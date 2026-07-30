/**
 * Pins compatible local-time disambiguation in the LifeOps primitive and the
 * owner-relative day-boundary path that consumes it.
 */
import { describe, expect, it } from "vitest";
import { resolveLifeOpsRelativeTime } from "./relative-time.js";
import { buildUtcDateFromLocalParts, getZonedDateParts } from "./time.js";

const schedule: Parameters<typeof resolveLifeOpsRelativeTime>[0]["schedule"] = {
  circadianState: "unclear",
  stateConfidence: 0.5,
  uncertaintyReason: "no_signals",
  awakeProbability: {
    pAwake: 0,
    pAsleep: 0,
    pUnknown: 1,
    contributingSources: [],
    computedAt: "2026-01-01T00:00:00.000Z",
  },
  regularity: {
    sri: 0,
    bedtimeStddevMin: 0,
    wakeStddevMin: 0,
    midSleepStddevMin: 0,
    regularityClass: "insufficient_data",
    sampleCount: 0,
    windowDays: 28,
  },
  baseline: null,
  sleepConfidence: 0.5,
  currentSleepStartedAt: null,
  lastSleepStartedAt: null,
  lastSleepEndedAt: null,
  wakeAt: null,
  firstActiveAt: null,
};

describe("buildUtcDateFromLocalParts compatible disambiguation", () => {
  it("moves Santiago's skipped midnight forward by the one-hour gap", () => {
    const instant = buildUtcDateFromLocalParts("America/Santiago", {
      year: 2026,
      month: 9,
      day: 6,
      hour: 0,
      minute: 0,
      second: 0,
    });

    expect(instant.toISOString()).toBe("2026-09-06T04:00:00.000Z");
    expect(getZonedDateParts(instant, "America/Santiago")).toEqual({
      year: 2026,
      month: 9,
      day: 6,
      hour: 1,
      minute: 0,
      second: 0,
    });
  });

  it("moves Apia's skipped date forward by the 24-hour gap", () => {
    const instant = buildUtcDateFromLocalParts("Pacific/Apia", {
      year: 2011,
      month: 12,
      day: 30,
      hour: 0,
      minute: 0,
      second: 0,
    });

    expect(instant.toISOString()).toBe("2011-12-30T10:00:00.000Z");
    expect(getZonedDateParts(instant, "Pacific/Apia")).toEqual({
      year: 2011,
      month: 12,
      day: 31,
      hour: 0,
      minute: 0,
      second: 0,
    });
  });

  it("chooses the earlier repeat and shifts a skipped clock time forward", () => {
    const repeated = buildUtcDateFromLocalParts("America/New_York", {
      year: 2026,
      month: 11,
      day: 1,
      hour: 1,
      minute: 30,
      second: 0,
    });
    const skipped = buildUtcDateFromLocalParts("America/New_York", {
      year: 2026,
      month: 3,
      day: 8,
      hour: 2,
      minute: 30,
      second: 0,
    });

    expect(repeated.toISOString()).toBe("2026-11-01T05:30:00.000Z");
    expect(skipped.toISOString()).toBe("2026-03-08T07:30:00.000Z");
  });
});

describe("resolveLifeOpsRelativeTime local-day boundaries", () => {
  it("starts Santiago's transition day at the first valid local time", () => {
    const relativeTime = resolveLifeOpsRelativeTime({
      nowMs: Date.parse("2026-09-06T16:00:00.000Z"),
      timezone: "America/Santiago",
      schedule,
    });

    expect(relativeTime.dayBoundaryStartAt).toBe("2026-09-06T04:00:00.000Z");
    expect(relativeTime.dayBoundaryEndAt).toBe("2026-09-07T03:00:00.000Z");
  });

  it("ends Apia's December 29 day at the first instant after its skipped date", () => {
    const relativeTime = resolveLifeOpsRelativeTime({
      nowMs: Date.parse("2011-12-29T22:00:00.000Z"),
      timezone: "Pacific/Apia",
      schedule,
    });

    expect(relativeTime.dayBoundaryStartAt).toBe("2011-12-29T10:00:00.000Z");
    expect(relativeTime.dayBoundaryEndAt).toBe("2011-12-30T10:00:00.000Z");
  });
});
