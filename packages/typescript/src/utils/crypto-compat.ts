/**
 * Browser and Node.js compatible crypto abstraction
 * Provides cross-platform interface for cryptographic operations
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
 */
let cachedHasNodeCrypto: boolean | null = null;
function hasNodeCrypto(): boolean {
  if (cachedHasNodeCrypto !== null) {
    return cachedHasNodeCrypto;
  }
  if (typeof require === "undefined" || typeof process === "undefined") {
    cachedHasNodeCrypto = false;
    return cachedHasNodeCrypto;
  }
  const versions = process.versions;
  if (!versions) {
    cachedHasNodeCrypto = false;
    return cachedHasNodeCrypto;
  }
  cachedHasNodeCrypto =
    versions.node !== undefined || versions.bun !== undefined;
  return cachedHasNodeCrypto;
}

/**
 * Hash algorithm mapping for Web Crypto API
 */
const WEB_CRYPTO_ALGO_MAP: Record<string, string> = {
  sha256: "SHA-256",
  sha1: "SHA-1",
  sha512: "SHA-512",
};

/**
 * Get the appropriate crypto module for the current environment
 */
function getNodeCrypto(): typeof import("node:crypto") {
  if (!hasNodeCrypto()) {
    throw new Error("Node.js crypto module not available in this environment");
  }
  return require("node:crypto");
}

/**
 * Get Web Crypto SubtleCrypto interface, throwing if unavailable
 */
function getWebCryptoSubtle(): SubtleCrypto {
  const globalThisCrypto = globalThis.crypto;
  const subtle = globalThisCrypto?.subtle;
  if (!subtle) {
    throw new Error(
      "Web Crypto API not available. This browser may not support cryptographic operations.",
    );
  }
  return subtle;
}

/**
 * Hash data using Web Crypto API (browser-compatible)
 */
async function webCryptoHash(
  algorithm: string,
  data: Uint8Array,
): Promise<Uint8Array> {
  const subtle = getWebCryptoSubtle();
  const webAlgo = WEB_CRYPTO_ALGO_MAP[algorithm.toLowerCase()];

  if (!webAlgo) {
    throw new Error(
      `Unsupported algorithm: ${algorithm}. Supported: ${Object.keys(WEB_CRYPTO_ALGO_MAP).join(", ")}`,
    );
  }

  // Create a copy to ensure we have a proper ArrayBuffer (not SharedArrayBuffer)
  const dataBuffer = new Uint8Array(data).buffer;
  const hashBuffer = await subtle.digest(webAlgo, dataBuffer);
  return new Uint8Array(hashBuffer);
}

/**
 * Encrypt data using AES-256-CBC with Web Crypto API (browser-compatible)
 */
async function webCryptoEncrypt(
  key: Uint8Array,
  iv: Uint8Array,
  data: Uint8Array,
): Promise<Uint8Array> {
  validateKeyAndIv(key, iv);
  const subtle = getWebCryptoSubtle();

  // Create copies to ensure we have proper ArrayBuffers (not SharedArrayBuffers)
  const keyBuffer = new Uint8Array(key).buffer;
  const ivCopy = new Uint8Array(iv);
  const dataCopy = new Uint8Array(data);

  const cryptoKey = await subtle.importKey(
    "raw",
    keyBuffer,
    { name: "AES-CBC", length: 256 },
    false,
    ["encrypt"],
  );

  const encrypted = await subtle.encrypt(
    { name: "AES-CBC", iv: ivCopy },
    cryptoKey,
    dataCopy,
  );
  return new Uint8Array(encrypted);
}

/**
 * Decrypt data using AES-256-CBC with Web Crypto API (browser-compatible)
 */
async function webCryptoDecrypt(
  key: Uint8Array,
  iv: Uint8Array,
  data: Uint8Array,
): Promise<Uint8Array> {
  validateKeyAndIv(key, iv);
  const subtle = getWebCryptoSubtle();

  // Create copies to ensure we have proper ArrayBuffers (not SharedArrayBuffers)
  const keyBuffer = new Uint8Array(key).buffer;
  const ivCopy = new Uint8Array(iv);
  const dataCopy = new Uint8Array(data);

  const cryptoKey = await subtle.importKey(
    "raw",
    keyBuffer,
    { name: "AES-CBC", length: 256 },
    false,
    ["decrypt"],
  );

  const decrypted = await subtle.decrypt(
    { name: "AES-CBC", iv: ivCopy },
    cryptoKey,
    dataCopy,
  );
  return new Uint8Array(decrypted);
}

/**
 * Validate key and IV lengths for AES-256-CBC
 */
function validateKeyAndIv(key: Uint8Array, iv: Uint8Array): void {
  if (key.length !== 32) {
    throw new Error(
      `Invalid key length: ${key.length} bytes. Expected 32 bytes for AES-256.`,
    );
  }
  if (iv.length !== 16) {
    throw new Error(
      `Invalid IV length: ${iv.length} bytes. Expected 16 bytes for AES-CBC.`,
    );
  }
}

/**
 * Validate key and IV lengths for AES-256-GCM
 *
 * GCM requires a 32-byte key. The recommended nonce/IV length is 12 bytes.
 */
function validateKeyAndGcmIv(key: Uint8Array, iv: Uint8Array): void {
  if (key.length !== 32) {
    throw new Error(
      `Invalid key length: ${key.length} bytes. Expected 32 bytes for AES-256.`,
    );
  }
  if (iv.length !== 12) {
    throw new Error(
      `Invalid IV length: ${iv.length} bytes. Expected 12 bytes for AES-GCM.`,
    );
  }
}

/**
 * Create a hash object for incremental hashing (cross-platform - synchronous)
 *
 * This function works in both Node.js and browser environments. In browsers, it uses
 * crypto-browserify to provide synchronous hashing compatible with Node.js crypto API.
 *
 * @param algorithm - Hash algorithm ('sha256', 'sha1', 'sha512')
 * @returns Hash object with update() and digest() methods
 */
export function createHash(algorithm: string): {
  update(data: string | Uint8Array): ReturnType<typeof createHash>;
  digest(): Uint8Array;
} {
  if (hasNodeCrypto()) {
    const crypto = getNodeCrypto();
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

  // Use crypto-browserify in browser
  const cryptoBrowserify = require("crypto-browserify");
  const hash = cryptoBrowserify.createHash(algorithm);
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
 * This is the recommended method for cross-platform code.
 *
 * @param algorithm - Hash algorithm ('sha256', 'sha1', 'sha512')
 * @param data - Data to hash
 * @returns Hash result
 */
export async function createHashAsync(
  algorithm: string,
  data: string | Uint8Array,
): Promise<Uint8Array> {
  const bytes =
    typeof data === "string" ? new TextEncoder().encode(data) : data;

  if (hasNodeCrypto()) {
    const crypto = getNodeCrypto();
    const hash = crypto.createHash(algorithm);
    hash.update(bytes);
    return new Uint8Array(hash.digest());
  }

  return webCryptoHash(algorithm, bytes);
}

/**
 * Create a cipher for encryption (cross-platform - synchronous)
 *
 * @param algorithm - Cipher algorithm (only 'aes-256-cbc' is supported)
 * @param key - 256-bit (32-byte) encryption key
 * @param iv - 128-bit (16-byte) initialization vector
 * @returns Cipher object with update() and final() methods
 */
export function createCipheriv(
  algorithm: string,
  key: Uint8Array,
  iv: Uint8Array,
): {
  update(data: string, inputEncoding: string, outputEncoding: string): string;
  final(encoding: string): string;
} {
  if (algorithm !== "aes-256-cbc") {
    throw new Error(
      `Unsupported algorithm: ${algorithm}. Only 'aes-256-cbc' is supported.`,
    );
  }

  if (hasNodeCrypto()) {
    const crypto = getNodeCrypto();
    const cipher = crypto.createCipheriv(algorithm, key, iv);
    return {
      update(
        data: string,
        inputEncoding: string,
        outputEncoding: string,
      ): string {
        return cipher.update(
          data,
          inputEncoding as BufferEncoding,
          outputEncoding as BufferEncoding,
        );
      },
      final(encoding: string): string {
        return cipher.final(encoding as BufferEncoding);
      },
    };
  }

  // Use crypto-browserify in browser
  const cryptoBrowserify = require("crypto-browserify");
  const cipher = cryptoBrowserify.createCipheriv(algorithm, key, iv);
  return {
    update(
      data: string,
      inputEncoding: string,
      outputEncoding: string,
    ): string {
      const result = cipher.update(
        Buffer.from(data, inputEncoding as BufferEncoding),
        undefined,
        outputEncoding as BufferEncoding,
      );
      return typeof result === "string"
        ? result
        : result.toString(outputEncoding as BufferEncoding);
    },
    final(encoding: string): string {
      const result = cipher.final(encoding as BufferEncoding);
      return typeof result === "string"
        ? result
        : result.toString(encoding as BufferEncoding);
    },
  };
}

/**
 * Create a decipher for decryption (cross-platform - synchronous)
 *
 * @param algorithm - Cipher algorithm (only 'aes-256-cbc' is supported)
 * @param key - 256-bit (32-byte) decryption key
 * @param iv - 128-bit (16-byte) initialization vector
 * @returns Decipher object with update() and final() methods
 */
export function createDecipheriv(
  algorithm: string,
  key: Uint8Array,
  iv: Uint8Array,
): {
  update(data: string, inputEncoding: string, outputEncoding: string): string;
  final(encoding: string): string;
} {
  if (algorithm !== "aes-256-cbc") {
    throw new Error(
      `Unsupported algorithm: ${algorithm}. Only 'aes-256-cbc' is supported.`,
    );
  }

  if (hasNodeCrypto()) {
    const crypto = getNodeCrypto();
    const decipher = crypto.createDecipheriv(algorithm, key, iv);
    return {
      update(
        data: string,
        inputEncoding: string,
        outputEncoding: string,
      ): string {
        return decipher.update(
          data,
          inputEncoding as BufferEncoding,
          outputEncoding as BufferEncoding,
        );
      },
      final(encoding: string): string {
        return decipher.final(encoding as BufferEncoding);
      },
    };
  }

  // Use crypto-browserify in browser
  const cryptoBrowserify = require("crypto-browserify");
  const decipher = cryptoBrowserify.createDecipheriv(algorithm, key, iv);
  return {
    update(
      data: string,
      inputEncoding: string,
      outputEncoding: string,
    ): string {
      const result = decipher.update(
        Buffer.from(data, inputEncoding as BufferEncoding),
        undefined,
        outputEncoding as BufferEncoding,
      );
      return typeof result === "string"
        ? result
        : result.toString(outputEncoding as BufferEncoding);
    },
    final(encoding: string): string {
      const result = decipher.final(encoding as BufferEncoding);
      return typeof result === "string"
        ? result
        : result.toString(encoding as BufferEncoding);
    },
  };
}

/**
 * Encrypt data asynchronously (works in both Node.js and browser)
 *
 * This is the recommended method for cross-platform code using AES-256-CBC.
 *
 * @param key - 256-bit (32-byte) encryption key
 * @param iv - 128-bit (16-byte) initialization vector
 * @param data - Data to encrypt
 * @returns Encrypted data
 */
export async function encryptAsync(
  key: Uint8Array,
  iv: Uint8Array,
  data: Uint8Array,
): Promise<Uint8Array> {
  validateKeyAndIv(key, iv);

  if (hasNodeCrypto()) {
    const crypto = getNodeCrypto();
    const cipher = crypto.createCipheriv("aes-256-cbc", key, iv);
    const encrypted = Buffer.concat([cipher.update(data), cipher.final()]);
    return new Uint8Array(encrypted);
  }

  return webCryptoEncrypt(key, iv, data);
}

/**
 * Decrypt data asynchronously (works in both Node.js and browser)
 *
 * This is the recommended method for cross-platform code using AES-256-CBC.
 *
 * @param key - 256-bit (32-byte) decryption key
 * @param iv - 128-bit (16-byte) initialization vector
 * @param data - Data to decrypt
 * @returns Decrypted data
 */
export async function decryptAsync(
  key: Uint8Array,
  iv: Uint8Array,
  data: Uint8Array,
): Promise<Uint8Array> {
  validateKeyAndIv(key, iv);

  if (hasNodeCrypto()) {
    const crypto = getNodeCrypto();
    const decipher = crypto.createDecipheriv("aes-256-cbc", key, iv);
    const decrypted = Buffer.concat([decipher.update(data), decipher.final()]);
    return new Uint8Array(decrypted);
  }

  return webCryptoDecrypt(key, iv, data);
}

/**
 * Encrypt using AES-256-GCM (synchronous; Node.js or crypto-browserify).
 *
 * This is used for cross-language secret encryption with integrity protection.
 */
export function encryptAes256Gcm(
  key: Uint8Array,
  iv: Uint8Array,
  plaintext: Uint8Array,
  aad?: Uint8Array,
): { ciphertext: Uint8Array; tag: Uint8Array } {
  validateKeyAndGcmIv(key, iv);

  if (hasNodeCrypto()) {
    const crypto = getNodeCrypto();
    const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
    if (aad && aad.length > 0) {
      cipher.setAAD(aad);
    }
    const ciphertext = Buffer.concat([
      cipher.update(plaintext),
      cipher.final(),
    ]);
    const tag = cipher.getAuthTag();
    return { ciphertext: new Uint8Array(ciphertext), tag: new Uint8Array(tag) };
  }

  const cryptoBrowserify = require("crypto-browserify");
  const cipher = cryptoBrowserify.createCipheriv("aes-256-gcm", key, iv);
  if (aad && aad.length > 0) {
    cipher.setAAD(Buffer.from(aad));
  }
  const ciphertext = Buffer.concat([
    cipher.update(Buffer.from(plaintext)),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return { ciphertext: new Uint8Array(ciphertext), tag: new Uint8Array(tag) };
}

/**
 * Decrypt using AES-256-GCM (synchronous; Node.js or crypto-browserify).
 */
export function decryptAes256Gcm(
  key: Uint8Array,
  iv: Uint8Array,
  ciphertext: Uint8Array,
  tag: Uint8Array,
  aad?: Uint8Array,
): Uint8Array {
  validateKeyAndGcmIv(key, iv);
  if (tag.length !== 16) {
    throw new Error(
      `Invalid tag length: ${tag.length} bytes. Expected 16 bytes for AES-GCM tag.`,
    );
  }

  if (hasNodeCrypto()) {
    const crypto = getNodeCrypto();
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
    if (aad && aad.length > 0) {
      decipher.setAAD(aad);
    }
    decipher.setAuthTag(Buffer.from(tag));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(ciphertext)),
      decipher.final(),
    ]);
    return new Uint8Array(plaintext);
  }

  const cryptoBrowserify = require("crypto-browserify");
  const decipher = cryptoBrowserify.createDecipheriv("aes-256-gcm", key, iv);
  if (aad && aad.length > 0) {
    decipher.setAAD(Buffer.from(aad));
  }
  decipher.setAuthTag(Buffer.from(tag));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(ciphertext)),
    decipher.final(),
  ]);
  return new Uint8Array(plaintext);
}
