import { AgentRuntime, ChannelType, type Entity, type Room, type UUID } from '@elizaos/core';
import { v4 as uuidv4 } from 'uuid';
import { describe, it, expect, beforeEach, beforeAll, afterAll } from 'bun:test';
import { PgDatabaseAdapter } from '../../pg/adapter';
import { PgliteDatabaseAdapter } from '../../pglite/adapter';
import { participantTable } from '../../schema';
import { createIsolatedTestDatabase } from '../test-helpers';

describe('Participant Integration Tests', () => {
  let adapter: PgliteDatabaseAdapter | PgDatabaseAdapter;
  let runtime: AgentRuntime;
  let cleanup: () => Promise<void>;
  let testAgentId: UUID;
  let testRoomId: UUID;
  let testEntityId: UUID;

  beforeAll(async () => {
    const setup = await createIsolatedTestDatabase('participant-tests');
    adapter = setup.adapter;
    runtime = setup.runtime;
    cleanup = setup.cleanup;
    testAgentId = setup.testAgentId;

    // Generate random UUIDs for test data
    testRoomId = uuidv4() as UUID;
    testEntityId = uuidv4() as UUID;

    // Create test room and entity
    await adapter.createRooms([
      {
        id: testRoomId,
        agentId: testAgentId,
        name: 'Test Room',
        source: 'test',
        type: ChannelType.GROUP,
      } as Room,
    ]);
    await adapter.createEntities([
      { id: testEntityId, agentId: testAgentId, names: ['Test Entity'] } as Entity,
    ]);
  });

  afterAll(async () => {
    if (cleanup) {
      await cleanup();
    }
  });

  describe('Participant Tests', () => {
    beforeEach(async () => {
      await adapter.getDatabase().delete(participantTable);
    });

    it('should add and retrieve a participant', async () => {
      const result = await adapter.addParticipant(testEntityId, testRoomId);
      expect(result).toBe(true);
      const rooms = await adapter.getRoomsForParticipant(testEntityId);
      expect(rooms).toContain(testRoomId);
    });

    it('should remove a participant from a room', async () => {
      await adapter.addParticipant(testEntityId, testRoomId);
      let rooms = await adapter.getRoomsForParticipant(testEntityId);
      expect(rooms).toContain(testRoomId);

      const result = await adapter.removeParticipant(testEntityId, testRoomId);
      expect(result).toBe(true);
      rooms = await adapter.getRoomsForParticipant(testEntityId);
      expect(rooms).not.toContain(testRoomId);
    });

    it('should manage participant state', async () => {
      await adapter.addParticipant(testEntityId, testRoomId);
      await adapter.setParticipantUserState(testRoomId, testEntityId, 'FOLLOWED');
      let state = await adapter.getParticipantUserState(testRoomId, testEntityId);
      expect(state).toBe('FOLLOWED');

      await adapter.setParticipantUserState(testRoomId, testEntityId, null);
      state = await adapter.getParticipantUserState(testRoomId, testEntityId);
      expect(state).toBeNull();
    });
  });
});
