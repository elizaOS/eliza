/**
 * Reviewer-requested scenario proof for #25140 (PR #29754): one real
 * agent-memory write carrying a 192 KiB multibyte message plus 10 attachments
 * (7 oversized, 3 inline-small) through the BaseDrizzleAdapter path on real
 * PGlite, then the same stored message read back through the production
 * MESSAGE action caller path (messageAction handler, op=read_channel with a
 * memory reference) over a real AgentRuntime. Asserts the lossless pagination
 * contract end-to-end: bounded inline markers (never source bytes), exact
 * memory_text_segments row counts per field and generation with per-row
 * SHA-256 digests and segment indices, monotone non-overlapping ordered pages
 * with code-point-boundary snapping and a positive-progress completeness
 * invariant, byte-exact reassembly of every oversized field, small-field
 * null-page fallback, and caller-visible pages from the action boundary.
 * Real-harness: production adapter, migration service, AgentRuntime, and
 * action handler; no mocks.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  AgentRuntime,
  isSegmentedContentMarker,
  logger,
  type Memory,
  messageAction,
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
import { memoryTextSegmentTable } from "../../schema/memoryTextSegments";
import type { DrizzleDatabase } from "../../types";

const tempDirectories: string[] = [];
/** Open handles tracked for afterEach teardown so assertion failures cannot leak them. */
const openHandles: Array<{ close(): Promise<void> }> = [];

async function openDatabase(dataDir: string, agentId: UUID) {
  const manager = new PGliteClientManager({ dataDir });
  // Track the manager before initialization so a failure inside initialize()
  // or adapter.init() still leaves afterEach able to close what opened.
  openHandles.push(manager);
  await manager.initialize();
  const adapter = new PgliteDatabaseAdapter(agentId, manager);
  openHandles.push(adapter);
  await adapter.init();
  return { adapter, manager };
}

async function migrate(adapter: PgliteDatabaseAdapter) {
  const migrations = new DatabaseMigrationService();
  await migrations.initializeWithDatabase(adapter.getDatabase() as DrizzleDatabase);
  migrations.discoverAndRegisterPluginSchemas([sqlPlugin]);
  await migrations.runAllPluginMigrations();
}

/** Deterministic multibyte source so byte math is exercised, not skipped. */
function largeSource(byteLength: number, salt: string): string {
  const unit = `seg-${salt} segurança שלום 🌏 test `;
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
    name: "Scenario paging",
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
  await adapter.createRooms([
    {
      id: roomId,
      agentId,
      name: "Scenario paging room",
      source: "test",
      type: "direct" as never,
      worldId: undefined,
      channelId: undefined,
    },
  ]);
  await adapter.createEntities([{ id: entityId, agentId, names: ["user"] }]);
  // The agent itself joins the room so it can later read its own stored
  // message through the MESSAGE action with a resolved AGENT role.
  await adapter.createEntities([{ id: agentId, agentId, names: ["agent"] }]);
  await adapter.createRoomParticipants([entityId, agentId], roomId);
  return { roomId, entityId };
}

/** Code-point-safe expected page end mirroring the production snap rule. */
function expectedCodePointEnd(sourceBytes: Buffer, limit: number): number {
  let end = Math.min(limit, sourceBytes.length);
  while (end > 0 && (sourceBytes[end] & 0xc0) === 0x80) {
    end -= 1;
  }
  return end;
}

describe("scenario: agent memory path across boundaries (real PGlite)", () => {
  afterEach(async () => {
    // error-policy:J6 teardown-only close failures are warned and reported,
    // never swallowed: every handle is still attempted so one failure cannot
    // leak the rest, and the warning surfaces the leak instead of hiding it.
    for (const handle of openHandles.splice(0)) {
      try {
        await handle.close();
      } catch (error) {
        logger.warn(
          "scenario paging test teardown close failed:",
          error instanceof Error ? error.message : String(error)
        );
      }
    }
    for (const directory of tempDirectories.splice(0)) {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("one 192 KiB message + 10 attachments segments losslessly with exact DB row counts, ordered byte-exact pages, and caller-visible reads through the MESSAGE action", async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "eliza-seg-scenario-"));
    tempDirectories.push(dataDir);
    const agentId = v4() as UUID;
    const { adapter, manager } = await openDatabase(dataDir, agentId);
    await migrate(adapter);
    const { roomId, entityId } = await seedRoom(adapter, agentId);

    // --- Scenario payload: one oversized message + 10 attachments (7 oversized + 3 small)
    const messageText = largeSource(192 * 1024, "msg");
    const attachments = Array.from({ length: 10 }, (_, i) => {
      const oversized = i < 7;
      const bytes = oversized ? 129 * 1024 + i * 1024 : 3 * 1024;
      return {
        id: `att-${i}-${v4()}`,
        url: `https://example.com/t${i}.txt`,
        contentType: "text/plain",
        text: largeSource(bytes, `att${i}`),
      };
    });
    const oversized = attachments.filter((_, i) => i < 7);

    const memoryId = await adapter.createMemory(
      {
        entityId,
        roomId,
        agentId,
        content: {
          text: messageText,
          source: "test",
          attachments,
        },
      } as unknown as Memory,
      "messages"
    );
    expect(memoryId).toBeTruthy();

    const db = adapter.getDatabase() as DrizzleDatabase;

    // --- Inline bounded markers, never source bytes, for every segmented field
    const row = (await db.select().from(memoryTable).where(eq(memoryTable.id, memoryId)))[0];
    const storedContent = row.content as {
      text: string;
      attachments: Array<{ id: string; text: string }>;
    };
    expect(isSegmentedContentMarker(storedContent.text)).toBe(true);
    expect(Buffer.byteLength(storedContent.text, "utf8")).toBeLessThan(512);
    for (const att of oversized) {
      const stored = storedContent.attachments.find((a) => a.id === att.id);
      expect(stored, `stored attachment ${att.id}`).toBeDefined();
      expect(isSegmentedContentMarker(stored!.text)).toBe(true);
      expect(Buffer.byteLength(stored!.text, "utf8")).toBeLessThan(512);
    }
    // Small attachments stay inline byte-exact.
    for (const att of attachments.filter((_, i) => i >= 7)) {
      const stored = storedContent.attachments.find((a) => a.id === att.id);
      expect(stored!.text).toBe(att.text);
    }

    // --- DB row-count proof: exactly the expected segments per field exist
    const descriptorOf = (fieldKey: string) =>
      (
        row.metadata as {
          segmentation?: Record<string, { revision: string; totalBytes: number }>;
        }
      )?.segmentation?.[fieldKey];

    const expectedFields: Array<{ fieldKey: string; source: string }> = [
      { fieldKey: "content.text", source: messageText },
      ...oversized.map((att) => ({
        fieldKey: `attachment.text:${att.id}`,
        source: att.text,
      })),
    ];

    const segmentRows = await db.select().from(memoryTextSegmentTable);
    // 128 KiB segments: ceil(bytes / 128 KiB) per oversized field.
    const expectedTotalRows = expectedFields.reduce((sum, f) => {
      const bytes = Buffer.byteLength(f.source, "utf8");
      return sum + Math.ceil(bytes / (128 * 1024));
    }, 0);
    expect(segmentRows.length).toBe(expectedTotalRows);
    // Every segment row belongs to exactly this parent memory.
    expect(segmentRows.every((r) => r.parentId === memoryId)).toBe(true);

    for (const field of expectedFields) {
      const descriptor = descriptorOf(field.fieldKey);
      expect(descriptor, `descriptor for ${field.fieldKey}`).toBeDefined();
      expect(descriptor!.totalBytes).toBe(Buffer.byteLength(field.source, "utf8"));

      // The public revision is `seg:<generation>:<sha>`; rows key on the raw generation.
      const generation = descriptor!.revision.split(":")[1];
      const fieldRows = segmentRows.filter((r) => r.generation === generation);
      const expectedRows = Math.ceil(Buffer.byteLength(field.source, "utf8") / (128 * 1024));
      expect(fieldRows.length, `segment rows for ${field.fieldKey}`).toBe(expectedRows);
      // Ordered, non-overlapping, contiguous byte ranges starting at 0, with
      // segment indices forming an exact 0..n-1 cover.
      const byStart = [...fieldRows].sort((a, b) => a.byteStart - b.byteStart);
      expect(byStart[0].byteStart).toBe(0);
      const indices = byStart.map((r) => r.segmentIndex).sort((a, b) => a - b);
      expect(indices).toEqual(byStart.map((_, i) => i));
      for (let i = 0; i < byStart.length; i++) {
        if (i > 0) expect(byStart[i].byteStart).toBe(byStart[i - 1].byteEnd);
        expect(byStart[i].byteEnd).toBeGreaterThan(byStart[i].byteStart);
      }
      expect(byStart[byStart.length - 1].byteEnd).toBe(Buffer.byteLength(field.source, "utf8"));
      // Each segment's bytes in the DB equal the source slice and its digest
      // matches (row-level losslessness, text included — not just the hash).
      const sourceBytes = Buffer.from(field.source, "utf8");
      for (const seg of byStart) {
        const slice = sourceBytes.subarray(seg.byteStart, seg.byteEnd);
        expect(Buffer.byteLength(seg.text, "utf8")).toBe(slice.length);
        expect(Buffer.compare(Buffer.from(seg.text, "utf8"), slice)).toBe(0);
        expect(seg.segmentSha256).toBe(createHash("sha256").update(slice).digest("hex"));
      }
    }

    // --- Small-field fallback: pages return null (caller sees inline value)
    const smallPage = await adapter.getMemoryContentPage({
      memoryId,
      field: { kind: "attachment.text", attachmentId: attachments[7].id },
      byteStart: 0,
      byteLimit: 32 * 1024,
    });
    expect(smallPage).toBeNull();

    // --- Adapter-level caller-visible pagination across boundaries
    expect(adapter.memoryContentPageCapability).toBe(1);
    const reassemble = async (
      field: { kind: "content.text" } | { kind: "attachment.text"; attachmentId: string }
    ) => {
      const source =
        field.kind === "content.text"
          ? messageText
          : oversized.find((a) => a.id === (field as { attachmentId: string }).attachmentId)!.text;
      const sourceBuffer = Buffer.from(source, "utf8");
      const window = 64 * 1024; // deliberately not segment-aligned
      const parts: Buffer[] = [];
      let cursor = 0;
      let revision: string | undefined;
      let first = true;
      for (;;) {
        const page = await adapter.getMemoryContentPage({
          memoryId,
          field,
          byteStart: cursor,
          byteLimit: window,
          ...(first ? {} : { expectedRevision: revision! }),
        });
        expect(page).not.toBeNull();
        const expectedEnd = expectedCodePointEnd(sourceBuffer, cursor + window);
        expect(page!.start).toBe(cursor);
        // Positive-progress invariant: a data page must advance the cursor
        // (guards against a broken final empty "complete" page pass-through).
        expect(page!.end).toBeGreaterThan(cursor);
        expect(page!.total).toBe(sourceBuffer.length);
        expect(
          Buffer.from(page!.text, "utf8").equals(sourceBuffer.subarray(cursor, expectedEnd))
        ).toBe(true);
        if (first) {
          expect(page!.completeness).toBe("partial-recoverable");
          first = false;
        }
        if (page!.completeness === "complete") {
          // Completeness requires the final page to close the byte range.
          expect(page!.end).toBe(sourceBuffer.length);
        }
        parts.push(Buffer.from(page!.text, "utf8"));
        revision = page!.revision;
        cursor = page!.end;
        if (page!.completeness === "complete") break;
      }
      expect(revision).toBe(
        descriptorOf(
          field.kind === "content.text" ? "content.text" : `attachment.text:${field.attachmentId}`
        )!.revision
      );
      expect(Buffer.concat(parts).equals(sourceBuffer)).toBe(true);
    };

    await reassemble({ kind: "content.text" });
    for (const att of oversized) {
      await reassemble({ kind: "attachment.text", attachmentId: att.id });
    }

    // --- Production caller path: the MESSAGE action over a real AgentRuntime
    const runtime = new AgentRuntime({
      character: { name: "scenario-paging" },
      agentId,
    });
    runtime.registerDatabaseAdapter(adapter);
    expect(runtime.memoryContentPageCapability).toBe(1);
    expect(typeof runtime.getMemoryContentPage).toBe("function");

    const actionParts: Buffer[] = [];
    let actionCursor = 0;
    let actionRevision: string | undefined;
    let actionFirst = true;
    for (;;) {
      const result = await messageAction.handler(
        runtime,
        {
          id: v4() as UUID,
          entityId: agentId,
          agentId,
          roomId,
          content: { text: "read the stored message" },
        } as Memory,
        undefined,
        {
          parameters: {
            action: "read_channel",
            reference: `memory:${memoryId}`,
            offset: actionCursor,
            limit: 48 * 1024,
            ...(actionFirst ? {} : { expectedRevision: actionRevision! }),
          },
        } as never,
        undefined,
        undefined
      );
      expect(result.success).toBe(true);
      const readView = (
        result.data as {
          readView: {
            slice: {
              range: { start: number; end: number; total: number };
              completeness: string;
              revision: string;
            };
          };
        }
      ).readView;
      const expectedEnd = expectedCodePointEnd(
        Buffer.from(messageText, "utf8"),
        actionCursor + 48 * 1024
      );
      expect(readView.slice.range.start).toBe(actionCursor);
      expect(readView.slice.range.end).toBe(expectedEnd);
      expect(readView.slice.range.end).toBeGreaterThan(actionCursor);
      expect(readView.slice.range.total).toBe(Buffer.byteLength(messageText, "utf8"));
      if (actionFirst) {
        expect(readView.slice.completeness).toBe("partial-recoverable");
        actionFirst = false;
      }
      actionParts.push(Buffer.from(result.text ?? "", "utf8"));
      actionRevision = readView.slice.revision;
      actionCursor = readView.slice.range.end;
      if (readView.slice.completeness === "complete") {
        expect(readView.slice.range.end).toBe(Buffer.byteLength(messageText, "utf8"));
        break;
      }
    }
    // The action boundary delivered the caller-visible lossless page stream.
    expect(actionRevision).toBe(descriptorOf("content.text")!.revision);
    expect(Buffer.concat(actionParts).equals(Buffer.from(messageText, "utf8"))).toBe(true);

    // Stale-revision negative assertion through the action boundary: a
    // continuation with the wrong revision must be a typed failure, never a
    // silently re-page from byte 0 or a fresh first page (guards the
    // expectedRevision forwarding through the caller path).
    const staleResult = await messageAction.handler(
      runtime,
      {
        id: v4() as UUID,
        entityId: agentId,
        agentId,
        roomId,
        content: { text: "read the stored message" },
      } as Memory,
      undefined,
      {
        parameters: {
          action: "read_channel",
          reference: `memory:${memoryId}`,
          offset: 1024,
          expectedRevision: "seg:not-the-live-generation",
        },
      } as never,
      undefined,
      undefined
    );
    expect(staleResult).toBeDefined();
    expect(staleResult!.success).toBe(false);
    expect(staleResult!.values).toMatchObject({
      error: "MEMORY_CONTENT_STALE_REVISION",
    });

    // Reference disambiguation: a second stored message in the same room must
    // not satisfy a read pinned to the first by memory reference.
    const decoyText = "small decoy message that stays inline";
    const decoyId = await adapter.createMemory(
      {
        entityId: agentId,
        roomId,
        agentId,
        content: { text: decoyText, source: "test" },
      } as Memory,
      "messages"
    );
    expect(decoyId).not.toBe(memoryId);
    const decoyResult = await messageAction.handler(
      runtime,
      {
        id: v4() as UUID,
        entityId: agentId,
        agentId,
        roomId,
        content: { text: "read the stored message" },
      } as Memory,
      undefined,
      {
        parameters: {
          action: "read_channel",
          reference: `memory:${memoryId}`,
        },
      } as never,
      undefined,
      undefined
    );
    expect(decoyResult).toBeDefined();
    expect(decoyResult!.success).toBe(true);
    // The pinned reference returned the SEGMENTED message's first page, not
    // the decoy's inline text.
    expect(decoyResult!.text).not.toContain(decoyText);
    expect(
      Buffer.from(decoyResult!.text ?? "", "utf8").equals(
        Buffer.from(messageText, "utf8").subarray(
          0,
          expectedCodePointEnd(Buffer.from(messageText, "utf8"), 256 * 1024)
        )
      )
    ).toBe(true);
  });
});
