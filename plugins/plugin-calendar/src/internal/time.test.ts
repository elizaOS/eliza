/**
 * Unit tests for the timezone-aware date primitives (zoned parts, offset lookup,
 * local-date arithmetic), including DST-boundary behaviour. Pure functions, no
 * runtime.
 */
import { describe, expect, it } from "vitest";
import {
  addDaysToLocalDate,
  addMinutes,
  buildUtcDateFromLocalParts,
  getTimeZoneOffsetMinutes,
  getWeekdayForLocalDate,
  getZonedDateParts,
} from "./time.js";

/**
 * Pure IANA-timezone date math behind calendar event normalization. Tested with
 * fixed instants and fixed-offset zones (UTC, Honolulu) plus an explicit
 * DST-aware New York case, so assertions don't drift with the host clock.
 */

const NOON_UTC = new Date(Date.UTC(2026, 5, 15, 12, 0, 0)); // 2026-06-15 12:00Z

describe("getZonedDateParts", () => {
  it("reads wall-clock parts in the target timezone", () => {
    expect(getZonedDateParts(NOON_UTC, "UTC")).toEqual({
      year: 2026,
      month: 6,
      day: 15,
      hour: 12,
      minute: 0,
      second: 0,
    });
    // Honolulu is UTC-10 year-round → 02:00 local.
    expect(getZonedDateParts(NOON_UTC, "Pacific/Honolulu").hour).toBe(2);
    // New York in June is EDT (UTC-4) → 08:00 local.
    expect(getZonedDateParts(NOON_UTC, "America/New_York").hour).toBe(8);
  });
});

describe("getTimeZoneOffsetMinutes", () => {
  it("returns 0 for UTC and the fixed Honolulu offset", () => {
    expect(getTimeZoneOffsetMinutes(NOON_UTC, "UTC")).toBe(0);
    expect(getTimeZoneOffsetMinutes(NOON_UTC, "Pacific/Honolulu")).toBe(-600);
  });

  it("reflects DST for New York (EDT in June, EST in January)", () => {
    expect(getTimeZoneOffsetMinutes(NOON_UTC, "America/New_York")).toBe(-240);
    const janNoonUtc = new Date(Date.UTC(2026, 0, 15, 12, 0, 0));
    expect(getTimeZoneOffsetMinutes(janNoonUtc, "America/New_York")).toBe(-300);
  });
});

describe("buildUtcDateFromLocalParts", () => {
  it("round-trips local parts → UTC → local parts", () => {
    for (const tz of ["UTC", "Pacific/Honolulu", "America/New_York"]) {
      const local = {
        year: 2026,
        month: 6,
        day: 15,
        hour: 9,
        minute: 30,
        second: 0,
      };
      const utc = buildUtcDateFromLocalParts(tz, local);
      expect(getZonedDateParts(utc, tz)).toEqual(local);
    }
  });
});

describe("addDaysToLocalDate", () => {
  it("rolls over month and year boundaries", () => {
    expect(addDaysToLocalDate({ year: 2026, month: 1, day: 31 }, 1)).toEqual({
      year: 2026,
      month: 2,
      day: 1,
    });
    expect(addDaysToLocalDate({ year: 2026, month: 12, day: 31 }, 1)).toEqual({
      year: 2027,
      month: 1,
      day: 1,
    });
    expect(addDaysToLocalDate({ year: 2026, month: 3, day: 1 }, -1)).toEqual({
      year: 2026,
      month: 2,
      day: 28,
    });
  });

  it("is a no-op for delta 0", () => {
    expect(addDaysToLocalDate({ year: 2026, month: 6, day: 15 }, 0)).toEqual({
      year: 2026,
      month: 6,
      day: 15,
    });
  });
});

describe("getWeekdayForLocalDate", () => {
  it("matches the reference UTC weekday and advances cyclically", () => {
    const ref = new Date("2026-06-15T12:00:00Z").getUTCDay();
    expect(getWeekdayForLocalDate({ year: 2026, month: 6, day: 15 })).toBe(ref);
    expect(getWeekdayForLocalDate({ year: 2026, month: 6, day: 22 })).toBe(ref);
    expect(getWeekdayForLocalDate({ year: 2026, month: 6, day: 16 })).toBe(
      (ref + 1) % 7,
    );
  });
});

describe("addMinutes", () => {
  it("shifts an instant by the given minutes", () => {
    expect(addMinutes(NOON_UTC, 90).toISOString()).toBe(
      "2026-06-15T13:30:00.000Z",
    );
    expect(addMinutes(NOON_UTC, -120).toISOString()).toBe(
      "2026-06-15T10:00:00.000Z",
    );
  });
});
