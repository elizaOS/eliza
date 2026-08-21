/**
 * Service for managing CLI authentication sessions.
 */

import { ElizaError } from "@elizaos/core";
import crypto from "crypto";
import { decryptApiKey } from "../../db/crypto/api-keys";
import { cliAuthSessionsRepository } from "../../db/repositories";
import type { ApiKey } from "../../db/schemas/api-keys";
import type { CliAuthSession } from "../../db/schemas/cli-auth-sessions";
import { apiKeysService, isCliApiKeySecret } from "./api-keys";
import { cliAuthSessionCompletionService } from "./cli-auth-session-completion";

/**
 * Session expiry time in minutes.
 */
const SESSION_EXPIRY_MINUTES = 10; // Sessions expire after 10 minutes

/**
 * Session ids are server-generated UUIDs (POST /api/auth/cli-session mints
 * them; client-chosen ids allowed squatting and unbounded row inserts).
 * Routes validate the format before touching the store.
 */
const CLI_AUTH_SESSION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function looksLikeCliAuthSessionId(sessionId: string): boolean {
  return CLI_AUTH_SESSION_ID_PATTERN.test(sessionId);
}

export type CliAuthApiKeyRevealResult =
  | {
      status: "revealed";
      apiKey: string;
      keyPrefix: string;
      expiresAt: Date | null;
    }
  | {
      status: "unavailable";
      reason: "not-found" | "not-authenticated" | "expired" | "consumed" | "revoked" | "claim-lost";
    };

function revealIntegrityError(sessionId: string, defect: string): ElizaError {
  return new ElizaError("CLI auth session cannot reveal its API key", {
    code: "CLI_AUTH_SESSION_INTEGRITY",
    context: { sessionId, defect },
    severity: "fatal",
  });
}

/**
 * Service for CLI authentication flow and session management.
 */
export class CliAuthSessionsService {
  private async alreadyAuthenticatedResult(
    session: CliAuthSession,
    userId: string,
    organizationId: string,
    primaryApiKey: ApiKey | null,
  ): Promise<{
    session: CliAuthSession;
    keyPrefix: string;
    expiresAt: Date | null;
    alreadyAuthenticated: true;
  }> {
    if (!session.user_id || session.user_id !== userId) {
      throw new Error("Session already authenticated or expired");
    }

    if (!session.api_key_id) {
      throw new ElizaError("Authenticated CLI session has no API key reference", {
        code: "CLI_AUTH_SESSION_INTEGRITY",
        context: { sessionId: session.session_id, defect: "missing_api_key_id" },
        severity: "fatal",
      });
    }
    if (!primaryApiKey) {
      throw new ElizaError("Authenticated CLI session references a missing API key", {
        code: "CLI_AUTH_SESSION_INTEGRITY",
        context: { sessionId: session.session_id, defect: "missing_api_key_row" },
        severity: "fatal",
      });
    }
    if (primaryApiKey.user_id !== userId || primaryApiKey.organization_id !== organizationId) {
      throw new ElizaError(
        "Authenticated CLI session references an API key with different ownership",
        {
          code: "CLI_AUTH_SESSION_INTEGRITY",
          context: { sessionId: session.session_id, defect: "api_key_owner_mismatch" },
          severity: "fatal",
        },
      );
    }

    return {
      session,
      keyPrefix: primaryApiKey.key_prefix,
      expiresAt: primaryApiKey.expires_at ?? null,
      alreadyAuthenticated: true,
    };
  }

  /**
   * Create a new CLI authentication session
   */
  async createSession(sessionId: string): Promise<CliAuthSession> {
    const expiresAt = new Date();
    expiresAt.setMinutes(expiresAt.getMinutes() + SESSION_EXPIRY_MINUTES);

    return await cliAuthSessionsRepository.create({
      session_id: sessionId,
      status: "pending",
      expires_at: expiresAt,
    });
  }

  /**
   * Get session by session ID
   */
  async getSession(sessionId: string): Promise<CliAuthSession | null> {
    const session = await cliAuthSessionsRepository.findBySessionId(sessionId);
    return session || null;
  }

  /**
   * Get active session (not expired)
   */
  async getActiveSession(sessionId: string): Promise<CliAuthSession | null> {
    const session = await cliAuthSessionsRepository.findActiveBySessionId(sessionId);

    // Check if session is expired
    if (session && new Date() > new Date(session.expires_at)) {
      await cliAuthSessionsRepository.markExpired(sessionId);
      return null;
    }

    return session || null;
  }

  /**
   * Complete authentication for a session
   * Generates API key and marks session as authenticated
   */
  async completeAuthentication(
    sessionId: string,
    userId: string,
    organizationId: string,
  ): Promise<{
    session: CliAuthSession;
    keyPrefix: string;
    expiresAt: Date | null;
    alreadyAuthenticated: boolean;
  }> {
    // Completion is a consistency-sensitive state transition. A replica miss
    // immediately after session creation must not turn a valid login into an
    // "expired" error, so establish the initial state on the primary.
    const state = await cliAuthSessionCompletionService.findActive(sessionId);
    const session = state?.session;

    if (!session) {
      throw new Error("Invalid or expired session");
    }

    // Browser retries are safe only when ownership is positively established;
    // a legacy row without an owner cannot prove that the caller completed it.
    if (session.status === "authenticated") {
      return await this.alreadyAuthenticatedResult(
        session,
        userId,
        organizationId,
        state.apiKey ?? null,
      );
    }

    if (session.status === "pending" && session.consumed_at) {
      throw new Error("Session delivery is awaiting acknowledgement");
    }

    if (session.status !== "pending") {
      // Expired or any other non-pending terminal state.
      throw new Error("Session already authenticated or expired");
    }

    const claim = await cliAuthSessionCompletionService.claimPending({
      sessionId,
      userId,
      organizationId,
    });

    if (!claim.claimed) {
      // Read from the same primary transaction that lost the conditional
      // update. This avoids a read-replica lag window after another request
      // wins the claim.
      if (claim.session?.status === "authenticated") {
        return await this.alreadyAuthenticatedResult(
          claim.session,
          userId,
          organizationId,
          claim.apiKey ?? null,
        );
      }
      if (!claim.session || claim.session.expires_at <= new Date()) {
        throw new Error("Invalid or expired session");
      }
      throw new Error("Session already authenticated or expired");
    }

    return {
      session: claim.session,
      keyPrefix: claim.apiKey.key_prefix,
      expiresAt: claim.apiKey.expires_at,
      alreadyAuthenticated: false,
    };
  }

  /**
   * Single-use plaintext retrieval (D-6).
   *
   * Returns the decrypted plaintext API key for an authenticated session at
   * most once. One concurrent caller can win the `consumed_at` claim; if its
   * response is lost after that claim, the credential is intentionally not
   * replayable and the caller must create a new CLI auth session.
   *
   * The plaintext is decrypted in-memory from the encrypted api_keys row
   * and never persisted on the cli_auth_sessions row.
   */
  async getAndClearApiKey(
    sessionId: string,
    options: { requireAcknowledgement?: boolean } = {},
  ): Promise<CliAuthApiKeyRevealResult> {
    const state = await cliAuthSessionsRepository.findApiKeyRevealState(sessionId);
    if (!state) {
      return { status: "unavailable", reason: "not-found" };
    }

    const { apiKey: apiKeyRecord, session } = state;
    if (session.status !== "authenticated") {
      return { status: "unavailable", reason: "not-authenticated" };
    }
    if (session.expires_at <= new Date()) {
      return { status: "unavailable", reason: "expired" };
    }
    if (session.consumed_at) {
      return { status: "unavailable", reason: "consumed" };
    }
    if (!session.api_key_id) {
      throw revealIntegrityError(sessionId, "missing_api_key_id");
    }
    if (!session.user_id) {
      throw revealIntegrityError(sessionId, "missing_user_id");
    }
    if (!apiKeyRecord) {
      throw revealIntegrityError(sessionId, "missing_api_key_row");
    }
    if (apiKeyRecord.user_id !== session.user_id) {
      throw revealIntegrityError(sessionId, "api_key_owner_mismatch");
    }
    if (
      !apiKeyRecord.is_active ||
      apiKeyRecord.deleted_at ||
      (apiKeyRecord.expires_at && apiKeyRecord.expires_at <= new Date())
    ) {
      return { status: "unavailable", reason: "revoked" };
    }
    if (
      !apiKeyRecord.key_ciphertext ||
      !apiKeyRecord.key_nonce ||
      !apiKeyRecord.key_auth_tag ||
      !apiKeyRecord.key_kms_key_id ||
      apiKeyRecord.key_kms_key_version == null
    ) {
      throw revealIntegrityError(sessionId, "incomplete_encrypted_key");
    }

    const plaintext = await decryptApiKey(apiKeyRecord.id, {
      ciphertext: apiKeyRecord.key_ciphertext,
      nonce: apiKeyRecord.key_nonce,
      auth_tag: apiKeyRecord.key_auth_tag,
      kms_key_id: apiKeyRecord.key_kms_key_id,
      kms_key_version: apiKeyRecord.key_kms_key_version,
    });

    // Decryption deliberately happens before the primary-DB claim. A missing
    // key or KMS failure therefore leaves the session retryable. The claim is
    // one conditional UPDATE, so concurrent pollers have exactly one winner
    // without holding an external KMS call open inside a DB transaction.
    const claimed = await cliAuthSessionsRepository.claimConsumed({
      sessionId,
      apiKeyId: session.api_key_id,
      userId: session.user_id,
      organizationId: apiKeyRecord.organization_id,
      keyHash: apiKeyRecord.key_hash,
      requireAcknowledgement: options.requireAcknowledgement,
    });
    if (!claimed) {
      return { status: "unavailable", reason: "claim-lost" };
    }

    // Sessions minted just before this deployment still carry the historical
    // generic `eliza_` prefix. The inactive row is already committed, so clear
    // any positive validation/IAC refill before returning its plaintext. New
    // `eliza_cli_` credentials never enter either cache and need no delete.
    if (options.requireAcknowledgement && !isCliApiKeySecret(plaintext)) {
      await apiKeysService.confirmRevocationAfterCommit([apiKeyRecord.key_hash]);
    }

    return {
      status: "revealed",
      apiKey: plaintext,
      keyPrefix: apiKeyRecord.key_prefix,
      expiresAt: apiKeyRecord.expires_at,
    };
  }

  /** Confirms receipt of a cancellation-sensitive reveal using its exact bearer. */
  async acknowledgeConsumedCredential(sessionId: string, presentedToken: string): Promise<boolean> {
    const token = presentedToken.trim();
    if (!token) return false;
    const state = await cliAuthSessionsRepository.findApiKeyRevealState(sessionId);
    if (
      !state ||
      !state.session.consumed_at ||
      !state.session.api_key_id ||
      !state.session.user_id ||
      !state.apiKey ||
      state.apiKey.id !== state.session.api_key_id ||
      state.apiKey.user_id !== state.session.user_id ||
      state.apiKey.deleted_at ||
      (state.apiKey.expires_at && state.apiKey.expires_at <= new Date())
    ) {
      return false;
    }

    const presentedHash = crypto.createHash("sha256").update(token).digest();
    const storedHash = Buffer.from(state.apiKey.key_hash, "hex");
    if (
      storedHash.length !== presentedHash.length ||
      !crypto.timingSafeEqual(storedHash, presentedHash)
    ) {
      return false;
    }

    if (state.session.status === "authenticated") {
      if (!state.apiKey.is_active) return false;
      if (!isCliApiKeySecret(token)) {
        await apiKeysService.invalidateCache(state.apiKey.key_hash);
      }
      return true;
    }
    if (state.session.status !== "pending") return false;
    if (state.apiKey.is_active) return false;
    const acknowledged = await cliAuthSessionsRepository.acknowledgeConsumed({
      sessionId,
      apiKeyId: state.apiKey.id,
      userId: state.apiKey.user_id,
      organizationId: state.apiKey.organization_id,
      keyHash: state.apiKey.key_hash,
    });
    if (!acknowledged) return false;
    if (!isCliApiKeySecret(token)) {
      await apiKeysService.invalidateCache(state.apiKey.key_hash);
    }
    return true;
  }

  /**
   * Revokes only the consumed API key bound to one CLI login session.
   *
   * The session id is public, so authority comes from possession of the exact
   * revealed plaintext key and its immutable session-to-key binding. A token
   * from a newer login cannot revoke this row, even for the same user or org.
   */
  async revokeConsumedCredential(sessionId: string, presentedToken: string): Promise<boolean> {
    const token = presentedToken.trim();
    if (!token) return false;
    const state = await cliAuthSessionsRepository.findApiKeyRevealState(sessionId);
    if (
      !state ||
      (state.session.status !== "authenticated" &&
        state.session.status !== "pending" &&
        state.session.status !== "expired") ||
      !state.session.consumed_at ||
      !state.session.api_key_id ||
      !state.session.user_id ||
      !state.apiKey ||
      state.apiKey.id !== state.session.api_key_id ||
      state.apiKey.user_id !== state.session.user_id
    ) {
      return false;
    }

    const presentedHash = crypto.createHash("sha256").update(token).digest();
    const storedHash = Buffer.from(state.apiKey.key_hash, "hex");
    if (
      storedHash.length !== presentedHash.length ||
      !crypto.timingSafeEqual(storedHash, presentedHash)
    ) {
      return false;
    }

    const revoked = await cliAuthSessionsRepository.revokeConsumed({
      sessionId,
      apiKeyId: state.apiKey.id,
      userId: state.apiKey.user_id,
      organizationId: state.apiKey.organization_id,
      keyHash: state.apiKey.key_hash,
    });
    if (!revoked) return false;

    // A response may be lost after the atomic database mutation but before
    // cache invalidation is confirmed. An exact retry re-enters the terminal
    // session and confirms denial again before reporting success.
    await apiKeysService.invalidateCache(state.apiKey.key_hash);
    return true;
  }

  /**
   * Reaps expired sessions and revokes the orphan keys minted by abandoned
   * sign-ins (cron-driven). The revocation commits first, then each revoked
   * hash's auth caches are invalidated — matching the write-then-invalidate
   * ordering the revocation paths use. These keys' plaintext was never
   * revealed (consumed_at was NULL), so no warm cache entry can exist; the
   * invalidation is defense-in-depth and an unconfirmed delete surfaces to
   * the cron boundary rather than being swallowed.
   */
  async cleanupExpiredSessions(): Promise<{
    deletedSessions: number;
    revokedOrphanKeys: number;
  }> {
    // Pin one cutoff across both phases. A later deletion cutoff could remove
    // a session that expired after candidate selection without first revoking
    // and invalidating its credential.
    const cutoff = new Date();
    const revokedOrphanKeys = await cliAuthSessionsRepository.prepareExpiredSessionsForReap(cutoff);
    // This helper attempts every hash before throwing. If any invalidation is
    // unconfirmed, the expired session rows remain as durable retry carriers;
    // the next cron pass re-offers even already-inactive keys.
    await apiKeysService.confirmRevocationAfterCommit(revokedOrphanKeys.map((key) => key.key_hash));
    const deletedSessions = await cliAuthSessionsRepository.deleteExpiredSessions(cutoff);

    return { deletedSessions, revokedOrphanKeys: revokedOrphanKeys.length };
  }
}

export const cliAuthSessionsService = new CliAuthSessionsService();
