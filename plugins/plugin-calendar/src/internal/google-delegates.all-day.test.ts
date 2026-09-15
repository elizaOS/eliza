/** Deterministic coverage that provider-neutral all-day dates remain date-only at Google. */
import { describe, expect, it } from "vitest";
import {
  googleCalendarEventInput,
  googleCalendarEventPatchInput,
} from "./google-delegates.js";

describe("Google all-day mutation adapters", () => {
  it("preserves date-only create bounds", () => {
    expect(
      googleCalendarEventInput({
        accountId: "account-a",
        title: "School closed",
        startAt: "2026-03-08",
        endAt: "2026-03-09",
        timeZone: "America/New_York",
      }),
    ).toMatchObject({
      start: "2026-03-08",
      end: "2026-03-09",
      timeZone: "America/New_York",
    });
  });

  it("preserves date-only update bounds", () => {
    expect(
      googleCalendarEventPatchInput({
        accountId: "account-a",
        eventId: "event-a",
        startAt: "2026-11-01",
        endAt: "2026-11-02",
        timeZone: "America/New_York",
      }),
    ).toMatchObject({
      start: "2026-11-01",
      end: "2026-11-02",
      timeZone: "America/New_York",
    });
  });
});
