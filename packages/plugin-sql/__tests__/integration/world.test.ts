import { describe, expect, it, beforeAll, afterAll, beforeEach } from 'vitest';
import { PgliteDatabaseAdapter } from '../../src/pglite/adapter';
import { type UUID, type World } from '@elizaos/core';
import { v4 as uuidv4 } from 'uuid';
import { createTestDatabase } from '../test-helpers';
import { worldTable, agentTable } from '../../src/schema';

describe('World Integration Tests', () => {
  let adapter: PgliteDatabaseAdapter;
  let testAgentId: UUID;

  beforeAll(async () => {
    testAgentId = uuidv4() as UUID;
    const setup = await createTestDatabase(testAgentId);
    adapter = setup.adapter as PgliteDatabaseAdapter;
    await adapter.createAgent({ id: testAgentId, name: 'Test Agent' } as any);
  }, 30000);

  beforeEach(async () => {
    await adapter.getDatabase().delete(worldTable);
  });

  afterAll(async () => {
    await adapter.getDatabase().delete(worldTable);
    await adapter.getDatabase().delete(agentTable);
    await adapter.close();
  });

  it('should create and retrieve a world', async () => {
    const world: World = {
      id: uuidv4() as UUID,
      agentId: testAgentId,
      name: 'Test World',
      serverId: 'server1',
      metadata: { owner: 'test-user' },
    };
    const worldId = await adapter.createWorld(world);
    expect(worldId).toBe(world.id);

    const retrieved = await adapter.getWorld(worldId);
    expect(retrieved).not.toBeNull();
    expect(retrieved?.name).toBe('Test World');
    expect(retrieved?.metadata).toEqual({ owner: 'test-user' });
  });

  it('should not create a world with a duplicate id', async () => {
    const worldId = uuidv4() as UUID;
    const world1: World = {
      id: worldId,
      agentId: testAgentId,
      name: 'Test World 1',
      serverId: 'server1',
    };
    await adapter.createWorld(world1);

    const world2: World = {
      id: worldId,
      agentId: testAgentId,
      name: 'Test World 2',
      serverId: 'server2',
    };

    await expect(adapter.createWorld(world2)).rejects.toThrow();
  });

  it('should update an existing world', async () => {
    const world: World = {
      id: uuidv4() as UUID,
      agentId: testAgentId,
      name: 'Original World',
      serverId: 'server1',
    };
    const worldId = await adapter.createWorld(world);

    const updatedWorld = { ...world, name: 'Updated World' };
    await adapter.updateWorld(updatedWorld);

    const retrieved = await adapter.getWorld(worldId);
    expect(retrieved?.name).toBe('Updated World');
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
    const world: World = {
      id: uuidv4() as UUID,
      agentId: testAgentId,
      name: 'To Be Deleted',
      serverId: 'server1',
    };
    const worldId = await adapter.createWorld(world);

    let retrieved = await adapter.getWorld(worldId);
    expect(retrieved).not.toBeNull();

    await adapter.removeWorld(worldId);

    retrieved = await adapter.getWorld(worldId);
    expect(retrieved).toBeUndefined();
  });

  it('should return null when retrieving a non-existent world', async () => {
    const nonExistentId = uuidv4() as UUID;
    const retrieved = await adapter.getWorld(nonExistentId);
    expect(retrieved).toBeUndefined();
  });

  it('should retrieve all worlds for an agent', async () => {
    for (let i = 0; i < 3; i++) {
      await adapter.createWorld({
        id: uuidv4() as UUID,
        agentId: testAgentId,
        name: `World ${i}`,
        serverId: `server${i}`,
      } as World);
    }
    const worlds = await adapter.getAllWorlds();
    expect(worlds).toHaveLength(3);
  });

  it('should return an empty array if no worlds exist', async () => {
    const worlds = await adapter.getAllWorlds();
    expect(worlds).toEqual([]);
  });
});
