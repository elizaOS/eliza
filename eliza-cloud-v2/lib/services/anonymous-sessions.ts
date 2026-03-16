import { anonymousSessionsRepository } from "@/db/repositories";
import type { AnonymousSession } from "@/db/schemas";

/**
 * Anonymous Sessions Service
 *
 * Business logic for managing anonymous user sessions.
 */
class AnonymousSessionsService {
  async getByToken(sessionToken: string) {
    return anonymousSessionsRepository.getByToken(sessionToken);
  }

  async getByUserId(userId: string) {
    return anonymousSessionsRepository.getByUserId(userId);
  }

  async create(data: {
    session_token: string;
    user_id: string;
    expires_at: Date;
    ip_address?: string;
    user_agent?: string;
    fingerprint?: string;
    messages_limit?: number;
  }) {
    return anonymousSessionsRepository.create(data);
  }

  async incrementMessageCount(sessionId: string) {
    return anonymousSessionsRepository.incrementMessageCount(sessionId);
  }

  async checkRateLimit(
    sessionId: string,
  ): Promise<{ allowed: boolean; remaining: number; retryAfter?: number }> {
    return anonymousSessionsRepository.incrementHourlyCount(sessionId);
  }

  async addTokenUsage(sessionId: string, tokens: number) {
    return anonymousSessionsRepository.addTokenUsage(sessionId, tokens);
  }

  async incrementSignupPrompt(sessionId: string) {
    return anonymousSessionsRepository.incrementSignupPrompt(sessionId);
  }

  async markConverted(sessionId: string) {
    return anonymousSessionsRepository.markConverted(sessionId);
  }

  async deactivate(sessionId: string) {
    return anonymousSessionsRepository.deactivate(sessionId);
  }

  async deleteExpired() {
    return anonymousSessionsRepository.deleteExpired();
  }

  /**
   * Check if session has reached message limit
   */
  async hasReachedLimit(session: AnonymousSession): Promise<boolean> {
    return session.message_count >= session.messages_limit;
  }

  /**
   * Get remaining messages for a session
   */
  getRemainingMessages(session: AnonymousSession): number {
    return Math.max(0, session.messages_limit - session.message_count);
  }

  /**
   * NOTE: IP-based anonymous-session abuse checks were removed.
   * We intentionally do not block anonymous session creation by IP.
   */
}

export const anonymousSessionsService = new AnonymousSessionsService();
