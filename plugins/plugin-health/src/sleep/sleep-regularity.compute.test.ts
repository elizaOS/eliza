/**
 * Sleep-regularity tests pin episode filtering, classification floors, and the
 * perfectly regular nightly schedule invariant.
 */
import { describe, expect, it } from "vitest";
import type { SleepRegularityEpisodeLike } from "./sleep-regularity.js";
import { computeSleepRegularity } from "./sleep-regularity.js";

const nowMs = Date.parse("2026-06-24T00:00:00Z");
const ep = (
  startAt: string,
  endAt: string,
  cycleType: SleepRegularityEpisodeLike["cycleType"] = "overnight",
): SleepRegularityEpisodeLike => ({ startAt, endAt, cycleType });

// Six nights are enough to cross the five-episode classification floor.
const regularNights: SleepRegularityEpisodeLike[] = [
  ep("2026-06-17T23:00:00Z", "2026-06-18T07:00:00Z"),
  ep("2026-06-18T23:00:00Z", "2026-06-19T07:00:00Z"),
  ep("2026-06-19T23:00:00Z", "2026-06-20T07:00:00Z"),
  ep("2026-06-20T23:00:00Z", "2026-06-21T07:00:00Z"),
  ep("2026-06-21T23:00:00Z", "2026-06-22T07:00:00Z"),
  ep("2026-06-22T23:00:00Z", "2026-06-23T07:00:00Z"),
];

describe("computeSleepRegularity", () => {
  it("classifies an identical nightly schedule as very_regular with ~0 variance", () => {
    const r = computeSleepRegularity({
      episodes: regularNights,
      timezone: "UTC",
      nowMs,
    });
    expect(r.sampleCount).toBe(6);
    expect(r.bedtimeStddevMin).toBeCloseTo(0, 4);
    expect(r.wakeStddevMin).toBeCloseTo(0, 4);
    expect(r.midSleepStddevMin).toBeCloseTo(0, 4);
    expect(r.regularityClass).toBe("very_regular"); // SRI~100, stddev 0, n>=5
    expect(r.windowDays).toBe(28); // default
  });

  it("returns insufficient_data below the 5-episode classification floor", () => {
    const r = computeSleepRegularity({
      episodes: regularNights.slice(0, 4), // 4 < 5
      timezone: "UTC",
      nowMs,
    });
    expect(r.sampleCount).toBe(4);
    expect(r.regularityClass).toBe("insufficient_data");
  });

  it("fails closed to insufficient_data with no episodes", () => {
    expect(
      computeSleepRegularity({ episodes: [], timezone: "UTC", nowMs }),
    ).toEqual({
      sri: 0,
      bedtimeStddevMin: 0,
      wakeStddevMin: 0,
      midSleepStddevMin: 0,
      regularityClass: "insufficient_data",
      sampleCount: 0,
      windowDays: 28,
    });
  });

  it("excludes naps and sub-3h episodes from the sample", () => {
    const nap = computeSleepRegularity({
      episodes: [ep("2026-06-22T23:00:00Z", "2026-06-23T07:00:00Z", "nap")],
      timezone: "UTC",
      nowMs,
    });
    expect(nap.sampleCount).toBe(0);
    expect(nap.regularityClass).toBe("insufficient_data");

    const tooShort = computeSleepRegularity({
      episodes: [ep("2026-06-23T05:00:00Z", "2026-06-23T07:00:00Z")], // 2h
      timezone: "UTC",
      nowMs,
    });
    expect(tooShort.sampleCount).toBe(0);
  });

  it("passes the configured windowDays through to the result", () => {
    const r = computeSleepRegularity({
      episodes: regularNights,
      timezone: "UTC",
      nowMs,
      windowDays: 14,
    });
    expect(r.windowDays).toBe(14);
    expect(r.sampleCount).toBe(6);
  });
});
