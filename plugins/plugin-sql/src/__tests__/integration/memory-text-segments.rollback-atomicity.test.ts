/**
 * Rollback-atomicity probe for #25140 review round 4: when segment
 * publication fails inside the parent-insert transaction, NEITHER the parent
 * row NOR any segment row may survive (deterministic, real PGlite; the
 * failure is induced with a composite-PK collision on the segment insert).
 * This is the crash-window the reviewer flagged — a parent committed with a
 * descriptor but no segments would brick every later paged read with
 * MEMORY_SEGMENT_DESCRIPTOR_DRIFT.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { UUID } from "@elizaos/core";
import { buildSegmentedContentMarker } from "@elizaos/core";
import { v4 } from "uuid";
import { afterEach, describe, expect, it } from "vitest";
import { plugin as sqlPlugin } from "../../index";
import { DatabaseMigrationService } from "../../migration-service";
import { PgliteDatabaseAdapter } from "../../pglite/adapter";
import { PGliteClientManager } from "../../pglite/manager";
import { memoryTable } from "../../schema/memory";
import {
  insertSegmentsInTransaction,
  mergeSegmentationMetadata,
  planSegmentedField,
} from "../../stores/memoryTextSegments.store";
import type { DrizzleDatabase } from "../../types";

const tempDirectories: string[] = [];

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

async function seedRoom(adapter: PgliteDatabaseAdapter, agentId: UUID) {
  const entityId = v4() as UUID;
  const roomId = v4() as UUID;
  await adapter.createAgent({
    id: agentId,
    name: "rollback probe",
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
  await adapter.createRooms([
    {
      id: roomId,
      agentId,
      name: "rollback room",
      source: "test",
      type: "direct" as never,
      worldId: undefined,
      channelId: undefined,
    },
  ]);
  await adapter.createEntities([{ id: entityId, agentId, names: ["user"] }]);
  return { roomId, entityId };
}

describe("segmented publication rollback atomicity (real PGlite)", () => {
  afterEach(() => {
    for (const directory of tempDirectories.splice(0)) {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rolls back parent and segments together when segment publication fails mid-transaction", async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "eliza-segments-rollback-"));
    tempDirectories.push(dataDir);
    const agentId = v4() as UUID;
    const { adapter } = await openDatabase(dataDir, agentId);
    await migrate(adapter);
    const { roomId, entityId } = await seedRoom(adapter, agentId);
    const db = adapter.getDatabase() as DrizzleDatabase;

    const plan = planSegmentedField({
      field: { kind: "content.text" },
      text: largeSource(150 * 1024),
      segmentBytes: 64 * 1024,
    });

    // Corrupt one planned segment's digest so the bulk insert violates the
    // `char_length(segment_sha256) = 64` check AFTER the parent row insert
    // succeeded inside the same transaction — the exact crash-window shape
    // (parent committed, segments fail) the reviewer flagged.
    const memoryId = v4() as UUID;
    const metadata = mergeSegmentationMetadata({}, plan.descriptor);
    await expect(
      db.transaction(async (tx) => {
        await tx.insert(memoryTable).values({
          id: memoryId,
          type: "messages",
          content: { text: buildSegmentedContentMarker(plan.descriptor) },
          metadata,
          entityId,
          roomId,
          agentId,
          unique: true,
        });
        await insertSegmentsInTransaction({
          tx,
          parentId: memoryId,
          segments: plan.segments.map((segment, index) =>
            index === 0 ? { ...segment, sha256: "corrupt" } : segment
          ),
          generation: plan.descriptor.generation,
        });
      })
    ).rejects.toThrow();

    const parentRows = await db.execute(
      `SELECT count(*)::int AS n FROM memories WHERE id = '${memoryId}'`
    );
    expect((parentRows.rows as Array<{ n: number }>)[0].n).toBe(0);
    const segmentRows = await db.execute(
      `SELECT count(*)::int AS n FROM memory_text_segments WHERE parent_id = '${memoryId}'`
    );
    expect((segmentRows.rows as Array<{ n: number }>)[0].n).toBe(0);

    await adapter.close();
  });
});
