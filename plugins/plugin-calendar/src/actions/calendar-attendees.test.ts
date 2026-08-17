/**
 * Planner-arg attendee sanitization: invented non-email attendees ("lunch with
 * dana" → {email: "dana"}) must be dropped, not forwarded to the calendar
 * service where the strict boundary validator 400s the whole create. The
 * normalizer validates shape with the plugin's linear `basicEmailValid`, so
 * adversarial planner output cannot trigger the ReDoS backtracking of the
 * equivalent `[^\s@]+\.[^\s@]+` regex. Deterministic unit harness over the
 * exported normalizer.
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

  it("returns undefined for an empty or all-invalid attendee list", () => {
    expect(normalizeCalendarAttendees({ attendees: [] })).toBeUndefined();
    expect(
      normalizeCalendarAttendees({ attendees: ["dana", { email: "marco" }] }),
    ).toBeUndefined();
  });

  it("keeps a single valid string-form attendee as an email entry", () => {
    expect(
      normalizeCalendarAttendees({ attendees: [" sam@example.com "] }),
    ).toEqual([{ email: "sam@example.com" }]);
  });

  it("preserves displayName and optional on a valid object attendee", () => {
    expect(
      normalizeCalendarAttendees({
        attendees: [
          { email: "sam@example.com", displayName: "Sam", optional: true },
        ],
      }),
    ).toEqual([
      { email: "sam@example.com", displayName: "Sam", optional: true },
    ]);
  });

  it("drops adversarial planner output in linear time (no ReDoS)", () => {
    // A no-whitespace, single-@ value whose domain is a long dot run with no
    // terminal segment is the backtracking trigger for the legacy
    // `[^\s@]+\.[^\s@]+` regex; the linear validator drops it immediately.
    const evil = `x@${"a.".repeat(200_000)}@`;
    const start = performance.now();
    const out = normalizeCalendarAttendees({ attendees: [evil] });
    const elapsed = performance.now() - start;
    expect(out).toBeUndefined();
    expect(elapsed).toBeLessThan(1000);
  });
});
