/**
 * Unit test for the boundary role reported by `GET /api/auth/me`: an authorized
 * loopback request resolves to OWNER, an unauthorized request to GUEST with a
 * 401. The auth helpers (`isAuthorized`, `resolveBoundaryRole`) are mocked so
 * the assertions exercise the route's role mapping in isolation.
 */
import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  isAuthorized: vi.fn(),
  isTrustedLocalRequest: vi.fn(),
}));

vi.mock("./server-helpers-auth.ts", () => ({
  isAuthorized: mocks.isAuthorized,
  isTrustedLocalRequest: mocks.isTrustedLocalRequest,
  // #12087 Item 13: auth-routes derives the response role from the single
  // resolveBoundaryRole helper. Mirror its real one-line impl (authorized →
  // OWNER, else GUEST) off the mocked isAuthorized so these assertions
  // exercise the true boundary-role mapping.
  resolveBoundaryRole: (req: unknown) =>
    mocks.isAuthorized(req) ? "OWNER" : "GUEST",
}));

import { type AuthRouteContext, handleAuthRoutes } from "./auth-routes.ts";

function mkCtx(remoteAddress = "203.0.113.10"): {
  ctx: AuthRouteContext;
  captured: { body?: unknown; status?: number };
} {
  const captured: { body?: unknown; status?: number } = {};
  const ctx = {
    req: {
      method: "GET",
      url: "/api/auth/me",
      headers: {},
      socket: { remoteAddress },
    },
    res: {},
    method: "GET",
    pathname: "/api/auth/me",
    readJsonBody: async () => ({}),
    json: (_res: unknown, body: unknown, status?: number) => {
      captured.body = body;
      captured.status = status ?? 200;
    },
    error: (_res: unknown, _msg: string, status?: number) => {
      captured.status = status ?? 500;
    },
    pairingEnabled: () => false,
    ensurePairingCode: () => null,
    normalizePairingCode: (c: string) => c,
    rateLimitPairing: () => true,
    getPairingExpiresAt: () => 0,
    clearPairing: () => {},
  } as unknown as AuthRouteContext;
  return { ctx, captured };
}

describe("/api/auth/me boundary role (#9948)", () => {
  it("returns role OWNER for an authorized loopback request", async () => {
    mocks.isAuthorized.mockReturnValue(true);
    mocks.isTrustedLocalRequest.mockReturnValue(true);
    const { ctx, captured } = mkCtx("127.0.0.1");
    expect(await handleAuthRoutes(ctx)).toBe(true);
    expect(captured.status).toBe(200);
    expect((captured.body as { access: { role: string } }).access.role).toBe(
      "OWNER",
    );
  });

  it("returns role GUEST (401) for an unauthorized request", async () => {
    mocks.isAuthorized.mockReturnValue(false);
    mocks.isTrustedLocalRequest.mockReturnValue(false);
    const { ctx, captured } = mkCtx();
    expect(await handleAuthRoutes(ctx)).toBe(true);
    expect(captured.status).toBe(401);
    expect((captured.body as { access: { role: string } }).access.role).toBe(
      "GUEST",
    );
  });
});
