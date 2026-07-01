import { describe, expect, it } from "bun:test";
import {
  extractDayFromEvent,
  getGameDayNumber,
  toDateString,
  toSafeDayNumber,
} from "../../engine/src/utils/date-utils";

/**
 * Game date utilities. getGameDayNumber is 1-indexed and clamps pre-start
 * timestamps to day 1; toSafeDayNumber guards an int DB column; toDateString
 * extracts the YYYY-MM-DD portion. Off-by-one here mislabels every event's day.
 */

describe("getGameDayNumber", () => {
  const start = new Date("2026-06-23T00:00:00.000Z");

  it("is 1-indexed across day boundaries and clamps pre-start", () => {
    expect(getGameDayNumber(start, start)).toBe(1); // first instant = day 1
    expect(getGameDayNumber(start, new Date("2026-06-23T23:59:59Z"))).toBe(1);
    expect(getGameDayNumber(start, new Date("2026-06-24T00:00:00Z"))).toBe(2);
    expect(getGameDayNumber(start, new Date("2026-06-30T12:00:00Z"))).toBe(8);
    // before start → clamped to 1
    expect(getGameDayNumber(start, new Date("2026-06-20T00:00:00Z"))).toBe(1);
  });
});

describe("toSafeDayNumber", () => {
  it("accepts 1..int32-max, rejects out-of-range / non-finite", () => {
    expect(toSafeDayNumber(1)).toBe(1);
    expect(toSafeDayNumber(500)).toBe(500);
    expect(toSafeDayNumber(0)).toBeUndefined();
    expect(toSafeDayNumber(-5)).toBeUndefined();
    expect(toSafeDayNumber(Number.NaN)).toBeUndefined();
    expect(toSafeDayNumber(2_147_483_648)).toBeUndefined();
  });
});

describe("toDateString / extractDayFromEvent", () => {
  it("extracts the date portion + day number", () => {
    expect(toDateString(new Date("2026-06-23T15:30:00Z"))).toBe("2026-06-23");
    expect(toDateString("2026-06-23T00:00:00Z")).toBe("2026-06-23");
    expect(extractDayFromEvent({ day: 5 })).toBe(5);
    expect(extractDayFromEvent({})).toBe(0);
  });
});
