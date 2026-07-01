import { describe, expect, it } from "vitest";
import { parseExplicitLocalDate } from "../src/actions/calendar-handler.js";
import { addDaysToLocalDate, getZonedDateParts } from "../src/internal/time.js";

/**
 * Relative-date phrasing coverage (#8795). The deterministic date resolver used
 * by the CALENDAR action previously returned null for "today"/"tomorrow"/"in N
 * days" — the exact everyday phrasing in the action's own examples ("Schedule a
 * meeting with Alex at 3pm tomorrow") — forcing an avoidable LLM round-trip.
 * These assert the offsets relative to "today" in a fixed timezone, computed
 * with the same time helpers the resolver uses so the test is clock-independent.
 */
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
