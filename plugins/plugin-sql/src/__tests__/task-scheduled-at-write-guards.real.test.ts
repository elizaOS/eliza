/**
 * Regression coverage for task `metadata.scheduledAt` write guards and the
 * per-row tolerance of task list reads, against a real isolated PGlite (or
 * Postgres) adapter with no mocks.
 *
 * The scheduler tick lists every task of an agent in one `getTasks` call, so a
 * single row whose `scheduledAt` escaped canonicalisation through
 * `patchTaskMetadata` or `updatePendingTask` must neither be stored in that
 * form nor poison the whole list.
 */
import { ChannelType, type Entity, logger, type Room, type Task, type UUID } from "@elizaos/core";
import { eq } from "drizzle-orm";
import { v4 as uuidv4 } from "uuid";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { PgDatabaseAdapter } from "../pg/adapter";
import type { PgliteDatabaseAdapter } from "../pglite/adapter";
import { taskTable } from "../schema";
import type { DrizzleDatabase } from "../types";
import { createIsolatedTestDatabase } from "./test-helpers";

const NON_CANONICAL_ISO = "2026-09-21T09:00:00Z";
const CANONICAL_ISO = "2026-09-21T09:00:00.000Z";
const CANONICAL_MS = Date.parse(CANONICAL_ISO);
const REPEAT_DUE_AT = 1_900_000_005_000;

describe("task scheduledAt write guards", () => {
  let adapter: PgliteDatabaseAdapter | PgDatabaseAdapter;
  let cleanup: () => Promise<void>;
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

  it("keeps listing healthy tasks when one persisted row carries unreadable timing", async () => {
    const repeatId = await createHealthyRepeatTask();
    const queueId = await createQueueTask();
    await (adapter.getDatabase() as DrizzleDatabase)
      .update(taskTable)
      .set({ metadata: { status: "pending", scheduledAt: "not-a-date" } })
      .where(eq(taskTable.id, queueId));

    const warn = vi.spyOn(logger, "warn");
    try {
      const tasks = await listTasks();
      expect(tasks).toHaveLength(2);
      expect(tasks.find((task) => task.id === repeatId)?.dueAt).toBe(REPEAT_DUE_AT);
      const damaged = tasks.find((task) => task.id === queueId);
      expect(damaged?.dueAt).toBeUndefined();
      expect(damaged?.metadata).toMatchObject({ scheduledAt: "not-a-date" });
      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({ src: "plugin:sql", taskId: queueId, agentId: testAgentId }),
        expect.stringContaining("scheduledAt")
      );
      expect(await adapter.getTasksByName("healthy-repeat")).toEqual([
        expect.objectContaining({ id: repeatId, dueAt: REPEAT_DUE_AT }),
      ]);
    } finally {
      warn.mockRestore();
    }
  });
});
