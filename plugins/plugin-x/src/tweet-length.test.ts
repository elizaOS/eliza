/** Exercises X's reference weighted-length parser through the connector gate. */
import { describe, expect, it } from "vitest";
import { countTwitterWeightedLength } from "./tweet-length";

describe("countTwitterWeightedLength", () => {
  it("counts Latin, CJK, emoji clusters, and URLs the way X does", () => {
    expect(countTwitterWeightedLength("a".repeat(280))).toBe(280);
    expect(countTwitterWeightedLength("a".repeat(281))).toBe(281);
    expect(countTwitterWeightedLength("你".repeat(140))).toBe(280);
    expect(countTwitterWeightedLength("你".repeat(141))).toBe(282);
    expect(countTwitterWeightedLength("🦊")).toBe(2);
    expect(countTwitterWeightedLength("👨‍👩‍👧‍👦")).toBe(2);
    expect(
      countTwitterWeightedLength("see https://example.com/this/is/a/long/path"),
    ).toBe(4 + 23);
  });

  it("matches JavaScript length on a previously-valid Latin corpus", () => {
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
