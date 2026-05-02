import type http from "node:http";
import { describe, expect, it, vi } from "vitest";
import {
  type BrowserBridgeRouteContext,
  handleBrowserBridgeRoutes,
} from "./routes.ts";
import {
  BROWSER_BRIDGE_ROUTE_SERVICE_TYPE,
  type BrowserBridgeRouteService,
} from "./service.ts";

function createContext(
  overrides: Partial<BrowserBridgeRouteContext> = {},
): BrowserBridgeRouteContext {
  const url = new URL(
    overrides.req?.url ?? "/api/browser-bridge/companions/sync",
    "http://127.0.0.1",
  );
  const service = {
    syncBrowserCompanion: vi.fn(),
  } as unknown as BrowserBridgeRouteService;
  const getService = vi.fn((serviceType: string) =>
    serviceType === BROWSER_BRIDGE_ROUTE_SERVICE_TYPE ? service : null,
  );
  return {
    req: {
      url: `${url.pathname}${url.search}`,
      headers: {},
      socket: { remoteAddress: "127.0.0.1" },
    } as unknown as http.IncomingMessage,
    res: {
      writeHead: vi.fn(),
      end: vi.fn(),
    } as unknown as http.ServerResponse,
    method: "POST",
    pathname: url.pathname,
    url,
    state: {
      runtime: {
        agentId: "00000000-0000-0000-0000-000000000001",
        getService,
      } as BrowserBridgeRouteContext["state"]["runtime"],
      adminEntityId: null,
    },
    json: vi.fn(),
    error: vi.fn(),
    readJsonBody: vi.fn(async () => ({
      companion: {
        browser: "chrome",
        profileId: "default",
        label: "Chrome",
      },
      tabs: [],
    })),
    decodePathComponent: (raw) => decodeURIComponent(raw),
    ...overrides,
  };
}

describe("browser bridge companion routes", () => {
  it("requires companion id and bearer pairing token on companion sync", async () => {
    const context = createContext();

    await expect(handleBrowserBridgeRoutes(context)).resolves.toBe(true);

    expect(context.error).toHaveBeenCalledWith(
      context.res,
      "Missing X-Browser-Bridge-Companion-Id header",
      401,
    );
    expect(context.state.runtime?.getService).toHaveBeenCalledWith(
      BROWSER_BRIDGE_ROUTE_SERVICE_TYPE,
    );
    const service = context.state.runtime?.getService(
      BROWSER_BRIDGE_ROUTE_SERVICE_TYPE,
    ) as BrowserBridgeRouteService;
    expect(service.syncBrowserCompanion).not.toHaveBeenCalled();
  });

  it("syncs companions through the browser bridge route service", async () => {
    const context = createContext({
      req: {
        url: "/api/browser-bridge/companions/sync",
        headers: {
          "x-browser-bridge-companion-id": "companion-1",
          authorization: "Bearer pair-token",
        },
        socket: { remoteAddress: "127.0.0.1" },
      } as unknown as http.IncomingMessage,
    });
    const service = context.state.runtime?.getService(
      BROWSER_BRIDGE_ROUTE_SERVICE_TYPE,
    ) as BrowserBridgeRouteService;

    await expect(handleBrowserBridgeRoutes(context)).resolves.toBe(true);

    expect(context.state.runtime?.getService).toHaveBeenCalledWith(
      BROWSER_BRIDGE_ROUTE_SERVICE_TYPE,
    );
    expect(service.syncBrowserCompanion).toHaveBeenCalledWith(
      "companion-1",
      "pair-token",
      expect.objectContaining({
        tabs: [],
      }),
      null,
    );
  });
});
