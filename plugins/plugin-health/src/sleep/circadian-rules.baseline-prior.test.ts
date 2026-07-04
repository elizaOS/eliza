/**
 * Regression test for the `baselinePrior` circadian rule. The baseline stores
 * bedtime in the 12..36 "hours past prior noon" convention and wake in 0..24;
 * comparing the two conventions directly made the rule fire
 * `currentHourLikelyAsleep` all afternoon AND during the post-wake morning,
 * while the `currentHourLikelyAwake` branch was unreachable for any wake
 * hour before ~08:00. Pure and timezone-parameterized.
 */
import { describe, expect, it } from "vitest";
import type { LifeOpsPersonalBaseline } from "../contracts/health.js";
import { scoreCircadianRules } from "./circadian-rules.js";

const TYPICAL_BASELINE: LifeOpsPersonalBaseline = {
  medianWakeLocalHour: 7,
  medianBedtimeLocalHour: 23,
  medianSleepDurationMin: 480,
  bedtimeStddevMin: 20,
  wakeStddevMin: 20,
  sampleCount: 10,
  windowDays: 28,
};

// Score with no signals/windows so the only possible firing is baselinePrior.
function baselineFirings(
  isoInstant: string,
  baseline: LifeOpsPersonalBaseline,
): string[] {
  const result = scoreCircadianRules({
    nowMs: Date.parse(isoInstant),
    timezone: "America/Los_Angeles",
    signals: [],
    windows: [],
    baseline,
    regularityClass: "very_regular",
    hasCurrentSleepEpisode: false,
    currentSleepStartedAtMs: null,
    lastSleepEndedAtMs: null,
    currentEpisodeLikelyNap: false,
  });
  return result.firings.map(
    (firing) => `${firing.name}->${firing.contributes}`,
  );
}

describe("baselinePrior rule (bedtime 23:00, wake 07:00)", () => {
  it("does not fire mid-afternoon", () => {
    // 14:00 PDT — squarely inside the awake day, outside both windows.
    expect(baselineFirings("2026-06-02T21:00:00Z", TYPICAL_BASELINE)).toEqual(
      [],
    );
  });

  it("fires the awake prior in the post-wake morning window", () => {
    // 08:00 PDT — one hour after the baseline wake.
    expect(baselineFirings("2026-06-02T15:00:00Z", TYPICAL_BASELINE)).toEqual([
      "baseline.currentHourLikelyAwake->awake",
    ]);
  });

  it("fires the asleep prior after bedtime and across midnight", () => {
    // 23:30 PDT
    expect(baselineFirings("2026-06-03T06:30:00Z", TYPICAL_BASELINE)).toEqual([
      "baseline.currentHourLikelyAsleep->sleeping",
    ]);
    // 03:00 PDT
    expect(baselineFirings("2026-06-02T10:00:00Z", TYPICAL_BASELINE)).toEqual([
      "baseline.currentHourLikelyAsleep->sleeping",
    ]);
  });

  it("handles a past-midnight bedtime (01:30, stored as 25.5)", () => {
    const lateBaseline: LifeOpsPersonalBaseline = {
      ...TYPICAL_BASELINE,
      medianBedtimeLocalHour: 25.5,
      medianWakeLocalHour: 9,
    };
    // 00:30 PDT — after midnight but before the 01:30 bedtime: no prior.
    expect(baselineFirings("2026-06-02T07:30:00Z", lateBaseline)).toEqual([]);
    // 02:00 PDT — inside the sleep window.
    expect(baselineFirings("2026-06-02T09:00:00Z", lateBaseline)).toEqual([
      "baseline.currentHourLikelyAsleep->sleeping",
    ]);
  });
});
