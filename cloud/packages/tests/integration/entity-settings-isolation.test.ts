/**
 * Entity Settings Isolation E2E Tests
 *
 * These tests verify that:
 * 1. Users share the same runtime (for efficiency)
 * 2. Each user's settings are isolated via request context
 * 3. No API key or sensitive data leakage between concurrent requests
 * 4. Cache invalidation works correctly
 *
 * CRITICAL: These tests exercise real code paths, not mocks.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { UUID } from "@elizaos/core";
import { createHash } from "crypto";
import { eq } from "drizzle-orm";
import { dbWrite } from "@/db/client";
import { apiKeys } from "@/db/schemas/api-keys";
import { entitySettings } from "@/db/schemas/entity-settings";
import { organizations } from "@/db/schemas/organizations";
import { users } from "@/db/schemas/users";
import { entitySettingsService } from "@/lib/services/entity-settings";
import { entitySettingsCache } from "@/lib/services/entity-settings/cache";
import {
  getRequestContext,
  runWithRequestContext,
} from "@/lib/services/entity-settings/request-context";
import { getEncryptionService } from "@/lib/services/secrets";

// Test fixtures
interface TestUser {
  id: string;
  email: string;
  apiKey: string;
  customSetting: string;
}

interface TestFixtures {
  organization: { id: string; name: string };
  userA: TestUser;
  userB: TestUser;
  userC: TestUser;
  agentId: string;
}

let fixtures: TestFixtures;

/**
 * Setup: Create test users with different API keys and settings
 */
async function setupTestFixtures(): Promise<TestFixtures> {
  const now = new Date();
  const orgId = crypto.randomUUID();
  const agentId = crypto.randomUUID();
  const orgSlug = `test-entity-settings-${Date.now()}`;

  // Create organization
  await dbWrite.insert(organizations).values({
    id: orgId,
    name: "Test Org for Entity Settings",
    slug: orgSlug,
    created_at: now,
    updated_at: now,
  });

  // Create three test users with different settings
  const testUsers: TestUser[] = [];
  for (const suffix of ["A", "B", "C"]) {
    const userId = crypto.randomUUID();
    const email = `test-entity-settings-${suffix.toLowerCase()}-${Date.now()}@test.local`;
    const apiKey = `elk_test_${suffix}_${crypto.randomUUID().slice(0, 16)}`;
    const apiKeyHash = createHash("sha256").update(apiKey).digest("hex");
    const apiKeyPrefix = apiKey.slice(0, 8);
    const customSetting = `custom-value-for-user-${suffix}`;

    // Create user
    await dbWrite.insert(users).values({
      id: userId,
      steward_user_id: `test-entity-settings-${userId}`,
      email,
      name: `Test User ${suffix}`,
      created_at: now,
      updated_at: now,
    });

    // Create API key for user (links user to organization)
    await dbWrite.insert(apiKeys).values({
      id: crypto.randomUUID(),
      user_id: userId,
      organization_id: orgId,
      name: `Test Key ${suffix}`,
      key: apiKey,
      key_hash: apiKeyHash,
      key_prefix: apiKeyPrefix,
      is_active: true,
      created_at: now,
      updated_at: now,
    });

    // Create custom entity setting for user
    const encryption = getEncryptionService();
    const encrypted = await encryption.encrypt(customSetting);

    await dbWrite.insert(entitySettings).values({
      id: crypto.randomUUID(),
      user_id: userId,
      agent_id: null, // Global setting
      key: "CUSTOM_SETTING",
      encrypted_value: encrypted.encryptedValue,
      encryption_key_id: encrypted.keyId,
      encrypted_dek: encrypted.encryptedDek,
      nonce: encrypted.nonce,
      auth_tag: encrypted.authTag,
      created_at: now,
      updated_at: now,
    });

    testUsers.push({ id: userId, email, apiKey, customSetting });
  }

  return {
    organization: { id: orgId, name: "Test Org for Entity Settings" },
    userA: testUsers[0],
    userB: testUsers[1],
    userC: testUsers[2],
    agentId,
  };
}

/**
 * Cleanup: Remove test data
 */
async function cleanupTestFixtures(fixtures: TestFixtures): Promise<void> {
  if (!fixtures) {
    console.warn("[Cleanup] No fixtures to clean up");
    return;
  }

  const userIds = [fixtures.userA?.id, fixtures.userB?.id, fixtures.userC?.id].filter(Boolean);

  // Delete in reverse dependency order
  for (const userId of userIds) {
    try {
      await dbWrite.delete(entitySettings).where(eq(entitySettings.user_id, userId as string));
      await dbWrite.delete(apiKeys).where(eq(apiKeys.user_id, userId as string));
      await dbWrite.delete(users).where(eq(users.id, userId as string));
    } catch (e) {
      console.warn(`[Cleanup] Error cleaning user ${userId}:`, e);
    }
  }

  if (fixtures.organization?.id) {
    try {
      await dbWrite.delete(organizations).where(eq(organizations.id, fixtures.organization.id));
    } catch (e) {
      console.warn(`[Cleanup] Error cleaning organization:`, e);
    }
  }

  // Clear cache
  for (const userId of userIds) {
    try {
      await entitySettingsCache.invalidateUser(userId as string);
    } catch (_e) {
      // Ignore cache errors during cleanup
    }
  }
}

describe("Entity Settings Isolation", () => {
  beforeAll(async () => {
    fixtures = await setupTestFixtures();
  });

  afterAll(async () => {
    await cleanupTestFixtures(fixtures);
  });

  describe("Prefetch and Context Isolation", () => {
    test("prefetch returns correct settings for each user", async () => {
      // Prefetch settings for User A
      const resultA = await entitySettingsService.prefetch(
        fixtures.userA.id,
        fixtures.agentId,
        fixtures.organization.id,
      );

      // Prefetch settings for User B
      const resultB = await entitySettingsService.prefetch(
        fixtures.userB.id,
        fixtures.agentId,
        fixtures.organization.id,
      );

      // Verify User A's settings
      expect(resultA.settings.get("ELIZAOS_API_KEY")).toBe(fixtures.userA.apiKey);
      expect(resultA.settings.get("CUSTOM_SETTING")).toBe(fixtures.userA.customSetting);
      expect(resultA.sources["ELIZAOS_API_KEY"]).toBe("api_keys");
      expect(resultA.sources["CUSTOM_SETTING"]).toBe("entity_settings");

      // Verify User B's settings are DIFFERENT
      expect(resultB.settings.get("ELIZAOS_API_KEY")).toBe(fixtures.userB.apiKey);
      expect(resultB.settings.get("CUSTOM_SETTING")).toBe(fixtures.userB.customSetting);

      // Critical assertion: settings are NOT the same
      expect(resultA.settings.get("ELIZAOS_API_KEY")).not.toBe(
        resultB.settings.get("ELIZAOS_API_KEY"),
      );
    });

    test("request context isolates settings within runWithRequestContext", async () => {
      // Prefetch for both users
      const settingsA = await entitySettingsService.prefetch(
        fixtures.userA.id,
        fixtures.agentId,
        fixtures.organization.id,
      );
      const settingsB = await entitySettingsService.prefetch(
        fixtures.userB.id,
        fixtures.agentId,
        fixtures.organization.id,
      );

      // Values captured inside each context
      let capturedApiKeyA: string | undefined;
      let capturedApiKeyB: string | undefined;

      // Run User A's context
      await runWithRequestContext(
        {
          entityId: fixtures.userA.id as UUID,
          agentId: fixtures.agentId as UUID,
          entitySettings: settingsA.settings,
          requestStartTime: Date.now(),
        },
        () => {
          const ctx = getRequestContext();
          capturedApiKeyA = ctx?.entitySettings?.get("ELIZAOS_API_KEY") as string;
        },
      );

      // Run User B's context
      await runWithRequestContext(
        {
          entityId: fixtures.userB.id as UUID,
          agentId: fixtures.agentId as UUID,
          entitySettings: settingsB.settings,
          requestStartTime: Date.now(),
        },
        () => {
          const ctx = getRequestContext();
          capturedApiKeyB = ctx?.entitySettings?.get("ELIZAOS_API_KEY") as string;
        },
      );

      // Verify isolation
      expect(capturedApiKeyA).toBe(fixtures.userA.apiKey);
      expect(capturedApiKeyB).toBe(fixtures.userB.apiKey);
      expect(capturedApiKeyA).not.toBe(capturedApiKeyB);
    });

    test("context is undefined outside of runWithRequestContext", () => {
      // Outside any context, getRequestContext should return undefined
      const ctx = getRequestContext();
      expect(ctx).toBeUndefined();
    });
  });

  describe("Concurrent Request Isolation", () => {
    test("concurrent requests from different users maintain isolation", async () => {
      const results: Array<{
        userId: string;
        expectedApiKey: string;
        actualApiKey: string | undefined;
        timestamp: number;
      }> = [];

      // Simulate 10 concurrent requests from 3 different users
      const requests = [];
      for (let i = 0; i < 30; i++) {
        const user = [fixtures.userA, fixtures.userB, fixtures.userC][i % 3];
        requests.push(
          (async () => {
            const settings = await entitySettingsService.prefetch(
              user.id,
              fixtures.agentId,
              fixtures.organization.id,
            );

            return runWithRequestContext(
              {
                entityId: user.id as UUID,
                agentId: fixtures.agentId as UUID,
                entitySettings: settings.settings,
                requestStartTime: Date.now(),
              },
              async () => {
                // Simulate some async work (like DB query or API call)
                await new Promise((r) => setTimeout(r, Math.random() * 50));

                const ctx = getRequestContext();
                const actualApiKey = ctx?.entitySettings?.get("ELIZAOS_API_KEY") as string;

                results.push({
                  userId: user.id,
                  expectedApiKey: user.apiKey,
                  actualApiKey,
                  timestamp: Date.now(),
                });

                return actualApiKey;
              },
            );
          })(),
        );
      }

      // Execute all concurrently
      await Promise.all(requests);

      // Verify NO leakage: every result should have the correct API key
      for (const result of results) {
        expect(result.actualApiKey).toBe(result.expectedApiKey);
      }

      // Count by user to ensure we tested all users
      const countByUser = results.reduce(
        (acc, r) => {
          acc[r.userId] = (acc[r.userId] || 0) + 1;
          return acc;
        },
        {} as Record<string, number>,
      );

      expect(countByUser[fixtures.userA.id]).toBe(10);
      expect(countByUser[fixtures.userB.id]).toBe(10);
      expect(countByUser[fixtures.userC.id]).toBe(10);
    });

    test("nested async operations maintain context", async () => {
      const settings = await entitySettingsService.prefetch(
        fixtures.userA.id,
        fixtures.agentId,
        fixtures.organization.id,
      );

      const capturedKeys: string[] = [];

      await runWithRequestContext(
        {
          entityId: fixtures.userA.id as UUID,
          agentId: fixtures.agentId as UUID,
          entitySettings: settings.settings,
          requestStartTime: Date.now(),
        },
        async () => {
          // Level 1
          const ctx1 = getRequestContext();
          capturedKeys.push(ctx1?.entitySettings?.get("ELIZAOS_API_KEY") as string);

          // Level 2: nested async
          await Promise.resolve().then(async () => {
            const ctx2 = getRequestContext();
            capturedKeys.push(ctx2?.entitySettings?.get("ELIZAOS_API_KEY") as string);

            // Level 3: setTimeout equivalent
            await new Promise<void>((resolve) => {
              const ctx3 = getRequestContext();
              capturedKeys.push(ctx3?.entitySettings?.get("ELIZAOS_API_KEY") as string);
              resolve();
            });
          });

          // Level 2 again: parallel promises
          await Promise.all([
            (async () => {
              const ctx = getRequestContext();
              capturedKeys.push(ctx?.entitySettings?.get("ELIZAOS_API_KEY") as string);
            })(),
            (async () => {
              await new Promise((r) => setTimeout(r, 10));
              const ctx = getRequestContext();
              capturedKeys.push(ctx?.entitySettings?.get("ELIZAOS_API_KEY") as string);
            })(),
          ]);
        },
      );

      // All captured keys should be User A's key
      expect(capturedKeys).toHaveLength(5);
      for (const key of capturedKeys) {
        expect(key).toBe(fixtures.userA.apiKey);
      }
    });
  });

  describe("Cache Behavior", () => {
    test("cache returns same result on second call", async () => {
      // Clear cache first
      await entitySettingsCache.invalidateUser(fixtures.userA.id);

      // First call - cache miss
      const result1 = await entitySettingsService.prefetch(
        fixtures.userA.id,
        fixtures.agentId,
        fixtures.organization.id,
      );

      // Second call - cache hit
      const result2 = await entitySettingsService.prefetch(
        fixtures.userA.id,
        fixtures.agentId,
        fixtures.organization.id,
      );

      // Should return equivalent data
      expect(result1.settings.get("ELIZAOS_API_KEY")).toBe(result2.settings.get("ELIZAOS_API_KEY"));
      expect(result1.settings.get("CUSTOM_SETTING")).toBe(result2.settings.get("CUSTOM_SETTING"));
    });

    test("cache invalidation forces fresh fetch", async () => {
      // Prefetch to populate cache
      await entitySettingsService.prefetch(
        fixtures.userA.id,
        fixtures.agentId,
        fixtures.organization.id,
      );

      // Update the setting in database
      const newValue = `updated-${Date.now()}`;
      await entitySettingsService.set({
        userId: fixtures.userA.id,
        key: "CUSTOM_SETTING",
        value: newValue,
      });

      // Prefetch again - should get new value (set() invalidates cache)
      const result = await entitySettingsService.prefetch(
        fixtures.userA.id,
        fixtures.agentId,
        fixtures.organization.id,
      );

      expect(result.settings.get("CUSTOM_SETTING")).toBe(newValue);

      // Restore original value
      await entitySettingsService.set({
        userId: fixtures.userA.id,
        key: "CUSTOM_SETTING",
        value: fixtures.userA.customSetting,
      });
    });

    test("different agent IDs have separate cache entries", async () => {
      const agentId2 = crypto.randomUUID();

      // Set agent-specific setting for agentId2
      await entitySettingsService.set({
        userId: fixtures.userA.id,
        key: "AGENT_SPECIFIC",
        value: "agent2-value",
        agentId: agentId2,
      });

      // Prefetch for original agent
      const result1 = await entitySettingsService.prefetch(
        fixtures.userA.id,
        fixtures.agentId,
        fixtures.organization.id,
      );

      // Prefetch for agent2
      const result2 = await entitySettingsService.prefetch(
        fixtures.userA.id,
        agentId2,
        fixtures.organization.id,
      );

      // Original agent should NOT have the agent-specific setting
      expect(result1.settings.get("AGENT_SPECIFIC")).toBeUndefined();

      // Agent2 should have it
      expect(result2.settings.get("AGENT_SPECIFIC")).toBe("agent2-value");

      // Cleanup
      await entitySettingsService.revoke({
        userId: fixtures.userA.id,
        key: "AGENT_SPECIFIC",
        agentId: agentId2,
      });
    });
  });

  describe("Setting Priority", () => {
    test("agent-specific settings override global settings", async () => {
      const agentSpecificValue = `agent-specific-${Date.now()}`;

      // Set global setting
      await entitySettingsService.set({
        userId: fixtures.userA.id,
        key: "PRIORITY_TEST",
        value: "global-value",
        agentId: null,
      });

      // Set agent-specific setting
      await entitySettingsService.set({
        userId: fixtures.userA.id,
        key: "PRIORITY_TEST",
        value: agentSpecificValue,
        agentId: fixtures.agentId,
      });

      // Prefetch - should get agent-specific value
      const result = await entitySettingsService.prefetch(
        fixtures.userA.id,
        fixtures.agentId,
        fixtures.organization.id,
      );

      expect(result.settings.get("PRIORITY_TEST")).toBe(agentSpecificValue);

      // Cleanup
      await entitySettingsService.revoke({
        userId: fixtures.userA.id,
        key: "PRIORITY_TEST",
        agentId: fixtures.agentId,
      });
      await entitySettingsService.revoke({
        userId: fixtures.userA.id,
        key: "PRIORITY_TEST",
        agentId: null,
      });
    });

    test("entity settings override API keys for same key", async () => {
      // User A already has an API key from fixtures
      // Set an entity setting with the same key name
      const overrideValue = `override-${Date.now()}`;
      await entitySettingsService.set({
        userId: fixtures.userA.id,
        key: "ELIZAOS_API_KEY",
        value: overrideValue,
      });

      const result = await entitySettingsService.prefetch(
        fixtures.userA.id,
        fixtures.agentId,
        fixtures.organization.id,
      );

      // Entity setting should take precedence
      expect(result.settings.get("ELIZAOS_API_KEY")).toBe(overrideValue);
      expect(result.sources["ELIZAOS_API_KEY"]).toBe("entity_settings");

      // Cleanup - revoke the override
      await entitySettingsService.revoke({
        userId: fixtures.userA.id,
        key: "ELIZAOS_API_KEY",
      });

      // Now should fall back to API key
      const result2 = await entitySettingsService.prefetch(
        fixtures.userA.id,
        fixtures.agentId,
        fixtures.organization.id,
      );
      expect(result2.settings.get("ELIZAOS_API_KEY")).toBe(fixtures.userA.apiKey);
      expect(result2.sources["ELIZAOS_API_KEY"]).toBe("api_keys");
    });
  });

  describe("Error Handling", () => {
    test("prefetch handles missing user gracefully", async () => {
      const fakeUserId = crypto.randomUUID();

      // Should not throw, just return empty settings
      const result = await entitySettingsService.prefetch(
        fakeUserId,
        fixtures.agentId,
        fixtures.organization.id,
      );

      expect(result.settings.size).toBe(0);
      expect(Object.keys(result.sources)).toHaveLength(0);
    });

    test("set operation with invalid user fails FK constraint", async () => {
      const fakeUserId = crypto.randomUUID();

      await expect(
        entitySettingsService.set({
          userId: fakeUserId,
          key: "TEST",
          value: "value",
        }),
      ).rejects.toThrow();
    });

    test("revoke returns false for non-existent setting", async () => {
      const result = await entitySettingsService.revoke({
        userId: fixtures.userA.id,
        key: "NON_EXISTENT_KEY_12345",
      });

      expect(result).toBe(false);
    });
  });

  describe("List and Metadata", () => {
    test("list returns all settings for user with previews", async () => {
      const settings = await entitySettingsService.list(fixtures.userA.id);

      // Should have at least CUSTOM_SETTING
      const customSetting = settings.find((s) => s.key === "CUSTOM_SETTING");
      expect(customSetting).toBeDefined();
      expect(customSetting?.valuePreview).toMatch(/^\.\.\..{3}$/); // "...xxx" format
      expect(customSetting?.agentId).toBeNull(); // Global setting
    });

    test("list filters by agent ID", async () => {
      // Set agent-specific setting
      await entitySettingsService.set({
        userId: fixtures.userA.id,
        key: "AGENT_ONLY",
        value: "test",
        agentId: fixtures.agentId,
      });

      // List global only
      const globalSettings = await entitySettingsService.list(fixtures.userA.id, null);
      expect(globalSettings.find((s) => s.key === "AGENT_ONLY")).toBeUndefined();

      // List agent-specific only
      const agentSettings = await entitySettingsService.list(fixtures.userA.id, fixtures.agentId);
      expect(agentSettings.find((s) => s.key === "AGENT_ONLY")).toBeDefined();

      // Cleanup
      await entitySettingsService.revoke({
        userId: fixtures.userA.id,
        key: "AGENT_ONLY",
        agentId: fixtures.agentId,
      });
    });
  });
});

describe("Stress Test: High Concurrency", () => {
  let stressFixtures: TestFixtures;

  beforeAll(async () => {
    stressFixtures = await setupTestFixtures();
  });

  afterAll(async () => {
    await cleanupTestFixtures(stressFixtures);
  });

  test("100 concurrent requests maintain perfect isolation", async () => {
    const users = [stressFixtures.userA, stressFixtures.userB, stressFixtures.userC];
    const errors: string[] = [];
    const results: Array<{ userId: string; match: boolean }> = [];

    // Create 100 concurrent operations
    const operations = Array.from({ length: 100 }, async (_, i) => {
      const user = users[i % 3];

      try {
        const settings = await entitySettingsService.prefetch(
          user.id,
          stressFixtures.agentId,
          stressFixtures.organization.id,
        );

        return runWithRequestContext(
          {
            entityId: user.id as UUID,
            agentId: stressFixtures.agentId as UUID,
            entitySettings: settings.settings,
            requestStartTime: Date.now(),
          },
          async () => {
            // Random delay to interleave executions
            await new Promise((r) => setTimeout(r, Math.random() * 100));

            // Multiple context accesses within same request
            const checks = await Promise.all([
              (async () => {
                const ctx = getRequestContext();
                return ctx?.entitySettings?.get("ELIZAOS_API_KEY");
              })(),
              (async () => {
                await new Promise((r) => setTimeout(r, Math.random() * 20));
                const ctx = getRequestContext();
                return ctx?.entitySettings?.get("ELIZAOS_API_KEY");
              })(),
              (async () => {
                await new Promise((r) => setTimeout(r, Math.random() * 20));
                const ctx = getRequestContext();
                return ctx?.entitySettings?.get("CUSTOM_SETTING");
              })(),
            ]);

            const apiKeyMatch = checks[0] === user.apiKey && checks[1] === user.apiKey;
            const customMatch = checks[2] === user.customSetting;

            if (!apiKeyMatch || !customMatch) {
              errors.push(
                `User ${user.id}: expected API key ${user.apiKey}, got ${checks[0]}, ${checks[1]}; custom: expected ${user.customSetting}, got ${checks[2]}`,
              );
            }

            results.push({
              userId: user.id,
              match: apiKeyMatch && customMatch,
            });
          },
        );
      } catch (error) {
        errors.push(`User ${user.id}: ${error}`);
      }
    });

    await Promise.all(operations);

    // Report any failures
    if (errors.length > 0) {
      console.error("Isolation failures:", errors);
    }

    expect(errors).toHaveLength(0);
    expect(results).toHaveLength(100);
    expect(results.every((r) => r.match)).toBe(true);
  });
});
