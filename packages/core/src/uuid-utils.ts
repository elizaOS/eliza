import z from "zod";

import type { UUID } from "./types/primitives";

const uuidSchema = z
	.string()
	.regex(
		/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
		"Invalid UUID format",
	) as z.ZodType<UUID>;

/**
 * Validates a UUID value.
 *
 * @param {unknown} value - The value to validate.
 * @returns {UUID | null} Returns the validated UUID value or null if validation fails.
 */
export function validateUuid(value: unknown): UUID | null {
	const result = uuidSchema.safeParse(value);
	return result.success ? result.data : null;
}

/**
 * Converts a string or number to a UUID.
 *
 * @param {string | number} target - The string or number to convert to a UUID.
 * @returns {UUID} The UUID generated from the input target.
 * @throws {TypeError} Throws an error if the input target is not a string.
 */
export function stringToUuid(target: string | number): UUID {
	if (typeof target === "number") {
		target = target.toString();
	}

	if (typeof target !== "string") {
		throw TypeError("Value must be string");
	}

	// If already a UUID, return as-is to avoid re-hashing
	const maybeUuid = validateUuid(target);
	if (maybeUuid) return maybeUuid;

	const escapedStr = encodeURIComponent(target);

	// Deterministic UUID derived from SHA-1(escapedStr)
	// Use WebCrypto if available (sync via cache), otherwise pure JS
	const digest = getCachedSha1(escapedStr); // 20 bytes
	const bytes = digest.slice(0, 16);

	// Set RFC4122 variant bits: 10xxxxxx
	bytes[8] = (bytes[8] & 0x3f) | 0x80;
	// Set custom version nibble to 0x0 (custom elizaOS UUID format)
	bytes[6] = (bytes[6] & 0x0f) | 0x00;

	return bytesToUuid(bytes) as UUID;
}

/**
 * Pre-warm the SHA-1 cache with common values using WebCrypto
 * Call this during initialization to improve performance
 */
export async function prewarmUuidCache(values: string[]): Promise<void> {
	if (!checkWebCrypto()) return;

	const promises = values.map(async (value) => {
		const escapedStr = encodeURIComponent(value);
		const digest = await sha1BytesAsync(escapedStr);
		sha1Cache.set(escapedStr, digest);
	});

	await Promise.all(promises);
}

// Cache for SHA-1 digests to enable synchronous WebCrypto usage
const sha1Cache = new Map<string, Uint8Array>();
let webCryptoAvailable: boolean | null = null;

/**
 * Check if WebCrypto is available for SHA-1
 */
function checkWebCrypto(): boolean {
	if (webCryptoAvailable !== null) return webCryptoAvailable;

	// Check for crypto.subtle (WebCrypto API)
	if (
		typeof globalThis !== "undefined" &&
		globalThis.crypto &&
		globalThis.crypto.subtle &&
		typeof globalThis.crypto.subtle.digest === "function"
	) {
		webCryptoAvailable = true;
		return true;
	}

	webCryptoAvailable = false;
	return false;
}

/**
 * Get SHA-1 digest using cache for synchronous operation
 * Uses WebCrypto when available (via background pre-computation), falls back to pure JS
 */
function getCachedSha1(message: string): Uint8Array {
	// Check cache first
	const cached = sha1Cache.get(message);
	if (cached) return cached;

	// Use synchronous pure JS implementation for immediate result
	const digest = sha1Bytes(message);
	sha1Cache.set(message, digest);

	// Asynchronously compute with WebCrypto for next time (if available)
	if (checkWebCrypto()) {
		sha1BytesAsync(message).then((webDigest) => {
			// Update cache with WebCrypto result (should be identical)
			sha1Cache.set(message, webDigest);
		});
	}

	// Limit cache size to prevent memory leaks
	if (sha1Cache.size > 10000) {
		// Remove oldest entries (first ones in iteration order)
		const keysToDelete = Array.from(sha1Cache.keys()).slice(0, 5000);
		for (const key of keysToDelete) {
			sha1Cache.delete(key);
		}
	}

	return digest;
}

/**
 * Async SHA-1 using WebCrypto when available
 * This can be used to pre-warm the cache
 */
async function sha1BytesAsync(message: string): Promise<Uint8Array> {
	if (checkWebCrypto()) {
		const encoder = new TextEncoder();
		const data = encoder.encode(message);
		const hashBuffer = await globalThis.crypto.subtle.digest("SHA-1", data);
		return new Uint8Array(hashBuffer);
	}

	// Fallback to pure JS implementation
	return sha1Bytes(message);
}

/**
 * Minimal SHA-1 implementation returning raw bytes.
 * Source adapted from public-domain references for portability (browser/Node).
 * Used as fallback when WebCrypto is not available.
 */
function sha1Bytes(message: string): Uint8Array {
	const bytes = utf8Encode(message);
	const ml = bytes.length;

	// Pre-processing (padding)
	const withOne = new Uint8Array(((ml + 9 + 63) >>> 6) << 6); // multiple of 64
	withOne.set(bytes);
	withOne[ml] = 0x80;
	const bitLen = ml * 8;
	// Append length as 64-bit big-endian
	const dv = new DataView(withOne.buffer);
	dv.setUint32(withOne.length - 4, bitLen >>> 0, false);
	dv.setUint32(withOne.length - 8, Math.floor(bitLen / 2 ** 32) >>> 0, false);

	// Initialize hash values
	let h0 = 0x67452301;
	let h1 = 0xefcdab89;
	let h2 = 0x98badcfe;
	let h3 = 0x10325476;
	let h4 = 0xc3d2e1f0;

	const w = new Uint32Array(80);

	for (let i = 0; i < withOne.length; i += 64) {
		// Break chunk into sixteen 32-bit big-endian words
		for (let j = 0; j < 16; j++) {
			w[j] = dv.getUint32(i + j * 4, false);
		}
		// Extend to 80 words
		for (let j = 16; j < 80; j++) {
			const t = w[j - 3] ^ w[j - 8] ^ w[j - 14] ^ w[j - 16];
			w[j] = (t << 1) | (t >>> 31);
		}

		// Initialize working vars
		let a = h0;
		let b = h1;
		let c = h2;
		let d = h3;
		let e = h4;

		for (let j = 0; j < 80; j++) {
			let f: number;
			let k: number;
			if (j < 20) {
				f = (b & c) | (~b & d);
				k = 0x5a827999;
			} else if (j < 40) {
				f = b ^ c ^ d;
				k = 0x6ed9eba1;
			} else if (j < 60) {
				f = (b & c) | (b & d) | (c & d);
				k = 0x8f1bbcdc;
			} else {
				f = b ^ c ^ d;
				k = 0xca62c1d6;
			}
			const temp = (((a << 5) | (a >>> 27)) + f + e + k + w[j]) >>> 0;
			e = d;
			d = c;
			c = ((b << 30) | (b >>> 2)) >>> 0;
			b = a;
			a = temp;
		}

		h0 = (h0 + a) >>> 0;
		h1 = (h1 + b) >>> 0;
		h2 = (h2 + c) >>> 0;
		h3 = (h3 + d) >>> 0;
		h4 = (h4 + e) >>> 0;
	}

	const out = new Uint8Array(20);
	const outDv = new DataView(out.buffer);
	outDv.setUint32(0, h0, false);
	outDv.setUint32(4, h1, false);
	outDv.setUint32(8, h2, false);
	outDv.setUint32(12, h3, false);
	outDv.setUint32(16, h4, false);
	return out;
}

function utf8Encode(str: string): Uint8Array {
	if (typeof TextEncoder !== "undefined") {
		return new TextEncoder().encode(str);
	}
	// Fallback
	const utf8: number[] = [];
	for (let i = 0; i < str.length; i++) {
		const charcode = str.charCodeAt(i);
		if (charcode < 0x80) utf8.push(charcode);
		else if (charcode < 0x800) {
			utf8.push(0xc0 | (charcode >> 6), 0x80 | (charcode & 0x3f));
		} else if (charcode < 0xd800 || charcode >= 0xe000) {
			utf8.push(
				0xe0 | (charcode >> 12),
				0x80 | ((charcode >> 6) & 0x3f),
				0x80 | (charcode & 0x3f),
			);
		} else {
			// surrogate pair
			i++;
			// UTF-16 to Unicode code point
			const codePoint =
				0x10000 + (((charcode & 0x3ff) << 10) | (str.charCodeAt(i) & 0x3ff));
			utf8.push(
				0xf0 | (codePoint >> 18),
				0x80 | ((codePoint >> 12) & 0x3f),
				0x80 | ((codePoint >> 6) & 0x3f),
				0x80 | (codePoint & 0x3f),
			);
		}
	}
	return new Uint8Array(utf8);
}

function bytesToUuid(bytes: Uint8Array): string {
	const hex: string[] = [];
	for (let i = 0; i < 16; i++) {
		hex.push(bytes[i].toString(16).padStart(2, "0"));
	}
	return [
		hex.slice(0, 4).join(""),
		hex.slice(4, 6).join(""),
		hex.slice(6, 8).join(""),
		hex.slice(8, 10).join(""),
		hex.slice(10, 16).join(""),
	].join("-");
}
