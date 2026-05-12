import { and, eq, gt, lt } from "drizzle-orm";
import { dbRead, dbWrite } from "@/db/helpers";
import {
  type CliAuthSession,
  cliAuthSessions,
  type NewCliAuthSession,
} from "@/db/schemas/cli-auth-sessions";

export type { CliAuthSession, NewCliAuthSession };

/**
 * Repository for CLI authentication session database operations.
 */
export class CliAuthSessionsRepository {
  // ============================================================================
  // READ OPERATIONS (use read-intent connection)
  // ============================================================================

  /**
   * Finds a CLI auth session by session ID.
   */
  async findBySessionId(sessionId: string): Promise<CliAuthSession | undefined> {
    const [session] = await dbRead
      .select()
      .from(cliAuthSessions)
      .where(eq(cliAuthSessions.session_id, sessionId))
      .limit(1);

    return session;
  }

  /**
   * Finds an active (non-expired) CLI auth session by session ID.
   */
  async findActiveBySessionId(sessionId: string): Promise<CliAuthSession | undefined> {
    const now = new Date();
    const [session] = await dbRead
      .select()
      .from(cliAuthSessions)
      .where(and(eq(cliAuthSessions.session_id, sessionId), gt(cliAuthSessions.expires_at, now)))
      .limit(1);

    return session;
  }

  // ============================================================================
  // WRITE OPERATIONS (use primary)
  // ============================================================================

  /**
   * Creates a new CLI auth session.
   *
   * @throws Error if session creation fails.
   */
  async create(data: NewCliAuthSession): Promise<CliAuthSession> {
    const [session] = await dbWrite.insert(cliAuthSessions).values(data).returning();

    if (!session) {
      throw new Error("Failed to create CLI auth session");
    }

    return session;
  }

  /**
   * Updates an existing CLI auth session.
   */
  async update(
    sessionId: string,
    data: Partial<NewCliAuthSession>,
  ): Promise<CliAuthSession | undefined> {
    const [updated] = await dbWrite
      .update(cliAuthSessions)
      .set({
        ...data,
        updated_at: new Date(),
      })
      .where(eq(cliAuthSessions.session_id, sessionId))
      .returning();

    return updated;
  }

  /**
   * Marks a session as authenticated and stores user/API key information.
   */
  async markAuthenticated(
    sessionId: string,
    userId: string,
    apiKeyId: string,
    apiKeyPlain: string,
  ): Promise<CliAuthSession | undefined> {
    return await this.update(sessionId, {
      status: "authenticated",
      user_id: userId,
      api_key_id: apiKeyId,
      api_key_plain: apiKeyPlain,
      authenticated_at: new Date(),
    });
  }

  /**
   * Clears the plain API key from a session (for security after retrieval).
   */
  async clearPlainKey(sessionId: string): Promise<void> {
    await dbWrite
      .update(cliAuthSessions)
      .set({
        api_key_plain: null,
        updated_at: new Date(),
      })
      .where(eq(cliAuthSessions.session_id, sessionId));
  }

  /**
   * Marks a session as expired.
   */
  async markExpired(sessionId: string): Promise<void> {
    await dbWrite
      .update(cliAuthSessions)
      .set({
        status: "expired",
        updated_at: new Date(),
      })
      .where(eq(cliAuthSessions.session_id, sessionId));
  }

  /**
   * Deletes all expired CLI auth sessions.
   */
  async deleteExpiredSessions(): Promise<void> {
    const now = new Date();
    await dbWrite.delete(cliAuthSessions).where(lt(cliAuthSessions.expires_at, now));
  }
}

/**
 * Singleton instance of CliAuthSessionsRepository.
 */
export const cliAuthSessionsRepository = new CliAuthSessionsRepository();
