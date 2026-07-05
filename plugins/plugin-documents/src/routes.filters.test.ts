/**
 * Route-level tests for the first-class `roomId` filter and `mediaFormat` facet
 * added in #13593 (knowledge slice 1). Exercises `GET /api/documents` through
 * `handleDocumentsRoutes` with a mock documents service, asserting the new
 * filters compose with tags[] and that access control still applies after
 * filtering (owner-private items don't leak to a non-owner actor).
 */
import type { Memory, UUID } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { type DocumentRouteContext, handleDocumentsRoutes } from "./routes.ts";

const AGENT_ID = "00000000-0000-0000-0000-0000000000aa" as UUID;
const OWNER_ENTITY = "00000000-0000-0000-0000-0000000000b1" as UUID;
const USER_ENTITY = "00000000-0000-0000-0000-0000000000c2" as UUID;
const ROOM_A = "00000000-0000-0000-0000-0000000000d1" as UUID;
const ROOM_B = "00000000-0000-0000-0000-0000000000d2" as UUID;

function docMemory(id: string, metadata: Record<string, unknown>): Memory {
  return {
    id: id as UUID,
    entityId: (metadata.addedBy as UUID) ?? OWNER_ENTITY,
    agentId: AGENT_ID,
    roomId: (metadata.roomId as UUID) ?? ROOM_A,
    createdAt: 1000,
    content: { text: `body-${id}` },
    metadata: { type: "document", ...metadata } as Memory["metadata"],
  };
}

/** Documents spanning two rooms and multiple formats + scopes. */
function seedDocuments(): Memory[] {
  return [
    docMemory("img-a", {
      documentId: "img-a",
      tags: ["attachment", "media-format:image"],
      mediaFormat: "image",
      roomId: ROOM_A,
      scope: "user-private",
      addedBy: USER_ENTITY,
      scopedToEntityId: USER_ENTITY,
    }),
    docMemory("pdf-a", {
      documentId: "pdf-a",
      tags: ["attachment", "media-format:pdf"],
      mediaFormat: "pdf",
      roomId: ROOM_A,
      scope: "user-private",
      addedBy: USER_ENTITY,
      scopedToEntityId: USER_ENTITY,
    }),
    docMemory("img-b", {
      documentId: "img-b",
      tags: ["attachment", "media-format:image"],
      mediaFormat: "image",
      roomId: ROOM_B,
      scope: "user-private",
      addedBy: USER_ENTITY,
      scopedToEntityId: USER_ENTITY,
    }),
    docMemory("owner-secret", {
      documentId: "owner-secret",
      tags: ["attachment", "media-format:pdf"],
      mediaFormat: "pdf",
      roomId: ROOM_A,
      scope: "owner-private",
      addedBy: OWNER_ENTITY,
    }),
  ];
}

function makeRuntimeAndService(docs: Memory[]) {
  let scanned = false;
  const documentsService = {
    getMemories: vi.fn(
      async (params: { tableName: string; offset?: number }) => {
        if (params.tableName !== "documents") return [];
        // Single batch: return all on first call, empty after.
        if (scanned) return [];
        scanned = true;
        return docs;
      },
    ),
    countMemories: vi.fn(async () => docs.length),
    addDocument: vi.fn(),
    searchDocuments: vi.fn(async () => []),
    updateDocument: vi.fn(),
    deleteMemory: vi.fn(),
  };

  const runtime = {
    agentId: AGENT_ID,
    getService: vi.fn((name: string) =>
      name === "documents" ? documentsService : null,
    ),
    getServiceLoadPromise: vi.fn(),
    getSetting: vi.fn((key: string) =>
      key === "ELIZA_ADMIN_ENTITY_ID" ? OWNER_ENTITY : undefined,
    ),
    getMemoryById: vi.fn(async () => null),
  };

  return { runtime, documentsService };
}

async function listDocuments(params: {
  query: string;
  actorEntityId?: UUID;
}): Promise<{ status: number; body: Record<string, unknown> }> {
  const { runtime } = makeRuntimeAndService(seedDocuments());
  const url = new URL(`http://local/api/documents?${params.query}`);

  let captured: { status: number; body: unknown } = { status: 0, body: null };
  const res = {
    setHeader: vi.fn(),
  } as unknown as DocumentRouteContext["res"];

  const headers: Record<string, string> = {};
  if (params.actorEntityId) headers["x-eliza-entity-id"] = params.actorEntityId;

  const ctx = {
    req: { headers } as DocumentRouteContext["req"],
    res,
    method: "GET",
    pathname: "/api/documents",
    url,
    runtime: runtime as never,
    json: (_res: unknown, data: unknown, status = 200) => {
      captured = { status, body: data };
    },
    error: (_res: unknown, message: string, status = 400) => {
      captured = { status, body: { error: message } };
    },
    readJsonBody: async () => null,
  } as unknown as DocumentRouteContext;

  const handled = await handleDocumentsRoutes(ctx);
  expect(handled).toBe(true);
  return {
    status: captured.status,
    body: captured.body as Record<string, unknown>,
  };
}

function docIds(body: Record<string, unknown>): string[] {
  const documents = (body.documents as Array<{ id?: string }>) ?? [];
  return documents.map((d) => d.id ?? "").sort();
}

describe("GET /api/documents — roomId + mediaFormat filters (#13593)", () => {
  it("filters by roomId (composes with post-filter access control)", async () => {
    // The USER owns img-a/pdf-a/img-b (user-private scoped to them). Filtering
    // ROOM_A as that user yields their two ROOM_A items; owner-secret is
    // owner-private and excluded.
    const { body } = await listDocuments({
      query: `roomId=${ROOM_A}`,
      actorEntityId: USER_ENTITY,
    });
    expect(docIds(body)).toEqual(["img-a", "pdf-a"]);
    expect(docIds(body)).not.toContain("img-b"); // ROOM_B excluded by roomId
    expect(docIds(body)).not.toContain("owner-secret"); // owner-private excluded
  });

  it("filters by mediaFormat facet", async () => {
    const { body } = await listDocuments({
      query: "mediaFormat=image",
      actorEntityId: USER_ENTITY,
    });
    expect(docIds(body)).toEqual(["img-a", "img-b"]);
  });

  it("composes roomId + mediaFormat", async () => {
    const { body } = await listDocuments({
      query: `roomId=${ROOM_A}&mediaFormat=pdf`,
      actorEntityId: USER_ENTITY,
    });
    // ROOM_A pdfs the USER can read: pdf-a only (owner-secret is owner-private).
    expect(docIds(body)).toEqual(["pdf-a"]);
  });

  it("composes mediaFormat with a tags[] filter", async () => {
    const { body } = await listDocuments({
      query: "mediaFormat=pdf&tags=attachment",
      actorEntityId: USER_ENTITY,
    });
    expect(docIds(body)).toEqual(["pdf-a"]);
  });

  it("owner can read owner-private items matching the facet", async () => {
    const { body } = await listDocuments({
      query: `roomId=${ROOM_A}&mediaFormat=pdf`,
      actorEntityId: OWNER_ENTITY,
    });
    // Owner reads owner-secret (owner-private); pdf-a belongs to USER, so it is
    // not returned to the owner by default (no scopedToEntityId filter).
    expect(docIds(body)).toEqual(["owner-secret"]);
  });

  it("applies access control AFTER filtering — non-owner never sees owner-private", async () => {
    // USER actor filters ROOM_A pdfs: pdf-a is theirs (user-private scoped to
    // them), owner-secret is owner-private and must be excluded.
    const { body } = await listDocuments({
      query: `roomId=${ROOM_A}&mediaFormat=pdf`,
      actorEntityId: USER_ENTITY,
    });
    expect(docIds(body)).toEqual(["pdf-a"]);
    expect(docIds(body)).not.toContain("owner-secret");
  });

  it("supports the `format` alias for mediaFormat", async () => {
    const { body } = await listDocuments({
      query: "format=image",
      actorEntityId: USER_ENTITY,
    });
    expect(docIds(body)).toEqual(["img-a", "img-b"]);
  });
});

async function requestDocuments(params: {
  pathname: string;
  query: string;
  actorEntityId?: UUID;
}): Promise<{ status: number; body: Record<string, unknown> }> {
  const { runtime } = makeRuntimeAndService(seedDocuments());
  const url = new URL(`http://local${params.pathname}?${params.query}`);
  let captured: { status: number; body: unknown } = { status: 0, body: null };
  const headers: Record<string, string> = {};
  if (params.actorEntityId) headers["x-eliza-entity-id"] = params.actorEntityId;
  const ctx = {
    req: { headers } as DocumentRouteContext["req"],
    res: { setHeader: vi.fn() } as unknown as DocumentRouteContext["res"],
    method: "GET",
    pathname: params.pathname,
    url,
    runtime: runtime as never,
    json: (_res: unknown, data: unknown, status = 200) => {
      captured = { status, body: data };
    },
    error: (_res: unknown, message: string, status = 400) => {
      captured = { status, body: { error: message } };
    },
    readJsonBody: async () => null,
  } as unknown as DocumentRouteContext;
  const handled = await handleDocumentsRoutes(ctx);
  expect(handled).toBe(true);
  return {
    status: captured.status,
    body: captured.body as Record<string, unknown>,
  };
}

describe("GET /api/documents — knowledgeFacet hub grouping (#13594)", () => {
  it("groups pdf/text/file into the `doc` facet", async () => {
    // The USER's readable pdf is pdf-a; the `doc` facet must catch it via the
    // pdf->doc grouping (owner-secret is owner-private, excluded).
    const { body } = await requestDocuments({
      pathname: "/api/documents",
      query: "knowledgeFacet=doc",
      actorEntityId: USER_ENTITY,
    });
    expect(docIds(body)).toEqual(["pdf-a"]);
  });

  it("passes image/audio/video/transcript through unchanged", async () => {
    const { body } = await requestDocuments({
      pathname: "/api/documents",
      query: "knowledgeFacet=image",
      actorEntityId: USER_ENTITY,
    });
    expect(docIds(body)).toEqual(["img-a", "img-b"]);
  });

  it("treats `all` as a no-op (whole readable store)", async () => {
    const { body } = await requestDocuments({
      pathname: "/api/documents",
      query: "knowledgeFacet=all",
      actorEntityId: USER_ENTITY,
    });
    expect(docIds(body)).toEqual(["img-a", "img-b", "pdf-a"]);
  });
});

describe("GET /api/documents/facets — whole-store hub counts (#13594)", () => {
  it("returns coarse facet counts over the whole readable store", async () => {
    // As the USER: img-a, img-b (image) + pdf-a (doc) are readable; owner-secret
    // is owner-private and excluded. Counts must describe the whole store, not a
    // page slice — the review blocker.
    const { body } = await requestDocuments({
      pathname: "/api/documents/facets",
      query: "",
      actorEntityId: USER_ENTITY,
    });
    const counts = body.counts as Record<string, number>;
    expect(counts).toMatchObject({
      all: 3,
      doc: 1,
      image: 2,
      audio: 0,
      video: 0,
      transcript: 0,
    });
  });

  it("honors the scope/room narrowing but ignores the facet itself", async () => {
    // Narrow to ROOM_A: img-a (image) + pdf-a (doc) for the USER. The facet
    // param is dropped inside the count so every bucket is still counted.
    const { body } = await requestDocuments({
      pathname: "/api/documents/facets",
      query: `roomId=${ROOM_A}&knowledgeFacet=image`,
      actorEntityId: USER_ENTITY,
    });
    const counts = body.counts as Record<string, number>;
    expect(counts).toMatchObject({ all: 2, doc: 1, image: 1 });
  });

  it("lets the owner count owner-private items", async () => {
    // Owner reads global + owner-private; owner-secret (owner-private pdf) is
    // counted as a `doc`. The USER's user-private items are scoped to the USER,
    // so the owner does not see them by default.
    const { body } = await requestDocuments({
      pathname: "/api/documents/facets",
      query: "",
      actorEntityId: OWNER_ENTITY,
    });
    const counts = body.counts as Record<string, number>;
    expect(counts.doc).toBeGreaterThanOrEqual(1);
  });
});

describe("GET /api/documents/search — roomId pushed into service scope (#13593)", () => {
  it("passes roomId to searchDocuments BEFORE ranking/capping", async () => {
    const searchDocuments = vi.fn(async () => []);
    const documentsService = {
      getMemories: vi.fn(async () => []),
      countMemories: vi.fn(async () => 0),
      addDocument: vi.fn(),
      searchDocuments,
      updateDocument: vi.fn(),
      deleteMemory: vi.fn(),
    };
    const runtime = {
      agentId: AGENT_ID,
      getService: vi.fn((name: string) =>
        name === "documents" ? documentsService : null,
      ),
      getServiceLoadPromise: vi.fn(),
      getSetting: vi.fn((key: string) =>
        key === "ELIZA_ADMIN_ENTITY_ID" ? OWNER_ENTITY : undefined,
      ),
      getMemoryById: vi.fn(async () => null),
    };
    const url = new URL(
      `http://local/api/documents/search?q=chart&roomId=${ROOM_A}&mediaFormat=image`,
    );
    let captured: unknown = null;
    const ctx = {
      req: { headers: { "x-eliza-entity-id": OWNER_ENTITY } },
      res: { setHeader: vi.fn() },
      method: "GET",
      pathname: "/api/documents/search",
      url,
      runtime: runtime as never,
      json: (_res: unknown, data: unknown) => {
        captured = data;
      },
      error: vi.fn(),
      readJsonBody: async () => null,
    } as unknown as DocumentRouteContext;

    const handled = await handleDocumentsRoutes(ctx);
    expect(handled).toBe(true);
    expect(captured).not.toBeNull();
    // roomId is threaded into the service search scope (2nd arg) so the DB
    // pre-filters by room before the top-N cap.
    expect(searchDocuments).toHaveBeenCalledTimes(1);
    const scopeArg = searchDocuments.mock.calls[0][1] as
      | { roomId?: string }
      | undefined;
    expect(scopeArg?.roomId).toBe(ROOM_A);
  });

  it("keeps help-tagged fragment results when free-text search also has tag=help", async () => {
    const helpFragment = docMemory("help-fragment", {
      documentId: "help-doc",
      title: "Getting started",
      tags: ["help"],
      scope: "global",
      addedBy: AGENT_ID,
    });
    helpFragment.content.text = "The chat pill opens Eliza from every view.";
    helpFragment.similarity = 0.92;
    const searchDocuments = vi.fn(async () => [helpFragment]);
    const documentsService = {
      getMemories: vi.fn(async () => []),
      countMemories: vi.fn(async () => 0),
      addDocument: vi.fn(),
      searchDocuments,
      updateDocument: vi.fn(),
      deleteMemory: vi.fn(),
    };
    const runtime = {
      agentId: AGENT_ID,
      getService: vi.fn((name: string) =>
        name === "documents" ? documentsService : null,
      ),
      getServiceLoadPromise: vi.fn(),
      getSetting: vi.fn((key: string) =>
        key === "ELIZA_ADMIN_ENTITY_ID" ? OWNER_ENTITY : undefined,
      ),
      getMemoryById: vi.fn(async () => null),
    };
    const url = new URL(
      "http://local/api/documents/search?q=chat%20pill&tag=help",
    );
    let captured: unknown = null;
    const ctx = {
      req: { headers: { "x-eliza-entity-id": OWNER_ENTITY } },
      res: { setHeader: vi.fn() },
      method: "GET",
      pathname: "/api/documents/search",
      url,
      runtime: runtime as never,
      json: (_res: unknown, data: unknown) => {
        captured = data;
      },
      error: vi.fn(),
      readJsonBody: async () => null,
    } as unknown as DocumentRouteContext;

    const handled = await handleDocumentsRoutes(ctx);

    expect(handled).toBe(true);
    expect(captured).toMatchObject({
      count: 1,
      results: [
        {
          documentId: "help-doc",
          documentTitle: "Getting started",
        },
      ],
    });
  });
});
