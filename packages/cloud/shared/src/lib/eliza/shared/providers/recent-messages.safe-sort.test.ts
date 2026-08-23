/**
 * Regression coverage for chronological recent-messages ordering in the
 * cloud shared provider (recent-messages.ts:202).
 *
 * The provider formats conversation logs oldest-first for the model. A
 * non-finite createdAt previously returned NaN and left the log out of order.
 */
import { describe, expect, it } from "vitest";
import { __testCompareMemoryByCreatedAtAsc as cmp } from "./recent-messages.ts";

function mem(id: string, createdAt: number | undefined) {
  return { id, createdAt } as { id: string; createdAt?: number };
}

describe("cloud recent-messages ordering", () => {
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
