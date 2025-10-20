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
 * Check if we're in Node.js with native crypto module available
 * @returns {boolean} True if Node.js crypto is available
 */
function hasNodeCrypto(): boolean {
    try {
        return typeof require !== 'undefined' && typeof process !== 'undefined' && process.versions?.node !== undefined;
    } catch {
        return false;
    }
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
        throw new Error('Web Crypto API not available. This browser may not support cryptographic operations.');
    }

    const algoMap: Record<string, string> = {
        'sha256': 'SHA-256',
        'sha1': 'SHA-1',
        'sha512': 'SHA-512',
    };

    const webAlgo = algoMap[algorithm.toLowerCase()];
    if (!webAlgo) {
        throw new Error(`Unsupported algorithm: ${algorithm}. Supported algorithms: ${Object.keys(algoMap).join(', ')}`);
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
        throw new Error('Web Crypto API not available. This browser may not support cryptographic operations.');
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
        throw new Error('Web Crypto API not available. This browser may not support cryptographic operations.');
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
 * Create a hash object for incremental hashing (Node.js only - synchronous)
 * 
 * **Note:** This function only works in Node.js environments. For browser compatibility,
 * use `createHashAsync()` instead.
 * 
 * @param {string} algorithm - Hash algorithm ('sha256', 'sha1', 'sha512')
 * @returns {object} Hash object with update() and digest() methods
 * @throws {Error} In browser environments - use createHashAsync() instead
 * 
 * @example
 * ```typescript
 * // Node.js only
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
    let buffer: Uint8Array = new Uint8Array(0);

    if (hasNodeCrypto()) {
        // Use Node.js crypto
        const crypto = require('crypto');
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

    // Browser: collect data and hash on digest()
    return {
        update(data: string | Uint8Array) {
            const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
            const newBuffer = new Uint8Array(buffer.length + bytes.length);
            newBuffer.set(buffer);
            newBuffer.set(bytes, buffer.length);
            buffer = newBuffer;
            return this;
        },
        digest() {
            throw new Error(
                'Synchronous digest not supported in browser. ' +
                'Use createHashAsync() instead for cross-platform compatibility. ' +
                'Example: await createHashAsync("sha256", data)'
            );
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
        // Use Node.js crypto
        const crypto = require('crypto');
        return new Uint8Array(crypto.createHash(algorithm).update(bytes).digest());
    }

    // Use Web Crypto API in browser
    return webCryptoHash(algorithm, bytes);
}

/**
 * Create a cipher for encryption (Node.js only - synchronous)
 * 
 * **Note:** This function only works in Node.js environments. For browser compatibility,
 * use `encryptAsync()` instead.
 * 
 * @param {string} algorithm - Cipher algorithm (currently only 'aes-256-cbc' is supported)
 * @param {Uint8Array} key - 256-bit (32-byte) encryption key
 * @param {Uint8Array} iv - 128-bit (16-byte) initialization vector
 * @returns {object} Cipher object with update() and final() methods
 * @throws {Error} In browser environments or if algorithm is unsupported
 * 
 * @example
 * ```typescript
 * // Node.js only
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
        throw new Error(`Unsupported algorithm: ${algorithm}. Only 'aes-256-cbc' is currently supported.`);
    }

    if (hasNodeCrypto()) {
        const crypto = require('crypto');
        return crypto.createCipheriv(algorithm, key, iv);
    }

    throw new Error(
        'Synchronous encryption not supported in browser. ' +
        'Use encryptAsync() instead for cross-platform compatibility. ' +
        'Example: await encryptAsync(key, iv, data)'
    );
}

/**
 * Create a decipher for decryption (Node.js only - synchronous)
 * 
 * **Note:** This function only works in Node.js environments. For browser compatibility,
 * use `decryptAsync()` instead.
 * 
 * @param {string} algorithm - Cipher algorithm (currently only 'aes-256-cbc' is supported)
 * @param {Uint8Array} key - 256-bit (32-byte) decryption key
 * @param {Uint8Array} iv - 128-bit (16-byte) initialization vector
 * @returns {object} Decipher object with update() and final() methods
 * @throws {Error} In browser environments or if algorithm is unsupported
 * 
 * @example
 * ```typescript
 * // Node.js only
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
        throw new Error(`Unsupported algorithm: ${algorithm}. Only 'aes-256-cbc' is currently supported.`);
    }

    if (hasNodeCrypto()) {
        const crypto = require('crypto');
        return crypto.createDecipheriv(algorithm, key, iv);
    }

    throw new Error(
        'Synchronous decryption not supported in browser. ' +
        'Use decryptAsync() instead for cross-platform compatibility. ' +
        'Example: await decryptAsync(key, iv, encryptedData)'
    );
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
        // Use Node.js crypto
        const crypto = require('crypto');
        const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
        const encrypted = Buffer.concat([cipher.update(data), cipher.final()]);
        return new Uint8Array(encrypted);
    }

    // Use Web Crypto API in browser
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
        // Use Node.js crypto
        const crypto = require('crypto');
        const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
        const decrypted = Buffer.concat([decipher.update(data), decipher.final()]);
        return new Uint8Array(decrypted);
    }

    // Use Web Crypto API in browser
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

