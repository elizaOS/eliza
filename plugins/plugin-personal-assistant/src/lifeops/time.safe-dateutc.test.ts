/**
 * Behavioral regression for PA Date.UTC years 0-99 — calls real exports.
 */

import { utcDateMs } from "@elizaos/core/utils/utcDateMs";
import { describe, expect, it } from "vitest";
import { addDaysToLocalDate, getWeekdayForLocalDate } from "./time.ts";

describe("pa Date.UTC safe via real exports", () => {
  it("getWeekdayForLocalDate year 5 stays 5 not 1905", () => {
    expect(getWeekdayForLocalDate({ year: 5, month: 1, day: 1 })).toBe(
      new Date(utcDateMs(5, 0, 1, 12, 0, 0, 0)).getUTCDay(),
    );
    expect(new Date(Date.UTC(5, 0, 1, 12, 0, 0)).getUTCDay()).not.toBe(
      new Date(utcDateMs(5, 0, 1, 12, 0, 0, 0)).getUTCDay(),
    );
  });
  it("addDaysToLocalDate year 0 stays 0", () => {
    const result = addDaysToLocalDate({ year: 0, month: 1, day: 1 }, 0);
    expect(result.year).toBe(0);
    expect(result.month).toBe(1);
    expect(result.day).toBe(1);
    const normalized = new Date(utcDateMs(0, 0, 1, 12, 0, 0, 0));
    expect(normalized.getUTCFullYear()).toBe(0);
    expect(new Date(Date.UTC(0, 0, 1, 12, 0, 0)).getUTCFullYear()).toBe(1900);
  });
  it("utcDateMs year 99 stays 99", () => {
    expect(new Date(utcDateMs(99, 0, 1)).getUTCFullYear()).toBe(99);
    expect(new Date(Date.UTC(99, 0, 1)).getUTCFullYear()).toBe(1999);
  });
  it("addDays handles year 0 leap day", () => {
    const result = addDaysToLocalDate({ year: 0, month: 2, day: 28 }, 1);
    expect(result.day).toBe(29);
    expect(result.month).toBe(2);
  });
});
