/** Persists CLI auth sessions through primary-safe reveal and lifecycle operations. */
import { and, eq, exists, gt, inArray, isNotNull, isNull, lt, or } from "drizzle-orm";
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
    requireAcknowledgement?: boolean;
  }): Promise<CliAuthSession | undefined> {
    const consumedAt = new Date();
    const [claimed] = await dbWrite
      .update(cliAuthSessions)
      .set({
        consumed_at: consumedAt,
        // Android's cancellation-sensitive flow uses `pending` + a non-null
        // consumed_at as a durable delivered-but-unacknowledged state. This
        // reuses the existing schema while keeping legacy CLI reveals on the
        // authenticated state they have always used.
        ...(input.requireAcknowledgement ? { status: "pending" as const } : {}),
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

  /** Atomically confirms that the exact delivered credential reached its client. */
  async acknowledgeConsumed(input: {
    sessionId: string;
    apiKeyId: string;
    userId: string;
    organizationId: string;
    keyHash: string;
  }): Promise<CliAuthSession | undefined> {
    const acknowledgedAt = new Date();
    const [acknowledged] = await dbWrite
      .update(cliAuthSessions)
      .set({ status: "authenticated", updated_at: acknowledgedAt })
      .where(
        and(
          eq(cliAuthSessions.session_id, input.sessionId),
          eq(cliAuthSessions.status, "pending"),
          isNotNull(cliAuthSessions.consumed_at),
          gt(cliAuthSessions.expires_at, acknowledgedAt),
          eq(cliAuthSessions.api_key_id, input.apiKeyId),
          eq(cliAuthSessions.user_id, input.userId),
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
                  or(isNull(apiKeys.expires_at), gt(apiKeys.expires_at, acknowledgedAt)),
                ),
              ),
          ),
        ),
      )
      .returning();

    return acknowledged;
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
   * Reaps every expired CLI auth session and revokes the orphan credentials
   * they minted, in one primary transaction.
   *
   * An abandoned sign-in ends `authenticated` with `consumed_at = NULL`: the
   * key row exists and is active, but its plaintext was never revealed to any
   * caller (`getAndClearApiKey` is the only reveal path and it stamps
   * `consumed_at`). Deleting such a session without touching its key would
   * strand a live credential nobody holds — the #22551 orphan population — so
   * the key is deactivated in the same transaction that removes the session.
   * A cancellation-sensitive reveal remains `pending` until its client proves
   * receipt with the exact bearer. Expired unacknowledged reveals are revoked;
   * acknowledged and legacy consumed sessions leave their keys active.
   *
   * Returns the revoked keys' hashes so the caller can invalidate auth caches
   * AFTER commit (write-then-invalidate; a pre-commit invalidation could be
   * repopulated from the not-yet-revoked row).
   */
  async reapExpiredSessions(now: Date = new Date()): Promise<{
    deletedSessions: number;
    revokedOrphanKeys: { id: string; key_hash: string }[];
  }> {
    return await dbWrite.transaction(async (tx) => {
      const orphanKeyIds = tx
        .select({ id: cliAuthSessions.api_key_id })
        .from(cliAuthSessions)
        .where(
          and(
            lt(cliAuthSessions.expires_at, now),
            or(isNull(cliAuthSessions.consumed_at), eq(cliAuthSessions.status, "pending")),
            isNotNull(cliAuthSessions.api_key_id),
          ),
        );

      const revokedOrphanKeys = await tx
        .update(apiKeys)
        .set({ is_active: false, updated_at: now })
        .where(
          and(
            inArray(apiKeys.id, orphanKeyIds),
            eq(apiKeys.is_active, true),
            isNull(apiKeys.deleted_at),
          ),
        )
        .returning({ id: apiKeys.id, key_hash: apiKeys.key_hash });

      const deleted = await tx
        .delete(cliAuthSessions)
        .where(lt(cliAuthSessions.expires_at, now))
        .returning({ id: cliAuthSessions.id });

      return { deletedSessions: deleted.length, revokedOrphanKeys };
    });
  }
}

/**
 * Singleton instance of CliAuthSessionsRepository.
 */
export const cliAuthSessionsRepository = new CliAuthSessionsRepository();
