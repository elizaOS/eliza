/**
 * Planner-supplied attendees survive only when the user's words name them.
 * Pure helper, no runtime; the real-PGlite handler case lives in
 * test/eliza-calendar.pglite.test.ts.
 */
import { describe, expect, it } from "vitest";
import { userAuthorizedCalendarAttendees } from "./calendar-handler";

describe("userAuthorizedCalendarAttendees", () => {
  it("drops a guest the user never mentioned (live 2026-09-16: an invented example.invalid address)", () => {
    expect(
      userAuthorizedCalendarAttendees(
        [{ email: "shawmakesmagic@example.invalid" }],
        ["add a barber appointment friday at 3pm to my calendar"],
      ),
    ).toBeUndefined();
    expect(
      userAuthorizedCalendarAttendees(
        [{ email: "dana@acme.com", displayName: "Dana" }],
        ["add a dentist appointment friday at 3pm"],
      ),
    ).toBeUndefined();
  });

  it("keeps a guest the user named by address, mailbox or name", () => {
    expect(
      userAuthorizedCalendarAttendees(
        [{ email: "bob@acme.com" }],
        ["invite bob@acme.com to the standup at 10"],
      ),
    ).toEqual([{ email: "bob@acme.com" }]);
    expect(
      userAuthorizedCalendarAttendees(
        [{ email: "dana.k@acme.com", displayName: "Dana K" }],
        ["lunch with dana k on friday at noon"],
      ),
    ).toEqual([{ email: "dana.k@acme.com", displayName: "Dana K" }]);
    expect(
      userAuthorizedCalendarAttendees(
        [{ email: "bob@acme.com" }, { email: "eve@acme.com" }],
        ["set up a call with bob tomorrow at 9"],
      ),
    ).toEqual([{ email: "bob@acme.com" }]);
    // Earlier user lines ground a guest too.
    expect(
      userAuthorizedCalendarAttendees(
        [{ email: "bob@acme.com" }],
        ["book it for friday at 2", "bob@acme.com should be on it"],
      ),
    ).toEqual([{ email: "bob@acme.com" }]);
  });

  it("never keeps a reserved example-domain address, even when quoted", () => {
    expect(
      userAuthorizedCalendarAttendees(
        [{ email: "someone@example.com" }],
        ["invite someone@example.com"],
      ),
    ).toBeUndefined();
  });

  it("passes undefined through and drops an empty list", () => {
    expect(userAuthorizedCalendarAttendees(undefined, ["x"])).toBeUndefined();
    expect(userAuthorizedCalendarAttendees([], ["x"])).toBeUndefined();
  });
});
