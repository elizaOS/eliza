/**
 * Browser and Node.js compatible crypto abstraction
 * Provides unified interface for cryptographic operations
 *
 * @module crypto-compat
 *
 * This module provides both synchronous (Node.js only) and asynchronous (cross-platform)
 * APIs for cryptographic operations. Use async methods for browser compatibility.
 *
 * @example
 * ```typescript
 * // Node.js synchronous API
 * const hash = createHash('sha256').update('data').digest();
 *
 * // Cross-platform async API
 * const hash = await createHashAsync('sha256', 'data');
 * ```
 */

/**
 * Check if we're in Node.js or Bun with native crypto module available
 * @returns {boolean} True if Node.js or Bun crypto is available
 */
function hasNodeCrypto(): boolean {
  try {
    return (
      typeof require !== 'undefined' &&
      typeof process !== 'undefined' &&
      (process.versions?.node !== undefined || process.versions?.bun !== undefined)
    );
  } catch {
    return false;
  }
}

/**
 * Get the appropriate crypto module for the current environment
 * @returns {any} Native crypto in Node.js/Bun, crypto-browserify in browser
 */
function getCryptoModule(): any {
  if (hasNodeCrypto()) {
    return require('crypto');
  }
  // Use crypto-browserify for synchronous APIs in browser
  return require('crypto-browserify');
}

/**
 * Hash data using Web Crypto API (browser-compatible)
 * @param {string} algorithm - Hash algorithm ('sha256', 'sha1', 'sha512')
 * @param {Uint8Array} data - Data to hash
 * @returns {Promise<Uint8Array>} Hash result
 * @throws {Error} If Web Crypto API is not available or algorithm is unsupported
 */
async function webCryptoHash(algorithm: string, data: Uint8Array): Promise<Uint8Array> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    throw new Error(
      'Web Crypto API not available. This browser may not support cryptographic operations.'
    );
  }

  const algoMap: Record<string, string> = {
    sha256: 'SHA-256',
    sha1: 'SHA-1',
    sha512: 'SHA-512',
  };

  const webAlgo = algoMap[algorithm.toLowerCase()];
  if (!webAlgo) {
    throw new Error(
      `Unsupported algorithm: ${algorithm}. Supported algorithms: ${Object.keys(algoMap).join(', ')}`
    );
  }

  const hashBuffer = await subtle.digest(webAlgo, data as BufferSource);
  return new Uint8Array(hashBuffer);
}

/**
 * Encrypt data using AES-256-CBC with Web Crypto API (browser-compatible)
 * @param {Uint8Array} key - 256-bit (32-byte) encryption key
 * @param {Uint8Array} iv - 128-bit (16-byte) initialization vector
 * @param {Uint8Array} data - Data to encrypt
 * @returns {Promise<Uint8Array>} Encrypted data
 * @throws {Error} If Web Crypto API is not available or key/IV lengths are invalid
 */
async function webCryptoEncrypt(
  key: Uint8Array,
  iv: Uint8Array,
  data: Uint8Array
): Promise<Uint8Array> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    throw new Error(
      'Web Crypto API not available. This browser may not support cryptographic operations.'
    );
  }

  if (key.length !== 32) {
    throw new Error(`Invalid key length: ${key.length} bytes. Expected 32 bytes for AES-256.`);
  }

  if (iv.length !== 16) {
    throw new Error(`Invalid IV length: ${iv.length} bytes. Expected 16 bytes for AES-CBC.`);
  }

  const cryptoKey = await subtle.importKey(
    'raw',
    key as BufferSource,
    { name: 'AES-CBC', length: 256 },
    false,
    ['encrypt']
  );

  const encrypted = await subtle.encrypt(
    { name: 'AES-CBC', iv: iv as BufferSource },
    cryptoKey,
    data as BufferSource
  );

  return new Uint8Array(encrypted);
}

/**
 * Decrypt data using AES-256-CBC with Web Crypto API (browser-compatible)
 * @param {Uint8Array} key - 256-bit (32-byte) decryption key
 * @param {Uint8Array} iv - 128-bit (16-byte) initialization vector
 * @param {Uint8Array} data - Data to decrypt
 * @returns {Promise<Uint8Array>} Decrypted data
 * @throws {Error} If Web Crypto API is not available or key/IV lengths are invalid
 */
async function webCryptoDecrypt(
  key: Uint8Array,
  iv: Uint8Array,
  data: Uint8Array
): Promise<Uint8Array> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    throw new Error(
      'Web Crypto API not available. This browser may not support cryptographic operations.'
    );
  }

  if (key.length !== 32) {
    throw new Error(`Invalid key length: ${key.length} bytes. Expected 32 bytes for AES-256.`);
  }

  if (iv.length !== 16) {
    throw new Error(`Invalid IV length: ${iv.length} bytes. Expected 16 bytes for AES-CBC.`);
  }

  const cryptoKey = await subtle.importKey(
    'raw',
    key as BufferSource,
    { name: 'AES-CBC', length: 256 },
    false,
    ['decrypt']
  );

  const decrypted = await subtle.decrypt(
    { name: 'AES-CBC', iv: iv as BufferSource },
    cryptoKey,
    data as BufferSource
  );

  return new Uint8Array(decrypted);
}

/**
 * Create a hash object for incremental hashing (cross-platform - synchronous)
 *
 * This function works in both Node.js and browser environments. In browsers, it uses
 * crypto-browserify to provide synchronous hashing compatible with Node.js crypto API.
 *
 * @param {string} algorithm - Hash algorithm ('sha256', 'sha1', 'sha512')
 * @returns {object} Hash object with update() and digest() methods
 *
 * @example
 * ```typescript
 * const hash = createHash('sha256')
 *   .update('hello')
 *   .update('world')
 *   .digest();
 * ```
 */
export function createHash(algorithm: string): {
  update(data: string | Uint8Array): ReturnType<typeof createHash>;
  digest(): Uint8Array;
} {
  // Use crypto-browserify in browser, native crypto in Node.js
  const crypto = getCryptoModule();
  const hash = crypto.createHash(algorithm);
  return {
    update(data: string | Uint8Array) {
      hash.update(data);
      return this;
    },
    digest() {
      return new Uint8Array(hash.digest());
    },
  };
}

/**
 * Create a hash asynchronously (works in both Node.js and browser)
 *
 * This is the recommended method for cross-platform code as it works in both
 * Node.js and browser environments.
 *
 * @param {string} algorithm - Hash algorithm ('sha256', 'sha1', 'sha512')
 * @param {string | Uint8Array} data - Data to hash
 * @returns {Promise<Uint8Array>} Hash result
 * @throws {Error} If algorithm is unsupported or Web Crypto API is unavailable
 *
 * @example
 * ```typescript
 * // Works in both Node.js and browser
 * const hash = await createHashAsync('sha256', 'hello world');
 * ```
 */
export async function createHashAsync(
  algorithm: string,
  data: string | Uint8Array
): Promise<Uint8Array> {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;

  if (hasNodeCrypto()) {
    // Use Node.js native crypto for better performance
    const crypto = getCryptoModule();
    return new Uint8Array(crypto.createHash(algorithm).update(bytes).digest());
  }

  // Use Web Crypto API in browser for async operations
  return webCryptoHash(algorithm, bytes);
}

/**
 * Create a cipher for encryption (cross-platform - synchronous)
 *
 * This function works in both Node.js and browser environments. In browsers, it uses
 * crypto-browserify to provide synchronous encryption compatible with Node.js crypto API.
 *
 * @param {string} algorithm - Cipher algorithm (currently only 'aes-256-cbc' is supported)
 * @param {Uint8Array} key - 256-bit (32-byte) encryption key
 * @param {Uint8Array} iv - 128-bit (16-byte) initialization vector
 * @returns {object} Cipher object with update() and final() methods
 * @throws {Error} If algorithm is unsupported
 *
 * @example
 * ```typescript
 * const cipher = createCipheriv('aes-256-cbc', key, iv);
 * let encrypted = cipher.update('data', 'utf8', 'hex');
 * encrypted += cipher.final('hex');
 * ```
 */
export function createCipheriv(
  algorithm: string,
  key: Uint8Array,
  iv: Uint8Array
): {
  update(data: string, inputEncoding: string, outputEncoding: string): string;
  final(encoding: string): string;
} {
  if (algorithm !== 'aes-256-cbc') {
    throw new Error(
      `Unsupported algorithm: ${algorithm}. Only 'aes-256-cbc' is currently supported.`
    );
  }

  // Use crypto-browserify in browser, native crypto in Node.js
  const crypto = getCryptoModule();
  return crypto.createCipheriv(algorithm, key, iv);
}

/**
 * Create a decipher for decryption (cross-platform - synchronous)
 *
 * This function works in both Node.js and browser environments. In browsers, it uses
 * crypto-browserify to provide synchronous decryption compatible with Node.js crypto API.
 *
 * @param {string} algorithm - Cipher algorithm (currently only 'aes-256-cbc' is supported)
 * @param {Uint8Array} key - 256-bit (32-byte) decryption key
 * @param {Uint8Array} iv - 128-bit (16-byte) initialization vector
 * @returns {object} Decipher object with update() and final() methods
 * @throws {Error} If algorithm is unsupported
 *
 * @example
 * ```typescript
 * const decipher = createDecipheriv('aes-256-cbc', key, iv);
 * let decrypted = decipher.update(encrypted, 'hex', 'utf8');
 * decrypted += decipher.final('utf8');
 * ```
 */
export function createDecipheriv(
  algorithm: string,
  key: Uint8Array,
  iv: Uint8Array
): {
  update(data: string, inputEncoding: string, outputEncoding: string): string;
  final(encoding: string): string;
} {
  if (algorithm !== 'aes-256-cbc') {
    throw new Error(
      `Unsupported algorithm: ${algorithm}. Only 'aes-256-cbc' is currently supported.`
    );
  }

  // Use crypto-browserify in browser, native crypto in Node.js
  const crypto = getCryptoModule();
  return crypto.createDecipheriv(algorithm, key, iv);
}

/**
 * Encrypt data asynchronously (works in both Node.js and browser)
 *
 * This is the recommended method for cross-platform code as it works in both
 * Node.js and browser environments using AES-256-CBC.
 *
 * @param {Uint8Array} key - 256-bit (32-byte) encryption key
 * @param {Uint8Array} iv - 128-bit (16-byte) initialization vector
 * @param {Uint8Array} data - Data to encrypt
 * @returns {Promise<Uint8Array>} Encrypted data
 * @throws {Error} If key/IV lengths are invalid or Web Crypto API is unavailable
 *
 * @example
 * ```typescript
 * // Works in both Node.js and browser
 * const encrypted = await encryptAsync(key, iv, data);
 * ```
 */
export async function encryptAsync(
  key: Uint8Array,
  iv: Uint8Array,
  data: Uint8Array
): Promise<Uint8Array> {
  if (key.length !== 32) {
    throw new Error(`Invalid key length: ${key.length} bytes. Expected 32 bytes for AES-256.`);
  }

  if (iv.length !== 16) {
    throw new Error(`Invalid IV length: ${iv.length} bytes. Expected 16 bytes for AES-CBC.`);
  }

  if (hasNodeCrypto()) {
    // Use Node.js native crypto for better performance
    const crypto = getCryptoModule();
    const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
    const encrypted = Buffer.concat([cipher.update(data), cipher.final()]);
    return new Uint8Array(encrypted);
  }

  // Use Web Crypto API in browser for async operations
  return webCryptoEncrypt(key, iv, data);
}

/**
 * Decrypt data asynchronously (works in both Node.js and browser)
 *
 * This is the recommended method for cross-platform code as it works in both
 * Node.js and browser environments using AES-256-CBC.
 *
 * @param {Uint8Array} key - 256-bit (32-byte) decryption key
 * @param {Uint8Array} iv - 128-bit (16-byte) initialization vector
 * @param {Uint8Array} data - Data to decrypt
 * @returns {Promise<Uint8Array>} Decrypted data
 * @throws {Error} If key/IV lengths are invalid or Web Crypto API is unavailable
 *
 * @example
 * ```typescript
 * // Works in both Node.js and browser
 * const decrypted = await decryptAsync(key, iv, encryptedData);
 * ```
 */
export async function decryptAsync(
  key: Uint8Array,
  iv: Uint8Array,
  data: Uint8Array
): Promise<Uint8Array> {
  if (key.length !== 32) {
    throw new Error(`Invalid key length: ${key.length} bytes. Expected 32 bytes for AES-256.`);
  }

  if (iv.length !== 16) {
    throw new Error(`Invalid IV length: ${iv.length} bytes. Expected 16 bytes for AES-CBC.`);
  }

  if (hasNodeCrypto()) {
    // Use Node.js native crypto for better performance
    const crypto = getCryptoModule();
    const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
    const decrypted = Buffer.concat([decipher.update(data), decipher.final()]);
    return new Uint8Array(decrypted);
  }

  // Use Web Crypto API in browser for async operations
  return webCryptoDecrypt(key, iv, data);
}

/**
 * Legacy Web Crypto API export for backward compatibility
 *
 * **Deprecated:** Use the top-level async functions instead:
 * - `createHashAsync()` instead of `webCrypto.hash()`
 * - `encryptAsync()` instead of `webCrypto.encrypt()`
 * - `decryptAsync()` instead of `webCrypto.decrypt()`
 *
 * @deprecated Use top-level async functions for better cross-platform support
 */
export const webCrypto = {
  hash: webCryptoHash,
  encrypt: webCryptoEncrypt,
  decrypt: webCryptoDecrypt,
};
