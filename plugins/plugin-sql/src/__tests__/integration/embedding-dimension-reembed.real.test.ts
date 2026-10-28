/**
 * Boots a real AgentRuntime on the SQL store after the embedding model changed
 * width (384 to 1536). Boot reclaims the old-width vectors and re-embeds those
 * memories in the background; every reclaimed memory must get a vector at the
 * new width, including the first ones queued before the embedding service has
 * started.
 */
import {
  ChannelType,
  EmbeddingGenerationService,
  type Entity,
  type Memory,
  MemoryType,
  ModelType,
  type Plugin,
  type Room,
  TaskService,
  type UUID,
} from "@elizaos/core";
import { v4 as uuidv4 } from "uuid";
import { expect, it } from "vitest";
import { createTestDatabase } from "../test-helpers";

const MEMORY_COUNT = 60;

it("re-embeds every memory whose vector was reclaimed at boot", async () => {
  const agentId = uuidv4() as UUID;
  const embeddingPlugin: Plugin = {
    name: "test-embedding-1536",
    description: "Deterministic 1536-dimension TEXT_EMBEDDING model",
    services: [TaskService, EmbeddingGenerationService],
    models: {
      [ModelType.TEXT_EMBEDDING]: async () =>
        Array.from({ length: 1536 }, (_, i) => ((i % 7) + 1) / 10),
    },
  };
  const { adapter, runtime, cleanup } = await createTestDatabase(agentId, [embeddingPlugin]);
  try {
    // Memories embedded by the previous 384-dimension model.
    await adapter.ensureEmbeddingDimension(384);
    const entityId = uuidv4() as UUID;
    const roomId = uuidv4() as UUID;
    await adapter.createEntities([{ id: entityId, agentId, names: ["User"] } as Entity]);
    await adapter.createRooms([
      { id: roomId, agentId, name: "Room", source: "test", type: ChannelType.GROUP } as Room,
    ]);
    const ids: UUID[] = [];
    for (let i = 0; i < MEMORY_COUNT; i++) {
      ids.push(
        await adapter.createMemory(
          {
            id: uuidv4() as UUID,
            agentId,
            entityId,
            roomId,
            content: { text: `remembered fact ${i}` },
            embedding: Array.from({ length: 384 }, () => Math.random()),
            createdAt: Date.now(),
            unique: false,
            metadata: { type: MemoryType.CUSTOM, source: "test" },
          } as Memory,
          "memories"
        )
      );
    }

    await runtime.initialize({ skipMigrations: true });

    const countReembedded = async () =>
      (await adapter.getMemoriesByIds(ids)).filter((m) => m.embedding?.length === 1536).length;
    let reembedded = 0;
    let unchangedPolls = 0;
    while (reembedded < MEMORY_COUNT && unchangedPolls < 5) {
      await new Promise((resolve) => setTimeout(resolve, 2000));
      const next = await countReembedded();
      unchangedPolls = next === reembedded ? unchangedPolls + 1 : 0;
      reembedded = next;
    }

    expect(reembedded).toBe(MEMORY_COUNT);
  } finally {
    await runtime.stop();
    await cleanup();
  }
});
