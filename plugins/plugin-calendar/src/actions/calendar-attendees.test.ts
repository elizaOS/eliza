/**
 * Deterministic coverage for attendee sanitization at the planner-output
 * boundary, before strict calendar-service validation.
 */

import { describe, expect, it } from "vitest";
import { normalizeCalendarAttendees } from "./calendar-handler.ts";

describe("normalizeCalendarAttendees (planner-arg sanitization)", () => {
  it("drops a planner-invented bare-name attendee instead of failing the create (live regression)", () => {
    const out = normalizeCalendarAttendees({
      attendees: [{ email: "dana", displayName: "Dana", optional: false }],
    });
    expect(out).toBeUndefined();
  });

  it("keeps valid-email attendees and drops invalid ones from a mixed list", () => {
    const out = normalizeCalendarAttendees({
      attendees: [
        { email: "dana", displayName: "Dana" },
        { email: "sam@example.com", displayName: "Sam" },
        "marco",
        "polo@example.com",
      ],
    });
    expect(out).toEqual([
      { email: "sam@example.com", displayName: "Sam" },
      { email: "polo@example.com" },
    ]);
  });

  it("returns undefined when the details carry no attendees", () => {
    expect(normalizeCalendarAttendees({})).toBeUndefined();
    expect(normalizeCalendarAttendees(undefined)).toBeUndefined();
  });

  it("CALENDAR_DETAILS_PARAMETER_SCHEMA attendees.items has no conflicting type above anyOf", async () => {
    const { CALENDAR_DETAILS_PARAMETER_SCHEMA } = await import(
      "../calendar-action-schema.ts"
    );
    const attendees = CALENDAR_DETAILS_PARAMETER_SCHEMA.properties
      ?.attendees as {
      items?: { type?: string; anyOf?: unknown[] };
    };
    expect(attendees?.items?.type).toBeUndefined();
    expect(Array.isArray(attendees?.items?.anyOf)).toBe(true);
    expect(
      CALENDAR_DETAILS_PARAMETER_SCHEMA.properties?.notify_attendees,
    ).toEqual({ type: "boolean" });
  });
});
