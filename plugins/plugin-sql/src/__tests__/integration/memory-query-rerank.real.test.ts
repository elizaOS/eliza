/** Exercises SQL-owned query ranking and pagination through the runtime against an isolated real database. */
import { randomUUID } from "node:crypto";
import { ChannelType, type Memory, type UUID } from "@elizaos/core";
import { expect, it } from "vitest";
import { createIsolatedTestDatabase } from "../test-helpers";

it("SQL owns query reranking while runtime preserves its scoped result page", async () => {
  const {
    adapter,
    runtime,
    cleanup,
    testAgentId: agentId,
  } = await createIsolatedTestDatabase("query_rerank");
  const roomId = randomUUID() as UUID;
  const entityId = randomUUID() as UUID;
  const vector = (tilt: number) =>
    Array.from({ length: 384 }, (_, i) => (i === 0 ? 1 : i === 1 ? tilt : 0));
  try {
    await adapter.createEntities([{ id: entityId, agentId, names: ["Retrieval"] }]);
    await adapter.createRooms([
      { id: roomId, agentId, name: "Retrieval", source: "test", type: ChannelType.GROUP },
    ]);
    const rows: Memory[] = [
      "I bought a car",
      "automobile purchase receipt",
      "",
      "automobile purchase",
    ].map((text, index) => ({
      id: randomUUID() as UUID,
      agentId,
      entityId,
      roomId,
      content: { text },
      embedding: vector((index + 1) / 10),
    }));
    await adapter.createMemories(rows.map((memory) => ({ memory, tableName: "messages" })));
    const params = { tableName: "messages", roomId, embedding: vector(0), limit: 3 };
    const ids = (memories: Memory[]) => memories.map((memory) => memory.id);
    expect(ids(await runtime.searchMemories(params))).toEqual(
      rows.slice(0, 3).map((row) => row.id)
    );
    const expected = [rows[1].id, rows[0].id, rows[2].id];
    expect(ids(await adapter.searchMemories({ ...params, query: "automobile purchase" }))).toEqual(
      expected
    );
    expect(ids(await runtime.searchMemories({ ...params, query: "automobile purchase" }))).toEqual(
      expected
    );
    expect(
      ids(
        await runtime.searchMemories({
          ...params,
          query: "automobile purchase",
          offset: 1,
          limit: 2,
        })
      )
    ).toEqual([rows[1].id, rows[2].id]);
  } finally {
    await cleanup();
  }
});
