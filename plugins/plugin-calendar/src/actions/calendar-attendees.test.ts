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
  it.each([
    [{ email: "dana", displayName: "Dana", optional: false }],
    [{ email: "sam@acme.co", displayName: "Sam" }, "marco"],
    [{ displayName: "Sam" }],
    [null],
  ])(
    "rejects unresolved proposals without dropping guests from the list: %j",
    (...attendees) => {
      expect(() => normalizeCalendarAttendees({ attendees })).toThrow(
        "email address is not verified",
      );
    },
  );

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
