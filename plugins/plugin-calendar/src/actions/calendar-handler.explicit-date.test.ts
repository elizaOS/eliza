/**
 * Deterministic coverage for parseExplicitLocalDate's numeric branch: a bare
 * dash time range beside a named weekday ("friday 3-5") must resolve through
 * the weekday branch instead of being read as month/day, and impossible
 * month/day pairs (month 25, Feb 30) must fall through rather than roll over
 * (#21941). Real parser, no mocks; weekday expectations are computed relative
 * to the current date so the suite stays green on any day.
 */
import { describe, expect, it } from "vitest";
import { parseExplicitLocalDate } from "./calendar-handler.js";

const TZ = "America/New_York";

function weekdayOf(parts: { year: number; month: number; day: number }) {
  return new Date(
    Date.UTC(parts.year, parts.month - 1, parts.day, 12),
  ).getUTCDay();
}

describe("parseExplicitLocalDate numeric branch (#21941)", () => {
  it("resolves 'friday 3-5' via the weekday branch, not as March 5", () => {
    const result = parseExplicitLocalDate("schedule review friday 3-5", TZ);
    expect(result).toEqual(parseExplicitLocalDate("friday", TZ));
    if (result === null) throw new Error("expected a weekday-branch result");
    expect(weekdayOf(result)).toBe(5);
  });

  it("resolves 'friday 4-6' via the weekday branch, not as April 6", () => {
    const result = parseExplicitLocalDate("what do I have friday 4-6", TZ);
    expect(result).toEqual(parseExplicitLocalDate("friday", TZ));
    if (result === null) throw new Error("expected a weekday-branch result");
    expect(weekdayOf(result)).toBe(5);
  });

  it("rejects month 25 instead of rolling it over", () => {
    expect(parseExplicitLocalDate("lunch on 25/12", TZ)).toBeNull();
  });

  it("rejects Feb 30 rollover", () => {
    expect(parseExplicitLocalDate("review on 2/30/2026", TZ)).toBeNull();
  });

  it("still parses valid slash and dashed dates", () => {
    const year = new Date().getFullYear();
    expect(parseExplicitLocalDate("dinner on 12/25", TZ)).toMatchObject({
      month: 12,
      day: 25,
    });
    expect(parseExplicitLocalDate("meet on 3/5", TZ)).toMatchObject({
      year,
      month: 3,
      day: 5,
    });
    expect(parseExplicitLocalDate("party 3-5-2026", TZ)).toEqual({
      year: 2026,
      month: 3,
      day: 5,
    });
    expect(parseExplicitLocalDate("party 12/25/2026", TZ)).toEqual({
      year: 2026,
      month: 12,
      day: 25,
    });
  });

  it("keeps year-qualified dash dates winning even beside a weekday name", () => {
    expect(parseExplicitLocalDate("friday 3-5-2026", TZ)).toEqual({
      year: 2026,
      month: 3,
      day: 5,
    });
  });
});
