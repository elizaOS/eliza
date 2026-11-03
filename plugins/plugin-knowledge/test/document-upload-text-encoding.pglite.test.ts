import { randomUUID } from "node:crypto";
import {
  buildDocumentSourceProjection,
  DOCUMENT_PARENT_INLINE_MAX_BYTES,
  type IAgentRuntime,
  type UUID,
} from "@elizaos/core";
import type { RouteHandlerContext } from "@elizaos/host/protocol";
import { DocumentService } from "@elizaos/plugin-assistant";
import { createTestRuntime } from "@elizaos/testing/runtime";
import { expect, it } from "vitest";
import { documentsRoutes } from "../src/plugin.ts";

function routeFor(type: string, path: string) {
  const route = documentsRoutes.find(
    (candidate) => candidate.type === type && candidate.path === path,
  );
  if (!route?.routeHandler) throw new Error(`missing route ${type} ${path}`);
  return route.routeHandler;
}

function context(
  runtime: IAgentRuntime,
  method: string,
  path: string,
  body?: unknown,
): RouteHandlerContext {
  return {
    signal: new AbortController().signal,
    body,
    params: {},
    query: {},
    headers: { host: "localhost" },
    method,
    path,
    runtime,
    inProcess: false,
    isTrustedLocal: true,
  };
}

it("stores text files the browser labels with a binary MIME as their literal text", async () => {
  const owner = randomUUID() as UUID;
  const fixture = await createTestRuntime({
    characterName: "UploadTextEncoding",
    settings: { ELIZA_ADMIN_ENTITY_ID: owner },
  });
  try {
    const { runtime } = fixture;
    await runtime.createEntity({
      id: owner,
      names: ["Owner"],
      agentId: runtime.agentId,
    });
    await runtime.registerService(DocumentService);
    const files = [
      {
        filename: "export.csv",
        contentType: "application/vnd.ms-excel",
        content: "name,team\nAlice,Ops\nBob,Sales",
      },
      {
        filename: "notes.txt",
        contentType: "application/octet-stream",
        content: "Meet the vendor on Tuesday.",
      },
    ];

    const upload = await routeFor(
      "POST",
      "/api/documents/bulk",
    )(
      context(runtime, "POST", "/api/documents/bulk", {
        documents: files.map((file) => ({
          ...file,
          scope: "owner-private",
          metadata: { includeImageDescriptions: false },
        })),
      }),
    );
    expect(upload.status).toBe(200);
    const results = (
      upload.body as {
        results: Array<{ ok: boolean; documentId?: string; error?: string }>;
      }
    ).results;
    expect(results.map(({ ok, error }) => ({ ok, error }))).toEqual([
      { ok: true, error: undefined },
      { ok: true, error: undefined },
    ]);

    const storedTexts = [];
    for (const result of results) {
      const fragments = await routeFor(
        "GET",
        "/api/documents/:id/fragments",
      )(
        context(
          runtime,
          "GET",
          `/api/documents/${result.documentId}/fragments`,
        ),
      );
      expect(fragments.status).toBe(200);
      storedTexts.push(
        (fragments.body as { fragments: Array<{ text: string }> }).fragments
          .map((fragment) => fragment.text)
          .join("\n"),
      );
    }
    expect(storedTexts).toEqual([
      "name,team\nAlice,Ops\nBob,Sales",
      "Meet the vendor on Tuesday.",
    ]);
  } finally {
    await fixture.cleanup();
  }
}, 120_000);

it("returns the text of a note whose letters happen to look like base64", async () => {
  const owner = randomUUID() as UUID;
  const fixture = await createTestRuntime({
    characterName: "UploadTextPreview",
    settings: { ELIZA_ADMIN_ENTITY_ID: owner },
  });
  try {
    const { runtime } = fixture;
    await runtime.createEntity({
      id: owner,
      names: ["Owner"],
      agentId: runtime.agentId,
    });
    await runtime.registerService(DocumentService);
    // 24 letters once the spaces go, no punctuation: base64-shaped, but text.
    const text = "Remember to call the dentist";

    const upload = await routeFor(
      "POST",
      "/api/documents",
    )(
      context(runtime, "POST", "/api/documents", {
        filename: "todo.txt",
        contentType: "text/plain",
        content: text,
        scope: "owner-private",
        metadata: { includeImageDescriptions: false },
      }),
    );
    expect(upload.status).toBe(200);
    const documentId = (upload.body as { documentId: string }).documentId;

    const detail = await routeFor(
      "GET",
      "/api/documents/:id",
    )(context(runtime, "GET", `/api/documents/${documentId}`));
    expect(detail.status).toBe(200);
    const document = (
      detail.body as {
        document: { canEditText: boolean; content?: { text?: string } };
      }
    ).document;
    expect({
      canEditText: document.canEditText,
      content: document.content,
    }).toEqual({ canEditText: true, content: { text } });
  } finally {
    await fixture.cleanup();
  }
}, 120_000);

it("returns and edits the full text of segmented documents over 64 KiB", async () => {
  const owner = randomUUID() as UUID;
  const fixture = await createTestRuntime({
    characterName: "SegmentedDocumentDetail",
    settings: { ELIZA_ADMIN_ENTITY_ID: owner },
  });
  try {
    const { runtime } = fixture;
    await runtime.createEntity({
      id: owner,
      names: ["Owner"],
      agentId: runtime.agentId,
    });
    await runtime.registerService(DocumentService);

    const buildSegmentedText = (minBytes: number, heading: string) => {
      const prefix = `# ${heading}\n\n`;
      const line =
        "Segmented checklist entry — UTF-8 verification café résumé.\n";
      const count = Math.ceil(
        (minBytes - Buffer.byteLength(prefix, "utf8")) /
          Buffer.byteLength(line, "utf8"),
      );
      return (prefix + line.repeat(count)).trim();
    };

    const initialText = buildSegmentedText(
      DOCUMENT_PARENT_INLINE_MAX_BYTES + 16_384,
      "Segmented Architecture Handbook",
    );
    const upload = await routeFor(
      "POST",
      "/api/documents",
    )(
      context(runtime, "POST", "/api/documents", {
        filename: "architecture-handbook.md",
        contentType: "text/markdown",
        content: initialText,
        scope: "owner-private",
        metadata: { includeImageDescriptions: false },
      }),
    );
    expect(upload.status).toBe(200);
    const documentId = (upload.body as { documentId: string }).documentId;

    const detail = await routeFor(
      "GET",
      "/api/documents/:id",
    )(context(runtime, "GET", `/api/documents/${documentId}`));
    expect(detail.status).toBe(200);
    expect(
      (
        detail.body as {
          document: { canEditText: boolean; content?: { text?: string } };
        }
      ).document,
    ).toMatchObject({
      canEditText: true,
      content: { text: initialText },
    });

    const updatedText = buildSegmentedText(
      DOCUMENT_PARENT_INLINE_MAX_BYTES + 24_576,
      "Segmented Architecture Handbook v2",
    );
    const patch = await routeFor(
      "PATCH",
      "/api/documents/:id",
    )(
      context(runtime, "PATCH", `/api/documents/${documentId}`, {
        content: updatedText,
      }),
    );
    expect(patch.status).toBe(200);

    const editedDetail = await routeFor(
      "GET",
      "/api/documents/:id",
    )(context(runtime, "GET", `/api/documents/${documentId}`));
    expect(editedDetail.status).toBe(200);
    expect(
      (
        editedDetail.body as {
          document: { canEditText: boolean; content?: { text?: string } };
        }
      ).document,
    ).toMatchObject({
      canEditText: true,
      content: { text: updatedText },
    });

    // Segmented text records restored without an explicit textBacked boolean
    // (such as transferred or internal documents) remain readable and editable.
    const restoredId = randomUUID() as UUID;
    const restoredText = buildSegmentedText(
      DOCUMENT_PARENT_INLINE_MAX_BYTES + 12_000,
      "Restored Operations Runbook",
    );
    const restoredMetadata = {
      type: "document",
      source: "upload",
      filename: "document-note.txt",
      fileType: "text/plain",
      contentType: "text/plain",
      fileSize: Buffer.byteLength(restoredText, "utf8"),
      scope: "owner-private",
      scopedToEntityId: owner,
      addedBy: owner,
      addedByRole: "OWNER",
      documentRevision: 0,
      timestamp: Date.now(),
    };
    const projection = buildDocumentSourceProjection({
      text: restoredText,
      documentId: restoredId,
      agentId: runtime.agentId,
      roomId: runtime.agentId,
      entityId: owner,
      worldId: runtime.agentId,
      documentMetadata: restoredMetadata as never,
    });
    await runtime.createMemory(
      {
        id: restoredId,
        agentId: runtime.agentId,
        roomId: runtime.agentId,
        worldId: runtime.agentId,
        entityId: owner,
        createdAt: Date.now(),
        content: {
          documentSource: {
            kind: "document-source",
            storage: "segments",
            byteLength: projection.metadata.sourceByteLength,
            fingerprint: projection.metadata.sourceFingerprint,
          },
        },
        metadata: { ...restoredMetadata, ...projection.metadata } as never,
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

    const restoredList = await routeFor(
      "GET",
      "/api/documents",
    )(context(runtime, "GET", "/api/documents"));
    expect(restoredList.status).toBe(200);
    expect(
      (
        restoredList.body as {
          documents: Array<{ id: string; canEditText: boolean }>;
        }
      ).documents.find((entry) => entry.id === restoredId),
    ).toMatchObject({ id: restoredId, canEditText: true });

    const restoredDetail = await routeFor(
      "GET",
      "/api/documents/:id",
    )(context(runtime, "GET", `/api/documents/${restoredId}`));
    expect(restoredDetail.status).toBe(200);
    expect(
      (
        restoredDetail.body as {
          document: {
            filename: string;
            canEditText: boolean;
            content?: { text?: string };
          };
        }
      ).document,
    ).toMatchObject({
      filename: "Restored Operations Runbook",
      canEditText: true,
      content: { text: restoredText },
    });

    const restoredPatch = await routeFor(
      "PATCH",
      "/api/documents/:id",
    )(
      context(runtime, "PATCH", `/api/documents/${restoredId}`, {
        content: buildSegmentedText(
          DOCUMENT_PARENT_INLINE_MAX_BYTES + 14_000,
          "Restored Operations Runbook Revised",
        ),
      }),
    );
    expect(restoredPatch.status).toBe(200);

    // Binary records with segmented extracted text remain non-editable and
    // do not expose extracted segments as editable document text.
    const binaryId = randomUUID() as UUID;
    const binaryMetadata = {
      type: "document",
      source: "upload",
      filename: "guide.pdf",
      fileType: "application/pdf",
      contentType: "application/pdf",
      textBacked: false,
      fileSize: 4096,
      scope: "owner-private",
      scopedToEntityId: owner,
      addedBy: owner,
      addedByRole: "OWNER",
      documentRevision: 0,
      timestamp: Date.now(),
    };
    const binaryProjection = buildDocumentSourceProjection({
      text: initialText,
      documentId: binaryId,
      agentId: runtime.agentId,
      roomId: runtime.agentId,
      entityId: owner,
      worldId: runtime.agentId,
      documentMetadata: binaryMetadata as never,
    });
    await runtime.createMemory(
      {
        id: binaryId,
        agentId: runtime.agentId,
        roomId: runtime.agentId,
        worldId: runtime.agentId,
        entityId: owner,
        createdAt: Date.now(),
        content: {
          documentSource: {
            kind: "document-source",
            storage: "segments",
            byteLength: binaryProjection.metadata.sourceByteLength,
            fingerprint: binaryProjection.metadata.sourceFingerprint,
          },
          text: Buffer.from("%PDF-1.4 binary payload").toString("base64"),
        },
        metadata: { ...binaryMetadata, ...binaryProjection.metadata } as never,
      },
      "documents",
    );
    await runtime.createMemories(
      binaryProjection.segments.map((memory) => ({
        memory,
        tableName: "document_fragments",
        unique: false,
      })),
    );
    const binaryDetail = await routeFor(
      "GET",
      "/api/documents/:id",
    )(context(runtime, "GET", `/api/documents/${binaryId}`));
    expect(binaryDetail.status).toBe(200);
    const binaryDoc = (
      binaryDetail.body as {
        document: { canEditText: boolean; content?: { text?: string } };
      }
    ).document;
    expect(binaryDoc.canEditText).toBe(false);
    expect(binaryDoc.content).toBeUndefined();
  } finally {
    await fixture.cleanup();
  }
}, 120_000);
