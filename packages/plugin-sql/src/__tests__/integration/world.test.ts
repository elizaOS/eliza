import { type UUID, type World } from '@elizaos/core';
import { v4 as uuidv4 } from 'uuid';
import { describe, it, expect, beforeEach, beforeAll, afterAll } from 'bun:test';
import { PgDatabaseAdapter } from '../../pg/adapter';
import { PgliteDatabaseAdapter } from '../../pglite/adapter';
import { worldTable } from '../../schema';
import { createIsolatedTestDatabase } from '../test-helpers';

describe('World Integration Tests', () => {
  let adapter: PgliteDatabaseAdapter | PgDatabaseAdapter;
  let cleanup: () => Promise<void>;
  let testAgentId: UUID;

  beforeAll(async () => {
    const setup = await createIsolatedTestDatabase('world-tests');
    adapter = setup.adapter;
    cleanup = setup.cleanup;
    testAgentId = setup.testAgentId;
  });

  afterAll(async () => {
    if (cleanup) {
      await cleanup();
    }
  });

  describe('World Tests', () => {
    beforeEach(async () => {
      // Clean up worlds table before each test
      await adapter.getDatabase().delete(worldTable);
    });

    it('should create and retrieve a world', async () => {
      const worldId = uuidv4() as UUID;
      const world: World = {
        id: worldId,
        agentId: testAgentId,
        name: 'Test World',
        metadata: { owner: 'test-user' },
        serverId: 'server1',
      };
      await adapter.createWorld(world);

      const retrieved = await adapter.getWorld(worldId);
      expect(retrieved).not.toBeNull();
      expect(retrieved?.id).toBe(worldId);
    });

    it('should ignore duplicate world creation (idempotent upsert)', async () => {
      const worldId = uuidv4() as UUID;
      const world1: World = {
        id: worldId,
        agentId: testAgentId,
        name: 'Test World 1',
        serverId: 'server1',
      };
      const world2: World = {
        id: worldId,
        agentId: testAgentId,
        name: 'Test World 2',
        serverId: 'server2',
      };
      await adapter.createWorld(world1);
      // Second call should succeed silently (onConflictDoNothing)
      await adapter.createWorld(world2);
      // Original world should remain unchanged
      const retrieved = await adapter.getWorld(worldId);
      expect(retrieved?.name).toBe('Test World 1');
    });

    it('should update an existing world', async () => {
      const worldId = uuidv4() as UUID;
      const originalWorld: World = {
        id: worldId,
        agentId: testAgentId,
        name: 'Original World',
        serverId: 'server1',
      };
      await adapter.createWorld(originalWorld);

      const updatedWorld = { ...originalWorld, name: 'Updated World Name' };
      await adapter.updateWorld(updatedWorld);

      const retrieved = await adapter.getWorld(worldId);
      expect(retrieved?.name).toBe('Updated World Name');
    });

    it('should only update the specified world', async () => {
      const world1: World = {
        id: uuidv4() as UUID,
        agentId: testAgentId,
        name: 'World One',
        serverId: 'server1',
      };
      const world2: World = {
        id: uuidv4() as UUID,
        agentId: testAgentId,
        name: 'World Two',
        serverId: 'server2',
      };
      await adapter.createWorld(world1);
      await adapter.createWorld(world2);

      const updatedWorld1 = { ...world1, name: 'Updated World One' };
      await adapter.updateWorld(updatedWorld1);

      const retrieved1 = await adapter.getWorld(world1.id);
      const retrieved2 = await adapter.getWorld(world2.id);
      expect(retrieved1?.name).toBe('Updated World One');
      expect(retrieved2?.name).toBe('World Two');
    });

    it('should delete a world', async () => {
      const worldId = uuidv4() as UUID;
      const world: World = {
        id: worldId,
        agentId: testAgentId,
        name: 'To Be Deleted',
        serverId: 'server1',
      };
      await adapter.createWorld(world);

      let retrieved = await adapter.getWorld(worldId);
      expect(retrieved).not.toBeNull();

      await adapter.removeWorld(worldId);
      retrieved = await adapter.getWorld(worldId);
      expect(retrieved).toBeNull();
    });

    it('should return null when retrieving a non-existent world', async () => {
      const world = await adapter.getWorld(uuidv4() as UUID);
      expect(world).toBeNull();
    });

    it('should retrieve all worlds for an agent', async () => {
      const world1: World = {
        id: uuidv4() as UUID,
        agentId: testAgentId,
        name: 'World 0',
        serverId: 'server0',
      };
      const world2: World = {
        id: uuidv4() as UUID,
        agentId: testAgentId,
        name: 'World 1',
        serverId: 'server1',
      };
      await adapter.createWorld(world1);
      await adapter.createWorld(world2);
      const worlds = await adapter.getAllWorlds();
      expect(worlds.length).toBe(2);
    });

    it('should return an empty array if no worlds exist', async () => {
      const worlds = await adapter.getAllWorlds();
      expect(worlds).toEqual([]);
    });
  });
});
