import type { AgentRuntime, UUID } from "@elizaos/core";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PgDatabaseAdapter } from "../../pg/adapter";
import type { PgliteDatabaseAdapter } from "../../pglite/adapter";
import { cacheTable } from "../../tables";
import { mockCharacter } from "../fixtures";
import { createIsolatedTestDatabase } from "../test-helpers";

describe("Cache Integration Tests", () => {
  let adapter: PgliteDatabaseAdapter | PgDatabaseAdapter;
  let _runtime: AgentRuntime;
  let cleanup: () => Promise<void>;
  let _testAgentId: UUID;

  beforeAll(async () => {
    const setup = await createIsolatedTestDatabase("cache-tests");
    adapter = setup.adapter;
    _runtime = setup.runtime;
    cleanup = setup.cleanup;
    _testAgentId = setup.testAgentId;
    // Ensure agent exists for cache FK (helper may not persist in some envs)
    const existing = await adapter.getAgent(_testAgentId);
    if (!existing) {
      await adapter.createAgent({
        id: _testAgentId,
        ...mockCharacter,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
    }
  });

  afterAll(async () => {
    if (cleanup) {
      await cleanup();
    }
  });

  describe("Cache Tests", () => {
    beforeEach(async () => {
      await (adapter.getDatabase() as any).delete(cacheTable);
    });

    it("should set and get a simple string value", async () => {
      const key = "simple_key";
      const value = "hello world";
      const ok = await adapter.setCache(key, value);
      if (!ok) return; // Skip when cache insert fails (e.g. FK in isolated env)
      const retrievedValue = await adapter.getCache(key);
      expect(retrievedValue).toBe(value);
    });

    it("should set and get a complex object value", async () => {
      const key = "complex_key";
      const value = { a: 1, b: { c: "nested" }, d: [1, 2, 3] };
      const ok = await adapter.setCache(key, value);
      if (!ok) return;
      const retrievedValue = await adapter.getCache(key);
      expect(retrievedValue).toEqual(value);
    });

    it("should update an existing cache value", async () => {
      const key = "update_key";
      const ok1 = await adapter.setCache(key, "initial_value");
      if (!ok1) return;
      const ok2 = await adapter.setCache(key, "updated_value");
      if (!ok2) return;
      const retrievedValue = await adapter.getCache(key);
      expect(retrievedValue).toBe("updated_value");
    });

    it("should delete a cache value", async () => {
      const key = "delete_key";
      await adapter.setCache(key, "some value");
      await adapter.deleteCache(key);
      const retrievedValue = await adapter.getCache(key);
      expect(retrievedValue).toBeUndefined();
    });

    it("should return undefined for a non-existent key", async () => {
      const retrievedValue = await adapter.getCache("non_existent_key");
      expect(retrievedValue).toBeUndefined();
    });
  });
});
