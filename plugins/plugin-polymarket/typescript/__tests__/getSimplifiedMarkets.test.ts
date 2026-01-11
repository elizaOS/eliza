import type { IAgentRuntime, Memory, State } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import { getSimplifiedMarketsAction } from "../actions/getSimplifiedMarkets";
import type { SimplifiedMarket, SimplifiedMarketsResponse } from "../types";
import { initializeClobClient } from "../utils/clobClient";
import { callLLMWithTimeout } from "../utils/llmHelpers";

// Mock the dependencies
vi.mock("../utils/clobClient");
vi.mock("../utils/llmHelpers");

const mockInitializeClobClient = initializeClobClient as Mock;
const mockCallLLMWithTimeout = callLLMWithTimeout as Mock;

/**
 * Creates a REAL AgentRuntime for testing - NO MOCKS.
 */
async function createTestRuntime(settings: Record<string, string | undefined> = {}): Promise<{
  runtime: IAgentRuntime;
  cleanup: () => Promise<void>;
}> {
  const sqlPlugin = await import("@elizaos/plugin-sql");
  const { AgentRuntime } = await import("@elizaos/core");
  const { v4: uuidv4 } = await import("uuid");

  const agentId = uuidv4() as `${string}-${string}-${string}-${string}-${string}`;
  const adapter = sqlPlugin.createDatabaseAdapter({ dataDir: ":memory:" }, agentId);
  await adapter.init();

  const runtime = new AgentRuntime({
    agentId,
    character: {
      name: "Test Agent",
      bio: ["A test agent for Polymarket"],
      system: "You are a helpful assistant.",
      plugins: [],
      settings: {
        secrets: {
          CLOB_API_URL: settings.CLOB_API_URL ?? "https://clob.polymarket.com",
          CLOB_API_KEY: settings.CLOB_API_KEY ?? "test-api-key",
        },
      },
      messageExamples: [],
      postExamples: [],
      topics: ["testing"],
      adjectives: ["helpful"],
      style: { all: [], chat: [], post: [] },
    },
    adapter,
    plugins: [],
  });

  await runtime.initialize();

  const cleanup = async () => {
    try {
      await runtime.stop();
      await adapter.close();
    } catch {
      // Ignore cleanup errors
    }
  };

  return { runtime, cleanup };
}

// Sample simplified market data for testing
const mockSimplifiedMarket: SimplifiedMarket = {
  condition_id: "0x1234567890abcdef1234567890abcdef12345678",
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
  rewards: {
    min_size: 0.01,
    max_spread: 0.05,
    event_start_date: "2024-01-01T00:00:00Z",
    event_end_date: "2024-12-31T23:59:59Z",
    in_game_multiplier: 1.5,
    reward_epoch: 1,
  },
  min_incentive_size: "0.1",
  max_incentive_spread: "0.05",
  active: true,
  closed: false,
};

const mockSimplifiedMarketsResponse: SimplifiedMarketsResponse = {
  limit: 100,
  count: 1,
  next_cursor: "LTE=",
  data: [mockSimplifiedMarket],
};

describe("getSimplifiedMarketsAction", () => {
  let runtime: IAgentRuntime;
  let cleanup: () => Promise<void>;
  let testMemory: Memory;
  let testState: State;

  beforeEach(async () => {
    vi.clearAllMocks();

    const result = await createTestRuntime();
    runtime = result.runtime;
    cleanup = result.cleanup;

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

  afterEach(async () => {
    await cleanup();
  });

  describe("validation", () => {
    it("should validate successfully when CLOB_API_URL is provided", async () => {
      const result = await getSimplifiedMarketsAction.validate(runtime, testMemory, testState);

      expect(result).toBe(true);
    });

    it("should fail validation when CLOB_API_URL is not provided", async () => {
      const resultWithoutUrl = await createTestRuntime({
        CLOB_API_URL: undefined,
      });

      vi.spyOn(resultWithoutUrl.runtime, "getSetting").mockReturnValue(undefined);

      const result = await getSimplifiedMarketsAction.validate(
        resultWithoutUrl.runtime,
        testMemory,
        testState
      );

      expect(result).toBe(false);

      await resultWithoutUrl.cleanup();
    });
  });

  describe("handler", () => {
    it("should successfully fetch simplified markets", async () => {
      // Mock the CLOB client
      const mockClient = {
        getSimplifiedMarkets: vi.fn().mockResolvedValue(mockSimplifiedMarketsResponse),
      };
      mockInitializeClobClient.mockResolvedValue(mockClient);

      // Mock LLM response for no pagination cursor
      mockCallLLMWithTimeout.mockResolvedValue({
        error: "No pagination cursor requested. Fetching first page.",
      });

      const result = await getSimplifiedMarketsAction.handler(runtime, testMemory, testState);

      expect(mockInitializeClobClient).toHaveBeenCalledWith(runtime);
      expect(mockClient.getSimplifiedMarkets).toHaveBeenCalledWith("");
      expect(result.text).toContain("Retrieved 1 Simplified Polymarket markets");
      expect(result.text).toContain("Condition ID");
      expect(result.text).toContain(mockSimplifiedMarket.condition_id);
      expect(result.actions).toContain("GET_SIMPLIFIED_MARKETS");
      expect(result.data).toEqual({
        markets: [mockSimplifiedMarket],
        count: 1,
        total: 1,
        filtered: 0,
        next_cursor: "LTE=",
        limit: 100,
      });
    });

    it("should handle empty simplified markets response", async () => {
      const emptyResponse: SimplifiedMarketsResponse = {
        limit: 100,
        count: 0,
        next_cursor: "LTE=",
        data: [],
      };

      const mockClient = {
        getSimplifiedMarkets: vi.fn().mockResolvedValue(emptyResponse),
      };
      mockInitializeClobClient.mockResolvedValue(mockClient);
      mockCallLLMWithTimeout.mockResolvedValue({
        error: "No pagination cursor requested. Fetching first page.",
      });

      const result = await getSimplifiedMarketsAction.handler(runtime, testMemory, testState);

      expect(result.text).toContain("Retrieved 0 Simplified Polymarket markets");
      expect(result.text).toContain("No valid simplified markets found");
      expect(result.data.count).toBe(0);
    });

    it("should handle pagination cursor from LLM", async () => {
      const mockClient = {
        getSimplifiedMarkets: vi.fn().mockResolvedValue(mockSimplifiedMarketsResponse),
      };
      mockInitializeClobClient.mockResolvedValue(mockClient);

      // Mock LLM response with pagination cursor
      mockCallLLMWithTimeout.mockResolvedValue({
        next_cursor: "test-cursor-123",
      });

      await getSimplifiedMarketsAction.handler(runtime, testMemory, testState);

      expect(mockClient.getSimplifiedMarkets).toHaveBeenCalledWith("test-cursor-123");
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
        getSimplifiedMarkets: vi
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
      const mockClient = {
        getSimplifiedMarkets: vi.fn().mockResolvedValue(null),
      };
      mockInitializeClobClient.mockResolvedValue(mockClient);
      mockCallLLMWithTimeout.mockResolvedValue({
        error: "No pagination cursor requested. Fetching first page.",
      });

      await expect(
        getSimplifiedMarketsAction.handler(runtime, testMemory, testState)
      ).rejects.toThrow("Invalid response from CLOB API");
    });

    it("should handle missing CLOB_API_URL", async () => {
      const resultWithoutUrl = await createTestRuntime({
        CLOB_API_URL: undefined,
      });

      vi.spyOn(resultWithoutUrl.runtime, "getSetting").mockReturnValue(undefined);

      await expect(
        getSimplifiedMarketsAction.handler(resultWithoutUrl.runtime, testMemory, testState)
      ).rejects.toThrow("CLOB_API_URL is required in configuration.");

      await resultWithoutUrl.cleanup();
    });

    it("should handle callback if provided", async () => {
      const mockCallback = vi.fn();
      const mockClient = {
        getSimplifiedMarkets: vi.fn().mockResolvedValue(mockSimplifiedMarketsResponse),
      };
      mockInitializeClobClient.mockResolvedValue(mockClient);
      mockCallLLMWithTimeout.mockResolvedValue({
        error: "No pagination cursor requested. Fetching first page.",
      });

      await getSimplifiedMarketsAction.handler(runtime, testMemory, testState, {}, mockCallback);

      expect(mockCallback).toHaveBeenCalledWith(
        expect.objectContaining({
          text: expect.stringContaining("Retrieved 1 Simplified Polymarket markets"),
          actions: ["GET_SIMPLIFIED_MARKETS"],
        })
      );
    });

    it("should handle LLM timeout gracefully", async () => {
      const mockClient = {
        getSimplifiedMarkets: vi.fn().mockResolvedValue(mockSimplifiedMarketsResponse),
      };
      mockInitializeClobClient.mockResolvedValue(mockClient);

      // Mock LLM timeout
      mockCallLLMWithTimeout.mockRejectedValue(new Error("LLM timeout"));

      const result = await getSimplifiedMarketsAction.handler(runtime, testMemory, testState);

      // Should still work with default parameters
      expect(mockClient.getSimplifiedMarkets).toHaveBeenCalledWith("");
      expect(result.text).toContain("Retrieved 1 Simplified Polymarket markets");
    });
  });

  describe("action properties", () => {
    it("should have correct action name", () => {
      expect(getSimplifiedMarketsAction.name).toBe("GET_SIMPLIFIED_MARKETS");
    });

    it("should have appropriate similes", () => {
      expect(getSimplifiedMarketsAction.similes).toContain("LIST_SIMPLIFIED_MARKETS");
      expect(getSimplifiedMarketsAction.similes).toContain("SIMPLIFIED_MARKETS");
      expect(getSimplifiedMarketsAction.similes).toContain("SIMPLE_MARKETS");
    });

    it("should have correct description", () => {
      expect(getSimplifiedMarketsAction.description).toContain("simplified");
      expect(getSimplifiedMarketsAction.description).toContain("reduced schema");
    });

    it("should have examples", () => {
      expect(getSimplifiedMarketsAction.examples).toBeDefined();
      expect(getSimplifiedMarketsAction.examples.length).toBeGreaterThan(0);
    });
  });
});
