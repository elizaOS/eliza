import { describe, expect, it } from "vitest";

import { normalizeWerText, wordErrorRate } from "./voice-wer";

// voice-wer is the single source of truth for word-error-rate (#8785) — both the
// headless metric library and the headful self-test re-export it. It had no
// dedicated test; this pins the normalization + the Levenshtein scoring so the
// two consumers can never drift again.
describe("normalizeWerText", () => {
  it("lowercases and collapses whitespace", () => {
    expect(normalizeWerText("  Hello   WORLD ")).toBe("hello world");
  });

  it("strips punctuation but keeps letters, numbers, and apostrophes", () => {
    expect(normalizeWerText("It's 42, really?!")).toBe("it's 42 really");
  });

  it("retains unicode letters/numbers", () => {
    expect(normalizeWerText("Café déjà 3")).toBe("café déjà 3");
  });

  it("turns a punctuation-only string into empty", () => {
    expect(normalizeWerText("?!.,")).toBe("");
  });
});

describe("wordErrorRate", () => {
  it("is 0 for identical strings", () => {
    expect(wordErrorRate("the quick brown fox", "the quick brown fox")).toBe(0);
  });

  it("is case- and punctuation-insensitive (still 0)", () => {
    expect(wordErrorRate("The quick brown fox.", "the QUICK brown, fox")).toBe(
      0,
    );
  });

  it("scores a single substitution as 1/N", () => {
    // 3-word reference, one word wrong → 1/3
    expect(wordErrorRate("one two three", "one four three")).toBeCloseTo(
      1 / 3,
      10,
    );
  });

  it("scores a single insertion as 1/N", () => {
    expect(wordErrorRate("one two three", "one two extra three")).toBeCloseTo(
      1 / 3,
      10,
    );
  });

  it("scores a single deletion as 1/N", () => {
    expect(wordErrorRate("one two three", "one three")).toBeCloseTo(1 / 3, 10);
  });

  it("an empty reference scores 0 against an empty hypothesis", () => {
    expect(wordErrorRate("", "")).toBe(0);
    expect(wordErrorRate("   ", "?!.")).toBe(0);
  });

  it("an empty reference scores 1 against a non-empty hypothesis", () => {
    expect(wordErrorRate("", "anything here")).toBe(1);
  });

  it("can exceed 1 when the hypothesis is much longer (insertions dominate)", () => {
    // ref 1 word; hyp 3 words → 1 sub-or-match + 2 insertions = 2 errors / 1 = 2
    expect(wordErrorRate("hi", "hi there friend")).toBe(2);
  });

  it("scores a fully wrong same-length hypothesis as 1", () => {
    expect(wordErrorRate("alpha beta", "gamma delta")).toBe(1);
  });
});
