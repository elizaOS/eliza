/**
 * Deterministic coverage for attendee sanitization at the planner-output
 * boundary, before strict calendar-service validation.
 */

import { describe, expect, it } from "vitest";
import {
  attendeeEmailAccepted,
  normalizeCalendarAttendees,
} from "./calendar-handler.ts";

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
        { email: "sam@acme.co", displayName: "Sam" },
        "marco",
        "polo@acme.co",
      ],
    });
    expect(out).toEqual([
      { email: "sam@acme.co", displayName: "Sam" },
      { email: "polo@acme.co" },
    ]);
  });

  it("preserves explicitly supplied addresses without guessing whether a domain was invented", () => {
    const attendees = [
      { email: "sam@example.com", displayName: "Sam" },
      { email: "guest@Example.ORG" },
      { email: "qa@team.test" },
    ];
    expect(normalizeCalendarAttendees({ attendees })).toEqual(attendees);
    expect(attendeeEmailAccepted("sam@example.com")).toBe(true);
  });

  it("returns undefined when the details carry no attendees", () => {
    expect(normalizeCalendarAttendees({})).toBeUndefined();
    expect(normalizeCalendarAttendees(undefined)).toBeUndefined();
  });
});
