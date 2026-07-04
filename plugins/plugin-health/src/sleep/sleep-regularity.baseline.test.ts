/**
 * Unit test for `computePersonalBaseline` — asserts the per-user sleep baseline
 * (typical bedtime/duration and sample sufficiency) over episode fixtures.
 */
import { describe, expect, it } from "vitest";
import {
  computePersonalBaseline,
  type SleepRegularityEpisodeLike,
} from "./sleep-regularity.js";

/**
 * Personal sleep baseline (#8795 health). `computePersonalBaseline` reduces a
 * set of recent sleep episodes into the median bedtime/wake/duration + circular
 * stddev that the circadian + regularity engines compare against. It was
 * untested. Using UTC + identical episode times makes the circular means
 * exactly predictable (mean of identical angles = that angle, stddev 0).
 */

const NOW = Date.parse("2024-01-10T00:00:00Z");

// Five identical overnight episodes: 23:00 → 07:00 UTC (8h) on consecutive days.
const overnightEpisodes = (count: number): SleepRegularityEpisodeLike[] =>
  Array.from({ length: count }, (_, i) => ({
    startAt: `2024-01-0${i + 1}T23:00:00Z`,
    endAt: `2024-01-0${i + 2}T07:00:00Z`,
    cycleType: "overnight" as const,
  }));

describe("computePersonalBaseline", () => {
  it("returns null below the minimum sample count", () => {
    expect(
      computePersonalBaseline({
        episodes: overnightEpisodes(4),
        timezone: "UTC",
        nowMs: NOW,
      }),
    ).toBeNull();
  });

  it("computes medians + zero stddev for a run of identical episodes", () => {
    const baseline = computePersonalBaseline({
      episodes: overnightEpisodes(5),
      timezone: "UTC",
      nowMs: NOW,
    });
    expect(baseline).not.toBeNull();
    expect(baseline).toMatchObject({
      medianBedtimeLocalHour: 23,
      medianWakeLocalHour: 7,
      medianSleepDurationMin: 480, // 8h
      sampleCount: 5,
      windowDays: 28, // default
    });
    expect(baseline?.bedtimeStddevMin).toBeCloseTo(0, 5);
    expect(baseline?.wakeStddevMin).toBeCloseTo(0, 5);
  });

  it("echoes a windowDays override and excludes naps + future/short episodes", () => {
    const episodes: SleepRegularityEpisodeLike[] = [
      ...overnightEpisodes(5),
      // a nap — excluded regardless of duration
      {
        startAt: "2024-01-03T14:00:00Z",
        endAt: "2024-01-03T18:00:00Z",
        cycleType: "nap",
      },
      // ends after nowMs — excluded
      {
        startAt: "2024-01-20T23:00:00Z",
        endAt: "2024-01-21T07:00:00Z",
        cycleType: "overnight",
      },
      // under 3h — excluded
      {
        startAt: "2024-01-04T01:00:00Z",
        endAt: "2024-01-04T03:00:00Z",
        cycleType: "overnight",
      },
    ];
    const baseline = computePersonalBaseline({
      episodes,
      timezone: "UTC",
      nowMs: NOW,
      windowDays: 14,
    });
    // Only the 5 qualifying overnight episodes count.
    expect(baseline?.sampleCount).toBe(5);
    expect(baseline?.windowDays).toBe(14);
  });
});
