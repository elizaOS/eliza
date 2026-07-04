/**
 * Task-store CRUD and query (tags/room/name) tests against a real PGlite (or
 * Postgres, if `POSTGRES_URL` is set) adapter via `createIsolatedTestDatabase`
 * — no mocks.
 */
import { ChannelType, type Entity, type Room, type Task, type UUID } from "@elizaos/core";
import { v4 as uuidv4 } from "uuid";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PgDatabaseAdapter } from "../../pg/adapter";
import type { PgliteDatabaseAdapter } from "../../pglite/adapter";
import { taskTable } from "../../schema";
import type { DrizzleDatabase } from "../../types";
import { createIsolatedTestDatabase } from "../test-helpers";

describe("Task Integration Tests", () => {
  let adapter: PgliteDatabaseAdapter | PgDatabaseAdapter;
  let cleanup: () => Promise<void>;
  let testAgentId: UUID;
  let testRoomId: UUID;
  let testWorldId: UUID;
  let testEntityId: UUID;

  beforeAll(async () => {
    const setup = await createIsolatedTestDatabase("task-tests");
    adapter = setup.adapter;
    cleanup = setup.cleanup;
    testAgentId = setup.testAgentId;

    testRoomId = uuidv4() as UUID;
    testWorldId = uuidv4() as UUID;
    testEntityId = uuidv4() as UUID;

    await adapter.createWorld({
      id: testWorldId,
      agentId: testAgentId,
      name: "Test World",
      messageServerId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" as UUID,
    });

    await adapter.createRooms([
      {
        id: testRoomId,
        agentId: testAgentId,
        worldId: testWorldId,
        name: "Test Room",
        source: "test",
        type: ChannelType.GROUP,
      } as Room,
    ]);

    await adapter.createEntities([
      {
        id: testEntityId,
        agentId: testAgentId,
        names: ["Test Entity"],
      } as Entity,
    ]);

    await adapter.addParticipant(testEntityId, testRoomId);
  });

  afterAll(async () => {
    if (cleanup) {
      await cleanup();
    }
  });

  describe("Task Tests", () => {
    beforeEach(async () => {
      await (adapter.getDatabase() as DrizzleDatabase).delete(taskTable);
    });
    it("should create and retrieve a task", async () => {
      const taskId = uuidv4() as UUID;
      const task: Task = {
        id: taskId,
        roomId: testRoomId,
        worldId: testWorldId,
        entityId: testEntityId,
        name: "Test Task",
        description: "A test task",
        tags: ["a", "b"],
        metadata: { status: "pending" },
      };

      const taskIdCreated = await adapter.createTask(task);
      expect(taskIdCreated).toBe(taskId);

      const retrieved = await adapter.getTask(taskId);
      expect(retrieved).not.toBeNull();
      expect(retrieved?.id).toBe(taskId);
      expect(retrieved?.agentId).toBe(testAgentId);
    });

    it("returns agentId from task lookup APIs", async () => {
      const taskId = uuidv4() as UUID;
      const task: Task = {
        id: taskId,
        roomId: testRoomId,
        worldId: testWorldId,
        entityId: testEntityId,
        name: "Drain Task",
        description: "A managed drain task",
        tags: ["queue", "repeat"],
        metadata: { affinityKey: "autonomy" },
      };
      await adapter.createTask(task);

      const byId = await adapter.getTask(taskId);
      const byName = await adapter.getTasksByName("Drain Task");
      const byQuery = await adapter.getTasks({ tags: ["queue"] });

      expect(byId?.agentId).toBe(testAgentId);
      expect(byName).toHaveLength(1);
      expect(byName[0]?.agentId).toBe(testAgentId);
      expect(byQuery.find((item) => item.id === taskId)?.agentId).toBe(testAgentId);
    });

    it("should update a task", async () => {
      const taskId = uuidv4() as UUID;
      const originalTask: Task = {
        id: taskId,
        roomId: testRoomId,
        worldId: testWorldId,
        entityId: testEntityId,
        name: "Original Task",
        description: "Original description",
        tags: ["a"],
        metadata: { status: "pending" },
      };
      await adapter.createTask(originalTask);

      await adapter.updateTask(taskId, {
        description: "Updated Description",
        metadata: { status: "completed" },
      });

      const retrieved = await adapter.getTask(taskId);
      expect(retrieved?.description).toBe("Updated Description");
      expect(retrieved?.metadata).toEqual({ status: "completed" });
    });

    it("should delete a task", async () => {
      const taskId = uuidv4() as UUID;
      const task: Task = {
        id: taskId,
        roomId: testRoomId,
        worldId: testWorldId,
        entityId: testEntityId,
        name: "Deletable Task",
        description: "This task will be deleted",
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

    it("should filter tasks by tags and room", async () => {
      const roomId1 = uuidv4() as UUID;
      const roomId2 = uuidv4() as UUID;
      await adapter.createRooms([
        {
          id: roomId1,
          agentId: testAgentId,
          worldId: testWorldId,
          source: "test",
          type: ChannelType.GROUP,
        } as Room,
        {
          id: roomId2,
          agentId: testAgentId,
          worldId: testWorldId,
          source: "test",
          type: ChannelType.GROUP,
        } as Room,
      ]);

      const task1: Task = {
        id: uuidv4() as UUID,
        roomId: roomId1,
        worldId: testWorldId,
        entityId: testEntityId,
        name: "Task 1",
        description: "Task 1",
        tags: ["urgent", "a"],
        metadata: {},
      };
      await adapter.createTask(task1);

      const task2: Task = {
        id: uuidv4() as UUID,
        roomId: roomId1,
        worldId: testWorldId,
        entityId: testEntityId,
        name: "Task 2",
        description: "Task 2",
        tags: ["a", "b"],
        metadata: {},
      };
      await adapter.createTask(task2);

      const task3: Task = {
        id: uuidv4() as UUID,
        roomId: roomId2,
        worldId: testWorldId,
        entityId: testEntityId,
        name: "Task 3",
        description: "Task 3",
        tags: ["urgent", "c"],
        metadata: {},
      };
      await adapter.createTask(task3);

      const filteredTasks = await adapter.getTasks({
        roomId: roomId1,
        tags: ["urgent"],
      });
      expect(filteredTasks.length).toBe(1);
      expect(filteredTasks[0].id).toBe(task1.id as UUID);
    });
  });
});
