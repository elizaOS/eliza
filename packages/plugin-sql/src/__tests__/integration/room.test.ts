import { type Room, type UUID, AgentRuntime, ChannelType } from '@elizaos/core';
import { v4 as uuidv4 } from 'uuid';
import { describe, it, expect, beforeEach, beforeAll, afterAll } from 'bun:test';
import { PgDatabaseAdapter } from '../../pg/adapter';
import { PgliteDatabaseAdapter } from '../../pglite/adapter';
import { roomTable } from '../../schema';
import { createIsolatedTestDatabase } from '../test-helpers';

describe('Room Integration Tests', () => {
  let adapter: PgliteDatabaseAdapter | PgDatabaseAdapter;
  let runtime: AgentRuntime;
  let cleanup: () => Promise<void>;
  let testAgentId: UUID;
  let testWorldId: UUID;

  beforeAll(async () => {
    const setup = await createIsolatedTestDatabase('room-tests');
    adapter = setup.adapter;
    runtime = setup.runtime;
    cleanup = setup.cleanup;
    testAgentId = setup.testAgentId;

    // Create a test world
    testWorldId = uuidv4() as UUID;
    await adapter.createWorld({
      id: testWorldId,
      agentId: testAgentId,
      name: 'Test World',
      serverId: 'test-server',
    });
  });

  afterAll(async () => {
    if (cleanup) {
      await cleanup();
    }
  });

  describe('Room Tests', () => {
    beforeEach(async () => {
      await adapter.getDatabase().delete(roomTable);
    });

    it('should create and retrieve a room', async () => {
      const roomId = uuidv4() as UUID;
      const room: Room = {
        id: roomId,
        agentId: testAgentId,
        worldId: testWorldId,
        source: 'test',
        type: ChannelType.GROUP,
        name: 'Test Room',
      };
      await adapter.createRooms([room]);
      const retrieved = await adapter.getRoomsByIds([roomId]);
      expect(retrieved).not.toBeNull();
      expect(retrieved?.[0]?.id).toBe(roomId);
    });

    it('should get all rooms for a world', async () => {
      const room1: Room = {
        id: uuidv4() as UUID,
        agentId: testAgentId,
        worldId: testWorldId,
        source: 'test',
        type: ChannelType.GROUP,
        name: 'Room 1',
      };
      const room2: Room = {
        id: uuidv4() as UUID,
        agentId: testAgentId,
        worldId: testWorldId,
        source: 'test',
        type: ChannelType.GROUP,
        name: 'Room 2',
      };
      await adapter.createRooms([room1, room2]);
      const rooms = await adapter.getRoomsByWorld(testWorldId);
      expect(rooms).toHaveLength(2);
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

      const retrieved = await adapter.getRoomsByIds([roomId]);
      expect(retrieved).not.toBeNull();
      expect(retrieved?.[0]?.name).toBe('Updated Room Name');
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
});
