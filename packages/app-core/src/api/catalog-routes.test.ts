/**
 * Unit tests for `handleCatalogRoutes` (`GET /api/catalog/apps`). Covers
 * routing pass-through, the auth short-circuit, empty/single/multi visible
 * queues, hidden-entry filtering, and every AppEntry → RegistryAppInfo mapping
 * branch. Drives fake Node `IncomingMessage`/`ServerResponse` objects through
 * the real handler and `sendJson`; `getApps`/`loadRegistry` and
 * `ensureRouteAuthorized` are hoisted doubles so mapper edges do not depend
 * on the live first-party catalog.
 */
import * as http from "node:http";
import { Socket } from "node:net";
import type { AppEntry } from "@elizaos/registry/first-party";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CompatRuntimeState } from "./compat-route-shared";

const mocks = vi.hoisted(() => ({
  ensureRouteAuthorized: vi.fn(),
  getApps: vi.fn(),
  loadRegistry: vi.fn(),
}));

vi.mock("./auth", () => ({
  ensureRouteAuthorized: mocks.ensureRouteAuthorized,
}));

vi.mock("./auth.ts", () => ({
  ensureRouteAuthorized: mocks.ensureRouteAuthorized,
}));

vi.mock("@elizaos/registry/first-party", () => ({
  getApps: mocks.getApps,
  loadRegistry: mocks.loadRegistry,
}));

// The agent barrel pulls plugin endpoint graphs this unit test does not need.
// Load the real hero-image helper so the catalog mapper's fallback is genuine.
vi.mock("@elizaos/agent", async () => {
  const { resolveAppHeroImage } = await import(
    "../../../agent/src/services/registry-client-queries.ts"
  );
  return { resolveAppHeroImage };
});

const STATE: CompatRuntimeState = {
  current: null,
  pendingAgentName: null,
  pendingRestartReasons: [],
};

const REGISTRY_SENTINEL = { id: "catalog-test-registry" };

interface FakeRes {
  body(): unknown;
  res: http.ServerResponse;
  status(): number;
}

function fakeRes(): FakeRes {
  let bodyText = "";
  const req = new http.IncomingMessage(new Socket());
  const res = new http.ServerResponse(req);
  res.statusCode = 200;
  res.setHeader = () => res;
  res.end = ((chunk?: string | Buffer) => {
    if (typeof chunk === "string") bodyText += chunk;
    else if (chunk) bodyText += chunk.toString("utf8");
    return res;
  }) as typeof res.end;
  return {
    body() {
      return bodyText.length > 0 ? JSON.parse(bodyText) : null;
    },
    res,
    status() {
      return res.statusCode;
    },
  };
}

function fakeReq(
  pathname: string,
  options: { method?: string | undefined } = {},
): http.IncomingMessage {
  const req = new http.IncomingMessage(new Socket());
  if (options.method !== undefined) {
    req.method = options.method;
  }
  req.url = pathname;
  req.headers = { host: "localhost:2138" };
  Object.defineProperty(req.socket, "remoteAddress", {
    value: "127.0.0.1",
    configurable: true,
  });
  return req;
}

type AppOverrides = Omit<Partial<AppEntry>, "launch" | "render"> & {
  launch?: Partial<AppEntry["launch"]>;
  render?: Partial<AppEntry["render"]>;
};

function makeApp(overrides: AppOverrides = {}): AppEntry {
  const { launch, render, resources, ...rest } = overrides;
  return {
    id: "demo-app",
    name: "Demo App",
    kind: "app",
    subtype: "tool",
    source: "bundled",
    tags: [],
    config: {},
    dependsOn: [],
    channels: [],
    shortIds: [],
    resources: { ...resources },
    launch: {
      type: "internal-tab",
      capabilities: [],
      ...launch,
    },
    render: {
      visible: true,
      pinTo: [],
      style: "card",
      group: "tools",
      actions: [],
      ...render,
    },
    ...rest,
  };
}

function stubApps(apps: AppEntry[]): void {
  mocks.loadRegistry.mockReturnValue(REGISTRY_SENTINEL);
  mocks.getApps.mockImplementation((registry) => {
    expect(registry).toBe(REGISTRY_SENTINEL);
    return apps;
  });
}

async function loadRoute() {
  vi.resetModules();
  const mod = await import("./catalog-routes");
  return mod.handleCatalogRoutes;
}

describe("handleCatalogRoutes", () => {
  beforeEach(() => {
    mocks.ensureRouteAuthorized.mockReset();
    mocks.getApps.mockReset();
    mocks.loadRegistry.mockReset();
    mocks.ensureRouteAuthorized.mockResolvedValue(true);
    stubApps([]);
  });

  describe("routing", () => {
    it("returns false for paths outside /api/catalog without touching auth", async () => {
      const handleCatalogRoutes = await loadRoute();
      const res = fakeRes();
      const handled = await handleCatalogRoutes(
        fakeReq("/api/apps"),
        res.res,
        STATE,
      );

      expect(handled).toBe(false);
      expect(mocks.ensureRouteAuthorized).not.toHaveBeenCalled();
      expect(mocks.loadRegistry).not.toHaveBeenCalled();
      expect(res.body()).toBeNull();
    });

    it("returns false when the method or url is missing so the defaults miss /api/catalog/apps", async () => {
      const handleCatalogRoutes = await loadRoute();
      const req = new http.IncomingMessage(new Socket());
      const res = fakeRes();

      const handled = await handleCatalogRoutes(req, res.res, STATE);

      expect(handled).toBe(false);
      expect(mocks.ensureRouteAuthorized).not.toHaveBeenCalled();
    });

    it("returns false for catalog prefixes that are not GET /api/catalog/apps", async () => {
      const handleCatalogRoutes = await loadRoute();
      const cases = [
        fakeReq("/api/catalog"),
        fakeReq("/api/catalog/"),
        fakeReq("/api/catalog/apps/extra"),
        fakeReq("/api/catalogfoo"),
        fakeReq("/api/catalog/apps", { method: "POST" }),
        fakeReq("/api/catalog/apps", { method: "PUT" }),
        fakeReq("/api/catalog/apps", { method: "HEAD" }),
      ];

      for (const req of cases) {
        const res = fakeRes();
        const handled = await handleCatalogRoutes(req, res.res, STATE);
        expect(handled).toBe(false);
      }

      expect(mocks.ensureRouteAuthorized).not.toHaveBeenCalled();
      expect(mocks.getApps).not.toHaveBeenCalled();
    });
  });

  describe("authorization", () => {
    it("claims GET /api/catalog/apps when the gate rejects and does not read the catalog", async () => {
      mocks.ensureRouteAuthorized.mockResolvedValue(false);
      const handleCatalogRoutes = await loadRoute();
      const req = fakeReq("/api/catalog/apps");
      const res = fakeRes();

      const handled = await handleCatalogRoutes(req, res.res, STATE);

      expect(handled).toBe(true);
      expect(mocks.ensureRouteAuthorized).toHaveBeenCalledWith(
        req,
        res.res,
        STATE,
      );
      expect(mocks.loadRegistry).not.toHaveBeenCalled();
      expect(mocks.getApps).not.toHaveBeenCalled();
      expect(res.body()).toBeNull();
    });
  });

  describe("GET /api/catalog/apps", () => {
    it("treats a missing method as GET and still serves the catalog", async () => {
      const handleCatalogRoutes = await loadRoute();
      const req = fakeReq("/api/catalog/apps");
      req.method = undefined;
      const res = fakeRes();

      const handled = await handleCatalogRoutes(req, res.res, STATE);

      expect(handled).toBe(true);
      expect(res.status()).toBe(200);
      expect(res.body()).toEqual([]);
    });

    it("uppercases a lowercase GET and honours a query string on the apps path", async () => {
      const handleCatalogRoutes = await loadRoute();
      const res = fakeRes();

      const handled = await handleCatalogRoutes(
        fakeReq("/api/catalog/apps?source=dashboard", { method: "get" }),
        res.res,
        STATE,
      );

      expect(handled).toBe(true);
      expect(res.status()).toBe(200);
      expect(res.body()).toEqual([]);
    });

    it("returns an empty JSON array when the registry has no apps", async () => {
      stubApps([]);
      const handleCatalogRoutes = await loadRoute();
      const res = fakeRes();

      const handled = await handleCatalogRoutes(
        fakeReq("/api/catalog/apps"),
        res.res,
        STATE,
      );

      expect(handled).toBe(true);
      expect(res.status()).toBe(200);
      expect(res.body()).toEqual([]);
      expect(mocks.getApps).toHaveBeenCalledWith(REGISTRY_SENTINEL);
    });

    it("filters hidden apps and preserves getApps order among the visible remainder", async () => {
      stubApps([
        makeApp({
          id: "hidden-app",
          name: "Hidden",
          render: { visible: false },
        }),
        makeApp({ id: "first-visible", name: "First" }),
        makeApp({
          id: "also-hidden",
          name: "Also Hidden",
          render: { visible: false },
        }),
        makeApp({ id: "second-visible", name: "Second" }),
      ]);
      const handleCatalogRoutes = await loadRoute();
      const res = fakeRes();

      const handled = await handleCatalogRoutes(
        fakeReq("/api/catalog/apps"),
        res.res,
        STATE,
      );

      expect(handled).toBe(true);
      const body = res.body();
      expect(Array.isArray(body)).toBe(true);
      const names = (body as Array<{ name: string }>).map((app) => app.name);
      expect(names).toEqual(["first-visible", "second-visible"]);
    });

    it("maps a fully populated visible app onto RegistryAppInfo", async () => {
      const viewer = {
        url: "https://example.test/view",
        sandbox: "allow-scripts",
      };
      const uiExtension = { detailPanelId: "panel-demo" };
      stubApps([
        makeApp({
          id: "demo-app",
          name: "Demo App",
          description: "A catalog fixture",
          npmName: "@elizaos/app-demo",
          version: "2.1.0",
          subtype: "game",
          resources: { repository: "https://github.com/elizaOS/app-demo" },
          launch: {
            type: "overlay",
            url: "https://example.test/launch",
            capabilities: ["camera"],
            supports: { v0: true, v1: false, v2: true },
            npm: {
              package: "@elizaos/app-demo-npm",
              v0Version: "0.9.0",
              v1Version: "1.4.0",
              v2Version: "2.1.0",
            },
            viewer,
            uiExtension,
          },
          render: {
            visible: true,
            icon: "icon-demo",
            heroImage: "https://cdn.example.test/hero.png",
          },
        }),
      ]);
      const handleCatalogRoutes = await loadRoute();
      const res = fakeRes();

      await handleCatalogRoutes(fakeReq("/api/catalog/apps"), res.res, STATE);

      expect(res.status()).toBe(200);
      expect(res.body()).toEqual([
        {
          name: "@elizaos/app-demo",
          displayName: "Demo App",
          description: "A catalog fixture",
          category: "game",
          launchType: "overlay",
          launchUrl: "https://example.test/launch",
          icon: "icon-demo",
          heroImage: "https://cdn.example.test/hero.png",
          capabilities: ["camera"],
          stars: 0,
          repository: "https://github.com/elizaOS/app-demo",
          latestVersion: "2.1.0",
          supports: { v0: true, v1: false, v2: true },
          npm: {
            package: "@elizaos/app-demo-npm",
            v0Version: "0.9.0",
            v1Version: "1.4.0",
            v2Version: "2.1.0",
          },
          viewer,
          uiExtension,
        },
      ]);
    });

    it("rewrites server-launch to launchType server and keeps other launch types", async () => {
      stubApps([
        makeApp({
          id: "server-app",
          npmName: "@elizaos/app-server",
          launch: { type: "server-launch" },
        }),
        makeApp({
          id: "tab-app",
          npmName: "@elizaos/app-tab",
          launch: { type: "internal-tab" },
        }),
        makeApp({
          id: "overlay-app",
          npmName: "@elizaos/app-overlay",
          launch: { type: "overlay" },
        }),
      ]);
      const handleCatalogRoutes = await loadRoute();
      const res = fakeRes();

      await handleCatalogRoutes(fakeReq("/api/catalog/apps"), res.res, STATE);

      const types = (res.body() as Array<{ launchType: string }>).map(
        (app) => app.launchType,
      );
      expect(types).toEqual(["server", "internal-tab", "overlay"]);
    });

    it("fills mapping defaults for missing optional AppEntry fields", async () => {
      stubApps([
        makeApp({
          id: "sparse-app",
          name: "Sparse",
          description: undefined,
          npmName: undefined,
          version: undefined,
          launch: {
            type: "internal-tab",
            url: undefined,
            npm: undefined,
            supports: undefined,
            viewer: undefined,
            uiExtension: undefined,
          },
          render: {
            visible: true,
            icon: undefined,
            heroImage: undefined,
          },
          resources: {},
        }),
      ]);
      const handleCatalogRoutes = await loadRoute();
      const res = fakeRes();

      await handleCatalogRoutes(fakeReq("/api/catalog/apps"), res.res, STATE);

      const [app] = res.body() as Array<Record<string, unknown>>;
      expect(app).toMatchObject({
        name: "sparse-app",
        displayName: "Sparse",
        description: "",
        category: "tool",
        launchType: "internal-tab",
        launchUrl: null,
        icon: null,
        heroImage: "/api/apps/hero/sparse-app",
        capabilities: [],
        stars: 0,
        repository: "",
        latestVersion: null,
        supports: { v0: false, v1: false, v2: true },
        npm: {
          package: "sparse-app",
          v0Version: null,
          v1Version: null,
          v2Version: null,
        },
      });
      expect(app).not.toHaveProperty("viewer");
      expect(app).not.toHaveProperty("uiExtension");
    });

    it("prefers npmName over id, and launch.npm.package over npmName, for the package identity", async () => {
      stubApps([
        makeApp({
          id: "fallback-id",
          npmName: "@elizaos/app-named",
          launch: { type: "internal-tab", npm: undefined },
        }),
        makeApp({
          id: "with-npm-block",
          npmName: "@elizaos/app-named-again",
          launch: {
            type: "internal-tab",
            npm: {
              package: "@elizaos/app-canonical",
              v0Version: null,
              v1Version: null,
              v2Version: null,
            },
          },
        }),
      ]);
      const handleCatalogRoutes = await loadRoute();
      const res = fakeRes();

      await handleCatalogRoutes(fakeReq("/api/catalog/apps"), res.res, STATE);

      const body = res.body() as Array<{
        name: string;
        npm: { package: string };
      }>;
      expect(body[0]?.name).toBe("@elizaos/app-named");
      expect(body[0]?.npm.package).toBe("@elizaos/app-named");
      expect(body[1]?.name).toBe("@elizaos/app-named-again");
      expect(body[1]?.npm.package).toBe("@elizaos/app-canonical");
    });

    it("uses a declared heroImage as-is, including a package-relative path", async () => {
      stubApps([
        makeApp({
          id: "hero-relative",
          npmName: "@elizaos/app-chess",
          render: { visible: true, heroImage: "assets/hero.png" },
        }),
      ]);
      const handleCatalogRoutes = await loadRoute();
      const res = fakeRes();

      await handleCatalogRoutes(fakeReq("/api/catalog/apps"), res.res, STATE);

      const [app] = res.body() as Array<{ heroImage: string }>;
      expect(app.heroImage).toBe("assets/hero.png");
    });

    it("falls back through launch.npm.v2Version, then entry.version, for npm.v2Version", async () => {
      stubApps([
        makeApp({
          id: "version-only",
          version: "3.0.0",
          launch: { type: "internal-tab", npm: undefined },
        }),
        makeApp({
          id: "npm-v2-wins",
          version: "3.0.0",
          launch: {
            type: "internal-tab",
            npm: {
              package: "npm-v2-wins",
              v0Version: "1.0.0",
              v1Version: "2.0.0",
              v2Version: "4.0.0",
            },
          },
        }),
      ]);
      const handleCatalogRoutes = await loadRoute();
      const res = fakeRes();

      await handleCatalogRoutes(fakeReq("/api/catalog/apps"), res.res, STATE);

      const body = res.body() as Array<{
        latestVersion: string | null;
        npm: { v2Version: string | null };
      }>;
      expect(body[0]?.latestVersion).toBe("3.0.0");
      expect(body[0]?.npm.v2Version).toBe("3.0.0");
      expect(body[1]?.latestVersion).toBe("3.0.0");
      expect(body[1]?.npm.v2Version).toBe("4.0.0");
    });

    it("stars is always 0 even for a fully populated catalog entry", async () => {
      stubApps([
        makeApp({
          id: "starred-looking",
          npmName: "@elizaos/app-starred",
          version: "1.0.0",
        }),
      ]);
      const handleCatalogRoutes = await loadRoute();
      const res = fakeRes();

      await handleCatalogRoutes(fakeReq("/api/catalog/apps"), res.res, STATE);

      const [app] = res.body() as Array<{ stars: number }>;
      expect(app.stars).toBe(0);
    });
  });
});
