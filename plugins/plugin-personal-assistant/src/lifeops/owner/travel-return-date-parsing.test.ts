/**
 * Regression coverage for `parseTravelReturnIso` (internal to
 * `extractProfileDetails`), which turns a free-text return-date phrase like
 * "until July 20" into a bounded ISO end for the owner's travel window.
 *
 * Two bugs fixed here:
 *   1. `Date.parse("July 20")` never returns NaN -- absent a year it
 *      silently substitutes a fixed placeholder year (2001 in V8) instead of
 *      failing, so the "no year given, use the current year" fallback was
 *      dead code. Every bare "Month Day" phrase fell straight into the
 *      "resolve to next year" branch, even when the date was still upcoming
 *      this year, almost always exceeding the 30-day travel horizon and
 *      silently discarding the user's stated return date.
 *   2. A bare `YYYY-MM-DD` string parses as UTC midnight while a
 *      `Month Day, Year` string parses as LOCAL midnight -- the same
 *      intended calendar day could land a day earlier depending on which
 *      literal form the user (or an upstream LLM) happened to use, in any
 *      timezone west of UTC.
 *   3. `new Date(year, month - 1, day)` normalizes an impossible calendar
 *      date (Feb 29 on a non-leap year, month 13, day 0) into a real one
 *      instead of rejecting it, and remaps a 4-digit year under 100 to
 *      1900-1999 (legacy two-digit-year behavior) -- both silently persist
 *      a fabricated travel end date instead of failing.
 */
import { afterEach, describe, expect, it } from "vitest";
import { extractProfileDetails } from "./profile-extraction-evaluator.ts";

const ORIGINAL_TZ = process.env.TZ;

afterEach(() => {
  process.env.TZ = ORIGINAL_TZ;
});

function travelEndIso(text: string, now: Date): string | undefined {
  const travel = extractProfileDetails(text, now).travel;
  return travel?.kind === "set" ? travel.endIso : undefined;
}

describe("parseTravelReturnIso — year resolution", () => {
  it("a bare month/day still upcoming this year (and within the horizon) resolves to THIS year, not next", () => {
    process.env.TZ = "UTC";
    const now = new Date("2026-07-05T12:00:00.000Z");
    const endIso = travelEndIso("I'm traveling until July 20", now);
    expect(endIso).toBe("2026-07-20T00:00:00.000Z");
  });

  it("a bare month/day already past this year rolls over to next year when still within the horizon", () => {
    process.env.TZ = "UTC";
    const now = new Date("2026-12-28T12:00:00.000Z");
    const endIso = travelEndIso("I'm traveling until Jan 5", now);
    expect(endIso).toBe("2027-01-05T00:00:00.000Z");
  });

  it("a bare month/day already past this year AND beyond the horizon next year is discarded, not misdated", () => {
    process.env.TZ = "UTC";
    const now = new Date("2026-08-15T12:00:00.000Z");
    // "July 20" already passed this year; next year's July 20 is ~11 months
    // away, past the 30-day horizon -- must fall back to undefined, never a
    // date silently a year later than the user meant.
    const endIso = travelEndIso("I'm traveling until July 20", now);
    expect(endIso).toBeUndefined();
  });
});

describe("parseTravelReturnIso — ISO date-only reads as a local calendar date", () => {
  it("matches the local day a month-name phrase would produce, in a UTC- timezone", () => {
    process.env.TZ = "America/Los_Angeles";
    const now = new Date("2026-07-01T12:00:00.000Z");
    const isoForm = travelEndIso("I'm traveling until 2026-07-20", now);
    const nameForm = travelEndIso("I'm traveling until July 20, 2026", now);
    expect(isoForm).toBe(nameForm);
    // Local PDT midnight on 2026-07-20 is 07:00 UTC, not 00:00 UTC.
    expect(isoForm).toBe("2026-07-20T07:00:00.000Z");
  });

  it("matches the local day a month-name phrase would produce, in a UTC+ timezone", () => {
    process.env.TZ = "Asia/Tokyo";
    const now = new Date("2026-07-01T12:00:00.000Z");
    const isoForm = travelEndIso("I'm traveling until 2026-07-20", now);
    const nameForm = travelEndIso("I'm traveling until July 20, 2026", now);
    expect(isoForm).toBe(nameForm);
    // Local JST midnight on 2026-07-20 is the previous UTC day.
    expect(isoForm).toBe("2026-07-19T15:00:00.000Z");
  });
});

describe("parseTravelReturnIso — unaffected cases stay unaffected", () => {
  it("an explicit past year is discarded, not bumped forward", () => {
    process.env.TZ = "UTC";
    const now = new Date("2026-06-01T12:00:00.000Z");
    const endIso = travelEndIso("I'm traveling until July 20 2020", now);
    expect(endIso).toBeUndefined();
  });

  it("no return-date phrase at all still opens an open-ended travel signal", () => {
    process.env.TZ = "UTC";
    const now = new Date("2026-06-01T12:00:00.000Z");
    const travel = extractProfileDetails("I'm traveling", now).travel;
    expect(travel).toEqual({ kind: "set" });
  });
});

describe("parseTravelReturnIso — impossible calendar dates are rejected, not normalized", () => {
  it("Feb 29 on a non-leap year is rejected", () => {
    process.env.TZ = "UTC";
    const now = new Date("2025-02-10T12:00:00.000Z");
    expect(travelEndIso("I'm traveling until 2025-02-29", now)).toBeUndefined();
  });

  it("control: a real nearby date through the same phrase shape still resolves (proves the pipeline itself works)", () => {
    process.env.TZ = "UTC";
    const now = new Date("2025-02-10T12:00:00.000Z");
    expect(travelEndIso("I'm traveling until 2025-03-01", now)).toBe(
      "2025-03-01T00:00:00.000Z",
    );
  });

  it("Feb 29 on an actual leap year is accepted", () => {
    process.env.TZ = "UTC";
    const now = new Date("2024-02-10T12:00:00.000Z");
    expect(travelEndIso("I'm traveling until 2024-02-29", now)).toBe(
      "2024-02-29T00:00:00.000Z",
    );
  });

  it("April 31 (April has 30 days) is rejected", () => {
    process.env.TZ = "UTC";
    const now = new Date("2026-04-10T12:00:00.000Z");
    expect(travelEndIso("I'm traveling until 2026-04-31", now)).toBeUndefined();
  });

  it("month 13 is rejected, not rolled into January of the next year", () => {
    process.env.TZ = "UTC";
    // `new Date(2026, 12, 1)` would silently roll to 2027-01-01 -- pick `now`
    // close enough to that wrong date that the 30-day horizon cap can't
    // coincidentally produce the same `undefined` result for the wrong
    // reason (masking a missing calendar-validity check).
    const now = new Date("2026-12-15T12:00:00.000Z");
    expect(travelEndIso("I'm traveling until 2026-13-01", now)).toBeUndefined();
  });

  it("month 00 is rejected, not rolled into December of the prior year", () => {
    process.env.TZ = "UTC";
    // `new Date(2026, -1, 15)` would silently roll to 2025-12-15.
    const now = new Date("2025-12-01T12:00:00.000Z");
    expect(travelEndIso("I'm traveling until 2026-00-15", now)).toBeUndefined();
  });

  it("day 00 is rejected", () => {
    process.env.TZ = "UTC";
    // `new Date(2026, 5, 0)` would silently roll to 2026-05-31 (day 0 of
    // June = last day of May).
    const now = new Date("2026-05-15T12:00:00.000Z");
    expect(travelEndIso("I'm traveling until 2026-06-00", now)).toBeUndefined();
  });

  it("a 4-digit year under 100 is rejected instead of being remapped to 19xx by the Date constructor's legacy two-digit-year rule", () => {
    process.env.TZ = "UTC";
    // `new Date(99, 5, 15)` remaps to local 1999-06-15 under the legacy
    // 0-99 -> 1900-1999 rule -- pick `now` near that wrong year so the
    // "past date, try next year" branch can't independently absorb this
    // instead of the round-trip check.
    const now = new Date("1999-06-01T12:00:00.000Z");
    expect(travelEndIso("I'm traveling until 0099-06-15", now)).toBeUndefined();
  });
});
