/**
 * Real PGlite coverage for the adapter-integrated segmentation path (#25140):
 * createMemory publishes segments transactionally with a bounded inline
 * marker + descriptor metadata; getMemoryContentPage (the adapter capability
 * the MESSAGE/ATTACHMENT actions consume) pages those rows with revision
 * fencing; updateMemory replaces a generation and retires the stale one.
 * Complements memory-text-segments.real.test.ts, which drives the store
 * directly — this file proves the BaseDrizzleAdapter wiring.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isSegmentedContentMarker, type Memory, type UUID } from "@elizaos/core";
import { eq } from "drizzle-orm";
import { v4 } from "uuid";
import { afterEach, describe, expect, it } from "vitest";
import { plugin as sqlPlugin } from "../../index";
import { DatabaseMigrationService } from "../../migration-service";
import { PgliteDatabaseAdapter } from "../../pglite/adapter";
import { PGliteClientManager } from "../../pglite/manager";
import { memoryTable } from "../../schema/index";
import type { DrizzleDatabase } from "../../types";

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
  const unit = "segurança שלום 🌏 test "; // multibyte on purpose
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
    name: "Adapter segmentation",
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
  await adapter.createRooms([
    {
      id: roomId,
      agentId,
      name: "Adapter segmentation room",
      source: "test",
      type: "direct" as never,
      worldId: undefined,
      channelId: undefined,
    },
  ]);
  await adapter.createEntities([{ id: entityId, agentId, names: ["user"] }]);
  return { roomId, entityId };
}

describe("adapter-integrated memory content paging (real PGlite)", () => {
  afterEach(() => {
    for (const directory of tempDirectories.splice(0)) {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("createMemory publishes segments with a bounded marker and pages them via getMemoryContentPage", async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "eliza-seg-adapter-"));
    tempDirectories.push(dataDir);
    const agentId = v4() as UUID;
    const { adapter, manager } = await openDatabase(dataDir, agentId);
    await migrate(adapter);
    const { roomId, entityId } = await seedRoom(adapter, agentId);

    const source = largeSource(300 * 1024);
    const memoryId = await adapter.createMemory(
      {
        entityId,
        roomId,
        agentId,
        content: { text: source, source: "test" },
      } as Memory,
      "messages"
    );

    // Inline field is a bounded marker, never the source bytes.
    const db = adapter.getDatabase() as DrizzleDatabase;
    const row = (await db.select().from(memoryTable).where(eq(memoryTable.id, memoryId)))[0];
    const inlineText = (row.content as { text: string }).text;
    expect(isSegmentedContentMarker(inlineText)).toBe(true);
    expect(Buffer.byteLength(inlineText, "utf8")).toBeLessThan(512);

    // Metadata carries the descriptor.
    const metadata = row.metadata as {
      segmentation?: Record<string, { revision: string; totalBytes: number }>;
    };
    const descriptor = metadata?.segmentation?.["content.text"];
    expect(descriptor).toBeDefined();
    expect(descriptor!.totalBytes).toBe(Buffer.byteLength(source, "utf8"));

    // The adapter capability is declared and pages.
    expect(adapter.memoryContentPageCapability).toBe(1);
    const page1 = await adapter.getMemoryContentPage({
      memoryId,
      field: { kind: "content.text" },
      byteStart: 0,
      byteLimit: 64 * 1024,
    });
    expect(page1).not.toBeNull();
    expect(page1?.start).toBe(0);
    expect(page1?.revision).toBe(descriptor!.revision);
    expect(page1?.completeness).toBe("partial-recoverable");
    // The window end snaps backward off any partial trailing code point, so
    // the page is the source prefix truncated to a code-point boundary.
    const sourceBytes1 = Buffer.from(source, "utf8");
    let expectedEnd1 = Math.min(64 * 1024, sourceBytes1.length);
    while (expectedEnd1 > 0 && (sourceBytes1[expectedEnd1] & 0xc0) === 0x80) {
      expectedEnd1 -= 1;
    }
    expect(page1?.end).toBe(expectedEnd1);
    const page1Bytes = Buffer.from(page1!.text, "utf8");
    expect(page1Bytes.length).toBe(expectedEnd1);
    expect(page1Bytes.equals(sourceBytes1.subarray(0, expectedEnd1))).toBe(true);

    // Continuation without revision is a typed rejection.
    await expect(
      adapter.getMemoryContentPage({
        memoryId,
        field: { kind: "content.text" },
        byteStart: 64 * 1024,
      })
    ).rejects.toMatchObject({ code: "MEMORY_CONTENT_EXPECTED_REVISION_REQUIRED" });

    // Continuation with the wrong revision is stale.
    await expect(
      adapter.getMemoryContentPage({
        memoryId,
        field: { kind: "content.text" },
        byteStart: 64 * 1024,
        expectedRevision: "seg:not-the-live-generation",
      })
    ).rejects.toMatchObject({ code: "MEMORY_CONTENT_STALE_REVISION" });

    // Walk every page with the live revision and reassemble exactly.
    const whole: Buffer[] = [];
    let cursor = 0;
    let revision = page1!.revision;
    for (;;) {
      const page = await adapter.getMemoryContentPage({
        memoryId,
        field: { kind: "content.text" },
        byteStart: cursor,
        expectedRevision: revision,
      });
      expect(page).not.toBeNull();
      whole.push(Buffer.from(page!.text, "utf8"));
      cursor = page!.end;
      revision = page!.revision;
      if (page!.completeness === "complete") break;
    }
    expect(Buffer.concat(whole).equals(Buffer.from(source, "utf8"))).toBe(true);

    await adapter.close();
    await manager.close();
  });

  it("small content stays inline and pages return null (fallback path)", async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "eliza-seg-small-"));
    tempDirectories.push(dataDir);
    const agentId = v4() as UUID;
    const { adapter, manager } = await openDatabase(dataDir, agentId);
    await migrate(adapter);
    const { roomId, entityId } = await seedRoom(adapter, agentId);

    const memoryId = await adapter.createMemory(
      {
        entityId,
        roomId,
        agentId,
        content: { text: "small inline text", source: "test" },
      } as Memory,
      "messages"
    );

    const page = await adapter.getMemoryContentPage({
      memoryId,
      field: { kind: "content.text" },
      byteStart: 0,
    });
    expect(page).toBeNull();

    await adapter.close();
    await manager.close();
  });

  it("updateMemory replaces the generation and retires the stale one", async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "eliza-seg-replace-"));
    tempDirectories.push(dataDir);
    const agentId = v4() as UUID;
    const { adapter, manager } = await openDatabase(dataDir, agentId);
    await migrate(adapter);
    const { roomId, entityId } = await seedRoom(adapter, agentId);

    const first = largeSource(200 * 1024);
    const memoryId = await adapter.createMemory(
      {
        entityId,
        roomId,
        agentId,
        content: { text: first, source: "test" },
      } as Memory,
      "messages"
    );

    const page1 = await adapter.getMemoryContentPage({
      memoryId,
      field: { kind: "content.text" },
      byteStart: 0,
      byteLimit: 1024,
    });
    expect(page1).not.toBeNull();
    const firstRevision = page1!.revision;

    // Full replacement with different large content.
    const second = largeSource(260 * 1024).replace("segurança", "substituição ");
    expect(Buffer.compare(Buffer.from(second), Buffer.from(first))).not.toBe(0);
    const updated = await adapter.updateMemory({
      id: memoryId,
      content: { text: second, source: "test" },
    });
    expect(updated).toBe(true);

    const page2 = await adapter.getMemoryContentPage({
      memoryId,
      field: { kind: "content.text" },
      byteStart: 0,
      byteLimit: 1024,
    });
    expect(page2).not.toBeNull();
    expect(page2!.revision).not.toBe(firstRevision);
    expect(page2!.total).toBe(Buffer.byteLength(second, "utf8"));
    expect(
      Buffer.from(page2!.text, "utf8").equals(Buffer.from(second, "utf8").subarray(0, 1024))
    ).toBe(true);

    // The stale generation now rejects.
    await expect(
      adapter.getMemoryContentPage({
        memoryId,
        field: { kind: "content.text" },
        byteStart: 1024,
        expectedRevision: firstRevision,
      })
    ).rejects.toMatchObject({ code: "MEMORY_CONTENT_STALE_REVISION" });

    await adapter.close();
    await manager.close();
  });

  it("large-to-small replacement retires the descriptor and generation", async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "eliza-seg-shrink-"));
    tempDirectories.push(dataDir);
    const agentId = v4() as UUID;
    const { adapter, manager } = await openDatabase(dataDir, agentId);
    await migrate(adapter);
    const { roomId, entityId } = await seedRoom(adapter, agentId);

    const memoryId = await adapter.createMemory(
      {
        entityId,
        roomId,
        agentId,
        content: { text: largeSource(200 * 1024), source: "test" },
      } as Memory,
      "messages"
    );
    const pageBefore = await adapter.getMemoryContentPage({
      memoryId,
      field: { kind: "content.text" },
      byteStart: 0,
      byteLimit: 64,
    });
    expect(pageBefore).not.toBeNull();

    // Replace with small content: descriptor must be dropped and generation retired.
    expect(
      await adapter.updateMemory({
        id: memoryId,
        content: { text: "now small", source: "test" },
      })
    ).toBe(true);

    const db = adapter.getDatabase() as DrizzleDatabase;
    const row = (await db.select().from(memoryTable).where(eq(memoryTable.id, memoryId)))[0];
    const segmentation = (row.metadata as { segmentation?: unknown }).segmentation;
    expect(segmentation).toEqual({});
    const leftover = await db.execute(
      `SELECT count(*)::int AS n FROM memory_text_segments WHERE parent_id = '${memoryId}'`
    );
    expect((leftover.rows as Array<{ n: number }>)[0].n).toBe(0);
    // Small-row read falls back to inline.
    const pageAfter = await adapter.getMemoryContentPage({
      memoryId,
      field: { kind: "content.text" },
      byteStart: 0,
    });
    expect(pageAfter).toBeNull();

    await adapter.close();
    await manager.close();
  });

  it("rejects large attachment text without an id and duplicate ids", async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "eliza-seg-attid-"));
    tempDirectories.push(dataDir);
    const agentId = v4() as UUID;
    const { adapter, manager } = await openDatabase(dataDir, agentId);
    await migrate(adapter);
    const { roomId, entityId } = await seedRoom(adapter, agentId);

    await expect(
      adapter.createMemory(
        {
          entityId,
          roomId,
          agentId,
          content: {
            text: "small",
            attachments: [{ url: "https://example.test/x", text: largeSource(150 * 1024) }],
          },
        } as unknown as Memory,
        "messages"
      )
    ).rejects.toMatchObject({ code: "MEMORY_SEGMENT_ATTACHMENT_ID_REQUIRED" });

    await expect(
      adapter.createMemory(
        {
          entityId,
          roomId,
          agentId,
          content: {
            text: "small",
            attachments: [
              { id: "dup-1", url: "https://example.test/a", text: largeSource(150 * 1024) },
              { id: "dup-1", url: "https://example.test/b", text: largeSource(150 * 1024) },
            ],
          },
        } as unknown as Memory,
        "messages"
      )
    ).rejects.toMatchObject({ code: "MEMORY_SEGMENT_ATTACHMENT_ID_CONFLICT" });

    // Small attachment reusing a segmented attachment's id: equally ambiguous
    // for the owner-bound descriptor key, must fail closed the same way.
    await expect(
      adapter.createMemory(
        {
          entityId,
          roomId,
          agentId,
          content: {
            text: "small",
            attachments: [
              { id: "dup-1", url: "https://example.test/a", text: largeSource(150 * 1024) },
              { id: "dup-1", url: "https://example.test/b", text: "small text" },
            ],
          },
        } as unknown as Memory,
        "messages"
      )
    ).rejects.toMatchObject({ code: "MEMORY_SEGMENT_ATTACHMENT_ID_CONFLICT" });

    await adapter.close();
    await manager.close();
  });

  it("publishes segmented attachment text and pages it by owner-bound field", async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "eliza-seg-attach-"));
    tempDirectories.push(dataDir);
    const agentId = v4() as UUID;
    const { adapter, manager } = await openDatabase(dataDir, agentId);
    await migrate(adapter);
    const { roomId, entityId } = await seedRoom(adapter, agentId);

    const attachmentId = `att-${v4()}`;
    const transcript = largeSource(150 * 1024);
    const memoryId = await adapter.createMemory(
      {
        entityId,
        roomId,
        agentId,
        content: {
          text: "here is the transcript",
          source: "test",
          attachments: [
            {
              id: attachmentId,
              url: "https://example.com/t.wav",
              contentType: "audio/wav",
              text: transcript,
            },
          ],
        },
      } as unknown as Memory,
      "messages"
    );

    const db = adapter.getDatabase() as DrizzleDatabase;
    const row = (await db.select().from(memoryTable).where(eq(memoryTable.id, memoryId)))[0];
    const attachments = (row.content as { attachments: Array<{ id: string; text: string }> })
      .attachments;
    expect(isSegmentedContentMarker(attachments[0].text)).toBe(true);
    const descriptor = (
      row.metadata as {
        segmentation?: Record<string, { revision: string; totalBytes: number }>;
      }
    )?.segmentation?.[`attachment.text:${attachmentId}`];
    expect(descriptor).toBeDefined();
    expect(descriptor!.totalBytes).toBe(Buffer.byteLength(transcript, "utf8"));

    const page = await adapter.getMemoryContentPage({
      memoryId,
      field: { kind: "attachment.text", attachmentId },
      byteStart: 0,
      byteLimit: 32 * 1024,
    });
    expect(page).not.toBeNull();
    expect(page!.total).toBe(Buffer.byteLength(transcript, "utf8"));
    expect(page!.revision).toBe(descriptor!.revision);
    const transcriptBytes = Buffer.from(transcript, "utf8");
    let expectedEnd2 = Math.min(32 * 1024, transcriptBytes.length);
    while (expectedEnd2 > 0 && (transcriptBytes[expectedEnd2] & 0xc0) === 0x80) {
      expectedEnd2 -= 1;
    }
    expect(page!.end).toBe(expectedEnd2);
    expect(Buffer.from(page!.text, "utf8").equals(transcriptBytes.subarray(0, expectedEnd2))).toBe(
      true
    );

    await adapter.close();
    await manager.close();
  });
});
