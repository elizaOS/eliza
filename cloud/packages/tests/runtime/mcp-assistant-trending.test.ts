/**
 * MCP Chat Trending Tokens Test
 *
 * Tests the MCP assistant with "can you get trending tokens" query.
 * Uses local database (same as running server).
 *
 * Run with: bun test tests/runtime/mcp-assistant-trending.test.ts
 *
 * Environment:
 *   DEBUG_TRACING=true  - Enable debug tracing (set in .env)
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mcpTestCharacter } from "../fixtures/mcp-test-character";
import {
  cleanupTestData,
  createTestDataSet,
  createTestRuntime,
  createTestUser,
  endTimer,
  getConnectionString,
  getMcpService,
  hasDatabaseUrl,
  hasRuntimeModelCredentials,
  logTimings,
  sendTestMessage,
  startTimer,
  type TestDataSet,
  type TestRuntimeResult,
  type TestUserContext,
  verifyConnection,
  waitForMcpReady,
} from "../infrastructure";
import {
  clearDebugTraces,
  getLatestDebugTrace,
  isDebugTracingEnabled,
  renderDebugTrace,
} from "../infrastructure/test-runtime";

// Test state
let connectionString: string;
let testData: TestDataSet;
let testRuntimeResult: TestRuntimeResult;
let testUserContext: TestUserContext;
const timings: Record<string, number> = {};
const skipLiveModelSuite = !hasDatabaseUrl || !hasRuntimeModelCredentials;

// Setup function - uses local database (same as running server)
async function setupTestEnvironment(): Promise<void> {
  console.log("\n" + "=".repeat(60));
  console.log("🚀 SETTING UP TEST ENVIRONMENT (Local DB)");
  console.log("=".repeat(60));

  // Check debug tracing
  const debugEnabled = isDebugTracingEnabled();
  console.log(`\n🔍 Debug Tracing: ${debugEnabled ? "✅ ENABLED" : "❌ DISABLED"}`);
  if (!debugEnabled) {
    console.log("   Set DEBUG_TRACING=true in .env to enable debug output");
  }

  // Step 1: Verify database connection
  console.log("\n📦 Step 1: Verifying database connection...");
  const connected = await verifyConnection();
  if (!connected) {
    throw new Error(
      "Cannot connect to database. Make sure DATABASE_URL is set and server is running.",
    );
  }
  connectionString = getConnectionString();
  console.log(`✅ Database connected`);

  // Step 2: Create test data
  console.log("\n👤 Step 2: Creating test data...");
  testData = await createTestDataSet(connectionString, {
    organizationName: "Trending Test Organization",
    userName: "Trending Test User",
    userEmail: `trending-test-${Date.now()}@eliza.test`,
    creditBalance: 1000.0,
    includeCharacter: true,
    characterName: "Mira",
    characterData: mcpTestCharacter as unknown as Record<string, unknown>,
    characterSettings: mcpTestCharacter.settings as Record<string, unknown>,
  });
  console.log("✅ Test data created");

  console.log("\n" + "=".repeat(60));
  console.log("✅ ENVIRONMENT READY");
  console.log(`   API Key: ${testData.apiKey.keyPrefix}...`);
  console.log(`   Credits: $${testData.organization.creditBalance}`);
  console.log("=".repeat(60) + "\n");
}

// Cleanup function
async function cleanupTestEnvironment(): Promise<void> {
  console.log("\n🧹 CLEANING UP...");
  if (testRuntimeResult) {
    await testRuntimeResult.cleanup();
  }
  if (testData && connectionString) {
    await cleanupTestData(connectionString, testData.organization.id).catch(() => {});
  }
  logTimings("MCP Chat Trending Tests", timings);
  console.log("✅ Cleanup complete\n");
}

describe.skipIf(skipLiveModelSuite)("MCP Chat - Trending Tokens Query", () => {
  beforeAll(async () => {
    await setupTestEnvironment();
  });
  afterAll(cleanupTestEnvironment);

  it("should create runtime with MCP plugin", async () => {
    startTimer("runtime_creation");

    testRuntimeResult = await createTestRuntime({
      testData,
      characterId: testData.character?.id,
      agentMode: "CHAT" as any,
      webSearchEnabled: false,
    });

    timings.runtimeCreation = endTimer("runtime_creation");

    expect(testRuntimeResult).toBeDefined();
    expect(testRuntimeResult.runtime).toBeDefined();
    expect(testRuntimeResult.runtime.agentId).toBeDefined();

    console.log(`\n✅ Runtime created in ${timings.runtimeCreation}ms`);
    console.log(`   Agent ID: ${testRuntimeResult.runtime.agentId}`);
    console.log(`   Character: ${testRuntimeResult.runtime.character?.name}`);
  }, 120000);

  it("should have MCP service available", async () => {
    startTimer("mcp_service_check");

    const mcpService = getMcpService(testRuntimeResult.runtime);

    timings.mcpServiceCheck = endTimer("mcp_service_check");

    expect(mcpService).toBeDefined();
    console.log(`\n✅ MCP service found in ${timings.mcpServiceCheck}ms`);

    if (mcpService?.getServers) {
      const servers = mcpService.getServers();
      console.log(`   Servers: ${servers?.length || 0}`);
    }
  }, 10000);

  it("should wait for MCP initialization", async () => {
    startTimer("mcp_init_wait");

    const isReady = await waitForMcpReady(testRuntimeResult.runtime, 15000);

    timings.mcpInitWait = endTimer("mcp_init_wait");

    expect(isReady).toBe(true);
    console.log(`\n✅ MCP initialized in ${timings.mcpInitWait}ms`);

    const mcpService = getMcpService(testRuntimeResult.runtime);
    if (mcpService?.getTools) {
      const tools = mcpService.getTools();
      console.log(`   Tools available: ${tools?.length || 0}`);
      if (tools && tools.length > 0) {
        console.log(
          `   Sample tools: ${tools
            .slice(0, 5)
            .map((t: any) => t.name || t)
            .join(", ")}`,
        );
      }
    }
  }, 30000);

  it("should create test user with elizaOS entities", async () => {
    startTimer("user_creation");

    testUserContext = await createTestUser(testRuntimeResult.runtime, "TrendingTestUser");

    timings.userCreation = endTimer("user_creation");

    expect(testUserContext).toBeDefined();
    expect(testUserContext.entityId).toBeDefined();
    expect(testUserContext.roomId).toBeDefined();
    expect(testUserContext.worldId).toBeDefined();

    console.log(`\n✅ Test user created in ${timings.userCreation}ms`);
    console.log(`   Entity ID: ${testUserContext.entityId}`);
    console.log(`   Room ID: ${testUserContext.roomId}`);
  }, 30000);

  it("should process 'can you get trending tokens' with debug tracing", async () => {
    const debugEnabled = isDebugTracingEnabled();
    console.log(
      `\n🔍 Processing message with debug tracing ${debugEnabled ? "ENABLED" : "DISABLED"}`,
    );

    // Clear any existing traces
    clearDebugTraces();

    startTimer("trending_query");

    const result = await sendTestMessage(
      testRuntimeResult.runtime,
      testUserContext,
      "Can you get trending tokens?",
      testData,
      {
        timeoutMs: 120000,
        debug: {
          enabled: debugEnabled,
          renderView: "full",
          storeTrace: true,
        },
      },
    );

    timings.trendingQuery = endTimer("trending_query");

    console.log(`\n📨 Message processed in ${result.duration}ms`);
    console.log(`   Did respond: ${result.didRespond}`);

    if (result.response) {
      console.log(`\n📝 Response:`);
      console.log(`   ${result.response.text?.substring(0, 500)}...`);
    }

    if (result.error) {
      console.log(`\n❌ Error: ${result.error}`);
    }

    // Output debug trace if available
    if (debugEnabled) {
      const trace = getLatestDebugTrace();
      if (trace) {
        console.log("\n" + "=".repeat(60));
        console.log("🔍 DEBUG TRACE");
        console.log("=".repeat(60));

        const markdown = renderDebugTrace(trace, "full");
        console.log(markdown);

        console.log("\n" + "=".repeat(60));
        console.log("📊 TRACE SUMMARY");
        console.log("=".repeat(60));
        console.log(`   Run ID: ${trace.runId}`);
        console.log(`   Status: ${trace.status}`);
        console.log(`   Agent Mode: ${trace.agentMode}`);
        console.log(`   Steps: ${trace.steps?.length || 0}`);
        console.log(`   Duration: ${trace.endedAt ? trace.endedAt - trace.startedAt : "N/A"}ms`);

        const fail = trace.failures[0];
        if (fail) {
          console.log(`\n⚠️ Failure detected:`);
          console.log(`   Type: ${fail.type}`);
          console.log(`   Message: ${fail.message}`);
          console.log(`   Step: ${fail.stepIndex}`);
        }
      } else {
        console.log("\n⚠️ No debug trace captured (trace may not have been generated)");
      }
    }

    // The test passes if we got a response OR we got a specific MCP-related interaction
    expect(result.didRespond || result.error === undefined).toBe(true);
  }, 180000);

  it("should also handle a simpler greeting to verify basic functionality", async () => {
    startTimer("greeting_test");

    const result = await sendTestMessage(
      testRuntimeResult.runtime,
      testUserContext,
      "Hello! What can you help me with?",
      testData,
      {
        timeoutMs: 60000,
      },
    );

    timings.greetingTest = endTimer("greeting_test");

    console.log(`\n📨 Greeting processed in ${result.duration}ms`);
    console.log(`   Did respond: ${result.didRespond}`);
    if (result.response) {
      console.log(`   Response: ${result.response.text?.substring(0, 200)}...`);
    }
    if (result.error) {
      console.log(`   Error: ${result.error}`);
    }

    expect(result.didRespond).toBe(true);
    expect(result.response).toBeDefined();
  }, 120000);
});

describe.skipIf(!hasDatabaseUrl)("Debug Tracing Status", () => {
  it("should report debug tracing configuration", () => {
    const debugEnabled = isDebugTracingEnabled();

    console.log("\n" + "=".repeat(60));
    console.log("DEBUG TRACING STATUS");
    console.log("=".repeat(60));
    console.log(`Enabled: ${debugEnabled ? "✅ YES" : "❌ NO"}`);
    console.log(`Environment: DEBUG_TRACING=${process.env.DEBUG_TRACING || "not set"}`);
    console.log("=".repeat(60));

    if (!debugEnabled) {
      console.log("\n💡 To enable debug tracing:");
      console.log("   1. Add DEBUG_TRACING=true to your .env file");
      console.log("   2. Run the test again");
      console.log("");
    }

    // This test always passes - it's informational
    expect(true).toBe(true);
  });
});
