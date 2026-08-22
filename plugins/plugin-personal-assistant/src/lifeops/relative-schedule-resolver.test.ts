/**
 * Unit coverage for the relative-schedule resolver's baseline-projection
 * branch. Pins the invariant the workflow scheduler loop depends on: the
 * resolved instant is strictly AFTER the cursor, including for negative-offset
 * schedules (during_night / "before bedtime") whose fire instant precedes the
 * projected anchor. Also pins the anchor-day weekday gate for the direct-anchor
 * branch (regression for #24739): `onDays` filters on the anchor's local day,
 * not the offsetted fire instant, so a negative offset that crosses local
 * midnight cannot fire on an unrequested weekday or drop a requested one.
 * Deterministic vitest, no runtime.
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

type Schedule = Parameters<
  typeof resolveNextRelativeScheduleInstant
>[0]["schedule"];

/**
 * Direct-anchor branch with live sleep-cycle anchors and no baseline fallback:
 * `baseline: null` forces the resolver through the direct-anchor path only, so
 * a null result means the weekday gate rejected the occurrence rather than the
 * projection branch producing a different day.
 */
function anchorState(overrides: {
  bedtimeTargetAt?: string | null;
  wakeAt?: string | null;
}): LifeOpsScheduleMergedStateRecord {
  return {
    timezone: "America/New_York",
    circadianState: "awake",
    regularity: { regularityClass: "very_regular" },
    baseline: null,
    relativeTime: { bedtimeTargetAt: overrides.bedtimeTargetAt ?? null },
    wakeAt: overrides.wakeAt ?? null,
  } as unknown as LifeOpsScheduleMergedStateRecord;
}

describe("resolveNextRelativeScheduleInstant — direct-anchor weekday gate (#24739)", () => {
  // bedtimeTargetAt 2026-01-06T06:00Z = Tue 01:00 EST (anchor local weekday =
  // Tuesday / 2). offset -120m => fire instant 2026-01-06T04:00Z = Mon 23:00
  // EST (offset weekday = Monday / 1). The gate must match on the ANCHOR day.
  const bedtimeState = anchorState({
    bedtimeTargetAt: "2026-01-06T06:00:00.000Z",
  });
  const nowBeforeFire = Date.parse("2026-01-06T01:00:00.000Z"); // Mon 20:00 EST

  it("relative_to_bedtime negative offset gates on the anchor's local day, not the fire instant", () => {
    const onAnchorDay = resolveNextRelativeScheduleInstant({
      schedule: {
        kind: "relative_to_bedtime",
        timezone: "America/New_York",
        offsetMinutes: -120,
        onDays: [2], // Tuesday — the anchor's local day
      } as Schedule,
      state: bedtimeState,
      cursorIso: null,
      nowMs: nowBeforeFire,
    });
    expect(onAnchorDay).toBe("2026-01-06T04:00:00.000Z");

    const onFireInstantDay = resolveNextRelativeScheduleInstant({
      schedule: {
        kind: "relative_to_bedtime",
        timezone: "America/New_York",
        offsetMinutes: -120,
        onDays: [1], // Monday — the offset fire-instant's local day
      } as Schedule,
      state: bedtimeState,
      cursorIso: null,
      nowMs: nowBeforeFire,
    });
    expect(onFireInstantDay).toBeNull();
  });

  it("during_night window crossing midnight gates on the bedtime anchor's local day", () => {
    // window 120m before Tue 01:00 EST bedtime target => fire Mon 23:00 EST.
    const onAnchorDay = resolveNextRelativeScheduleInstant({
      schedule: {
        kind: "during_night",
        timezone: "America/New_York",
        windowMinutesBeforeSleepTarget: 120,
        onDays: [2], // Tuesday anchor
      } as Schedule,
      state: bedtimeState,
      cursorIso: null,
      nowMs: nowBeforeFire,
    });
    expect(onAnchorDay).toBe("2026-01-06T04:00:00.000Z");

    const onFireInstantDay = resolveNextRelativeScheduleInstant({
      schedule: {
        kind: "during_night",
        timezone: "America/New_York",
        windowMinutesBeforeSleepTarget: 120,
        onDays: [1], // Monday fire instant
      } as Schedule,
      state: bedtimeState,
      cursorIso: null,
      nowMs: nowBeforeFire,
    });
    expect(onFireInstantDay).toBeNull();
  });

  it("relative_to_wake large positive offset gates on the wake anchor's local day when the fire crosses into the next day", () => {
    // wakeAt 2026-01-06T15:00Z = Tue 10:00 EST (anchor Tuesday / 2). offset
    // +900m (15h) => fire 2026-01-07T06:00Z = Wed 01:00 EST (Wednesday / 3).
    const wakeState = anchorState({ wakeAt: "2026-01-06T15:00:00.000Z" });
    const now = Date.parse("2026-01-06T16:00:00.000Z"); // Tue 11:00 EST
    const onAnchorDay = resolveNextRelativeScheduleInstant({
      schedule: {
        kind: "relative_to_wake",
        timezone: "America/New_York",
        offsetMinutes: 900,
        onDays: [2], // Tuesday wake anchor
      } as Schedule,
      state: wakeState,
      cursorIso: null,
      nowMs: now,
    });
    expect(onAnchorDay).toBe("2026-01-07T06:00:00.000Z");

    const onFireInstantDay = resolveNextRelativeScheduleInstant({
      schedule: {
        kind: "relative_to_wake",
        timezone: "America/New_York",
        offsetMinutes: 900,
        onDays: [3], // Wednesday fire instant
      } as Schedule,
      state: wakeState,
      cursorIso: null,
      nowMs: now,
    });
    expect(onFireInstantDay).toBeNull();
  });

  it("does not regress the common same-day case where anchor and fire share a weekday", () => {
    // wakeAt 2026-01-06T13:00Z = Tue 08:00 EST, offset +240m => Tue 12:00 EST;
    // anchor and fire are both Tuesday, so onDays=[2] fires and onDays=[3] not.
    const wakeState = anchorState({ wakeAt: "2026-01-06T13:00:00.000Z" });
    const now = Date.parse("2026-01-06T14:00:00.000Z"); // Tue 09:00 EST
    const sameDay = resolveNextRelativeScheduleInstant({
      schedule: {
        kind: "relative_to_wake",
        timezone: "America/New_York",
        offsetMinutes: 240,
        onDays: [2],
      } as Schedule,
      state: wakeState,
      cursorIso: null,
      nowMs: now,
    });
    expect(sameDay).toBe("2026-01-06T17:00:00.000Z");

    const otherDay = resolveNextRelativeScheduleInstant({
      schedule: {
        kind: "relative_to_wake",
        timezone: "America/New_York",
        offsetMinutes: 240,
        onDays: [3],
      } as Schedule,
      state: wakeState,
      cursorIso: null,
      nowMs: now,
    });
    expect(otherDay).toBeNull();
  });
});
