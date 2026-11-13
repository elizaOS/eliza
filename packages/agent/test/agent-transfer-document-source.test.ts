/** Encrypted agent transfer carries a large document's segmented source text,
 * so the restored document reads back in full through the SQL range API. */
import { randomUUID } from "node:crypto";
import { buildDocumentSourceProjection, type UUID } from "@elizaos/core";
import { createTestRuntime } from "@elizaos/testing/runtime";
import { expect, it } from "vitest";
import { exportAgent, importAgent } from "../src/services/agent-export.ts";

it("restores every source segment of a large document", async () => {
  const fixture = await createTestRuntime({
    characterName: "TransferDocumentSource",
  });
  try {
    const runtime = fixture.runtime;
    const documentId = randomUUID() as UUID;
    const text = "document body line\n".repeat(8000);
    const documentMetadata = {
      type: "document",
      source: "upload",
      scope: "global",
      documentRevision: 0,
      timestamp: Date.now(),
    };
    const projection = buildDocumentSourceProjection({
      text,
      documentId,
      agentId: runtime.agentId,
      roomId: runtime.agentId,
      entityId: runtime.agentId,
      documentMetadata: documentMetadata as never,
    });
    expect(projection.metadata.sourceStorage).toBe("segments");
    expect(projection.segments.length).toBe(3);
    await runtime.createMemory(
      {
        id: documentId,
        agentId: runtime.agentId,
        roomId: runtime.agentId,
        entityId: runtime.agentId,
        content: {
          documentSource: {
            kind: "document-source",
            storage: "segments",
            byteLength: projection.metadata.sourceByteLength,
            fingerprint: projection.metadata.sourceFingerprint,
          },
        },
        metadata: { ...documentMetadata, ...projection.metadata } as never,
      },
      "documents",
    );
    await runtime.createMemories(
      projection.segments.map((memory) => ({
        memory,
        tableName: "document_fragments",
        unique: false,
      })),
    );

    const password = "document-source-transfer-password";
    const bundle = await exportAgent(runtime, password);
    const imported = await importAgent(runtime, bundle, password);
    expect(imported.success).toBe(true);
    const importedAgentId = imported.agentId as UUID;
    if (!runtime.adapter.withAgentScope) throw Error("Missing scoped adapter");
    const read = await runtime.adapter.withAgentScope(
      importedAgentId,
      async (db) => {
        const [document] = await db.getMemories({
          agentId: importedAgentId,
          tableName: "documents",
        });
        if (!document?.id || !db.readDocumentRange) {
          throw Error("Imported document is not readable");
        }
        return db.readDocumentRange({
          agentId: importedAgentId,
          requesterEntityId: importedAgentId,
          requesterRoomIds: [],
          requesterRole: "OWNER",
          documentId: document.id,
          unit: "byte",
          offset: 0,
          limit: projection.metadata.sourceByteLength,
        });
      },
    );
    expect(read?.returnedSourceSegments).toBe(3);
    expect(read?.text).toBe(text);
  } finally {
    await fixture.cleanup();
  }
}, 180_000);

/** A leading UTF-8 BOM must survive segmentation and byte-page reads.
 * Without `ignoreBOM`, the shared decoder strips the BOM from the first
 * segment, so its text is 3 bytes shorter than its stored byte span and
 * hash, and the read fails with DOCUMENT_SOURCE_CORRUPT. The same strip
 * also loses the BOM from a byte page that starts at offset 0. */
it("restores a BOM document across 64 KiB segments and byte pages", async () => {
  const fixture = await createTestRuntime({
    characterName: "TransferDocumentSourceBom",
  });
  try {
    const runtime = fixture.runtime;
    const documentId = randomUUID() as UUID;
    const text = `\uFEFF${"document body line\n".repeat(8000)}`;
    const documentMetadata = {
      type: "document",
      source: "upload",
      scope: "global",
      documentRevision: 0,
      timestamp: Date.now(),
    };
    const projection = buildDocumentSourceProjection({
      text,
      documentId,
      agentId: runtime.agentId,
      roomId: runtime.agentId,
      entityId: runtime.agentId,
      documentMetadata: documentMetadata as never,
    });
    expect(projection.metadata.sourceByteLength).toBe(152_003);
    expect(projection.segments.length).toBe(3);
    // BOM start and 64 KiB boundary: every segment's decoded text must
    // round-trip to exactly its stored byte span.
    for (const segment of projection.segments) {
      const metadata = segment.metadata as unknown as {
        sourceByteStart: number;
        sourceByteEnd: number;
      };
      expect(new TextEncoder().encode(segment.content.text ?? "").length).toBe(
        metadata.sourceByteEnd - metadata.sourceByteStart,
      );
    }
    const firstSegment = projection.segments[0];
    const secondSegment = projection.segments[1];
    if (!firstSegment || !secondSegment) {
      throw Error("Missing projected segments");
    }
    expect(
      (
        firstSegment.metadata as unknown as {
          sourceByteEnd: number;
        }
      ).sourceByteEnd,
    ).toBe(65_536);
    expect(
      (
        secondSegment.metadata as unknown as {
          sourceByteStart: number;
        }
      ).sourceByteStart,
    ).toBe(65_536);
    await runtime.createMemory(
      {
        id: documentId,
        agentId: runtime.agentId,
        roomId: runtime.agentId,
        entityId: runtime.agentId,
        content: {
          documentSource: {
            kind: "document-source",
            storage: "segments",
            byteLength: projection.metadata.sourceByteLength,
            fingerprint: projection.metadata.sourceFingerprint,
          },
        },
        metadata: { ...documentMetadata, ...projection.metadata } as never,
      },
      "documents",
    );
    await runtime.createMemories(
      projection.segments.map((memory) => ({
        memory,
        tableName: "document_fragments",
        unique: false,
      })),
    );

    const password = "document-source-transfer-password";
    const bundle = await exportAgent(runtime, password);
    const imported = await importAgent(runtime, bundle, password);
    expect(imported.success).toBe(true);
    const importedAgentId = imported.agentId as UUID;
    // Bind the adapter method: calling it unbound loses `this`, and the
    // scoped read then fails with "Agent scope requires a SQL transaction".
    const withAgentScope = runtime.adapter.withAgentScope?.bind(
      runtime.adapter,
    );
    if (!withAgentScope) throw Error("Missing scoped adapter");
    const readBytePage = async (offset: number, limit: number) =>
      withAgentScope(importedAgentId, async (db) => {
        const [document] = await db.getMemories({
          agentId: importedAgentId,
          tableName: "documents",
        });
        if (!document?.id || !db.readDocumentRange) {
          throw Error("Imported document is not readable");
        }
        return db.readDocumentRange({
          agentId: importedAgentId,
          requesterEntityId: importedAgentId,
          requesterRoomIds: [],
          requesterRole: "OWNER",
          documentId: document.id,
          unit: "byte",
          offset,
          limit,
        });
      });
    const read = await readBytePage(0, projection.metadata.sourceByteLength);
    expect(read?.returnedSourceSegments).toBe(3);
    expect(read?.text).toBe(text);
    // Byte page starting at offset 0: the first 10 stored bytes are the
    // 3-byte BOM plus "documen", and the BOM must still be in the text.
    const firstPage = await readBytePage(0, 10);
    expect(firstPage?.text).toBe("\uFEFFdocumen");
    expect(firstPage?.end).toBe(10);
  } finally {
    await fixture.cleanup();
  }
}, 180_000);
