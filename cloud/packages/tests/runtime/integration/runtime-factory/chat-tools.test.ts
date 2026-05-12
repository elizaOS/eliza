/**
 * RuntimeFactory - CHAT Mode Integration Tests
 *
 * Tests the production RuntimeFactory in CHAT mode with MCP and web search.
 * This is a self-contained test file with its own setup/teardown.
 *
 * Run with: bun test tests/runtime/integration/runtime-factory/chat-tools.test.ts
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mcpTestCharacter } from "../../../fixtures/mcp-test-character";
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
  // Local database
  hasDatabaseUrl,
  hasRuntimeModelCredentials,
  invalidateRuntime,
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
} from "../../../infrastructure";

// ============================================================================
// Local Test State (isolated to this file)
// ============================================================================

let connectionString: string;
let testData: TestDataSet;
const timings: Record<string, number> = {};
const skipLiveModelSuite = !hasDatabaseUrl || !hasRuntimeModelCredentials;

// ============================================================================
// CHAT Mode with MCP Tests
// ============================================================================

describe.skipIf(skipLiveModelSuite)("RuntimeFactory - CHAT Mode (MCP)", () => {
  let runtime: TestRuntime;
  let testUser: TestUserContext;

  beforeAll(async () => {
    console.log("\n" + "=".repeat(60));
    console.log("SETTING UP CHAT MODE (MCP) TEST ENVIRONMENT");
    console.log("=".repeat(60));

    // Verify database connection
    const connected = await verifyConnection();
    if (!connected) {
      throw new Error(
        "Cannot connect to database. Make sure DATABASE_URL is set and server is running.",
      );
    }
    connectionString = getConnectionString();
    console.log("Database connected");

    // Create test data with unique identifiers
    testData = await createTestDataSet(connectionString, {
      organizationName: "CHAT MCP Test Org",
      userName: "CHAT MCP Test User",
      userEmail: `chat-mcp-test-${Date.now()}@eliza.test`,
      creditBalance: 1000.0,
      includeCharacter: true,
      characterName: "Mira",
      characterData: { ...mcpTestCharacter },
      characterSettings: mcpTestCharacter.settings as Record<string, unknown>,
    });
    console.log("Test data created");
    console.log(`   API Key: ${testData.apiKey.keyPrefix}...`);
    console.log(`   Credits: $${testData.organization.creditBalance}`);
    console.log("=".repeat(60) + "\n");
  }, 60000);

  afterAll(async () => {
    console.log("\nCleaning up CHAT Mode (MCP) test...");
    if (runtime) {
      await invalidateRuntime(runtime.agentId as string).catch((err) =>
        console.warn(`Runtime cleanup warning: ${err}`),
      );
    }
    if (testData && connectionString) {
      await cleanupTestData(connectionString, testData.organization.id).catch((err) =>
        console.warn(`Data cleanup warning: ${err}`),
      );
    }
    logTimings("CHAT Mode (MCP) Tests", timings);
  });

  it("should create runtime in CHAT mode with MCP", async () => {
    startTimer("chat_tools_runtime_create");

    const userContext = buildUserContext(testData, {
      agentMode: AgentMode.CHAT,
      characterId: testData.character?.id,
      webSearchEnabled: false, // Isolate MCP testing
    });

    runtime = await runtimeFactory.createRuntimeForUser(userContext);

    timings.chatToolsRuntimeCreate = endTimer("chat_tools_runtime_create");

    expect(runtime).toBeDefined();
    expect(runtime.character?.name).toBe("Mira");
    console.log(`\nCHAT runtime created in ${timings.chatToolsRuntimeCreate}ms`);
  }, 60000);

  it("should have MCP service initialized", async () => {
    startTimer("mcp_init");
    const isReady = await waitForMcpReady(runtime, 15000);
    timings.mcpInit = endTimer("mcp_init");

    expect(isReady).toBe(true);

    const mcpService = getMcpService(runtime);
    expect(mcpService).toBeDefined();

    const tools = mcpService?.getTools?.();
    console.log(`\nMCP ready in ${timings.mcpInit}ms`);
    console.log(`   Tools: ${tools?.length || 0}`);
  }, 30000);

  it("should process message with MCP tools available", async () => {
    testUser = await createTestUser(runtime, "ChatToolsTestUser");

    startTimer("chat_tools_message");
    const result = await sendTestMessage(
      runtime,
      testUser,
      "What's the current price of Bitcoin?",
      testData,
      { timeoutMs: 120000 },
    );
    timings.chatToolsMessage = endTimer("chat_tools_message");

    expect(result.didRespond).toBe(true);
    console.log(`\nCHAT message processed in ${timings.chatToolsMessage}ms`);
    console.log(`   Response: ${result.response?.text?.substring(0, 80)}...`);
  }, 180000);

  it("should cleanup CHAT runtime", async () => {
    await invalidateRuntime(runtime.agentId as string);
  });
});

// ============================================================================
// CHAT Mode with Web Search Tests
// ============================================================================

describe.skipIf(skipLiveModelSuite)("RuntimeFactory - CHAT Mode (Web Search)", () => {
  let runtime: TestRuntime;
  let testUser: TestUserContext;
  let localConnectionString: string;
  let localTestData: TestDataSet;
  const localTimings: Record<string, number> = {};

  beforeAll(async () => {
    console.log("\n" + "=".repeat(60));
    console.log("SETTING UP CHAT MODE (WEB SEARCH) TEST ENVIRONMENT");
    console.log("=".repeat(60));

    // Verify database connection
    const connected = await verifyConnection();
    if (!connected) {
      throw new Error(
        "Cannot connect to database. Make sure DATABASE_URL is set and server is running.",
      );
    }
    localConnectionString = getConnectionString();
    console.log("Database connected");

    // Create test data with unique identifiers
    localTestData = await createTestDataSet(localConnectionString, {
      organizationName: "CHAT WebSearch Test Org",
      userName: "CHAT WebSearch Test User",
      userEmail: `chat-websearch-test-${Date.now()}@eliza.test`,
      creditBalance: 1000.0,
      includeCharacter: true,
      characterName: "Mira",
      characterData: { ...mcpTestCharacter },
      characterSettings: mcpTestCharacter.settings as Record<string, unknown>,
    });
    console.log("Test data created");
    console.log(`   API Key: ${localTestData.apiKey.keyPrefix}...`);
    console.log(`   Credits: $${localTestData.organization.creditBalance}`);
    console.log("=".repeat(60) + "\n");
  }, 60000);

  afterAll(async () => {
    console.log("\nCleaning up CHAT Mode (Web Search) test...");
    if (runtime) {
      await invalidateRuntime(runtime.agentId as string).catch((err) =>
        console.warn(`Runtime cleanup warning: ${err}`),
      );
    }
    if (localTestData && localConnectionString) {
      await cleanupTestData(localConnectionString, localTestData.organization.id).catch((err) =>
        console.warn(`Data cleanup warning: ${err}`),
      );
    }
    logTimings("CHAT Mode (Web Search) Tests", localTimings);
  });

  it("should create runtime with web search enabled", async () => {
    startTimer("websearch_runtime_create");

    const userContext = buildUserContext(localTestData, {
      agentMode: AgentMode.CHAT,
      webSearchEnabled: true,
    });

    runtime = await runtimeFactory.createRuntimeForUser(userContext);

    localTimings.webSearchRuntimeCreate = endTimer("websearch_runtime_create");

    expect(runtime).toBeDefined();
    console.log(`\nWeb Search runtime created in ${localTimings.webSearchRuntimeCreate}ms`);
  }, 60000);

  it("should process message with web search", async () => {
    testUser = await createTestUser(runtime, "WebSearchTestUser");

    startTimer("websearch_message");
    const result = await sendTestMessage(
      runtime,
      testUser,
      "What is the latest news about AI?",
      localTestData,
      { timeoutMs: 120000 },
    );
    localTimings.webSearchMessage = endTimer("websearch_message");

    expect(result.didRespond).toBe(true);
    console.log(`\nWeb Search message processed in ${localTimings.webSearchMessage}ms`);
  }, 180000);

  it("should cleanup web search runtime", async () => {
    await invalidateRuntime(runtime.agentId as string);
  });
});
