/** Proves head publication is atomic under contention, rollback and ownership collisions. */
import type {
  AtomicMemoryPublicationParams,
  Memory,
  UUID,
} from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { SQLiteDatabaseAdapter } from "./adapter";

const agentId = "71000000-0000-4000-8000-000000000001" as UUID;
const roomId = "71000000-0000-4000-8000-000000000002" as UUID;
const entityId = "71000000-0000-4000-8000-000000000003" as UUID;
const headId = "71000000-0000-4000-8000-000000000004" as UUID;
const dependencyId = "71000000-0000-4000-8000-000000000005" as UUID;
const losingId = "71000000-0000-4000-8000-000000000006" as UUID;
function row(id: UUID, text: string): Memory {
  return {
    id,
    agentId,
    roomId,
    entityId,
    content: { text },
    metadata: { revision: text },
  };
}
function publication(
  revision: string,
  dependency = dependencyId,
): AtomicMemoryPublicationParams {
  return {
    head: { memory: row(headId, revision), tableName: "heads" },
    dependencies: [
      { memory: row(dependency, "immutable"), tableName: "segments" },
    ],
    expectedRevision: null,
  };
}
describe("SQLite atomic content publication", () => {
  it("admits one competing writer and leaves no losing dependencies", async () => {
    const adapter = SQLiteDatabaseAdapter.create(":memory:", agentId);
    try {
      const results = await Promise.all([
        adapter.compareAndSwapMemoryPublication(publication("first")),
        adapter.compareAndSwapMemoryPublication(
          publication("second", losingId),
        ),
      ]);
      expect(results.map((result) => result.status).sort()).toEqual([
        "conflict",
        "published",
      ]);
      const head = (await adapter.getMemoriesByIds([headId]))[0];
      const winner = head?.content.text === "first" ? dependencyId : losingId;
      const loser = winner === dependencyId ? losingId : dependencyId;
      expect((await adapter.getMemoriesByIds([winner]))[0]).not.toBeUndefined();
      expect((await adapter.getMemoriesByIds([loser]))[0]).toBeUndefined();
      await expect(
        adapter.compareAndSwapMemoryPublication({
          ...publication("third"),
          expectedRevision: "stale",
        }),
      ).resolves.toEqual({ status: "conflict" });
    } finally {
      await adapter.close();
    }
  });
  it("rolls back the head and all dependencies with the enclosing transaction", async () => {
    const adapter = SQLiteDatabaseAdapter.create(":memory:", agentId);
    try {
      await expect(
        adapter.transaction(async (tx) => {
          if (!tx.compareAndSwapMemoryPublication)
            throw new Error("Missing atomic publication");
          await tx.compareAndSwapMemoryPublication(publication("first"));
          throw new Error("abort publication");
        }),
      ).rejects.toMatchObject({ cause: { message: "abort publication" } });
      expect((await adapter.getMemoriesByIds([headId]))[0]).toBeUndefined();
      expect(
        (await adapter.getMemoriesByIds([dependencyId]))[0],
      ).toBeUndefined();
    } finally {
      await adapter.close();
    }
  });
  it("rejects immutable collisions and foreign owners without publishing a head", async () => {
    const adapter = SQLiteDatabaseAdapter.create(":memory:", agentId);
    try {
      await adapter.createMemories([
        { memory: row(dependencyId, "different"), tableName: "segments" },
      ]);
      await expect(
        adapter.compareAndSwapMemoryPublication(publication("first")),
      ).rejects.toMatchObject({
        code: "CONTENT_CONTINUITY_IMMUTABLE_COLLISION",
      });
      expect((await adapter.getMemoriesByIds([headId]))[0]).toBeUndefined();
      const foreign = publication("second", losingId);
      foreign.dependencies[0].memory.agentId =
        "71000000-0000-4000-8000-000000000099" as UUID;
      await expect(
        adapter.compareAndSwapMemoryPublication(foreign),
      ).rejects.toMatchObject({ code: "SQLITE_AGENT_MISMATCH" });
      expect((await adapter.getMemoriesByIds([headId]))[0]).toBeUndefined();
      expect((await adapter.getMemoriesByIds([losingId]))[0]).toBeUndefined();
    } finally {
      await adapter.close();
    }
  });
});
