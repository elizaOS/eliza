/**
 * Behavioral coverage for packages/core/src/utils/crypto-compat.ts.
 *
 * AES-256-GCM is already pinned in crypto-compat.aes-gcm.test.ts. This file
 * drives the remaining public helpers against independent oracles (node:crypto
 * and Web Crypto) rather than mocked return values: sync hashes, Web Crypto
 * hashes, AES-256-CBC cipher/decipher (PKCS#7, chunking, stateful UTF-8/base64
 * output streaming, encoding locks), and the async AES-CBC wrappers.
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

	it("preserves a leading UTF-8 BOM in utf8 output like node:crypto", () => {
		const bomPlaintext = "\ufeffhello";
		const hex = concatCipherHex(AES_CBC_KEY, AES_CBC_IV, bomPlaintext);
		const nodeDecipher = nodeCreateDecipheriv(
			"aes-256-cbc",
			Buffer.from(AES_CBC_KEY),
			Buffer.from(AES_CBC_IV),
		);
		const nodeOut =
			nodeDecipher.update(hex, "hex", "utf8") + nodeDecipher.final("utf8");
		const decipher = createDecipheriv("aes-256-cbc", AES_CBC_KEY, AES_CBC_IV);
		const ourOut = decipher.update(hex, "hex", "utf8") + decipher.final("utf8");
		expect(ourOut).toBe(nodeOut);
		expect(ourOut.startsWith("\ufeff")).toBe(true);
	});

	it("preserves a UTF-8 BOM split across update chunks like node:crypto", () => {
		// 17 plaintext bytes: BOM (3) + 14 chars, so the first update decrypts
		// 16 bytes (BOM fully inside the first chunk) and the second update
		// plus final carry the tail; ciphertext fed in 10-byte slices.
		const bomPlaintext = "\ufeff0123456789abcd";
		const nodeCipher = nodeCreateCipheriv(
			"aes-256-cbc",
			Buffer.from(AES_CBC_KEY),
			Buffer.from(AES_CBC_IV),
		);
		const hex =
			nodeCipher.update(bomPlaintext, "utf8", "hex") + nodeCipher.final("hex");
		const buf = Buffer.from(hex, "hex");
		const nodeDecipher = nodeCreateDecipheriv(
			"aes-256-cbc",
			Buffer.from(AES_CBC_KEY),
			Buffer.from(AES_CBC_IV),
		);
		let nodeOut = "";
		for (let o = 0; o < buf.length; o += 10) {
			nodeOut += nodeDecipher.update(
				buf.subarray(o, o + 10),
				undefined as unknown as "hex",
				"utf8",
			);
		}
		nodeOut += nodeDecipher.final("utf8");
		const decipher = createDecipheriv("aes-256-cbc", AES_CBC_KEY, AES_CBC_IV);
		let ourOut = "";
		for (let o = 0; o < buf.length; o += 10) {
			ourOut += decipher.update(
				buf.subarray(o, o + 10).toString("hex"),
				"hex",
				"utf8",
			);
		}
		ourOut += decipher.final("utf8");
		expect(ourOut).toBe(nodeOut);
		expect(ourOut).toBe(bomPlaintext);
	});

	it("emits non-3-byte-aligned base64 decipher output across update/final like node:crypto", () => {
		// 17 plaintext bytes: update decrypts 16, final decrypts the 17-byte
		// remainder minus hold-back → the concatenated base64 of update+final
		// must equal node's one-shot base64 (no mid-stream padding).
		const plaintext = "0123456789abcdefg"; // 17 chars
		const nodeCipher = nodeCreateCipheriv(
			"aes-256-cbc",
			Buffer.from(AES_CBC_KEY),
			Buffer.from(AES_CBC_IV),
		);
		const b64 =
			nodeCipher.update(plaintext, "utf8", "base64") +
			nodeCipher.final("base64");
		const raw = Buffer.from(b64, "base64");
		const nodeDecipher = nodeCreateDecipheriv(
			"aes-256-cbc",
			Buffer.from(AES_CBC_KEY),
			Buffer.from(AES_CBC_IV),
		);
		let nodeOut = "";
		for (let o = 0; o < raw.length; o += 10) {
			nodeOut += nodeDecipher.update(
				raw.subarray(o, o + 10),
				undefined as unknown as "hex",
				"base64",
			);
		}
		nodeOut += nodeDecipher.final("base64");
		const decipher = createDecipheriv("aes-256-cbc", AES_CBC_KEY, AES_CBC_IV);
		let ourOut = "";
		for (let o = 0; o < raw.length; o += 10) {
			ourOut += decipher.update(
				raw.subarray(o, o + 10).toString("base64"),
				"base64",
				"base64",
			);
		}
		ourOut += decipher.final("base64");
		expect(ourOut).toBe(nodeOut);
		expect(ourOut).toBe(Buffer.from(plaintext, "utf8").toString("base64"));
	});

	it("throws on update after final like node:crypto (cipher)", () => {
		const cipher = createCipheriv("aes-256-cbc", AES_CBC_KEY, AES_CBC_IV);
		cipher.update("data", "utf8", "hex");
		cipher.final("hex");
		expect(() => cipher.update("more", "utf8", "hex")).toThrow(
			/Trying to add data in unsupported state/,
		);
	});

	it("throws on double final like node:crypto (cipher)", () => {
		const cipher = createCipheriv("aes-256-cbc", AES_CBC_KEY, AES_CBC_IV);
		cipher.update("data", "utf8", "hex");
		cipher.final("hex");
		expect(() => cipher.final("hex")).toThrow(/Unsupported state/);
	});

	it("throws on update after final like node:crypto (decipher)", () => {
		const hex = concatCipherHex(AES_CBC_KEY, AES_CBC_IV, PLAINTEXT);
		const decipher = createDecipheriv("aes-256-cbc", AES_CBC_KEY, AES_CBC_IV);
		decipher.update(hex, "hex", "utf8");
		decipher.final("utf8");
		expect(() => decipher.update(hex, "hex", "utf8")).toThrow(
			/Trying to add data in unsupported state/,
		);
	});

	it("consumes state on failed final (truncated ciphertext) like node:crypto", () => {
		const hex = concatCipherHex(AES_CBC_KEY, AES_CBC_IV, PLAINTEXT);
		const truncated = hex.slice(0, hex.length - 4); // not block-multiple
		const decipher = createDecipheriv("aes-256-cbc", AES_CBC_KEY, AES_CBC_IV);
		decipher.update(truncated, "hex", "utf8");
		expect(() => decipher.final("utf8")).toThrow(
			/Invalid ciphertext length for AES-CBC payload\./,
		);
		// node:crypto rejects any further use after a failed finalization
		expect(() => decipher.update("00", "hex", "utf8")).toThrow(
			/Trying to add data in unsupported state/,
		);
		expect(() => decipher.final("utf8")).toThrow(/Unsupported state/);
	});

	it("consumes state on failed final (invalid padding) like node:crypto", () => {
		// Build a block-aligned ciphertext whose final block decrypts to
		// garbage padding (wrong key for the last block only is hard; instead
		// encrypt with a DIFFERENT key entirely so padding check fails).
		const wrongKey = new Uint8Array(32).fill(7);
		const nodeCipher = nodeCreateCipheriv(
			"aes-256-cbc",
			Buffer.from(wrongKey),
			Buffer.from(AES_CBC_IV),
		);
		const hex =
			nodeCipher.update("pad-breaking payload", "utf8", "hex") +
			nodeCipher.final("hex");
		const decipher = createDecipheriv("aes-256-cbc", AES_CBC_KEY, AES_CBC_IV);
		decipher.update(hex, "hex", "utf8");
		expect(() => decipher.final("utf8")).toThrow();
		expect(() => decipher.update("00", "hex", "utf8")).toThrow(
			/Trying to add data in unsupported state/,
		);
		expect(() => decipher.final("utf8")).toThrow(/Unsupported state/);
	});

	it("throws on double final like node:crypto (decipher)", () => {
		const hex = concatCipherHex(AES_CBC_KEY, AES_CBC_IV, PLAINTEXT);
		const decipher = createDecipheriv("aes-256-cbc", AES_CBC_KEY, AES_CBC_IV);
		decipher.update(hex, "hex", "utf8");
		decipher.final("utf8");
		expect(() => decipher.final("utf8")).toThrow(/Unsupported state/);
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

	it("decodes a multibyte UTF-8 character split across the update()/final() boundary", () => {
		// "€" is E2 82 AC; starting it at byte 15 puts its lead byte at the end
		// of the first plaintext block, so the sequence straddles the last
		// update() chunk and the final() tail. Regression pin (#28947):
		// per-chunk decoding emitted U+FFFD here while node:crypto streamed it
		// through one stateful decoder.
		const plaintext = `${"a".repeat(15)}€tail`;
		const hex = nodeEncryptHex(AES_CBC_KEY, AES_CBC_IV, plaintext);
		const decipher = createDecipheriv("aes-256-cbc", AES_CBC_KEY, AES_CBC_IV);
		expect(decipher.update(hex, "hex", "utf8") + decipher.final("utf8")).toBe(
			plaintext,
		);
	});

	it("decodes multibyte UTF-8 split across two update() chunks and hands the held-back sequence between output-producing updates", () => {
		// 29 a's + 🚀 (F0 9F 9A 80) + "cd" = 35 bytes -> 48-byte ciphertext (3
		// blocks). Feeding update() 32 bytes of ciphertext at a time makes the
		// second update emit plaintext ending MID-EMOJI (the sequence starts at
		// byte 29), so it completes in a later chunk than its lead byte.
		const emoji = `${"a".repeat(29)}🚀cd`;
		const emojiHex = nodeEncryptHex(AES_CBC_KEY, AES_CBC_IV, emoji);
		const d1 = createDecipheriv("aes-256-cbc", AES_CBC_KEY, AES_CBC_IV);
		expect(
			d1.update(emojiHex.slice(0, 64), "hex", "utf8") +
				d1.update(emojiHex.slice(64), "hex", "utf8") +
				d1.final("utf8"),
		).toBe(emoji);

		// 14 b's put the €'s E2 at byte 14, 82 at 15 (block 1), AC at 16
		// (block 2): the first output-producing update must emit exactly the
		// 14 b's and hold the partial sequence back for the next update.
		const straddling = `${"b".repeat(14)}€${"c".repeat(50)}`;
		const straddlingHex = nodeEncryptHex(AES_CBC_KEY, AES_CBC_IV, straddling);
		const d2 = createDecipheriv("aes-256-cbc", AES_CBC_KEY, AES_CBC_IV);
		const out1 = d2.update(straddlingHex.slice(0, 64), "hex", "utf8");
		expect(out1).toBe("b".repeat(14));
		const rest =
			d2.update(straddlingHex.slice(64, 128), "hex", "utf8") +
			d2.update(straddlingHex.slice(128), "hex", "utf8") +
			d2.final("utf8");
		expect(out1 + rest).toBe(straddling);
	});

	it("round-trips a non-ASCII secret against node:crypto ciphertext", () => {
		const secret = "ключ-космос-鍵-🔐-secreto"; // 2/3/4-byte sequences
		const hex = nodeEncryptHex(AES_CBC_KEY, AES_CBC_IV, secret);
		const decipher = createDecipheriv("aes-256-cbc", AES_CBC_KEY, AES_CBC_IV);
		expect(decipher.update(hex, "hex", "utf8") + decipher.final("utf8")).toBe(
			secret,
		);
	});

	it("rejects changing the output encoding mid-stream like node:crypto (cipher and decipher)", () => {
		const hex = concatCipherHex(AES_CBC_KEY, AES_CBC_IV, PLAINTEXT);

		// decipher: update utf8 -> final hex
		const d1 = createDecipheriv("aes-256-cbc", AES_CBC_KEY, AES_CBC_IV);
		d1.update(hex, "hex", "utf8");
		expect(() => d1.final("hex")).toThrow(/Cannot change encoding/);
		// decipher: update utf8 -> update hex
		const d2 = createDecipheriv("aes-256-cbc", AES_CBC_KEY, AES_CBC_IV);
		d2.update(hex.slice(0, 32), "hex", "utf8");
		expect(() => d2.update(hex.slice(32), "hex", "hex")).toThrow(
			/Cannot change encoding/,
		);

		// cipher: update hex -> update base64
		const c1 = createCipheriv("aes-256-cbc", AES_CBC_KEY, AES_CBC_IV);
		c1.update(PLAINTEXT, "utf8", "hex");
		expect(() => c1.update("tail", "utf8", "base64")).toThrow(
			/Cannot change encoding/,
		);
		// cipher: update hex -> final base64
		const c2 = createCipheriv("aes-256-cbc", AES_CBC_KEY, AES_CBC_IV);
		c2.update(PLAINTEXT, "utf8", "hex");
		expect(() => c2.final("base64")).toThrow(/Cannot change encoding/);
		// the failed final consumed the state exactly like node:crypto
		expect(() => c2.update("tail", "utf8", "hex")).toThrow(
			/Trying to add data in unsupported state/,
		);
		expect(() => c2.final("hex")).toThrow(/Unsupported state/);

		// the alias pair utf8/utf-8 stays one encoding on both directions
		const d3 = createDecipheriv("aes-256-cbc", AES_CBC_KEY, AES_CBC_IV);
		d3.update(hex.slice(0, 32), "hex", "utf8");
		expect(
			() => d3.update(hex.slice(32), "hex", "utf-8") + d3.final("utf8"),
		).not.toThrow();
		const c3 = createCipheriv("aes-256-cbc", AES_CBC_KEY, AES_CBC_IV);
		c3.update("a".repeat(32), "utf8", "utf8");
		expect(
			() => c3.update("b", "utf8", "utf-8") + c3.final("utf8"),
		).not.toThrow();
	});

	it("streams base64 output in 3-byte groups so every call shape matches node:crypto's one-shot base64", () => {
		// node:crypto pipes cipher output through one stateful base64 decoder:
		// its per-call outputs concatenate to the base64 of the WHOLE
		// ciphertext. Encoding each chunk independently would emit "=" padding
		// mid-stream — a concatenation that is not valid single base64.
		// Regression pin (review of #28971): the pre-fix shim diverged even on
		// a plain update()+final() pair.
		const plaintext = `${PLAINTEXT}0123456789abcdefg`; // 2+ blocks
		const nodeCipher = nodeCreateCipheriv(
			"aes-256-cbc",
			Buffer.from(AES_CBC_KEY),
			Buffer.from(AES_CBC_IV),
		);
		const nodeOneShot =
			nodeCipher.update(plaintext, "utf8", "base64") +
			nodeCipher.final("base64");

		const oneShot = createCipheriv("aes-256-cbc", AES_CBC_KEY, AES_CBC_IV);
		expect(
			oneShot.update(plaintext, "utf8", "base64") + oneShot.final("base64"),
		).toBe(nodeOneShot);

		for (const split of [1, 7, 16, 17, 33]) {
			if (split >= plaintext.length) continue;
			const cipher = createCipheriv("aes-256-cbc", AES_CBC_KEY, AES_CBC_IV);
			const streamed =
				cipher.update(plaintext.slice(0, split), "utf8", "base64") +
				cipher.update(plaintext.slice(split), "utf8", "base64") +
				cipher.final("base64");
			expect(streamed).toBe(nodeOneShot);
		}

		// Decipher side: base64-out streaming must also concatenate to the
		// base64 of the whole plaintext (node parity for the reverse shape).
		// Feed the ciphertext hex in two uneven chunks so the first update
		// holds back a partial block and the second crosses a 3-byte group
		// boundary before final() flushes the remainder.
		const fullHex = nodeEncryptHex(AES_CBC_KEY, AES_CBC_IV, plaintext);
		const nodeDecipher = nodeCreateDecipheriv(
			"aes-256-cbc",
			Buffer.from(AES_CBC_KEY),
			Buffer.from(AES_CBC_IV),
		);
		const nodePlainB64 =
			nodeDecipher.update(fullHex.slice(0, 20), "hex", "base64") +
			nodeDecipher.update(fullHex.slice(20), "hex", "base64") +
			nodeDecipher.final("base64");
		const decipherStreamed = createDecipheriv(
			"aes-256-cbc",
			AES_CBC_KEY,
			AES_CBC_IV,
		);
		const plainB64 =
			decipherStreamed.update(fullHex.slice(0, 20), "hex", "base64") +
			decipherStreamed.update(fullHex.slice(20), "hex", "base64") +
			decipherStreamed.final("base64");
		expect(plainB64).toBe(nodePlainB64);
		expect(Buffer.from(plainB64, "base64").toString("utf8")).toBe(plaintext);

		// Hex output stays stateless-parity across every split.
		for (const split of [1, 7, 16, 17, 33]) {
			if (split >= plaintext.length) continue;
			const cipher = createCipheriv("aes-256-cbc", AES_CBC_KEY, AES_CBC_IV);
			const hexStream =
				cipher.update(plaintext.slice(0, split), "utf8", "hex") +
				cipher.update(plaintext.slice(split), "utf8", "hex") +
				cipher.final("hex");
			expect(hexStream).toBe(
				nodeEncryptHex(AES_CBC_KEY, AES_CBC_IV, plaintext),
			);
		}
	});

	it("throws when the pad length byte is valid but interior pad bytes are wrong", () => {
		// Final byte says "3 bytes of padding" but the preceding pad byte is
		// 0x07, not 0x03 — pins the full interior-byte validation loop, not
		// just the length range check.
		const hex = concatCipherHex(AES_CBC_KEY, AES_CBC_IV, PLAINTEXT);
		const last = Buffer.from(hex, "hex").subarray(-16);
		const ecb = nodeCreateCipheriv(
			"aes-256-cbc",
			Buffer.from(AES_CBC_KEY),
			last,
		);
		ecb.setAutoPadding(false);
		const forgedBlock = Buffer.alloc(16, 0x41);
		forgedBlock[14] = 0x07; // wrong interior pad byte
		forgedBlock[15] = 0x03; // valid-looking pad length
		const appended = ecb.update(forgedBlock);
		const tampered = Buffer.concat([Buffer.from(hex, "hex"), appended]);
		const decipher = createDecipheriv("aes-256-cbc", AES_CBC_KEY, AES_CBC_IV);
		expect(
			() =>
				decipher.update(tampered.toString("hex"), "hex", "utf8") +
				decipher.final("utf8"),
		).toThrow(/Invalid PKCS#7 padding/);
	});

	it("decrypting under the wrong key never yields the plaintext", () => {
		const hex = nodeEncryptHex(AES_CBC_KEY, AES_CBC_IV, PLAINTEXT);
		const wrongKey = new Uint8Array(32).fill(0xab);
		const decipher = createDecipheriv("aes-256-cbc", wrongKey, AES_CBC_IV);
		const attempt = () =>
			decipher.update(hex, "hex", "utf8") + decipher.final("utf8");
		// Wrong key garbles every block; padding almost always rejects. If it
		// happens to validate, the plaintext is still garbage — never PLAINTEXT.
		let result: string | undefined;
		try {
			result = attempt();
		} catch {
			result = undefined;
		}
		expect(result === undefined || result !== PLAINTEXT).toBe(true);
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
