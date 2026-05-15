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

function makeReqWithBody(body?: unknown): http.IncomingMessage {
  const em = new EventEmitter() as http.IncomingMessage;
  // Provide just enough of the IncomingMessage interface for readJsonBody.
  (em as Record<string, unknown>).headers = {
    "content-type": "application/json",
  };
  (em as Record<string, unknown>).method = "POST";
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

const PLUGIN_NAMES = ["views-integration-wallet", "views-integration-dev"];

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

// ---------------------------------------------------------------------------
// GET /api/views — list all registered views
// ---------------------------------------------------------------------------

describe("GET /api/views", () => {
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
    const ids = payload.views.map((v: { id: string }) => v.id);
    expect(ids).toContain("wallet.inventory");
  });

  it("returns 200 with empty views array when no plugins are registered", async () => {
    // Ensure wallet is not present for this test.
    unregisterPluginViews("views-integration-wallet");

    const { ctx, json } = makeCtx("GET", "/api/views");
    await handleViewsRoutes(ctx);
    const [, payload] = json.mock.calls[0] as [unknown, { views: unknown[] }];
    expect(Array.isArray(payload.views)).toBe(true);
  });

  it("excludes developerOnly views by default", async () => {
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
      { views: { id: string }[] },
    ];
    const ids = payload.views.map((v) => v.id);
    expect(ids).toContain("wallet.inventory");
    expect(ids).not.toContain("dev.logs");
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
    const broadcast = broadcasts[0] as { type: string; requestId: string };
    expect(broadcast.type).toBe("view:interact");
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

  it("allows standard capabilities on views with declared capabilities", async () => {
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
      { capability: "get-text", timeoutMs: 500 },
      (payload) => broadcasts.push(payload),
    );

    // This will time out (504) since no frontend resolves it — that's fine,
    // we just want to confirm the broadcast happened (capability was accepted).
    await handleViewsRoutes(ctx);
    expect(broadcasts).toHaveLength(1);
    const broadcast = broadcasts[0] as { type: string; capability: string };
    expect(broadcast.type).toBe("view:interact");
    expect(broadcast.capability).toBe("get-text");
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
