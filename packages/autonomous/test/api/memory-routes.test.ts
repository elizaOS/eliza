import { describe, test, expect, vi } from "vitest";
import {
  createMockIncomingMessage,
  createMockHttpResponse,
} from "../../src/test-support/test-helpers";
import { handleMemoryRoutes } from "../../src/api/memory-routes";
import type { MemoryRouteContext } from "../../src/api/memory-routes";

function buildCtx(
  method: string,
  pathname: string,
  query = "",
  overrides?: Partial<MemoryRouteContext>,
): MemoryRouteContext {
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
    agentName: "test-agent",
    ...overrides,
  } as MemoryRouteContext;
}

describe("memory-routes", () => {
  describe("GET /api/memory/search", () => {
    test("requires runtime", async () => {
      const ctx = buildCtx("GET", "/api/memory/search", "q=hello");
      const handled = await handleMemoryRoutes(ctx);
      expect(handled).toBe(true);
      expect(ctx.error).toHaveBeenCalled();
    });
  });

  describe("POST /api/memory/remember", () => {
    test("requires runtime", async () => {
      const ctx = buildCtx("POST", "/api/memory/remember", "", {
        readJsonBody: vi.fn(async () => ({ text: "something to remember" })),
      });
      const handled = await handleMemoryRoutes(ctx);
      expect(handled).toBe(true);
      expect(ctx.error).toHaveBeenCalled();
    });
  });

  describe("GET /api/context/quick", () => {
    test("requires runtime", async () => {
      const ctx = buildCtx("GET", "/api/context/quick", "q=test");
      const handled = await handleMemoryRoutes(ctx);
      expect(handled).toBe(true);
      expect(ctx.error).toHaveBeenCalled();
    });
  });

  describe("routing", () => {
    test("unrelated path returns false", async () => {
      const ctx = buildCtx("GET", "/api/other");
      expect(await handleMemoryRoutes(ctx)).toBe(false);
    });
  });
});
