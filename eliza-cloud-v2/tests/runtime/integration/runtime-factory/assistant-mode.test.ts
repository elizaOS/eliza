/**
 * RuntimeFactory - ASSISTANT Mode Integration Tests
 *
 * Tests the production RuntimeFactory in ASSISTANT mode with MCP and web search.
 * This is a self-contained test file with its own setup/teardown.
 *
 * Run with: bun test tests/runtime/integration/runtime-factory/assistant-mode.test.ts
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
} from "../../../infrastructure";
import { mcpTestCharacter } from "../../../fixtures/mcp-test-character";

// ============================================================================
// Local Test State (isolated to this file)
// ============================================================================

let connectionString: string;
let testData: TestDataSet;
const timings: Record<string, number> = {};

// ============================================================================
// ASSISTANT Mode with MCP Tests
// ============================================================================

describe("RuntimeFactory - ASSISTANT Mode (MCP)", () => {
  let runtime: TestRuntime;
  let testUser: TestUserContext;

  beforeAll(async () => {
    console.log("\n" + "=".repeat(60));
    console.log("SETTING UP ASSISTANT MODE (MCP) TEST ENVIRONMENT");
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
      organizationName: "ASSISTANT MCP Test Org",
      userName: "ASSISTANT MCP Test User",
      userEmail: `assistant-mcp-test-${Date.now()}@eliza.test`,
      creditBalance: 1000.0,
      includeCharacter: true,
      characterName: "Mira",
      characterData: mcpTestCharacter as unknown as Record<string, unknown>,
      characterSettings: mcpTestCharacter.settings as Record<string, unknown>,
    });
    console.log("Test data created");
    console.log(`   API Key: ${testData.apiKey.keyPrefix}...`);
    console.log(`   Credits: $${testData.organization.creditBalance}`);
    console.log("=".repeat(60) + "\n");
  }, 60000);

  afterAll(async () => {
    console.log("\nCleaning up ASSISTANT Mode (MCP) test...");
    if (runtime) {
      await invalidateRuntime(runtime.agentId as string).catch((err) =>
        console.warn(`Runtime cleanup warning: ${err}`),
      );
    }
    if (testData && connectionString) {
      await cleanupTestData(connectionString, testData.organization.id).catch(
        (err) => console.warn(`Data cleanup warning: ${err}`),
      );
    }
    logTimings("ASSISTANT Mode (MCP) Tests", timings);
  });

  it("should create runtime in ASSISTANT mode with MCP", async () => {
    startTimer("assistant_runtime_create");

    const userContext = buildUserContext(testData, {
      agentMode: AgentMode.ASSISTANT,
      characterId: testData.character?.id,
      webSearchEnabled: false, // Isolate MCP testing
    });

    runtime = await runtimeFactory.createRuntimeForUser(userContext);

    timings.assistantRuntimeCreate = endTimer("assistant_runtime_create");

    expect(runtime).toBeDefined();
    expect(runtime.character?.name).toBe("Mira");
    console.log(
      `\nASSISTANT runtime created in ${timings.assistantRuntimeCreate}ms`,
    );
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
    testUser = await createTestUser(runtime, "AssistantTestUser");

    startTimer("assistant_message");
    const result = await sendTestMessage(
      runtime,
      testUser,
      "What's the current price of Bitcoin?",
      testData,
      { timeoutMs: 120000 },
    );
    timings.assistantMessage = endTimer("assistant_message");

    expect(result.didRespond).toBe(true);
    console.log(
      `\nASSISTANT message processed in ${timings.assistantMessage}ms`,
    );
    console.log(`   Response: ${result.response?.text?.substring(0, 80)}...`);
  }, 180000);

  it("should cleanup ASSISTANT runtime", async () => {
    await invalidateRuntime(runtime.agentId as string);
  });
});

// ============================================================================
// ASSISTANT Mode with Web Search Tests
// ============================================================================

describe("RuntimeFactory - ASSISTANT Mode (Web Search)", () => {
  let runtime: TestRuntime;
  let testUser: TestUserContext;
  let localConnectionString: string;
  let localTestData: TestDataSet;
  const localTimings: Record<string, number> = {};

  beforeAll(async () => {
    console.log("\n" + "=".repeat(60));
    console.log("SETTING UP ASSISTANT MODE (WEB SEARCH) TEST ENVIRONMENT");
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
      organizationName: "ASSISTANT WebSearch Test Org",
      userName: "ASSISTANT WebSearch Test User",
      userEmail: `assistant-websearch-test-${Date.now()}@eliza.test`,
      creditBalance: 1000.0,
      includeCharacter: true,
      characterName: "Mira",
      characterData: mcpTestCharacter as unknown as Record<string, unknown>,
      characterSettings: mcpTestCharacter.settings as Record<string, unknown>,
    });
    console.log("Test data created");
    console.log(`   API Key: ${localTestData.apiKey.keyPrefix}...`);
    console.log(`   Credits: $${localTestData.organization.creditBalance}`);
    console.log("=".repeat(60) + "\n");
  }, 60000);

  afterAll(async () => {
    console.log("\nCleaning up ASSISTANT Mode (Web Search) test...");
    if (runtime) {
      await invalidateRuntime(runtime.agentId as string).catch((err) =>
        console.warn(`Runtime cleanup warning: ${err}`),
      );
    }
    if (localTestData && localConnectionString) {
      await cleanupTestData(
        localConnectionString,
        localTestData.organization.id,
      ).catch((err) => console.warn(`Data cleanup warning: ${err}`));
    }
    logTimings("ASSISTANT Mode (Web Search) Tests", localTimings);
  });

  it("should create runtime with web search enabled", async () => {
    startTimer("websearch_runtime_create");

    const userContext = buildUserContext(localTestData, {
      agentMode: AgentMode.ASSISTANT,
      webSearchEnabled: true,
    });

    runtime = await runtimeFactory.createRuntimeForUser(userContext);

    localTimings.webSearchRuntimeCreate = endTimer("websearch_runtime_create");

    expect(runtime).toBeDefined();
    console.log(
      `\nWeb Search runtime created in ${localTimings.webSearchRuntimeCreate}ms`,
    );
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
    console.log(
      `\nWeb Search message processed in ${localTimings.webSearchMessage}ms`,
    );
  }, 180000);

  it("should cleanup web search runtime", async () => {
    await invalidateRuntime(runtime.agentId as string);
  });
});
