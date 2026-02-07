/**
 * RuntimeFactory Integration Tests
 *
 * Tests the production RuntimeFactory with all modes:
 * - CHAT: Basic conversation mode
 * - ASSISTANT: Full capabilities with MCP, web search
 * - BUILD: Character building mode
 *
 * These tests run the EXACT production code path against the local database.
 * Make sure your local server is running before running these tests.
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import {
  // Local database
  getConnectionString,
  verifyConnection,
  // Test data
  createTestDataSet,
  cleanupTestData,
  type TestDataSet,
  // Production RuntimeFactory
  runtimeFactory,
  invalidateRuntime,
  isRuntimeCached,
  getRuntimeCacheStats,
  AgentMode,
  // Test helpers
  buildUserContext,
  createTestUser,
  sendTestMessage,
  getMcpService,
  waitForMcpReady,
  type TestRuntime,
  type TestUserContext,
  // Timing
  startTimer,
  endTimer,
  logTimings,
} from "../infrastructure";
import { mcpTestCharacter } from "../fixtures/mcp-test-character";

// ============================================================================
// Global Test State
// ============================================================================

let connectionString: string;
let testData: TestDataSet;
const allTimings: Record<string, number> = {};

// Setup function - uses local database (same as running server)
async function setupEnvironment(): Promise<void> {
  console.log("\n" + "=".repeat(60));
  console.log("🚀 SETTING UP TEST ENVIRONMENT (Local DB)");
  console.log("=".repeat(60));

  // Verify database connection
  const connected = await verifyConnection();
  if (!connected) {
    throw new Error(
      "Cannot connect to database. Make sure DATABASE_URL is set and server is running.",
    );
  }
  connectionString = getConnectionString();
  console.log(`✅ Database connected`);

  // Create test data
  testData = await createTestDataSet(connectionString, {
    organizationName: "RuntimeFactory Test Org",
    userName: "RuntimeFactory Test User",
    userEmail: `runtime-test-${Date.now()}@eliza.test`,
    creditBalance: 1000.0,
    includeCharacter: true,
    characterName: "Mira",
    characterData: mcpTestCharacter as unknown as Record<string, unknown>,
    characterSettings: mcpTestCharacter.settings as Record<string, unknown>,
  });
  console.log("✅ Test data created");
  console.log(`   API Key: ${testData.apiKey.keyPrefix}...`);
  console.log(`   Credits: $${testData.organization.creditBalance}`);
  console.log("=".repeat(60) + "\n");
}

// Cleanup function
async function cleanupEnvironment(): Promise<void> {
  console.log("\n🧹 Cleaning up...");
  if (testData) {
    await cleanupTestData(connectionString, testData.organization.id).catch(
      (err) => console.warn(`Cleanup warning: ${err}`),
    );
  }
  logTimings("All RuntimeFactory Tests", allTimings);
}

// ============================================================================
// CHAT Mode Tests
// ============================================================================

describe("RuntimeFactory - CHAT Mode", () => {
  let runtime: TestRuntime;
  let testUser: TestUserContext;

  beforeAll(setupEnvironment);
  afterAll(cleanupEnvironment);

  it("should create runtime in CHAT mode", async () => {
    startTimer("chat_runtime_create");

    const userContext = buildUserContext(testData, {
      agentMode: AgentMode.CHAT,
      webSearchEnabled: false,
    });

    runtime = await runtimeFactory.createRuntimeForUser(userContext);

    allTimings.chatRuntimeCreate = endTimer("chat_runtime_create");

    expect(runtime).toBeDefined();
    expect(runtime.agentId).toBeDefined();
    console.log(
      `\n✅ CHAT runtime created in ${allTimings.chatRuntimeCreate}ms`,
    );
  }, 60000);

  it("should process message in CHAT mode", async () => {
    testUser = await createTestUser(runtime, "ChatTestUser");

    startTimer("chat_message");
    const result = await sendTestMessage(
      runtime,
      testUser,
      "Hello! How are you?",
      testData,
      {
        timeoutMs: 60000,
      },
    );
    allTimings.chatMessage = endTimer("chat_message");

    console.log(
      `\n📝 CHAT result:`,
      JSON.stringify(
        {
          didRespond: result.didRespond,
          error: result.error,
          hasResponse: !!result.response,
        },
        null,
        2,
      ),
    );
    if (result.error) {
      console.error(`❌ Error: ${result.error}`);
    }
    expect(result.didRespond).toBe(true);
    expect(result.response).toBeDefined();
    console.log(`\n✅ CHAT message in ${allTimings.chatMessage}ms`);
    console.log(`   Response: ${result.response?.text?.substring(0, 80)}...`);
  }, 120000);

  it("should cleanup CHAT runtime", async () => {
    await invalidateRuntime(runtime.agentId as string);
    expect(isRuntimeCached(runtime.agentId as string)).toBe(false);
  });
});

// ============================================================================
// ASSISTANT Mode Tests (with MCP)
// ============================================================================

describe("RuntimeFactory - ASSISTANT Mode (MCP)", () => {
  let runtime: TestRuntime;
  let testUser: TestUserContext;

  beforeAll(setupEnvironment);
  afterAll(cleanupEnvironment);

  it("should create runtime in ASSISTANT mode with MCP", async () => {
    startTimer("assistant_runtime_create");

    const userContext = buildUserContext(testData, {
      agentMode: AgentMode.ASSISTANT,
      characterId: testData.character?.id,
      webSearchEnabled: false, // Isolate MCP testing
    });

    runtime = await runtimeFactory.createRuntimeForUser(userContext);

    allTimings.assistantRuntimeCreate = endTimer("assistant_runtime_create");

    expect(runtime).toBeDefined();
    expect(runtime.character?.name).toBe("Mira");
    console.log(
      `\n✅ ASSISTANT runtime created in ${allTimings.assistantRuntimeCreate}ms`,
    );
  }, 60000);

  it("should have MCP service initialized", async () => {
    startTimer("mcp_init");
    const isReady = await waitForMcpReady(runtime, 15000);
    allTimings.mcpInit = endTimer("mcp_init");

    expect(isReady).toBe(true);

    const mcpService = getMcpService(runtime);
    expect(mcpService).toBeDefined();

    const tools = mcpService?.getTools?.();
    console.log(`\n✅ MCP ready in ${allTimings.mcpInit}ms`);
    console.log(`   Tools: ${tools?.length || 0}`);
  }, 30000);

  it("should process message with MCP tools available", async () => {
    testUser = await createTestUser(runtime, "AssistantTestUser");

    startTimer("assistant_message");
    const result = await sendTestMessage(
      runtime,
      testUser,
      "What's the current price of Bitcoin?",
      testData,
      { timeoutMs: 120000 },
    );
    allTimings.assistantMessage = endTimer("assistant_message");

    expect(result.didRespond).toBe(true);
    console.log(`\n✅ ASSISTANT message in ${allTimings.assistantMessage}ms`);
    console.log(`   Response: ${result.response?.text?.substring(0, 80)}...`);
  }, 180000);

  it("should cleanup ASSISTANT runtime", async () => {
    await invalidateRuntime(runtime.agentId as string);
  });
});

// ============================================================================
// ASSISTANT Mode with Web Search
// ============================================================================

describe("RuntimeFactory - ASSISTANT Mode (Web Search)", () => {
  let runtime: TestRuntime;
  let testUser: TestUserContext;

  beforeAll(setupEnvironment);
  afterAll(cleanupEnvironment);

  it("should create runtime with web search enabled", async () => {
    startTimer("websearch_runtime_create");

    const userContext = buildUserContext(testData, {
      agentMode: AgentMode.ASSISTANT,
      webSearchEnabled: true,
    });

    runtime = await runtimeFactory.createRuntimeForUser(userContext);

    allTimings.webSearchRuntimeCreate = endTimer("websearch_runtime_create");

    expect(runtime).toBeDefined();
    console.log(
      `\n✅ Web Search runtime in ${allTimings.webSearchRuntimeCreate}ms`,
    );
  }, 60000);

  it("should process message with web search", async () => {
    testUser = await createTestUser(runtime, "WebSearchTestUser");

    startTimer("websearch_message");
    const result = await sendTestMessage(
      runtime,
      testUser,
      "What is the latest news about AI?",
      testData,
      { timeoutMs: 120000 },
    );
    allTimings.webSearchMessage = endTimer("websearch_message");

    expect(result.didRespond).toBe(true);
    console.log(`\n✅ Web Search message in ${allTimings.webSearchMessage}ms`);
  }, 180000);

  it("should cleanup web search runtime", async () => {
    await invalidateRuntime(runtime.agentId as string);
  });
});

// ============================================================================
// BUILD Mode Tests
// ============================================================================

describe("RuntimeFactory - BUILD Mode", () => {
  let runtime: TestRuntime;
  let testUser: TestUserContext;

  beforeAll(setupEnvironment);
  afterAll(cleanupEnvironment);

  it("should create runtime in BUILD mode", async () => {
    startTimer("build_runtime_create");

    const userContext = buildUserContext(testData, {
      agentMode: AgentMode.BUILD,
      characterId: testData.character?.id,
      webSearchEnabled: false,
    });

    runtime = await runtimeFactory.createRuntimeForUser(userContext);

    allTimings.buildRuntimeCreate = endTimer("build_runtime_create");

    expect(runtime).toBeDefined();
    console.log(
      `\n✅ BUILD runtime created in ${allTimings.buildRuntimeCreate}ms`,
    );
  }, 60000);

  it("should process BUILD mode message", async () => {
    testUser = await createTestUser(runtime, "BuildTestUser");

    startTimer("build_message");
    const result = await sendTestMessage(
      runtime,
      testUser,
      "Make this character more friendly and add knowledge about cooking.",
      testData,
      { timeoutMs: 120000 },
    );
    allTimings.buildMessage = endTimer("build_message");

    expect(result.didRespond).toBe(true);
    console.log(`\n✅ BUILD message in ${allTimings.buildMessage}ms`);
    console.log(`   Response: ${result.response?.text?.substring(0, 80)}...`);
  }, 180000);

  it("should cleanup BUILD runtime", async () => {
    await invalidateRuntime(runtime.agentId as string);
  });
});

// ============================================================================
// Caching Tests
// ============================================================================

describe("RuntimeFactory - Caching Behavior", () => {
  beforeAll(setupEnvironment);
  afterAll(cleanupEnvironment);

  it("should cache runtime on first creation", async () => {
    const userContext = buildUserContext(testData, {
      agentMode: AgentMode.ASSISTANT,
      webSearchEnabled: false,
    });

    startTimer("cache_cold");
    const runtime1 = await runtimeFactory.createRuntimeForUser(userContext);
    allTimings.cacheCold = endTimer("cache_cold");

    expect(isRuntimeCached(runtime1.agentId as string)).toBe(true);
    console.log(`\n✅ Cold start: ${allTimings.cacheCold}ms`);

    // Don't cleanup - leave cached for next test
  }, 60000);

  it("should return cached runtime on second call", async () => {
    const userContext = buildUserContext(testData, {
      agentMode: AgentMode.ASSISTANT,
      webSearchEnabled: false,
    });

    startTimer("cache_warm");
    const runtime2 = await runtimeFactory.createRuntimeForUser(userContext);
    allTimings.cacheWarm = endTimer("cache_warm");

    expect(runtime2).toBeDefined();
    console.log(`\n✅ Warm start: ${allTimings.cacheWarm}ms`);
    console.log(
      `   Speedup: ${(((allTimings.cacheCold - allTimings.cacheWarm) / allTimings.cacheCold) * 100).toFixed(1)}%`,
    );

    // Cleanup
    await invalidateRuntime(runtime2.agentId as string);
  }, 60000);

  it("should report cache stats", () => {
    const stats = getRuntimeCacheStats();
    expect(stats).toBeDefined();
    expect(stats.runtime).toBeDefined();
    console.log(
      `\n📊 Cache stats: size=${stats.runtime.size}/${stats.runtime.maxSize}`,
    );
  });
});

// ============================================================================
// Performance Benchmarks
// ============================================================================

describe("RuntimeFactory - Performance Benchmarks", () => {
  beforeAll(setupEnvironment);
  afterAll(cleanupEnvironment);

  it("should benchmark runtime creation times", async () => {
    const modes = [AgentMode.CHAT, AgentMode.ASSISTANT, AgentMode.BUILD];
    const benchmarks: Record<string, number> = {};

    for (const mode of modes) {
      // Ensure clean state
      const userContext = buildUserContext(testData, {
        agentMode: mode,
        webSearchEnabled: false,
      });

      startTimer(`bench_${mode}`);
      const runtime = await runtimeFactory.createRuntimeForUser(userContext);
      benchmarks[mode] = endTimer(`bench_${mode}`);

      await invalidateRuntime(runtime.agentId as string);
    }

    console.log("\n📊 Runtime Creation Benchmarks:");
    for (const [mode, time] of Object.entries(benchmarks)) {
      console.log(`   ${mode}: ${time}ms`);
      allTimings[`benchmark_${mode}`] = time;
    }

    // All modes should create in under 10 seconds
    expect(benchmarks[AgentMode.CHAT]).toBeLessThan(10000);
    expect(benchmarks[AgentMode.ASSISTANT]).toBeLessThan(10000);
    expect(benchmarks[AgentMode.BUILD]).toBeLessThan(10000);
  }, 180000);
});
