/**
 * Contract for the in-memory adapter's fuzzy embedding cache: it must key off
 * the same nested `content` subfield the SQL adapter matches on
 * (`content->>query_field_sub_name`), or a runtime swapping storage backends
 * silently loses every cache hit. Real adapter over real MemoryStorage.
 */
import { randomUUID } from "node:crypto";
import type { Memory, UUID } from "@elizaos/core";
import { beforeEach, describe, expect, it } from "vitest";
import { InMemoryDatabaseAdapter } from "./adapter";
import { MemoryStorage } from "./storage-memory";

describe("InMemoryDatabaseAdapter.getCachedEmbeddings", () => {
  const agentId = randomUUID() as UUID;
  const entityId = randomUUID() as UUID;
  const roomId = randomUUID() as UUID;
  let adapter: InMemoryDatabaseAdapter;

  beforeEach(async () => {
    adapter = new InMemoryDatabaseAdapter(new MemoryStorage(), agentId);
    await adapter.initialize();
  });

  it("matches the nested content subfield used by the SQL adapter", async () => {
    const embedding = Array.from({ length: 384 }, (_, index) => (index === 0 ? 1 : 0));
    const memory: Memory = {
      id: randomUUID() as UUID,
      agentId,
      entityId,
      roomId,
      content: { text: "cached phrase" },
      embedding,
    };
    await adapter.createMemories([{ memory, tableName: "memories" }]);

    await expect(
      adapter.getCachedEmbeddings({
        query_table_name: "memories",
        query_threshold: 0,
        query_input: "cached phrase",
        query_field_name: "body",
        query_field_sub_name: "text",
        query_match_count: 10,
      })
    ).resolves.toEqual([{ embedding, levenshtein_score: 0 }]);
  });

  it("excludes memories without a string content subfield", async () => {
    const embedding = Array.from({ length: 384 }, (_, index) => (index === 1 ? 1 : 0));
    const missing: Memory = {
      id: randomUUID() as UUID,
      agentId,
      entityId,
      roomId,
      content: {},
      embedding,
    };
    const nonString: Memory = {
      id: randomUUID() as UUID,
      agentId,
      entityId,
      roomId,
      content: { text: "placeholder" },
      embedding,
    };
    (nonString.content as { text?: unknown }).text = 42;
    await adapter.createMemories(
      [missing, nonString].map((memory) => ({ memory, tableName: "memories" }))
    );

    await expect(
      adapter.getCachedEmbeddings({
        query_table_name: "memories",
        query_threshold: 0,
        query_input: "",
        query_field_name: "body",
        query_field_sub_name: "text",
        query_match_count: 10,
      })
    ).resolves.toEqual([]);
  });
});
