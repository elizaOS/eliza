import { createCipheriv, createHash, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { decryptStringValue, encryptStringValue } from "../src/settings.ts";

const SALT = "v1-detection-salt";

/** The exact envelope the legacy v1 path produced: iv.toString("hex") + ":" + cipher.update(value,"utf8","hex") + cipher.final("hex"). */
function legacyV1Encrypt(value: string, salt: string): string {
	const key = createHash("sha256").update(salt).digest().slice(0, 32);
	const iv = randomBytes(16);
	const cipher = createCipheriv("aes-256-cbc", key, iv);
	let enc = cipher.update(value, "utf8", "hex");
	enc += cipher.final("hex");
	return `${iv.toString("hex")}:${enc}`;
}

describe("settings v1 ciphertext detection", () => {
	it("still recognizes and round-trips genuine legacy v1 ciphertext", () => {
		const stored = legacyV1Encrypt("real-secret-value", SALT);
		// A real ciphertext must be left untouched (not re-encrypted) and decrypt.
		expect(encryptStringValue(stored, SALT)).toBe(stored);
		expect(decryptStringValue(stored, SALT)).toBe("real-secret-value");
		expect(decryptStringValue(stored.toUpperCase(), SALT)).toBe(
			"real-secret-value",
		);
	});

	it("encrypts a plaintext shaped like '<32 hex>:<text>' instead of misclassifying it", () => {
		const tricky = "a1b2c3d4e5f60718293a4b5c6d7e8f90:my-secret";
		const stored = encryptStringValue(tricky, SALT);
		// Must be actually encrypted (v2 envelope), not passed through to storage.
		expect(stored).not.toBe(tricky);
		expect(stored.startsWith("v2:")).toBe(true);
		// And it must round-trip rather than throw SETTING_DECRYPTION_FAILED.
		expect(decryptStringValue(stored, SALT)).toBe(tricky);
	});

	it("encrypts a plaintext shaped like '<uuid-ish hex>:<hex>' instead of misclassifying it", () => {
		const tricky =
			"0a1b2c3d-4e5f-6071-8293-a4b5c6d7e8f9:0123456789abcdef0123456789abcdef";
		const stored = encryptStringValue(tricky, SALT);
		expect(stored).not.toBe(tricky);
		expect(stored.startsWith("v2:")).toBe(true);
		expect(decryptStringValue(stored, SALT)).toBe(tricky);
	});

	it("leaves ordinary plaintext alone on decrypt", () => {
		expect(decryptStringValue("just-a-setting", SALT)).toBe("just-a-setting");
		expect(decryptStringValue("host:port", SALT)).toBe("host:port");
	});

	it("round-trips normal secrets", () => {
		const secret = "super-secret-value";
		const stored = encryptStringValue(secret, SALT);
		expect(stored.startsWith("v2:")).toBe(true);
		expect(decryptStringValue(stored, SALT)).toBe(secret);
	});
});
