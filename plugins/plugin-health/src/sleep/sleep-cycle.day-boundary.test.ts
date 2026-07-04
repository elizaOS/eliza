/**
 * Regression test: `resolveLifeOpsDayBoundary` must span the full LOCAL
 * calendar day across DST transitions. Advancing local midnight by 24 elapsed
 * hours lands on 23:00 of the SAME local day on a fall-back day (25 local
 * hours), collapsing the boundary to endOfDay === startOfDay. Pure and
 * timezone-parameterized — no dependence on the machine TZ.
 */
import { describe, expect, it } from "vitest";
import { resolveLifeOpsDayBoundary } from "./sleep-cycle.js";

const NO_SLEEP_CYCLE = {
  cycleType: "unknown" as const,
  sleepConfidence: 0.5,
  currentSleepStartedAt: null,
  lastSleepStartedAt: null,
  lastSleepEndedAt: null,
};

describe("resolveLifeOpsDayBoundary DST handling", () => {
  it("spans the full 25h local day on the US DST fall-back day", () => {
    const boundary = resolveLifeOpsDayBoundary({
      nowMs: Date.parse("2026-11-01T12:00:00-05:00"), // noon EST, fall-back day
      timezone: "America/New_York",
      sleepCycle: NO_SLEEP_CYCLE,
    });

    expect(boundary.startOfDayAt).toBe("2026-11-01T04:00:00.000Z"); // 00:00 EDT
    expect(boundary.endOfDayAt).toBe("2026-11-02T05:00:00.000Z"); // 00:00 EST next day
    expect(
      Date.parse(boundary.endOfDayAt) - Date.parse(boundary.startOfDayAt),
    ).toBe(25 * 3_600_000);
  });

  it("spans the 23h local day on the US DST spring-forward day", () => {
    const boundary = resolveLifeOpsDayBoundary({
      nowMs: Date.parse("2026-03-08T12:00:00-04:00"), // noon EDT, spring-forward day
      timezone: "America/New_York",
      sleepCycle: NO_SLEEP_CYCLE,
    });

    expect(boundary.startOfDayAt).toBe("2026-03-08T05:00:00.000Z"); // 00:00 EST
    expect(boundary.endOfDayAt).toBe("2026-03-09T04:00:00.000Z"); // 00:00 EDT next day
    expect(
      Date.parse(boundary.endOfDayAt) - Date.parse(boundary.startOfDayAt),
    ).toBe(23 * 3_600_000);
  });

  it("spans exactly 24h on a plain day", () => {
    const boundary = resolveLifeOpsDayBoundary({
      nowMs: Date.parse("2026-06-15T12:00:00-04:00"),
      timezone: "America/New_York",
      sleepCycle: NO_SLEEP_CYCLE,
    });

    expect(boundary.startOfDayAt).toBe("2026-06-15T04:00:00.000Z");
    expect(boundary.endOfDayAt).toBe("2026-06-16T04:00:00.000Z");
  });
});
