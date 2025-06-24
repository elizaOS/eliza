import type { UUID } from '@elizaos/core';
import { v4 as uuidv4 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { PgDatabaseAdapter } from '../../pg/adapter';
import { PgliteDatabaseAdapter } from '../../pglite/adapter';
import { createIsolatedTestDatabase } from '../test-helpers';

describe('Cascade Delete Tests', () => {
  // No shared adapter - each test gets its own isolated database

  it('should cascade delete all related data when deleting an agent', async () => {
    // Create a fresh isolated database for this test
    const setup = await createIsolatedTestDatabase('cascade-delete-tests');
    const adapter = setup.adapter;
    const testAgentId = setup.testAgentId;

    try {
      // Use the testAgentId that the adapter was initialized with
      const agentId = testAgentId;

      // The agent was already created by the test helper, so we just need to create related data

      // Create a world
      const worldId = uuidv4() as UUID;
      await adapter.createWorld({
        id: worldId,
        name: 'Test World',
        agentId,
        serverId: uuidv4() as UUID,
      });

      // Create rooms
      const roomId = uuidv4() as UUID;
      await adapter.createRooms([
        {
          id: roomId,
          name: 'Test Room',
          agentId,
          serverId: uuidv4() as UUID,
          worldId,
          channelId: uuidv4() as UUID,
          type: 'PUBLIC' as any,
          source: 'test',
        },
      ]);

      // Create entities
      const entityId = uuidv4() as UUID;
      await adapter.createEntities([
        {
          id: entityId,
          agentId,
          names: ['Test Entity'],
          metadata: { type: 'test' },
        },
      ]);

      // Create memory with embedding
      const memoryId = await adapter.createMemory(
        {
          id: uuidv4() as UUID,
          agentId,
          entityId,
          roomId,
          content: { text: 'Test memory' },
          createdAt: Date.now(),
          embedding: new Array(384).fill(0.1), // Test embedding
        },
        'test_memories'
      );

      // Create task
      const taskId = await adapter.createTask({
        id: uuidv4() as UUID,
        name: 'Test Task',
        description: 'A test task',
        roomId,
        worldId,
        tags: ['test'],
        metadata: { priority: 'high' },
      });

      // Create cache entry
      await adapter.setCache('test_cache_key', { value: 'cached data' });

      // Verify all data was created
      expect(await adapter.getAgent(agentId)).not.toBeNull();
      expect(await adapter.getWorld(worldId)).not.toBeNull();
      expect((await adapter.getRoomsByIds([roomId]))?.length).toBe(1);
      expect((await adapter.getEntitiesByIds([entityId]))?.length).toBe(1);
      expect(await adapter.getMemoryById(memoryId)).not.toBeNull();
      expect(await adapter.getTask(taskId)).not.toBeNull();
      expect(await adapter.getCache('test_cache_key')).toBeDefined();

      // Now delete the agent - this should cascade delete everything
      const deleteResult = await adapter.deleteAgent(agentId);
      expect(deleteResult).toBe(true);

      // Verify the agent is deleted
      expect(await adapter.getAgent(agentId)).toBeNull();

      // Verify all related data is deleted via cascade
      expect(await adapter.getWorld(worldId)).toBeNull();
      expect(await adapter.getRoomsByIds([roomId])).toEqual([]);
      expect(await adapter.getEntitiesByIds([entityId])).toEqual([]);
      expect(await adapter.getMemoryById(memoryId)).toBeNull();
      expect(await adapter.getTask(taskId)).toBeNull();
      expect(await adapter.getCache('test_cache_key')).toBeUndefined();
    } finally {
      await setup.cleanup();
    }
  });

  it('should handle deletion of agent with no related data', async () => {
    // Create a separate test instance for this test
    const setup = await createIsolatedTestDatabase('cascade-delete-simple-agent');
    const simpleAdapter = setup.adapter;
    const simpleAgentId = setup.testAgentId;

    try {
      // The agent was already created by the test helper
      // Just delete it without creating any related data
      const result = await simpleAdapter.deleteAgent(simpleAgentId);
      expect(result).toBe(true);

      // Verify deletion
      expect(await simpleAdapter.getAgent(simpleAgentId)).toBeNull();
    } finally {
      await setup.cleanup();
    }
  });

  it('should return false when deleting non-existent agent', async () => {
    // Create a fresh isolated database for this test
    const setup = await createIsolatedTestDatabase('cascade-delete-nonexistent');
    const adapter = setup.adapter;

    try {
      const nonExistentId = uuidv4() as UUID;
      const result = await adapter.deleteAgent(nonExistentId);

      // With the new simplified deleteAgent, it should return false for non-existent agents
      expect(result).toBe(false);
    } finally {
      await setup.cleanup();
    }
  });
});
