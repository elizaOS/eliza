/**
 * Durable Google Calendar push-channel state and notification leases.
 *
 * The capability token is stored only as a SHA-256 digest. Message numbers
 * remain decimal text because Google does not bound them to JavaScript's safe
 * integer range; SQL numeric comparisons and BigInt callers preserve ordering.
 */
import { ElizaError, type IAgentRuntime } from "@elizaos/core";
import {
  LIFEOPS_CONNECTOR_SIDES,
  type LifeOpsConnectorSide,
} from "@elizaos/shared";
import {
  executeRawSql,
  sqlBoolean,
  sqlQuote,
  sqlText,
} from "../internal/sql.js";

export type GoogleCalendarWatchState =
  | "creating"
  | "active"
  | "stopping"
  | "stopped"
  | "revoked"
  | "expired"
  | "error";

export interface GoogleCalendarWatchChannel {
  channelId: string;
  agentId: string;
  grantId: string;
  connectorAccountId: string;
  side: LifeOpsConnectorSide;
  calendarId: string;
  calendarSummary: string;
  calendarAccessRole: string;
  timeZone: string;
  windowStartAt: string;
  windowEndAt: string;
  webhookUrl: string;
  tokenSha256: string;
  resourceId: string | null;
  resourceUri: string | null;
  expirationAt: string | null;
  state: GoogleCalendarWatchState;
  lastMessageNumber: string;
  pendingMessageNumber: string | null;
  lastNotificationAt: string | null;
  lastSyncAt: string | null;
  syncLeaseToken: string | null;
  syncLeaseExpiresAt: string | null;
  renewalChannelId: string | null;
  failureCount: number;
  nextRetryAt: string | null;
  error: {
    code: string;
    message: string;
    retryable: boolean;
  } | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateGoogleCalendarWatchChannel {
  channelId: string;
  agentId: string;
  grantId: string;
  connectorAccountId: string;
  side: LifeOpsConnectorSide;
  calendarId: string;
  calendarSummary: string;
  calendarAccessRole: string;
  timeZone: string;
  windowStartAt: string;
  windowEndAt: string;
  webhookUrl: string;
  tokenSha256: string;
  provisionalExpirationAt: string;
  createdAt: string;
}

const GOOGLE_CALENDAR_WATCH_STATES: readonly GoogleCalendarWatchState[] = [
  "creating",
  "active",
  "stopping",
  "stopped",
  "revoked",
  "expired",
  "error",
];

function invalidStoredValue(column: string, value: unknown): never {
  throw new ElizaError(
    "Google Calendar watch state contains an invalid durable value.",
    {
      code: "GOOGLE_CALENDAR_WATCH_INVALID_STATE",
      context: { column, valueType: typeof value },
      severity: "fatal",
    },
  );
}

function requiredText(row: Record<string, unknown>, column: string): string {
  const value = row[column];
  if (typeof value === "string") return value;
  return invalidStoredValue(column, value);
}

function nullableText(
  row: Record<string, unknown>,
  column: string,
): string | null {
  const value = row[column];
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return value;
  return invalidStoredValue(column, value);
}

function requiredNonnegativeInteger(
  row: Record<string, unknown>,
  column: string,
): number {
  const value = row[column];
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string" && /^\d+$/.test(value)
        ? Number(value)
        : Number.NaN;
  if (Number.isSafeInteger(parsed) && parsed >= 0) return parsed;
  return invalidStoredValue(column, value);
}

function requiredBoolean(
  row: Record<string, unknown>,
  column: string,
): boolean {
  const value = row[column];
  if (typeof value === "boolean") return value;
  return invalidStoredValue(column, value);
}

function parseWatchChannel(
  row: Record<string, unknown>,
): GoogleCalendarWatchChannel {
  const errorCode = nullableText(row, "last_error_code");
  const side = requiredText(row, "side");
  if (!LIFEOPS_CONNECTOR_SIDES.includes(side as LifeOpsConnectorSide)) {
    invalidStoredValue("side", side);
  }
  const state = requiredText(row, "state");
  if (
    !GOOGLE_CALENDAR_WATCH_STATES.includes(state as GoogleCalendarWatchState)
  ) {
    invalidStoredValue("state", state);
  }
  const lastMessageNumber = requiredText(row, "last_message_number");
  const pendingMessageNumber = nullableText(row, "pending_message_number");
  if (!/^(0|[1-9]\d*)$/.test(lastMessageNumber)) {
    invalidStoredValue("last_message_number", lastMessageNumber);
  }
  if (
    pendingMessageNumber !== null &&
    !/^[1-9]\d*$/.test(pendingMessageNumber)
  ) {
    invalidStoredValue("pending_message_number", pendingMessageNumber);
  }
  return {
    channelId: requiredText(row, "channel_id"),
    agentId: requiredText(row, "agent_id"),
    grantId: requiredText(row, "grant_id"),
    connectorAccountId: requiredText(row, "connector_account_id"),
    side: side as LifeOpsConnectorSide,
    calendarId: requiredText(row, "calendar_id"),
    calendarSummary: requiredText(row, "calendar_summary"),
    calendarAccessRole: requiredText(row, "calendar_access_role"),
    timeZone: requiredText(row, "time_zone"),
    windowStartAt: requiredText(row, "window_start_at"),
    windowEndAt: requiredText(row, "window_end_at"),
    webhookUrl: requiredText(row, "webhook_url"),
    tokenSha256: requiredText(row, "token_sha256"),
    resourceId: nullableText(row, "resource_id"),
    resourceUri: nullableText(row, "resource_uri"),
    expirationAt: nullableText(row, "expiration_at"),
    state: state as GoogleCalendarWatchState,
    lastMessageNumber,
    pendingMessageNumber,
    lastNotificationAt: nullableText(row, "last_notification_at"),
    lastSyncAt: nullableText(row, "last_sync_at"),
    syncLeaseToken: nullableText(row, "sync_lease_token"),
    syncLeaseExpiresAt: nullableText(row, "sync_lease_expires_at"),
    renewalChannelId: nullableText(row, "renewal_channel_id"),
    failureCount: requiredNonnegativeInteger(row, "failure_count"),
    nextRetryAt: nullableText(row, "next_retry_at"),
    error: errorCode
      ? {
          code: errorCode,
          message: requiredText(row, "last_error_message"),
          retryable: requiredBoolean(row, "last_error_retryable"),
        }
      : null,
    createdAt: requiredText(row, "created_at"),
    updatedAt: requiredText(row, "updated_at"),
  };
}

function requireReturnedChannel(
  rows: Array<Record<string, unknown>>,
  operation: string,
  channelId: string,
): GoogleCalendarWatchChannel {
  const row = rows[0];
  if (!row) {
    throw new ElizaError(
      `Google Calendar watch ${operation} did not update its durable channel.`,
      {
        code: "GOOGLE_CALENDAR_WATCH_STATE_RACE",
        context: { operation, channelId },
        severity: "ephemeral",
      },
    );
  }
  return parseWatchChannel(row);
}

export class GoogleCalendarWatchRepository {
  constructor(private readonly runtime: IAgentRuntime) {}

  async createProvisional(
    channel: CreateGoogleCalendarWatchChannel,
  ): Promise<GoogleCalendarWatchChannel> {
    const rows = await executeRawSql(
      this.runtime,
      `INSERT INTO app_calendar.google_calendar_watch_channels (
        channel_id, agent_id, grant_id, connector_account_id, side,
        calendar_id, calendar_summary, calendar_access_role, time_zone,
        window_start_at, window_end_at, webhook_url, token_sha256,
        expiration_at, state, created_at, updated_at
      ) VALUES (
        ${sqlQuote(channel.channelId)},
        ${sqlQuote(channel.agentId)},
        ${sqlQuote(channel.grantId)},
        ${sqlQuote(channel.connectorAccountId)},
        ${sqlQuote(channel.side)},
        ${sqlQuote(channel.calendarId)},
        ${sqlQuote(channel.calendarSummary)},
        ${sqlQuote(channel.calendarAccessRole)},
        ${sqlQuote(channel.timeZone)},
        ${sqlQuote(channel.windowStartAt)},
        ${sqlQuote(channel.windowEndAt)},
        ${sqlQuote(channel.webhookUrl)},
        ${sqlQuote(channel.tokenSha256)},
        ${sqlQuote(channel.provisionalExpirationAt)},
        'creating',
        ${sqlQuote(channel.createdAt)},
        ${sqlQuote(channel.createdAt)}
      )
      RETURNING *`,
    );
    return requireReturnedChannel(
      rows,
      "provisional insert",
      channel.channelId,
    );
  }

  async get(
    agentId: string,
    channelId: string,
  ): Promise<GoogleCalendarWatchChannel | null> {
    const rows = await executeRawSql(
      this.runtime,
      `SELECT *
         FROM app_calendar.google_calendar_watch_channels
        WHERE agent_id = ${sqlQuote(agentId)}
          AND channel_id = ${sqlQuote(channelId)}
        LIMIT 1`,
    );
    return rows[0] ? parseWatchChannel(rows[0]) : null;
  }

  async findCurrentForBinding(args: {
    agentId: string;
    grantId: string;
    connectorAccountId: string;
    calendarId: string;
    nowIso: string;
  }): Promise<GoogleCalendarWatchChannel | null> {
    const rows = await executeRawSql(
      this.runtime,
      `SELECT *
         FROM app_calendar.google_calendar_watch_channels
        WHERE agent_id = ${sqlQuote(args.agentId)}
          AND grant_id = ${sqlQuote(args.grantId)}
          AND connector_account_id = ${sqlQuote(args.connectorAccountId)}
          AND calendar_id = ${sqlQuote(args.calendarId)}
          AND state IN ('creating', 'active')
          AND (
            expiration_at IS NULL OR
            expiration_at > ${sqlQuote(args.nowIso)}
          )
        ORDER BY
          CASE state WHEN 'active' THEN 0 ELSE 1 END,
          expiration_at DESC NULLS LAST,
          created_at DESC
        LIMIT 1`,
    );
    return rows[0] ? parseWatchChannel(rows[0]) : null;
  }

  async countLiveForAccount(
    agentId: string,
    connectorAccountId: string,
    nowIso: string,
  ): Promise<number> {
    const rows = await executeRawSql(
      this.runtime,
      `SELECT COUNT(*)::text AS count
         FROM app_calendar.google_calendar_watch_channels
        WHERE agent_id = ${sqlQuote(agentId)}
          AND connector_account_id = ${sqlQuote(connectorAccountId)}
          AND state IN ('creating', 'active', 'stopping')
          AND (
            expiration_at IS NULL OR
            expiration_at > ${sqlQuote(nowIso)}
          )`,
    );
    const row = rows[0];
    if (!row) {
      throw new ElizaError(
        "Google Calendar watch quota query returned no durable result.",
        {
          code: "GOOGLE_CALENDAR_WATCH_INVALID_STATE",
          context: { connectorAccountId },
          severity: "fatal",
        },
      );
    }
    return requiredNonnegativeInteger(row, "count");
  }

  async bindProvisionalResource(args: {
    agentId: string;
    channelId: string;
    resourceId: string;
    resourceUri: string;
    updatedAt: string;
  }): Promise<GoogleCalendarWatchChannel | null> {
    const rows = await executeRawSql(
      this.runtime,
      `UPDATE app_calendar.google_calendar_watch_channels
          SET resource_id = ${sqlQuote(args.resourceId)},
              resource_uri = ${sqlQuote(args.resourceUri)},
              updated_at = ${sqlQuote(args.updatedAt)}
        WHERE agent_id = ${sqlQuote(args.agentId)}
          AND channel_id = ${sqlQuote(args.channelId)}
          AND state = 'creating'
          AND (resource_id IS NULL OR resource_id = ${sqlQuote(args.resourceId)})
          AND (resource_uri IS NULL OR resource_uri = ${sqlQuote(args.resourceUri)})
        RETURNING *`,
    );
    return rows[0] ? parseWatchChannel(rows[0]) : null;
  }

  async finalizeCreated(args: {
    agentId: string;
    channelId: string;
    resourceId: string;
    resourceUri: string;
    expirationAt: string;
    updatedAt: string;
  }): Promise<GoogleCalendarWatchChannel> {
    const rows = await executeRawSql(
      this.runtime,
      `UPDATE app_calendar.google_calendar_watch_channels
          SET resource_id = ${sqlQuote(args.resourceId)},
              resource_uri = ${sqlQuote(args.resourceUri)},
              expiration_at = ${sqlQuote(args.expirationAt)},
              state = 'active',
              failure_count = 0,
              next_retry_at = NULL,
              last_error_code = NULL,
              last_error_message = NULL,
              last_error_retryable = NULL,
              updated_at = ${sqlQuote(args.updatedAt)}
        WHERE agent_id = ${sqlQuote(args.agentId)}
          AND channel_id = ${sqlQuote(args.channelId)}
          AND state = 'creating'
          AND (resource_id IS NULL OR resource_id = ${sqlQuote(args.resourceId)})
          AND (resource_uri IS NULL OR resource_uri = ${sqlQuote(args.resourceUri)})
        RETURNING *`,
    );
    return requireReturnedChannel(rows, "finalization", args.channelId);
  }

  async enqueueNotification(args: {
    agentId: string;
    channelId: string;
    messageNumber: string;
    notifiedAt: string;
  }): Promise<GoogleCalendarWatchChannel | null> {
    const rows = await executeRawSql(
      this.runtime,
      `UPDATE app_calendar.google_calendar_watch_channels
          SET pending_message_number = CASE
                WHEN pending_message_number IS NULL
                  OR pending_message_number::numeric < ${sqlQuote(args.messageNumber)}::numeric
                THEN ${sqlQuote(args.messageNumber)}
                ELSE pending_message_number
              END,
              last_notification_at = ${sqlQuote(args.notifiedAt)},
              updated_at = ${sqlQuote(args.notifiedAt)}
        WHERE agent_id = ${sqlQuote(args.agentId)}
          AND channel_id = ${sqlQuote(args.channelId)}
          AND state IN ('creating', 'active')
          AND last_message_number::numeric < ${sqlQuote(args.messageNumber)}::numeric
        RETURNING *`,
    );
    return rows[0] ? parseWatchChannel(rows[0]) : null;
  }

  async claimPendingSync(args: {
    agentId: string;
    channelId: string;
    leaseToken: string;
    claimedAt: string;
    leaseExpiresAt: string;
    maxConcurrentForAccount: number;
  }): Promise<GoogleCalendarWatchChannel | null> {
    const rows = await executeRawSql(
      this.runtime,
      `UPDATE app_calendar.google_calendar_watch_channels
          SET sync_lease_token = ${sqlQuote(args.leaseToken)},
              sync_lease_expires_at = ${sqlQuote(args.leaseExpiresAt)},
              updated_at = ${sqlQuote(args.claimedAt)}
        WHERE agent_id = ${sqlQuote(args.agentId)}
          AND channel_id = ${sqlQuote(args.channelId)}
          AND state IN ('creating', 'active')
          AND pending_message_number IS NOT NULL
          AND last_message_number::numeric < pending_message_number::numeric
          AND (
            next_retry_at IS NULL OR
            next_retry_at <= ${sqlQuote(args.claimedAt)}
          )
          AND (
            sync_lease_token IS NULL OR
            sync_lease_expires_at IS NULL OR
            sync_lease_expires_at <= ${sqlQuote(args.claimedAt)}
          )
          AND (
            SELECT COUNT(*)
              FROM app_calendar.google_calendar_watch_channels AS active_lease
             WHERE active_lease.agent_id = ${sqlQuote(args.agentId)}
               AND active_lease.connector_account_id =
                   app_calendar.google_calendar_watch_channels.connector_account_id
               AND active_lease.sync_lease_token IS NOT NULL
               AND active_lease.sync_lease_expires_at > ${sqlQuote(args.claimedAt)}
          ) < ${Math.max(1, Math.floor(args.maxConcurrentForAccount))}
        RETURNING *`,
    );
    return rows[0] ? parseWatchChannel(rows[0]) : null;
  }

  async completePendingSync(args: {
    agentId: string;
    channelId: string;
    leaseToken: string;
    processedMessageNumber: string;
    completedAt: string;
  }): Promise<GoogleCalendarWatchChannel> {
    const rows = await executeRawSql(
      this.runtime,
      `UPDATE app_calendar.google_calendar_watch_channels
          SET last_message_number = ${sqlQuote(args.processedMessageNumber)},
              pending_message_number = CASE
                WHEN pending_message_number IS NOT NULL
                  AND pending_message_number::numeric > ${sqlQuote(args.processedMessageNumber)}::numeric
                THEN pending_message_number
                ELSE NULL
              END,
              sync_lease_token = CASE
                WHEN pending_message_number IS NOT NULL
                  AND pending_message_number::numeric > ${sqlQuote(args.processedMessageNumber)}::numeric
                THEN sync_lease_token
                ELSE NULL
              END,
              sync_lease_expires_at = CASE
                WHEN pending_message_number IS NOT NULL
                  AND pending_message_number::numeric > ${sqlQuote(args.processedMessageNumber)}::numeric
                THEN sync_lease_expires_at
                ELSE NULL
              END,
              last_sync_at = ${sqlQuote(args.completedAt)},
              failure_count = 0,
              next_retry_at = NULL,
              last_error_code = NULL,
              last_error_message = NULL,
              last_error_retryable = NULL,
              updated_at = ${sqlQuote(args.completedAt)}
        WHERE agent_id = ${sqlQuote(args.agentId)}
          AND channel_id = ${sqlQuote(args.channelId)}
          AND sync_lease_token = ${sqlQuote(args.leaseToken)}
          AND last_message_number::numeric < ${sqlQuote(args.processedMessageNumber)}::numeric
        RETURNING *`,
    );
    return requireReturnedChannel(
      rows,
      "notification completion",
      args.channelId,
    );
  }

  async releaseFailedSync(args: {
    agentId: string;
    channelId: string;
    leaseToken: string;
    failedAt: string;
    error: { code: string; message: string; retryable: boolean };
    nextRetryAt: string | null;
  }): Promise<GoogleCalendarWatchChannel> {
    const rows = await executeRawSql(
      this.runtime,
      `UPDATE app_calendar.google_calendar_watch_channels
          SET sync_lease_token = NULL,
              sync_lease_expires_at = NULL,
              failure_count = failure_count + 1,
              next_retry_at = ${sqlText(args.nextRetryAt)},
              last_error_code = ${sqlQuote(args.error.code)},
              last_error_message = ${sqlQuote(args.error.message)},
              last_error_retryable = ${sqlBoolean(args.error.retryable)},
              updated_at = ${sqlQuote(args.failedAt)}
        WHERE agent_id = ${sqlQuote(args.agentId)}
          AND channel_id = ${sqlQuote(args.channelId)}
          AND sync_lease_token = ${sqlQuote(args.leaseToken)}
        RETURNING *`,
    );
    return requireReturnedChannel(
      rows,
      "notification failure release",
      args.channelId,
    );
  }

  async markError(args: {
    agentId: string;
    channelId: string;
    failedAt: string;
    state?: Extract<GoogleCalendarWatchState, "error" | "revoked">;
    error: { code: string; message: string; retryable: boolean };
    nextRetryAt?: string | null;
  }): Promise<void> {
    await executeRawSql(
      this.runtime,
      `UPDATE app_calendar.google_calendar_watch_channels
          SET state = ${sqlQuote(args.state ?? "error")},
              sync_lease_token = NULL,
              sync_lease_expires_at = NULL,
              failure_count = failure_count + 1,
              next_retry_at = ${sqlText(args.nextRetryAt ?? null)},
              last_error_code = ${sqlQuote(args.error.code)},
              last_error_message = ${sqlQuote(args.error.message)},
              last_error_retryable = ${sqlBoolean(args.error.retryable)},
              updated_at = ${sqlQuote(args.failedAt)}
        WHERE agent_id = ${sqlQuote(args.agentId)}
          AND channel_id = ${sqlQuote(args.channelId)}`,
    );
  }

  async markStopping(
    agentId: string,
    channelId: string,
    updatedAt: string,
  ): Promise<void> {
    await executeRawSql(
      this.runtime,
      `UPDATE app_calendar.google_calendar_watch_channels
          SET state = 'stopping',
              updated_at = ${sqlQuote(updatedAt)}
        WHERE agent_id = ${sqlQuote(agentId)}
          AND channel_id = ${sqlQuote(channelId)}
          AND state NOT IN ('stopped', 'revoked')`,
    );
  }

  async markStopped(args: {
    agentId: string;
    channelId: string;
    state: Extract<GoogleCalendarWatchState, "stopped" | "revoked" | "expired">;
    updatedAt: string;
  }): Promise<void> {
    await executeRawSql(
      this.runtime,
      `UPDATE app_calendar.google_calendar_watch_channels
          SET state = ${sqlQuote(args.state)},
              pending_message_number = NULL,
              sync_lease_token = NULL,
              sync_lease_expires_at = NULL,
              next_retry_at = NULL,
              updated_at = ${sqlQuote(args.updatedAt)}
        WHERE agent_id = ${sqlQuote(args.agentId)}
          AND channel_id = ${sqlQuote(args.channelId)}`,
    );
  }

  async markRenewed(args: {
    agentId: string;
    channelId: string;
    renewalChannelId: string;
    updatedAt: string;
  }): Promise<void> {
    await executeRawSql(
      this.runtime,
      `UPDATE app_calendar.google_calendar_watch_channels
          SET renewal_channel_id = ${sqlQuote(args.renewalChannelId)},
              updated_at = ${sqlQuote(args.updatedAt)}
        WHERE agent_id = ${sqlQuote(args.agentId)}
          AND channel_id = ${sqlQuote(args.channelId)}`,
    );
  }

  async listForAccount(
    agentId: string,
    connectorAccountId: string,
  ): Promise<GoogleCalendarWatchChannel[]> {
    const rows = await executeRawSql(
      this.runtime,
      `SELECT *
         FROM app_calendar.google_calendar_watch_channels
        WHERE agent_id = ${sqlQuote(agentId)}
          AND connector_account_id = ${sqlQuote(connectorAccountId)}
          AND state NOT IN ('stopped', 'revoked', 'expired')
        ORDER BY created_at ASC`,
    );
    return rows.map(parseWatchChannel);
  }

  async listForMaintenance(
    agentId: string,
  ): Promise<GoogleCalendarWatchChannel[]> {
    const rows = await executeRawSql(
      this.runtime,
      `SELECT *
         FROM app_calendar.google_calendar_watch_channels
        WHERE agent_id = ${sqlQuote(agentId)}
          AND state IN ('creating', 'active', 'stopping', 'error')
        ORDER BY expiration_at ASC NULLS FIRST, created_at ASC`,
    );
    return rows.map(parseWatchChannel);
  }

  async findHealthForBinding(args: {
    agentId: string;
    grantId: string;
    connectorAccountId: string;
    calendarId: string;
  }): Promise<GoogleCalendarWatchChannel | null> {
    const rows = await executeRawSql(
      this.runtime,
      `SELECT *
         FROM app_calendar.google_calendar_watch_channels
        WHERE agent_id = ${sqlQuote(args.agentId)}
          AND grant_id = ${sqlQuote(args.grantId)}
          AND connector_account_id = ${sqlQuote(args.connectorAccountId)}
          AND calendar_id = ${sqlQuote(args.calendarId)}
        ORDER BY
          CASE state
            WHEN 'active' THEN 0
            WHEN 'creating' THEN 1
            WHEN 'error' THEN 2
            ELSE 3
          END,
          expiration_at DESC NULLS LAST,
          updated_at DESC
        LIMIT 1`,
    );
    return rows[0] ? parseWatchChannel(rows[0]) : null;
  }
}
