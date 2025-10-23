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
 * Hash data using Web Crypto API (browser-compatible)
 * @param {string} algorithm - Hash algorithm ('sha256', 'sha1', 'sha512')
 * @param {Uint8Array} data - Data to hash
 * @returns {Promise<Uint8Array>} Hash result
 * @throws {Error} If Web Crypto API is not available or algorithm is unsupported
 */
declare function webCryptoHash(algorithm: string, data: Uint8Array): Promise<Uint8Array>;
/**
 * Encrypt data using AES-256-CBC with Web Crypto API (browser-compatible)
 * @param {Uint8Array} key - 256-bit (32-byte) encryption key
 * @param {Uint8Array} iv - 128-bit (16-byte) initialization vector
 * @param {Uint8Array} data - Data to encrypt
 * @returns {Promise<Uint8Array>} Encrypted data
 * @throws {Error} If Web Crypto API is not available or key/IV lengths are invalid
 */
declare function webCryptoEncrypt(key: Uint8Array, iv: Uint8Array, data: Uint8Array): Promise<Uint8Array>;
/**
 * Decrypt data using AES-256-CBC with Web Crypto API (browser-compatible)
 * @param {Uint8Array} key - 256-bit (32-byte) decryption key
 * @param {Uint8Array} iv - 128-bit (16-byte) initialization vector
 * @param {Uint8Array} data - Data to decrypt
 * @returns {Promise<Uint8Array>} Decrypted data
 * @throws {Error} If Web Crypto API is not available or key/IV lengths are invalid
 */
declare function webCryptoDecrypt(key: Uint8Array, iv: Uint8Array, data: Uint8Array): Promise<Uint8Array>;
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
export declare function createHash(algorithm: string): {
    update(data: string | Uint8Array): ReturnType<typeof createHash>;
    digest(): Uint8Array;
};
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
export declare function createHashAsync(algorithm: string, data: string | Uint8Array): Promise<Uint8Array>;
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
export declare function createCipheriv(algorithm: string, key: Uint8Array, iv: Uint8Array): {
    update(data: string, inputEncoding: string, outputEncoding: string): string;
    final(encoding: string): string;
};
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
export declare function createDecipheriv(algorithm: string, key: Uint8Array, iv: Uint8Array): {
    update(data: string, inputEncoding: string, outputEncoding: string): string;
    final(encoding: string): string;
};
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
export declare function encryptAsync(key: Uint8Array, iv: Uint8Array, data: Uint8Array): Promise<Uint8Array>;
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
export declare function decryptAsync(key: Uint8Array, iv: Uint8Array, data: Uint8Array): Promise<Uint8Array>;
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
export declare const webCrypto: {
    hash: typeof webCryptoHash;
    encrypt: typeof webCryptoEncrypt;
    decrypt: typeof webCryptoDecrypt;
};
export {};
//# sourceMappingURL=crypto-compat.d.ts.map