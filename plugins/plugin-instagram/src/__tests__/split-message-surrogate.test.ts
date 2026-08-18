/**
 * Regression coverage for `splitMessage`'s character-split fallback (used for
 * a single "word" with no whitespace longer than the platform limit): the
 * fallback must never cut a UTF-16 surrogate pair (emoji) in half.
 */
import { describe, expect, it } from "vitest";
import { MAX_DM_LENGTH } from "../constants.js";
import { splitMessage } from "../service.js";

describe("splitMessage character-split fallback", () => {
  it("keeps a surrogate pair (emoji) intact instead of splitting it across chunks", () => {
    // A run of "x" up to one code unit before the limit, then a 2-code-unit
    // emoji, then more text, all with no whitespace: a naive
    // slice(i, i + maxLength) cuts between the emoji's high and low
    // surrogate at the first chunk boundary.
    const word = `${"x".repeat(MAX_DM_LENGTH - 1)}\u{1F600}${"y".repeat(50)}`;

    const parts = splitMessage(word, MAX_DM_LENGTH);

    expect(parts.length).toBeGreaterThan(1);
    for (const part of parts) {
      expect(part.length).toBeLessThanOrEqual(MAX_DM_LENGTH);
      expect(part.isWellFormed()).toBe(true);
    }
    expect(parts.join("")).toBe(word);
  });

  it("still chunks a plain long word at exact maxLength boundaries", () => {
    const word = "a".repeat(MAX_DM_LENGTH * 2 + 5);

    const parts = splitMessage(word, MAX_DM_LENGTH);

    expect(parts).toEqual(["a".repeat(MAX_DM_LENGTH), "a".repeat(MAX_DM_LENGTH), "a".repeat(5)]);
    expect(parts.join("")).toBe(word);
  });
});
