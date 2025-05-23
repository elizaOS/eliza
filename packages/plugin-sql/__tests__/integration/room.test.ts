import { describe, expect, it, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { PgliteDatabaseAdapter } from '../../src/pglite/adapter';
import { PGliteClientManager } from '../../src/pglite/manager';
import { ChannelType, type UUID } from '@elizaos/core';
import {
  roomTestAgentId,
  roomTestWorldId,
  roomTestRooms,
  roomTestAgent,
  roomTestEntity,
  roomTestEntityId,
  roomTestWorld,
  roomTestRoomId,
  roomTestRoom2Id,
  createModifiedRoom,
} from './seed';
import { v4 as uuidv4 } from 'uuid';
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

describe('Room Integration Tests', () => {
  // Database connection variables
  let connectionManager: PGliteClientManager;
  let adapter: PgliteDatabaseAdapter;
  let agentId: UUID = roomTestAgentId;

  beforeAll(async () => {
    // Initialize connection manager and adapter
    connectionManager = new PGliteClientManager({});
    await connectionManager.initialize();
    adapter = new PgliteDatabaseAdapter(agentId, connectionManager);
    await adapter.init();

    try {
      // Step 1: Create test agent
      await adapter.createAgent(roomTestAgent);

      // Step 2: Create test world
      await adapter.createWorld({
        ...roomTestWorld,
        agentId: roomTestAgentId,
      });

      // Step 3: Create test entity
      await adapter.createEntities([roomTestEntity]);
    } catch (error) {
      console.error('Error in setup:', error);
      throw error;
    }
  }, 10000);

  afterAll(async () => {
    // Clean up test data
    const client = connectionManager.getConnection();
    try {
      // Order matters for foreign key constraints
      await client.query('DELETE FROM participants WHERE TRUE');
      await client.query(`DELETE FROM rooms WHERE "agentId" = '${roomTestAgentId}'`);
      await client.query(`DELETE FROM entities WHERE id = '${roomTestEntityId}'`);
      await client.query(`DELETE FROM worlds WHERE id = '${roomTestWorldId}'`);
      await client.query(`DELETE FROM agents WHERE id = '${roomTestAgentId}'`);
    } catch (error) {
      console.error('Error cleaning test data:', error);
    }

    // Close all connections
    await adapter.close();
  }, 10000);

  beforeEach(async () => {
    // Clean up any existing test rooms before each test
    const client = connectionManager.getConnection();
    try {
      await client.query(`DELETE FROM rooms WHERE "agentId" = '${roomTestAgentId}'`);
    } catch (error) {
      console.error('Error cleaning test room data:', error);
    }
  });

  afterEach(async () => {
    vi.clearAllMocks();
  });

  describe('Room CRUD Operations', () => {
    it('should create a room', async () => {
      const room = roomTestRooms[0];

      const roomId = await adapter.createRooms([room]);
      expect(roomId[0]).toBe(room.id);

      // Verify it exists in the database
      const res = await adapter.getRoomsByIds([roomId[0]]);
      expect(res?.length).toBe(1);
      const createdRoom = res![0];
      expect(createdRoom?.name).toBe(room.name);
      expect(createdRoom?.type).toBe(room.type);
      expect(createdRoom?.source).toBe(room.source);
      expect(createdRoom?.worldId).toBe(room.worldId);
    });

    it('should handle room creation with minimal required fields', async () => {
      const minimalRoom = {
        id: uuidv4() as UUID,
        name: 'Minimal Room',
        agentId: roomTestAgentId,
        source: 'test',
        type: ChannelType.GROUP,
        worldId: roomTestWorldId,
      };

      const roomId = await adapter.createRooms([minimalRoom]);
      expect(roomId).not.toBeNull();

      // Verify it exists with default values where applicable
      const res = await adapter.getRoomsByIds([roomId[0]]);
      const createdRoom = res![0];
      expect(createdRoom).not.toBeNull();
      expect(createdRoom?.name).toBe(minimalRoom.name);
      expect(createdRoom?.metadata).toBeDefined();
    });

    it('should get a room by ID', async () => {
      // Create a room first
      const room = roomTestRooms[0];
      await adapter.createRooms([room]);

      // Get the room
      const res = await adapter.getRoomsByIds([room.id]);
      expect(res).not.toBeNull();
      const retrievedRoom = res![0];

      expect(retrievedRoom?.id).toBe(room.id);
      expect(retrievedRoom?.name).toBe(room.name);
      expect(retrievedRoom?.type).toBe(room.type);
      expect(retrievedRoom?.source).toBe(room.source);
    });

    it('should return null when getting a non-existent room', async () => {
      const nonExistentId = '00000000-0000-0000-0000-000000000000' as UUID;
      const room = await adapter.getRoomsByIds([nonExistentId]);
      expect(room).toStrictEqual([]);
    });

    it('should update a room', async () => {
      // Create a room first
      const room = roomTestRooms[0];
      await adapter.createRooms([room]);

      // Create a modified version
      const modifiedRoom = createModifiedRoom(room);

      // Update the room
      await adapter.updateRoom(modifiedRoom);

      // Verify the update
      const updatedRooms = await adapter.getRoomsByIds([room.id]);
      expect(updatedRooms?.length).toBe(1);
      const updatedRoom = updatedRooms?.[0];
      expect(updatedRoom?.name).toBe(modifiedRoom.name);
      expect(updatedRoom?.metadata).toMatchObject(modifiedRoom.metadata as Record<string, unknown>);
    });

    it('should delete a room', async () => {
      // Create a room first
      const room = roomTestRooms[0];
      await adapter.createRooms([room]);

      // Verify it exists
      const createdRooms = await adapter.getRoomsByIds([room.id]);
      expect(createdRooms).not.toBeNull();

      // Delete the room
      await adapter.deleteRoom(room.id);

      // Verify it's gone
      const deletedRooms = await adapter.getRoomsByIds([room.id]);
      expect(deletedRooms).toEqual([]);
    });

    it('should create a room with all fields populated', async () => {
      const room = roomTestRooms[1]; // This one has channelId and serverId

      const roomId = await adapter.createRooms([room]);

      // Verify all fields were saved correctly
      const savedRooms = await adapter.getRoomsByIds([roomId[0]]);
      expect(savedRooms?.length).toBe(1);
      const savedRoom = savedRooms?.[0];
      expect(savedRoom).not.toBeNull();
      expect(savedRoom?.name).toBe(room.name);
      expect(savedRoom?.channelId).toBe(room.channelId);
      expect(savedRoom?.serverId).toBe(room.serverId);
      expect(savedRoom?.metadata).toMatchObject(room.metadata as Record<string, unknown>);
    });
  });

  describe('Room List Operations', () => {
    it('should get all rooms for a world', async () => {
      // Create multiple rooms
      await adapter.createRooms(roomTestRooms);

      // Get all rooms for the world
      const rooms = await adapter.getRoomsByWorld(roomTestWorldId);

      expect(rooms.length).toBe(roomTestRooms.length);

      // Verify all expected rooms are present
      const roomIds = rooms.map((r) => r.id);
      expect(roomIds).toContain(roomTestRoomId);
      expect(roomIds).toContain(roomTestRoom2Id);
    });

    it('should return an empty array when no rooms exist for a world', async () => {
      const nonExistentWorldId = '00000000-0000-0000-0000-000000000000' as UUID;
      const rooms = await adapter.getRoomsByWorld(nonExistentWorldId);
      expect(rooms).toEqual([]);
    });

    it('should delete rooms by world ID', async () => {
      // Create multiple rooms in the same world
      const room1 = roomTestRooms[0];
      const room2 = {
        ...roomTestRooms[1],
        serverId: 'different-server-id',
      };

      await adapter.createRooms([room1]);
      await adapter.createRooms([room2]);

      // Delete all rooms in the world
      await adapter.deleteRoomsByWorldId(roomTestWorldId);

      // Verify both rooms were deleted since they're in the same world
      const deletedRoom1 = await adapter.getRoomsByIds([room1.id]);
      expect(deletedRoom1).toEqual([]);

      const deletedRoom2 = await adapter.getRoomsByIds([room2.id]);
      expect(deletedRoom2).toEqual([]);
    });

    it('should delete rooms individually when they have different server IDs', async () => {
      // Create rooms with specific serverId
      const roomWithServerId = roomTestRooms[1]; // This has a serverId

      // Create another room with a different serverId for comparison
      const otherRoom = {
        ...roomTestRooms[0],
        serverId: 'other-server-id',
      };
      await adapter.createRooms([roomWithServerId, otherRoom]);

      // Delete one specific room
      await adapter.deleteRoom(roomWithServerId.id);

      // Verify only the targeted room was deleted
      const rooms = await adapter.getRoomsByIds([roomWithServerId.id, otherRoom.id]);
      expect(rooms?.length).toBe(1);
      expect(rooms![0].id).toEqual(otherRoom.id);
    });

    it('should delete rooms individually when they have different server IDs', async () => {
      // Create rooms with specific serverId
      const roomWithServerId = roomTestRooms[1]; // This has a serverId

      // Create another room with a different serverId for comparison
      const otherRoom = {
        ...roomTestRooms[0],
        serverId: 'other-server-id',
      };
      await adapter.createRooms([roomWithServerId, otherRoom]);

      // Delete one specific room
      await adapter.deleteRoom(roomWithServerId.id);

      // Verify only the targeted room was deleted
      const rooms = await adapter.getRoomsByIds([roomWithServerId.id, otherRoom.id]);
      expect(rooms?.length).toBe(1);
      expect(rooms![0].id).toEqual(otherRoom.id);
    });
  });

  describe('Room Participants', () => {
    it('should add a participant to a room', async () => {
      // Create a room first
      const room = roomTestRooms[0];
      await adapter.createRooms([room]);

      // Add participant
      const added = await adapter.addParticipantsRoom([roomTestEntityId], room.id);
      expect(added).toBe(true);

      // Verify participant was added
      const participants = await adapter.getParticipantsForRoom(room.id);
      expect(participants).toContain(roomTestEntityId);
    });

    it('should get all participants for a room', async () => {
      // Create a room first
      const room = roomTestRooms[0];
      await adapter.createRooms([room]);

      // Add participant
      await adapter.addParticipant(roomTestEntityId, room.id);

      // Get participants
      const participants = await adapter.getParticipantsForRoom(room.id);

      expect(participants.length).toBe(1);
      expect(participants[0]).toBe(roomTestEntityId);
    });

    it('should get all rooms for a participant', async () => {
      // Create rooms
      for (const room of roomTestRooms) {
        await adapter.createRooms([room]);
        // Add the same participant to each room
        await adapter.addParticipant(roomTestEntityId, room.id);
      }

      // Get rooms for participant
      const rooms = await adapter.getRoomsForParticipant(roomTestEntityId);

      expect(rooms.length).toBe(roomTestRooms.length);

      // Verify all expected room IDs are present
      expect(rooms).toContain(roomTestRoomId);
      expect(rooms).toContain(roomTestRoom2Id);
    });

    it('should remove a participant from a room', async () => {
      // Create a room first
      const room = roomTestRooms[0];
      await adapter.createRooms([room]);

      // Add participant
      await adapter.addParticipant(roomTestEntityId, room.id);

      // Remove participant
      const removed = await adapter.removeParticipant(roomTestEntityId, room.id);
      expect(removed).toBe(true);

      // Verify participant was removed
      const participants = await adapter.getParticipantsForRoom(room.id);
      expect(participants).not.toContain(roomTestEntityId);
    });

    it('should handle participant user state', async () => {
      // Create a room first
      const room = roomTestRooms[0];
      await adapter.createRooms([room]);

      // Add participant
      await adapter.addParticipant(roomTestEntityId, room.id);

      // Set user state
      await adapter.setParticipantUserState(room.id, roomTestEntityId, 'FOLLOWED');

      // Verify state was set
      const state = await adapter.getParticipantUserState(room.id, roomTestEntityId);
      expect(state).toBe('FOLLOWED');

      // Update state
      await adapter.setParticipantUserState(room.id, roomTestEntityId, 'MUTED');

      // Verify state was updated
      const updatedState = await adapter.getParticipantUserState(room.id, roomTestEntityId);
      expect(updatedState).toBe('MUTED');

      // Clear state
      await adapter.setParticipantUserState(room.id, roomTestEntityId, null);

      // Verify state was cleared
      const clearedState = await adapter.getParticipantUserState(room.id, roomTestEntityId);
      expect(clearedState).toBeNull();
    });
  });

  describe('Room Edge Cases', () => {
    it('should handle creating a room with the same ID twice', async () => {
      const room = roomTestRooms[0];

      // First creation should succeed
      const roomId1 = await adapter.createRooms([room]);
      expect(roomId1[0]).toBe(room.id);

      // Second creation with same ID should not throw
      const roomId2 = await adapter.createRooms([room]);
      expect(roomId2?.length).toBe(0);
    });

    it('should gracefully handle deleting a non-existent room', async () => {
      const nonExistentId = '00000000-0000-0000-0000-000000000000' as UUID;

      // Should not throw an error
      await expect(adapter.deleteRoom(nonExistentId)).resolves.not.toThrow();
    });
  });
});
