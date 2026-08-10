/** Verifies the deterministic change-delivery projection for MCP polling. */

import { describe, expect, it } from "vitest";
import { googleCalendarPollingHealth } from "./google-polling.js";

describe("googleCalendarPollingHealth", () => {
  it("reports active polling without push-channel state", () => {
    const syncedAt = "2026-08-10T12:00:00.000Z";

    expect(googleCalendarPollingHealth(syncedAt)).toEqual({
      mode: "polling",
      status: "active",
      expiresAt: null,
      lastNotificationAt: null,
      lastSuccessfulSyncAt: syncedAt,
      error: null,
    });
  });
});
