/**
 * Browser and Node.js compatible crypto abstraction
 * Provides unified interface for cryptographic operations
 */

// Check if we're in Node.js with native crypto
function hasNodeCrypto(): boolean {
    try {
        return typeof require !== 'undefined' && typeof process !== 'undefined' && process.versions?.node !== undefined;
    } catch {
        return false;
    }
}

// Web Crypto API based implementations for browser
async function webCryptoHash(algorithm: string, data: Uint8Array): Promise<Uint8Array> {
    const subtle = globalThis.crypto?.subtle;
    if (!subtle) {
        throw new Error('Web Crypto API not available');
    }

    const algoMap: Record<string, string> = {
        'sha256': 'SHA-256',
        'sha1': 'SHA-1',
        'sha512': 'SHA-512',
    };

    const webAlgo = algoMap[algorithm.toLowerCase()];
    if (!webAlgo) {
        throw new Error(`Unsupported algorithm: ${algorithm}`);
    }

    const hashBuffer = await subtle.digest(webAlgo, data as BufferSource);
    return new Uint8Array(hashBuffer);
}

async function webCryptoEncrypt(
    key: Uint8Array,
    iv: Uint8Array,
    data: Uint8Array
): Promise<Uint8Array> {
    const subtle = globalThis.crypto?.subtle;
    if (!subtle) {
        throw new Error('Web Crypto API not available');
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

async function webCryptoDecrypt(
    key: Uint8Array,
    iv: Uint8Array,
    data: Uint8Array
): Promise<Uint8Array> {
    const subtle = globalThis.crypto?.subtle;
    if (!subtle) {
        throw new Error('Web Crypto API not available');
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

// Hash implementation compatible across environments
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
            // Return sync stub for browser - caller must handle async
            throw new Error('Synchronous digest not supported in browser. Use async crypto operations.');
        },
    };
}

// Cipher implementation
export function createCipheriv(
    algorithm: string,
    key: Uint8Array,
    iv: Uint8Array
): {
    update(data: string, inputEncoding: string, outputEncoding: string): string;
    final(encoding: string): string;
} {
    if (algorithm !== 'aes-256-cbc') {
        throw new Error(`Unsupported algorithm: ${algorithm}`);
    }

    if (hasNodeCrypto()) {
        const crypto = require('crypto');
        return crypto.createCipheriv(algorithm, key, iv);
    }

    // Browser: not supported synchronously
    throw new Error('Synchronous encryption not supported in browser. Use async crypto operations.');
}

// Decipher implementation
export function createDecipheriv(
    algorithm: string,
    key: Uint8Array,
    iv: Uint8Array
): {
    update(data: string, inputEncoding: string, outputEncoding: string): string;
    final(encoding: string): string;
} {
    if (algorithm !== 'aes-256-cbc') {
        throw new Error(`Unsupported algorithm: ${algorithm}`);
    }

    if (hasNodeCrypto()) {
        const crypto = require('crypto');
        return crypto.createDecipheriv(algorithm, key, iv);
    }

    // Browser: not supported synchronously
    throw new Error('Synchronous decryption not supported in browser. Use async crypto operations.');
}

// Export async versions for browser
export const webCrypto = {
    hash: webCryptoHash,
    encrypt: webCryptoEncrypt,
    decrypt: webCryptoDecrypt,
};

