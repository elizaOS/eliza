/** Exercises auth API route behavior with deterministic OAuth and session fixtures. */
import type http from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { handleAuthRoutes } from "../../src/api/auth-routes";

type CapturedResponse = {
  status: number;
  body: unknown;
};

function createAuthRouteHarness(options: {
  headers?: Record<string, string>;
  method?: string;
  pathname?: string;
  remoteAddress?: string;
  pairingEnabled?: boolean;
  ensurePairingCode?: () => string | null;
  getPairingExpiresAt?: () => number;
}): {
  captured: CapturedResponse;
  ctx: Parameters<typeof handleAuthRoutes>[0];
} {
  const captured: CapturedResponse = {
    status: 200,
    body: null,
  };
  const req = {
    headers: {
      host: "127.0.0.1:31337",
      ...options.headers,
    },
    socket: {
      remoteAddress: options.remoteAddress ?? "127.0.0.1",
    },
  } as http.IncomingMessage;
  const res = {} as http.ServerResponse;
  const expiresAt = options.getPairingExpiresAt?.() ?? Date.now() + 60_000;

  return {
    captured,
    ctx: {
      req,
      res,
      method: options.method ?? "GET",
      pathname: options.pathname ?? "/api/auth/me",
      readJsonBody: async () => null,
      json: (_res, data, status = 200) => {
        captured.status = status;
        captured.body = data;
      },
      error: (_res, message, status = 500) => {
        captured.status = status;
        captured.body = { error: message };
      },
      pairingEnabled: options.pairingEnabled ?? (() => false),
      ensurePairingCode: options.ensurePairingCode ?? (() => null),
      normalizePairingCode: (code) => code,
      rateLimitPairing: () => true,
      getPairingExpiresAt: () => expiresAt,
      clearPairing: () => {},
    },
  };
}

describe("handleAuthRoutes", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...originalEnv };
    process.env.ELIZA_REQUIRE_LOCAL_AUTH = "1";
    process.env.ELIZA_API_TOKEN = "native-token";
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("returns a local session for the authorized on-device agent token", async () => {
    const { ctx, captured } = createAuthRouteHarness({
      headers: {
        authorization: "Bearer native-token",
      },
    });

    await expect(handleAuthRoutes(ctx)).resolves.toBe(true);

    expect(captured.status).toBe(200);
    expect(captured.body).toMatchObject({
      identity: {
        id: "local-agent",
        displayName: "Local Agent",
        kind: "machine",
      },
      session: {
        id: "local",
        kind: "local",
        expiresAt: null,
      },
      access: {
        mode: "local",
        passwordConfigured: false,
        ownerConfigured: false,
      },
    });
  });

  it("requires the bearer token when Android local auth is enforced", async () => {
    const { ctx, captured } = createAuthRouteHarness({});

    await expect(handleAuthRoutes(ctx)).resolves.toBe(true);

    expect(captured.status).toBe(401);
    expect(captured.body).toMatchObject({
      reason: "remote_auth_required",
      access: {
        mode: "local",
        passwordConfigured: true,
        ownerConfigured: false,
      },
    });
  });

  describe("GET /api/auth/pair-code", () => {
    it("returns the pairing code for trusted loopback callers", async () => {
      delete process.env.ELIZA_REQUIRE_LOCAL_AUTH;
      const expiresAt = Date.now() + 600_000;
      const { ctx, captured } = createAuthRouteHarness({
        pathname: "/api/auth/pair-code",
        pairingEnabled: () => true,
        ensurePairingCode: () => "ABCD-EFGH",
        getPairingExpiresAt: () => expiresAt,
      });

      await expect(handleAuthRoutes(ctx)).resolves.toBe(true);

      expect(captured.status).toBe(200);
      expect(captured.body).toEqual({ code: "ABCD-EFGH", expiresAt });
    });

    it("rejects non-loopback callers", async () => {
      delete process.env.ELIZA_REQUIRE_LOCAL_AUTH;
      const { ctx, captured } = createAuthRouteHarness({
        pathname: "/api/auth/pair-code",
        remoteAddress: "192.168.1.50",
        pairingEnabled: () => true,
        ensurePairingCode: () => "ABCD-EFGH",
      });

      await expect(handleAuthRoutes(ctx)).resolves.toBe(true);

      expect(captured.status).toBe(403);
      expect(captured.body).toEqual({
        error: "Pair code visible on loopback only",
      });
    });

    it("returns 503 when pairing is disabled", async () => {
      delete process.env.ELIZA_REQUIRE_LOCAL_AUTH;
      const { ctx, captured } = createAuthRouteHarness({
        pathname: "/api/auth/pair-code",
        pairingEnabled: () => false,
      });

      await expect(handleAuthRoutes(ctx)).resolves.toBe(true);

      expect(captured.status).toBe(503);
      expect(captured.body).toEqual({ error: "Pairing not enabled" });
    });
  });
});
