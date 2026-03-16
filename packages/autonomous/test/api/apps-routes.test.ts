import { describe, test, expect, vi } from "vitest";
import {
  createMockIncomingMessage,
  createMockHttpResponse,
} from "../../src/test-support/test-helpers";
import type {
  AppsRouteContext,
  AppManagerLike,
  PluginManagerLike,
} from "../../src/api/apps-routes";
import { handleAppsRoutes } from "../../src/api/apps-routes";

function buildPluginManager(
  overrides: Partial<PluginManagerLike> = {},
): PluginManagerLike {
  return {
    listInstalledPlugins: vi.fn(async () => []),
    getRegistryPlugin: vi.fn(async () => null),
    refreshRegistry: vi.fn(async () => new Map()),
    searchRegistry: vi.fn(async () => []),
    installPlugin: vi.fn(async () => ({
      success: true,
      pluginName: "test",
      version: "1.0.0",
      installPath: "/tmp",
      requiresRestart: false,
    })),
    uninstallPlugin: vi.fn(async () => ({
      success: true,
      pluginName: "test",
      requiresRestart: false,
    })),
    listEjectedPlugins: vi.fn(async () => []),
    ejectPlugin: vi.fn(async () => ({
      success: true,
      pluginName: "test",
      ejectedPath: "/tmp",
      requiresRestart: false,
    })),
    syncPlugin: vi.fn(async () => ({
      success: true,
      pluginName: "test",
      ejectedPath: "/tmp",
      requiresRestart: false,
    })),
    reinjectPlugin: vi.fn(async () => ({
      success: true,
      pluginName: "test",
      removedPath: "/tmp",
      requiresRestart: false,
    })),
    ...overrides,
  };
}

function buildAppManager(
  overrides: Partial<AppManagerLike> = {},
): AppManagerLike {
  return {
    listAvailable: vi.fn(async () => []),
    search: vi.fn(async () => []),
    listInstalled: vi.fn(async () => []),
    launch: vi.fn(async () => ({ success: true })),
    stop: vi.fn(async () => ({ success: true })),
    getInfo: vi.fn(async () => null),
    ...overrides,
  };
}

function buildCtx(
  overrides: Partial<AppsRouteContext> = {},
): AppsRouteContext {
  const { res } = createMockHttpResponse();
  return {
    req: createMockIncomingMessage({ method: "GET", url: "/" }),
    res,
    method: "GET",
    pathname: "/",
    url: new URL("http://localhost:2138/"),
    appManager: buildAppManager(),
    getPluginManager: () => buildPluginManager(),
    parseBoundedLimit: vi.fn((raw, fallback = 20) =>
      raw ? Math.min(Math.max(1, Number(raw)), 100) : fallback,
    ),
    json: vi.fn((r, data, status = 200) => {
      r.writeHead(status);
      r.end(JSON.stringify(data));
    }),
    error: vi.fn((r, message, status = 500) => {
      r.writeHead(status);
      r.end(JSON.stringify({ error: message }));
    }),
    readJsonBody: vi.fn(async () => null),
    runtime: null,
    ...overrides,
  };
}

describe("handleAppsRoutes", () => {
  test("returns false for unrelated path", async () => {
    const ctx = buildCtx({ pathname: "/api/other" });
    const handled = await handleAppsRoutes(ctx);
    expect(handled).toBe(false);
  });

  test("GET /api/apps returns available apps list", async () => {
    const { res, getStatus, getJson } = createMockHttpResponse();
    const apps = [{ name: "test-app", version: "1.0.0" }];
    const ctx = buildCtx({
      method: "GET",
      pathname: "/api/apps",
      res,
      appManager: buildAppManager({
        listAvailable: vi.fn(async () => apps),
      }),
    });

    const handled = await handleAppsRoutes(ctx);

    expect(handled).toBe(true);
    expect(getStatus()).toBe(200);
    expect(getJson()).toEqual(apps);
  });

  test("GET /api/apps/search returns empty array for blank query", async () => {
    const { res, getStatus, getJson } = createMockHttpResponse();
    const ctx = buildCtx({
      method: "GET",
      pathname: "/api/apps/search",
      url: new URL("http://localhost:2138/api/apps/search?q="),
      res,
    });

    const handled = await handleAppsRoutes(ctx);

    expect(handled).toBe(true);
    expect(getStatus()).toBe(200);
    expect(getJson()).toEqual([]);
  });
});
