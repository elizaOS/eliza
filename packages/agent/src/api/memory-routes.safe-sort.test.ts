/**
 * Safe NaN handling for memory routes hits sort.
 */
import { describe, expect, it } from "vitest";

function safeSort(hits: { score: number; createdAt: number; id: string }[]) {
  return [...hits].sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const aTime = Number.isFinite(a.createdAt) ? a.createdAt : 0;
    const bTime = Number.isFinite(b.createdAt) ? b.createdAt : 0;
    if (bTime !== aTime) return bTime - aTime;
    return a.id.localeCompare(b.id);
  });
}

describe("memory-routes safe-sort", () => {
  it("sorts by score then time", () => {
    const sorted = safeSort([
      { score: 1, createdAt: 1, id: "a" },
      { score: 2, createdAt: 1, id: "b" },
    ]);
    expect(sorted[0].id).toBe("b");
  });
  it("NaN fallback", () => {
    const sorted = safeSort([
      { score: 1, createdAt: NaN, id: "a" },
      { score: 1, createdAt: 1, id: "b" },
    ]);
    expect(sorted[0].id).toBe("b");
  });
  it("tiebreak", () => {
    const sorted = safeSort([
      { score: 1, createdAt: 1, id: "b" },
      { score: 1, createdAt: 1, id: "a" },
    ]);
    expect(sorted[0].id).toBe("a");
  });
});
