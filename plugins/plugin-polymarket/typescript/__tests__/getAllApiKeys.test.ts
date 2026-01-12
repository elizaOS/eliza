import type { HandlerCallback, IAgentRuntime, Memory, State } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getAllApiKeysAction } from "../actions/getAllApiKeys";

// Mock the crypto module
vi.mock("crypto", () => ({
  createHmac: vi.fn(() => ({
    update: vi.fn(() => ({
      digest: vi.fn(() => "mock-signature"),
    })),
  })),
}));

// Mock @elizaos/core to avoid real runtime initialization
vi.mock("@elizaos/core", async () => {
  const actual = await vi.importActual("@elizaos/core");
  return {
    ...actual,
    logger: {
      log: vi.fn(),
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
  };
});

// Mock fetch globally
interface GlobalWithFetch {
  fetch: ReturnType<typeof vi.fn>;
}

// Helper function to access global fetch with proper typing
function getGlobalFetch(): GlobalWithFetch {
  return globalThis as GlobalWithFetch;
}

getGlobalFetch().fetch = vi.fn();

/**
 * Creates a mock AgentRuntime for testing.
 */
function createMockRuntime(settings: Record<string, string | undefined> = {}): IAgentRuntime {
  const secrets: Record<string, string | undefined> = {
    WALLET_PRIVATE_KEY:
      settings.WALLET_PRIVATE_KEY ??
      "0x1234567890123456789012345678901234567890123456789012345678901234",
    CLOB_API_URL: settings.CLOB_API_URL ?? "https://clob.polymarket.com",
    CLOB_API_KEY: settings.CLOB_API_KEY ?? "test-api-key",
    CLOB_API_SECRET: settings.CLOB_API_SECRET ?? "test-api-secret",
    CLOB_API_PASSPHRASE: settings.CLOB_API_PASSPHRASE ?? "test-passphrase",
  };

  return {
    agentId: "test-agent-id" as `${string}-${string}-${string}-${string}-${string}`,
    character: {
      name: "Test Agent",
      bio: ["A test agent for Polymarket"],
      system: "You are a helpful assistant.",
      plugins: [],
      settings: {
        secrets,
      },
      messageExamples: [],
      postExamples: [],
      topics: ["testing"],
      adjectives: ["helpful"],
      style: { all: [], chat: [], post: [] },
    },
    getSetting: vi.fn((key: string) => secrets[key]),
    setSetting: vi.fn((key: string, value: string) => {
      secrets[key] = value;
    }),
    getService: vi.fn(),
    registerService: vi.fn(),
    useModel: vi.fn(),
    emitEvent: vi.fn(),
    composeState: vi.fn().mockResolvedValue({}),
    updateRecentMessageState: vi.fn().mockResolvedValue({}),
  } as unknown as IAgentRuntime;
}

describe("getAllApiKeysAction", () => {
  let runtime: IAgentRuntime;
  let testMessage: Memory;
  let testState: State;
  let testCallback: HandlerCallback;

  beforeEach(() => {
    // Reset all mocks
    vi.clearAllMocks();

    // Create mock runtime
    runtime = createMockRuntime();

    // Test message
    testMessage = {
      id: crypto.randomUUID() as `${string}-${string}-${string}-${string}-${string}`,
      content: {
        text: "Get my API keys",
      },
      userId: "test-user" as `${string}-${string}-${string}-${string}-${string}`,
      roomId: "test-room" as `${string}-${string}-${string}-${string}-${string}`,
      entityId: "test-entity" as `${string}-${string}-${string}-${string}-${string}`,
      agentId: runtime.agentId,
      createdAt: Date.now(),
    } as Memory;

    // Test state
    testState = {} as State;

    // Test callback
    testCallback = vi.fn();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe("validate", () => {
    it("should return true when private key is available", async () => {
      const result = await getAllApiKeysAction.validate(runtime, testMessage);
      expect(result).toBe(true);
    });

    it("should return false when no private key is available", async () => {
      // Create runtime without private key
      const runtimeWithoutKey = createMockRuntime({
        WALLET_PRIVATE_KEY: undefined,
        CLOB_API_KEY: undefined,
        CLOB_API_SECRET: undefined,
        CLOB_API_PASSPHRASE: undefined,
      });

      // Override getSetting to return undefined for WALLET_PRIVATE_KEY
      vi.spyOn(runtimeWithoutKey, "getSetting").mockReturnValue(undefined);

      const result = await getAllApiKeysAction.validate(runtimeWithoutKey, testMessage);
      expect(result).toBe(false);
    });
  });

  describe("handler", () => {
    beforeEach(() => {
      // Reset fetch mock
      getGlobalFetch().fetch.mockReset();
    });

    it("should successfully retrieve non-empty array of API keys", async () => {
      // Mock successful API response with array of keys
      const mockApiKeys = [
        {
          key: "api-key-1",
          secret: "secret-1",
          passphrase: "passphrase-1",
          created_at: "2023-01-01T00:00:00Z",
          active: true,
        },
        {
          key: "api-key-2",
          secret: "secret-2",
          passphrase: "passphrase-2",
          created_at: "2023-01-02T00:00:00Z",
          active: false,
        },
      ];

      getGlobalFetch().fetch.mockResolvedValue({
        ok: true,
        json: vi.fn().mockResolvedValue(mockApiKeys),
      });

      await getAllApiKeysAction.handler(runtime, testMessage, testState, {}, testCallback);

      expect(testCallback).toHaveBeenCalledWith({
        text: expect.stringContaining("✅ **API Keys Retrieved Successfully**"),
        action: "GET_API_KEYS",
        data: {
          success: true,
          apiKeys: expect.arrayContaining([
            expect.objectContaining({
              key: "api-key-1",
              secret: "secret-1",
              passphrase: "passphrase-1",
            }),
          ]),
          count: 2,
          address: expect.any(String),
        },
      });

      expect((testCallback as ReturnType<typeof vi.fn>).mock.calls[0][0].text).toContain(
        "Total API Keys**: 2"
      );
      expect((testCallback as ReturnType<typeof vi.fn>).mock.calls[0][0].text).toContain("Key 1:");
      expect((testCallback as ReturnType<typeof vi.fn>).mock.calls[0][0].text).toContain("Key 2:");
    });

    it("should handle empty array of API keys", async () => {
      // Mock API response with empty array
      getGlobalFetch().fetch.mockResolvedValue({
        ok: true,
        json: vi.fn().mockResolvedValue([]),
      });

      await getAllApiKeysAction.handler(runtime, testMessage, testState, {}, testCallback);

      expect(testCallback).toHaveBeenCalledWith({
        text: expect.stringContaining("✅ **API Keys Retrieved Successfully**"),
        action: "GET_API_KEYS",
        data: {
          success: true,
          apiKeys: [],
          count: 0,
          address: expect.any(String),
        },
      });

      expect((testCallback as ReturnType<typeof vi.fn>).mock.calls[0][0].text).toContain(
        "Total API Keys**: 0"
      );
      expect((testCallback as ReturnType<typeof vi.fn>).mock.calls[0][0].text).toContain(
        "No API keys found"
      );
      expect((testCallback as ReturnType<typeof vi.fn>).mock.calls[0][0].text).toContain(
        "CREATE_API_KEY action"
      );
    });

    it("should handle API response with data wrapper", async () => {
      // Mock API response with data wrapper
      const mockApiResponse = {
        data: [
          {
            api_key: "wrapped-key-1",
            api_secret: "wrapped-secret-1",
            api_passphrase: "wrapped-passphrase-1",
            createdAt: "2023-01-01T00:00:00Z",
          },
        ],
      };

      getGlobalFetch().fetch.mockResolvedValue({
        ok: true,
        json: vi.fn().mockResolvedValue(mockApiResponse),
      });

      await getAllApiKeysAction.handler(runtime, testMessage, testState, {}, testCallback);

      expect(testCallback).toHaveBeenCalledWith({
        text: expect.stringContaining("✅ **API Keys Retrieved Successfully**"),
        action: "GET_API_KEYS",
        data: {
          success: true,
          apiKeys: expect.arrayContaining([
            expect.objectContaining({
              key: "wrapped-key-1",
              secret: "wrapped-secret-1",
              passphrase: "wrapped-passphrase-1",
            }),
          ]),
          count: 1,
          address: expect.any(String),
        },
      });
    });

    it("should handle missing API credentials error", async () => {
      // Create runtime without API credentials
      const runtimeWithoutCreds = createMockRuntime({
        WALLET_PRIVATE_KEY: "0x1234567890123456789012345678901234567890123456789012345678901234",
        CLOB_API_URL: "https://clob.polymarket.com",
        CLOB_API_KEY: undefined,
        CLOB_API_SECRET: undefined,
        CLOB_API_PASSPHRASE: undefined,
      });

      // Override getSetting to return undefined for API credentials
      vi.spyOn(runtimeWithoutCreds, "getSetting").mockImplementation((key: string) => {
        if (key === "WALLET_PRIVATE_KEY")
          return "0x1234567890123456789012345678901234567890123456789012345678901234";
        if (key === "CLOB_API_URL") return "https://clob.polymarket.com";
        return undefined;
      });

      await getAllApiKeysAction.handler(
        runtimeWithoutCreds,
        testMessage,
        testState,
        {},
        testCallback
      );

      expect(testCallback).toHaveBeenCalledWith({
        text: expect.stringContaining("❌ **Failed to Retrieve API Keys**"),
        action: "GET_API_KEYS",
        data: {
          success: false,
          error:
            "API credentials not found. You need to create API keys first using the CREATE_API_KEY action",
        },
      });
    });

    it("should handle network/auth error from API", async () => {
      // Mock failed API response
      getGlobalFetch().fetch.mockResolvedValue({
        ok: false,
        status: 401,
        statusText: "Unauthorized",
        text: vi.fn().mockResolvedValue('{"error":"Invalid credentials"}'),
      });

      await getAllApiKeysAction.handler(runtime, testMessage, testState, {}, testCallback);

      expect(testCallback).toHaveBeenCalledWith({
        text: expect.stringContaining("❌ **Failed to Retrieve API Keys**"),
        action: "GET_API_KEYS",
        data: {
          success: false,
          error: expect.stringContaining("Failed to retrieve API keys: 401 Unauthorized"),
        },
      });
    });

    it("should handle network connectivity issues", async () => {
      // Mock network error
      getGlobalFetch().fetch.mockRejectedValue(new Error("Network error"));

      await getAllApiKeysAction.handler(runtime, testMessage, testState, {}, testCallback);

      expect(testCallback).toHaveBeenCalledWith({
        text: expect.stringContaining("❌ **Failed to Retrieve API Keys**"),
        action: "GET_API_KEYS",
        data: {
          success: false,
          error: "Network error",
        },
      });
    });

    it("should truncate sensitive data in response", async () => {
      // Mock API response with long credentials
      const mockApiKeys = [
        {
          key: "very-long-api-key-12345678901234567890",
          secret: "very-long-secret-12345678901234567890",
          passphrase: "very-long-passphrase-12345678901234567890",
          active: true,
        },
      ];

      getGlobalFetch().fetch.mockResolvedValue({
        ok: true,
        json: vi.fn().mockResolvedValue(mockApiKeys),
      });

      await getAllApiKeysAction.handler(runtime, testMessage, testState, {}, testCallback);

      const responseText = (testCallback as ReturnType<typeof vi.fn>).mock.calls[0][0].text;

      // Check that sensitive data is truncated
      expect(responseText).toContain("very-lon...");
      expect(responseText).not.toContain("very-long-secret-12345678901234567890");
      expect(responseText).not.toContain("very-long-passphrase-12345678901234567890");
    });
  });
});
