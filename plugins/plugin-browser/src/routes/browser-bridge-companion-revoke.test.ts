import type http from "node:http";
import type { AgentRuntime } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import type { BrowserBridgeRouteService } from "../service.js";
import { BROWSER_BRIDGE_ROUTE_SERVICE_TYPE } from "../service.js";
import type { BrowserBridgeRouteContext } from "./bridge.js";

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
  service: Partial<BrowserBridgeRouteService>;
}): BrowserBridgeRouteContext & {
  res: http.ServerResponse & { body?: unknown };
} {
  const res = { statusCode: 200 } as http.ServerResponse & { body?: unknown };
  const runtime = {
    agentId: "agent-1",
    getService: (serviceType: string) =>
      serviceType === BROWSER_BRIDGE_ROUTE_SERVICE_TYPE ? args.service : null,
  } as AgentRuntime;
  return {
    req: {
      headers: {},
      socket: { remoteAddress: "127.0.0.1" },
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
    readJsonBody: vi.fn(),
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
    const { handleBrowserBridgeRoutes } = await import("./bridge.js");

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
});
