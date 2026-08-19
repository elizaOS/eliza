/**
 * Regression coverage for `splitMessage`'s character-split fallback (used for
 * a single "word" with no whitespace longer than the platform limit): the
 * fallback must never cut a UTF-16 surrogate pair (emoji) in half.
 */
import { ElizaError } from "@elizaos/core";
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

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY, 1.5])(
    "rejects a non-positive-integer maxLength (%s) instead of misbehaving",
    (maxLength) => {
      expect(() => splitMessage("hello world", maxLength)).toThrow(ElizaError);
      try {
        splitMessage("hello world", maxLength);
        throw new Error("expected splitMessage to throw");
      } catch (err) {
        expect(err).toBeInstanceOf(ElizaError);
        expect((err as ElizaError).code).toBe("INSTAGRAM_SPLIT_LIMIT_INVALID");
      }
    }
  );

  it("throws instead of looping forever when maxLength is too small to fit an emoji-leading word", () => {
    // maxLength: 1 can never fit a 2-code-unit surrogate pair, so
    // truncateWellFormed(word, 1) always returns "" — pushing that empty
    // chunk forever would never advance `remainingWord`.
    const word = `\u{1F600}${"y".repeat(5)}`;

    expect(() => splitMessage(word, 1)).toThrow(ElizaError);
    try {
      splitMessage(word, 1);
      throw new Error("expected splitMessage to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ElizaError);
      expect((err as ElizaError).code).toBe("INSTAGRAM_SPLIT_LIMIT_TOO_SMALL");
    }
  });

  it("still succeeds at the minimum maxLength that can fit any single well-formed unit", () => {
    // maxLength: 2 is exactly wide enough for one surrogate pair, so an
    // emoji-leading word must still split successfully, not throw.
    const word = `\u{1F600}${"y".repeat(5)}`;

    const parts = splitMessage(word, 2);

    for (const part of parts) {
      expect(part.length).toBeLessThanOrEqual(2);
      expect(part.isWellFormed()).toBe(true);
    }
    expect(parts.join("")).toBe(word);
  });
});
