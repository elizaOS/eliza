import type { HandlerCallback, IAgentRuntime, Memory, State } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import { getAllApiKeysAction } from "../actions/getAllApiKeys";
import { initializeClobClientWithCreds } from "../utils/clobClient";
import { callLLMWithTimeout } from "../utils/llmHelpers";

// Mock the dependencies - use simple factories to avoid importOriginal issues
vi.mock("../utils/clobClient", () => ({
  initializeClobClientWithCreds: vi.fn(),
}));

vi.mock("../utils/llmHelpers", () => ({
  callLLMWithTimeout: vi.fn(),
  isLLMError: vi.fn(() => false),
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

// Typed mock references
const mockInitializeClobClientWithCreds = initializeClobClientWithCreds as Mock;
const mockCallLLMWithTimeout = callLLMWithTimeout as Mock;

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
      id: "test-message-id" as `${string}-${string}-${string}-${string}-${string}`,
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

    // Default mock behavior for LLM
    mockCallLLMWithTimeout.mockResolvedValue({});
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
    it("should successfully retrieve API keys", async () => {
      // Mock CLOB client with API keys response
      const mockApiKeysResponse = {
        apiKeys: [
          { key: "api-key-1", secret: "secret-1", passphrase: "passphrase-1" },
          { key: "api-key-2", secret: "secret-2", passphrase: "passphrase-2" },
        ],
      };

      const mockClobClient = {
        getApiKeys: vi.fn().mockResolvedValue(mockApiKeysResponse),
      };
      mockInitializeClobClientWithCreds.mockResolvedValue(mockClobClient);

      await getAllApiKeysAction.handler(runtime, testMessage, testState, {}, testCallback);

      expect(mockInitializeClobClientWithCreds).toHaveBeenCalledWith(runtime);
      expect(mockClobClient.getApiKeys).toHaveBeenCalled();
      expect(testCallback).toHaveBeenCalledWith(
        expect.objectContaining({
          text: expect.stringContaining("Your Polymarket API Keys"),
          actions: ["POLYMARKET_GET_ALL_API_KEYS"],
          data: expect.objectContaining({
            apiKeysCount: 2,
          }),
        })
      );
    });

    it("should handle empty array of API keys", async () => {
      // Mock CLOB client with empty API keys response
      const mockApiKeysResponse = {
        apiKeys: [],
      };

      const mockClobClient = {
        getApiKeys: vi.fn().mockResolvedValue(mockApiKeysResponse),
      };
      mockInitializeClobClientWithCreds.mockResolvedValue(mockClobClient);

      await getAllApiKeysAction.handler(runtime, testMessage, testState, {}, testCallback);

      expect(testCallback).toHaveBeenCalledWith(
        expect.objectContaining({
          text: expect.stringContaining("no API keys registered"),
          actions: ["POLYMARKET_GET_ALL_API_KEYS"],
          data: expect.objectContaining({
            apiKeysCount: 0,
          }),
        })
      );
    });

    it("should handle CLOB client initialization error", async () => {
      mockInitializeClobClientWithCreds.mockRejectedValue(
        new Error("Failed to initialize CLOB client")
      );

      await getAllApiKeysAction.handler(runtime, testMessage, testState, {}, testCallback);

      expect(testCallback).toHaveBeenCalledWith(
        expect.objectContaining({
          text: expect.stringContaining("Error fetching API keys"),
          actions: ["POLYMARKET_GET_ALL_API_KEYS"],
          data: expect.objectContaining({
            error: "Failed to initialize CLOB client",
          }),
        })
      );
    });

    it("should handle API call error", async () => {
      const mockClobClient = {
        getApiKeys: vi.fn().mockRejectedValue(new Error("API request failed")),
      };
      mockInitializeClobClientWithCreds.mockResolvedValue(mockClobClient);

      await getAllApiKeysAction.handler(runtime, testMessage, testState, {}, testCallback);

      expect(testCallback).toHaveBeenCalledWith(
        expect.objectContaining({
          text: expect.stringContaining("Error fetching API keys"),
          actions: ["POLYMARKET_GET_ALL_API_KEYS"],
          data: expect.objectContaining({
            error: "API request failed",
          }),
        })
      );
    });

    it("should handle network connectivity issues", async () => {
      mockInitializeClobClientWithCreds.mockRejectedValue(new Error("Network error"));

      await getAllApiKeysAction.handler(runtime, testMessage, testState, {}, testCallback);

      expect(testCallback).toHaveBeenCalledWith(
        expect.objectContaining({
          text: expect.stringContaining("Error fetching API keys"),
          data: expect.objectContaining({
            error: "Network error",
          }),
        })
      );
    });

    it("should return correct action result", async () => {
      const mockApiKeysResponse = {
        apiKeys: [{ key: "api-key-1", secret: "secret-1", passphrase: "passphrase-1" }],
      };

      const mockClobClient = {
        getApiKeys: vi.fn().mockResolvedValue(mockApiKeysResponse),
      };
      mockInitializeClobClientWithCreds.mockResolvedValue(mockClobClient);

      const result = await getAllApiKeysAction.handler(
        runtime,
        testMessage,
        testState,
        {},
        testCallback
      );

      expect(result.success).toBe(true);
      expect(result.text).toContain("Your Polymarket API Keys");
      expect(result.data?.apiKeysCount).toBe(1);
    });

    it("should return error result on failure", async () => {
      mockInitializeClobClientWithCreds.mockRejectedValue(new Error("Test error"));

      const result = await getAllApiKeysAction.handler(
        runtime,
        testMessage,
        testState,
        {},
        testCallback
      );

      expect(result.success).toBe(false);
      expect(result.error).toBe("Test error");
    });
  });

  describe("action properties", () => {
    it("should have correct action name", () => {
      expect(getAllApiKeysAction.name).toBe("POLYMARKET_GET_ALL_API_KEYS");
    });

    it("should have appropriate similes", () => {
      expect(getAllApiKeysAction.similes).toContain("POLYMARKET_LIST_MY_API_KEYS");
      expect(getAllApiKeysAction.similes).toContain("POLYMARKET_VIEW_API_CREDENTIALS");
      expect(getAllApiKeysAction.similes).toContain("POLYMARKET_SHOW_ALL_KEYS");
    });

    it("should have proper description", () => {
      expect(getAllApiKeysAction.description).toContain("API keys");
      expect(getAllApiKeysAction.description).toContain("Polymarket");
    });

    it("should have example conversations", () => {
      expect(getAllApiKeysAction.examples).toBeDefined();
      expect(getAllApiKeysAction.examples.length).toBeGreaterThan(0);
    });
  });
});
