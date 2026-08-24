/**
 * Regression coverage for chronological action-state ordering (action-state.ts:75).
 *
 * The provider orders per-run action results oldest-first for the planning prompt.
 * A non-finite createdAt previously returned NaN and left the run's steps out of order.
 */
import { describe, expect, it } from "vitest";
import { __testCompareMemoryByCreatedAtAsc as cmp } from "./action-state.ts";

function mem(id: string, createdAt: number | undefined) {
  return { id, createdAt } as { id: string; createdAt?: number };
}

describe("cloud action-state ordering", () => {
  it("sorts oldest-first", () => {
    expect([...[mem("c", 30), mem("a", 10), mem("b", 20)].sort(cmp).map((m) => m.id)]).toEqual(["a", "b", "c"]);
  });
  it("treats NaN as 0 oldest", () => {
    expect([...[mem("c", 30), mem("b", Number.NaN), mem("a", 10)].sort(cmp).map((m) => m.id)]).toEqual(["b", "a", "c"]);
  });
  it("breaks ties by id", () => {
    expect([...[mem("b", 10), mem("a", 10)].sort(cmp).map((m) => m.id)]).toEqual(["a", "b"]);
  });
});
