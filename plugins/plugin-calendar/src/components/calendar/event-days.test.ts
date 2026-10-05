/** Exercises feed-to-day placement across timezone and exclusive all-day boundaries. */
import type { LifeOpsCalendarEvent } from "@elizaos/contracts";
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

  it("still places a same-day timed event on the viewer's local start day", () => {
    // 2026-09-16T00:00Z is 2026-09-15 20:00 in New York and 2026-09-16 noon in Auckland.
    const timed = {
      startAt: "2026-09-16T00:00:00.000Z",
      endAt: "2026-09-16T01:00:00.000Z",
      isAllDay: false,
    } as LifeOpsCalendarEvent;
    expect(calendarEventOccursOn(timed, "2026-09-15", "America/New_York")).toBe(
      true,
    );
    expect(calendarEventOccursOn(timed, "2026-09-16", "America/New_York")).toBe(
      false,
    );
    expect(calendarEventOccursOn(timed, "2026-09-16", "Pacific/Auckland")).toBe(
      true,
    );
    expect(calendarEventOccursOn(timed, "2026-09-15", "Pacific/Auckland")).toBe(
      false,
    );
  });

  it("places an overnight timed event on both local days it occupies", () => {
    // 22:00–01:00 America/New_York on 15–16 June (EDT, UTC-4).
    const overnight = {
      startAt: "2026-06-16T02:00:00.000Z",
      endAt: "2026-06-16T05:00:00.000Z",
      isAllDay: false,
    } as LifeOpsCalendarEvent;
    expect(
      calendarEventOccursOn(overnight, "2026-06-15", "America/New_York"),
    ).toBe(true);
    expect(
      calendarEventOccursOn(overnight, "2026-06-16", "America/New_York"),
    ).toBe(true);
    expect(
      calendarEventOccursOn(overnight, "2026-06-14", "America/New_York"),
    ).toBe(false);
    expect(
      calendarEventOccursOn(overnight, "2026-06-17", "America/New_York"),
    ).toBe(false);
    // The same instant stays on 16 June in UTC and Auckland.
    expect(calendarEventOccursOn(overnight, "2026-06-16", "UTC")).toBe(true);
    expect(calendarEventOccursOn(overnight, "2026-06-15", "UTC")).toBe(false);
    expect(
      calendarEventOccursOn(overnight, "2026-06-16", "Pacific/Auckland"),
    ).toBe(true);
    expect(
      calendarEventOccursOn(overnight, "2026-06-17", "Pacific/Auckland"),
    ).toBe(false);
  });

  it("places a multi-day timed event on every local day until an exclusive midnight end", () => {
    const timed = { ...school, isAllDay: false };
    expect(
      ["2026-09-15", "2026-09-16", "2026-09-17", "2026-09-18"].filter((day) =>
        calendarEventOccursOn(timed, day, "America/New_York"),
      ),
    ).toEqual(["2026-09-15", "2026-09-16", "2026-09-17"]);
    expect(
      ["2026-09-15", "2026-09-16", "2026-09-17", "2026-09-18"].filter((day) =>
        calendarEventOccursOn(timed, day, "Pacific/Auckland"),
      ),
    ).toEqual(["2026-09-16", "2026-09-17", "2026-09-18"]);
  });

  it("does not place a timed event on the local day of an exclusive midnight end", () => {
    // 12:00–24:00 America/New_York on 15 June ends at 2026-06-16T04:00Z.
    const untilMidnight = {
      startAt: "2026-06-15T16:00:00.000Z",
      endAt: "2026-06-16T04:00:00.000Z",
      isAllDay: false,
    } as LifeOpsCalendarEvent;
    expect(
      calendarEventOccursOn(untilMidnight, "2026-06-15", "America/New_York"),
    ).toBe(true);
    expect(
      calendarEventOccursOn(untilMidnight, "2026-06-16", "America/New_York"),
    ).toBe(false);
  });
  it("includes an end day occupied for a fraction of a second", () => {
    const event = {
      startAt: "2026-06-15T16:00:00.000Z",
      endAt: "2026-06-16T04:00:00.001Z",
      isAllDay: false,
    } as LifeOpsCalendarEvent;
    expect(calendarEventOccursOn(event, "2026-06-16", "America/New_York")).toBe(
      true,
    );
  });

  it("keeps a timed event with an unparseable end on its start day without throwing", () => {
    for (const endAt of ["", "not-a-date", "2026-06-16T25:00:00Z"]) {
      const event = {
        startAt: "2026-06-16T02:00:00.000Z",
        endAt,
        isAllDay: false,
      } as LifeOpsCalendarEvent;
      expect(
        ["2026-06-14", "2026-06-15", "2026-06-16"].filter((day) =>
          calendarEventOccursOn(event, day, "America/New_York"),
        ),
      ).toEqual(["2026-06-15"]);
    }
  });

  it("places a timed event with an unparseable start on no day", () => {
    const event = {
      startAt: "",
      endAt: "2026-06-16T05:00:00.000Z",
      isAllDay: false,
    } as LifeOpsCalendarEvent;
    expect(calendarEventOccursOn(event, "2026-06-15", "UTC")).toBe(false);
  });
});
