/**
 * External Agent Integration Tests
 *
 * Tests for enhanced ExternalAgentAdapter with A2A protocol, authentication,
 * discovery, and trust verification integrated with CommunicationHub.
 */

import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { CommunicationHub } from "../communication/CommunicationHub";
import { getEventBus } from "../communication/EventBus";
import {
  AuthMethod,
  ExternalAgentAdapter,
  TrustLevel,
} from "../external/ExternalAgentAdapter";
import type { AgentCard } from "../types/agent-registry";

// Type for mock fetch function
type MockFetchFn = ((
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>) & {
  mockResolvedValueOnce: (value: Response) => MockFetchFn;
  mockImplementation: (fn: (url: string) => Promise<Response>) => MockFetchFn;
  mockClear: () => void;
};

// Mock fetch globally
const mockFetchFn = mock<
  (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
>(() => Promise.resolve(new Response())) as MockFetchFn;
global.fetch = mockFetchFn;

// Mock database
mock.module("@polyagent/db", () => ({
  db: {
    externalAgentConnection: {
      findMany: mock(() => Promise.resolve([])),
      update: mock(() => Promise.resolve({})),
    },
  },
}));

// Mock agent registry
mock.module("../services/interfaces", () => ({
  agentRegistry: {
    getAgentById: mock(() => Promise.resolve(null)),
  },
}));

describe("ExternalAgentAdapter - Enhanced A2A Protocol", () => {
  let adapter: ExternalAgentAdapter;

  beforeEach(() => {
    adapter = new ExternalAgentAdapter();
    mockFetchFn.mockClear();
  });

  afterEach(() => {
    adapter.stopHealthChecks();
    adapter.shutdown();
  });

  describe("JSON-RPC 2.0 A2A Protocol", () => {
    it("should send A2A message with JSON-RPC 2.0 format", async () => {
      const mockConnection = {
        id: "conn-1",
        externalId: "agent-1",
        endpoint: "https://agent.example.com/a2a",
        protocol: "a2a" as const,
        isHealthy: true,
      };

      // Add connection manually
      adapter.connections.set("agent-1", mockConnection);

      const mockResponse = {
        jsonrpc: "2.0",
        id: 1,
        result: { message: "Hello from external agent" },
      };

      // Mock fetch for testing
      mockFetchFn.mockResolvedValueOnce({
        ok: true,
        json: async () => mockResponse,
      } as Response);

      const response = await adapter.sendMessage("agent-1", {
        type: "greeting",
        content: "Hello",
      });

      expect(response.success).toBe(true);
      expect(response.data).toEqual({ message: "Hello from external agent" });
      expect(response.messageId).toBe("1");

      // Verify fetch was called with correct JSON-RPC structure
      expect(global.fetch).toHaveBeenCalledWith(
        "https://agent.example.com/a2a",
        expect.objectContaining({
          method: "POST",
          headers: expect.objectContaining({
            "Content-Type": "application/json",
            Accept: "application/json",
          }),
          body: expect.stringContaining('"jsonrpc":"2.0"'),
        }),
      );
    });

    it("should handle JSON-RPC errors correctly", async () => {
      const mockConnection = {
        id: "conn-1",
        externalId: "agent-1",
        endpoint: "https://agent.example.com/a2a",
        protocol: "a2a" as const,
        isHealthy: true,
      };

      adapter.connections.set("agent-1", mockConnection);

      const mockErrorResponse = {
        jsonrpc: "2.0",
        id: 1,
        error: {
          code: -32600,
          message: "Invalid Request",
          data: { details: "Missing required field" },
        },
      };

      // Mock fetch for testing
      mockFetchFn.mockResolvedValueOnce({
        ok: true,
        json: async () => mockErrorResponse,
      } as Response);

      const response = await adapter.sendMessage("agent-1", {
        type: "invalid",
        content: {},
      });

      expect(response.success).toBe(false);
      expect(response.error).toContain("A2A Error -32600");
      expect(response.error).toContain("Invalid Request");
    });
  });

  describe("Authentication Support", () => {
    it("should configure bearer token authentication", () => {
      adapter.configureAuth("agent-1", {
        method: AuthMethod.BEARER_TOKEN,
        token: "test-token-123",
      });

      const headers = adapter.getAuthHeaders("agent-1");
      expect(headers.Authorization).toBe("Bearer test-token-123");
    });

    it("should configure API key authentication", () => {
      adapter.configureAuth("agent-1", {
        method: AuthMethod.API_KEY,
        apiKey: "api-key-xyz",
      });

      const headers = adapter.getAuthHeaders("agent-1");
      expect(headers.Authorization).toBe("api-key-xyz");
    });

    it("should configure OAuth2 authentication", () => {
      adapter.configureAuth("agent-1", {
        method: AuthMethod.OAUTH2,
        oauth: {
          accessToken: "oauth-token-abc",
          tokenType: "Bearer",
          expiresAt: new Date(Date.now() + 3600000),
        },
      });

      const headers = adapter.getAuthHeaders("agent-1");
      expect(headers.Authorization).toBe("Bearer oauth-token-abc");
    });

    it("should send authenticated A2A request", async () => {
      const mockConnection = {
        id: "conn-1",
        externalId: "agent-1",
        endpoint: "https://secure.agent.com/a2a",
        protocol: "a2a" as const,
        isHealthy: true,
      };

      adapter.connections.set("agent-1", mockConnection);
      adapter.configureAuth("agent-1", {
        method: AuthMethod.BEARER_TOKEN,
        token: "secure-token",
      });

      // Mock fetch for testing
      mockFetchFn.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          jsonrpc: "2.0",
          id: 1,
          result: { authenticated: true },
        }),
      } as Response);

      await adapter.sendMessage("agent-1", {
        type: "secure-action",
        content: "data",
      });

      // Verify Authorization header was included
      expect(global.fetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: "Bearer secure-token",
          }),
        }),
      );
    });
  });

  describe("Agent Discovery", () => {
    it("should discover agent via well-known URI", async () => {
      const mockAgentCard: AgentCard = {
        version: "1.0",
        agentId: "agent-123",
        name: "Test Agent",
        description: "A test agent for integration testing",
        endpoints: {
          a2a: "https://agent.example.com/a2a",
        },
        capabilities: {
          actions: ["text-generation", "summarization"],
          version: "1.0.0",
        },
      };

      // Mock fetch for testing
      mockFetchFn.mockResolvedValueOnce({
        ok: true,
        json: async () => mockAgentCard,
      } as Response);

      const card = await adapter.discoverAgent("https://agent.example.com");

      expect(card).toEqual(mockAgentCard);
      expect(global.fetch).toHaveBeenCalledWith(
        "https://agent.example.com/.well-known/agent-card.json",
        expect.objectContaining({
          method: "GET",
          headers: { Accept: "application/json" },
        }),
      );
    });

    it("should cache agent card discovery", async () => {
      const mockAgentCard: AgentCard = {
        version: "1.0",
        agentId: "agent-123",
        name: "Test Agent",
        description: "A test agent for caching",
        endpoints: {},
        capabilities: {
          version: "1.0.0",
        },
      };

      // Mock fetch for testing
      mockFetchFn.mockResolvedValueOnce({
        ok: true,
        json: async () => mockAgentCard,
      } as Response);

      // First call
      const card1 = await adapter.discoverAgent("https://agent.example.com");
      expect(card1).toEqual(mockAgentCard);

      // Second call should use cache
      const card2 = await adapter.discoverAgent("https://agent.example.com");
      expect(card2).toEqual(mockAgentCard);

      // Fetch should only be called once
      expect(global.fetch).toHaveBeenCalledTimes(1);
    });

    it("should return null for failed discovery", async () => {
      // Mock fetch for testing
      mockFetchFn.mockResolvedValueOnce({
        ok: false,
        status: 404,
      } as Response);

      const card = await adapter.discoverAgent(
        "https://nonexistent.example.com",
      );
      expect(card).toBeNull();
    });
  });

  describe("Trust Verification", () => {
    it("should calculate trust score correctly", () => {
      const connection = {
        id: "conn-1",
        externalId: "agent-1",
        endpoint: "https://agent.example.com",
        protocol: "a2a" as const,
        isHealthy: true,
        trustLevel: TrustLevel.VERIFIED,
        agentCard: {
          version: "1.0",
          agentId: "agent-1",
          name: "Test Agent",
          endpoints: {},
        },
        lastConnected: new Date(),
      };

      const score = adapter.calculateTrustScore(connection);

      // VERIFIED (2) * 10 = 20 points
      // isHealthy = 20 points
      // agentCard present = 20 points
      // lastConnected < 1 day = 20 points
      // Total = 80 points
      expect(score).toBe(80);
    });

    it("should verify agent and determine trust level", async () => {
      const mockConnection = {
        id: "conn-1",
        externalId: "agent-1",
        endpoint: "https://agent.example.com",
        protocol: "a2a" as const,
        isHealthy: false,
      };

      adapter.connections.set("agent-1", mockConnection);

      // Mock health check to return healthy
      // Mock fetch for testing
      mockFetchFn.mockResolvedValueOnce({
        ok: true,
      } as Response);

      // Mock agent card discovery
      const mockAgentCard: AgentCard = {
        version: "1.0",
        agentId: "agent-1",
        name: "Test Agent",
        description: "Test agent for trust verification",
        endpoints: {},
        capabilities: {
          actions: ["text-generation"],
          version: "1.0.0",
        },
      };

      // Mock fetch for testing
      mockFetchFn.mockResolvedValueOnce({
        ok: true,
        json: async () => mockAgentCard,
      } as Response);

      const trustLevel = await adapter.verifyAgent("agent-1");

      expect(trustLevel).toBe(TrustLevel.VERIFIED);
      expect(mockConnection.trustLevel).toBe(TrustLevel.VERIFIED);
      expect(mockConnection.trustScore).toBeGreaterThan(0);
      expect(mockConnection.agentCard).toEqual(mockAgentCard);
    });
  });
});

describe("CommunicationHub - Streaming and Context Support", () => {
  let hub: CommunicationHub;

  beforeEach(() => {
    const eventBus = getEventBus();
    hub = new CommunicationHub(eventBus);
    mockFetchFn.mockClear();
  });

  afterEach(() => {
    hub.clearHistory();
  });

  it("should support contextId for conversation continuity", async () => {
    const contextId = "conversation-123";

    // Mock internal delivery
    const subscription = hub.subscribeToMessages(
      "recipient-agent",
      async (message) => {
        expect(message.contextId).toBe(contextId);
        expect(message.content).toBe("Hello");
      },
    );

    await hub.sendMessage(
      "sender-agent",
      "recipient-agent",
      "chat",
      "Hello",
      {},
      contextId,
    );

    const history = hub.getMessageHistory();
    expect(history[0].contextId).toBe(contextId);

    hub.unsubscribe(subscription);
  });

  it("should support streaming flag", async () => {
    // Mock internal delivery
    const subscription = hub.subscribeToMessages(
      "recipient-agent",
      async (message) => {
        expect(message.streaming).toBe(true);
      },
    );

    await hub.sendMessage(
      "sender-agent",
      "recipient-agent",
      "long-task",
      { taskData: "complex-analysis" },
      {},
      undefined,
      true, // streaming enabled
    );

    const history = hub.getMessageHistory();
    expect(history[0].streaming).toBe(true);

    hub.unsubscribe(subscription);
  });

  it("should broadcast with contextId to multiple agents", async () => {
    const contextId = "broadcast-123";
    const recipients = ["agent-1", "agent-2", "agent-3"];

    const subscription1 = hub.subscribeToMessages(
      "agent-1",
      async (message) => {
        expect(message.contextId).toBe(contextId);
      },
    );

    const subscription2 = hub.subscribeToMessages(
      "agent-2",
      async (message) => {
        expect(message.contextId).toBe(contextId);
      },
    );

    const subscription3 = hub.subscribeToMessages(
      "agent-3",
      async (message) => {
        expect(message.contextId).toBe(contextId);
      },
    );

    const responses = await hub.broadcastMessage(
      "sender-agent",
      recipients,
      "announcement",
      { text: "Important update" },
      {},
      contextId,
    );

    expect(responses).toHaveLength(3);
    expect(responses.every((r) => r.success)).toBe(true);

    hub.unsubscribe(subscription1);
    hub.unsubscribe(subscription2);
    hub.unsubscribe(subscription3);
  });
});

describe("End-to-End Integration", () => {
  let adapter: ExternalAgentAdapter;
  let hub: CommunicationHub;

  beforeEach(() => {
    adapter = new ExternalAgentAdapter();
    const eventBus = getEventBus();
    hub = new CommunicationHub(eventBus);
    mockFetchFn.mockClear();
  });

  afterEach(() => {
    adapter.stopHealthChecks();
    adapter.shutdown();
    hub.clearHistory();
  });

  it("should handle complete A2A workflow with authentication and trust", async () => {
    // Setup: Configure external agent
    const mockConnection = {
      id: "conn-1",
      externalId: "external-agent-1",
      endpoint: "https://trusted.agent.com/a2a",
      protocol: "a2a" as const,
      isHealthy: true,
    };

    adapter.connections.set("external-agent-1", mockConnection);

    // Configure authentication
    adapter.configureAuth("external-agent-1", {
      method: AuthMethod.BEARER_TOKEN,
      token: "secure-token-xyz",
    });

    // Mock discovery
    const mockAgentCard: AgentCard = {
      version: "1.0",
      agentId: "external-agent-1",
      name: "Trusted External Agent",
      description:
        "A trusted external agent for end-to-end integration testing",
      endpoints: { a2a: "https://trusted.agent.com/a2a" },
      capabilities: {
        actions: ["analysis", "generation"],
        version: "1.0.0",
      },
    };

    // Mock fetch implementation for testing
    mockFetchFn.mockImplementation((url: string) => {
      if (url.includes("/.well-known/agent-card.json")) {
        return Promise.resolve({
          ok: true,
          json: async () => mockAgentCard,
        } as Response);
      }
      if (url.includes("/a2a")) {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            jsonrpc: "2.0",
            id: 1,
            result: { analysis: "Complete" },
          }),
        } as Response);
      }
      return Promise.resolve({ ok: true } as Response);
    });

    // Verify agent and establish trust
    const trustLevel = await adapter.verifyAgent("external-agent-1");
    expect(trustLevel).toBe(TrustLevel.VERIFIED);

    // Get trust score
    const connection = adapter.getConnectionStatus("external-agent-1");
    expect(connection?.trustScore).toBeGreaterThanOrEqual(60);

    // Send authenticated message via CommunicationHub
    const response = await adapter.sendMessage("external-agent-1", {
      type: "analysis-request",
      content: { data: "test" },
      contextId: "session-123",
    });

    expect(response.success).toBe(true);
    expect(response.data).toEqual({ analysis: "Complete" });

    // Verify authentication headers were sent
    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining("/a2a"),
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer secure-token-xyz",
        }),
      }),
    );
  });
});
