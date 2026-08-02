/** Unit tests for createDocumentServiceSink: scope binding, idempotent clientDocumentId derivation, and status mapping against an in-memory fake DocumentService. */

import { describe, expect, it } from "vitest";
import type { SinkDocument } from "../core/sink.ts";
import {
  createDocumentServiceSink,
  type DocumentServiceAddOptions,
  type DocumentServiceAddResult,
  type DocumentServiceLike,
  defaultImportClientDocumentId,
} from "./document-service.ts";

class FakeDocumentService implements DocumentServiceLike {
  readonly added: DocumentServiceAddOptions[] = [];
  readonly deleted: string[] = [];
  nextResult: DocumentServiceAddResult = {
    clientDocumentId: "client-doc",
    storedDocumentMemoryId: "stored-doc",
    fragmentCount: 2,
  };

  async addDocument(
    options: DocumentServiceAddOptions,
  ): Promise<DocumentServiceAddResult> {
    this.added.push(options);
    return this.nextResult;
  }

  async deleteDocument(documentId: string): Promise<void> {
    this.deleted.push(documentId);
  }
}

function doc(overrides: Partial<SinkDocument> = {}): SinkDocument {
  return {
    content: "# Imported transcript\n\nhello",
    contentType: "text/markdown",
    originalFilename: "chatgpt/c1.md",
    scope: "user-private",
    scopedToEntityId: "user-42",
    addedFrom: "import",
    metadata: {
      import: { source: "chatgpt", sourceConversationId: "c1" },
      tags: ["import", "import:chatgpt"],
    },
    ...overrides,
  };
}

describe("createDocumentServiceSink", () => {
  it("maps SinkDocument fields into DocumentService.addDocument", async () => {
    const service = new FakeDocumentService();
    const sink = createDocumentServiceSink(service, {
      agentId: "agent-1",
      worldId: "world-1",
      roomId: "room-1",
      entityId: "entity-1",
      addedBy: "owner-1",
      addedByRole: "OWNER",
    });

    const result = await sink.addDocument(doc());

    expect(result).toEqual({ id: "stored-doc", status: "stored" });
    expect(service.added).toHaveLength(1);
    expect(service.added[0]).toMatchObject({
      agentId: "agent-1",
      worldId: "world-1",
      roomId: "room-1",
      entityId: "entity-1",
      contentType: "text/markdown",
      originalFilename: "chatgpt/c1.md",
      content: "# Imported transcript\n\nhello",
      scope: "user-private",
      scopedToEntityId: "user-42",
      addedBy: "owner-1",
      addedByRole: "OWNER",
      addedFrom: "import",
      metadata: {
        import: { source: "chatgpt", sourceConversationId: "c1" },
        tags: ["import", "import:chatgpt"],
      },
    });
    expect(service.added[0]?.clientDocumentId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it("uses context defaults when the sink document omits optional provenance", async () => {
    const service = new FakeDocumentService();
    const sink = createDocumentServiceSink(service, {
      worldId: "world-1",
      roomId: "room-1",
      entityId: "entity-1",
      scopedToEntityId: "fallback-user",
      addedFrom: "upload",
    });

    await sink.addDocument(
      doc({ addedFrom: undefined, scopedToEntityId: undefined }),
    );

    expect(service.added[0]).toMatchObject({
      scopedToEntityId: "fallback-user",
      addedFrom: "upload",
    });
  });

  it("allows callers to map a DocumentService result into skipped status", async () => {
    const service = new FakeDocumentService();
    service.nextResult = {
      clientDocumentId: "existing-doc",
      storedDocumentMemoryId: "existing-doc",
      fragmentCount: 3,
    };
    const sink = createDocumentServiceSink(service, {
      worldId: "world-1",
      roomId: "room-1",
      entityId: "entity-1",
      statusFromResult: (result) =>
        result.clientDocumentId === "existing-doc" ? "skipped" : "stored",
    });

    await expect(sink.addDocument(doc())).resolves.toEqual({
      id: "existing-doc",
      status: "skipped",
    });
  });

  it("delegates deleteDocument for uninstallBatch", async () => {
    const service = new FakeDocumentService();
    const sink = createDocumentServiceSink(service, {
      worldId: "world-1",
      roomId: "room-1",
      entityId: "entity-1",
    });

    await sink.deleteDocument("doc-123");

    expect(service.deleted).toEqual(["doc-123"]);
  });

  it("throws when addDocument returns no usable document id", async () => {
    const service = new FakeDocumentService();
    service.nextResult = { fragmentCount: 0 };
    const sink = createDocumentServiceSink(service, {
      worldId: "world-1",
      roomId: "room-1",
      entityId: "entity-1",
    });

    await expect(sink.addDocument(doc())).rejects.toThrow(
      /storedDocumentMemoryId or clientDocumentId/,
    );
  });
});

describe("defaultImportClientDocumentId", () => {
  it("is stable for identical sink documents and changes with content", () => {
    const first = defaultImportClientDocumentId(doc());
    const again = defaultImportClientDocumentId(doc());
    const changed = defaultImportClientDocumentId(doc({ content: "changed" }));

    expect(first).toBe(again);
    expect(first).not.toBe(changed);
  });
});
