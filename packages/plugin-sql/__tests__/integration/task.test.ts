import { describe, expect, it, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { PgDatabaseAdapter } from '../../src/pg/adapter';
import { PostgresConnectionManager } from '../../src/pg/manager';
import { ChannelType, Agent, World, Room, type UUID } from '@elizaos/core';
import { config } from '../config';
import {
  taskTestAgentId,
  taskTestRoomId,
  taskTestWorldId,
  taskTestTasks,
  taskTestTaskDifferentRoom,
  taskTestTaskWithSpecificTags,
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

describe('Task Integration Tests', () => {
  // Database connection variables
  let connectionManager: PostgresConnectionManager;
  let adapter: PgDatabaseAdapter;
  let agentId: UUID = taskTestAgentId;

  // Test data
  const testAgent: Agent = {
    id: taskTestAgentId,
    name: 'Task Test Agent',
    bio: 'Test agent for task integration tests',
    settings: {
      profile: {
        short_description: 'Test agent for task integration tests',
      },
    },
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };

  const testWorld: World = {
    id: taskTestWorldId,
    agentId: taskTestAgentId,
    name: 'Task Test World',
    serverId: 'test-server',
    metadata: {},
  };

  const testRoom: Room = {
    id: taskTestRoomId,
    name: 'Task Test Room',
    agentId: taskTestAgentId,
    source: 'test',
    type: ChannelType.GROUP,
    worldId: taskTestWorldId,
    metadata: {},
  };

  beforeAll(async () => {
    // Initialize connection manager and adapter
    connectionManager = new PostgresConnectionManager(config.DATABASE_URL);
    await connectionManager.initialize();
    adapter = new PgDatabaseAdapter(agentId, connectionManager);
    await adapter.init();

    try {
      // Set up test environment
      // Step 1: Create test agent
      await adapter.createAgent(testAgent);

      // Step 2: Create test world
      await adapter.createWorld({
        ...testWorld,
        agentId: taskTestAgentId,
      });

      // Step 3: Create test room
      await adapter.createRoom(testRoom);
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
      await client.query(`DELETE FROM tasks WHERE "agent_id" = '${taskTestAgentId}'`);
      await client.query(`DELETE FROM rooms WHERE id = '${taskTestRoomId}'`);
      await client.query(`DELETE FROM worlds WHERE id = '${taskTestWorldId}'`);
      await client.query(`DELETE FROM agents WHERE id = '${taskTestAgentId}'`);
    } catch (error) {
      console.error('Error cleaning test data:', error);
    } finally {
      client.release();
    }

    // Close all connections
    await adapter.close();
  }, 10000);

  beforeEach(async () => {
    // Clean up any existing test tasks before each test
    const client = await connectionManager.getClient();
    try {
      await client.query(`DELETE FROM tasks WHERE "agent_id" = '${taskTestAgentId}'`);
    } finally {
      client.release();
    }
  });

  afterEach(async () => {
    vi.clearAllMocks();
  });

  describe('Task CRUD Operations', () => {
    it('should create a task', async () => {
      const task = taskTestTasks[0];
      const taskId = await adapter.createTask(task);

      expect(taskId).toBe(task.id);

      // Verify it exists in the database
      const createdTask = await adapter.getTask(taskId);
      expect(createdTask).not.toBeNull();
      expect(createdTask?.name).toBe(task.name);
      expect(createdTask?.description).toBe(task.description);
      expect(createdTask?.roomId).toBe(task.roomId);
      expect(createdTask?.worldId).toBe(task.worldId);
      expect(createdTask?.tags).toEqual(task.tags);
      expect(createdTask?.metadata!).toMatchObject(task.metadata!);
    });

    it('should retrieve a task by ID', async () => {
      // Create a task first
      const task = taskTestTasks[1];
      const taskId = await adapter.createTask(task);

      // Retrieve the task
      const retrievedTask = await adapter.getTask(taskId);

      expect(retrievedTask).not.toBeNull();
      expect(retrievedTask?.id).toBe(taskId);
      expect(retrievedTask?.name).toBe(task.name);
      expect(retrievedTask?.description).toBe(task.description);
      // Verify all fields match
      expect(retrievedTask?.tags).toEqual(task.tags);
      expect(retrievedTask?.metadata!).toMatchObject(task.metadata!);
    });

    it('should update a task', async () => {
      // Create a task first
      const task = taskTestTasks[2];
      const taskId = await adapter.createTask(task);

      // Update the task
      const updateData = {
        name: 'Updated Task Name',
        description: 'This task has been updated',
        tags: [...task.tags, 'updated'],
        metadata: {
          ...task.metadata,
          status: 'in-progress',
          updateTime: Date.now(),
        },
      };

      await adapter.updateTask(taskId, updateData);

      // Verify the update
      const updatedTask = await adapter.getTask(taskId);
      expect(updatedTask?.name).toBe(updateData.name);
      expect(updatedTask?.description).toBe(updateData.description);
      expect(updatedTask?.tags).toEqual(updateData.tags);
      expect(updatedTask?.metadata!).toMatchObject(updateData.metadata!);

      // Original fields remain
      expect(updatedTask?.roomId).toBe(task.roomId);
      expect(updatedTask?.worldId).toBe(task.worldId);
    });

    it('should delete a task', async () => {
      // Create a task first
      const task = taskTestTasks[3];
      const taskId = await adapter.createTask(task);

      // Verify it exists
      const createdTask = await adapter.getTask(taskId);
      expect(createdTask).not.toBeNull();

      // Delete the task
      await adapter.deleteTask(taskId);

      // Verify it's gone
      const deletedTask = await adapter.getTask(taskId);
      expect(deletedTask).toBeNull();
    });

    it('should handle partial task updates without affecting other fields', async () => {
      // Create a task first
      const task = taskTestTasks[0];
      const taskId = await adapter.createTask(task);

      // Update only the name
      await adapter.updateTask(taskId, { name: 'Only Name Updated' });

      // Verify only name changed, other fields preserved
      const afterNameUpdate = await adapter.getTask(taskId);
      expect(afterNameUpdate?.name).toBe('Only Name Updated');
      expect(afterNameUpdate?.description).toBe(task.description);
      expect(afterNameUpdate?.tags).toEqual(task.tags);
      expect(afterNameUpdate?.metadata!).toMatchObject(task.metadata!);

      // Update only metadata
      const metadataUpdate = {
        metadata: {
          ...task.metadata,
          status: 'completed',
        },
      };

      await adapter.updateTask(taskId, metadataUpdate);

      // Verify only metadata updated, other fields preserved
      const afterMetadataUpdate = await adapter.getTask(taskId);
      expect(afterMetadataUpdate?.name).toBe('Only Name Updated'); // From previous update
      expect(afterMetadataUpdate?.description).toBe(task.description);
      expect(afterMetadataUpdate?.tags).toEqual(task.tags);
      expect(afterMetadataUpdate?.metadata!).toMatchObject({
        ...task.metadata!,
        status: 'completed',
      });
    });
  });

  describe('Task Filtering and Search Operations', () => {
    it('should retrieve tasks filtered by room ID', async () => {
      // Create tasks in the main test room
      for (const task of taskTestTasks) {
        await adapter.createTask(task);
      }

      // Create a task in a different room
      await adapter.createTask(taskTestTaskDifferentRoom);

      // Retrieve tasks from the main test room
      const tasks = await adapter.getTasks({ roomId: taskTestRoomId });

      // Should find all tasks in the main room but not the task in different room
      expect(tasks).toHaveLength(taskTestTasks.length);

      // All tasks should belong to the test room
      for (const task of tasks) {
        expect(task.roomId).toBe(taskTestRoomId);
      }

      // The different room task should not be included
      const differentRoomTaskIncluded = tasks.some(
        (task) => task.id === taskTestTaskDifferentRoom.id
      );
      expect(differentRoomTaskIncluded).toBe(false);
    });

    it('should retrieve tasks filtered by tags', async () => {
      // Create regular test tasks
      for (const task of taskTestTasks) {
        await adapter.createTask(task);
      }

      // Create a task with specific tags
      await adapter.createTask(taskTestTaskWithSpecificTags);

      // Retrieve tasks with specific tag
      const tasksWithSpecificTag = await adapter.getTasks({
        tags: ['specific-tag'],
      });

      expect(tasksWithSpecificTag).toHaveLength(1);
      expect(tasksWithSpecificTag[0].id).toBe(taskTestTaskWithSpecificTags.id);

      // Retrieve tasks with multiple tags (should find tasks with ALL specified tags)
      const tasksWithMultipleTags = await adapter.getTasks({
        tags: ['test', 'integration'],
      });

      // Should find tasks that have both 'test' and 'integration' tags
      expect(tasksWithMultipleTags.length).toBeGreaterThan(0);
      for (const task of tasksWithMultipleTags) {
        expect(task.tags).toContain('test');
        expect(task.tags).toContain('integration');
      }
    });

    it('should retrieve tasks by name', async () => {
      // Create all test tasks
      for (const task of taskTestTasks) {
        await adapter.createTask(task);
      }

      // Find the special test task by name
      const specialTasks = await adapter.getTasksByName('Special Test Task');

      expect(specialTasks).toHaveLength(1);
      expect(specialTasks[0].name).toBe('Special Test Task');

      // Test with a non-existent name
      const nonExistentTasks = await adapter.getTasksByName('Non-Existent Task');
      expect(nonExistentTasks).toHaveLength(0);

      // Create multiple tasks with the same name
      const duplicateTaskName = 'Duplicate Task Name';

      for (let i = 0; i < 3; i++) {
        await adapter.createTask({
          id: uuidv4() as UUID,
          name: duplicateTaskName,
          description: `Duplicate task ${i + 1}`,
          roomId: taskTestRoomId,
          worldId: taskTestWorldId,
          tags: ['test', 'duplicate'],
          metadata: { index: i },
        });
      }

      // Find tasks with duplicate name
      const duplicateTasks = await adapter.getTasksByName(duplicateTaskName);
      expect(duplicateTasks).toHaveLength(3);
      duplicateTasks.forEach((task) => {
        expect(task.name).toBe(duplicateTaskName);
      });
    });

    it('should combine room and tag filters', async () => {
      // Create various tasks
      for (const task of taskTestTasks) {
        await adapter.createTask(task);
      }

      // Create task with specific tags
      await adapter.createTask(taskTestTaskWithSpecificTags);

      // Create task in different room
      await adapter.createTask(taskTestTaskDifferentRoom);

      // Retrieve tasks with both room and tag filters
      const filteredTasks = await adapter.getTasks({
        roomId: taskTestRoomId,
        tags: ['test', 'integration'],
      });

      // All returned tasks should match both criteria
      expect(filteredTasks.length).toBeGreaterThan(0);
      for (const task of filteredTasks) {
        expect(task.roomId).toBe(taskTestRoomId);
        expect(task.tags).toContain('test');
        expect(task.tags).toContain('integration');
      }

      // The different room task should not be included
      const differentRoomTaskIncluded = filteredTasks.some(
        (task) => task.id === taskTestTaskDifferentRoom.id
      );
      expect(differentRoomTaskIncluded).toBe(false);

      // Tasks without the specified tags should not be included
      const specificTagTaskIncluded = filteredTasks.some(
        (task) => task.id === taskTestTaskWithSpecificTags.id
      );
      // This will be false if the specific tag task doesn't have 'integration' tag
      expect(specificTagTaskIncluded).toBe(false);
    });
  });

  describe('Investment Manager Task Compatibility', () => {
    it('should support tasks with updateInterval in metadata', async () => {
      // Create a task similar to those used in the investment manager
      const intelTask = {
        id: uuidv4() as UUID,
        name: 'INTEL_SYNC_TEST',
        description: 'Test syncing task for investment manager',
        roomId: taskTestRoomId,
        worldId: taskTestWorldId,
        tags: ['queue', 'repeat', 'degen_intel'],
        metadata: {
          updatedAt: Date.now(),
          updateInterval: 1000 * 60 * 60, // 1 hour
        },
      };

      const taskId = await adapter.createTask(intelTask);

      // Verify it exists with the correct metadata
      const createdTask = await adapter.getTask(taskId);
      expect(createdTask).not.toBeNull();
      expect(createdTask?.name).toBe(intelTask.name);
      expect(createdTask?.tags).toEqual(intelTask.tags);
      expect(createdTask?.metadata!.updateInterval).toBe(intelTask.metadata.updateInterval);
      expect(createdTask?.metadata!.updatedAt).toBe(intelTask.metadata.updatedAt);
    });

    it('should retrieve tasks filtered by the tags used in investment manager', async () => {
      // Create several tasks with the tags used in investment manager
      const intelTasks = [
        {
          id: uuidv4() as UUID,
          name: 'INTEL_BIRDEYE_SYNC_TRENDING',
          description: 'Sync trending tokens from Birdeye',
          roomId: taskTestRoomId,
          worldId: taskTestWorldId,
          tags: ['queue', 'repeat', 'degen_intel'],
          metadata: {
            updatedAt: Date.now(),
            updateInterval: 1000 * 60 * 60, // 1 hour
          },
        },
        {
          id: uuidv4() as UUID,
          name: 'INTEL_SYNC_RAW_TWEETS',
          description: 'Sync raw tweets from Twitter',
          roomId: taskTestRoomId,
          worldId: taskTestWorldId,
          tags: ['queue', 'repeat', 'degen_intel'],
          metadata: {
            updatedAt: Date.now(),
            updateInterval: 1000 * 60 * 15, // 15 minutes
          },
        },
        {
          id: uuidv4() as UUID,
          name: 'INTEL_PARSE_TWEETS',
          description: 'Parse tweets',
          roomId: taskTestRoomId,
          worldId: taskTestWorldId,
          tags: ['queue', 'repeat', 'degen_intel'],
          metadata: {
            updatedAt: Date.now(),
            updateInterval: 1000 * 60 * 60 * 24, // 24 hours
          },
        },
      ];

      // Create all the intel tasks
      for (const task of intelTasks) {
        await adapter.createTask(task);
      }

      // Retrieve tasks with the specific tags used in investment manager
      const retrievedTasks = await adapter.getTasks({
        tags: ['queue', 'repeat', 'degen_intel'],
      });

      // Verify we got all the tasks
      expect(retrievedTasks.length).toBe(intelTasks.length);

      // Verify each task has all the required tags
      for (const task of retrievedTasks) {
        expect(task.tags).toContain('queue');
        expect(task.tags).toContain('repeat');
        expect(task.tags).toContain('degen_intel');
      }

      // Verify we can find a specific task by name
      const tweetTasks = await adapter.getTasksByName('INTEL_SYNC_RAW_TWEETS');
      expect(tweetTasks.length).toBe(1);
      expect(tweetTasks[0].name).toBe('INTEL_SYNC_RAW_TWEETS');
    });
  });
});

// Helper function for tests
function uuidv4(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}
