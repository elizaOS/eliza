/**
 * Contract tests for the `node:crypto`-compatible AES-256-CBC and hash surface
 * of `crypto-compat.ts` — the shim `settings.ts` decrypts every legacy v1
 * (`enc:`-prefixed) secret setting through, and the hash identity primitive
 * behind PII pseudonym maps and trajectory dedupe (#25159 covered only the
 * AES-GCM half). The oracle for wire parity is the real `node:crypto`, so a
 * divergence in the hand-rolled IV chaining, streaming hold-back buffering, or
 * PKCS#7 handling fails here even though both sides of a self round-trip
 * would stay green. Deterministic, network-free.
 */

import {
	createCipheriv as nodeCipher,
	createHash as nodeHash,
} from "node:crypto";
import { describe, expect, it } from "vitest";
import {
	createCipheriv,
	createDecipheriv,
	createHash,
} from "./crypto-compat.ts";

const KEY = new Uint8Array(32).map((_, i) => (i * 7 + 3) & 0xff);
const IV = new Uint8Array(16).map((_, i) => (i * 11 + 5) & 0xff);
const SECRET = "wallet mnemonic: rural oxygen mosaic glance palette";

const hexToBytes = (hex: string) => Uint8Array.from(Buffer.from(hex, "hex"));
const bytesToHex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const joinBytes = (a: Uint8Array, b: Uint8Array) => {
	const out = new Uint8Array(a.length + b.length);
	out.set(a);
	out.set(b, a.length);
	return out;
};

/** One-shot node:crypto AES-256-CBC ciphertext hex for the same inputs. */
function nodeCiphertextHex(
	plaintext: string,
	key: Uint8Array = KEY,
	iv: Uint8Array = IV,
): string {
	const cipher = nodeCipher("aes-256-cbc", key, iv);
	return cipher.update(plaintext, "utf8", "hex") + cipher.final("hex");
}

describe("AES-256-CBC wire parity with node:crypto", () => {
	it("produces byte-identical ciphertext for the same key/IV/plaintext", () => {
		const cipher = createCipheriv("aes-256-cbc", KEY, IV);
		const compatHex =
			cipher.update(SECRET, "utf8", "hex") + cipher.final("hex");
		expect(compatHex).toBe(nodeCiphertextHex(SECRET));
	});

	it("decrypts ciphertext produced by node:crypto (drop-in interop)", () => {
		const nodeHex = nodeCiphertextHex(SECRET);
		const decipher = createDecipheriv("aes-256-cbc", KEY, IV);
		const plaintext =
			decipher.update(nodeHex, "hex", "utf8") + decipher.final("utf8");
		expect(plaintext).toBe(SECRET);
	});

	it("round-trips through the legacy v1 settings wire shape (hex → utf8)", () => {
		// Exactly how decryptStringValue's v1 leg calls it (settings.ts):
		// hex ciphertext in, utf8 plaintext out.
		const cipher = createCipheriv("aes-256-cbc", KEY, IV);
		const storedHex =
			cipher.update(SECRET, "utf8", "hex") + cipher.final("hex");
		const decipher = createDecipheriv("aes-256-cbc", KEY, IV);
		expect(
			decipher.update(storedHex, "hex", "utf8") + decipher.final("utf8"),
		).toBe(SECRET);
	});

	it("rejects aes-128-cbc with the documented unsupported-algorithm error", () => {
		expect(() => createCipheriv("aes-128-cbc", KEY, IV)).toThrow(
			/Only 'aes-256-cbc' is supported/,
		);
		expect(() => createDecipheriv("aes-128-cbc", KEY, IV)).toThrow(
			/Only 'aes-256-cbc' is supported/,
		);
	});

	it("enforces the 32-byte key and 16-byte IV lengths on both directions", () => {
		const shortKey = KEY.slice(0, 31);
		const shortIv = IV.slice(0, 15);
		expect(() => createCipheriv("aes-256-cbc", shortKey, IV)).toThrow(
			/Invalid key length: 31 bytes/,
		);
		expect(() => createDecipheriv("aes-256-cbc", KEY, shortIv)).toThrow(
			/Invalid IV length: 15 bytes/,
		);
	});
});

describe("AES-256-CBC streaming semantics (hold-back buffer + IV chaining)", () => {
	// Block-boundary and off-boundary plaintext lengths: an exact multiple of
	// 16 forces the full PKCS#7 pad block; off-by-one lengths pin the partial
	// block carried between update() calls.
	const lengths = [1, 15, 16, 17, 31, 32, 33, 64];

	it.each(lengths)(
		"chunked update() equals one-shot for %i-byte plaintext",
		(len) => {
			const plaintext = "a".repeat(len);
			const expected = nodeCiphertextHex(plaintext);

			// Chunk at every awkward split so one update holds a partial block.
			for (const split of [1, 5, 16, 17, len - 1]) {
				if (split <= 0 || split >= len) continue;
				const cipher = createCipheriv("aes-256-cbc", KEY, IV);
				const got =
					cipher.update(plaintext.slice(0, split), "utf8", "hex") +
					cipher.update(plaintext.slice(split), "utf8", "hex") +
					cipher.final("hex");
				expect(got).toBe(expected);
			}

			const oneShot = createCipheriv("aes-256-cbc", KEY, IV);
			expect(
				oneShot.update(plaintext, "utf8", "hex") + oneShot.final("hex"),
			).toBe(expected);
		},
	);

	it("decrypt side mirrors the same chunked hold-back across update() calls", () => {
		const ciphertextHex = nodeCiphertextHex(SECRET + "0123456789abcde"); // 47 bytes
		const expected = SECRET + "0123456789abcde";
		for (const split of [16, 31, 32]) {
			const decipher = createDecipheriv("aes-256-cbc", KEY, IV);
			const got =
				decipher.update(ciphertextHex.slice(0, split * 2), "hex", "utf8") +
				decipher.update(ciphertextHex.slice(split * 2), "hex", "utf8") +
				decipher.final("utf8");
			expect(got).toBe(expected);
		}
	});

	it("pads an exact-block plaintext with a full 0x10 block (ciphertext +16 bytes)", () => {
		const plaintext = "0123456789abcdef"; // exactly 16 bytes
		const cipher = createCipheriv("aes-256-cbc", KEY, IV);
		const hex = cipher.update(plaintext, "utf8", "hex") + cipher.final("hex");
		expect(hex).toBe(nodeCiphertextHex(plaintext));
		expect(hexToBytes(hex).length).toBe(32);
	});
});

describe("AES-256-CBC tamper and padding rejection", () => {
	it("a flipped ciphertext byte never decrypts to the original plaintext", () => {
		const hex = nodeCiphertextHex(SECRET);
		const bytes = hexToBytes(hex);
		bytes[Math.floor(bytes.length / 2)] ^= 0x01;
		const decipher = createDecipheriv("aes-256-cbc", KEY, IV);
		const tamperedHex = bytesToHex(bytes);
		const attempt = () =>
			decipher.update(tamperedHex, "hex", "utf8") + decipher.final("utf8");
		// CBC has no integrity: mid-block flips usually decrypt to garbage that
		// fails the padding check; either way the original secret must NOT come
		// back out — that is the observable contract.
		let result: string | undefined;
		try {
			result = attempt();
		} catch {
			result = undefined;
		}
		expect(result).not.toBe(SECRET);
	});

	it("throws on constructed zero padding byte (invalid PKCS#7 < 1)", () => {
		// Build a ciphertext whose final plaintext block decrypts to all zero
		// bytes: append Cn = E(C(n-1)) so D(Cn) xor C(n-1) = 0x00*16.
		const hex = nodeCiphertextHex(SECRET);
		const blocks = hex.match(/.{32}/g) ?? [];
		const last = hexToBytes(blocks[blocks.length - 1] ?? "");
		const ecb = nodeCipher("aes-256-cbc", KEY, last);
		ecb.setAutoPadding(false);
		const forcedZeroPad = ecb.update(new Uint8Array(16));
		const tampered = bytesToHex(joinBytes(hexToBytes(hex), forcedZeroPad));
		const decipher = createDecipheriv("aes-256-cbc", KEY, IV);
		expect(
			() => decipher.update(tampered, "hex", "utf8") + decipher.final("utf8"),
		).toThrow(/Invalid PKCS#7 padding/);
	});

	it("throws on constructed oversized padding byte (0x11 > 16)", () => {
		const hex = nodeCiphertextHex(SECRET);
		const last = hexToBytes((hex.match(/.{32}/g) ?? []).slice(-1)[0] ?? "");
		const ecb = nodeCipher("aes-256-cbc", KEY, last);
		ecb.setAutoPadding(false);
		const forcedBigPad = ecb.update(new Uint8Array(16).fill(0x11));
		const tampered = bytesToHex(joinBytes(hexToBytes(hex), forcedBigPad));
		const decipher = createDecipheriv("aes-256-cbc", KEY, IV);
		expect(
			() => decipher.update(tampered, "hex", "utf8") + decipher.final("utf8"),
		).toThrow(/Invalid PKCS#7 padding/);
	});

	it("rejects non-block-multiple ciphertext at final()", () => {
		const cipher = createCipheriv("aes-256-cbc", KEY, IV);
		const oddHex = cipher.update("abc", "utf8", "hex") + cipher.final("hex");
		const truncated = oddHex.slice(0, 30); // 15 bytes: not a multiple of 16
		const decipher = createDecipheriv("aes-256-cbc", KEY, IV);
		expect(
			() => decipher.update(truncated, "hex", "utf8") + decipher.final("utf8"),
		).toThrow(/Invalid ciphertext length/);
	});

	it("decrypting under the wrong key never yields the plaintext", () => {
		const hex = nodeCiphertextHex(SECRET);
		const wrongKey = new Uint8Array(32).fill(0xab);
		const decipher = createDecipheriv("aes-256-cbc", wrongKey, IV);
		const attempt = () =>
			decipher.update(hex, "hex", "utf8") + decipher.final("utf8");
		// Wrong key garbles every block; padding almost always rejects. If it
		// happens to validate, the plaintext is still garbage — never SECRET.
		let result: string | undefined;
		try {
			result = attempt();
		} catch {
			result = undefined;
		}
		expect(result === undefined || result !== SECRET).toBe(true);
	});
});

describe("createHash node:crypto parity and known-answer vectors", () => {
	// Standard FIPS 180-4 / RFC 1321 / RIPEMD-160 test vectors for "abc".
	const KAT: Record<string, string> = {
		md5: "900150983cd24fb0d6963f7d28e17f72",
		sha1: "a9993e364706816aba3e25717850c26c9cd0d89d",
		sha224: "23097d223405d8228642a477bda255b32aadbce4bda0b3f7e36c9da7",
		sha256: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
		sha384:
			"cb00753f45a35e8bb5a03d699ac65007272c32ab0eded1631a8b605a43ff5bed8086072ba1e7cc2358baeca134c825a7",
		sha512:
			"ddaf35a193617abacc417349ae20413112e6fa4e89a97ea20a9eeee64b55d39a2192992a274fc1a836ba3c23a3feebbd454d4423643ce80e2a9ac94fa54ca49f",
		ripemd160: "8eb208f7e05d987a9b044a8e98c6b087f15a0bfc",
	};

	it.each(Object.entries(KAT))(
		"%s('abc') matches the standard vector",
		(algo, expected) => {
			expect(createHash(algo).update("abc").digest("hex")).toBe(expected);
		},
	);

	it("incremental update() chaining equals a one-shot digest", () => {
		const parts = ["elizaos:", "settings:", "salt-material"];
		const chained = createHash("sha256");
		for (const p of parts) chained.update(p);
		expect(chained.digest("hex")).toBe(
			nodeHash("sha256").update(parts.join("")).digest("hex"),
		);
	});

	it("digest() encodings (hex/base64) and the 'utf-8' alias match node:crypto", () => {
		const digestHex = createHash("sha256").update(SECRET).digest("hex");
		expect(digestHex).toBe(nodeHash("sha256").update(SECRET).digest("hex"));
		expect(createHash("sha256").update(SECRET).digest("base64")).toBe(
			nodeHash("sha256").update(SECRET).digest("base64"),
		);
		// settings.ts hashes raw byte digests; the alias must not throw.
		const asBytes = createHash("sha256").update(SECRET).digest("utf-8");
		expect(typeof asBytes).toBe("string");
		expect(() =>
			createHash("sha256").update(SECRET).digest("utf8"),
		).not.toThrow();
	});

	it("accepts bytes input alongside strings", () => {
		const bytes = new TextEncoder().encode("abc");
		expect(createHash("sha256").update(bytes).digest("hex")).toBe(KAT.sha256);
	});

	it("throws the documented error for an unsupported algorithm", () => {
		expect(() => createHash("md4")).toThrow(/Unsupported algorithm: md4/);
	});
});
