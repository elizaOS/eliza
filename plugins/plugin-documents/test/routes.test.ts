/** Route-handler tests for the documents REST surface, driving handleDocumentsRoutes against a mocked document service and fetch impl. */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DocumentRouteContext } from "../src/routes.js";
import {
  __setDocumentFetchImplForTests,
  handleDocumentsRoutes,
} from "../src/routes.js";

const addDocument = vi.fn();
const searchDocuments = vi.fn();

vi.mock("@elizaos/agent/api/documents-service-loader", () => ({
  getDocumentsService: vi.fn(async () => ({
    service: {
      addDocument,
      searchDocuments,
    },
  })),
  getDocumentsServiceTimeoutMs: vi.fn(() => 0),
}));

type MockResponse = {
  statusCode?: number;
  body?: unknown;
  headers: Record<string, string>;
  setHeader: (name: string, value: string | number | readonly string[]) => void;
  end: (chunk?: string) => void;
};

function buildCtx(args: {
  method: string;
  pathname: string;
  body?: unknown;
  runtime?: Partial<NonNullable<DocumentRouteContext["runtime"]>>;
}): {
  ctx: DocumentRouteContext;
  res: MockResponse;
} {
  const getMemoryById = vi.fn();
  const res: MockResponse = {
    headers: {},
    setHeader(name, value) {
      res.headers[name.toLowerCase()] = Array.isArray(value)
        ? value.join(", ")
        : String(value);
    },
    end(chunk) {
      res.body = chunk ? JSON.parse(chunk) : undefined;
    },
  };

  const ctx: DocumentRouteContext = {
    req: { headers: {} } as DocumentRouteContext["req"],
    res: res as DocumentRouteContext["res"],
    method: args.method,
    pathname: args.pathname,
    url: new URL(`http://localhost${args.pathname}`),
    runtime: {
      agentId: "agent-id",
      getSetting: () => undefined,
      getMemoryById,
      ...args.runtime,
    } as DocumentRouteContext["runtime"],
    json(response, data, status = 200) {
      response.statusCode = status;
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(data));
    },
    error(response, message, status = 400) {
      response.statusCode = status;
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ error: message }));
    },
    async readJsonBody<T>() {
      return (args.body as T | undefined) ?? null;
    },
    decodePathComponent(value, response, label = "path component") {
      try {
        return decodeURIComponent(value);
      } catch {
        ctx.error(
          response ?? res,
          `Invalid ${label}: malformed URL encoding`,
          400,
        );
        return null;
      }
    },
  };

  return { ctx, res };
}

describe("document routes", () => {
  afterEach(() => {
    vi.clearAllMocks();
    __setDocumentFetchImplForTests(undefined);
  });

  it.each([
    {},
    { url: {} },
    { url: "   " },
  ])("rejects malformed URL upload body %# with a 400", async (body) => {
    const fetchDocument = vi.fn();
    __setDocumentFetchImplForTests(fetchDocument);
    const { ctx, res } = buildCtx({
      method: "POST",
      pathname: "/api/documents/url",
      body,
    });

    await expect(handleDocumentsRoutes(ctx)).resolves.toBe(true);

    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ error: "url is required" });
    expect(fetchDocument).not.toHaveBeenCalled();
    expect(addDocument).not.toHaveBeenCalled();
  });

  it.each([
    { content: {}, filename: "doc.md" },
    { content: "hello", filename: {} },
    { content: "   ", filename: "doc.md" },
    { content: "hello", filename: "   " },
  ])("rejects malformed document upload body %# with a 400", async (body) => {
    const { ctx, res } = buildCtx({
      method: "POST",
      pathname: "/api/documents",
      body,
    });

    await expect(handleDocumentsRoutes(ctx)).resolves.toBe(true);

    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({
      error: "content and filename must be non-empty strings",
    });
    expect(addDocument).not.toHaveBeenCalled();
  });

  it("projects transcript time anchors (transcriptId/startMs/endMs) on search hits", async () => {
    searchDocuments.mockResolvedValueOnce([
      {
        id: "frag-anchored",
        similarity: 0.9,
        content: { text: "Alice: hello there" },
        metadata: {
          type: "fragment",
          documentId: "doc-1",
          position: 0,
          transcriptId: "t-1",
          startMs: 61_000,
          endMs: 62_500,
          title: "standup",
        },
      },
      {
        id: "frag-plain",
        similarity: 0.8,
        content: { text: "plain document chunk" },
        metadata: {
          type: "fragment",
          documentId: "doc-2",
          position: 3,
          title: "notes",
        },
      },
    ]);
    const { ctx, res } = buildCtx({
      method: "GET",
      pathname: "/api/documents/search",
    });
    ctx.url = new URL("http://localhost/api/documents/search?q=hello");

    await expect(handleDocumentsRoutes(ctx)).resolves.toBe(true);

    expect(res.statusCode).toBe(200);
    const body = res.body as {
      results: Array<Record<string, unknown>>;
    };
    expect(body.results).toHaveLength(2);
    // Anchored transcript fragment carries the deep-link fields.
    expect(body.results[0]).toMatchObject({
      id: "frag-anchored",
      documentId: "doc-1",
      transcriptId: "t-1",
      startMs: 61_000,
      endMs: 62_500,
    });
    // Non-transcript fragments carry no anchor keys at all.
    expect(body.results[1].transcriptId).toBeUndefined();
    expect(body.results[1].startMs).toBeUndefined();
    expect(body.results[1].endMs).toBeUndefined();
  });

  it("drops malformed anchors at the DTO boundary (NaN/negative/inverted)", async () => {
    searchDocuments.mockResolvedValueOnce([
      {
        id: "frag-nan",
        similarity: 0.9,
        content: { text: "nan anchor" },
        metadata: {
          type: "fragment",
          documentId: "doc-1",
          transcriptId: "t-1",
          startMs: Number.NaN,
          endMs: 1000,
        },
      },
      {
        id: "frag-negative",
        similarity: 0.85,
        content: { text: "negative anchor" },
        metadata: {
          type: "fragment",
          documentId: "doc-2",
          transcriptId: "t-2",
          startMs: -500,
          endMs: 1000,
        },
      },
      {
        id: "frag-inverted",
        similarity: 0.8,
        content: { text: "inverted anchor" },
        metadata: {
          type: "fragment",
          documentId: "doc-3",
          transcriptId: "t-3",
          startMs: 5000,
          endMs: 1000,
        },
      },
    ]);
    const { ctx, res } = buildCtx({
      method: "GET",
      pathname: "/api/documents/search",
    });
    ctx.url = new URL("http://localhost/api/documents/search?q=anchor");

    await expect(handleDocumentsRoutes(ctx)).resolves.toBe(true);

    const body = res.body as { results: Array<Record<string, unknown>> };
    expect(body.results).toHaveLength(3);
    // NaN start is not a valid seek anchor — no startMs published (endMs kept).
    expect(body.results[0].startMs).toBeUndefined();
    expect(body.results[0].endMs).toBe(1000);
    // Negative start dropped.
    expect(body.results[1].startMs).toBeUndefined();
    // Inverted pair (endMs < startMs) publishes NEITHER anchor.
    expect(body.results[2].startMs).toBeUndefined();
    expect(body.results[2].endMs).toBeUndefined();
    expect(body.results[2].transcriptId).toBeUndefined();
  });

  it("rejects image uploads that would otherwise store placeholder text", async () => {
    const { ctx, res } = buildCtx({
      method: "POST",
      pathname: "/api/documents",
      body: {
        content: "iVBORw0KGgo=",
        filename: "photo.png",
        contentType: "image/png",
      },
    });

    await expect(handleDocumentsRoutes(ctx)).resolves.toBe(true);

    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({
      error:
        "Failed to add document: Image uploads require metadata.includeImageDescriptions=true so the document store can persist real searchable text.",
    });
    expect(addDocument).not.toHaveBeenCalled();
  });

  it("stores image uploads only after a real image description is produced", async () => {
    const useModel = vi.fn(async () => ({
      description: "A receipt for coffee with total $4.50.",
    }));
    addDocument.mockResolvedValueOnce({
      clientDocumentId: "doc-id",
      fragmentCount: 1,
    });
    const { ctx, res } = buildCtx({
      method: "POST",
      pathname: "/api/documents",
      runtime: { useModel } as Partial<
        NonNullable<DocumentRouteContext["runtime"]>
      >,
      body: {
        content: "iVBORw0KGgo=",
        filename: "receipt.png",
        contentType: "image/png",
        metadata: { includeImageDescriptions: true },
      },
    });

    await expect(handleDocumentsRoutes(ctx)).resolves.toBe(true);

    expect(res.statusCode).toBe(200);
    expect(addDocument).toHaveBeenCalledWith(
      expect.objectContaining({
        contentType: "text/plain",
        content:
          "[Image: receipt.png]\n\nA receipt for coffee with total $4.50.",
      }),
    );
    expect(res.body).toEqual({
      ok: true,
      documentId: "doc-id",
      fragmentCount: 1,
    });
  });

  it("rejects image uploads when the image description model fails", async () => {
    const useModel = vi.fn(async () => {
      throw new Error("vision unavailable");
    });
    const { ctx, res } = buildCtx({
      method: "POST",
      pathname: "/api/documents",
      runtime: { useModel } as Partial<
        NonNullable<DocumentRouteContext["runtime"]>
      >,
      body: {
        content: "iVBORw0KGgo=",
        filename: "receipt.png",
        contentType: "image/png",
        metadata: { includeImageDescriptions: true },
      },
    });

    await expect(handleDocumentsRoutes(ctx)).resolves.toBe(true);

    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({
      error:
        "Failed to add document: Image description model failed: Error: vision unavailable",
    });
    expect(addDocument).not.toHaveBeenCalled();
  });

  it.each([
    ["GET", "/api/documents/%E0%A4%A"],
    ["GET", "/api/documents/%E0%A4%A/fragments"],
    ["PATCH", "/api/documents/%E0%A4%A"],
    ["DELETE", "/api/documents/%E0%A4%A"],
  ])("rejects malformed document id encoding for %s %s", async (method, pathname) => {
    const { ctx, res } = buildCtx({ method, pathname });
    const runtime = ctx.runtime as NonNullable<DocumentRouteContext["runtime"]>;
    const getMemoryById = vi.mocked(runtime.getMemoryById);

    await expect(handleDocumentsRoutes(ctx)).resolves.toBe(true);

    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({
      error: "Invalid document id: malformed URL encoding",
    });
    expect(getMemoryById).not.toHaveBeenCalled();
  });

  it("links original bytes (mediaUrl/mediaHash/mediaFileName) when a file-storage service is present", async () => {
    const store = vi.fn(
      async (bytes: Buffer | Uint8Array, mimeType: string) => {
        void bytes;
        void mimeType;
        return {
          url: "/api/media/deadbeef.txt",
          hash: "deadbeef",
          fileName: "deadbeef.txt",
          mimeType: "text/plain",
          size: 11,
        };
      },
    );
    const getService = vi.fn(() => ({ store }));
    addDocument.mockResolvedValueOnce({
      clientDocumentId: "doc-id",
      fragmentCount: 1,
    });
    const { ctx, res } = buildCtx({
      method: "POST",
      pathname: "/api/documents",
      runtime: { getService } as Partial<
        NonNullable<DocumentRouteContext["runtime"]>
      >,
      body: {
        content: "hello world",
        filename: "notes.txt",
        contentType: "text/plain",
      },
    });

    await expect(handleDocumentsRoutes(ctx)).resolves.toBe(true);

    expect(res.statusCode).toBe(200);
    expect(store).toHaveBeenCalledTimes(1);
    // Text upload → bytes are UTF-8 of the original content.
    expect((store.mock.calls[0][0] as Buffer).toString("utf8")).toBe(
      "hello world",
    );
    expect(addDocument).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({
          mediaUrl: "/api/media/deadbeef.txt",
          mediaHash: "deadbeef",
          mediaFileName: "deadbeef.txt",
        }),
      }),
    );
  });

  it("succeeds without a media link when no file-storage service is available", async () => {
    addDocument.mockResolvedValueOnce({
      clientDocumentId: "doc-id",
      fragmentCount: 1,
    });
    const getService = vi.fn(() => null);
    const { ctx, res } = buildCtx({
      method: "POST",
      pathname: "/api/documents",
      runtime: { getService } as Partial<
        NonNullable<DocumentRouteContext["runtime"]>
      >,
      body: {
        content: "hello world",
        filename: "notes.txt",
        contentType: "text/plain",
      },
    });

    await expect(handleDocumentsRoutes(ctx)).resolves.toBe(true);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      ok: true,
      documentId: "doc-id",
      fragmentCount: 1,
    });
    const passedMetadata = (
      addDocument.mock.calls[0][0] as {
        metadata: Record<string, unknown>;
      }
    ).metadata;
    expect(passedMetadata.mediaUrl).toBeUndefined();
    expect(passedMetadata.mediaHash).toBeUndefined();
    expect(passedMetadata.mediaFileName).toBeUndefined();
  });

  it("does not fail the upload when the file-storage service throws", async () => {
    const store = vi.fn(async () => {
      throw new Error("disk full");
    });
    const getService = vi.fn(() => ({ store }));
    const warn = vi.fn();
    addDocument.mockResolvedValueOnce({
      clientDocumentId: "doc-id",
      fragmentCount: 1,
    });
    const { ctx, res } = buildCtx({
      method: "POST",
      pathname: "/api/documents",
      runtime: { getService, logger: { warn } } as unknown as Partial<
        NonNullable<DocumentRouteContext["runtime"]>
      >,
      body: {
        content: "hello world",
        filename: "notes.txt",
        contentType: "text/plain",
      },
    });

    await expect(handleDocumentsRoutes(ctx)).resolves.toBe(true);

    expect(res.statusCode).toBe(200);
    expect(store).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(1);
    const passedMetadata = (
      addDocument.mock.calls[0][0] as {
        metadata: Record<string, unknown>;
      }
    ).metadata;
    expect(passedMetadata.mediaUrl).toBeUndefined();
  });

  it.each([
    null,
    42,
    "not a document",
    ["hello"],
  ])("rejects non-object bulk item %# without throwing", async (document) => {
    const { ctx, res } = buildCtx({
      method: "POST",
      pathname: "/api/documents/bulk",
      body: { documents: [document] },
    });

    await expect(handleDocumentsRoutes(ctx)).resolves.toBe(true);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      ok: false,
      total: 1,
      successCount: 0,
      failureCount: 1,
      results: [
        {
          index: 0,
          ok: false,
          filename: "document-1",
          error: "content and filename must be non-empty strings",
        },
      ],
    });
    expect(addDocument).not.toHaveBeenCalled();
  });
});
