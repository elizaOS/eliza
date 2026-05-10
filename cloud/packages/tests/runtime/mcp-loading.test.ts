/**
 * MCP Plugin Loading Tests
 *
 * Tests the full production flow for loading a character with MCP plugin.
 * Uses local database (same as running server).
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mcpTestCharacter } from "../fixtures/mcp-test-character";
import {
  AgentMode,
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
    organizationName: "MCP Test Organization",
    userName: "MCP Test User",
    userEmail: `mcp-test-${Date.now()}@eliza.test`,
    creditBalance: 1000.0,
    includeCharacter: true,
    characterName: "Mira",
    characterData: { ...mcpTestCharacter },
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
  logTimings("MCP Loading Tests", timings);
  console.log("✅ Cleanup complete\n");
}

describe.skipIf(skipLiveModelSuite)("MCP Plugin Loading - Production Flow", () => {
  beforeAll(setupTestEnvironment);
  afterAll(cleanupTestEnvironment);

  it("should create runtime with MCP plugin using RuntimeFactory", async () => {
    startTimer("runtime_creation");

    testRuntimeResult = await createTestRuntime({
      testData,
      characterId: testData.character?.id,
      agentMode: AgentMode.CHAT,
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
    }
  }, 30000);

  it("should create test user with elizaOS entities", async () => {
    startTimer("user_creation");

    testUserContext = await createTestUser(testRuntimeResult.runtime, "MCPTestUser");

    timings.userCreation = endTimer("user_creation");

    expect(testUserContext).toBeDefined();
    expect(testUserContext.entityId).toBeDefined();
    expect(testUserContext.roomId).toBeDefined();
    expect(testUserContext.worldId).toBeDefined();

    console.log(`\n✅ Test user created in ${timings.userCreation}ms`);
    console.log(`   Entity ID: ${testUserContext.entityId}`);
    console.log(`   Room ID: ${testUserContext.roomId}`);
  }, 30000);

  it("should process a message through the runtime", async () => {
    startTimer("message_processing");

    const result = await sendTestMessage(
      testRuntimeResult.runtime,
      testUserContext,
      "Hello! What can you help me with?",
      testData,
      {
        timeoutMs: 60000,
      },
    );

    timings.messageProcessing = endTimer("message_processing");

    console.log(`\n📨 Message processed in ${result.duration}ms`);
    console.log(`   Did respond: ${result.didRespond}`);
    if (result.response) {
      console.log(`   Response: ${result.response.text?.substring(0, 100)}...`);
    }
    if (result.error) {
      console.log(`   Error: ${result.error}`);
    }

    expect(result.didRespond).toBe(true);
    expect(result.response).toBeDefined();
    expect(result.error).toBeUndefined();
  }, 120000);
});
