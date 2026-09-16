/** Node cryptographic primitives. Stored CBC and authenticated GCM formats stay unchanged. */
import {
	createHash as nodeCreateHash,
	createCipheriv as nodeCreateCipheriv,
	createDecipheriv as nodeCreateDecipheriv,
	webcrypto,
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
const HASH_ALGORITHMS = [
	"md5",
	"ripemd160",
	"sha1",
	"sha224",
	"sha256",
	"sha384",
	"sha512",
];
export function createHash(algorithm: string) {
	if (!HASH_ALGORITHMS.includes(algorithm.toLowerCase()))
		throw new Error(
			`Unsupported algorithm: ${algorithm}. Supported: ${HASH_ALGORITHMS.join(", ")}`,
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
export async function createHashAsync(
	algorithm: string,
	data: string | Uint8Array,
): Promise<Uint8Array> {
	const algorithms: Record<string, string> = {
		sha256: "SHA-256",
		sha1: "SHA-1",
		sha512: "SHA-512",
	};
	const name = algorithms[algorithm.toLowerCase()];
	if (!name)
		throw new Error(
			`Unsupported algorithm: ${algorithm}. Supported: ${Object.keys(algorithms).join(", ")}`,
		);
	return new Uint8Array(
		await webcrypto.subtle.digest(
			name,
			typeof data === "string"
				? new TextEncoder().encode(data)
				: Uint8Array.from(data),
		),
	);
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

function cbcTransform(
	algorithm: string,
	key: Uint8Array,
	iv: Uint8Array,
	decrypt: boolean,
) {
	if (algorithm !== "aes-256-cbc")
		throw new Error(
			`Unsupported algorithm: ${algorithm}. Only 'aes-256-cbc' is supported.`,
		);
	validateKeyAndIv(key, iv);
	const cipher = decrypt
		? nodeCreateDecipheriv(algorithm, key, iv)
		: nodeCreateCipheriv(algorithm, key, iv);
	return {
		update(
			data: string,
			inputEncoding: string,
			outputEncoding: string,
		): string {
			return cipher.update(
				data,
				normalizeEncoding(inputEncoding),
				normalizeEncoding(outputEncoding),
			);
		},
		final(encoding: string): string {
			return cipher.final(normalizeEncoding(encoding));
		},
	};
}
export function createCipheriv(
	algorithm: string,
	key: Uint8Array,
	iv: Uint8Array,
) {
	return cbcTransform(algorithm, key, iv, false);
}
export function createDecipheriv(
	algorithm: string,
	key: Uint8Array,
	iv: Uint8Array,
) {
	return cbcTransform(algorithm, key, iv, true);
}
export async function encryptAsync(
	key: Uint8Array,
	iv: Uint8Array,
	data: Uint8Array,
): Promise<Uint8Array> {
	validateKeyAndIv(key, iv);
	const cipher = nodeCreateCipheriv("aes-256-cbc", key, iv);
	return Buffer.concat([cipher.update(data), cipher.final()]);
}
export async function decryptAsync(
	key: Uint8Array,
	iv: Uint8Array,
	data: Uint8Array,
): Promise<Uint8Array> {
	validateKeyAndIv(key, iv);
	const cipher = nodeCreateDecipheriv("aes-256-cbc", key, iv);
	return Buffer.concat([cipher.update(data), cipher.final()]);
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
