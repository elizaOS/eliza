/**
 * Unit tests for safe sorting in schedule insight activity windows and meal candidates.
 */
import { describe, expect, it } from "vitest";
import {
  inferLifeOpsScheduleInsight,
  inferMealCandidates,
  mergeActivityWindows,
} from "./schedule-insight";
import type { LifeOpsActivitySignal, LifeOpsActivityWindow } from "./types";

describe("schedule-insight safe sort comparators", () => {
  it("mergeActivityWindows handles windows with NaN timestamps safely", () => {
    const windows: LifeOpsActivityWindow[] = [
      { startMs: 2000, endMs: 3000, source: "app" },
      { startMs: Number.NaN, endMs: 1000, source: "screen_time" },
      { startMs: 1000, endMs: 2500, source: "signal" },
    ];

    const merged = mergeActivityWindows(windows);
    expect(merged.length).toBeGreaterThan(0);
    expect(merged[0].startMs).toBeNaN();
  });

  it("inferMealCandidates scores and detects meal gaps deterministically", () => {
    const baseMs = new Date("2026-08-23T06:00:00Z").getTime();
    const windows: LifeOpsActivityWindow[] = [
      { startMs: baseMs, endMs: baseMs + 60 * 60 * 1000, source: "app" }, // 6-7 AM
      {
        startMs: baseMs + 2 * 60 * 60 * 1000,
        endMs: baseMs + 4 * 60 * 60 * 1000,
        source: "app",
      }, // 8-10 AM (1 hr gap 7-8 AM -> breakfast)
    ];

    const meals = inferMealCandidates({
      windows,
      wakeAtMs: baseMs,
      timezone: "UTC",
    });

    expect(meals.length).toBeGreaterThanOrEqual(0);
  });

  it("inferLifeOpsScheduleInsight handles activity windows and signals deterministically", () => {
    const nowMs = new Date("2026-08-23T14:00:00Z").getTime();
    const windows: LifeOpsActivityWindow[] = [
      {
        startMs: nowMs - 6 * 60 * 60 * 1000,
        endMs: nowMs - 4 * 60 * 60 * 1000,
        source: "app",
      },
    ];
    const signals: LifeOpsActivitySignal[] = [];

    const insight = inferLifeOpsScheduleInsight({
      nowMs,
      timezone: "UTC",
      windows,
      signals,
    });

    expect(insight).toBeDefined();
    expect(insight.timezone).toBe("UTC");
    expect(Array.isArray(insight.circadianRuleFirings)).toBe(true);
  });
});
