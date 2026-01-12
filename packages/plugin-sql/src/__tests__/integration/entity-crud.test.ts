import { describe, it, expect, beforeEach, beforeAll, afterAll } from 'bun:test';
import { createIsolatedTestDatabase } from '../test-helpers';
import { v4 as uuidv4 } from 'uuid';
import type { Entity, UUID, Metadata } from '@elizaos/core';
import { PgDatabaseAdapter } from '../../pg/adapter';
import { PgliteDatabaseAdapter } from '../../pglite/adapter';

describe('Entity CRUD Operations', () => {
  let adapter: PgliteDatabaseAdapter | PgDatabaseAdapter;
  let cleanup: () => Promise<void>;
  let testAgentId: UUID;

  beforeAll(async () => {
    const setup = await createIsolatedTestDatabase('entity-crud');
    adapter = setup.adapter;
    cleanup = setup.cleanup;
    testAgentId = setup.testAgentId;
  });

  afterAll(async () => {
    if (cleanup) {
      await cleanup();
    }
  });

  describe('Basic CRUD Operations', () => {
    beforeEach(async () => {
      // Clean up any existing entities
      const existingEntities = await adapter.searchEntitiesByName({
        query: '',
        agentId: testAgentId,
        limit: 100,
      });
      for (const entity of existingEntities) {
        if (entity.id) {
          await adapter.deleteEntity(entity.id);
        }
      }
    });

    it('should create and retrieve an entity', async () => {
      const entity: Entity = {
        id: uuidv4() as UUID,
        agentId: testAgentId,
        names: ['Test Entity'],
        metadata: { type: 'test' },
      };

      const result = await adapter.createEntities([entity]);
      expect(result).toBe(true);

      const retrieved = await adapter.getEntitiesByIds([entity.id!]);
      expect(retrieved).toHaveLength(1);
      expect(retrieved![0].id).toBe(entity.id as UUID);
    });

    it('should update an entity', async () => {
      const entity: Entity = {
        id: uuidv4() as UUID,
        agentId: testAgentId,
        names: ['Original Name'],
        metadata: { version: 1 },
      };

      await adapter.createEntities([entity]);

      const updatedEntity: Entity = {
        ...entity,
        names: ['Updated Name'],
        metadata: { version: 2 },
      };

      await adapter.updateEntity(updatedEntity);

      const retrieved = await adapter.getEntitiesByIds([entity.id!]);
      expect(retrieved![0].names).toContain('Updated Name');
      expect(retrieved![0].metadata?.version).toBe(2);
    });

    it('should delete an entity', async () => {
      const entity: Entity = {
        id: uuidv4() as UUID,
        agentId: testAgentId,
        names: ['To Delete'],
        metadata: {},
      };

      await adapter.createEntities([entity]);

      // Verify it exists
      let retrieved = await adapter.getEntitiesByIds([entity.id!]);
      expect(retrieved).toHaveLength(1);

      // Delete it
      await adapter.deleteEntity(entity.id!);

      // Verify it's gone
      retrieved = await adapter.getEntitiesByIds([entity.id!]);
      expect(retrieved).toHaveLength(0);
    });
  });

  describe('Advanced Entity Operations', () => {
    it('should get entities by multiple names', async () => {
      const entities = [
        {
          id: uuidv4() as UUID,
          agentId: testAgentId,
          names: ['John Doe', 'JD'],
          metadata: { type: 'person' },
        },
        {
          id: uuidv4() as UUID,
          agentId: testAgentId,
          names: ['Jane Doe', 'JD2'],
          metadata: { type: 'person' },
        },
        {
          id: uuidv4() as UUID,
          agentId: testAgentId,
          names: ['Bob Smith'],
          metadata: { type: 'person' },
        },
      ];

      for (const entity of entities) {
        await adapter.createEntities([entity]);
      }

      // Search for Doe entities
      const doeEntities = await adapter.getEntitiesByNames({
        names: ['John Doe', 'Jane Doe'],
        agentId: testAgentId,
      });

      expect(doeEntities).toHaveLength(2);
      const names = doeEntities.flatMap((e) => e.names);
      expect(names).toContain('John Doe');
      expect(names).toContain('Jane Doe');
    });

    it('should search entities with partial name matching', async () => {
      const entities = [
        {
          id: uuidv4() as UUID,
          agentId: testAgentId,
          names: ['Alexander Hamilton'],
          metadata: {},
        },
        {
          id: uuidv4() as UUID,
          agentId: testAgentId,
          names: ['Alexandra Smith'],
          metadata: {},
        },
        {
          id: uuidv4() as UUID,
          agentId: testAgentId,
          names: ['Bob Johnson'],
          metadata: {},
        },
      ];

      for (const entity of entities) {
        await adapter.createEntities([entity]);
      }

      const results = await adapter.searchEntitiesByName({
        query: 'Alex',
        agentId: testAgentId,
        limit: 10,
      });

      expect(results).toHaveLength(2);
      expect(
        results.every((e) => e.names.some((name) => name.toLowerCase().includes('alex')))
      ).toBe(true);
    });

    it('should handle entity metadata operations', async () => {
      const entity: Entity = {
        id: uuidv4() as UUID,
        agentId: testAgentId,
        names: ['Metadata Test'],
        metadata: {
          level: 1,
          tags: ['test', 'metadata'],
          nested: {
            property: 'value',
            array: [1, 2, 3],
          },
        },
      };

      await adapter.createEntities([entity]);

      const retrieved = await adapter.getEntitiesByIds([entity.id!]);
      expect(retrieved![0].metadata).toEqual(entity.metadata as Metadata);
      expect((retrieved![0].metadata?.nested as any)?.array).toEqual([1, 2, 3]);
    });

    it('should handle duplicate entity creation (idempotent upsert)', async () => {
      const entityId = uuidv4() as UUID;
      const entity1: Entity = {
        id: entityId,
        agentId: testAgentId,
        names: ['Original Name'],
        metadata: { version: 1 },
      };
      const entity2: Entity = {
        id: entityId,
        agentId: testAgentId,
        names: ['Updated Name'],
        metadata: { version: 2 },
      };

      // First creation should succeed
      const firstResult = await adapter.createEntities([entity1]);
      expect(firstResult).toBe(true);

      // Second creation should succeed silently (onConflictDoNothing)
      const secondResult = await adapter.createEntities([entity2]);
      expect(secondResult).toBe(true);

      // Original entity should remain unchanged (not updated by second insert)
      const retrieved = await adapter.getEntitiesByIds([entityId]);
      expect(retrieved).toHaveLength(1);
      expect(retrieved![0].names).toEqual(['Original Name']);
      expect(retrieved![0].metadata).toEqual({ version: 1 });
    });

    it('should handle batch entity operations', async () => {
      const entities: Entity[] = [];
      for (let i = 0; i < 5; i++) {
        entities.push({
          id: uuidv4() as UUID,
          agentId: testAgentId,
          names: [`Batch Entity ${i}`],
          metadata: { index: i },
        });
      }

      // Create all entities
      const result = await adapter.createEntities(entities);
      expect(result).toBe(true);

      // Verify all were created
      const entityIds = entities.map((e) => e.id!);
      const retrieved = await adapter.getEntitiesByIds(entityIds);
      expect(retrieved).toHaveLength(5);

      // Delete all entities
      for (const entity of entities) {
        await adapter.deleteEntity(entity.id!);
      }

      // Verify all were deleted
      const afterDelete = await adapter.getEntitiesByIds(entityIds);
      expect(afterDelete).toHaveLength(0);
    });
  });

  describe('Edge Cases', () => {
    it('should handle empty search query', async () => {
      // Create a few entities
      for (let i = 0; i < 3; i++) {
        await adapter.createEntities([
          {
            id: uuidv4() as UUID,
            agentId: testAgentId,
            names: [`Entity ${i}`],
            metadata: {},
          },
        ]);
      }

      const results = await adapter.searchEntitiesByName({
        query: '',
        agentId: testAgentId,
        limit: 10,
      });

      expect(results.length).toBeGreaterThanOrEqual(3);
    });

    it('should handle update of non-existent entity', async () => {
      const entity: Entity = {
        id: uuidv4() as UUID,
        agentId: testAgentId,
        names: ['Non-existent'],
        metadata: {},
      };

      // Should not throw - updateEntity should handle non-existent entities gracefully
      await adapter.updateEntity(entity);

      // Entity should not exist
      const retrieved = await adapter.getEntitiesByIds([entity.id!]);
      expect(retrieved).toHaveLength(0);
    });

    it('should handle deletion of non-existent entity', async () => {
      const nonExistentId = uuidv4() as UUID;

      // Should not throw - deleteEntity should handle non-existent entities gracefully
      await adapter.deleteEntity(nonExistentId);
    });

    it('should handle entities with multiple names in search', async () => {
      const entity: Entity = {
        id: uuidv4() as UUID,
        agentId: testAgentId,
        names: ['Primary Name', 'Alias One', 'Alias Two'],
        metadata: {},
      };

      await adapter.createEntities([entity]);

      // Should find by any name
      const result1 = await adapter.searchEntitiesByName({
        query: 'Primary',
        agentId: testAgentId,
      });
      expect(result1).toHaveLength(1);

      const result2 = await adapter.searchEntitiesByName({
        query: 'Alias',
        agentId: testAgentId,
      });
      expect(result2).toHaveLength(1);
    });

    it('should handle case-insensitive name search', async () => {
      const entity: Entity = {
        id: uuidv4() as UUID,
        agentId: testAgentId,
        names: ['CaseSensitive Name'],
        metadata: {},
      };

      await adapter.createEntities([entity]);

      const results = await adapter.searchEntitiesByName({
        query: 'CASESENSITIVE',
        agentId: testAgentId,
      });

      expect(results).toHaveLength(1);
      expect(results[0].id).toBe(entity.id as UUID);
    });
  });
});
