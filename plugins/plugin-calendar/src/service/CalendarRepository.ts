/**
 * SQL persistence for cached calendar events and per-grant sync state in the
 * `app_calendar` schema. Reads and writes the `life_calendar_events` /
 * `life_calendar_sync_states` tables through the runtime db, mapping DB rows to
 * `LifeOpsCalendarEvent`; every raw statement qualifies its table with the
 * `app_calendar.` prefix.
 */
import { ElizaError, type IAgentRuntime } from "@elizaos/core";
import type {
  LifeOpsCalendarEvent,
  LifeOpsCalendarProvider,
  LifeOpsCalendarSourceError,
  LifeOpsConnectorGrant,
  LifeOpsConnectorSide,
  LifeOpsIcsSourceSyncStatus,
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
  toNumber,
  toText,
} from "../internal/sql.js";

export interface LifeOpsCalendarSyncState {
  id: string;
  agentId: string;
  provider: LifeOpsConnectorGrant["provider"];
  side: LifeOpsConnectorSide;
  grantId: string;
  connectorAccountId: string;
  calendarId: string;
  windowStartAt: string;
  windowEndAt: string;
  nextSyncToken: string | null;
  syncedAt: string;
  updatedAt: string;
}

export interface IcsCalendarSourceRecord {
  id: string;
  agentId: string;
  provider: "ics";
  side: "owner";
  name: string;
  enabled: boolean;
  secretRef: string;
  urlFingerprint: string;
  origin: string;
  etag: string | null;
  lastModified: string | null;
  contentHash: string | null;
  syncStatus: LifeOpsIcsSourceSyncStatus;
  error: LifeOpsCalendarSourceError | null;
  lastSyncedAt: string | null;
  lastAttemptedAt: string | null;
  syncGeneration: number;
  leaseToken: string | null;
  leaseExpiresAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface IcsSecretCleanupRecord {
  id: string;
  agentId: string;
  sourceId: string;
  secretRef: string;
  reason: "source_deleted" | "url_rotated";
  attemptCount: number;
  lastAttemptAt: string | null;
  lastErrorCode: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface IcsCalendarSyncLease {
  source: IcsCalendarSourceRecord;
  generation: number;
  token: string;
}

export interface IcsCalendarReconciliationResult {
  source: IcsCalendarSourceRecord;
  acceptedEvents: number;
  prunedEvents: number;
  tombstones: number;
}

export function createLifeOpsCalendarSyncState(
  params: Omit<LifeOpsCalendarSyncState, "id" | "updatedAt">,
): LifeOpsCalendarSyncState {
  return {
    ...params,
    id: [
      params.agentId,
      params.provider,
      params.side,
      "grant",
      params.grantId,
      "calendar",
      params.calendarId,
    ].join(":"),
    updatedAt: new Date().toISOString(),
  };
}

function parseCalendarEvent(
  row: Record<string, unknown>,
): LifeOpsCalendarEvent {
  const metadata = parseJsonRecord(row.metadata_json);
  const metadataRecurrence = Array.isArray(metadata.recurrence)
    ? metadata.recurrence.filter(
        (line): line is string => typeof line === "string" && line.length > 0,
      )
    : [];
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
    metadata,
    recurrence: metadataRecurrence.length > 0 ? metadataRecurrence : null,
    recurringEventId:
      typeof metadata.recurringEventId === "string" &&
      metadata.recurringEventId.length > 0
        ? metadata.recurringEventId
        : null,
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
    grantId: toText(row.grant_id),
    connectorAccountId: toText(row.connector_account_id),
    calendarId: toText(row.calendar_id),
    windowStartAt: toText(row.window_start_at),
    windowEndAt: toText(row.window_end_at),
    nextSyncToken: row.next_sync_token ? toText(row.next_sync_token) : null,
    syncedAt: toText(row.synced_at),
    updatedAt: toText(row.updated_at),
  };
}

function parseIcsCalendarSource(
  row: Record<string, unknown>,
): IcsCalendarSourceRecord {
  const errorCode = row.last_error_code ? toText(row.last_error_code) : null;
  return {
    id: toText(row.id),
    agentId: toText(row.agent_id),
    provider: "ics",
    side: "owner",
    name: toText(row.name),
    enabled: toBoolean(row.enabled),
    secretRef: toText(row.secret_ref),
    urlFingerprint: toText(row.url_fingerprint),
    origin: toText(row.origin),
    etag: row.etag ? toText(row.etag) : null,
    lastModified: row.last_modified ? toText(row.last_modified) : null,
    contentHash: row.content_hash ? toText(row.content_hash) : null,
    syncStatus: toText(row.sync_status, "never") as LifeOpsIcsSourceSyncStatus,
    error: errorCode
      ? {
          code: errorCode,
          message: toText(
            row.last_error_message,
            "Calendar subscription sync failed.",
          ),
          retryable: toBoolean(row.last_error_retryable),
        }
      : null,
    lastSyncedAt: row.last_synced_at ? toText(row.last_synced_at) : null,
    lastAttemptedAt: row.last_attempted_at
      ? toText(row.last_attempted_at)
      : null,
    syncGeneration: toNumber(row.sync_generation),
    leaseToken: row.lease_token ? toText(row.lease_token) : null,
    leaseExpiresAt: row.lease_expires_at ? toText(row.lease_expires_at) : null,
    createdAt: toText(row.created_at),
    updatedAt: toText(row.updated_at),
  };
}

function parseIcsSecretCleanup(
  row: Record<string, unknown>,
): IcsSecretCleanupRecord {
  const reason = toText(row.reason);
  if (reason !== "source_deleted" && reason !== "url_rotated") {
    throw new ElizaError("Calendar secret cleanup reason is invalid.", {
      code: "ICS_SECRET_CLEANUP_INVALID_STATE",
      context: { cleanupId: toText(row.id), reason },
      severity: "fatal",
    });
  }
  return {
    id: toText(row.id),
    agentId: toText(row.agent_id),
    sourceId: toText(row.source_id),
    secretRef: toText(row.secret_ref),
    reason,
    attemptCount: toNumber(row.attempt_count),
    lastAttemptAt: row.last_attempt_at ? toText(row.last_attempt_at) : null,
    lastErrorCode: row.last_error_code ? toText(row.last_error_code) : null,
    createdAt: toText(row.created_at),
    updatedAt: toText(row.updated_at),
  };
}

function calendarEventValues(event: LifeOpsCalendarEvent): string {
  return `(
    ${sqlQuote(event.id)},
    ${sqlQuote(event.agentId)},
    ${sqlQuote(event.provider)},
    ${sqlQuote(event.side)},
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
    ${sqlText(event.connectorAccountId)},
    ${sqlText(event.grantId)},
    ${sqlJson(event.metadata)},
    ${sqlQuote(event.syncedAt)},
    ${sqlQuote(event.updatedAt)}
  )`;
}

/**
 * Data-access layer for the calendar event + sync-state tables. Mirrors the
 * raw-SQL pattern of `LifeOpsRepository`: every statement runs through the
 * runtime database adapter via `executeRawSql`, and table names stay qualified
 * with the `app_calendar.` schema prefix.
 */
export class CalendarRepository {
  constructor(private readonly runtime: IAgentRuntime) {}

  async insertCalendarEventIfAbsent(
    event: LifeOpsCalendarEvent,
  ): Promise<{ event: LifeOpsCalendarEvent; inserted: boolean }> {
    const rows = await executeRawSql(
      this.runtime,
      `INSERT INTO app_calendar.life_calendar_events (
        id, agent_id, provider, side, calendar_id, external_event_id, title,
        description, location, status, start_at, end_at, is_all_day,
        timezone, html_link, conference_link, organizer_json, attendees_json,
        connector_account_id, grant_id, metadata_json, synced_at, updated_at
      ) VALUES ${calendarEventValues(event)}
      ON CONFLICT DO NOTHING
      RETURNING *`,
    );
    const inserted = rows[0];
    if (inserted) {
      return { event: parseCalendarEvent(inserted), inserted: true };
    }
    const existing = await this.getCalendarEventById(event.agentId, event.id);
    if (!existing) {
      throw new ElizaError(
        "Calendar event idempotency conflict did not resolve to its original row.",
        {
          code: "CALENDAR_EVENT_IDEMPOTENCY_CONFLICT",
          context: { agentId: event.agentId, eventId: event.id },
          severity: "fatal",
        },
      );
    }
    return { event: existing, inserted: false };
  }

  async upsertCalendarEvent(
    event: LifeOpsCalendarEvent,
    side: LifeOpsConnectorSide = event.side,
  ): Promise<void> {
    const connectorAccountId = event.connectorAccountId ?? null;
    await executeRawSql(
      this.runtime,
      `INSERT INTO app_calendar.life_calendar_events (
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
      ON CONFLICT(id) DO UPDATE SET
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
        connector_account_id = COALESCE(excluded.connector_account_id, app_calendar.life_calendar_events.connector_account_id),
        grant_id = COALESCE(excluded.grant_id, app_calendar.life_calendar_events.grant_id),
        metadata_json = excluded.metadata_json,
        synced_at = excluded.synced_at,
        updated_at = excluded.updated_at`,
    );
  }

  async deleteCalendarEventsForProvider(
    agentId: string,
    provider: LifeOpsCalendarProvider,
    calendarId?: string,
    side?: LifeOpsConnectorSide,
  ): Promise<void> {
    const calendarClause = calendarId
      ? `AND calendar_id = ${sqlQuote(calendarId)}`
      : "";
    const sideClause = side ? `AND side = ${sqlQuote(side)}` : "";
    await executeRawSql(
      this.runtime,
      `DELETE FROM app_calendar.life_calendar_events
        WHERE agent_id = ${sqlQuote(agentId)}
          AND provider = ${sqlQuote(provider)}
          ${calendarClause}
          ${sideClause}`,
    );
  }

  async purgeImportedCalendarProjection(args: {
    agentId: string;
    provider: Extract<LifeOpsCalendarProvider, "google" | "apple_calendar">;
    side: LifeOpsConnectorSide;
    grantId: string;
    connectorAccountId: string;
  }): Promise<{ deletedEventCount: number; deletedSyncStateCount: number }> {
    const rows = await executeRawSql(
      this.runtime,
      `WITH deleted_events AS (
         DELETE FROM app_calendar.life_calendar_events
          WHERE agent_id = ${sqlQuote(args.agentId)}
            AND provider = ${sqlQuote(args.provider)}
            AND side = ${sqlQuote(args.side)}
            AND grant_id = ${sqlQuote(args.grantId)}
            AND connector_account_id = ${sqlQuote(args.connectorAccountId)}
         RETURNING id
       ), deleted_sync_states AS (
         DELETE FROM app_calendar.life_calendar_sync_states
          WHERE agent_id = ${sqlQuote(args.agentId)}
            AND provider = ${sqlQuote(args.provider)}
            AND side = ${sqlQuote(args.side)}
            AND grant_id = ${sqlQuote(args.grantId)}
            AND connector_account_id = ${sqlQuote(args.connectorAccountId)}
         RETURNING id
       )
       SELECT
         (SELECT COUNT(*) FROM deleted_events) AS deleted_event_count,
         (SELECT COUNT(*) FROM deleted_sync_states) AS deleted_sync_state_count`,
    );
    return {
      deletedEventCount: toNumber(rows[0]?.deleted_event_count, 0),
      deletedSyncStateCount: toNumber(rows[0]?.deleted_sync_state_count, 0),
    };
  }

  async deleteCalendarEventByExternalId(
    agentId: string,
    provider: LifeOpsCalendarProvider,
    calendarId: string | null | undefined,
    externalEventId: string,
    side?: LifeOpsConnectorSide,
    grantId?: string,
  ): Promise<void> {
    const sideClause = side ? `AND side = ${sqlQuote(side)}` : "";
    const grantClause = grantId ? `AND grant_id = ${sqlQuote(grantId)}` : "";
    const calendarClause =
      calendarId && calendarId !== "all"
        ? `AND calendar_id = ${sqlQuote(calendarId)}`
        : "";
    await executeRawSql(
      this.runtime,
      `DELETE FROM app_calendar.life_calendar_events
        WHERE agent_id = ${sqlQuote(agentId)}
          AND provider = ${sqlQuote(provider)}
          ${calendarClause}
          AND external_event_id = ${sqlQuote(externalEventId)}
          ${sideClause}
          ${grantClause}`,
    );
  }

  async deleteCalendarEventById(
    agentId: string,
    eventId: string,
  ): Promise<void> {
    await executeRawSql(
      this.runtime,
      `DELETE FROM app_calendar.life_calendar_events
        WHERE agent_id = ${sqlQuote(agentId)}
          AND id = ${sqlQuote(eventId)}`,
    );
  }

  async deleteCalendarEventByIdIfVersion(args: {
    agentId: string;
    eventId: string;
    expectedVersion: string;
  }): Promise<boolean> {
    const rows = await executeRawSql(
      this.runtime,
      `DELETE FROM app_calendar.life_calendar_events
        WHERE agent_id = ${sqlQuote(args.agentId)}
          AND id = ${sqlQuote(args.eventId)}
          AND metadata_json::jsonb ->> 'etag' = ${sqlQuote(args.expectedVersion)}
      RETURNING id`,
    );
    return rows.length === 1;
  }

  async pruneCalendarEventsInWindow(
    agentId: string,
    provider: LifeOpsCalendarProvider,
    calendarId: string,
    timeMin: string,
    timeMax: string,
    keepExternalIds: readonly string[],
    side: LifeOpsConnectorSide = "owner",
    grantId?: string | null,
  ): Promise<void> {
    const calendarClause =
      calendarId && calendarId !== "all"
        ? `AND calendar_id = ${sqlQuote(calendarId)}`
        : "";
    // Multi-account safety: two grants can expose a calendar with the same
    // calendarId (every Google account names its default calendar "primary"),
    // and the keep-list only contains the syncing grant's event ids — so an
    // unscoped prune lets one account's sync delete the other account's cached
    // events on every pass. When the caller syncs on behalf of a grant, only
    // that grant's rows are pruned (plus legacy rows that predate grant
    // attribution, so they converge instead of going permanently stale).
    const grantClause = grantId
      ? `AND (grant_id = ${sqlQuote(grantId)} OR grant_id IS NULL)`
      : "";
    const keepClause =
      keepExternalIds.length > 0
        ? `AND external_event_id NOT IN (${keepExternalIds
            .map((externalId) => sqlQuote(externalId))
            .join(", ")})`
        : "";
    await executeRawSql(
      this.runtime,
      `DELETE FROM app_calendar.life_calendar_events
        WHERE agent_id = ${sqlQuote(agentId)}
          AND provider = ${sqlQuote(provider)}
          AND side = ${sqlQuote(side)}
          ${calendarClause}
          ${grantClause}
          AND end_at > ${sqlQuote(timeMin)}
          AND start_at < ${sqlQuote(timeMax)}
          ${keepClause}`,
    );
  }

  async getCalendarEventById(
    agentId: string,
    eventId: string,
  ): Promise<LifeOpsCalendarEvent | null> {
    const rows = await executeRawSql(
      this.runtime,
      `SELECT *
         FROM app_calendar.life_calendar_events
        WHERE agent_id = ${sqlQuote(agentId)}
          AND id = ${sqlQuote(eventId)}
        LIMIT 1`,
    );
    const row = rows[0];
    return row ? parseCalendarEvent(row) : null;
  }

  async getCalendarEventByExternalId(args: {
    agentId: string;
    provider: LifeOpsCalendarProvider;
    externalEventId: string;
    calendarId?: string | null;
    side?: LifeOpsConnectorSide;
    grantId?: string;
  }): Promise<LifeOpsCalendarEvent | null> {
    const calendarClause =
      args.calendarId && args.calendarId !== "all"
        ? `AND calendar_id = ${sqlQuote(args.calendarId)}`
        : "";
    const sideClause = args.side ? `AND side = ${sqlQuote(args.side)}` : "";
    const grantClause = args.grantId
      ? `AND grant_id = ${sqlQuote(args.grantId)}`
      : "";
    const rows = await executeRawSql(
      this.runtime,
      `SELECT *
         FROM app_calendar.life_calendar_events
        WHERE agent_id = ${sqlQuote(args.agentId)}
          AND provider = ${sqlQuote(args.provider)}
          AND external_event_id = ${sqlQuote(args.externalEventId)}
          ${calendarClause}
          ${sideClause}
          ${grantClause}
        LIMIT 1`,
    );
    const row = rows[0];
    return row ? parseCalendarEvent(row) : null;
  }

  async replaceCalendarEventIfVersion(args: {
    event: LifeOpsCalendarEvent;
    expectedVersion: string;
  }): Promise<LifeOpsCalendarEvent | null> {
    const event = args.event;
    const rows = await executeRawSql(
      this.runtime,
      `UPDATE app_calendar.life_calendar_events SET
        title = ${sqlQuote(event.title)},
        description = ${sqlQuote(event.description)},
        location = ${sqlQuote(event.location)},
        status = ${sqlQuote(event.status)},
        start_at = ${sqlQuote(event.startAt)},
        end_at = ${sqlQuote(event.endAt)},
        is_all_day = ${sqlBoolean(event.isAllDay)},
        timezone = ${sqlText(event.timezone)},
        html_link = ${sqlText(event.htmlLink)},
        conference_link = ${sqlText(event.conferenceLink)},
        organizer_json = ${event.organizer ? sqlJson(event.organizer) : "NULL"},
        attendees_json = ${sqlJson(event.attendees)},
        metadata_json = ${sqlJson(event.metadata)},
        synced_at = ${sqlQuote(event.syncedAt)},
        updated_at = ${sqlQuote(event.updatedAt)}
        WHERE agent_id = ${sqlQuote(event.agentId)}
          AND id = ${sqlQuote(event.id)}
          AND metadata_json::jsonb ->> 'etag' = ${sqlQuote(args.expectedVersion)}
      RETURNING *`,
    );
    const row = rows[0];
    return row ? parseCalendarEvent(row) : null;
  }

  async listCalendarEvents(
    agentId: string,
    provider: LifeOpsCalendarProvider,
    timeMin?: string,
    timeMax?: string,
    side?: LifeOpsConnectorSide,
    grantId?: string,
  ): Promise<LifeOpsCalendarEvent[]> {
    const timeMinClause = timeMin ? `AND end_at > ${sqlQuote(timeMin)}` : "";
    const timeMaxClause = timeMax ? `AND start_at < ${sqlQuote(timeMax)}` : "";
    const sideClause = side ? `AND side = ${sqlQuote(side)}` : "";
    const grantClause = grantId ? `AND grant_id = ${sqlQuote(grantId)}` : "";
    const rows = await executeRawSql(
      this.runtime,
      `SELECT *
         FROM app_calendar.life_calendar_events
        WHERE agent_id = ${sqlQuote(agentId)}
          AND provider = ${sqlQuote(provider)}
          ${sideClause}
          ${grantClause}
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
    provider: LifeOpsCalendarProvider;
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
         FROM app_calendar.life_calendar_events
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
      `INSERT INTO app_calendar.life_calendar_sync_states (
        id, agent_id, provider, side, calendar_id, connector_account_id,
        grant_id, window_start_at, window_end_at, next_sync_token, synced_at,
        updated_at
      ) VALUES (
        ${sqlQuote(state.id)},
        ${sqlQuote(state.agentId)},
        ${sqlQuote(state.provider)},
        ${sqlQuote(state.side)},
        ${sqlQuote(state.calendarId)},
        ${sqlQuote(state.connectorAccountId)},
        ${sqlQuote(state.grantId)},
        ${sqlQuote(state.windowStartAt)},
        ${sqlQuote(state.windowEndAt)},
        ${sqlText(state.nextSyncToken)},
        ${sqlQuote(state.syncedAt)},
        ${sqlQuote(state.updatedAt)}
      )
      ON CONFLICT(id) DO UPDATE SET
        connector_account_id = excluded.connector_account_id,
        grant_id = excluded.grant_id,
        window_start_at = excluded.window_start_at,
        window_end_at = excluded.window_end_at,
        next_sync_token = excluded.next_sync_token,
        synced_at = excluded.synced_at,
        updated_at = excluded.updated_at`,
    );
  }

  async getCalendarSyncState(
    agentId: string,
    provider: LifeOpsCalendarProvider,
    calendarId: string,
    side?: LifeOpsConnectorSide,
    grantId?: string,
  ): Promise<LifeOpsCalendarSyncState | null> {
    const sideClause = side ? `AND side = ${sqlQuote(side)}` : "";
    const grantClause = grantId ? `AND grant_id = ${sqlQuote(grantId)}` : "";
    const rows = await executeRawSql(
      this.runtime,
      `SELECT *
         FROM app_calendar.life_calendar_sync_states
        WHERE agent_id = ${sqlQuote(agentId)}
          AND provider = ${sqlQuote(provider)}
          AND calendar_id = ${sqlQuote(calendarId)}
          ${sideClause}
          ${grantClause}
        LIMIT 1`,
    );
    const row = rows[0];
    return row ? parseCalendarSyncState(row) : null;
  }

  async deleteCalendarSyncState(
    agentId: string,
    provider: LifeOpsCalendarProvider,
    calendarId?: string,
    side?: LifeOpsConnectorSide,
    grantId?: string,
  ): Promise<void> {
    const calendarClause = calendarId
      ? `AND calendar_id = ${sqlQuote(calendarId)}`
      : "";
    const sideClause = side ? `AND side = ${sqlQuote(side)}` : "";
    const grantClause = grantId ? `AND grant_id = ${sqlQuote(grantId)}` : "";
    await executeRawSql(
      this.runtime,
      `DELETE FROM app_calendar.life_calendar_sync_states
        WHERE agent_id = ${sqlQuote(agentId)}
          AND provider = ${sqlQuote(provider)}
          ${calendarClause}
          ${sideClause}
      ${grantClause}`,
    );
  }

  async createIcsCalendarSource(
    source: IcsCalendarSourceRecord,
  ): Promise<IcsCalendarSourceRecord> {
    const rows = await executeRawSql(
      this.runtime,
      `INSERT INTO app_calendar.life_calendar_sources (
        id, agent_id, provider, side, name, enabled, secret_ref,
        url_fingerprint, origin, etag, last_modified, content_hash,
        sync_status, last_error_code, last_error_message,
        last_error_retryable, last_synced_at, last_attempted_at,
        sync_generation, lease_token, lease_expires_at, created_at, updated_at
      ) VALUES (
        ${sqlQuote(source.id)},
        ${sqlQuote(source.agentId)},
        'ics',
        'owner',
        ${sqlQuote(source.name)},
        ${sqlBoolean(source.enabled)},
        ${sqlQuote(source.secretRef)},
        ${sqlQuote(source.urlFingerprint)},
        ${sqlQuote(source.origin)},
        NULL, NULL, NULL, 'never', NULL, NULL, NULL, NULL, NULL, 0, NULL,
        NULL, ${sqlQuote(source.createdAt)}, ${sqlQuote(source.updatedAt)}
      )
      RETURNING *`,
    );
    const row = rows[0];
    if (!row) {
      throw new ElizaError(
        "Calendar subscription source insert returned no row.",
        {
          code: "ICS_SOURCE_INSERT_INVARIANT",
          context: { sourceId: source.id, agentId: source.agentId },
          severity: "fatal",
        },
      );
    }
    return parseIcsCalendarSource(row);
  }

  async listIcsCalendarSources(
    agentId: string,
    enabledOnly = false,
  ): Promise<IcsCalendarSourceRecord[]> {
    const rows = await executeRawSql(
      this.runtime,
      `SELECT *
         FROM app_calendar.life_calendar_sources
        WHERE agent_id = ${sqlQuote(agentId)}
          AND provider = 'ics'
          ${enabledOnly ? "AND enabled = TRUE" : ""}
        ORDER BY created_at ASC, id ASC`,
    );
    return rows.map(parseIcsCalendarSource);
  }

  async getIcsCalendarSource(
    agentId: string,
    sourceId: string,
  ): Promise<IcsCalendarSourceRecord | null> {
    const rows = await executeRawSql(
      this.runtime,
      `SELECT *
         FROM app_calendar.life_calendar_sources
        WHERE agent_id = ${sqlQuote(agentId)}
          AND id = ${sqlQuote(sourceId)}
          AND provider = 'ics'
        LIMIT 1`,
    );
    const row = rows[0];
    return row ? parseIcsCalendarSource(row) : null;
  }

  async updateIcsCalendarSource(args: {
    agentId: string;
    sourceId: string;
    name: string;
    updatedAt: string;
    replacement?: {
      secretRef: string;
      urlFingerprint: string;
      origin: string;
      retiredSecretRef: string;
      cleanupId: string;
      cleanupAt: string;
    };
  }): Promise<IcsCalendarSourceRecord | null> {
    const replacement = args.replacement;
    const updateStatement = `UPDATE app_calendar.life_calendar_sources
        SET name = ${sqlQuote(args.name)},
            updated_at = ${sqlQuote(args.updatedAt)},
            sync_generation = sync_generation + 1,
            lease_token = NULL,
            lease_expires_at = NULL
            ${
              replacement
                ? `,
            secret_ref = ${sqlQuote(replacement.secretRef)},
            url_fingerprint = ${sqlQuote(replacement.urlFingerprint)},
            origin = ${sqlQuote(replacement.origin)},
            etag = NULL,
            last_modified = NULL,
            content_hash = NULL,
            sync_status = 'never',
            last_error_code = NULL,
            last_error_message = NULL,
            last_error_retryable = NULL,
            last_synced_at = NULL`
                : ""
            }
      WHERE agent_id = ${sqlQuote(args.agentId)}
        AND id = ${sqlQuote(args.sourceId)}
        AND provider = 'ics'
        ${
          replacement
            ? `AND secret_ref = ${sqlQuote(replacement.retiredSecretRef)}`
            : ""
        }
      RETURNING *`;
    const statement = replacement
      ? `WITH updated_source AS (
          ${updateStatement}
        ), retired_snapshot AS (
          DELETE FROM app_calendar.life_calendar_events AS event
          USING updated_source
           WHERE event.agent_id = ${sqlQuote(args.agentId)}
             AND event.provider = 'ics'
             AND event.grant_id = updated_source.id
        ), cleanup AS (
          INSERT INTO app_calendar.life_calendar_secret_cleanup (
            id, agent_id, source_id, secret_ref, reason, attempt_count,
            last_attempt_at, last_error_code, created_at, updated_at
          )
          SELECT
            ${sqlQuote(replacement.cleanupId)},
            ${sqlQuote(args.agentId)},
            updated_source.id,
            ${sqlQuote(replacement.retiredSecretRef)},
            'url_rotated',
            0,
            NULL,
            NULL,
            ${sqlQuote(replacement.cleanupAt)},
            ${sqlQuote(replacement.cleanupAt)}
          FROM updated_source
          ON CONFLICT (agent_id, secret_ref) DO NOTHING
        )
        SELECT * FROM updated_source`
      : updateStatement;
    const rows = await executeRawSql(this.runtime, statement);
    const row = rows[0];
    return row ? parseIcsCalendarSource(row) : null;
  }

  async deleteIcsCalendarSource(
    agentId: string,
    sourceId: string,
    cleanup: { id: string; createdAt: string },
  ): Promise<IcsCalendarSourceRecord | null> {
    const rows = await executeRawSql(
      this.runtime,
      `WITH source AS (
        DELETE FROM app_calendar.life_calendar_sources
         WHERE agent_id = ${sqlQuote(agentId)}
           AND id = ${sqlQuote(sourceId)}
           AND provider = 'ics'
         RETURNING *
      ), deleted_events AS (
        DELETE FROM app_calendar.life_calendar_events
         WHERE agent_id = ${sqlQuote(agentId)}
           AND provider = 'ics'
           AND grant_id = ${sqlQuote(sourceId)}
      ), cleanup AS (
        INSERT INTO app_calendar.life_calendar_secret_cleanup (
          id, agent_id, source_id, secret_ref, reason, attempt_count,
          last_attempt_at, last_error_code, created_at, updated_at
        )
        SELECT
          ${sqlQuote(cleanup.id)},
          ${sqlQuote(agentId)},
          source.id,
          source.secret_ref,
          'source_deleted',
          0,
          NULL,
          NULL,
          ${sqlQuote(cleanup.createdAt)},
          ${sqlQuote(cleanup.createdAt)}
        FROM source
        ON CONFLICT (agent_id, secret_ref) DO NOTHING
      )
      SELECT * FROM source`,
    );
    const row = rows[0];
    return row ? parseIcsCalendarSource(row) : null;
  }

  async listIcsSecretCleanup(
    agentId: string,
    limit = 100,
  ): Promise<IcsSecretCleanupRecord[]> {
    const boundedLimit = Math.max(1, Math.min(1_000, Math.floor(limit)));
    const rows = await executeRawSql(
      this.runtime,
      `SELECT *
         FROM app_calendar.life_calendar_secret_cleanup
        WHERE agent_id = ${sqlQuote(agentId)}
        ORDER BY created_at ASC, id ASC
        LIMIT ${boundedLimit}`,
    );
    return rows.map(parseIcsSecretCleanup);
  }

  async acknowledgeIcsSecretCleanup(
    agentId: string,
    cleanupId: string,
  ): Promise<void> {
    await executeRawSql(
      this.runtime,
      `DELETE FROM app_calendar.life_calendar_secret_cleanup
        WHERE agent_id = ${sqlQuote(agentId)}
          AND id = ${sqlQuote(cleanupId)}`,
    );
  }

  async recordIcsSecretCleanupFailure(args: {
    agentId: string;
    cleanupId: string;
    attemptedAt: string;
    errorCode: string;
  }): Promise<void> {
    await executeRawSql(
      this.runtime,
      `UPDATE app_calendar.life_calendar_secret_cleanup
          SET attempt_count = attempt_count + 1,
              last_attempt_at = ${sqlQuote(args.attemptedAt)},
              last_error_code = ${sqlQuote(args.errorCode)},
              updated_at = ${sqlQuote(args.attemptedAt)}
        WHERE agent_id = ${sqlQuote(args.agentId)}
          AND id = ${sqlQuote(args.cleanupId)}`,
    );
  }

  async claimIcsCalendarSync(args: {
    agentId: string;
    sourceId: string;
    token: string;
    attemptedAt: string;
    leaseExpiresAt: string;
  }): Promise<IcsCalendarSyncLease | null> {
    const rows = await executeRawSql(
      this.runtime,
      `UPDATE app_calendar.life_calendar_sources
          SET sync_generation = sync_generation + 1,
              lease_token = ${sqlQuote(args.token)},
              lease_expires_at = ${sqlQuote(args.leaseExpiresAt)},
              last_attempted_at = ${sqlQuote(args.attemptedAt)},
              updated_at = ${sqlQuote(args.attemptedAt)}
        WHERE agent_id = ${sqlQuote(args.agentId)}
          AND id = ${sqlQuote(args.sourceId)}
          AND provider = 'ics'
          AND enabled = TRUE
          AND (
            lease_token IS NULL OR
            lease_expires_at IS NULL OR
            lease_expires_at <= ${sqlQuote(args.attemptedAt)}
          )
        RETURNING *`,
    );
    const row = rows[0];
    if (!row) return null;
    const source = parseIcsCalendarSource(row);
    return {
      source,
      generation: source.syncGeneration,
      token: args.token,
    };
  }

  async completeIcsCalendarNotModified(args: {
    agentId: string;
    sourceId: string;
    generation: number;
    token: string;
    completedAt: string;
    origin: string;
    etag: string | null;
    lastModified: string | null;
  }): Promise<IcsCalendarSourceRecord | null> {
    const rows = await executeRawSql(
      this.runtime,
      `UPDATE app_calendar.life_calendar_sources
          SET origin = ${sqlQuote(args.origin)},
              etag = ${sqlText(args.etag)},
              last_modified = ${sqlText(args.lastModified)},
              sync_status = CASE
                WHEN sync_status = 'never' THEN 'fresh'
                WHEN sync_status = 'error' THEN 'fresh'
                ELSE sync_status
              END,
              last_synced_at = ${sqlQuote(args.completedAt)},
              last_error_code = CASE
                WHEN sync_status = 'partial' THEN last_error_code
                ELSE NULL
              END,
              last_error_message = CASE
                WHEN sync_status = 'partial' THEN last_error_message
                ELSE NULL
              END,
              last_error_retryable = CASE
                WHEN sync_status = 'partial' THEN last_error_retryable
                ELSE NULL
              END,
              lease_token = NULL,
              lease_expires_at = NULL,
              updated_at = ${sqlQuote(args.completedAt)}
        WHERE agent_id = ${sqlQuote(args.agentId)}
          AND id = ${sqlQuote(args.sourceId)}
          AND provider = 'ics'
          AND content_hash IS NOT NULL
          AND last_synced_at IS NOT NULL
          AND sync_generation = ${Math.floor(args.generation)}
          AND lease_token = ${sqlQuote(args.token)}
        RETURNING *`,
    );
    const row = rows[0];
    return row ? parseIcsCalendarSource(row) : null;
  }

  async failIcsCalendarSync(args: {
    agentId: string;
    sourceId: string;
    generation: number;
    token: string;
    completedAt: string;
    error: LifeOpsCalendarSourceError;
  }): Promise<IcsCalendarSourceRecord | null> {
    const rows = await executeRawSql(
      this.runtime,
      `UPDATE app_calendar.life_calendar_sources
          SET sync_status = CASE
                WHEN sync_status = 'partial' THEN 'partial'
                ELSE 'error'
              END,
              last_error_code = ${sqlQuote(args.error.code)},
              last_error_message = ${sqlQuote(args.error.message)},
              last_error_retryable = ${sqlBoolean(args.error.retryable)},
              lease_token = NULL,
              lease_expires_at = NULL,
              updated_at = ${sqlQuote(args.completedAt)}
        WHERE agent_id = ${sqlQuote(args.agentId)}
          AND id = ${sqlQuote(args.sourceId)}
          AND provider = 'ics'
          AND sync_generation = ${Math.floor(args.generation)}
          AND lease_token = ${sqlQuote(args.token)}
        RETURNING *`,
    );
    const row = rows[0];
    return row ? parseIcsCalendarSource(row) : null;
  }

  /**
   * Applies one parsed snapshot and advances its source revision in the same
   * PostgreSQL statement. The lease guard is shared by every mutating CTE, so
   * an expired, slower fetch cannot write events or source health after a newer
   * generation has claimed the source.
   */
  async reconcileIcsCalendarSnapshot(args: {
    agentId: string;
    sourceId: string;
    generation: number;
    token: string;
    completedAt: string;
    origin: string;
    etag: string | null;
    lastModified: string | null;
    contentHash: string;
    state: "complete" | "partial";
    error: LifeOpsCalendarSourceError | null;
    events: LifeOpsCalendarEvent[];
  }): Promise<IcsCalendarReconciliationResult | null> {
    const eventColumns = `(
      id, agent_id, provider, side, calendar_id, external_event_id, title,
      description, location, status, start_at, end_at, is_all_day, timezone,
      html_link, conference_link, organizer_json, attendees_json,
      connector_account_id, grant_id, metadata_json, synced_at, updated_at
    )`;
    const incoming =
      args.events.length > 0
        ? `incoming ${eventColumns} AS (
            VALUES ${args.events.map(calendarEventValues).join(",\n")}
          )`
        : `incoming ${eventColumns} AS (
            SELECT
              NULL::text, NULL::text, NULL::text, NULL::text, NULL::text,
              NULL::text, NULL::text, NULL::text, NULL::text, NULL::text,
              NULL::text, NULL::text, NULL::boolean, NULL::text, NULL::text,
              NULL::text, NULL::text, NULL::text, NULL::text, NULL::text,
              NULL::text, NULL::text, NULL::text
            WHERE FALSE
          )`;
    const rows = await executeRawSql(
      this.runtime,
      `WITH guard AS (
        SELECT id
          FROM app_calendar.life_calendar_sources
         WHERE agent_id = ${sqlQuote(args.agentId)}
           AND id = ${sqlQuote(args.sourceId)}
           AND provider = 'ics'
           AND sync_generation = ${Math.floor(args.generation)}
           AND lease_token = ${sqlQuote(args.token)}
      ), ${incoming},
      upserted AS (
        INSERT INTO app_calendar.life_calendar_events ${eventColumns}
        SELECT incoming.*
          FROM incoming
          CROSS JOIN guard
        ON CONFLICT (id) DO UPDATE SET
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
          connector_account_id = excluded.connector_account_id,
          grant_id = excluded.grant_id,
          metadata_json = excluded.metadata_json,
          synced_at = excluded.synced_at,
          updated_at = excluded.updated_at
        WHERE
          COALESCE(
            (excluded.metadata_json::jsonb ->> 'icsSequence')::integer,
            0
          ) > COALESCE(
            (app_calendar.life_calendar_events.metadata_json::jsonb
              ->> 'icsSequence')::integer,
            0
          )
          OR (
            COALESCE(
              (excluded.metadata_json::jsonb ->> 'icsSequence')::integer,
              0
            ) = COALESCE(
              (app_calendar.life_calendar_events.metadata_json::jsonb
                ->> 'icsSequence')::integer,
              0
            )
            AND COALESCE(
              excluded.metadata_json::jsonb ->> 'icsRevisionAt',
              ''
            ) > COALESCE(
              app_calendar.life_calendar_events.metadata_json::jsonb
                ->> 'icsRevisionAt',
              ''
            )
          )
        RETURNING status
      ), pruned AS (
        DELETE FROM app_calendar.life_calendar_events AS event
        USING guard
         WHERE ${sqlBoolean(args.state === "complete")}
           AND event.agent_id = ${sqlQuote(args.agentId)}
           AND event.provider = 'ics'
           AND event.grant_id = ${sqlQuote(args.sourceId)}
           AND event.status <> 'cancelled'
           AND NOT EXISTS (
             SELECT 1 FROM incoming WHERE incoming.id = event.id
           )
        RETURNING event.id
      ), updated_source AS (
        UPDATE app_calendar.life_calendar_sources
           SET origin = ${sqlQuote(args.origin)},
               etag = ${sqlText(args.etag)},
               last_modified = ${sqlText(args.lastModified)},
               content_hash = ${sqlQuote(args.contentHash)},
               sync_status = ${sqlQuote(
                 args.state === "complete" ? "fresh" : "partial",
               )},
               last_error_code = ${sqlText(args.error?.code)},
               last_error_message = ${sqlText(args.error?.message)},
               last_error_retryable = ${
                 args.error === null ? "NULL" : sqlBoolean(args.error.retryable)
},
               last_synced_at = ${sqlQuote(args.completedAt)},
               lease_token = NULL,
               lease_expires_at = NULL,
               updated_at = ${sqlQuote(args.completedAt)}
         WHERE agent_id = ${sqlQuote(args.agentId)}
           AND id = ${sqlQuote(args.sourceId)}
           AND provider = 'ics'
           AND sync_generation = ${Math.floor(args.generation)}
           AND lease_token = ${sqlQuote(args.token)}
         RETURNING *
      )
      SELECT updated_source.*,
             (SELECT COUNT(*)::integer FROM upserted) AS accepted_events,
             (SELECT COUNT(*)::integer FROM pruned) AS pruned_events,
             (
               SELECT COUNT(*)::integer
                 FROM upserted
                WHERE status = 'cancelled'
             ) AS tombstones
        FROM updated_source`,
    );
    const row = rows[0];
    if (!row) return null;
    return {
      source: parseIcsCalendarSource(row),
      acceptedEvents: toNumber(row.accepted_events),
      prunedEvents: toNumber(row.pruned_events),
      tombstones: toNumber(row.tombstones),
    };
  }
}
