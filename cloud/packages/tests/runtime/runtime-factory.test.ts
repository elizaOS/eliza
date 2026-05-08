/**
 * RuntimeFactory Integration Tests
 *
 * Tests the production RuntimeFactory with CHAT mode:
 * - CHAT: Basic conversation mode
 *
 * These tests run the EXACT production code path against the local database.
 * Make sure your local server is running before running these tests.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mcpTestCharacter } from "../fixtures/mcp-test-character";
import {
  AgentMode,
  // Test helpers
  buildUserContext,
  cleanupTestData,
  // Test data
  createTestDataSet,
  createTestUser,
  endTimer,
  getConnectionString,
  getMcpService,
  getRuntimeCacheStats,
  // Local database
  hasDatabaseUrl,
  hasRuntimeModelCredentials,
  invalidateRuntime,
  isRuntimeCached,
  logTimings,
  // Production RuntimeFactory
  runtimeFactory,
  sendTestMessage,
  // Timing
  startTimer,
  type TestDataSet,
  type TestRuntime,
  type TestUserContext,
  verifyConnection,
  waitForMcpReady,
} from "../infrastructure";

// ============================================================================
// Global Test State
// ============================================================================

let connectionString: string;
let testData: TestDataSet;
const allTimings: Record<string, number> = {};
const skipLiveModelSuites = !hasDatabaseUrl || !hasRuntimeModelCredentials;

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
    await cleanupTestData(connectionString, testData.organization.id).catch((err) =>
      console.warn(`Cleanup warning: ${err}`),
    );
  }
  logTimings("All RuntimeFactory Tests", allTimings);
}

// ============================================================================
// CHAT Mode Tests
// ============================================================================

describe.skipIf(skipLiveModelSuites)("RuntimeFactory - CHAT Mode", () => {
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
    console.log(`\n✅ CHAT runtime created in ${allTimings.chatRuntimeCreate}ms`);
  }, 60000);

  it("should process message in CHAT mode", async () => {
    testUser = await createTestUser(runtime, "ChatTestUser");

    startTimer("chat_message");
    const result = await sendTestMessage(runtime, testUser, "Hello! How are you?", testData, {
      timeoutMs: 60000,
    });
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
// CHAT Mode Tests (with MCP)
// ============================================================================

describe.skipIf(skipLiveModelSuites)("RuntimeFactory - CHAT Mode (MCP)", () => {
  let runtime: TestRuntime;
  let testUser: TestUserContext;

  beforeAll(setupEnvironment);
  afterAll(cleanupEnvironment);

  it("should create runtime in CHAT mode with MCP", async () => {
    startTimer("assistant_runtime_create");

    const userContext = buildUserContext(testData, {
      agentMode: AgentMode.CHAT,
      characterId: testData.character?.id,
      webSearchEnabled: false, // Isolate MCP testing
    });

    runtime = await runtimeFactory.createRuntimeForUser(userContext);

    allTimings.assistantRuntimeCreate = endTimer("assistant_runtime_create");

    expect(runtime).toBeDefined();
    expect(runtime.character?.name).toBe("Mira");
    console.log(`\n✅ CHAT runtime created in ${allTimings.assistantRuntimeCreate}ms`);
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
    console.log(`\n✅ CHAT message in ${allTimings.assistantMessage}ms`);
    console.log(`   Response: ${result.response?.text?.substring(0, 80)}...`);
  }, 180000);

  it("should cleanup CHAT runtime", async () => {
    await invalidateRuntime(runtime.agentId as string);
  });
});

// ============================================================================
// CHAT Mode with Web Search
// ============================================================================

describe.skipIf(skipLiveModelSuites)("RuntimeFactory - CHAT Mode (Web Search)", () => {
  let runtime: TestRuntime;
  let testUser: TestUserContext;

  beforeAll(setupEnvironment);
  afterAll(cleanupEnvironment);

  it("should create runtime with web search enabled", async () => {
    startTimer("websearch_runtime_create");

    const userContext = buildUserContext(testData, {
      agentMode: AgentMode.CHAT,
      webSearchEnabled: true,
    });

    runtime = await runtimeFactory.createRuntimeForUser(userContext);

    allTimings.webSearchRuntimeCreate = endTimer("websearch_runtime_create");

    expect(runtime).toBeDefined();
    console.log(`\n✅ Web Search runtime in ${allTimings.webSearchRuntimeCreate}ms`);
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
// CHAT Mode Tests
// ============================================================================

describe.skipIf(skipLiveModelSuites)("RuntimeFactory - CHAT Mode", () => {
  let runtime: TestRuntime;
  let testUser: TestUserContext;

  beforeAll(setupEnvironment);
  afterAll(cleanupEnvironment);

  it("should create runtime in CHAT mode", async () => {
    startTimer("build_runtime_create");

    const userContext = buildUserContext(testData, {
      agentMode: AgentMode.CHAT,
      characterId: testData.character?.id,
      webSearchEnabled: false,
    });

    runtime = await runtimeFactory.createRuntimeForUser(userContext);

    allTimings.buildRuntimeCreate = endTimer("build_runtime_create");

    expect(runtime).toBeDefined();
    console.log(`\n✅ CHAT runtime created in ${allTimings.buildRuntimeCreate}ms`);
  }, 60000);

  it("should process CHAT mode message", async () => {
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
    console.log(`\n✅ CHAT message in ${allTimings.buildMessage}ms`);
    console.log(`   Response: ${result.response?.text?.substring(0, 80)}...`);
  }, 180000);

  it("should cleanup CHAT runtime", async () => {
    await invalidateRuntime(runtime.agentId as string);
  });
});

// ============================================================================
// Caching Tests
// ============================================================================

describe.skipIf(!hasDatabaseUrl)("RuntimeFactory - Caching Behavior", () => {
  beforeAll(setupEnvironment);
  afterAll(cleanupEnvironment);

  it("should cache runtime on first creation", async () => {
    const userContext = buildUserContext(testData, {
      agentMode: AgentMode.CHAT,
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
      agentMode: AgentMode.CHAT,
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
    console.log(`\n📊 Cache stats: size=${stats.runtime.size}/${stats.runtime.maxSize}`);
  });

  it("should separate cached runtimes when direct model preferences differ", async () => {
    const baseContext = buildUserContext(testData, {
      agentMode: AgentMode.CHAT,
      webSearchEnabled: false,
      modelPreferences: {
        responseHandlerModel: "google/gemini-2.5-flash-lite",
      },
    });
    const tunedContext = buildUserContext(testData, {
      agentMode: AgentMode.CHAT,
      webSearchEnabled: false,
      modelPreferences: {
        responseHandlerModel: "projects/demo/locations/us-central1/endpoints/demo-handler",
      },
    });

    const runtime1 = await runtimeFactory.createRuntimeForUser(baseContext);
    const runtime2 = await runtimeFactory.createRuntimeForUser(tunedContext);

    expect(runtime1).not.toBe(runtime2);
    expect(runtime1.character.settings?.ELIZAOS_CLOUD_RESPONSE_HANDLER_MODEL).toBe(
      "google/gemini-2.5-flash-lite",
    );
    expect(runtime2.character.settings?.ELIZAOS_CLOUD_RESPONSE_HANDLER_MODEL).toBe(
      "projects/demo/locations/us-central1/endpoints/demo-handler",
    );

    await invalidateRuntime(runtime1.agentId as string);
  }, 60000);
});

// ============================================================================
// Performance Benchmarks
// ============================================================================

describe.skipIf(!hasDatabaseUrl)("RuntimeFactory - Performance Benchmarks", () => {
  beforeAll(setupEnvironment);
  afterAll(cleanupEnvironment);

  it("should benchmark runtime creation times", async () => {
    const modes = [AgentMode.CHAT];
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

    // Chat runtime should create in under 10 seconds
    expect(benchmarks[AgentMode.CHAT]).toBeLessThan(10000);
  }, 180000);
});
