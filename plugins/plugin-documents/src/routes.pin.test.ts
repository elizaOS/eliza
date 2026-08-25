/**
 * Proves document pin/unpin REST mutations cross the canonical
 * access-context-aware service, map typed pin failures to HTTP statuses, and
 * 503 cleanly when the canonical pin authority is unavailable.
 */
import {
  type AccessContext,
  ElizaError,
  type Memory,
  type UUID,
} from "@elizaos/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DocumentRouteContext } from "./routes.ts";
import { handleDocumentsRoutes } from "./routes.ts";

const AGENT_ID = "00000000-0000-0000-0000-0000000000aa" as UUID;
const USER_ID = "00000000-0000-0000-0000-0000000000bb" as UUID;
const ROOM_ID = "00000000-0000-0000-0000-0000000000cc" as UUID;
const DOCUMENT_ID = "00000000-0000-0000-0000-0000000000dd" as UUID;
const accessContext = {
  requesterEntityId: USER_ID,
  role: "USER",
  isOwner: false,
} satisfies AccessContext;

const document: Memory = {
  id: DOCUMENT_ID,
  agentId: AGENT_ID,
  entityId: USER_ID,
  roomId: ROOM_ID,
  createdAt: 1_000,
  content: { text: "authorized bytes" },
  metadata: {
    type: "document",
    documentId: DOCUMENT_ID,
    scope: "user-private",
    scopedToEntityId: USER_ID,
  } as Memory["metadata"],
};

const service = vi.hoisted(() => ({
  listAllDocumentsWithAccessContext: vi.fn(),
  getDocumentByIdWithAccessContext: vi.fn(),
  getMutableDocumentWithAccessContext: vi.fn(),
  setDocumentPinnedWithAccessContext: vi.fn(),
  setDocumentDirectGrantsWithAccessContext: vi.fn(),
  getDocumentDirectGrantsWithAccessContext: vi.fn(),
  listDocumentFragmentsWithAccessContext: vi.fn(),
  getMemories: vi.fn(),
  updateDocument: vi.fn(),
  deleteDocumentWithAccessContext: vi.fn(),
  deleteMemory: vi.fn(),
}));

vi.mock("@elizaos/agent/api/documents-service-loader", () => ({
  getDocumentsService: vi.fn(async () => ({ service })),
}));

function context(
  pathname: string,
  method = "GET",
): {
  ctx: DocumentRouteContext;
  response: { status: number; body: unknown };
} {
  const response = { status: 0, body: undefined as unknown };
  const ctx = {
    req: { headers: {} },
    res: { setHeader: vi.fn() },
    method,
    pathname,
    url: new URL(`http://local${pathname}`),
    accessContext,
    runtime: {
      agentId: AGENT_ID,
      getSetting: vi.fn(),
      getMemoryById: vi.fn(),
    },
    json: (_res: unknown, body: unknown, status = 200) => {
      response.status = status;
      response.body = body;
    },
    error: (_res: unknown, message: string, status = 400) => {
      response.status = status;
      response.body = { error: message };
    },
    readJsonBody: vi.fn(async () => null),
  } as unknown as DocumentRouteContext;
  return { ctx, response };
}

describe("document pin REST mutations", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    service.setDocumentPinnedWithAccessContext.mockResolvedValue({
      ...document,
      metadata: { ...document.metadata, pinned: true, documentRevision: 1 },
    });
  });

  it("pins via POST /api/documents/:id/pin through the canonical service", async () => {
    const { ctx, response } = context(
      `/api/documents/${DOCUMENT_ID}/pin`,
      "POST",
    );
    const handled = await handleDocumentsRoutes(ctx as never);
    expect(handled).toBe(true);
    expect(service.setDocumentPinnedWithAccessContext).toHaveBeenCalledWith(
      DOCUMENT_ID,
      true,
      accessContext,
    );
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      ok: true,
      documentId: DOCUMENT_ID,
      pinned: true,
      revision: 1,
    });
  });

  it("unpins via DELETE /api/documents/:id/pin through the canonical service", async () => {
    service.setDocumentPinnedWithAccessContext.mockResolvedValueOnce({
      ...document,
      metadata: { ...document.metadata, documentRevision: 1 },
    });
    const { ctx, response } = context(
      `/api/documents/${DOCUMENT_ID}/pin`,
      "DELETE",
    );
    const handled = await handleDocumentsRoutes(ctx as never);
    expect(handled).toBe(true);
    expect(service.setDocumentPinnedWithAccessContext).toHaveBeenCalledWith(
      DOCUMENT_ID,
      false,
      accessContext,
    );
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      ok: true,
      documentId: DOCUMENT_ID,
      pinned: false,
    });
  });

  it("maps DOCUMENT_MUTATION_FORBIDDEN to 403", async () => {
    service.setDocumentPinnedWithAccessContext.mockRejectedValueOnce(
      new ElizaError("Requester cannot mutate this document", {
        code: "DOCUMENT_MUTATION_FORBIDDEN",
      }),
    );
    const { ctx, response } = context(
      `/api/documents/${DOCUMENT_ID}/pin`,
      "POST",
    );
    await handleDocumentsRoutes(ctx as never);
    expect(response.status).toBe(403);
  });

  it("maps DOCUMENT_NOT_FOUND to 404", async () => {
    service.setDocumentPinnedWithAccessContext.mockRejectedValueOnce(
      new ElizaError(`Document ${DOCUMENT_ID} not found`, {
        code: "DOCUMENT_NOT_FOUND",
      }),
    );
    const { ctx, response } = context(
      `/api/documents/${DOCUMENT_ID}/pin`,
      "POST",
    );
    await handleDocumentsRoutes(ctx as never);
    expect(response.status).toBe(404);
  });

  it("maps DOCUMENT_MUTATION_CONFLICT to 409", async () => {
    service.setDocumentPinnedWithAccessContext.mockRejectedValueOnce(
      new ElizaError("Document authorization changed before pin update", {
        code: "DOCUMENT_MUTATION_CONFLICT",
      }),
    );
    const { ctx, response } = context(
      `/api/documents/${DOCUMENT_ID}/pin`,
      "POST",
    );
    await handleDocumentsRoutes(ctx as never);
    expect(response.status).toBe(409);
  });

  it("rejects a malformed document id with 400", async () => {
    const { ctx, response } = context("/api/documents/not-a-uuid/pin", "POST");
    await handleDocumentsRoutes(ctx as never);
    expect(response.status).toBe(400);
    expect(service.setDocumentPinnedWithAccessContext).not.toHaveBeenCalled();
  });

  it("returns 503 when the canonical pin authority is unavailable", async () => {
    const pinCapable = service.setDocumentPinnedWithAccessContext;
    service.setDocumentPinnedWithAccessContext = undefined as never;
    try {
      const { ctx, response } = context(
        `/api/documents/${DOCUMENT_ID}/pin`,
        "POST",
      );
      await handleDocumentsRoutes(ctx as never);
      expect(response.status).toBe(503);
    } finally {
      service.setDocumentPinnedWithAccessContext = pinCapable;
    }
  });

  it("does not handle a GET on the pin route", async () => {
    const { ctx } = context(`/api/documents/${DOCUMENT_ID}/pin`, "GET");
    const handled = await handleDocumentsRoutes(ctx as never);
    expect(handled).toBe(false);
  });
});
