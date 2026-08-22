// Persists anonymous sessions records for cloud services through the shared DB boundary.
import { ElizaError } from "@elizaos/core";
import { and, eq, gt, gte, lt, sql } from "drizzle-orm";
import { mutateRowCount } from "../execute-helpers";
import { dbRead, dbWrite } from "../helpers";
import { type AnonymousSession, anonymousSessions, userIdentities } from "../schemas";

export type { AnonymousSession };

export interface AnonymousChatGateHydration {
  sessionId: string;
  userId: string;
  messageCount: number;
  messagesLimit: number;
  hourlyMessageCount: number;
  hourlyResetAt: Date | null;
  expiresAt: Date;
  gateRevision: number;
}

export interface AnonymousChatGateCounterSnapshot {
  sessionId: string;
  revision: number;
  messageCount: number;
  hourlyMessageCount: number;
  hourlyResetAt: Date | null;
  lastMessageAt: Date;
}

export type AnonymousHourlyRateLimitResult =
  | { allowed: true; remaining: number }
  | { allowed: false; remaining: 0; retryAfter: number };

const HOUR_MS = 60 * 60 * 1_000;

/**
 * Repository for anonymous session database operations.
 *
 * Handles CRUD operations for anonymous user sessions.
 * Used for tracking free tier usage and rate limiting.
 *
 * Read operations → dbRead (read-intent connection)
 * Write operations → dbWrite (primary)
 */
export class AnonymousSessionsRepository {
  // ============================================================================
  // READ OPERATIONS (use read-intent connection)
  // ============================================================================

  /**
   * Gets an active, non-expired session by token.
   */
  async getByToken(sessionToken: string): Promise<AnonymousSession | null> {
    const [session] = await dbRead
      .select()
      .from(anonymousSessions)
      .where(
        and(
          eq(anonymousSessions.session_token, sessionToken),
          eq(anonymousSessions.is_active, true),
          gte(anonymousSessions.expires_at, new Date()),
        ),
      )
      .limit(1);

    return session || null;
  }

  /**
   * Gets a session by user ID.
   */
  async getByUserId(userId: string): Promise<AnonymousSession | null> {
    const [session] = await dbRead
      .select()
      .from(anonymousSessions)
      .where(eq(anonymousSessions.user_id, userId))
      .limit(1);

    return session || null;
  }

  /**
   * Reads the authoritative anonymous identity and quota snapshot from primary.
   * This is used only by off-response-path Durable Object hydration.
   */
  async getGateHydrationByToken(sessionToken: string): Promise<AnonymousChatGateHydration | null> {
    const [snapshot] = await dbWrite
      .select({
        sessionId: anonymousSessions.id,
        userId: anonymousSessions.user_id,
        messageCount: anonymousSessions.message_count,
        messagesLimit: anonymousSessions.messages_limit,
        hourlyMessageCount: anonymousSessions.hourly_message_count,
        hourlyResetAt: anonymousSessions.hourly_reset_at,
        expiresAt: anonymousSessions.expires_at,
        gateRevision: anonymousSessions.gate_revision,
      })
      .from(anonymousSessions)
      .innerJoin(userIdentities, eq(userIdentities.user_id, anonymousSessions.user_id))
      .where(
        and(
          eq(anonymousSessions.session_token, sessionToken),
          eq(anonymousSessions.is_active, true),
          gte(anonymousSessions.expires_at, new Date()),
          eq(userIdentities.is_anonymous, true),
        ),
      )
      .limit(1);

    return snapshot ?? null;
  }

  // ============================================================================
  // WRITE OPERATIONS (use primary)
  // ============================================================================

  /**
   * Creates a new anonymous session.
   */
  async create(data: {
    session_token: string;
    user_id: string;
    expires_at: Date;
    ip_address?: string;
    user_agent?: string;
    fingerprint?: string;
    messages_limit?: number;
  }): Promise<AnonymousSession> {
    const [session] = await dbWrite
      .insert(anonymousSessions)
      .values({
        session_token: data.session_token,
        user_id: data.user_id,
        expires_at: data.expires_at,
        ip_address: data.ip_address,
        user_agent: data.user_agent,
        fingerprint: data.fingerprint,
        messages_limit: data.messages_limit ?? 10,
      })
      .returning();

    return session;
  }

  /**
   * Atomically increments message count for a session.
   *
   * Uses SQL increment to prevent race conditions when multiple
   * requests try to increment simultaneously.
   *
   * @throws Error if session not found.
   */
  async incrementMessageCount(sessionId: string): Promise<AnonymousSession> {
    const [session] = await dbWrite
      .update(anonymousSessions)
      .set({
        message_count: sql`${anonymousSessions.message_count} + 1`,
        last_message_at: new Date(),
      })
      .where(eq(anonymousSessions.id, sessionId))
      .returning();

    if (!session) {
      throw new Error("Session not found");
    }

    return session;
  }

  /**
   * Atomically reserves one free-message slot before a stream starts.
   *
   * The conditional WHERE is the limit check: under concurrent requests only
   * rows still below messages_limit are incremented and returned.
   */
  async reserveMessageSlot(sessionId: string): Promise<AnonymousSession | null> {
    const [session] = await dbWrite
      .update(anonymousSessions)
      .set({
        message_count: sql`${anonymousSessions.message_count} + 1`,
        last_message_at: new Date(),
      })
      .where(
        and(
          eq(anonymousSessions.id, sessionId),
          lt(anonymousSessions.message_count, anonymousSessions.messages_limit),
        ),
      )
      .returning();

    return session ?? null;
  }

  /**
   * Refunds a pre-stream anonymous free-message reservation.
   *
   * The guard keeps repeated abort/error paths from driving the counter below 0.
   */
  async refundMessageSlot(sessionId: string): Promise<AnonymousSession | null> {
    const [session] = await dbWrite
      .update(anonymousSessions)
      .set({
        message_count: sql`${anonymousSessions.message_count} - 1`,
      })
      .where(and(eq(anonymousSessions.id, sessionId), gt(anonymousSessions.message_count, 0)))
      .returning();

    return session ?? null;
  }

  /**
   * Atomically increments hourly message count for rate limiting.
   *
   * Resets hourly counter if hour has passed. Uses atomic operations
   * to minimize race conditions.
   *
   * @throws Error if session not found.
   */
  async incrementHourlyCount(sessionId: string): Promise<AnonymousHourlyRateLimitResult> {
    const hourlyLimit = Number.parseInt(process.env.ANON_HOURLY_LIMIT || "10", 10);
    const now = new Date();
    const oneHourAgo = new Date(now.getTime() - HOUR_MS);

    // Use a single atomic update with conditional logic
    // This resets the counter if the hour has passed, otherwise increments
    const [updated] = await dbWrite
      .update(anonymousSessions)
      .set({
        hourly_message_count: sql`
          CASE 
            WHEN ${anonymousSessions.hourly_reset_at} IS NULL 
              OR ${anonymousSessions.hourly_reset_at} < ${oneHourAgo}
            THEN 1
            ELSE ${anonymousSessions.hourly_message_count} + 1
          END
        `,
        hourly_reset_at: sql`
          CASE 
            WHEN ${anonymousSessions.hourly_reset_at} IS NULL 
              OR ${anonymousSessions.hourly_reset_at} < ${oneHourAgo}
            THEN ${now}
            ELSE ${anonymousSessions.hourly_reset_at}
          END
        `,
        last_message_at: now,
      })
      .where(eq(anonymousSessions.id, sessionId))
      .returning();

    if (!updated) {
      throw new Error("Session not found");
    }

    // Check if limit exceeded after update
    if (updated.hourly_message_count > hourlyLimit) {
      if (!updated.hourly_reset_at) {
        throw new ElizaError("Anonymous hourly window is unavailable after quota update", {
          code: "ANONYMOUS_HOURLY_WINDOW_UNAVAILABLE",
          context: {
            sessionId,
            hourlyMessageCount: updated.hourly_message_count,
          },
          severity: "fatal",
        });
      }
      return {
        allowed: false,
        remaining: 0,
        retryAfter: Math.max(
          1,
          Math.ceil((updated.hourly_reset_at.getTime() + HOUR_MS - now.getTime()) / 1_000),
        ),
      };
    }

    return {
      allowed: true,
      remaining: hourlyLimit - updated.hourly_message_count,
    };
  }

  /**
   * Atomically tracks token usage for analytics (not billing).
   *
   * @throws Error if session not found.
   */
  async addTokenUsage(sessionId: string, tokens: number): Promise<void> {
    const result = await dbWrite
      .update(anonymousSessions)
      .set({
        total_tokens_used: sql`${anonymousSessions.total_tokens_used} + ${tokens}`,
      })
      .where(eq(anonymousSessions.id, sessionId))
      .returning({ id: anonymousSessions.id });

    if (result.length === 0) {
      throw new Error("Session not found");
    }
  }

  /**
   * Mirrors a strongly ordered Durable Object counter snapshot to Postgres.
   * The revision predicate makes delayed waitUntil work harmless.
   */
  async persistGateCounterSnapshot(snapshot: AnonymousChatGateCounterSnapshot): Promise<boolean> {
    const [updated] = await dbWrite
      .update(anonymousSessions)
      .set({
        message_count: snapshot.messageCount,
        hourly_message_count: snapshot.hourlyMessageCount,
        hourly_reset_at: snapshot.hourlyResetAt,
        last_message_at: snapshot.lastMessageAt,
        gate_revision: snapshot.revision,
      })
      .where(
        and(
          eq(anonymousSessions.id, snapshot.sessionId),
          lt(anonymousSessions.gate_revision, snapshot.revision),
        ),
      )
      .returning({ id: anonymousSessions.id });

    return Boolean(updated);
  }

  /**
   * Atomically increments signup prompt count and updates timestamp.
   *
   * @throws Error if session not found.
   */
  async incrementSignupPrompt(sessionId: string): Promise<void> {
    const result = await dbWrite
      .update(anonymousSessions)
      .set({
        signup_prompted_at: new Date(),
        signup_prompt_count: sql`${anonymousSessions.signup_prompt_count} + 1`,
      })
      .where(eq(anonymousSessions.id, sessionId))
      .returning({ id: anonymousSessions.id });

    if (result.length === 0) {
      throw new Error("Session not found");
    }
  }

  /**
   * Marks session as converted (user signed up) and deactivates it.
   */
  async markConverted(sessionId: string): Promise<string | null> {
    const [session] = await dbWrite
      .update(anonymousSessions)
      .set({
        converted_at: new Date(),
        is_active: false,
      })
      .where(eq(anonymousSessions.id, sessionId))
      .returning({ sessionToken: anonymousSessions.session_token });
    return session?.sessionToken ?? null;
  }

  /**
   * Deactivates a session.
   */
  async deactivate(sessionId: string): Promise<string | null> {
    const [session] = await dbWrite
      .update(anonymousSessions)
      .set({
        is_active: false,
      })
      .where(eq(anonymousSessions.id, sessionId))
      .returning({ sessionToken: anonymousSessions.session_token });
    return session?.sessionToken ?? null;
  }

  /**
   * Deletes expired sessions (cleanup job).
   *
   * @returns Number of sessions deleted.
   */
  async deleteExpired(): Promise<number> {
    const now = new Date();
    const result = await dbWrite
      .delete(anonymousSessions)
      .where(lt(anonymousSessions.expires_at, now));

    return mutateRowCount(result);
  }
}

/**
 * Singleton instance of AnonymousSessionsRepository.
 */
export const anonymousSessionsRepository = new AnonymousSessionsRepository();
