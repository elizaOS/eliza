/** Exercises document search-mode validation through the deterministic route harness. */
import type { AccessContext, UUID } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import type { DocumentRouteContext } from "./routes.ts";
import { handleDocumentsRoutes } from "./routes.ts";

const searchDocuments = vi.fn(async () => []);

vi.mock("@elizaos/shared", () => ({
  parseClampedFloat: () => 0.3,
  parsePositiveInteger: () => 20,
}));

vi.mock("@elizaos/agent/api/documents-service-loader", () => ({
  getDocumentsService: vi.fn(async () => ({
    service: {
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

function buildCtx(path: string): {
  ctx: DocumentRouteContext;
  res: MockResponse;
} {
  const url = new URL(`http://localhost${path}`);
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
    method: "GET",
    pathname: url.pathname,
    url,
    accessContext: {
      requesterEntityId: OWNER_ENTITY_ID,
      role: "OWNER",
      isOwner: true,
    } satisfies AccessContext,
    runtime: {
      agentId: "agent-id",
      getSetting: () => undefined,
      getMemoryById: vi.fn(),
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
    async readJsonBody() {
      return null;
    },
  };

  return { ctx, res };
}

describe("GET /api/documents/search searchMode identity", () => {
  it.each([
    "/api/documents/search?q=notes",
    "/api/documents/search?q=notes&searchMode=",
  ])("accepts omitted/empty searchMode as the default search", async (path) => {
    searchDocuments.mockClear();
    const { ctx, res } = buildCtx(path);
    await expect(handleDocumentsRoutes(ctx)).resolves.toBe(true);
    expect(res.statusCode).toBe(200);
    expect(searchDocuments).toHaveBeenCalledTimes(1);
    expect(searchDocuments.mock.calls[0][2]).toBeUndefined();
  });

  it.each(["hybrid", "vector", "keyword"] as const)(
    "accepts searchMode=%s as that retrieval mode",
    async (token) => {
      searchDocuments.mockClear();
      const { ctx, res } = buildCtx(
        `/api/documents/search?q=notes&searchMode=${token}`,
      );
      await expect(handleDocumentsRoutes(ctx)).resolves.toBe(true);
      expect(res.statusCode).toBe(200);
      expect(searchDocuments).toHaveBeenCalledTimes(1);
      expect(searchDocuments.mock.calls[0][2]).toBe(token);
    },
  );

  it.each(["HYBRID", "VECTOR", "KEYWORD", "1", "true", "TRUE", "foo", "1e2"])(
    "rejects searchMode=%s before searchDocuments",
    async (token) => {
      searchDocuments.mockClear();
      const { ctx, res } = buildCtx(
        `/api/documents/search?q=notes&searchMode=${encodeURIComponent(token)}`,
      );
      await expect(handleDocumentsRoutes(ctx)).resolves.toBe(true);
      expect(res.statusCode).toBe(400);
      expect(res.body).toEqual({ error: "Invalid searchMode" });
      expect(searchDocuments).not.toHaveBeenCalled();
    },
  );

  it.each([
    "/api/documents/search?q=notes&searchMode=hybrid&searchMode=hybrid",
    "/api/documents/search?q=notes&searchMode=hybrid&searchMode=vector",
    "/api/documents/search?q=notes&searchMode=&searchMode=hybrid",
    "/api/documents/search?q=notes&searchMode=foo&searchMode=hybrid",
  ])("rejects duplicate searchMode values in %s", async (path) => {
    searchDocuments.mockClear();
    const { ctx, res } = buildCtx(path);
    await expect(handleDocumentsRoutes(ctx)).resolves.toBe(true);
    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ error: "Invalid searchMode" });
    expect(searchDocuments).not.toHaveBeenCalled();
  });
});
