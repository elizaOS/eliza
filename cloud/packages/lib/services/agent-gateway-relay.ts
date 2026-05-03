import { randomUUID } from "crypto";
import { buildRedisClient, type CompatibleRedis } from "@/lib/cache/redis-factory";
import type { BridgeRequest, BridgeResponse } from "@/lib/services/eliza-sandbox";
import { logger } from "@/lib/utils/logger";
import { assertPersistentCloudStateConfigured } from "@/lib/utils/persistence-guard";

const ENV_PREFIX = process.env.ENVIRONMENT || "local";
const SESSION_TTL_SECONDS = 90;
const REQUEST_TTL_SECONDS = 120;
const DEFAULT_POLL_TIMEOUT_MS = 25_000;
const DEFAULT_RESPONSE_TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 500;

const SESSION_KEY_PREFIX = `${ENV_PREFIX}:agent:gateway-relay:session:`;
const OWNER_INDEX_KEY_PREFIX = `${ENV_PREFIX}:agent:gateway-relay:owner:`;
const REQUEST_QUEUE_KEY_PREFIX = `${ENV_PREFIX}:agent:gateway-relay:queue:`;
const RESPONSE_KEY_PREFIX = `${ENV_PREFIX}:agent:gateway-relay:response:`;

type SessionPlatform = "local-runtime";

export interface AgentGatewayRelaySession {
  id: string;
  organizationId: string;
  userId: string;
  runtimeAgentId: string;
  agentName: string | null;
  platform: SessionPlatform;
  createdAt: string;
  lastSeenAt: string;
}

export interface AgentGatewayRelayRequestEnvelope {
  requestId: string;
  rpc: BridgeRequest;
  queuedAt: string;
}

interface RelaySessionStore {
  getSession(sessionId: string): Promise<AgentGatewayRelaySession | null>;
  setSession(session: AgentGatewayRelaySession): Promise<void>;
  deleteSession(sessionId: string): Promise<void>;
  addOwnerSession(ownerKey: string, sessionId: string): Promise<void>;
  removeOwnerSession(ownerKey: string, sessionId: string): Promise<void>;
  listOwnerSessionIds(ownerKey: string): Promise<string[]>;
  enqueueRequest(sessionId: string, request: AgentGatewayRelayRequestEnvelope): Promise<void>;
  dequeueRequest(sessionId: string): Promise<AgentGatewayRelayRequestEnvelope | null>;
  setResponse(requestId: string, response: BridgeResponse): Promise<void>;
  getResponse(requestId: string): Promise<BridgeResponse | null>;
  deleteResponse(requestId: string): Promise<void>;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildOwnerKey(organizationId: string, userId: string): string {
  return `${OWNER_INDEX_KEY_PREFIX}${organizationId}:${userId}`;
}

function buildSessionKey(sessionId: string): string {
  return `${SESSION_KEY_PREFIX}${sessionId}`;
}

function buildQueueKey(sessionId: string): string {
  return `${REQUEST_QUEUE_KEY_PREFIX}${sessionId}`;
}

function buildResponseKey(requestId: string): string {
  return `${RESPONSE_KEY_PREFIX}${requestId}`;
}

function isSessionExpired(session: AgentGatewayRelaySession): boolean {
  return Date.now() - new Date(session.lastSeenAt).getTime() > SESSION_TTL_SECONDS * 1000;
}

function parseJson<T>(value: unknown): T | null {
  if (!value) {
    return null;
  }
  try {
    if (typeof value === "string") {
      return JSON.parse(value) as T;
    }
    return value as T;
  } catch {
    return null;
  }
}

let redisClient: CompatibleRedis | null = null;
let redisInitialized = false;

function getRedisClient(): CompatibleRedis | null {
  if (redisInitialized) {
    return redisClient;
  }

  redisClient = buildRedisClient();
  if (redisClient) {
    logger.info?.("[agent-gateway-relay] Redis relay store initialized");
  } else {
    assertPersistentCloudStateConfigured("agent-gateway-relay", false);
    logger.warn?.("[agent-gateway-relay] Redis unavailable, using in-memory relay store");
  }

  redisInitialized = true;
  return redisClient;
}

class InMemoryRelayStore implements RelaySessionStore {
  private sessions = new Map<string, AgentGatewayRelaySession>();
  private ownerIndex = new Map<string, Set<string>>();
  private requestQueues = new Map<string, AgentGatewayRelayRequestEnvelope[]>();
  private responses = new Map<string, BridgeResponse>();

  private pruneExpiredSessions(): void {
    for (const [sessionId, session] of this.sessions.entries()) {
      if (!isSessionExpired(session)) {
        continue;
      }
      this.sessions.delete(sessionId);
      const ownerKey = buildOwnerKey(session.organizationId, session.userId);
      this.ownerIndex.get(ownerKey)?.delete(sessionId);
      this.requestQueues.delete(sessionId);
    }
  }

  async getSession(sessionId: string): Promise<AgentGatewayRelaySession | null> {
    this.pruneExpiredSessions();
    return this.sessions.get(sessionId) ?? null;
  }

  async setSession(session: AgentGatewayRelaySession): Promise<void> {
    this.sessions.set(session.id, session);
  }

  async deleteSession(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    this.sessions.delete(sessionId);
    this.requestQueues.delete(sessionId);
    if (session) {
      this.ownerIndex.get(buildOwnerKey(session.organizationId, session.userId))?.delete(sessionId);
    }
  }

  async addOwnerSession(ownerKey: string, sessionId: string): Promise<void> {
    const set = this.ownerIndex.get(ownerKey) ?? new Set<string>();
    set.add(sessionId);
    this.ownerIndex.set(ownerKey, set);
  }

  async removeOwnerSession(ownerKey: string, sessionId: string): Promise<void> {
    this.ownerIndex.get(ownerKey)?.delete(sessionId);
  }

  async listOwnerSessionIds(ownerKey: string): Promise<string[]> {
    this.pruneExpiredSessions();
    return [...(this.ownerIndex.get(ownerKey) ?? new Set<string>())];
  }

  async enqueueRequest(
    sessionId: string,
    request: AgentGatewayRelayRequestEnvelope,
  ): Promise<void> {
    const queue = this.requestQueues.get(sessionId) ?? [];
    queue.push(request);
    this.requestQueues.set(sessionId, queue);
  }

  async dequeueRequest(sessionId: string): Promise<AgentGatewayRelayRequestEnvelope | null> {
    const queue = this.requestQueues.get(sessionId);
    if (!queue?.length) {
      return null;
    }
    return queue.shift() ?? null;
  }

  async setResponse(requestId: string, response: BridgeResponse): Promise<void> {
    this.responses.set(requestId, response);
  }

  async getResponse(requestId: string): Promise<BridgeResponse | null> {
    return this.responses.get(requestId) ?? null;
  }

  async deleteResponse(requestId: string): Promise<void> {
    this.responses.delete(requestId);
  }
}

class RedisRelayStore implements RelaySessionStore {
  constructor(private readonly redis: CompatibleRedis) {}

  async getSession(sessionId: string): Promise<AgentGatewayRelaySession | null> {
    return parseJson<AgentGatewayRelaySession>(await this.redis.get(buildSessionKey(sessionId)));
  }

  async setSession(session: AgentGatewayRelaySession): Promise<void> {
    await this.redis.setex(
      buildSessionKey(session.id),
      SESSION_TTL_SECONDS,
      JSON.stringify(session),
    );
  }

  async deleteSession(sessionId: string): Promise<void> {
    await this.redis.del(buildSessionKey(sessionId));
    await this.redis.del(buildQueueKey(sessionId));
  }

  async addOwnerSession(ownerKey: string, sessionId: string): Promise<void> {
    await this.redis.sadd(ownerKey, sessionId);
    await this.redis.expire(ownerKey, SESSION_TTL_SECONDS * 2);
  }

  async removeOwnerSession(ownerKey: string, sessionId: string): Promise<void> {
    await this.redis.srem(ownerKey, sessionId);
  }

  async listOwnerSessionIds(ownerKey: string): Promise<string[]> {
    const result = await this.redis.smembers(ownerKey);
    return Array.isArray(result) ? result : [];
  }

  async enqueueRequest(
    sessionId: string,
    request: AgentGatewayRelayRequestEnvelope,
  ): Promise<void> {
    await this.redis.rpush(buildQueueKey(sessionId), JSON.stringify(request));
    await this.redis.expire(buildQueueKey(sessionId), REQUEST_TTL_SECONDS);
  }

  async dequeueRequest(sessionId: string): Promise<AgentGatewayRelayRequestEnvelope | null> {
    return parseJson<AgentGatewayRelayRequestEnvelope>(
      await this.redis.lpop(buildQueueKey(sessionId)),
    );
  }

  async setResponse(requestId: string, response: BridgeResponse): Promise<void> {
    await this.redis.setex(
      buildResponseKey(requestId),
      REQUEST_TTL_SECONDS,
      JSON.stringify(response),
    );
  }

  async getResponse(requestId: string): Promise<BridgeResponse | null> {
    return parseJson<BridgeResponse>(await this.redis.get(buildResponseKey(requestId)));
  }

  async deleteResponse(requestId: string): Promise<void> {
    await this.redis.del(buildResponseKey(requestId));
  }
}

function createStore(): RelaySessionStore {
  const redis = getRedisClient();
  return redis ? new RedisRelayStore(redis) : new InMemoryRelayStore();
}

class AgentGatewayRelayService {
  private store: RelaySessionStore | null;

  constructor(store?: RelaySessionStore) {
    this.store = store ?? null;
  }

  private getStore(): RelaySessionStore {
    if (!this.store) {
      this.store = createStore();
    }

    return this.store;
  }

  resetForTests(store: RelaySessionStore | null = new InMemoryRelayStore()): void {
    this.store = store;
  }

  async registerSession(params: {
    organizationId: string;
    userId: string;
    runtimeAgentId: string;
    agentName?: string | null;
  }): Promise<AgentGatewayRelaySession> {
    const store = this.getStore();
    const now = new Date().toISOString();
    const session: AgentGatewayRelaySession = {
      id: randomUUID(),
      organizationId: params.organizationId,
      userId: params.userId,
      runtimeAgentId: params.runtimeAgentId.trim(),
      agentName: params.agentName?.trim() || null,
      platform: "local-runtime",
      createdAt: now,
      lastSeenAt: now,
    };

    await store.setSession(session);
    await store.addOwnerSession(buildOwnerKey(params.organizationId, params.userId), session.id);

    logger.info?.("[agent-gateway-relay] Registered local runtime session", {
      sessionId: session.id,
      organizationId: params.organizationId,
      userId: params.userId,
      runtimeAgentId: params.runtimeAgentId,
    });

    return session;
  }

  async refreshSession(sessionId: string): Promise<AgentGatewayRelaySession | null> {
    const store = this.getStore();
    const existing = await store.getSession(sessionId);
    if (!existing) {
      return null;
    }

    const refreshed: AgentGatewayRelaySession = {
      ...existing,
      lastSeenAt: new Date().toISOString(),
    };
    await store.setSession(refreshed);
    await store.addOwnerSession(
      buildOwnerKey(refreshed.organizationId, refreshed.userId),
      refreshed.id,
    );
    return refreshed;
  }

  async disconnectSession(sessionId: string): Promise<void> {
    const store = this.getStore();
    const existing = await store.getSession(sessionId);
    await store.deleteSession(sessionId);
    if (existing) {
      await store.removeOwnerSession(
        buildOwnerKey(existing.organizationId, existing.userId),
        sessionId,
      );
    }
  }

  async getSession(sessionId: string): Promise<AgentGatewayRelaySession | null> {
    const store = this.getStore();
    const session = await store.getSession(sessionId);
    if (!session || isSessionExpired(session)) {
      if (session) {
        await this.disconnectSession(session.id);
      }
      return null;
    }
    return session;
  }

  async listOwnerSessions(
    organizationId: string,
    userId: string,
  ): Promise<AgentGatewayRelaySession[]> {
    const store = this.getStore();
    const ownerKey = buildOwnerKey(organizationId, userId);
    const sessionIds = await store.listOwnerSessionIds(ownerKey);
    const sessions: AgentGatewayRelaySession[] = [];

    for (const sessionId of sessionIds) {
      const session = await this.getSession(sessionId);
      if (session) {
        sessions.push(session);
      } else {
        await store.removeOwnerSession(ownerKey, sessionId);
      }
    }

    return sessions.sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt));
  }

  async pollNextRequest(
    sessionId: string,
    timeoutMs = DEFAULT_POLL_TIMEOUT_MS,
  ): Promise<AgentGatewayRelayRequestEnvelope | null> {
    const store = this.getStore();
    const session = await this.refreshSession(sessionId);
    if (!session) {
      return null;
    }

    const deadline = Date.now() + Math.max(0, timeoutMs);
    while (Date.now() <= deadline) {
      const request = await store.dequeueRequest(sessionId);
      if (request) {
        await this.refreshSession(sessionId);
        return request;
      }
      await sleep(POLL_INTERVAL_MS);
    }

    return null;
  }

  async respondToRequest(params: {
    sessionId: string;
    requestId: string;
    response: BridgeResponse;
  }): Promise<boolean> {
    const store = this.getStore();
    const session = await this.refreshSession(params.sessionId);
    if (!session) {
      return false;
    }

    await store.setResponse(params.requestId, params.response);
    return true;
  }

  async routeToSession(
    session: AgentGatewayRelaySession,
    rpc: BridgeRequest,
    timeoutMs = DEFAULT_RESPONSE_TIMEOUT_MS,
  ): Promise<BridgeResponse> {
    const store = this.getStore();
    const activeSession = await this.refreshSession(session.id);
    if (!activeSession) {
      return {
        jsonrpc: "2.0",
        id: rpc.id,
        error: { code: -32000, message: "Local runtime session is offline" },
      };
    }

    const requestId = randomUUID();
    await store.enqueueRequest(session.id, {
      requestId,
      rpc,
      queuedAt: new Date().toISOString(),
    });

    const deadline = Date.now() + Math.max(0, timeoutMs);
    while (Date.now() <= deadline) {
      const response = await store.getResponse(requestId);
      if (response) {
        await store.deleteResponse(requestId);
        return response;
      }

      const latestSession = await this.getSession(session.id);
      if (!latestSession) {
        return {
          jsonrpc: "2.0",
          id: rpc.id,
          error: {
            code: -32000,
            message: "Local runtime session disconnected",
          },
        };
      }

      await sleep(POLL_INTERVAL_MS);
    }

    return {
      jsonrpc: "2.0",
      id: rpc.id,
      error: { code: -32000, message: "Local runtime session timed out" },
    };
  }
}

export const agentGatewayRelayService = new AgentGatewayRelayService();
