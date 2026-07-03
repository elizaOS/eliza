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
  runtime?: AppsRouteContext["runtime"];
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
    runtime: args.runtime ?? null,
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

interface MockRegistry {
  register: ReturnType<typeof vi.fn>;
  recordManifestRejection: ReturnType<typeof vi.fn>;
}

function createMockRegistryRuntime(): {
  runtime: AppsRouteContext["runtime"];
  registry: MockRegistry;
} {
  const registry: MockRegistry = {
    register: vi.fn(async () => {}),
    recordManifestRejection: vi.fn(async () => {}),
  };
  const runtime = {
    getService: (type: string) => (type === "app-registry" ? registry : null),
  } as unknown as AppsRouteContext["runtime"];
  return { runtime, registry };
}

async function writeAppManifest(
  dir: string,
  name: string,
  app: Record<string, unknown>,
): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, "package.json"),
    JSON.stringify({ name, version: "0.0.0", elizaos: { app } }),
    "utf8",
  );
}

describe("POST /api/apps/load-from-directory — single-dir registration (#11954)", () => {
  it("registers an app when the directory itself carries the elizaos.app manifest", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "app-single-"));
    const appDir = path.join(root, "eliza", "apps", "app-notes");
    try {
      await writeAppManifest(appDir, "app-notes", {
        slug: "notes",
        displayName: "Notes",
      });
      const { runtime, registry } = createMockRegistryRuntime();

      const result = await callRoute({
        method: "POST",
        pathname: "/api/apps/load-from-directory",
        body: { directory: appDir },
        runtime,
      });

      expect(result.handled).toBe(true);
      expect(result.res.status).toBe(200);
      expect(result.res.body).toMatchObject({
        ok: true,
        registered: 1,
        items: [{ slug: "notes", canonicalName: "app-notes" }],
      });
      // Registered with the app's own dir + external trust — exactly the path
      // the verifyApp handoff (verification-room-bridge) now drives (#11954).
      expect(registry.register).toHaveBeenCalledTimes(1);
      expect(registry.register).toHaveBeenCalledWith(
        expect.objectContaining({ slug: "notes", directory: appDir }),
        expect.objectContaining({ trust: "external" }),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("still scans subdirectories when a parent/container dir is passed", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "app-scan-"));
    const appsDir = path.join(root, "apps");
    try {
      await writeAppManifest(path.join(appsDir, "app-alpha"), "app-alpha", {
        slug: "alpha",
      });
      await writeAppManifest(path.join(appsDir, "app-beta"), "app-beta", {
        slug: "beta",
      });
      // A non-app subdir must be ignored.
      await mkdir(path.join(appsDir, "not-an-app"), { recursive: true });
      const { runtime, registry } = createMockRegistryRuntime();

      const result = await callRoute({
        method: "POST",
        pathname: "/api/apps/load-from-directory",
        body: { directory: appsDir },
        runtime,
      });

      expect(result.res.status).toBe(200);
      // The container dir has no manifest of its own, so only the two app
      // subdirs register — the top-level candidate must not double-count.
      expect(result.res.body).toMatchObject({ ok: true, registered: 2 });
      expect(registry.register).toHaveBeenCalledTimes(2);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("registers 0 for a directory that is neither an app nor a container of apps", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "app-empty-"));
    try {
      await mkdir(path.join(root, "src"), { recursive: true });
      const { runtime, registry } = createMockRegistryRuntime();

      const result = await callRoute({
        method: "POST",
        pathname: "/api/apps/load-from-directory",
        body: { directory: root },
        runtime,
      });

      expect(result.res.status).toBe(200);
      expect(result.res.body).toMatchObject({ ok: true, registered: 0 });
      expect(registry.register).not.toHaveBeenCalled();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("503s when no AppRegistryService is on the runtime", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "app-noreg-"));
    const appDir = path.join(root, "app-notes");
    try {
      await writeAppManifest(appDir, "app-notes", { slug: "notes" });
      const result = await callRoute({
        method: "POST",
        pathname: "/api/apps/load-from-directory",
        body: { directory: appDir },
        runtime: null,
      });
      expect(result.res.status).toBe(503);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
