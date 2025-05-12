import { describe, expect, it, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { PgDatabaseAdapter } from '../../src/pg/adapter';
import { PostgresConnectionManager } from '../../src/pg/manager';
import { type UUID } from '@elizaos/core';
import { config } from '../config';
import {
  participantTestAgentId,
  participantTestEntityId,
  participantTestRoomId,
  participantTestWorldId,
  participantTestWorld,
  participantTestEntity,
  participantTestRoom,
  participantTestAgent,
} from './seed';

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

describe('Participant Integration Tests', () => {
  // Database connection variables
  let connectionManager: PostgresConnectionManager;
  let adapter: PgDatabaseAdapter;
  let agentId: UUID = participantTestAgentId;

  beforeAll(async () => {
    // Initialize connection manager and adapter
    connectionManager = new PostgresConnectionManager(config.DATABASE_URL);
    await connectionManager.initialize();
    adapter = new PgDatabaseAdapter(agentId, connectionManager);
    await adapter.init();

    try {
      // Step 1: Create test agent
      await adapter.createAgent(participantTestAgent);

      // Step 2: Create test world
      await adapter.createWorld({
        ...participantTestWorld,
        agentId: participantTestAgentId,
      });

      // Step 3: Create test entity
      await adapter.createEntity(participantTestEntity);

      // Step 4: Create test room
      await adapter.createRoom(participantTestRoom);
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
      await client.query(`DELETE FROM rooms WHERE id = '${participantTestRoomId}'`);
      await client.query(`DELETE FROM entities WHERE id = '${participantTestEntityId}'`);
      await client.query(`DELETE FROM worlds WHERE id = '${participantTestWorldId}'`);
      await client.query(`DELETE FROM agents WHERE id = '${participantTestAgentId}'`);
    } catch (error) {
      console.error('Error cleaning test data:', error);
    } finally {
      client.release();
    }

    // Close all connections
    await adapter.close();
  }, 10000);

  beforeEach(async () => {
    // Clean up any existing test participants before each test
    const client = await connectionManager.getClient();
    try {
      await client.query('DELETE FROM participants WHERE TRUE');
    } finally {
      client.release();
    }
  });

  afterEach(async () => {
    vi.clearAllMocks();
  });

  describe('Participant CRUD Operations', () => {
    it('should add a participant to a room', async () => {
      const result = await adapter.addParticipant(participantTestEntityId, participantTestRoomId);

      expect(result).toBe(true);

      // Verify participant exists by checking room participants
      const participants = await adapter.getParticipantsForRoom(participantTestRoomId);
      expect(participants).toContain(participantTestEntityId);
    });

    it('should allow adding a participant multiple times to a room', async () => {
      // First add
      await adapter.addParticipant(participantTestEntityId, participantTestRoomId);

      // Second add shouldn't cause errors
      const result = await adapter.addParticipant(participantTestEntityId, participantTestRoomId);
      expect(result).toBe(true);

      // Verify participant exists in the list
      const participants = await adapter.getParticipantsForRoom(participantTestRoomId);
      expect(participants.includes(participantTestEntityId)).toBe(true);

      // Note: Currently the database allows duplicate participants
      // This would need a schema change with a unique constraint to enforce uniqueness
    });

    it('should remove a participant from a room', async () => {
      // First add the participant
      await adapter.addParticipant(participantTestEntityId, participantTestRoomId);

      // Then remove
      const result = await adapter.removeParticipant(
        participantTestEntityId,
        participantTestRoomId
      );
      expect(result).toBe(true);

      // Verify participant was removed
      const participants = await adapter.getParticipantsForRoom(participantTestRoomId);
      expect(participants).not.toContain(participantTestEntityId);
    });

    it('should return false when removing a non-existent participant', async () => {
      const nonExistentUUID = '00000000-0000-0000-0000-000000000000' as UUID;
      const result = await adapter.removeParticipant(nonExistentUUID, participantTestRoomId);
      expect(result).toBe(false);
    });

    it('should get participants for an entity', async () => {
      // Add the participant to the room
      await adapter.addParticipant(participantTestEntityId, participantTestRoomId);

      // Get participants for the entity
      const participants = await adapter.getParticipantsForEntity(participantTestEntityId);

      expect(participants.length).toBeGreaterThan(0);
      expect(participants[0].entity.id).toBe(participantTestEntityId);
    });

    it('should get rooms for a participant', async () => {
      // Add the participant to the room
      await adapter.addParticipant(participantTestEntityId, participantTestRoomId);

      // Get rooms for the participant
      const rooms = await adapter.getRoomsForParticipant(participantTestEntityId);

      expect(rooms).toContain(participantTestRoomId);
    });

    it('should get rooms for multiple participants', async () => {
      // Add the participant to the room
      await adapter.addParticipant(participantTestEntityId, participantTestRoomId);

      // Get rooms for the participants
      const rooms = await adapter.getRoomsForParticipants([participantTestEntityId]);

      expect(rooms).toContain(participantTestRoomId);
    });
  });

  describe('Participant State Management', () => {
    it('should set FOLLOWED state and get it correctly', async () => {
      // Add the participant
      await adapter.addParticipant(participantTestEntityId, participantTestRoomId);

      // Set state to FOLLOWED
      await adapter.setParticipantUserState(
        participantTestRoomId,
        participantTestEntityId,
        'FOLLOWED'
      );

      // Get state
      const state = await adapter.getParticipantUserState(
        participantTestRoomId,
        participantTestEntityId
      );
      expect(state).toBe('FOLLOWED');
    });

    it('should set MUTED state and get it correctly', async () => {
      // Add the participant
      await adapter.addParticipant(participantTestEntityId, participantTestRoomId);

      // Set state to MUTED
      await adapter.setParticipantUserState(
        participantTestRoomId,
        participantTestEntityId,
        'MUTED'
      );

      // Get state
      const state = await adapter.getParticipantUserState(
        participantTestRoomId,
        participantTestEntityId
      );
      expect(state).toBe('MUTED');
    });

    it('should update participant state from FOLLOWED to MUTED', async () => {
      // Add the participant
      await adapter.addParticipant(participantTestEntityId, participantTestRoomId);

      // Set initial state
      await adapter.setParticipantUserState(
        participantTestRoomId,
        participantTestEntityId,
        'FOLLOWED'
      );

      // Verify initial state
      let state = await adapter.getParticipantUserState(
        participantTestRoomId,
        participantTestEntityId
      );
      expect(state).toBe('FOLLOWED');

      // Update state to MUTED
      await adapter.setParticipantUserState(
        participantTestRoomId,
        participantTestEntityId,
        'MUTED'
      );

      // Get updated state
      state = await adapter.getParticipantUserState(participantTestRoomId, participantTestEntityId);
      expect(state).toBe('MUTED');
    });

    it('should update participant state from MUTED to FOLLOWED', async () => {
      // Add the participant
      await adapter.addParticipant(participantTestEntityId, participantTestRoomId);

      // Set initial state
      await adapter.setParticipantUserState(
        participantTestRoomId,
        participantTestEntityId,
        'MUTED'
      );

      // Verify initial state
      let state = await adapter.getParticipantUserState(
        participantTestRoomId,
        participantTestEntityId
      );
      expect(state).toBe('MUTED');

      // Update state to FOLLOWED
      await adapter.setParticipantUserState(
        participantTestRoomId,
        participantTestEntityId,
        'FOLLOWED'
      );

      // Get updated state
      state = await adapter.getParticipantUserState(participantTestRoomId, participantTestEntityId);
      expect(state).toBe('FOLLOWED');
    });

    it('should return null for non-existent participant state', async () => {
      const nonExistentUUID = '00000000-0000-0000-0000-000000000000' as UUID;
      const state = await adapter.getParticipantUserState(participantTestRoomId, nonExistentUUID);
      expect(state).toBeNull();
    });

    it('should clear participant user state by setting to null', async () => {
      // Add the participant
      await adapter.addParticipant(participantTestEntityId, participantTestRoomId);

      // Set state
      await adapter.setParticipantUserState(
        participantTestRoomId,
        participantTestEntityId,
        'FOLLOWED'
      );

      // Verify state was set
      let state = await adapter.getParticipantUserState(
        participantTestRoomId,
        participantTestEntityId
      );
      expect(state).toBe('FOLLOWED');

      // Clear state
      await adapter.setParticipantUserState(participantTestRoomId, participantTestEntityId, null);

      // Get state should return null
      state = await adapter.getParticipantUserState(participantTestRoomId, participantTestEntityId);
      expect(state).toBeNull();
    });

    it('should handle setting state when participant was added multiple times', async () => {
      // Add the participant twice (which creates duplicate entries)
      await adapter.addParticipant(participantTestEntityId, participantTestRoomId);
      await adapter.addParticipant(participantTestEntityId, participantTestRoomId);

      // Set state to FOLLOWED
      await adapter.setParticipantUserState(
        participantTestRoomId,
        participantTestEntityId,
        'FOLLOWED'
      );

      // Get state - should match last set value regardless of duplicates
      const state = await adapter.getParticipantUserState(
        participantTestRoomId,
        participantTestEntityId
      );
      expect(state).toBe('FOLLOWED');
    });
  });
});
