/**
 * Pins the three legacy-content reindex guards (#25140) that the adapter and
 * RLS suites do not assert by code: the caller-supplied `maxSourceBytes`
 * bound, the source-drift check between the locked byte count and the later
 * source fetch, and the REINDEX_REQUIRED rejection for a legacy row that a
 * bounded page read cannot serve. The bound table is database-free and proves
 * the guard short-circuits before any transaction; the other cases run on
 * real PGlite in the PR lane. Drift is induced by rewriting the locked row
 * from inside the same transaction, right before the source fetch, which is
 * the only deterministic way to reach that guard under a row lock.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MEMORY_SEGMENTATION_THRESHOLD_BYTES, type Memory, type UUID } from "@elizaos/core";
import { eq, sql } from "drizzle-orm";
import { v4 } from "uuid";
import { afterEach, describe, expect, it } from "vitest";
import { plugin as sqlPlugin } from "../../index";
import { DatabaseMigrationService } from "../../migration-service";
import { PgliteDatabaseAdapter } from "../../pglite/adapter";
import { PGliteClientManager } from "../../pglite/manager";
import { memoryTable } from "../../schema/index";
import { reindexMemoryContent } from "../../stores/memoryTextSegments.store";
import type { DrizzleDatabase } from "../../types";

const REINDEX_HARD_MAX_BYTES = 16 * 1024 * 1024;
const tempDirectories: string[] = [];

async function openDatabase(dataDir: string, agentId: UUID) {
  const manager = new PGliteClientManager({ dataDir });
  await manager.initialize();
  const adapter = new PgliteDatabaseAdapter(agentId, manager);
  await adapter.init();
  return { adapter, manager };
}

async function migrate(adapter: PgliteDatabaseAdapter) {
  const migrations = new DatabaseMigrationService();
  await migrations.initializeWithDatabase(adapter.getDatabase() as DrizzleDatabase);
  migrations.discoverAndRegisterPluginSchemas([sqlPlugin]);
  await migrations.runAllPluginMigrations();
}

function largeSource(byteLength: number): string {
  const unit = "segurança שלום 🌏 test ";
  const chunks: string[] = [];
  let bytes = 0;
  while (bytes < byteLength) {
    chunks.push(unit);
    bytes += Buffer.byteLength(unit, "utf8");
  }
  return chunks.join("");
}

async function seedRoom(adapter: PgliteDatabaseAdapter, agentId: UUID) {
  const entityId = v4() as UUID;
  const roomId = v4() as UUID;
  await adapter.createAgent({
    id: agentId,
    name: "reindex guards",
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
  await adapter.createRooms([
    {
      id: roomId,
      agentId,
      name: "reindex guards room",
      source: "test",
      type: "direct" as never,
      worldId: undefined,
      channelId: undefined,
    },
  ]);
  await adapter.createEntities([{ id: entityId, agentId, names: ["user"] }]);
  return { roomId, entityId };
}

/** Writes a legacy unsegmented row the way a pre-#25140 import left it. */
async function seedLegacyRow(
  adapter: PgliteDatabaseAdapter,
  agentId: UUID,
  text: string
): Promise<{ memoryId: UUID; roomId: UUID; entityId: UUID }> {
  const { roomId, entityId } = await seedRoom(adapter, agentId);
  const memoryId = await adapter.createMemory(
    { entityId, roomId, agentId, content: { text: "legacy seed", source: "test" } } as Memory,
    "messages"
  );
  const db = adapter.getDatabase() as DrizzleDatabase;
  await db
    .update(memoryTable)
    .set({ content: { text, source: "legacy-import" }, metadata: {} })
    .where(eq(memoryTable.id, memoryId));
  return { memoryId, roomId, entityId };
}

describe("reindex bound validation (no database)", () => {
  const untouchable = {
    transaction: () => {
      throw new Error("DB WAS TOUCHED");
    },
  } as unknown as DrizzleDatabase;
  const base = {
    db: untouchable,
    memoryId: v4() as UUID,
    field: { kind: "content.text" } as const,
    parentAuthorization: sql`true`,
  };

  it.each([
    ["one byte above the 16 MiB hard ceiling", REINDEX_HARD_MAX_BYTES + 1],
    ["far above the ceiling", Number.MAX_VALUE],
    ["a non-integer", 1.5],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["negative", -1],
    ["zero", 0],
    ["exactly the segmentation threshold", MEMORY_SEGMENTATION_THRESHOLD_BYTES],
  ])("rejects a bound that is %s before opening a transaction", async (_label, maxSourceBytes) => {
    await expect(reindexMemoryContent({ ...base, maxSourceBytes })).rejects.toMatchObject({
      code: "MEMORY_CONTENT_REINDEX_INVALID_BOUND",
      context: { maxSourceBytes, hardMaxBytes: REINDEX_HARD_MAX_BYTES },
    });
  });

  it.each([
    ["one byte above the segmentation threshold", MEMORY_SEGMENTATION_THRESHOLD_BYTES + 1],
    ["exactly the 16 MiB hard ceiling", REINDEX_HARD_MAX_BYTES],
  ])(
    "admits a bound that is %s and proceeds to the transaction",
    async (_label, maxSourceBytes) => {
      await expect(reindexMemoryContent({ ...base, maxSourceBytes })).rejects.toThrow(
        "DB WAS TOUCHED"
      );
    }
  );
});

describe("reindex guards (real PGlite)", () => {
  afterEach(() => {
    for (const directory of tempDirectories.splice(0)) {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rejects the reindex and rolls back when the source is rewritten after the locked byte count", async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "eliza-reindex-drift-"));
    tempDirectories.push(dataDir);
    const agentId = v4() as UUID;
    const { adapter } = await openDatabase(dataDir, agentId);
    await migrate(adapter);
    const source = largeSource(200 * 1024);
    const { memoryId } = await seedLegacyRow(adapter, agentId, source);
    const db = adapter.getDatabase() as DrizzleDatabase;

    // The store issues two raw reads inside its transaction: the FOR UPDATE
    // size check, then the source fetch. Rewrite the row between them from
    // the same transaction (the lock holder), so the second read returns a
    // different byte length than the first one measured.
    let executeCalls = 0;
    const wrapTransaction = (tx: DrizzleDatabase): DrizzleDatabase =>
      new Proxy(tx, {
        get(target, property, receiver) {
          const value = Reflect.get(target, property, receiver);
          if (property !== "execute") {
            return typeof value === "function" ? value.bind(target) : value;
          }
          return async (...args: unknown[]) => {
            executeCalls += 1;
            if (executeCalls === 2) {
              await target.execute(
                sql`UPDATE memories SET content = jsonb_set(content, '{text}', to_jsonb('rewritten mid-reindex'::text), false) WHERE id = ${memoryId}`
              );
            }
            return (target.execute as (...inner: unknown[]) => Promise<unknown>)(...args);
          };
        },
      });
    const driftingDb = {
      transaction: (run: (tx: DrizzleDatabase) => Promise<unknown>) =>
        db.transaction((tx) => run(wrapTransaction(tx as DrizzleDatabase))),
    } as unknown as DrizzleDatabase;

    await expect(
      reindexMemoryContent({
        db: driftingDb,
        memoryId,
        field: { kind: "content.text" },
        maxSourceBytes: 1024 * 1024,
        parentAuthorization: sql`true`,
      })
    ).rejects.toMatchObject({
      code: "MEMORY_CONTENT_REINDEX_SOURCE_DRIFT",
      context: { memoryId },
    });
    expect(executeCalls).toBe(2);

    // The whole transaction rolled back: the injected rewrite is gone, no
    // descriptor was written, and no segment generation was published.
    const [row] = await db
      .select({ content: memoryTable.content, metadata: memoryTable.metadata })
      .from(memoryTable)
      .where(eq(memoryTable.id, memoryId));
    expect((row.content as { text: string }).text).toBe(source);
    expect((row.metadata as { segmentation?: unknown }).segmentation).toBeUndefined();
    const segments = await db.execute(
      sql`SELECT count(*)::int AS n FROM memory_text_segments WHERE parent_id = ${memoryId}`
    );
    expect((segments.rows as Array<{ n: number }>)[0].n).toBe(0);

    await adapter.close();
  });

  it("refuses a bounded page over a legacy row above the segmentation threshold until it is reindexed", async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "eliza-reindex-required-"));
    tempDirectories.push(dataDir);
    const agentId = v4() as UUID;
    const { adapter } = await openDatabase(dataDir, agentId);
    await migrate(adapter);
    const source = largeSource(MEMORY_SEGMENTATION_THRESHOLD_BYTES + 4096);
    const { memoryId, roomId, entityId } = await seedLegacyRow(adapter, agentId, source);
    const accessContext = {
      requesterEntityId: entityId,
      authorizedRoomIds: [roomId],
      role: "USER" as const,
    };
    const fieldBytes = Buffer.byteLength(source, "utf8");

    await expect(
      adapter.getMemoryContentPage({
        memoryId,
        field: { kind: "content.text" },
        byteStart: 0,
        accessContext,
      })
    ).rejects.toMatchObject({
      code: "MEMORY_CONTENT_REINDEX_REQUIRED",
      context: { memoryId, fieldKind: "content.text", fieldBytes },
    });

    // Boundary control: a legacy row at exactly the threshold is served by
    // the ordinary small-row path (null means fall back inline).
    const db = adapter.getDatabase() as DrizzleDatabase;
    const atThreshold = "a".repeat(MEMORY_SEGMENTATION_THRESHOLD_BYTES);
    await db
      .update(memoryTable)
      .set({ content: { text: atThreshold, source: "legacy-import" }, metadata: {} })
      .where(eq(memoryTable.id, memoryId));
    await expect(
      adapter.getMemoryContentPage({
        memoryId,
        field: { kind: "content.text" },
        byteStart: 0,
        accessContext,
      })
    ).resolves.toBeNull();

    // The remedy the error names: an authorized reindex makes the same
    // page read succeed.
    await db
      .update(memoryTable)
      .set({ content: { text: source, source: "legacy-import" }, metadata: {} })
      .where(eq(memoryTable.id, memoryId));
    const receipt = await adapter.reindexMemoryContent({
      memoryId,
      field: { kind: "content.text" },
      accessContext,
      maxSourceBytes: 1024 * 1024,
    });
    expect(receipt.totalBytes).toBe(fieldBytes);
    const page = await adapter.getMemoryContentPage({
      memoryId,
      field: { kind: "content.text" },
      byteStart: 0,
      accessContext,
    });
    expect(page).not.toBeNull();
    expect(page?.revision).toBe(receipt.revision);

    await adapter.close();
  });
});
