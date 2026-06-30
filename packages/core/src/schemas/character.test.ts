import { describe, expect, it } from "vitest";
import { isValidCharacter, parseAndValidateCharacter } from "./character";

/**
 * Tests for character config validation (#8801 / #9943). parseAndValidateCharacter
 * and isValidCharacter gate whether an agent definition is accepted; they (and
 * the underlying validateCharacter) were untested. The key behaviors: a valid
 * character passes, malformed JSON is reported DISTINCTLY from schema errors, and
 * non-objects / missing name are rejected.
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
