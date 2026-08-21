/**
 * Browser bridge route tests for companion revoke authorization and state changes.
 */

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
  it("binds action-begin requests to authenticated companion credentials", async () => {
    const beginBrowserSessionActionFromCompanion = vi.fn(async () => ({
      id: "session-1",
      currentActionIndex: 0,
    }));
    const ctx = createContext({
      method: "POST",
      pathname:
        "/api/browser-bridge/companions/sessions/session-1/actions/begin",
      headers: {
        authorization: "Bearer pairing-token-1",
        "x-browser-bridge-companion-id": "companion-1",
      },
      body: {
        currentActionIndex: 0,
        actionId: "action-1",
        attemptId: "attempt-1",
      },
      service: { beginBrowserSessionActionFromCompanion },
    });
    const { handleBrowserBridgeRoutes } = await import("../bridge.js");

    const handled = await handleBrowserBridgeRoutes(ctx);

    expect(handled).toBe(true);
    expect(beginBrowserSessionActionFromCompanion).toHaveBeenCalledWith(
      "companion-1",
      "pairing-token-1",
      "session-1",
      {
        currentActionIndex: 0,
        actionId: "action-1",
        attemptId: "attempt-1",
      },
      "owner-1",
    );
    expect(ctx.res.statusCode).toBe(200);
  });

  it("rejects action-begin requests without companion authentication", async () => {
    const beginBrowserSessionActionFromCompanion = vi.fn();
    const ctx = createContext({
      method: "POST",
      pathname:
        "/api/browser-bridge/companions/sessions/session-1/actions/begin",
      body: {
        currentActionIndex: 0,
        actionId: "action-1",
        attemptId: "attempt-1",
      },
      service: { beginBrowserSessionActionFromCompanion },
    });
    const { handleBrowserBridgeRoutes } = await import("../bridge.js");

    const handled = await handleBrowserBridgeRoutes(ctx);

    expect(handled).toBe(true);
    expect(beginBrowserSessionActionFromCompanion).not.toHaveBeenCalled();
    expect(ctx.res.statusCode).toBe(401);
  });

  it("fails closed instead of minting credentials for a loopback extension", async () => {
    const request = {
      browser: "chrome" as const,
      profileId: "default",
    };
    const getService = vi.fn();
    const ctx = createContext({
      method: "POST",
      pathname: "/api/browser-bridge/companions/auto-pair",
      headers: { origin: "chrome-extension://installed-extension" },
      body: request,
      runtime: {
        agentId: "agent-1",
        getService,
      } as AgentRuntime,
    });
    const { handleBrowserBridgeRoutes } = await import("../bridge.js");

    const handled = await handleBrowserBridgeRoutes(ctx);

    expect(handled).toBe(true);
    expect(getService).not.toHaveBeenCalled();
    expect(ctx.res.statusCode).toBe(410);
    expect(ctx.res.body).toEqual({
      error:
        "Automatic browser pairing is disabled. Create an authenticated pairing in Eliza and import its pairing JSON in the extension.",
    });
  });

  it("fails closed before parsing attacker-controlled auto-pair payloads", async () => {
    const readJsonBody = vi.fn(async () => ({ browser: "chrome" }));
    const ctx = createContext({
      method: "POST",
      pathname: "/api/browser-bridge/companions/auto-pair",
      headers: { origin: "chrome-extension://installed-extension" },
      body: { browser: "chrome" },
      remoteAddress: "192.0.2.10",
      service: {},
    });
    ctx.readJsonBody = readJsonBody;
    const { handleBrowserBridgeRoutes } = await import("../bridge.js");

    const handled = await handleBrowserBridgeRoutes(ctx);

    expect(handled).toBe(true);
    expect(readJsonBody).not.toHaveBeenCalled();
    expect(ctx.res.statusCode).toBe(410);
  });

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

  it("resets revocation only through the owner-authenticated route", async () => {
    const resetAt = "2026-05-08T12:05:00.000Z";
    const resetBrowserCompanionRevocation = vi.fn(async () => ({
      companion: { id: "companion-1", pairingTokenRevokedAt: null },
      resetAt,
    }));
    const ctx = createContext({
      method: "POST",
      pathname: "/api/browser-bridge/companions/companion-1/reset-revocation",
      service: { resetBrowserCompanionRevocation },
    });
    const { handleBrowserBridgeRoutes } = await import("../bridge.js");

    const handled = await handleBrowserBridgeRoutes(ctx);

    expect(handled).toBe(true);
    expect(resetBrowserCompanionRevocation).toHaveBeenCalledWith(
      "companion-1",
      "owner-1",
    );
    expect(ctx.res.statusCode).toBe(200);
    expect(ctx.res.body).toMatchObject({ resetAt });
  });

  it("returns the canonical revoked code from pairing failures", async () => {
    const createBrowserCompanionPairing = vi.fn(async () => {
      throw Object.assign(
        new Error("Browser companion enrollment was revoked"),
        {
          status: 409,
          code: "revoked",
        },
      );
    });
    const ctx = createContext({
      method: "POST",
      pathname: "/api/browser-bridge/companions/pair",
      body: {
        browser: "chrome",
        profileId: "profile-1",
        pairingKind: "native_enrollment",
      },
      service: { createBrowserCompanionPairing },
    });
    const { handleBrowserBridgeRoutes } = await import("../bridge.js");

    await handleBrowserBridgeRoutes(ctx);

    expect(ctx.res.statusCode).toBe(409);
    expect(ctx.res.body).toEqual({
      code: "revoked",
      error: "Browser companion enrollment was revoked",
    });
  });

  it("forwards native enrollment intent to the pairing service", async () => {
    const pairingTokenExpiresAt = "2026-05-08T12:05:00.000Z";
    const createBrowserCompanionPairing = vi.fn(async () => ({
      companion: { id: "companion-1" },
      pairingToken: "short-lived-token",
      pairingTokenExpiresAt,
    }));
    const body = {
      browser: "firefox" as const,
      profileId: "profile-native",
      pairingKind: "native_enrollment" as const,
    };
    const ctx = createContext({
      method: "POST",
      pathname: "/api/browser-bridge/companions/pair",
      body,
      service: { createBrowserCompanionPairing },
    });
    const { handleBrowserBridgeRoutes } = await import("../bridge.js");

    await handleBrowserBridgeRoutes(ctx);

    expect(createBrowserCompanionPairing).toHaveBeenCalledWith(body, "owner-1");
    expect(ctx.res.statusCode).toBe(201);
    expect(ctx.res.body).toMatchObject({ pairingTokenExpiresAt });
  });

  it("returns 503 when the route service is unavailable", async () => {
    const ctx = createContext({
      method: "GET",
      pathname: "/api/browser-bridge/settings",
      service: null,
    });
    const { handleBrowserBridgeRoutes } = await import("../bridge.js");

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
    const { handleBrowserBridgeRoutes } = await import("../bridge.js");

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
    const { handleBrowserBridgeRoutes } = await import("../bridge.js");

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

  it("authenticates preflight before reading its body and returns no browser data", async () => {
    const readJsonBody = vi.fn(async () => ({ companion: {} }));
    const unauthenticated = createContext({
      method: "POST",
      pathname: "/api/browser-bridge/companions/preflight",
      service: { preflightBrowserCompanion: vi.fn() },
    });
    unauthenticated.readJsonBody = readJsonBody;
    const { handleBrowserBridgeRoutes } = await import("../bridge.js");
    await handleBrowserBridgeRoutes(unauthenticated);
    expect(unauthenticated.res.statusCode).toBe(401);
    expect(readJsonBody).not.toHaveBeenCalled();

    const response = {
      companion: { id: "companion-1" },
      settings: { enabled: false },
      settingsVersion: "bbsv1_hash",
    };
    const preflightBrowserCompanion = vi.fn(async () => response as never);
    const authenticated = createContext({
      method: "POST",
      pathname: "/api/browser-bridge/companions/preflight",
      headers: {
        "x-browser-bridge-companion-id": "companion-1",
        authorization: "Bearer token",
      },
      body: { companion: { browser: "chrome", profileId: "profile-1" } },
      service: { preflightBrowserCompanion },
    });
    await handleBrowserBridgeRoutes(authenticated);
    expect(authenticated.res.body).toEqual(response);
    expect(authenticated.res.body).not.toHaveProperty("session");
    expect(authenticated.res.body).not.toHaveProperty("tabs");
    expect(authenticated.res.body).not.toHaveProperty("currentPage");
  });

  it("rejects malformed JSON bodies before service mutation", async () => {
    const updateBrowserSettings = vi.fn();
    const ctx = createContext({
      method: "POST",
      pathname: "/api/browser-bridge/settings",
      service: { updateBrowserSettings },
      body: ["not", "an", "object"],
    });
    const { handleBrowserBridgeRoutes } = await import("../bridge.js");

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
    const { handleBrowserBridgeRoutes } = await import("../bridge.js");

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
    const { handleBrowserBridgeRoutes } = await import("../bridge.js");

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
    const { handleBrowserBridgeRoutes } = await import("../bridge.js");

    const handled = await handleBrowserBridgeRoutes(ctx);

    expect(handled).toBe(true);
    expect(ctx.res.statusCode).toBe(403);
    expect(ctx.res.body).toEqual({
      error:
        "Local extension install helpers can only run on the same machine as the agent",
    });
  });
});
