import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { createIsolatedTestDatabase } from '../test-helpers';
import { v4 as uuidv4 } from 'uuid';
import type { Entity, UUID } from '@elizaos/core';
import { PgDatabaseAdapter } from '../../pg/adapter';
import { PgliteDatabaseAdapter } from '../../pglite/adapter';

describe('Entity Methods Integration Tests', () => {
  let adapter: PgliteDatabaseAdapter | PgDatabaseAdapter;
  let cleanup: () => Promise<void>;
  let testAgentId: UUID;

  beforeAll(async () => {
    const setup = await createIsolatedTestDatabase('entity-methods');
    adapter = setup.adapter;
    cleanup = setup.cleanup;
    testAgentId = setup.testAgentId;
  });

  afterAll(async () => {
    if (cleanup) {
      await cleanup();
    }
  });

  describe('deleteEntity', () => {
    it('should delete an entity by ID', async () => {
      const entity: Entity = {
        id: uuidv4() as UUID,
        agentId: testAgentId,
        names: ['Entity to Delete'],
        metadata: { type: 'test' },
      };

      // Create entity
      await adapter.createEntities([entity]);

      // Verify it exists
      let retrieved = await adapter.getEntitiesByIds([entity.id!]);
      expect(retrieved).toHaveLength(1);

      // Delete entity
      await adapter.deleteEntity(entity.id!);

      // Verify it's deleted
      retrieved = await adapter.getEntitiesByIds([entity.id!]);
      expect(retrieved).toHaveLength(0);
    });

    it('should not throw when deleting non-existent entity', async () => {
      const nonExistentId = uuidv4() as UUID;
      // Should not throw - deleteEntity should handle non-existent entities gracefully
      await adapter.deleteEntity(nonExistentId);
    });
  });

  describe('getEntitiesByNames', () => {
    it('should retrieve entities by names', async () => {
      const entity1: Entity = {
        id: uuidv4() as UUID,
        agentId: testAgentId,
        names: ['John Doe', 'Johnny'],
        metadata: { type: 'person' },
      };

      const entity2: Entity = {
        id: uuidv4() as UUID,
        agentId: testAgentId,
        names: ['Jane Doe', 'Janet'],
        metadata: { type: 'person' },
      };

      const entity3: Entity = {
        id: uuidv4() as UUID,
        agentId: testAgentId,
        names: ['Bob Smith'],
        metadata: { type: 'person' },
      };

      // Create entities
      await adapter.createEntities([entity1, entity2, entity3]);

      // Search for entities with Doe names
      const doeEntities = await adapter.getEntitiesByNames({
        names: ['John Doe', 'Jane Doe'],
        agentId: testAgentId,
      });

      expect(doeEntities).toHaveLength(2);
      expect(doeEntities.map((e) => e.id)).toContain(entity1.id);
      expect(doeEntities.map((e) => e.id)).toContain(entity2.id);
    });

    it('should return empty array when no entities match', async () => {
      const result = await adapter.getEntitiesByNames({
        names: ['Non Existent Name'],
        agentId: testAgentId,
      });

      expect(result).toEqual([]);
    });
  });

  describe('searchEntitiesByName', () => {
    it('should search entities by partial name match', async () => {
      const entities: Entity[] = [
        {
          id: uuidv4() as UUID,
          agentId: testAgentId,
          names: ['Alice Smith', 'Alicia'],
          metadata: { type: 'person' },
        },
        {
          id: uuidv4() as UUID,
          agentId: testAgentId,
          names: ['Bob Johnson'],
          metadata: { type: 'person' },
        },
        {
          id: uuidv4() as UUID,
          agentId: testAgentId,
          names: ['Alice Cooper', 'Al Cooper'],
          metadata: { type: 'person' },
        },
      ];

      // Create entities
      for (const entity of entities) {
        await adapter.createEntities([entity]);
      }

      // Search for entities with 'Alice' in name
      const searchResults = await adapter.searchEntitiesByName({
        query: 'Alice',
        agentId: testAgentId,
        limit: 10,
      });

      expect(searchResults).toHaveLength(2);
      expect(
        searchResults.every((e) => e.names.some((name) => name.toLowerCase().includes('alice')))
      ).toBe(true);
    });

    it('should respect the limit parameter', async () => {
      const entities: Entity[] = [];
      for (let i = 0; i < 5; i++) {
        entities.push({
          id: uuidv4() as UUID,
          agentId: testAgentId,
          names: [`Test Entity ${i}`],
          metadata: { index: i },
        });
      }

      // Create entities
      await adapter.createEntities(entities);

      // Search with limit
      const results = await adapter.searchEntitiesByName({
        query: 'Test',
        agentId: testAgentId,
        limit: 2,
      });

      expect(results).toHaveLength(2);
    });

    it('should return all entities when query is empty', async () => {
      const entities: Entity[] = [
        {
          id: uuidv4() as UUID,
          agentId: testAgentId,
          names: ['Entity 1'],
          metadata: {},
        },
        {
          id: uuidv4() as UUID,
          agentId: testAgentId,
          names: ['Entity 2'],
          metadata: {},
        },
      ];

      await adapter.createEntities(entities);

      const results = await adapter.searchEntitiesByName({
        query: '',
        agentId: testAgentId,
        limit: 10,
      });

      expect(results.length).toBeGreaterThanOrEqual(2);
    });

    it('should perform case-insensitive search', async () => {
      const entity: Entity = {
        id: uuidv4() as UUID,
        agentId: testAgentId,
        names: ['UPPERCASE NAME', 'MixedCase Name'],
        metadata: {},
      };

      await adapter.createEntities([entity]);

      // Search with lowercase
      let results = await adapter.searchEntitiesByName({
        query: 'uppercase',
        agentId: testAgentId,
      });
      expect(results).toHaveLength(1);

      // Search with different case
      results = await adapter.searchEntitiesByName({
        query: 'MIXEDCASE',
        agentId: testAgentId,
      });
      expect(results).toHaveLength(1);
    });
  });
});
