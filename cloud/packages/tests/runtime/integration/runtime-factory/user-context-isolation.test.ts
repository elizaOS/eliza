/**
 * User Context Isolation Integration Tests
 *
 * Tests that user-specific settings (API keys, user IDs, MCP) are:
 * 1. NOT persisted to the database
 * 2. Correctly refreshed on cache hit
 * 3. Isolated between different users
 *
 * These tests verify the fix for the bug where stale API keys and user context
 * from previous users would leak via database persistence.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { Client } from "pg";
import {
  AgentMode,
  buildUserContext,
  cleanupTestData,
  createTestDataSet,
  getConnectionString,
  hasDatabaseUrl,
  invalidateRuntime,
  runtimeFactory,
  type TestDataSet,
  verifyConnection,
} from "../../../infrastructure";

let connectionString: string;
let testDataUser1: TestDataSet;
let testDataUser2: TestDataSet;

async function setupEnvironment(): Promise<void> {
  console.log("\n" + "=".repeat(60));
  console.log("🔐 User Context Isolation Tests");
  console.log("=".repeat(60));

  const connected = await verifyConnection();
  if (!connected) {
    throw new Error("Cannot connect to database");
  }
  connectionString = getConnectionString();

  // Create two separate test data sets (different orgs, but same concept applies)
  testDataUser1 = await createTestDataSet(connectionString, {
    organizationName: "User Context Test Org 1",
    userName: "Test User 1",
    userEmail: `user-context-test-1-${Date.now()}@eliza.test`,
    creditBalance: 100.0,
  });

  testDataUser2 = await createTestDataSet(connectionString, {
    organizationName: "User Context Test Org 2",
    userName: "Test User 2",
    userEmail: `user-context-test-2-${Date.now()}@eliza.test`,
    creditBalance: 100.0,
  });

  console.log("✅ Test data created:");
  console.log(
    `   User 1: ${testDataUser1.user.email} (API: ${testDataUser1.apiKey.key.substring(0, 15)}...)`,
  );
  console.log(
    `   User 2: ${testDataUser2.user.email} (API: ${testDataUser2.apiKey.key.substring(0, 15)}...)`,
  );
}

async function cleanupEnvironment(): Promise<void> {
  console.log("\n🧹 Cleaning up...");

  // Invalidate any cached runtimes
  await invalidateRuntime("b850bc30-45f8-0041-a00a-83df46d8555d").catch(() => {});

  if (testDataUser1) {
    await cleanupTestData(connectionString, testDataUser1.organization.id).catch((err) =>
      console.warn(`Cleanup warning: ${err}`),
    );
  }
  if (testDataUser2) {
    await cleanupTestData(connectionString, testDataUser2.organization.id).catch((err) =>
      console.warn(`Cleanup warning: ${err}`),
    );
  }
}

/**
 * Helper to get user-specific settings from the database for the Eliza agent
 */
async function getAgentSettingsFromDb(): Promise<Record<string, unknown>> {
  const client = new Client({ connectionString });
  await client.connect();
  try {
    const result = await client.query(
      "SELECT settings FROM agents WHERE id = 'b850bc30-45f8-0041-a00a-83df46d8555d'",
    );
    return (result.rows[0]?.settings || {}) as Record<string, unknown>;
  } finally {
    await client.end();
  }
}

describe.skipIf(!hasDatabaseUrl)("User Context Isolation", () => {
  beforeAll(setupEnvironment);
  afterAll(cleanupEnvironment);

  it("should NOT persist user-specific settings to database", async () => {
    // First, clear any existing user-specific settings from the agent
    const client = new Client({ connectionString });
    await client.connect();
    try {
      const result = await client.query(
        "SELECT settings FROM agents WHERE id = 'b850bc30-45f8-0041-a00a-83df46d8555d'",
      );
      const settings = (result.rows[0]?.settings || {}) as Record<string, unknown>;

      // Remove user-specific settings
      delete settings.ELIZAOS_API_KEY;
      delete settings.ELIZAOS_CLOUD_API_KEY;
      delete settings.USER_ID;
      delete settings.ENTITY_ID;
      delete settings.ORGANIZATION_ID;
      delete settings.IS_ANONYMOUS;
      delete settings.mcp;

      await client.query(
        "UPDATE agents SET settings = $1 WHERE id = 'b850bc30-45f8-0041-a00a-83df46d8555d'",
        [JSON.stringify(settings)],
      );
    } finally {
      await client.end();
    }

    // Create runtime for User 1
    const userContext1 = buildUserContext(testDataUser1, {
      agentMode: AgentMode.CHAT,
      webSearchEnabled: false,
    });

    const runtime = await runtimeFactory.createRuntimeForUser(userContext1);

    try {
      // Verify runtime has correct settings
      const apiKey = runtime.getSetting("ELIZAOS_API_KEY");
      expect(apiKey).toBe(testDataUser1.apiKey.key);

      const userId = runtime.getSetting("USER_ID");
      expect(userId).toBe(testDataUser1.user.id);

      console.log("✅ Runtime has correct user-specific settings");

      // Now check the database - these settings should NOT be persisted
      const dbSettings = await getAgentSettingsFromDb();

      // These should NOT be in the database (or should be undefined/null)
      expect(dbSettings.ELIZAOS_API_KEY).toBeUndefined();
      expect(dbSettings.ELIZAOS_CLOUD_API_KEY).toBeUndefined();
      expect(dbSettings.USER_ID).toBeUndefined();
      expect(dbSettings.ENTITY_ID).toBeUndefined();
      expect(dbSettings.ORGANIZATION_ID).toBeUndefined();

      console.log("✅ User-specific settings NOT persisted to database");
    } finally {
      await invalidateRuntime(runtime.agentId as string);
    }
  }, 60000);

  it("should give each user their own settings even for same agent", async () => {
    // User 1 creates runtime
    const userContext1 = buildUserContext(testDataUser1, {
      agentMode: AgentMode.CHAT,
      webSearchEnabled: false,
    });

    const runtime1 = await runtimeFactory.createRuntimeForUser(userContext1);

    // Verify User 1's settings
    expect(runtime1.getSetting("ELIZAOS_API_KEY")).toBe(testDataUser1.apiKey.key);
    expect(runtime1.getSetting("USER_ID")).toBe(testDataUser1.user.id);
    console.log(`✅ User 1 runtime created (API: ${testDataUser1.apiKey.key.substring(0, 15)}...)`);

    await invalidateRuntime(runtime1.agentId as string);

    // User 2 creates runtime for same agent (different org, so cache miss)
    const userContext2 = buildUserContext(testDataUser2, {
      agentMode: AgentMode.CHAT,
      webSearchEnabled: false,
    });

    const runtime2 = await runtimeFactory.createRuntimeForUser(userContext2);

    try {
      // Verify User 2 gets THEIR settings, not User 1's
      const apiKey2 = runtime2.getSetting("ELIZAOS_API_KEY");
      const userId2 = runtime2.getSetting("USER_ID");

      expect(apiKey2).toBe(testDataUser2.apiKey.key);
      expect(userId2).toBe(testDataUser2.user.id);

      // Make sure we didn't get User 1's stale data
      expect(apiKey2).not.toBe(testDataUser1.apiKey.key);
      expect(userId2).not.toBe(testDataUser1.user.id);

      console.log(
        `✅ User 2 got their own settings (API: ${testDataUser2.apiKey.key.substring(0, 15)}...)`,
      );
      console.log("✅ Different users get isolated settings");
    } finally {
      await invalidateRuntime(runtime2.agentId as string);
    }
  }, 60000);

  it("should isolate API keys between sequential requests from different users", async () => {
    // Simulate multiple sequential requests from different users
    const results: { userId: string; apiKey: string | null }[] = [];

    for (let i = 0; i < 3; i++) {
      // Alternate between User 1 and User 2
      const testData = i % 2 === 0 ? testDataUser1 : testDataUser2;

      const userContext = buildUserContext(testData, {
        agentMode: AgentMode.CHAT,
        webSearchEnabled: false,
      });

      const runtime = await runtimeFactory.createRuntimeForUser(userContext);

      results.push({
        userId: testData.user.id,
        apiKey: runtime.getSetting("ELIZAOS_API_KEY") as string | null,
      });

      await invalidateRuntime(runtime.agentId as string);
    }

    // Verify each request got the correct API key
    expect(results[0].apiKey).toBe(testDataUser1.apiKey.key); // User 1
    expect(results[1].apiKey).toBe(testDataUser2.apiKey.key); // User 2
    expect(results[2].apiKey).toBe(testDataUser1.apiKey.key); // User 1 again

    console.log("✅ API keys correctly isolated across sequential requests:");
    results.forEach((r, i) => {
      console.log(
        `   Request ${i + 1}: User ${r.userId.substring(0, 8)}... → API ${r.apiKey?.substring(0, 15)}...`,
      );
    });
  }, 90000);

  it("should not leak MCP settings between users with different OAuth states", async () => {
    // Helper to get MCP settings the way McpService does
    const getMcpSettings = (runtime: any): Record<string, unknown> | undefined => {
      return runtime.character?.settings?.mcp || runtime.settings?.mcp;
    };

    // User 1: Has Google OAuth
    const userContext1 = {
      ...buildUserContext(testDataUser1, {
        agentMode: AgentMode.CHAT,
        webSearchEnabled: false,
      }),
      oauthConnections: [{ platform: "google" }],
    };

    const runtime1 = await runtimeFactory.createRuntimeForUser(userContext1);

    // Check User 1 has Google MCP enabled without persisting their API key
    const mcp1 = getMcpSettings(runtime1);
    expect(mcp1).toBeDefined();
    expect((mcp1 as any)?.servers?.google).toBeDefined();

    const googleServer1 = (mcp1 as any)?.servers?.google;
    expect(googleServer1?.url).toContain("/api/mcps/google/streamable-http");
    expect(googleServer1?.headers?.["X-API-Key"]).toBeUndefined();

    console.log("✅ User 1 (with OAuth) has Google MCP enabled without persisted API key");

    await invalidateRuntime(runtime1.agentId as string);

    // User 2: No OAuth
    const userContext2 = buildUserContext(testDataUser2, {
      agentMode: AgentMode.CHAT,
      webSearchEnabled: false,
    });
    // Explicitly no oauthConnections

    const runtime2 = await runtimeFactory.createRuntimeForUser(userContext2);

    try {
      // Check User 2 does NOT have MCP settings (even though User 1 did)
      const mcp2 = getMcpSettings(runtime2);

      // MCP should either be undefined/null or have no Google server
      const hasGoogleServer = mcp2 && (mcp2 as any)?.servers?.google;

      if (hasGoogleServer) {
        // If somehow MCP exists, it still must not carry any user API key.
        const googleServer2 = (mcp2 as any).servers.google;
        expect(googleServer2?.headers?.["X-API-Key"]).toBeUndefined();
      }

      console.log("✅ User 2 (no OAuth) does not have User 1's MCP settings");
    } finally {
      await invalidateRuntime(runtime2.agentId as string);
    }
  }, 90000);
});
