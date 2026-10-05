/**
 * All-day events carry a civil date in the date part of startAt (UTC midnight).
 * formatCalendarEventDateTime used to render that instant in the event zone, so
 * a New York all-day Nov 1 listed as "Oct 31, 8:00 PM".
 */

import { describe, expect, it } from "vitest";
import { formatCalendarEventDateTime } from "./format.js";

const allDayNov1 = {
  startAt: "2026-11-01T00:00:00.000Z",
  timezone: "America/New_York",
  isAllDay: true,
};

describe("formatCalendarEventDateTime all-day civil dates", () => {
  it.each(["America/New_York", "America/Los_Angeles", "Asia/Tokyo"] as const)(
    "labels Nov 1 as Nov 1 in a %s feed, not the previous local evening",
    (timeZone) => {
      const labeled = formatCalendarEventDateTime(
        { ...allDayNov1, timezone: timeZone },
        { timeZone },
      );
      expect(labeled).toBe("Nov 1");
      expect(labeled).not.toMatch(/Oct 31/);
      expect(labeled).not.toMatch(/PM|AM/i);
    },
  );

  it("still renders a timed event in the requested zone", () => {
    expect(
      formatCalendarEventDateTime(
        {
          startAt: "2026-11-01T20:00:00.000Z",
          timezone: "America/New_York",
          isAllDay: false,
        },
        { timeZone: "America/New_York" },
      ),
    ).toBe("Nov 1, 3:00 PM");
  });

  it("keeps the timed zone render when isAllDay is omitted", () => {
    expect(
      formatCalendarEventDateTime(
        {
          startAt: "2026-11-01T00:00:00.000Z",
          timezone: "America/New_York",
        },
        { timeZone: "America/New_York" },
      ),
    ).toBe("Oct 31, 8:00 PM");
  });
});
