/**
 * Service for managing CLI authentication sessions.
 */

import { apiKeysRepository, cliAuthSessionsRepository } from "@/db/repositories";
import type { CliAuthSession } from "@/db/schemas/cli-auth-sessions";
import { apiKeysService } from "./api-keys";

/**
 * Session expiry time in minutes.
 */
const SESSION_EXPIRY_MINUTES = 10; // Sessions expire after 10 minutes
const CLI_LOGIN_KEY_NAME = "CLI Login";

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

    // Keep only one active CLI-login key per user to prevent key sprawl when
    // the login flow is retried repeatedly. Deactivate both the current
    // canonical name and legacy timestamped names ("CLI Login - ...").
    await apiKeysService.deactivateUserKeysByName(userId, CLI_LOGIN_KEY_NAME);
    const orgKeys = await apiKeysRepository.listByOrganization(organizationId);
    for (const key of orgKeys) {
      if (
        key.user_id === userId &&
        key.is_active &&
        typeof key.name === "string" &&
        key.name.startsWith(`${CLI_LOGIN_KEY_NAME} - `)
      ) {
        await apiKeysService.update(key.id, { is_active: false });
      }
    }

    // Generate API key for CLI usage
    const { apiKey, plainKey } = await apiKeysService.create({
      name: CLI_LOGIN_KEY_NAME,
      description: "Generated via CLI login command",
      organization_id: organizationId,
      user_id: userId,
      permissions: [], // Full access
      rate_limit: 1000,
      is_active: true,
      expires_at: null, // Never expires by default
    });

    // Update session with authentication details and temporarily store plain key
    const updatedSession = await cliAuthSessionsRepository.markAuthenticated(
      sessionId,
      userId,
      apiKey.id,
      plainKey, // Store temporarily for CLI retrieval
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
   * Get API key from authenticated session and clear it
   * This ensures the plain key is only retrieved once
   */
  async getAndClearApiKey(sessionId: string): Promise<{
    apiKey: string;
    keyPrefix: string;
    expiresAt: Date | null;
  } | null> {
    const session = await this.getActiveSession(sessionId);

    if (!session || session.status !== "authenticated" || !session.api_key_plain) {
      return null;
    }

    // Get API key details
    const apiKey = session.api_key_plain;
    const apiKeyRecord = await apiKeysRepository.findById(session.api_key_id!);

    // Clear the plain key from the session for security
    await cliAuthSessionsRepository.clearPlainKey(sessionId);

    return {
      apiKey,
      keyPrefix: apiKeyRecord?.key_prefix || "",
      expiresAt: apiKeyRecord?.expires_at || null,
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
