import { describe, expect, it } from "vitest";
import { decryptStringValue, encryptStringValue } from "../src/settings.ts";

const SALT = "test-salt-for-unit-tests";

describe("settings v1 ciphertext detection", () => {
	it("encrypts a plaintext shaped like '<32 hex>:<text>' instead of misclassifying it", () => {
		const tricky = "a1b2c3d4e5f60718293a4b5c6d7e8f90:my-secret";
		const stored = encryptStringValue(tricky, SALT);
		// Must be actually encrypted (v2 format), not passed through as-is.
		expect(stored).not.toBe(tricky);
		expect(stored.startsWith("v2:")).toBe(true);
		// And it must round-trip.
		expect(decryptStringValue(stored, SALT)).toBe(tricky);
	});

	it("leaves ordinary plaintext alone on decrypt", () => {
		expect(decryptStringValue("just-a-setting", SALT)).toBe("just-a-setting");
	});

	it("round-trips normal secrets", () => {
		const secret = "super-secret-value";
		const stored = encryptStringValue(secret, SALT);
		expect(stored.startsWith("v2:")).toBe(true);
		expect(decryptStringValue(stored, SALT)).toBe(secret);
	});
});
