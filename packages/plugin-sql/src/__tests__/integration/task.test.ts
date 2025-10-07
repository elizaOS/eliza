import {
  ChannelType,
  type Entity,
  type Room,
  type Task,
  type UUID,
  type World,
} from '@elizaos/core';
import { v4 as uuidv4 } from 'uuid';
import { describe, it, expect, beforeEach, beforeAll, afterAll } from 'bun:test';
import { PgDatabaseAdapter } from '../../pg/adapter';
import { PgliteDatabaseAdapter } from '../../pglite/adapter';
import { taskTable } from '../../schema';
import { createIsolatedTestDatabase } from '../test-helpers';

describe('Task Integration Tests', () => {
  let adapter: PgliteDatabaseAdapter | PgDatabaseAdapter;
  let cleanup: () => Promise<void>;
  let testAgentId: UUID;
  let testRoomId: UUID;
  let testWorldId: UUID;
  let testEntityId: UUID;

  beforeAll(async () => {
    const setup = await createIsolatedTestDatabase('task-tests');
    adapter = setup.adapter;
    cleanup = setup.cleanup;
    testAgentId = setup.testAgentId;

    // Generate random UUIDs for test data
    testRoomId = uuidv4() as UUID;
    testWorldId = uuidv4() as UUID;
    testEntityId = uuidv4() as UUID;

    // Create test world
    await adapter.createWorld({
      id: testWorldId,
      agentId: testAgentId,
      name: 'Test World',
      serverId: 'test-server',
    } as World);

    // Create test room
    await adapter.createRooms([
      {
        id: testRoomId,
        agentId: testAgentId,
        worldId: testWorldId,
        name: 'Test Room',
        source: 'test',
        type: ChannelType.GROUP,
      } as Room,
    ]);

    // Create test entity
    await adapter.createEntities([
      { id: testEntityId, agentId: testAgentId, names: ['Test Entity'] } as Entity,
    ]);

    await adapter.addParticipant(testEntityId, testRoomId);
  });

  afterAll(async () => {
    if (cleanup) {
      await cleanup();
    }
  });

  describe('Task Tests', () => {
    beforeEach(async () => {
      await adapter.getDatabase().delete(taskTable);
    });
    it('should create and retrieve a task', async () => {
      const taskId = uuidv4() as UUID;
      const task: Task = {
        id: taskId,
        roomId: testRoomId,
        worldId: testWorldId,
        entityId: testEntityId,
        name: 'Test Task',
        description: 'A test task',
        tags: ['a', 'b'],
        metadata: { status: 'pending' },
      };

      const taskIdCreated = await adapter.createTask(task);
      expect(taskIdCreated).toBe(taskId);

      const retrieved = await adapter.getTask(taskId);
      expect(retrieved).not.toBeNull();
      expect(retrieved?.id).toBe(taskId);
    });

    it('should update a task', async () => {
      const taskId = uuidv4() as UUID;
      const originalTask: Task = {
        id: taskId,
        roomId: testRoomId,
        worldId: testWorldId,
        entityId: testEntityId,
        name: 'Original Task',
        description: 'Original description',
        tags: ['a'],
        metadata: { status: 'pending' },
      };
      await adapter.createTask(originalTask);

      await adapter.updateTask(taskId, {
        description: 'Updated Description',
        metadata: { status: 'completed' },
      });

      const retrieved = await adapter.getTask(taskId);
      expect(retrieved?.description).toBe('Updated Description');
      expect(retrieved?.metadata).toEqual({ status: 'completed' });
    });

    it('should delete a task', async () => {
      const taskId = uuidv4() as UUID;
      const task: Task = {
        id: taskId,
        roomId: testRoomId,
        worldId: testWorldId,
        entityId: testEntityId,
        name: 'Deletable Task',
        description: 'This task will be deleted',
        tags: [],
        metadata: {},
      };
      await adapter.createTask(task);
      let retrieved = await adapter.getTask(taskId);
      expect(retrieved).not.toBeNull();
      await adapter.deleteTask(taskId);
      retrieved = await adapter.getTask(taskId);
      expect(retrieved).toBeNull();
    });

    it('should filter tasks by tags and room', async () => {
      const roomId1 = uuidv4() as UUID;
      const roomId2 = uuidv4() as UUID;
      await adapter.createRooms([
        {
          id: roomId1,
          agentId: testAgentId,
          worldId: testWorldId,
          source: 'test',
          type: ChannelType.GROUP,
        } as Room,
        {
          id: roomId2,
          agentId: testAgentId,
          worldId: testWorldId,
          source: 'test',
          type: ChannelType.GROUP,
        } as Room,
      ]);

      const task1: Task = {
        id: uuidv4() as UUID,
        roomId: roomId1,
        worldId: testWorldId,
        entityId: testEntityId,
        name: 'Task 1',
        description: 'Task 1',
        tags: ['urgent', 'a'],
        metadata: {},
      };
      await adapter.createTask(task1);

      const task2: Task = {
        id: uuidv4() as UUID,
        roomId: roomId1,
        worldId: testWorldId,
        entityId: testEntityId,
        name: 'Task 2',
        description: 'Task 2',
        tags: ['a', 'b'],
        metadata: {},
      };
      await adapter.createTask(task2);

      const task3: Task = {
        id: uuidv4() as UUID,
        roomId: roomId2,
        worldId: testWorldId,
        entityId: testEntityId,
        name: 'Task 3',
        description: 'Task 3',
        tags: ['urgent', 'c'],
        metadata: {},
      };
      await adapter.createTask(task3);

      const filteredTasks = await adapter.getTasks({ roomId: roomId1, tags: ['urgent'] });
      expect(filteredTasks.length).toBe(1);
      expect(filteredTasks[0].id).toBe(task1.id as UUID);
    });
  });
});
