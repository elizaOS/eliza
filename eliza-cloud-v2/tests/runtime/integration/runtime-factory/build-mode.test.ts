/**
 * RuntimeFactory - BUILD Mode Integration Tests
 *
 * Tests the production RuntimeFactory in BUILD mode (character building).
 * This is a self-contained test file with its own setup/teardown.
 *
 * Run with: bun test tests/runtime/integration/runtime-factory/build-mode.test.ts
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
let runtime: TestRuntime;
let testUser: TestUserContext;
const timings: Record<string, number> = {};

describe("RuntimeFactory - BUILD Mode", () => {
  beforeAll(async () => {
    console.log("\n" + "=".repeat(60));
    console.log("SETTING UP BUILD MODE TEST ENVIRONMENT");
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
      organizationName: "BUILD Mode Test Org",
      userName: "BUILD Mode Test User",
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
    console.log("\nCleaning up BUILD mode test...");
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
    logTimings("BUILD Mode Tests", timings);
  });

  it("should create runtime in BUILD mode", async () => {
    startTimer("build_runtime_create");

    const userContext = buildUserContext(testData, {
      agentMode: AgentMode.BUILD,
      characterId: testData.character?.id,
      webSearchEnabled: false,
    });

    runtime = await runtimeFactory.createRuntimeForUser(userContext);

    timings.buildRuntimeCreate = endTimer("build_runtime_create");

    expect(runtime).toBeDefined();
    console.log(`\nBUILD runtime created in ${timings.buildRuntimeCreate}ms`);
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
    timings.buildMessage = endTimer("build_message");

    expect(result.didRespond).toBe(true);
    console.log(`\nBUILD message processed in ${timings.buildMessage}ms`);
    console.log(`   Response: ${result.response?.text?.substring(0, 80)}...`);
  }, 180000);

  it("should cleanup BUILD runtime", async () => {
    await invalidateRuntime(runtime.agentId as string);
  });
});
