import { describe, expect, it } from "vitest";
import { resolveLifeOpsRelativeTime } from "../src/lifeops/relative-time.js";

// Covers the bedtime-target roll-over bug: at 12:56 AM the target must stay
// anchored on the sleep-day that began with yesterday's wake, not roll
// forward to tonight's bedtime.

const BASE_SCHEDULE = {
  circadianState: "awake" as const,
  stateConfidence: 0.8,
  uncertaintyReason: null,
  awakeProbability: {
    pAwake: 0.8,
    pAsleep: 0.1,
    pUnknown: 0.1,
    contributingSources: [],
    computedAt: "2026-04-18T20:00:00.000Z",
  },
  regularity: {
    sri: 82,
    bedtimeStddevMin: 32,
    wakeStddevMin: 28,
    midSleepStddevMin: 24,
    regularityClass: "regular" as const,
    sampleCount: 12,
    windowDays: 28,
  },
  baseline: {
    // 23.5 = 11:30 PM
    medianWakeLocalHour: 7.5,
    medianBedtimeLocalHour: 23.5,
    medianSleepDurationMin: 480,
    bedtimeStddevMin: 32,
    wakeStddevMin: 28,
    sampleCount: 12,
    windowDays: 28,
  },
  sleepConfidence: 0.7,
  currentSleepStartedAt: null,
  lastSleepStartedAt: "2026-04-17T23:30:00.000Z",
  lastSleepEndedAt: null,
  wakeAt: "2026-04-18T07:30:00.000Z",
  firstActiveAt: "2026-04-18T07:35:00.000Z",
};

describe("resolveLifeOpsRelativeTime bedtime target stays on sleep-day", () => {
  it("reports bedtime in ~90m when evening is before tonight's bedtime", () => {
    const nowMs = Date.parse("2026-04-18T22:00:00.000Z");
    const relativeTime = resolveLifeOpsRelativeTime({
      nowMs,
      timezone: "UTC",
      schedule: BASE_SCHEDULE,
    });

    expect(relativeTime.bedtimeTargetAt).toBe("2026-04-18T23:30:00.000Z");
    expect(relativeTime.minutesUntilBedtimeTarget).toBe(90);
    expect(relativeTime.minutesSinceBedtimeTarget).toBeNull();
  });

  it("reports bedtime was ~86m ago at 12:56 AM after the sleep-day bedtime passed", () => {
    const nowMs = Date.parse("2026-04-19T00:56:00.000Z");
    const relativeTime = resolveLifeOpsRelativeTime({
      nowMs,
      timezone: "UTC",
      schedule: BASE_SCHEDULE,
    });

    expect(relativeTime.bedtimeTargetAt).toBe("2026-04-18T23:30:00.000Z");
    expect(relativeTime.minutesUntilBedtimeTarget).toBeNull();
    expect(relativeTime.minutesSinceBedtimeTarget).toBe(86);
  });

  it("reports bedtime in ~990m at 7 AM after waking, anchored on today", () => {
    const nowMs = Date.parse("2026-04-18T07:00:00.000Z");
    const relativeTime = resolveLifeOpsRelativeTime({
      nowMs,
      timezone: "UTC",
      schedule: {
        ...BASE_SCHEDULE,
        // Wake just happened this morning.
        wakeAt: "2026-04-18T07:00:00.000Z",
        firstActiveAt: "2026-04-18T07:00:00.000Z",
      },
    });

    expect(relativeTime.bedtimeTargetAt).toBe("2026-04-18T23:30:00.000Z");
    expect(relativeTime.minutesUntilBedtimeTarget).toBe(990);
    expect(relativeTime.minutesSinceBedtimeTarget).toBeNull();
  });

  it("rolls the target forward when the wake anchor is several days stale", () => {
    const nowMs = Date.parse("2026-04-21T10:00:00.000Z");
    const relativeTime = resolveLifeOpsRelativeTime({
      nowMs,
      timezone: "UTC",
      schedule: {
        ...BASE_SCHEDULE,
        // Last known wake was 3 days before "now" — the naive implementation
        // would anchor the target 3 days in the past.
        wakeAt: "2026-04-18T07:30:00.000Z",
        firstActiveAt: "2026-04-18T07:35:00.000Z",
      },
    });

    const targetMs = Date.parse(relativeTime.bedtimeTargetAt ?? "");
    expect(Number.isFinite(targetMs)).toBe(true);
    // The target should now sit within a reasonable window around "now",
    // not days in the past.
    expect(targetMs - nowMs).toBeLessThanOrEqual(24 * 60 * 60 * 1000);
    expect(nowMs - targetMs).toBeLessThanOrEqual(18 * 60 * 60 * 1000);
  });

  it("keeps currentSleepStartedAt as the bedtime anchor while sleeping", () => {
    const nowMs = Date.parse("2026-04-19T02:30:00.000Z");
    const relativeTime = resolveLifeOpsRelativeTime({
      nowMs,
      timezone: "UTC",
      schedule: {
        ...BASE_SCHEDULE,
        circadianState: "sleeping",
        stateConfidence: 0.9,
        currentSleepStartedAt: "2026-04-19T00:30:00.000Z",
        wakeAt: null,
        firstActiveAt: null,
      },
    });

    expect(relativeTime.bedtimeTargetAt).toBe("2026-04-19T00:30:00.000Z");
    expect(relativeTime.minutesUntilBedtimeTarget).toBeNull();
    expect(relativeTime.minutesSinceBedtimeTarget).toBe(120);
  });

  it("returns no projected bedtime for irregular schedules", () => {
    const nowMs = Date.parse("2026-04-19T18:00:00.000Z");
    const relativeTime = resolveLifeOpsRelativeTime({
      nowMs,
      timezone: "UTC",
      schedule: {
        ...BASE_SCHEDULE,
        regularity: {
          ...BASE_SCHEDULE.regularity,
          regularityClass: "irregular",
        },
      },
    });

    expect(relativeTime.bedtimeTargetAt).toBeNull();
    expect(relativeTime.minutesUntilBedtimeTarget).toBeNull();
  });
});
