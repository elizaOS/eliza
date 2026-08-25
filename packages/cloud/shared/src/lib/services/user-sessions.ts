/**
 * Service for managing user sessions and tracking usage.
 */

import crypto from "crypto";
import {
  type UserSessionCleanupMetrics,
  userSessionsRepository,
} from "../../db/repositories/user-sessions";
import type {
  NewUserSession,
  UserSession,
  UserSessionEndReason,
} from "../../db/schemas/user-sessions";

/**
 * Hash a token for secure storage and lookup.
 * We never store raw JWT tokens in the database for security reasons.
 *
 * @param token - The raw token (e.g., JWT) to hash
 * @returns A 32-character SHA-256 hash
 */
function hashSessionToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex").substring(0, 32);
}

/**
 * Check if a token is already hashed (32 hex characters).
 * This allows the service to accept both raw tokens and pre-hashed tokens.
 */
function isAlreadyHashed(token: string): boolean {
  return /^[a-f0-9]{32}$/.test(token);
}

/**
 * Normalize a token to its hashed form.
 * If the token is already hashed, return as-is.
 * Otherwise, hash it.
 */
function normalizeToken(token: string): string {
  return isAlreadyHashed(token) ? token : hashSessionToken(token);
}

/**
 * Parameters for creating a user session.
 */
export interface CreateSessionParams {
  user_id: string;
  organization_id: string;
  session_token: string;
  token_expires_at: Date;
  ip_address?: string;
  user_agent?: string;
  device_info?: Record<string, unknown>;
}

/**
 * Parameters for tracking session usage.
 */
export interface TrackUsageParams {
  session_token: string;
  credits_used?: number;
  requests_made?: number;
  tokens_consumed?: number;
}

/**
 * Service for user session management and usage tracking.
 *
 * IMPORTANT: All session_token values are stored as SHA-256 hashes.
 * Raw JWT tokens should never be stored in the database.
 * This service automatically hashes incoming tokens before storage/lookup.
 */
class UserSessionsService {
  async getById(id: string): Promise<UserSession | undefined> {
    return await userSessionsRepository.findById(id);
  }

  async getActiveByToken(sessionToken: string): Promise<UserSession | undefined> {
    const hashedToken = normalizeToken(sessionToken);
    return await userSessionsRepository.findActiveByToken(hashedToken);
  }

  async listActiveByUser(userId: string): Promise<UserSession[]> {
    return await userSessionsRepository.listActiveByUser(userId);
  }

  async listByOrganization(organizationId: string, limit?: number): Promise<UserSession[]> {
    return await userSessionsRepository.listByOrganization(organizationId, limit);
  }

  async create(params: CreateSessionParams): Promise<UserSession> {
    if (!Number.isFinite(params.token_expires_at.getTime())) {
      throw new RangeError("user-session telemetry requires a valid token_expires_at");
    }
    const hashedToken = normalizeToken(params.session_token);
    const sessionData: NewUserSession = {
      user_id: params.user_id,
      organization_id: params.organization_id,
      session_token: hashedToken,
      token_expires_at: params.token_expires_at,
      ip_address: params.ip_address,
      user_agent: params.user_agent,
      device_info: params.device_info || {},
      credits_used: "0.00",
      requests_made: 0,
      tokens_consumed: 0,
      started_at: new Date(),
      last_activity_at: new Date(),
    };

    return await userSessionsRepository.create(sessionData);
  }

  async trackUsage(params: TrackUsageParams): Promise<UserSession | undefined> {
    const { session_token, credits_used, requests_made, tokens_consumed } = params;
    const hashedToken = normalizeToken(session_token);

    return await userSessionsRepository.incrementMetrics(hashedToken, {
      credits_used,
      requests_made,
      tokens_consumed,
    });
  }

  async endSession(
    sessionToken: string,
    reason: UserSessionEndReason = "logout",
  ): Promise<UserSession | undefined> {
    const hashedToken = normalizeToken(sessionToken);
    return await userSessionsRepository.endSession(hashedToken, reason);
  }

  async endAllUserSessions(
    userId: string,
    reason: UserSessionEndReason = "logout",
  ): Promise<number> {
    return await userSessionsRepository.endAllUserSessions(userId, reason);
  }

  async getCurrentSessionStats(userId: string): Promise<{
    credits_used: number;
    requests_made: number;
    tokens_consumed: number;
  } | null> {
    return await userSessionsRepository.getCurrentSessionStats(userId);
  }

  async cleanupLifecycle(): Promise<UserSessionCleanupMetrics> {
    return await userSessionsRepository.cleanupLifecycle();
  }

  async cleanupOldSessions(): Promise<number> {
    return await userSessionsRepository.cleanupOldSessions();
  }

  async getOrCreateSession(params: {
    user_id: string;
    organization_id: string;
    session_token: string;
    token_expires_at: Date;
    ip_address?: string;
    user_agent?: string;
    device_info?: Record<string, unknown>;
  }): Promise<UserSession | undefined> {
    if (!Number.isFinite(params.token_expires_at.getTime())) {
      throw new RangeError("user-session telemetry requires a valid token_expires_at");
    }
    // Hash the token for secure storage
    const hashedToken = normalizeToken(params.session_token);

    // Use atomic get-or-create at database level to prevent race conditions
    const sessionData: NewUserSession = {
      user_id: params.user_id,
      organization_id: params.organization_id,
      session_token: hashedToken,
      token_expires_at: params.token_expires_at,
      ip_address: params.ip_address,
      user_agent: params.user_agent,
      device_info: params.device_info || {},
      credits_used: "0.00",
      requests_made: 0,
      tokens_consumed: 0,
      started_at: new Date(),
      last_activity_at: new Date(),
    };

    return await userSessionsRepository.getOrCreate(sessionData);
  }
}

export const userSessionsService = new UserSessionsService();
