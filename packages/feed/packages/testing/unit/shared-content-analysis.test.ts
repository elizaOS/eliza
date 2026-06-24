import { describe, expect, it } from "bun:test";
import {
  analyzeSentiment,
  jaccardSimilarity,
} from "../../shared/src/utils/content-analysis";

/**
 * Text-only content analysis (no oracle data). jaccardSimilarity backs
 * duplicate-post detection (tokens > 3 chars), and analyzeSentiment scores
 * observable sentiment words clamped to [-1, 1]. Both are deterministic.
 */

describe("jaccardSimilarity", () => {
  it("scores 1 for identical, 0 for disjoint, fractional for overlap", () => {
    expect(jaccardSimilarity("hello world example", "hello world example")).toBe(
      1,
    );
    expect(jaccardSimilarity("hello world", "planet saturn")).toBe(0);
    expect(jaccardSimilarity("hello world", "hello planet")).toBeCloseTo(1 / 3);
    // tokens of <= 3 chars are dropped → no comparable tokens → 0.
    expect(jaccardSimilarity("the cat sat", "the dog ran")).toBe(0);
    expect(jaccardSimilarity("", "hello world")).toBe(0);
  });
});

describe("analyzeSentiment", () => {
  it("sums +/-0.15 per sentiment word, clamped to [-1,1]", () => {
    expect(analyzeSentiment("great success bullish")).toBeCloseTo(0.45);
    expect(analyzeSentiment("crash collapse loss")).toBeCloseTo(-0.45);
    expect(analyzeSentiment("great crash")).toBeCloseTo(0); // cancel out
    expect(analyzeSentiment("nothing notable today")).toBe(0);
    // many positives clamp at 1.
    expect(
      analyzeSentiment(
        "great good excellent success win approved confirmed amazing fantastic bullish",
      ),
    ).toBe(1);
  });
});
