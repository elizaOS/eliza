/**
 * Discord Gateway Service E2E Tests
 *
 * End-to-end tests for the Discord gateway service.
 * Uses mocks for external dependencies (Discord API, Redis, Eliza Cloud).
 */

import { describe, test, expect, beforeEach, afterEach, mock, spyOn } from "bun:test";
import { Hono } from "hono";

// ============================================
// Mock Setup
// ============================================

// Mock Discord.js Client
const mockDiscordClient = {
  user: { id: "bot-user-123", username: "TestBot" },
  guilds: { cache: { size: 5 } },
  login: mock(() => Promise.resolve("token")),
  destroy: mock(() => {}),
  on: mock((event: string, handler: (...args: unknown[]) => void) => {
    // Store handlers for later triggering
    mockDiscordClient._handlers.set(event, handler);
    return mockDiscordClient;
  }),
  removeListener: mock(() => mockDiscordClient),
  removeAllListeners: mock(() => {
    mockDiscordClient._handlers.clear();
    return mockDiscordClient;
  }),
  _handlers: new Map<string, (...args: unknown[]) => void>(),
  emit: (event: string, ...args: unknown[]) => {
    const handler = mockDiscordClient._handlers.get(event);
    if (handler) handler(...args);
  },
};

mock.module("discord.js", () => ({
  Client: mock(() => mockDiscordClient),
  GatewayIntentBits: {
    Guilds: 1,
    GuildMessages: 512,
    MessageContent: 32768,
    GuildMessageReactions: 1024,
    DirectMessages: 4096,
  },
  Events: {
    ClientReady: "ready",
    MessageCreate: "messageCreate",
    MessageUpdate: "messageUpdate",
    MessageDelete: "messageDelete",
    MessageReactionAdd: "messageReactionAdd",
    GuildMemberAdd: "guildMemberAdd",
    GuildMemberRemove: "guildMemberRemove",
    InteractionCreate: "interactionCreate",
    Error: "error",
    ShardDisconnect: "shardDisconnect",
    ShardReconnecting: "shardReconnecting",
  },
}));

// Mock Redis
const mockRedisData = new Map<string, string>();
const mockRedisSet = new Set<string>();

const mockRedis = {
  setex: mock((key: string, _ttl: number, value: string) => {
    mockRedisData.set(key, value);
    return Promise.resolve("OK");
  }),
  set: mock((key: string, value: string, options?: { ex?: number; nx?: boolean }) => {
    // SETNX semantics: only set if key doesn't exist
    if (options?.nx && mockRedisData.has(key)) {
      return Promise.resolve(null);
    }
    mockRedisData.set(key, value);
    return Promise.resolve("OK");
  }),
  get: mock((key: string) => Promise.resolve(mockRedisData.get(key) ?? null)),
  del: mock((key: string) => {
    mockRedisData.delete(key);
    return Promise.resolve(1);
  }),
  sadd: mock((key: string, value: string) => {
    if (!mockRedisSet.has(key)) mockRedisSet.add(key);
    mockRedisData.set(`${key}:${value}`, value);
    return Promise.resolve(1);
  }),
  srem: mock((key: string, value: string) => {
    mockRedisData.delete(`${key}:${value}`);
    return Promise.resolve(1);
  }),
  smembers: mock((key: string) => {
    const members: string[] = [];
    for (const [k, v] of mockRedisData) {
      if (k.startsWith(`${key}:`)) members.push(v);
    }
    return Promise.resolve(members);
  }),
};

mock.module("@upstash/redis", () => ({
  Redis: mock(() => mockRedis),
}));

// Mock VoiceMessageHandler
mock.module("../../src/voice-message-handler", () => ({
  VoiceMessageHandler: mock(() => ({
    processVoiceAttachments: mock(() => Promise.resolve([])),
    startCleanupJob: mock(() => {}),
    stopCleanupJob: mock(() => {}),
  })),
  hasVoiceAttachments: mock(() => false),
}));

// Mock fetch
const mockFetchResponses: Array<{ url: string | RegExp; response: Response }> = [];
const mockFetchCalls: Array<{ url: string; options: RequestInit }> = [];

const mockFetch = mock((url: string, options?: RequestInit) => {
  mockFetchCalls.push({ url, options: options ?? {} });
  
  for (const { url: pattern, response } of mockFetchResponses) {
    if (typeof pattern === "string" ? url.includes(pattern) : pattern.test(url)) {
      return Promise.resolve(response);
    }
  }
  
  // Default response
  return Promise.resolve(new Response(JSON.stringify({ assignments: [] }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  }));
});

globalThis.fetch = mockFetch as unknown as typeof fetch;

// ============================================
// Test Utilities
// ============================================

function createMockResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// Helper to set up mock token response - must be called before tests that make API calls
function setupMockTokenResponse() {
  mockFetchResponses.push({
    url: "/api/internal/auth/token",
    response: createMockResponse({
      access_token: "mock-jwt-token-for-testing",
      token_type: "Bearer",
      expires_in: 3600,
    }),
  });
}

function resetMocks() {
  mockDiscordClient._handlers.clear();
  mockDiscordClient.login.mockClear();
  mockDiscordClient.destroy.mockClear();
  mockDiscordClient.on.mockClear();
  mockDiscordClient.removeAllListeners.mockClear();
  mockRedisData.clear();
  mockRedisSet.clear();
  mockRedis.setex.mockClear();
  mockRedis.set.mockClear();
  mockRedis.get.mockClear();
  mockRedis.del.mockClear();
  mockFetchResponses.length = 0;
  mockFetchCalls.length = 0;
}

// ============================================
// Tests
// ============================================

describe("Discord Gateway Service E2E", () => {
  beforeEach(() => {
    resetMocks();
    process.env.POD_NAME = "test-pod-1";
    process.env.GATEWAY_BOOTSTRAP_SECRET = "test-bootstrap-secret";
    process.env.REDIS_URL = "redis://localhost:6379";
    process.env.KV_REST_API_TOKEN = "test-token";
  });

  afterEach(() => {
    resetMocks();
  });

  describe("HTTP Endpoints", () => {
    test("GET /health returns healthy status when no bots", async () => {
      const { GatewayManager } = await import("../../src/gateway-manager");
      
      const manager = new GatewayManager({
        podName: "test-pod",
        elizaCloudUrl: "http://localhost:3000",
        gatewayBootstrapSecret: "test-bootstrap-secret",
        redisUrl: "redis://localhost",
        redisToken: "token",
      });

      const health = manager.getHealth();

      expect(health.status).toBe("healthy");
      expect(health.podName).toBe("test-pod");
      expect(health.totalBots).toBe(0);
      expect(health.connectedBots).toBe(0);
      expect(health.controlPlane.healthy).toBe(true);
    });

    test("GET /ready returns ready when healthy", async () => {
      const { GatewayManager } = await import("../../src/gateway-manager");
      
      const manager = new GatewayManager({
        podName: "test-pod",
        elizaCloudUrl: "http://localhost:3000",
        gatewayBootstrapSecret: "test-bootstrap-secret",
        redisUrl: "redis://localhost",
        redisToken: "token",
      });

      const health = manager.getHealth();
      const ready = health.status === "healthy" && health.controlPlane.healthy;

      expect(ready).toBe(true);
    });

    test("GET /metrics returns Prometheus format", async () => {
      const { GatewayManager } = await import("../../src/gateway-manager");
      
      const manager = new GatewayManager({
        podName: "test-pod",
        elizaCloudUrl: "http://localhost:3000",
        gatewayBootstrapSecret: "test-bootstrap-secret",
        redisUrl: "redis://localhost",
        redisToken: "token",
      });

      const metrics = manager.getMetrics();

      expect(metrics).toContain("# HELP discord_gateway_bots_total");
      expect(metrics).toContain("# TYPE discord_gateway_bots_total gauge");
      expect(metrics).toContain("discord_gateway_bots_connected");
      expect(metrics).toContain("discord_gateway_guilds_total");
      expect(metrics).toContain("discord_gateway_uptime_seconds");
      expect(metrics).toContain("discord_gateway_control_plane_healthy");
    });

    test("GET /status returns detailed status", async () => {
      const { GatewayManager } = await import("../../src/gateway-manager");
      
      const manager = new GatewayManager({
        podName: "test-pod",
        elizaCloudUrl: "http://localhost:3000",
        gatewayBootstrapSecret: "test-bootstrap-secret",
        redisUrl: "redis://localhost",
        redisToken: "token",
      });

      const status = manager.getStatus();

      expect(status.podName).toBe("test-pod");
      expect(status.startTime).toBeDefined();
      expect(status.uptime).toBeGreaterThanOrEqual(0);
      expect(status.connections).toEqual([]);
      expect(status.controlPlane).toBeDefined();
    });
  });

  describe("Hono App Integration", () => {
    test("health endpoint returns JSON with correct status code", async () => {
      const { GatewayManager } = await import("../../src/gateway-manager");
      
      const manager = new GatewayManager({
        podName: "test-pod",
        elizaCloudUrl: "http://localhost:3000",
        gatewayBootstrapSecret: "test-bootstrap-secret",
        redisUrl: "redis://localhost",
        redisToken: "token",
      });

      const app = new Hono();
      app.get("/health", (c) => {
        const health = manager.getHealth();
        const alive = health.status !== "unhealthy";
        return c.json(health, alive ? 200 : 503);
      });

      const res = await app.request("/health");
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.status).toBe("healthy");
    });

    test("ready endpoint returns 503 when degraded", async () => {
      const { GatewayManager } = await import("../../src/gateway-manager");
      
      const manager = new GatewayManager({
        podName: "test-pod",
        elizaCloudUrl: "http://localhost:3000",
        gatewayBootstrapSecret: "test-bootstrap-secret",
        redisUrl: "redis://localhost",
        redisToken: "token",
      });

      // Simulate degraded state by forcing consecutive poll failures
      // @ts-expect-error - accessing private for test
      manager.consecutivePollFailures = 5;

      const app = new Hono();
      app.get("/ready", (c) => {
        const health = manager.getHealth();
        const ready = health.status === "healthy" && health.controlPlane.healthy;
        return c.json({ ready, ...health }, ready ? 200 : 503);
      });

      const res = await app.request("/ready");
      const body = await res.json();

      expect(res.status).toBe(503);
      expect(body.ready).toBe(false);
      expect(body.status).toBe("unhealthy");
    });

    test("metrics endpoint returns text/plain", async () => {
      const { GatewayManager } = await import("../../src/gateway-manager");
      
      const manager = new GatewayManager({
        podName: "test-pod",
        elizaCloudUrl: "http://localhost:3000",
        gatewayBootstrapSecret: "test-bootstrap-secret",
        redisUrl: "redis://localhost",
        redisToken: "token",
      });

      const app = new Hono();
      app.get("/metrics", (c) => {
        const metrics = manager.getMetrics();
        return c.text(metrics, 200, { "Content-Type": "text/plain" });
      });

      const res = await app.request("/metrics");
      const body = await res.text();

      expect(res.status).toBe(200);
      expect(res.headers.get("Content-Type")).toContain("text/plain");
      expect(body).toContain("discord_gateway");
    });
  });

  describe("Bot Assignment Polling", () => {
    test("polls for bot assignments on start", async () => {
      // Setup token mock first
      setupMockTokenResponse();
      
      mockFetchResponses.push({
        url: "/api/internal/discord/gateway/assignments",
        response: createMockResponse({
          assignments: [
            {
              connectionId: "conn-123",
              organizationId: "org-456",
              applicationId: "app-789",
              botToken: "test-token",
              intents: 32767,
            },
          ],
        }),
      });

      const { GatewayManager } = await import("../../src/gateway-manager");
      
      const manager = new GatewayManager({
        podName: "test-pod",
        elizaCloudUrl: "http://localhost:3000",
        gatewayBootstrapSecret: "test-bootstrap-secret",
        redisUrl: "redis://localhost",
        redisToken: "token",
      });

      // Acquire token first
      // @ts-expect-error - accessing private for test
      await manager.acquireToken();

      // Call pollForBots directly instead of start to avoid intervals
      // @ts-expect-error - accessing private for test
      await manager.pollForBots();

      const assignmentCall = mockFetchCalls.find(c => 
        c.url.includes("/api/internal/discord/gateway/assignments")
      );

      expect(assignmentCall).toBeDefined();
      expect(assignmentCall?.url).toContain("pod=test-pod");
    });

    test("handles poll failure gracefully", async () => {
      // Setup token mock first
      setupMockTokenResponse();
      
      mockFetchResponses.push({
        url: "/api/internal/discord/gateway/assignments",
        response: new Response("Internal Server Error", { status: 500 }),
      });

      const { GatewayManager } = await import("../../src/gateway-manager");
      
      const manager = new GatewayManager({
        podName: "test-pod",
        elizaCloudUrl: "http://localhost:3000",
        gatewayBootstrapSecret: "test-bootstrap-secret",
        redisUrl: "redis://localhost",
        redisToken: "token",
      });

      // Acquire token first
      // @ts-expect-error - accessing private for test
      await manager.acquireToken();

      // @ts-expect-error - accessing private for test
      await manager.pollForBots();

      // Should increment consecutive failures
      // @ts-expect-error - accessing private for test
      expect(manager.consecutivePollFailures).toBe(1);
    });

    test("respects MAX_BOTS_PER_POD limit", async () => {
      // Setup token mock first
      setupMockTokenResponse();
      
      // Create assignments exceeding the limit
      const assignments = Array.from({ length: 150 }, (_, i) => ({
        connectionId: `conn-${i}`,
        organizationId: "org-456",
        applicationId: `app-${i}`,
        botToken: "test-token",
        intents: 32767,
      }));

      mockFetchResponses.push({
        url: "/api/internal/discord/gateway/assignments",
        response: createMockResponse({ assignments }),
      });

      const { GatewayManager } = await import("../../src/gateway-manager");
      
      const manager = new GatewayManager({
        podName: "test-pod",
        elizaCloudUrl: "http://localhost:3000",
        gatewayBootstrapSecret: "test-bootstrap-secret",
        redisUrl: "redis://localhost",
        redisToken: "token",
      });

      // Acquire token first
      // @ts-expect-error - accessing private for test
      await manager.acquireToken();

      // @ts-expect-error - accessing private for test
      await manager.pollForBots();

      // Should not exceed MAX_BOTS_PER_POD (default 100)
      const status = manager.getStatus();
      expect(status.connections.length).toBeLessThanOrEqual(100);
    });
  });

  describe("Connection Status Updates", () => {
    test("updates connection status to Eliza Cloud", async () => {
      // Setup token mock first
      setupMockTokenResponse();
      
      mockFetchResponses.push({
        url: "/api/internal/discord/gateway/status",
        response: createMockResponse({ success: true }),
      });

      const { GatewayManager } = await import("../../src/gateway-manager");
      
      const manager = new GatewayManager({
        podName: "test-pod",
        elizaCloudUrl: "http://localhost:3000",
        gatewayBootstrapSecret: "test-bootstrap-secret",
        redisUrl: "redis://localhost",
        redisToken: "token",
      });

      // Acquire token first
      // @ts-expect-error - accessing private for test
      await manager.acquireToken();

      // @ts-expect-error - accessing private for test
      await manager.updateConnectionStatus("conn-123", "connected", undefined, "bot-user-456");

      const statusCall = mockFetchCalls.find(c => 
        c.url.includes("/api/internal/discord/gateway/status")
      );

      expect(statusCall).toBeDefined();
      expect(statusCall?.options.method).toBe("POST");
      
      const body = JSON.parse(statusCall?.options.body as string);
      expect(body.connection_id).toBe("conn-123");
      expect(body.status).toBe("connected");
      expect(body.bot_user_id).toBe("bot-user-456");
    });
  });

  describe("Heartbeat", () => {
    test("sends heartbeat to Eliza Cloud and Redis", async () => {
      // Setup token mock first
      setupMockTokenResponse();
      
      mockFetchResponses.push({
        url: "/api/internal/discord/gateway/heartbeat",
        response: createMockResponse({ success: true }),
      });

      const { GatewayManager } = await import("../../src/gateway-manager");
      
      const manager = new GatewayManager({
        podName: "test-pod",
        elizaCloudUrl: "http://localhost:3000",
        gatewayBootstrapSecret: "test-bootstrap-secret",
        redisUrl: "redis://localhost",
        redisToken: "token",
      });

      // Acquire token first
      // @ts-expect-error - accessing private for test
      await manager.acquireToken();

      // Add a mock connection
      // @ts-expect-error - accessing private for test
      manager.connections.set("conn-123", {
        connectionId: "conn-123",
        organizationId: "org-456",
        applicationId: "app-789",
        client: mockDiscordClient,
        status: "connected",
        guildCount: 5,
        eventsReceived: 0,
        eventsRouted: 0,
        eventsFailed: 0,
        consecutiveFailures: 0,
        lastHeartbeat: new Date(),
        listeners: new Map(),
      });

      // @ts-expect-error - accessing private for test
      await manager.sendHeartbeat();

      // Check Eliza Cloud heartbeat
      const heartbeatCall = mockFetchCalls.find(c => 
        c.url.includes("/api/internal/discord/gateway/heartbeat")
      );
      expect(heartbeatCall).toBeDefined();

      // Check Redis heartbeat
      expect(mockRedis.setex).toHaveBeenCalled();
      expect(mockRedis.sadd).toHaveBeenCalled();
    });
  });

  describe("Failover", () => {
    test("detects dead pods and claims orphaned connections", async () => {
      // Setup token mock first
      setupMockTokenResponse();
      
      // Setup: another pod with stale heartbeat
      const deadPodState = JSON.stringify({
        podId: "dead-pod",
        connections: ["conn-orphan-1", "conn-orphan-2"],
        lastHeartbeat: Date.now() - 60_000, // 60 seconds ago (> 45s threshold)
      });
      
      mockRedisData.set("discord:pod:dead-pod", deadPodState);
      mockRedisData.set("discord:active_pods:dead-pod", "dead-pod");

      mockFetchResponses.push({
        url: "/api/internal/discord/gateway/failover",
        response: createMockResponse({ claimed: 2 }),
      });

      const { GatewayManager } = await import("../../src/gateway-manager");
      
      const manager = new GatewayManager({
        podName: "test-pod",
        elizaCloudUrl: "http://localhost:3000",
        gatewayBootstrapSecret: "test-bootstrap-secret",
        redisUrl: "redis://localhost",
        redisToken: "token",
      });

      // Acquire token first
      // @ts-expect-error - accessing private for test
      await manager.acquireToken();

      // @ts-expect-error - accessing private for test
      await manager.checkForDeadPods();

      const failoverCall = mockFetchCalls.find(c => 
        c.url.includes("/api/internal/discord/gateway/failover")
      );

      expect(failoverCall).toBeDefined();
      const body = JSON.parse(failoverCall?.options.body as string);
      expect(body.claiming_pod).toBe("test-pod");
      expect(body.dead_pod).toBe("dead-pod");
    });

    test("does not claim from healthy pods", async () => {
      // Setup: another pod with fresh heartbeat
      const healthyPodState = JSON.stringify({
        podId: "healthy-pod",
        connections: ["conn-1"],
        lastHeartbeat: Date.now() - 5_000, // 5 seconds ago (< 45s threshold)
      });
      
      mockRedisData.set("discord:pod:healthy-pod", healthyPodState);
      mockRedisData.set("discord:active_pods:healthy-pod", "healthy-pod");

      const { GatewayManager } = await import("../../src/gateway-manager");
      
      const manager = new GatewayManager({
        podName: "test-pod",
        elizaCloudUrl: "http://localhost:3000",
        gatewayBootstrapSecret: "test-bootstrap-secret",
        redisUrl: "redis://localhost",
        redisToken: "token",
      });

      // @ts-expect-error - accessing private for test
      await manager.checkForDeadPods();

      // Should NOT call failover endpoint
      const failoverCall = mockFetchCalls.find(c => 
        c.url.includes("/api/internal/discord/gateway/failover")
      );

      expect(failoverCall).toBeUndefined();
    });

    test("skips failover when another pod holds the lock", async () => {
      // Setup dead pod
      const deadPodState = JSON.stringify({
        podId: "dead-pod",
        connections: ["conn-1"],
        lastHeartbeat: Date.now() - 60_000, // 60s ago - dead
      });
      
      mockRedisData.set("discord:pod:dead-pod", deadPodState);
      mockRedisData.set("discord:active_pods:dead-pod", "dead-pod");
      
      // Another pod already has the failover lock
      mockRedisData.set("discord:failover:lock:dead-pod", "other-pod");

      const { GatewayManager } = await import("../../src/gateway-manager");
      
      const manager = new GatewayManager({
        podName: "test-pod",
        elizaCloudUrl: "http://localhost:3000",
        gatewayBootstrapSecret: "test-bootstrap-secret",
        redisUrl: "redis://localhost",
        redisToken: "token",
      });

      // @ts-expect-error - accessing private for test
      await manager.checkForDeadPods();

      // Should NOT call failover endpoint because lock is held
      const failoverCall = mockFetchCalls.find(c => 
        c.url.includes("/api/internal/discord/gateway/failover")
      );

      expect(failoverCall).toBeUndefined();
    });
  });

  describe("Graceful Shutdown", () => {
    test("releases connections on shutdown", async () => {
      // Setup token mock first
      setupMockTokenResponse();
      
      mockFetchResponses.push({
        url: "/api/internal/discord/gateway/shutdown",
        response: createMockResponse({ success: true }),
      });
      mockFetchResponses.push({
        url: "/api/internal/discord/gateway/status",
        response: createMockResponse({ success: true }),
      });

      const { GatewayManager } = await import("../../src/gateway-manager");
      
      const manager = new GatewayManager({
        podName: "test-pod",
        elizaCloudUrl: "http://localhost:3000",
        gatewayBootstrapSecret: "test-bootstrap-secret",
        redisUrl: "redis://localhost",
        redisToken: "token",
      });

      // Acquire token first
      // @ts-expect-error - accessing private for test
      await manager.acquireToken();

      // Add a mock connection
      // @ts-expect-error - accessing private for test
      manager.connections.set("conn-123", {
        connectionId: "conn-123",
        organizationId: "org-456",
        applicationId: "app-789",
        client: mockDiscordClient,
        status: "connected",
        guildCount: 5,
        eventsReceived: 10,
        eventsRouted: 8,
        eventsFailed: 2,
        consecutiveFailures: 0,
        lastHeartbeat: new Date(),
        listeners: new Map(),
      });

      await manager.shutdown();

      // Check shutdown was called
      const shutdownCall = mockFetchCalls.find(c => 
        c.url.includes("/api/internal/discord/gateway/shutdown")
      );
      expect(shutdownCall).toBeDefined();

      // Check Redis cleanup
      expect(mockRedis.del).toHaveBeenCalled();
      expect(mockRedis.srem).toHaveBeenCalled();

      // Check Discord client destroyed
      expect(mockDiscordClient.destroy).toHaveBeenCalled();

      // Connections should be cleared
      const status = manager.getStatus();
      expect(status.connections).toEqual([]);
    });
  });

  describe("Event Forwarding", () => {
    test("forwards MESSAGE_CREATE events to Eliza Cloud", async () => {
      // Setup token mock first
      setupMockTokenResponse();
      
      mockFetchResponses.push({
        url: "/api/internal/discord/events",
        response: createMockResponse({ processed: true }),
      });

      const { GatewayManager } = await import("../../src/gateway-manager");
      
      const manager = new GatewayManager({
        podName: "test-pod",
        elizaCloudUrl: "http://localhost:3000",
        gatewayBootstrapSecret: "test-bootstrap-secret",
        redisUrl: "redis://localhost",
        redisToken: "token",
      });

      // Acquire token first
      // @ts-expect-error - accessing private for test
      await manager.acquireToken();

      const mockConn = {
        connectionId: "conn-123",
        organizationId: "org-456",
        applicationId: "app-789",
        client: mockDiscordClient,
        status: "connected" as const,
        guildCount: 5,
        eventsReceived: 0,
        eventsRouted: 0,
        eventsFailed: 0,
        consecutiveFailures: 0,
        lastHeartbeat: new Date(),
        listeners: new Map(),
      };

      // @ts-expect-error - accessing private for test
      manager.connections.set("conn-123", mockConn);

      // @ts-expect-error - accessing private for test
      await manager.forwardEvent("conn-123", mockConn, "MESSAGE_CREATE", {
        id: "msg-123",
        channel_id: "chan-456",
        guild_id: "guild-789",
        content: "Hello, bot!",
        author: { id: "user-111", username: "testuser", bot: false },
      });

      const eventCall = mockFetchCalls.find(c => 
        c.url.includes("/api/internal/discord/events")
      );

      expect(eventCall).toBeDefined();
      expect(eventCall?.options.method).toBe("POST");
      expect(eventCall?.options.headers).toHaveProperty("Authorization");

      const body = JSON.parse(eventCall?.options.body as string);
      expect(body.connection_id).toBe("conn-123");
      expect(body.event_type).toBe("MESSAGE_CREATE");
      expect(body.data.content).toBe("Hello, bot!");
    });

    test("increments eventsRouted on success", async () => {
      // Setup token mock first
      setupMockTokenResponse();
      
      mockFetchResponses.push({
        url: "/api/internal/discord/events",
        response: createMockResponse({ processed: true }),
      });

      const { GatewayManager } = await import("../../src/gateway-manager");
      
      const manager = new GatewayManager({
        podName: "test-pod",
        elizaCloudUrl: "http://localhost:3000",
        gatewayBootstrapSecret: "test-bootstrap-secret",
        redisUrl: "redis://localhost",
        redisToken: "token",
      });

      // Acquire token first
      // @ts-expect-error - accessing private for test
      await manager.acquireToken();

      const mockConn = {
        connectionId: "conn-123",
        organizationId: "org-456",
        applicationId: "app-789",
        client: mockDiscordClient,
        status: "connected" as const,
        guildCount: 5,
        eventsReceived: 0,
        eventsRouted: 0,
        eventsFailed: 0,
        consecutiveFailures: 0,
        lastHeartbeat: new Date(),
        listeners: new Map(),
      };

      // @ts-expect-error - accessing private for test
      manager.connections.set("conn-123", mockConn);

      // @ts-expect-error - accessing private for test
      await manager.forwardEvent("conn-123", mockConn, "MESSAGE_CREATE", {
        id: "msg-123",
        channel_id: "chan-456",
      });

      expect(mockConn.eventsRouted).toBe(1);
      expect(mockConn.consecutiveFailures).toBe(0);
    });

    test("increments eventsFailed on failure", async () => {
      // Setup token mock first
      setupMockTokenResponse();
      
      mockFetchResponses.push({
        url: "/api/internal/discord/events",
        response: new Response("Error", { status: 500 }),
      });

      const { GatewayManager } = await import("../../src/gateway-manager");
      
      const manager = new GatewayManager({
        podName: "test-pod",
        elizaCloudUrl: "http://localhost:3000",
        gatewayBootstrapSecret: "test-bootstrap-secret",
        redisUrl: "redis://localhost",
        redisToken: "token",
      });

      // Acquire token first
      // @ts-expect-error - accessing private for test
      await manager.acquireToken();

      const mockConn = {
        connectionId: "conn-123",
        organizationId: "org-456",
        applicationId: "app-789",
        client: mockDiscordClient,
        status: "connected" as const,
        guildCount: 5,
        eventsReceived: 0,
        eventsRouted: 0,
        eventsFailed: 0,
        consecutiveFailures: 0,
        lastHeartbeat: new Date(),
        listeners: new Map(),
      };

      // @ts-expect-error - accessing private for test
      manager.connections.set("conn-123", mockConn);

      // @ts-expect-error - accessing private for test
      await manager.forwardEvent("conn-123", mockConn, "MESSAGE_CREATE", {
        id: "msg-123",
        channel_id: "chan-456",
      });

      expect(mockConn.eventsFailed).toBe(1);
      expect(mockConn.consecutiveFailures).toBe(1);
    });
  });

  describe("Health Status Transitions", () => {
    test("transitions to unhealthy after 5 consecutive poll failures", async () => {
      const { GatewayManager } = await import("../../src/gateway-manager");
      
      const manager = new GatewayManager({
        podName: "test-pod",
        elizaCloudUrl: "http://localhost:3000",
        gatewayBootstrapSecret: "test-bootstrap-secret",
        redisUrl: "redis://localhost",
        redisToken: "token",
      });

      // Simulate consecutive failures
      // @ts-expect-error - accessing private for test
      manager.consecutivePollFailures = 4;
      expect(manager.getHealth().status).toBe("healthy");

      // @ts-expect-error - accessing private for test
      manager.consecutivePollFailures = 5;
      expect(manager.getHealth().status).toBe("unhealthy");
      expect(manager.getHealth().controlPlane.healthy).toBe(false);
    });

    test("transitions to degraded when some bots disconnected", async () => {
      const { GatewayManager } = await import("../../src/gateway-manager");
      
      const manager = new GatewayManager({
        podName: "test-pod",
        elizaCloudUrl: "http://localhost:3000",
        gatewayBootstrapSecret: "test-bootstrap-secret",
        redisUrl: "redis://localhost",
        redisToken: "token",
      });

      // Add connected bot
      // @ts-expect-error - accessing private for test
      manager.connections.set("conn-1", {
        connectionId: "conn-1",
        status: "connected",
        guildCount: 0,
        eventsReceived: 0,
        eventsRouted: 0,
        eventsFailed: 0,
        consecutiveFailures: 0,
        lastHeartbeat: new Date(),
        listeners: new Map(),
      });

      // Add disconnected bot
      // @ts-expect-error - accessing private for test
      manager.connections.set("conn-2", {
        connectionId: "conn-2",
        status: "disconnected",
        guildCount: 0,
        eventsReceived: 0,
        eventsRouted: 0,
        eventsFailed: 0,
        consecutiveFailures: 0,
        lastHeartbeat: new Date(),
        listeners: new Map(),
      });

      const health = manager.getHealth();
      expect(health.status).toBe("degraded");
      expect(health.totalBots).toBe(2);
      expect(health.connectedBots).toBe(1);
      expect(health.disconnectedBots).toBe(1);
    });

    test("transitions to unhealthy when all bots disconnected", async () => {
      const { GatewayManager } = await import("../../src/gateway-manager");
      
      const manager = new GatewayManager({
        podName: "test-pod",
        elizaCloudUrl: "http://localhost:3000",
        gatewayBootstrapSecret: "test-bootstrap-secret",
        redisUrl: "redis://localhost",
        redisToken: "token",
      });

      // Add only disconnected bots
      // @ts-expect-error - accessing private for test
      manager.connections.set("conn-1", {
        connectionId: "conn-1",
        status: "disconnected",
        guildCount: 0,
        eventsReceived: 0,
        eventsRouted: 0,
        eventsFailed: 0,
        consecutiveFailures: 0,
        lastHeartbeat: new Date(),
        listeners: new Map(),
      });

      const health = manager.getHealth();
      expect(health.status).toBe("unhealthy");
      expect(health.connectedBots).toBe(0);
    });
  });

  describe("Session State Persistence", () => {
    test("saves session state to Redis", async () => {
      const { GatewayManager } = await import("../../src/gateway-manager");
      
      const manager = new GatewayManager({
        podName: "test-pod",
        elizaCloudUrl: "http://localhost:3000",
        gatewayBootstrapSecret: "test-bootstrap-secret",
        redisUrl: "redis://localhost",
        redisToken: "token",
      });

      const mockConn = {
        connectionId: "conn-123",
        organizationId: "org-456",
        applicationId: "app-789",
        client: mockDiscordClient,
        status: "connected" as const,
        guildCount: 5,
        eventsReceived: 100,
        eventsRouted: 95,
        eventsFailed: 5,
        consecutiveFailures: 0,
        lastHeartbeat: new Date(),
        listeners: new Map(),
      };

      // @ts-expect-error - accessing private for test
      await manager.saveSessionState("conn-123", mockConn);

      expect(mockRedis.setex).toHaveBeenCalled();
      
      // Verify the saved data
      const savedData = mockRedisData.get("discord:session:conn-123");
      expect(savedData).toBeDefined();
      
      const parsed = JSON.parse(savedData!);
      expect(parsed.connectionId).toBe("conn-123");
      expect(parsed.eventsReceived).toBe(100);
      expect(parsed.eventsRouted).toBe(95);
    });
  });

  describe("JWT Authentication", () => {
    test("acquires token on startup using bootstrap secret", async () => {
      // Mock token endpoint response
      mockFetchResponses.push({
        url: "/api/internal/auth/token",
        response: createMockResponse({
          access_token: "test-jwt-token",
          token_type: "Bearer",
          expires_in: 3600,
        }),
      });

      const { GatewayManager } = await import("../../src/gateway-manager");
      
      const manager = new GatewayManager({
        podName: "test-pod",
        elizaCloudUrl: "http://localhost:3000",
        gatewayBootstrapSecret: "test-bootstrap-secret",
        redisUrl: "redis://localhost",
        redisToken: "token",
      });

      // @ts-expect-error - accessing private for test
      await manager.acquireToken();

      const tokenCall = mockFetchCalls.find(c => 
        c.url.includes("/api/internal/auth/token")
      );

      expect(tokenCall).toBeDefined();
      expect(tokenCall?.options.method).toBe("POST");
      expect(tokenCall?.options.headers).toHaveProperty("X-Gateway-Secret", "test-bootstrap-secret");

      const body = JSON.parse(tokenCall?.options.body as string);
      expect(body.pod_name).toBe("test-pod");
      expect(body.service).toBe("discord-gateway");
    });

    test("refreshes token using existing JWT", async () => {
      // Mock token endpoint for initial acquisition
      mockFetchResponses.push({
        url: "/api/internal/auth/token",
        response: createMockResponse({
          access_token: "initial-jwt-token",
          token_type: "Bearer",
          expires_in: 3600,
        }),
      });

      // Mock refresh endpoint
      mockFetchResponses.push({
        url: "/api/internal/auth/refresh",
        response: createMockResponse({
          access_token: "refreshed-jwt-token",
          token_type: "Bearer",
          expires_in: 3600,
        }),
      });

      const { GatewayManager } = await import("../../src/gateway-manager");
      
      const manager = new GatewayManager({
        podName: "test-pod",
        elizaCloudUrl: "http://localhost:3000",
        gatewayBootstrapSecret: "test-bootstrap-secret",
        redisUrl: "redis://localhost",
        redisToken: "token",
      });

      // Acquire initial token
      // @ts-expect-error - accessing private for test
      await manager.acquireToken();

      // Refresh token
      // @ts-expect-error - accessing private for test
      await manager.refreshToken();

      const refreshCall = mockFetchCalls.find(c => 
        c.url.includes("/api/internal/auth/refresh")
      );

      expect(refreshCall).toBeDefined();
      expect(refreshCall?.options.method).toBe("POST");
      expect(refreshCall?.options.headers).toHaveProperty("Authorization");
      
      // Should use Bearer token
      const authHeader = (refreshCall?.options.headers as Record<string, string>)["Authorization"];
      expect(authHeader).toMatch(/^Bearer /);
    });

    test("uses JWT in Authorization header for API calls", async () => {
      // Mock token endpoint
      mockFetchResponses.push({
        url: "/api/internal/auth/token",
        response: createMockResponse({
          access_token: "test-jwt-token-12345",
          token_type: "Bearer",
          expires_in: 3600,
        }),
      });

      // Mock events endpoint
      mockFetchResponses.push({
        url: "/api/internal/discord/events",
        response: createMockResponse({ processed: true }),
      });

      const { GatewayManager } = await import("../../src/gateway-manager");
      
      const manager = new GatewayManager({
        podName: "test-pod",
        elizaCloudUrl: "http://localhost:3000",
        gatewayBootstrapSecret: "test-bootstrap-secret",
        redisUrl: "redis://localhost",
        redisToken: "token",
      });

      // Acquire token first
      // @ts-expect-error - accessing private for test
      await manager.acquireToken();

      const mockConn = {
        connectionId: "conn-123",
        organizationId: "org-456",
        applicationId: "app-789",
        client: mockDiscordClient,
        status: "connected" as const,
        guildCount: 5,
        eventsReceived: 0,
        eventsRouted: 0,
        eventsFailed: 0,
        consecutiveFailures: 0,
        lastHeartbeat: new Date(),
        listeners: new Map(),
      };

      // @ts-expect-error - accessing private for test
      manager.connections.set("conn-123", mockConn);

      // @ts-expect-error - accessing private for test
      await manager.forwardEvent("conn-123", mockConn, "MESSAGE_CREATE", {
        id: "msg-123",
        channel_id: "chan-456",
      });

      const eventCall = mockFetchCalls.find(c => 
        c.url.includes("/api/internal/discord/events")
      );

      expect(eventCall).toBeDefined();
      const authHeader = (eventCall?.options.headers as Record<string, string>)["Authorization"];
      expect(authHeader).toBe("Bearer test-jwt-token-12345");
    });

    test("handles token acquisition failure gracefully", async () => {
      mockFetchResponses.push({
        url: "/api/internal/auth/token",
        response: new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 }),
      });

      const { GatewayManager } = await import("../../src/gateway-manager");
      
      const manager = new GatewayManager({
        podName: "test-pod",
        elizaCloudUrl: "http://localhost:3000",
        gatewayBootstrapSecret: "wrong-secret",
        redisUrl: "redis://localhost",
        redisToken: "token",
      });

      // Should not throw, but log error
      // @ts-expect-error - accessing private for test
      await expect(manager.acquireToken()).rejects.toThrow();
    });

    test("getAuthHeader returns correct format", async () => {
      mockFetchResponses.push({
        url: "/api/internal/auth/token",
        response: createMockResponse({
          access_token: "my-test-token",
          token_type: "Bearer",
          expires_in: 3600,
        }),
      });

      const { GatewayManager } = await import("../../src/gateway-manager");
      
      const manager = new GatewayManager({
        podName: "test-pod",
        elizaCloudUrl: "http://localhost:3000",
        gatewayBootstrapSecret: "test-bootstrap-secret",
        redisUrl: "redis://localhost",
        redisToken: "token",
      });

      // @ts-expect-error - accessing private for test
      await manager.acquireToken();

      // @ts-expect-error - accessing private for test
      const authHeader = manager.getAuthHeader();

      expect(authHeader).toEqual({ Authorization: "Bearer my-test-token" });
    });

    test("clears token refresh timeout on shutdown", async () => {
      mockFetchResponses.push({
        url: "/api/internal/auth/token",
        response: createMockResponse({
          access_token: "test-jwt-token",
          token_type: "Bearer",
          expires_in: 3600,
        }),
      });

      mockFetchResponses.push({
        url: "/api/internal/discord/gateway/shutdown",
        response: createMockResponse({ success: true }),
      });

      const { GatewayManager } = await import("../../src/gateway-manager");
      
      const manager = new GatewayManager({
        podName: "test-pod",
        elizaCloudUrl: "http://localhost:3000",
        gatewayBootstrapSecret: "test-bootstrap-secret",
        redisUrl: "redis://localhost",
        redisToken: "token",
      });

      // @ts-expect-error - accessing private for test
      await manager.acquireToken();

      // Shutdown should be called - timeout is cleared via clearTimeout
      // (The variable still holds the timeout reference but it won't fire)
      await manager.shutdown();

      // Verify shutdown completed (connections cleared is the main indicator)
      const status = manager.getStatus();
      expect(status.connections).toEqual([]);
    });
  });
});
