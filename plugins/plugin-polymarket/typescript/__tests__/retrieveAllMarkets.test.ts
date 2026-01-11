import type { HandlerCallback, IAgentRuntime, Memory, State } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { retrieveAllMarketsAction } from "../actions/retrieveAllMarkets";

// Mock the dependencies
vi.mock("../utils/llmHelpers", () => ({
  callLLMWithTimeout: vi.fn(),
}));

vi.mock("../utils/clobClient", () => ({
  initializeClobClient: vi.fn(),
}));

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

describe("retrieveAllMarketsAction", () => {
  let runtime: IAgentRuntime;
  let cleanup: () => Promise<void>;
  let testMessage: Memory;
  let testState: State;
  let testCallback: HandlerCallback | undefined;

  beforeEach(async () => {
    const result = await createTestRuntime();
    runtime = result.runtime;
    cleanup = result.cleanup;

    testMessage = {
      id: "test-id" as `${string}-${string}-${string}-${string}-${string}`,
      content: { text: "Get all markets" },
      userId: "test-user" as `${string}-${string}-${string}-${string}-${string}`,
      roomId: "test-room" as `${string}-${string}-${string}-${string}-${string}`,
      agentId: runtime.agentId,
      createdAt: Date.now(),
    } as Memory;

    testState = {
      agentId: runtime.agentId,
      bio: "Test bio",
      lore: "Test lore",
      recentMessages: [],
      providers: [],
      messageDirections: "outgoing",
      actions: [],
      evaluators: [],
      responseData: {},
    } as State;

    testCallback = vi.fn();
  });

  afterEach(async () => {
    await cleanup();
  });

  describe("validate", () => {
    it("should return true when CLOB_API_URL is provided", async () => {
      const result = await retrieveAllMarketsAction.validate(runtime, testMessage, testState);

      expect(result).toBe(true);
    });

    it("should return false when CLOB_API_URL is not provided", async () => {
      const resultWithoutUrl = await createTestRuntime({
        CLOB_API_URL: undefined,
      });

      vi.spyOn(resultWithoutUrl.runtime, "getSetting").mockReturnValue(undefined);

      const result = await retrieveAllMarketsAction.validate(
        resultWithoutUrl.runtime,
        testMessage,
        testState
      );

      expect(result).toBe(false);

      await resultWithoutUrl.cleanup();
    });
  });

  describe("handler", () => {
    it("should fetch and return markets successfully", async () => {
      const mockMarkets = [
        {
          question: "Will BTC reach $100k?",
          category: "crypto",
          active: true,
          end_date_iso: "2024-12-31T23:59:59Z",
        },
        {
          question: "Who will win the election?",
          category: "politics",
          active: true,
          end_date_iso: "2024-11-05T23:59:59Z",
        },
      ];

      const mockResponse = {
        data: mockMarkets,
        count: 2,
        limit: 100,
        next_cursor: "LTE=",
      };

      const mockClobClient = {
        getMarkets: vi.fn().mockResolvedValue(mockResponse),
      };

      const { callLLMWithTimeout } = await import("../utils/llmHelpers");
      const { initializeClobClient } = await import("../utils/clobClient");

      vi.mocked(callLLMWithTimeout).mockResolvedValue({});
      vi.mocked(initializeClobClient).mockResolvedValue(mockClobClient);

      const result = await retrieveAllMarketsAction.handler(
        runtime,
        testMessage,
        testState,
        {},
        testCallback
      );

      expect(result.text).toContain("Retrieved 2 Polymarket prediction markets");
      expect(result.text).toContain("Will BTC reach $100k?");
      expect(result.text).toContain("Who will win the election?");
      expect(result.actions).toContain("GET_ALL_MARKETS");
      expect(result.data.markets).toEqual(mockMarkets);
      expect(result.data.count).toBe(2);
      expect(testCallback).toHaveBeenCalledWith(result);
    });

    it("should handle empty markets response", async () => {
      const mockResponse = {
        data: [],
        count: 0,
        limit: 100,
        next_cursor: "LTE=",
      };

      const mockClobClient = {
        getMarkets: vi.fn().mockResolvedValue(mockResponse),
      };

      const { callLLMWithTimeout } = await import("../utils/llmHelpers");
      const { initializeClobClient } = await import("../utils/clobClient");

      vi.mocked(callLLMWithTimeout).mockResolvedValue({});
      vi.mocked(initializeClobClient).mockResolvedValue(mockClobClient);

      const result = await retrieveAllMarketsAction.handler(
        runtime,
        testMessage,
        testState,
        {},
        testCallback
      );

      expect(result.text).toContain("Retrieved 0 Polymarket prediction markets");
      expect(result.text).toContain("No markets found matching your criteria");
      expect(result.data.count).toBe(0);
    });

    it("should handle CLOB API errors", async () => {
      const mockClobClient = {
        getMarkets: vi
          .fn()
          .mockRejectedValue(new Error("CLOB API error: 500 Internal Server Error")),
      };

      const { callLLMWithTimeout } = await import("../utils/llmHelpers");
      const { initializeClobClient } = await import("../utils/clobClient");

      vi.mocked(callLLMWithTimeout).mockResolvedValue({});
      vi.mocked(initializeClobClient).mockResolvedValue(mockClobClient);

      await expect(
        retrieveAllMarketsAction.handler(runtime, testMessage, testState, {}, testCallback)
      ).rejects.toThrow("CLOB API error: 500 Internal Server Error");

      expect(testCallback).toHaveBeenCalledWith(
        expect.objectContaining({
          text: expect.stringContaining("Error retrieving markets"),
          data: expect.objectContaining({
            error: "CLOB API error: 500 Internal Server Error",
          }),
        })
      );
    });

    it("should handle missing CLOB_API_URL in handler", async () => {
      const resultWithoutUrl = await createTestRuntime({
        CLOB_API_URL: undefined,
      });

      vi.spyOn(resultWithoutUrl.runtime, "getSetting").mockReturnValue(undefined);

      await expect(
        retrieveAllMarketsAction.handler(
          resultWithoutUrl.runtime,
          testMessage,
          testState,
          {},
          testCallback
        )
      ).rejects.toThrow("CLOB_API_URL is required in configuration.");

      expect(testCallback).toHaveBeenCalledWith(
        expect.objectContaining({
          text: "CLOB_API_URL is required in configuration.",
          data: expect.objectContaining({
            error: "CLOB_API_URL is required in configuration.",
          }),
        })
      );

      await resultWithoutUrl.cleanup();
    });
  });

  describe("action properties", () => {
    it("should have correct action name and similes", () => {
      expect(retrieveAllMarketsAction.name).toBe("GET_ALL_MARKETS");
      expect(retrieveAllMarketsAction.similes).toContain("LIST_MARKETS");
      expect(retrieveAllMarketsAction.similes).toContain("SHOW_MARKETS");
      expect(retrieveAllMarketsAction.similes).toContain("GET_MARKETS");
    });

    it("should have proper description", () => {
      expect(retrieveAllMarketsAction.description).toBe(
        "Retrieve all available prediction markets from Polymarket"
      );
    });

    it("should have example conversations", () => {
      expect(retrieveAllMarketsAction.examples).toBeDefined();
      expect(retrieveAllMarketsAction.examples.length).toBeGreaterThan(0);

      const firstExample = retrieveAllMarketsAction.examples[0];
      expect(firstExample[0].content.text).toContain("prediction markets");
      expect(firstExample[1].content.actions).toContain("GET_ALL_MARKETS");
    });
  });
});
