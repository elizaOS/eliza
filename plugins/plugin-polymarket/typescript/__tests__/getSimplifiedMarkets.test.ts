import type { IAgentRuntime, Memory, State } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import { getSimplifiedMarketsAction } from "../actions/getSimplifiedMarkets";
import { initializeClobClient } from "../utils/clobClient";
import { callLLMWithTimeout } from "../utils/llmHelpers";

// Mock the dependencies - use simple factories to avoid importOriginal issues
vi.mock("../utils/clobClient", () => ({
  initializeClobClient: vi.fn(),
}));

vi.mock("../utils/llmHelpers", () => ({
  callLLMWithTimeout: vi.fn(),
  isLLMError: (response: unknown) => {
    return response !== null && typeof response === "object" && "error" in (response as object);
  },
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

const mockInitializeClobClient = initializeClobClient as Mock;
const mockCallLLMWithTimeout = callLLMWithTimeout as Mock;

// Types for mocked market data
interface MockMarket {
  condition_id: string;
  question?: string;
  active?: boolean;
  closed?: boolean;
  end_date_iso?: string;
  tokens?: { token_id: string; outcome: string }[];
}

interface MockMarketsResponse {
  data: MockMarket[];
  count: number;
  limit: number;
  next_cursor?: string;
}

/**
 * Creates a mock AgentRuntime for testing.
 */
function createMockRuntime(settings: Record<string, string | undefined> = {}): IAgentRuntime {
  const secrets: Record<string, string | undefined> = {
    CLOB_API_URL: settings.CLOB_API_URL ?? "https://clob.polymarket.com",
    CLOB_API_KEY: settings.CLOB_API_KEY ?? "test-api-key",
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

// Sample market data for testing (matching what the action expects)
const mockMarket: MockMarket = {
  condition_id: "0x1234567890abcdef1234567890abcdef12345678",
  question: "Will BTC reach $100k?",
  active: true,
  closed: false,
  end_date_iso: "2024-12-31T23:59:59Z",
  tokens: [
    {
      token_id: "1234567890",
      outcome: "Yes",
    },
    {
      token_id: "0987654321",
      outcome: "No",
    },
  ],
};

const mockMarketsResponse: MockMarketsResponse = {
  data: [mockMarket],
  count: 1,
  limit: 100,
  next_cursor: "LTE=",
};

describe("getSimplifiedMarketsAction", () => {
  let runtime: IAgentRuntime;
  let testMemory: Memory;
  let testState: State;

  beforeEach(() => {
    // Reset all mocks
    vi.clearAllMocks();

    // Create mock runtime
    runtime = createMockRuntime();

    testMemory = {
      id: "test-memory-id" as `${string}-${string}-${string}-${string}-${string}`,
      userId: "test-user-id" as `${string}-${string}-${string}-${string}-${string}`,
      agentId: runtime.agentId,
      roomId: "test-room-id" as `${string}-${string}-${string}-${string}-${string}`,
      content: {
        text: "Get simplified market data",
      },
      embedding: new Float32Array(),
      createdAt: Date.now(),
    } as Memory;

    testState = {
      userId: "test-user-id",
      agentId: runtime.agentId,
      roomId: "test-room-id",
      agentName: "test-agent",
      bio: "test bio",
      lore: "test lore",
      messageDirections: "test directions",
      postDirections: "test post directions",
      actors: "test actors",
      actorsData: [],
      goals: "test goals",
      goalsData: [],
      recentMessages: "test recent messages",
      recentMessagesData: [],
      actionNames: "test action names",
      actions: "test actions",
      actionExamples: "test action examples",
      providers: "test providers",
      responseData: "test response data",
      recentInteractionsData: [],
      recentInteractions: "test recent interactions",
      formattedConversation: "test formatted conversation",
      knowledge: "test knowledge",
      knowledgeData: [],
    } as State;
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe("validation", () => {
    it("should validate successfully when CLOB_API_URL is provided", async () => {
      const result = await getSimplifiedMarketsAction.validate(runtime, testMemory, testState);

      expect(result).toBe(true);
    });

    it("should fail validation when CLOB_API_URL is not provided", async () => {
      const runtimeWithoutUrl = createMockRuntime({
        CLOB_API_URL: undefined,
      });

      vi.spyOn(runtimeWithoutUrl, "getSetting").mockReturnValue(undefined);

      const result = await getSimplifiedMarketsAction.validate(
        runtimeWithoutUrl,
        testMemory,
        testState
      );

      expect(result).toBe(false);
    });
  });

  describe("handler", () => {
    it("should successfully fetch simplified markets", async () => {
      // Mock the CLOB client - actual code uses getMarkets not getSimplifiedMarkets
      const mockClient = {
        getMarkets: vi.fn().mockResolvedValue(mockMarketsResponse),
      };
      mockInitializeClobClient.mockResolvedValue(mockClient);

      // Mock LLM response for pagination parameters
      mockCallLLMWithTimeout.mockResolvedValue({
        limit: 10,
      });

      const result = await getSimplifiedMarketsAction.handler(runtime, testMemory, testState);

      expect(mockInitializeClobClient).toHaveBeenCalledWith(runtime);
      expect(mockClient.getMarkets).toHaveBeenCalled();
      expect(result.text).toContain("Simplified Polymarket Markets");
      expect(result.data.count).toBe("1");
    });

    it("should handle empty simplified markets response", async () => {
      const emptyResponse: MockMarketsResponse = {
        data: [],
        count: 0,
        limit: 100,
        next_cursor: "LTE=",
      };

      const mockClient = {
        getMarkets: vi.fn().mockResolvedValue(emptyResponse),
      };
      mockInitializeClobClient.mockResolvedValue(mockClient);
      mockCallLLMWithTimeout.mockResolvedValue({
        limit: 10,
      });

      const result = await getSimplifiedMarketsAction.handler(runtime, testMemory, testState);

      expect(result.text).toContain("Simplified Polymarket Markets");
      expect(result.text).toContain("No markets found");
      expect(result.data.count).toBe("0");
    });

    it("should handle pagination cursor from LLM", async () => {
      const mockClient = {
        getMarkets: vi.fn().mockResolvedValue(mockMarketsResponse),
      };
      mockInitializeClobClient.mockResolvedValue(mockClient);

      // Mock LLM response with pagination cursor
      mockCallLLMWithTimeout.mockResolvedValue({
        limit: 10,
        next_cursor: "test-cursor-123",
      });

      await getSimplifiedMarketsAction.handler(runtime, testMemory, testState);

      expect(mockClient.getMarkets).toHaveBeenCalledWith("test-cursor-123");
    });

    it("should handle CLOB client initialization error", async () => {
      const testError = new Error("Failed to initialize CLOB client");
      mockInitializeClobClient.mockRejectedValue(testError);

      await expect(
        getSimplifiedMarketsAction.handler(runtime, testMemory, testState)
      ).rejects.toThrow("Failed to initialize CLOB client");
    });

    it("should handle CLOB API error", async () => {
      const mockClient = {
        getMarkets: vi
          .fn()
          .mockRejectedValue(new Error("CLOB API error: 500 Internal Server Error")),
      };
      mockInitializeClobClient.mockResolvedValue(mockClient);
      mockCallLLMWithTimeout.mockResolvedValue({
        error: "No pagination cursor requested. Fetching first page.",
      });

      await expect(
        getSimplifiedMarketsAction.handler(runtime, testMemory, testState)
      ).rejects.toThrow("CLOB API error: 500 Internal Server Error");
    });

    it("should handle invalid response from CLOB API", async () => {
      // The actual code accesses marketsResponse.data, so null response will cause an error
      const mockClient = {
        getMarkets: vi.fn().mockResolvedValue(null),
      };
      mockInitializeClobClient.mockResolvedValue(mockClient);
      mockCallLLMWithTimeout.mockResolvedValue({
        error: "No pagination cursor requested. Fetching first page.",
      });

      await expect(
        getSimplifiedMarketsAction.handler(runtime, testMemory, testState)
      ).rejects.toThrow();
    });

    it("should handle missing CLOB_API_URL", async () => {
      const runtimeWithoutUrl = createMockRuntime({
        CLOB_API_URL: undefined,
      });

      vi.spyOn(runtimeWithoutUrl, "getSetting").mockReturnValue(undefined);

      // The actual code doesn't throw for missing URL in handler - it relies on validate
      // Instead, initializeClobClient will fail
      mockInitializeClobClient.mockRejectedValue(
        new Error("CLOB_API_URL is required in configuration.")
      );

      await expect(
        getSimplifiedMarketsAction.handler(runtimeWithoutUrl, testMemory, testState)
      ).rejects.toThrow("CLOB_API_URL is required in configuration.");
    });

    it("should handle callback if provided", async () => {
      const mockCallback = vi.fn();
      const mockClient = {
        getMarkets: vi.fn().mockResolvedValue(mockMarketsResponse),
      };
      mockInitializeClobClient.mockResolvedValue(mockClient);
      mockCallLLMWithTimeout.mockResolvedValue({
        error: "No pagination cursor requested. Fetching first page.",
      });

      await getSimplifiedMarketsAction.handler(runtime, testMemory, testState, {}, mockCallback);

      expect(mockCallback).toHaveBeenCalledWith(
        expect.objectContaining({
          text: expect.stringContaining("Simplified Polymarket Markets"),
          actions: ["POLYMARKET_GET_SIMPLIFIED_MARKETS"],
        })
      );
    });

    it("should handle LLM timeout gracefully", async () => {
      const mockClient = {
        getMarkets: vi.fn().mockResolvedValue(mockMarketsResponse),
      };
      mockInitializeClobClient.mockResolvedValue(mockClient);

      // Mock LLM timeout - the actual code propagates the error
      mockCallLLMWithTimeout.mockRejectedValue(new Error("LLM timeout"));

      // The handler propagates the error, so we expect it to reject
      await expect(
        getSimplifiedMarketsAction.handler(runtime, testMemory, testState)
      ).rejects.toThrow("LLM timeout");
    });
  });

  describe("action properties", () => {
    it("should have correct action name", () => {
      expect(getSimplifiedMarketsAction.name).toBe("POLYMARKET_GET_SIMPLIFIED_MARKETS");
    });

    it("should have appropriate similes", () => {
      // Actual similes are POLYMARKET_ prefixed
      expect(getSimplifiedMarketsAction.similes).toContain("POLYMARKET_SIMPLE_MARKETS");
      expect(getSimplifiedMarketsAction.similes).toContain("POLYMARKET_MARKET_LIST");
      expect(getSimplifiedMarketsAction.similes).toContain("POLYMARKET_BASIC_MARKETS");
      expect(getSimplifiedMarketsAction.similes).toContain("POLYMARKET_QUICK_MARKETS");
    });

    it("should have correct description", () => {
      expect(getSimplifiedMarketsAction.description).toContain("simplified");
      expect(getSimplifiedMarketsAction.description).toContain("essential information");
    });

    it("should have examples", () => {
      expect(getSimplifiedMarketsAction.examples).toBeDefined();
      expect(getSimplifiedMarketsAction.examples.length).toBeGreaterThan(0);
    });
  });
});
