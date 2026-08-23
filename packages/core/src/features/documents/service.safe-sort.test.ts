/**
 * Regression coverage for the RAG-enrichment recency ordering in
 * `DocumentService` (`service.ts:2313`).
 *
 * The recent-conversation window is sorted newest-first to find the latest
 * message newer than a pending enrichment timestamp. A non-finite `createdAt`
 * previously returned `NaN` and left the window in insertion order, causing the
 * enrichment to attach to the wrong turn or to none.
 */
import { describe, expect, it } from "vitest";
import { __testCompareMemoryByCreatedAtDesc as cmp } from "./service.ts";

function mem(id: string, createdAt: number | undefined) {
  return { id, createdAt } as { id: string; createdAt?: number };
}

describe("documents service recency ordering", () => {
  it("sorts newest-first", () => {
    const rows = [mem("a", 10), mem("c", 30), mem("b", 20)];
    expect([...rows].sort(cmp).map((m) => m.id)).toEqual(["c", "b", "a"]);
  });
  it("treats NaN/Infinity/undefined as 0 oldest", () => {
    const rows = [mem("b", Number.NaN), mem("c", 30), mem("a", 10), mem("d", Number.POSITIVE_INFINITY)];
    expect([...rows].sort(cmp).map((m) => m.id)).toEqual(["c", "a", "d", "b"]);
    // Non-finite group sorted by id descending (newest-first tie break uses b.id vs a.id)
    // So among NaN group, d > b, thus d before b
  });
  it("breaks equal timestamps by descending id", () => {
    expect([...[mem("a", 10), mem("b", 10)].sort(cmp).map((m) => m.id)]).toEqual(["b", "a"]);
  });
});
