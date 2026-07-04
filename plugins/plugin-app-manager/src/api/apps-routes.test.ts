/**
 * Property and unit tests for `handleAppsRoutes`, driving the `/api/apps/*`
 * dispatcher against a mock AppManager/plugin-manager (AppsRouteContext) over a
 * real temp state dir on disk — no live agent runtime.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import type http from "node:http";
import os from "node:os";
import path from "node:path";
import fc from "fast-check";
import { describe, expect, it, vi } from "vitest";
import {
  type AppManagerLike,
  type AppsRouteActorRole,
  type AppsRouteContext,
  type FavoriteAppsStore,
  handleAppsRoutes,
} from "./apps-routes";

interface CapturedResponse {
  body: unknown;
  headers: Record<string, string | number>;
  status: number;
}

type TestRequest = http.IncomingMessage & { __body?: unknown };

function createResponse(): http.ServerResponse & CapturedResponse {
  return {
    body: undefined,
    headers: {},
    status: 200,
    writeHead(status: number, headers: Record<string, string | number>) {
      this.status = status;
      this.headers = { ...this.headers, ...headers };
      return this as http.ServerResponse;
    },
    setHeader(name: string, value: string | number) {
      this.headers[name] = value;
      return this as http.ServerResponse;
    },
    end(chunk?: unknown) {
      this.body = chunk;
      return this as http.ServerResponse;
    },
  } as http.ServerResponse & CapturedResponse;
}

function createAppManager(): AppManagerLike {
  return {
    search: vi.fn(async () => []),
    listAvailable: vi.fn(async () => []),
    listInstalled: vi.fn(async () => []),
    launch: vi.fn(async () => ({ success: true })),
    stop: vi.fn(async () => ({ success: true })),
    listRuns: vi.fn(async () => []),
    getRun: vi.fn(async () => null),
    attachRun: vi.fn(async () => ({ success: true })),
    detachRun: vi.fn(async () => ({ success: true })),
    recordHeartbeat: vi.fn(() => null),
    startStaleRunSweeper: vi.fn(),
    getInfo: vi.fn(async () => null),
  };
}

function createFavoriteStore(initial: string[] = []): FavoriteAppsStore & {
  writes: string[][];
} {
  let current = [...initial];
  const writes: string[][] = [];
  return {
    writes,
    read: () => [...current],
    write: (apps) => {
      current = [...apps];
      writes.push([...apps]);
      return [...current];
    },
  };
}

async function callRoute(args: {
  method: string;
  pathname: string;
  body?: unknown;
  appManager?: AppManagerLike;
  favoriteApps?: FavoriteAppsStore;
  getPluginManager?: AppsRouteContext["getPluginManager"];
  actorRole?: AppsRouteActorRole | null;
}): Promise<{
  handled: boolean;
  res: CapturedResponse;
  appManager: AppManagerLike;
}> {
  const appManager = args.appManager ?? createAppManager();
  const req = { __body: args.body } as TestRequest;
  const res = createResponse();
  const url = new URL(`http://localhost${args.pathname}`);
  const ctx: AppsRouteContext = {
    req,
    res,
    method: args.method,
    pathname: args.pathname,
    url,
    appManager,
    favoriteApps: args.favoriteApps,
    actorRole: args.actorRole,
    runtime: null,
    getPluginManager:
      args.getPluginManager ??
      (() =>
        ({
          installPlugin: vi.fn(),
          getInstalledPlugins: vi.fn(async () => []),
          searchPlugins: vi.fn(async () => []),
          refreshRegistry: vi.fn(async () => undefined),
        }) as never),
    parseBoundedLimit: () => 20,
    readJsonBody: async (request) =>
      (request as TestRequest).__body === undefined
        ? null
        : ((request as TestRequest).__body as Record<string, unknown>),
    json: (response, payload, status = 200) => {
      const captured = response as http.ServerResponse & CapturedResponse;
      captured.status = status;
      captured.body = payload;
    },
    error: (response, message, status = 400) => {
      const captured = response as http.ServerResponse & CapturedResponse;
      captured.status = status;
      captured.body = { error: message };
    },
  };

  const handled = await handleAppsRoutes(ctx);
  return { handled, res, appManager };
}

function sanitizeExpectedFavorites(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

describe("handleAppsRoutes", () => {
  it("rejects malformed favorite updates before writing the store", async () => {
    const store = createFavoriteStore(["@elizaos/plugin-phone"]);

    const result = await callRoute({
      method: "PUT",
      pathname: "/api/apps/favorites",
      favoriteApps: store,
      body: {
        appName: "@elizaos/plugin-wallet",
        isFavorite: true,
        extra: "reject me",
      },
    });

    expect(result.handled).toBe(true);
    expect(result.res.status).toBe(400);
    expect(result.res.body).toMatchObject({
      error: expect.stringContaining("Invalid request body"),
    });
    expect(store.writes).toHaveLength(0);
  });

  it("fuzzes favorites replacement through the route sanitizer", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.string(), { maxLength: 50 }),
        async (apps) => {
          const store = createFavoriteStore();
          const result = await callRoute({
            method: "POST",
            pathname: "/api/apps/favorites/replace",
            favoriteApps: store,
            body: { favoriteAppNames: apps },
          });

          const expected = sanitizeExpectedFavorites(apps);
          expect(result.handled).toBe(true);
          expect(result.res.status).toBe(200);
          expect(result.res.body).toEqual({ favoriteApps: expected });
          expect(store.writes).toEqual([expected]);
        },
      ),
      { numRuns: 200 },
    );
  });

  it("rejects blank run messages without proxying to plugin route handlers", async () => {
    const appManager = createAppManager();
    vi.mocked(appManager.getRun).mockResolvedValue({
      runId: "run-1",
      appName: "@elizaos/plugin-demo",
    } as never);

    const result = await callRoute({
      method: "POST",
      pathname: "/api/apps/runs/run-1/message",
      appManager,
      body: { content: " \n\t " },
    });

    expect(result.handled).toBe(true);
    expect(result.res.status).toBe(400);
    expect(result.res.body).toMatchObject({
      error: expect.stringContaining("content is required"),
    });
  });

  it("rejects malformed launch payloads before invoking appManager.launch", async () => {
    const appManager = createAppManager();

    const result = await callRoute({
      method: "POST",
      pathname: "/api/apps/launch",
      appManager,
      actorRole: "OWNER",
      body: { name: "", __proto__: { polluted: true } },
    });

    expect(result.handled).toBe(true);
    expect(result.res.status).toBe(400);
    expect(result.res.body).toMatchObject({
      error: expect.stringContaining("Invalid request body"),
    });
    expect(appManager.launch).not.toHaveBeenCalled();
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it.each([
    undefined,
    null,
    "USER",
    "GUEST",
  ] as const)("denies %s actor before invoking appManager.launch", async (actorRole) => {
    const appManager = createAppManager();

    const result = await callRoute({
      method: "POST",
      pathname: "/api/apps/launch",
      appManager,
      actorRole,
      body: { name: "@elizaos/plugin-demo" },
    });

    expect(result.handled).toBe(true);
    expect(result.res.status).toBe(403);
    expect(result.res.body).toEqual({
      error: "App launch requires OWNER or ADMIN role",
    });
    expect(appManager.launch).not.toHaveBeenCalled();
  });

  it.each([
    "OWNER",
    "ADMIN",
  ] as const)("allows %s actor to launch apps", async (actorRole) => {
    const appManager = createAppManager();

    const result = await callRoute({
      method: "POST",
      pathname: "/api/apps/launch",
      appManager,
      actorRole,
      body: { name: "@elizaos/plugin-demo" },
    });

    expect(result.handled).toBe(true);
    expect(result.res.status).toBe(200);
    expect(result.res.body).toEqual({ success: true });
    expect(appManager.launch).toHaveBeenCalledTimes(1);
  });

  it("reuses the app hero registry lookup across adjacent image requests", async () => {
    const packageDir = await mkdtemp(
      path.join(os.tmpdir(), "app-manager-hero-"),
    );
    try {
      await mkdir(path.join(packageDir, "assets"));
      await writeFile(
        path.join(packageDir, "package.json"),
        JSON.stringify({
          name: "@elizaos/plugin-demo",
          elizaos: { app: { heroImage: "assets/hero.png" } },
        }),
      );
      await writeFile(path.join(packageDir, "assets", "hero.png"), "png");

      const refreshRegistry = vi.fn(
        async () =>
          new Map([
            [
              "@elizaos/plugin-demo",
              {
                name: "@elizaos/plugin-demo",
                npm: { package: "@elizaos/plugin-demo" },
                localPath: packageDir,
                appMeta: { heroImage: "assets/hero.png" },
              },
            ],
          ]),
      );
      const getPluginManager = () =>
        ({
          installPlugin: vi.fn(),
          getInstalledPlugins: vi.fn(async () => []),
          searchPlugins: vi.fn(async () => []),
          refreshRegistry,
        }) as never;
      const appManager = createAppManager();

      const first = await callRoute({
        method: "GET",
        pathname: "/api/apps/hero/demo",
        appManager,
        getPluginManager,
      });
      expect(refreshRegistry).toHaveBeenCalledTimes(1);
      const second = await callRoute({
        method: "GET",
        pathname: "/api/apps/hero/demo",
        appManager,
        getPluginManager,
      });

      expect(first.handled).toBe(true);
      expect(second.handled).toBe(true);
      expect(first.res.status).toBe(200);
      expect(second.res.status).toBe(200);
      expect(refreshRegistry).toHaveBeenCalledTimes(1);
    } finally {
      await rm(packageDir, { recursive: true, force: true });
    }
  });
});
