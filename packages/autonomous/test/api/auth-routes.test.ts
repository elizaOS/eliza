import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { AuthRouteContext } from "../../src/api/auth-routes";
import { handleAuthRoutes } from "../../src/api/auth-routes";
import {
  createMockHttpResponse,
  createMockIncomingMessage,
} from "../../src/test-support/test-helpers";

let envBackup: string | undefined;

beforeEach(() => {
  envBackup = process.env.ELIZA_API_TOKEN;
  process.env.ELIZA_API_TOKEN = "test-token-secret";
});

afterEach(() => {
  if (envBackup === undefined) delete process.env.ELIZA_API_TOKEN;
  else process.env.ELIZA_API_TOKEN = envBackup;
});

function buildCtx(
  method: string,
  pathname: string,
  overrides?: Partial<AuthRouteContext>,
): AuthRouteContext & { getStatus: () => number; getJson: () => unknown } {
  const { res, getStatus, getJson } = createMockHttpResponse();
  const req = createMockIncomingMessage({ method, url: pathname });
  Object.assign(req, { socket: { remoteAddress: "127.0.0.1" } });
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
    readJsonBody: vi.fn(async () => null),
    pairingEnabled: () => true,
    ensurePairingCode: () => "ABC123",
    normalizePairingCode: (code: string) => code.toUpperCase().trim(),
    rateLimitPairing: () => true,
    getPairingExpiresAt: () => Date.now() + 60_000,
    clearPairing: vi.fn(),
    getStatus,
    getJson,
    ...overrides,
  } as AuthRouteContext & { getStatus: () => number; getJson: () => unknown };
  return ctx;
}

describe("auth-routes", () => {
  describe("GET /api/auth/status", () => {
    test("returns pairing status", async () => {
      const ctx = buildCtx("GET", "/api/auth/status");
      const handled = await handleAuthRoutes(ctx);
      expect(handled).toBe(true);
      expect(ctx.json).toHaveBeenCalledOnce();
      const payload = (ctx.json as ReturnType<typeof vi.fn>).mock.calls[0][1];
      expect(payload).toHaveProperty("pairingEnabled", true);
      expect(payload).toHaveProperty("required");
      expect(payload).toHaveProperty("expiresAt");
    });

    test("returns pairingEnabled false when disabled", async () => {
      const ctx = buildCtx("GET", "/api/auth/status", {
        pairingEnabled: () => false,
      });
      await handleAuthRoutes(ctx);
      const payload = (ctx.json as ReturnType<typeof vi.fn>).mock.calls[0][1];
      expect(payload.pairingEnabled).toBe(false);
      expect(payload.expiresAt).toBeNull();
    });
  });

  describe("POST /api/auth/pair", () => {
    test("succeeds with valid code and returns token", async () => {
      const ctx = buildCtx("POST", "/api/auth/pair", {
        readJsonBody: vi.fn(async () => ({ code: "ABC123" })),
      });
      const handled = await handleAuthRoutes(ctx);
      expect(handled).toBe(true);
      expect(ctx.json).toHaveBeenCalledOnce();
      const payload = (ctx.json as ReturnType<typeof vi.fn>).mock.calls[0][1];
      expect(payload).toHaveProperty("token");
      expect(ctx.clearPairing).toHaveBeenCalled();
    });

    test("rejects when pairing disabled", async () => {
      const ctx = buildCtx("POST", "/api/auth/pair", {
        pairingEnabled: () => false,
        readJsonBody: vi.fn(async () => ({ code: "ABC123" })),
        rateLimitPairing: () => true,
      });
      await handleAuthRoutes(ctx);
      expect(ctx.error).toHaveBeenCalled();
      const args = (ctx.error as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(args[2]).toBe(403);
    });

    test("rejects when rate limited", async () => {
      const ctx = buildCtx("POST", "/api/auth/pair", {
        rateLimitPairing: () => false,
        readJsonBody: vi.fn(async () => ({ code: "ABC123" })),
      });
      await handleAuthRoutes(ctx);
      expect(ctx.error).toHaveBeenCalled();
      const args = (ctx.error as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(args[2]).toBe(429);
    });

    test("rejects with wrong code", async () => {
      const ctx = buildCtx("POST", "/api/auth/pair", {
        readJsonBody: vi.fn(async () => ({ code: "WRONG" })),
      });
      await handleAuthRoutes(ctx);
      expect(ctx.error).toHaveBeenCalled();
      const args = (ctx.error as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(args[2]).toBe(403);
    });

    test("rejects with no API token set", async () => {
      delete process.env.ELIZA_API_TOKEN;
      const ctx = buildCtx("POST", "/api/auth/pair", {
        readJsonBody: vi.fn(async () => ({ code: "ABC123" })),
      });
      await handleAuthRoutes(ctx);
      expect(ctx.error).toHaveBeenCalled();
      const args = (ctx.error as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(args[2]).toBe(400);
    });

    test("rejects expired code", async () => {
      const ctx = buildCtx("POST", "/api/auth/pair", {
        getPairingExpiresAt: () => Date.now() - 1000,
        readJsonBody: vi.fn(async () => ({ code: "ABC123" })),
      });
      await handleAuthRoutes(ctx);
      expect(ctx.error).toHaveBeenCalled();
      const args = (ctx.error as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(args[2]).toBe(410);
    });
  });

  describe("routing", () => {
    test("unrelated path returns false", async () => {
      const ctx = buildCtx("GET", "/api/other");
      expect(await handleAuthRoutes(ctx)).toBe(false);
    });

    test("/api/auth/ prefix but unknown sub-path returns false", async () => {
      const ctx = buildCtx("GET", "/api/auth/unknown");
      expect(await handleAuthRoutes(ctx)).toBe(false);
    });
  });
});
