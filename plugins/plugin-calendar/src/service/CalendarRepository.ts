import crypto from "node:crypto";
import type { IAgentRuntime } from "@elizaos/core";
import type {
  LifeOpsCalendarEvent,
  LifeOpsConnectorGrant,
  LifeOpsConnectorSide,
} from "@elizaos/shared";
import {
  executeRawSql,
  parseJsonArray,
  parseJsonRecord,
  sqlBoolean,
  sqlJson,
  sqlQuote,
  sqlText,
  toBoolean,
  toText,
} from "../internal/sql.js";

export interface LifeOpsCalendarSyncState {
  id: string;
  agentId: string;
  provider: LifeOpsConnectorGrant["provider"];
  side: LifeOpsConnectorSide;
  calendarId: string;
  windowStartAt: string;
  windowEndAt: string;
  syncedAt: string;
  updatedAt: string;
}

export function createLifeOpsCalendarSyncState(
  params: Omit<LifeOpsCalendarSyncState, "id" | "updatedAt">,
): LifeOpsCalendarSyncState {
  return {
    ...params,
    id: crypto.randomUUID(),
    updatedAt: new Date().toISOString(),
  };
}

function parseCalendarEvent(
  row: Record<string, unknown>,
): LifeOpsCalendarEvent {
  return {
    id: toText(row.id),
    externalId: toText(row.external_event_id),
    agentId: toText(row.agent_id),
    provider: toText(
      row.provider,
      "google",
    ) as LifeOpsCalendarEvent["provider"],
    side: toText(row.side, "owner") as LifeOpsCalendarEvent["side"],
    calendarId: toText(row.calendar_id),
    connectorAccountId: row.connector_account_id
      ? toText(row.connector_account_id)
      : undefined,
    title: toText(row.title),
    description: toText(row.description),
    location: toText(row.location),
    status: toText(row.status),
    startAt: toText(row.start_at),
    endAt: toText(row.end_at),
    isAllDay: toBoolean(row.is_all_day),
    timezone: row.timezone ? toText(row.timezone) : null,
    htmlLink: row.html_link ? toText(row.html_link) : null,
    conferenceLink: row.conference_link ? toText(row.conference_link) : null,
    organizer: row.organizer_json ? parseJsonRecord(row.organizer_json) : null,
    attendees: parseJsonArray(
      row.attendees_json,
    ) as LifeOpsCalendarEvent["attendees"],
    metadata: parseJsonRecord(row.metadata_json),
    syncedAt: toText(row.synced_at),
    updatedAt: toText(row.updated_at),
    grantId: row.grant_id ? toText(row.grant_id) : undefined,
  };
}

function parseCalendarSyncState(
  row: Record<string, unknown>,
): LifeOpsCalendarSyncState {
  return {
    id: toText(row.id),
    agentId: toText(row.agent_id),
    provider: toText(row.provider) as LifeOpsConnectorGrant["provider"],
    side: toText(row.side, "owner") as LifeOpsConnectorSide,
    calendarId: toText(row.calendar_id),
    windowStartAt: toText(row.window_start_at),
    windowEndAt: toText(row.window_end_at),
    syncedAt: toText(row.synced_at),
    updatedAt: toText(row.updated_at),
  };
}

/**
 * Data-access layer for the calendar event + sync-state tables. Mirrors the
 * raw-SQL pattern of `LifeOpsRepository`: every statement runs through the
 * runtime database adapter via `executeRawSql`, and table names stay qualified
 * with the `app_lifeops.` schema prefix.
 */
export class CalendarRepository {
  constructor(private readonly runtime: IAgentRuntime) {}

  async upsertCalendarEvent(
    event: LifeOpsCalendarEvent,
    side: LifeOpsConnectorSide = event.side,
  ): Promise<void> {
    const connectorAccountId = event.connectorAccountId ?? null;
    await executeRawSql(
      this.runtime,
      `INSERT INTO app_lifeops.life_calendar_events (
        id, agent_id, provider, side, calendar_id, external_event_id, title,
        description, location, status, start_at, end_at, is_all_day,
        timezone, html_link, conference_link, organizer_json, attendees_json,
        connector_account_id, grant_id, metadata_json, synced_at, updated_at
      ) VALUES (
        ${sqlQuote(event.id)},
        ${sqlQuote(event.agentId)},
        ${sqlQuote(event.provider)},
        ${sqlQuote(side)},
        ${sqlQuote(event.calendarId)},
        ${sqlQuote(event.externalId)},
        ${sqlQuote(event.title)},
        ${sqlQuote(event.description)},
        ${sqlQuote(event.location)},
        ${sqlQuote(event.status)},
        ${sqlQuote(event.startAt)},
        ${sqlQuote(event.endAt)},
        ${sqlBoolean(event.isAllDay)},
        ${sqlText(event.timezone)},
        ${sqlText(event.htmlLink)},
        ${sqlText(event.conferenceLink)},
        ${event.organizer ? sqlJson(event.organizer) : "NULL"},
        ${sqlJson(event.attendees)},
        ${sqlText(connectorAccountId)},
        ${sqlText(event.grantId)},
        ${sqlJson(event.metadata)},
        ${sqlQuote(event.syncedAt)},
        ${sqlQuote(event.updatedAt)}
      )
      ON CONFLICT(agent_id, provider, side, calendar_id, external_event_id) DO UPDATE SET
        title = excluded.title,
        description = excluded.description,
        location = excluded.location,
        status = excluded.status,
        start_at = excluded.start_at,
        end_at = excluded.end_at,
        is_all_day = excluded.is_all_day,
        timezone = excluded.timezone,
        html_link = excluded.html_link,
        conference_link = excluded.conference_link,
        organizer_json = excluded.organizer_json,
        attendees_json = excluded.attendees_json,
        connector_account_id = COALESCE(excluded.connector_account_id, app_lifeops.life_calendar_events.connector_account_id),
        grant_id = COALESCE(excluded.grant_id, app_lifeops.life_calendar_events.grant_id),
        metadata_json = excluded.metadata_json,
        synced_at = excluded.synced_at,
        updated_at = excluded.updated_at`,
    );
  }

  async deleteCalendarEventsForProvider(
    agentId: string,
    provider: LifeOpsConnectorGrant["provider"],
    calendarId?: string,
    side?: LifeOpsConnectorSide,
  ): Promise<void> {
    const calendarClause = calendarId
      ? `AND calendar_id = ${sqlQuote(calendarId)}`
      : "";
    const sideClause = side ? `AND side = ${sqlQuote(side)}` : "";
    await executeRawSql(
      this.runtime,
      `DELETE FROM app_lifeops.life_calendar_events
        WHERE agent_id = ${sqlQuote(agentId)}
          AND provider = ${sqlQuote(provider)}
          ${calendarClause}
          ${sideClause}`,
    );
  }

  async deleteCalendarEventByExternalId(
    agentId: string,
    provider: LifeOpsConnectorGrant["provider"],
    calendarId: string | null | undefined,
    externalEventId: string,
    side?: LifeOpsConnectorSide,
  ): Promise<void> {
    const sideClause = side ? `AND side = ${sqlQuote(side)}` : "";
    const calendarClause =
      calendarId && calendarId !== "all"
        ? `AND calendar_id = ${sqlQuote(calendarId)}`
        : "";
    await executeRawSql(
      this.runtime,
      `DELETE FROM app_lifeops.life_calendar_events
        WHERE agent_id = ${sqlQuote(agentId)}
          AND provider = ${sqlQuote(provider)}
          ${calendarClause}
          AND external_event_id = ${sqlQuote(externalEventId)}
          ${sideClause}`,
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
    const calendarClause =
      calendarId && calendarId !== "all"
        ? `AND calendar_id = ${sqlQuote(calendarId)}`
        : "";
    const keepClause =
      keepExternalIds.length > 0
        ? `AND external_event_id NOT IN (${keepExternalIds
            .map((externalId) => sqlQuote(externalId))
            .join(", ")})`
        : "";
    await executeRawSql(
      this.runtime,
      `DELETE FROM app_lifeops.life_calendar_events
        WHERE agent_id = ${sqlQuote(agentId)}
          AND provider = ${sqlQuote(provider)}
          AND side = ${sqlQuote(side)}
          ${calendarClause}
          AND end_at > ${sqlQuote(timeMin)}
          AND start_at < ${sqlQuote(timeMax)}
          ${keepClause}`,
    );
  }

  async listCalendarEvents(
    agentId: string,
    provider: LifeOpsConnectorGrant["provider"],
    timeMin?: string,
    timeMax?: string,
    side?: LifeOpsConnectorSide,
  ): Promise<LifeOpsCalendarEvent[]> {
    const timeMinClause = timeMin ? `AND end_at > ${sqlQuote(timeMin)}` : "";
    const timeMaxClause = timeMax ? `AND start_at < ${sqlQuote(timeMax)}` : "";
    const sideClause = side ? `AND side = ${sqlQuote(side)}` : "";
    const rows = await executeRawSql(
      this.runtime,
      `SELECT *
         FROM app_lifeops.life_calendar_events
        WHERE agent_id = ${sqlQuote(agentId)}
          AND provider = ${sqlQuote(provider)}
          ${sideClause}
          ${timeMinClause}
          ${timeMaxClause}
        ORDER BY start_at ASC`,
    );
    return rows.map(parseCalendarEvent);
  }

  /**
   * Returns events whose `end_at` falls in (cursorEndAt, upToIso] OR
   * (end_at == cursorEndAt AND id > cursorId). Ordered by (end_at, id)
   * ascending so callers can advance a tuple cursor and never re-fire for the
   * same event.
   */
  async listCalendarEventsEndedAfterCursor(args: {
    agentId: string;
    provider: LifeOpsConnectorGrant["provider"];
    side?: LifeOpsConnectorSide;
    cursorEndAt: string | null;
    cursorEventId: string | null;
    upToIso: string;
    limit: number;
  }): Promise<LifeOpsCalendarEvent[]> {
    const sideClause = args.side ? `AND side = ${sqlQuote(args.side)}` : "";
    let cursorClause = "";
    if (args.cursorEndAt) {
      cursorClause = args.cursorEventId
        ? `AND (end_at > ${sqlQuote(args.cursorEndAt)}
              OR (end_at = ${sqlQuote(args.cursorEndAt)} AND id > ${sqlQuote(args.cursorEventId)}))`
        : `AND end_at > ${sqlQuote(args.cursorEndAt)}`;
    }
    const rows = await executeRawSql(
      this.runtime,
      `SELECT *
         FROM app_lifeops.life_calendar_events
        WHERE agent_id = ${sqlQuote(args.agentId)}
          AND provider = ${sqlQuote(args.provider)}
          ${sideClause}
          AND end_at <= ${sqlQuote(args.upToIso)}
          ${cursorClause}
        ORDER BY end_at ASC, id ASC
        LIMIT ${Math.max(1, Math.floor(args.limit))}`,
    );
    return rows.map(parseCalendarEvent);
  }

  async upsertCalendarSyncState(
    state: LifeOpsCalendarSyncState,
  ): Promise<void> {
    await executeRawSql(
      this.runtime,
      `INSERT INTO app_lifeops.life_calendar_sync_states (
        id, agent_id, provider, side, calendar_id, window_start_at,
        window_end_at, synced_at, updated_at
      ) VALUES (
        ${sqlQuote(state.id)},
        ${sqlQuote(state.agentId)},
        ${sqlQuote(state.provider)},
        ${sqlQuote(state.side)},
        ${sqlQuote(state.calendarId)},
        ${sqlQuote(state.windowStartAt)},
        ${sqlQuote(state.windowEndAt)},
        ${sqlQuote(state.syncedAt)},
        ${sqlQuote(state.updatedAt)}
      )
      ON CONFLICT(agent_id, provider, side, calendar_id) DO UPDATE SET
        window_start_at = excluded.window_start_at,
        window_end_at = excluded.window_end_at,
        synced_at = excluded.synced_at,
        updated_at = excluded.updated_at`,
    );
  }

  async getCalendarSyncState(
    agentId: string,
    provider: LifeOpsConnectorGrant["provider"],
    calendarId: string,
    side?: LifeOpsConnectorSide,
  ): Promise<LifeOpsCalendarSyncState | null> {
    const sideClause = side ? `AND side = ${sqlQuote(side)}` : "";
    const rows = await executeRawSql(
      this.runtime,
      `SELECT *
         FROM app_lifeops.life_calendar_sync_states
        WHERE agent_id = ${sqlQuote(agentId)}
          AND provider = ${sqlQuote(provider)}
          AND calendar_id = ${sqlQuote(calendarId)}
          ${sideClause}
        LIMIT 1`,
    );
    const row = rows[0];
    return row ? parseCalendarSyncState(row) : null;
  }

  async deleteCalendarSyncState(
    agentId: string,
    provider: LifeOpsConnectorGrant["provider"],
    calendarId?: string,
    side?: LifeOpsConnectorSide,
  ): Promise<void> {
    const calendarClause = calendarId
      ? `AND calendar_id = ${sqlQuote(calendarId)}`
      : "";
    const sideClause = side ? `AND side = ${sqlQuote(side)}` : "";
    await executeRawSql(
      this.runtime,
      `DELETE FROM app_lifeops.life_calendar_sync_states
        WHERE agent_id = ${sqlQuote(agentId)}
          AND provider = ${sqlQuote(provider)}
          ${calendarClause}
          ${sideClause}`,
    );
  }
}
