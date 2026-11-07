/**
 * "a week from Friday" is the Friday after the coming one. The date parser
 * used to stop at the weekday (or at "tomorrow") and drop the offset, so a
 * calendar request landed a week early.
 */
import { describe, expect, it } from "vitest";
import { parseExplicitLocalDate } from "./request-time.js";

// Thursday 2026-10-15 12:00 in Seoul. "Friday" and "tomorrow" are the 16th.
const NOW = new Date("2026-10-15T03:00:00.000Z");
const ZONE = "Asia/Seoul";

describe("parseExplicitLocalDate offset from an anchor day", () => {
  it("adds days or weeks stated before the anchor instead of using the anchor day", () => {
    expect(parseExplicitLocalDate("a week from Friday", ZONE, NOW)).toEqual({
      year: 2026,
      month: 10,
      day: 23,
    });
    expect(parseExplicitLocalDate("two weeks from Friday", ZONE, NOW)).toEqual({
      year: 2026,
      month: 10,
      day: 30,
    });
    expect(parseExplicitLocalDate("3 days from Monday", ZONE, NOW)).toEqual({
      year: 2026,
      month: 10,
      day: 22,
    });
    expect(parseExplicitLocalDate("a week from tomorrow", ZONE, NOW)).toEqual({
      year: 2026,
      month: 10,
      day: 23,
    });
    expect(
      parseExplicitLocalDate("a week from next Friday", ZONE, NOW),
    ).toEqual({
      year: 2026,
      month: 10,
      day: 30,
    });
    expect(parseExplicitLocalDate("a week from March 15", ZONE, NOW)).toEqual({
      year: 2026,
      month: 3,
      day: 22,
    });
    expect(parseExplicitLocalDate("a week from 2026-10-20", ZONE, NOW)).toEqual(
      {
        year: 2026,
        month: 10,
        day: 27,
      },
    );
  });

  it("keeps a bare weekday, next weekday, and a week from today", () => {
    expect(parseExplicitLocalDate("Friday", ZONE, NOW)).toEqual({
      year: 2026,
      month: 10,
      day: 16,
    });
    expect(parseExplicitLocalDate("next friday", ZONE, NOW)).toEqual({
      year: 2026,
      month: 10,
      day: 23,
    });
    expect(parseExplicitLocalDate("a week from today", ZONE, NOW)).toEqual({
      year: 2026,
      month: 10,
      day: 22,
    });
    expect(parseExplicitLocalDate("in 2 days", ZONE, NOW)).toEqual({
      year: 2026,
      month: 10,
      day: 17,
    });
  });
});
