import fs from "node:fs";
import type http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
  packageNameToAppDisplayName,
  packageNameToAppRouteSlug,
} from "../contracts/apps.js";
import type {
  PluginManagerLike,
  RegistryPluginInfo,
} from "../services/plugin-manager-types.js";
import type { AppManagerLike, AppsRouteContext } from "./apps-routes.js";
import { handleAppsRoutes } from "./apps-routes.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const upstreamAppsDir = path.resolve(here, "../../../../apps");

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
  registryEntry: RegistryPluginInfo | RegistryPluginInfo[],
): PluginManagerLike {
  const registryEntries = Array.isArray(registryEntry)
    ? registryEntry
    : [registryEntry];
  const registry = new Map(registryEntries.map((entry) => [entry.name, entry]));
  return {
    refreshRegistry: vi.fn(async () => registry),
    listInstalledPlugins: vi.fn(async () => []),
    getRegistryPlugin: vi.fn(async (name: string) => registry.get(name) ?? null),
    searchRegistry: vi.fn(async () => []),
    installPlugin: vi.fn(),
    uninstallPlugin: vi.fn(),
    listEjectedPlugins: vi.fn(async () => []),
    ejectPlugin: vi.fn(),
    syncPlugin: vi.fn(),
    reinjectPlugin: vi.fn(),
  };
}

function makeRegistryEntry({
  description = "Workspace app",
  displayName,
  heroImage,
  localPath,
  name,
}: {
  description?: string;
  displayName?: string;
  heroImage: string | null;
  localPath?: string;
  name: string;
}): RegistryPluginInfo {
  return {
    name,
    gitRepo: `example/${name.replace(/^@[^/]+\//, "")}`,
    gitUrl: `https://example.com/${name.replace(/^@[^/]+\//, "")}.git`,
    description,
    homepage: null,
    topics: [],
    stars: 0,
    language: "TypeScript",
    npm: {
      package: name,
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
    localPath,
    appMeta: {
      displayName: displayName ?? packageNameToAppDisplayName(name),
      category: "utility",
      launchType: "connect",
      launchUrl: null,
      icon: null,
      heroImage,
      capabilities: [],
      minPlayers: null,
      maxPlayers: null,
    },
  };
}

function readUpstreamHeroAppPackages(): Array<{
  dir: string;
  heroImage: string;
  name: string;
  slug: string;
}> {
  return fs
    .readdirSync(upstreamAppsDir)
    .sort()
    .flatMap((entry) => {
      const packageJsonPath = path.join(upstreamAppsDir, entry, "package.json");
      if (!fs.existsSync(packageJsonPath)) return [];
      const packageJson = JSON.parse(
        fs.readFileSync(packageJsonPath, "utf8"),
      ) as {
        name?: unknown;
        elizaos?: { app?: { heroImage?: unknown } };
      };
      if (packageJson.name === "@elizaos/app") return [];
      const heroImage = packageJson.elizaos?.app?.heroImage;
      if (typeof packageJson.name !== "string") return [];
      if (typeof heroImage !== "string" || !heroImage.trim()) return [];
      const slug = packageNameToAppRouteSlug(packageJson.name);
      return slug
        ? [
            {
              dir: path.dirname(packageJsonPath),
              heroImage,
              name: packageJson.name,
              slug,
            },
          ]
        : [];
    });
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
    const packageDir = path.resolve(upstreamAppsDir, "app-browser");
    const heroPath = path.join(packageDir, "assets/hero.png");
    const expected = fs.readFileSync(heroPath);

    const pluginManager = makePluginManager(
      makeRegistryEntry({
        name: "@elizaos/app-browser",
        description: "Browser workspace app",
        heroImage: "assets/hero.png",
        localPath: "/tmp/does-not-exist/app-browser",
      }),
    );

    const ctx = makeRouteContext(pluginManager, "/api/apps/hero/browser");
    const handled = await handleAppsRoutes(ctx);

    expect(handled).toBe(true);
    expect(ctx.recorded.status).toBe(200);
    expect(ctx.recorded.headers["Content-Type"]).toBe("image/png");
    expect(ctx.recorded.body).not.toBeNull();
    expect(ctx.recorded.body?.equals(expected)).toBe(true);
  });

  it("serves every package-local upstream app hero asset", async () => {
    const appPackages = readUpstreamHeroAppPackages();
    expect(appPackages.length).toBeGreaterThan(0);
    const pluginManager = makePluginManager(
      appPackages.map((app) =>
        makeRegistryEntry({
          name: app.name,
          heroImage: app.heroImage,
          localPath: "/tmp/does-not-exist",
        }),
      ),
    );

    for (const app of appPackages) {
      const ctx = makeRouteContext(
        pluginManager,
        `/api/apps/hero/${app.slug}`,
      );
      const expected = fs.readFileSync(path.resolve(app.dir, app.heroImage));
      const handled = await handleAppsRoutes(ctx);

      expect(handled, app.name).toBe(true);
      expect(ctx.recorded.status, app.name).toBe(200);
      expect(ctx.recorded.headers["Content-Type"], app.name).toBe("image/png");
      expect(ctx.recorded.body?.equals(expected), app.name).toBe(true);
    }
  });

  it("generates hero artwork when an app does not ship a hero asset", async () => {
    const pluginManager = makePluginManager(
      makeRegistryEntry({
        name: "@acme/app-mystery",
        displayName: "Mystery App",
        description: "A mysterious utility app with no bundled artwork.",
        heroImage: null,
      }),
    );

    const ctx = makeRouteContext(pluginManager, "/api/apps/hero/mystery");
    const handled = await handleAppsRoutes(ctx);

    expect(handled).toBe(true);
    expect(ctx.recorded.status).toBe(200);
    expect(ctx.recorded.headers["Content-Type"]).toBe("image/svg+xml");
    expect(ctx.recorded.body?.toString("utf8")).toContain("<svg");
    expect(ctx.recorded.body?.toString("utf8")).toContain("Mystery App");
  });
});
