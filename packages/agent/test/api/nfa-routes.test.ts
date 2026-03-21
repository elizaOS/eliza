import { describe, expect, test, vi } from "vitest";
import type { NfaRouteContext } from "../../src/api/nfa-routes";
import { handleNfaRoutes } from "../../src/api/nfa-routes";
import {
  createMockHttpResponse,
  createMockIncomingMessage,
} from "../../src/test-support/test-helpers";

function buildCtx(
  method: string,
  pathname: string,
  overrides?: Partial<NfaRouteContext>,
): NfaRouteContext & { getStatus: () => number; getJson: () => unknown } {
  const { res, getStatus, getJson } = createMockHttpResponse();
  const req = createMockIncomingMessage({ method, url: pathname });
  const ctx = {
    req,
    res,
    method,
    pathname,
    json: vi.fn((r, data, status = 200) => {
      r.writeHead(status);
      r.end(JSON.stringify(data));
    }),
    error: vi.fn((r, msg, status = 500) => {
      r.writeHead(status);
      r.end(JSON.stringify({ error: msg }));
    }),
    getStatus,
    getJson,
    ...overrides,
  } as NfaRouteContext & {
    getStatus: () => number;
    getJson: () => unknown;
  };
  return ctx;
}

describe("nfa-routes", () => {
  describe("GET /api/nfa/status", () => {
    test("handles missing eliza dir gracefully and returns null records", async () => {
      const ctx = buildCtx("GET", "/api/nfa/status");
      const handled = await handleNfaRoutes(ctx);
      expect(handled).toBe(true);
      expect(ctx.json).toHaveBeenCalledOnce();
      const payload = (ctx.json as ReturnType<typeof vi.fn>).mock.calls[0][1];
      expect(payload.nfa).toBeNull();
      expect(payload.identity).toBeNull();
      expect(payload.configured).toBe(false);
    });
  });

  describe("GET /api/nfa/learnings", () => {
    test("returns empty entries when no LEARNINGS.md file exists", async () => {
      const ctx = buildCtx("GET", "/api/nfa/learnings");
      const handled = await handleNfaRoutes(ctx);
      expect(handled).toBe(true);
      expect(ctx.json).toHaveBeenCalledOnce();
      const payload = (ctx.json as ReturnType<typeof vi.fn>).mock.calls[0][1];
      expect(payload.entries).toEqual([]);
      expect(payload.totalEntries).toBe(0);
      expect(payload.source).toBeNull();
      expect(payload.merkleRoot).toBeDefined();
    });
  });

  describe("routing", () => {
    test("unrelated path returns false", async () => {
      const ctx = buildCtx("GET", "/api/other");
      expect(await handleNfaRoutes(ctx)).toBe(false);
    });

    test("POST to /api/nfa/status returns false (wrong method)", async () => {
      const ctx = buildCtx("POST", "/api/nfa/status");
      expect(await handleNfaRoutes(ctx)).toBe(false);
    });
  });
});
