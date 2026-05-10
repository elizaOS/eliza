/**
 * Message Handler - Basic Message Integration Tests
 *
 * Tests the production message handler with basic message processing.
 * This is a self-contained test file with its own setup/teardown.
 *
 * Run with: bun test tests/runtime/integration/message-handler/basic-message.test.ts
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mcpTestCharacter } from "../../../fixtures/mcp-test-character";
import {
  AgentMode,
  cleanupTestData,
  // Test data
  createTestDataSet,
  // Test runtime
  createTestRuntime,
  createTestUser,
  endTimer,
  getConnectionString,
  // Local database
  hasDatabaseUrl,
  hasRuntimeModelCredentials,
  logTimings,
  sendTestMessage,
  // Timing
  startTimer,
  type TestDataSet,
  type TestRuntimeResult,
  type TestUserContext,
  verifyConnection,
} from "../../../infrastructure";

// ============================================================================
// Local Test State (isolated to this file)
// ============================================================================

let connectionString: string;
let testData: TestDataSet;
let testRuntimeResult: TestRuntimeResult;
let testUserContext: TestUserContext;
const timings: Record<string, number> = {};
const skipLiveModelSuite = !hasDatabaseUrl || !hasRuntimeModelCredentials;

describe.skipIf(skipLiveModelSuite)("Message Handler - Basic Message Processing", () => {
  beforeAll(async () => {
    console.log("\n" + "=".repeat(60));
    console.log("SETTING UP BASIC MESSAGE TEST ENVIRONMENT");
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
      organizationName: "Basic Message Test Org",
      userName: "Basic Message Test User",
      userEmail: `basic-message-test-${Date.now()}@eliza.test`,
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
    console.log("\nCleaning up basic message test...");
    if (testRuntimeResult) {
      await testRuntimeResult.cleanup();
    }
    if (testData && connectionString) {
      await cleanupTestData(connectionString, testData.organization.id).catch((err) =>
        console.warn(`Data cleanup warning: ${err}`),
      );
    }
    logTimings("Basic Message Tests", timings);
  });

  it("should create runtime for message testing", async () => {
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

    console.log(`\nRuntime created in ${timings.runtimeCreation}ms`);
    console.log(`   Agent ID: ${testRuntimeResult.runtime.agentId}`);
    console.log(`   Character: ${testRuntimeResult.runtime.character?.name}`);
  }, 120000);

  it("should create test user with elizaOS entities", async () => {
    startTimer("user_creation");

    testUserContext = await createTestUser(testRuntimeResult.runtime, "BasicMessageTestUser");

    timings.userCreation = endTimer("user_creation");

    expect(testUserContext).toBeDefined();
    expect(testUserContext.entityId).toBeDefined();
    expect(testUserContext.roomId).toBeDefined();
    expect(testUserContext.worldId).toBeDefined();

    console.log(`\nTest user created in ${timings.userCreation}ms`);
    console.log(`   Entity ID: ${testUserContext.entityId}`);
    console.log(`   Room ID: ${testUserContext.roomId}`);
  }, 30000);

  it("should process a simple greeting message", async () => {
    startTimer("greeting_message");

    const result = await sendTestMessage(
      testRuntimeResult.runtime,
      testUserContext,
      "Hello! How are you?",
      testData,
      {
        timeoutMs: 60000,
      },
    );

    timings.greetingMessage = endTimer("greeting_message");

    console.log(`\nGreeting processed in ${result.duration}ms`);
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

  it("should process a question message", async () => {
    startTimer("question_message");

    const result = await sendTestMessage(
      testRuntimeResult.runtime,
      testUserContext,
      "What can you help me with?",
      testData,
      {
        timeoutMs: 60000,
      },
    );

    timings.questionMessage = endTimer("question_message");

    console.log(`\nQuestion processed in ${result.duration}ms`);
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

  it("should handle multiple messages in sequence", async () => {
    const messages = [
      "Tell me about yourself.",
      "What do you specialize in?",
      "Thanks for the help!",
    ];

    const results: Array<{
      message: string;
      didRespond: boolean;
      duration: number;
    }> = [];

    for (const message of messages) {
      startTimer(`seq_message_${results.length}`);
      const result = await sendTestMessage(
        testRuntimeResult.runtime,
        testUserContext,
        message,
        testData,
        {
          timeoutMs: 60000,
        },
      );
      const duration = endTimer(`seq_message_${results.length}`);
      results.push({ message, didRespond: result.didRespond, duration });
    }

    console.log("\nSequential message processing:");
    for (const r of results) {
      console.log(
        `   "${r.message.substring(0, 30)}..." - responded: ${r.didRespond}, ${r.duration}ms`,
      );
    }

    for (const r of results) {
      expect(r.didRespond).toBe(true);
    }
  }, 300000);
});
