import { describe, expect, it } from "vitest";
import { parseDateRangeParams } from "./date-range-params";

describe("parseDateRangeParams", () => {
  it("rejects an impossible civil day inside an ISO timestamp", () => {
    expect(
      parseDateRangeParams(new URLSearchParams("start_date=2024-02-30T00:00:00.000Z")),
    ).toEqual({ success: false, error: "Invalid start_date" });
    expect(parseDateRangeParams(new URLSearchParams("end_date=2024-04-31T12:00:00.000Z"))).toEqual({
      success: false,
      error: "Invalid end_date",
    });
  });

  it("keeps a real day, including an offset that crosses UTC midnight", () => {
    const leap = parseDateRangeParams(new URLSearchParams("start_date=2024-02-29T00:00:00.000Z"));
    expect(leap.success).toBe(true);
    if (leap.success) {
      expect(leap.startDate?.toISOString()).toBe("2024-02-29T00:00:00.000Z");
    }

    const offset = parseDateRangeParams(
      new URLSearchParams("start_date=2024-02-29T23:00:00-05:00"),
    );
    expect(offset.success).toBe(true);
    if (offset.success) {
      expect(offset.startDate?.toISOString()).toBe("2024-03-01T04:00:00.000Z");
    }
  });

  it("still rejects a date-only impossible day", () => {
    expect(parseDateRangeParams(new URLSearchParams("start_date=2024-02-30"))).toEqual({
      success: false,
      error: "Invalid start_date",
    });
  });
});
