/**
 * Registration parity for the `/api/browser-bridge/*` surface: every path the
 * plugin advertises to the HTTP host must be reachable by the shared handler,
 * and every companion-callback path must carry the public flags the extension
 * relies on when it talks to the agent without a session cookie. A handler
 * added to `bridge.ts` without a matching entry in `plugin.ts` answers 404 in
 * production, which unit tests of the handler alone cannot detect. The runtime
 * is deliberately absent so each route resolves to the 503 runtime-unavailable
 * branch — the assertion is that the handler claims the path at all.
 */

import type http from "node:http";
import type { Route } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { browserPlugin } from "../../plugin.js";
import {
  type BrowserBridgeRouteContext,
  handleBrowserBridgeRoutes,
} from "../bridge.js";

vi.mock("@elizaos/core", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    logger: {
      debug: vi.fn(),
      error: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
    },
  };
});

vi.mock("@elizaos/agent", () => ({
  checkRateLimit: vi.fn(() => ({ allowed: true, retryAfterMs: 0 })),
  createIntegrationTelemetrySpan: vi.fn(() => ({
    failure: vi.fn(),
    success: vi.fn(),
  })),
}));

/** Replaces route-template parameters with concrete, decodable components. */
function materializePath(template: string): string {
  return template
    .replace("/:browser/", "/chrome/")
    .replace("/:id/", "/session-1/")
    .replace(/\/:id$/, "/session-1");
}

function createContext(
  method: string,
  pathname: string,
): BrowserBridgeRouteContext & {
  res: http.ServerResponse & { body?: unknown };
} {
  const res = { statusCode: 200 } as http.ServerResponse & { body?: unknown };
  return {
    req: {
      headers: {},
      socket: { remoteAddress: "127.0.0.1" },
    } as http.IncomingMessage,
    res,
    method,
    pathname,
    url: new URL(`http://127.0.0.1${pathname}`),
    state: { runtime: null, adminEntityId: null },
    json: (target, data, status = 200) => {
      target.statusCode = status;
      (target as typeof res).body = data;
    },
    error: (target, message, status = 400) => {
      target.statusCode = status;
      (target as typeof res).body = { error: message };
    },
    readJsonBody: vi.fn(async () => ({}) as never),
    decodePathComponent: (raw: string) => decodeURIComponent(raw),
  };
}

function bridgeRoutes(): Route[] {
  return (browserPlugin.routes ?? []).filter((route) =>
    route.path.startsWith("/api/browser-bridge/"),
  );
}

describe("browser bridge route registration", () => {
  it("registers the companion action-lease begin callback as a public write", () => {
    const route = bridgeRoutes().find(
      (candidate) =>
        candidate.path ===
        "/api/browser-bridge/companions/sessions/:id/actions/begin",
    );
    expect(route).toBeDefined();
    expect(route?.type).toBe("POST");
    expect((route as { public?: boolean }).public).toBe(true);
    expect((route as { publicWrite?: string }).publicWrite).toBeTruthy();
  });

  it("registers the authenticated companion preflight callback as a public write", () => {
    const route = bridgeRoutes().find(
      (candidate) =>
        candidate.path === "/api/browser-bridge/companions/preflight",
    );
    expect(route).toBeDefined();
    expect(route?.type).toBe("POST");
    expect((route as { public?: boolean }).public).toBe(true);
    expect((route as { publicWrite?: string }).publicWrite).toBeTruthy();
  });

  it("resolves every advertised bridge path to a handler branch", async () => {
    const unhandled: string[] = [];
    // The `/packages/*` family runs stateless handlers that shell out to the
    // host OS (opening a browser's extension manager, revealing a directory),
    // so it cannot be swept without real side effects; its registration is
    // covered by the packaging tests instead.
    const sweepable = bridgeRoutes().filter(
      (route) => !route.path.startsWith("/api/browser-bridge/packages"),
    );
    expect(sweepable.length).toBeGreaterThan(0);
    for (const route of sweepable) {
      const pathname = materializePath(route.path);
      const ctx = createContext(route.type, pathname);
      const handled = await handleBrowserBridgeRoutes(ctx);
      if (!handled) {
        unhandled.push(`${route.type} ${pathname}`);
      }
    }
    expect(unhandled).toEqual([]);
  });

  it("does not claim paths outside the advertised bridge surface", async () => {
    const ctx = createContext(
      "POST",
      "/api/browser-bridge/companions/sessions/session-1/actions/finish",
    );
    await expect(handleBrowserBridgeRoutes(ctx)).resolves.toBe(false);
  });
});
