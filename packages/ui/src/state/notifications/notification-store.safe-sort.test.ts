/**
 * Regression: notification createdAt sort must be NaN-safe and stable.
 */
import { describe, expect, it } from "vitest";

function sortNotifications(items: { id: string; createdAt: number }[]): { id: string; createdAt: number }[] {
  return [...items].sort((a, b) => {
    const aSafe = Number.isFinite(a.createdAt) ? a.createdAt : 0;
    const bSafe = Number.isFinite(b.createdAt) ? b.createdAt : 0;
    if (bSafe !== aSafe) return bSafe - aSafe;
    return a.id.localeCompare(b.id);
  });
}

describe("notification-store safe sort", () => {
  it("handles NaN createdAt as 0", () => {
    const items = [
      { id: "b", createdAt: Number.NaN },
      { id: "a", createdAt: 100 },
    ];
    const sorted = sortNotifications(items);
    expect(sorted[0].id).toBe("a");
  });
  it("tiebreaks by id for determinism", () => {
    const items = [
      { id: "b", createdAt: 100 },
      { id: "a", createdAt: 100 },
    ];
    const sorted = sortNotifications(items);
    expect(sorted.map((x) => x.id)).toEqual(["a", "b"]);
  });
  it("handles Infinity as 0 fallback", () => {
    const items = [
      { id: "a", createdAt: Number.POSITIVE_INFINITY },
      { id: "b", createdAt: 50 },
    ];
    const sorted = sortNotifications(items);
    expect(sorted[0].id).toBe("b");
  });
});
