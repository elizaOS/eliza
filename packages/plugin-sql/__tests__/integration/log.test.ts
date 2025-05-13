import { describe, expect, it, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { PgliteDatabaseAdapter } from '../../src/pglite/adapter';
import { PGliteClientManager } from '../../src/pglite/manager';
import { type UUID, type Entity, type Room, type Agent, type World } from '@elizaos/core';
import {
  logTestAgentSettings,
  logTestEntity,
  logTestRoom,
  logTestLogs,
  logTestWorld,
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

describe('Log Integration Tests', () => {
  // Database connection variables
  let connectionManager: PGliteClientManager;
  let adapter: PgliteDatabaseAdapter;
  let testAgentId: UUID;
  let testEntityId: UUID;
  let testRoomId: UUID;
  let testWorldId: UUID;

  beforeAll(async () => {
    // Use the shared test IDs
    testAgentId = logTestAgentSettings.id as UUID;
    testEntityId = logTestEntity.id;
    testRoomId = logTestRoom.id;
    testWorldId = logTestWorld.id;

    // Initialize connection manager and adapter
    connectionManager = new PGliteClientManager({});
    await connectionManager.initialize();
    adapter = new PgliteDatabaseAdapter(testAgentId, connectionManager);
    await adapter.init();

    try {
      // Use ensureAgentExists instead of createAgent
      await adapter.createAgent(logTestAgentSettings as Agent);

      // Create the test world first
      await adapter.createWorld({
        ...logTestWorld,
        agentId: testAgentId,
      });

      // Create the test entity
      await adapter.createEntity({
        ...logTestEntity,
        agentId: testAgentId,
      } as Entity);

      // Create the test room
      await adapter.createRoom({
        ...logTestRoom,
        agentId: testAgentId,
      } as Room);
    } catch (error) {
      console.error('Error in setup:', error);
      throw error;
    }
  }, 10000);

  afterAll(async () => {
    // Clean up test data
    const client = connectionManager.getConnection();
    try {
      // Delete test data in correct order due to foreign key constraints
      await client.query(`DELETE FROM logs WHERE "entityId" = '${testEntityId}'`);
      await client.query(`DELETE FROM entities WHERE id = '${testEntityId}'`);
      await client.query(`DELETE FROM rooms WHERE id = '${testRoomId}'`);
      await client.query(`DELETE FROM worlds WHERE id = '${testWorldId}'`);
      await client.query(`DELETE FROM agents WHERE id = '${testAgentId}'`);
    } catch (error) {
      console.error('Error cleaning test data:', error);
    }

    // Close all connections
    await adapter.close();
  }, 10000);

  beforeEach(async () => {
    // Clean up any existing logs for our test entity
    try {
      const client = connectionManager.getConnection();
      await client.query(`DELETE FROM logs WHERE "entityId" = '${testEntityId}'`);
    } catch (error) {
      console.error('Error cleaning test log data:', error);
    }
  });

  afterEach(async () => {
    vi.clearAllMocks();
  });

  describe('log', () => {
    it('should successfully create a log entry', async () => {
      const logParams = {
        body: logTestLogs.basic.body,
        entityId: testEntityId,
        roomId: testRoomId,
        type: logTestLogs.basic.type,
      };

      await expect(adapter.log(logParams)).resolves.not.toThrow();

      // Verify the log was created by retrieving it
      const logs = await adapter.getLogs({
        entityId: testEntityId,
        roomId: testRoomId,
        type: logTestLogs.basic.type,
      });

      expect(logs).toHaveLength(1);
      expect(logs[0].body).toEqual(logParams.body);
      expect(logs[0].type).toBe(logParams.type);
    });

    it('should create a log with rich metadata', async () => {
      const logParams = {
        body: logTestLogs.withMetadata.body,
        entityId: testEntityId,
        roomId: testRoomId,
        type: logTestLogs.withMetadata.type,
      };

      await adapter.log(logParams);

      const logs = await adapter.getLogs({
        entityId: testEntityId,
        type: logTestLogs.withMetadata.type,
      });

      expect(logs).toHaveLength(1);
      expect(logs[0].body).toEqual(logParams.body);
      // Access the metadata property safely using type assertion
      const metadata = logs[0].body.metadata as { priority: string; source: string };
      expect(metadata.priority).toBe('high');
    });

    it('should throw an error when entity does not exist', async () => {
      const nonExistentEntityId = uuidv4() as UUID;
      const logParams = {
        body: { message: 'This should fail' },
        entityId: nonExistentEntityId,
        roomId: testRoomId,
        type: 'error_test',
      };

      await expect(adapter.log(logParams)).rejects.toThrow();
    });

    it('should throw an error when room does not exist', async () => {
      const nonExistentRoomId = uuidv4() as UUID;
      const logParams = {
        body: { message: 'This should fail' },
        entityId: testEntityId,
        roomId: nonExistentRoomId,
        type: 'error_test',
      };

      await expect(adapter.log(logParams)).rejects.toThrow();
    });
  });

  describe('getLogs', () => {
    beforeEach(async () => {
      // Create several log entries for testing
      await adapter.log({
        body: logTestLogs.basic.body,
        entityId: testEntityId,
        roomId: testRoomId,
        type: 'test_log',
      });

      await adapter.log({
        body: logTestLogs.withMetadata.body,
        entityId: testEntityId,
        roomId: testRoomId,
        type: 'metadata_log',
      });

      await adapter.log({
        body: { message: 'Another test log' },
        entityId: testEntityId,
        roomId: testRoomId,
        type: 'test_log',
      });
    });

    it('should retrieve all logs for an entity', async () => {
      const logs = await adapter.getLogs({
        entityId: testEntityId,
      });

      expect(logs.length).toBe(3);
      // Verify logs are returned in descending order by creation time
      expect(logs[0].createdAt.getTime()).toBeGreaterThanOrEqual(logs[1].createdAt.getTime());
    });

    it('should filter logs by type', async () => {
      const logs = await adapter.getLogs({
        entityId: testEntityId,
        type: 'test_log',
      });

      expect(logs.length).toBe(2);
      logs.forEach((log) => {
        expect(log.type).toBe('test_log');
      });
    });

    it('should filter logs by room id', async () => {
      const logs = await adapter.getLogs({
        entityId: testEntityId,
        roomId: testRoomId,
        type: 'metadata_log',
      });

      expect(logs.length).toBe(1);
      expect(logs[0].type).toBe('metadata_log');
      // Access the metadata property safely using type assertion
      const metadata = logs[0].body.metadata as { priority: string; source: string };
      expect(metadata.priority).toBe('high');
    });

    it('should limit the number of logs returned', async () => {
      // Create extra logs
      for (let i = 0; i < 5; i++) {
        await adapter.log({
          body: { message: `Extra log ${i}` },
          entityId: testEntityId,
          roomId: testRoomId,
          type: 'extra_log',
        });
      }

      const logs = await adapter.getLogs({
        entityId: testEntityId,
        count: 3,
      });

      expect(logs.length).toBe(3);
    });

    it('should support pagination with offset', async () => {
      // Create 10 numbered logs
      for (let i = 0; i < 10; i++) {
        await adapter.log({
          body: { message: `Pagination log ${i}` },
          entityId: testEntityId,
          roomId: testRoomId,
          type: 'pagination_log',
        });
      }

      // Get first page
      const firstPage = await adapter.getLogs({
        entityId: testEntityId,
        type: 'pagination_log',
        count: 5,
        offset: 0,
      });

      // Get second page
      const secondPage = await adapter.getLogs({
        entityId: testEntityId,
        type: 'pagination_log',
        count: 5,
        offset: 5,
      });

      expect(firstPage.length).toBe(5);
      expect(secondPage.length).toBe(5);

      // Ensure no overlap between pages
      const firstPageIds = firstPage.map((log) => log.id);
      const secondPageIds = secondPage.map((log) => log.id);
      const intersection = firstPageIds.filter((id) => secondPageIds.includes(id));
      expect(intersection.length).toBe(0);
    });

    it('should return an empty array for non-existent entity', async () => {
      const nonExistentEntityId = uuidv4() as UUID;
      const logs = await adapter.getLogs({
        entityId: nonExistentEntityId,
      });

      expect(logs).toHaveLength(0);
    });
  });

  describe('deleteLog', () => {
    let testLogId: UUID;

    beforeEach(async () => {
      // Create a log entry for testing deletion
      await adapter.log({
        body: { message: 'Log to delete' },
        entityId: testEntityId,
        roomId: testRoomId,
        type: 'delete_test',
      });

      const logs = await adapter.getLogs({
        entityId: testEntityId,
        type: 'delete_test',
      });

      // Ensure logs[0] exists and has an id before assigning
      expect(logs).toHaveLength(1);
      expect(logs[0].id).toBeDefined();
      testLogId = logs[0].id as UUID;
    });

    it('should delete a log entry by id', async () => {
      await adapter.deleteLog(testLogId);

      const logs = await adapter.getLogs({
        entityId: testEntityId,
        type: 'delete_test',
      });

      expect(logs).toHaveLength(0);
    });

    it('should not throw when deleting a non-existent log', async () => {
      const nonExistentId = uuidv4() as UUID;

      await expect(adapter.deleteLog(nonExistentId)).resolves.not.toThrow();
    });

    it('should only delete the specified log', async () => {
      // Create another log
      await adapter.log({
        body: { message: 'Log to keep' },
        entityId: testEntityId,
        roomId: testRoomId,
        type: 'keep_test',
      });

      // Get count before deletion
      const beforeLogs = await adapter.getLogs({ entityId: testEntityId });
      const beforeCount = beforeLogs.length;

      // Delete one specific log
      await adapter.deleteLog(testLogId);

      // Get count after deletion
      const afterLogs = await adapter.getLogs({ entityId: testEntityId });
      const afterCount = afterLogs.length;

      // Should have one fewer log
      expect(afterCount).toBe(beforeCount - 1);

      // The 'keep_test' log should still exist
      const keepLogs = await adapter.getLogs({
        entityId: testEntityId,
        type: 'keep_test',
      });
      expect(keepLogs).toHaveLength(1);
    });
  });
});
