/**
 * Unit tests for the character-config validators (`parseAndValidateCharacter`,
 * `isValidCharacter`, over the underlying `validateCharacter`) that gate whether
 * an agent definition is accepted — pure synchronous zod validation, no model or
 * DB. Covers a valid character passing, malformed JSON reported distinctly from
 * schema errors, and non-object / missing-name rejection. (#8801 / #9943)
 */
import { describe, expect, it } from "vitest";
import {
	isValidCharacter,
	parseAndValidateCharacter,
	validateCharacter,
} from "./character";

describe("parseAndValidateCharacter", () => {
	it("accepts a minimal valid character", () => {
		expect(parseAndValidateCharacter('{"name":"Aria"}').success).toBe(true);
	});

	it("reports invalid JSON distinctly (not as a schema error)", () => {
		const result = parseAndValidateCharacter("{not valid json");
		expect(result.success).toBe(false);
		if (!result.success) expect(result.error.message).toMatch(/Invalid JSON/);
	});

	it("rejects well-formed JSON that fails the schema (missing name)", () => {
		expect(parseAndValidateCharacter("{}").success).toBe(false);
	});

	it("rejects a non-object JSON value", () => {
		expect(parseAndValidateCharacter('"just a string"').success).toBe(false);
	});
});

describe("settings.maxReplyTokens", () => {
	// #16395: the schema relocates unknown settings keys into settings.extra,
	// which would silently strip the reply-length budget. maxReplyTokens must be
	// a known top-level key that survives the validate round-trip.
	it("survives validateCharacter as a top-level settings key (not extra)", () => {
		const result = validateCharacter({
			name: "Aria",
			settings: { maxReplyTokens: 200 },
		});
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.settings?.maxReplyTokens).toBe(200);
			expect(result.data.settings?.extra).toBeUndefined();
		}
	});

	it("rejects a non-positive or non-integer budget", () => {
		expect(
			validateCharacter({ name: "Aria", settings: { maxReplyTokens: 0 } })
				.success,
		).toBe(false);
		expect(
			validateCharacter({ name: "Aria", settings: { maxReplyTokens: 2.5 } })
				.success,
		).toBe(false);
	});
});

describe("isValidCharacter", () => {
	it("is a type guard — true only for a valid character object", () => {
		expect(isValidCharacter({ name: "Aria" })).toBe(true);
		expect(isValidCharacter({})).toBe(false);
		expect(isValidCharacter(null)).toBe(false);
		expect(isValidCharacter("nope")).toBe(false);
		expect(isValidCharacter(42)).toBe(false);
	});
});
