/** A day-first date may use a comma before the year, like "1 March, 2024". */
import { describe, expect, it } from "vitest";
import { parseCalendarDate } from "./calendar-date.ts";

describe("parseCalendarDate day-first comma", () => {
  it("accepts a comma between the month and the year", () => {
    expect(parseCalendarDate("1 March, 2024")).toBe("2024-03-01");
    expect(parseCalendarDate("29 Feb, 2024")).toBe("2024-02-29");
  });

  it("keeps the day-first form without a comma and rejects an impossible day", () => {
    expect(parseCalendarDate("1 March 2024")).toBe("2024-03-01");
    expect(parseCalendarDate("31 April, 2024")).toBeUndefined();
    expect(parseCalendarDate("29 Feb, 2023")).toBeUndefined();
  });
});
