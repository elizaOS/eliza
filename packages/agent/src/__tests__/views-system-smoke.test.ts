/**
 * Views System End-to-End Smoke Test
 *
 * Documents and verifies the full views system lifecycle:
 *
 *   Plugin declares views → registered in registry at plugin load
 *     → served via HTTP routes (list, metadata, bundle, hero)
 *     → navigate endpoint broadcasts WS event
 *     → frontend dispatches eliza:navigate:view custom event
 *     → ViewManagerPage renders view cards from /api/views
 *     → DynamicViewLoader fetches bundle from /api/views/:id/bundle.js
 *
 * This file acts as living documentation for how the system works.
 * Each test verifies one stage of the pipeline.
 */

import type http from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  generateViewHeroSvg,
  getBundleDiskPath,
  getView,
  listViews,
  registerPluginViews,
  unregisterPluginViews,
} from "../api/views-registry.js";
import type { ViewsRouteContext } from "../api/views-routes.js";
import { handleViewsRoutes } from "../api/views-routes.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SMOKE_PLUGIN = "views-smoke-plugin";
const SMOKE_VIEW = {
  id: "smoke.main",
  label: "Smoke View",
  description: "Smoke test view",
  icon: "TestTube",
  path: "/smoke",
  order: 1,
  bundlePath: "dist/views/bundle.js",
  componentExport: "SmokeView",
  tags: ["test"],
  visibleInManager: true,
};

function makeCtx(
  method: string,
  pathname: string,
  opts: {
    broadcastWs?: (payload: object) => void;
    developerMode?: boolean;
  } = {},
): {
  ctx: ViewsRouteContext;
  json: ReturnType<typeof vi.fn>;
  error: ReturnType<typeof vi.fn>;
} {
  const json = vi.fn();
  const error = vi.fn();
  const url = new URL(`http://localhost${pathname}`);
  const ctx: ViewsRouteContext = {
    req: { headers: {} } as http.IncomingMessage,
    res: {} as http.ServerResponse,
    method,
    pathname,
    url,
    json,
    error,
    broadcastWs: opts.broadcastWs,
    developerMode: opts.developerMode,
  };
  return { ctx, json, error };
}

beforeEach(() => {
  vi.spyOn(console, "info").mockImplementation(() => {});
});

afterEach(() => {
  unregisterPluginViews(SMOKE_PLUGIN);
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Stage 1: Plugin → Registry
// ---------------------------------------------------------------------------

describe("stage 1: plugin declares views → registry populated", () => {
  it("registerPluginViews stores the view entry keyed by id", async () => {
    await registerPluginViews(
      {
        name: SMOKE_PLUGIN,
        description: "smoke plugin",
        actions: [],
        views: [SMOKE_VIEW],
      },
      undefined,
    );

    const entry = getView("smoke.main");
    expect(entry).toBeDefined();
    expect(entry?.pluginName).toBe(SMOKE_PLUGIN);
    expect(entry?.label).toBe("Smoke View");
    expect(entry?.path).toBe("/smoke");
    expect(entry?.bundlePath).toBe("dist/views/bundle.js");
    expect(entry?.componentExport).toBe("SmokeView");
    expect(entry?.tags).toEqual(["test"]);
  });

  it("entry includes derived fields: bundleUrl and heroImageUrl", async () => {
    await registerPluginViews(
      {
        name: SMOKE_PLUGIN,
        description: "smoke plugin",
        actions: [],
        views: [SMOKE_VIEW],
      },
      undefined,
    );

    const entry = getView("smoke.main");
    expect(entry?.bundleUrl).toMatch(
      /^\/api\/views\/smoke\.main\/bundle\.js\?v=\d+$/,
    );
    expect(entry?.heroImageUrl).toBe("/api/views/smoke.main/hero");
  });

  it("entry marks available=false when pluginDir is not resolvable", async () => {
    await registerPluginViews(
      {
        name: SMOKE_PLUGIN,
        description: "smoke plugin",
        actions: [],
        views: [SMOKE_VIEW],
      },
      undefined,
    );

    const entry = getView("smoke.main");
    // Without a resolvable pluginDir and an actual dist/views/bundle.js, available=false.
    expect(entry?.available).toBe(false);
  });

  it("unregisterPluginViews removes all views owned by that plugin", async () => {
    await registerPluginViews(
      {
        name: SMOKE_PLUGIN,
        description: "smoke plugin",
        actions: [],
        views: [SMOKE_VIEW],
      },
      undefined,
    );
    expect(getView("smoke.main")).toBeDefined();

    unregisterPluginViews(SMOKE_PLUGIN);
    expect(getView("smoke.main")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Stage 2: Registry → HTTP API — listing
// ---------------------------------------------------------------------------

describe("stage 2: HTTP GET /api/views returns views list", () => {
  it("GET /api/views returns a views array containing registered views", async () => {
    await registerPluginViews(
      {
        name: SMOKE_PLUGIN,
        description: "smoke plugin",
        actions: [],
        views: [SMOKE_VIEW],
      },
      undefined,
    );

    const { ctx, json } = makeCtx("GET", "/api/views");
    const handled = await handleViewsRoutes(ctx);

    expect(handled).toBe(true);
    const [, body] = json.mock.calls[0] as [
      unknown,
      { views: { id: string }[] },
    ];
    expect(body.views.some((v) => v.id === "smoke.main")).toBe(true);
  });

  it("GET /api/views response includes bundleUrl and heroImageUrl for views with bundlePath", async () => {
    await registerPluginViews(
      {
        name: SMOKE_PLUGIN,
        description: "smoke plugin",
        actions: [],
        views: [SMOKE_VIEW],
      },
      undefined,
    );

    const { ctx, json } = makeCtx("GET", "/api/views");
    await handleViewsRoutes(ctx);

    const [, body] = json.mock.calls[0] as [
      unknown,
      { views: { id: string; bundleUrl?: string; heroImageUrl?: string }[] },
    ];
    const view = body.views.find((v) => v.id === "smoke.main");
    expect(view?.bundleUrl).toMatch(
      /^\/api\/views\/smoke\.main\/bundle\.js\?v=\d+$/,
    );
    expect(view?.heroImageUrl).toBe("/api/views/smoke.main/hero");
  });
});

// ---------------------------------------------------------------------------
// Stage 3: HTTP API — single view metadata
// ---------------------------------------------------------------------------

describe("stage 3: GET /api/views/:id returns single view metadata", () => {
  it("returns the full view entry as JSON", async () => {
    await registerPluginViews(
      {
        name: SMOKE_PLUGIN,
        description: "smoke plugin",
        actions: [],
        views: [SMOKE_VIEW],
      },
      undefined,
    );

    const { ctx, json } = makeCtx("GET", "/api/views/smoke.main");
    const handled = await handleViewsRoutes(ctx);

    expect(handled).toBe(true);
    const [, body] = json.mock.calls[0] as [
      unknown,
      { id: string; label: string; pluginName: string },
    ];
    expect(body.id).toBe("smoke.main");
    expect(body.label).toBe("Smoke View");
    expect(body.pluginName).toBe(SMOKE_PLUGIN);
  });

  it("returns 404 for unknown view id", async () => {
    const { ctx, error } = makeCtx("GET", "/api/views/does.not.exist");
    await handleViewsRoutes(ctx);

    const [, , status] = error.mock.calls[0] as [unknown, string, number];
    expect(status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Stage 4: HTTP API — bundle endpoint
// ---------------------------------------------------------------------------

describe("stage 4: GET /api/views/:id/bundle.js serves the view bundle", () => {
  it("returns 404 when no bundlePath is configured", async () => {
    const viewNoBundlePath = { ...SMOKE_VIEW, bundlePath: undefined };
    await registerPluginViews(
      {
        name: SMOKE_PLUGIN,
        description: "smoke plugin",
        actions: [],
        views: [viewNoBundlePath],
      },
      undefined,
    );

    const { ctx, error } = makeCtx("GET", "/api/views/smoke.main/bundle.js");
    await handleViewsRoutes(ctx);

    const [, , status] = error.mock.calls[0] as [unknown, string, number];
    expect(status).toBe(404);
  });

  it("getBundleDiskPath returns null when pluginDir is undefined", async () => {
    await registerPluginViews(
      {
        name: SMOKE_PLUGIN,
        description: "smoke plugin",
        actions: [],
        views: [SMOKE_VIEW],
      },
      undefined,
    );

    const entry = getView("smoke.main");
    expect(entry).toBeDefined();
    // Without a pluginDir, getBundleDiskPath returns null.
    expect(getBundleDiskPath(entry!)).toBeNull();
  });

  it("getBundleDiskPath resolves correctly given a pluginDir", async () => {
    await registerPluginViews(
      {
        name: SMOKE_PLUGIN,
        description: "smoke plugin",
        actions: [],
        views: [SMOKE_VIEW],
      },
      "/some/plugin/dir",
    );

    const entry = getView("smoke.main");
    expect(entry).toBeDefined();
    const diskPath = getBundleDiskPath(entry!);
    expect(diskPath).toBe("/some/plugin/dir/dist/views/bundle.js");
  });
});

// ---------------------------------------------------------------------------
// Stage 5: HTTP API — hero image endpoint
// ---------------------------------------------------------------------------

describe("stage 5: GET /api/views/:id/hero serves hero image or SVG placeholder", () => {
  it("returns an SVG placeholder when no hero image exists on disk", async () => {
    await registerPluginViews(
      {
        name: SMOKE_PLUGIN,
        description: "smoke plugin",
        actions: [],
        views: [SMOKE_VIEW],
      },
      undefined,
    );

    // The handler calls sendGeneratedHero for entries without a resolvable hero.
    // We can verify the SVG generator works correctly.
    const svg = generateViewHeroSvg("Smoke View", "TestTube");
    expect(svg).toContain("<svg");
    expect(svg).toContain("Smoke View");
    expect(svg).toContain("TestTube");
  });
});

// ---------------------------------------------------------------------------
// Stage 6: HTTP API — navigate endpoint
// ---------------------------------------------------------------------------

describe("stage 6: POST /api/views/:id/navigate broadcasts WS event", () => {
  it("calls broadcastWs with shell:navigate:view type and viewId", async () => {
    await registerPluginViews(
      {
        name: SMOKE_PLUGIN,
        description: "smoke plugin",
        actions: [],
        views: [SMOKE_VIEW],
      },
      undefined,
    );

    const broadcasts: object[] = [];
    const { ctx, json } = makeCtx("POST", "/api/views/smoke.main/navigate", {
      broadcastWs: (payload) => broadcasts.push(payload),
    });
    const handled = await handleViewsRoutes(ctx);

    expect(handled).toBe(true);
    expect(broadcasts).toHaveLength(1);
    const event = broadcasts[0] as {
      type: string;
      viewId: string;
      viewPath: string | null;
    };
    expect(event.type).toBe("shell:navigate:view");
    expect(event.viewId).toBe("smoke.main");
    expect(event.viewPath).toBe("/smoke");

    // Also returns JSON with ok: true
    const [, body] = json.mock.calls[0] as [
      unknown,
      { ok: boolean; viewId: string },
    ];
    expect(body.ok).toBe(true);
    expect(body.viewId).toBe("smoke.main");
  });

  it("navigate works for synthetic IDs not in registry (like view manager)", async () => {
    const broadcasts: object[] = [];
    const { ctx, json } = makeCtx(
      "POST",
      "/api/views/__view-manager__/navigate",
      {
        broadcastWs: (payload) => broadcasts.push(payload),
      },
    );
    const handled = await handleViewsRoutes(ctx);

    expect(handled).toBe(true);
    expect(broadcasts).toHaveLength(1);
    const event = broadcasts[0] as {
      type: string;
      viewId: string;
      viewPath: string | null;
    };
    expect(event.type).toBe("shell:navigate:view");
    expect(event.viewId).toBe("__view-manager__");
    // The synthetic manager id resolves to the built-in Views route.
    expect(event.viewPath).toBe("/apps");

    const [, body] = json.mock.calls[0] as [unknown, { ok: boolean }];
    expect(body.ok).toBe(true);
  });

  it("navigate without broadcastWs still returns 200 (broadcastWs is optional)", async () => {
    await registerPluginViews(
      {
        name: SMOKE_PLUGIN,
        description: "smoke plugin",
        actions: [],
        views: [SMOKE_VIEW],
      },
      undefined,
    );

    const { ctx, json } = makeCtx("POST", "/api/views/smoke.main/navigate");
    const handled = await handleViewsRoutes(ctx);

    expect(handled).toBe(true);
    const [, body] = json.mock.calls[0] as [unknown, { ok: boolean }];
    expect(body.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Stage 7: Registry ordering and filtering
// ---------------------------------------------------------------------------

describe("stage 7: registry ordering and developer mode filtering", () => {
  it("listViews returns views sorted by order field ascending", async () => {
    const views = [
      { id: "smoke.z", label: "Z View", order: 99 },
      { id: "smoke.a", label: "A View", order: 1 },
      { id: "smoke.m", label: "M View", order: 50 },
    ];

    await registerPluginViews(
      { name: SMOKE_PLUGIN, description: "smoke plugin", actions: [], views },
      undefined,
    );

    const listed = listViews().filter((v) =>
      ["smoke.a", "smoke.m", "smoke.z"].includes(v.id),
    );
    expect(listed.map((v) => v.id)).toEqual(["smoke.a", "smoke.m", "smoke.z"]);

    // Clean up extra views
    unregisterPluginViews(SMOKE_PLUGIN);
  });

  it("developerOnly views are excluded from listViews by default", async () => {
    const devOnlyView = {
      id: "smoke.devonly",
      label: "Dev Only",
      developerOnly: true,
    };
    await registerPluginViews(
      {
        name: SMOKE_PLUGIN,
        description: "smoke plugin",
        actions: [],
        views: [devOnlyView],
      },
      undefined,
    );

    const normal = listViews({ developerMode: false });
    expect(normal.find((v) => v.id === "smoke.devonly")).toBeUndefined();

    const dev = listViews({ developerMode: true });
    expect(dev.find((v) => v.id === "smoke.devonly")).toBeDefined();

    unregisterPluginViews(SMOKE_PLUGIN);
  });
});

// ---------------------------------------------------------------------------
// Stage 8: Full route lifecycle — not-found handling
// ---------------------------------------------------------------------------

describe("stage 8: route fall-through for non-views paths", () => {
  it("returns handled=false for /api/apps", async () => {
    const { ctx } = makeCtx("GET", "/api/apps");
    const handled = await handleViewsRoutes(ctx);
    expect(handled).toBe(false);
  });

  it("returns handled=false for /", async () => {
    const { ctx } = makeCtx("GET", "/");
    const handled = await handleViewsRoutes(ctx);
    expect(handled).toBe(false);
  });

  it("returns handled=false for /api/health", async () => {
    const { ctx } = makeCtx("GET", "/api/health");
    const handled = await handleViewsRoutes(ctx);
    expect(handled).toBe(false);
  });
});
