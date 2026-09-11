/**
 * Pins `calendarDateKeyInZone`: the same instant maps to different calendar
 * days on either side of the date line, and an unknown zone is rejected by
 * Intl rather than silently falling back. Deterministic, no I/O.
 */
import { describe, expect, it } from "vitest";
import { calendarDateKeyInZone } from "./calendar-date.ts";

describe("calendarDateKeyInZone", () => {
  const instant = new Date("2026-03-03T03:30:00.000Z");

  it.each([
    ["UTC", "2026-03-03"],
    ["America/Los_Angeles", "2026-03-02"],
    ["America/New_York", "2026-03-02"],
    ["Asia/Tokyo", "2026-03-03"],
    ["Pacific/Kiritimati", "2026-03-03"],
    ["Pacific/Honolulu", "2026-03-02"],
  ])("maps 03:30Z on March 3 to the local day in %s", (zone, expected) => {
    expect(calendarDateKeyInZone(instant, zone)).toBe(expected);
  });

  it("keeps the calendar day across a DST transition", () => {
    // 2026-03-08 02:30 local does not exist in New York; 06:30Z is 01:30 EST.
    expect(
      calendarDateKeyInZone(
        new Date("2026-03-08T06:30:00.000Z"),
        "America/New_York",
      ),
    ).toBe("2026-03-08");
    expect(
      calendarDateKeyInZone(
        new Date("2026-03-08T04:59:00.000Z"),
        "America/New_York",
      ),
    ).toBe("2026-03-07");
  });

  it("rejects an unknown zone instead of guessing", () => {
    expect(() => calendarDateKeyInZone(instant, "Mars/Olympus")).toThrow(
      RangeError,
    );
  });
});
