/**
 * Exercises the owner daily-window resolution in window-bounds.ts against
 * real owner-facts inputs: default fallback for absent values, malformed-value
 * rejection through the canonical local-time parser, degenerate same-start/end
 * windows, midnight-wrapping segment splitting, derived-gap overlap
 * suppression, and minute-of-day formatting.
 */

import { describe, expect, it } from "vitest";

import { InvalidLocalTimeError } from "./local-time.js";
import type { OwnerFactsView } from "./types.js";
import {
  formatLocalHHMM,
  resolveOwnerWindowBoundsMinutes,
  resolveOwnerWindowSegments,
} from "./window-bounds.js";

function facts(
  windows: Pick<OwnerFactsView, "morningWindow" | "eveningWindow">,
): OwnerFactsView {
  return { ...windows };
}

describe("resolveOwnerWindowBoundsMinutes", () => {
  it("falls back to the scheduling defaults when no windows are configured", () => {
    expect(resolveOwnerWindowBoundsMinutes(facts({}))).toEqual({
      morningStart: 360,
      morningEnd: 660,
      eveningStart: 1080,
      eveningEnd: 1320,
    });
  });

  it("uses configured values over the defaults", () => {
    expect(
      resolveOwnerWindowBoundsMinutes(
        facts({
          morningWindow: { start: "05:15", end: "09:45" },
          eveningWindow: { start: "17:30", end: "23:05" },
        }),
      ),
    ).toEqual({
      morningStart: 315,
      morningEnd: 585,
      eveningStart: 1050,
      eveningEnd: 1385,
    });
  });

  it("keeps the default for an individual bound left unset", () => {
    expect(
      resolveOwnerWindowBoundsMinutes(
        facts({ morningWindow: { start: "07:00" } }),
      ),
    ).toEqual({
      morningStart: 420,
      morningEnd: 660,
      eveningStart: 1080,
      eveningEnd: 1320,
    });
  });

  it("rejects a malformed bound instead of silently applying a default", () => {
    const read = () =>
      resolveOwnerWindowBoundsMinutes(
        facts({ morningWindow: { start: "7:00", end: "11:00" } }),
      );
    expect(read).toThrow(InvalidLocalTimeError);
    try {
      read();
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidLocalTimeError);
      const invalid = error as InvalidLocalTimeError;
      expect(invalid.reason).toBe("malformed_hhmm");
      expect(invalid.localTime).toBe("7:00");
    }
  });

  it("treats a zero-length morning window as malformed and restores both defaults", () => {
    expect(
      resolveOwnerWindowBoundsMinutes(
        facts({
          morningWindow: { start: "06:00", end: "06:00" },
          eveningWindow: { start: "20:00", end: "21:00" },
        }),
      ),
    ).toEqual({
      morningStart: 360,
      morningEnd: 660,
      eveningStart: 1200,
      eveningEnd: 1260,
    });
  });

  it("treats a zero-length evening window as malformed and restores both defaults", () => {
    expect(
      resolveOwnerWindowBoundsMinutes(
        facts({
          morningWindow: { start: "07:00", end: "08:00" },
          eveningWindow: { start: "22:00", end: "22:00" },
        }),
      ),
    ).toEqual({
      morningStart: 420,
      morningEnd: 480,
      eveningStart: 1080,
      eveningEnd: 1320,
    });
  });

  it("keeps an end-before-start window because it wraps past midnight", () => {
    expect(
      resolveOwnerWindowBoundsMinutes(
        facts({
          eveningWindow: { start: "22:00", end: "02:00" },
        }),
      ),
    ).toEqual({
      morningStart: 360,
      morningEnd: 660,
      eveningStart: 1320,
      eveningEnd: 120,
    });
  });
});

describe("resolveOwnerWindowSegments", () => {
  it("returns no segments for an unknown window key", () => {
    expect(resolveOwnerWindowSegments("bogus", facts({}))).toEqual([]);
  });

  it("resolves the default morning window to one non-wrapping segment", () => {
    expect(resolveOwnerWindowSegments("morning", facts({}))).toEqual([
      { name: "morning", start: 360, end: 660 },
    ]);
  });

  it("splits a midnight-wrapping evening window into two segments", () => {
    const segments = resolveOwnerWindowSegments(
      "evening",
      facts({ eveningWindow: { start: "22:00", end: "02:00" } }),
    );
    expect(segments).toEqual([
      { name: "evening", start: 1320, end: 1440 },
      { name: "evening", start: 0, end: 120 },
    ]);
  });

  it("keeps the night gap beside a wrapping evening window without overlap", () => {
    const segments = resolveOwnerWindowSegments(
      "night",
      facts({ eveningWindow: { start: "22:00", end: "02:00" } }),
    );
    expect(segments).toEqual([{ name: "night", start: 120, end: 360 }]);
  });

  it("drops the derived afternoon gap when it overlaps an explicit window", () => {
    const owner = facts({
      morningWindow: { start: "00:00", end: "14:00" },
      eveningWindow: { start: "13:00", end: "20:00" },
    });
    expect(resolveOwnerWindowSegments("afternoon", owner)).toEqual([]);
  });

  it("keeps the derived afternoon gap between disjoint explicit windows", () => {
    const owner = facts({
      morningWindow: { start: "06:00", end: "11:00" },
      eveningWindow: { start: "18:00", end: "22:00" },
    });
    expect(resolveOwnerWindowSegments("afternoon", owner)).toEqual([
      { name: "afternoon", start: 660, end: 1080 },
    ]);
  });

  it("composes compound keys from their parts in order", () => {
    const owner = facts({});
    expect(resolveOwnerWindowSegments("morning_or_night", owner)).toEqual([
      { name: "morning", start: 360, end: 660 },
      { name: "night", start: 1320, end: 1440 },
      { name: "night", start: 0, end: 360 },
    ]);
    expect(resolveOwnerWindowSegments("morning_or_evening", owner)).toEqual([
      { name: "morning", start: 360, end: 660 },
      { name: "evening", start: 1080, end: 1320 },
    ]);
  });
});

describe("formatLocalHHMM", () => {
  it("zero-pads hours and minutes", () => {
    expect(formatLocalHHMM(0)).toBe("00:00");
    expect(formatLocalHHMM(360)).toBe("06:00");
    expect(formatLocalHHMM(605)).toBe("10:05");
    expect(formatLocalHHMM(1439)).toBe("23:59");
  });
});
