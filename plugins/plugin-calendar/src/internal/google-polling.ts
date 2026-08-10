/** Builds the change-delivery health projection for MCP-only Google Calendar polling. */

import type { LifeOpsCalendarChangeDeliveryHealth } from "@elizaos/shared";

export function googleCalendarPollingHealth(
  lastSuccessfulSyncAt: string | null,
): LifeOpsCalendarChangeDeliveryHealth {
  return {
    mode: "polling",
    status: "active",
    expiresAt: null,
    lastNotificationAt: null,
    lastSuccessfulSyncAt,
    error: null,
  };
}
