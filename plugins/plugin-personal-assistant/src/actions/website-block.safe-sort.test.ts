/**
 * Regression coverage for chronological conversation-turn ordering in
 * website-block.ts.
 *
 * The block planner consumes the last N turns oldest-first to derive hosts and
 * durations. A non-finite createdAt previously returned NaN and left the slice
 * in insertion order, causing the LLM planner to see out-of-order context.
 */
import { describe, expect, it } from "vitest";
import { __testCompareConversationTurnByCreatedAtAsc as cmp } from "./website-block.ts";

function mem(id: string, createdAt: number | undefined) {
  return { id, createdAt } as { id: string; createdAt?: number };
}

describe("website-block conversation turn ordering", () => {
  it("sorts oldest-first", () => {
    expect([
      ...[mem("c", 30), mem("a", 10), mem("b", 20)].sort(cmp).map((m) => m.id),
    ]).toEqual(["a", "b", "c"]);
  });
  it("treats NaN as 0 oldest", () => {
    expect([
      ...[mem("c", 30), mem("b", Number.NaN), mem("a", 10)]
        .sort(cmp)
        .map((m) => m.id),
    ]).toEqual(["b", "a", "c"]);
  });
  it("breaks ties by id", () => {
    expect([
      ...[mem("b", 10), mem("a", 10)].sort(cmp).map((m) => m.id),
    ]).toEqual(["a", "b"]);
  });
});
