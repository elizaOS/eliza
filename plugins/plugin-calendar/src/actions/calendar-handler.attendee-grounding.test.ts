/**
 * Planner-supplied addresses require explicit user address evidence; names pause.
 * Pure helper, no runtime; the real-PGlite handler case lives in
 * test/eliza-calendar.pglite.test.ts.
 */
import { describe, expect, it } from "vitest";
import { userAuthorizedCalendarAttendees } from "./calendar-handler";

describe("userAuthorizedCalendarAttendees", () => {
  it("rejects unverified proposals without silently omitting an attendee", () => {
    expect(() =>
      userAuthorizedCalendarAttendees(
        [{ email: "shawmakesmagic@example.invalid" }],
        ["add a barber appointment friday at 3pm to my calendar"],
      ),
    ).toThrow("email address is not verified");
    expect(() =>
      userAuthorizedCalendarAttendees(
        [{ email: "dana@acme.com", displayName: "Dana" }],
        ["add a dentist appointment friday at 3pm"],
      ),
    ).toThrow("email address is not verified");
  });

  it("keeps explicit addresses and pauses unverified named guests", () => {
    expect(
      userAuthorizedCalendarAttendees(
        [{ email: "bob@acme.com" }],
        ["invite bob@acme.com to the standup at 10"],
      ),
    ).toEqual([{ email: "bob@acme.com" }]);
    expect(() =>
      userAuthorizedCalendarAttendees(
        [{ email: "dana.k@acme.com", displayName: "Dana K" }],
        ["lunch with dana k on friday at noon"],
      ),
    ).toThrow("email address is not verified");
    expect(() =>
      userAuthorizedCalendarAttendees(
        [{ email: "bob@acme.com" }, { email: "eve@acme.com" }],
        ["set up a call with bob tomorrow at 9"],
      ),
    ).toThrow("email address is not verified");
    expect(
      userAuthorizedCalendarAttendees(
        [{ email: "bob@acme.com" }],
        ["book it for friday at 2", "bob@acme.com should be on it"],
      ),
    ).toEqual([{ email: "bob@acme.com" }]);
  });

  it("never keeps a reserved example-domain address, even when quoted", () => {
    expect(() =>
      userAuthorizedCalendarAttendees(
        [{ email: "someone@example.com" }],
        ["invite someone@example.com"],
      ),
    ).toThrow("email address is not verified");
  });

  it("passes undefined through and drops an empty list", () => {
    expect(userAuthorizedCalendarAttendees(undefined, ["x"])).toBeUndefined();
    expect(userAuthorizedCalendarAttendees([], ["x"])).toBeUndefined();
  });
});
