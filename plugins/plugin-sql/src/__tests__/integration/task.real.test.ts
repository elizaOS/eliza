/**
 * Task-store CRUD and query (tags/room/name) tests against a real PGlite (or
 * Postgres, if `POSTGRES_URL` is set) adapter via `createIsolatedTestDatabase`
 * — no mocks.
 */
import { ChannelType, type Entity, logger, type Room, type Task, type UUID } from "@elizaos/core";
import { v4 as uuidv4 } from "uuid";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
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
        dueAt: 1_900_000_005_000n,
        metadata: { status: "pending" },
      };

      const taskIdCreated = await adapter.createTask(task);
      expect(taskIdCreated).toBe(taskId);

      const retrieved = await adapter.getTask(taskId);
      expect(retrieved).not.toBeNull();
      expect(retrieved?.id).toBe(taskId);
      expect(retrieved?.agentId).toBe(testAgentId);
      expect(retrieved?.entityId).toBe(testEntityId);
      expect(retrieved?.dueAt).toBe(1_900_000_005_000);
      expect(retrieved?.metadata).toMatchObject({
        status: "pending",
        scheduledAt: "2030-03-17T17:46:45.000Z",
      });
      await expect(
        adapter.getTasks({ entityId: testEntityId, agentIds: [testAgentId] })
      ).resolves.toEqual([expect.objectContaining({ id: taskId, entityId: testEntityId })]);
      await expect(
        adapter.getTasks({ entityId: uuidv4() as UUID, agentIds: [testAgentId] })
      ).resolves.toEqual([]);
      await expect(adapter.getTasks({ agentIds: [] })).resolves.toEqual([]);
      await expect(adapter.getTasks({ agentIds: [uuidv4() as UUID] })).resolves.toEqual([]);
      await expect(
        adapter.createTask({
          ...task,
          id: uuidv4() as UUID,
          dueAt: BigInt(Number.MAX_SAFE_INTEGER) + 1n,
        })
      ).rejects.toThrow("safe integer millisecond timestamp");
      await expect(
        adapter.createTask({ ...task, id: uuidv4() as UUID, dueAt: Number.NaN })
      ).rejects.toThrow("safe integer millisecond timestamp");
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
      const byQuery = await adapter.getTasks({ tags: ["queue"], agentIds: [testAgentId] });

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
        metadata: { status: "pending", affinityKey: "preserved" },
      };
      await adapter.createTask(originalTask);

      await adapter.updateTask(taskId, { dueAt: 1_900_000_009_000 });
      await expect(adapter.getTask(taskId)).resolves.toMatchObject({
        dueAt: 1_900_000_009_000,
        metadata: {
          status: "pending",
          affinityKey: "preserved",
          scheduledAt: "2030-03-17T17:46:49.000Z",
        },
      });

      await adapter.updateTask(taskId, { dueAt: null });
      await expect(adapter.getTask(taskId)).resolves.toMatchObject({
        dueAt: undefined,
        metadata: { status: "pending", affinityKey: "preserved" },
      });

      await adapter.updateTask(taskId, {
        description: "Updated Description",
        dueAt: 1_900_000_010_000,
        metadata: { status: "completed" },
      });

      const retrieved = await adapter.getTask(taskId);
      expect(retrieved?.description).toBe("Updated Description");
      expect(retrieved?.dueAt).toBe(1_900_000_010_000);
      expect(retrieved?.metadata).toEqual({
        status: "completed",
        scheduledAt: "2030-03-17T17:46:50.000Z",
      });
    });

    it("does not retry malformed persisted task timing", async () => {
      const taskId = uuidv4() as UUID;
      await adapter.createTask({
        id: taskId,
        roomId: testRoomId,
        worldId: testWorldId,
        entityId: testEntityId,
        name: "Malformed timing",
        metadata: {},
      });
      await (adapter.getDatabase() as DrizzleDatabase)
        .update(taskTable)
        .set({ metadata: { scheduledAt: "not-a-date" } });

      const warn = vi.spyOn(logger, "warn");
      try {
        await expect(adapter.getTask(taskId)).rejects.toThrow("ISO-8601");
        expect(warn).not.toHaveBeenCalledWith(
          expect.objectContaining({ src: "plugin:sql" }),
          "Database operation failed, retrying"
        );
      } finally {
        warn.mockRestore();
      }
    });

    it("allows exactly one pending-task lifecycle transition", async () => {
      const taskId = uuidv4() as UUID;
      await adapter.createTask({
        id: taskId,
        roomId: testRoomId,
        worldId: testWorldId,
        entityId: testEntityId,
        name: "Contended Task",
        tags: ["queue", "follow-up"],
        metadata: { status: "pending" },
      });

      const [completed, claimed] = await Promise.all([
        adapter.updatePendingTask(taskId, {
          tags: ["follow-up"],
          metadata: { status: "completed" },
        }),
        adapter.updatePendingTask(taskId, {
          tags: ["follow-up"],
          metadata: { status: "executing" },
        }),
      ]);

      expect([completed, claimed].filter(Boolean)).toHaveLength(1);
      const stored = await adapter.getTask(taskId);
      expect(stored?.tags).not.toContain("queue");
      expect(["completed", "executing"]).toContain(stored?.metadata?.status);
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
        agentIds: [testAgentId],
      });
      expect(filteredTasks.length).toBe(1);
      expect(filteredTasks[0].id).toBe(task1.id as UUID);
      await expect(
        adapter.getTasks({
          roomId: roomId1,
          worldId: testWorldId,
          entityId: testEntityId,
          tags: ["a"],
          agentIds: [testAgentId],
        })
      ).resolves.toHaveLength(2);
      await expect(
        adapter.getTasks({ worldId: uuidv4() as UUID, agentIds: [testAgentId] })
      ).resolves.toEqual([]);
      const firstPage = await adapter.getTasks({ agentIds: [testAgentId], limit: 1 });
      const secondPage = await adapter.getTasks({ agentIds: [testAgentId], limit: 1, offset: 1 });
      expect(firstPage).toHaveLength(1);
      expect(secondPage).toHaveLength(1);
      expect(secondPage[0]?.id).not.toBe(firstPage[0]?.id);
    });
  });
});
