/**
 * Regression coverage for the NaN-safe, tie-deterministic comparators in
 * `schedule-insight.ts`. Every case calls the exported production functions
 * (`mergeActivityWindows`, `inferMealCandidates`) directly — no comparator is
 * reimplemented here — so reverting a comparator makes these fail. The harness
 * is pure and deterministic: fixed UTC timestamps, no runtime, no I/O.
 */
import { describe, expect, it } from "vitest";
import { inferMealCandidates, mergeActivityWindows } from "./schedule-insight";
import type { LifeOpsActivityWindow } from "./types";

const MINUTE = 60_000;

describe("mergeActivityWindows comparator", () => {
  it("orders a NaN-start window first instead of leaving it where it happened to land", () => {
    // A corrupt window must not poison the ordering of the sound ones: the
    // comparator reads a non-finite start as 0, so it sorts ahead of every
    // real timestamp rather than returning NaN and freezing input order.
    const windows: LifeOpsActivityWindow[] = [
      { startMs: 5 * 60 * MINUTE, endMs: 6 * 60 * MINUTE, source: "app" },
      { startMs: Number.NaN, endMs: 60 * MINUTE, source: "screen_time" },
    ];

    const merged = mergeActivityWindows(windows);

    expect(merged).toHaveLength(2);
    expect(merged[0].startMs).toBeNaN();
    expect(merged[1].startMs).toBe(5 * 60 * MINUTE);
  });
});

describe("inferMealCandidates score comparator", () => {
  it("resolves a score tie by label instead of by object-key order", () => {
    // Midpoint 16:00 UTC scores no hour bonus, and 540 minutes since wake
    // grants lunch and dinner the same +0.2, so the two tie at the top. The
    // comparator's label tie-break must decide it, deterministically.
    const wakeAtMs = Date.parse("2026-08-23T07:00:00.000Z");
    const midpointMs = Date.parse("2026-08-23T16:00:00.000Z");
    expect((midpointMs - wakeAtMs) / MINUTE).toBe(540);

    const gapMs = 35 * MINUTE;
    const gapStartMs = midpointMs - Math.floor(gapMs / 2);
    const gapEndMs = gapStartMs + gapMs;
    const windows: LifeOpsActivityWindow[] = [
      { startMs: gapStartMs - 45 * MINUTE, endMs: gapStartMs, source: "app" },
      { startMs: gapEndMs, endMs: gapEndMs + 45 * MINUTE, source: "app" },
    ];

    const meals = inferMealCandidates({ windows, wakeAtMs, timezone: "UTC" });

    expect(meals).toHaveLength(1);
    expect(meals[0].label).toBe("dinner");
    expect(meals[0].detectedAt).toBe(new Date(midpointMs).toISOString());
  });

  it("still picks the label the hour bonus favors when there is no tie", () => {
    const wakeAtMs = Date.parse("2026-08-23T06:00:00.000Z");
    const midpointMs = Date.parse("2026-08-23T12:30:00.000Z");
    const gapMs = 35 * MINUTE;
    const gapStartMs = midpointMs - Math.floor(gapMs / 2);
    const gapEndMs = gapStartMs + gapMs;
    const windows: LifeOpsActivityWindow[] = [
      { startMs: gapStartMs - 45 * MINUTE, endMs: gapStartMs, source: "app" },
      { startMs: gapEndMs, endMs: gapEndMs + 45 * MINUTE, source: "app" },
    ];

    const meals = inferMealCandidates({ windows, wakeAtMs, timezone: "UTC" });

    expect(meals.map((meal) => meal.label)).toEqual(["lunch"]);
  });
});
