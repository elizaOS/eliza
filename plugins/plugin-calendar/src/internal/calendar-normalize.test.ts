/**
 * Unit tests for the Z/offset path of `normalizeCalendarDateTimeInTimeZone`.
 * JavaScript's `Date.parse` silently rolls over impossible dates like
 * 2026-02-30 to March 2; the helper must reject those before they reach the
 * pipeline (#19222).
 */
import { describe, expect, it } from "vitest";
import { normalizeCalendarDateTimeInTimeZone } from "./calendar-normalize.js";
import { CalendarServiceError } from "./errors.js";

const expectInvalidDate = (
  text: string,
  field: string,
): CalendarServiceError => {
  try {
    normalizeCalendarDateTimeInTimeZone(text, field, "UTC");
  } catch (error) {
    expect(error).toBeInstanceOf(CalendarServiceError);
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
