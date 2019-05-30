import sodium from 'libsodium-wrappers';
import pbkdf2 from 'pbkdf2';
import secp256k1 from 'secp256k1';
import utility from './utility';
import { prefix } from './constants';
import { Key as KeyInterface } from './types';

/**
 * Creates a key object from a base58 encoded key.
 * @class Key
 * @param {String} key A public or secret key in base58 encoding, or a 15 word bip39 english mnemonic string
 * @param {String} passphrase The passphrase used if the key provided is an encrypted private key or a fundraiser key
 * @param {String} email Email used if a fundraiser key is passed
 * @example
 * const key = new Key('edskRv6ZnkLQMVustbYHFPNsABu1Js6pEEWyMUFJQTqEZjVCU2WHh8ckcc7YA4uBzPiJjZCsv3pC1NDdV99AnyLzPjSip4uC3y');
 * await key.ready;
 */
export default class Key implements KeyInterface {
  _publicKey: string;
  _secretKey?: string;
  _isSecret: boolean;
  _isLedger: boolean;
  _ledgerPath: string;
  _ledgerCurve: number;
  ready: Promise<void>;
  curve: string;

  constructor(key: string, passphrase?: string, email?: string) {
    this._isLedger = false;
    this._ledgerPath = "44'/1729'/0'/0'";
    this._ledgerCurve = 0x00;
    this.ready = new Promise((resolve) => {
      this.initialize(key, passphrase, email, resolve);
    });
  }

  get isLedger(): boolean {
    return this._isLedger;
  }

  set isLedger(value: boolean) {
    this._isLedger = value;
  }

  get ledgerPath(): string {
    return this._ledgerPath;
  }

  set ledgerPath(value: string) {
    this._ledgerPath = value;
  }

  get ledgerCurve(): number {
    return this._ledgerCurve;
  }

  set ledgerCurve(value: number) {
    this._ledgerCurve = value;
  }

  /**
   * @memberof Key
   * @description Returns the public key
   * @returns {String} The public key associated with the private key
   */
  publicKey = (): string => utility.b58cencode(this._publicKey, prefix[`${this.curve}pk`]);

  /**
   * @memberof Key
   * @description Returns the secret key
   * @returns {String} The secret key associated with this key, if available
   */
  secretKey = (): string => {
    if (!this._secretKey) {
      throw new Error('Secret key not known.');
    }

    let key = this._secretKey;
    if (this.curve === 'ed') {
      ({ privateKey: key } = sodium.crypto_sign_seed_keypair(key.slice(0, 32)));
    }

    return utility.b58cencode(key, prefix[`${this.curve}sk`]);
  }

  /**
   * @memberof Key
   * @description Returns public key hash for this key
   * @returns {String} The public key hash for this key
   */
  publicKeyHash = (): string => {
    const prefixMap: { [key: string]: Uint8Array } = {
      ed: prefix.tz1,
      sp: prefix.tz2,
      p2: prefix.tz3,
    };

    const _prefix = prefixMap[this.curve];
    return utility.b58cencode(sodium.crypto_generichash(20, this._publicKey), _prefix);
  }

  initialize = async (key: string, passphrase?: string, email?: string, ready?: any) => {
    await sodium.ready;

    if (email) {
      if (!passphrase) {
        throw new Error('Fundraiser key provided without a passphrase.');
      }

      const salt = utility.textDecode(utility.textEncode(`${email}${passphrase}`)).normalize('NFKD');
      const seed = pbkdf2.pbkdf2Sync(key, `mnemonic${salt}`, 2048, 64, 'sha512');
      const { publicKey, privateKey } = sodium.crypto_sign_seed_keypair(seed.slice(0, 32));

      this._publicKey = publicKey;
      this._secretKey = privateKey;
      this.curve = 'ed';
      this._isSecret = true;
      ready();
      return;
    }

    this.curve = key.substr(0, 2);

    if (!['sp', 'p2', 'ed'].includes(this.curve)) {
      throw new Error('Invalid prefix for a key encoding.');
    }

    if (![54, 55, 88, 98].includes(key.length)) {
      throw new Error('Invalid length for a key encoding');
    }

    const encrypted = key.substring(2, 3) === 'e';
    const publicOrSecret = encrypted ? key.slice(3, 5) : key.slice(2, 4);

    if (!['pk', 'sk'].includes(publicOrSecret)) {
      throw new Error('Invalid prefix for a key encoding.');
    }

    this._isSecret = publicOrSecret === 'sk';

    if (this._isSecret) {
      key = utility.b58cdecode(key, prefix[`${this.curve}${encrypted ? 'e' : ''}sk`]);
    } else {
      key = utility.b58cdecode(key, prefix[`${this.curve}pk`]);
    }

    if (encrypted) {
      if (!passphrase) {
        throw new Error('Encrypted key provided without a passphrase.');
      }

      const salt = key.slice(0, 8);
      const encryptedSk = key.slice(8);
      const encryptionKey = pbkdf2.pbkdf2Sync(passphrase, salt, 32768, 32, 'sha512');

      key = sodium.crypto_secretbox_open_easy(encryptedSk, new Uint8Array(24), encryptionKey);
    }

    if (!this._isSecret) {
      this._publicKey = key;
      this._secretKey = undefined;
    } else {
      this._secretKey = key;
      if (this.curve === 'ed') {
        if (key.length === 64) {
          this._publicKey = key.slice(32);
        } else {
          const { publicKey, privateKey } = sodium.crypto_sign_seed_keypair(key, 'uint8array');
          this._publicKey = publicKey;
          this._secretKey = privateKey;
        }
      } else if (this.curve === 'sp') {
        this._publicKey = secp256k1.publicKeyCreate(key);
      } else if (this.curve === 'p2') {
        throw new Error('Curve P256 key is not yet supported.');
      } else {
        throw new Error('Invalid key');
      }
    }

    ready();
  }

  /**
   * @memberof Key
   * @description Sign a raw sequence of bytes
   * @param {String} bytes Sequence of bytes, raw format or hexadecimal notation
   * @param {Uint8Array} watermark The watermark bytes
   * @returns {String} The public key hash for this key
   */
  sign = async (bytes: string, watermark: Uint8Array) => {
    let bb = utility.hex2buf(bytes);
    if (typeof watermark !== 'undefined') {
      bb = utility.mergebuf(watermark, bb);
    }

    if (this.curve === 'ed') {
      const sig = sodium.crypto_sign_detached(sodium.crypto_generichash(32, bb), this._secretKey);
      const edsig = utility.b58cencode(sig, prefix.edsig);
      const sbytes = bytes + utility.buf2hex(sig);

      return {
        bytes,
        sig: utility.b58cencode(sig, prefix.sig),
        edsig,
        sbytes,
      };
    }

    throw new Error('Provided curve not supported');
  }

  /**
   * @memberof Key
   * @description Verify signature, throw error if it is not valid
   * @param {String} bytes Sequance of bytes, raw format or hexadecimal notation
   * @param {Uint8Array} signature A signature in base58 encoding
   */
  verify = (bytes: string, signature: string) => {
    if (!this._publicKey) {
      throw new Error('Cannot verify without a public key');
    }

    if (signature.slice(0, 3) !== 'sig') {
      if (this.curve !== signature.slice(0, 2)) { // 'sp', 'p2' 'ed'
        throw new Error('Signature and public key curves mismatch.');
      }
    }

    if (this.curve === 'ed') {
      const digest = utility.hex2buf(bytes);
      try {
        return sodium.crypto_sign_verify_detached(signature, digest, this._publicKey);
      } catch (e) {
        throw new Error('Signature is invalid.');
      }
    } else {
      throw new Error(`Curve '${this.curve}' not supported`);
    }
  }
}