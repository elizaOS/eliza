/**
 * Lifecycle integration tests for the apps-routes heartbeat + stop endpoints.
 *
 * Exercises the API surface the GameView uses to keep an app run alive
 * while the tab is open and to clean up server-side state on tab close.
 * The AppManager is stubbed via {@link AppManagerLike} so these tests
 * run without a plugin manager, registry, or filesystem.
 */

import type http from "node:http";
import { describe, expect, it, vi } from "vitest";
import type { AppRunSummary, AppStopResult } from "../contracts/apps.js";
import { type AppManagerLike, handleAppsRoutes } from "./apps-routes.js";

interface RecordedResponse {
  status: number;
  body: unknown;
}

function makeRunSummary(overrides: Partial<AppRunSummary> = {}): AppRunSummary {
  const now = new Date().toISOString();
  return {
    runId: "run-1",
    appName: "@elizaos/app-defense-of-the-agents",
    displayName: "Defense of the Agents",
    pluginName: "@elizaos/app-defense-of-the-agents",
    launchType: "connect",
    launchUrl: null,
    viewer: null,
    session: null,
    characterId: null,
    agentId: null,
    status: "running",
    summary: null,
    startedAt: now,
    updatedAt: now,
    lastHeartbeatAt: now,
    supportsBackground: true,
    supportsViewerDetach: false,
    chatAvailability: "unknown",
    controlAvailability: "unknown",
    viewerAttachment: "unavailable",
    recentEvents: [],
    awaySummary: null,
    health: { state: "healthy", message: null },
    healthDetails: {
      checkedAt: now,
      auth: { state: "unknown", message: null },
      runtime: { state: "healthy", message: null },
      viewer: { state: "unknown", message: null },
      chat: { state: "unknown", message: null },
      control: { state: "unknown", message: null },
      message: null,
    },
    ...overrides,
  };
}

function makeAppManager(
  overrides: Partial<AppManagerLike> = {},
): AppManagerLike {
  return {
    listAvailable: vi.fn(),
    search: vi.fn(),
    listInstalled: vi.fn(),
    listRuns: vi.fn(),
    getRun: vi.fn(),
    attachRun: vi.fn(),
    detachRun: vi.fn(),
    launch: vi.fn(),
    stop: vi.fn(),
    recordHeartbeat: vi.fn(),
    getInfo: vi.fn(),
    ...overrides,
  };
}

function makeRouteContext(
  appManager: AppManagerLike,
  method: string,
  pathname: string,
) {
  const recorded: RecordedResponse = { status: 200, body: undefined };
  return {
    req: {} as http.IncomingMessage,
    res: {} as http.ServerResponse,
    method,
    pathname,
    url: new URL(`http://localhost${pathname}`),
    appManager,
    getPluginManager: () =>
      ({}) as unknown as Parameters<
        ReturnType<typeof makeAppManager>["listAvailable"]
      >[0],
    parseBoundedLimit: (raw: string | null, fallback = 15) => {
      const n = raw ? Number.parseInt(raw, 10) : NaN;
      return Number.isFinite(n) ? n : fallback;
    },
    runtime: null,
    json: (_res: http.ServerResponse, data: object, status?: number) => {
      recorded.status = status ?? 200;
      recorded.body = data;
    },
    error: (_res: http.ServerResponse, message: string, status?: number) => {
      recorded.status = status ?? 500;
      recorded.body = { error: message };
    },
    readJsonBody: async <T extends object>(): Promise<T | null> => null,
    recorded,
  };
}

describe("POST /api/apps/runs/:runId/heartbeat", () => {
  it("calls AppManager.recordHeartbeat and returns the refreshed run", async () => {
    const refreshed = makeRunSummary();
    const recordHeartbeat = vi.fn(() => refreshed);
    const appManager = makeAppManager({ recordHeartbeat });

    const ctx = makeRouteContext(
      appManager,
      "POST",
      "/api/apps/runs/run-1/heartbeat",
    );
    const handled = await handleAppsRoutes(ctx);

    expect(handled).toBe(true);
    expect(recordHeartbeat).toHaveBeenCalledWith("run-1");
    expect(ctx.recorded.status).toBe(200);
    expect(ctx.recorded.body).toEqual({ ok: true, run: refreshed });
  });

  it("returns 404 when the run is unknown", async () => {
    const recordHeartbeat = vi.fn(() => null);
    const appManager = makeAppManager({ recordHeartbeat });

    const ctx = makeRouteContext(
      appManager,
      "POST",
      "/api/apps/runs/ghost-run/heartbeat",
    );
    const handled = await handleAppsRoutes(ctx);

    expect(handled).toBe(true);
    expect(recordHeartbeat).toHaveBeenCalledWith("ghost-run");
    expect(ctx.recorded.status).toBe(404);
    expect(ctx.recorded.body).toEqual({
      error: 'App run "ghost-run" not found',
    });
  });

  it("does not invoke any other AppManager method", async () => {
    const recordHeartbeat = vi.fn(() => makeRunSummary());
    const appManager = makeAppManager({ recordHeartbeat });

    const ctx = makeRouteContext(
      appManager,
      "POST",
      "/api/apps/runs/run-1/heartbeat",
    );
    await handleAppsRoutes(ctx);

    expect(appManager.stop).not.toHaveBeenCalled();
    expect(appManager.getRun).not.toHaveBeenCalled();
    expect(appManager.listRuns).not.toHaveBeenCalled();
  });

  it("URL-decodes the runId", async () => {
    const recordHeartbeat = vi.fn(() => makeRunSummary());
    const appManager = makeAppManager({ recordHeartbeat });

    const ctx = makeRouteContext(
      appManager,
      "POST",
      "/api/apps/runs/run%3Ax%2Fy/heartbeat",
    );
    await handleAppsRoutes(ctx);

    expect(recordHeartbeat).toHaveBeenCalledWith("run:x/y");
  });
});

describe("POST /api/apps/runs/:runId/stop", () => {
  it("invokes AppManager.stop with the runId so the stopRun hook fires", async () => {
    // The stop route is the same path the navigator.sendBeacon call hits
    // when a tab closes; this test pins that the request shape we depend
    // on continues to call AppManager.stop with the runId (not name).
    const stopResult: AppStopResult = {
      success: true,
      appName: "@elizaos/app-defense-of-the-agents",
      runId: "run-1",
      stoppedAt: new Date().toISOString(),
      pluginUninstalled: false,
      needsRestart: false,
      stopScope: "viewer-session",
      message: "Defense of the Agents stopped.",
    };
    const stop = vi.fn(async () => stopResult);
    const appManager = makeAppManager({ stop });

    const ctx = makeRouteContext(
      appManager,
      "POST",
      "/api/apps/runs/run-1/stop",
    );
    const handled = await handleAppsRoutes(ctx);

    expect(handled).toBe(true);
    expect(stop).toHaveBeenCalledTimes(1);
    expect(stop).toHaveBeenCalledWith(expect.anything(), "", "run-1", null);
    expect(ctx.recorded.status).toBe(200);
    expect(ctx.recorded.body).toEqual(stopResult);
  });
});
