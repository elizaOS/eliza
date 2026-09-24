/** Exercises host retention through the real core scheduler and file-backed SQLite, including restart, concurrent sweeps, opt-out and corrupt-storage failure recovery. No model or storage mocks are used. */
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  AgentRuntime,
  ChannelType,
  TaskService,
  type UUID,
} from "@elizaos/core";
import { SQLiteDatabaseAdapter } from "@elizaos/testing";
import { afterEach, expect, it } from "vitest";
import { LogsRetentionService } from "../src/runtime/logs-retention-service.ts";
import { MemoryRetentionService } from "../src/runtime/memory-retention-service.ts";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), "host-retention-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, "agent.sqlite");
  const runtime = new AgentRuntime({
    agentId: randomUUID() as UUID,
    character: { name: "Retention acceptance", bio: [], settings: {} },
    logLevel: "fatal",
  });
  const adapter = SQLiteDatabaseAdapter.create(file, runtime.agentId);
  runtime.registerDatabaseAdapter(adapter);
  await runtime.init();
  cleanups.push(() => runtime.close());
  const scheduler = new TaskService(runtime);
  cleanups.push(() => scheduler.stop());
  const roomId = randomUUID() as UUID;
  const entityId = randomUUID() as UUID;
  await runtime.createRooms([
    {
      id: roomId,
      agentId: runtime.agentId,
      type: ChannelType.DM,
      source: "test",
    },
  ]);
  const older = randomUUID() as UUID;
  const newer = randomUUID() as UUID;
  await runtime.createMemories([
    {
      tableName: "messages",
      memory: {
        id: older,
        roomId,
        entityId,
        agentId: runtime.agentId,
        createdAt: 1,
        content: { text: "old message" },
      },
    },
    {
      tableName: "messages",
      memory: {
        id: newer,
        roomId,
        entityId,
        agentId: runtime.agentId,
        createdAt: 2,
        content: { text: "complete retained message with final reference" },
      },
    },
  ]);
  await runtime.log({
    entityId,
    roomId,
    type: "retention-acceptance",
    body: { message: "first log" },
  });
  await runtime.log({
    entityId,
    roomId,
    type: "retention-acceptance",
    body: { message: "second log" },
  });
  return { runtime, adapter, scheduler, file, older, newer };
}

async function makeDue(runtime: AgentRuntime) {
  for (const task of await runtime.getTasks({ tags: ["queue"] })) {
    if (!task.id) throw new Error("Stored task requires an ID");
    await runtime.updateTask(task.id, {
      metadata: { ...task.metadata, updatedAt: 0 },
    });
  }
}

it("keeps retention off until configured, then uses the core clock and survives service restart", async () => {
  const h = await fixture();
  const off = await MemoryRetentionService.start(h.runtime);
  await h.scheduler.runDueTasks();
  expect(await h.runtime.getMemoryById(h.older)).not.toBeNull();
  expect(await h.runtime.getTasks({ tags: ["queue"] })).toEqual([]);
  await off.stop();

  h.runtime.setSetting("ELIZA_MEMORY_RETENTION_MAX_ROWS_PER_ROOM", "1");
  h.runtime.setSetting("ELIZA_LOGS_RETENTION_MAX_ROWS_PER_ROOM", "1");
  const starts = await Promise.allSettled([
    MemoryRetentionService.start(h.runtime),
    MemoryRetentionService.start(h.runtime),
  ]);
  const [started, duplicate] = starts;
  if (started.status !== "fulfilled") throw started.reason;
  const memory = started.value;
  cleanups.push(() => memory.stop());
  expect(duplicate).toMatchObject({
    status: "rejected",
    reason: { code: "RETENTION_WORKER_ALREADY_REGISTERED" },
  });
  const logs = await LogsRetentionService.start(h.runtime);
  cleanups.push(() => logs.stop());
  await h.scheduler.runDueTasks();
  expect(await h.runtime.getMemoryById(h.older)).not.toBeNull();
  expect(await h.adapter.getLogs({})).toHaveLength(2);

  await makeDue(h.runtime);
  await h.scheduler.runDueTasks();
  expect(await h.runtime.getMemoryById(h.older)).toBeNull();
  expect((await h.runtime.getMemoryById(h.newer))?.content.text).toBe(
    "complete retained message with final reference",
  );
  expect(await h.adapter.getLogs({})).toHaveLength(1);
  expect(
    (await h.runtime.getTasks({ tags: ["queue"] })).every(
      (task) => task.metadata?.failureCount === 0,
    ),
  ).toBe(true);
  await memory.stop();
  await logs.stop();
  expect(await h.runtime.getTasks({ tags: ["queue"] })).toEqual([]);

  const restarted = await MemoryRetentionService.start(h.runtime);
  cleanups.push(() => restarted.stop());
  await makeDue(h.runtime);
  await h.scheduler.runDueTasks();
  expect(await h.runtime.getMemoryById(h.newer)).not.toBeNull();
  await restarted.stop();
  await expect(restarted.sweep()).rejects.toMatchObject({
    code: "RETENTION_SERVICE_STOPPED",
  });
});

it("joins concurrent direct sweeps and drains their durable deletion before stop resolves", async () => {
  const h = await fixture();
  h.runtime.setSetting("ELIZA_MEMORY_RETENTION_MAX_ROWS_PER_ROOM", "1");
  const memory = await MemoryRetentionService.start(h.runtime);
  cleanups.push(() => memory.stop());
  const first = memory.sweep();
  const second = memory.sweep();
  await memory.stop();
  const [a, b] = await Promise.all([first, second]);
  expect(a.find((result) => result.partition === "messages")?.deleted).toBe(1);
  expect(b).toEqual(a);
  expect(await h.runtime.getMemoryById(h.older)).toBeNull();
  expect(await h.runtime.getMemoryById(h.newer)).not.toBeNull();
  expect(await h.runtime.getTasks({ tags: ["queue"] })).toEqual([]);
});

it("surfaces corrupt storage to direct callers and scheduler retry bookkeeping", async () => {
  const h = await fixture();
  h.runtime.setSetting("ELIZA_LOGS_RETENTION_MAX_ROWS_PER_ROOM", "1");
  const logs = await LogsRetentionService.start(h.runtime);
  cleanups.push(() => logs.stop());
  async function mutateDatabase(sql: string, bytes?: Uint8Array) {
    await h.adapter.close();
    const db = new DatabaseSync(h.file);
    try {
      if (bytes) db.prepare(sql).run(bytes);
      else db.prepare(sql).run();
    } finally {
      db.close();
    }
    await h.adapter.initialize();
  }
  await mutateDatabase(
    "INSERT INTO records(collection,id,data) VALUES('logs','corrupt',?)",
    new Uint8Array([0xff]),
  );
  await expect(logs.sweep()).rejects.toMatchObject({
    code: "LOGS_RETENTION_FAILED",
  });
  await makeDue(h.runtime);
  await expect(h.scheduler.runDueTasks()).rejects.toBeDefined();
  const [failed] = await h.runtime.getTasks({ tags: ["queue"] });
  expect(failed.metadata?.failureCount).toBe(1);
  expect(failed.metadata?.lastError).toContain(
    "Unable to complete logs retention",
  );
  await mutateDatabase(
    "DELETE FROM records WHERE collection='logs' AND id='corrupt'",
  );
  await makeDue(h.runtime);
  await h.scheduler.runDueTasks();
  expect(await h.adapter.getLogs({})).toHaveLength(1);
  const [recovered] = await h.runtime.getTasks({ tags: ["queue"] });
  expect(recovered.metadata?.failureCount).toBe(0);
  expect(recovered.metadata?.lastError).toBeUndefined();
  expect(await h.runtime.getMemoryById(h.older)).not.toBeNull();
});

it("rejects a sub-millisecond interval before scheduling or deleting any data", async () => {
  const h = await fixture();
  h.runtime.setSetting("ELIZA_MEMORY_RETENTION_MAX_ROWS_PER_ROOM", "1");
  h.runtime.setSetting(
    "ELIZA_MEMORY_RETENTION_INTERVAL_MINUTES",
    "0.000000000001",
  );
  await expect(MemoryRetentionService.start(h.runtime)).rejects.toMatchObject({
    code: "RETENTION_INTERVAL_INVALID",
  });
  await h.scheduler.runDueTasks();
  expect(await h.runtime.getTasks({ tags: ["queue"] })).toEqual([]);
  expect(await h.runtime.getMemoryById(h.older)).not.toBeNull();
});
