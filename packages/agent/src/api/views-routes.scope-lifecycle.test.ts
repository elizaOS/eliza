/**
 * Covers final release of disconnected client view scopes through the real
 * navigation route, including revision and active-capability isolation.
 */

import type http from "node:http";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getActiveViewContext } from "../runtime/view-action-affinity.ts";
import {
  DEFAULT_VIEW_SCOPE_DISCONNECT_GRACE_MS,
  registerViewScopeConnection,
  scheduleViewScopeClearAfterGrace,
} from "./view-scope-ws-lifecycle.ts";
import { registerBuiltinViews } from "./views-registry.ts";
import {
  clearCurrentViewState,
  getCurrentViewRevision,
  getCurrentViewState,
  handleViewsRoutes,
  pruneIdleCurrentViewScopes,
  registerCurrentViewScopeWebSocket,
  releaseCurrentViewScope,
  VIEW_SCOPE_IDLE_TTL_MS,
  type ViewsRouteContext,
} from "./views-routes.ts";

function navigationContext(
  viewId: string,
  clientId: string,
): ViewsRouteContext {
  const pathname = `/api/views/${viewId}/navigate`;
  const req = Readable.from([
    Buffer.from("{}"),
  ]) as unknown as http.IncomingMessage;
  req.headers = { "x-elizaos-client-id": clientId };
  return {
    req,
    res: {} as http.ServerResponse,
    method: "POST",
    pathname,
    url: new URL(`http://local${pathname}`),
    json: vi.fn(),
    error: vi.fn(),
    broadcastWs: vi.fn(),
    broadcastWsToClientId: vi.fn(() => 1),
  };
}

describe("released client view scope", () => {
  beforeEach(() => {
    registerBuiltinViews();
    clearCurrentViewState();
  });

  afterEach(() => {
    vi.useRealTimers();
    clearCurrentViewState();
    vi.restoreAllMocks();
  });

  it("deletes only the disconnected scope and resets its revision lineage", async () => {
    await handleViewsRoutes(navigationContext("settings", "client-a"));
    await handleViewsRoutes(navigationContext("character", "client-b"));

    expect(getCurrentViewState("client-a")?.viewId).toBe("settings");
    expect(getCurrentViewRevision("client-a")).toBe(1);
    expect(getActiveViewContext("client-a")?.viewId).toBe("settings");

    releaseCurrentViewScope("client-a");

    expect(getCurrentViewState("client-a")).toBeNull();
    expect(getCurrentViewRevision("client-a")).toBe(0);
    expect(getActiveViewContext("client-a")).toBeNull();
    expect(getCurrentViewState("client-b")?.viewId).toBe("character");
    expect(getCurrentViewRevision("client-b")).toBe(1);
  });

  it("reclaims an idle REST-only scope without affecting another client", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-17T12:00:00.000Z"));
    await handleViewsRoutes(navigationContext("settings", "rest-client"));
    await handleViewsRoutes(navigationContext("character", "active-client"));

    vi.advanceTimersByTime(VIEW_SCOPE_IDLE_TTL_MS - 1);
    getCurrentViewState("active-client");
    vi.advanceTimersByTime(1);
    pruneIdleCurrentViewScopes();

    expect(getCurrentViewState("rest-client")).toBeNull();
    expect(getCurrentViewRevision("rest-client")).toBe(0);
    expect(getActiveViewContext("rest-client")).toBeNull();
    expect(getCurrentViewState("active-client")?.viewId).toBe("character");
  });

  it("renews the inactivity lease whenever a scoped client reads its state", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-17T12:00:00.000Z"));
    await handleViewsRoutes(navigationContext("settings", "rest-client"));

    vi.advanceTimersByTime(VIEW_SCOPE_IDLE_TTL_MS - 1);
    expect(getCurrentViewState("rest-client")?.viewId).toBe("settings");
    vi.advanceTimersByTime(VIEW_SCOPE_IDLE_TTL_MS - 1);
    pruneIdleCurrentViewScopes();
    expect(getCurrentViewState("rest-client")?.viewId).toBe("settings");

    vi.advanceTimersByTime(VIEW_SCOPE_IDLE_TTL_MS);
    pruneIdleCurrentViewScopes();
    expect(getCurrentViewState("rest-client")).toBeNull();
  });

  it("does not reap an idle scope while its authenticated WebSocket remains connected", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-17T12:00:00.000Z"));
    await handleViewsRoutes(navigationContext("settings", "ws-client"));
    registerViewScopeConnection({
      clientId: "ws-client",
      pendingClears: new Map(),
      markViewScopeConnected: registerCurrentViewScopeWebSocket,
    });

    vi.advanceTimersByTime(VIEW_SCOPE_IDLE_TTL_MS * 2);
    pruneIdleCurrentViewScopes();

    expect(getCurrentViewState("ws-client")?.viewId).toBe("settings");
    expect(getCurrentViewRevision("ws-client")).toBe(1);
  });

  it("preserves state on reconnect and releases it after a final WebSocket disconnect", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-17T12:00:00.000Z"));
    await handleViewsRoutes(navigationContext("settings", "ws-client"));

    const pendingClears = new Map<string, ReturnType<typeof setTimeout>>();
    let connected = true;
    const register = () =>
      registerViewScopeConnection({
        clientId: "ws-client",
        pendingClears,
        markViewScopeConnected: registerCurrentViewScopeWebSocket,
      });
    const disconnect = () => {
      connected = false;
      scheduleViewScopeClearAfterGrace({
        clientId: "ws-client",
        pendingClears,
        clientHasLiveConnection: () => connected,
        clearViewScope: releaseCurrentViewScope,
      });
    };

    register();
    disconnect();
    vi.advanceTimersByTime(5_000);
    connected = true;
    expect(register()).toBe(true);
    vi.advanceTimersByTime(DEFAULT_VIEW_SCOPE_DISCONNECT_GRACE_MS);
    expect(getCurrentViewState("ws-client")?.viewId).toBe("settings");

    disconnect();
    vi.advanceTimersByTime(DEFAULT_VIEW_SCOPE_DISCONNECT_GRACE_MS);
    expect(getCurrentViewState("ws-client")).toBeNull();
    expect(getCurrentViewRevision("ws-client")).toBe(0);
    expect(getActiveViewContext("ws-client")).toBeNull();

    await handleViewsRoutes(navigationContext("character", "ws-client"));
    vi.advanceTimersByTime(VIEW_SCOPE_IDLE_TTL_MS);
    pruneIdleCurrentViewScopes();
    expect(getCurrentViewState("ws-client")).toBeNull();
  });
});
