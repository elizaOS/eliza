// Exercises LifeOps owner workflows, connector boundaries, and scheduled-task behavior.
import { describe, expect, it } from "vitest";
import {
  DEFAULT_MORNING_WINDOW,
  DEFAULT_NIGHT_WINDOW,
  type EnforcementWindow,
  getCurrentEnforcementWindow,
  isWithinEnforcementWindow,
  minutesPastWindowStart,
} from "../src/lifeops/enforcement-windows.js";

/**
 * Enforcement windows decide when routine reminders escalate. The math is pure
 * time-of-day arithmetic over an IANA timezone, so it's tested deterministically
 * with fixed UTC instants. Wrapping windows (e.g. 22:00→02:00) and timezone
 * resolution are the easy-to-break cases.
 */

/** A UTC instant on a fixed, non-DST-ambiguous date. */
function at(hourUtc: number, minuteUtc = 0): Date {
  return new Date(Date.UTC(2026, 0, 15, hourUtc, minuteUtc, 0));
}

const UTC = "UTC";

describe("getCurrentEnforcementWindow", () => {
  it("returns the morning window inside 06:00–10:00 local", () => {
    expect(getCurrentEnforcementWindow(at(7), UTC).kind).toBe("morning");
    expect(getCurrentEnforcementWindow(at(6), UTC).kind).toBe("morning");
    expect(getCurrentEnforcementWindow(at(9, 59), UTC).kind).toBe("morning");
  });

  it("returns the night window inside 21:00–24:00 local", () => {
    expect(getCurrentEnforcementWindow(at(22, 30), UTC).kind).toBe("night");
    expect(getCurrentEnforcementWindow(at(23, 59), UTC).kind).toBe("night");
  });

  it("returns none outside any window (and at the exclusive end)", () => {
    expect(getCurrentEnforcementWindow(at(5), UTC).kind).toBe("none");
    expect(getCurrentEnforcementWindow(at(10), UTC).kind).toBe("none");
    expect(getCurrentEnforcementWindow(at(15), UTC).kind).toBe("none");
  });

  it("resolves the window in the supplied timezone, not UTC", () => {
    // 18:00 UTC is 08:00 in Honolulu (UTC-10, no DST) → morning there...
    expect(getCurrentEnforcementWindow(at(18), "Pacific/Honolulu").kind).toBe(
      "morning",
    );
    // ...but 18:00 in UTC itself is outside every window.
    expect(getCurrentEnforcementWindow(at(18), UTC).kind).toBe("none");
  });
});

describe("isWithinEnforcementWindow", () => {
  it("matches the given window only inside it", () => {
    expect(isWithinEnforcementWindow(at(7), UTC, DEFAULT_MORNING_WINDOW)).toBe(
      true,
    );
    expect(isWithinEnforcementWindow(at(11), UTC, DEFAULT_MORNING_WINDOW)).toBe(
      false,
    );
    expect(isWithinEnforcementWindow(at(22), UTC, DEFAULT_NIGHT_WINDOW)).toBe(
      true,
    );
  });

  it("is always false for a none-kind window", () => {
    const none: EnforcementWindow = {
      kind: "none",
      startMinute: 0,
      endMinute: 0,
    };
    expect(isWithinEnforcementWindow(at(7), UTC, none)).toBe(false);
  });

  it("handles a window that wraps past midnight", () => {
    const wrap: EnforcementWindow = {
      kind: "night",
      startMinute: 22 * 60,
      endMinute: 2 * 60,
    };
    expect(isWithinEnforcementWindow(at(23), UTC, wrap)).toBe(true);
    expect(isWithinEnforcementWindow(at(1), UTC, wrap)).toBe(true);
    expect(isWithinEnforcementWindow(at(3), UTC, wrap)).toBe(false);
  });
});

describe("minutesPastWindowStart", () => {
  it("counts minutes from the window start when inside", () => {
    expect(minutesPastWindowStart(at(7, 30), UTC, DEFAULT_MORNING_WINDOW)).toBe(
      90,
    );
    expect(minutesPastWindowStart(at(6), UTC, DEFAULT_MORNING_WINDOW)).toBe(0);
  });

  it("returns 0 when outside the window", () => {
    expect(minutesPastWindowStart(at(12), UTC, DEFAULT_MORNING_WINDOW)).toBe(0);
  });

  it("counts across the day boundary for a wrapping window", () => {
    const wrap: EnforcementWindow = {
      kind: "night",
      startMinute: 22 * 60,
      endMinute: 2 * 60,
    };
    expect(minutesPastWindowStart(at(23), UTC, wrap)).toBe(60);
    expect(minutesPastWindowStart(at(1), UTC, wrap)).toBe(180);
  });
});
