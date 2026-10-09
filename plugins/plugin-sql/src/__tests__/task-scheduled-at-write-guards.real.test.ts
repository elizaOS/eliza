/**
 * Exercises real SQL task timing writes and list-to-scheduler dispatch, including
 * malformed stored rows, healthy sibling execution, and repair. The existing
 * isolated database fixture supplies the actual adapter and AgentRuntime;
 * TaskService uses an injected clock without replacing validation or execution.
 */
import {
  type AgentRuntime,
  ChannelType,
  type Entity,
  type Room,
  type Task,
  TaskService,
  type UUID,
} from "@elizaos/core";
import { eq } from "drizzle-orm";
import { v4 as uuidv4 } from "uuid";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PgDatabaseAdapter } from "../pg/adapter";
import type { PgliteDatabaseAdapter } from "../pglite/adapter";
import { taskTable } from "../schema/tasks";
import type { DrizzleDatabase } from "../types";
import { createIsolatedTestDatabase } from "./test-helpers";

const NON_CANONICAL_ISO = "2026-09-21T09:00:00Z";
const CANONICAL_ISO = "2026-09-21T09:00:00.000Z";
const CANONICAL_MS = Date.parse(CANONICAL_ISO);
const REPEAT_DUE_AT = 1_900_000_005_000;

describe("task scheduledAt write guards", () => {
  let adapter: PgliteDatabaseAdapter | PgDatabaseAdapter;
  let cleanup: () => Promise<void>;
  let runtime: AgentRuntime;
  let testAgentId: UUID;
  let testRoomId: UUID;
  let testWorldId: UUID;
  let testEntityId: UUID;

  const baseTask = (overrides: Partial<Task> & { name: string }): Task => ({
    id: uuidv4() as UUID,
    roomId: testRoomId,
    worldId: testWorldId,
    entityId: testEntityId,
    description: "",
    tags: [],
    metadata: {},
    ...overrides,
  });

  const createHealthyRepeatTask = async (): Promise<UUID> =>
    adapter.createTask(
      baseTask({
        name: "healthy-repeat",
        tags: ["queue", "repeat"],
        dueAt: REPEAT_DUE_AT,
        metadata: { updateInterval: 60_000 },
      })
    );

  const createQueueTask = async (): Promise<UUID> =>
    adapter.createTask(
      baseTask({
        name: "queued-once",
        tags: ["queue"],
        metadata: { status: "pending" },
      })
    );

  const listTasks = () => adapter.getTasks({ agentIds: [testAgentId] });

  beforeAll(async () => {
    const setup = await createIsolatedTestDatabase("task-scheduled-at-write-guards");
    adapter = setup.adapter;
    runtime = setup.runtime;
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
      { id: testEntityId, agentId: testAgentId, names: ["Test Entity"] } as Entity,
    ]);
    await adapter.addParticipant(testEntityId, testRoomId);
  });

  afterAll(async () => {
    if (cleanup) await cleanup();
  });

  beforeEach(async () => {
    await (adapter.getDatabase() as DrizzleDatabase).delete(taskTable);
  });

  it("canonicalises a parseable scheduledAt written through patchTaskMetadata", async () => {
    const repeatId = await createHealthyRepeatTask();
    const queueId = await createQueueTask();

    expect(
      await adapter.patchTaskMetadata(queueId, { set: { scheduledAt: NON_CANONICAL_ISO } })
    ).toBe(true);

    const [storedRow] = await (adapter.getDatabase() as DrizzleDatabase)
      .select({ metadata: taskTable.metadata })
      .from(taskTable)
      .where(eq(taskTable.id, queueId));
    expect(storedRow?.metadata).toMatchObject({ status: "pending", scheduledAt: CANONICAL_ISO });

    const tasks = await listTasks();
    expect(tasks).toHaveLength(2);
    expect(tasks.find((task) => task.id === repeatId)?.dueAt).toBe(REPEAT_DUE_AT);
    expect(tasks.find((task) => task.id === queueId)?.dueAt).toBe(CANONICAL_MS);
  });

  it("canonicalises a parseable scheduledAt written through updatePendingTask", async () => {
    const repeatId = await createHealthyRepeatTask();
    const queueId = await createQueueTask();

    expect(
      await adapter.updatePendingTask(queueId, {
        metadata: { status: "pending", scheduledAt: NON_CANONICAL_ISO },
      })
    ).toBe(true);

    const [storedRow] = await (adapter.getDatabase() as DrizzleDatabase)
      .select({ metadata: taskTable.metadata })
      .from(taskTable)
      .where(eq(taskTable.id, queueId));
    expect(storedRow?.metadata).toMatchObject({ status: "pending", scheduledAt: CANONICAL_ISO });

    const tasks = await listTasks();
    expect(tasks).toHaveLength(2);
    expect(tasks.find((task) => task.id === repeatId)?.dueAt).toBe(REPEAT_DUE_AT);
    expect(tasks.find((task) => task.id === queueId)?.dueAt).toBe(CANONICAL_MS);
  });

  it("rejects an unparseable scheduledAt on both patch paths and names the canonical form", async () => {
    const queueId = await createQueueTask();

    await expect(
      adapter.patchTaskMetadata(queueId, { set: { scheduledAt: "March 17, 2030" } })
    ).rejects.toThrow(/YYYY-MM-DDTHH:MM:SS\.mmmZ/u);
    await expect(
      adapter.updatePendingTask(queueId, { metadata: { scheduledAt: "not-a-date" } })
    ).rejects.toThrow(/YYYY-MM-DDTHH:MM:SS\.mmmZ/u);

    const [task] = await listTasks();
    expect(task?.metadata).toEqual({ status: "pending" });
    expect(task?.dueAt).toBeUndefined();
  });

  it.each(["not-a-date", "2026-02-30T00:00:00Z"])(
    "keeps an invalid schedule %s visible without dispatching it, then permits repair",
    async (scheduledAt) => {
      const healthyId = await adapter.createTask(
        baseTask({
          name: "healthy-once",
          tags: ["queue"],
          metadata: { scheduledAt: "2026-09-21T10:00:00+01:00" },
        })
      );
      const queueId = await createQueueTask();
      await (adapter.getDatabase() as DrizzleDatabase)
        .update(taskTable)
        .set({ metadata: { status: "pending", scheduledAt } })
        .where(eq(taskTable.id, queueId));

      const executions: UUID[] = [];
      for (const name of ["healthy-once", "queued-once"]) {
        runtime.registerTaskWorker({
          name,
          execute: async (_runtime, _options, task) => {
            if (!task.id) throw new Error("Persisted task has no id");
            executions.push(task.id);
            return { preserveTask: true };
          },
        });
      }
      const scheduler = new TaskService(runtime, {
        now: () => CANONICAL_MS + 1000,
        setInterval: () => {
          throw new Error("Only manual ticks are expected");
        },
        clearInterval: () => undefined,
      });
      try {
        const tasks = await runtime.getTasks({ tags: ["queue"] });
        expect(tasks).toHaveLength(2);
        const damaged = tasks.find((task) => task.id === queueId);
        expect(damaged?.dueAt).toBeUndefined();
        expect(damaged?.scheduleError).toBeTruthy();
        expect(damaged?.metadata).toEqual({ status: "pending", scheduledAt });
        expect((await adapter.getTasksByName("queued-once"))[0]?.scheduleError).toBe(
          damaged?.scheduleError
        );
        await expect(adapter.getTask(queueId)).rejects.toThrow();
        await expect(scheduler.runDueTasks()).rejects.toMatchObject({
          code: "TASK_TICK_FAILED",
          context: { failureCodes: ["TASK_SCHEDULE_INVALID"] },
        });
        expect(executions).toEqual([healthyId]);

        await adapter.patchTaskMetadata(queueId, { set: { scheduledAt: NON_CANONICAL_ISO } });
        expect(
          (await runtime.getTasks({ tags: ["queue"] })).find((task) => task.id === queueId)
            ?.scheduleError
        ).toBeUndefined();
        executions.length = 0;
        await scheduler.runDueTasks();
        expect(executions.sort()).toEqual([healthyId, queueId].sort());
      } finally {
        await scheduler.stop();
        runtime.unregisterTaskWorker("healthy-once");
        runtime.unregisterTaskWorker("queued-once");
      }
    }
  );
});
