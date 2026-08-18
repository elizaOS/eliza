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
