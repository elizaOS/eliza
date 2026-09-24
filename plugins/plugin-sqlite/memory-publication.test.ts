/** Exercises immutable dependency publication and revision races against real SQLite files, including restart and rollback. */
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  AtomicMemoryPublicationParams,
  Memory,
  UUID,
} from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SQLiteDatabaseAdapter } from "./adapter";

const uuid = () => randomUUID() as UUID;
const agentId = uuid();
const roomId = uuid();
const entityId = uuid();
let directory: string;
let adapter: SQLiteDatabaseAdapter;
type PublicationMemory = Memory & { id: UUID };
type PublicationRow = { memory: PublicationMemory; tableName: string };
type TestPublication = Omit<
  AtomicMemoryPublicationParams,
  "head" | "dependencies"
> & {
  head: PublicationRow;
  dependencies: PublicationRow[];
};
function memory(text: string, id = uuid()): PublicationMemory {
  return {
    id,
    agentId,
    roomId,
    entityId,
    content: { text },
    metadata: { type: "custom" },
  };
}
function publication(
  id = uuid(),
  revision = "r1",
  expectedRevision: string | null = null,
): TestPublication {
  return {
    head: {
      memory: { ...memory("head", id), metadata: { type: "custom", revision } },
      tableName: "continuity_heads",
    },
    dependencies: [
      {
        memory: memory("complete immutable body"),
        tableName: "continuity_shards",
      },
    ],
    expectedRevision,
  };
}
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "sqlite-publication-"));
  adapter = SQLiteDatabaseAdapter.create(
    join(directory, "agent.sqlite"),
    agentId,
  );
  await adapter.initialize();
});
afterEach(async () => {
  await adapter.close();
  await rm(directory, { recursive: true, force: true });
});

describe("atomic memory publication", () => {
  it("publishes complete dependencies and their head durably, then swaps one revision", async () => {
    const initial = publication();
    expect(
      await adapter.compareAndSwapMemoryPublication(initial),
    ).toMatchObject({ status: "published" });
    await adapter.close();
    adapter = SQLiteDatabaseAdapter.create(
      join(directory, "agent.sqlite"),
      agentId,
    );
    await adapter.initialize();
    const headId = initial.head.memory.id;
    expect(
      await adapter.getMemoriesByIds([
        headId,
        initial.dependencies[0].memory.id,
      ]),
    ).toHaveLength(2);
    const next = publication(headId, "r2", "r1");
    next.dependencies.push(initial.dependencies[0]);
    expect(await adapter.compareAndSwapMemoryPublication(next)).toMatchObject({
      status: "published",
      head: { metadata: { revision: "r2" } },
    });
    expect((await adapter.getMemoriesByIds([headId]))[0].content).toEqual(
      next.head.memory.content,
    );
  });

  it("admits one competing writer and publishes no losing or missing-head dependencies", async () => {
    const initial = publication();
    await adapter.compareAndSwapMemoryPublication(initial);
    const first = publication(initial.head.memory.id, "r2", "r1");
    const second = publication(initial.head.memory.id, "r3", "r1");
    const results = await Promise.all([
      adapter.compareAndSwapMemoryPublication(first),
      adapter.compareAndSwapMemoryPublication(second),
    ]);
    expect(results.map((result) => result.status).sort()).toEqual([
      "conflict",
      "published",
    ]);
    const loser = results[0].status === "conflict" ? first : second;
    expect(
      await adapter.getMemoriesByIds([loser.dependencies[0].memory.id]),
    ).toEqual([]);
    const missing = publication(uuid(), "r2", "absent");
    expect(await adapter.compareAndSwapMemoryPublication(missing)).toEqual({
      status: "conflict",
    });
    expect(
      await adapter.getMemoriesByIds([missing.dependencies[0].memory.id]),
    ).toEqual([]);
    expect(await adapter.compareAndSwapMemoryPublication(initial)).toEqual({
      status: "conflict",
    });
  });

  it("rejects immutable collisions atomically and preserves the original head", async () => {
    const initial = publication();
    await adapter.compareAndSwapMemoryPublication(initial);
    const next = publication(initial.head.memory.id, "r2", "r1");
    next.dependencies.push({
      ...initial.dependencies[0],
      memory: {
        ...initial.dependencies[0].memory,
        content: { text: "different body" },
      },
    });
    await expect(
      adapter.compareAndSwapMemoryPublication(next),
    ).rejects.toMatchObject({ code: "CONTENT_CONTINUITY_IMMUTABLE_COLLISION" });
    expect(
      await adapter.getMemoriesByIds([next.dependencies[0].memory.id]),
    ).toEqual([]);
    expect(
      (await adapter.getMemoriesByIds([initial.head.memory.id]))[0].metadata,
    ).toMatchObject({ revision: "r1" });
  });

  it("rolls back published rows and vector entries with their enclosing transaction", async () => {
    await adapter.ensureEmbeddingDimension(3);
    const input = publication();
    input.dependencies[0].memory.embedding = [1, 0, 0];
    await expect(
      adapter.transaction(async (transaction) => {
        if (!transaction.compareAndSwapMemoryPublication)
          throw new Error("SQLite transaction must support atomic publication");
        expect(
          await transaction.compareAndSwapMemoryPublication(input),
        ).toMatchObject({ status: "published" });
        throw new Error("abort publication transaction");
      }),
    ).rejects.toMatchObject({ code: "SQLITE_TRANSACTION_FAILED" });
    expect(
      await adapter.getMemoriesByIds([
        input.head.memory.id,
        input.dependencies[0].memory.id,
      ]),
    ).toEqual([]);
    expect(
      await adapter.searchMemories({
        tableName: "continuity_shards",
        embedding: [1, 0, 0],
      }),
    ).toEqual([]);
    expect(await adapter.compareAndSwapMemoryPublication(input)).toMatchObject({
      status: "published",
    });
  });

  it.each(["head", "dependency"])(
    "rejects a foreign-agent %s without writing anything",
    async (target) => {
      const input = publication();
      (target === "head"
        ? input.head.memory
        : input.dependencies[0].memory).agentId = uuid();
      await expect(
        adapter.compareAndSwapMemoryPublication(input),
      ).rejects.toMatchObject({ code: "SQLITE_AGENT_MISMATCH" });
      expect(
        await adapter.getMemoriesByIds([
          input.head.memory.id,
          input.dependencies[0].memory.id,
        ]),
      ).toEqual([]);
    },
  );
});
