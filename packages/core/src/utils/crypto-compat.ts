/** Node cryptographic primitives. Stored CBC and authenticated GCM formats stay unchanged. */
import {
	createCipheriv as nodeCreateCipheriv,
	createDecipheriv as nodeCreateDecipheriv,
	createHash as nodeCreateHash,
} from "node:crypto";

type Encoding = "utf8" | "utf-8" | "base64" | "hex";
function normalizeEncoding(value: string): Encoding {
	const encoding = value.toLowerCase();
	if (
		encoding === "utf8" ||
		encoding === "utf-8" ||
		encoding === "base64" ||
		encoding === "hex"
	)
		return encoding;
	throw new Error(
		`Unsupported encoding: ${value}. Supported: utf8, utf-8, base64, hex.`,
	);
}
const HASH_ALGORITHMS = new Set([
	"md5",
	"ripemd160",
	"sha1",
	"sha224",
	"sha256",
	"sha384",
	"sha512",
]);
export function createHash(algorithm: string) {
	if (!HASH_ALGORITHMS.has(algorithm.toLowerCase()))
		throw new Error(
			`Unsupported algorithm: ${algorithm}. Supported: ${[...HASH_ALGORITHMS].join(", ")}`,
		);
	const hash = nodeCreateHash(algorithm);
	function digest(): Uint8Array;
	function digest(encoding: Encoding): string;
	function digest(encoding?: Encoding): Uint8Array | string {
		const bytes = hash.digest();
		return encoding ? bytes.toString(normalizeEncoding(encoding)) : bytes;
	}
	const builder = {
		update(data: string | Uint8Array) {
			hash.update(data);
			return builder;
		},
		digest,
	};
	return builder;
}
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

/** Decrypts the legacy stored AES-256-CBC format; new data is written with GCM. */
export function createDecipheriv(
	algorithm: string,
	key: Uint8Array,
	iv: Uint8Array,
) {
	if (algorithm !== "aes-256-cbc")
		throw new Error(
			`Unsupported algorithm: ${algorithm}. Only 'aes-256-cbc' is supported.`,
		);
	validateKeyAndIv(key, iv);
	const decipher = nodeCreateDecipheriv(algorithm, key, iv);
	return {
		update(
			data: string,
			inputEncoding: string,
			outputEncoding: string,
		): string {
			return decipher.update(
				data,
				normalizeEncoding(inputEncoding),
				normalizeEncoding(outputEncoding),
			);
		},
		final(encoding: string): string {
			return decipher.final(normalizeEncoding(encoding));
		},
	};
}
export function encryptAes256Gcm(
	key: Uint8Array,
	iv: Uint8Array,
	plaintext: Uint8Array,
	aad?: Uint8Array,
): { ciphertext: Uint8Array; tag: Uint8Array } {
	validateKeyAndGcmIv(key, iv);
	const cipher = nodeCreateCipheriv("aes-256-gcm", key, iv);
	if (aad) cipher.setAAD(aad);
	const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
	return { ciphertext, tag: cipher.getAuthTag() };
}
export function decryptAes256Gcm(
	key: Uint8Array,
	iv: Uint8Array,
	ciphertext: Uint8Array,
	tag: Uint8Array,
	aad?: Uint8Array,
): Uint8Array {
	validateKeyAndGcmIv(key, iv);
	if (tag.length !== 16)
		throw new Error(
			`Invalid tag length: ${tag.length} bytes. Expected 16 bytes for AES-GCM tag.`,
		);
	const cipher = nodeCreateDecipheriv("aes-256-gcm", key, iv);
	if (aad) cipher.setAAD(aad);
	cipher.setAuthTag(tag);
	return Buffer.concat([cipher.update(ciphertext), cipher.final()]);
}
