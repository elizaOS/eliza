/**
 * Service for managing CLI authentication sessions.
 */

import { decryptApiKey } from "../../db/crypto/api-keys";
import { apiKeysRepository, cliAuthSessionsRepository } from "../../db/repositories";
import type { CliAuthSession } from "../../db/schemas/cli-auth-sessions";
import { apiKeysService } from "./api-keys";

/**
 * Session expiry time in minutes.
 */
const SESSION_EXPIRY_MINUTES = 10; // Sessions expire after 10 minutes

/**
 * Service for CLI authentication flow and session management.
 */
export class CliAuthSessionsService {
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
    apiKey: string;
    keyPrefix: string;
    expiresAt: Date | null;
  }> {
    // Check if session exists and is still valid
    const session = await this.getActiveSession(sessionId);

    if (!session) {
      throw new Error("Invalid or expired session");
    }

    if (session.status !== "pending") {
      throw new Error("Session already authenticated or expired");
    }

    // Generate API key for CLI usage
    const { apiKey, plainKey } = await apiKeysService.create({
      name: `CLI Login - ${new Date().toISOString()}`,
      description: "Generated via CLI login command",
      organization_id: organizationId,
      user_id: userId,
      permissions: [], // Full access
      rate_limit: 1000,
      is_active: true,
      expires_at: null, // Never expires by default
    });

    // Update session with authentication details (no plaintext stored — D-6).
    const updatedSession = await cliAuthSessionsRepository.markAuthenticated(
      sessionId,
      userId,
      apiKey.id,
    );

    if (!updatedSession) {
      throw new Error("Failed to update session");
    }

    return {
      session: updatedSession,
      apiKey: plainKey,
      keyPrefix: apiKey.key_prefix,
      expiresAt: apiKey.expires_at,
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
