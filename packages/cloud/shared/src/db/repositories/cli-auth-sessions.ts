/** Persists CLI auth sessions through primary-safe reveal and lifecycle operations. */
import { ElizaError } from "@elizaos/core";
import { and, eq, exists, gt, isNotNull, isNull, lt, or } from "drizzle-orm";
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

export interface CliAuthSessionCleanupCandidate {
  session_id: string;
  api_key_id: string | null;
  key_hash: string | null;
}

function atomicCredentialTransitionError(
  sessionId: string,
  apiKeyId: string,
  transition: "activation" | "deactivation",
): ElizaError {
  return new ElizaError(`CLI delivery ${transition} did not update its bound credential`, {
    code: "CLI_AUTH_SESSION_ATOMIC_TRANSITION_FAILED",
    context: { sessionId, apiKeyId, transition },
    severity: "fatal",
  });
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
    return await dbWrite.transaction(async (tx) => {
      const [claimed] = await tx
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
              tx
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

      if (!claimed || !input.requireAcknowledgement) return claimed;

      const [deactivated] = await tx
        .update(apiKeys)
        .set({ is_active: false, updated_at: consumedAt })
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
        )
        .returning({ id: apiKeys.id });
      if (!deactivated) {
        throw atomicCredentialTransitionError(input.sessionId, input.apiKeyId, "deactivation");
      }

      return claimed;
    });
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
    return await dbWrite.transaction(async (tx) => {
      const [acknowledged] = await tx
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
              tx
                .select({ id: apiKeys.id })
                .from(apiKeys)
                .where(
                  and(
                    eq(apiKeys.id, input.apiKeyId),
                    eq(apiKeys.user_id, input.userId),
                    eq(apiKeys.organization_id, input.organizationId),
                    eq(apiKeys.key_hash, input.keyHash),
                    eq(apiKeys.is_active, false),
                    isNull(apiKeys.deleted_at),
                    or(isNull(apiKeys.expires_at), gt(apiKeys.expires_at, acknowledgedAt)),
                  ),
                ),
            ),
          ),
        )
        .returning();

      if (!acknowledged) return undefined;

      const [activated] = await tx
        .update(apiKeys)
        .set({ is_active: true, updated_at: acknowledgedAt })
        .where(
          and(
            eq(apiKeys.id, input.apiKeyId),
            eq(apiKeys.user_id, input.userId),
            eq(apiKeys.organization_id, input.organizationId),
            eq(apiKeys.key_hash, input.keyHash),
            eq(apiKeys.is_active, false),
            isNull(apiKeys.deleted_at),
            or(isNull(apiKeys.expires_at), gt(apiKeys.expires_at, acknowledgedAt)),
          ),
        )
        .returning({ id: apiKeys.id });
      if (!activated) {
        throw atomicCredentialTransitionError(input.sessionId, input.apiKeyId, "activation");
      }

      return acknowledged;
    });
  }

  /** Atomically terminalizes an exact delivered session and deactivates its key. */
  async revokeConsumed(input: {
    sessionId: string;
    apiKeyId: string;
    userId: string;
    organizationId: string;
    keyHash: string;
  }): Promise<CliAuthSession | undefined> {
    const revokedAt = new Date();
    return await dbWrite.transaction(async (tx) => {
      const exactCredentialExists = exists(
        tx
          .select({ id: apiKeys.id })
          .from(apiKeys)
          .where(
            and(
              eq(apiKeys.id, input.apiKeyId),
              eq(apiKeys.user_id, input.userId),
              eq(apiKeys.organization_id, input.organizationId),
              eq(apiKeys.key_hash, input.keyHash),
            ),
          ),
      );
      const exactSession = and(
        eq(cliAuthSessions.session_id, input.sessionId),
        isNotNull(cliAuthSessions.consumed_at),
        eq(cliAuthSessions.api_key_id, input.apiKeyId),
        eq(cliAuthSessions.user_id, input.userId),
        exactCredentialExists,
      );
      const [revoked] = await tx
        .update(cliAuthSessions)
        .set({ status: "expired", updated_at: revokedAt })
        .where(
          and(
            exactSession,
            or(eq(cliAuthSessions.status, "authenticated"), eq(cliAuthSessions.status, "pending")),
          ),
        )
        .returning();

      let terminalSession = revoked;
      if (!terminalSession) {
        [terminalSession] = await tx
          .select()
          .from(cliAuthSessions)
          .where(and(exactSession, eq(cliAuthSessions.status, "expired")))
          .limit(1);
      }
      if (!terminalSession) return undefined;

      await tx
        .update(apiKeys)
        .set({ is_active: false, updated_at: revokedAt })
        .where(
          and(
            eq(apiKeys.id, input.apiKeyId),
            eq(apiKeys.user_id, input.userId),
            eq(apiKeys.organization_id, input.organizationId),
            eq(apiKeys.key_hash, input.keyHash),
            eq(apiKeys.is_active, true),
          ),
        );
      const [credential] = await tx
        .select({ isActive: apiKeys.is_active })
        .from(apiKeys)
        .where(
          and(
            eq(apiKeys.id, input.apiKeyId),
            eq(apiKeys.user_id, input.userId),
            eq(apiKeys.organization_id, input.organizationId),
            eq(apiKeys.key_hash, input.keyHash),
          ),
        )
        .limit(1);
      if (!credential || credential.isActive) {
        throw atomicCredentialTransitionError(input.sessionId, input.apiKeyId, "deactivation");
      }

      return terminalSession;
    });
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
   * Revokes credentials owned by expired sessions before those sessions are
   * deleted.
   *
   * An abandoned sign-in ends `authenticated` with `consumed_at = NULL`: the
   * key row exists and is active, but its plaintext was never revealed to any
   * caller (`getAndClearApiKey` is the only reveal path and it stamps
   * `consumed_at`). Deleting such a session without touching its key would
   * strand a live credential nobody holds — the #22551 orphan population — so
   * the key is deactivated before post-commit cache denial is confirmed and
   * the session is removed.
   * A cancellation-sensitive reveal remains `pending` until its client proves
   * receipt with the exact bearer. Expired unacknowledged reveals are revoked;
   * acknowledged and legacy consumed sessions leave their keys active.
   *
   * Session rows are locked before their bound key so acknowledgement and
   * cleanup serialize in the same order. An acknowledgement that commits first
   * leaves an authenticated receipt, while cleanup that commits first changes
   * the pending delivery to `expired` before its key is deactivated. A stale
   * acknowledgement can therefore never reactivate a cleanup-selected key.
   *
   * Consumed authenticated sessions are revocation receipts. They remain until
   * the bound key itself expires or is deleted so a response-lost DELETE can be
   * retried with the exact bearer. Every returned candidate is terminalized in
   * this transaction and remains as a durable cache-invalidation retry carrier
   * until {@link deleteExpiredSessions} receives that exact candidate set.
   */
  async prepareExpiredSessionsForReap(
    now: Date = new Date(),
  ): Promise<CliAuthSessionCleanupCandidate[]> {
    return await dbWrite.transaction(async (tx) => {
      const expiredSessions = await tx
        .select()
        .from(cliAuthSessions)
        .where(lt(cliAuthSessions.expires_at, now))
        .orderBy(cliAuthSessions.session_id)
        .for("update");
      const candidates: CliAuthSessionCleanupCandidate[] = [];

      for (const session of expiredSessions) {
        let apiKey: ApiKey | undefined;
        if (session.api_key_id) {
          [apiKey] = await tx
            .select()
            .from(apiKeys)
            .where(eq(apiKeys.id, session.api_key_id))
            .limit(1)
            .for("update");
        }

        const keyStillLive =
          apiKey && !apiKey.deleted_at && (!apiKey.expires_at || apiKey.expires_at > now);
        if (session.status === "authenticated" && session.consumed_at && keyStillLive) {
          continue;
        }

        if (apiKey?.is_active && !apiKey.deleted_at) {
          await tx
            .update(apiKeys)
            .set({ is_active: false, updated_at: now })
            .where(
              and(
                eq(apiKeys.id, apiKey.id),
                eq(apiKeys.key_hash, apiKey.key_hash),
                eq(apiKeys.is_active, true),
                isNull(apiKeys.deleted_at),
              ),
            );
        }

        await tx
          .update(cliAuthSessions)
          .set({ status: "expired", updated_at: now })
          .where(
            and(
              eq(cliAuthSessions.session_id, session.session_id),
              session.api_key_id
                ? eq(cliAuthSessions.api_key_id, session.api_key_id)
                : isNull(cliAuthSessions.api_key_id),
            ),
          );
        candidates.push({
          session_id: session.session_id,
          api_key_id: session.api_key_id,
          key_hash: apiKey?.key_hash ?? null,
        });
      }

      return candidates;
    });
  }

  /** Deletes only prepared terminal candidates after cache denial is confirmed. */
  async deleteExpiredSessions(
    now: Date,
    candidates: readonly CliAuthSessionCleanupCandidate[],
  ): Promise<number> {
    if (candidates.length === 0) return 0;
    return await dbWrite.transaction(async (tx) => {
      let deletedCount = 0;
      for (const candidate of candidates) {
        const [session] = await tx
          .select()
          .from(cliAuthSessions)
          .where(
            and(
              eq(cliAuthSessions.session_id, candidate.session_id),
              eq(cliAuthSessions.status, "expired"),
              lt(cliAuthSessions.expires_at, now),
              candidate.api_key_id
                ? eq(cliAuthSessions.api_key_id, candidate.api_key_id)
                : isNull(cliAuthSessions.api_key_id),
            ),
          )
          .limit(1)
          .for("update");
        if (!session) continue;

        if (candidate.api_key_id) {
          const [apiKey] = await tx
            .select()
            .from(apiKeys)
            .where(eq(apiKeys.id, candidate.api_key_id))
            .limit(1)
            .for("update");
          if (apiKey) {
            const keyRemainsBound =
              !apiKey.deleted_at && (!apiKey.expires_at || apiKey.expires_at > now);
            if (
              apiKey.key_hash !== candidate.key_hash ||
              (session.consumed_at && keyRemainsBound) ||
              (apiKey.is_active && keyRemainsBound)
            ) {
              // A consumed session is the exact bearer-authorized revocation
              // receipt even after its key has been deactivated. Keep that
              // binding until the key expires or is deleted so a response-lost
              // client DELETE can still complete idempotently.
              continue;
            }
          }
        }

        const deleted = await tx
          .delete(cliAuthSessions)
          .where(
            and(
              eq(cliAuthSessions.id, session.id),
              eq(cliAuthSessions.status, "expired"),
              lt(cliAuthSessions.expires_at, now),
              candidate.api_key_id
                ? eq(cliAuthSessions.api_key_id, candidate.api_key_id)
                : isNull(cliAuthSessions.api_key_id),
            ),
          )
          .returning({ id: cliAuthSessions.id });
        deletedCount += deleted.length;
      }
      return deletedCount;
    });
  }
}

/**
 * Singleton instance of CliAuthSessionsRepository.
 */
export const cliAuthSessionsRepository = new CliAuthSessionsRepository();
