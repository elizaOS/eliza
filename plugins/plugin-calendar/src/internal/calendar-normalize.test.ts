import { expect, it } from "vitest";
import { normalizeCalendarDateTimeInTimeZone } from "./calendar-normalize.js";

it("reads an offset-less datetime with microseconds in the requested zone", () => {
  // 10:00 in America/New_York is 15:00 UTC in November (EST, UTC-5).
  expect(
    normalizeCalendarDateTimeInTimeZone(
      "2026-11-09T10:00:00.123456",
      "startAt",
      "America/New_York",
    ),
  ).toBe("2026-11-09T15:00:00.123Z");
});

it("reads an offset-less datetime with nanoseconds in the requested zone", () => {
  expect(
    normalizeCalendarDateTimeInTimeZone(
      "2026-11-09T10:00:00.123456789",
      "startAt",
      "America/New_York",
    ),
  ).toBe("2026-11-09T15:00:00.123Z");
});

it("keeps millisecond datetimes in the requested zone", () => {
  expect(
    normalizeCalendarDateTimeInTimeZone(
      "2026-11-09T10:00:00.123",
      "startAt",
      "America/New_York",
    ),
  ).toBe("2026-11-09T15:00:00.123Z");
});
