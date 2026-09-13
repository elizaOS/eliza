/**
 * Unit tests for `normalizeCalendarDateTimeInTimeZone`. Two invalid-input
 * grammars must both surface as a translatable `CalendarServiceError(400)`
 * rather than leaking a raw error past the CALENDAR action boundary: the
 * Z/offset path, where `Date.parse` silently rolls over impossible dates like
 * 2026-02-30 (#19222); and the offset-less local path, where an out-of-range
 * time-of-day (hour >= 24, minute >= 60, second >= 60) previously fell through
 * to `buildUtcDateFromLocalParts` and threw a bare `RangeError` (#27640).
 */
import { describe, expect, it } from "vitest";
import { normalizeCalendarDateTimeInTimeZone } from "./calendar-normalize.js";
import { CalendarServiceError } from "./errors.js";

const expectInvalidDate = (
  text: string,
  field: string,
  timeZone = "UTC",
): CalendarServiceError => {
  try {
    normalizeCalendarDateTimeInTimeZone(text, field, timeZone);
  } catch (error) {
    expect(error).toBeInstanceOf(CalendarServiceError);
    expect(error).not.toBeInstanceOf(RangeError);
    expect((error as CalendarServiceError).status).toBe(400);
    return error as CalendarServiceError;
  }
  throw new Error(
    `normalizeCalendarDateTimeInTimeZone(${JSON.stringify(text)}) should have failed`,
  );
};

describe("normalizeCalendarDateTimeInTimeZone — Z/offset path", () => {
  it("accepts a valid UTC ISO datetime", () => {
    expect(
      normalizeCalendarDateTimeInTimeZone(
        "2026-06-15T09:00:00Z",
        "startAt",
        "UTC",
      ),
    ).toBe("2026-06-15T09:00:00.000Z");
  });

  it("accepts a valid UTC ISO datetime with milliseconds", () => {
    expect(
      normalizeCalendarDateTimeInTimeZone(
        "2026-06-15T09:00:00.123Z",
        "startAt",
        "UTC",
      ),
    ).toBe("2026-06-15T09:00:00.123Z");
  });

  it("accepts a valid offset ISO datetime", () => {
    expect(
      normalizeCalendarDateTimeInTimeZone(
        "2026-06-15T11:00:00+02:00",
        "startAt",
        "UTC",
      ),
    ).toBe("2026-06-15T09:00:00.000Z");
  });

  it("rejects an impossible Feb 30 with Z suffix (#19222)", () => {
    expectInvalidDate("2026-02-30T09:00:00Z", "startAt");
  });

  it("rejects Feb 30 with explicit offset (#19222)", () => {
    expectInvalidDate("2026-02-30T09:00:00+00:00", "startAt");
  });

  it("rejects non-leap-year Feb 29 (#19222)", () => {
    expectInvalidDate("2026-02-29T09:00:00Z", "startAt");
  });

  it("accepts Feb 29 in a leap year", () => {
    expect(
      normalizeCalendarDateTimeInTimeZone(
        "2024-02-29T09:00:00Z",
        "startAt",
        "UTC",
      ),
    ).toBe("2024-02-29T09:00:00.000Z");
  });

  it("rejects April 31 with offset (#19222)", () => {
    expectInvalidDate("2026-04-31T09:00:00-05:00", "startAt");
  });

  it("rejects Feb 30 with compact positive offset (#19222)", () => {
    expectInvalidDate("2026-02-30T09:00:00+0000", "startAt");
  });

  it("rejects Feb 30 with compact negative offset (#19222)", () => {
    expectInvalidDate("2026-02-30T09:00:00-0500", "startAt");
  });

  it("accepts a valid compact offset datetime", () => {
    expect(
      normalizeCalendarDateTimeInTimeZone(
        "2026-06-15T09:00:00+0200",
        "startAt",
        "UTC",
      ),
    ).toBe("2026-06-15T07:00:00.000Z");
  });

  it("rejects an impossible month", () => {
    expectInvalidDate("2026-13-15T09:00:00Z", "startAt");
  });

  it("rejects an impossible day-of-month (day 32)", () => {
    expectInvalidDate("2026-01-32T09:00:00Z", "startAt");
  });
});

describe("normalizeCalendarDateTimeInTimeZone — offset-less time-of-day (#27640)", () => {
  // Before this fix an out-of-range local time-of-day fell through to
  // buildUtcDateFromLocalParts, which threw a bare RangeError blaming the
  // timezone. Only CalendarServiceError is translated at the action boundary,
  // so the RangeError escaped as an uncaught 500-class failure. Every
  // out-of-range field must now fail as a clean 400 like an impossible date.
  it("rejects hour 24 (ISO end-of-day is not accepted here)", () => {
    const error = expectInvalidDate("2024-06-05T24:00", "startAt");
    expect(error.message).toBe("startAt must be a valid ISO datetime");
  });

  it("rejects hour 25", () => {
    expectInvalidDate("2024-06-05T25:00", "startAt");
  });

  it("rejects hour 31", () => {
    expectInvalidDate("2024-06-05T31:00", "endAt");
  });

  it("rejects minute 60", () => {
    expectInvalidDate("2024-06-05T10:60", "startAt");
  });

  it("rejects minute 75", () => {
    expectInvalidDate("2024-06-05T10:75", "startAt");
  });

  it("rejects second 60", () => {
    expectInvalidDate("2024-06-05T10:00:60", "startAt");
  });

  it("rejects second 99", () => {
    expectInvalidDate("2024-06-05T10:00:99", "endAt");
  });

  it("rejects an out-of-range hour in a DST zone (America/New_York)", () => {
    expectInvalidDate("2024-06-05T25:00", "startAt", "America/New_York");
  });

  it("rejects an out-of-range minute in a DST zone (America/New_York)", () => {
    expectInvalidDate("2024-06-05T10:75", "startAt", "America/New_York");
  });

  it("rejects an out-of-range second in a DST zone (America/New_York)", () => {
    expectInvalidDate("2024-06-05T10:00:99", "endAt", "America/New_York");
  });

  it("still accepts the last valid wall time 23:59:59 in UTC", () => {
    expect(
      normalizeCalendarDateTimeInTimeZone(
        "2024-06-05T23:59:59",
        "startAt",
        "UTC",
      ),
    ).toBe("2024-06-05T23:59:59.000Z");
  });

  it("still accepts midnight 00:00:00 in UTC", () => {
    expect(
      normalizeCalendarDateTimeInTimeZone(
        "2024-06-05T00:00:00",
        "startAt",
        "UTC",
      ),
    ).toBe("2024-06-05T00:00:00.000Z");
  });

  it("still resolves the last valid wall time in a DST zone", () => {
    expect(
      normalizeCalendarDateTimeInTimeZone(
        "2024-06-05T23:59:59",
        "startAt",
        "America/New_York",
      ),
    ).toBe("2024-06-06T03:59:59.000Z");
  });

  it("still resolves midnight in a standard-time DST zone offset", () => {
    expect(
      normalizeCalendarDateTimeInTimeZone(
        "2024-01-15T00:00:00",
        "startAt",
        "America/New_York",
      ),
    ).toBe("2024-01-15T05:00:00.000Z");
  });

  it("still resolves a leap-day local datetime without time-of-day", () => {
    expect(
      normalizeCalendarDateTimeInTimeZone(
        "2024-02-29T10:00",
        "startAt",
        "America/New_York",
      ),
    ).toBe("2024-02-29T15:00:00.000Z");
  });

  it("still rejects an out-of-range hour carrying a Z suffix as a clean 400", () => {
    expectInvalidDate("2024-06-05T25:00:00Z", "startAt");
  });
});
