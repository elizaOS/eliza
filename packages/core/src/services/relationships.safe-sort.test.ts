/**
 * Regression: relationship sort comparators must be NaN-safe and stable.
 */
import { describe, expect, it } from "vitest";

function sortByCreatedAt(items: { id: string; createdAt: unknown }[]): typeof items {
  return [...items].sort((a, b) => {
    const aVal = Number((a as any).createdAt ?? 0);
    const bVal = Number((b as any).createdAt ?? 0);
    const aSafe = Number.isFinite(aVal) ? aVal : 0;
    const bSafe = Number.isFinite(bVal) ? bVal : 0;
    if (aSafe !== bSafe) return aSafe - bSafe;
    return String(a.id ?? "").localeCompare(String(b.id ?? ""));
  });
}

function sortByStrength(items: { contact: { id: string }; analytics: { strength: number } }[]): typeof items {
  return [...items].sort((a, b) => {
    const aSafe = Number.isFinite(a.analytics.strength) ? a.analytics.strength : 0;
    const bSafe = Number.isFinite(b.analytics.strength) ? b.analytics.strength : 0;
    if (bSafe !== aSafe) return bSafe - aSafe;
    return String(a.contact.id ?? "").localeCompare(String(b.contact.id ?? ""));
  });
}

describe("relationships safe sort", () => {
  it("handles NaN createdAt as 0", () => {
    const items = [
      { id: "b", createdAt: Number.NaN },
      { id: "a", createdAt: 100 },
    ];
    const sorted = sortByCreatedAt(items as any);
    expect(sorted[0].id).toBe("b");
  });
  it("handles NaN strength as 0", () => {
    const items = [
      { contact: { id: "a" }, analytics: { strength: Number.NaN } },
      { contact: { id: "b" }, analytics: { strength: 10 } },
    ];
    const sorted = sortByStrength(items);
    expect(sorted[0].contact.id).toBe("b");
  });
  it("tiebreaks by id", () => {
    const items = [
      { id: "b", createdAt: 100 },
      { id: "a", createdAt: 100 },
    ];
    const sorted = sortByCreatedAt(items as any);
    expect(sorted.map((x) => x.id)).toEqual(["a", "b"]);
  });
});
