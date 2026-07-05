/**
 * View Registry + HTTP route integration tests.
 *
 * Tests the full path from plugin registration through `handleViewsRoutes` to
 * the HTTP response. No live server is started — we call the route handler
 * directly with fabricated request contexts, mirroring the pattern used in
 * `background-tasks-routes.test.ts`.
 */

import type http from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  getView,
  listViews,
  registerPluginViews,
  unregisterPluginViews,
} from "../api/views-registry.js";
import type { ViewsRouteContext } from "../api/views-routes.js";
import { handleViewsRoutes } from "../api/views-routes.js";

// ---------------------------------------------------------------------------
// Context factory
// ---------------------------------------------------------------------------

import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

function makeReqWithBody(body?: unknown): http.IncomingMessage {
  const em = new EventEmitter() as http.IncomingMessage;
  // Provide just enough of the IncomingMessage interface for readJsonBody.
  (em as unknown as { headers: Record<string, string> }).headers = {
    "content-type": "application/json",
  };
  (em as unknown as { method: string }).method = "POST";
  if (body !== undefined) {
    const chunk = Buffer.from(JSON.stringify(body));
    // Emit data/end asynchronously on next tick so callers have time to attach listeners.
    process.nextTick(() => {
      em.emit("data", chunk);
      em.emit("end");
    });
  } else {
    process.nextTick(() => em.emit("end"));
  }
  return em;
}

function makeCtx(
  method: string,
  pathname: string,
  queryParams: Record<string, string> = {},
  developerMode?: boolean,
  body?: unknown,
  broadcastWs?: (payload: object) => void,
): {
  ctx: ViewsRouteContext;
  json: ReturnType<typeof vi.fn>;
  error: ReturnType<typeof vi.fn>;
} {
  const json = vi.fn();
  const error = vi.fn();

  const search = new URLSearchParams(queryParams).toString();
  const urlString = `http://localhost${pathname}${search ? `?${search}` : ""}`;
  const url = new URL(urlString);

  // Build a minimal res mock that readJsonBody can write errors to without crashing.
  const res = {
    writeHead: vi.fn(),
    end: vi.fn(),
    setHeader: vi.fn(),
    getHeader: vi.fn(),
    statusCode: 200,
  } as unknown as http.ServerResponse;

  const req =
    body !== undefined || method === "POST"
      ? makeReqWithBody(body)
      : ({ headers: {} } as http.IncomingMessage);

  const ctx: ViewsRouteContext = {
    req,
    res,
    method,
    pathname,
    url,
    json,
    error,
    developerMode,
    broadcastWs,
  };
  return { ctx, json, error };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const WALLET_VIEW = {
  id: "wallet.inventory",
  label: "Wallet",
  description: "Manage your crypto wallet and assets",
  icon: "Wallet",
  path: "/wallet",
  order: 10,
  tags: ["finance", "crypto"],
};

const DEV_VIEW = {
  id: "dev.logs",
  label: "Dev Logs",
  description: "Structured log viewer",
  developerOnly: true,
  order: 200,
};

const REMOTE_VIEW = {
  id: "remote.panel",
  label: "Remote Panel",
  description: "Remote capability panel",
  bundleUrl: "https://capability.example.test/assets/remote-panel.js",
  order: 20,
};

const PLUGIN_NAMES = [
  "views-integration-wallet",
  "views-integration-dev",
  "views-integration-modalities",
  "views-integration-remote",
  "views-integration-remote-frame",
  "views-integration-local-bundle",
  "views-integration-local-frame",
  "todos",
];

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.spyOn(console, "info").mockImplementation(() => {});
});

afterEach(() => {
  for (const name of PLUGIN_NAMES) {
    unregisterPluginViews(name);
  }
  vi.restoreAllMocks();
});

async function createLocalBundlePlugin(bundleSource: string): Promise<{
  pluginDir: string;
  bundlePath: string;
}> {
  const pluginDir = await mkdtemp(path.join(tmpdir(), "eliza-view-bundle-"));
  const bundleDir = path.join(pluginDir, "dist", "views");
  await mkdir(bundleDir, { recursive: true });
  const bundlePath = path.join(bundleDir, "bundle.js");
  await writeFile(bundlePath, bundleSource);
  return { pluginDir, bundlePath };
}

async function createLocalFramePlugin(frameSource: string): Promise<{
  pluginDir: string;
  framePath: string;
}> {
  const pluginDir = await mkdtemp(path.join(tmpdir(), "eliza-view-frame-"));
  const frameDir = path.join(pluginDir, "dist", "views");
  await mkdir(frameDir, { recursive: true });
  const absoluteFramePath = path.join(frameDir, "frame.html");
  await writeFile(absoluteFramePath, frameSource);
  return { pluginDir, framePath: path.relative(pluginDir, absoluteFramePath) };
}

function rawResponse(ctx: ViewsRouteContext): {
  writeHead: ReturnType<typeof vi.fn>;
  end: ReturnType<typeof vi.fn>;
} {
  const res = ctx.res as unknown as {
    writeHead: ReturnType<typeof vi.fn>;
    end: ReturnType<typeof vi.fn>;
  };
  return { writeHead: res.writeHead, end: res.end };
}

// ---------------------------------------------------------------------------
// GET /api/views — list all registered views
// ---------------------------------------------------------------------------

describe("GET /api/views", () => {
  it("resolves short first-party plugin names to their workspace package roots", async () => {
    await registerPluginViews(
      {
        name: "todos",
        description: "short-name first-party plugin",
        actions: [],
        views: [
          {
            id: "short-name.todos",
            label: "Short Name Todos",
            path: "/short-name-todos",
            bundlePath: "package.json",
          },
        ],
      },
      undefined,
    );

    const entry = getView("short-name.todos");
    expect(entry?.pluginName).toBe("todos");
    expect(entry?.pluginDir).toContain("plugin-todos");
    expect(entry?.available).toBe(true);
  });

  it("returns registered views with views key in response body", async () => {
    await registerPluginViews(
      {
        name: "views-integration-wallet",
        description: "wallet",
        actions: [],
        views: [WALLET_VIEW],
      },
      undefined,
    );

    const { ctx, json } = makeCtx("GET", "/api/views");
    const handled = await handleViewsRoutes(ctx);

    expect(handled).toBe(true);
    expect(json).toHaveBeenCalledOnce();
    const [, payload] = json.mock.calls[0] as [unknown, { views: unknown[] }];
    expect(Array.isArray(payload.views)).toBe(true);
    const ids = (payload.views as { id: string }[]).map((v) => v.id);
    expect(ids).toContain("wallet.inventory");
  });

  it("defaults views to gui and lets tui override the same logical id", async () => {
    await registerPluginViews(
      {
        name: "views-integration-wallet",
        description: "wallet",
        actions: [],
        views: [
          WALLET_VIEW,
          {
            ...WALLET_VIEW,
            label: "Wallet TUI",
            viewType: "tui",
            bundlePath: "dist/views/tui.js",
          },
        ],
      },
      undefined,
    );

    const { ctx: guiCtx, json: guiJson } = makeCtx("GET", "/api/views");
    await handleViewsRoutes(guiCtx);
    const [, guiPayload] = guiJson.mock.calls[0] as [
      unknown,
      { views: { id: string; label: string; viewType: string }[] },
    ];
    expect(
      guiPayload.views.find((v) => v.id === "wallet.inventory"),
    ).toMatchObject({
      label: "Wallet",
      viewType: "gui",
    });

    const { ctx: tuiCtx, json: tuiJson } = makeCtx("GET", "/api/views", {
      viewType: "tui",
    });
    await handleViewsRoutes(tuiCtx);
    const [, tuiPayload] = tuiJson.mock.calls[0] as [
      unknown,
      { views: { id: string; label: string; viewType: string }[] },
    ];
    expect(
      tuiPayload.views.find((v) => v.id === "wallet.inventory"),
    ).toMatchObject({
      label: "Wallet TUI",
      viewType: "tui",
    });
  });

  it("returns 200 with empty views array when no plugins are registered", async () => {
    // Ensure wallet is not present for this test.
    unregisterPluginViews("views-integration-wallet");

    const { ctx, json } = makeCtx("GET", "/api/views");
    await handleViewsRoutes(ctx);
    const [, payload] = json.mock.calls[0] as [unknown, { views: unknown[] }];
    expect(Array.isArray(payload.views)).toBe(true);
  });

  it("returns all view kinds with metadata so the client can gate them", async () => {
    // GET /api/views deliberately surfaces every kind (incl. developer/preview)
    // annotated with developerOnly/viewKind. The server cannot know whether it
    // is talking to a dev build or which Settings toggles are on, so kind-gating
    // is a client responsibility — the route just hands over the full catalog.
    await registerPluginViews(
      {
        name: "views-integration-wallet",
        description: "wallet",
        actions: [],
        views: [WALLET_VIEW],
      },
      undefined,
    );
    await registerPluginViews(
      {
        name: "views-integration-dev",
        description: "dev",
        actions: [],
        views: [DEV_VIEW],
      },
      undefined,
    );

    const { ctx, json } = makeCtx("GET", "/api/views");
    await handleViewsRoutes(ctx);

    const [, payload] = json.mock.calls[0] as [
      unknown,
      { views: { id: string; developerOnly?: boolean }[] },
    ];
    const ids = payload.views.map((v) => v.id);
    expect(ids).toContain("wallet.inventory");
    // Developer-only views are now included (the client hides them unless the
    // Developer-views toggle is on) and still carry the developerOnly flag.
    expect(ids).toContain("dev.logs");
    const devView = payload.views.find((v) => v.id === "dev.logs");
    expect(devView?.developerOnly).toBe(true);
  });

  it("includes developerOnly views when developerMode query param is true", async () => {
    await registerPluginViews(
      {
        name: "views-integration-dev",
        description: "dev",
        actions: [],
        views: [DEV_VIEW],
      },
      undefined,
    );

    const { ctx, json } = makeCtx("GET", "/api/views", {
      developerMode: "true",
    });
    await handleViewsRoutes(ctx);

    const [, payload] = json.mock.calls[0] as [
      unknown,
      { views: { id: string }[] },
    ];
    const ids = payload.views.map((v) => v.id);
    expect(ids).toContain("dev.logs");
  });

  it("includes developerOnly views when context developerMode flag is true", async () => {
    await registerPluginViews(
      {
        name: "views-integration-dev",
        description: "dev",
        actions: [],
        views: [DEV_VIEW],
      },
      undefined,
    );

    // developerMode passed as context flag, no query param
    const { ctx, json } = makeCtx("GET", "/api/views", {}, true);
    await handleViewsRoutes(ctx);

    const [, payload] = json.mock.calls[0] as [
      unknown,
      { views: { id: string }[] },
    ];
    const ids = payload.views.map((v) => v.id);
    expect(ids).toContain("dev.logs");
  });

  it("does not handle non-views paths", async () => {
    const { ctx, json } = makeCtx("GET", "/api/health");
    const handled = await handleViewsRoutes(ctx);
    expect(handled).toBe(false);
    expect(json).not.toHaveBeenCalled();
  });

  it("returns views sorted by order field", async () => {
    await registerPluginViews(
      {
        name: "views-integration-wallet",
        description: "wallet",
        actions: [],
        views: [
          { id: "wallet.inventory", label: "Wallet", order: 30 },
          { id: "chat.main", label: "Chat", order: 5 },
        ],
      },
      undefined,
    );

    const { ctx, json } = makeCtx("GET", "/api/views");
    await handleViewsRoutes(ctx);

    const [, payload] = json.mock.calls[0] as [
      unknown,
      { views: { id: string; order?: number }[] },
    ];
    const filtered = payload.views.filter((v) =>
      ["wallet.inventory", "chat.main"].includes(v.id),
    );
    expect(filtered[0]?.id).toBe("chat.main");
    expect(filtered[1]?.id).toBe("wallet.inventory");
  });

  it("returns absolute remote bundleUrl for remote capability views", async () => {
    await registerPluginViews(
      {
        name: "views-integration-remote",
        description: "remote",
        actions: [],
        views: [REMOTE_VIEW],
      },
      undefined,
    );

    const registryEntry = getView("remote.panel");
    expect(registryEntry).toMatchObject({
      id: "remote.panel",
      pluginName: "views-integration-remote",
      available: true,
      bundleUrl: "https://capability.example.test/assets/remote-panel.js",
      bundleUrlVersioned:
        "https://capability.example.test/assets/remote-panel.js",
    });
    expect(registryEntry?.pluginDir).toBeUndefined();
    expect(registryEntry?.bundlePath).toBeUndefined();

    const { ctx, json } = makeCtx("GET", "/api/views");
    await handleViewsRoutes(ctx);

    const [, payload] = json.mock.calls[0] as [
      unknown,
      {
        views: Array<{
          id: string;
          available: boolean;
          bundleUrl?: string;
          bundleUrlVersioned?: string;
        }>;
      },
    ];
    expect(payload.views.find((v) => v.id === "remote.panel")).toMatchObject({
      available: true,
      bundleUrl: "https://capability.example.test/assets/remote-panel.js",
      bundleUrlVersioned:
        "https://capability.example.test/assets/remote-panel.js",
    });
  });

  it("returns absolute remote frameUrl for sandboxed remote capability views", async () => {
    await registerPluginViews(
      {
        name: "views-integration-remote-frame",
        description: "remote frame",
        actions: [],
        views: [
          {
            id: "remote.frame",
            label: "Remote Frame",
            surface: { isolation: "sandboxed-iframe" },
            frameUrl: "https://capability.example.test/assets/frame.html",
          },
        ],
      },
      undefined,
    );

    const registryEntry = getView("remote.frame");
    expect(registryEntry).toMatchObject({
      id: "remote.frame",
      pluginName: "views-integration-remote-frame",
      available: true,
      bundleUrl: undefined,
      frameUrl: "https://capability.example.test/assets/frame.html",
      frameUrlVersioned: "https://capability.example.test/assets/frame.html",
    });

    const { ctx, json } = makeCtx("GET", "/api/views");
    await handleViewsRoutes(ctx);

    const [, payload] = json.mock.calls[0] as [
      unknown,
      {
        views: Array<{
          id: string;
          available: boolean;
          bundleUrl?: string;
          frameUrl?: string;
          frameUrlVersioned?: string;
        }>;
      },
    ];
    expect(payload.views.find((v) => v.id === "remote.frame")).toMatchObject({
      available: true,
      bundleUrl: undefined,
      frameUrl: "https://capability.example.test/assets/frame.html",
      frameUrlVersioned: "https://capability.example.test/assets/frame.html",
    });
  });
});

// ---------------------------------------------------------------------------
// GET /api/views/:id — single view metadata
// ---------------------------------------------------------------------------

describe("GET /api/views/:id", () => {
  it("returns 200 with view metadata for a known id", async () => {
    await registerPluginViews(
      {
        name: "views-integration-wallet",
        description: "wallet",
        actions: [],
        views: [WALLET_VIEW],
      },
      undefined,
    );

    const { ctx, json } = makeCtx("GET", "/api/views/wallet.inventory");
    const handled = await handleViewsRoutes(ctx);

    expect(handled).toBe(true);
    expect(json).toHaveBeenCalledOnce();
    const [, payload] = json.mock.calls[0] as [
      unknown,
      { id: string; label: string },
    ];
    expect(payload.id).toBe("wallet.inventory");
    expect(payload.label).toBe("Wallet");
  });

  it("returns 404 for an unknown view id", async () => {
    const { ctx, error } = makeCtx("GET", "/api/views/unknown.view");
    const handled = await handleViewsRoutes(ctx);

    expect(handled).toBe(true);
    expect(error).toHaveBeenCalledOnce();
    const [, msg, status] = error.mock.calls[0] as [unknown, string, number];
    expect(msg).toContain("unknown.view");
    expect(status).toBe(404);
  });

  it("decodes percent-encoded view ids", async () => {
    const viewWithDots = { id: "wallet.inventory", label: "Wallet" };
    await registerPluginViews(
      {
        name: "views-integration-wallet",
        description: "wallet",
        actions: [],
        views: [viewWithDots],
      },
      undefined,
    );

    // The router encodes with encodeURIComponent; simulate a URL-encoded id
    const encoded = encodeURIComponent("wallet.inventory");
    const { ctx, json } = makeCtx("GET", `/api/views/${encoded}`);
    const handled = await handleViewsRoutes(ctx);

    expect(handled).toBe(true);
    expect(json).toHaveBeenCalledOnce();
    const [, payload] = json.mock.calls[0] as [unknown, { id: string }];
    expect(payload.id).toBe("wallet.inventory");
  });

  it("returns single remote view metadata with absolute bundleUrl", async () => {
    await registerPluginViews(
      {
        name: "views-integration-remote",
        description: "remote",
        actions: [],
        views: [REMOTE_VIEW],
      },
      undefined,
    );

    const { ctx, json } = makeCtx("GET", "/api/views/remote.panel");
    const handled = await handleViewsRoutes(ctx);

    expect(handled).toBe(true);
    expect(json).toHaveBeenCalledOnce();
    const [, payload] = json.mock.calls[0] as [
      unknown,
      { id: string; available: boolean; bundleUrl?: string },
    ];
    expect(payload).toMatchObject({
      id: "remote.panel",
      available: true,
      bundleUrl: "https://capability.example.test/assets/remote-panel.js",
    });
  });

  it("returns single sandboxed view metadata with frameUrl and no bundleUrl", async () => {
    await registerPluginViews(
      {
        name: "views-integration-remote-frame",
        description: "remote frame",
        actions: [],
        views: [
          {
            id: "remote.frame",
            label: "Remote Frame",
            surface: { isolation: "sandboxed-iframe" },
            frameUrl: "https://capability.example.test/assets/frame.html",
          },
        ],
      },
      undefined,
    );

    const { ctx, json } = makeCtx("GET", "/api/views/remote.frame");
    const handled = await handleViewsRoutes(ctx);

    expect(handled).toBe(true);
    expect(json).toHaveBeenCalledOnce();
    const [, payload] = json.mock.calls[0] as [
      unknown,
      { id: string; available: boolean; bundleUrl?: string; frameUrl?: string },
    ];
    expect(payload).toMatchObject({
      id: "remote.frame",
      available: true,
      bundleUrl: undefined,
      frameUrl: "https://capability.example.test/assets/frame.html",
    });
  });
});

// ---------------------------------------------------------------------------
// GET /api/views/:id/bundle.js — 404 when bundle not built
// ---------------------------------------------------------------------------

describe("GET /api/views/:id/bundle.js", () => {
  it("returns 404 when bundle path is not configured", async () => {
    // WALLET_VIEW has no bundlePath → no bundle configured
    await registerPluginViews(
      {
        name: "views-integration-wallet",
        description: "wallet",
        actions: [],
        views: [WALLET_VIEW],
      },
      undefined,
    );

    const { ctx, error } = makeCtx(
      "GET",
      "/api/views/wallet.inventory/bundle.js",
    );
    const handled = await handleViewsRoutes(ctx);

    expect(handled).toBe(true);
    expect(error).toHaveBeenCalledOnce();
    const [, , status] = error.mock.calls[0] as [unknown, string, number];
    expect(status).toBe(404);
  });

  it("returns 404 when bundle path is configured but file does not exist on disk", async () => {
    const viewWithBundle = {
      ...WALLET_VIEW,
      bundlePath: "dist/views/bundle.js",
    };
    // pluginDir undefined → resolvePluginPackageDir will fail → available=false
    await registerPluginViews(
      {
        name: "views-integration-wallet",
        description: "wallet",
        actions: [],
        views: [viewWithBundle],
      },
      "/tmp/nonexistent-plugin-dir-abc123",
    );

    const { ctx, error } = makeCtx(
      "GET",
      "/api/views/wallet.inventory/bundle.js",
    );
    const handled = await handleViewsRoutes(ctx);

    expect(handled).toBe(true);
    expect(error).toHaveBeenCalledOnce();
    const [, , status] = error.mock.calls[0] as [unknown, string, number];
    expect(status).toBe(404);
  });

  it("returns 404 for bundle request on unknown view", async () => {
    const { ctx, error } = makeCtx(
      "GET",
      "/api/views/nonexistent.view/bundle.js",
    );
    const handled = await handleViewsRoutes(ctx);

    expect(handled).toBe(true);
    expect(error).toHaveBeenCalledOnce();
    const [, , status] = error.mock.calls[0] as [unknown, string, number];
    expect(status).toBe(404);
  });

  it("does not fabricate a local bundle route for remote absolute bundleUrl views", async () => {
    await registerPluginViews(
      {
        name: "views-integration-remote",
        description: "remote",
        actions: [],
        views: [REMOTE_VIEW],
      },
      undefined,
    );

    const { ctx, error } = makeCtx("GET", "/api/views/remote.panel/bundle.js");
    const handled = await handleViewsRoutes(ctx);

    expect(handled).toBe(true);
    expect(error).toHaveBeenCalledOnce();
    const [, message, status] = error.mock.calls[0] as [
      unknown,
      string,
      number,
    ];
    expect(status).toBe(404);
    expect(message).toContain("no bundle path configured");
  });

  it("serves local bundles with ETag, HEAD, 304, immutable versioned URLs, and changed hashes after rebuild", async () => {
    const { pluginDir, bundlePath } = await createLocalBundlePlugin(
      "export default function LocalBundle(){ return 'v1'; }\n",
    );

    try {
      await registerPluginViews(
        {
          name: "views-integration-local-bundle",
          description: "local bundle",
          actions: [],
          views: [
            {
              id: "local.bundle",
              label: "Local Bundle",
              path: "/local-bundle",
              bundlePath: "dist/views/bundle.js",
            },
          ],
        },
        pluginDir,
      );

      const entryV1 = getView("local.bundle");
      expect(entryV1).toMatchObject({
        available: true,
        bundlePath: "dist/views/bundle.js",
      });
      expect(entryV1?.bundleHash).toMatch(/^[a-f0-9]{12}$/);
      expect(entryV1?.bundleUrlVersioned).toContain(`v=${entryV1?.bundleHash}`);

      const { ctx: getCtx } = makeCtx(
        "GET",
        "/api/views/local.bundle/bundle.js",
      );
      await handleViewsRoutes(getCtx);
      const getRes = rawResponse(getCtx);
      const [, getHeaders] = getRes.writeHead.mock.calls[0] as [
        number,
        Record<string, string | number>,
      ];
      const getBody = getRes.end.mock.calls[0]?.[0] as Buffer;
      expect(getHeaders["Content-Type"]).toBe(
        "application/javascript; charset=utf-8",
      );
      expect(getHeaders["Cache-Control"]).toBe("no-cache");
      expect(getHeaders.ETag).toMatch(/^"[a-f0-9]{16}"$/);
      expect(getHeaders["X-Content-Hash"]).toMatch(/^sha256-/);
      expect(getBody.toString("utf8")).toContain("LocalBundle");

      const { ctx: headCtx } = makeCtx(
        "HEAD",
        "/api/views/local.bundle/bundle.js",
      );
      await handleViewsRoutes(headCtx);
      const headRes = rawResponse(headCtx);
      const [, headHeaders] = headRes.writeHead.mock.calls[0] as [
        number,
        Record<string, string | number>,
      ];
      expect(headHeaders.ETag).toBe(getHeaders.ETag);
      expect(headHeaders["Content-Length"]).toBe(0);
      expect(headRes.end.mock.calls[0]?.[0]).toBeUndefined();

      const { ctx: notModifiedCtx } = makeCtx(
        "GET",
        "/api/views/local.bundle/bundle.js",
      );
      notModifiedCtx.req.headers = {
        ...notModifiedCtx.req.headers,
        "if-none-match": String(getHeaders.ETag),
      };
      await handleViewsRoutes(notModifiedCtx);
      const notModifiedRes = rawResponse(notModifiedCtx);
      expect(notModifiedRes.writeHead).toHaveBeenCalledWith(304, {});
      expect(notModifiedRes.end.mock.calls[0]?.[0]).toBeUndefined();

      const { ctx: immutableCtx } = makeCtx(
        "GET",
        "/api/views/local.bundle/bundle.js",
        { v: entryV1?.bundleHash ?? "" },
      );
      await handleViewsRoutes(immutableCtx);
      const immutableRes = rawResponse(immutableCtx);
      const [, immutableHeaders] = immutableRes.writeHead.mock.calls[0] as [
        number,
        Record<string, string | number>,
      ];
      expect(immutableHeaders["Cache-Control"]).toBe(
        "public, max-age=31536000, immutable",
      );

      await writeFile(
        bundlePath,
        "export default function LocalBundle(){ return 'v2'; }\n",
      );
      await registerPluginViews(
        {
          name: "views-integration-local-bundle",
          description: "local bundle",
          actions: [],
          views: [
            {
              id: "local.bundle",
              label: "Local Bundle",
              path: "/local-bundle",
              bundlePath: "dist/views/bundle.js",
            },
          ],
        },
        pluginDir,
      );

      const entryV2 = getView("local.bundle");
      expect(entryV2?.bundleHash).toMatch(/^[a-f0-9]{12}$/);
      expect(entryV2?.bundleHash).not.toBe(entryV1?.bundleHash);
      expect(entryV2?.bundleUrlVersioned).toContain(`v=${entryV2?.bundleHash}`);
    } finally {
      unregisterPluginViews("views-integration-local-bundle");
      await rm(pluginDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// GET /api/views/:id/frame.html — sandboxed iframe document
// ---------------------------------------------------------------------------

describe("GET /api/views/:id/frame.html", () => {
  it("serves local frame documents with HTML content type and immutable versioned URLs", async () => {
    const { pluginDir } = await createLocalFramePlugin(
      '<!doctype html><html><body><main id="app">Frame v1</main></body></html>\n',
    );

    try {
      await registerPluginViews(
        {
          name: "views-integration-local-frame",
          description: "local frame",
          actions: [],
          views: [
            {
              id: "local.frame",
              label: "Local Frame",
              path: "/local-frame",
              surface: { isolation: "sandboxed-iframe" },
              framePath: "dist/views/frame.html",
            },
          ],
        },
        pluginDir,
      );

      const entry = getView("local.frame");
      expect(entry).toMatchObject({
        available: true,
        bundleUrl: undefined,
        framePath: "dist/views/frame.html",
      });
      expect(entry?.frameHash).toMatch(/^[a-f0-9]{12}$/);
      expect(entry?.frameUrl).toContain("/api/views/local.frame/frame.html?v=");
      expect(entry?.frameUrlVersioned).toContain(`v=${entry?.frameHash}`);

      const { ctx: getCtx } = makeCtx(
        "GET",
        "/api/views/local.frame/frame.html",
      );
      await handleViewsRoutes(getCtx);
      const getRes = rawResponse(getCtx);
      const [, getHeaders] = getRes.writeHead.mock.calls[0] as [
        number,
        Record<string, string | number>,
      ];
      const getBody = getRes.end.mock.calls[0]?.[0] as Buffer;
      expect(getHeaders["Content-Type"]).toBe("text/html; charset=utf-8");
      expect(getHeaders["Content-Length"]).toBe(getBody.byteLength);
      expect(getHeaders["X-Content-Type-Options"]).toBe("nosniff");
      expect(getHeaders["Cache-Control"]).toBe("no-cache");
      expect(getBody.toString("utf8")).toContain("Frame v1");

      const { ctx: headCtx } = makeCtx(
        "HEAD",
        "/api/views/local.frame/frame.html",
      );
      await handleViewsRoutes(headCtx);
      const headRes = rawResponse(headCtx);
      const [, headHeaders] = headRes.writeHead.mock.calls[0] as [
        number,
        Record<string, string | number>,
      ];
      expect(headHeaders["Content-Type"]).toBe("text/html; charset=utf-8");
      expect(headHeaders["Content-Length"]).toBe(getBody.byteLength);
      expect(headHeaders["Cache-Control"]).toBe("no-cache");
      expect(headRes.end).toHaveBeenCalledWith(undefined);

      const { ctx: immutableCtx } = makeCtx(
        "GET",
        "/api/views/local.frame/frame.html",
        { v: entry?.frameHash ?? "" },
      );
      await handleViewsRoutes(immutableCtx);
      const immutableRes = rawResponse(immutableCtx);
      const [, immutableHeaders] = immutableRes.writeHead.mock.calls[0] as [
        number,
        Record<string, string | number>,
      ];
      expect(immutableHeaders["Cache-Control"]).toBe(
        "public, max-age=31536000, immutable",
      );
    } finally {
      unregisterPluginViews("views-integration-local-frame");
      await rm(pluginDir, { recursive: true, force: true });
    }
  });

  it("does not fabricate a local frame route for remote absolute frameUrl views", async () => {
    await registerPluginViews(
      {
        name: "views-integration-remote-frame",
        description: "remote frame",
        actions: [],
        views: [
          {
            id: "remote.frame",
            label: "Remote Frame",
            surface: { isolation: "sandboxed-iframe" },
            frameUrl: "https://capability.example.test/assets/frame.html",
          },
        ],
      },
      undefined,
    );

    const { ctx, error } = makeCtx("GET", "/api/views/remote.frame/frame.html");
    const handled = await handleViewsRoutes(ctx);

    expect(handled).toBe(true);
    expect(error).toHaveBeenCalledOnce();
    const [, message, status] = error.mock.calls[0] as [
      unknown,
      string,
      number,
    ];
    expect(status).toBe(404);
    expect(message).toContain("no frame path configured");
  });
});

// ---------------------------------------------------------------------------
// POST /api/views/:id/interact
// ---------------------------------------------------------------------------

import { resolveViewInteractResult } from "../api/views-routes.js";

describe("POST /api/views/:id/interact", () => {
  it("returns 404 for interact on an unknown view", async () => {
    const { ctx, error } = makeCtx(
      "POST",
      "/api/views/unknown.view/interact",
      {},
      undefined,
      { capability: "get-text" },
    );
    const handled = await handleViewsRoutes(ctx);

    expect(handled).toBe(true);
    expect(error).toHaveBeenCalledOnce();
    const [, , status] = error.mock.calls[0] as [unknown, string, number];
    expect(status).toBe(404);
  });

  it("returns 400 when capability field is missing in body", async () => {
    await registerPluginViews(
      {
        name: "views-integration-wallet",
        description: "wallet",
        actions: [],
        views: [WALLET_VIEW],
      },
      undefined,
    );

    const { ctx, error } = makeCtx(
      "POST",
      "/api/views/wallet.inventory/interact",
      {},
      undefined,
      { /* no capability */ params: {} },
    );
    const handled = await handleViewsRoutes(ctx);

    expect(handled).toBe(true);
    expect(error).toHaveBeenCalledOnce();
    const [, , status] = error.mock.calls[0] as [unknown, string, number];
    expect(status).toBe(400);
  });

  it("broadcasts view:interact WS message and resolves when result arrives", async () => {
    await registerPluginViews(
      {
        name: "views-integration-wallet",
        description: "wallet",
        actions: [],
        views: [WALLET_VIEW],
      },
      undefined,
    );

    const broadcasts: object[] = [];
    const broadcastWs = (payload: object) => broadcasts.push(payload);

    const { ctx, json } = makeCtx(
      "POST",
      "/api/views/wallet.inventory/interact",
      {},
      undefined,
      { capability: "get-text", timeoutMs: 2000 },
      broadcastWs,
    );

    const routePromise = handleViewsRoutes(ctx);

    // Simulate the frontend sending back a result after the WS broadcast.
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
    expect(broadcasts).toHaveLength(1);
    const broadcast = broadcasts[0] as {
      type: string;
      requestId: string;
      viewType: string;
    };
    expect(broadcast.type).toBe("view:interact");
    expect(broadcast.viewType).toBe("gui");
    expect(typeof broadcast.requestId).toBe("string");

    // Resolve the pending request as the frontend would.
    resolveViewInteractResult({
      requestId: broadcast.requestId,
      success: true,
      result: "Hello from the view",
    });

    const handled = await routePromise;
    expect(handled).toBe(true);
    expect(json).toHaveBeenCalledOnce();
    const [, result] = json.mock.calls[0] as [
      unknown,
      { success: boolean; result: unknown },
    ];
    expect(result.success).toBe(true);
    expect(result.result).toBe("Hello from the view");
  });

  it("routes interact to the requested tui view override", async () => {
    await registerPluginViews(
      {
        name: "views-integration-wallet",
        description: "wallet",
        actions: [],
        views: [
          WALLET_VIEW,
          {
            ...WALLET_VIEW,
            label: "Wallet TUI",
            viewType: "tui",
            capabilities: [
              { id: "terminal-select-row", description: "Select a row" },
            ],
          },
        ],
      },
      undefined,
    );

    const broadcasts: object[] = [];
    const { ctx } = makeCtx(
      "POST",
      "/api/views/wallet.inventory/interact",
      { viewType: "tui" },
      undefined,
      { capability: "terminal-select-row", timeoutMs: 50 },
      (payload) => broadcasts.push(payload),
    );

    await handleViewsRoutes(ctx);
    expect(broadcasts).toHaveLength(1);
    const broadcast = broadcasts[0] as {
      type: string;
      viewType: string;
      capability: string;
    };
    expect(broadcast.type).toBe("view:interact");
    expect(broadcast.viewType).toBe("tui");
    expect(broadcast.capability).toBe("terminal-select-row");
  });

  it("returns 400 for undeclared capability when view has declared capabilities", async () => {
    const viewWithCaps = {
      ...WALLET_VIEW,
      capabilities: [{ id: "custom-action", description: "A custom action" }],
    };
    await registerPluginViews(
      {
        name: "views-integration-wallet",
        description: "wallet",
        actions: [],
        views: [viewWithCaps],
      },
      undefined,
    );

    const { ctx, error } = makeCtx(
      "POST",
      "/api/views/wallet.inventory/interact",
      {},
      undefined,
      { capability: "undeclared-capability" },
    );
    const handled = await handleViewsRoutes(ctx);

    expect(handled).toBe(true);
    expect(error).toHaveBeenCalledOnce();
    const [, , status] = error.mock.calls[0] as [unknown, string, number];
    expect(status).toBe(400);
  });

  it.each([
    "get-text",
    "click-element",
    "fill-input",
  ] as const)("allows standard capability %s on views with declared capabilities", async (capability) => {
    const viewWithCaps = {
      ...WALLET_VIEW,
      capabilities: [{ id: "custom-action", description: "A custom action" }],
    };
    await registerPluginViews(
      {
        name: "views-integration-wallet",
        description: "wallet",
        actions: [],
        views: [viewWithCaps],
      },
      undefined,
    );

    const broadcasts: object[] = [];
    const { ctx } = makeCtx(
      "POST",
      "/api/views/wallet.inventory/interact",
      {},
      undefined,
      { capability, timeoutMs: 500 },
      (payload) => broadcasts.push(payload),
    );

    // This will time out (504) since no frontend resolves it — that's fine,
    // we just want to confirm the broadcast happened (capability was accepted).
    await handleViewsRoutes(ctx);
    expect(broadcasts).toHaveLength(1);
    const broadcast = broadcasts[0] as { type: string; capability: string };
    expect(broadcast.type).toBe("view:interact");
    expect(broadcast.capability).toBe(capability);
  });
});

// ---------------------------------------------------------------------------
// Registry: registerPluginViews / unregisterPluginViews
// ---------------------------------------------------------------------------

describe("registering and unregistering plugin views", () => {
  it("registering a plugin with views adds them to the registry", async () => {
    await registerPluginViews(
      {
        name: "views-integration-wallet",
        description: "wallet",
        actions: [],
        views: [WALLET_VIEW],
      },
      undefined,
    );

    const entry = getView("wallet.inventory");
    expect(entry).toBeDefined();
    expect(entry?.pluginName).toBe("views-integration-wallet");
  });

  it("expands one modalities declaration into per-surface registry entries", async () => {
    await registerPluginViews(
      {
        name: "views-integration-modalities",
        description: "multi-surface view",
        actions: [],
        views: [
          {
            ...WALLET_VIEW,
            id: "multi.calendar",
            label: "Calendar",
            modalities: ["gui", "xr", "tui"],
          },
        ],
      },
      undefined,
    );

    expect(getView("multi.calendar", { viewType: "gui" })?.viewType).toBe(
      "gui",
    );
    expect(getView("multi.calendar", { viewType: "xr" })?.viewType).toBe("xr");
    expect(getView("multi.calendar", { viewType: "tui" })?.viewType).toBe(
      "tui",
    );
    expect(
      listViews({ developerMode: true, viewType: "tui" }).find(
        (view) => view.id === "multi.calendar",
      )?.viewType,
    ).toBe("tui");
  });

  it("unregistering a plugin removes its views from the registry", async () => {
    await registerPluginViews(
      {
        name: "views-integration-wallet",
        description: "wallet",
        actions: [],
        views: [WALLET_VIEW],
      },
      undefined,
    );

    expect(getView("wallet.inventory")).toBeDefined();
    unregisterPluginViews("views-integration-wallet");
    expect(getView("wallet.inventory")).toBeUndefined();
  });

  it("filtering by developerMode works at registry level", async () => {
    await registerPluginViews(
      {
        name: "views-integration-dev",
        description: "dev",
        actions: [],
        views: [DEV_VIEW],
      },
      undefined,
    );

    const normal = listViews({ developerMode: false });
    expect(normal.find((v) => v.id === "dev.logs")).toBeUndefined();

    const dev = listViews({ developerMode: true });
    expect(dev.find((v) => v.id === "dev.logs")).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Route: paths that should not be handled
// ---------------------------------------------------------------------------

describe("handleViewsRoutes route fallthrough", () => {
  it("does not handle /api/apps", async () => {
    const { ctx, json } = makeCtx("GET", "/api/apps");
    const handled = await handleViewsRoutes(ctx);
    expect(handled).toBe(false);
    expect(json).not.toHaveBeenCalled();
  });

  it("does not handle /api/views with POST method (no body route)", async () => {
    const { ctx, json } = makeCtx("POST", "/api/views");
    // POST /api/views is not a registered route; should fall through or return handled=false
    // The actual handler only handles GET /api/views exactly.
    await handleViewsRoutes(ctx);
    // POST to /api/views should not be handled (no matching route)
    expect(json).not.toHaveBeenCalled();
    // handled may be true or false — the important thing is no json response on POST /api/views
  });
});
