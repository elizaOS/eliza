/**
 * Unit coverage for the relative-schedule resolver's baseline-projection
 * branch. Pins the invariant the workflow scheduler loop depends on: the
 * resolved instant is strictly AFTER the cursor, including for negative-offset
 * schedules (during_night / "before bedtime") whose fire instant precedes the
 * projected anchor. Deterministic vitest, no runtime.
 */
import { describe, expect, it } from "vitest";
import { resolveNextRelativeScheduleInstant } from "./relative-schedule-resolver.js";
import type { LifeOpsScheduleMergedStateRecord } from "./repository.js";

/**
 * Minimal merged-state fixture: very_regular owner in UTC with a median
 * bedtime of 23:00 and wake of 08:00, and no live sleep-cycle anchors — the
 * resolver must project from the baseline.
 */
const mergedState = {
  timezone: "UTC",
  circadianState: "awake",
  regularity: { regularityClass: "very_regular" },
  baseline: { medianWakeLocalHour: 8, medianBedtimeLocalHour: 23 },
  relativeTime: { bedtimeTargetAt: null },
  wakeAt: null,
} as unknown as LifeOpsScheduleMergedStateRecord;

const duringNight = {
  kind: "during_night",
  timezone: "UTC",
  windowMinutesBeforeSleepTarget: 120,
} as Parameters<typeof resolveNextRelativeScheduleInstant>[0]["schedule"];

describe("resolveNextRelativeScheduleInstant — negative-offset projection", () => {
  // Bedtime target 23:00 − 120m = 21:00; at now=22:30 today's fire instant
  // has already passed, so the next occurrence is tomorrow 21:00 — never a
  // past instant that would be "due" immediately.
  it("never resolves a during_night instant at or before now", () => {
    const nowMs = Date.parse("2026-07-01T22:30:00.000Z");
    const resolved = resolveNextRelativeScheduleInstant({
      schedule: duringNight,
      state: mergedState,
      cursorIso: null,
      nowMs,
    });
    expect(resolved).toBe("2026-07-02T21:00:00.000Z");
  });

  // The scheduler's run-due loop recomputes with cursorIso = the dueAt it just
  // executed. If the resolver returns the same instant, the loop executes the
  // workflow `limit` times per tick and never advances — the resolved instant
  // must be strictly after the cursor.
  it("advances past the cursor when re-resolved from the previous dueAt", () => {
    const nowMs = Date.parse("2026-07-01T22:30:00.000Z");
    const first = resolveNextRelativeScheduleInstant({
      schedule: duringNight,
      state: mergedState,
      cursorIso: null,
      nowMs,
    });
    expect(first).not.toBeNull();
    const second = resolveNextRelativeScheduleInstant({
      schedule: duringNight,
      state: mergedState,
      cursorIso: first,
      nowMs,
    });
    expect(second).not.toBeNull();
    expect(Date.parse(second as string)).toBeGreaterThan(
      Date.parse(first as string),
    );
  });

  // Positive-offset sanity: relative_to_wake +240m at now=10:00 with wake
  // baseline 08:00 fires TODAY at 12:00 — the anchor already passed but the
  // fire instant has not, so it must not be pushed to tomorrow.
  it("keeps a still-future positive-offset fire on today's anchor", () => {
    const nowMs = Date.parse("2026-07-01T10:00:00.000Z");
    const resolved = resolveNextRelativeScheduleInstant({
      schedule: {
        kind: "relative_to_wake",
        timezone: "UTC",
        offsetMinutes: 240,
      } as Parameters<typeof resolveNextRelativeScheduleInstant>[0]["schedule"],
      state: mergedState,
      cursorIso: null,
      nowMs,
    });
    expect(resolved).toBe("2026-07-01T12:00:00.000Z");
  });
});
