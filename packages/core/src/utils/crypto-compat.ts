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
import { gcm } from "@noble/ciphers/aes.js";
import { md5, ripemd160, sha1 } from "@noble/hashes/legacy.js";
import { sha224, sha256, sha384, sha512 } from "@noble/hashes/sha2.js";
import type { CHash } from "@noble/hashes/utils.js";
import * as BufferUtils from "./buffer";

type BufferEncodingName = "utf8" | "utf-8" | "base64" | "hex";
type OwnedUint8Array = Uint8Array<ArrayBuffer>;
type HashDigestEncoding = BufferEncodingName;

interface HashBuilder {
	update(data: string | Uint8Array): HashBuilder;
	digest(): Uint8Array;
	digest(encoding: HashDigestEncoding): string;
}

const HASH_ALGORITHMS: Record<string, CHash> = {
	md5,
	ripemd160,
	sha1,
	sha224,
	sha256,
	sha384,
	sha512,
};

/**
 * Normalize supported encodings to the names expected by buffer utils.
 */
function normalizeEncoding(encoding: string): BufferEncodingName {
	switch (encoding.toLowerCase()) {
		case "base64":
			return "base64";
		case "hex":
			return "hex";
		case "utf8":
		case "utf-8":
			return "utf8";
		default:
			throw new Error(
				`Unsupported encoding: ${encoding}. Supported: utf8, utf-8, base64, hex.`,
			);
	}
}

/**
 * Copy arbitrary byte-like input into an owned Uint8Array with an ArrayBuffer backing store.
 */
function toOwnedUint8Array(data: ArrayLike<number>): OwnedUint8Array {
	const output = new Uint8Array(data.length);
	output.set(data);
	return output;
}

/**
 * Convert string or bytes into a Uint8Array.
 */
function toUint8Array(
	data: string | Uint8Array,
	encoding: BufferEncodingName = "utf8",
): OwnedUint8Array {
	if (typeof data === "string") {
		const normalized = normalizeEncoding(encoding);
		return normalized === "hex"
			? toOwnedUint8Array(BufferUtils.fromHex(data))
			: toOwnedUint8Array(BufferUtils.fromString(data, normalized));
	}
	return toOwnedUint8Array(data);
}

/**
 * Convert bytes into a string using the requested encoding.
 */
function toEncodedString(
	bytes: Uint8Array,
	encoding: BufferEncodingName = "utf8",
): string {
	return BufferUtils.bufferToString(bytes, normalizeEncoding(encoding));
}

/**
 * Concatenate two byte arrays into a fresh Uint8Array.
 */
function concatBytes(a: Uint8Array, b: Uint8Array): OwnedUint8Array {
	return toOwnedUint8Array(BufferUtils.concat([a, b]));
}

/**
 * Slice bytes into a fresh Uint8Array.
 */
function sliceBytes(
	bytes: Uint8Array,
	start: number,
	end?: number,
): OwnedUint8Array {
	return toOwnedUint8Array(BufferUtils.slice(bytes, start, end));
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
 * Get Web Crypto SubtleCrypto interface, throwing if unavailable
 */
function getWebCryptoSubtle(): SubtleCrypto {
	const globalThisCrypto = globalThis.crypto;
	const subtle = globalThisCrypto.subtle;
	if (!subtle) {
		throw new Error(
			"Web Crypto API not available. This browser may not support cryptographic operations.",
		);
	}
	return subtle;
}

/**
 * Resolve a synchronous hash implementation.
 */
function getSyncHashFactory(algorithm: string): CHash {
	const normalized = algorithm.toLowerCase();
	const hashFactory = HASH_ALGORITHMS[normalized];
	if (!hashFactory) {
		throw new Error(
			`Unsupported algorithm: ${algorithm}. Supported: ${Object.keys(HASH_ALGORITHMS).join(", ")}`,
		);
	}
	return hashFactory;
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

	const hashBuffer = await subtle.digest(webAlgo, Uint8Array.from(data));
	return new Uint8Array(hashBuffer);
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
 * This function works in both Node.js and browser environments using
 * synchronous noble hash implementations.
 *
 * @param algorithm - Hash algorithm ('sha256', 'sha1', 'sha512')
 * @returns Hash object with update() and digest() methods
 */
export function createHash(algorithm: string): {
	update(data: string | Uint8Array): HashBuilder;
	digest(): Uint8Array;
	digest(encoding: HashDigestEncoding): string;
} {
	const hash = getSyncHashFactory(algorithm).create();
	function digest(): Uint8Array;
	function digest(encoding: HashDigestEncoding): string;
	function digest(encoding?: HashDigestEncoding): Uint8Array | string {
		const hashDigest = Uint8Array.from(hash.digest());
		if (!encoding) {
			return hashDigest;
		}
		return toEncodedString(hashDigest, normalizeEncoding(encoding));
	}
	const builder: HashBuilder = {
		update(data: string | Uint8Array) {
			hash.update(toUint8Array(data));
			return builder;
		},
		digest,
	};
	return builder;
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

	return webCryptoHash(algorithm, bytes);
}

/**
 * Encrypt using AES-256-GCM (synchronous).
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
	const encrypted = Uint8Array.from(
		gcm(
			Uint8Array.from(key),
			Uint8Array.from(iv),
			aad ? Uint8Array.from(aad) : undefined,
		).encrypt(Uint8Array.from(plaintext)),
	);
	const tagStart = encrypted.length - 16;
	return {
		ciphertext: sliceBytes(encrypted, 0, tagStart),
		tag: sliceBytes(encrypted, tagStart),
	};
}

/**
 * Decrypt using AES-256-GCM (synchronous).
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

	const combined = concatBytes(
		Uint8Array.from(ciphertext),
		Uint8Array.from(tag),
	);
	return Uint8Array.from(
		gcm(
			Uint8Array.from(key),
			Uint8Array.from(iv),
			aad ? Uint8Array.from(aad) : undefined,
		).decrypt(combined),
	);
}
