/**
 * Safe NaN handling for virtual filesystem snapshot sort.
 */
import { describe, expect, it } from "vitest";

function safeSort(snapshots: { createdAt: string; id: string }[]) {
  return [...snapshots].sort((a, b) => {
    const aTime = Date.parse(a.createdAt);
    const bTime = Date.parse(b.createdAt);
    const aSafe = Number.isFinite(aTime) ? aTime : 0;
    const bSafe = Number.isFinite(bTime) ? bTime : 0;
    if (bSafe !== aSafe) return bSafe - aSafe;
    return a.id.localeCompare(b.id);
  });
}

describe("virtual-filesystem safe-sort", () => {
  it("sorts valid dates descending", () => {
    const sorted = safeSort([
      { createdAt: "2026-01-02T00:00:00.000Z", id: "b" },
      { createdAt: "2026-01-01T00:00:00.000Z", id: "a" },
    ]);
    expect(sorted[0].id).toBe("b");
  });
  it("puts NaN at end with fallback 0", () => {
    const sorted = safeSort([
      { createdAt: "invalid", id: "a" },
      { createdAt: "2026-01-01T00:00:00.000Z", id: "b" },
    ]);
    expect(sorted[0].id).toBe("b");
  });
  it("tiebreaks by id when times equal or both NaN", () => {
    const sorted = safeSort([
      { createdAt: "invalid", id: "b" },
      { createdAt: "also-bad", id: "a" },
    ]);
    expect(sorted[0].id).toBe("a");
  });
});
