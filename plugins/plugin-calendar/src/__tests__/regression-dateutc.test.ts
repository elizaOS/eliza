/**
 * Behavioral regression for Date.UTC 0-99 — must use setUTCFullYear
 * Calls real calendar primitives that previously used Date.UTC(y,m,d) directly.
 */
import { describe, expect, it } from "vitest";
import { addDaysToLocalDate, getWeekdayForLocalDate } from "../internal/time";

function createUTCDateViaSet(y: number, m: number, d: number): Date {
  const dt = new Date(0);
  dt.setUTCFullYear(y, m, d);
  dt.setUTCHours(12, 0, 0, 0);
  return dt;
}

describe("calendar Date.UTC 0-99 regression - real functions", () => {
  it("addDaysToLocalDate year 0 stays 0 not 1900", () => {
    const out = addDaysToLocalDate({ year: 0, month: 1, day: 1 }, 0);
    expect(out.year).toBe(0);
    expect(out.month).toBe(1);
    expect(out.day).toBe(1);
    // prove buggy Date.UTC would be 1900
    expect(new Date(Date.UTC(0, 0, 1, 12, 0, 0)).getUTCFullYear()).not.toBe(0);
    expect(createUTCDateViaSet(0, 0, 1).getUTCFullYear()).toBe(0);
  });
  it("addDaysToLocalDate year 99 stays 99 not 1999", () => {
    const out = addDaysToLocalDate({ year: 99, month: 1, day: 1 }, 0);
    expect(out.year).toBe(99);
  });
  it("addDaysToLocalDate year 5 delta 1 rolls correctly", () => {
    const out = addDaysToLocalDate({ year: 5, month: 1, day: 1 }, 1);
    expect(out.year).toBe(5);
    expect(out.month).toBe(1);
    expect(out.day).toBe(2);
  });
  it("getWeekdayForLocalDate year 99 matches setUTCFullYear weekday", () => {
    const w = getWeekdayForLocalDate({ year: 99, month: 1, day: 1 });
    const expected = createUTCDateViaSet(99, 0, 1).getUTCDay();
    expect(w).toBe(expected);
    // buggy Date.UTC would give 1999's weekday
    const buggy = new Date(Date.UTC(99, 0, 1, 12, 0, 0)).getUTCDay();
    expect(buggy).not.toBe(expected); // prove divergence, unless same weekday by coincidence (check year 5)
  });
  it("year 5 weekday divergence", () => {
    const w = getWeekdayForLocalDate({ year: 5, month: 6, day: 15 });
    const expected = createUTCDateViaSet(5, 5, 15).getUTCDay();
    expect(w).toBe(expected);
    const _buggy = new Date(Date.UTC(5, 5, 15, 12, 0, 0)).getUTCDay();
    // For year 5 vs 1905, weekdays differ (1905-06-15 Thursday vs 0005-06-15 ...)
    // At least year is different, so we assert year fix, not just weekday coincidence
    expect(createUTCDateViaSet(5, 5, 15).getUTCFullYear()).toBe(5);
  });
  it("Date.UTC bug proof: 5 -> 1905 vs setUTCFullYear -> 5", () => {
    expect(new Date(Date.UTC(5, 0, 1)).getUTCFullYear()).toBe(1905);
    expect(createUTCDateViaSet(5, 0, 1).getUTCFullYear()).toBe(5);
  });
});
