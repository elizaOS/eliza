/**
 * Coverage for splitMessageForIMessage's chunk boundary: an unbroken run of
 * multi-byte text (no newline/space near the limit) must never cut a UTF-16
 * surrogate pair (emoji) in half, and the bound itself must be validated so
 * a degenerate `maxLength` fails closed instead of looping forever.
 *
 * Well-formedness is asserted via toWellFormedUnicode's round-trip
 * (`toWellFormedUnicode(chunk) === chunk`) rather than the native
 * `String.prototype.isWellFormed`: the former exercises this repo's real
 * fallback path on runtimes without the ES2024 method, so the check stays
 * load-bearing everywhere instead of only where the native method exists.
 */

import { toWellFormedUnicode } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { isEmail, splitMessageForIMessage } from "./types";

describe("isEmail", () => {
  it("validates a 100k local part without polynomial backtracking", () => {
    expect(isEmail(`${"a".repeat(100_000)}@example.com`)).toBe(true);
    expect(isEmail(`${"a".repeat(100_000)}@example`)).toBe(false);
  });
});

function expectWellFormedLosslessRejoin(text: string, maxLength: number) {
  const chunks = splitMessageForIMessage(text, maxLength);
  for (const chunk of chunks) {
    expect(chunk.length).toBeGreaterThan(0);
    expect(toWellFormedUnicode(chunk)).toBe(chunk);
  }
  expect(chunks.join("")).toBe(text);
  return chunks;
}

describe("splitMessageForIMessage", () => {
  it("does not split a surrogate pair when no whitespace break point exists near the limit", () => {
    // 🎉 is a surrogate pair (U+1F389, 2 UTF-16 code units). A run of them
    // long enough to exceed maxLength with no space/newline forces the
    // fallback hard cut at exactly maxLength.
    const emoji = "\u{1F389}"; // 🎉
    const text = emoji.repeat(50); // 100 UTF-16 code units, no whitespace
    const maxLength = 51; // odd cut point lands mid-pair without the fix

    expectWellFormedLosslessRejoin(text, maxLength);
  });

  it("still breaks on whitespace when available", () => {
    const text = `${"a".repeat(30)} ${"b".repeat(30)}`;
    const chunks = splitMessageForIMessage(text, 32);
    expect(chunks).toEqual(["a".repeat(30), "b".repeat(30)]);
  });

  it("returns the input unchanged when under the limit", () => {
    expect(splitMessageForIMessage("hello", 4000)).toEqual(["hello"]);
  });

  it("terminates and widens by exactly one unit for a leading surrogate pair at maxLength 1", () => {
    // The one supported-but-degenerate bound: an astral scalar needs both
    // surrogate halves, so no 1-unit head chunk can exist. The effective
    // chunk is 2 code units here instead of 1 -- documented exception, not
    // a bug -- but the loop must still terminate on well-formed, nonempty,
    // losslessly-rejoinable chunks.
    const text = "\u{1F389}\u{1F389}\u{1F389}"; // 🎉🎉🎉, no whitespace
    const chunks = expectWellFormedLosslessRejoin(text, 1);
    expect(chunks).toEqual(["\u{1F389}", "\u{1F389}", "\u{1F389}"]);
  });

  it("fits a single leading emoji exactly at maxLength 2 with no widening", () => {
    const text = "\u{1F389}\u{1F389}"; // 🎉🎉, no whitespace
    const chunks = expectWellFormedLosslessRejoin(text, 2);
    expect(chunks).toEqual(["\u{1F389}", "\u{1F389}"]);
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    "rejects a degenerate maxLength (%s) instead of looping forever",
    (maxLength) => {
      expect(() => splitMessageForIMessage("hello world", maxLength)).toThrow(
        /maxLength must be a positive finite number/
      );
    }
  );
});
