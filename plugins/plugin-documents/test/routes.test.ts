import { afterEach, describe, expect, it, vi } from "vitest";
import type { DocumentRouteContext } from "../src/routes.js";
import {
  __setDocumentFetchImplForTests,
  handleDocumentsRoutes,
} from "../src/routes.js";

const addDocument = vi.fn();

vi.mock("@elizaos/agent/api/documents-service-loader", () => ({
  getDocumentsService: vi.fn(async () => ({
    service: {
      addDocument,
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

function buildCtx(args: { method: string; pathname: string; body?: unknown }): {
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
