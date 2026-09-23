/** Verifies real in-memory adapters preserve scoped vector pages and query ranking through the runtime. */
import { randomUUID } from "node:crypto";
import { AgentRuntime, type Memory, type UUID } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { InMemoryDatabaseAdapter as StoredAdapter } from "./adapter";
import { InMemoryDatabaseAdapter as IsolatedAdapter } from "./runtime";
import { MemoryStorage } from "./storage-memory";

for (const kind of ["stored", "isolated"] as const) {
  describe(`${kind} adapter retrieval through AgentRuntime`, () => {
    it("reranks the scoped vector page and retains semantic-only hits", async () => {
      const agentId = randomUUID() as UUID;
      const roomId = randomUUID() as UUID;
      const entityId = randomUUID() as UUID;
      const adapter =
        kind === "stored"
          ? new StoredAdapter(new MemoryStorage(), agentId)
          : new IsolatedAdapter(agentId);
      await adapter.init();
      const runtime = new AgentRuntime({ agentId, character: { name: "retrieval" } });
      runtime.registerDatabaseAdapter(adapter);
      const vector = (tilt: number) =>
        Array.from({ length: 384 }, (_, i) => (i === 0 ? 1 : i === 1 ? tilt : 0));
      const memory = (text: string | undefined, tilt: number, room = roomId): Memory => ({
        id: randomUUID() as UUID,
        agentId,
        roomId: room,
        entityId,
        content: text === undefined ? {} : { text },
        embedding: vector(tilt),
      });
      const semantic = memory("I bought a car", 0.1);
      const keyword = memory("automobile purchase receipt", 0.2);
      const attachment = memory(undefined, 0.3);
      const outsidePage = memory("automobile purchase", 0.4);
      const outsideRoom = memory("automobile purchase", 0, randomUUID() as UUID);
      const missingVector = memory("automobile purchase without an indexed vector", 0);
      delete missingVector.embedding;
      try {
        await adapter.createMemories(
          [semantic, keyword, attachment, outsidePage, outsideRoom, missingVector].map(
            (memory) => ({
              memory,
              tableName: "messages",
            })
          )
        );
        const params = { tableName: "messages", embedding: vector(0), roomId, limit: 3 };
        const ids = (rows: Memory[]) => rows.map((row) => row.id);
        const projectedParams = {
          ...params,
          roomId: undefined,
          excludeRoomIds: [outsideRoom.roomId],
          query: "automobile purchase",
        };
        const full = await runtime.searchMemories(projectedParams);
        const projected = await runtime.searchMemories({
          ...projectedParams,
          includeEmbedding: false,
        });
        expect(ids(full)).toEqual([keyword.id, semantic.id, attachment.id]);
        expect(projected.map(({ embedding, ...row }) => row)).toEqual(
          full.map(({ embedding, ...row }) => row)
        );
        expect(full.every((row) => Array.isArray(row.embedding))).toBe(true);
        expect(projected.every((row) => row.embedding === undefined)).toBe(true);
        expect((await runtime.searchMemories(projectedParams)).map((row) => row.embedding)).toEqual(
          full.map((row) => row.embedding)
        );
        expect(await runtime.searchMemories({ ...params, excludeRoomIds: [roomId] })).toEqual([]);

        expect(ids(await runtime.searchMemories(params))).toEqual([
          semantic.id,
          keyword.id,
          attachment.id,
        ]);
        expect(
          ids(await runtime.searchMemories({ ...params, query: "automobile purchase" }))
        ).toEqual([keyword.id, semantic.id, attachment.id]);
        expect(
          ids(await adapter.searchMemories({ ...params, query: "automobile purchase" }))
        ).toEqual([keyword.id, semantic.id, attachment.id]);
        expect(
          ids(
            await runtime.searchMemories({
              ...params,
              offset: 1,
              limit: 2,
              query: "automobile purchase",
            })
          )
        ).toEqual([keyword.id, attachment.id]);
      } finally {
        await adapter.close();
      }
    });
  });
}
