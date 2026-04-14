/**
 * Unit tests for Vincent API routes and plugin registration.
 *
 * Tests the route handler directly with mock HTTP req/res objects.
 * External Vincent API calls (heyvincent.ai) are mocked via vi.stubGlobal.
 */

import http from "node:http";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { handleVincentRoute } from "./routes";
import { vincentPlugin } from "./plugin";
import type { VincentRouteState } from "./routes";

// ---------------------------------------------------------------------------
// Helpers: mock HTTP req/res
// ---------------------------------------------------------------------------

function mockReq(
  method: string,
  url: string,
  body?: string,
): http.IncomingMessage {
  const { Readable } = require("node:stream");
  const readable = new Readable();
  readable._read = () => {};
  if (body) {
    readable.push(body);
    readable.push(null);
  } else {
    readable.push(null);
  }
  readable.method = method;
  readable.url = url;
  readable.headers = { host: "localhost:31337" };
  return readable as http.IncomingMessage;
}

function mockRes(): http.ServerResponse & {
  _status: number;
  _headers: Record<string, string>;
  _body: string;
  _ended: boolean;
} {
  const res = {
    _status: 0,
    _headers: {} as Record<string, string>,
    _body: "",
    _ended: false,
    headersSent: false,
    statusCode: 200,
    setHeader(name: string, value: string) {
      res._headers[name.toLowerCase()] = value;
    },
    end(data?: string) {
      res._body = data ?? "";
      res._ended = true;
      res._status = res.statusCode;
    },
    writeHead(status: number, headers?: Record<string, string>) {
      res.statusCode = status;
      if (headers) {
        for (const [k, v] of Object.entries(headers)) {
          res._headers[k.toLowerCase()] = v;
        }
      }
    },
  };
  return res as unknown as http.ServerResponse & {
    _status: number;
    _headers: Record<string, string>;
    _body: string;
    _ended: boolean;
  };
}

function parseBody(res: ReturnType<typeof mockRes>): Record<string, unknown> {
  return JSON.parse(res._body) as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Mock config
// ---------------------------------------------------------------------------

function makeConfig(vincent?: {
  accessToken?: string;
  refreshToken?: string | null;
  clientId?: string;
  connectedAt?: number;
}): VincentRouteState["config"] {
  const config: Record<string, unknown> = {};
  if (vincent) {
    (config as Record<string, unknown>).vincent = {
      accessToken: vincent.accessToken ?? "test-token",
      refreshToken: vincent.refreshToken ?? null,
      clientId: vincent.clientId ?? "test-client",
      connectedAt: vincent.connectedAt ?? 1000,
    };
  }
  return config as VincentRouteState["config"];
}

// Stub saveElizaConfig so it doesn't hit disk
vi.mock("@elizaos/agent/config/config", () => ({
  loadElizaConfig: () => makeConfig(),
  saveElizaConfig: vi.fn().mockResolvedValue(undefined),
}));

// Provide sendJson / sendJsonError — routes.ts imports them from @elizaos/app-core
vi.mock("@elizaos/app-core", async (importOriginal) => {
  // Try to get the original module; if it fails, provide stubs
  let original: Record<string, unknown> = {};
  try {
    original = (await importOriginal()) as Record<string, unknown>;
  } catch {
    // noop
  }
  return {
    ...original,
    sendJson: (
      res: http.ServerResponse,
      status: number,
      data: unknown,
    ) => {
      res.statusCode = status;
      res.setHeader("content-type", "application/json; charset=utf-8");
      res.end(JSON.stringify(data));
    },
    sendJsonError: (
      res: http.ServerResponse,
      status: number,
      message: string,
    ) => {
      res.statusCode = status;
      res.setHeader("content-type", "application/json; charset=utf-8");
      res.end(JSON.stringify({ error: message }));
    },
  };
});

// ---------------------------------------------------------------------------
// Plugin shape tests
// ---------------------------------------------------------------------------

describe("vincentPlugin", () => {
  it("has the correct plugin name", () => {
    expect(vincentPlugin.name).toBe("@elizaos/app-vincent");
  });

  it("exports routes array", () => {
    expect(Array.isArray(vincentPlugin.routes)).toBe(true);
    expect(vincentPlugin.routes!.length).toBeGreaterThan(0);
  });

  it("all routes have rawPath: true", () => {
    for (const route of vincentPlugin.routes!) {
      expect((route as Record<string, unknown>).rawPath).toBe(true);
    }
  });

  it("all routes have a handler function", () => {
    for (const route of vincentPlugin.routes!) {
      expect(typeof route.handler).toBe("function");
    }
  });

  it("/callback/vincent is marked public", () => {
    const callbackRoute = vincentPlugin.routes!.find(
      (r) => r.path === "/callback/vincent",
    );
    expect(callbackRoute).toBeDefined();
    expect(callbackRoute!.public).toBe(true);
  });

  it("registers all expected route paths", () => {
    const paths = vincentPlugin.routes!.map((r) => `${r.type} ${r.path}`);
    expect(paths).toContain("POST /api/vincent/start-login");
    expect(paths).toContain("GET /callback/vincent");
    expect(paths).toContain("POST /api/vincent/register");
    expect(paths).toContain("POST /api/vincent/token");
    expect(paths).toContain("GET /api/vincent/status");
    expect(paths).toContain("POST /api/vincent/disconnect");
    expect(paths).toContain("GET /api/vincent/vault-status");
    expect(paths).toContain("GET /api/vincent/trading-profile");
    expect(paths).toContain("GET /api/vincent/strategy");
    expect(paths).toContain("POST /api/vincent/strategy");
    expect(paths).toContain("POST /api/vincent/trading/start");
    expect(paths).toContain("POST /api/vincent/trading/stop");
  });
});

// ---------------------------------------------------------------------------
// Route handler tests
// ---------------------------------------------------------------------------

describe("handleVincentRoute", () => {
  describe("GET /api/vincent/status", () => {
    it("returns connected: false when no tokens exist", async () => {
      const req = mockReq("GET", "/api/vincent/status");
      const res = mockRes();
      const state = { config: makeConfig() };

      const handled = await handleVincentRoute(
        req,
        res,
        "/api/vincent/status",
        "GET",
        state,
      );

      expect(handled).toBe(true);
      expect(res._ended).toBe(true);
      const body = parseBody(res);
      expect(body.connected).toBe(false);
      expect(body.connectedAt).toBeNull();
    });

    it("returns connected: true when tokens exist", async () => {
      const req = mockReq("GET", "/api/vincent/status");
      const res = mockRes();
      const state = {
        config: makeConfig({ accessToken: "real-token", connectedAt: 12345 }),
      };

      const handled = await handleVincentRoute(
        req,
        res,
        "/api/vincent/status",
        "GET",
        state,
      );

      expect(handled).toBe(true);
      const body = parseBody(res);
      expect(body.connected).toBe(true);
      expect(body.connectedAt).toBe(12345);
    });
  });

  describe("POST /api/vincent/disconnect", () => {
    it("clears tokens and returns ok", async () => {
      const req = mockReq("POST", "/api/vincent/disconnect");
      const res = mockRes();
      const config = makeConfig({ accessToken: "to-remove" });
      const state = { config };

      const handled = await handleVincentRoute(
        req,
        res,
        "/api/vincent/disconnect",
        "POST",
        state,
      );

      expect(handled).toBe(true);
      const body = parseBody(res);
      expect(body.ok).toBe(true);
      // Vincent tokens should be cleared from config
      expect(
        (config as unknown as Record<string, unknown>).vincent,
      ).toBeUndefined();
    });
  });

  describe("GET /api/vincent/vault-status", () => {
    it("returns not connected when no tokens", async () => {
      const req = mockReq("GET", "/api/vincent/vault-status");
      const res = mockRes();
      const state = { config: makeConfig() };

      const handled = await handleVincentRoute(
        req,
        res,
        "/api/vincent/vault-status",
        "GET",
        state,
      );

      expect(handled).toBe(true);
      const body = parseBody(res);
      expect(body.connected).toBe(false);
    });

    it("returns connected with null placeholders when connected", async () => {
      const req = mockReq("GET", "/api/vincent/vault-status");
      const res = mockRes();
      const state = { config: makeConfig({ accessToken: "test" }) };

      const handled = await handleVincentRoute(
        req,
        res,
        "/api/vincent/vault-status",
        "GET",
        state,
      );

      expect(handled).toBe(true);
      const body = parseBody(res);
      expect(body.connected).toBe(true);
      expect(body.evmAddress).toBeNull();
      expect(body.solanaAddress).toBeNull();
    });
  });

  describe("GET /api/vincent/trading-profile", () => {
    it("returns not connected when no tokens", async () => {
      const req = mockReq("GET", "/api/vincent/trading-profile");
      const res = mockRes();
      const state = { config: makeConfig() };

      const handled = await handleVincentRoute(
        req,
        res,
        "/api/vincent/trading-profile",
        "GET",
        state,
      );

      expect(handled).toBe(true);
      const body = parseBody(res);
      expect(body.connected).toBe(false);
      expect(body.profile).toBeNull();
    });

    it("returns stub profile when connected", async () => {
      const req = mockReq("GET", "/api/vincent/trading-profile");
      const res = mockRes();
      const state = { config: makeConfig({ accessToken: "test" }) };

      const handled = await handleVincentRoute(
        req,
        res,
        "/api/vincent/trading-profile",
        "GET",
        state,
      );

      expect(handled).toBe(true);
      const body = parseBody(res);
      expect(body.connected).toBe(true);
      expect(body.profile).toBeDefined();
      const profile = body.profile as Record<string, unknown>;
      expect(profile.totalPnl).toBe("0");
      expect(profile.totalSwaps).toBe(0);
    });
  });

  describe("GET /api/vincent/strategy", () => {
    it("returns not connected when no tokens", async () => {
      const req = mockReq("GET", "/api/vincent/strategy");
      const res = mockRes();
      const state = { config: makeConfig() };

      const handled = await handleVincentRoute(
        req,
        res,
        "/api/vincent/strategy",
        "GET",
        state,
      );

      expect(handled).toBe(true);
      const body = parseBody(res);
      expect(body.connected).toBe(false);
      expect(body.strategy).toBeNull();
    });

    it("returns default strategy when connected", async () => {
      const req = mockReq("GET", "/api/vincent/strategy");
      const res = mockRes();
      const state = { config: makeConfig({ accessToken: "test" }) };

      const handled = await handleVincentRoute(
        req,
        res,
        "/api/vincent/strategy",
        "GET",
        state,
      );

      expect(handled).toBe(true);
      const body = parseBody(res);
      expect(body.connected).toBe(true);
      const strategy = body.strategy as Record<string, unknown>;
      expect(strategy.name).toBe("manual");
      expect(strategy.dryRun).toBe(false);
      expect(strategy.running).toBe(false);
    });
  });

  describe("POST /api/vincent/strategy", () => {
    it("rejects when not connected", async () => {
      const req = mockReq(
        "POST",
        "/api/vincent/strategy",
        JSON.stringify({ strategy: "dca" }),
      );
      const res = mockRes();
      const state = { config: makeConfig() };

      const handled = await handleVincentRoute(
        req,
        res,
        "/api/vincent/strategy",
        "POST",
        state,
      );

      expect(handled).toBe(true);
      expect(res.statusCode).toBe(401);
    });

    it("updates strategy when connected", async () => {
      const req = mockReq(
        "POST",
        "/api/vincent/strategy",
        JSON.stringify({ strategy: "dca", dryRun: true }),
      );
      const res = mockRes();
      const config = makeConfig({ accessToken: "test" });
      const state = { config };

      const handled = await handleVincentRoute(
        req,
        res,
        "/api/vincent/strategy",
        "POST",
        state,
      );

      expect(handled).toBe(true);
      const body = parseBody(res);
      expect(body.ok).toBe(true);
      const updated = body.strategy as Record<string, unknown>;
      expect(updated.strategy).toBe("dca");
      expect(updated.dryRun).toBe(true);
    });
  });

  describe("POST /api/vincent/trading/start", () => {
    it("rejects when not connected", async () => {
      const req = mockReq("POST", "/api/vincent/trading/start");
      const res = mockRes();
      const state = { config: makeConfig() };

      const handled = await handleVincentRoute(
        req,
        res,
        "/api/vincent/trading/start",
        "POST",
        state,
      );

      expect(handled).toBe(true);
      expect(res.statusCode).toBe(401);
    });

    it("starts trading when connected", async () => {
      const req = mockReq("POST", "/api/vincent/trading/start");
      const res = mockRes();
      const state = { config: makeConfig({ accessToken: "test" }) };

      const handled = await handleVincentRoute(
        req,
        res,
        "/api/vincent/trading/start",
        "POST",
        state,
      );

      expect(handled).toBe(true);
      const body = parseBody(res);
      expect(body.ok).toBe(true);
      expect(body.running).toBe(true);
    });
  });

  describe("POST /api/vincent/trading/stop", () => {
    it("stops trading when connected", async () => {
      const req = mockReq("POST", "/api/vincent/trading/stop");
      const res = mockRes();
      const state = { config: makeConfig({ accessToken: "test" }) };

      const handled = await handleVincentRoute(
        req,
        res,
        "/api/vincent/trading/stop",
        "POST",
        state,
      );

      expect(handled).toBe(true);
      const body = parseBody(res);
      expect(body.ok).toBe(true);
      expect(body.running).toBe(false);
    });
  });

  describe("unmatched routes", () => {
    it("returns false for unknown paths", async () => {
      const req = mockReq("GET", "/api/something/else");
      const res = mockRes();
      const state = { config: makeConfig() };

      const handled = await handleVincentRoute(
        req,
        res,
        "/api/something/else",
        "GET",
        state,
      );

      expect(handled).toBe(false);
    });
  });

  describe("POST /api/vincent/start-login", () => {
    let originalFetch: typeof globalThis.fetch;

    beforeEach(() => {
      originalFetch = globalThis.fetch;
    });

    afterEach(() => {
      globalThis.fetch = originalFetch;
    });

    it("returns authUrl on successful registration", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ client_id: "mock-client-id" }),
      }) as unknown as typeof fetch;

      const req = mockReq(
        "POST",
        "/api/vincent/start-login",
        JSON.stringify({ appName: "TestApp" }),
      );
      const res = mockRes();
      const state = { config: makeConfig() };

      const handled = await handleVincentRoute(
        req,
        res,
        "/api/vincent/start-login",
        "POST",
        state,
      );

      expect(handled).toBe(true);
      const body = parseBody(res);
      expect(body.authUrl).toBeDefined();
      expect(typeof body.authUrl).toBe("string");
      expect(body.state).toBeDefined();
      expect(body.redirectUri).toBe(
        "http://localhost:31337/callback/vincent",
      );
      // Verify the authUrl contains the expected params
      const authUrl = new URL(body.authUrl as string);
      expect(authUrl.searchParams.get("client_id")).toBe("mock-client-id");
      expect(authUrl.searchParams.get("code_challenge_method")).toBe("S256");
    });

    it("returns error when Vincent register fails", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        text: () => Promise.resolve("Vincent is down"),
      }) as unknown as typeof fetch;

      const req = mockReq("POST", "/api/vincent/start-login", "{}");
      const res = mockRes();
      const state = { config: makeConfig() };

      const handled = await handleVincentRoute(
        req,
        res,
        "/api/vincent/start-login",
        "POST",
        state,
      );

      expect(handled).toBe(true);
      expect(res.statusCode).toBe(500);
    });

    it("returns 400 when Host header is missing", async () => {
      const { Readable } = require("node:stream");
      const readable = new Readable();
      readable._read = () => {};
      readable.push("{}");
      readable.push(null);
      readable.method = "POST";
      readable.url = "/api/vincent/start-login";
      readable.headers = {}; // no host
      const req = readable as http.IncomingMessage;
      const res = mockRes();
      const state = { config: makeConfig() };

      const handled = await handleVincentRoute(
        req,
        res,
        "/api/vincent/start-login",
        "POST",
        state,
      );

      expect(handled).toBe(true);
      expect(res.statusCode).toBe(400);
    });
  });
});
