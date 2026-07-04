// Exercises LifeOps owner workflows, connector boundaries, and scheduled-task behavior.
import { describe, expect, it } from "vitest";
import type { LifeOpsOccurrence } from "../src/contracts/index.js";
import {
  buildPerformanceWindow,
  computeOccurrenceStreaks,
  occurrenceAnchorIso,
  occurrenceAnchorMs,
} from "../src/lifeops/service-helpers-occurrence.js";

/**
 * Occurrence anchoring + streak/performance math back the LifeOps habit tracker
 * (#8795). The anchor falls back dueAt → scheduledAt → relevanceStartAt, streaks
 * count consecutive completions, and a "perfect day" requires every occurrence
 * that day completed — off-by-one or fallthrough bugs corrupt the user's stats.
 */

const occ = (o: Partial<LifeOpsOccurrence>): LifeOpsOccurrence =>
  o as LifeOpsOccurrence;

describe("occurrenceAnchorIso / occurrenceAnchorMs", () => {
  it("falls back dueAt → scheduledAt → relevanceStartAt", () => {
    expect(occurrenceAnchorIso(occ({ dueAt: "a", scheduledAt: "b" }))).toBe(
      "a",
    );
    expect(occurrenceAnchorIso(occ({ scheduledAt: "b" }))).toBe("b");
    expect(occurrenceAnchorIso(occ({ relevanceStartAt: "c" }))).toBe("c");
    expect(occurrenceAnchorIso(occ({}))).toBeFalsy();
  });

  it("anchorMs parses the iso, else MAX_SAFE_INTEGER", () => {
    expect(occurrenceAnchorMs(occ({ dueAt: "2026-06-23T00:00:00Z" }))).toBe(
      Date.parse("2026-06-23T00:00:00Z"),
    );
    expect(occurrenceAnchorMs(occ({}))).toBe(Number.MAX_SAFE_INTEGER);
    expect(occurrenceAnchorMs(occ({ dueAt: "not-a-date" }))).toBe(
      Number.MAX_SAFE_INTEGER,
    );
  });
});

describe("computeOccurrenceStreaks", () => {
  const s = (...states: string[]) =>
    computeOccurrenceStreaks(states.map((state) => ({ state }) as never));

  it("tracks best run and the trailing current run", () => {
    expect(s("completed", "completed", "skipped", "completed")).toEqual({
      best: 2,
      current: 1,
    });
    expect(s("completed", "completed", "completed")).toEqual({
      best: 3,
      current: 3,
    });
    expect(s("skipped", "completed", "completed")).toEqual({
      best: 2,
      current: 2,
    });
    expect(s("skipped")).toEqual({ best: 0, current: 0 });
    expect(s()).toEqual({ best: 0, current: 0 });
  });
});

describe("buildPerformanceWindow", () => {
  it("counts states, completion rate, and perfect days in window", () => {
    const occurrences = [
      occ({ dueAt: "2026-06-23T08:00:00Z", state: "completed" }),
      occ({ dueAt: "2026-06-23T20:00:00Z", state: "completed" }), // same day, both done
      occ({ dueAt: "2026-06-24T08:00:00Z", state: "skipped" }), // other day, not perfect
    ];
    const win = buildPerformanceWindow(
      occurrences,
      "UTC",
      Date.parse("2026-06-20T00:00:00Z"),
      Date.parse("2026-06-25T00:00:00Z"),
    );
    expect(win.scheduledCount).toBe(3);
    expect(win.completedCount).toBe(2);
    expect(win.skippedCount).toBe(1);
    expect(win.pendingCount).toBe(0);
    expect(win.completionRate).toBeCloseTo(2 / 3);
    expect(win.perfectDayCount).toBe(1); // only 2026-06-23
  });

  it("excludes occurrences outside the window", () => {
    const win = buildPerformanceWindow(
      [occ({ dueAt: "2026-01-01T00:00:00Z", state: "completed" })],
      "UTC",
      Date.parse("2026-06-20T00:00:00Z"),
      Date.parse("2026-06-25T00:00:00Z"),
    );
    expect(win.scheduledCount).toBe(0);
    expect(win.completionRate).toBe(0);
  });
});
