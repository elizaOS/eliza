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
