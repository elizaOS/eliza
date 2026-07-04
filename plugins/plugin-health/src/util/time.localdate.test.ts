/**
 * Unit test for the IANA-timezone date arithmetic helpers (local-date add,
 * minute add, UTC-from-local-parts, RFC-3339 formatting). Pure, deterministic.
 */
import { describe, expect, it } from "vitest";
import {
  addDaysToLocalDate,
  addMinutes,
  buildUtcDateFromLocalParts,
  formatInstantAsRfc3339InTimeZone,
  getLocalDateKey,
  getTimeZoneOffsetMinutes,
  getWeekdayForLocalDate,
  getZonedDateParts,
} from "./time.js";

// #8795 — every sleep/bedtime/circadian computation in plugin-health rests on
// these timezone primitives; a tz/DST bug here silently shifts wake windows.
// Intl is deterministic given (instant, zone), so pin the conversions.

const noonUtcJan = new Date("2026-01-15T12:00:00Z");
const noonUtcJul = new Date("2026-07-15T12:00:00Z");

describe("getZonedDateParts", () => {
  it("projects a UTC instant into wall-clock parts for the zone", () => {
    expect(getZonedDateParts(noonUtcJan, "UTC")).toEqual({
      year: 2026,
      month: 1,
      day: 15,
      hour: 12,
      minute: 0,
      second: 0,
    });
    // EST is UTC-5 in January → 07:00 local.
    expect(getZonedDateParts(noonUtcJan, "America/New_York")).toMatchObject({
      day: 15,
      hour: 7,
    });
  });
});

describe("getTimeZoneOffsetMinutes", () => {
  it("returns 0 for UTC and signed minutes elsewhere, DST-aware", () => {
    expect(getTimeZoneOffsetMinutes(noonUtcJan, "UTC")).toBe(0);
    expect(getTimeZoneOffsetMinutes(noonUtcJan, "America/New_York")).toBe(-300); // EST
    expect(getTimeZoneOffsetMinutes(noonUtcJul, "America/New_York")).toBe(-240); // EDT
  });

  it("parses half-hour offsets (Asia/Kolkata = +05:30)", () => {
    expect(getTimeZoneOffsetMinutes(noonUtcJan, "Asia/Kolkata")).toBe(330);
  });
});

describe("buildUtcDateFromLocalParts (inverse of getZonedDateParts)", () => {
  it("round-trips wall-clock parts back to the correct UTC instant", () => {
    const parts = {
      year: 2026,
      month: 1,
      day: 15,
      hour: 7,
      minute: 0,
      second: 0,
    };
    const utc = buildUtcDateFromLocalParts("America/New_York", parts);
    expect(utc.toISOString()).toBe("2026-01-15T12:00:00.000Z");
    expect(getZonedDateParts(utc, "America/New_York")).toEqual(parts);
  });
});

describe("formatInstantAsRfc3339InTimeZone", () => {
  it("emits a zoned RFC-3339 string with the correct offset token", () => {
    expect(
      formatInstantAsRfc3339InTimeZone(noonUtcJan, "America/New_York"),
    ).toBe("2026-01-15T07:00:00-05:00");
    expect(formatInstantAsRfc3339InTimeZone(noonUtcJan, "UTC")).toBe(
      "2026-01-15T12:00:00+00:00",
    );
  });

  it("throws on an invalid datetime rather than emitting NaN", () => {
    expect(() =>
      formatInstantAsRfc3339InTimeZone("not-a-date", "UTC"),
    ).toThrow();
  });
});

describe("local-date arithmetic + keys", () => {
  it("addDaysToLocalDate rolls across month and year boundaries", () => {
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

  it("getWeekdayForLocalDate matches UTC day-of-week (epoch = Thursday = 4)", () => {
    expect(getWeekdayForLocalDate({ year: 1970, month: 1, day: 1 })).toBe(4);
  });

  it("getLocalDateKey zero-pads to YYYY-MM-DD", () => {
    expect(getLocalDateKey({ year: 2026, month: 3, day: 5 })).toBe(
      "2026-03-05",
    );
  });

  it("addMinutes shifts an instant by whole minutes", () => {
    expect(addMinutes(new Date("2026-01-01T00:00:00Z"), 90).toISOString()).toBe(
      "2026-01-01T01:30:00.000Z",
    );
  });
});
