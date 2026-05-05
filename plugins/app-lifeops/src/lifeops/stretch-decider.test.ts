import { describe, expect, it } from "vitest";
import {
  pickStretchReminderCopy,
  shouldStretchNow,
  STRETCH_REMINDER_VARIANTS,
} from "./stretch-decider.js";

const SIX_HOURS_MS = 6 * 60 * 60 * 1000;
// 2026-05-04 is a Monday in any timezone we test from. We compute hour and
// dow against the test inputs directly rather than parsing dates so the
// pure function stays timezone-free.
const MONDAY = 1;
const TUESDAY = 2;
const SATURDAY = 6;
const SUNDAY = 0;

const NOW = 1_730_000_000_000;

describe("shouldStretchNow", () => {
  it("fires the very first time when nothing else is gating", () => {
    const result = shouldStretchNow({
      nowMs: NOW,
      lastStretchMs: null,
      lastWalkOutMs: null,
      isBusyDay: false,
      dayOfWeek: TUESDAY,
      hourOfDay: 14,
    });
    expect(result).toEqual({ shouldFire: true, reason: "first_fire" });
  });

  it("fires exactly at the cooldown boundary (>= interval)", () => {
    const result = shouldStretchNow({
      nowMs: NOW,
      lastStretchMs: NOW - SIX_HOURS_MS,
      lastWalkOutMs: null,
      isBusyDay: false,
      dayOfWeek: TUESDAY,
      hourOfDay: 14,
    });
    expect(result).toEqual({
      shouldFire: true,
      reason: "interval_elapsed",
    });
  });

  it("does not fire when the last stretch is one ms inside the cooldown", () => {
    const result = shouldStretchNow({
      nowMs: NOW,
      lastStretchMs: NOW - (SIX_HOURS_MS - 1),
      lastWalkOutMs: null,
      isBusyDay: false,
      dayOfWeek: TUESDAY,
      hourOfDay: 14,
    });
    expect(result).toEqual({
      shouldFire: false,
      reason: "within_cooldown",
    });
  });

  it("does not fire twice once a stretch has already fired in the window", () => {
    // First call would fire (boundary case).
    const first = shouldStretchNow({
      nowMs: NOW,
      lastStretchMs: NOW - SIX_HOURS_MS,
      lastWalkOutMs: null,
      isBusyDay: false,
      dayOfWeek: TUESDAY,
      hourOfDay: 14,
    });
    expect(first.shouldFire).toBe(true);

    // After it fires we set lastStretchMs = NOW; the very next tick must
    // be silent.
    const second = shouldStretchNow({
      nowMs: NOW + 1_000,
      lastStretchMs: NOW,
      lastWalkOutMs: null,
      isBusyDay: false,
      dayOfWeek: TUESDAY,
      hourOfDay: 14,
    });
    expect(second).toEqual({ shouldFire: false, reason: "within_cooldown" });
  });

  it("rearms the cadence from a walk-out signal newer than the last stretch", () => {
    const stretchedAt = NOW - 8 * 60 * 60 * 1000; // 8h ago — stale
    const walkedAt = NOW - 30 * 60 * 1000; // 30 min ago — fresh
    const result = shouldStretchNow({
      nowMs: NOW,
      lastStretchMs: stretchedAt,
      lastWalkOutMs: walkedAt,
      isBusyDay: false,
      dayOfWeek: TUESDAY,
      hourOfDay: 14,
    });
    expect(result).toEqual({
      shouldFire: false,
      reason: "within_cooldown",
    });
  });

  it("uses the walk-out anchor reason when the walk satisfies the cooldown", () => {
    const stretchedAt = NOW - 12 * 60 * 60 * 1000;
    const walkedAt = NOW - 7 * 60 * 60 * 1000; // > 6h cooldown after the walk
    const result = shouldStretchNow({
      nowMs: NOW,
      lastStretchMs: stretchedAt,
      lastWalkOutMs: walkedAt,
      isBusyDay: false,
      dayOfWeek: TUESDAY,
      hourOfDay: 14,
    });
    expect(result).toEqual({ shouldFire: true, reason: "walk_reset" });
  });

  it("ignores stale walk-out signals older than the last stretch", () => {
    // User walked first, then stretched. The walk should NOT reset the
    // cooldown — the stretch is the more recent signal.
    const walkedAt = NOW - 8 * 60 * 60 * 1000;
    const stretchedAt = NOW - 1 * 60 * 60 * 1000; // 1h ago
    const result = shouldStretchNow({
      nowMs: NOW,
      lastStretchMs: stretchedAt,
      lastWalkOutMs: walkedAt,
      isBusyDay: false,
      dayOfWeek: TUESDAY,
      hourOfDay: 14,
    });
    expect(result).toEqual({
      shouldFire: false,
      reason: "within_cooldown",
    });
  });

  it("suppresses the nudge on a busy day even if the cooldown has elapsed", () => {
    const result = shouldStretchNow({
      nowMs: NOW,
      lastStretchMs: NOW - 12 * 60 * 60 * 1000,
      lastWalkOutMs: null,
      isBusyDay: true,
      dayOfWeek: MONDAY,
      hourOfDay: 14,
    });
    expect(result).toEqual({ shouldFire: false, reason: "busy_day_skip" });
  });

  it("skips weekends regardless of cooldown", () => {
    const saturday = shouldStretchNow({
      nowMs: NOW,
      lastStretchMs: null,
      lastWalkOutMs: null,
      isBusyDay: false,
      dayOfWeek: SATURDAY,
      hourOfDay: 14,
    });
    const sunday = shouldStretchNow({
      nowMs: NOW,
      lastStretchMs: null,
      lastWalkOutMs: null,
      isBusyDay: false,
      dayOfWeek: SUNDAY,
      hourOfDay: 14,
    });
    expect(saturday).toEqual({ shouldFire: false, reason: "weekend_skip" });
    expect(sunday).toEqual({ shouldFire: false, reason: "weekend_skip" });
  });

  it("does not fire after 21:00 local time", () => {
    const result = shouldStretchNow({
      nowMs: NOW,
      lastStretchMs: NOW - 12 * 60 * 60 * 1000,
      lastWalkOutMs: null,
      isBusyDay: false,
      dayOfWeek: TUESDAY,
      hourOfDay: 21,
    });
    expect(result).toEqual({
      shouldFire: false,
      reason: "late_evening_skip",
    });
  });

  it("still fires at 20:59 — the late-evening cutoff is 21:00 sharp", () => {
    const result = shouldStretchNow({
      nowMs: NOW,
      lastStretchMs: NOW - 12 * 60 * 60 * 1000,
      lastWalkOutMs: null,
      isBusyDay: false,
      dayOfWeek: TUESDAY,
      hourOfDay: 20,
    });
    expect(result).toEqual({
      shouldFire: true,
      reason: "interval_elapsed",
    });
  });

  it("respects an explicit intervalMs override (e.g. 4h)", () => {
    const fourHoursMs = 4 * 60 * 60 * 1000;
    const result = shouldStretchNow({
      nowMs: NOW,
      lastStretchMs: NOW - fourHoursMs,
      lastWalkOutMs: null,
      isBusyDay: false,
      dayOfWeek: TUESDAY,
      hourOfDay: 14,
      intervalMs: fourHoursMs,
    });
    expect(result.shouldFire).toBe(true);
  });
});

describe("pickStretchReminderCopy", () => {
  it("returns one of the canonical variants", () => {
    const text = pickStretchReminderCopy({ dayOfYear: 100 });
    expect(STRETCH_REMINDER_VARIANTS).toContain(text);
  });

  it("rotates deterministically across consecutive days", () => {
    const consecutive = [123, 124, 125, 126, 127].map((day) =>
      pickStretchReminderCopy({ dayOfYear: day }),
    );
    // Every variant slot should appear exactly once across five days
    // when length === 5.
    expect(new Set(consecutive).size).toBe(STRETCH_REMINDER_VARIANTS.length);
  });

  it("returns the same copy for the same day", () => {
    expect(pickStretchReminderCopy({ dayOfYear: 200 })).toEqual(
      pickStretchReminderCopy({ dayOfYear: 200 }),
    );
  });

  it("handles negative day-of-year defensively", () => {
    const text = pickStretchReminderCopy({ dayOfYear: -3 });
    expect(STRETCH_REMINDER_VARIANTS).toContain(text);
  });
});
