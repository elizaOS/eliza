/** Route-handler tests for the documents REST surface, driving handleDocumentsRoutes against a mocked document service and fetch impl. */
import type { AccessContext, UUID } from "@elizaos/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DocumentRouteContext } from "../src/routes.js";
import {
  __setDocumentFetchImplForTests,
  handleDocumentsRoutes,
} from "../src/routes.js";

const addDocument = vi.fn();
const searchDocuments = vi.fn(async () => []);

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

const OWNER_ENTITY_ID = "00000000-0000-0000-0000-0000000000b1" as UUID;
const AGENT_ID = "00000000-0000-4000-8000-0000000000a1" as UUID;
const ROOM_ID = "00000000-0000-4000-8000-0000000000a2" as UUID;
const WORLD_ID = "00000000-0000-4000-8000-0000000000a3" as UUID;
const OTHER_WORLD_ID = "00000000-0000-4000-8000-0000000000a4" as UUID;

function buildCtx(args: {
  method: string;
  pathname: string;
  body?: unknown;
  runtime?: Partial<NonNullable<DocumentRouteContext["runtime"]>>;
  accessContext?: AccessContext | null;
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
    accessContext:
      args.accessContext === null
        ? undefined
        : (args.accessContext ??
          ({
            requesterEntityId: OWNER_ENTITY_ID,
            role: "OWNER",
            isOwner: true,
          } satisfies AccessContext)),
    runtime: {
      agentId: AGENT_ID,
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
    ["list", "GET", "/api/documents", undefined],
    [
      "upload",
      "POST",
      "/api/documents",
      { content: "private", filename: "private.txt" },
    ],
  ])(
    "rejects unauthenticated %s before document access",
    async (_label, method, pathname, body) => {
      const getMemoryById = vi.fn();
      const { ctx, res } = buildCtx({
        method,
        pathname,
        body,
        accessContext: null,
        runtime: { getMemoryById },
      });

      await expect(handleDocumentsRoutes(ctx)).resolves.toBe(true);

      expect(res.statusCode).toBe(401);
      expect(res.body).toEqual({ error: "Authentication required" });
      expect(getMemoryById).not.toHaveBeenCalled();
      expect(searchDocuments).not.toHaveBeenCalled();
      expect(addDocument).not.toHaveBeenCalled();
    },
  );

  it.each([{}, { url: {} }, { url: "   " }])(
    "rejects malformed URL upload body %# with a 400",
    async (body) => {
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
    },
  );

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

  it.each([
    [{ roomId: "not-a-uuid" }, "roomId must be a valid UUID"],
    [
      { worldId: "not-a-uuid" },
      "worldId requires a roomId so tenant scope can be verified",
    ],
    [
      { roomId: ROOM_ID, worldId: "not-a-uuid" },
      "worldId must be a valid UUID",
    ],
  ])(
    "rejects malformed upload location %#",
    async (location, expectedError) => {
      const { ctx, res } = buildCtx({
        method: "POST",
        pathname: "/api/documents",
        body: { content: "hello", filename: "doc.txt", ...location },
      });

      await expect(handleDocumentsRoutes(ctx)).resolves.toBe(true);

      expect(res.statusCode).toBe(400);
      expect(res.body).toEqual({ error: expectedError });
      expect(addDocument).not.toHaveBeenCalled();
    },
  );

  it("derives upload world authority from the canonical room", async () => {
    addDocument.mockResolvedValueOnce({
      clientDocumentId: "00000000-0000-4000-8000-0000000000a5",
      fragmentCount: 1,
    });
    const getRoom = vi.fn(async () => ({ id: ROOM_ID, worldId: WORLD_ID }));
    const { ctx, res } = buildCtx({
      method: "POST",
      pathname: "/api/documents",
      runtime: { getRoom },
      accessContext: {
        requesterEntityId: OWNER_ENTITY_ID,
        role: "USER",
        worldId: WORLD_ID,
      },
      body: {
        content: "hello",
        filename: "doc.txt",
        roomId: ROOM_ID,
        worldId: WORLD_ID,
      },
    });

    await expect(handleDocumentsRoutes(ctx)).resolves.toBe(true);

    expect(res.statusCode).toBe(200);
    expect(getRoom).toHaveBeenCalledWith(ROOM_ID);
    expect(addDocument).toHaveBeenCalledWith(
      expect.objectContaining({ roomId: ROOM_ID, worldId: WORLD_ID }),
    );
  });

  it("rejects a syntactically valid caller-supplied world that mismatches the room", async () => {
    const getRoom = vi.fn(async () => ({ id: ROOM_ID, worldId: WORLD_ID }));
    const { ctx, res } = buildCtx({
      method: "POST",
      pathname: "/api/documents",
      runtime: { getRoom },
      body: {
        content: "hello",
        filename: "doc.txt",
        roomId: ROOM_ID,
        worldId: OTHER_WORLD_ID,
      },
    });

    await expect(handleDocumentsRoutes(ctx)).resolves.toBe(true);

    expect(res.statusCode).toBe(403);
    expect(res.body).toEqual({
      error: "worldId does not match the canonical room tenant",
    });
    expect(addDocument).not.toHaveBeenCalled();
  });

  it("rejects a non-owner whose access context is for another world", async () => {
    const getRoom = vi.fn(async () => ({ id: ROOM_ID, worldId: WORLD_ID }));
    const { ctx, res } = buildCtx({
      method: "POST",
      pathname: "/api/documents",
      runtime: { getRoom },
      accessContext: {
        requesterEntityId: OWNER_ENTITY_ID,
        role: "USER",
        worldId: OTHER_WORLD_ID,
      },
      body: { content: "hello", filename: "doc.txt", roomId: ROOM_ID },
    });

    await expect(handleDocumentsRoutes(ctx)).resolves.toBe(true);

    expect(res.statusCode).toBe(403);
    expect(res.body).toEqual({
      error: "Requester is not authorized for the room tenant",
    });
    expect(addDocument).not.toHaveBeenCalled();
  });

  it("returns unavailable and reports diagnostics when room lookup fails", async () => {
    const lookupFailure = new Error("database unavailable");
    const reportError = vi.fn();
    const { ctx, res } = buildCtx({
      method: "POST",
      pathname: "/api/documents",
      runtime: {
        getRoom: vi.fn(async () => {
          throw lookupFailure;
        }),
        reportError,
      },
      body: { content: "hello", filename: "doc.txt", roomId: ROOM_ID },
    });

    await expect(handleDocumentsRoutes(ctx)).resolves.toBe(true);

    expect(res.statusCode).toBe(503);
    expect(reportError).toHaveBeenCalledWith(
      "documents.upload-location",
      lookupFailure,
      { roomId: ROOM_ID },
    );
    expect(addDocument).not.toHaveBeenCalled();
  });

  it.each([
    ["empty", ""],
    ["whitespace", "   "],
    ["empty essence", "; charset=UTF-8"],
    ["non-string", 42],
    ["null", null],
    ["malformed", "not-a-mime"],
  ])(
    "rejects a supplied %s contentType before single-upload persistence",
    async (_label, contentType) => {
      const store = vi.fn();
      const getService = vi.fn(() => ({ store }));
      const { ctx, res } = buildCtx({
        method: "POST",
        pathname: "/api/documents",
        runtime: { getService } as Partial<
          NonNullable<DocumentRouteContext["runtime"]>
        >,
        body: {
          content: "hello",
          filename: "doc.txt",
          contentType,
        },
      });

      await expect(handleDocumentsRoutes(ctx)).resolves.toBe(true);

      expect(res.statusCode).toBe(400);
      expect(res.body).toEqual({
        error:
          "contentType must be a valid non-empty MIME type string when provided",
      });
      expect(getService).not.toHaveBeenCalled();
      expect(store).not.toHaveBeenCalled();
      expect(addDocument).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["empty", ""],
    ["whitespace", "   "],
    ["empty essence", "; charset=UTF-8"],
    ["non-string", { type: "text/plain" }],
    ["null", null],
    ["malformed", "not-a-mime"],
  ])(
    "rejects a supplied %s contentType before bulk-upload persistence",
    async (_label, contentType) => {
      const store = vi.fn();
      const getService = vi.fn(() => ({ store }));
      const { ctx, res } = buildCtx({
        method: "POST",
        pathname: "/api/documents/bulk",
        runtime: { getService } as Partial<
          NonNullable<DocumentRouteContext["runtime"]>
        >,
        body: {
          documents: [
            {
              content: "hello",
              filename: "doc.txt",
              contentType,
            },
          ],
        },
      });

      await expect(handleDocumentsRoutes(ctx)).resolves.toBe(true);

      expect(res.statusCode).toBe(400);
      expect(res.body).toEqual({
        error:
          "contentType must be a valid non-empty MIME type string when provided",
      });
      expect(getService).not.toHaveBeenCalled();
      expect(store).not.toHaveBeenCalled();
      expect(addDocument).not.toHaveBeenCalled();
    },
  );

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
        metadata: expect.objectContaining({
          contentType: "text/plain",
          fileType: "image/png",
          textBacked: true,
        }),
      }),
    );
    expect(res.body).toEqual({
      ok: true,
      documentId: "doc-id",
      fragmentCount: 1,
    });
  });

  it.each([
    {
      content: "hello world",
      filename: "notes.txt",
      contentType: undefined,
      expectedContentType: "text/plain",
      expectedFileType: "text/plain",
      expectedTextBacked: true,
      expectedBytes: "hello world",
    },
    {
      content: "hello world",
      filename: "notes.txt",
      contentType: "TEXT/PLAIN; charset=UTF-8",
      expectedContentType: "text/plain",
      expectedFileType: "TEXT/PLAIN; charset=UTF-8",
      expectedTextBacked: true,
      expectedBytes: "hello world",
    },
    {
      content: Buffer.from("pdf bytes").toString("base64"),
      filename: "report.bin",
      contentType: "APPLICATION/PDF",
      expectedContentType: "application/pdf",
      expectedFileType: "APPLICATION/PDF",
      expectedTextBacked: false,
      expectedBytes: "pdf bytes",
    },
    {
      content: Buffer.from("pdf bytes").toString("base64"),
      filename: "report.bin",
      contentType: "application/pdf; charset=UTF-8",
      expectedContentType: "application/pdf",
      expectedFileType: "application/pdf; charset=UTF-8",
      expectedTextBacked: false,
      expectedBytes: "pdf bytes",
    },
    {
      content: Buffer.from("#!/bin/sh\necho hello\n").toString("base64"),
      filename: "run.bin",
      contentType: "application/x-sh",
      expectedContentType: "application/x-sh",
      expectedFileType: "application/x-sh",
      expectedTextBacked: false,
      expectedBytes: "#!/bin/sh\necho hello\n",
    },
    ...[
      "application/problem+json",
      "application/soap+xml",
      "application/typescript",
      "application/yaml",
      "application/x-yaml",
    ].map((contentType) => ({
      content: Buffer.from("wire-compatible bytes").toString("base64"),
      filename: "payload.bin",
      contentType,
      expectedContentType: contentType,
      expectedFileType: contentType,
      expectedTextBacked: false,
      expectedBytes: "wire-compatible bytes",
    })),
  ])(
    "canonicalizes case and parameters before document service routing %#",
    async ({
      content,
      filename,
      contentType,
      expectedContentType,
      expectedFileType,
      expectedTextBacked,
      expectedBytes,
    }) => {
      const store = vi.fn(async () => ({
        url: "/api/media/deadbeef.bin",
        hash: "deadbeef",
        fileName: "deadbeef.bin",
        mimeType: expectedContentType,
        size: expectedBytes.length,
      }));
      addDocument.mockResolvedValueOnce({
        clientDocumentId: "doc-id",
        fragmentCount: 1,
      });
      const { ctx, res } = buildCtx({
        method: "POST",
        pathname: "/api/documents",
        runtime: {
          getService: vi.fn(() => ({ store })),
        } as Partial<NonNullable<DocumentRouteContext["runtime"]>>,
        body: {
          content,
          filename,
          ...(contentType === undefined ? {} : { contentType }),
        },
      });

      await expect(handleDocumentsRoutes(ctx)).resolves.toBe(true);

      expect(res.statusCode).toBe(200);
      expect(store.mock.calls).toHaveLength(1);
      expect(store).toHaveBeenCalledWith(
        expect.any(Buffer),
        expectedContentType,
      );
      const storedContent = store.mock.calls[0][0] as Buffer;
      expect(storedContent.toString("utf8")).toBe(expectedBytes);
      expect(addDocument).toHaveBeenCalledWith(
        expect.objectContaining({
          contentType: expectedContentType,
          metadata: expect.objectContaining({
            contentType: expectedContentType,
            fileType: expectedFileType,
            textBacked: expectedTextBacked,
          }),
        }),
      );
    },
  );

  it.each(["single", "bulk"] as const)(
    "uses the text filename fallback for original byte decoding in %s upload",
    async (uploadKind) => {
      const content = "plain text sent with a generic MIME type";
      const document = {
        content,
        filename: "notes.txt",
        contentType: "application/octet-stream",
      };
      const store = vi.fn(async () => ({
        url: "/api/media/deadbeef.bin",
        hash: "deadbeef",
        fileName: "deadbeef.bin",
        mimeType: "application/octet-stream",
        size: Buffer.byteLength(content),
      }));
      addDocument.mockResolvedValueOnce({
        clientDocumentId: "doc-id",
        fragmentCount: 1,
      });
      const pathname =
        uploadKind === "single" ? "/api/documents" : "/api/documents/bulk";
      const { ctx, res } = buildCtx({
        method: "POST",
        pathname,
        runtime: {
          getService: vi.fn(() => ({ store })),
        } as Partial<NonNullable<DocumentRouteContext["runtime"]>>,
        body: uploadKind === "single" ? document : { documents: [document] },
      });

      await expect(handleDocumentsRoutes(ctx)).resolves.toBe(true);

      expect(res.statusCode).toBe(200);
      expect(store).toHaveBeenCalledWith(
        expect.any(Buffer),
        "application/octet-stream",
      );
      expect((store.mock.calls[0][0] as Buffer).toString("utf8")).toBe(content);
      expect(addDocument).toHaveBeenCalledWith(
        expect.objectContaining({
          content,
          contentType: "application/octet-stream",
          metadata: expect.objectContaining({
            contentType: "application/octet-stream",
            fileType: "application/octet-stream",
            textBacked: true,
          }),
        }),
      );
    },
  );

  it.each(["single", "bulk"] as const)(
    "routes an omitted or fallback-MIME .mdx document as text/markdown in %s upload",
    async (uploadKind) => {
      const content = "# Compatibility note";
      const document = {
        content,
        filename: "note.mdx",
        ...(uploadKind === "bulk"
          ? { contentType: "application/octet-stream" }
          : {}),
      };
      const uploadedContentType =
        uploadKind === "bulk" ? "application/octet-stream" : "text/plain";
      const store = vi.fn(async () => ({
        url: "/api/media/deadbeef.txt",
        hash: "deadbeef",
        fileName: "deadbeef.txt",
        mimeType: uploadedContentType,
        size: Buffer.byteLength(content),
      }));
      addDocument.mockResolvedValueOnce({
        clientDocumentId: "doc-id",
        fragmentCount: 1,
      });
      const pathname =
        uploadKind === "single" ? "/api/documents" : "/api/documents/bulk";
      const { ctx, res } = buildCtx({
        method: "POST",
        pathname,
        runtime: {
          getService: vi.fn(() => ({ store })),
        } as Partial<NonNullable<DocumentRouteContext["runtime"]>>,
        body: uploadKind === "single" ? document : { documents: [document] },
      });

      await expect(handleDocumentsRoutes(ctx)).resolves.toBe(true);

      expect(res.statusCode).toBe(200);
      expect(store).toHaveBeenCalledWith(
        expect.any(Buffer),
        uploadedContentType,
      );
      expect((store.mock.calls[0][0] as Buffer).toString("utf8")).toBe(content);
      expect(addDocument).toHaveBeenCalledWith(
        expect.objectContaining({
          content,
          contentType: "text/markdown",
          metadata: expect.objectContaining({
            contentType: "text/markdown",
            fileType: uploadedContentType,
            textBacked: true,
          }),
        }),
      );
    },
  );

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
  ])(
    "rejects malformed document id encoding for %s %s",
    async (method, pathname) => {
      const { ctx, res } = buildCtx({ method, pathname });
      const runtime = ctx.runtime as NonNullable<
        DocumentRouteContext["runtime"]
      >;
      const getMemoryById = vi.mocked(runtime.getMemoryById);

      await expect(handleDocumentsRoutes(ctx)).resolves.toBe(true);

      expect(res.statusCode).toBe(400);
      expect(res.body).toEqual({
        error: "Invalid document id: malformed URL encoding",
      });
      expect(getMemoryById).not.toHaveBeenCalled();
    },
  );

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

  it.each([null, 42, "not a document", ["hello"]])(
    "rejects non-object bulk item %# without throwing",
    async (document) => {
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
    },
  );

  it("preserves query string searchParams when search URL contains q parameter", async () => {
    const { ctx, res } = buildCtx({
      method: "GET",
      pathname: "/api/documents/search",
    });
    ctx.url = new URL("http://localhost/api/documents/search?q=testquery");

    await handleDocumentsRoutes(ctx);
    expect(res.statusCode).not.toBe(400);
  });
});
