import { describe, expect, test, vi } from "vitest";
import type { KnowledgeRouteContext } from "../../src/api/knowledge-routes";
import { handleKnowledgeRoutes } from "../../src/api/knowledge-routes";
import {
  createMockHttpResponse,
  createMockIncomingMessage,
} from "../../src/test-support/test-helpers";

function buildCtx(
  method: string,
  pathname: string,
  query = "",
  overrides?: Partial<KnowledgeRouteContext>,
): KnowledgeRouteContext {
  const fullUrl = query ? `${pathname}?${query}` : pathname;
  const { res } = createMockHttpResponse();
  return {
    req: createMockIncomingMessage({ method, url: fullUrl }),
    res,
    method,
    pathname,
    url: new URL(fullUrl, "http://localhost:2138"),
    json: vi.fn((r, data, status = 200) => {
      r.writeHead(status);
      r.end(JSON.stringify(data));
    }),
    error: vi.fn((r, msg, status = 500) => {
      r.writeHead(status);
      r.end(JSON.stringify({ error: msg }));
    }),
    readJsonBody: vi.fn(async () => ({})),
    runtime: null,
    ...overrides,
  } as KnowledgeRouteContext;
}

describe("knowledge-routes", () => {
  describe("GET /api/knowledge", () => {
    test("requires runtime", async () => {
      const ctx = buildCtx("GET", "/api/knowledge");
      const handled = await handleKnowledgeRoutes(ctx);
      expect(handled).toBe(true);
      expect(ctx.error).toHaveBeenCalled();
    });
  });

  describe("GET /api/knowledge/search", () => {
    test("requires runtime", async () => {
      const ctx = buildCtx("GET", "/api/knowledge/search", "q=test");
      const handled = await handleKnowledgeRoutes(ctx);
      expect(handled).toBe(true);
      expect(ctx.error).toHaveBeenCalled();
    });
  });

  describe("POST /api/knowledge", () => {
    test("requires runtime for upload", async () => {
      const ctx = buildCtx("POST", "/api/knowledge", "", {
        readJsonBody: vi.fn(async () => ({ title: "test", content: "data" })),
      });
      const handled = await handleKnowledgeRoutes(ctx);
      expect(handled).toBe(true);
      expect(ctx.error).toHaveBeenCalled();
    });
  });

  describe("routing", () => {
    test("unrelated path returns false", async () => {
      const ctx = buildCtx("GET", "/api/other");
      expect(await handleKnowledgeRoutes(ctx)).toBe(false);
    });
  });
});
