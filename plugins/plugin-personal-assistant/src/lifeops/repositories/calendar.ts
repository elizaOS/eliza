/** Adapts host connector identity defaults to the canonical calendar repository. Calendar SQL, parsing, and sync-state ownership remain in plugin-calendar. */
import type { IAgentRuntime } from "@elizaos/core";
import { CalendarRepository } from "@elizaos/plugin-calendar/service/CalendarRepository";
import type {
  LifeOpsCalendarEvent,
  LifeOpsConnectorGrant,
  LifeOpsConnectorSide,
} from "../../contracts/index.js";
import { deriveConnectorAccountId } from "../privacy-egress.js";
import type { LifeOpsCalendarSyncState } from "./calendar-records.js";
export class LifeOpsCalendarRepository {
  private readonly calendar: CalendarRepository;
  constructor(runtime: IAgentRuntime) {
    this.calendar = new CalendarRepository(runtime);
  }

  async upsertCalendarEvent(
    event: LifeOpsCalendarEvent,
    side: LifeOpsConnectorSide = event.side,
  ): Promise<void> {
    return this.calendar.upsertCalendarEvent(
      {
        ...event,
        connectorAccountId:
          event.connectorAccountId ??
          deriveConnectorAccountId({
            provider: event.provider,
            side,
            identityEmail: event.accountEmail,
            grantId: event.grantId,
          }) ??
          undefined,
      },
      side,
    );
  }

  async deleteCalendarEventsForProvider(
    agentId: string,
    provider: LifeOpsConnectorGrant["provider"],
    calendarId?: string,
    side?: LifeOpsConnectorSide,
  ): Promise<void> {
    return this.calendar.deleteCalendarEventsForProvider(
      agentId,
      provider,
      calendarId,
      side,
    );
  }

  async deleteCalendarEventByExternalId(
    agentId: string,
    provider: LifeOpsConnectorGrant["provider"],
    calendarId: string | null | undefined,
    externalEventId: string,
    side?: LifeOpsConnectorSide,
  ): Promise<void> {
    return this.calendar.deleteCalendarEventByExternalId(
      agentId,
      provider,
      calendarId,
      externalEventId,
      side,
    );
  }

  async pruneCalendarEventsInWindow(
    agentId: string,
    provider: LifeOpsConnectorGrant["provider"],
    calendarId: string,
    timeMin: string,
    timeMax: string,
    keepExternalIds: readonly string[],
    side: LifeOpsConnectorSide = "owner",
  ): Promise<void> {
    return this.calendar.pruneCalendarEventsInWindow(
      agentId,
      provider,
      calendarId,
      timeMin,
      timeMax,
      keepExternalIds,
      side,
    );
  }

  async listCalendarEvents(
    agentId: string,
    provider: LifeOpsConnectorGrant["provider"],
    timeMin?: string,
    timeMax?: string,
    side?: LifeOpsConnectorSide,
  ): Promise<LifeOpsCalendarEvent[]> {
    return this.calendar.listCalendarEvents(
      agentId,
      provider,
      timeMin,
      timeMax,
      side,
    );
  }

  async listCalendarEventsEndedAfterCursor(args: {
    agentId: string;
    provider: LifeOpsConnectorGrant["provider"];
    side?: LifeOpsConnectorSide;
    cursorEndAt: string | null;
    cursorEventId: string | null;
    upToIso: string;
    limit: number;
  }): Promise<LifeOpsCalendarEvent[]> {
    return this.calendar.listCalendarEventsEndedAfterCursor(args);
  }

  async upsertCalendarSyncState(
    state: LifeOpsCalendarSyncState,
  ): Promise<void> {
    return this.calendar.upsertCalendarSyncState(state);
  }

  async getCalendarSyncState(
    agentId: string,
    provider: LifeOpsConnectorGrant["provider"],
    calendarId: string,
    side?: LifeOpsConnectorSide,
    grantId?: string,
  ): Promise<LifeOpsCalendarSyncState | null> {
    return this.calendar.getCalendarSyncState(
      agentId,
      provider,
      calendarId,
      side,
      grantId,
    );
  }

  async deleteCalendarSyncState(
    agentId: string,
    provider: LifeOpsConnectorGrant["provider"],
    calendarId?: string,
    side?: LifeOpsConnectorSide,
    grantId?: string,
  ): Promise<void> {
    return this.calendar.deleteCalendarSyncState(
      agentId,
      provider,
      calendarId,
      side,
      grantId,
    );
  }
}
