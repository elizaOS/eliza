import { describe, expect, it, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { PgliteDatabaseAdapter } from '../../src/pglite/adapter';
import { PGliteClientManager } from '../../src/pglite/manager';
import { type UUID, type Entity } from '@elizaos/core';
import { entityTestAgentSettings, testEntities } from './seed';
import { v4 } from 'uuid';
import { setupMockedMigrations } from '../test-helpers';

// Setup mocked migrations before any tests run or instances are created
setupMockedMigrations();

// Mock only the logger
vi.mock('@elizaos/core', async () => {
  const actual = await vi.importActual('@elizaos/core');
  return {
    ...actual,
    logger: {
      debug: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
      success: vi.fn(),
      trace: vi.fn(),
      info: vi.fn(),
    },
  };
});

describe('Entity Integration Tests', () => {
  // Database connection variables
  let connectionManager: PGliteClientManager;
  let adapter: PgliteDatabaseAdapter;
  let testAgentId: UUID;

  beforeAll(async () => {
    // Create a random agent ID for use with the adapter
    testAgentId = entityTestAgentSettings.id as UUID;

    // Initialize connection manager and adapter
    connectionManager = new PGliteClientManager({});
    await connectionManager.initialize();
    adapter = new PgliteDatabaseAdapter(testAgentId, connectionManager);
    await adapter.init();

    // Ensure the test agent exists
    await adapter.createAgent(entityTestAgentSettings);
  }, 5000);

  afterAll(async () => {
    // Clean up any test agents
    const client = connectionManager.getConnection();
    try {
      await client.query(`DELETE FROM agents WHERE name = '${entityTestAgentSettings.name}'`);
    } finally {
      // No release needed for PGlite instance from getConnection like with pg PoolClient
    }

    // Close all connections
    await adapter.close();
  });

  beforeEach(async () => {
    // Clean up any existing entity entries for our test agent
    try {
      const client = connectionManager.getConnection();
      await client.query(`DELETE FROM entities WHERE "agentId" = '${testAgentId}'`);
      // Also clean up components
      await client.query(`DELETE FROM components WHERE "agentId" = '${testAgentId}'`);
    } catch (error) {
      console.error('Error cleaning test entity data:', error);
    }
  });

  afterEach(async () => {
    vi.clearAllMocks();
  });

  describe('createEntity', () => {
    it('should successfully create a basic entity', async () => {
      const entity = testEntities.basicEntity;

      const result = await adapter.createEntities([entity]);

      expect(result).toBe(true);

      // Verify the entity was created in the database
      const retrievedEntities = await adapter.getEntityByIds([entity.id]);
      expect(retrievedEntities).not.toBeNull();
      expect(retrievedEntities?.length).toBe(1);
      if (!retrievedEntities) return;
      const retrievedEntity = retrievedEntities[0];
      expect(retrievedEntity?.id).toBe(entity.id);
      expect(retrievedEntity?.names).toEqual(entity.names);
      expect(retrievedEntity?.metadata).toEqual(entity.metadata);
    });

    it('should successfully create an entity with complex metadata', async () => {
      const entity = testEntities.complexEntity;

      const result = await adapter.createEntities([entity]);

      expect(result).toBe(true);

      // Verify the entity was created with complex metadata
      const retrievedEntities = await adapter.getEntityByIds([entity.id]);
      expect(retrievedEntities).not.toBeNull();
      if (!retrievedEntities) return;
      const retrievedEntity = retrievedEntities[0];
      expect(retrievedEntity?.metadata).toEqual(entity.metadata);

      // Verify nested objects in metadata
      expect(retrievedEntity?.metadata?.properties?.strength).toBe(10);
      expect(retrievedEntity?.metadata?.properties?.intelligence).toBe(15);
      expect(retrievedEntity?.metadata?.properties?.isSpecial).toBe(true);

      // Verify arrays in metadata
      expect(retrievedEntity?.metadata?.tags).toEqual(['test', 'entity', 'complex']);
    });

    it('should handle entity creation with empty names array', async () => {
      const entity = {
        ...testEntities.basicEntity,
        id: vi.fn().mockReturnValue(crypto.randomUUID())(),
        names: [],
      };

      const result = await adapter.createEntities([entity]);

      expect(result).toBe(true);

      const retrievedEntities = await adapter.getEntityByIds([entity.id]);
      expect(retrievedEntities).not.toBeNull();
      if (!retrievedEntities) return;
      const retrievedEntity = retrievedEntities[0];
      expect(retrievedEntity?.names).toEqual([]);
    });

    it('should handle entity creation with empty metadata', async () => {
      const entity = {
        ...testEntities.basicEntity,
        id: vi.fn().mockReturnValue(crypto.randomUUID())(),
        metadata: {},
      };

      const result = await adapter.createEntities([entity]);

      expect(result).toBe(true);

      const retrievedEntities = await adapter.getEntityByIds([entity.id]);
      expect(retrievedEntities).not.toBeNull();
      if (!retrievedEntities) return;
      const retrievedEntity = retrievedEntities[0];
      expect(retrievedEntity?.metadata).toEqual({});
    });
  });

  describe('getEntityById', () => {
    it('should retrieve an existing entity', async () => {
      // Create entity first
      const entity = testEntities.basicEntity;
      await adapter.createEntities([entity]);

      // Retrieve entity
      const retrievedEntities = await adapter.getEntityByIds([entity.id]);
      expect(retrievedEntities).not.toBeNull();
      if (!retrievedEntities) return;
      const retrievedEntity = retrievedEntities[0];
      expect(retrievedEntity?.id).toBe(entity.id);
      expect(retrievedEntity?.names).toEqual(entity.names);
      expect(retrievedEntity?.metadata).toEqual(entity.metadata);
    });

    it('should return null for non-existent entity id', async () => {
      const nonExistentId = vi.fn().mockReturnValue(crypto.randomUUID())();
      const result = await adapter.getEntityByIds([nonExistentId as UUID]);

      expect(result).toBeNull();
    });
  });

  describe('updateEntity', () => {
    it('should update an existing entity', async () => {
      // Create entity first
      const entity = testEntities.entityToUpdate;
      await adapter.createEntities([entity]);

      // Update entity
      const updatedEntity: Entity = {
        ...entity,
        names: [...entity.names, 'Updated Name'],
        metadata: {
          ...entity.metadata,
          version: 2,
          updatedAt: Date.now(),
        },
      };

      await adapter.updateEntity(updatedEntity);

      // Retrieve updated entity
      const retrievedEntities = await adapter.getEntityByIds([entity.id]);
      expect(retrievedEntities).not.toBeNull();
      if (!retrievedEntities) return;
      const retrievedEntity = retrievedEntities[0];

      expect(retrievedEntity?.names).toEqual(updatedEntity.names);
      expect(retrievedEntity?.metadata).toEqual(updatedEntity.metadata);
      expect(retrievedEntity?.metadata?.version).toBe(2);
    });

    it('should only update specified fields', async () => {
      // Create entity first
      const entity = testEntities.entityToUpdate;
      await adapter.createEntities([entity]);

      // Update only names
      const partialUpdate: Entity = {
        ...entity,
        names: ['Only Names Updated'],
      };

      await adapter.updateEntity(partialUpdate);

      // Retrieve updated entity
      const retrievedEntities = await adapter.getEntityByIds([entity.id]);
      expect(retrievedEntities).not.toBeNull();
      if (!retrievedEntities) return;
      const retrievedEntity = retrievedEntities[0];
      expect(retrievedEntity?.names).toEqual(partialUpdate.names);
      // Metadata should remain unchanged
      expect(retrievedEntity?.metadata).toEqual(entity.metadata);
    });
  });

  describe('Error handling', () => {
    it('should handle errors when creating entity with duplicate ID', async () => {
      // First, create the entity successfully
      const entity = testEntities.basicEntity;
      await adapter.createEntities([entity]);

      // Try to create the entity again with the same ID - should return false, not throw
      expect(await adapter.createEntities([entity])).toBe(false);
    });

    it('should handle errors when creating entity with invalid data', async () => {
      // Create an invalid entity (missing required agentId)
      const invalidEntity = {
        id: v4() as UUID,
        names: ['Invalid Entity'],
        // Missing agentId which is required
      } as Entity;

      // This should not throw but return false
      expect(await adapter.createEntities([invalidEntity])).toBe(false);
    });
  });
});
