import type { AgentRuntime, Entity, UUID } from "@elizaos/core";
import { v4 as uuidv4 } from "uuid";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PgDatabaseAdapter } from "../../pg/adapter";
import type { PgliteDatabaseAdapter } from "../../pglite/adapter";
import { relationshipTable } from "../../schema";
import type { DrizzleDatabase } from "../../types";
import { createIsolatedTestDatabase } from "../test-helpers";

describe("Relationship Integration Tests", () => {
  let adapter: PgliteDatabaseAdapter | PgDatabaseAdapter;
  let _runtime: AgentRuntime;
  let cleanup: () => Promise<void>;
  let testAgentId: UUID;
  let testEntityId: UUID;
  let testTargetEntityId: UUID;

  beforeAll(async () => {
    const setup = await createIsolatedTestDatabase("relationship-tests");
    adapter = setup.adapter;
    _runtime = setup.runtime;
    cleanup = setup.cleanup;
    testAgentId = setup.testAgentId;

    // Generate random UUIDs for test data
    testEntityId = uuidv4() as UUID;
    testTargetEntityId = uuidv4() as UUID;

    // Create test entities
    await adapter.createEntities([
      {
        id: testEntityId,
        agentId: testAgentId,
        names: ["Test Entity"],
      } as Entity,
      {
        id: testTargetEntityId,
        agentId: testAgentId,
        names: ["Target Entity"],
      } as Entity,
    ]);
  });

  afterAll(async () => {
    if (cleanup) {
      await cleanup();
    }
  });

  describe("Relationship Tests", () => {
    beforeEach(async () => {
      await (adapter.getDatabase() as DrizzleDatabase).delete(relationshipTable);
    });

    it("should create and retrieve a relationship", async () => {
      const relationshipData = {
        sourceEntityId: testEntityId,
        targetEntityId: testTargetEntityId,
        tags: ["friend"],
      };
      const result = await adapter.createRelationship(relationshipData);
      expect(result).toBe(true);

      const retrieved = await adapter.getRelationship({
        sourceEntityId: testEntityId,
        targetEntityId: testTargetEntityId,
      });
      expect(retrieved).toBeDefined();
      expect(retrieved?.tags).toContain("friend");
    });

    it("should ignore duplicate relationship creation for the same pair", async () => {
      const relationshipData = {
        sourceEntityId: testEntityId,
        targetEntityId: testTargetEntityId,
        tags: ["friend"],
      };

      await expect(adapter.createRelationship(relationshipData)).resolves.toBe(true);
      await expect(adapter.createRelationship(relationshipData)).resolves.toBe(false);

      const relationships = await adapter.getRelationships({
        entityIds: [testEntityId, testTargetEntityId],
      });
      expect(relationships).toHaveLength(1);
    });

    it("should update an existing relationship", async () => {
      const relationshipData = {
        sourceEntityId: testEntityId,
        targetEntityId: testTargetEntityId,
        tags: ["friend"],
      };
      await adapter.createRelationship(relationshipData);

      const retrieved = await adapter.getRelationship({
        sourceEntityId: testEntityId,
        targetEntityId: testTargetEntityId,
      });
      expect(retrieved).toBeDefined();

      const updatedRelationship = {
        ...retrieved!,
        tags: ["best_friend"],
        metadata: { since: "2023" },
      };
      await adapter.updateRelationship(updatedRelationship);

      const updatedRetrieved = await adapter.getRelationship({
        sourceEntityId: testEntityId,
        targetEntityId: testTargetEntityId,
      });
      expect(updatedRetrieved?.tags).toContain("best_friend");
      expect(updatedRetrieved?.metadata).toEqual({
        since: "2023",
      });
    });

    it("should retrieve relationships by entity ID and tags", async () => {
      await adapter.createRelationship({
        sourceEntityId: testEntityId,
        targetEntityId: testTargetEntityId,
        tags: ["friend", "colleague"],
      });

      const otherTargetId = uuidv4() as UUID;
      await adapter.createEntities([
        {
          id: otherTargetId,
          agentId: testAgentId,
          names: ["Other Entity"],
        } as Entity,
      ]);
      await adapter.createRelationship({
        sourceEntityId: testEntityId,
        targetEntityId: otherTargetId,
        tags: ["family"],
      });

      const results = await adapter.getRelationships({
        entityId: testEntityId,
        tags: ["friend"],
      });
      expect(results).toHaveLength(1);
      expect(results[0].targetEntityId).toBe(testTargetEntityId);
    });

    it("should retrieve relationships by entityIds and tags", async () => {
      await adapter.createRelationship({
        sourceEntityId: testEntityId,
        targetEntityId: testTargetEntityId,
        tags: ["friend", "colleague"],
      });

      const results = await adapter.getRelationships({
        entityIds: [testEntityId],
        tags: ["friend"],
      });
      expect(results).toHaveLength(1);
      expect(results[0].targetEntityId).toBe(testTargetEntityId);
    });
  });
});
