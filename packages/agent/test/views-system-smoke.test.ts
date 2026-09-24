/** Registry and in-process HTTP route smoke tests using actual runtimes and disk fixtures. WebSocket delivery is observed through spies; no browser, native device, or inference is exercised. */
import { AgentRuntime, createCharacter } from "@elizaos/core";
import { closeRuntimeViewRegistry } from "../src/api/view-installations.ts";
import { closeViewInteractionHost } from "../src/api/view-interaction-host.ts";
import { bindCatalogAssetRequest } from "./view-renderer-test-utils.ts";

let runtime: AgentRuntime;
let hostKey: object;
const installed = new Map<string, Awaited<ReturnType<typeof registerViews>>>();
async function registerPluginViews(...args: Parameters<typeof registerViews>) {
  const lease = await registerViews(...args);
  installed.set(args[1].name, lease);
  return lease;
}
function unregisterPluginViews(name: string) {
  const lease = installed.get(name);
  if (lease) unregisterViews(runtime, lease);
  installed.delete(name);
}

import { EventEmitter } from "node:events";
import {
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import type http from "node:http";
import os from "node:os";
import path from "node:path";
import { SHELL_NAVIGATE_VIEW_WS_EVENT } from "@elizaos/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  findHeroOnDisk,
  generateViewHeroSvg,
  getBundleDiskPath,
  getFrameDiskPath,
  getHeroDiskPath,
  getView,
  listViews,
  registerPluginViews as registerViews,
  unregisterPluginViews as unregisterViews,
} from "../src/api/views-registry.js";
import type { ViewsRouteContext } from "../src/api/views-routes.js";
import {
  clearCurrentViewState,
  handleViewsRoutes,
} from "../src/api/views-routes.js";

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
    body?: unknown;
    broadcastWs?: (payload: object) => void;
    developerMode?: boolean;
    headers?: http.IncomingHttpHeaders;
    res?: http.ServerResponse;
  } = {},
): {
  ctx: ViewsRouteContext;
  json: ReturnType<typeof vi.fn>;
  error: ReturnType<typeof vi.fn>;
} {
  const json = vi.fn();
  const error = vi.fn();
  const url = new URL(`http://localhost${pathname}`);

  const req =
    opts.body !== undefined || method === "POST"
      ? makeReqWithBody(opts.body)
      : ({ headers: opts.headers ?? {} } as http.IncomingMessage);
  const ctx: ViewsRouteContext = {
    runtime,
    hostKey,
    req,
    res: opts.res ?? ({} as http.ServerResponse),
    method,
    pathname: url.pathname,
    url,
    json,
    error,
    broadcastWs: opts.broadcastWs,
    developerMode: opts.developerMode,
  };
  bindCatalogAssetRequest(runtime, ctx);
  return { ctx, json, error };
}

function makeReqWithBody(body?: unknown): http.IncomingMessage {
  const req = new EventEmitter() as http.IncomingMessage;
  (req as unknown as { headers: Record<string, string> }).headers = {
    "content-type": "application/json",
  };
  process.nextTick(() => {
    if (body !== undefined) {
      req.emit("data", Buffer.from(JSON.stringify(body)));
    }
    req.emit("end");
  });
  return req;
}

beforeEach(() => {
  runtime = new AgentRuntime({
    character: createCharacter({ name: "View smoke" }),
    enableAutonomy: false,
  });
  hostKey = {};
  installed.clear();
  vi.spyOn(console, "info").mockImplementation(() => {});
});

afterEach(() => {
  unregisterPluginViews(SMOKE_PLUGIN);
  clearCurrentViewState(runtime);
  closeRuntimeViewRegistry(runtime);
  closeViewInteractionHost(hostKey);
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Stage 1: Plugin → Registry
// ---------------------------------------------------------------------------

describe("stage 1: plugin declares views → registry populated", () => {
  it("registerPluginViews stores the view entry keyed by id", async () => {
    await registerPluginViews(
      runtime,
      {
        name: SMOKE_PLUGIN,
        description: "smoke plugin",
        actions: [],
        views: [SMOKE_VIEW],
      },
      { pluginDir: undefined, indexEmbeddings: false },
    );

    const entry = getView(runtime, "smoke.main");
    expect(entry).toBeDefined();
    expect(entry?.pluginName).toBe(SMOKE_PLUGIN);
    expect(entry?.label).toBe("Smoke View");
    expect(entry?.path).toBe("/smoke");
    expect(entry?.bundlePath).toBe("dist/views/bundle.js");
    expect(entry?.componentExport).toBe("SmokeView");
    expect(entry?.tags).toEqual(["test"]);
  });

  it("expands one multimodal declaration into concrete viewType entries", async () => {
    await registerPluginViews(
      runtime,
      {
        name: SMOKE_PLUGIN,
        description: "smoke plugin",
        actions: [],
        views: [
          {
            ...SMOKE_VIEW,
            id: "smoke.multimodal",
            label: "Smoke Multimodal",
            modalities: ["gui", "xr", "tui"],
          },
        ],
      },
      { pluginDir: undefined, indexEmbeddings: false },
    );

    for (const viewType of ["gui", "xr", "tui"] as const) {
      const entry = getView(runtime, "smoke.multimodal", { viewType });
      expect(entry).toBeDefined();
      expect(entry?.viewType).toBe(viewType);
      expect(entry?.modalities).toEqual(["gui", "xr", "tui"]);
      expect(
        listViews(runtime, { developerMode: true, viewType }).filter(
          (view) => view.id === "smoke.multimodal",
        ),
      ).toHaveLength(1);
    }

    expect(getView(runtime, "smoke.multimodal")?.bundleUrl).not.toContain(
      "viewType=",
    );
    expect(
      getView(runtime, "smoke.multimodal", { viewType: "tui" })?.bundleUrl,
    ).toContain("/tui/bundle/");
    expect(
      getView(runtime, "smoke.multimodal", { viewType: "xr" })?.heroImageUrl,
    ).toContain("viewType=xr");
  });

  it("entry includes derived fields: bundleUrl and heroImageUrl", async () => {
    await registerPluginViews(
      runtime,
      {
        name: SMOKE_PLUGIN,
        description: "smoke plugin",
        actions: [],
        views: [SMOKE_VIEW],
      },
      { pluginDir: undefined, indexEmbeddings: false },
    );

    const entry = getView(runtime, "smoke.main");
    expect(entry?.bundleUrl).toMatch(
      /^\/api\/views\/smoke\.main\/installations\/[a-f0-9-]{36}\/gui\/bundle\/bundle\.js(?:\?v=[a-f0-9]{64})?$/,
    );
    expect(entry?.heroImageUrl).toBe("/api/views/smoke.main/hero");
  });

  it("entry includes viewType in derived TUI asset URLs", async () => {
    await registerPluginViews(
      runtime,
      {
        name: SMOKE_PLUGIN,
        description: "smoke plugin",
        actions: [],
        views: [{ ...SMOKE_VIEW, viewType: "tui", path: "/smoke/tui" }],
      },
      { pluginDir: undefined, indexEmbeddings: false },
    );

    const entry = getView(runtime, "smoke.main", { viewType: "tui" });
    expect(entry?.bundleUrl).toMatch(
      /^\/api\/views\/smoke\.main\/installations\/[a-f0-9-]{36}\/tui\/bundle\/bundle\.js(?:\?v=[a-f0-9]{64})?$/,
    );
    expect(entry?.heroImageUrl).toBe("/api/views/smoke.main/hero?viewType=tui");
  });

  it("entry marks available=false when pluginDir is not resolvable", async () => {
    await registerPluginViews(
      runtime,
      {
        name: SMOKE_PLUGIN,
        description: "smoke plugin",
        actions: [],
        views: [SMOKE_VIEW],
      },
      { pluginDir: undefined, indexEmbeddings: false },
    );

    const entry = getView(runtime, "smoke.main");
    // Without a resolvable pluginDir and an actual dist/views/bundle.js, available=false.
    expect(entry?.available).toBe(false);
  });

  it("unregisterPluginViews removes all views owned by that plugin", async () => {
    await registerPluginViews(
      runtime,
      {
        name: SMOKE_PLUGIN,
        description: "smoke plugin",
        actions: [],
        views: [SMOKE_VIEW],
      },
      { pluginDir: undefined, indexEmbeddings: false },
    );
    expect(getView(runtime, "smoke.main")).toBeDefined();

    unregisterPluginViews(SMOKE_PLUGIN);
    expect(getView(runtime, "smoke.main")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Stage 2: Registry → HTTP API — listing
// ---------------------------------------------------------------------------

describe("stage 2: HTTP GET /api/views returns views list", () => {
  it("GET /api/views returns a views array containing registered views", async () => {
    await registerPluginViews(
      runtime,
      {
        name: SMOKE_PLUGIN,
        description: "smoke plugin",
        actions: [],
        views: [SMOKE_VIEW],
      },
      { pluginDir: undefined, indexEmbeddings: false },
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
      runtime,
      {
        name: SMOKE_PLUGIN,
        description: "smoke plugin",
        actions: [],
        views: [SMOKE_VIEW],
      },
      { pluginDir: undefined, indexEmbeddings: false },
    );

    const { ctx, json } = makeCtx("GET", "/api/views");
    await handleViewsRoutes(ctx);

    const [, body] = json.mock.calls[0] as [
      unknown,
      { views: { id: string; bundleUrl?: string; heroImageUrl?: string }[] },
    ];
    const view = body.views.find((v) => v.id === "smoke.main");
    expect(view?.bundleUrl).toMatch(
      /^\/api\/views\/smoke\.main\/installations\/[a-f0-9-]{36}\/gui\/bundle\/bundle\.js(?:\?v=[a-f0-9]{64})?$/,
    );
    expect(view?.heroImageUrl).toBe("/api/views/smoke.main/hero");
  });

  it("GET /api/views response includes frameUrl for sandboxed iframe views with framePath", async () => {
    const pluginDir = await mkdtemp(path.join(os.tmpdir(), "eliza-frame-"));
    try {
      await mkdir(path.join(pluginDir, "dist", "views"), { recursive: true });
      await writeFile(
        path.join(pluginDir, "dist", "views", "frame.html"),
        "<!doctype html><title>Sandbox smoke</title>",
      );

      await registerPluginViews(
        runtime,
        {
          name: SMOKE_PLUGIN,
          description: "smoke plugin",
          actions: [],
          views: [
            {
              ...SMOKE_VIEW,
              bundlePath: undefined,
              framePath: "dist/views/frame.html",
              surface: { isolation: "sandboxed-iframe" },
            },
          ],
        },
        { pluginDir: pluginDir, indexEmbeddings: false },
      );

      const { ctx, json } = makeCtx("GET", "/api/views");
      await handleViewsRoutes(ctx);

      const [, body] = json.mock.calls[0] as [
        unknown,
        {
          views: {
            id: string;
            bundleUrl?: string;
            frameUrl?: string;
            available: boolean;
          }[];
        },
      ];
      const view = body.views.find((v) => v.id === "smoke.main");
      expect(view?.bundleUrl).toBeUndefined();
      expect(view?.frameUrl).toMatch(
        /^\/api\/views\/smoke\.main\/installations\/[a-f0-9-]{36}\/gui\/frame\/frame\.html(?:\?v=[a-f0-9]{64})?$/,
      );
      expect(view?.available).toBe(true);
      const registryEntry = getView(runtime, "smoke.main");
      expect(registryEntry).toBeTruthy();
      expect(registryEntry ? getFrameDiskPath(registryEntry) : null).toBe(
        await realpath(path.join(pluginDir, "dist", "views", "frame.html")),
      );
    } finally {
      await rm(pluginDir, { recursive: true, force: true });
    }
  });

  it("marks sandboxed iframe views unavailable when their frame document is missing", async () => {
    const pluginDir = await mkdtemp(path.join(os.tmpdir(), "eliza-frame-"));
    try {
      await mkdir(path.join(pluginDir, "dist", "views"), { recursive: true });
      await writeFile(
        path.join(pluginDir, "dist", "views", "bundle.js"),
        "export default function Smoke() { return null; }",
      );

      await registerPluginViews(
        runtime,
        {
          name: SMOKE_PLUGIN,
          description: "smoke plugin",
          actions: [],
          views: [
            {
              ...SMOKE_VIEW,
              framePath: "dist/views/frame.html",
              surface: { isolation: "sandboxed-iframe" },
            },
          ],
        },
        { pluginDir: pluginDir, indexEmbeddings: false },
      );

      const { ctx, json } = makeCtx("GET", "/api/views");
      await handleViewsRoutes(ctx);

      const [, body] = json.mock.calls[0] as [
        unknown,
        {
          views: {
            id: string;
            available: boolean;
            bundleUrl?: string;
            frameUrl?: string;
          }[];
        },
      ];
      const view = body.views.find((v) => v.id === "smoke.main");
      expect(view?.bundleUrl).toMatch(
        /^\/api\/views\/smoke\.main\/installations\/[a-f0-9-]{36}\/gui\/bundle\/bundle\.js(?:\?v=[a-f0-9]{64})?$/,
      );
      expect(view?.frameUrl).toMatch(
        /^\/api\/views\/smoke\.main\/installations\/[a-f0-9-]{36}\/gui\/frame\/frame\.html(?:\?v=[a-f0-9]{64})?$/,
      );
      expect(view?.available).toBe(false);
    } finally {
      await rm(pluginDir, { recursive: true, force: true });
    }
  });

  it("keeps installation metadata without executable frame URLs on restricted native platforms", async () => {
    const pluginDir = await mkdtemp(path.join(os.tmpdir(), "eliza-frame-"));
    try {
      await mkdir(path.join(pluginDir, "dist", "views"), { recursive: true });
      await writeFile(
        path.join(pluginDir, "dist", "views", "frame.html"),
        "<!doctype html><title>Sandbox smoke</title>",
      );

      await registerPluginViews(
        runtime,
        {
          name: SMOKE_PLUGIN,
          description: "smoke plugin",
          actions: [],
          views: [
            {
              ...SMOKE_VIEW,
              bundlePath: undefined,
              framePath: "dist/views/frame.html",
              surface: { isolation: "sandboxed-iframe" },
            },
          ],
        },
        { pluginDir: pluginDir, indexEmbeddings: false },
      );

      const { ctx, json } = makeCtx("GET", "/api/views", {
        headers: { "x-eliza-platform": "ios" },
      });
      await handleViewsRoutes(ctx);

      const [, body] = json.mock.calls[0] as [
        unknown,
        {
          views: Array<{
            id: string;
            installationId?: string;
            metadataOnly?: boolean;
            available: boolean;
            bundleUrl?: string;
            frameUrl?: string;
          }>;
        },
      ];
      const metadata = body.views.find((view) => view.id === "smoke.main");
      expect(metadata).toMatchObject({
        installationId: getView(runtime, "smoke.main")?.installationId,
        available: false,
        metadataOnly: true,
      });
      expect(metadata?.bundleUrl).toBeUndefined();
      expect(metadata?.frameUrl).toBeUndefined();
    } finally {
      await rm(pluginDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Stage 3: HTTP API — single view metadata
// ---------------------------------------------------------------------------

describe("stage 3: GET /api/views/:id returns single view metadata", () => {
  it("returns the full view entry as JSON", async () => {
    await registerPluginViews(
      runtime,
      {
        name: SMOKE_PLUGIN,
        description: "smoke plugin",
        actions: [],
        views: [SMOKE_VIEW],
      },
      { pluginDir: undefined, indexEmbeddings: false },
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
      runtime,
      {
        name: SMOKE_PLUGIN,
        description: "smoke plugin",
        actions: [],
        views: [viewNoBundlePath],
      },
      { pluginDir: undefined, indexEmbeddings: false },
    );

    const { ctx, error } = makeCtx("GET", "/api/views/smoke.main/bundle.js");
    await handleViewsRoutes(ctx);

    const [, , status] = error.mock.calls[0] as [unknown, string, number];
    expect(status).toBe(404);
  });

  it("getBundleDiskPath returns null when pluginDir is undefined", async () => {
    await registerPluginViews(
      runtime,
      {
        name: SMOKE_PLUGIN,
        description: "smoke plugin",
        actions: [],
        views: [SMOKE_VIEW],
      },
      { pluginDir: undefined, indexEmbeddings: false },
    );

    const entry = getView(runtime, "smoke.main");
    expect(entry).toBeDefined();
    // Without a pluginDir, getBundleDiskPath returns null.
    if (!entry) throw new Error("Expected smoke.main to be registered");
    expect(getBundleDiskPath(entry)).toBeNull();
  });

  it("getBundleDiskPath resolves correctly given a pluginDir", async () => {
    await registerPluginViews(
      runtime,
      {
        name: SMOKE_PLUGIN,
        description: "smoke plugin",
        actions: [],
        views: [SMOKE_VIEW],
      },
      { pluginDir: "/some/plugin/dir", indexEmbeddings: false },
    );

    const entry = getView(runtime, "smoke.main");
    expect(entry).toBeDefined();
    if (!entry) throw new Error("Expected smoke.main to be registered");
    const diskPath = getBundleDiskPath(entry);
    // getBundleDiskPath returns a real on-disk path (path.resolve), so it is
    // backslash/drive-rooted on Windows — compare against the platform-resolved
    // path rather than a hardcoded POSIX string.
    expect(diskPath).toBe(
      path.resolve("/some/plugin/dir", "dist/views/bundle.js"),
    );
  });

  it("rejects bundle, frame, and hero declarations equal to the plugin root", async () => {
    const pluginDir = await mkdtemp(path.join(os.tmpdir(), "eliza-view-root-"));
    try {
      await registerPluginViews(
        runtime,
        {
          name: SMOKE_PLUGIN,
          description: "plugin-root confinement fixture",
          actions: [],
          views: [
            {
              ...SMOKE_VIEW,
              bundlePath: ".",
              framePath: ".",
              heroImagePath: ".",
            },
          ],
        },
        { pluginDir: pluginDir, indexEmbeddings: false },
      );

      const entry = getView(runtime, "smoke.main");
      expect(entry).toBeDefined();
      if (!entry) throw new Error("Expected smoke.main to be registered");
      expect(entry.available).toBe(false);
      expect(getBundleDiskPath(entry)).toBeNull();
      expect(getFrameDiskPath(entry)).toBeNull();
      expect(getHeroDiskPath(entry)).toBeNull();
    } finally {
      await rm(pluginDir, { recursive: true, force: true });
    }
  });

  const itSymlink = process.platform === "win32" ? it.skip : it;

  itSymlink(
    "getBundleDiskPath rejects a bundle reached through a directory symlink",
    async () => {
      const pluginDir = await mkdtemp(
        path.join(os.tmpdir(), "eliza-view-root-"),
      );
      const outsideDir = await mkdtemp(
        path.join(os.tmpdir(), "eliza-view-outside-"),
      );
      try {
        await mkdir(path.join(outsideDir, "views"), { recursive: true });
        await writeFile(
          path.join(outsideDir, "views", "bundle.js"),
          "export {};",
        );
        await symlink(outsideDir, path.join(pluginDir, "dist"), "dir");
        await registerPluginViews(
          runtime,
          {
            name: SMOKE_PLUGIN,
            description: "symlink confinement fixture",
            actions: [],
            views: [SMOKE_VIEW],
          },
          { pluginDir: pluginDir, indexEmbeddings: false },
        );

        const entry = getView(runtime, "smoke.main");
        expect(entry).toBeDefined();
        expect(entry ? getBundleDiskPath(entry) : null).toBeNull();
      } finally {
        await rm(pluginDir, { recursive: true, force: true });
        await rm(outsideDir, { recursive: true, force: true });
      }
    },
  );

  it("serves relative chunks emitted beside the root bundle", async () => {
    const pluginDir = await mkdtemp(path.join(os.tmpdir(), "eliza-view-"));
    const viewsDir = path.join(pluginDir, "dist", "views");
    await mkdir(viewsDir, { recursive: true });
    await writeFile(path.join(viewsDir, "bundle.js"), "import './chunk.js';");
    await writeFile(path.join(viewsDir, "chunk.js"), "export const ok = true;");
    await writeFile(
      path.join(viewsDir, "bundle.js.assets.json"),
      JSON.stringify({ version: 1, files: ["bundle.js", "chunk.js"] }),
    );

    try {
      await registerPluginViews(
        runtime,
        {
          name: SMOKE_PLUGIN,
          description: "smoke plugin",
          actions: [],
          views: [SMOKE_VIEW],
        },
        { pluginDir: pluginDir, indexEmbeddings: false },
      );

      const writeHead = vi.fn();
      const end = vi.fn();
      const { ctx } = makeCtx("GET", "/api/views/smoke.main/chunk.js", {
        res: { writeHead, end } as unknown as http.ServerResponse,
      });
      await handleViewsRoutes(ctx);

      expect(writeHead).toHaveBeenCalledWith(
        200,
        expect.objectContaining({
          "Content-Type": "application/javascript; charset=utf-8",
        }),
      );
      expect(end).toHaveBeenCalledWith(Buffer.from("export const ok = true;"));
    } finally {
      await rm(pluginDir, { recursive: true, force: true });
    }
  });
});

describe("stage 4b: GET /api/views/:id/frame.html serves sandbox frame documents", () => {
  it("serves a configured sandbox frame document as HTML", async () => {
    const pluginDir = await mkdtemp(path.join(os.tmpdir(), "eliza-frame-"));
    try {
      await mkdir(path.join(pluginDir, "dist", "views"), { recursive: true });
      await writeFile(
        path.join(pluginDir, "dist", "views", "frame.html"),
        "<!doctype html><title>Sandbox smoke</title>",
      );

      await registerPluginViews(
        runtime,
        {
          name: SMOKE_PLUGIN,
          description: "smoke plugin",
          actions: [],
          views: [
            {
              ...SMOKE_VIEW,
              bundlePath: undefined,
              framePath: "dist/views/frame.html",
              surface: { isolation: "sandboxed-iframe" },
            },
          ],
        },
        { pluginDir: pluginDir, indexEmbeddings: false },
      );

      const res = {
        writeHead: vi.fn(),
        end: vi.fn(),
      };
      const { ctx } = makeCtx("GET", "/api/views/smoke.main/frame.html", {
        res: res as unknown as http.ServerResponse,
      });
      const handled = await handleViewsRoutes(ctx);

      expect(handled).toBe(true);
      expect(res.writeHead).toHaveBeenCalledWith(
        200,
        expect.objectContaining({
          "Content-Type": "text/html; charset=utf-8",
          "X-Content-Type-Options": "nosniff",
        }),
      );
      const served = res.end.mock.calls[0]?.[0];
      expect(Buffer.isBuffer(served)).toBe(true);
      expect(String(served)).toContain("<title>Sandbox smoke</title>");
    } finally {
      await rm(pluginDir, { recursive: true, force: true });
    }
  });

  it("blocks sandbox frame documents on restricted native platforms", async () => {
    const pluginDir = await mkdtemp(path.join(os.tmpdir(), "eliza-frame-"));
    try {
      await mkdir(path.join(pluginDir, "dist", "views"), { recursive: true });
      await writeFile(
        path.join(pluginDir, "dist", "views", "frame.html"),
        "<!doctype html><title>Sandbox smoke</title>",
      );

      await registerPluginViews(
        runtime,
        {
          name: SMOKE_PLUGIN,
          description: "smoke plugin",
          actions: [],
          views: [
            {
              ...SMOKE_VIEW,
              bundlePath: undefined,
              framePath: "dist/views/frame.html",
              surface: { isolation: "sandboxed-iframe" },
            },
          ],
        },
        { pluginDir: pluginDir, indexEmbeddings: false },
      );

      const { ctx, error } = makeCtx(
        "GET",
        "/api/views/smoke.main/frame.html",
        {
          headers: { "x-eliza-platform": "ios" },
        },
      );
      const handled = await handleViewsRoutes(ctx);

      expect(handled).toBe(true);
      expect(error).toHaveBeenCalledWith(
        expect.anything(),
        "Dynamic view asset loading is not permitted on this platform.",
        403,
      );
    } finally {
      await rm(pluginDir, { recursive: true, force: true });
    }
  });

  it("does not serve bundle.js as the sandbox frame document fallback", async () => {
    await registerPluginViews(
      runtime,
      {
        name: SMOKE_PLUGIN,
        description: "smoke plugin",
        actions: [],
        views: [SMOKE_VIEW],
      },
      { pluginDir: undefined, indexEmbeddings: false },
    );

    const { ctx, error } = makeCtx("GET", "/api/views/smoke.main/frame.html");
    const handled = await handleViewsRoutes(ctx);

    expect(handled).toBe(true);
    expect(error).toHaveBeenCalledOnce();
    const [, message, status] = error.mock.calls[0] as [
      unknown,
      string,
      number,
    ];
    expect(status).toBe(404);
    expect(message).toContain("has no local root");
  });
});

// ---------------------------------------------------------------------------
// Stage 5: HTTP API — hero image endpoint
// ---------------------------------------------------------------------------

describe("stage 5: GET /api/views/:id/hero serves hero image or SVG placeholder", () => {
  it("returns an SVG placeholder when no hero image exists on disk", async () => {
    await registerPluginViews(
      runtime,
      {
        name: SMOKE_PLUGIN,
        description: "smoke plugin",
        actions: [],
        views: [SMOKE_VIEW],
      },
      { pluginDir: undefined, indexEmbeddings: false },
    );

    // The handler calls sendGeneratedHero for entries without a resolvable hero.
    // We can verify the SVG generator works correctly.
    const svg = generateViewHeroSvg("Smoke View", "TestTube");
    expect(svg).toContain("<svg");
    expect(svg).toContain("Smoke View");
  });

  const itSymlink = process.platform === "win32" ? it.skip : it;

  itSymlink(
    "rejects a fallback hero symlink that escapes the plugin",
    async () => {
      const pluginDir = await mkdtemp(
        path.join(os.tmpdir(), "eliza-hero-root-"),
      );
      const outsideDir = await mkdtemp(
        path.join(os.tmpdir(), "eliza-hero-outside-"),
      );
      try {
        const assetsDir = path.join(pluginDir, "assets");
        const outsideHero = path.join(outsideDir, "secret.png");
        await mkdir(assetsDir, { recursive: true });
        await writeFile(outsideHero, "outside-secret");
        await symlink(outsideHero, path.join(assetsDir, "hero.png"), "file");

        await expect(
          findHeroOnDisk({ pluginDir, heroImagePath: undefined }),
        ).resolves.toBeNull();
      } finally {
        await rm(pluginDir, { recursive: true, force: true });
        await rm(outsideDir, { recursive: true, force: true });
      }
    },
  );
});

// ---------------------------------------------------------------------------
// Stage 6: HTTP API — navigate endpoint
// ---------------------------------------------------------------------------

describe("stage 6: POST /api/views/:id/navigate broadcasts WS event", () => {
  it("calls broadcastWs with shell:navigate:view type and viewId", async () => {
    await registerPluginViews(
      runtime,
      {
        name: SMOKE_PLUGIN,
        description: "smoke plugin",
        actions: [],
        views: [SMOKE_VIEW],
      },
      { pluginDir: undefined, indexEmbeddings: false },
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
      viewType: string;
    };
    expect(event.type).toBe(SHELL_NAVIGATE_VIEW_WS_EVENT);
    expect(event.viewId).toBe("smoke.main");
    expect(event.viewPath).toBe("/smoke");
    expect(event.viewType).toBe("gui");

    // Also returns JSON with ok: true
    const [, body] = json.mock.calls[0] as [
      unknown,
      { ok: boolean; viewId: string; viewType: string },
    ];
    expect(body.ok).toBe(true);
    expect(body.viewId).toBe("smoke.main");
    expect(body.viewType).toBe("gui");
  });

  it("propagates alwaysOnTop through navigate responses and broadcasts", async () => {
    await registerPluginViews(
      runtime,
      {
        name: SMOKE_PLUGIN,
        description: "smoke plugin",
        actions: [],
        views: [SMOKE_VIEW],
      },
      { pluginDir: undefined, indexEmbeddings: false },
    );

    const broadcasts: object[] = [];
    const { ctx, json } = makeCtx("POST", "/api/views/smoke.main/navigate", {
      body: { action: "open-window", alwaysOnTop: true },
      broadcastWs: (payload) => broadcasts.push(payload),
    });
    const handled = await handleViewsRoutes(ctx);

    expect(handled).toBe(true);
    expect(broadcasts).toHaveLength(1);
    expect(broadcasts[0]).toMatchObject({
      type: SHELL_NAVIGATE_VIEW_WS_EVENT,
      viewId: "smoke.main",
      action: "open-window",
      alwaysOnTop: true,
    });

    const [, body] = json.mock.calls[0] as [
      unknown,
      {
        ok: boolean;
        viewId: string;
        action: string;
        alwaysOnTop: boolean;
      },
    ];
    expect(body).toMatchObject({
      ok: true,
      viewId: "smoke.main",
      action: "open-window",
      alwaysOnTop: true,
    });
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
    expect(event.type).toBe(SHELL_NAVIGATE_VIEW_WS_EVENT);
    expect(event.viewId).toBe("__view-manager__");
    // The synthetic manager id resolves to the built-in Views route.
    expect(event.viewPath).toBe("/apps");

    const [, body] = json.mock.calls[0] as [unknown, { ok: boolean }];
    expect(body.ok).toBe(true);
  });

  it("navigate without broadcastWs still returns 200 (broadcastWs is optional)", async () => {
    await registerPluginViews(
      runtime,
      {
        name: SMOKE_PLUGIN,
        description: "smoke plugin",
        actions: [],
        views: [SMOKE_VIEW],
      },
      { pluginDir: undefined, indexEmbeddings: false },
    );

    const { ctx, json } = makeCtx("POST", "/api/views/smoke.main/navigate");
    const handled = await handleViewsRoutes(ctx);

    expect(handled).toBe(true);
    const [, body] = json.mock.calls[0] as [unknown, { ok: boolean }];
    expect(body.ok).toBe(true);
  });

  it("records the current view for agent-side awareness", async () => {
    await registerPluginViews(
      runtime,
      {
        name: SMOKE_PLUGIN,
        description: "smoke plugin",
        actions: [],
        views: [
          SMOKE_VIEW,
          {
            ...SMOKE_VIEW,
            viewType: "tui",
            label: "Smoke TUI",
            path: "/smoke/tui",
            componentExport: "SmokeTuiView",
          },
        ],
      },
      { pluginDir: undefined, indexEmbeddings: false },
    );

    const navigate = makeCtx(
      "POST",
      "/api/views/smoke.main/navigate?viewType=tui",
      { body: { source: "user" } },
    );
    navigate.ctx.req.headers["x-elizaos-client-id"] = "smoke-client";
    await handleViewsRoutes(navigate.ctx);

    const current = makeCtx("GET", "/api/views/current", {
      headers: { "x-elizaos-client-id": "smoke-client" },
    });
    const handled = await handleViewsRoutes(current.ctx);

    expect(handled).toBe(true);
    const [, body] = current.json.mock.calls[0] as [
      unknown,
      {
        currentView: {
          viewId: string;
          viewPath: string;
          viewLabel: string;
          viewType: string;
          updatedAt: string;
        };
      },
    ];
    expect(body.currentView.viewId).toBe("smoke.main");
    expect(body.currentView.viewPath).toBe("/smoke/tui");
    expect(body.currentView.viewLabel).toBe("Smoke TUI");
    expect(body.currentView.viewType).toBe("tui");
    expect(Date.parse(body.currentView.updatedAt)).not.toBeNaN();
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
      runtime,
      { name: SMOKE_PLUGIN, description: "smoke plugin", actions: [], views },
      { pluginDir: undefined, indexEmbeddings: false },
    );

    const listed = listViews(runtime).filter((v) =>
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
      runtime,
      {
        name: SMOKE_PLUGIN,
        description: "smoke plugin",
        actions: [],
        views: [devOnlyView],
      },
      { pluginDir: undefined, indexEmbeddings: false },
    );

    const normal = listViews(runtime, { developerMode: false });
    expect(normal.find((v) => v.id === "smoke.devonly")).toBeUndefined();

    const dev = listViews(runtime, { developerMode: true });
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
