import type http from "node:http";
import fc from "fast-check";
import { describe, expect, it, vi } from "vitest";
import {
  type AppManagerLike,
  type AppsRouteContext,
  type FavoriteAppsStore,
  handleAppsRoutes,
} from "./apps-routes";

interface CapturedResponse {
  body: unknown;
  status: number;
}

type TestRequest = http.IncomingMessage & { __body?: unknown };

function createResponse(): http.ServerResponse & CapturedResponse {
  return {
    body: undefined,
    status: 200,
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
    runtime: null,
    getPluginManager: () =>
      ({
        installPlugin: vi.fn(),
        getInstalledPlugins: vi.fn(async () => []),
        searchPlugins: vi.fn(async () => []),
        refreshRegistry: vi.fn(async () => undefined),
      }) as never,
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
      fc.asyncProperty(fc.array(fc.string(), { maxLength: 50 }), async (apps) => {
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
      }),
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
});
