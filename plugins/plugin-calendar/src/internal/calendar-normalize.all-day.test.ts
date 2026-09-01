/** Deterministic coverage for provider-neutral all-day and legacy timed range normalization. */
import { describe, expect, it } from "vitest";
import { resolveCalendarEventRange } from "./calendar-normalize.js";

describe("resolveCalendarEventRange all-day contract", () => {
  it.each([
    ["2026-01-15", "2026-01-16"],
    ["2026-07-15", "2026-07-16"],
    ["2026-03-08", "2026-03-09"],
    ["2026-11-01", "2026-11-02"],
  ])(
    "preserves civil dates across DST for %s",
    (startDate, endDateExclusive) => {
      expect(
        resolveCalendarEventRange(
          {
            title: "School closed",
            allDay: { startDate, endDateExclusive },
            timeZone: "America/New_York",
          },
          new Date("2026-01-01T12:00:00.000Z"),
        ),
      ).toEqual({
        startAt: `${startDate}T00:00:00.000Z`,
        endAt: `${endDateExclusive}T00:00:00.000Z`,
        timeZone: "America/New_York",
        isAllDay: true,
        startDate,
        endDateExclusive,
      });
    },
  );

  it("keeps timed RFC 3339 requests classified as timed", () => {
    expect(
      resolveCalendarEventRange(
        {
          title: "Meeting",
          startAt: "2026-03-08T09:00:00-04:00",
          endAt: "2026-03-08T10:00:00-04:00",
          timeZone: "America/New_York",
        },
        new Date("2026-01-01T12:00:00.000Z"),
      ),
    ).toMatchObject({
      startAt: "2026-03-08T13:00:00.000Z",
      endAt: "2026-03-08T14:00:00.000Z",
      isAllDay: false,
    });
  });

  it("rejects mixed timed and all-day bounds", () => {
    expect(() =>
      resolveCalendarEventRange(
        {
          title: "Invalid",
          startAt: "2026-03-08T09:00:00-04:00",
          allDay: {
            startDate: "2026-03-08",
            endDateExclusive: "2026-03-09",
          },
        },
        new Date(),
      ),
    ).toThrow("allDay cannot be combined");
  });
});
