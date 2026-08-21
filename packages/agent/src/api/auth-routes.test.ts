/**
 * Unit coverage for handleAuthRoutes — the pre-auth boundary: /me identity,
 * /status token state, loopback-only /pair-code, and rate-limited timing-safe
 * /pair exchange.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { handleAuthRoutes } from "./auth-routes.ts";
import type { AuthRouteContext } from "./auth-routes.ts";

type JsonFn = (res: unknown, data: unknown, status?: number) => void;
type ErrorFn = (res: unknown, message: string, status?: number) => void;

function makeCtx(
  overrides: Partial<AuthRouteContext> = {},
): { ctx: AuthRouteContext; json: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> } {
  const json = vi.fn() as unknown as JsonFn;
  const error = vi.fn() as unknown as ErrorFn;
  const ctx = {
    req: { socket: { remoteAddress: "127.0.0.1" } } as AuthRouteContext["req"],
    res: {} as AuthRouteContext["res"],
    method: "GET",
    pathname: "",
    readJsonBody: vi.fn(),
    json: ((_res, data, status) =>
      status === undefined ? json(data) : json(data, status)) as JsonFn,
    error: ((_res, message, status) =>
      status === undefined ? error(message) : error(message, status)) as ErrorFn,
    pairingEnabled: vi.fn(() => true),
    ensurePairingCode: vi.fn(() => "ABCD-EFGH"),
    normalizePairingCode: vi.fn((s: string) => s.replace(/-/g, "")),
    rateLimitPairing: vi.fn(() => true),
    getPairingExpiresAt: vi.fn(() => Date.now() + 600_000),
    clearPairing: vi.fn(),
    ...overrides,
  } as unknown as AuthRouteContext;
  return { ctx, json, error };
}

// Mock the auth helpers and schema via module mocking
vi.mock("./server-helpers-auth.ts", () => ({
  isAuthorized: vi.fn(() => false),
  isTrustedLocalRequest: vi.fn(() => true),
  resolveBoundaryRole: vi.fn(() => "GUEST"),
}));
vi.mock("@elizaos/shared", () => ({
  isCloudProvisionedContainer: vi.fn(() => false),
  resolveApiToken: vi.fn(() => undefined),
  PostAuthPairRequestSchema: {
    safeParse: vi.fn(() => ({ success: true, data: { code: "ABCDEFGH" } })),
  },
}));

import { isAuthorized, isTrustedLocalRequest, resolveBoundaryRole } from "./server-helpers-auth.ts";
import { isCloudProvisionedContainer, PostAuthPairRequestSchema, resolveApiToken } from "@elizaos/shared";

const mockIsAuthorized = vi.mocked(isAuthorized);
const mockIsTrustedLocalRequest = vi.mocked(isTrustedLocalRequest);
const mockResolveBoundaryRole = vi.mocked(resolveBoundaryRole);
const mockIsCloud = vi.mocked(isCloudProvisionedContainer);
const mockParse = vi.mocked(PostAuthPairRequestSchema.safeParse);

beforeEach(() => {
  mockIsAuthorized.mockReturnValue(false);
  mockIsTrustedLocalRequest.mockReturnValue(true);
  mockResolveBoundaryRole.mockReturnValue("GUEST");
  mockIsCloud.mockReturnValue(false);
  vi.mocked(resolveApiToken).mockReturnValue(undefined);
  mockParse.mockReturnValue({ success: true, data: { code: "ABCDEFGH" } } as never);
});

describe("GET /api/auth/me", () => {
  it("returns 401 GUEST when unauthenticated", async () => {
    mockIsAuthorized.mockReturnValue(false);
    mockIsTrustedLocalRequest.mockReturnValue(true);
    mockResolveBoundaryRole.mockReturnValue("GUEST");
    const { ctx, json } = makeCtx({ method: "GET", pathname: "/api/auth/me" });
    await handleAuthRoutes(ctx);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: "remote_password_not_configured",
        access: expect.objectContaining({ role: "GUEST", mode: "local" }),
      }),
      401,
    );
  });

  it("returns 401 remote_auth_required when token configured", async () => {
    mockIsAuthorized.mockReturnValue(false);
    vi.mocked((await import("@elizaos/shared")).resolveApiToken).mockReturnValue("secret");
    const { ctx, json } = makeCtx({ method: "GET", pathname: "/api/auth/me" });
    await handleAuthRoutes(ctx);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "remote_auth_required" }),
      401,
    );
  });

  it("returns OWNER identity when authorized locally", async () => {
    mockIsAuthorized.mockReturnValue(true);
    mockIsTrustedLocalRequest.mockReturnValue(true);
    mockResolveBoundaryRole.mockReturnValue("OWNER");
    const { ctx, json } = makeCtx({ method: "GET", pathname: "/api/auth/me" });
    await handleAuthRoutes(ctx);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({
        identity: expect.objectContaining({ id: "local-agent", kind: "machine" }),
        access: expect.objectContaining({ role: "OWNER" }),
      }),
    );
  });

  it("returns bearer identity for remote authorized callers", async () => {
    mockIsAuthorized.mockReturnValue(true);
    mockIsTrustedLocalRequest.mockReturnValue(false);
    const { ctx, json } = makeCtx({ method: "GET", pathname: "/api/auth/me" });
    await handleAuthRoutes(ctx);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({
        identity: expect.objectContaining({ id: "bearer-agent" }),
        session: expect.objectContaining({ kind: "machine" }),
      }),
    );
  });
});

describe("GET /api/auth/status", () => {
  it("reports disabled pairing in cloud containers", async () => {
    mockIsCloud.mockReturnValue(true);
    const { ctx, json } = makeCtx({ method: "GET", pathname: "/api/auth/status" });
    await handleAuthRoutes(ctx);
    expect(json).toHaveBeenCalledWith(
      { required: false, pairingEnabled: false, expiresAt: null },
    );
  });

  it("reports required + pairing state for standalone", async () => {
    mockIsCloud.mockReturnValue(false);
    vi.mocked((await import("@elizaos/shared")).resolveApiToken).mockReturnValue(undefined);
    const { ctx, json } = makeCtx({ method: "GET", pathname: "/api/auth/status" });
    await handleAuthRoutes(ctx);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({
        required: false,
        authenticated: false,
        pairingEnabled: true,
      }),
    );
  });
});

describe("GET /api/auth/pair-code", () => {
  it("rejects non-loopback callers with 403", async () => {
    mockIsTrustedLocalRequest.mockReturnValue(false);
    const { ctx, error } = makeCtx({ method: "GET", pathname: "/api/auth/pair-code" });
    await handleAuthRoutes(ctx);
    expect(error).toHaveBeenCalledWith("Pair code visible on loopback only", 403);
  });

  it("rejects cloud containers with 403", async () => {
    mockIsTrustedLocalRequest.mockReturnValue(true);
    mockIsCloud.mockReturnValue(true);
    const { ctx, error } = makeCtx({ method: "GET", pathname: "/api/auth/pair-code" });
    await handleAuthRoutes(ctx);
    expect(error).toHaveBeenCalledWith("Pairing disabled", 403);
  });

  it("returns the code on loopback", async () => {
    mockIsTrustedLocalRequest.mockReturnValue(true);
    mockIsCloud.mockReturnValue(false);
    const { ctx, json } = makeCtx({ method: "GET", pathname: "/api/auth/pair-code" });
    await handleAuthRoutes(ctx);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({ code: "ABCD-EFGH" }),
    );
  });

  it("503 when pairing disabled", async () => {
    mockIsTrustedLocalRequest.mockReturnValue(true);
    mockIsCloud.mockReturnValue(false);
    const { ctx, error } = makeCtx({
      method: "GET",
      pathname: "/api/auth/pair-code",
      pairingEnabled: vi.fn(() => false),
    });
    await handleAuthRoutes(ctx);
    expect(error).toHaveBeenCalledWith("Pairing not enabled", 503);
  });
});

describe("POST /api/auth/pair", () => {
  it("accepts the raw token from a trusted loopback caller", async () => {
    mockIsTrustedLocalRequest.mockReturnValue(true);
    mockIsCloud.mockReturnValue(false);
    vi.mocked((await import("@elizaos/shared")).resolveApiToken).mockReturnValue("correct-token");
    mockParse.mockReturnValue({ success: true, data: { code: "correct-token" } } as never);
    const { ctx, json } = makeCtx({
      method: "POST",
      pathname: "/api/auth/pair",
      readJsonBody: vi.fn(async () => ({ code: "correct-token" })),
    });
    await handleAuthRoutes(ctx);
    expect(json).toHaveBeenCalledWith({ token: "correct-token" });
  });

  it("rejects a wrong token from loopback with 403", async () => {
    mockIsTrustedLocalRequest.mockReturnValue(true);
    mockIsCloud.mockReturnValue(false);
    vi.mocked((await import("@elizaos/shared")).resolveApiToken).mockReturnValue("real-token");
    mockParse.mockReturnValue({ success: true, data: { code: "wrong-token" } } as never);
    const { ctx, error } = makeCtx({
      method: "POST",
      pathname: "/api/auth/pair",
      readJsonBody: vi.fn(async () => ({ code: "wrong-token" })),
      normalizePairingCode: vi.fn((s) => s),
      ensurePairingCode: vi.fn(() => "ABCDEFGH"),
    });
    await handleAuthRoutes(ctx);
    expect(error).toHaveBeenCalledWith("Invalid pairing code", 403);
  });

  it("returns 429 when rate-limited", async () => {
    vi.mocked(resolveApiToken).mockReturnValue("token");
    const { ctx, error } = makeCtx({
      method: "POST",
      pathname: "/api/auth/pair",
      readJsonBody: vi.fn(async () => ({ code: "anything" })),
      rateLimitPairing: vi.fn(() => false),
    });
    await handleAuthRoutes(ctx);
    expect(error).toHaveBeenCalledWith("Too many attempts. Try again later.", 429);
  });

  it("returns 400 on invalid body schema", async () => {
    mockParse.mockReturnValue({
      success: false,
      error: { issues: [{ path: ["code"], message: "invalid" }] },
    } as never);
    const { ctx, error } = makeCtx({
      method: "POST",
      pathname: "/api/auth/pair",
      readJsonBody: vi.fn(async () => ({})),
    });
    await handleAuthRoutes(ctx);
    expect(error).toHaveBeenCalledWith(
      "Invalid request body at code: invalid",
      400,
    );
  });

  it("returns 410 when the pairing code expired", async () => {
    mockIsTrustedLocalRequest.mockReturnValue(false);
    mockIsCloud.mockReturnValue(false);
    vi.mocked((await import("@elizaos/shared")).resolveApiToken).mockReturnValue("token");
    mockParse.mockReturnValue({ success: true, data: { code: "WRONG" } } as never);
    const { ctx, error } = makeCtx({
      method: "POST",
      pathname: "/api/auth/pair",
      readJsonBody: vi.fn(async () => ({ code: "WRONG" })),
      getPairingExpiresAt: vi.fn(() => Date.now() - 1000),
      ensurePairingCode: vi.fn(() => "ABCDEFGH"),
    });
    await handleAuthRoutes(ctx);
    expect(error).toHaveBeenCalledWith(
      "Pairing code expired. Check server logs for a new code.",
      410,
    );
  });
});

describe("routing", () => {
  it("returns false for non-auth paths", async () => {
    const { ctx } = makeCtx({ method: "GET", pathname: "/api/other" });
    expect(await handleAuthRoutes(ctx)).toBe(false);
  });
});
