/**
 * AES-256-GCM authenticated encryption (#8801 — the crypto primitive that
 * protects stored secrets/character keys). The properties that matter for
 * security are pinned: an exact round-trip, AAD binding, and that any
 * tamper / wrong key / wrong AAD is REJECTED (GCM's authentication), plus the
 * key/IV/tag length guards. A regression that silently returned plaintext on a
 * bad tag would be a critical confidentiality+integrity break.
 */

import { describe, expect, it } from "vitest";
import { decryptAes256Gcm, encryptAes256Gcm } from "./crypto-compat.ts";

const KEY = new Uint8Array(32).map((_, i) => i + 1); // 32 bytes → AES-256
const KEY2 = new Uint8Array(32).map((_, i) => 255 - i); // a different key
const IV = new Uint8Array(12).map((_, i) => i + 100); // 12 bytes → GCM nonce
const PT = new TextEncoder().encode("wallet private key: do not leak");

const bytes = (a: Uint8Array) => Array.from(a);

describe("AES-256-GCM round-trip", () => {
	it("decrypts back to the exact plaintext", () => {
		const { ciphertext, tag } = encryptAes256Gcm(KEY, IV, PT);
		expect(tag.length).toBe(16);
		expect(bytes(ciphertext)).not.toEqual(bytes(PT)); // actually encrypted
		const out = decryptAes256Gcm(KEY, IV, ciphertext, tag);
		expect(bytes(out)).toEqual(bytes(PT));
	});

	it("round-trips empty plaintext", () => {
		const { ciphertext, tag } = encryptAes256Gcm(KEY, IV, new Uint8Array(0));
		const out = decryptAes256Gcm(KEY, IV, ciphertext, tag);
		expect(out.length).toBe(0);
	});

	it("binds additional authenticated data (AAD)", () => {
		const aad = new TextEncoder().encode("user:42");
		const { ciphertext, tag } = encryptAes256Gcm(KEY, IV, PT, aad);
		expect(bytes(decryptAes256Gcm(KEY, IV, ciphertext, tag, aad))).toEqual(
			bytes(PT),
		);
		// same ciphertext, wrong/absent AAD → authentication fails
		expect(() =>
			decryptAes256Gcm(
				KEY,
				IV,
				ciphertext,
				tag,
				new TextEncoder().encode("user:99"),
			),
		).toThrow();
		expect(() => decryptAes256Gcm(KEY, IV, ciphertext, tag)).toThrow();
	});
});

describe("AES-256-GCM rejects tampering / wrong key", () => {
	it("rejects a flipped ciphertext byte", () => {
		const { ciphertext, tag } = encryptAes256Gcm(KEY, IV, PT);
		const tampered = Uint8Array.from(ciphertext);
		tampered[0] ^= 0xff;
		expect(() => decryptAes256Gcm(KEY, IV, tampered, tag)).toThrow();
	});

	it("rejects a flipped auth tag", () => {
		const { ciphertext, tag } = encryptAes256Gcm(KEY, IV, PT);
		const badTag = Uint8Array.from(tag);
		badTag[0] ^= 0xff;
		expect(() => decryptAes256Gcm(KEY, IV, ciphertext, badTag)).toThrow();
	});

	it("rejects decryption under a different key", () => {
		const { ciphertext, tag } = encryptAes256Gcm(KEY, IV, PT);
		expect(() => decryptAes256Gcm(KEY2, IV, ciphertext, tag)).toThrow();
	});
});

describe("AES-256-GCM length validation", () => {
	it("rejects a non-32-byte key", () => {
		expect(() => encryptAes256Gcm(new Uint8Array(16), IV, PT)).toThrow(
			/key length/i,
		);
	});

	it("rejects a non-12-byte IV", () => {
		expect(() => encryptAes256Gcm(KEY, new Uint8Array(16), PT)).toThrow(
			/IV length/i,
		);
	});

	it("rejects a non-16-byte tag on decrypt", () => {
		const { ciphertext } = encryptAes256Gcm(KEY, IV, PT);
		expect(() =>
			decryptAes256Gcm(KEY, IV, ciphertext, new Uint8Array(8)),
		).toThrow(/tag length/i);
	});
});
