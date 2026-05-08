/**
 * CloudBootstrapMessageService - Web Search Multi-Step Integration Tests
 *
 * Tests the full native planner execution flow with real:
 * - Runtime with CloudBootstrapMessageService
 * - Web search action (hosted Google grounding)
 * - Claude Sonnet for LLM calls
 * - Real queries about ETH, HYPERLIQUID, etc.
 *
 * NOTE: These tests make real API calls and can take 2-3 minutes per test.
 * Set TEST_TIMEOUT=600000 for longer timeouts if needed.
 *
 * Run with: bun test tests/runtime/integration/cloud-bootstrap/web-search-native planner.test.ts --timeout 600000
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import {
  AgentMode,
  buildUserContext,
  cleanupTestData,
  createTestDataSet,
  createTestUser,
  endTimer,
  getConnectionString,
  hasDatabaseUrl,
  hasRuntimeModelCredentials,
  invalidateRuntime,
  logTimings,
  runtimeFactory,
  sendTestMessage,
  startTimer,
  type TestDataSet,
  type TestRuntime,
  type TestUserContext,
  verifyConnection,
} from "../../../infrastructure";

// Character with web search enabled
const skipLiveModelSuite = !hasDatabaseUrl || !hasRuntimeModelCredentials;

const webSearchCharacter = {
  id: "web-search-test-agent-001",
  name: "CryptoResearcher",
  system: `You are CryptoResearcher, a knowledgeable assistant specializing in cryptocurrency and blockchain research.

Your capabilities:
- Search the web for current crypto news and market information
- Analyze and summarize findings from multiple sources
- Provide accurate, up-to-date information about tokens, protocols, and market trends

When a user asks about crypto topics:
1. Use WEB_SEARCH to find current information
2. Synthesize the results into a clear, informative response
3. Include specific details like prices, dates, and sources when available

Be direct and informative. Focus on facts from your searches.`,
  bio: "A crypto research assistant that uses web search to provide current market information.",
  messageExamples: [
    [
      {
        name: "{{user1}}",
        content: { text: "What's the latest news about Ethereum?" },
      },
      {
        name: "CryptoResearcher",
        content: {
          text: "Let me search for the latest Ethereum news for you.",
          actions: ["WEB_SEARCH"],
        },
      },
    ],
  ],
  plugins: [],
  settings: {
    webSearch: { enabled: true },
  },
  style: {
    all: [
      "Be informative and precise",
      "Cite sources when possible",
      "Focus on facts from search results",
    ],
  },
};

let connectionString: string;
let testData: TestDataSet;
let runtime: TestRuntime;
let testUser: TestUserContext;
const timings: Record<string, number> = {};

describe.skipIf(skipLiveModelSuite)("CloudBootstrapMessageService - Web Search Multi-Step", () => {
  beforeAll(async () => {
    console.log("\n" + "=".repeat(70));
    console.log("MULTI-STEP WEB SEARCH INTEGRATION TESTS");
    console.log("Using Claude Sonnet + Real Web Search (Google grounding)");
    console.log("=".repeat(70));

    const connected = await verifyConnection();
    if (!connected) {
      throw new Error("Cannot connect to database. Ensure server is running.");
    }
    connectionString = getConnectionString();
    console.log("✓ Database connected");

    testData = await createTestDataSet(connectionString, {
      organizationName: "Web Search Multi-Step Test Org",
      userName: "Web Search Test User",
      userEmail: `web-search-multistep-${Date.now()}@eliza.test`,
      creditBalance: 100.0,
      includeCharacter: true,
      characterName: webSearchCharacter.name,
      characterData: webSearchCharacter as Record<string, unknown>,
      characterSettings: webSearchCharacter.settings as Record<string, unknown>,
    });

    console.log(`✓ Test data created`);
    console.log(`   API Key: ${testData.apiKey.keyPrefix}...`);
    console.log(`   Credits: $${testData.organization.creditBalance}`);
    console.log("=".repeat(70) + "\n");
  }, 60000);

  afterAll(async () => {
    console.log("\n" + "=".repeat(70));
    console.log("CLEANING UP");
    console.log("=".repeat(70));

    if (runtime) {
      await invalidateRuntime(runtime.agentId as string).catch((err) =>
        console.warn(`Runtime cleanup: ${err}`),
      );
    }
    if (testData && connectionString) {
      await cleanupTestData(connectionString, testData.organization.id).catch((err) =>
        console.warn(`Data cleanup: ${err}`),
      );
    }
    logTimings("Web Search Multi-Step Tests", timings);
  });

  describe("Runtime Setup with Web Search", () => {
    it("should create runtime with Claude Sonnet and web search enabled", async () => {
      startTimer("runtime_create");

      const userContext = buildUserContext(testData, {
        agentMode: AgentMode.CHAT,
        characterId: testData.character?.id,
        webSearchEnabled: true,
        modelPreferences: {
          smallModel: "anthropic/claude-sonnet-4.6",
          largeModel: "anthropic/claude-sonnet-4.6",
        },
      });

      runtime = await runtimeFactory.createRuntimeForUser(userContext);
      timings.runtimeCreate = endTimer("runtime_create");

      expect(runtime).toBeDefined();
      expect(runtime.character?.name).toBe("CryptoResearcher");

      // Verify CloudBootstrapMessageService is installed
      const serviceName = runtime.messageService?.constructor?.name;
      console.log(`\n✓ Runtime created in ${timings.runtimeCreate}ms`);
      console.log(`   Character: ${runtime.character?.name}`);
      console.log(`   Message Service: ${serviceName}`);
      console.log(`   Agent ID: ${runtime.agentId}`);

      expect(serviceName).toBe("CloudBootstrapMessageService");
    }, 120000);

    it("should verify web search service is available", async () => {
      const webSearchService = runtime.getService("WEB_SEARCH");
      expect(webSearchService).toBeDefined();
      console.log("✓ Web search service initialized");
    }, 10000);

    it("should create test user with entities", async () => {
      startTimer("user_create");
      testUser = await createTestUser(runtime, "WebSearchTestUser");
      timings.userCreate = endTimer("user_create");

      expect(testUser.entityId).toBeDefined();
      expect(testUser.roomId).toBeDefined();

      console.log(`\n✓ Test user created in ${timings.userCreate}ms`);
      console.log(`   Entity ID: ${testUser.entityId}`);
      console.log(`   Room ID: ${testUser.roomId}`);
    }, 30000);
  });

  describe("Web Search Action Execution", () => {
    it("should search for Ethereum news and return real results", async () => {
      console.log("\n" + "-".repeat(50));
      console.log("TEST: Search for Ethereum news");
      console.log("-".repeat(50));

      startTimer("eth_search");
      const result = await sendTestMessage(
        runtime,
        testUser,
        "What is the latest news about Ethereum? Search for recent ETH updates.",
        testData,
        { timeoutMs: 300000 }, // 5 minutes - real API calls take time
      );
      timings.ethSearch = endTimer("eth_search");

      console.log(`\nDuration: ${timings.ethSearch}ms`);
      console.log(`Did respond: ${result.didRespond}`);

      if (result.response?.text) {
        console.log(`\nResponse (${result.response.text.length} chars):`);
        console.log("-".repeat(40));
        console.log(result.response.text.substring(0, 500));
        if (result.response.text.length > 500) {
          console.log("... [truncated]");
        }
        console.log("-".repeat(40));
      }

      if (result.error) {
        console.log(`Error: ${result.error}`);
      }

      expect(result.didRespond).toBe(true);
      expect(result.response).toBeDefined();
      expect(result.response?.text).toBeTruthy();
      expect(result.response?.text?.length).toBeGreaterThan(50);

      // Verify response contains relevant content
      const responseText = result.response?.text?.toLowerCase() || "";
      const hasEthContent =
        responseText.includes("ethereum") ||
        responseText.includes("eth") ||
        responseText.includes("blockchain") ||
        responseText.includes("crypto");
      expect(hasEthContent).toBe(true);
    }, 360000); // 6 minute timeout

    it("should search for Hyperliquid news with finance topic", async () => {
      console.log("\n" + "-".repeat(50));
      console.log("TEST: Search for Hyperliquid news");
      console.log("-".repeat(50));

      startTimer("hype_search");
      const result = await sendTestMessage(
        runtime,
        testUser,
        "Search the web for the latest Hyperliquid news and updates. What's happening with HYPE token?",
        testData,
        { timeoutMs: 300000 },
      );
      timings.hypeSearch = endTimer("hype_search");

      console.log(`\nDuration: ${timings.hypeSearch}ms`);
      console.log(`Did respond: ${result.didRespond}`);

      if (result.response?.text) {
        console.log(`\nResponse (${result.response.text.length} chars):`);
        console.log("-".repeat(40));
        console.log(result.response.text.substring(0, 500));
        if (result.response.text.length > 500) {
          console.log("... [truncated]");
        }
        console.log("-".repeat(40));
      }

      expect(result.didRespond).toBe(true);
      expect(result.response?.text).toBeTruthy();
    }, 360000);
  });
});
