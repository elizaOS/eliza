/**
 * OAuth Cache Invalidation Integration Tests
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { v4 as uuidv4 } from "uuid";
import type { UserContext } from "../../../../lib/eliza/user-context";
import { entitySettingsCache } from "../../../../lib/services/entity-settings/cache";
import {
  _testing,
  AgentMode,
  buildUserContext,
  cleanupTestData,
  createTestDataSet,
  getConnectionString,
  hasDatabaseUrl,
  invalidateByOrganization,
  isRuntimeCached,
  runtimeFactory,
  type TestDataSet,
  verifyConnection,
} from "../../../infrastructure";

const hasHostedWebSearchApiKey = Boolean(
  process.env.GOOGLE_API_KEY ||
    process.env.GEMINI_API_KEY ||
    process.env.GOOGLE_GENERATIVE_AI_API_KEY,
);

let connectionString: string;
let testData: TestDataSet;
let testData2: TestDataSet;

function hasRuntimeForOrganization(organizationId: string): boolean {
  return Array.from(_testing.getCacheEntries().keys()).some((key) =>
    key.includes(`:${organizationId}`),
  );
}

async function setupEnvironment(): Promise<void> {
  console.log("\n🔐 OAuth Cache Invalidation Tests");

  const connected = await verifyConnection();
  if (!connected) {
    throw new Error("Cannot connect to database");
  }
  connectionString = getConnectionString();

  // Create two test data sets for different organizations
  testData = await createTestDataSet(connectionString, {
    organizationName: "OAuth Cache Test Org 1",
    userName: "OAuth Cache Test User 1",
    userEmail: `oauth-cache-test-1-${Date.now()}@eliza.test`,
    creditBalance: 100.0,
  });

  testData2 = await createTestDataSet(connectionString, {
    organizationName: "OAuth Cache Test Org 2",
    userName: "OAuth Cache Test User 2",
    userEmail: `oauth-cache-test-2-${Date.now()}@eliza.test`,
    creditBalance: 100.0,
  });

  console.log("✅ Test data created for two organizations");
}

async function cleanupEnvironment(): Promise<void> {
  console.log("\n🧹 Cleaning up...");
  if (testData) {
    await cleanupTestData(connectionString, testData.organization.id).catch((err) =>
      console.warn(`Cleanup warning: ${err}`),
    );
  }
  if (testData2) {
    await cleanupTestData(connectionString, testData2.organization.id).catch((err) =>
      console.warn(`Cleanup warning: ${err}`),
    );
  }
}

describe.skipIf(!hasDatabaseUrl)("RuntimeCache.removeByOrganization", () => {
  beforeAll(setupEnvironment, 60000);
  afterAll(cleanupEnvironment);

  afterEach(async () => {
    // Clean up any cached runtimes after each test
    if (testData?.organization?.id) {
      await invalidateByOrganization(testData.organization.id);
    }
    if (testData2?.organization?.id) {
      await invalidateByOrganization(testData2.organization.id);
    }
  });

  it("should return 0 when no runtimes exist for organization", async () => {
    const nonExistentOrgId = uuidv4();
    const removed = await invalidateByOrganization(nonExistentOrgId);

    expect(removed).toBe(0);
    console.log("✅ Returns 0 for empty cache");
  }, 30000);

  it("should remove single runtime for organization", async () => {
    // Create a runtime
    const userContext = buildUserContext(testData, {
      agentMode: AgentMode.CHAT,
      webSearchEnabled: false,
    });
    const runtime = await runtimeFactory.createRuntimeForUser(userContext);
    const agentId = runtime.agentId as string;

    expect(isRuntimeCached(agentId)).toBe(true);
    expect(hasRuntimeForOrganization(testData.organization.id)).toBe(true);

    // Invalidate by organization
    const removed = await invalidateByOrganization(testData.organization.id);

    expect(removed).toBe(1);
    expect(hasRuntimeForOrganization(testData.organization.id)).toBe(false);
    console.log("✅ Single runtime removed");
  }, 60000);

  it("should remove multiple runtimes for same organization (with/without webSearch)", async () => {
    if (!hasHostedWebSearchApiKey) {
      console.log("Skipping webSearch invalidation case: GOOGLE_API_KEY not set");
      return;
    }

    // Create runtime without webSearch
    const userContext1 = buildUserContext(testData, {
      agentMode: AgentMode.CHAT,
      webSearchEnabled: false,
    });
    const runtime1 = await runtimeFactory.createRuntimeForUser(userContext1);

    // Create runtime with webSearch (different cache key suffix)
    const userContext2 = buildUserContext(testData, {
      agentMode: AgentMode.CHAT,
      webSearchEnabled: true,
    });
    const _runtime2 = await runtimeFactory.createRuntimeForUser(userContext2);

    expect(isRuntimeCached(runtime1.agentId as string)).toBe(true);
    // Note: webSearch runtime may have different cache key format

    // Invalidate by organization
    const removed = await invalidateByOrganization(testData.organization.id);

    // Should have removed at least 1 (may be more if webSearch creates separate entry)
    expect(removed).toBeGreaterThanOrEqual(1);
    expect(hasRuntimeForOrganization(testData.organization.id)).toBe(false);
    console.log(`✅ Removed ${removed} runtime(s) for organization`);
  }, 90000);

  it("should only remove runtimes for matching organization", async () => {
    // Create runtime for org 1
    const userContext1 = buildUserContext(testData, {
      agentMode: AgentMode.CHAT,
      webSearchEnabled: false,
    });
    const _runtime1 = await runtimeFactory.createRuntimeForUser(userContext1);

    // Create runtime for org 2
    const userContext2 = buildUserContext(testData2, {
      agentMode: AgentMode.CHAT,
      webSearchEnabled: false,
    });
    const _runtime2 = await runtimeFactory.createRuntimeForUser(userContext2);

    // Get cache stats before
    const statsBefore = _testing.getRuntimeCache().getStats();

    // Invalidate only org 1
    const removed = await invalidateByOrganization(testData.organization.id);

    expect(removed).toBe(1);

    // Verify org 2's runtime is still cached by checking cache stats
    const statsAfter = _testing.getRuntimeCache().getStats();
    // One runtime should remain (org 2)
    expect(statsAfter.size).toBe(statsBefore.size - 1);

    // Also verify by trying to remove org 2 - should find 1 entry
    const removed2 = await invalidateByOrganization(testData2.organization.id);
    expect(removed2).toBe(1);

    console.log("✅ Only matching organization runtimes removed");
  }, 90000);

  it("should handle concurrent invalidation calls safely", async () => {
    // Create runtime
    const userContext = buildUserContext(testData, {
      agentMode: AgentMode.CHAT,
      webSearchEnabled: false,
    });
    const _runtime = await runtimeFactory.createRuntimeForUser(userContext);

    const statsBefore = _testing.getRuntimeCache().getStats();
    expect(statsBefore.size).toBeGreaterThan(0);

    // Call invalidation concurrently
    const results = await Promise.all([
      invalidateByOrganization(testData.organization.id),
      invalidateByOrganization(testData.organization.id),
      invalidateByOrganization(testData.organization.id),
    ]);

    // At least one call should succeed, total may vary due to race conditions
    const totalRemoved = results.reduce((a, b) => a + b, 0);
    expect(totalRemoved).toBeGreaterThanOrEqual(1);

    // Cache should now be empty for this org
    const verifyRemoved = await invalidateByOrganization(testData.organization.id);
    expect(verifyRemoved).toBe(0);

    console.log(`✅ Concurrent calls handled safely (total removed: ${totalRemoved})`);
  }, 60000);

  it("should reject invalid organization IDs (non-UUID format)", async () => {
    // This tests that only valid UUIDs are accepted

    // Create runtime
    const userContext = buildUserContext(testData, {
      agentMode: AgentMode.CHAT,
      webSearchEnabled: false,
    });
    await runtimeFactory.createRuntimeForUser(userContext);

    const statsBefore = _testing.getRuntimeCache().getStats();

    // Try with various invalid org IDs (not valid UUID format)
    const invalidIds = [
      "", // empty
      "abc", // too short
      "not-a-uuid-at-all", // wrong format
      "12345678-1234-1234-1234-123456789", // too short (35 chars)
      "12345678-1234-1234-1234-1234567890123", // too long (37 chars)
      "ZZZZZZZZ-ZZZZ-ZZZZ-ZZZZ-ZZZZZZZZZZZZ", // invalid hex chars
      testData.organization.id.substring(0, 8), // partial UUID
    ];

    for (const invalidId of invalidIds) {
      const removed = await invalidateByOrganization(invalidId);
      expect(removed).toBe(0);
    }

    // Cache should be unchanged
    const statsAfter = _testing.getRuntimeCache().getStats();
    expect(statsAfter.size).toBe(statsBefore.size);

    console.log("✅ Invalid organization IDs rejected (UUID validation)");
  }, 60000);
});

describe.skipIf(!hasDatabaseUrl)("EntitySettingsCache invalidation", () => {
  beforeAll(setupEnvironment, 60000);
  afterAll(cleanupEnvironment);

  it("should invalidate cache for specific user", async () => {
    const userId = testData.user.id;
    const agentId = uuidv4();

    // Set something in cache
    const testSettings = new Map<string, string>();
    testSettings.set("TEST_KEY", "test_value");
    await entitySettingsCache.set(userId, agentId, testSettings, {
      TEST_KEY: "entity_settings",
    });

    // Verify it's cached
    const cached = await entitySettingsCache.get(userId, agentId);
    expect(cached).not.toBeNull();
    expect(cached?.settings.get("TEST_KEY")).toBe("test_value");

    // Invalidate
    await entitySettingsCache.invalidateUser(userId);

    // Verify it's gone
    const afterInvalidate = await entitySettingsCache.get(userId, agentId);
    expect(afterInvalidate).toBeNull();

    console.log("✅ User cache invalidated correctly");
  }, 30000);

  it("should invalidate all agent-specific caches for user", async () => {
    const userId = testData.user.id;
    const agentId1 = uuidv4();
    const agentId2 = uuidv4();

    // Set cache for two different agents
    const settings1 = new Map<string, string>([["KEY1", "value1"]]);
    const settings2 = new Map<string, string>([["KEY2", "value2"]]);

    await entitySettingsCache.set(userId, agentId1, settings1, {
      KEY1: "entity_settings",
    });
    await entitySettingsCache.set(userId, agentId2, settings2, {
      KEY2: "entity_settings",
    });

    // Verify both are cached
    expect(await entitySettingsCache.get(userId, agentId1)).not.toBeNull();
    expect(await entitySettingsCache.get(userId, agentId2)).not.toBeNull();

    // Invalidate user (should clear all agent-specific caches)
    await entitySettingsCache.invalidateUser(userId);

    // Both should be gone
    expect(await entitySettingsCache.get(userId, agentId1)).toBeNull();
    expect(await entitySettingsCache.get(userId, agentId2)).toBeNull();

    console.log("✅ All agent-specific caches invalidated for user");
  }, 30000);

  it("should not affect other users when invalidating", async () => {
    const userId1 = testData.user.id;
    const userId2 = testData2.user.id;
    const agentId = uuidv4();

    // Set cache for two different users
    const settings1 = new Map<string, string>([["USER1_KEY", "user1_value"]]);
    const settings2 = new Map<string, string>([["USER2_KEY", "user2_value"]]);

    await entitySettingsCache.set(userId1, agentId, settings1, {
      USER1_KEY: "entity_settings",
    });
    await entitySettingsCache.set(userId2, agentId, settings2, {
      USER2_KEY: "entity_settings",
    });

    // Invalidate only user 1
    await entitySettingsCache.invalidateUser(userId1);

    // User 1 should be gone, user 2 should remain
    expect(await entitySettingsCache.get(userId1, agentId)).toBeNull();
    const user2Cache = await entitySettingsCache.get(userId2, agentId);
    expect(user2Cache).not.toBeNull();
    expect(user2Cache?.settings.get("USER2_KEY")).toBe("user2_value");

    // Cleanup
    await entitySettingsCache.invalidateUser(userId2);

    console.log("✅ Other users not affected by invalidation");
  }, 30000);
});

describe.skipIf(!hasDatabaseUrl)("OAuth flow cache invalidation integration", () => {
  beforeAll(setupEnvironment, 60000);
  afterAll(cleanupEnvironment);

  afterEach(async () => {
    // Clean up caches
    if (testData?.organization?.id) {
      await invalidateByOrganization(testData.organization.id);
    }
    if (testData?.user?.id) {
      await entitySettingsCache.invalidateUser(testData.user.id);
    }
  });

  it("should allow MCP plugin reload after runtime cache invalidation", async () => {
    // 1. Create runtime WITHOUT OAuth (no MCP plugin)
    const userContext1: UserContext = {
      ...buildUserContext(testData, {
        agentMode: AgentMode.CHAT,
        webSearchEnabled: false,
      }),
      oauthConnections: undefined, // No OAuth
    };
    const runtime1 = await runtimeFactory.createRuntimeForUser(userContext1);
    const agentId = runtime1.agentId as string;

    // Verify cached
    expect(isRuntimeCached(agentId)).toBe(true);
    expect(hasRuntimeForOrganization(testData.organization.id)).toBe(true);

    // 2. Simulate OAuth connect by invalidating cache
    const removed = await invalidateByOrganization(testData.organization.id);
    expect(removed).toBe(1);
    expect(hasRuntimeForOrganization(testData.organization.id)).toBe(false);

    // 3. Create runtime again WITH OAuth (should get MCP plugin)
    const userContext2: UserContext = {
      ...buildUserContext(testData, {
        agentMode: AgentMode.CHAT,
        webSearchEnabled: false,
      }),
      oauthConnections: [{ platform: "google" }],
    };
    const runtime2 = await runtimeFactory.createRuntimeForUser(userContext2);

    // 4. Verify MCP settings are now present
    type McpServerConfig = {
      url?: string;
      type?: string;
      headers?: Record<string, string>;
    };
    const mcpSettings = (
      runtime2.character as {
        settings?: { mcp?: { servers?: Record<string, McpServerConfig> } };
      }
    ).settings?.mcp;
    expect(mcpSettings).toBeDefined();
    expect(mcpSettings?.servers?.google).toBeDefined();

    console.log("✅ MCP plugin loaded after cache invalidation");
  }, 90000);

  it("should handle rapid connect/disconnect cycles", async () => {
    // Simulate rapid OAuth changes
    for (let i = 0; i < 3; i++) {
      // Connect
      const connectContext: UserContext = {
        ...buildUserContext(testData, {
          agentMode: AgentMode.CHAT,
          webSearchEnabled: false,
        }),
        oauthConnections: [{ platform: "google" }],
      };
      const runtime = await runtimeFactory.createRuntimeForUser(connectContext);
      expect(isRuntimeCached(runtime.agentId as string)).toBe(true);
      expect(hasRuntimeForOrganization(testData.organization.id)).toBe(true);

      // Disconnect (invalidate)
      await invalidateByOrganization(testData.organization.id);
      expect(hasRuntimeForOrganization(testData.organization.id)).toBe(false);
    }

    console.log("✅ Rapid connect/disconnect cycles handled");
  }, 180000);
});

describe.skipIf(!hasDatabaseUrl)("Edge cases and error handling", () => {
  beforeAll(setupEnvironment, 60000);
  afterAll(cleanupEnvironment);

  it("should handle invalidation of already-invalidated runtime gracefully", async () => {
    const userContext = buildUserContext(testData, {
      agentMode: AgentMode.CHAT,
      webSearchEnabled: false,
    });
    const _runtime = await runtimeFactory.createRuntimeForUser(userContext);
    const orgId = testData.organization.id;

    // First invalidation
    const first = await invalidateByOrganization(orgId);
    expect(first).toBe(1);

    // Second invalidation should return 0 (nothing to invalidate)
    const second = await invalidateByOrganization(orgId);
    expect(second).toBe(0);

    console.log("✅ Double invalidation handled gracefully");
  }, 60000);

  it("should handle empty organization ID", async () => {
    const removed = await invalidateByOrganization("");
    expect(removed).toBe(0);

    console.log("✅ Empty organization ID handled");
  }, 30000);

  it("should handle special characters in organization ID", async () => {
    // These should not match any real cache keys
    const specialIds = ["::", ":::ws", "test:org:extra", "../../../etc/passwd"];

    for (const id of specialIds) {
      const removed = await invalidateByOrganization(id);
      expect(removed).toBe(0);
    }

    console.log("✅ Special characters handled safely");
  }, 30000);

  it("should handle entity settings cache invalidation with null agentId", async () => {
    const userId = testData.user.id;

    // Set global settings (agentId = null)
    const globalSettings = new Map<string, string>([["GLOBAL_KEY", "global_value"]]);
    await entitySettingsCache.set(userId, null, globalSettings, {
      GLOBAL_KEY: "entity_settings",
    });

    // Verify cached
    const cached = await entitySettingsCache.get(userId, null);
    expect(cached?.settings.get("GLOBAL_KEY")).toBe("global_value");

    // Invalidate user (should clear global settings too)
    await entitySettingsCache.invalidateUser(userId);

    // Should be gone
    expect(await entitySettingsCache.get(userId, null)).toBeNull();

    console.log("✅ Global settings (null agentId) invalidated correctly");
  }, 30000);
});
