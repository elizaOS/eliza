import { describe, expect, it, beforeAll, afterAll, beforeEach } from 'vitest';
import {
  type UUID,
  type Entity,
  type Room,
  stringToUuid,
  AgentRuntime,
  ChannelType,
} from '@elizaos/core';
import { v4 as uuidv4 } from 'uuid';
import { PgliteDatabaseAdapter } from '../../src/pglite/adapter';
import { createTestDatabase } from '../test-helpers';
import { participantTable } from '../../src/schema';

describe('Participant Integration Tests', () => {
  let adapter: PgliteDatabaseAdapter;
  let runtime: AgentRuntime;
  let cleanup: () => Promise<void>;
  let testAgentId: UUID;
  let testRoomId: UUID;
  let testEntityId: UUID;
  let testWorldId: UUID;
  
  beforeAll(async () => {
    testAgentId = stringToUuid('test-agent-for-participant-tests');
    testRoomId = stringToUuid('test-room-for-participant-tests');
    testEntityId = stringToUuid('test-entity-for-participant-tests');
    testWorldId = stringToUuid('test-world-for-participant-tests');
    ({ adapter, runtime, cleanup } = await createTestDatabase(testAgentId));

    // Create necessary entities for foreign key constraints
    await adapter.createEntities([
      { id: testEntityId, agentId: testAgentId, names: ['Test Entity'] } as Entity,
    ]);
    await runtime.createRoom({
      id: testRoomId,
      agentId: testAgentId,
      name: 'Test Room',
      source: 'test',
      type: ChannelType.GROUP,
      serverId: 'test-server',
      worldId: testWorldId,
    } as Room);
  }, 30000);

  beforeEach(async () => {
    // Clear participants before each test
    await adapter.getDatabase().delete(participantTable);
  });

  afterAll(async () => {
    await cleanup();
  });

  it('should add and retrieve a participant', async () => {
    const result = await adapter.addParticipant(testEntityId, testRoomId);
    expect(result).toBe(true);

    const participants = await adapter.getParticipantsForRoom(testRoomId);
    expect(participants).toContain(testEntityId);

    const rooms = await adapter.getRoomsForParticipant(testEntityId);
    expect(rooms).toContain(testRoomId);
  });

  it('should remove a participant from a room', async () => {
    await adapter.addParticipant(testEntityId, testRoomId);
    let participants = await adapter.getParticipantsForRoom(testRoomId);
    expect(participants).toContain(testEntityId);

    const result = await adapter.removeParticipant(testEntityId, testRoomId);
    expect(result).toBe(true);

    participants = await adapter.getParticipantsForRoom(testRoomId);
    expect(participants).not.toContain(testEntityId);
  });

  it('should manage participant state', async () => {
    await adapter.addParticipant(testEntityId, testRoomId);

    await adapter.setParticipantUserState(testRoomId, testEntityId, 'FOLLOWED');
    let state = await adapter.getParticipantUserState(testRoomId, testEntityId);
    expect(state).toBe('FOLLOWED');

    await adapter.setParticipantUserState(testRoomId, testEntityId, 'MUTED');
    state = await adapter.getParticipantUserState(testRoomId, testEntityId);
    expect(state).toBe('MUTED');

    await adapter.setParticipantUserState(testRoomId, testEntityId, null);
    state = await adapter.getParticipantUserState(testRoomId, testEntityId);
    expect(state).toBeNull();
  });
});
