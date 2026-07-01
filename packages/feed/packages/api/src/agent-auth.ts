/**
 * Agent Authentication Utilities
 *
 * @description Provides session management and verification for Feed agents.
 * Supports pluggable session stores (Redis, in-memory, etc.).
 * Sessions expire after 24 hours and are automatically cleaned up.
 */

import { logger } from "@feed/shared";
import { ensureRedisReady, getRedisClient } from "./redis/client";

/**
 * Agent session information
 */
export interface AgentSession {
  sessionToken: string;
  agentId: string;
  expiresAt: number;
}

/**
 * Session store interface for pluggable storage backends
 */
export interface SessionStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlMs: number): Promise<void>;
  delete(key: string): Promise<void>;
}

// In-memory session storage (default fallback).
//
// Backed by `globalThis` so the session map is a true singleton across module
// instances. This matters because `@feed/api` is bundled per-route in Next dev
// (transpilePackages) and reloaded on HMR — a plain module-level Map would give
// each route its own copy, so a session minted by /api/agents/auth would be
// invisible to /api/posts. The Redis store (below) is preferred in production
// (multi-replica safe); this is the single-process fallback.
const SESSION_MAP_GLOBAL_KEY = "__feedAgentSessions";
const globalScope = globalThis as typeof globalThis & {
  [SESSION_MAP_GLOBAL_KEY]?: Map<string, AgentSession>;
};
const agentSessions: Map<string, AgentSession> =
  globalScope[SESSION_MAP_GLOBAL_KEY] ??
  (globalScope[SESSION_MAP_GLOBAL_KEY] = new Map<string, AgentSession>());

// Session duration: 24 hours
const SESSION_DURATION = 24 * 60 * 60 * 1000;
const SESSION_PREFIX = "agent:session:";
const DEFAULT_TEST_AGENT_ID = "feed-agent-alice";
const isProduction = process.env.NODE_ENV === "production";

// Configurable session store - defaults to in-memory
let sessionStore: SessionStore | null = null;

/**
 * Configure a custom session store (e.g., Redis)
 */
export function setSessionStore(store: SessionStore | null): void {
  sessionStore = store;
}

/**
 * In-memory session store implementation
 */
const inMemoryStore: SessionStore = {
  async get(key: string): Promise<string | null> {
    const session = agentSessions.get(key.replace(SESSION_PREFIX, ""));
    return session ? JSON.stringify(session) : null;
  },
  async set(key: string, value: string, _ttlMs: number): Promise<void> {
    const session = JSON.parse(value) as AgentSession;
    agentSessions.set(key.replace(SESSION_PREFIX, ""), session);
  },
  async delete(key: string): Promise<void> {
    agentSessions.delete(key.replace(SESSION_PREFIX, ""));
  },
};

/**
 * Redis-backed session store. Preferred in production: agent sessions survive
 * across web replicas (an agent authenticated on one instance is recognized on
 * any other) and across process restarts. Keys carry their own TTL so expired
 * sessions are evicted automatically.
 */
export class RedisSessionStore implements SessionStore {
  async get(key: string): Promise<string | null> {
    const client = getRedisClient();
    if (!client) return null;
    return client.get(key);
  }
  async set(key: string, value: string, ttlMs: number): Promise<void> {
    const client = getRedisClient();
    if (!client) return;
    await client.set(key, value, "EX", Math.max(1, Math.ceil(ttlMs / 1000)));
  }
  async delete(key: string): Promise<void> {
    const client = getRedisClient();
    if (!client) return;
    await client.del(key);
  }
}

/**
 * Wire the agent session store to Redis when Redis is configured, so agent
 * sessions are shared across replicas. Falls back to the globalThis-backed
 * in-memory store when Redis is unavailable. Call once at server startup.
 */
export async function configureAgentSessionStore(): Promise<void> {
  const client = await ensureRedisReady();
  if (client) {
    setSessionStore(new RedisSessionStore());
    logger.info(
      "Agent session store backed by Redis (multi-replica safe)",
      undefined,
      "AgentAuth",
    );
  }
}

/**
 * Get the current session store
 */
function getStore(): SessionStore {
  return sessionStore ?? inMemoryStore;
}

/**
 * Clean up expired sessions (for in-memory store)
 */
export function cleanupExpiredSessions(): void {
  if (sessionStore) {
    // External stores (Redis) handle expiration automatically
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
 * @security Uses separate AGENT_SECRET (not CRON_SECRET) for agent auth.
 * Falls back to CRON_SECRET for backwards compatibility but prefers AGENT_SECRET.
 * In development, also accepts dev agent credentials.
 */
export function verifyAgentCredentials(
  agentId: string,
  agentSecret: string,
): boolean {
  const configuredAgentId =
    process.env.FEED_AGENT_ID ??
    (!isProduction ? DEFAULT_TEST_AGENT_ID : undefined);

  // Use separate AGENT_SECRET, fallback to CRON_SECRET for backwards compatibility
  const configuredAgentSecret =
    process.env.AGENT_SECRET || process.env.CRON_SECRET;

  // In development, also check dev credentials
  if (!isProduction) {
    // Lazy import to avoid circular dependency
    const { isValidAgentSecret, getDevCredentials } =
      require("./dev-credentials") as typeof import("./dev-credentials");

    const devCreds = getDevCredentials();
    if (devCreds) {
      // In dev, accept either the default test agent or the dev credentials
      if (
        (agentId === DEFAULT_TEST_AGENT_ID ||
          agentId === devCreds.adminUserId) &&
        isValidAgentSecret(agentSecret)
      ) {
        return true;
      }
    }
  }

  // Production validation
  if (!configuredAgentSecret) {
    logger.error(
      "AGENT_SECRET (or CRON_SECRET) not configured in environment",
      undefined,
      "AgentAuth",
    );
    return false;
  }

  if (!configuredAgentId) {
    logger.error(
      "FEED_AGENT_ID must be configured in production environments",
      undefined,
      "AgentAuth",
    );
    return false;
  }

  return agentId === configuredAgentId && agentSecret === configuredAgentSecret;
}

/**
 * Create a new agent session
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

  const store = getStore();
  const key = `${SESSION_PREFIX}${sessionToken}`;
  await store.set(key, JSON.stringify(session), SESSION_DURATION);

  return session;
}

/**
 * Verify agent session token
 */
export async function verifyAgentSession(
  sessionToken: string,
): Promise<{ agentId: string } | null> {
  const store = getStore();
  const key = `${SESSION_PREFIX}${sessionToken}`;

  const stored = await store.get(key);
  if (stored) {
    const session = JSON.parse(stored) as AgentSession;
    if (Date.now() <= session.expiresAt) {
      return { agentId: session.agentId };
    }
    // Session expired - delete it
    await store.delete(key);
    return null;
  }

  return null;
}

/**
 * Get session duration in milliseconds
 */
export function getSessionDuration(): number {
  return SESSION_DURATION;
}
