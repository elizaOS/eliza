/**
 * Secret validation catches misconfigured API keys before they reach a provider
 * (a wrong-shaped key fails the call at runtime, often after billing). Known
 * keys are checked against a provider-specific pattern; unknown keys get basic
 * checks that reject empty values and obvious placeholders ("your_api_key_here").
 * inferValidationPatternKey maps prefixed/variant names back to the canonical key.
 */
import { describe, expect, it } from "vitest";
import {
	checkRequiredSecrets,
	getValidationPattern,
	hasValidationPattern,
	inferValidationPatternKey,
	validateSecretKey,
	validateSecrets,
} from "./secrets.ts";

describe("validateSecretKey — known patterns", () => {
	it("accepts a well-formed OpenAI key, rejects a malformed one", () => {
		expect(
			validateSecretKey("OPENAI_API_KEY", `sk-${"a".repeat(30)}`).isValid,
		).toBe(true);
		const bad = validateSecretKey("OPENAI_API_KEY", "not-a-key");
		expect(bad.isValid).toBe(false);
		expect(bad.error).toMatch(/sk-|short/);
	});

	it("enforces the Anthropic sk-ant- prefix", () => {
		expect(
			validateSecretKey("ANTHROPIC_API_KEY", `sk-ant-${"a".repeat(30)}`)
				.isValid,
		).toBe(true);
		expect(
			validateSecretKey("ANTHROPIC_API_KEY", `sk-${"a".repeat(30)}`).isValid,
		).toBe(false);
	});
});

describe("validateSecretKey — basic (no pattern)", () => {
	it("rejects empty and placeholder values", () => {
		expect(validateSecretKey("CUSTOM_THING", "").isValid).toBe(false);
		expect(validateSecretKey("CUSTOM_THING", "   ").isValid).toBe(false);
		expect(validateSecretKey("CUSTOM_THING", "your_api_key_here").isValid).toBe(
			false,
		);
		expect(validateSecretKey("CUSTOM_THING", "REPLACE_ME").isValid).toBe(false);
	});

	it("accepts a plausible custom value", () => {
		expect(
			validateSecretKey("CUSTOM_THING", "a-real-looking-value-123").isValid,
		).toBe(true);
	});
});

describe("checkRequiredSecrets", () => {
	it("reports missing and invalid required keys", () => {
		const out = checkRequiredSecrets(
			{ OPENAI_API_KEY: "bad", PRESENT: "value-here-ok" },
			["OPENAI_API_KEY", "MISSING_KEY", "PRESENT"],
		);
		expect(out.missing).toEqual(["MISSING_KEY"]);
		expect(out.invalid).toEqual(["OPENAI_API_KEY"]);
		expect(out.valid).toBe(false);
	});

	it("is valid when all required keys are present and well-formed", () => {
		const out = checkRequiredSecrets(
			{ OPENAI_API_KEY: `sk-${"a".repeat(30)}` },
			["OPENAI_API_KEY"],
		);
		expect(out.valid).toBe(true);
	});
});

describe("pattern lookup helpers", () => {
	it("getValidationPattern / hasValidationPattern", () => {
		expect(hasValidationPattern("OPENAI_API_KEY")).toBe(true);
		expect(hasValidationPattern("NOPE_KEY")).toBe(false);
		expect(getValidationPattern("OPENAI_API_KEY")?.minLength).toBeGreaterThan(
			0,
		);
	});

	it("inferValidationPatternKey maps variants to the canonical key", () => {
		expect(inferValidationPatternKey("MY_OPENAI_API_KEY")).toBe(
			"OPENAI_API_KEY",
		);
		expect(inferValidationPatternKey("anthropic_key")).toBe(
			"ANTHROPIC_API_KEY",
		);
		expect(inferValidationPatternKey("OPENAI_API_KEY")).toBe("OPENAI_API_KEY");
	});
});

describe("validateSecrets", () => {
	it("validates each entry independently", () => {
		const results = validateSecrets({
			OPENAI_API_KEY: "bad",
			X: "fine-value-123",
		});
		expect(results.OPENAI_API_KEY.isValid).toBe(false);
		expect(results.X.isValid).toBe(true);
	});
});
