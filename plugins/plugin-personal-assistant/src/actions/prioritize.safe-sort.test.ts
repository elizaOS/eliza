import { describe, expect, it } from "vitest";

describe("prioritize ranking safe-sort", () => {
  it("sorts rankings deterministically with non-finite score values", () => {
    const ranking: Array<{ id: string; score: number; reasoning: string }> = [
      { id: "item-nan", score: Number.NaN, reasoning: "NaN score" },
      { id: "item-high", score: 10, reasoning: "High score" },
      { id: "item-low", score: 2, reasoning: "Low score" },
    ];

    const sorted = [...ranking].sort((a, b) => {
      const bScore =
        typeof b.score === "number" && Number.isFinite(b.score) ? b.score : 0;
      const aScore =
        typeof a.score === "number" && Number.isFinite(a.score) ? a.score : 0;
      return bScore - aScore || a.id.localeCompare(b.id);
    });

    expect(sorted.map((e) => e.id)).toEqual([
      "item-high",
      "item-low",
      "item-nan",
    ]);
  });
});
