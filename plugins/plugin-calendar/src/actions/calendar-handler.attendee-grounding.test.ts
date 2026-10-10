/**
 * Planner-supplied addresses are written only with explicit user address
 * evidence; any other proposed attendee is left off and reported.
 * Pure helper, no runtime; the real-PGlite handler case lives in
 * test/eliza-calendar.pglite.test.ts.
 */
import { describe, expect, it } from "vitest";
import { userAuthorizedCalendarAttendees } from "./calendar-handler";

describe("userAuthorizedCalendarAttendees", () => {
  it("keeps addresses the user wrote", () => {
    expect(
      userAuthorizedCalendarAttendees(
        [{ email: "bob@acme.com" }],
        ["invite bob@acme.com to the standup at 10"],
      ),
    ).toEqual({ attendees: [{ email: "bob@acme.com" }], notAdded: [] });
    expect(
      userAuthorizedCalendarAttendees(
        [{ email: "bob@acme.com" }],
        ["book it for friday at 2", "bob@acme.com should be on it"],
      ).attendees,
    ).toEqual([{ email: "bob@acme.com" }]);
  });

  it("never keeps a reserved example-domain address, even when quoted", () => {
    expect(
      userAuthorizedCalendarAttendees(
        [{ email: "someone@example.com" }],
        ["invite someone@example.com"],
      ),
    ).toEqual({ attendees: undefined, notAdded: ["someone@example.com"] });
  });

  it("passes undefined through and drops an empty list", () => {
    expect(userAuthorizedCalendarAttendees(undefined, ["x"])).toEqual({
      attendees: undefined,
      notAdded: [],
    });
    expect(userAuthorizedCalendarAttendees([], ["x"])).toEqual({
      attendees: undefined,
      notAdded: [],
    });
  });
});
