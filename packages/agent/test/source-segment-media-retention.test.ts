/** Large-document source text is stored as document_fragments rows with
 * fragmentRole "source-segment". The SQL list read hides those rows unless
 * the caller asks for that role. getAllMemories is the media GC reference
 * set and the memory wipe, so a hidden row drops a file named only in that
 * text and survives a wipe when its parent document is already gone. */
import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Memory, UUID } from "@elizaos/core";
import { createTestRuntime } from "@elizaos/testing/runtime";
import { expect, it } from "vitest";
import { collectReferencedMedia } from "../src/api/media-runtime.ts";
import {
  gcUnreferencedMedia,
  persistMediaBytes,
  storedMediaFileExists,
} from "../src/api/media-store.ts";

it("keeps media named only in document source text and wipes an orphan source segment", async () => {
  const previousStateDir = process.env.ELIZA_STATE_DIR;
  const stateDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "source-segment-media-"),
  );
  process.env.ELIZA_STATE_DIR = stateDir;
  let fixture: Awaited<ReturnType<typeof createTestRuntime>> | undefined;
  try {
    fixture = await createTestRuntime({
      characterName: "SourceSegmentMedia",
    });
    const runtime = fixture.runtime;
    const stored = persistMediaBytes(
      Buffer.from("source-segment media bytes"),
      "image/png",
    );
    const documentId = randomUUID() as UUID;
    const sourceId = randomUUID() as UUID;
    const chunkId = randomUUID() as UUID;
    const orphanId = randomUUID() as UUID;
    const missingParentId = randomUUID() as UUID;
    const scope = {
      agentId: runtime.agentId,
      roomId: runtime.agentId,
      entityId: runtime.agentId,
    };
    await runtime.createMemory(
      {
        ...scope,
        id: documentId,
        content: {
          documentSource: {
            kind: "document-source",
            storage: "segments",
            byteLength: 128,
            fingerprint: "sha256:parent",
          },
        },
        metadata: {
          type: "document",
          timestamp: Date.now(),
        } as Memory["metadata"],
      },
      "documents",
    );
    await runtime.createMemory(
      {
        ...scope,
        id: sourceId,
        content: {
          text: `The scan is stored at ${stored.url} for this document.`,
        },
        metadata: {
          type: "fragment",
          fragmentRole: "source-segment",
          documentId,
          position: 0,
        } as Memory["metadata"],
      },
      "document_fragments",
    );
    await runtime.createMemory(
      {
        ...scope,
        id: chunkId,
        content: { text: "short embedding chunk without a file link" },
        metadata: {
          type: "fragment",
          fragmentRole: "embedding-chunk",
          documentId,
          position: 0,
        } as Memory["metadata"],
      },
      "document_fragments",
    );
    await runtime.createMemory(
      {
        ...scope,
        id: orphanId,
        content: { text: "orphaned source text that a wipe must remove" },
        metadata: {
          type: "fragment",
          fragmentRole: "source-segment",
          documentId: missingParentId,
          position: 0,
        } as Memory["metadata"],
      },
      "document_fragments",
    );

    const visibleIds = new Set(
      (
        await runtime.getMemories({
          tableName: "document_fragments",
          agentId: runtime.agentId,
        })
      ).map((memory) => memory.id),
    );
    expect(visibleIds.has(chunkId)).toBe(true);
    expect(visibleIds.has(sourceId)).toBe(false);
    expect(visibleIds.has(orphanId)).toBe(false);

    const referenced = collectReferencedMedia(
      await runtime.getAllMemories(),
      runtime,
    );
    expect(referenced.has(stored.fileName)).toBe(true);

    const mediaPath = path.join(stateDir, "media", stored.fileName);
    const aged = new Date(Date.now() - 2 * 60 * 60 * 1000);
    fs.utimesSync(mediaPath, aged, aged);
    gcUnreferencedMedia(referenced);
    expect(storedMediaFileExists(stored.fileName)).toBe(true);

    await runtime.clearAllAgentMemories();
    expect(await runtime.getMemoryById(orphanId)).toBeNull();
    expect(await runtime.getMemoryById(sourceId)).toBeNull();
    expect(
      await runtime.getMemories({
        tableName: "document_fragments",
        agentId: runtime.agentId,
        metadata: { fragmentRole: "source-segment" },
      }),
    ).toEqual([]);
  } finally {
    await fixture?.cleanup();
    fs.rmSync(stateDir, { recursive: true, force: true });
    if (previousStateDir === undefined) delete process.env.ELIZA_STATE_DIR;
    else process.env.ELIZA_STATE_DIR = previousStateDir;
  }
}, 180_000);
