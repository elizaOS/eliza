/**
 * "last Friday" is the previous Friday. The date parser used to ignore the
 * past qualifier and return the coming Friday, so a calendar request landed
 * on the wrong day.
 */
import { describe, expect, it } from "vitest";
import { parseExplicitLocalDate } from "./request-time.js";

// Thursday 2026-10-15 12:00 in Seoul. The coming Friday is the 16th.
const NOW = new Date("2026-10-15T03:00:00.000Z");
const ZONE = "Asia/Seoul";
const lastFriday = { year: 2026, month: 10, day: 9 };

describe("parseExplicitLocalDate past weekdays", () => {
  it("reads a past weekday qualifier as the previous day, not the coming day", () => {
    for (const text of [
      "last Friday",
      "last friday",
      "previous Friday",
      "this past Friday",
      "past Friday",
      "cancel my haircut last Friday",
      "last Friday in the afternoon",
    ]) {
      expect(parseExplicitLocalDate(text, ZONE, NOW), text).toEqual(lastFriday);
    }
    expect(parseExplicitLocalDate("last Monday", ZONE, NOW)).toEqual({
      year: 2026,
      month: 10,
      day: 12,
    });
  });

  it("on that weekday, last means seven days earlier, not today", () => {
    const fridayNoon = new Date("2026-10-16T03:00:00.000Z");
    expect(parseExplicitLocalDate("last Friday", ZONE, fridayNoon)).toEqual(
      lastFriday,
    );
    expect(parseExplicitLocalDate("Friday", ZONE, fridayNoon)).toEqual({
      year: 2026,
      month: 10,
      day: 16,
    });
  });

  it("crosses into the previous month", () => {
    // Thursday 2026-10-01 12:00 in Seoul. The previous Friday is September 25.
    const octoberFirst = new Date("2026-10-01T03:00:00.000Z");
    expect(parseExplicitLocalDate("last Friday", ZONE, octoberFirst)).toEqual({
      year: 2026,
      month: 9,
      day: 25,
    });
  });

  it("does not read the final Friday of a named month as the previous Friday", () => {
    for (const text of [
      "last Friday of October",
      "the last Friday of the month",
      "last Friday in October",
      "last Friday of next month",
      "last Friday this month",
    ]) {
      expect(parseExplicitLocalDate(text, ZONE, NOW), text).toBeNull();
    }
  });

  it("keeps a bare weekday, next weekday, and a word that only contains last", () => {
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
    expect(parseExplicitLocalDate("this friday", ZONE, NOW)).toEqual({
      year: 2026,
      month: 10,
      day: 16,
    });
    expect(parseExplicitLocalDate("lastfriday", ZONE, NOW)).toBeNull();
    expect(parseExplicitLocalDate("금요일", ZONE, NOW)).toEqual({
      year: 2026,
      month: 10,
      day: 16,
    });
    expect(parseExplicitLocalDate("下周五", ZONE, NOW)).toEqual({
      year: 2026,
      month: 10,
      day: 23,
    });
    expect(parseExplicitLocalDate("지난 금요일", ZONE, NOW)).toBeNull();
  });
});
