/**
 * Tests for the /api/apps/favorites route surface.
 *
 * The favorites store is owned by the runtime (config.ui.favoriteApps) so
 * the agent's FAVORITE_APP action and the dashboard read the same list.
 */

import type http from "node:http";
import { describe, expect, it, vi } from "vitest";
import {
  type AppManagerLike,
  type FavoriteAppsStore,
  handleAppsRoutes,
} from "./apps-routes.js";

interface RecordedResponse {
  status: number;
  body: unknown;
}

function makeAppManager(): AppManagerLike {
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
  };
}

function makeStore(initial: string[] = []): FavoriteAppsStore & {
  current: () => string[];
} {
  let value = [...initial];
  return {
    read: () => [...value],
    write: (next) => {
      value = [...next];
      return [...value];
    },
    current: () => [...value],
  };
}

function makeContext(
  method: string,
  pathname: string,
  body: unknown,
  store: FavoriteAppsStore | undefined,
) {
  const recorded: RecordedResponse = { status: 200, body: undefined };
  return {
    req: {} as http.IncomingMessage,
    res: {} as http.ServerResponse,
    method,
    pathname,
    url: new URL(`http://localhost${pathname}`),
    appManager: makeAppManager(),
    getPluginManager: () => ({}) as never,
    parseBoundedLimit: (raw: string | null, fallback = 15) => {
      const n = raw ? Number.parseInt(raw, 10) : NaN;
      return Number.isFinite(n) ? n : fallback;
    },
    runtime: null,
    favoriteApps: store,
    json: (_res: http.ServerResponse, data: unknown, status?: number) => {
      recorded.status = status ?? 200;
      recorded.body = data;
    },
    error: (_res: http.ServerResponse, message: string, status?: number) => {
      recorded.status = status ?? 500;
      recorded.body = { error: message };
    },
    readJsonBody: async <T extends object>(): Promise<T | null> =>
      body as T | null,
    recorded,
  };
}

describe("GET /api/apps/favorites", () => {
  it("returns the current favorites list", async () => {
    const store = makeStore(["@elizaos/app-shopify", "@elizaos/app-companion"]);
    const ctx = makeContext("GET", "/api/apps/favorites", null, store);

    const handled = await handleAppsRoutes(ctx);

    expect(handled).toBe(true);
    expect(ctx.recorded.status).toBe(200);
    expect(ctx.recorded.body).toEqual({
      favoriteApps: ["@elizaos/app-shopify", "@elizaos/app-companion"],
    });
  });

  it("returns 503 when the favorites store is not configured", async () => {
    const ctx = makeContext("GET", "/api/apps/favorites", null, undefined);

    const handled = await handleAppsRoutes(ctx);

    expect(handled).toBe(true);
    expect(ctx.recorded.status).toBe(503);
  });
});

describe("PUT /api/apps/favorites", () => {
  it("appends a new favorite when isFavorite=true", async () => {
    const store = makeStore(["@elizaos/app-shopify"]);
    const ctx = makeContext(
      "PUT",
      "/api/apps/favorites",
      { appName: "@elizaos/app-companion", isFavorite: true },
      store,
    );

    const handled = await handleAppsRoutes(ctx);

    expect(handled).toBe(true);
    expect(ctx.recorded.status).toBe(200);
    expect(ctx.recorded.body).toEqual({
      favoriteApps: ["@elizaos/app-shopify", "@elizaos/app-companion"],
    });
    expect(store.current()).toEqual([
      "@elizaos/app-shopify",
      "@elizaos/app-companion",
    ]);
  });

  it("removes a favorite when isFavorite=false", async () => {
    const store = makeStore(["@elizaos/app-shopify", "@elizaos/app-companion"]);
    const ctx = makeContext(
      "PUT",
      "/api/apps/favorites",
      { appName: "@elizaos/app-shopify", isFavorite: false },
      store,
    );

    const handled = await handleAppsRoutes(ctx);

    expect(handled).toBe(true);
    expect(ctx.recorded.status).toBe(200);
    expect(ctx.recorded.body).toEqual({
      favoriteApps: ["@elizaos/app-companion"],
    });
  });

  it("rejects empty appName with 400", async () => {
    const store = makeStore([]);
    const ctx = makeContext(
      "PUT",
      "/api/apps/favorites",
      { appName: "   ", isFavorite: true },
      store,
    );

    const handled = await handleAppsRoutes(ctx);

    expect(handled).toBe(true);
    expect(ctx.recorded.status).toBe(400);
  });

  it("rejects non-boolean isFavorite with 400", async () => {
    const store = makeStore([]);
    const ctx = makeContext(
      "PUT",
      "/api/apps/favorites",
      { appName: "@elizaos/app-shopify", isFavorite: "yes" },
      store,
    );

    const handled = await handleAppsRoutes(ctx);

    expect(handled).toBe(true);
    expect(ctx.recorded.status).toBe(400);
  });

  it("dedupes when adding an app that is already favorited", async () => {
    const store = makeStore(["@elizaos/app-shopify"]);
    const ctx = makeContext(
      "PUT",
      "/api/apps/favorites",
      { appName: "@elizaos/app-shopify", isFavorite: true },
      store,
    );

    const handled = await handleAppsRoutes(ctx);

    expect(handled).toBe(true);
    expect(ctx.recorded.body).toEqual({
      favoriteApps: ["@elizaos/app-shopify"],
    });
  });
});

describe("POST /api/apps/favorites/replace", () => {
  it("bulk replaces the favorites list", async () => {
    const store = makeStore(["@elizaos/app-shopify"]);
    const ctx = makeContext(
      "POST",
      "/api/apps/favorites/replace",
      {
        favoriteAppNames: [
          "@elizaos/app-companion",
          "@elizaos/app-defense",
          "@elizaos/app-companion",
        ],
      },
      store,
    );

    const handled = await handleAppsRoutes(ctx);

    expect(handled).toBe(true);
    expect(ctx.recorded.status).toBe(200);
    expect(ctx.recorded.body).toEqual({
      favoriteApps: ["@elizaos/app-companion", "@elizaos/app-defense"],
    });
    expect(store.current()).toEqual([
      "@elizaos/app-companion",
      "@elizaos/app-defense",
    ]);
  });

  it("rejects non-array body with 400", async () => {
    const store = makeStore([]);
    const ctx = makeContext(
      "POST",
      "/api/apps/favorites/replace",
      { favoriteAppNames: "not-an-array" },
      store,
    );

    const handled = await handleAppsRoutes(ctx);

    expect(handled).toBe(true);
    expect(ctx.recorded.status).toBe(400);
  });

  it("filters out non-string and empty entries", async () => {
    const store = makeStore([]);
    const ctx = makeContext(
      "POST",
      "/api/apps/favorites/replace",
      {
        favoriteAppNames: [
          "@elizaos/app-shopify",
          123,
          null,
          "",
          "  @elizaos/app-companion  ",
        ],
      },
      store,
    );

    const handled = await handleAppsRoutes(ctx);

    expect(handled).toBe(true);
    expect(ctx.recorded.body).toEqual({
      favoriteApps: ["@elizaos/app-shopify", "@elizaos/app-companion"],
    });
  });
});
