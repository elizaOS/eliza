/** Persists CLI auth sessions through primary-safe reveal and lifecycle operations. */
import { and, eq, exists, gt, isNull, lt, or } from "drizzle-orm";
import { dbRead, dbWrite } from "../helpers";
import { type ApiKey, apiKeys } from "../schemas/api-keys";
import {
  type CliAuthSession,
  cliAuthSessions,
  type NewCliAuthSession,
} from "../schemas/cli-auth-sessions";

export type { CliAuthSession, NewCliAuthSession };

export interface CliAuthApiKeyRevealState {
  session: CliAuthSession;
  apiKey: ApiKey | null;
}

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
   * Loads the durable reveal state from the primary database.
   *
   * CLI completion writes the session and API-key row on the primary, then the
   * CLI polls immediately. A replica read here can observe a false miss or an
   * older session state, so the complete candidate is read consistently in one
   * left-joined query before the external KMS decrypt. The left join preserves
   * a broken API-key reference so the service can report an integrity failure
   * instead of misclassifying it as an already-consumed session.
   */
  async findApiKeyRevealState(sessionId: string): Promise<CliAuthApiKeyRevealState | undefined> {
    const [state] = await dbWrite
      .select({ session: cliAuthSessions, apiKey: apiKeys })
      .from(cliAuthSessions)
      .leftJoin(apiKeys, eq(cliAuthSessions.api_key_id, apiKeys.id))
      .where(eq(cliAuthSessions.session_id, sessionId))
      .limit(1);

    return state;
  }

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
  ): Promise<CliAuthSession | undefined> {
    return await this.update(sessionId, {
      status: "authenticated",
      user_id: userId,
      api_key_id: apiKeyId,
      authenticated_at: new Date(),
    });
  }

  /**
   * Atomically claims a session's single-use plaintext reveal (D-6).
   *
   * Every eligibility condition used before decryption is repeated on the
   * primary write. Concurrent pollers may both do the read/decrypt work, but
   * only the update winner receives the plaintext. Matching the expected key
   * and owner also prevents a stale read from consuming a changed session.
   */
  async claimConsumed(input: {
    sessionId: string;
    apiKeyId: string;
    userId: string;
    organizationId: string;
    keyHash: string;
  }): Promise<CliAuthSession | undefined> {
    const consumedAt = new Date();
    const [claimed] = await dbWrite
      .update(cliAuthSessions)
      .set({
        consumed_at: consumedAt,
        updated_at: consumedAt,
      })
      .where(
        and(
          eq(cliAuthSessions.session_id, input.sessionId),
          eq(cliAuthSessions.status, "authenticated"),
          eq(cliAuthSessions.api_key_id, input.apiKeyId),
          eq(cliAuthSessions.user_id, input.userId),
          gt(cliAuthSessions.expires_at, consumedAt),
          isNull(cliAuthSessions.consumed_at),
          exists(
            dbWrite
              .select({ id: apiKeys.id })
              .from(apiKeys)
              .where(
                and(
                  eq(apiKeys.id, input.apiKeyId),
                  eq(apiKeys.user_id, input.userId),
                  eq(apiKeys.organization_id, input.organizationId),
                  eq(apiKeys.key_hash, input.keyHash),
                  eq(apiKeys.is_active, true),
                  isNull(apiKeys.deleted_at),
                  or(isNull(apiKeys.expires_at), gt(apiKeys.expires_at, consumedAt)),
                ),
              ),
          ),
        ),
      )
      .returning();

    return claimed;
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
