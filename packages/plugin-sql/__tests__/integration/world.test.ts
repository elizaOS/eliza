import { describe, expect, it, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { SqliteDatabaseAdapter } from '../../src/sqlite/adapter';
import { PGliteClientManager } from '../../src/sqlite/manager';
import { type UUID } from '@elizaos/core';
import {
  worldTestAgentId,
  worldTestEntityId,
  worldTestAgent,
  worldTestEntity,
  worldTestWorlds,
} from './seed';
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
      info: vi.fn(),
    },
  };
});

describe('World Integration Tests', () => {
  // Database connection variables
  let connectionManager: PGliteClientManager;
  let adapter: SqliteDatabaseAdapter;
  let agentId: UUID = worldTestAgentId;

  beforeAll(async () => {
    // Initialize connection manager and adapter
    connectionManager = new PGliteClientManager({});
    await connectionManager.initialize();
    adapter = new SqliteDatabaseAdapter(agentId, connectionManager);
    await adapter.init();

    try {
      // Create test agent
      await adapter.createAgent(worldTestAgent);

      // Create test entity
      await adapter.createEntities([worldTestEntity]);
    } catch (error) {
      console.error('Error in setup:', error);
      throw error;
    }
  }, 10000);

  afterAll(async () => {
    // Clean up test data
    const client = connectionManager.getConnection();
    try {
      // Delete worlds
      for (const world of worldTestWorlds) {
        await client.query(`DELETE FROM worlds WHERE id = '${world.id}'`);
      }

      // Delete entity and agent
      await client.query(`DELETE FROM entities WHERE id = '${worldTestEntityId}'`);
      await client.query(`DELETE FROM agents WHERE id = '${worldTestAgentId}'`);
    } catch (error) {
      console.error('Error cleaning test data:', error);
    }

    // Close all connections
    await adapter.close();
  }, 10000);

  beforeEach(async () => {
    // Clean up any existing test worlds before each test
    const client = connectionManager.getConnection();
    try {
      await client.query(`DELETE FROM worlds WHERE "agentId" = '${worldTestAgentId}'`);
    } catch (error) {
      console.error('Error cleaning test data:', error);
    }
  });

  afterEach(async () => {
    vi.clearAllMocks();
  });

  describe('World CRUD Operations', () => {
    it('should create a world', async () => {
      const world = worldTestWorlds[0];

      const worldId = await adapter.createWorld(world);
      expect(worldId).toBe(world.id);

      // Verify it exists in the database
      const createdWorld = await adapter.getWorld(worldId);
      expect(createdWorld).not.toBeNull();
      expect(createdWorld?.name).toBe(world.name);
      expect(createdWorld?.serverId).toBe(world.serverId);
      expect(createdWorld?.agentId).toBe(world.agentId);

      // Check the metadata was properly stored
      expect(createdWorld?.metadata?.ownership?.ownerId).toBe(world.metadata?.ownership?.ownerId);
      expect(createdWorld?.metadata?.roles?.[worldTestEntityId]).toBe(
        world.metadata?.roles?.[worldTestEntityId]
      );
    });

    it('should update an existing world', async () => {
      // Create a world first
      const world = worldTestWorlds[1];
      const worldId = await adapter.createWorld(world);

      // Update the world
      const updatedName = 'Updated World Name';
      const updatedMetadata = {
        ...world.metadata,
        custom: 'updated-value',
        tags: ['updated', 'test'],
      };

      await adapter.updateWorld({
        ...world,
        name: updatedName,
        metadata: updatedMetadata,
      });

      // Verify the update
      const updatedWorld = await adapter.getWorld(worldId);
      expect(updatedWorld?.name).toBe(updatedName);
      expect(updatedWorld?.metadata).toEqual(updatedMetadata);

      // Make sure other fields weren't changed
      expect(updatedWorld?.serverId).toBe(world.serverId);
      expect(updatedWorld?.agentId).toBe(world.agentId);
    });

    it('should delete a world', async () => {
      // Create a world first
      const world = worldTestWorlds[2];
      const worldId = await adapter.createWorld(world);

      // Verify it exists
      const createdWorld = await adapter.getWorld(worldId);
      expect(createdWorld).not.toBeNull();

      // Delete the world
      await adapter.removeWorld(worldId);

      // Verify it's gone
      const deletedWorld = await adapter.getWorld(worldId);
      expect(deletedWorld).toBeUndefined();
    });
  });

  describe('World Retrieval Operations', () => {
    it('should retrieve all worlds for an agent', async () => {
      // Create test worlds
      for (const world of worldTestWorlds) {
        await adapter.createWorld(world);
      }

      // Retrieve worlds
      const worlds = await adapter.getAllWorlds();

      // Should have at least as many worlds as we created
      expect(worlds.length).toBeGreaterThanOrEqual(worldTestWorlds.length);

      // Verify all our test worlds are in the result
      for (const testWorld of worldTestWorlds) {
        const found = worlds.find((w) => w.id === testWorld.id);
        expect(found).toBeDefined();
        expect(found?.name).toBe(testWorld.name);
        expect(found?.serverId).toBe(testWorld.serverId);
      }
    });

    it('should retrieve a specific world by ID', async () => {
      // Create a world
      const world = worldTestWorlds[0];
      await adapter.createWorld(world);

      // Retrieve by ID
      const retrievedWorld = await adapter.getWorld(world.id);
      expect(retrievedWorld).not.toBeNull();
      expect(retrievedWorld?.id).toBe(world.id);
      expect(retrievedWorld?.name).toBe(world.name);
      expect(retrievedWorld?.agentId).toBe(world.agentId);
      expect(retrievedWorld?.serverId).toBe(world.serverId);
    });

    it('should return null when retrieving a non-existent world', async () => {
      const nonExistentId = '00000000-0000-0000-0000-000000000000' as UUID;
      const world = await adapter.getWorld(nonExistentId);
      expect(world).toBeUndefined();
    });
  });

  describe('World Model Mapping', () => {
    it('should correctly map between World and WorldModel', async () => {
      const testWorld = worldTestWorlds[0];

      // Create the world
      await adapter.createWorld(testWorld);

      // Retrieve it from database
      const retrievedWorld = await adapter.getWorld(testWorld.id);
      expect(retrievedWorld).not.toBeNull();

      // Verify all fields were properly mapped
      expect(retrievedWorld!.id).toBe(testWorld.id);
      expect(retrievedWorld!.agentId).toBe(testWorld.agentId);
      expect(retrievedWorld!.name).toBe(testWorld.name);
      expect(retrievedWorld!.serverId).toBe(testWorld.serverId);

      // Check complex metadata
      expect(retrievedWorld!.metadata?.ownership?.ownerId).toBe(
        testWorld.metadata?.ownership?.ownerId
      );
      expect(retrievedWorld!.metadata?.roles?.[worldTestEntityId]).toBe(
        testWorld.metadata?.roles?.[worldTestEntityId]
      );
    });
  });
});
