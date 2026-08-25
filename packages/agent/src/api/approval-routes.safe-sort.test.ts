/**
 * Safe NaN handling for approval routes dedup sort.
 */
import { describe, expect, it } from "vitest";

function safeSort(items: { createdAt: number; id: string }[]) {
  return [...items].sort((a, b) => {
    const aTime = Number.isFinite(a.createdAt) ? a.createdAt : 0;
    const bTime = Number.isFinite(b.createdAt) ? b.createdAt : 0;
    if (bTime !== aTime) return bTime - aTime;
    return a.id.localeCompare(b.id);
  });
}

describe("approval-routes safe-sort", () => {
  it("sorts descending", () => {
    expect(
      safeSort([
        { createdAt: 1, id: "a" },
        { createdAt: 2, id: "b" },
      ])[0].id,
    ).toBe("b");
  });
  it("NaN fallback", () => {
    expect(
      safeSort([
        { createdAt: NaN, id: "a" },
        { createdAt: 1, id: "b" },
      ])[0].id,
    ).toBe("b");
  });
  it("tiebreak", () => {
    expect(
      safeSort([
        { createdAt: 1, id: "b" },
        { createdAt: 1, id: "a" },
      ])[0].id,
    ).toBe("a");
  });
});
