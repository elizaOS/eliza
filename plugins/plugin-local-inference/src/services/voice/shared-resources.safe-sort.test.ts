/**
 * Regression coverage for eviction priority sort comparator.
 */
import { describe, expect, it } from "vitest";
import { __testCompareEvictableModelRole } from "./shared-resources.ts";

function role(name: string, priority: number) {
  return { role: name, evictionPriority: priority } as any;
}

describe("compareEvictableModelRole", () => {
  it("sorts ascending by evictionPriority (cheapest first)", () => {
    const sorted = [role("tts", 50), role("emotion", 15), role("asr", 40)].sort(__testCompareEvictableModelRole);
    expect(sorted.map((r) => r.role)).toEqual(["emotion", "asr", "tts"]);
  });

  it("treats NaN/Infinity as 0", () => {
    const sorted = [role("b", Number.NaN), role("a", 0), role("c", Number.POSITIVE_INFINITY)].sort(__testCompareEvictableModelRole);
    // all 0 -> sorted by role
    expect(sorted.map((r) => r.role)).toEqual(["a", "b", "c"]);
  });

  it("uses role localeCompare as tie-break for equal priority", () => {
    const sorted = [role("zebra", 10), role("apple", 10)].sort(__testCompareEvictableModelRole);
    expect(sorted.map((r) => r.role)).toEqual(["apple", "zebra"]);
  });
});
