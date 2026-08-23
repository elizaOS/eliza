/**
 * Regression coverage for voice-profile similarity sort comparator.
 * Proves NaN-safe descending order and stable id tie-break.
 */
import { describe, expect, it } from "vitest";
import { __testCompareVoiceProfileSearchHit } from "./store.ts";

function hit(id: string, similarity: number) {
  return { profile: { id } as any, similarity };
}

describe("compareVoiceProfileSearchHit", () => {
  it("sorts descending by similarity (highest first)", () => {
    const sorted = [hit("b", 0.2), hit("a", 0.9), hit("c", 0.5)].sort(__testCompareVoiceProfileSearchHit);
    expect(sorted.map((h) => h.profile.id)).toEqual(["a", "c", "b"]);
  });

  it("treats NaN/Infinity as NEGATIVE_INFINITY (sorted last)", () => {
    const sorted = [hit("nan", Number.NaN), hit("inf", Number.POSITIVE_INFINITY), hit("valid", 0.3), hit("neginf", Number.NEGATIVE_INFINITY)].sort(__testCompareVoiceProfileSearchHit);
    expect(sorted[0].profile.id).toBe("valid");
    // NaN, +Infinity, -Infinity all map to -Infinity -> tie-break by id
    expect(sorted.slice(1).map((h) => h.profile.id)).toEqual(["inf", "nan", "neginf"].sort());
  });

  it("uses profile.id localeCompare as deterministic tie-break for equal scores", () => {
    const sorted = [hit("zebra", 0.5), hit("apple", 0.5), hit("mango", 0.5)].sort(__testCompareVoiceProfileSearchHit);
    expect(sorted.map((h) => h.profile.id)).toEqual(["apple", "mango", "zebra"]);
  });
});
