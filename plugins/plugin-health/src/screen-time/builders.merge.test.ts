/**
 * Unit test for `mergeScreenTimeAggregateRows` — asserts per-target rows merge
 * and accumulate correctly. Pure, deterministic.
 */
import { describe, expect, it } from "vitest";
import {
  mergeScreenTimeAggregateRows,
  type ScreenTimeAggregateRow,
} from "./builders.js";

// #8795 — screen-time aggregation is the untested core of the weekly recap /
// trend surface. mergeScreenTimeAggregateRows folds raw per-source rows into one
// row per (source, identifier) and ranks them; lock that fold + the ordering.

const row = (
  over: Partial<ScreenTimeAggregateRow>,
): ScreenTimeAggregateRow => ({
  source: "app",
  identifier: "com.example",
  displayName: "Example",
  totalSeconds: 0,
  sessionCount: 0,
  metadata: {},
  ...over,
});

describe("mergeScreenTimeAggregateRows", () => {
  it("sums seconds + sessions across rows sharing source::identifier", () => {
    const out = mergeScreenTimeAggregateRows([
      row({
        identifier: "a",
        displayName: "A",
        totalSeconds: 100,
        sessionCount: 2,
      }),
      row({
        identifier: "a",
        displayName: "A",
        totalSeconds: 50,
        sessionCount: 1,
      }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ totalSeconds: 150, sessionCount: 3 });
  });

  it("keys on BOTH source and identifier (same id, different source stays split)", () => {
    const out = mergeScreenTimeAggregateRows([
      row({
        source: "app",
        identifier: "x",
        displayName: "Xapp",
        totalSeconds: 10,
      }),
      row({
        source: "website",
        identifier: "x",
        displayName: "Xweb",
        totalSeconds: 20,
      }),
    ]);
    expect(out).toHaveLength(2);
  });

  it("ranks by totalSeconds desc, breaking ties by displayName", () => {
    const out = mergeScreenTimeAggregateRows([
      row({ identifier: "low", displayName: "Low", totalSeconds: 5 }),
      row({ identifier: "tieB", displayName: "Banana", totalSeconds: 30 }),
      row({ identifier: "tieA", displayName: "Apple", totalSeconds: 30 }),
    ]);
    expect(out.map((r) => r.displayName)).toEqual(["Apple", "Banana", "Low"]);
  });

  it("merges metadata (later row wins) and backfills a missing displayName", () => {
    const out = mergeScreenTimeAggregateRows([
      row({
        identifier: "m",
        displayName: "",
        totalSeconds: 1,
        metadata: { a: 1, b: 1 },
      }),
      row({
        identifier: "m",
        displayName: "Named",
        totalSeconds: 1,
        metadata: { b: 2, c: 3 },
      }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].displayName).toBe("Named"); // backfilled from the second row
    expect(out[0].metadata).toEqual({ a: 1, b: 2, c: 3 }); // later row wins on `b`
  });

  it("does not mutate inputs into a shared metadata reference", () => {
    const a = row({ identifier: "s", metadata: undefined });
    const [merged] = mergeScreenTimeAggregateRows([a]);
    expect(merged.metadata).toEqual({}); // undefined defaulted to a fresh object
  });
});
