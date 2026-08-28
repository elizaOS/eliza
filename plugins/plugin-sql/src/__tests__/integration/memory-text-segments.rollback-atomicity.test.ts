/**
 * Rollback-atomicity probe for #25140 review round 4: when segment
 * publication fails inside the production createMemory path, NEITHER the
 * parent row NOR any segment row survives (deterministic, real PGlite; the
 * failure is induced by a database trigger that rejects segment inserts for
 * one parent, so the probe exercises adapter.createMemory →
 * insertMemoryInTransaction end-to-end, not a hand-rolled transaction).
 * This is the crash-window the reviewer flagged — a parent committed with a
 * descriptor but no segments would brick every later paged read with
 * MEMORY_SEGMENT_DESCRIPTOR_DRIFT.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Memory, UUID } from "@elizaos/core";
import { v4 } from "uuid";
import { afterEach, describe, expect, it } from "vitest";
import { plugin as sqlPlugin } from "../../index";
import { DatabaseMigrationService } from "../../migration-service";
import { PgliteDatabaseAdapter } from "../../pglite/adapter";
import { PGliteClientManager } from "../../pglite/manager";
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

  it("createMemory leaves neither parent nor segments when segment publication fails mid-transaction", async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "eliza-segments-rollback-"));
    tempDirectories.push(dataDir);
    const agentId = v4() as UUID;
    const { adapter } = await openDatabase(dataDir, agentId);
    await migrate(adapter);
    const { roomId, entityId } = await seedRoom(adapter, agentId);
    const db = adapter.getDatabase() as DrizzleDatabase;

    // Reject every segment insert from inside the database: the parent
    // insert succeeds first, then the segment publication fails inside the
    // SAME production transaction — the exact crash-window shape.
    await db.execute(
      "CREATE OR REPLACE FUNCTION reject_segment() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'segment insert rejected'; END; $$ LANGUAGE plpgsql"
    );
    await db.execute(
      "CREATE TRIGGER reject_segment BEFORE INSERT ON memory_text_segments FOR EACH ROW EXECUTE FUNCTION reject_segment()"
    );

    await expect(
      adapter.createMemory(
        {
          entityId,
          roomId,
          agentId,
          content: { text: largeSource(150 * 1024), source: "test" },
        } as unknown as Memory,
        "messages"
      )
    ).rejects.toThrow(/memory_text_segments/);

    // A control small memory still writes fine (trigger only rejects
    // segment rows), proving the probe failed on the segmentation path.
    const smallId = await adapter.createMemory(
      {
        entityId,
        roomId,
        agentId,
        content: { text: "small memory", source: "test" },
      } as unknown as Memory,
      "messages"
    );
    expect(smallId).toBeTruthy();

    // No segmented parent survived: every remaining messages row in the
    // room is the small control (segmented markers absent).
    const markers = await db.execute(
      `SELECT count(*)::int AS n FROM memories WHERE room_id::text = '${roomId}' AND content->>'text' LIKE '[elizaos:segmented-content%'`
    );
    expect((markers.rows as Array<{ n: number }>)[0].n).toBe(0);
    const segmentRows = await db.execute("SELECT count(*)::int AS n FROM memory_text_segments");
    expect((segmentRows.rows as Array<{ n: number }>)[0].n).toBe(0);

    await adapter.close();
  });
});
