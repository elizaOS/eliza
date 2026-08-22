/**
 * Deterministic coverage of twitter-text v3 weighted tweet length: CJK is 2
 * units, Latin is 1, URLs are 23, and truncation never splits a supplementary
 * code point.
 */
import { describe, expect, it } from "vitest";
import {
  countTwitterWeightedLength,
  truncateToTwitterWeightedLength,
} from "./tweet-length";

describe("countTwitterWeightedLength", () => {
  it("counts Latin, CJK, emoji, and URLs the way X does", () => {
    expect(countTwitterWeightedLength("a".repeat(280))).toBe(280);
    expect(countTwitterWeightedLength("a".repeat(281))).toBe(281);
    expect(countTwitterWeightedLength("你".repeat(140))).toBe(280);
    expect(countTwitterWeightedLength("你".repeat(141))).toBe(282);
    expect(countTwitterWeightedLength("🦊")).toBe(2);
    expect("🦊".length).toBe(2);
    expect("你".length).toBe(1);
    expect(
      countTwitterWeightedLength("see https://example.com/this/is/a/long/path"),
    ).toBe(4 + 23);
  });

  it("matches origin JavaScript length on a previously-valid Latin corpus", () => {
    const corpus = [
      "",
      "hello",
      "hello world",
      "a".repeat(280),
      "The quick brown fox jumps over the lazy dog.",
      "gm",
      "1234567890",
      "Hello, world!",
    ];
    for (const text of corpus) {
      expect(countTwitterWeightedLength(text)).toBe(text.length);
    }
  });
});

describe("truncateToTwitterWeightedLength", () => {
  it("keeps 140 CJK characters and drops the 141st", () => {
    const text = "你".repeat(141);
    const truncated = truncateToTwitterWeightedLength(text, 280);
    expect(truncated).toBe("你".repeat(140));
    expect(countTwitterWeightedLength(truncated)).toBe(280);
  });

  it("does not split a supplementary-plane emoji at the cap", () => {
    const text = `${"a".repeat(279)}🦊`;
    expect(text.length).toBe(281);
    const truncated = truncateToTwitterWeightedLength(text, 280);
    expect(truncated).toBe("a".repeat(279));
    expect(truncated.includes("\uD83E") || truncated.includes("🦊")).toBe(
      false,
    );
  });
});
