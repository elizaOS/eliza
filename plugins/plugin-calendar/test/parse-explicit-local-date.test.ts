/**
 * Covers relative-date phrasing for the deterministic CALENDAR date resolver.
 * The assertions compute expected local dates through the same timezone helpers
 * the resolver uses, so they stay clock-independent while guarding everyday
 * phrases like "tomorrow" and "in ten days."
 */
import { describe, expect, it } from "vitest";
import { parseExplicitLocalDate } from "../src/actions/calendar-handler.js";
import { addDaysToLocalDate, getZonedDateParts } from "../src/internal/time.js";

const TZ = "America/New_York";

function expectedFromToday(offset: number) {
  const today = getZonedDateParts(new Date(), TZ);
  const { year, month, day } = addDaysToLocalDate(
    { year: today.year, month: today.month, day: today.day },
    offset,
  );
  return { year, month, day };
}

describe("parseExplicitLocalDate — relative phrasing (#8795)", () => {
  it.each([
    ["today", 0],
    ["tomorrow", 1],
    ["yesterday", -1],
    ["day after tomorrow", 2],
    ["day before yesterday", -2],
    ["in 3 days", 3],
    ["in 1 day", 1],
    ["in 2 weeks", 14],
    ["a week from today", 7],
    ["two days from now", 2],
    ["in ten days", 10],
  ])("resolves %j to today%+d", (phrase, offset) => {
    expect(parseExplicitLocalDate(phrase, TZ)).toEqual(
      expectedFromToday(offset),
    );
  });

  it("resolves relative phrasing embedded in a fuller request", () => {
    expect(
      parseExplicitLocalDate("schedule a dentist appointment tomorrow", TZ),
    ).toEqual(expectedFromToday(1));
  });

  it("does not match '3 days from today' as the bare word 'today'", () => {
    // The N-count pattern must win over the bare 'today' word.
    expect(parseExplicitLocalDate("3 days from today", TZ)).toEqual(
      expectedFromToday(3),
    );
  });

  it("still prefers an explicit ISO date over relative words", () => {
    expect(parseExplicitLocalDate("2030-01-15 (tomorrow-ish)", TZ)).toEqual({
      year: 2030,
      month: 1,
      day: 15,
    });
  });

  it("returns null when there is no resolvable date", () => {
    expect(parseExplicitLocalDate("sometime soon maybe", TZ)).toBeNull();
    expect(parseExplicitLocalDate("", TZ)).toBeNull();
  });
});
