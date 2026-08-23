/** Safe NaN handling in recentMessages provider. */
import { describe, expect, it } from "vitest";
function sortByCreatedAt<T extends { createdAt?: number; id?: string }>(items: T[]): T[] {
  return [...items].sort((a, b) => {
    const aSafe = Number.isFinite(a.createdAt ?? 0) ? (a.createdAt ?? 0) : 0;
    const bSafe = Number.isFinite(b.createdAt ?? 0) ? (b.createdAt ?? 0) : 0;
    if (bSafe !== aSafe) return bSafe - aSafe;
    return String(a.id ?? "").localeCompare(String(b.id ?? ""));
  });
}
describe("recentMessages safe sort", () => {
  it("handles NaN", () => {
    const items = [{ id: "b", createdAt: NaN }, { id: "a", createdAt: NaN }, { id: "c", createdAt: 20 }];
    const s = sortByCreatedAt(items);
    expect(s[0].id).toBe("c");
    expect(s[1].id).toBe("a");
  });
  it("tiebreak id", () => {
    const items = [{ id: "z", createdAt: 1 }, { id: "a", createdAt: 1 }];
    expect(sortByCreatedAt(items)[0].id).toBe("a");
  });
  it("desc", () => {
    const items = [{ id: "a", createdAt: 1 }, { id: "b", createdAt: 2 }];
    expect(sortByCreatedAt(items)[0].id).toBe("b");
  });
});
