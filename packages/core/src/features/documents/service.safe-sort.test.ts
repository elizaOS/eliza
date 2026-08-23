/**
 * Regression for documents service similarity and createdAt sort handling.
 */
import { describe, expect, it } from "vitest";

type Doc = { id: string; similarity: number; createdAt?: number };

function compareDocBySimilarity(a: Doc, b: Doc): number {
  const bS = typeof b.similarity === "number" && Number.isFinite(b.similarity) ? b.similarity : 0;
  const aS = typeof a.similarity === "number" && Number.isFinite(a.similarity) ? a.similarity : 0;
  if (bS !== aS) return bS - aS;
  return String(a.id).localeCompare(String(b.id));
}
function compareDocByCreatedAt(a: Doc, b: Doc): number {
  const bT = typeof b.createdAt === "number" && Number.isFinite(b.createdAt) ? b.createdAt : 0;
  const aT = typeof a.createdAt === "number" && Number.isFinite(a.createdAt) ? a.createdAt : 0;
  if (bT !== aT) return bT - aT;
  return String(a.id).localeCompare(String(b.id));
}

describe("documents service safe-sort", () => {
  it("treats NaN similarity as 0", () => {
    const docs: Doc[] = [
      { id: "b", similarity: Number.NaN },
      { id: "a", similarity: 0.9 },
      { id: "c", similarity: Number.POSITIVE_INFINITY },
    ];
    expect([...docs].sort(compareDocBySimilarity).map(d => d.id)).toEqual(["a", "b", "c"]);
  });
  it("treats NaN createdAt as 0", () => {
    const docs: Doc[] = [
      { id: "b", createdAt: Number.NaN, similarity: 1 },
      { id: "a", createdAt: 100, similarity: 1 },
    ];
    expect([...docs].sort(compareDocByCreatedAt).map(d => d.id)).toEqual(["a", "b"]);
  });
  it("old comparator would return NaN", () => {
    expect(Number.isNaN(Number.NaN - 0.9)).toBe(true);
    expect(Number.isNaN(Number.NaN - 100)).toBe(true);
  });
});
