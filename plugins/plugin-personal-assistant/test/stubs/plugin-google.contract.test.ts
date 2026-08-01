/**
 * Pins the Google test double to the runtime error constructors consumed by
 * plugin-calendar. The connector itself remains stubbed; error identity is real.
 */

import { ElizaError } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import {
  GoogleCalendarMutationError,
  GoogleCalendarSyncTokenExpiredError,
} from "./plugin-google";

describe("Google plugin test-double contract", () => {
  it("preserves calendar error identity and diagnostic fields", () => {
    const cause = new Error("upstream rejected request");
    const mutation = new GoogleCalendarMutationError(
      "precondition_failed",
      "GOOGLE_CALENDAR_PRECONDITION_FAILED",
      "Calendar precondition failed.",
      { calendarId: "primary" },
      cause,
    );
    const expired = new GoogleCalendarSyncTokenExpiredError({
      resource: "events",
      accountId: "account-1",
      calendarId: "primary",
      cause,
    });

    expect(mutation).toBeInstanceOf(ElizaError);
    expect(mutation).toMatchObject({
      name: "GoogleCalendarMutationError",
      outcome: "precondition_failed",
      code: "GOOGLE_CALENDAR_PRECONDITION_FAILED",
      cause,
    });
    expect(expired).toBeInstanceOf(ElizaError);
    expect(expired).toMatchObject({
      name: "GoogleCalendarSyncTokenExpiredError",
      resource: "events",
      code: "GOOGLE_CALENDAR_SYNC_TOKEN_EXPIRED",
      cause,
    });
  });
});
