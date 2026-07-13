/**
 * Service for managing CLI authentication sessions.
 */

import { ElizaError } from "@elizaos/core";
import { decryptApiKey } from "../../db/crypto/api-keys";
import { apiKeysRepository, cliAuthSessionsRepository } from "../../db/repositories";
import type { ApiKey } from "../../db/schemas/api-keys";
import type { CliAuthSession } from "../../db/schemas/cli-auth-sessions";
import { cliAuthSessionCompletionService } from "./cli-auth-session-completion";

/**
 * Session expiry time in minutes.
 */
const SESSION_EXPIRY_MINUTES = 10; // Sessions expire after 10 minutes

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
   * Returns the decrypted plaintext API key for an authenticated session
   * exactly once. The session is marked `consumed_at` in the same call,
   * after which further attempts return null.
   *
   * The plaintext is decrypted in-memory from the encrypted api_keys row
   * and never persisted on the cli_auth_sessions row.
   */
  async getAndClearApiKey(sessionId: string): Promise<{
    apiKey: string;
    keyPrefix: string;
    expiresAt: Date | null;
  } | null> {
    const session = await this.getActiveSession(sessionId);

    if (
      !session ||
      session.status !== "authenticated" ||
      !session.api_key_id ||
      session.consumed_at
    ) {
      return null;
    }

    const apiKeyRecord = await apiKeysRepository.findById(session.api_key_id);
    if (
      !apiKeyRecord ||
      !apiKeyRecord.key_ciphertext ||
      !apiKeyRecord.key_nonce ||
      !apiKeyRecord.key_auth_tag ||
      !apiKeyRecord.key_kms_key_id ||
      apiKeyRecord.key_kms_key_version == null
    ) {
      return null;
    }

    const plaintext = await decryptApiKey(apiKeyRecord.id, {
      ciphertext: apiKeyRecord.key_ciphertext,
      nonce: apiKeyRecord.key_nonce,
      auth_tag: apiKeyRecord.key_auth_tag,
      kms_key_id: apiKeyRecord.key_kms_key_id,
      kms_key_version: apiKeyRecord.key_kms_key_version,
    });

    await cliAuthSessionsRepository.markConsumed(sessionId);

    return {
      apiKey: plaintext,
      keyPrefix: apiKeyRecord.key_prefix,
      expiresAt: apiKeyRecord.expires_at,
    };
  }

  /**
   * Clean up expired sessions (should be called by a cron job)
   */
  async cleanupExpiredSessions(): Promise<void> {
    await cliAuthSessionsRepository.deleteExpiredSessions();
  }
}

export const cliAuthSessionsService = new CliAuthSessionsService();
