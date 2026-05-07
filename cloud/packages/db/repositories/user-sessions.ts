import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { mutateRowCount } from "../execute-helpers";
import { dbRead, dbWrite } from "../helpers";
import { type NewUserSession, type UserSession, userSessions } from "../schemas/user-sessions";
import { jsonbParam } from "../utils/jsonb";

export type { NewUserSession, UserSession };

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
    return await dbRead.query.userSessions.findFirst({
      where: and(eq(userSessions.session_token, sessionToken), isNull(userSessions.ended_at)),
    });
  }

  /**
   * Lists all active sessions for a user, ordered by last activity.
   */
  async listActiveByUser(userId: string): Promise<UserSession[]> {
    return await dbRead.query.userSessions.findMany({
      where: and(eq(userSessions.user_id, userId), isNull(userSessions.ended_at)),
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
    const activeSessions = await dbRead.query.userSessions.findMany({
      where: and(eq(userSessions.user_id, userId), isNull(userSessions.ended_at)),
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
    const values = {
      ...data,
      // NOTE: When using Neon serverless driver, binding raw JS objects as query
      // params for jsonb can fail. Bind JSONB explicitly as a JSON string and cast.
      device_info: jsonbParam(data.device_info),
    } as unknown as NewUserSession;

    const [session] = await dbWrite.insert(userSessions).values(values).returning();
    return session;
  }

  /**
   * Atomically gets or creates a session using Drizzle's onConflictDoUpdate.
   *
   * Prevents race conditions by handling conflicts at the database level.
   * If session_token already exists, updates last_activity_at and returns existing session.
   */
  async getOrCreate(data: NewUserSession): Promise<UserSession> {
    const values = {
      ...data,
      // NOTE: When using Neon serverless driver, binding raw JS objects as query
      // params for jsonb can fail. Bind JSONB explicitly as a JSON string and cast.
      device_info: jsonbParam(data.device_info),
    } as unknown as NewUserSession;

    const [session] = await dbWrite
      .insert(userSessions)
      .values(values)
      .onConflictDoUpdate({
        target: userSessions.session_token,
        set: {
          last_activity_at: new Date(),
          updated_at: new Date(),
        },
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
    const updateFields: Record<string, any> = {
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
      .where(eq(userSessions.session_token, sessionToken))
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
    const updateFields: Record<string, any> = {
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
      .where(and(eq(userSessions.session_token, sessionToken), isNull(userSessions.ended_at)))
      .returning();

    return updated;
  }

  /**
   * Ends a session by setting ended_at timestamp.
   */
  async endSession(sessionToken: string): Promise<UserSession | undefined> {
    const [updated] = await dbWrite
      .update(userSessions)
      .set({
        ended_at: new Date(),
        updated_at: new Date(),
      })
      .where(eq(userSessions.session_token, sessionToken))
      .returning();
    return updated;
  }

  /**
   * Ends all active sessions for a user.
   *
   * @returns Number of sessions ended.
   */
  async endAllUserSessions(userId: string): Promise<number> {
    const result = await dbWrite
      .update(userSessions)
      .set({
        ended_at: new Date(),
        updated_at: new Date(),
      })
      .where(and(eq(userSessions.user_id, userId), isNull(userSessions.ended_at)));

    return mutateRowCount(result);
  }

  /**
   * Deletes sessions that ended more than specified days ago.
   *
   * @param daysOld - Minimum age in days for sessions to be deleted (default: 30).
   * @returns Number of sessions deleted.
   */
  async cleanupOldSessions(daysOld: number = 30): Promise<number> {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - daysOld);

    const result = await dbWrite
      .delete(userSessions)
      .where(sql`${userSessions.ended_at} < ${cutoffDate}`);

    return mutateRowCount(result);
  }
}

/**
 * Singleton instance of UserSessionsRepository.
 */
export const userSessionsRepository = new UserSessionsRepository();
