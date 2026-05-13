/**
 * API Keys Service Tests
 *
 * Sociable unit tests for the API Keys Service.
 * Tests use real PostgreSQL database.
 *
 * Key test scenarios:
 * - generateApiKey: generates cryptographically secure keys
 * - validateApiKey: validates keys with caching
 * - create: creates new API key
 * - update: updates key metadata
 * - incrementUsage: tracks usage count
 * - delete: removes API key
 *
 */

import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import crypto from "crypto";
import { v4 as uuidv4 } from "uuid";
import { API_KEY_PREFIX_LENGTH } from "@/lib/pricing";
import { apiKeysService } from "@/lib/services/api-keys";
import { getConnectionString } from "@/tests/infrastructure/local-database";
import {
  cleanupTestData,
  createTestDataSet,
  type TestDataSet,
} from "@/tests/infrastructure/test-data-factory";

describe("ApiKeysService", () => {
  let connectionString: string;
  let testData: TestDataSet;

  beforeAll(async () => {
    connectionString = getConnectionString();
  });

  beforeEach(async () => {
    // Create fresh test data for each test
    testData = await createTestDataSet(connectionString, {
      creditBalance: 100,
    });
  });

  afterAll(async () => {
    // Cleanup is handled per-test, but ensure final cleanup
    if (testData?.organization?.id) {
      await cleanupTestData(connectionString, testData.organization.id);
    }
  });

  // ===========================================================================
  // generateApiKey Tests
  // ===========================================================================

  describe("generateApiKey", () => {
    test("generates key with correct format", () => {
      // Act
      const generated = apiKeysService.generateApiKey();

      // Assert
      expect(generated.key).toBeDefined();
      expect(generated.hash).toBeDefined();
      expect(generated.prefix).toBeDefined();

      // Key should start with 'eliza_'
      expect(generated.key.startsWith("eliza_")).toBe(true);

      // Hash should be 64 characters (SHA256 hex)
      expect(generated.hash.length).toBe(64);

      // Prefix should be correct length
      expect(generated.prefix.length).toBe(API_KEY_PREFIX_LENGTH);
      expect(generated.key.startsWith(generated.prefix)).toBe(true);
    });

    test("generates unique keys on each call", () => {
      // Act
      const key1 = apiKeysService.generateApiKey();
      const key2 = apiKeysService.generateApiKey();
      const key3 = apiKeysService.generateApiKey();

      // Assert - All should be different
      expect(key1.key).not.toBe(key2.key);
      expect(key2.key).not.toBe(key3.key);
      expect(key1.key).not.toBe(key3.key);

      expect(key1.hash).not.toBe(key2.hash);
      expect(key2.hash).not.toBe(key3.hash);
    });

    test("hash is deterministic for the same key", () => {
      // Arrange
      const generated = apiKeysService.generateApiKey();

      // Act - Manually compute hash
      const manualHash = crypto
        .createHash("sha256")
        .update(generated.key)
        .digest("hex");

      // Assert
      expect(generated.hash).toBe(manualHash);
    });

    test("generates cryptographically random keys", () => {
      // Generate many keys and check for randomness
      const keys = new Set<string>();
      const numKeys = 100;

      for (let i = 0; i < numKeys; i++) {
        const { key } = apiKeysService.generateApiKey();
        keys.add(key);
      }

      // All keys should be unique
      expect(keys.size).toBe(numKeys);
    });
  });

  // ===========================================================================
  // validateApiKey Tests
  // ===========================================================================

  describe("validateApiKey", () => {
    test("validates active API key successfully", async () => {
      // Arrange - Use the API key created with testData
      const plainKey = testData.apiKey.key;

      // Act
      const validated = await apiKeysService.validateApiKey(plainKey);

      // Assert
      expect(validated).not.toBeNull();
      expect(validated!.id).toBe(testData.apiKey.id);
      expect(validated!.is_active).toBe(true);

      // Cleanup
      await cleanupTestData(connectionString, testData.organization.id);
    });

    test("returns null for invalid API key", async () => {
      // Arrange
      const fakeKey = `eliza_${crypto.randomBytes(32).toString("hex")}`;

      // Act
      const validated = await apiKeysService.validateApiKey(fakeKey);

      // Assert
      expect(validated).toBeNull();

      // Cleanup
      await cleanupTestData(connectionString, testData.organization.id);
    });

    test("returns null for malformed API key", async () => {
      // Arrange
      const malformedKey = "not-a-valid-key";

      // Act
      const validated = await apiKeysService.validateApiKey(malformedKey);

      // Assert
      expect(validated).toBeNull();

      // Cleanup
      await cleanupTestData(connectionString, testData.organization.id);
    });

    test("caches validation result on subsequent calls", async () => {
      // Arrange
      const plainKey = testData.apiKey.key;

      // Act - First validation (DB hit, then cache)
      const validated1 = await apiKeysService.validateApiKey(plainKey);

      // Second validation (should use cache)
      const validated2 = await apiKeysService.validateApiKey(plainKey);

      // Assert - Both should return same result
      expect(validated1).not.toBeNull();
      expect(validated2).not.toBeNull();
      expect(validated1!.id).toBe(validated2!.id);

      // Cleanup
      await cleanupTestData(connectionString, testData.organization.id);
    });
  });

  // ===========================================================================
  // getById Tests
  // ===========================================================================

  describe("getById", () => {
    test("returns API key when found", async () => {
      // Arrange
      const keyId = testData.apiKey.id;

      // Act
      const apiKey = await apiKeysService.getById(keyId);

      // Assert
      expect(apiKey).toBeDefined();
      expect(apiKey!.id).toBe(keyId);
      expect(apiKey!.organization_id).toBe(testData.organization.id);

      // Cleanup
      await cleanupTestData(connectionString, testData.organization.id);
    });

    test("returns undefined for non-existent API key", async () => {
      // Arrange
      const fakeKeyId = uuidv4();

      // Act
      const apiKey = await apiKeysService.getById(fakeKeyId);

      // Assert
      expect(apiKey).toBeUndefined();

      // Cleanup
      await cleanupTestData(connectionString, testData.organization.id);
    });
  });

  // ===========================================================================
  // listByOrganization Tests
  // ===========================================================================

  describe("listByOrganization", () => {
    test("returns all API keys for organization", async () => {
      // Arrange
      const orgId = testData.organization.id;

      // Act
      const keys = await apiKeysService.listByOrganization(orgId);

      // Assert
      expect(keys).toBeDefined();
      expect(keys.length).toBeGreaterThanOrEqual(1);
      expect(keys.some((k) => k.id === testData.apiKey.id)).toBe(true);

      // Cleanup
      await cleanupTestData(connectionString, testData.organization.id);
    });

    test("returns empty array for organization with no keys", async () => {
      // Arrange
      const fakeOrgId = uuidv4();

      // Act
      const keys = await apiKeysService.listByOrganization(fakeOrgId);

      // Assert
      expect(keys).toEqual([]);

      // Cleanup
      await cleanupTestData(connectionString, testData.organization.id);
    });
  });

  // ===========================================================================
  // create Tests
  // ===========================================================================

  describe("create", () => {
    test("creates new API key with generated secret", async () => {
      // Arrange
      const keyData = {
        user_id: testData.user.id,
        organization_id: testData.organization.id,
        name: "Test API Key",
        is_active: true,
      };

      // Act
      const { apiKey, plainKey } = await apiKeysService.create(keyData);

      // Assert
      expect(apiKey).toBeDefined();
      expect(apiKey.id).toBeDefined();
      expect(apiKey.name).toBe("Test API Key");
      expect(apiKey.is_active).toBe(true);
      expect(apiKey.user_id).toBe(testData.user.id);
      expect(apiKey.organization_id).toBe(testData.organization.id);

      // Plain key should be returned only once
      expect(plainKey).toBeDefined();
      expect(plainKey.startsWith("eliza_")).toBe(true);

      // Verify can validate with plain key
      const validated = await apiKeysService.validateApiKey(plainKey);
      expect(validated!.id).toBe(apiKey.id);

      // Cleanup
      await apiKeysService.delete(apiKey.id);
      await cleanupTestData(connectionString, testData.organization.id);
    });

    test("creates API key with expiration date", async () => {
      // Arrange
      const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000); // 30 days
      const keyData = {
        user_id: testData.user.id,
        organization_id: testData.organization.id,
        name: "Expiring Key",
        is_active: true,
        expires_at: expiresAt,
      };

      // Act
      const { apiKey } = await apiKeysService.create(keyData);

      // Assert
      expect(apiKey.expires_at).toBeDefined();
      expect(new Date(apiKey.expires_at!).getTime()).toBeCloseTo(
        expiresAt.getTime(),
        -3, // Within 1 second
      );

      // Cleanup
      await apiKeysService.delete(apiKey.id);
      await cleanupTestData(connectionString, testData.organization.id);
    });

    test("key hash is stored, not plain key", async () => {
      // Arrange
      const keyData = {
        user_id: testData.user.id,
        organization_id: testData.organization.id,
        name: "Hash Test Key",
        is_active: true,
      };

      // Act
      const { apiKey, plainKey } = await apiKeysService.create(keyData);

      // Assert - The stored key_hash should be SHA256 of plainKey
      const expectedHash = crypto
        .createHash("sha256")
        .update(plainKey)
        .digest("hex");
      expect(apiKey.key_hash).toBe(expectedHash);

      // Cleanup
      await apiKeysService.delete(apiKey.id);
      await cleanupTestData(connectionString, testData.organization.id);
    });
  });

  // ===========================================================================
  // update Tests
  // ===========================================================================

  describe("update", () => {
    test("updates API key name", async () => {
      // Arrange
      const keyId = testData.apiKey.id;
      const newName = "Updated Key Name";

      // Act
      const updated = await apiKeysService.update(keyId, { name: newName });

      // Assert
      expect(updated).toBeDefined();
      expect(updated!.name).toBe(newName);

      // Cleanup
      await cleanupTestData(connectionString, testData.organization.id);
    });

    test("deactivates API key", async () => {
      // Arrange
      const { apiKey: newKey, plainKey } = await apiKeysService.create({
        user_id: testData.user.id,
        organization_id: testData.organization.id,
        name: "Deactivate Test",
        is_active: true,
      });

      // Verify initially active
      expect(newKey.is_active).toBe(true);

      // Act
      const updated = await apiKeysService.update(newKey.id, {
        is_active: false,
      });

      // Assert
      expect(updated!.is_active).toBe(false);

      // Validation should return the key but it's inactive
      const validated = await apiKeysService.validateApiKey(plainKey);
      // Note: validateApiKey returns key even if inactive, caller checks is_active
      expect(validated).toBeNull(); // findActiveByHash only returns active keys

      // Cleanup
      await apiKeysService.delete(newKey.id);
      await cleanupTestData(connectionString, testData.organization.id);
    });

    test("invalidates cache after update", async () => {
      // Arrange
      const { apiKey: newKey, plainKey } = await apiKeysService.create({
        user_id: testData.user.id,
        organization_id: testData.organization.id,
        name: "Cache Invalidation Test",
        is_active: true,
      });

      // Prime the cache
      await apiKeysService.validateApiKey(plainKey);

      // Act - Deactivate the key
      await apiKeysService.update(newKey.id, { is_active: false });

      // Assert - Cache should be invalidated
      const validated = await apiKeysService.validateApiKey(plainKey);
      expect(validated).toBeNull();

      // Cleanup
      await apiKeysService.delete(newKey.id);
      await cleanupTestData(connectionString, testData.organization.id);
    });
  });

  // ===========================================================================
  // incrementUsage Tests
  // ===========================================================================

  describe("incrementUsage", () => {
    test("increments usage count", async () => {
      // Arrange
      const { apiKey: newKey } = await apiKeysService.create({
        user_id: testData.user.id,
        organization_id: testData.organization.id,
        name: "Usage Test",
        is_active: true,
      });

      // Initial usage should be 0
      const initial = await apiKeysService.getById(newKey.id);
      const initialUsage = initial!.usage_count || 0;

      // Act
      await apiKeysService.incrementUsage(newKey.id);
      await apiKeysService.incrementUsage(newKey.id);
      await apiKeysService.incrementUsage(newKey.id);

      // Assert
      const updated = await apiKeysService.getById(newKey.id);
      expect(updated!.usage_count).toBe(initialUsage + 3);

      // Cleanup
      await apiKeysService.delete(newKey.id);
      await cleanupTestData(connectionString, testData.organization.id);
    });

    test("updates last_used_at timestamp", async () => {
      // Arrange
      const { apiKey: newKey } = await apiKeysService.create({
        user_id: testData.user.id,
        organization_id: testData.organization.id,
        name: "Timestamp Test",
        is_active: true,
      });

      const before = new Date();

      // Act
      await apiKeysService.incrementUsage(newKey.id);

      // Assert
      const updated = await apiKeysService.getById(newKey.id);
      expect(updated!.last_used_at).toBeDefined();
      expect(new Date(updated!.last_used_at!).getTime()).toBeGreaterThanOrEqual(
        before.getTime() - 1000,
      );

      // Cleanup
      await apiKeysService.delete(newKey.id);
      await cleanupTestData(connectionString, testData.organization.id);
    });
  });

  // ===========================================================================
  // delete Tests
  // ===========================================================================

  describe("delete", () => {
    test("deletes API key", async () => {
      // Arrange
      const { apiKey: newKey } = await apiKeysService.create({
        user_id: testData.user.id,
        organization_id: testData.organization.id,
        name: "Delete Test",
        is_active: true,
      });

      // Verify exists
      const beforeDelete = await apiKeysService.getById(newKey.id);
      expect(beforeDelete).toBeDefined();

      // Act
      await apiKeysService.delete(newKey.id);

      // Assert
      const afterDelete = await apiKeysService.getById(newKey.id);
      expect(afterDelete).toBeUndefined();

      // Cleanup
      await cleanupTestData(connectionString, testData.organization.id);
    });

    test("invalidates cache after delete", async () => {
      // Arrange
      const { apiKey: newKey, plainKey } = await apiKeysService.create({
        user_id: testData.user.id,
        organization_id: testData.organization.id,
        name: "Cache Delete Test",
        is_active: true,
      });

      // Prime the cache
      const validated = await apiKeysService.validateApiKey(plainKey);
      expect(validated).not.toBeNull();

      // Act
      await apiKeysService.delete(newKey.id);

      // Assert - Cache should be invalidated
      const afterDelete = await apiKeysService.validateApiKey(plainKey);
      expect(afterDelete).toBeNull();

      // Cleanup
      await cleanupTestData(connectionString, testData.organization.id);
    });
  });

  // ===========================================================================
  // Security Tests
  // ===========================================================================

  describe("Security", () => {
    test("plain key is never stored in database", async () => {
      // Arrange
      const { apiKey, plainKey } = await apiKeysService.create({
        user_id: testData.user.id,
        organization_id: testData.organization.id,
        name: "Security Test",
        is_active: true,
      });

      // Assert - Check that stored data doesn't contain plain key
      const stored = await apiKeysService.getById(apiKey.id);

      // The 'key' field should contain a prefix, not the full key
      expect(stored!.key_prefix).toBeDefined();
      expect(stored!.key_prefix.length).toBe(API_KEY_PREFIX_LENGTH);
      expect(plainKey.length).toBeGreaterThan(stored!.key_prefix.length);

      // Hash should be stored, not plain key
      expect(stored!.key_hash).toBeDefined();
      expect(stored!.key_hash).not.toBe(plainKey);

      // Cleanup
      await apiKeysService.delete(apiKey.id);
      await cleanupTestData(connectionString, testData.organization.id);
    });

    test("different keys produce different hashes", () => {
      // Act
      const key1 = apiKeysService.generateApiKey();
      const key2 = apiKeysService.generateApiKey();

      // Assert
      expect(key1.hash).not.toBe(key2.hash);
    });
  });

  // ===========================================================================
  // Integration Tests
  // ===========================================================================

  describe("Integration", () => {
    test("full API key lifecycle: create, validate, use, delete", async () => {
      // Create
      const { apiKey, plainKey } = await apiKeysService.create({
        user_id: testData.user.id,
        organization_id: testData.organization.id,
        name: "Lifecycle Test",
        is_active: true,
      });
      expect(apiKey.id).toBeDefined();

      // Validate
      const validated = await apiKeysService.validateApiKey(plainKey);
      expect(validated!.id).toBe(apiKey.id);

      // Use (increment)
      await apiKeysService.incrementUsage(apiKey.id);
      const used = await apiKeysService.getById(apiKey.id);
      expect(used!.usage_count).toBe(1);

      // Update
      await apiKeysService.update(apiKey.id, { name: "Updated Lifecycle" });
      const updated = await apiKeysService.getById(apiKey.id);
      expect(updated!.name).toBe("Updated Lifecycle");

      // Delete
      await apiKeysService.delete(apiKey.id);
      const deleted = await apiKeysService.getById(apiKey.id);
      expect(deleted).toBeUndefined();

      // Validate should now fail
      const invalidated = await apiKeysService.validateApiKey(plainKey);
      expect(invalidated).toBeNull();

      // Cleanup
      await cleanupTestData(connectionString, testData.organization.id);
    });
  });

  describe("createForAgent / revokeForAgent", () => {
    test("creates a key bound to the sandbox via canonical name", async () => {
      const sandboxId = uuidv4();

      const { apiKey, plainKey } = await apiKeysService.createForAgent({
        organizationId: testData.organization.id,
        userId: testData.user.id,
        agentSandboxId: sandboxId,
      });

      expect(apiKey.name).toBe(`agent-sandbox:${sandboxId}`);
      expect(apiKey.permissions).toContain("agent");
      expect(plainKey).toMatch(/^eliza_[0-9a-f]{64}$/);

      const validated = await apiKeysService.validateApiKey(plainKey);
      expect(validated?.id).toBe(apiKey.id);
    });

    test("re-running create for the same sandbox revokes the old key", async () => {
      const sandboxId = uuidv4();

      const first = await apiKeysService.createForAgent({
        organizationId: testData.organization.id,
        userId: testData.user.id,
        agentSandboxId: sandboxId,
      });
      const second = await apiKeysService.createForAgent({
        organizationId: testData.organization.id,
        userId: testData.user.id,
        agentSandboxId: sandboxId,
      });

      expect(second.apiKey.id).not.toBe(first.apiKey.id);
      expect(await apiKeysService.validateApiKey(first.plainKey)).toBeNull();
      expect((await apiKeysService.validateApiKey(second.plainKey))?.id).toBe(
        second.apiKey.id,
      );
    });

    test("revokeForAgent removes the key from DB and cache", async () => {
      const sandboxId = uuidv4();
      const { plainKey } = await apiKeysService.createForAgent({
        organizationId: testData.organization.id,
        userId: testData.user.id,
        agentSandboxId: sandboxId,
      });
      // Prime cache
      await apiKeysService.validateApiKey(plainKey);

      await apiKeysService.revokeForAgent(sandboxId);

      expect(await apiKeysService.validateApiKey(plainKey)).toBeNull();
    });

    test("revokeForAgent is a no-op when no key exists for the sandbox", async () => {
      // Unprovisioned-then-deleted agents hit this path: deleteAgent calls
      // revokeForAgent unconditionally, so it must tolerate missing keys.
      await apiKeysService.revokeForAgent(uuidv4());
    });

    test("revokeForAgent only touches the target sandbox's key", async () => {
      const sandboxA = uuidv4();
      const sandboxB = uuidv4();

      const a = await apiKeysService.createForAgent({
        organizationId: testData.organization.id,
        userId: testData.user.id,
        agentSandboxId: sandboxA,
      });
      const b = await apiKeysService.createForAgent({
        organizationId: testData.organization.id,
        userId: testData.user.id,
        agentSandboxId: sandboxB,
      });

      await apiKeysService.revokeForAgent(sandboxA);

      expect(await apiKeysService.validateApiKey(a.plainKey)).toBeNull();
      expect((await apiKeysService.validateApiKey(b.plainKey))?.id).toBe(
        b.apiKey.id,
      );
    });
  });
});
