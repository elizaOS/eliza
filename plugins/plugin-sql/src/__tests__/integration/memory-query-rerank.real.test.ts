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
  const outsideRoomId = randomUUID() as UUID;
  const vector = (tilt: number) =>
    Array.from({ length: 384 }, (_, i) => (i === 0 ? 1 : i === 1 ? tilt : 0));
  try {
    await adapter.createEntities([{ id: entityId, agentId, names: ["Retrieval"] }]);
    await adapter.createRooms([
      { id: roomId, agentId, name: "Retrieval", source: "test", type: ChannelType.GROUP },
      { id: outsideRoomId, agentId, name: "Excluded", source: "test", type: ChannelType.GROUP },
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
    await adapter.createMemories([
      {
        memory: {
          id: randomUUID() as UUID,
          agentId,
          entityId,
          roomId: outsideRoomId,
          content: { text: "automobile purchase" },
          embedding: vector(0),
        },
        tableName: "messages",
      },
    ]);
    await adapter.createMemories([
      {
        memory: {
          id: randomUUID() as UUID,
          agentId,
          entityId,
          roomId,
          content: { text: "automobile purchase without an indexed vector" },
        },
        tableName: "messages",
      },
    ]);
    const params = { tableName: "messages", roomId, embedding: vector(0), limit: 3 };
    const ids = (memories: Memory[]) => memories.map((memory) => memory.id);
    expect(ids(await runtime.searchMemories(params))).toEqual(
      rows.slice(0, 3).map((row) => row.id)
    );
    const expected = [rows[1].id, rows[0].id, rows[2].id];
    const excludedParams = {
      ...params,
      roomId: undefined,
      excludeRoomIds: [outsideRoomId],
      query: "automobile purchase",
    };
    const full = await runtime.searchMemories(excludedParams);
    const projected = await runtime.searchMemories({ ...excludedParams, includeEmbedding: false });
    expect(ids(full)).toEqual(expected);
    expect(ids(projected)).toEqual(expected);
    expect(projected.map(({ embedding, ...memory }) => memory)).toEqual(
      full.map(({ embedding, ...memory }) => memory)
    );
    expect(full.every((memory) => Array.isArray(memory.embedding))).toBe(true);
    expect(projected.every((memory) => memory.embedding === undefined)).toBe(true);
    expect(
      (await runtime.searchMemories(excludedParams)).map((memory) => memory.embedding)
    ).toEqual(full.map((memory) => memory.embedding));
    expect(await runtime.searchMemories({ ...params, excludeRoomIds: [roomId] })).toEqual([]);

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
