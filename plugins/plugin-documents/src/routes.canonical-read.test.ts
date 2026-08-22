/**
 * Proves single-document and fragment REST reads cross the canonical
 * access-context-aware document service before any parent or fragment bytes.
 */
import type { AccessContext, Memory, UUID } from "@elizaos/core";
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
  getDocumentByIdWithAccessContext: vi.fn(),
  listDocumentFragmentsWithAccessContext: vi.fn(),
  getMemories: vi.fn(),
}));

vi.mock("@elizaos/agent/api/documents-service-loader", () => ({
  getDocumentsService: vi.fn(async () => ({ service })),
}));

function context(pathname: string): {
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
    method: "GET",
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
    readJsonBody: vi.fn(async () => null),
  } as unknown as DocumentRouteContext;
  return { ctx, response, getMemoryById };
}

describe("canonical document REST reads", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    service.getDocumentByIdWithAccessContext.mockResolvedValue(document);
    service.listDocumentFragmentsWithAccessContext.mockResolvedValue([
      fragment,
    ]);
    service.getMemories.mockResolvedValue([]);
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
});
