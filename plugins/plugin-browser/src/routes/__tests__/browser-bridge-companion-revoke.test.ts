import type http from "node:http";
import type { AgentRuntime } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import type { BrowserBridgeRouteService } from "../../service.js";
import { BROWSER_BRIDGE_ROUTE_SERVICE_TYPE } from "../../service.js";
import type { BrowserBridgeRouteContext } from "../bridge.js";

vi.mock("@elizaos/core", () => ({
  logger: {
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  },
}));

vi.mock("@elizaos/agent", () => ({
  checkRateLimit: vi.fn(() => ({ allowed: true, retryAfterMs: 0 })),
  createIntegrationTelemetrySpan: vi.fn(() => ({
    failure: vi.fn(),
    success: vi.fn(),
  })),
}));

function createContext(args: {
  method: string;
  pathname: string;
  service?: Partial<BrowserBridgeRouteService> | null;
  headers?: Record<string, string>;
  body?: unknown;
  remoteAddress?: string;
  runtime?: AgentRuntime | null;
}): BrowserBridgeRouteContext & {
  res: http.ServerResponse & { body?: unknown };
} {
  const res = { statusCode: 200 } as http.ServerResponse & { body?: unknown };
  const runtime =
    args.runtime === undefined
      ? ({
          agentId: "agent-1",
          getService: (serviceType: string) =>
            serviceType === BROWSER_BRIDGE_ROUTE_SERVICE_TYPE
              ? (args.service ?? null)
              : null,
        } as AgentRuntime)
      : args.runtime;
  return {
    req: {
      headers: args.headers ?? {},
      socket: { remoteAddress: args.remoteAddress ?? "127.0.0.1" },
    } as http.IncomingMessage,
    res,
    method: args.method,
    pathname: args.pathname,
    url: new URL(`http://127.0.0.1${args.pathname}`),
    state: {
      runtime,
      adminEntityId:
        "owner-1" as BrowserBridgeRouteContext["state"]["adminEntityId"],
    },
    json: (target, data, status = 200) => {
      target.statusCode = status;
      (target as typeof res).body = data;
    },
    error: (target, message, status = 400) => {
      target.statusCode = status;
      (target as typeof res).body = { error: message };
    },
    readJsonBody: vi.fn(async () => (args.body as object | undefined) ?? null),
    decodePathComponent: (raw) => decodeURIComponent(raw),
  };
}

describe("Browser Bridge companion revoke route", () => {
  it("revokes a companion token by companion id", async () => {
    const revokedAt = "2026-05-08T12:00:00.000Z";
    const service = {
      revokeBrowserCompanion: vi.fn(async () => ({
        companion: {
          id: "companion-1",
          agentId: "agent-1",
          browser: "chrome",
          profileId: "default",
          profileLabel: "Default",
          label: "Agent Browser Bridge chrome Default",
          extensionVersion: null,
          connectionState: "disconnected",
          permissions: {
            tabs: true,
            scripting: true,
            activeTab: true,
            allOrigins: false,
            grantedOrigins: [],
            incognitoEnabled: false,
          },
          lastSeenAt: null,
          pairedAt: revokedAt,
          pairingTokenExpiresAt: "2026-06-07T12:00:00.000Z",
          pairingTokenRevokedAt: revokedAt,
          metadata: {},
          createdAt: revokedAt,
          updatedAt: revokedAt,
        },
        revokedAt,
      })),
    };
    const ctx = createContext({
      method: "POST",
      pathname: "/api/browser-bridge/companions/companion-1/revoke",
      service,
    });
    const { handleBrowserBridgeRoutes } = await import("../bridge.js");

    const handled = await handleBrowserBridgeRoutes(ctx);

    expect(handled).toBe(true);
    expect(service.revokeBrowserCompanion).toHaveBeenCalledWith(
      "companion-1",
      "owner-1",
    );
    expect(ctx.res.statusCode).toBe(200);
    expect(ctx.res.body).toMatchObject({
      revokedAt,
      companion: {
        id: "companion-1",
        pairingTokenRevokedAt: revokedAt,
      },
    });
  });

  it("returns 503 when the route service is unavailable", async () => {
    const ctx = createContext({
      method: "GET",
      pathname: "/api/browser-bridge/settings",
      service: null,
    });
    const { handleBrowserBridgeRoutes } = await import("./bridge.js");

    const handled = await handleBrowserBridgeRoutes(ctx);

    expect(handled).toBe(true);
    expect(ctx.res.statusCode).toBe(503);
    expect(ctx.res.body).toEqual({
      error: "Browser Bridge service is not available",
    });
  });

  it("returns 503 when agent runtime is unavailable", async () => {
    const ctx = createContext({
      method: "GET",
      pathname: "/api/browser-bridge/settings",
      runtime: null,
    });
    const { handleBrowserBridgeRoutes } = await import("./bridge.js");

    const handled = await handleBrowserBridgeRoutes(ctx);

    expect(handled).toBe(true);
    expect(ctx.res.statusCode).toBe(503);
    expect(ctx.res.body).toEqual({
      error: "Agent runtime is not available",
    });
  });

  it("rejects public companion routes without companion auth before calling service", async () => {
    const syncBrowserCompanion = vi.fn();
    const readJsonBody = vi.fn(async () => ({ tabs: [] }));
    const ctx = createContext({
      method: "POST",
      pathname: "/api/browser-bridge/companions/sync",
      service: { syncBrowserCompanion },
    });
    ctx.readJsonBody = readJsonBody;
    const { handleBrowserBridgeRoutes } = await import("./bridge.js");

    const handled = await handleBrowserBridgeRoutes(ctx);

    expect(handled).toBe(true);
    expect(ctx.res.statusCode).toBe(401);
    expect(ctx.res.body).toEqual({
      code: "browser_bridge_companion_auth_missing_id",
      error: "Missing X-Browser-Bridge-Companion-Id header",
    });
    expect(syncBrowserCompanion).not.toHaveBeenCalled();
    expect(readJsonBody).not.toHaveBeenCalled();
  });

  it("rejects malformed JSON bodies before service mutation", async () => {
    const updateBrowserSettings = vi.fn();
    const ctx = createContext({
      method: "POST",
      pathname: "/api/browser-bridge/settings",
      service: { updateBrowserSettings },
      body: ["not", "an", "object"],
    });
    const { handleBrowserBridgeRoutes } = await import("./bridge.js");

    const handled = await handleBrowserBridgeRoutes(ctx);

    expect(handled).toBe(true);
    expect(ctx.res.statusCode).toBe(400);
    expect(ctx.res.body).toEqual({
      error: "request body must be a JSON object",
    });
    expect(updateBrowserSettings).not.toHaveBeenCalled();
  });

  it("rejects malformed decoded package paths without building packages", async () => {
    const ctx = createContext({
      method: "POST",
      pathname: "/api/browser-bridge/packages/%/build",
      service: {},
    });
    ctx.decodePathComponent = vi.fn((_raw, res) => {
      ctx.error(res, "invalid browser package target", 400);
      return null;
    });
    const { handleBrowserBridgeRoutes } = await import("./bridge.js");

    const handled = await handleBrowserBridgeRoutes(ctx);

    expect(handled).toBe(true);
    expect(ctx.res.statusCode).toBe(400);
    expect(ctx.res.body).toEqual({
      error: "invalid browser package target",
    });
  });

  it("preserves service status errors with codes", async () => {
    const error = Object.assign(new Error("pairing token revoked"), {
      code: "browser_bridge_companion_auth_revoked",
      status: 401,
    });
    const ctx = createContext({
      method: "GET",
      pathname: "/api/browser-bridge/settings",
      service: {
        getBrowserSettings: vi.fn(async () => {
          throw error;
        }),
      },
    });
    const { handleBrowserBridgeRoutes } = await import("./bridge.js");

    const handled = await handleBrowserBridgeRoutes(ctx);

    expect(handled).toBe(true);
    expect(ctx.res.statusCode).toBe(401);
    expect(ctx.res.body).toEqual({
      code: "browser_bridge_companion_auth_revoked",
      error: "pairing token revoked",
    });
  });

  it("rejects local package helpers from non-loopback callers", async () => {
    const ctx = createContext({
      method: "POST",
      pathname: "/api/browser-bridge/packages/open-path",
      remoteAddress: "203.0.113.10",
      service: {},
      body: { target: "chrome" },
    });
    const { handleBrowserBridgeRoutes } = await import("./bridge.js");

    const handled = await handleBrowserBridgeRoutes(ctx);

    expect(handled).toBe(true);
    expect(ctx.res.statusCode).toBe(403);
    expect(ctx.res.body).toEqual({
      error:
        "Local extension install helpers can only run on the same machine as the agent",
    });
  });
});
