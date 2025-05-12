import { describe, expect, it, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { PgDatabaseAdapter } from '../../src/pg/adapter';
import { PostgresConnectionManager } from '../../src/pg/manager';
import { ChannelType, type UUID } from '@elizaos/core';
import { config } from '../config';
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

// Spy on runMigrations before any instance is created to prevent actual execution
vi.spyOn(PostgresConnectionManager.prototype, 'runMigrations').mockImplementation(async () => {
  console.log('Skipping runMigrations in test environment.');
});

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
    },
  };
});

describe('Room Integration Tests', () => {
  // Database connection variables
  let connectionManager: PostgresConnectionManager;
  let adapter: PgDatabaseAdapter;
  let agentId: UUID = roomTestAgentId;

  beforeAll(async () => {
    // Initialize connection manager and adapter
    connectionManager = new PostgresConnectionManager(config.DATABASE_URL);
    await connectionManager.initialize();
    adapter = new PgDatabaseAdapter(agentId, connectionManager);
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
      await adapter.createEntity(roomTestEntity);
    } catch (error) {
      console.error('Error in setup:', error);
      throw error;
    }
  }, 10000);

  afterAll(async () => {
    // Clean up test data
    const client = await connectionManager.getClient();
    try {
      // Order matters for foreign key constraints
      await client.query('DELETE FROM participants WHERE TRUE');
      await client.query(`DELETE FROM rooms WHERE "agentId" = '${roomTestAgentId}'`);
      await client.query(`DELETE FROM entities WHERE id = '${roomTestEntityId}'`);
      await client.query(`DELETE FROM worlds WHERE id = '${roomTestWorldId}'`);
      await client.query(`DELETE FROM agents WHERE id = '${roomTestAgentId}'`);
    } catch (error) {
      console.error('Error cleaning test data:', error);
    } finally {
      client.release();
    }

    // Close all connections
    await adapter.close();
  }, 10000);

  beforeEach(async () => {
    // Clean up any existing test rooms before each test
    const client = await connectionManager.getClient();
    try {
      await client.query(`DELETE FROM rooms WHERE "agentId" = '${roomTestAgentId}'`);
    } finally {
      client.release();
    }
  });

  afterEach(async () => {
    vi.clearAllMocks();
  });

  describe('Room CRUD Operations', () => {
    it('should create a room', async () => {
      const room = roomTestRooms[0];

      const roomId = await adapter.createRoom(room);
      expect(roomId).toBe(room.id);

      // Verify it exists in the database
      const createdRoom = await adapter.getRoom(roomId);
      expect(createdRoom).not.toBeNull();
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

      const roomId = await adapter.createRoom(minimalRoom);
      expect(roomId).not.toBeNull();

      // Verify it exists with default values where applicable
      const createdRoom = await adapter.getRoom(roomId);
      expect(createdRoom).not.toBeNull();
      expect(createdRoom?.name).toBe(minimalRoom.name);
      expect(createdRoom?.metadata).toBeDefined();
    });

    it('should get a room by ID', async () => {
      // Create a room first
      const room = roomTestRooms[0];
      await adapter.createRoom(room);

      // Get the room
      const retrievedRoom = await adapter.getRoom(room.id);

      expect(retrievedRoom).not.toBeNull();
      expect(retrievedRoom?.id).toBe(room.id);
      expect(retrievedRoom?.name).toBe(room.name);
      expect(retrievedRoom?.type).toBe(room.type);
      expect(retrievedRoom?.source).toBe(room.source);
    });

    it('should return null when getting a non-existent room', async () => {
      const nonExistentId = '00000000-0000-0000-0000-000000000000' as UUID;
      const room = await adapter.getRoom(nonExistentId);
      expect(room).toBeNull();
    });

    it('should update a room', async () => {
      // Create a room first
      const room = roomTestRooms[0];
      await adapter.createRoom(room);

      // Create a modified version
      const modifiedRoom = createModifiedRoom(room);

      // Update the room
      await adapter.updateRoom(modifiedRoom);

      // Verify the update
      const updatedRoom = await adapter.getRoom(room.id);
      expect(updatedRoom?.name).toBe(modifiedRoom.name);
      expect(updatedRoom?.metadata).toMatchObject(modifiedRoom.metadata as Record<string, unknown>);
    });

    it('should delete a room', async () => {
      // Create a room first
      const room = roomTestRooms[0];
      await adapter.createRoom(room);

      // Verify it exists
      const createdRoom = await adapter.getRoom(room.id);
      expect(createdRoom).not.toBeNull();

      // Delete the room
      await adapter.deleteRoom(room.id);

      // Verify it's gone
      const deletedRoom = await adapter.getRoom(room.id);
      expect(deletedRoom).toBeNull();
    });

    it('should create a room with all fields populated', async () => {
      const room = roomTestRooms[1]; // This one has channelId and serverId

      const roomId = await adapter.createRoom(room);

      // Verify all fields were saved correctly
      const savedRoom = await adapter.getRoom(roomId);
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
      for (const room of roomTestRooms) {
        await adapter.createRoom(room);
      }

      // Get all rooms for the world
      const rooms = await adapter.getRooms(roomTestWorldId);

      expect(rooms.length).toBe(roomTestRooms.length);

      // Verify all expected rooms are present
      const roomIds = rooms.map((r) => r.id);
      expect(roomIds).toContain(roomTestRoomId);
      expect(roomIds).toContain(roomTestRoom2Id);
    });

    it('should return an empty array when no rooms exist for a world', async () => {
      const nonExistentWorldId = '00000000-0000-0000-0000-000000000000' as UUID;
      const rooms = await adapter.getRooms(nonExistentWorldId);
      expect(rooms).toEqual([]);
    });

    it('should delete rooms by server ID', async () => {
      // Create rooms with specific serverId
      const serverIdToDelete = 'test-server-id';
      const roomWithServerId = roomTestRooms[1]; // This has a serverId

      await adapter.createRoom(roomWithServerId);

      // Create another room with a different serverId for comparison
      const otherRoom = {
        ...roomTestRooms[0],
        serverId: 'other-server-id',
      };
      await adapter.createRoom(otherRoom);

      // Delete rooms by serverId
      await adapter.deleteRoomsByServerId(serverIdToDelete as UUID);

      // Verify only the targeted room was deleted
      const deletedRoom = await adapter.getRoom(roomWithServerId.id);
      expect(deletedRoom).toBeNull();

      const remainingRoom = await adapter.getRoom(otherRoom.id);
      expect(remainingRoom).not.toBeNull();
    });
  });

  describe('Room Participants', () => {
    it('should add a participant to a room', async () => {
      // Create a room first
      const room = roomTestRooms[0];
      await adapter.createRoom(room);

      // Add participant
      const added = await adapter.addParticipant(roomTestEntityId, room.id);
      expect(added).toBe(true);

      // Verify participant was added
      const participants = await adapter.getParticipantsForRoom(room.id);
      expect(participants).toContain(roomTestEntityId);
    });

    it('should get all participants for a room', async () => {
      // Create a room first
      const room = roomTestRooms[0];
      await adapter.createRoom(room);

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
        await adapter.createRoom(room);
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
      await adapter.createRoom(room);

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
      await adapter.createRoom(room);

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
      const roomId1 = await adapter.createRoom(room);
      expect(roomId1).toBe(room.id);

      // Second creation with same ID should not throw
      const roomId2 = await adapter.createRoom(room);
      expect(roomId2).toBe(room.id);
    });

    it('should gracefully handle deleting a non-existent room', async () => {
      const nonExistentId = '00000000-0000-0000-0000-000000000000' as UUID;

      // Should not throw an error
      await expect(adapter.deleteRoom(nonExistentId)).resolves.not.toThrow();
    });
  });
});
