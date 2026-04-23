import { describe, expect, it } from "vitest";
import {
  computePersonalBaseline,
  computeSleepRegularity,
  type SleepRegularityEpisodeLike,
} from "../src/lifeops/sleep-regularity.js";

function buildEpisode(
  startAt: string,
  endAt: string,
): SleepRegularityEpisodeLike {
  return { startAt, endAt, cycleType: "unknown" };
}

function buildWeekOfEpisodes(
  bedtimeHour: number,
  wakeHour: number,
  days = 14,
  jitterMin = 0,
): SleepRegularityEpisodeLike[] {
  const episodes: SleepRegularityEpisodeLike[] = [];
  for (let offset = 0; offset < days; offset += 1) {
    const baseMs = Date.UTC(2026, 3, 1 + offset);
    const jitter = jitterMin === 0 ? 0 : ((offset % 7) - 3) * jitterMin;
    const start = new Date(
      baseMs + bedtimeHour * 60 * 60 * 1000 + jitter * 60 * 1000,
    );
    const end = new Date(
      baseMs +
        24 * 60 * 60 * 1000 +
        wakeHour * 60 * 60 * 1000 +
        jitter * 60 * 1000,
    );
    episodes.push(buildEpisode(start.toISOString(), end.toISOString()));
  }
  return episodes;
}

describe("sleep-regularity math", () => {
  describe("computeSleepRegularity", () => {
    it("returns insufficient_data for fewer than 5 episodes", () => {
      const result = computeSleepRegularity({
        episodes: [
          buildEpisode("2026-04-20T23:00:00Z", "2026-04-21T07:00:00Z"),
        ],
        timezone: "UTC",
        nowMs: Date.parse("2026-04-21T12:00:00Z"),
      });
      expect(result.regularityClass).toBe("insufficient_data");
      expect(result.sampleCount).toBe(1);
    });

    it("classifies a stable schedule as regular or very_regular", () => {
      const episodes = buildWeekOfEpisodes(23, 7, 14, 0);
      const result = computeSleepRegularity({
        episodes,
        timezone: "UTC",
        nowMs: Date.parse("2026-04-20T12:00:00Z"),
      });
      expect(["regular", "very_regular"]).toContain(result.regularityClass);
      expect(result.sri).toBeGreaterThan(70);
      expect(result.bedtimeStddevMin).toBeLessThan(45);
      expect(result.wakeStddevMin).toBeLessThan(45);
    });

    it("classifies a jittery schedule as irregular or worse", () => {
      // 120 minute jitter pushes stddev past the regular threshold.
      const episodes = buildWeekOfEpisodes(23, 7, 14, 120);
      const result = computeSleepRegularity({
        episodes,
        timezone: "UTC",
        nowMs: Date.parse("2026-04-20T12:00:00Z"),
      });
      expect(["irregular", "very_irregular"]).toContain(result.regularityClass);
    });

    it("treats bedtimes crossing midnight with circular stddev", () => {
      // Bedtime at 00:00 every day: linear mean would be 0, but circular
      // mean should also settle near 0 with tiny stddev.
      const episodes: SleepRegularityEpisodeLike[] = [];
      for (let day = 0; day < 10; day += 1) {
        const baseMs = Date.UTC(2026, 3, 1 + day);
        const start = new Date(baseMs + 0 * 60 * 60 * 1000);
        const end = new Date(baseMs + 8 * 60 * 60 * 1000);
        episodes.push(buildEpisode(start.toISOString(), end.toISOString()));
      }
      const result = computeSleepRegularity({
        episodes,
        timezone: "UTC",
        nowMs: Date.parse("2026-04-15T12:00:00Z"),
      });
      expect(result.bedtimeStddevMin).toBeLessThan(5);
    });
  });

  describe("computePersonalBaseline", () => {
    it("returns null below the 5-episode sample threshold", () => {
      const episodes = buildWeekOfEpisodes(23, 7, 2, 0);
      const result = computePersonalBaseline({
        episodes,
        timezone: "UTC",
        nowMs: Date.parse("2026-04-20T12:00:00Z"),
      });
      expect(result).toBeNull();
    });

    it("produces baseline with circular mean and 28-day default window", () => {
      const episodes = buildWeekOfEpisodes(23, 7, 14, 0);
      const result = computePersonalBaseline({
        episodes,
        timezone: "UTC",
        nowMs: Date.parse("2026-04-20T12:00:00Z"),
      });
      expect(result).not.toBeNull();
      if (!result) throw new Error("baseline should be present");
      expect(result.sampleCount).toBeGreaterThanOrEqual(5);
      expect(result.windowDays).toBe(28);
      // Bedtime around 23:00 local, circular mean normalized to [12, 36).
      expect(result.medianBedtimeLocalHour).toBeGreaterThan(22);
      expect(result.medianBedtimeLocalHour).toBeLessThan(24);
      // Wake around 07:00 local, circular mean range [0, 24).
      expect(result.medianWakeLocalHour).toBeGreaterThan(6);
      expect(result.medianWakeLocalHour).toBeLessThan(8);
      expect(result.medianSleepDurationMin).toBeGreaterThan(470);
      expect(result.medianSleepDurationMin).toBeLessThan(490);
    });
  });
});
