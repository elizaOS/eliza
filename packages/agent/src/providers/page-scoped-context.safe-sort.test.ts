/** Safe NaN handling in page-scoped-context. */
import { describe, expect, it } from "vitest";
function sortByCreatedAt<T extends { createdAt?: number; id?: string }>(items: T[]): T[] {
  return [...items].sort((left, right) => {
    const leftSafe = Number.isFinite(left.createdAt ?? 0) ? (left.createdAt ?? 0) : 0;
    const rightSafe = Number.isFinite(right.createdAt ?? 0) ? (right.createdAt ?? 0) : 0;
    if (rightSafe !== leftSafe) return rightSafe - leftSafe;
    return String(left.id ?? "").localeCompare(String(right.id ?? ""));
  });
}
describe("page-scoped-context safe sort", () => {
  it("handles NaN", () => {
    const items = [{ id: "b", createdAt: NaN }, { id: "a", createdAt: NaN }, { id: "c", createdAt: 10 }];
    const s = sortByCreatedAt(items);
    expect(s[0].id).toBe("c");
    expect(s[1].id).toBe("a");
  });
  it("tiebreak", () => {
    const items = [{ id: "z", createdAt: 1 }, { id: "a", createdAt: 1 }];
    expect(sortByCreatedAt(items)[0].id).toBe("a");
  });
  it("asc vs desc", () => {
    const items = [{ id: "a", createdAt: 1 }, { id: "b", createdAt: 2 }];
    expect(sortByCreatedAt(items)[0].id).toBe("b");
  });
});
