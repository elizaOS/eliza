/**
 * Core secrets encryption (AES-256-GCM). The security guarantees pinned here:
 * a correct round-trip, authenticated decryption that rejects a wrong key or
 * tampered ciphertext/algorithm, deterministic password-based key derivation,
 * and a length-checked constant-time string comparison.
 */

import { describe, expect, it } from "vitest";
import type { EncryptedSecret } from "../types.ts";
import { EncryptionError } from "../types.ts";
import {
	decrypt,
	decryptGcm,
	deriveKeyPbkdf2,
	deriveKeyScrypt,
	encrypt,
	encryptGcm,
	generateKey,
	generateSalt,
	generateSecureToken,
	hashValue,
	isEncryptedSecret,
	secureCompare,
} from "./encryption.ts";

const KEY = generateKey();

describe("key + salt generation", () => {
	it("generateKey yields 32 bytes; deriveKey* are deterministic per (password,salt)", () => {
		expect(KEY.length).toBe(32);
		const salt = generateSalt();
		const a = deriveKeyPbkdf2("hunter2", salt);
		const b = deriveKeyPbkdf2("hunter2", salt);
		expect(a.length).toBe(32);
		expect(a.equals(b)).toBe(true);
		// Different password → different key.
		expect(a.equals(deriveKeyPbkdf2("other", salt))).toBe(false);
		// scrypt is also deterministic and 32 bytes.
		const s1 = deriveKeyScrypt("hunter2", salt);
		expect(s1.length).toBe(32);
		expect(s1.equals(deriveKeyScrypt("hunter2", salt))).toBe(true);
	});
});

describe("encrypt / decrypt round-trip", () => {
	it("recovers the plaintext and uses a fresh IV each time", () => {
		const a = encrypt("s3cr3t", KEY);
		const b = encrypt("s3cr3t", KEY);
		expect(a.algorithm).toBe("aes-256-gcm");
		expect(a.iv).not.toBe(b.iv); // fresh IV
		expect(a.value).not.toBe(b.value);
		expect(decrypt(a, KEY)).toBe("s3cr3t");
		expect(decrypt(b, KEY)).toBe("s3cr3t");
	});

	it("rejects a wrong-length key on encrypt and decrypt", () => {
		expect(() => encryptGcm("x", Buffer.alloc(16))).toThrow(EncryptionError);
		const enc = encrypt("x", KEY);
		expect(() => decryptGcm(enc, Buffer.alloc(16))).toThrow(EncryptionError);
	});
});

describe("authenticated decryption", () => {
	const enc = encrypt("payload", KEY);

	it("fails with a wrong key", () => {
		expect(() => decrypt(enc, generateKey())).toThrow();
	});

	it("fails on a tampered ciphertext", () => {
		const tampered: EncryptedSecret = {
			...enc,
			value: encrypt("different", KEY).value,
		};
		expect(() => decryptGcm(tampered, KEY)).toThrow();
	});

	it("rejects a missing auth tag or mismatched algorithm", () => {
		expect(() => decryptGcm({ ...enc, authTag: undefined }, KEY)).toThrow(
			/authentication tag/,
		);
		expect(() =>
			decrypt(
				{ ...enc, algorithm: "aes-128-cbc" } as unknown as EncryptedSecret,
				KEY,
			),
		).toThrow(/Unsupported algorithm/);
	});
});

describe("isEncryptedSecret", () => {
	it("recognizes the envelope shape", () => {
		expect(isEncryptedSecret(encrypt("x", KEY))).toBe(true);
		expect(isEncryptedSecret({ value: "x", iv: "y", algorithm: "rot13" })).toBe(
			false,
		);
		expect(isEncryptedSecret(null)).toBe(false);
		expect(isEncryptedSecret("string")).toBe(false);
	});
});

describe("hashValue / generateSecureToken / secureCompare", () => {
	it("hashValue is a stable hex digest sensitive to input", () => {
		expect(hashValue("a")).toMatch(/^[0-9a-f]{64}$/);
		expect(hashValue("a")).toBe(hashValue("a"));
		expect(hashValue("a")).not.toBe(hashValue("b"));
		expect(hashValue("a", "sha512")).toMatch(/^[0-9a-f]{128}$/);
	});

	it("generateSecureToken returns the requested byte length as hex", () => {
		expect(generateSecureToken(16)).toMatch(/^[0-9a-f]{32}$/);
		expect(generateSecureToken(16)).not.toBe(generateSecureToken(16));
	});

	it("secureCompare matches equal strings and rejects unequal/length-mismatched", () => {
		expect(secureCompare("abc", "abc")).toBe(true);
		expect(secureCompare("abc", "abd")).toBe(false);
		expect(secureCompare("abc", "abcd")).toBe(false);
	});
});
