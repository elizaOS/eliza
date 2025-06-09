import { describe, expect, it, beforeAll, afterAll, beforeEach } from 'vitest';
import { PgliteDatabaseAdapter } from '../../src/pglite/adapter';
import {
  type UUID,
  type Entity,
  type Room,
  type World,
  type Agent,
  type Log,
  stringToUuid,
  AgentRuntime,
  ChannelType,
} from '@elizaos/core';
import { v4 as uuidv4 } from 'uuid';
import { createTestDatabase } from '../test-helpers';
import { logTable } from '../../src/schema';

describe('Log Integration Tests', () => {
  let adapter: PgliteDatabaseAdapter;
  let runtime: AgentRuntime;
  let cleanup: () => Promise<void>;
  let testAgentId: UUID;
  let testEntityId: UUID;
  let testRoomId: UUID;
  let testWorldId: UUID;
  beforeAll(async () => {
    testAgentId = stringToUuid('test-agent-for-log-tests');
    testEntityId = stringToUuid('test-entity-for-log-tests');
    testRoomId = stringToUuid('test-room-for-log-tests');
    testWorldId = stringToUuid('test-world-for-log-tests');
    ({ adapter, runtime, cleanup } = await createTestDatabase(testAgentId));

    // Create necessary entities for foreign key constraints
    await adapter.createEntities([
      { id: testEntityId, agentId: testAgentId, names: ['Test Entity'] } as Entity,
    ]);
    await runtime.createRoom({
      id: testRoomId,
      agentId: testAgentId,
      worldId: testWorldId,
      name: 'Test Room',
      source: 'test',
      type: ChannelType.GROUP,
    } as Room);
  }, 30000);

  afterAll(async () => {
    await cleanup();
  });

  beforeEach(async () => {
    // Clean the log table before each test
    await adapter.getDatabase().delete(logTable);
  });

  it('should create and retrieve a log entry', async () => {
    const logParams = {
      body: { message: 'test log' },
      entityId: testEntityId,
      roomId: testRoomId,
      type: 'test_log_type',
    };

    await adapter.log(logParams);

    const logs = await adapter.getLogs({ entityId: testEntityId, type: 'test_log_type' });
    expect(logs).toHaveLength(1);
    expect(logs[0].body).toEqual(logParams.body);
  });

  it('should not throw when deleting a non-existent log', async () => {
    const nonExistentId = uuidv4() as UUID;
    await expect(adapter.deleteLog(nonExistentId)).resolves.not.toThrow();
  });

  it('should filter logs by type', async () => {
    await adapter.log({
      body: { a: 1 },
      entityId: testEntityId,
      roomId: testRoomId,
      type: 'typeA',
    });
    await adapter.log({
      body: { b: 2 },
      entityId: testEntityId,
      roomId: testRoomId,
      type: 'typeB',
    });
    await adapter.log({
      body: { c: 3 },
      entityId: testEntityId,
      roomId: testRoomId,
      type: 'typeA',
    });

    const logs = await adapter.getLogs({ entityId: testEntityId, type: 'typeA' });
    expect(logs).toHaveLength(2);
  });
});
