/** Persists bounded user-session telemetry through the shared database boundary. */
import { and, desc, eq, isNull, type SQL, sql } from "drizzle-orm";
import { sqlRows } from "../execute-helpers";
import { dbRead, dbWrite } from "../helpers";
import {
  type NewUserSession,
  type UserSession,
  type UserSessionEndReason,
  userSessions,
} from "../schemas/user-sessions";
import { jsonbParam } from "../utils/jsonb";

export type { NewUserSession, UserSession };

const USER_SESSION_IDLE_TIMEOUT_MS = 60 * 60 * 1_000;
const USER_SESSION_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;
const USER_SESSION_CLEANUP_BATCH_SIZE = 500;

export interface UserSessionCleanupMetrics {
  scanned: number;
  closed: number;
  retained: number;
  deleted: number;
}

interface UserSessionBackfillPreview {
  pending: number;
  staleNullEnded: number;
  endedMissingRetention: number;
}

interface UserSessionBackfillBatch {
  updated: number;
  active: number;
  ended: number;
}

type UserSessionMetricsUpdate = {
  last_activity_at: Date;
  updated_at: Date;
  credits_used?: string | SQL;
  requests_made?: number | SQL;
  tokens_consumed?: number | SQL;
};

function activeTelemetryWhere(now: Date) {
  const idleCutoff = new Date(now.getTime() - USER_SESSION_IDLE_TIMEOUT_MS);
  return and(
    isNull(userSessions.ended_at),
    sql`COALESCE(${userSessions.token_expires_at}, ${userSessions.started_at} + interval '1 hour') > ${now}`,
    sql`${userSessions.last_activity_at} > ${idleCutoff}`,
  );
}

function redactedClosureFields(reason: UserSessionEndReason, endedAt: Date) {
  return {
    ended_at: endedAt,
    ended_reason: reason,
    retention_expires_at: new Date(endedAt.getTime() + USER_SESSION_RETENTION_MS),
    metadata_purged_at: endedAt,
    session_token: sql<string>`'closed:' || ${userSessions.id}::text`,
    ip_address: null,
    user_agent: null,
    device_info: sql<Record<string, never>>`'{}'::jsonb`,
    updated_at: endedAt,
  };
}

/**
 * Repository for user session database operations.
 *
 * Read operations → dbRead (read-intent connection)
 * Write operations → dbWrite (primary)
 */
export class UserSessionsRepository {
  // ============================================================================
  // READ OPERATIONS (use read-intent connection)
  // ============================================================================

  /**
   * Finds a user session by ID.
   */
  async findById(id: string): Promise<UserSession | undefined> {
    return await dbRead.query.userSessions.findFirst({
      where: eq(userSessions.id, id),
    });
  }

  /**
   * Finds an active session by token (not ended).
   */
  async findActiveByToken(sessionToken: string): Promise<UserSession | undefined> {
    const now = new Date();
    return await dbRead.query.userSessions.findFirst({
      where: and(eq(userSessions.session_token, sessionToken), activeTelemetryWhere(now)),
    });
  }

  /**
   * Lists all active sessions for a user, ordered by last activity.
   */
  async listActiveByUser(userId: string): Promise<UserSession[]> {
    const now = new Date();
    return await dbRead.query.userSessions.findMany({
      where: and(eq(userSessions.user_id, userId), activeTelemetryWhere(now)),
      orderBy: desc(userSessions.last_activity_at),
    });
  }

  /**
   * Lists sessions for an organization, ordered by start time.
   */
  async listByOrganization(organizationId: string, limit?: number): Promise<UserSession[]> {
    return await dbRead.query.userSessions.findMany({
      where: eq(userSessions.organization_id, organizationId),
      orderBy: desc(userSessions.started_at),
      limit,
    });
  }

  /**
   * Gets aggregated stats across all active sessions for a user.
   *
   * @returns Aggregated stats or null if no active sessions.
   */
  async getCurrentSessionStats(userId: string): Promise<{
    credits_used: number;
    requests_made: number;
    tokens_consumed: number;
  } | null> {
    const now = new Date();
    const activeSessions = await dbRead.query.userSessions.findMany({
      where: and(eq(userSessions.user_id, userId), activeTelemetryWhere(now)),
    });

    if (activeSessions.length === 0) {
      return null;
    }

    const stats = activeSessions.reduce(
      (acc, session) => ({
        credits_used: acc.credits_used + Number(session.credits_used || 0),
        requests_made: acc.requests_made + (session.requests_made || 0),
        tokens_consumed: acc.tokens_consumed + (session.tokens_consumed || 0),
      }),
      { credits_used: 0, requests_made: 0, tokens_consumed: 0 },
    );

    return stats;
  }

  // ============================================================================
  // WRITE OPERATIONS (use primary)
  // ============================================================================

  /**
   * Creates a new user session.
   */
  async create(data: NewUserSession): Promise<UserSession> {
    const [session] = await dbWrite
      .insert(userSessions)
      .values({
        ...data,
        // NOTE: When using Neon serverless driver, binding raw JS objects as query
        // params for jsonb can fail. Bind JSONB explicitly as a JSON string and cast.
        device_info: jsonbParam(data.device_info),
      })
      .returning();
    return session;
  }

  /**
   * Atomically gets or creates a session using Drizzle's onConflictDoUpdate.
   *
   * Prevents race conditions by handling conflicts at the database level.
   * If session_token already exists, updates last_activity_at and returns existing session.
   */
  async getOrCreate(data: NewUserSession): Promise<UserSession | undefined> {
    const [session] = await dbWrite
      .insert(userSessions)
      .values({
        ...data,
        // NOTE: When using Neon serverless driver, binding raw JS objects as query
        // params for jsonb can fail. Bind JSONB explicitly as a JSON string and cast.
        device_info: jsonbParam(data.device_info),
      })
      .onConflictDoUpdate({
        target: userSessions.session_token,
        set: {
          last_activity_at: new Date(),
          token_expires_at: sql`GREATEST(COALESCE(${userSessions.token_expires_at}, excluded.token_expires_at), excluded.token_expires_at)`,
          updated_at: new Date(),
        },
        setWhere: activeTelemetryWhere(new Date()),
      })
      .returning();

    return session;
  }

  /**
   * Updates session metrics with absolute values.
   */
  async updateMetrics(
    sessionToken: string,
    metrics: {
      credits_used?: number;
      requests_made?: number;
      tokens_consumed?: number;
    },
  ): Promise<UserSession | undefined> {
    const updateFields: UserSessionMetricsUpdate = {
      last_activity_at: new Date(),
      updated_at: new Date(),
    };

    if (metrics.credits_used !== undefined) {
      updateFields.credits_used = String(metrics.credits_used);
    }

    if (metrics.requests_made !== undefined) {
      updateFields.requests_made = metrics.requests_made;
    }

    if (metrics.tokens_consumed !== undefined) {
      updateFields.tokens_consumed = metrics.tokens_consumed;
    }

    const [updated] = await dbWrite
      .update(userSessions)
      .set(updateFields)
      .where(and(eq(userSessions.session_token, sessionToken), activeTelemetryWhere(new Date())))
      .returning();
    return updated;
  }

  /**
   * Atomically increments session metrics for an active session.
   */
  async incrementMetrics(
    sessionToken: string,
    increments: {
      credits_used?: number;
      requests_made?: number;
      tokens_consumed?: number;
    },
  ): Promise<UserSession | undefined> {
    const updateFields: UserSessionMetricsUpdate = {
      last_activity_at: new Date(),
      updated_at: new Date(),
    };

    if (increments.credits_used !== undefined) {
      updateFields.credits_used = sql`${userSessions.credits_used} + ${increments.credits_used}`;
    }

    if (increments.requests_made !== undefined) {
      updateFields.requests_made = sql`${userSessions.requests_made} + ${increments.requests_made}`;
    }

    if (increments.tokens_consumed !== undefined) {
      updateFields.tokens_consumed = sql`${userSessions.tokens_consumed} + ${increments.tokens_consumed}`;
    }

    const [updated] = await dbWrite
      .update(userSessions)
      .set(updateFields)
      .where(and(eq(userSessions.session_token, sessionToken), activeTelemetryWhere(new Date())))
      .returning();

    return updated;
  }

  /**
   * Ends a session by setting ended_at timestamp.
   */
  async endSession(
    sessionToken: string,
    reason: UserSessionEndReason = "logout",
  ): Promise<UserSession | undefined> {
    const endedAt = new Date();
    const [updated] = await dbWrite
      .update(userSessions)
      .set(redactedClosureFields(reason, endedAt))
      .where(and(eq(userSessions.session_token, sessionToken), isNull(userSessions.ended_at)))
      .returning();
    return updated;
  }

  /**
   * Ends all active sessions for a user.
   *
   * @returns Number of sessions ended.
   */
  async endAllUserSessions(
    userId: string,
    reason: UserSessionEndReason = "logout",
  ): Promise<number> {
    const endedAt = new Date();
    const ended = await dbWrite
      .update(userSessions)
      .set(redactedClosureFields(reason, endedAt))
      .where(and(eq(userSessions.user_id, userId), isNull(userSessions.ended_at)))
      .returning({ id: userSessions.id });

    return ended.length;
  }

  /**
   * Closes stale telemetry and deletes only already-ended rows past retention.
   * One statement plus SKIP LOCKED makes concurrent/retried cron invocations
   * idempotent without ever treating telemetry as authentication authority.
   */
  async cleanupLifecycle(
    now = new Date(),
    batchSize = USER_SESSION_CLEANUP_BATCH_SIZE,
  ): Promise<UserSessionCleanupMetrics> {
    if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 1_000) {
      throw new RangeError("user-session cleanup batchSize must be an integer from 1 through 1000");
    }
    const idleCutoff = new Date(now.getTime() - USER_SESSION_IDLE_TIMEOUT_MS);
    const rows = await sqlRows<{
      scanned: number | string;
      closed: number | string;
      retained: number | string;
      deleted: number | string;
    }>(
      dbWrite,
      sql`
      WITH stale AS (
        SELECT
          ${userSessions.id} AS id,
          CASE
            WHEN COALESCE(${userSessions.token_expires_at}, ${userSessions.started_at} + interval '1 hour') <= ${now}
              THEN 'expired'
            ELSE 'idle'
          END AS reason,
          LEAST(
            COALESCE(${userSessions.token_expires_at}, ${userSessions.started_at} + interval '1 hour'),
            ${userSessions.last_activity_at} + interval '1 hour'
          ) AS lifecycle_ended_at
        FROM ${userSessions}
        WHERE ${userSessions.ended_at} IS NULL
          AND (
            COALESCE(${userSessions.token_expires_at}, ${userSessions.started_at} + interval '1 hour') <= ${now}
            OR ${userSessions.last_activity_at} <= ${idleCutoff}
          )
        ORDER BY lifecycle_ended_at, ${userSessions.id}
        LIMIT ${batchSize}
        FOR UPDATE SKIP LOCKED
      ),
      closed AS (
        UPDATE ${userSessions} AS target
        SET
          ended_at = stale.lifecycle_ended_at,
          ended_reason = stale.reason,
          retention_expires_at = stale.lifecycle_ended_at + interval '30 days',
          metadata_purged_at = ${now},
          session_token = 'closed:' || target.id::text,
          ip_address = NULL,
          user_agent = NULL,
          device_info = '{}'::jsonb,
          updated_at = ${now}
        FROM stale
        WHERE target.id = stale.id AND target.ended_at IS NULL
        RETURNING target.id
      ),
      deletion_candidates AS (
        SELECT ${userSessions.id} AS id
        FROM ${userSessions}
        WHERE ${userSessions.ended_at} IS NOT NULL
          AND COALESCE(
            ${userSessions.retention_expires_at},
            ${userSessions.ended_at} + interval '30 days'
          ) <= ${now}
          AND NOT EXISTS (SELECT 1 FROM closed WHERE closed.id = ${userSessions.id})
        ORDER BY COALESCE(
          ${userSessions.retention_expires_at},
          ${userSessions.ended_at} + interval '30 days'
        ), ${userSessions.id}
        LIMIT ${batchSize}
        FOR UPDATE SKIP LOCKED
      ),
      deleted AS (
        DELETE FROM ${userSessions} AS target
        USING deletion_candidates
        WHERE target.id = deletion_candidates.id AND target.ended_at IS NOT NULL
        RETURNING target.id
      )
      SELECT
        (SELECT count(*) FROM stale) + (SELECT count(*) FROM deletion_candidates) AS scanned,
        (SELECT count(*) FROM closed) AS closed,
        (SELECT count(*) FROM closed) AS retained,
        (SELECT count(*) FROM deleted) AS deleted
    `,
    );
    const row = rows[0];
    if (!row) throw new Error("user-session cleanup returned no metrics row");
    return {
      scanned: Number(row.scanned),
      closed: Number(row.closed),
      retained: Number(row.retained),
      deleted: Number(row.deleted),
    };
  }

  /** Returns aggregate dry-run counts for the additive lifecycle backfill. */
  async previewLifecycleBackfill(now = new Date()): Promise<UserSessionBackfillPreview> {
    const idleCutoff = new Date(now.getTime() - USER_SESSION_IDLE_TIMEOUT_MS);
    const rows = await sqlRows<{
      pending: number | string;
      stale_null_ended: number | string;
      ended_missing_retention: number | string;
    }>(
      dbRead,
      sql`
      SELECT
        count(*) FILTER (
          WHERE ${userSessions.token_expires_at} IS NULL
            OR (${userSessions.ended_at} IS NOT NULL AND (
              ${userSessions.ended_reason} IS NULL
              OR ${userSessions.retention_expires_at} IS NULL
              OR ${userSessions.metadata_purged_at} IS NULL
            ))
        ) AS pending,
        count(*) FILTER (
          WHERE ${userSessions.ended_at} IS NULL
            AND (
              COALESCE(${userSessions.token_expires_at}, ${userSessions.started_at} + interval '1 hour') <= ${now}
              OR ${userSessions.last_activity_at} <= ${idleCutoff}
            )
        ) AS stale_null_ended,
        count(*) FILTER (
          WHERE ${userSessions.ended_at} IS NOT NULL
            AND (${userSessions.retention_expires_at} IS NULL OR ${userSessions.ended_reason} IS NULL)
        ) AS ended_missing_retention
      FROM ${userSessions}
    `,
    );
    const row = rows[0];
    if (!row) throw new Error("user-session backfill preview returned no metrics row");
    return {
      pending: Number(row.pending),
      staleNullEnded: Number(row.stale_null_ended),
      endedMissingRetention: Number(row.ended_missing_retention),
    };
  }

  /** Applies at most one bounded, lock-skipping lifecycle backfill batch. */
  async applyLifecycleBackfillBatch(
    batchSize = USER_SESSION_CLEANUP_BATCH_SIZE,
  ): Promise<UserSessionBackfillBatch> {
    if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 1_000) {
      throw new RangeError(
        "user-session backfill batchSize must be an integer from 1 through 1000",
      );
    }
    const rows = await sqlRows<{
      updated: number | string;
      active: number | string;
      ended: number | string;
    }>(
      dbWrite,
      sql`
      WITH candidates AS (
        SELECT ${userSessions.id} AS id
        FROM ${userSessions}
        WHERE ${userSessions.token_expires_at} IS NULL
          OR (${userSessions.ended_at} IS NOT NULL AND (
            ${userSessions.ended_reason} IS NULL
            OR ${userSessions.retention_expires_at} IS NULL
            OR ${userSessions.metadata_purged_at} IS NULL
          ))
        ORDER BY ${userSessions.started_at}, ${userSessions.id}
        LIMIT ${batchSize}
        FOR UPDATE SKIP LOCKED
      ),
      updated AS (
        UPDATE ${userSessions} AS target
        SET
          token_expires_at = COALESCE(target.token_expires_at, target.started_at + interval '1 hour'),
          ended_reason = CASE
            WHEN target.ended_at IS NOT NULL THEN COALESCE(target.ended_reason, 'legacy_ended')
            ELSE target.ended_reason
          END,
          retention_expires_at = CASE
            WHEN target.ended_at IS NOT NULL
              THEN COALESCE(target.retention_expires_at, target.ended_at + interval '30 days')
            ELSE target.retention_expires_at
          END,
          metadata_purged_at = CASE
            WHEN target.ended_at IS NOT NULL THEN COALESCE(target.metadata_purged_at, now())
            ELSE target.metadata_purged_at
          END,
          session_token = CASE
            WHEN target.ended_at IS NOT NULL THEN 'closed:' || target.id::text
            ELSE target.session_token
          END,
          ip_address = CASE WHEN target.ended_at IS NOT NULL THEN NULL ELSE target.ip_address END,
          user_agent = CASE WHEN target.ended_at IS NOT NULL THEN NULL ELSE target.user_agent END,
          device_info = CASE
            WHEN target.ended_at IS NOT NULL THEN '{}'::jsonb
            ELSE target.device_info
          END,
          updated_at = now()
        FROM candidates
        WHERE target.id = candidates.id
        RETURNING target.ended_at
      )
      SELECT
        count(*) AS updated,
        count(*) FILTER (WHERE ended_at IS NULL) AS active,
        count(*) FILTER (WHERE ended_at IS NOT NULL) AS ended
      FROM updated
    `,
    );
    const row = rows[0];
    if (!row) throw new Error("user-session backfill returned no metrics row");
    return {
      updated: Number(row.updated),
      active: Number(row.active),
      ended: Number(row.ended),
    };
  }

  async cleanupOldSessions(): Promise<number> {
    return (await this.cleanupLifecycle()).deleted;
  }
}

/**
 * Singleton instance of UserSessionsRepository.
 */
export const userSessionsRepository = new UserSessionsRepository();
