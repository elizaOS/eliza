/**
 * Agent Authentication Utilities
 *
 * @description Provides session management and verification for Polyagent agents.
 * Supports both Redis-backed sessions (production) and in-memory sessions (development).
 * Sessions expire after 24 hours and are automatically cleaned up. Used for authenticating
 * external agents and cron jobs.
 */

import type IORedis from "ioredis";
import { logger } from "../shared/logger";

// Redis client type and availability checker
// These are injected at runtime or fallback to in-memory
let redis: IORedis | null = null;

function isRedisAvailable(): boolean {
  return redis !== null;
}

/**
 * Configure the redis client
 * Called by apps/web to inject the redis instance
 */
export function configureRedis(client: IORedis | null): void {
  redis = client;
}

/**
 * Agent session information
 *
 * @description Contains session data for authenticated agents, including
 * session token, agent ID, and expiration timestamp. Sessions are stored
 * in Redis (production) or in-memory (development).
 */
export interface AgentSession {
  sessionToken: string;
  agentId: string;
  expiresAt: number;
}

// In-memory session storage (in production, use Redis or database)
const agentSessions = new Map<string, AgentSession>();

// Session duration: 24 hours
const SESSION_DURATION = 24 * 60 * 60 * 1000;
const SESSION_PREFIX = "agent:session:";
const useRedis = isRedisAvailable() && redis !== null;
const DEFAULT_TEST_AGENT_ID = "polyagent-agent-alice";
const isProduction = process.env.NODE_ENV === "production";

/**
 * Clean up expired sessions
 *
 * @description Removes expired sessions from in-memory storage. Redis-backed
 * sessions are automatically cleaned up via TTL, so this only affects in-memory
 * sessions. Should be called periodically in long-running processes.
 *
 * @returns {void}
 *
 * @example
 * ```typescript
 * // Call periodically in long-running processes
 * setInterval(cleanupExpiredSessions, 60000); // Every minute
 * ```
 */
export function cleanupExpiredSessions(): void {
  if (useRedis) {
    // Redis handles expiration via TTL, nothing to do here.
    return;
  }

  const now = Date.now();
  const tokensToDelete: string[] = [];

  agentSessions.forEach((session, token) => {
    if (now > session.expiresAt) {
      tokensToDelete.push(token);
    }
  });

  tokensToDelete.forEach((token) => agentSessions.delete(token));
}

/**
 * Verify agent credentials against environment configuration
 *
 * @description Verifies agent credentials by comparing against environment
 * variables (POLYAGENT_AGENT_ID and CRON_SECRET). Used during initial authentication
 * before creating a session.
 *
 * @param {string} agentId - Agent ID to verify
 * @param {string} agentSecret - Agent secret to verify
 * @returns {boolean} True if credentials match environment configuration
 *
 * @example
 * ```typescript
 * if (verifyAgentCredentials(agentId, secret)) {
 *   const session = await createAgentSession(agentId, token);
 * }
 * ```
 */
export function verifyAgentCredentials(
  agentId: string,
  agentSecret: string,
): boolean {
  // Get configured agent credentials from environment
  const configuredAgentId =
    process.env.POLYAGENT_AGENT_ID ??
    (!isProduction ? DEFAULT_TEST_AGENT_ID : undefined);
  const configuredAgentSecret = process.env.CRON_SECRET;

  if (!configuredAgentSecret) {
    logger.error(
      "CRON_SECRET not configured in environment",
      undefined,
      "AgentAuth",
    );
    return false;
  }

  if (!configuredAgentId) {
    logger.error(
      "POLYAGENT_AGENT_ID must be configured in production environments",
      undefined,
      "AgentAuth",
    );
    return false;
  }

  return agentId === configuredAgentId && agentSecret === configuredAgentSecret;
}

/**
 * Create a new agent session
 *
 * @description Creates a new agent session with 24-hour expiration. Stores
 * session in Redis if available, otherwise uses in-memory storage. Returns
 * the created session object.
 *
 * @param {string} agentId - Agent ID for the session
 * @param {string} sessionToken - Unique session token
 * @returns {Promise<AgentSession>} Created session object
 *
 * @example
 * ```typescript
 * const session = await createAgentSession(agentId, generateToken());
 * // Session expires in 24 hours
 * ```
 */
export async function createAgentSession(
  agentId: string,
  sessionToken: string,
): Promise<AgentSession> {
  const expiresAt = Date.now() + SESSION_DURATION;
  const session: AgentSession = {
    sessionToken,
    agentId,
    expiresAt,
  };

  if (useRedis && redis) {
    const key = `${SESSION_PREFIX}${sessionToken}`;
    await redis.set(key, JSON.stringify(session), "PX", SESSION_DURATION);
  } else {
    agentSessions.set(sessionToken, session);
  }

  return session;
}

/**
 * Verify agent session token
 *
 * @description Verifies a session token and returns agent information if valid.
 * Checks expiration and automatically removes expired sessions. Returns null
 * if session is invalid or expired.
 *
 * @param {string} sessionToken - Session token to verify
 * @returns {Promise<{ agentId: string } | null>} Agent information or null if invalid
 *
 * @example
 * ```typescript
 * const agent = await verifyAgentSession(token);
 * if (agent) {
 *   // Session is valid, use agent.agentId
 * }
 * ```
 */
export async function verifyAgentSession(
  sessionToken: string,
): Promise<{ agentId: string } | null> {
  if (useRedis && redis) {
    const key = `${SESSION_PREFIX}${sessionToken}`;
    const stored = await redis.get(key);

    if (stored) {
      const session = JSON.parse(stored) as AgentSession;
      if (Date.now() <= session.expiresAt) {
        return { agentId: session.agentId };
      }
      // Session expired - delete it
      await redis.del(key);
      return null;
    }
  }

  const session = agentSessions.get(sessionToken);

  if (!session) {
    return null;
  }

  if (Date.now() > session.expiresAt) {
    agentSessions.delete(sessionToken);
    return null;
  }

  return { agentId: session.agentId };
}

/**
 * Get session duration in milliseconds
 *
 * @description Returns the configured session duration (24 hours). Useful
 * for displaying session expiration information to agents.
 *
 * @returns {number} Session duration in milliseconds (24 hours)
 *
 * @example
 * ```typescript
 * const duration = getSessionDuration();
 * const hours = duration / (1000 * 60 * 60); // 24
 * ```
 */
export function getSessionDuration(): number {
  return SESSION_DURATION;
}
