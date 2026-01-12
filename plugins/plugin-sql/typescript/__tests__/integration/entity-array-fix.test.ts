import type { Entity, UUID } from "@elizaos/core";
import { stringToUuid } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PgDatabaseAdapter } from "../../pg/adapter";
import type { PgliteDatabaseAdapter } from "../../pglite/adapter";
import { createTestDatabase } from "../test-helpers";

// Helper type for testing edge cases with non-standard Entity inputs
type PartialEntity = Partial<Entity> & {
  id: UUID;
  agentId: UUID;
  names?: string | string[] | Set<string> | number | boolean | object | null | undefined;
  metadata?: Record<string, unknown>;
};

// Helper function to create test entity with type assertion for edge cases
function createTestEntity(entity: PartialEntity): Entity {
  return entity as Entity;
}

describe("Entity Array Serialization Fix Tests", () => {
  let adapter: PgliteDatabaseAdapter | PgDatabaseAdapter;
  let cleanup: () => Promise<void>;
  let testAgentId: UUID;

  beforeEach(async () => {
    testAgentId = stringToUuid(`test-agent-${Date.now()}`);
    const testDB = await createTestDatabase(testAgentId);
    adapter = testDB.adapter;
    cleanup = testDB.cleanup;
  });

  afterEach(async () => {
    if (cleanup) {
      await cleanup();
    }
  });

  describe("Entity Creation with Names Array", () => {
    it("should create entity with single name in array", async () => {
      const entityId = stringToUuid(`entity-single-${Date.now()}`);
      const entity: Entity = {
        id: entityId,
        agentId: testAgentId,
        names: ["user-test123"],
        metadata: { web: { userName: "user-test123" } },
      };

      const result = await adapter.createEntities([entity]);
      expect(result).toBe(true);

      const retrieved = await adapter.getEntitiesByIds([entityId]);
      expect(retrieved).not.toBeNull();
      if (!retrieved) throw new Error("Entities should exist");
      expect(retrieved.length).toBe(1);
      if (!retrieved[0]) throw new Error("Entity should exist");
      expect(Array.isArray(retrieved[0].names)).toBe(true);
      expect(retrieved[0].names).toEqual(["user-test123"]);
    });

    it("should create entity with multiple names in array", async () => {
      const entityId = stringToUuid(`entity-multiple-${Date.now()}`);
      const entity: Entity = {
        id: entityId,
        agentId: testAgentId,
        names: ["user-primary", "user-alias1", "user-alias2"],
        metadata: { web: { userName: "user-primary" } },
      };

      const result = await adapter.createEntities([entity]);
      expect(result).toBe(true);

      const retrieved = await adapter.getEntitiesByIds([entityId]);
      expect(retrieved).not.toBeNull();
      if (!retrieved || !retrieved[0]) throw new Error("Entity should exist");
      expect(Array.isArray(retrieved[0].names)).toBe(true);
      expect(retrieved[0].names).toEqual(["user-primary", "user-alias1", "user-alias2"]);
    });

    it("should handle entity with empty names array", async () => {
      const entityId = stringToUuid(`entity-empty-${Date.now()}`);
      const entity: Entity = {
        id: entityId,
        agentId: testAgentId,
        names: [],
        metadata: {},
      };

      const result = await adapter.createEntities([entity]);
      expect(result).toBe(true);

      const retrieved = await adapter.getEntitiesByIds([entityId]);
      expect(retrieved).not.toBeNull();
      if (!retrieved || !retrieved[0]) throw new Error("Entity should exist");
      expect(Array.isArray(retrieved[0].names)).toBe(true);
      expect(retrieved[0].names).toEqual([]);
    });

    it("should handle entity with Set-like names by converting to array", async () => {
      const entityId = stringToUuid(`entity-set-${Date.now()}`);

      // Simulate what might happen if names accidentally becomes a Set
      const namesSet = new Set(["user-name1", "user-name2"]);
      // Use type assertion to test edge case where names is a Set (not conforming to Entity type)
      const entity = createTestEntity({
        id: entityId,
        agentId: testAgentId,
        names: namesSet, // This should be normalized to an array
        metadata: {},
      });

      const result = await adapter.createEntities([entity]);
      expect(result).toBe(true);

      const retrieved = await adapter.getEntitiesByIds([entityId]);
      expect(retrieved).not.toBeNull();
      if (!retrieved || !retrieved[0]) throw new Error("Entity should exist");
      expect(Array.isArray(retrieved[0].names)).toBe(true);
      // Set order is not guaranteed, so we just check the values are present
      expect(retrieved[0].names.length).toBe(2);
      expect(retrieved[0].names).toContain("user-name1");
      expect(retrieved[0].names).toContain("user-name2");
    });
  });

  describe("Entity Update with Names Array", () => {
    it("should update entity names correctly", async () => {
      const entityId = stringToUuid(`entity-update-${Date.now()}`);

      // Create initial entity
      const entity: Entity = {
        id: entityId,
        agentId: testAgentId,
        names: ["original-name"],
        metadata: {},
      };

      await adapter.createEntities([entity]);

      // Update with new names
      const updatedEntity: Entity = {
        id: entityId,
        agentId: testAgentId,
        names: ["original-name", "new-name", "another-name"],
        metadata: { updated: true },
      };

      await adapter.updateEntity(updatedEntity);

      const retrieved = await adapter.getEntitiesByIds([entityId]);
      expect(retrieved).not.toBeNull();
      if (!retrieved || !retrieved[0]) throw new Error("Entity should exist");
      expect(Array.isArray(retrieved[0].names)).toBe(true);
      expect(retrieved[0].names).toEqual(["original-name", "new-name", "another-name"]);
    });

    it("should handle Set-like names in update by converting to array", async () => {
      const entityId = stringToUuid(`entity-update-set-${Date.now()}`);

      // Create initial entity
      const entity: Entity = {
        id: entityId,
        agentId: testAgentId,
        names: ["original-name"],
        metadata: {},
      };

      await adapter.createEntities([entity]);

      // Update with Set-like names
      const namesSet = new Set(["updated-name1", "updated-name2"]);
      // Use type assertion to test edge case where names is a Set (not conforming to Entity type)
      const updatedEntity = createTestEntity({
        id: entityId,
        agentId: testAgentId,
        names: namesSet, // This should be normalized to an array
        metadata: { updated: true },
      });

      await adapter.updateEntity(updatedEntity);

      const retrieved = await adapter.getEntitiesByIds([entityId]);
      expect(retrieved).not.toBeNull();
      if (!retrieved || !retrieved[0]) throw new Error("Entity should exist");
      expect(Array.isArray(retrieved[0].names)).toBe(true);
      expect(retrieved[0].names.length).toBe(2);
      expect(retrieved[0].names).toContain("updated-name1");
      expect(retrieved[0].names).toContain("updated-name2");
    });
  });

  describe("Batch Entity Creation", () => {
    it("should create multiple entities with proper name arrays", async () => {
      const timestamp = Date.now();
      const entities: Entity[] = Array.from({ length: 5 }, (_, i) => ({
        id: stringToUuid(`batch-entity-${timestamp}-${i}`),
        agentId: testAgentId,
        names: [`user-${i}`, `alias-${i}`],
        metadata: { index: i },
      }));

      const result = await adapter.createEntities(entities);
      expect(result).toBe(true);

      const entityIds = entities.map((e) => e.id);
      const retrieved = await adapter.getEntitiesByIds(entityIds);

      expect(retrieved).not.toBeNull();
      if (!retrieved) throw new Error("Entities should exist");
      expect(retrieved.length).toBe(5);

      // Verify each entity has proper array format without relying on order
      retrieved.forEach((entity) => {
        expect(Array.isArray(entity.names)).toBe(true);
        expect(entity.names.length).toBe(2);
        expect(entity.names[0]).toMatch(/^user-\d+$/);
        expect(entity.names[1]).toMatch(/^alias-\d+$/);
      });
    });
  });

  describe("Edge Cases", () => {
    it("should handle entity with special characters in names", async () => {
      const entityId = stringToUuid(`entity-special-${Date.now()}`);
      const entity: Entity = {
        id: entityId,
        agentId: testAgentId,
        names: ["user@test.com", "user-with-dash", "user_with_underscore", "user{with}braces"],
        metadata: {},
      };

      const result = await adapter.createEntities([entity]);
      expect(result).toBe(true);

      const retrieved = await adapter.getEntitiesByIds([entityId]);
      expect(retrieved).not.toBeNull();
      if (!retrieved || !retrieved[0]) throw new Error("Entity should exist");
      expect(Array.isArray(retrieved[0].names)).toBe(true);
      expect(retrieved[0].names).toEqual([
        "user@test.com",
        "user-with-dash",
        "user_with_underscore",
        "user{with}braces",
      ]);
    });

    it("should handle entity with unicode characters in names", async () => {
      const entityId = stringToUuid(`entity-unicode-${Date.now()}`);
      const entity: Entity = {
        id: entityId,
        agentId: testAgentId,
        names: ["用户名", "ユーザー", "пользователь", "👤user"],
        metadata: {},
      };

      const result = await adapter.createEntities([entity]);
      expect(result).toBe(true);

      const retrieved = await adapter.getEntitiesByIds([entityId]);
      expect(retrieved).not.toBeNull();
      if (!retrieved || !retrieved[0]) throw new Error("Entity should exist");
      expect(Array.isArray(retrieved[0].names)).toBe(true);
      expect(retrieved[0].names).toEqual(["用户名", "ユーザー", "пользователь", "👤user"]);
    });
  });
});
