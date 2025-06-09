import { type Room, type UUID, AgentRuntime, ChannelType, stringToUuid, type World } from '@elizaos/core';
import { v4 as uuidv4 } from 'uuid';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PgliteDatabaseAdapter } from '../../src/pglite/adapter';
import { roomTable } from '../../src/schema';
import { createTestDatabase } from '../test-helpers';

describe('Room Integration Tests', () => {
  let adapter: PgliteDatabaseAdapter;
  let runtime: AgentRuntime;
  let cleanup: () => Promise<void>;
  let testAgentId: UUID;
  let testWorldId: UUID;

  beforeAll(async () => {
    testAgentId = stringToUuid('test-agent-for-room-tests');
    testWorldId = stringToUuid('test-world-for-room-tests');
    ({ adapter, runtime, cleanup } = await createTestDatabase(testAgentId));

    await runtime.createWorld({
      id: testWorldId,
      agentId: testAgentId,
      name: 'Test World',
      serverId: 'test-server',
    } as World);
  }, 30000);

  beforeEach(async () => {
    await adapter.getDatabase().delete(roomTable);
  });

  afterAll(async () => {
    await cleanup();
  });

  it('should create and retrieve a room', async () => {
    const room: Room = {
      id: uuidv4() as UUID,
      agentId: testAgentId,
      worldId: testWorldId,
      name: 'Test Room',
      source: 'test',
      type: ChannelType.GROUP,
    };
    await adapter.createRooms([room]);

    const retrieved = await adapter.getRoomsByIds([room.id]);
    expect(retrieved).not.toBeNull();
    expect(retrieved?.[0].id).toBe(room.id);
    expect(retrieved?.[0].name).toBe('Test Room');
  });

  it('should get all rooms for a world', async () => {
    for (let i = 0; i < 3; i++) {
      await adapter.createRooms([
        {
          id: uuidv4() as UUID,
          agentId: testAgentId,
          worldId: testWorldId,
          name: `Room ${i}`,
          source: 'test',
          type: ChannelType.GROUP,
        } as Room,
      ]);
    }
    const rooms = await adapter.getRoomsByWorld(testWorldId);
    expect(rooms).toHaveLength(3);
  });

  it('should update a room', async () => {
    const roomId = uuidv4() as UUID;
    const room = {
      id: roomId,
      agentId: testAgentId,
      worldId: testWorldId,
      source: 'test',
      type: ChannelType.GROUP,
      name: 'Original Room Name',
    };
    await adapter.createRooms([room as Room]);

    const updatedRoom = { ...room, name: 'Updated Room Name' };
    await adapter.updateRoom(updatedRoom);

    const retrievedRooms = await adapter.getRoomsByIds([room.id]);
    expect(retrievedRooms).not.toBeNull();
    expect(retrievedRooms?.[0].name).toBe('Updated Room Name');
  });

  it('should delete a room', async () => {
    const roomId = uuidv4() as UUID;
    const room = {
      id: roomId,
      agentId: testAgentId,
      worldId: testWorldId,
      source: 'test',
      type: ChannelType.GROUP,
      name: 'To Be Deleted',
    };
    await adapter.createRooms([room as Room]);

    let retrieved = await adapter.getRoomsByIds([room.id]);
    expect(retrieved).toHaveLength(1);

    await adapter.deleteRoom(room.id);

    retrieved = await adapter.getRoomsByIds([room.id]);
    expect(retrieved).toEqual([]);
  });
});
