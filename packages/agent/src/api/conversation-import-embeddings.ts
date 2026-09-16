import {
  createUniqueUuid,
  type IAgentRuntime,
  ModelType,
  type UUID,
} from "@elizaos/core";

const TASK_NAME = "CONVERSATION_IMPORT_EMBEDDINGS";
const PAGE_SIZE = 100;
const INTERVAL_MS = 1000;

/** Called under the import's room lease, before persisting any source rows. */
export async function scheduleImportedConversationEmbeddings(
  runtime: IAgentRuntime,
  roomId: UUID,
): Promise<void> {
  const id = createUniqueUuid(runtime, `import-embedding-repair:${roomId}`);
  const existing = await runtime.getTask(id);
  if (existing) {
    if (
      existing.agentId !== runtime.agentId ||
      existing.roomId !== roomId ||
      existing.name !== TASK_NAME
    ) {
      throw new Error("Import embedding task identity mismatch");
    }
    // A new import can add old timestamps before the previous scan cursor.
    await runtime.updateTask(id, {
      metadata: {
        ...existing.metadata,
        cursor: null,
        remaining: null,
        updateInterval: INTERVAL_MS,
        updatedAt: Date.now(),
      },
    });
    return;
  }
  await runtime.createTask({
    id,
    name: TASK_NAME,
    agentId: runtime.agentId,
    roomId,
    description: "Resume missing embeddings for imported conversation sources",
    tags: ["queue", "repeat"],
    metadata: { updateInterval: INTERVAL_MS, updatedAt: Date.now() },
  });
}

/** Durable bookkeeping only: the existing embedding queue still owns inference. */
export function registerImportedConversationEmbeddingWorker(
  runtime: IAgentRuntime,
): void {
  runtime.registerTaskWorker({
    name: TASK_NAME,
    shouldRun: async (rt, task) =>
      task.agentId === rt.agentId &&
      typeof task.roomId === "string" &&
      rt.roomHandlerQueue.pendingFor(task.roomId) === 0 &&
      Boolean(
        rt.getModel(ModelType.TEXT_EMBEDDING) ||
          rt.getModel(ModelType.TEXT_EMBEDDING_BATCH),
      ),
    execute: async (rt, _options, task) => {
      if (!task.id || task.agentId !== rt.agentId || !task.roomId) {
        throw new Error("Invalid import embedding task identity");
      }
      const lease = await rt.roomHandlerQueue.acquire(task.roomId);
      try {
        // Re-read after admission: an import may have reset this cursor while
        // this worker was waiting. A deleted task must never be resurrected.
        const current = await rt.getTask(task.id);
        if (!current) return { preserveTask: true };
        if (
          current.agentId !== rt.agentId ||
          current.roomId !== task.roomId ||
          current.name !== TASK_NAME
        ) {
          throw new Error("Import embedding task changed identity");
        }
        const raw = current.metadata?.cursor;
        let cursor: { createdAt: number; id: UUID } | undefined;
        if (raw != null) {
          if (
            typeof raw !== "object" ||
            !("createdAt" in raw) ||
            !("id" in raw) ||
            typeof raw.createdAt !== "number" ||
            !Number.isFinite(raw.createdAt) ||
            typeof raw.id !== "string"
          ) {
            throw new Error("Invalid import embedding scan cursor");
          }
          cursor = { createdAt: raw.createdAt, id: raw.id as UUID };
        }
        const rows = await rt.getMemories({
          tableName: "messages",
          agentId: rt.agentId,
          roomId: task.roomId,
          count: PAGE_SIZE,
          orderDirection: "asc",
          unique: false,
          includeEmbedding: true,
          cursor,
        });
        let missing = 0;
        for (const memory of rows) {
          if (memory.agentId !== rt.agentId || memory.roomId !== task.roomId) {
            throw new Error("Import embedding scan crossed its source scope");
          }
          if (
            memory.content.source !== "handoff_import" ||
            !memory.content.text?.trim() ||
            memory.embedding?.length
          )
            continue;
          missing += 1;
          await rt.queueEmbeddingGeneration(memory, "low");
        }
        if (!missing && rows.length < PAGE_SIZE) {
          await rt.deleteTask(task.id);
        } else {
          const last = rows.at(-1);
          let next = cursor;
          if (!missing && last) {
            if (
              !last.id ||
              typeof last.createdAt !== "number" ||
              !Number.isFinite(last.createdAt) ||
              (cursor &&
                (last.createdAt < cursor.createdAt ||
                  (last.createdAt === cursor.createdAt &&
                    last.id <= cursor.id)))
            ) {
              throw new Error("Import embedding scan did not advance");
            }
            next = { createdAt: last.createdAt, id: last.id };
          }
          await rt.updateTask(task.id, {
            metadata: {
              ...current.metadata,
              cursor: next ?? null,
              remaining: missing,
              // A slow/unavailable provider must not trigger a tight retry
              // loop. Reset as soon as this page makes durable progress.
              updateInterval:
                missing > 0 && current.metadata?.remaining === missing
                  ? Math.min(
                      60_000,
                      Math.max(
                        INTERVAL_MS,
                        Number(current.metadata?.updateInterval) || INTERVAL_MS,
                      ) * 2,
                    )
                  : INTERVAL_MS,
              updatedAt: Date.now(),
            },
          });
        }
        // All bookkeeping occurred under the room lease. Prevent the scheduler
        // from overwriting a later import's cursor or deleting its new task.
        return { preserveTask: true };
      } finally {
        await lease.release();
      }
    },
  });
}
