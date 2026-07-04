/**
 * Stretch-reminder pacing (#8795 LifeOps), tested as pure functions with no
 * reminder service. `shouldStretchNow` layers the stretch-specific cadence
 * rules (weekend/busy/late-evening skips, the 6h cooldown, and the "a recent
 * walk rearms the cooldown" reset) on top of the generic reminder loop, and
 * `pickStretchReminderCopy` rotates copy deterministically by day.
 */
import { describe, expect, it } from "vitest";
import {
  pickStretchReminderCopy,
  type ShouldStretchNowInput,
  STRETCH_REMINDER_VARIANTS,
  shouldStretchNow,
} from "./stretch-decider";

const H = 3_600_000; // 1 hour in ms
const NOW = 1_700_000_000_000;

// A weekday, daytime, non-busy context with no prior fire → the "fire" baseline.
const fireable = (
  o: Partial<ShouldStretchNowInput> = {},
): ShouldStretchNowInput => ({
  nowMs: NOW,
  lastStretchMs: null,
  lastWalkOutMs: null,
  isBusyDay: false,
  dayOfWeek: 3, // Wednesday
  hourOfDay: 14,
  ...o,
});

describe("shouldStretchNow — skip gates", () => {
  it("skips weekends, and the weekend gate wins over every other condition", () => {
    for (const dayOfWeek of [0, 6]) {
      // Even with a busy late-evening overdue context, weekend short-circuits.
      const r = shouldStretchNow(
        fireable({
          dayOfWeek,
          isBusyDay: true,
          hourOfDay: 22,
          lastStretchMs: NOW - 10 * H,
        }),
      );
      expect(r).toEqual({ shouldFire: false, reason: "weekend_skip" });
    }
  });

  it("skips busy days (weekday)", () => {
    expect(shouldStretchNow(fireable({ isBusyDay: true }))).toEqual({
      shouldFire: false,
      reason: "busy_day_skip",
    });
  });

  it("skips late evening (>= 21:00 local)", () => {
    expect(shouldStretchNow(fireable({ hourOfDay: 21 }))).toEqual({
      shouldFire: false,
      reason: "late_evening_skip",
    });
    // 20:00 is still allowed (boundary is inclusive at 21).
    expect(shouldStretchNow(fireable({ hourOfDay: 20 })).shouldFire).toBe(true);
  });
});

describe("shouldStretchNow — cadence", () => {
  it("fires on the very first opportunity", () => {
    expect(shouldStretchNow(fireable())).toEqual({
      shouldFire: true,
      reason: "first_fire",
    });
  });

  it("fires once the interval has elapsed, holds inside the cooldown", () => {
    expect(shouldStretchNow(fireable({ lastStretchMs: NOW - 7 * H }))).toEqual({
      shouldFire: true,
      reason: "interval_elapsed",
    });
    expect(shouldStretchNow(fireable({ lastStretchMs: NOW - 1 * H }))).toEqual({
      shouldFire: false,
      reason: "within_cooldown",
    });
  });

  it("honors an intervalMs override", () => {
    expect(
      shouldStretchNow(
        fireable({ lastStretchMs: NOW - 3 * H, intervalMs: 2 * H }),
      ),
    ).toEqual({ shouldFire: true, reason: "interval_elapsed" });
  });

  it("rearms the cooldown from a more-recent walk-out (reset precedence)", () => {
    // Walk 7h ago is more recent than the 10h-old stretch → anchor is the walk,
    // which is itself past the interval → fire, attributed to walk_reset.
    expect(
      shouldStretchNow(
        fireable({ lastStretchMs: NOW - 10 * H, lastWalkOutMs: NOW - 7 * H }),
      ),
    ).toEqual({ shouldFire: true, reason: "walk_reset" });

    // A stretch that WOULD have fired (7h ago) is suppressed by a fresh walk
    // 1h ago — the walk rearmed the clock.
    expect(
      shouldStretchNow(
        fireable({ lastStretchMs: NOW - 7 * H, lastWalkOutMs: NOW - 1 * H }),
      ),
    ).toEqual({ shouldFire: false, reason: "within_cooldown" });
  });
});

describe("pickStretchReminderCopy", () => {
  const n = STRETCH_REMINDER_VARIANTS.length;

  it("selects a deterministic variant by day-of-year modulo", () => {
    expect(pickStretchReminderCopy({ dayOfYear: 0 })).toBe(
      STRETCH_REMINDER_VARIANTS[0],
    );
    expect(pickStretchReminderCopy({ dayOfYear: n })).toBe(
      STRETCH_REMINDER_VARIANTS[0],
    );
    expect(pickStretchReminderCopy({ dayOfYear: 2 })).toBe(
      STRETCH_REMINDER_VARIANTS[2],
    );
  });

  it("truncates fractional and wraps negative inputs to a real variant", () => {
    expect(pickStretchReminderCopy({ dayOfYear: 2.9 })).toBe(
      STRETCH_REMINDER_VARIANTS[2],
    );
    // ((-1 % n) + n) % n === n - 1 (the last variant).
    expect(pickStretchReminderCopy({ dayOfYear: -1 })).toBe(
      STRETCH_REMINDER_VARIANTS[n - 1],
    );
  });
});
