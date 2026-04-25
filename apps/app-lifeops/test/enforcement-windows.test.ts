import { describe, expect, it } from "vitest";
import {
  DEFAULT_MORNING_WINDOW,
  DEFAULT_NIGHT_WINDOW,
  getCurrentEnforcementWindow,
  isWithinEnforcementWindow,
  minutesPastWindowStart,
  type EnforcementWindow,
} from "../src/lifeops/enforcement-windows.js";

/**
 * Build a UTC Date whose local time in the given IANA zone is
 * (hour, minute). We avoid timezone libraries by constructing the UTC
 * instant and letting the formatter do the reverse conversion in tests.
 *
 * For "America/Los_Angeles" (UTC-8/UTC-7 depending on DST), we use a
 * date well inside standard time so offsets are stable across runners.
 */
function localDateInZone(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  zone: string,
): Date {
  // Iterate to find the UTC instant whose zone rendering matches.
  // Start with an approximation using the zone's offset from a probe date.
  const probe = new Date(Date.UTC(year, month - 1, day, hour, minute));
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
  let candidate = probe;
  for (let i = 0; i < 5; i++) {
    const parts = fmt.formatToParts(candidate);
    const get = (type: string) =>
      Number.parseInt(parts.find((p) => p.type === type)?.value ?? "0", 10);
    const h = get("hour") % 24;
    const m = get("minute");
    const diffMinutes = (hour - h) * 60 + (minute - m);
    if (diffMinutes === 0) return candidate;
    candidate = new Date(candidate.getTime() + diffMinutes * 60_000);
  }
  return candidate;
}

describe("enforcement-windows", () => {
  const LA = "America/Los_Angeles";

  describe("getCurrentEnforcementWindow", () => {
    it("returns morning window at 7am local", () => {
      const now = localDateInZone(2025, 1, 15, 7, 0, LA);
      const result = getCurrentEnforcementWindow(now, LA);
      expect(result.kind).toBe("morning");
    });

    it("returns none at 5am local (before morning window)", () => {
      const now = localDateInZone(2025, 1, 15, 5, 0, LA);
      const result = getCurrentEnforcementWindow(now, LA);
      expect(result.kind).toBe("none");
    });

    it("returns none at 11am local (after morning window)", () => {
      const now = localDateInZone(2025, 1, 15, 11, 0, LA);
      const result = getCurrentEnforcementWindow(now, LA);
      expect(result.kind).toBe("none");
    });

    it("returns night window at 10pm local", () => {
      const now = localDateInZone(2025, 1, 15, 22, 0, LA);
      const result = getCurrentEnforcementWindow(now, LA);
      expect(result.kind).toBe("night");
    });

    it("returns night window at 11:59pm local (midnight edge)", () => {
      const now = localDateInZone(2025, 1, 15, 23, 59, LA);
      const result = getCurrentEnforcementWindow(now, LA);
      expect(result.kind).toBe("night");
    });

    it("returns none at 00:00 local (past default night window end)", () => {
      const now = localDateInZone(2025, 1, 15, 0, 0, LA);
      const result = getCurrentEnforcementWindow(now, LA);
      expect(result.kind).toBe("none");
    });

    it("throws when timezone is invalid", () => {
      const now = new Date(Date.UTC(2025, 0, 15, 7, 0));
      expect(() => getCurrentEnforcementWindow(now, "Not/A_Real_Zone")).toThrow(
        RangeError,
      );
    });

    it("uses provided windows when supplied", () => {
      const custom: EnforcementWindow[] = [
        { kind: "morning", startMinute: 4 * 60, endMinute: 5 * 60 },
      ];
      const now = localDateInZone(2025, 1, 15, 4, 30, LA);
      const result = getCurrentEnforcementWindow(now, LA, custom);
      expect(result.kind).toBe("morning");
    });

    it("handles wrapping night window crossing midnight", () => {
      const wrap: EnforcementWindow[] = [
        { kind: "night", startMinute: 22 * 60, endMinute: 2 * 60 },
      ];
      const late = localDateInZone(2025, 1, 15, 23, 30, LA);
      const early = localDateInZone(2025, 1, 15, 1, 0, LA);
      const mid = localDateInZone(2025, 1, 15, 12, 0, LA);
      expect(getCurrentEnforcementWindow(late, LA, wrap).kind).toBe("night");
      expect(getCurrentEnforcementWindow(early, LA, wrap).kind).toBe("night");
      expect(getCurrentEnforcementWindow(mid, LA, wrap).kind).toBe("none");
    });
  });

  describe("isWithinEnforcementWindow", () => {
    it("returns false for none-kind window", () => {
      const now = new Date();
      expect(
        isWithinEnforcementWindow(now, LA, {
          kind: "none",
          startMinute: 0,
          endMinute: 0,
        }),
      ).toBe(false);
    });

    it("returns true inside the morning default", () => {
      const now = localDateInZone(2025, 1, 15, 8, 30, LA);
      expect(isWithinEnforcementWindow(now, LA, DEFAULT_MORNING_WINDOW)).toBe(
        true,
      );
    });
  });

  describe("minutesPastWindowStart", () => {
    it("returns 0 outside the window", () => {
      const now = localDateInZone(2025, 1, 15, 5, 0, LA);
      expect(minutesPastWindowStart(now, LA, DEFAULT_MORNING_WINDOW)).toBe(0);
    });

    it("returns elapsed minutes inside morning window", () => {
      const now = localDateInZone(2025, 1, 15, 7, 15, LA);
      expect(minutesPastWindowStart(now, LA, DEFAULT_MORNING_WINDOW)).toBe(75);
    });

    it("returns elapsed minutes inside night window", () => {
      const now = localDateInZone(2025, 1, 15, 21, 30, LA);
      expect(minutesPastWindowStart(now, LA, DEFAULT_NIGHT_WINDOW)).toBe(30);
    });
  });
});
