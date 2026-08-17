/**
 * Prefix-coerced workbench todo priority must be invalid.
 * Number("1e2") === 100 used to become a stored priority.
 */
import { describe, expect, it } from "vitest";
import { parseNullableNumber } from "./workbench-todos";

describe("workbench todo priority leftover identities", () => {
  it("1e2 is invalid instead of becoming 100", () => {
    expect(parseNullableNumber("1e2")).toBeNull();
  });

  it("007 is invalid instead of becoming 7", () => {
    expect(parseNullableNumber("007")).toBeNull();
  });

  it("0x10 is invalid instead of becoming 16", () => {
    expect(parseNullableNumber("0x10")).toBeNull();
  });

  it("canonical 3 still parses", () => {
    expect(parseNullableNumber("3")).toBe(3);
  });

  it("canonical number 3 still parses", () => {
    expect(parseNullableNumber(3)).toBe(3);
  });

  it("omitted priority stays null", () => {
    expect(parseNullableNumber(null)).toBeNull();
    expect(parseNullableNumber(undefined)).toBeNull();
    expect(parseNullableNumber("")).toBeNull();
  });
});
