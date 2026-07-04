import { describe, expect, it } from "vitest";
import { isValidCharacter, parseAndValidateCharacter } from "./character";

/**
 * Unit tests for the character-config validators (`parseAndValidateCharacter`,
 * `isValidCharacter`, over the underlying `validateCharacter`) that gate whether
 * an agent definition is accepted — pure synchronous zod validation, no model or
 * DB. Covers a valid character passing, malformed JSON reported distinctly from
 * schema errors, and non-object / missing-name rejection. (#8801 / #9943)
 */
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

describe("isValidCharacter", () => {
	it("is a type guard — true only for a valid character object", () => {
		expect(isValidCharacter({ name: "Aria" })).toBe(true);
		expect(isValidCharacter({})).toBe(false);
		expect(isValidCharacter(null)).toBe(false);
		expect(isValidCharacter("nope")).toBe(false);
		expect(isValidCharacter(42)).toBe(false);
	});
});
