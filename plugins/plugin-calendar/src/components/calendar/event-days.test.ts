/** Exercises feed-to-day placement across timezone and exclusive all-day boundaries. */
import type { LifeOpsCalendarEvent } from "@elizaos/shared";
import { describe, expect, it } from "vitest";
import { calendarEventOccursOn } from "./event-days.js";

describe("calendar event day placement", () => {
  const school = {
    startAt: "2026-09-16T00:00:00.000Z",
    endAt: "2026-09-18T00:00:00.000Z",
    isAllDay: true,
  } as LifeOpsCalendarEvent;

  it.each(["America/New_York", "America/Los_Angeles", "Pacific/Auckland"])(
    "keeps school dates unchanged in %s and includes each day of a closure",
    (zone) => {
      const visible = [
        "2026-09-15",
        "2026-09-16",
        "2026-09-17",
        "2026-09-18",
      ].filter((day) => calendarEventOccursOn(school, day, zone));
      expect(visible).toEqual(["2026-09-16", "2026-09-17"]);
    },
  );

  it("still places timed events on the viewer's local day", () => {
    const timed = { ...school, isAllDay: false };
    expect(calendarEventOccursOn(timed, "2026-09-15", "America/New_York")).toBe(
      true,
    );
    expect(calendarEventOccursOn(timed, "2026-09-16", "America/New_York")).toBe(
      false,
    );
    expect(calendarEventOccursOn(timed, "2026-09-16", "Pacific/Auckland")).toBe(
      true,
    );
  });
});
