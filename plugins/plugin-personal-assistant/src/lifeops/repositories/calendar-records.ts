/** Applies legacy host defaults when creating canonical calendar sync-state records. */
import type { LifeOpsCalendarSyncState } from "@elizaos/plugin-calendar/service/CalendarRepository";

export type { LifeOpsCalendarSyncState } from "@elizaos/plugin-calendar/service/CalendarRepository";

import { isoNow } from "./record-values.js";

export function createLifeOpsCalendarSyncState(
  params: Omit<
    LifeOpsCalendarSyncState,
    "id" | "updatedAt" | "grantId" | "connectorAccountId" | "nextSyncToken"
  > &
    Partial<
      Pick<
        LifeOpsCalendarSyncState,
        "grantId" | "connectorAccountId" | "nextSyncToken"
      >
    >,
): LifeOpsCalendarSyncState {
  const legacySourceId =
    params.provider === "apple_calendar"
      ? "apple-calendar"
      : `legacy:${params.provider}:${params.side}`;
  const grantId = params.grantId ?? params.connectorAccountId ?? legacySourceId;
  const connectorAccountId =
    params.connectorAccountId ?? params.grantId ?? legacySourceId;
  return {
    ...params,
    id: [
      params.agentId,
      params.provider,
      params.side,
      "grant",
      grantId,
      "calendar",
      params.calendarId,
    ].join(":"),
    grantId,
    connectorAccountId,
    nextSyncToken: params.nextSyncToken ?? null,
    updatedAt: isoNow(),
  };
}
