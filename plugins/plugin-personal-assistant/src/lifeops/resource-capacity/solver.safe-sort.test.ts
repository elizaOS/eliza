/**
 * Regression coverage for newest-first observedAt ordering in the
 * household-capacity solver (solver.ts:765).
 *
 * The solver filters transitions for a specific resource hop and sorts
 * newest-first to pick the most recent evidence. A non-finite observedAt
 * previously returned NaN and left the transition list out of order.
 */
import { describe, expect, it } from "vitest";
import { __testCompareTransitionByObservedAtDesc as cmp } from "./solver.ts";

function item(observedAt: string, sourceRef: string) {
  return { observedAt, sourceRef } as { observedAt: string; sourceRef: string };
}

describe("solver observedAt ordering", () => {
  it("sorts newest-first", () => {
    const a = item("2026-01-01T00:00:00.000Z", "a");
    const b = item("2026-01-02T00:00:00.000Z", "a");
    const c = item("2026-01-03T00:00:00.000Z", "a");
    expect([a, c, b].sort(cmp).map((i) => i.observedAt)).toEqual([c.observedAt, b.observedAt, a.observedAt]);
  });
  it("treats unparseable as 0 oldest", () => {
    const good = item("2026-01-02T00:00:00.000Z", "a");
    const bad = item("not-a-date", "b");
    expect([bad, good].sort(cmp)[0]).toBe(good);
  });
  it("breaks ties by sourceRef", () => {
    const a = item("2026-01-01T00:00:00.000Z", "a");
    const b = item("2026-01-01T00:00:00.000Z", "b");
    expect([b, a].sort(cmp).map((i) => i.sourceRef)).toEqual(["a", "b"]);
  });
});
