/**
 * Coverage for splitMessageForIMessage's chunk boundary: an unbroken run of
 * multi-byte text (no newline/space near the limit) must never cut a UTF-16
 * surrogate pair (emoji) in half.
 */

import { describe, expect, it } from "vitest";
import { splitMessageForIMessage } from "./types";

describe("splitMessageForIMessage", () => {
  it("does not split a surrogate pair when no whitespace break point exists near the limit", () => {
    // 🎉 is a surrogate pair (U+1F389, 2 UTF-16 code units). A run of them
    // long enough to exceed maxLength with no space/newline forces the
    // fallback hard cut at exactly maxLength.
    const emoji = "\u{1F389}"; // 🎉
    const text = emoji.repeat(50); // 100 UTF-16 code units, no whitespace
    const maxLength = 51; // odd cut point lands mid-pair without the fix

    const chunks = splitMessageForIMessage(text, maxLength);

    for (const chunk of chunks) {
      expect(chunk.length === 0 || chunk.isWellFormed()).toBe(true);
    }
    expect(chunks.join("")).toBe(text);
  });

  it("still breaks on whitespace when available", () => {
    const text = `${"a".repeat(30)} ${"b".repeat(30)}`;
    const chunks = splitMessageForIMessage(text, 32);
    expect(chunks).toEqual(["a".repeat(30), "b".repeat(30)]);
  });

  it("returns the input unchanged when under the limit", () => {
    expect(splitMessageForIMessage("hello", 4000)).toEqual(["hello"]);
  });
});
