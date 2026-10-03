/** Truncating a thread must walk same-millisecond rows in UUID order. */
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentRuntime, createMessageMemory, type UUID } from "@elizaos/core";
import { SQLiteDatabaseAdapter } from "@elizaos/testing";
import { expect, it, vi } from "vitest";
import type { ConversationMeta } from "../src/api/server-types.ts";
import { truncateConversationMessages } from "../src/services/conversation-message-service.ts";

const lowerId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" as UUID;
const upperId = "BBBBBBBB-BBBB-4BBB-8BBB-BBBBBBBBBBBB" as UUID;

it("truncates the later UUID when two messages share a millisecond", async () => {
  const directory = await mkdtemp(join(tmpdir(), "eliza-truncate-order-"));
  for (const [key, value] of Object.entries({
    ELIZA_STATE_DIR: directory,
    ELIZA_CONFIG_PATH: join(directory, "config.json"),
    ELIZA_PERSIST_CONFIG_PATH: join(directory, "config.json"),
  }))
    vi.stubEnv(key, value);

  const agentId = randomUUID() as UUID;
  const roomId = randomUUID() as UUID;
  let runtime: AgentRuntime | undefined;
  try {
    runtime = new AgentRuntime({
      agentId,
      character: { name: "Truncate order", bio: [], settings: {} },
      logLevel: "fatal",
      enableAutonomy: false,
    });
    runtime.registerDatabaseAdapter(
      SQLiteDatabaseAdapter.create(join(directory, "state.sqlite"), agentId),
    );
    await runtime.init();
    for (const id of [upperId, lowerId]) {
      await runtime.createMemory(
        {
          ...createMessageMemory({
            id,
            entityId: agentId,
            agentId,
            roomId,
            content: { text: `turn ${id}`, source: "client_chat" },
          }),
          createdAt: 1_700_000_000_000,
        },
        "messages",
      );
    }
    const conversation: ConversationMeta = {
      id: randomUUID(),
      title: "Tied",
      roomId,
      createdAt: "2023-11-14T22:13:20.000Z",
      updatedAt: "2023-11-14T22:13:20.000Z",
    };
    const result = await truncateConversationMessages(
      runtime,
      conversation,
      lowerId,
    );
    expect(result.deletedCount).toBe(1);
    const remaining = await runtime.getMemories({
      roomId,
      tableName: "messages",
    });
    expect(remaining.map((memory) => memory.id)).toEqual([lowerId]);
  } finally {
    if (runtime) await runtime.close();
    vi.unstubAllEnvs();
    await rm(directory, { recursive: true, force: true });
  }
}, 120_000);
