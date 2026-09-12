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
  it("rejects relative app directories at the host boundary", async () => {
    const result = await callRoute({
      method: "POST",
      pathname: "/api/apps/load-from-directory",
      body: { directory: "apps" },
    });

    expect(result.handled).toBe(true);
    expect(result.res.status).toBe(400);
    expect(result.res.body).toEqual({
      error:
        "Invalid request body at directory: directory must be an absolute path",
    });
  });

  it("registers every valid sibling app when one package.json is malformed", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "app-manager-load-"));
    try {
      await mkdir(path.join(dir, "app-good"));
      await writeFile(
        path.join(dir, "app-good", "package.json"),
        JSON.stringify({
          name: "@elizaos/app-good",
          elizaos: { app: { slug: "good", displayName: "Good App" } },
        }),
      );
      await mkdir(path.join(dir, "app-bad"));
      // Syntactically malformed manifest: previously threw SyntaxError mid-loop
      // and aborted the whole scan with HTTP 500. The bareword value also makes
      // V8 embed a slice of these file bytes in the JSON.parse message, so the
      // marker below pins that the rejection reason does not persist file
      // content.
      await writeFile(
        path.join(dir, "app-bad", "package.json"),
        `{"n": LEAKMARK}`,
      );

      const registered: Array<Record<string, unknown>> = [];
      const rejections: Array<Record<string, unknown>> = [];
      const register = vi.fn(async (entry: Record<string, unknown>) => {
        registered.push(entry);
      });
      const recordManifestRejection = vi.fn(
        async (rejection: Record<string, unknown>) => {
          rejections.push(rejection);
        },
      );
      const runtime = {
        getService: (type: string) =>
          type === "app-registry"
            ? { register, recordManifestRejection }
            : null,
      };

      const result = await callRoute({
        method: "POST",
        pathname: "/api/apps/load-from-directory",
        body: { directory: dir },
        runtime: runtime as never,
      });

      expect(result.handled).toBe(true);
      expect(result.res.status).toBe(200);
      const body = result.res.body as {
        ok: boolean;
        registered: number;
        items: Array<{ canonicalName: string }>;
        rejectedManifests: Array<{
          directory: string;
          packageName: string | null;
          reason: string;
          path: string;
        }>;
      };
      expect(body.ok).toBe(true);
      // The valid app registers despite the malformed sibling manifest.
      expect(body.registered).toBe(1);
      expect(body.items.map((i) => i.canonicalName)).toEqual([
        "@elizaos/app-good",
      ]);
      expect(register).toHaveBeenCalledTimes(1);
      expect(registered[0]?.canonicalName).toBe("@elizaos/app-good");

      // The malformed manifest is surfaced as a rejection, not swallowed.
      expect(body.rejectedManifests).toHaveLength(1);
      const rejected = body.rejectedManifests[0];
      expect(rejected?.directory).toBe(path.join(dir, "app-bad"));
      expect(rejected?.packageName).toBeNull();
      expect(rejected?.reason).toContain("invalid JSON");
      // The reason is built from the error's name, not a constant: this pins the
      // positive half of the decision so replacing `parseError.name` with a bare
      // literal is caught, not just the negative hygiene half below.
      expect(rejected?.reason).toContain("SyntaxError");
      // Data hygiene: the reason must not carry the malformed file's bytes into
      // the HTTP response. V8's JSON.parse message would embed them; the reason
      // is built from the error name instead.
      expect(rejected?.reason).not.toContain("LEAKMARK");
      expect(rejected?.path).toBe(path.join(dir, "app-bad", "package.json"));

      // The rejection is also recorded through the registry service so callers
      // that persist rejections still learn which manifest failed.
      expect(recordManifestRejection).toHaveBeenCalledTimes(1);
      expect(rejections[0]).toMatchObject({
        directory: path.join(dir, "app-bad"),
        packageName: null,
        path: path.join(dir, "app-bad", "package.json"),
        requesterEntityId: null,
        requesterRoomId: null,
      });
      expect(String(rejections[0]?.reason)).toContain("invalid JSON");
      expect(String(rejections[0]?.reason)).toContain("SyntaxError");
      // The persisted rejection record must not carry file bytes either.
      expect(String(rejections[0]?.reason)).not.toContain("LEAKMARK");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("registers all apps when every manifest in the directory is valid", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "app-manager-load-ok-"));
    try {
      for (const name of ["alpha", "beta", "gamma"]) {
        await mkdir(path.join(dir, `app-${name}`));
        await writeFile(
          path.join(dir, `app-${name}`, "package.json"),
          JSON.stringify({
            name: `@elizaos/app-${name}`,
            elizaos: { app: { slug: name } },
          }),
        );
      }

      const register = vi.fn(async () => {});
      const recordManifestRejection = vi.fn(async () => {});
      const runtime = {
        getService: (type: string) =>
          type === "app-registry"
            ? { register, recordManifestRejection }
            : null,
      };

      const result = await callRoute({
        method: "POST",
        pathname: "/api/apps/load-from-directory",
        body: { directory: dir },
        runtime: runtime as never,
      });

      expect(result.handled).toBe(true);
      expect(result.res.status).toBe(200);
      const body = result.res.body as {
        registered: number;
        items: Array<{ canonicalName: string }>;
        rejectedManifests: unknown[];
      };
      expect(body.registered).toBe(3);
      expect(body.items.map((i) => i.canonicalName).sort()).toEqual([
        "@elizaos/app-alpha",
        "@elizaos/app-beta",
        "@elizaos/app-gamma",
      ]);
      expect(body.rejectedManifests).toEqual([]);
      expect(register).toHaveBeenCalledTimes(3);
      expect(recordManifestRejection).not.toHaveBeenCalled();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

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

  it.each([undefined, null, "USER", "GUEST"] as const)(
    "denies %s actor before invoking appManager.launch",
    async (actorRole) => {
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
    },
  );

  it.each(["OWNER", "ADMIN"] as const)(
    "allows %s actor to launch apps",
    async (actorRole) => {
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
    },
  );

  it("rejects illegal percent-encoding in app path segments before service calls", async () => {
    const appManager = createAppManager();
    const refreshRegistry = vi.fn(async () => new Map());
    const getPluginManager = () =>
      ({
        installPlugin: vi.fn(),
        getInstalledPlugins: vi.fn(async () => []),
        searchPlugins: vi.fn(async () => []),
        refreshRegistry,
      }) as never;

    for (const { method, pathname } of [
      { method: "GET", pathname: "/api/apps/hero/%" },
      { method: "GET", pathname: "/api/apps/info/%2" },
      { method: "GET", pathname: "/api/apps/runs/%ZZ" },
      { method: "POST", pathname: "/api/apps/runs/%ZZ/stop" },
      { method: "GET", pathname: "/api/apps/permissions/%" },
      { method: "PUT", pathname: "/api/apps/permissions/%" },
    ]) {
      const result = await callRoute({
        method,
        pathname,
        appManager,
        getPluginManager,
      });
      expect(result.handled).toBe(true);
      expect(result.res.status).toBe(400);
      expect(result.res.body).toEqual({
        error: expect.stringContaining("percent-encoding"),
      });
    }
    expect(appManager.getRun).not.toHaveBeenCalled();
    expect(appManager.getInfo).not.toHaveBeenCalled();
    expect(refreshRegistry).not.toHaveBeenCalled();
  });

  it("still loads a canonically encoded app info slug", async () => {
    const appManager = createAppManager();
    appManager.getInfo = vi.fn(async () => ({ name: "demo-app" }));
    const result = await callRoute({
      method: "GET",
      pathname: "/api/apps/info/demo%2Dapp",
      appManager,
    });
    expect(result.handled).toBe(true);
    expect(result.res.status).toBe(200);
    expect(result.res.body).toEqual({ name: "demo-app" });
    expect(appManager.getInfo).toHaveBeenCalledWith(
      expect.anything(),
      "demo-app",
    );
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

  it("serves plugin SVG heroes as attachments so they cannot execute on the dashboard origin", async () => {
    const packageDir = await mkdtemp(
      path.join(os.tmpdir(), "app-manager-hero-svg-"),
    );
    try {
      await mkdir(path.join(packageDir, "assets"));
      await writeFile(
        path.join(packageDir, "package.json"),
        JSON.stringify({
          name: "@elizaos/plugin-demo",
          elizaos: { app: { heroImage: "assets/hero.svg" } },
        }),
      );
      await writeFile(
        path.join(packageDir, "assets", "hero.svg"),
        '<svg xmlns="http://www.w3.org/2000/svg"><script>document.cookie</script></svg>',
      );

      const getPluginManager = () =>
        ({
          installPlugin: vi.fn(),
          getInstalledPlugins: vi.fn(async () => []),
          searchPlugins: vi.fn(async () => []),
          refreshRegistry: vi.fn(
            async () =>
              new Map([
                [
                  "@elizaos/plugin-demo",
                  {
                    name: "@elizaos/plugin-demo",
                    npm: { package: "@elizaos/plugin-demo" },
                    localPath: packageDir,
                    appMeta: { heroImage: "assets/hero.svg" },
                  },
                ],
              ]),
          ),
        }) as never;

      const result = await callRoute({
        method: "GET",
        pathname: "/api/apps/hero/demo",
        appManager: createAppManager(),
        getPluginManager,
      });

      expect(result.handled).toBe(true);
      expect(result.res.status).toBe(200);
      expect(result.res.headers["Content-Type"]).toBe("image/svg+xml");
      expect(result.res.headers["Content-Disposition"]).toBe("attachment");
      expect(result.res.headers["X-Content-Type-Options"]).toBe("nosniff");
      expect(String(result.res.body)).toContain("<script>");
    } finally {
      await rm(packageDir, { recursive: true, force: true });
    }
  });

  it("keeps raster hero images inline", async () => {
    const packageDir = await mkdtemp(
      path.join(os.tmpdir(), "app-manager-hero-png-"),
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

      const getPluginManager = () =>
        ({
          installPlugin: vi.fn(),
          getInstalledPlugins: vi.fn(async () => []),
          searchPlugins: vi.fn(async () => []),
          refreshRegistry: vi.fn(
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
          ),
        }) as never;

      const result = await callRoute({
        method: "GET",
        pathname: "/api/apps/hero/demo",
        appManager: createAppManager(),
        getPluginManager,
      });

      expect(result.handled).toBe(true);
      expect(result.res.status).toBe(200);
      expect(result.res.headers["Content-Type"]).toBe("image/png");
      expect(result.res.headers["Content-Disposition"]).toBeUndefined();
    } finally {
      await rm(packageDir, { recursive: true, force: true });
    }
  });
});
