/**
 * Coordinates anonymous-session repository operations for Cloud route services.
 * Quota results remain authoritative across this boundary, while lifecycle
 * mutations invalidate the Durable Object admission cache by session token.
 */

import {
  type AnonymousHourlyRateLimitResult,
  anonymousSessionsRepository,
} from "../../db/repositories";
import type { AnonymousSession } from "../../db/schemas";
import { invalidateAnonymousChatGateByToken } from "./anonymous-chat-admission";

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

  async reserveMessageSlot(sessionId: string) {
    return anonymousSessionsRepository.reserveMessageSlot(sessionId);
  }

  async refundMessageSlot(sessionId: string) {
    return anonymousSessionsRepository.refundMessageSlot(sessionId);
  }

  async checkRateLimit(sessionId: string): Promise<AnonymousHourlyRateLimitResult> {
    return anonymousSessionsRepository.incrementHourlyCount(sessionId);
  }

  async addTokenUsage(sessionId: string, tokens: number) {
    return anonymousSessionsRepository.addTokenUsage(sessionId, tokens);
  }

  async incrementSignupPrompt(sessionId: string) {
    return anonymousSessionsRepository.incrementSignupPrompt(sessionId);
  }

  async markConverted(sessionId: string) {
    const sessionToken = await anonymousSessionsRepository.markConverted(sessionId);
    if (sessionToken) {
      await invalidateAnonymousChatGateByToken(sessionToken);
    }
  }

  async deactivate(sessionId: string) {
    const sessionToken = await anonymousSessionsRepository.deactivate(sessionId);
    if (sessionToken) {
      await invalidateAnonymousChatGateByToken(sessionToken);
    }
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
