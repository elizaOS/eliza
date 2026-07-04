import { describe, expect, test } from "bun:test";
import { parseStrictFiniteNumber } from "./strict-numeric";

describe("parseStrictFiniteNumber", () => {
  test("accepts finite numbers and complete decimal strings", () => {
    expect(parseStrictFiniteNumber(12.5, "amount")).toBe(12.5);
    expect(parseStrictFiniteNumber("12.500000", "amount")).toBe(12.5);
    expect(parseStrictFiniteNumber("  .75 ", "amount")).toBe(0.75);
    expect(parseStrictFiniteNumber("-1e-3", "amount")).toBe(-0.001);
  });

  test("rejects partial, blank, and non-finite numeric values", () => {
    for (const value of [
      "12abc",
      "1,000",
      "",
      " ",
      "Infinity",
      "NaN",
      null,
      undefined,
      Number.NaN,
      Infinity,
    ]) {
      expect(() => parseStrictFiniteNumber(value, "amount", "TestOwner")).toThrow(
        "[TestOwner] Invalid numeric amount",
      );
    }
  });
});
