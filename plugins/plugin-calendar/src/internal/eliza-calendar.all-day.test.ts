/** Deterministic coverage for built-in calendar all-day classification and timed compatibility. */
import { describe, expect, it } from "vitest";
import { createElizaCalendarEvent } from "./eliza-calendar.js";

const base = {
  agentId: "agent-a",
  request: { title: "School closed", idempotencyKey: "school:closed" },
  startAt: "2026-03-08T00:00:00.000Z",
  endAt: "2026-03-09T00:00:00.000Z",
  timeZone: "America/New_York",
  attendees: [],
  now: new Date("2026-01-01T12:00:00.000Z"),
};

describe("built-in calendar event classification", () => {
  it("persists an all-day event for renderer classification", () => {
    expect(createElizaCalendarEvent({ ...base, isAllDay: true })).toMatchObject(
      {
        startAt: "2026-03-08T00:00:00.000Z",
        endAt: "2026-03-09T00:00:00.000Z",
        isAllDay: true,
        timezone: "America/New_York",
      },
    );
  });

  it("preserves timed event classification", () => {
    expect(
      createElizaCalendarEvent({ ...base, isAllDay: false }).isAllDay,
    ).toBe(false);
  });
});
