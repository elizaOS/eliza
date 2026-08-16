/**
 * Settings secret encryption (#8801 — the at-rest protection for secret settings
 * like API keys, shipped untested). It is AES-256-GCM keyed by SHA-256(salt) with
 * an "elizaos:settings:v2" AAD. The properties pinned here are the ones a secret
 * store lives or dies by: an exact round-trip, semantic security (same plaintext
 * → different ciphertext), idempotent re-encryption, type pass-through, and —
 * critically — that a WRONG salt fails *safe* (returns the ciphertext, never a
 * garbled/partial plaintext).
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	clearSaltCache,
	decryptedCharacter,
	decryptObjectValues,
	decryptStringValue,
	encryptedCharacter,
	encryptObjectValues,
	encryptStringValue,
} from "./settings.ts";
import type { Character, IAgentRuntime } from "./types";

const SALT = "salt-alpha";
const SECRET = "sk-api-key-do-not-leak-1234567890";

describe("encryptStringValue / decryptStringValue", () => {
	it("round-trips through the v2 format", () => {
		const enc = encryptStringValue(SECRET, SALT);
		expect(enc).not.toBe(SECRET);
		expect(enc.startsWith("v2:")).toBe(true);
		expect(enc.split(":")).toHaveLength(4); // v2:iv:ciphertext:tag
		expect(decryptStringValue(enc, SALT)).toBe(SECRET);
	});

	it("is semantically secure — same plaintext encrypts to different ciphertext", () => {
		// random IV per call; both must still decrypt back
		const a = encryptStringValue(SECRET, SALT);
		const b = encryptStringValue(SECRET, SALT);
		expect(a).not.toBe(b);
		expect(decryptStringValue(a, SALT)).toBe(SECRET);
		expect(decryptStringValue(b, SALT)).toBe(SECRET);
	});

	it("does not double-encrypt an already-encrypted value", () => {
		const enc = encryptStringValue(SECRET, SALT);
		expect(encryptStringValue(enc, SALT)).toBe(enc);
	});

	it("passes non-string / empty values through unchanged", () => {
		expect(encryptStringValue(true as never, SALT)).toBe(true);
		expect(encryptStringValue(42 as never, SALT)).toBe(42);
		expect(encryptStringValue(null as never, SALT)).toBeNull();
		expect(encryptStringValue(undefined as never, SALT)).toBeUndefined();
		// a plain (non-encrypted) string decrypts to itself
		expect(decryptStringValue("just a plain value", SALT)).toBe(
			"just a plain value",
		);
	});

	it("fails closed on a wrong salt instead of exposing ciphertext as a value", () => {
		const enc = encryptStringValue(SECRET, SALT);
		expect(() => decryptStringValue(enc, "wrong-salt")).toThrow(
			"Failed to decrypt secret setting",
		);
	});
});

describe("encryptObjectValues / decryptObjectValues", () => {
	it("round-trips string values and leaves non-strings/empties alone", () => {
		const obj = { apiKey: SECRET, count: 7, enabled: true, blank: "" };
		const enc = encryptObjectValues(obj, SALT);
		expect(enc.apiKey).not.toBe(SECRET);
		expect((enc.apiKey as string).startsWith("v2:")).toBe(true);
		expect(enc.count).toBe(7);
		expect(enc.enabled).toBe(true);
		expect(enc.blank).toBe(""); // empty string not encrypted
		expect(decryptObjectValues(enc, SALT)).toEqual(obj);
	});
});

describe("encryptedCharacter / decryptedCharacter", () => {
	const previousSalt = process.env.SECRET_SALT;

	beforeEach(() => {
		process.env.SECRET_SALT = SALT;
		clearSaltCache();
	});

	afterEach(() => {
		if (previousSalt === undefined) delete process.env.SECRET_SALT;
		else process.env.SECRET_SALT = previousSalt;
		clearSaltCache();
	});

	it("encrypts both character secret containers without mutating the input", () => {
		const character: Character = {
			name: "Secret Keeper",
			secrets: { OPENAI_API_KEY: SECRET },
			settings: {
				defaultTemperature: 0.4,
				secrets: {
					ANTHROPIC_API_KEY: "anthropic-secret",
					enabled: true,
					attempts: 3,
				},
			},
		};

		const encrypted = encryptedCharacter(character);

		expect(encrypted.secrets?.OPENAI_API_KEY).not.toBe(SECRET);
		expect(encrypted.secrets?.OPENAI_API_KEY).toMatch(/^v2:/);
		expect(encrypted.settings?.secrets?.ANTHROPIC_API_KEY).not.toBe(
			"anthropic-secret",
		);
		expect(encrypted.settings?.secrets?.ANTHROPIC_API_KEY).toMatch(/^v2:/);
		expect(encrypted.settings?.secrets?.enabled).toBe(true);
		expect(encrypted.settings?.secrets?.attempts).toBe(3);
		expect(encrypted.settings?.defaultTemperature).toBe(0.4);
		expect(character.secrets?.OPENAI_API_KEY).toBe(SECRET);
		expect(character.settings?.secrets?.ANTHROPIC_API_KEY).toBe(
			"anthropic-secret",
		);

		const decrypted = decryptedCharacter(encrypted, {} as IAgentRuntime);
		expect(decrypted).toEqual(character);
		expect(encrypted.settings?.secrets?.ANTHROPIC_API_KEY).toMatch(/^v2:/);
	});

	it("preserves characters that omit settings or nested secrets", () => {
		const withoutSettings: Character = { name: "No Settings" };
		const withoutNestedSecrets: Character = {
			name: "Public Settings",
			settings: { defaultTemperature: 0.2 },
		};

		expect(
			decryptedCharacter(
				encryptedCharacter(withoutSettings),
				{} as IAgentRuntime,
			),
		).toEqual(withoutSettings);
		expect(
			decryptedCharacter(
				encryptedCharacter(withoutNestedSecrets),
				{} as IAgentRuntime,
			),
		).toEqual(withoutNestedSecrets);
	});
});
