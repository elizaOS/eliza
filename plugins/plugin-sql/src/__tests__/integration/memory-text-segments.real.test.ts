/**
 * Real PGlite coverage for segmented large-content persistence (#25140):
 * transactional publication of segments + bounded parent descriptor through a
 * real database (real migrations create memory_text_segments), byte-window
 * page reads with revision fencing, exact SHA reassembly across a restart,
 * deletion cascade, and typed errors for legacy large unsegmented rows. Drives
 * the segmentation store directly over the adapter's Drizzle database;
 * adapter method wiring lands with the read-path change.
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildSegmentedContentMarker,
  ChannelType,
  type Entity,
  encodeUtf8Strict,
  MEMORY_PAGE_MAX_BYTES,
  type Memory,
  type Room,
  shouldSegmentContent,
  type UUID,
} from "@elizaos/core";
import { eq } from "drizzle-orm";
import { v4 } from "uuid";
import { afterEach, describe, expect, it } from "vitest";
import { plugin as sqlPlugin } from "../../index";
import { DatabaseMigrationService } from "../../migration-service";
import { PgliteDatabaseAdapter } from "../../pglite/adapter";
import { PGliteClientManager } from "../../pglite/manager";
import { memoryTable } from "../../schema/index";
import {
  insertSegmentsInTransaction,
  mergeSegmentationMetadata,
  planSegmentedField,
  readMemoryContentPage,
  retireStaleGenerationsInTransaction,
} from "../../stores/memoryTextSegments.store";
import type { DrizzleDatabase } from "../../types";

const tempDirectories: string[] = [];

async function openDatabase(dataDir: string, agentId: UUID) {
  const manager = new PGliteClientManager({ dataDir });
  await manager.initialize();
  const adapter = new PgliteDatabaseAdapter(agentId, manager);
  await adapter.init();
  return { adapter, manager };
}

function multibyteSource(byteLength: number): string {
  const chunks: string[] = [];
  let bytes = 0;
  const alphabet = ["plain text ", "日本語のテキスト ", "emoji🚀🎉 ", "ελληνικά "];
  let i = 0;
  while (bytes < byteLength) {
    const chunk = alphabet[i % alphabet.length];
    chunks.push(chunk);
    bytes += Buffer.byteLength(chunk, "utf8");
    i += 1;
  }
  return chunks.join("");
}

async function seedRoom(adapter: PgliteDatabaseAdapter, agentId: UUID) {
  const entityId = v4() as UUID;
  const roomId = v4() as UUID;
  await adapter.createAgent({
    id: agentId,
    name: "Segmentation evaluator",
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
  await adapter.createRooms([
    {
      id: roomId,
      agentId,
      name: "Segmentation room",
      source: "test",
      type: ChannelType.DM,
    } satisfies Room,
  ]);
  await adapter.createEntities([{ id: entityId, agentId, names: ["user"] } satisfies Entity]);
  return { roomId, entityId };
}

async function migrate(adapter: PgliteDatabaseAdapter) {
  const migrations = new DatabaseMigrationService();
  await migrations.initializeWithDatabase(adapter.getDatabase() as DrizzleDatabase);
  migrations.discoverAndRegisterPluginSchemas([sqlPlugin]);
  await migrations.runAllPluginMigrations();
}

describe("memory text segments (real PGlite)", () => {
  afterEach(() => {
    for (const directory of tempDirectories.splice(0)) {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("publishes parent-first, pages with revision fencing, reassembles across restart, cascades deletion (1 MiB multibyte)", async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "eliza-segments-"));
    tempDirectories.push(dataDir);
    const agentId = v4() as UUID;
    const memoryId = v4() as UUID;

    const first = await openDatabase(dataDir, agentId);
    await migrate(first.adapter);
    const { roomId, entityId } = await seedRoom(first.adapter, agentId);

    const source = multibyteSource(1024 * 1024);
    expect(shouldSegmentContent(source)).toBe(true);
    const db = first.adapter.getDatabase() as DrizzleDatabase;

    const plan = planSegmentedField({
      field: { kind: "content.text" },
      text: source,
      segmentBytes: 128 * 1024,
    });

    // Parent-first atomic publication inside one transaction.
    const metadata = mergeSegmentationMetadata({}, plan.descriptor);
    await db.transaction(async (tx) => {
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
        segments: plan.segments,
        generation: plan.descriptor.generation,
      });
      await retireStaleGenerationsInTransaction({
        tx,
        parentId: memoryId,
        liveMetadata: metadata,
      });
    });

    expect(plan.descriptor.revision).toMatch(/^seg:/);

    const page1 = await readMemoryContentPage({
      db,
      memoryId,
      field: { kind: "content.text" },
      byteStart: 0,
      byteLimit: 256 * 1024,
    });
    expect(page1).not.toBeNull();
    expect(page1?.start).toBe(0);
    expect(page1?.end).toBe(256 * 1024);
    expect(page1?.completeness).toBe("partial-recoverable");
    expect(createHash("sha256").update(encodeUtf8Strict(page1?.text)).digest("hex")).toBe(
      page1?.sliceSha256
    );

    await expect(
      readMemoryContentPage({
        db,
        memoryId,
        field: { kind: "content.text" },
        byteStart: page1?.end,
      })
    ).rejects.toThrow(/expectedRevision/);

    const parts: string[] = [page1?.text];
    let offset = page1?.end;
    let guard = 0;
    while (offset < page1?.total) {
      const page = await readMemoryContentPage({
        db,
        memoryId,
        field: { kind: "content.text" },
        byteStart: offset,
        expectedRevision: page1?.revision,
      });
      expect(page).not.toBeNull();
      parts.push(page?.text);
      offset = page?.end;
      guard += 1;
      if (guard > 100) throw new Error("paging did not terminate");
    }
    const reassembled = parts.join("");
    expect(Buffer.compare(Buffer.from(reassembled, "utf8"), Buffer.from(source, "utf8"))).toBe(0);

    // Stale revision rejection on continuation.
    await expect(
      readMemoryContentPage({
        db,
        memoryId,
        field: { kind: "content.text" },
        byteStart: page1?.end,
        expectedRevision: `seg:00000000-0000-0000-0000-000000000000:${"0".repeat(64)}`,
      })
    ).rejects.toThrow(/changed before this page/);

    // Parent stays bounded: descriptor only, no source bytes.
    const parentMeta = await db.execute(
      `SELECT octet_length(metadata::text) AS meta_bytes, content->>'text' AS text FROM memories WHERE id = '${memoryId}'`
    );
    const metaRow = (parentMeta.rows as Array<{ meta_bytes: number; text: string }>)[0];
    expect(metaRow.meta_bytes).toBeLessThan(4096);
    expect(metaRow.text).toBe(buildSegmentedContentMarker(plan.descriptor));

    // Restart: fresh manager + adapter on the same data dir.
    await first.adapter.close();
    const second = await openDatabase(dataDir, agentId);
    const db2 = second.adapter.getDatabase() as DrizzleDatabase;
    const after = await readMemoryContentPage({
      db: db2,
      memoryId,
      field: { kind: "content.text" },
      byteStart: 0,
      byteLimit: 4096,
    });
    expect(after).not.toBeNull();
    expect(encodeUtf8Strict(after?.text).length).toBe(4096);
    expect(after?.text).toBe(new TextDecoder().decode(encodeUtf8Strict(source).subarray(0, 4096)));

    // Deletion cascade.
    await second.adapter.deleteMemory(memoryId);
    const remaining = await db2.execute(
      `SELECT count(*)::int AS n FROM memory_text_segments WHERE parent_id = '${memoryId}'`
    );
    expect((remaining.rows as Array<{ n: number }>)[0].n).toBe(0);
    await second.adapter.close();
  });

  it("replaces a generation atomically and retires the prior one", async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "eliza-segments-replace-"));
    tempDirectories.push(dataDir);
    const agentId = v4() as UUID;
    const memoryId = v4() as UUID;

    const { adapter } = await openDatabase(dataDir, agentId);
    await migrate(adapter);
    const { roomId, entityId } = await seedRoom(adapter, agentId);
    const db = adapter.getDatabase() as DrizzleDatabase;

    const firstPlan = planSegmentedField({
      field: { kind: "content.text" },
      text: multibyteSource(300 * 1024),
      segmentBytes: 64 * 1024,
    });
    const firstMetadata = mergeSegmentationMetadata({}, firstPlan.descriptor);
    await db.transaction(async (tx) => {
      await tx.insert(memoryTable).values({
        id: memoryId,
        type: "messages",
        content: { text: buildSegmentedContentMarker(firstPlan.descriptor) },
        metadata: firstMetadata,
        entityId,
        roomId,
        agentId,
        unique: true,
      });
      await insertSegmentsInTransaction({
        tx,
        parentId: memoryId,
        segments: firstPlan.segments,
        generation: firstPlan.descriptor.generation,
      });
    });

    const replacement = `${multibyteSource(200 * 1024).slice(0, 100000)} tail`;
    const secondPlan = planSegmentedField({
      field: { kind: "content.text" },
      text: replacement,
      segmentBytes: 64 * 1024,
    });
    expect(secondPlan.descriptor.generation).not.toBe(firstPlan.descriptor.generation);
    const secondMetadata = mergeSegmentationMetadata({}, secondPlan.descriptor);
    await db.transaction(async (tx) => {
      await tx
        .update(memoryTable)
        .set({
          metadata: secondMetadata,
          content: { text: buildSegmentedContentMarker(secondPlan.descriptor) },
        })
        .where(eq(memoryTable.id, memoryId));
      await insertSegmentsInTransaction({
        tx,
        parentId: memoryId,
        segments: secondPlan.segments,
        generation: secondPlan.descriptor.generation,
      });
      await retireStaleGenerationsInTransaction({
        tx,
        parentId: memoryId,
        liveMetadata: secondMetadata,
      });
    });

    const page = await readMemoryContentPage({
      db,
      memoryId,
      field: { kind: "content.text" },
      byteStart: 0,
      byteLimit: MEMORY_PAGE_MAX_BYTES,
    });
    expect(page).not.toBeNull();
    expect(page?.revision).toBe(secondPlan.descriptor.revision);
    expect(page?.total).toBe(encodeUtf8Strict(replacement).length);

    const generations = await db.execute(
      `SELECT count(DISTINCT generation)::int AS n FROM memory_text_segments WHERE parent_id = '${memoryId}'`
    );
    expect((generations.rows as Array<{ n: number }>)[0].n).toBe(1);

    // Old revision is stale now.
    await expect(
      readMemoryContentPage({
        db,
        memoryId,
        field: { kind: "content.text" },
        byteStart: 100,
        expectedRevision: firstPlan.descriptor.revision,
      })
    ).rejects.toThrow(/changed before this page/);
    await adapter.close();
  });

  it("flags legacy large unsegmented rows and passes small rows through", async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "eliza-segments-legacy-"));
    tempDirectories.push(dataDir);
    const agentId = v4() as UUID;
    const memoryId = v4() as UUID;

    const { adapter } = await openDatabase(dataDir, agentId);
    await migrate(adapter);
    const { roomId, entityId } = await seedRoom(adapter, agentId);
    const db = adapter.getDatabase() as DrizzleDatabase;

    // Legacy large row: inline text above the hard page ceiling, NO
    // descriptor. Inserted with a raw drizzle write because createMemory now
    // transparently segments oversized content (#25140) — the legacy state by
    // definition predates that publication path.
    const legacyText = "legacy ".repeat(Math.ceil((MEMORY_PAGE_MAX_BYTES + 1024) / 7));
    await db.insert(memoryTable).values({
      id: memoryId,
      type: "messages",
      content: { text: legacyText, source: "test" },
      metadata: {},
      entityId,
      roomId,
      agentId,
      unique: true,
    });

    await expect(
      readMemoryContentPage({
        db,
        memoryId,
        field: { kind: "content.text" },
        byteStart: 0,
      })
    ).rejects.toThrow(/reindex/i);

    const smallId = v4() as UUID;
    await adapter.createMemory(
      {
        id: smallId,
        entityId,
        roomId,
        agentId,
        content: { text: "small", source: "test" },
        unique: true,
      } as Memory,
      "messages"
    );
    const small = await readMemoryContentPage({
      db,
      memoryId: smallId,
      field: { kind: "content.text" },
      byteStart: 0,
    });
    expect(small).toBeNull();
    await adapter.close();
  });
});
