import { type Entity, type Room, type UUID, AgentRuntime, ChannelType } from '@elizaos/core';
import { v4 as uuidv4 } from 'uuid';
import { describe, it, expect, beforeEach, beforeAll, afterAll } from 'bun:test';
import { PgDatabaseAdapter } from '../../pg/adapter';
import { PgliteDatabaseAdapter } from '../../pglite/adapter';
import { logTable } from '../../schema';
import { createIsolatedTestDatabase } from '../test-helpers';

describe('Log Integration Tests', () => {
  let adapter: PgliteDatabaseAdapter | PgDatabaseAdapter;
  let runtime: AgentRuntime;
  let cleanup: () => Promise<void>;
  let testAgentId: UUID;
  let testEntityId: UUID;
  let testRoomId: UUID;

  beforeAll(async () => {
    const setup = await createIsolatedTestDatabase('log-tests');
    adapter = setup.adapter;
    runtime = setup.runtime;
    cleanup = setup.cleanup;
    testAgentId = setup.testAgentId;

    // Generate random UUIDs for test data
    testEntityId = uuidv4() as UUID;
    testRoomId = uuidv4() as UUID;

    // Create necessary entities for foreign key constraints
    await adapter.createEntities([
      { id: testEntityId, agentId: testAgentId, names: ['Test Entity'] } as Entity,
    ]);
    await adapter.createRooms([
      {
        id: testRoomId,
        agentId: testAgentId,
        name: 'Test Room',
        source: 'test',
        type: ChannelType.GROUP,
      } as Room,
    ]);
  });

  afterAll(async () => {
    if (cleanup) {
      await cleanup();
    }
  });

  describe('Log Tests', () => {
    beforeEach(async () => {
      await adapter.getDatabase().delete(logTable);
    });

    it('should create and retrieve a log entry', async () => {
      const logData = {
        body: { message: 'hello world' },
        entityId: testEntityId,
        roomId: testRoomId,
        type: 'test_log',
      };
      await adapter.log(logData);
      const logs = await adapter.getLogs({ entityId: testEntityId, roomId: testRoomId });
      expect(logs).toHaveLength(1);
      expect(logs[0].body).toEqual({ message: 'hello world' });
    });

    it('should not throw when deleting a non-existent log', async () => {
      const nonExistentId = uuidv4() as UUID;
      await adapter.deleteLog(nonExistentId);
      expect(true).toBe(true);
    });

    it('should filter logs by type', async () => {
      await adapter.log({
        body: { message: 'message 1' },
        entityId: testEntityId,
        roomId: testRoomId,
        type: 'typeA',
      });
      await adapter.log({
        body: { message: 'message 2' },
        entityId: testEntityId,
        roomId: testRoomId,
        type: 'typeB',
      });

      const logs = await adapter.getLogs({
        entityId: testEntityId,
        roomId: testRoomId,
        type: 'typeA',
      });
      expect(logs).toHaveLength(1);
      expect(logs[0].type).toBe('typeA');
    });
  });
});
