/**
 * Proves document REST reads and mutations cross the canonical
 * access-context-aware service before parent, fragment, or mutation access.
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
const FRAGMENT_ID = "00000000-0000-0000-0000-0000000000ee" as UUID;
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
const fragment: Memory = {
  id: FRAGMENT_ID,
  agentId: AGENT_ID,
  entityId: USER_ID,
  roomId: ROOM_ID,
  createdAt: 1_001,
  content: { text: "fragment bytes" },
  metadata: {
    type: "fragment",
    documentId: DOCUMENT_ID,
    documentRevision: 1,
    position: 0,
  } as Memory["metadata"],
};

const service = vi.hoisted(() => ({
  listAllDocumentsWithAccessContext: vi.fn(),
  getDocumentByIdWithAccessContext: vi.fn(),
  getMutableDocumentWithAccessContext: vi.fn(),
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
  requestBody: unknown = null,
): {
  ctx: DocumentRouteContext;
  response: { status: number; body: unknown };
  getMemoryById: ReturnType<typeof vi.fn>;
} {
  const response = { status: 0, body: undefined as unknown };
  const getMemoryById = vi.fn(async () => {
    throw new Error("raw parent read must not execute");
  });
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
      getMemoryById,
    },
    json: (_res: unknown, body: unknown, status = 200) => {
      response.status = status;
      response.body = body;
    },
    error: (_res: unknown, message: string, status = 400) => {
      response.status = status;
      response.body = { error: message };
    },
    readJsonBody: vi.fn(async () => requestBody),
  } as unknown as DocumentRouteContext;
  return { ctx, response, getMemoryById };
}

describe("canonical document REST reads", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    service.getDocumentByIdWithAccessContext.mockResolvedValue(document);
    service.listAllDocumentsWithAccessContext.mockResolvedValue([document]);
    service.getMutableDocumentWithAccessContext.mockResolvedValue(document);
    service.setDocumentDirectGrantsWithAccessContext.mockResolvedValue({
      ...document,
      metadata: {
        ...document.metadata,
        directGrantEntityIds: [USER_ID],
      },
    });
    service.getDocumentDirectGrantsWithAccessContext.mockResolvedValue([
      USER_ID,
    ]);
    service.listDocumentFragmentsWithAccessContext.mockResolvedValue([
      fragment,
    ]);
    service.getMemories.mockResolvedValue([]);
    service.updateDocument.mockResolvedValue({
      documentId: DOCUMENT_ID,
      fragmentCount: 1,
    });
    service.deleteDocumentWithAccessContext.mockResolvedValue(undefined);
  });

  it("lists parents and counts fragments only through authorized service methods", async () => {
    const { ctx, response, getMemoryById } = context("/api/documents");

    await expect(handleDocumentsRoutes(ctx)).resolves.toBe(true);

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      total: 1,
      documents: [{ id: DOCUMENT_ID, fragmentCount: 1 }],
    });
    expect(service.listAllDocumentsWithAccessContext).toHaveBeenCalledWith(
      accessContext,
    );
    expect(service.listDocumentFragmentsWithAccessContext).toHaveBeenCalledWith(
      DOCUMENT_ID,
      accessContext,
    );
    expect(getMemoryById).not.toHaveBeenCalled();
    expect(service.getMemories).not.toHaveBeenCalled();
  });

  it("computes facets only from the canonically authorized document set", async () => {
    const { ctx, response } = context("/api/documents/facets");

    await expect(handleDocumentsRoutes(ctx)).resolves.toBe(true);

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ counts: { all: 1, doc: 1 } });
    expect(service.listAllDocumentsWithAccessContext).toHaveBeenCalledWith(
      accessContext,
    );
    expect(service.getMemories).not.toHaveBeenCalled();
  });

  it("reads a parent and its count only through authorized service methods", async () => {
    const { ctx, response, getMemoryById } = context(
      `/api/documents/${DOCUMENT_ID}`,
    );

    await expect(handleDocumentsRoutes(ctx)).resolves.toBe(true);

    expect(response.status).toBe(200);
    expect(service.getDocumentByIdWithAccessContext).toHaveBeenCalledWith(
      DOCUMENT_ID,
      accessContext,
    );
    expect(service.listDocumentFragmentsWithAccessContext).toHaveBeenCalledWith(
      DOCUMENT_ID,
      accessContext,
    );
    expect(getMemoryById).not.toHaveBeenCalled();
    expect(service.getMemories).not.toHaveBeenCalled();
  });

  it("loads fragment bytes only after the parent passes canonical authorization", async () => {
    const { ctx, response, getMemoryById } = context(
      `/api/documents/${DOCUMENT_ID}/fragments`,
    );

    await expect(handleDocumentsRoutes(ctx)).resolves.toBe(true);

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      documentId: DOCUMENT_ID,
      count: 1,
      fragments: [{ id: FRAGMENT_ID, text: "fragment bytes" }],
    });
    expect(service.getDocumentByIdWithAccessContext).toHaveBeenCalledBefore(
      service.listDocumentFragmentsWithAccessContext,
    );
    expect(getMemoryById).not.toHaveBeenCalled();
    expect(service.getMemories).not.toHaveBeenCalled();
  });

  it("updates through the canonical mutation authority without a raw parent read", async () => {
    const { ctx, response, getMemoryById } = context(
      `/api/documents/${DOCUMENT_ID}`,
      "PATCH",
      {
        content: "updated bytes",
        metadata: { directGrantEntityIds: [USER_ID] },
      },
    );

    await expect(handleDocumentsRoutes(ctx)).resolves.toBe(true);

    expect(response.status).toBe(200);
    expect(service.getMutableDocumentWithAccessContext).toHaveBeenCalledWith(
      DOCUMENT_ID,
      accessContext,
    );
    expect(service.updateDocument).toHaveBeenCalledWith({
      documentId: DOCUMENT_ID,
      content: "updated bytes",
      accessContext,
    });
    expect(getMemoryById).not.toHaveBeenCalled();
  });

  it("deletes atomically through DocumentService without raw fragment mutation", async () => {
    const { ctx, response, getMemoryById } = context(
      `/api/documents/${DOCUMENT_ID}`,
      "DELETE",
    );

    await expect(handleDocumentsRoutes(ctx)).resolves.toBe(true);

    expect(response.status).toBe(200);
    expect(service.deleteDocumentWithAccessContext).toHaveBeenCalledWith(
      DOCUMENT_ID,
      accessContext,
    );
    expect(response.body).toMatchObject({ ok: true, deletedFragments: 1 });
    expect(getMemoryById).not.toHaveBeenCalled();
    expect(service.deleteMemory).not.toHaveBeenCalled();
  });

  it("replaces direct grants only through the canonical ACL authority", async () => {
    const { ctx, response, getMemoryById } = context(
      `/api/documents/${DOCUMENT_ID}/access`,
      "PATCH",
      { directGrantEntityIds: [USER_ID] },
    );

    await expect(handleDocumentsRoutes(ctx)).resolves.toBe(true);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      ok: true,
      documentId: DOCUMENT_ID,
      directGrantEntityIds: [USER_ID],
    });
    expect(
      service.setDocumentDirectGrantsWithAccessContext,
    ).toHaveBeenCalledWith(DOCUMENT_ID, [USER_ID], accessContext);
    expect(service.getMutableDocumentWithAccessContext).not.toHaveBeenCalled();
    expect(getMemoryById).not.toHaveBeenCalled();
  });

  it("reads direct grants only through the canonical management authority", async () => {
    const { ctx, response, getMemoryById } = context(
      `/api/documents/${DOCUMENT_ID}/access`,
    );

    await expect(handleDocumentsRoutes(ctx)).resolves.toBe(true);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      documentId: DOCUMENT_ID,
      directGrantEntityIds: [USER_ID],
    });
    expect(
      service.getDocumentDirectGrantsWithAccessContext,
    ).toHaveBeenCalledWith(DOCUMENT_ID, accessContext);
    expect(getMemoryById).not.toHaveBeenCalled();
  });

  it("rejects malformed grant payloads before any canonical or raw storage access", async () => {
    const { ctx, response, getMemoryById } = context(
      `/api/documents/${DOCUMENT_ID}/access`,
      "PATCH",
      { directGrantEntityIds: "not-an-array" },
    );

    await expect(handleDocumentsRoutes(ctx)).resolves.toBe(true);

    expect(response.status).toBe(400);
    expect(
      service.setDocumentDirectGrantsWithAccessContext,
    ).not.toHaveBeenCalled();
    expect(getMemoryById).not.toHaveBeenCalled();
  });

  it("translates canonical grant denial without falling back to a raw mutation", async () => {
    service.setDocumentDirectGrantsWithAccessContext.mockRejectedValueOnce(
      new ElizaError("Requester cannot manage document grants", {
        code: "DOCUMENT_GRANT_MUTATION_FORBIDDEN",
      }),
    );
    const { ctx, response, getMemoryById } = context(
      `/api/documents/${DOCUMENT_ID}/access`,
      "PATCH",
      { directGrantEntityIds: [] },
    );

    await expect(handleDocumentsRoutes(ctx)).resolves.toBe(true);

    expect(response.status).toBe(403);
    expect(getMemoryById).not.toHaveBeenCalled();
  });
});
