/** Import embedding pages must advance across a UUID case boundary. */
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AgentRuntime,
  ChannelType,
  createMessageMemory,
  type UUID,
} from "@elizaos/core";
import { SQLiteDatabaseAdapter } from "@elizaos/testing/runtime";
import { expect, it, vi } from "vitest";
import {
  registerImportedConversationEmbeddingWorker,
  scheduleImportedConversationEmbeddings,
} from "../src/api/conversation-import-embeddings.ts";

const sharedAt = 1_700_000_000_000;
const lowerId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" as UUID;
const upperId = "BBBBBBBB-BBBB-4BBB-8BBB-BBBBBBBBBBBB" as UUID;

function rowId(index: number): UUID {
  if (index === 99) return lowerId;
  if (index === 199) return upperId;
  if (index < 99) {
    return `00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}` as UUID;
  }
  const offset = index - 100;
  return `b0000000-0000-4000-8000-${offset.toString(16).padStart(12, "0")}` as UUID;
}

it("advances the import embedding scan when the next id sorts higher only as a UUID", async () => {
  const directory = await mkdtemp(join(tmpdir(), "eliza-import-embed-"));
  for (const [key, value] of Object.entries({
    ELIZA_STATE_DIR: directory,
    ELIZA_CONFIG_PATH: join(directory, "config.json"),
    ELIZA_PERSIST_CONFIG_PATH: join(directory, "config.json"),
  }))
    vi.stubEnv(key, value);

  const agentId = randomUUID() as UUID;
  const worldId = randomUUID() as UUID;
  const roomId = randomUUID() as UUID;
  let runtime: AgentRuntime | undefined;
  try {
    runtime = new AgentRuntime({
      agentId,
      character: { name: "Import embeddings", bio: [], settings: {} },
      logLevel: "fatal",
      enableAutonomy: false,
    });
    const adapter = SQLiteDatabaseAdapter.create(
      join(directory, "state.sqlite"),
      agentId,
    );
    runtime.registerDatabaseAdapter(adapter);
    await runtime.init();
    await adapter.ensureEmbeddingDimension(3);
    await runtime.ensureWorldExists({
      id: worldId,
      agentId,
      name: "Import world",
    });
    await runtime.ensureRoomExists({
      id: roomId,
      agentId,
      worldId,
      name: "Import room",
      source: "client_chat",
      type: ChannelType.DM,
    });

    for (let index = 0; index < 200; index++) {
      await runtime.createMemory(
        {
          ...createMessageMemory({
            id: rowId(index),
            entityId: agentId,
            agentId,
            roomId,
            content: {
              text: `imported-${index}`,
              source: "handoff_import",
            },
            embedding: [1, 0, 0],
          }),
          createdAt: sharedAt,
        },
        "messages",
      );
    }

    registerImportedConversationEmbeddingWorker(runtime);
    await scheduleImportedConversationEmbeddings(runtime, roomId);
    const [task] = await runtime.getTasksByName(
      "CONVERSATION_IMPORT_EMBEDDINGS",
    );
    if (!task?.id) throw new Error("import embedding task was not created");
    const worker = runtime.getTaskWorker("CONVERSATION_IMPORT_EMBEDDINGS");
    if (!worker) throw new Error("import embedding worker was not registered");

    await worker.execute(runtime, {}, task);
    const afterFirst = await runtime.getTask(task.id);
    expect(afterFirst?.metadata?.cursor).toMatchObject({
      createdAt: sharedAt,
      id: lowerId,
    });
    await worker.execute(runtime, {}, afterFirst ?? task);
    const afterSecond = await runtime.getTask(task.id);
    expect(afterSecond?.metadata?.cursor).toMatchObject({
      createdAt: sharedAt,
      id: upperId,
    });
  } finally {
    if (runtime) await runtime.close();
    vi.unstubAllEnvs();
    await rm(directory, { recursive: true, force: true });
  }
}, 120_000);
