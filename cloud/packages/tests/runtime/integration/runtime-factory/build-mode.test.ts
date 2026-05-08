/**
 * RuntimeFactory - CHAT Mode Integration Tests
 *
 * Tests the production RuntimeFactory in CHAT mode (character building).
 * This is a self-contained test file with its own setup/teardown.
 *
 * Run with: bun test tests/runtime/integration/runtime-factory/build-mode.test.ts
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
} from "../../../infrastructure";

// ============================================================================
// Local Test State (isolated to this file)
// ============================================================================

let connectionString: string;
let testData: TestDataSet;
let runtime: TestRuntime;
let testUser: TestUserContext;
const timings: Record<string, number> = {};
const skipLiveModelSuite = !hasDatabaseUrl || !hasRuntimeModelCredentials;

describe.skipIf(skipLiveModelSuite)("RuntimeFactory - CHAT Mode", () => {
  beforeAll(async () => {
    console.log("\n" + "=".repeat(60));
    console.log("SETTING UP CHAT MODE TEST ENVIRONMENT");
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
      organizationName: "CHAT Mode Test Org",
      userName: "CHAT Mode Test User",
      userEmail: `build-mode-test-${Date.now()}@eliza.test`,
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
    console.log("\nCleaning up CHAT mode test...");
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
    logTimings("CHAT Mode Tests", timings);
  });

  it("should create runtime in CHAT mode", async () => {
    startTimer("build_runtime_create");

    const userContext = buildUserContext(testData, {
      agentMode: AgentMode.CHAT,
      characterId: testData.character?.id,
      webSearchEnabled: false,
    });

    runtime = await runtimeFactory.createRuntimeForUser(userContext);

    timings.buildRuntimeCreate = endTimer("build_runtime_create");

    expect(runtime).toBeDefined();
    console.log(`\nCHAT runtime created in ${timings.buildRuntimeCreate}ms`);
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
    timings.buildMessage = endTimer("build_message");

    expect(result.didRespond).toBe(true);
    console.log(`\nCHAT message processed in ${timings.buildMessage}ms`);
    console.log(`   Response: ${result.response?.text?.substring(0, 80)}...`);
  }, 180000);

  it("should cleanup CHAT runtime", async () => {
    await invalidateRuntime(runtime.agentId as string);
  });
});
