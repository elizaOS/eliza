import type { ActionResult, IAgentRuntime, Memory } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  analyzeInputAction,
  executeFinalAction,
  processAnalysisAction,
} from "../actions/chain-example";

async function createTestRuntime(characterOverrides: Record<string, unknown> = {}): Promise<{
  runtime: IAgentRuntime;
  cleanup: () => Promise<void>;
}> {
  const {
    createDatabaseAdapter,
    DatabaseMigrationService,
    plugin: sqlPluginInstance,
  } = await import("@elizaos/plugin-sql");
  const { AgentRuntime } = await import("@elizaos/core");
  const { v4: uuidv4 } = await import("uuid");

  const agentId = uuidv4() as `${string}-${string}-${string}-${string}-${string}`;

  // Create the adapter using the exported function
  const adapter = createDatabaseAdapter({ dataDir: `:memory:${agentId}` }, agentId);
  await adapter.init();

  // Run migrations to create the schema
  const migrationService = new DatabaseMigrationService();
  const db = (adapter as { getDatabase(): unknown }).getDatabase();
  await migrationService.initializeWithDatabase(db);
  migrationService.discoverAndRegisterPluginSchemas([sqlPluginInstance]);
  await migrationService.runAllPluginMigrations();

  const character = {
    name: (characterOverrides.name as string) || "Test Agent",
    bio: ["A test agent"],
    system: "You are a helpful assistant.",
    plugins: [],
    settings: {},
    messageExamples: [],
    postExamples: [],
    topics: ["testing"],
    adjectives: ["helpful"],
    style: { all: [], chat: [], post: [] },
    ...characterOverrides,
  };

  // Create the agent in the database first
  await adapter.createAgent({
    id: agentId,
    ...character,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });

  const runtime = new AgentRuntime({
    agentId,
    character,
    adapter,
    plugins: [],
  });

  await runtime.initialize();

  const cleanup = async () => {
    try {
      await runtime.stop();
      // Don't close the adapter - it uses a global singleton and closing it
      // would break subsequent tests. The connection will be cleaned up
      // when the test process ends.
    } catch {
      // Ignore cleanup errors
    }
  };

  return { runtime, cleanup };
}

interface ActionOptions {
  abortSignal?: AbortSignal;
  previousResults?: ActionResult[];
  chainContext?: {
    chainId: string;
    totalActions: number;
    currentIndex: number;
  };
}

describe("Action Chaining", () => {
  let runtime: IAgentRuntime;
  let cleanup: () => Promise<void> = async () => {
    // Default no-op cleanup in case beforeEach fails
  };
  let testMessage: Memory;
  let testState: { values: Record<string, unknown>; data: Record<string, unknown>; text: string };

  beforeEach(async () => {
    const result = await createTestRuntime({
      name: "Test Agent",
    });
    runtime = result.runtime;
    cleanup = result.cleanup;

    testMessage = {
      id: "test-message" as `${string}-${string}-${string}-${string}-${string}`,
      entityId: "test-entity" as `${string}-${string}-${string}-${string}-${string}`,
      roomId: "test-room" as `${string}-${string}-${string}-${string}-${string}`,
      agentId: runtime.agentId,
      content: {
        text: "This is a good test message",
      },
      createdAt: Date.now(),
    } as Memory;

    testState = {
      values: {},
      data: {},
      text: "",
    };
  });

  afterEach(async () => {
    await cleanup();
  });

  it("should pass data between actions", async () => {
    // Execute first action
    const result1 = await analyzeInputAction.handler(runtime, testMessage, testState, {});

    expect(result1).toBeDefined();
    expect((result1 as ActionResult)?.data).toBeDefined();
    expect((result1 as ActionResult)?.data.sentiment).toBe("positive");
    expect((result1 as ActionResult)?.text).toContain("positive sentiment");

    // Execute second action with previous results
    const options2 = {
      previousResults: [result1 as ActionResult],
    };

    const result2 = await processAnalysisAction.handler(runtime, testMessage, testState, options2);

    expect((result2 as ActionResult)?.data).toBeDefined();
    expect((result2 as ActionResult)?.data?.analysis).toEqual((result1 as ActionResult)?.data);
    expect((result2 as ActionResult)?.data?.decisions.suggestedResponse).toBe(
      "Thank you for the positive feedback!"
    );

    // Execute final action with all previous results
    const options3 = {
      previousResults: [result1 as ActionResult, result2 as ActionResult],
      chainContext: {
        chainId: "test-chain",
        totalActions: 3,
        currentIndex: 2,
      },
    };

    const mockCallback = vi.fn();
    const result3 = await executeFinalAction.handler(
      runtime,
      testMessage,
      testState,
      options3,
      mockCallback
    );

    expect(result3).toBeDefined();
    expect((result3 as ActionResult)?.data).toBeDefined();
    expect(mockCallback).toHaveBeenCalledWith({
      text: "Thank you for the positive feedback!",
      source: "chain_example",
    });
  });

  it("should handle abort signals", async () => {
    const abortController = new AbortController();

    // Abort immediately
    abortController.abort();

    const options: ActionOptions = {
      abortSignal: abortController.signal,
    };

    await expect(
      analyzeInputAction.handler(runtime, testMessage, testState, options)
    ).rejects.toThrow("Analysis aborted");
  });

  it("should stop chain when continueChain is false", async () => {
    // Create a message that will trigger needsMoreInfo
    const shortMessage = {
      id: "test-message" as `${string}-${string}-${string}-${string}-${string}`,
      entityId: "test-entity" as `${string}-${string}-${string}-${string}-${string}`,
      roomId: "test-room" as `${string}-${string}-${string}-${string}-${string}`,
      agentId: runtime.agentId,
      content: { text: "Hi" },
      createdAt: Date.now(),
    } as Memory;

    // First action
    const result1 = await analyzeInputAction.handler(runtime, shortMessage, testState, {});

    // Second action should return continueChain: false
    const options2: ActionOptions = {
      previousResults: [result1 as ActionResult],
    };

    const result2 = await processAnalysisAction.handler(runtime, shortMessage, testState, options2);

    expect(result2?.continueChain).toBe(false);
    expect(result2?.data?.decisions.needsMoreInfo).toBe(true);
  });

  it("should handle missing previous results", async () => {
    await expect(
      processAnalysisAction.handler(
        runtime,
        testMessage,
        testState,
        {} // No previous results
      )
    ).rejects.toThrow("No analysis data available");
  });

  it("should execute cleanup functions", async () => {
    const _cleanupMock = vi.fn();
    console.log = vi.fn(); // Mock console.log

    const result = await executeFinalAction.handler(runtime, testMessage, testState, {
      previousResults: [
        { success: true, data: { wordCount: 10 } },
        {
          success: true,
          data: {
            decisions: {
              requiresAction: true,
              suggestedResponse: "Test response",
            },
          },
          metadata: { action: "PROCESS_ANALYSIS" },
        },
      ],
    });

    expect(result?.cleanup).toBeDefined();

    // Execute cleanup
    await result?.cleanup?.();

    expect(console.log).toHaveBeenCalledWith("[ChainExample] Cleaning up resources...");
  });
});
