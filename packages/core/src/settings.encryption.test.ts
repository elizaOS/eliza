/**
 * Settings secret encryption (#8801 — the at-rest protection for secret settings
 * like API keys, shipped untested). It is AES-256-GCM keyed by SHA-256(salt) with
 * an "elizaos:settings:v2" AAD. The properties pinned here are the ones a secret
 * store lives or dies by: an exact round-trip, semantic security (same plaintext
 * → different ciphertext), idempotent re-encryption, type pass-through, and —
 * critically — that a WRONG salt fails *safe* with a typed error instead of
 * returning ciphertext or garbled/partial plaintext as a usable value.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { logger } from "./logger";
import {
	clearSaltCache,
	decryptedCharacter,
	decryptObjectValues,
	decryptStringValue,
	encryptedCharacter,
	encryptObjectValues,
	encryptStringValue,
	saltSettingValue,
	unsaltSettingValue,
} from "./settings.ts";
import type { Character } from "./types";

const SALT = "salt-alpha";
const SECRET = "sk-api-key-do-not-leak-1234567890";
const GENUINE_V1_CIPHERTEXT =
	"00112233445566778899aabbccddeeff:5f579a151889d90faab895d20ef4b8089d63fe4041167d135225bc8296f664ca89400401ce4958eb3bd6cbc0062b0634";
const V1_SHAPED_PLAINTEXT =
	"a1b2c3d4e5f60718293a4b5c6d7e8f90:deadbeefdeadbeefdeadbeefdeadbeef";
const V2_SHAPED_PLAINTEXT =
	"v2:00112233445566778899aabb:deadbeef:00112233445566778899aabbccddeeff";

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

	it("encrypts plaintext that matches the legacy v1 ciphertext shape", () => {
		const encrypted = encryptStringValue(V1_SHAPED_PLAINTEXT, SALT);

		expect(encrypted).not.toBe(V1_SHAPED_PLAINTEXT);
		expect(encrypted).toMatch(/^v2:/);
		expect(decryptStringValue(encrypted, SALT)).toBe(V1_SHAPED_PLAINTEXT);
	});

	it("encrypts plaintext that matches the v2 ciphertext shape", () => {
		const encrypted = encryptStringValue(V2_SHAPED_PLAINTEXT, SALT);

		expect(encrypted).not.toBe(V2_SHAPED_PLAINTEXT);
		expect(encrypted).toMatch(/^v2:/);
		expect(decryptStringValue(encrypted, SALT)).toBe(V2_SHAPED_PLAINTEXT);
	});

	it("preserves genuine legacy v1 ciphertext under the active salt", () => {
		expect(decryptStringValue(GENUINE_V1_CIPHERTEXT, SALT)).toBe(SECRET);
		expect(encryptStringValue(GENUINE_V1_CIPHERTEXT, SALT)).toBe(
			GENUINE_V1_CIPHERTEXT,
		);
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

	it("preserves direct empty strings and boundary-level falsy values", () => {
		const encryptedEmpty = encryptStringValue("", SALT);
		expect(encryptedEmpty).toMatch(/^v2:/);
		expect(decryptStringValue(encryptedEmpty, SALT)).toBe("");

		const emptySetting = { name: "empty", secret: true, value: "" };
		const falseSetting = { name: "false", secret: true, value: false };
		expect(saltSettingValue(emptySetting, SALT)).toEqual(emptySetting);
		expect(unsaltSettingValue(emptySetting, SALT)).toEqual(emptySetting);
		expect(saltSettingValue(falseSetting, SALT)).toEqual(falseSetting);
		expect(unsaltSettingValue(falseSetting, SALT)).toEqual(falseSetting);
	});

	it("fails closed on a wrong salt instead of exposing ciphertext as a value", () => {
		const enc = encryptStringValue(SECRET, SALT);
		expect(() => decryptStringValue(enc, "wrong-salt")).toThrow(
			"Failed to decrypt secret setting",
		);
	});

	it("warns and preserves fail-closed semantics when re-encrypting cross-salt ciphertext", () => {
		const otherSalt = "salt-beta";
		const ciphertext = encryptStringValue(SECRET, SALT);
		const warnSpy = vi
			.spyOn(logger, "warn")
			.mockImplementation(() => undefined);

		try {
			expect(() => decryptStringValue(ciphertext, otherSalt)).toThrow(
				"Failed to decrypt secret setting",
			);

			const reencrypted = encryptStringValue(ciphertext, otherSalt);
			expect(reencrypted).not.toBe(ciphertext);
			expect(reencrypted).toMatch(/^v2:/);

			const outerValue = decryptStringValue(reencrypted, otherSalt);
			expect(outerValue).toBe(ciphertext);
			expect(outerValue).not.toBe(SECRET);
			expect(() => decryptStringValue(reencrypted, SALT)).toThrow(
				"Failed to decrypt secret setting",
			);

			expect(warnSpy).toHaveBeenCalledTimes(1);
			const [context, message] = warnSpy.mock.calls[0];
			expect(context).toEqual({
				src: "core:settings",
				event: "core.settings.reencrypted_unauthenticated_ciphertext_shape",
				format: "v2",
			});
			expect(message).toBe(
				"Ciphertext-shaped secret setting failed authentication under the active salt and will be encrypted as plaintext",
			);

			const warningRecord = JSON.stringify(warnSpy.mock.calls);
			for (const protectedValue of [SECRET, ciphertext, SALT, otherSalt]) {
				expect(warningRecord).not.toContain(protectedValue);
			}
		} finally {
			warnSpy.mockRestore();
		}
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

		const decrypted = decryptedCharacter(encrypted);
		expect(decrypted).toEqual(character);
		expect(encrypted.settings?.secrets?.ANTHROPIC_API_KEY).toMatch(/^v2:/);
	});

	it("preserves characters that omit settings or nested secrets", () => {
		const withoutSettings: Character = { name: "No Settings" };
		const withoutNestedSecrets: Character = {
			name: "Public Settings",
			settings: { defaultTemperature: 0.2 },
		};

		expect(decryptedCharacter(encryptedCharacter(withoutSettings))).toEqual(
			withoutSettings,
		);
		expect(
			decryptedCharacter(encryptedCharacter(withoutNestedSecrets)),
		).toEqual(withoutNestedSecrets);
	});
});
