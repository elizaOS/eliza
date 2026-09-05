/**
 * Preserves well-formed Unicode across remaining preview and monogram truncation.
 */
// @vitest-environment jsdom

import { toWellFormedUnicode, truncateWellFormed } from "@elizaos/core";
import { describe, expect, it } from "vitest";

// Replicate the naive helpers to prove they are ill-formed, and verify fixed helpers are well-formed.

function naiveTruncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function isWellFormed(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const n = value.charCodeAt(i + 1);
      if (!(n >= 0xdc00 && n <= 0xdfff)) return false;
      i++;
    } else if (c >= 0xdc00 && c <= 0xdfff) return false;
  }
  return true;
}

describe("surrogate-preview-monogram truncation", () => {
  it("naive truncateText splits surrogate at 200, fixed backs off", () => {
    const fox = String.fromCodePoint(0x1f600);
    // 199 'a' + fox (2 units at 199,200) -> slice(0,200) keeps lone high surrogate
    const text = "a".repeat(199) + fox + "b".repeat(10);
    const naive = naiveTruncate(text, 200);
    expect(isWellFormed(naive)).toBe(false);
    const wellFormed = toWellFormedUnicode(text);
    const fixed =
      wellFormed.length > 200
        ? `${truncateWellFormed(wellFormed, 200)}…`
        : wellFormed;
    expect(isWellFormed(fixed)).toBe(true);
    expect(() => JSON.stringify(fixed)).not.toThrow();
  });

  it("naive config-field slice at 26 splits surrogate, fixed preserves", () => {
    const fox = String.fromCodePoint(0x1f98a);
    const raw = "a".repeat(25) + fox + "b".repeat(10);
    const naive = raw.length > 28 ? `${raw.slice(0, 26)}…` : raw;
    expect(isWellFormed(naive)).toBe(false);
    const wellFormed = toWellFormedUnicode(raw);
    const fixed =
      wellFormed.length > 28
        ? `${truncateWellFormed(wellFormed, 26)}…`
        : wellFormed;
    expect(isWellFormed(fixed)).toBe(true);
  });

  it("monogram word[0] via Array.from gets full emoji, naive word[0] gets lone high", () => {
    const foxWord = `${String.fromCodePoint(0x1f680)}rocket`;
    const naive = foxWord[0] ?? "";
    expect(naive.charCodeAt(0)).toBe(0xd83d);
    expect(isWellFormed(naive)).toBe(false);
    const fixed = Array.from(toWellFormedUnicode(foxWord))[0] ?? "";
    expect(isWellFormed(fixed)).toBe(true);
    expect(fixed).toBe(String.fromCodePoint(0x1f680));
  });

  it("monogram label.slice(0,1) splits emoji, Array.from preserves", () => {
    const fox = String.fromCodePoint(0x1f98a);
    const label = `${fox}label`;
    const naive = label.slice(0, 1);
    expect(isWellFormed(naive)).toBe(false);
    const fixed = Array.from(toWellFormedUnicode(label))[0] ?? "";
    expect(isWellFormed(fixed)).toBe(true);
    expect(fixed).toBe(fox);
  });
});
