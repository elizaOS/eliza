/**
 * Planner-arg attendee sanitization: invented non-email attendees ("lunch with
 * dana" → {email: "dana"}) must be dropped, not forwarded to the calendar
 * service where the strict boundary validator 400s the whole create.
 * Deterministic unit harness over the exported normalizer.
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
});
