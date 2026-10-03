/** A full memory wipe must remove document chunks, not only document headers. */
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentRuntime, type UUID } from "@elizaos/core";
import { SQLiteDatabaseAdapter } from "@elizaos/testing";
import { expect, it, vi } from "vitest";

it("clears document fragments along with the rest of the agent memory", async () => {
  const directory = await mkdtemp(join(tmpdir(), "eliza-clear-fragments-"));
  for (const [key, value] of Object.entries({
    ELIZA_STATE_DIR: directory,
    ELIZA_CONFIG_PATH: join(directory, "config.json"),
    ELIZA_PERSIST_CONFIG_PATH: join(directory, "config.json"),
  }))
    vi.stubEnv(key, value);

  const agentId = randomUUID() as UUID;
  const roomId = randomUUID() as UUID;
  const fragmentId = randomUUID() as UUID;
  let runtime: AgentRuntime | undefined;
  try {
    runtime = new AgentRuntime({
      agentId,
      character: { name: "Fragment wipe", bio: [], settings: {} },
      logLevel: "fatal",
      enableAutonomy: false,
    });
    runtime.registerDatabaseAdapter(
      SQLiteDatabaseAdapter.create(join(directory, "state.sqlite"), agentId),
    );
    await runtime.init();
    await runtime.createMemory(
      {
        id: fragmentId,
        entityId: agentId,
        agentId,
        roomId,
        content: { text: "chunk that a wipe must remove" },
        metadata: { type: "fragment", documentId: randomUUID() },
      },
      "document_fragments",
    );
    expect(
      (
        await runtime.getMemories({
          agentId,
          tableName: "document_fragments",
        })
      ).map((memory) => memory.id),
    ).toEqual([fragmentId]);

    await runtime.clearAllAgentMemories();

    const remaining = await runtime.getMemories({
      agentId,
      tableName: "document_fragments",
    });
    expect(remaining.map((memory) => memory.id)).toEqual([]);
  } finally {
    if (runtime) await runtime.close();
    vi.unstubAllEnvs();
    await rm(directory, { recursive: true, force: true });
  }
}, 120_000);
