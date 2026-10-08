/** English month-name dates may use an ordinal day, such as "March 1st". */
import { describe, expect, it } from "vitest";
import { parseCalendarDate } from "./calendar-date.ts";

describe("parseCalendarDate ordinal days", () => {
  it("accepts a matching ordinal on a month-name date", () => {
    expect(parseCalendarDate("March 1st, 2024")).toBe("2024-03-01");
    expect(parseCalendarDate("March 2nd, 2024")).toBe("2024-03-02");
    expect(parseCalendarDate("March 3rd, 2024")).toBe("2024-03-03");
    expect(parseCalendarDate("March 11th, 2024")).toBe("2024-03-11");
    expect(parseCalendarDate("1st March 2024")).toBe("2024-03-01");
  });

  it("keeps a plain day and rejects a mismatched ordinal", () => {
    expect(parseCalendarDate("March 1, 2024")).toBe("2024-03-01");
    expect(parseCalendarDate("March 1nd, 2024")).toBeUndefined();
    expect(parseCalendarDate("March 11st, 2024")).toBeUndefined();
    expect(parseCalendarDate("March 31st, 2024")).toBe("2024-03-31");
    expect(parseCalendarDate("April 31st, 2024")).toBeUndefined();
    expect(parseCalendarDate("1st/2/2024")).toBeUndefined();
  });
});
