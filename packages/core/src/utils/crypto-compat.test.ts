/**
 * Behavioral coverage for packages/core/src/utils/crypto-compat.ts.
 *
 * AES-256-GCM is already pinned in crypto-compat.aes-gcm.test.ts. This file
 * drives the remaining public helpers against independent oracles (node:crypto
 * and Web Crypto) rather than mocked return values: sync hashes, Web Crypto
 * hashes, AES-256-CBC cipher/decipher (including PKCS#7 and chunking), and
 * the async AES-CBC wrappers.
 */
import {
	createCipheriv as nodeCreateCipheriv,
	createDecipheriv as nodeCreateDecipheriv,
	createHash as nodeCreateHash,
} from "node:crypto";
import { describe, expect, it } from "vitest";
import {
	createCipheriv,
	createDecipheriv,
	createHash,
	createHashAsync,
	decryptAes256Gcm,
	decryptAsync,
	encryptAes256Gcm,
	encryptAsync,
} from "./crypto-compat.ts";

const AES_CBC_KEY = new Uint8Array(32).map((_, i) => i + 1);
const AES_CBC_IV = new Uint8Array(16).map((_, i) => i + 50);
const AES_GCM_KEY = new Uint8Array(32).map((_, i) => i + 1);
const AES_GCM_IV = new Uint8Array(12).map((_, i) => i + 100);
const PLAINTEXT = "wallet private key: do not leak";

const bytes = (value: Uint8Array) => Array.from(value);

function nodeDigestHex(algorithm: string, data: string | Uint8Array): string {
	return nodeCreateHash(algorithm).update(data).digest("hex");
}

function nodeEncryptHex(
	key: Uint8Array,
	iv: Uint8Array,
	plaintext: string,
): string {
	const cipher = nodeCreateCipheriv(
		"aes-256-cbc",
		Buffer.from(key),
		Buffer.from(iv),
	);
	return cipher.update(plaintext, "utf8", "hex") + cipher.final("hex");
}

function concatCipherHex(
	key: Uint8Array,
	iv: Uint8Array,
	plaintext: string,
	inputEncoding: "utf8" | "utf-8" | "hex" | "base64" = "utf8",
	outputEncoding: "utf8" | "utf-8" | "hex" | "base64" = "hex",
): string {
	const cipher = createCipheriv("aes-256-cbc", key, iv);
	return (
		cipher.update(plaintext, inputEncoding, outputEncoding) +
		cipher.final(outputEncoding)
	);
}

describe("createHash", () => {
	it("matches node:crypto for every supported algorithm", () => {
		const payload = "eliza-crypto-compat";
		for (const algorithm of [
			"md5",
			"ripemd160",
			"sha1",
			"sha224",
			"sha256",
			"sha384",
			"sha512",
		]) {
			expect(createHash(algorithm).update(payload).digest("hex")).toBe(
				nodeDigestHex(algorithm, payload),
			);
		}
	});

	it("normalizes algorithm names case-insensitively", () => {
		const payload = "CaseFold";
		expect(createHash("SHA256").update(payload).digest("hex")).toBe(
			nodeDigestHex("sha256", payload),
		);
		expect(createHash("Sha1").update(payload).digest("hex")).toBe(
			nodeDigestHex("sha1", payload),
		);
	});

	it("rejects unknown algorithms with the supported list", () => {
		expect(() => createHash("blake2s")).toThrow(
			/Unsupported algorithm: blake2s\. Supported: md5, ripemd160, sha1, sha224, sha256, sha384, sha512/,
		);
		expect(() => createHash("sha-256")).toThrow(/Unsupported algorithm/);
	});

	it("hashes empty input and incremental chunks the same as a single update", () => {
		expect(createHash("sha256").update("").digest("hex")).toBe(
			nodeDigestHex("sha256", ""),
		);
		const chained = createHash("sha256")
			.update("hel")
			.update("lo")
			.digest("hex");
		expect(chained).toBe(nodeDigestHex("sha256", "hello"));
		expect(chained).toBe(createHash("sha256").update("hello").digest("hex"));
	});

	it("accepts Uint8Array input and returns a raw digest by default", () => {
		const payload = new Uint8Array([0, 1, 255, 16]);
		const digest = createHash("sha256").update(payload).digest();
		expect(digest).toBeInstanceOf(Uint8Array);
		expect(Buffer.from(digest).toString("hex")).toBe(
			nodeDigestHex("sha256", payload),
		);
	});

	it("encodes digests as hex, base64, and utf8", () => {
		const raw = createHash("sha256").update("encode-me").digest();
		expect(createHash("sha256").update("encode-me").digest("hex")).toBe(
			Buffer.from(raw).toString("hex"),
		);
		expect(createHash("sha256").update("encode-me").digest("base64")).toBe(
			Buffer.from(raw).toString("base64"),
		);
		expect(createHash("sha256").update("encode-me").digest("utf8")).toBe(
			Buffer.from(raw).toString("utf8"),
		);
		expect(createHash("sha256").update("encode-me").digest("utf-8")).toBe(
			Buffer.from(raw).toString("utf8"),
		);
	});

	it("rejects unsupported digest encodings", () => {
		expect(() =>
			createHash("sha256")
				.update("x")
				.digest("latin1" as never),
		).toThrow(
			/Unsupported encoding: latin1\. Supported: utf8, utf-8, base64, hex\./,
		);
	});
});

describe("createHashAsync", () => {
	it("matches createHash and node:crypto for Web Crypto algorithms", async () => {
		const payload = "async-hash-payload";
		for (const algorithm of ["sha1", "sha256", "sha512"] as const) {
			const asyncDigest = await createHashAsync(algorithm, payload);
			expect(Buffer.from(asyncDigest).toString("hex")).toBe(
				createHash(algorithm).update(payload).digest("hex"),
			);
			expect(Buffer.from(asyncDigest).toString("hex")).toBe(
				nodeDigestHex(algorithm, payload),
			);
		}
	});

	it("hashes Uint8Array input the same as the equivalent string", async () => {
		const text = "byte-input";
		const fromString = await createHashAsync("sha256", text);
		const fromBytes = await createHashAsync(
			"sha256",
			new TextEncoder().encode(text),
		);
		expect(bytes(fromBytes)).toEqual(bytes(fromString));
	});

	it("normalizes algorithm names and rejects algorithms Web Crypto does not map", async () => {
		const payload = "web-crypto-only";
		expect(
			Buffer.from(await createHashAsync("SHA256", payload)).toString("hex"),
		).toBe(nodeDigestHex("sha256", payload));
		await expect(createHashAsync("md5", payload)).rejects.toThrow(
			/Unsupported algorithm: md5\. Supported: sha256, sha1, sha512/,
		);
		await expect(createHashAsync("sha224", payload)).rejects.toThrow(
			/Unsupported algorithm/,
		);
		await expect(createHashAsync("sha384", payload)).rejects.toThrow(
			/Unsupported algorithm/,
		);
	});
});

describe("createCipheriv / createDecipheriv AES-256-CBC", () => {
	it("round-trips UTF-8 plaintext and matches node:crypto ciphertext", () => {
		const hex = concatCipherHex(AES_CBC_KEY, AES_CBC_IV, PLAINTEXT);
		expect(hex).toBe(nodeEncryptHex(AES_CBC_KEY, AES_CBC_IV, PLAINTEXT));

		const decipher = createDecipheriv("aes-256-cbc", AES_CBC_KEY, AES_CBC_IV);
		const recovered =
			decipher.update(hex, "hex", "utf8") + decipher.final("utf8");
		expect(recovered).toBe(PLAINTEXT);

		const nodeDecipher = nodeCreateDecipheriv(
			"aes-256-cbc",
			Buffer.from(AES_CBC_KEY),
			Buffer.from(AES_CBC_IV),
		);
		expect(
			nodeDecipher.update(hex, "hex", "utf8") + nodeDecipher.final("utf8"),
		).toBe(PLAINTEXT);
	});

	it("round-trips empty plaintext as a full PKCS#7 padding block", () => {
		const hex = concatCipherHex(AES_CBC_KEY, AES_CBC_IV, "");
		expect(hex.length).toBe(32);
		const decipher = createDecipheriv("aes-256-cbc", AES_CBC_KEY, AES_CBC_IV);
		expect(decipher.update(hex, "hex", "utf8") + decipher.final("utf8")).toBe(
			"",
		);
	});

	it("round-trips an exact AES block of plaintext (extra padding block)", () => {
		const block = "0123456789abcdef";
		expect(block.length).toBe(16);
		const hex = concatCipherHex(AES_CBC_KEY, AES_CBC_IV, block);
		expect(Buffer.from(hex, "hex").length).toBe(32);
		const decipher = createDecipheriv("aes-256-cbc", AES_CBC_KEY, AES_CBC_IV);
		expect(decipher.update(hex, "hex", "utf8") + decipher.final("utf8")).toBe(
			block,
		);
	});

	it("holds a partial block in update and emits it from final", () => {
		const cipher = createCipheriv("aes-256-cbc", AES_CBC_KEY, AES_CBC_IV);
		expect(cipher.update("short", "utf8", "hex")).toBe("");
		const hex = cipher.final("hex");
		expect(hex.length).toBe(32);
		const decipher = createDecipheriv("aes-256-cbc", AES_CBC_KEY, AES_CBC_IV);
		expect(decipher.update(hex, "hex", "utf8")).toBe("");
		expect(decipher.final("utf8")).toBe("short");
	});

	it("encrypts full blocks in update and keeps a remainder for final", () => {
		const cipher = createCipheriv("aes-256-cbc", AES_CBC_KEY, AES_CBC_IV);
		const first = cipher.update("0123456789abcdefMORE", "utf8", "hex");
		expect(Buffer.from(first, "hex").length).toBe(16);
		const rest = cipher.final("hex");
		expect(Buffer.from(rest, "hex").length).toBe(16);
		const decipher = createDecipheriv("aes-256-cbc", AES_CBC_KEY, AES_CBC_IV);
		const combined = first + rest;
		const recovered =
			decipher.update(combined, "hex", "utf8") + decipher.final("utf8");
		expect(recovered).toBe("0123456789abcdefMORE");
	});

	it("decrypts in 16-byte chunks and withholds the last block until final", () => {
		const hex = concatCipherHex(AES_CBC_KEY, AES_CBC_IV, PLAINTEXT);
		const ciphertext = Buffer.from(hex, "hex");
		expect(ciphertext.length).toBeGreaterThan(16);
		const decipher = createDecipheriv("aes-256-cbc", AES_CBC_KEY, AES_CBC_IV);
		const firstBlockHex = ciphertext.subarray(0, 16).toString("hex");
		expect(decipher.update(firstBlockHex, "hex", "utf8")).toBe("");
		const recovered =
			decipher.update(ciphertext.subarray(16).toString("hex"), "hex", "utf8") +
			decipher.final("utf8");
		expect(recovered).toBe(PLAINTEXT);
	});

	it("accepts hex and base64 input encodings and utf-8 aliases", () => {
		const utf8Hex = concatCipherHex(
			AES_CBC_KEY,
			AES_CBC_IV,
			"Hello",
			"utf8",
			"hex",
		);
		expect(
			concatCipherHex(AES_CBC_KEY, AES_CBC_IV, "Hello", "utf-8", "hex"),
		).toBe(utf8Hex);
		expect(
			concatCipherHex(
				AES_CBC_KEY,
				AES_CBC_IV,
				Buffer.from("Hello").toString("hex"),
				"hex",
				"hex",
			),
		).toBe(utf8Hex);
		expect(
			concatCipherHex(
				AES_CBC_KEY,
				AES_CBC_IV,
				Buffer.from("Hello").toString("base64"),
				"base64",
				"hex",
			),
		).toBe(utf8Hex);

		const base64Out = concatCipherHex(
			AES_CBC_KEY,
			AES_CBC_IV,
			"Hello",
			"utf8",
			"base64",
		);
		expect(Buffer.from(base64Out, "base64").toString("hex")).toBe(utf8Hex);
	});

	it("accepts case-insensitive encodings", () => {
		const cipher = createCipheriv("aes-256-cbc", AES_CBC_KEY, AES_CBC_IV);
		const hex = cipher.update("Hello", "UTF8", "HEX") + cipher.final("HEX");
		expect(hex).toBe(
			concatCipherHex(AES_CBC_KEY, AES_CBC_IV, "Hello", "utf8", "hex"),
		);
	});

	it("rejects unsupported algorithms, key lengths, IV lengths, and encodings", () => {
		expect(() =>
			createCipheriv("aes-128-cbc", AES_CBC_KEY, AES_CBC_IV),
		).toThrow(
			/Unsupported algorithm: aes-128-cbc\. Only 'aes-256-cbc' is supported\./,
		);
		expect(() =>
			createDecipheriv("aes-256-gcm", AES_CBC_KEY, AES_CBC_IV),
		).toThrow(/Only 'aes-256-cbc' is supported/);
		expect(() =>
			createCipheriv("aes-256-cbc", new Uint8Array(16), AES_CBC_IV),
		).toThrow(/Invalid key length: 16 bytes\. Expected 32 bytes for AES-256\./);
		expect(() =>
			createCipheriv("aes-256-cbc", AES_CBC_KEY, new Uint8Array(12)),
		).toThrow(/Invalid IV length: 12 bytes\. Expected 16 bytes for AES-CBC\./);
		expect(() =>
			createCipheriv("aes-256-cbc", AES_CBC_KEY, AES_CBC_IV).update(
				"x",
				"latin1",
				"hex",
			),
		).toThrow(/Unsupported encoding: latin1/);
	});

	it("rejects truncated ciphertext and invalid PKCS#7 padding on final", () => {
		const decipherEmpty = createDecipheriv(
			"aes-256-cbc",
			AES_CBC_KEY,
			AES_CBC_IV,
		);
		expect(() => decipherEmpty.final("utf8")).toThrow(
			/Invalid ciphertext length for AES-CBC payload\./,
		);

		const decipherShort = createDecipheriv(
			"aes-256-cbc",
			AES_CBC_KEY,
			AES_CBC_IV,
		);
		decipherShort.update("aabbccdd", "hex", "utf8");
		expect(() => decipherShort.final("utf8")).toThrow(
			/Invalid ciphertext length for AES-CBC payload\./,
		);

		const hex = concatCipherHex(AES_CBC_KEY, AES_CBC_IV, "pad-check");
		const tampered = Buffer.from(hex, "hex");
		tampered[tampered.length - 1] ^= 0xff;
		const decipherBad = createDecipheriv(
			"aes-256-cbc",
			AES_CBC_KEY,
			AES_CBC_IV,
		);
		decipherBad.update(tampered.toString("hex"), "hex", "utf8");
		expect(() => decipherBad.final("utf8")).toThrow(/Invalid PKCS#7 padding\./);
	});
});

describe("encryptAsync / decryptAsync AES-256-CBC", () => {
	it("round-trips bytes and matches createCipheriv ciphertext", async () => {
		const plaintext = new TextEncoder().encode(PLAINTEXT);
		const ciphertext = await encryptAsync(AES_CBC_KEY, AES_CBC_IV, plaintext);
		expect(Buffer.from(ciphertext).toString("hex")).toBe(
			concatCipherHex(AES_CBC_KEY, AES_CBC_IV, PLAINTEXT),
		);
		const recovered = await decryptAsync(AES_CBC_KEY, AES_CBC_IV, ciphertext);
		expect(bytes(recovered)).toEqual(bytes(plaintext));
	});

	it("round-trips empty plaintext", async () => {
		const ciphertext = await encryptAsync(
			AES_CBC_KEY,
			AES_CBC_IV,
			new Uint8Array(0),
		);
		expect(ciphertext.length).toBe(16);
		const recovered = await decryptAsync(AES_CBC_KEY, AES_CBC_IV, ciphertext);
		expect(recovered.length).toBe(0);
	});

	it("rejects invalid key and IV lengths before touching Web Crypto", async () => {
		const plaintext = new Uint8Array([1, 2, 3]);
		await expect(
			encryptAsync(new Uint8Array(16), AES_CBC_IV, plaintext),
		).rejects.toThrow(/Invalid key length: 16 bytes/);
		await expect(
			encryptAsync(AES_CBC_KEY, new Uint8Array(12), plaintext),
		).rejects.toThrow(/Invalid IV length: 12 bytes/);
		await expect(
			decryptAsync(new Uint8Array(31), AES_CBC_IV, new Uint8Array(16)),
		).rejects.toThrow(/Invalid key length: 31 bytes/);
		await expect(
			decryptAsync(AES_CBC_KEY, new Uint8Array(15), new Uint8Array(16)),
		).rejects.toThrow(/Invalid IV length: 15 bytes/);
	});

	it("rejects decryption under the wrong key", async () => {
		const ciphertext = await encryptAsync(
			AES_CBC_KEY,
			AES_CBC_IV,
			new TextEncoder().encode("secret"),
		);
		const otherKey = new Uint8Array(32).map((_, i) => 255 - i);
		await expect(
			decryptAsync(otherKey, AES_CBC_IV, ciphertext),
		).rejects.toThrow();
	});
});

describe("AES-256-GCM exports remain wired", () => {
	it("round-trips through the same helpers covered in crypto-compat.aes-gcm.test.ts", () => {
		const plaintext = new TextEncoder().encode("gcm-export-smoke");
		const { ciphertext, tag } = encryptAes256Gcm(
			AES_GCM_KEY,
			AES_GCM_IV,
			plaintext,
		);
		expect(tag.length).toBe(16);
		expect(
			bytes(decryptAes256Gcm(AES_GCM_KEY, AES_GCM_IV, ciphertext, tag)),
		).toEqual(bytes(plaintext));
	});

	it("rejects GCM key, IV, and tag length errors", () => {
		const plaintext = new Uint8Array([9, 8, 7]);
		expect(() =>
			encryptAes256Gcm(new Uint8Array(16), AES_GCM_IV, plaintext),
		).toThrow(/Invalid key length: 16 bytes\. Expected 32 bytes for AES-256\./);
		expect(() =>
			encryptAes256Gcm(AES_GCM_KEY, new Uint8Array(16), plaintext),
		).toThrow(/Invalid IV length: 16 bytes\. Expected 12 bytes for AES-GCM\./);
		expect(() =>
			decryptAes256Gcm(
				AES_GCM_KEY,
				AES_GCM_IV,
				new Uint8Array(4),
				new Uint8Array(8),
			),
		).toThrow(
			/Invalid tag length: 8 bytes\. Expected 16 bytes for AES-GCM tag\./,
		);
	});
});
