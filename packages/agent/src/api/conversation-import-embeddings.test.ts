import {
  AgentRuntime,
  createCharacter,
  type Memory,
  ModelType,
  stringToUuid,
} from "@elizaos/core";
import { InMemoryDatabaseAdapter } from "@elizaos/testing/in-memory-adapter";
import { expect, test, vi } from "vitest";
import {
  registerImportedConversationEmbeddingWorker,
  scheduleImportedConversationEmbeddings,
} from "./conversation-import-embeddings.ts";

function fixture() {
  const runtime = new AgentRuntime({
    character: createCharacter({ name: "Import repair" }),
    adapter: new InMemoryDatabaseAdapter(),
    logLevel: "fatal",
    enableAutonomy: false,
  });
  const roomId = stringToUuid("import-repair-room");
  registerImportedConversationEmbeddingWorker(runtime);
  const queue = vi
    .spyOn(runtime, "queueEmbeddingGeneration")
    .mockResolvedValue();
  const source = (n: number, imported = true): Memory => ({
    id: stringToUuid(`import-repair-${n}`),
    agentId: runtime.agentId,
    entityId: runtime.agentId,
    roomId,
    createdAt: n + 1000,
    content: {
      text: `original ${n}`,
      source: imported ? "handoff_import" : "client_chat",
    },
  });
  async function task() {
    const tasks = await runtime.getTasksByName(
      "CONVERSATION_IMPORT_EMBEDDINGS",
    );
    expect(tasks).toHaveLength(1);
    return tasks[0]!;
  }
  const worker = runtime.getTaskWorker("CONVERSATION_IMPORT_EMBEDDINGS")!;
  return { runtime, roomId, queue, source, task, worker };
}

test("pages every imported source, waits for stored vectors, and resets for backdated imports", async () => {
  const f = fixture();
  try {
    for (let n = 0; n < 103; n++) {
      const memory = f.source(n, n !== 102);
      if (n < 100) memory.embedding = [1];
      await f.runtime.createMemory(memory, "messages");
    }
    await scheduleImportedConversationEmbeddings(f.runtime, f.roomId);
    expect(await f.worker.shouldRun!(f.runtime, await f.task())).toBe(false);
    f.runtime.registerModel(
      ModelType.TEXT_EMBEDDING,
      async () => [1],
      "fixture",
    );
    expect(await f.worker.shouldRun!(f.runtime, await f.task())).toBe(true);
    await f.worker.execute(f.runtime, {}, await f.task());
    expect(f.queue).not.toHaveBeenCalled();
    expect((await f.task()).metadata?.cursor).toBeTruthy();
    await f.worker.execute(f.runtime, {}, await f.task());
    expect(f.queue).toHaveBeenCalledTimes(2);
    expect((await f.task()).metadata?.updateInterval).toBe(1000);
    await f.worker.execute(f.runtime, {}, await f.task());
    expect((await f.task()).metadata?.updateInterval).toBe(2000);
    for (const n of [100, 101])
      await f.runtime.updateMemory({ id: f.source(n).id!, embedding: [1] });
    await f.worker.execute(f.runtime, {}, await f.task());
    expect(
      await f.runtime.getTasksByName("CONVERSATION_IMPORT_EMBEDDINGS"),
    ).toHaveLength(0);

    await f.runtime.createMemory(f.source(-1), "messages");
    await scheduleImportedConversationEmbeddings(f.runtime, f.roomId);
    await f.worker.execute(f.runtime, {}, await f.task());
    expect(f.queue).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: f.source(-1).id }),
      "low",
    );
  } finally {
    await f.runtime.close();
  }
});

test("a waiting worker reads the current cursor and never resurrects a deleted task", async () => {
  const f = fixture();
  try {
    await scheduleImportedConversationEmbeddings(f.runtime, f.roomId);
    const old = await f.task();
    await f.runtime.updateTask(old.id!, {
      metadata: {
        ...old.metadata,
        cursor: { createdAt: 999999, id: f.source(0).id },
      },
    });
    const lease = await f.runtime.roomHandlerQueue.acquire(f.roomId);
    const running = f.worker.execute(f.runtime, {}, old);
    await f.runtime.roomHandlerQueue.withLeaseWrite(f.roomId, lease, () =>
      f.runtime.createMemory(f.source(-1), "messages"),
    );
    await scheduleImportedConversationEmbeddings(f.runtime, f.roomId);
    await lease.release();
    await running;
    expect(f.queue).toHaveBeenCalledTimes(1);
    await f.runtime.deleteTask(old.id!);
    expect(await f.worker.execute(f.runtime, {}, old)).toEqual({
      preserveTask: true,
    });
    expect(await f.runtime.getTasksByName(old.name)).toHaveLength(0);
  } finally {
    await f.runtime.close();
  }
});

test("failed reads and foreign rows retain the task without queuing foreign data", async () => {
  const f = fixture();
  try {
    await scheduleImportedConversationEmbeddings(f.runtime, f.roomId);
    vi.spyOn(f.runtime, "getMemories").mockRejectedValueOnce(
      new Error("database unavailable"),
    );
    await expect(
      f.worker.execute(f.runtime, {}, await f.task()),
    ).rejects.toThrow("database unavailable");
    vi.spyOn(f.runtime, "getMemories").mockResolvedValueOnce([
      { ...f.source(0), agentId: stringToUuid("foreign-agent") },
    ]);
    await expect(
      f.worker.execute(f.runtime, {}, await f.task()),
    ).rejects.toThrow("source scope");
    expect(f.queue).not.toHaveBeenCalled();
    expect(await f.task()).toBeTruthy();
    expect(f.runtime.roomHandlerQueue.pendingFor(f.roomId)).toBe(0);
  } finally {
    await f.runtime.close();
  }
});
