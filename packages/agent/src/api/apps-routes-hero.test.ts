import fs from "node:fs";
import path from "node:path";
import type http from "node:http";
import { describe, expect, it, vi } from "vitest";
import type { AppManagerLike, AppsRouteContext } from "./apps-routes.js";
import { handleAppsRoutes } from "./apps-routes.js";
import type {
  PluginManagerLike,
  RegistryPluginInfo,
} from "../services/plugin-manager-types.js";

interface RecordedResponse {
  status: number;
  headers: Record<string, string | number>;
  body: Buffer | null;
  jsonBody: unknown;
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

function makePluginManager(
  registryEntry: RegistryPluginInfo,
): PluginManagerLike {
  return {
    refreshRegistry: vi.fn(
      async () => new Map([[registryEntry.name, registryEntry]]),
    ),
    listInstalledPlugins: vi.fn(async () => []),
    getRegistryPlugin: vi.fn(async () => registryEntry),
    searchRegistry: vi.fn(async () => []),
    installPlugin: vi.fn(),
    uninstallPlugin: vi.fn(),
    listEjectedPlugins: vi.fn(async () => []),
    ejectPlugin: vi.fn(),
    syncPlugin: vi.fn(),
    reinjectPlugin: vi.fn(),
  };
}

function makeRouteContext(
  pluginManager: PluginManagerLike,
  pathname: string,
): AppsRouteContext & { recorded: RecordedResponse } {
  const recorded: RecordedResponse = {
    status: 200,
    headers: {},
    body: null,
    jsonBody: null,
  };
  const res = {
    writeHead: (status: number, headers: Record<string, string | number>) => {
      recorded.status = status;
      Object.assign(recorded.headers, headers);
      return res;
    },
    setHeader: (name: string, value: string | number) => {
      recorded.headers[name] = value;
    },
    end: (chunk?: unknown) => {
      if (Buffer.isBuffer(chunk)) {
        recorded.body = chunk;
        return;
      }
      if (typeof chunk === "string") {
        recorded.body = Buffer.from(chunk);
        return;
      }
      recorded.body = Buffer.alloc(0);
    },
  } as unknown as http.ServerResponse;

  return {
    req: {} as http.IncomingMessage,
    res,
    method: "GET",
    pathname,
    url: new URL(`http://localhost${pathname}`),
    appManager: makeAppManager(),
    getPluginManager: () => pluginManager,
    parseBoundedLimit: (raw: string | null, fallback = 15) => {
      const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
      return Number.isFinite(parsed) ? parsed : fallback;
    },
    runtime: null,
    readJsonBody: async () => null,
    json: (_res: http.ServerResponse, data: object, status?: number) => {
      recorded.status = status ?? 200;
      recorded.jsonBody = data;
    },
    error: (_res: http.ServerResponse, message: string, status?: number) => {
      recorded.status = status ?? 500;
      recorded.jsonBody = { error: message };
    },
    recorded,
  };
}

describe("GET /api/apps/hero/:slug", () => {
  it("serves a workspace hero asset even when the registry localPath is stale", async () => {
    const packageDir = path.resolve(
      path.dirname(new URL(import.meta.url).pathname),
      "../../../../apps/app-browser",
    );
    const heroPath = path.join(packageDir, "assets/hero.png");
    const expected = fs.readFileSync(heroPath);

    const pluginManager = makePluginManager({
      name: "@elizaos/app-browser",
      gitRepo: "https://example.com/app-browser",
      gitUrl: "https://example.com/app-browser.git",
      description: "Browser workspace app",
      homepage: null,
      topics: [],
      stars: 0,
      language: "TypeScript",
      npm: {
        package: "@elizaos/app-browser",
        v0Version: null,
        v1Version: null,
        v2Version: "0.0.0",
      },
      git: {
        v0Branch: null,
        v1Branch: null,
        v2Branch: "develop",
      },
      supports: { v0: false, v1: false, v2: true },
      localPath: "/tmp/does-not-exist/app-browser",
      appMeta: {
        displayName: "Browser",
        category: "utility",
        launchType: "connect",
        launchUrl: null,
        icon: null,
        heroImage: "assets/hero.png",
        capabilities: [],
        minPlayers: null,
        maxPlayers: null,
      },
    });

    const ctx = makeRouteContext(pluginManager, "/api/apps/hero/browser");
    const handled = await handleAppsRoutes(ctx);

    expect(handled).toBe(true);
    expect(ctx.recorded.status).toBe(200);
    expect(ctx.recorded.headers["Content-Type"]).toBe("image/png");
    expect(ctx.recorded.body).not.toBeNull();
    expect(ctx.recorded.body?.equals(expected)).toBe(true);
  });

  it("generates hero artwork when an app does not ship a hero asset", async () => {
    const pluginManager = makePluginManager({
      name: "@acme/app-mystery",
      gitRepo: "acme/app-mystery",
      gitUrl: "https://example.com/acme/app-mystery.git",
      description: "A mysterious utility app with no bundled artwork.",
      homepage: null,
      topics: [],
      stars: 0,
      language: "TypeScript",
      npm: {
        package: "@acme/app-mystery",
        v0Version: null,
        v1Version: null,
        v2Version: "0.0.1",
      },
      git: {
        v0Branch: null,
        v1Branch: null,
        v2Branch: "main",
      },
      supports: { v0: false, v1: false, v2: true },
      appMeta: {
        displayName: "Mystery App",
        category: "utility",
        launchType: "connect",
        launchUrl: null,
        icon: null,
        heroImage: null,
        capabilities: [],
        minPlayers: null,
        maxPlayers: null,
      },
    });

    const ctx = makeRouteContext(pluginManager, "/api/apps/hero/mystery");
    const handled = await handleAppsRoutes(ctx);

    expect(handled).toBe(true);
    expect(ctx.recorded.status).toBe(200);
    expect(ctx.recorded.headers["Content-Type"]).toBe("image/svg+xml");
    expect(ctx.recorded.body?.toString("utf8")).toContain("<svg");
    expect(ctx.recorded.body?.toString("utf8")).toContain("Mystery App");
  });
});
