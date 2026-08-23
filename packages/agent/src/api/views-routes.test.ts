/**
 * Same-named coverage for views-routes.ts: exported parsers and WS wiring,
 * handleViewsRoutes prefix/identity/list/detail/asset/elements/broadcast
 * branches, and dispatchViewInteract success/deny/timeout/fallback. Drives the
 * real module plus the in-process view registry; no live model or HTTP server.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type http from "node:http";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentHttpRequestAuthorization } from "../runtime/host-bridge.ts";
import type { ViewRegistryEntry } from "./view-registry-types.ts";
import {
  registerBuiltinViews,
  registerPluginViews,
  unregisterPluginViews,
} from "./views-registry.ts";
import {
  type CurrentViewState,
  clearCurrentViewState,
  dispatchViewInteract,
  getCurrentViewState,
  getViewsBroadcastWs,
  getViewsBroadcastWsToClientId,
  handleViewsRoutes,
  isViewSwitchFresh,
  parseViewTypeParam,
  parseViewTypeValue,
  resolveViewInteractResult,
  setViewsBroadcastWs,
  VIEW_SWITCH_FRESH_MS,
  type ViewsRouteContext,
} from "./views-routes.ts";

const TEST_PLUGIN = "@test/views-routes-coverage";
const BUNDLE_PLUGIN = "@test/views-routes-bundle";
const PRIVATE_PLUGIN = "@test/views-routes-private";

let pluginDir = "";

function seedPluginDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "eliza-views-routes-"));
  mkdirSync(path.join(dir, "dist", "views"), { recursive: true });
  writeFileSync(
    path.join(dir, "dist", "views", "bundle.js"),
    "export default 1;\n",
  );
  writeFileSync(
    path.join(dir, "dist", "views", "chunk.css"),
    "body{color:red}\n",
  );
  writeFileSync(path.join(dir, "dist", "views", "data.json"), '{"ok":true}\n');
  writeFileSync(
    path.join(dir, "dist", "views", "picture.svg"),
    "<svg></svg>\n",
  );
  writeFileSync(
    path.join(dir, "dist", "views", "frame.html"),
    "<html><body>frame</body></html>\n",
  );
  writeFileSync(
    path.join(dir, "package.json"),
    '{"name":"@test/views-routes-bundle"}\n',
  );
  return dir;
}

function makeEntry(
  extras: {
    id?: string;
    label?: string;
    path?: string;
    capabilities?: ViewRegistryEntry["capabilities"];
    surface?: ViewRegistryEntry["surface"];
    serverInteract?: ViewRegistryEntry["serverInteract"];
    roleGate?: ViewRegistryEntry["roleGate"];
  } = {},
): ViewRegistryEntry {
  const entry: ViewRegistryEntry = {
    id: extras.id ?? "dispatch-wallet",
    label: extras.label ?? "Dispatch Wallet",
    path: extras.path ?? "/dispatch-wallet",
    viewType: "gui",
    pluginName: TEST_PLUGIN,
    hasHeroImage: false,
    available: true,
    loadedAt: 1,
    platform: "web",
  };
  if (extras.capabilities) entry.capabilities = extras.capabilities;
  if (extras.surface) entry.surface = extras.surface;
  if (extras.serverInteract) entry.serverInteract = extras.serverInteract;
  if (extras.roleGate) entry.roleGate = extras.roleGate;
  return entry;
}

function makeCtx(options: {
  method: string;
  pathname: string;
  search?: string;
  body?: Record<string, unknown> | null;
  headers?: http.IncomingHttpHeaders;
  callerAuthorization?: AgentHttpRequestAuthorization;
  developerMode?: boolean;
  noStream?: boolean;
  writeHead?: ReturnType<typeof vi.fn>;
  setHeader?: ReturnType<typeof vi.fn>;
  end?: ReturnType<typeof vi.fn>;
}): {
  ctx: ViewsRouteContext;
  json: ReturnType<typeof vi.fn>;
  error: ReturnType<typeof vi.fn>;
  broadcastWs: ReturnType<typeof vi.fn>;
  broadcastWsToClientId: ReturnType<typeof vi.fn>;
  writeHead: ReturnType<typeof vi.fn>;
  setHeader: ReturnType<typeof vi.fn>;
  end: ReturnType<typeof vi.fn>;
} {
  const json = vi.fn();
  const error = vi.fn();
  const broadcastWs = vi.fn();
  const broadcastWsToClientId = vi.fn(() => 1);
  const writeHead = options.writeHead ?? vi.fn();
  const setHeader = options.setHeader ?? vi.fn();
  const end = options.end ?? vi.fn();
  const headers = options.headers ?? {};
  let req: http.IncomingMessage;
  if (options.noStream) {
    req = { headers } as unknown as http.IncomingMessage;
  } else {
    const payload =
      options.body === undefined || options.body === null
        ? []
        : [Buffer.from(JSON.stringify(options.body))];
    req = Readable.from(payload) as unknown as http.IncomingMessage;
    req.headers = headers;
  }
  const res = {
    writeHead,
    setHeader,
    end,
  } as unknown as http.ServerResponse;
  const pathname = options.pathname;
  const ctx: ViewsRouteContext = {
    req,
    res,
    method: options.method,
    pathname,
    url: new URL(`http://local${pathname}${options.search ?? ""}`),
    json,
    error,
    broadcastWs,
    broadcastWsToClientId,
  };
  if (options.callerAuthorization) {
    ctx.callerAuthorization = options.callerAuthorization;
  }
  if (options.developerMode) {
    ctx.developerMode = true;
  }
  return {
    ctx,
    json,
    error,
    broadcastWs,
    broadcastWsToClientId,
    writeHead,
    setHeader,
    end,
  };
}

beforeEach(async () => {
  pluginDir = seedPluginDir();
  registerBuiltinViews();
  clearCurrentViewState();
  setViewsBroadcastWs(null, null);
  await registerPluginViews(
    {
      name: TEST_PLUGIN,
      description: "Synthetic views-routes coverage plugin.",
      views: [
        {
          id: "wallet",
          label: "Wallet",
          path: "/wallet",
          description: "GUI wallet.",
          tags: ["finance"],
        },
        {
          id: "tui-wallet",
          label: "Wallet Terminal",
          path: "/tui/wallet",
          viewType: "tui",
          description: "TUI wallet.",
        },
      ],
    },
    process.cwd(),
  );
  await registerPluginViews(
    {
      name: PRIVATE_PLUGIN,
      description: "Owner-gated view.",
      views: [
        {
          id: "owner-ledger",
          label: "Owner Ledger",
          path: "/owner-ledger",
          roleGate: { minRole: "OWNER" },
        },
      ],
    },
    process.cwd(),
  );
  await registerPluginViews(
    {
      name: BUNDLE_PLUGIN,
      description: "On-disk bundle/frame/asset fixture.",
      views: [
        {
          id: "bundled",
          label: "Bundled",
          path: "/bundled",
          bundlePath: "dist/views/bundle.js",
          framePath: "dist/views/frame.html",
        },
      ],
    },
    pluginDir,
  );
});

afterEach(() => {
  clearCurrentViewState();
  setViewsBroadcastWs(null, null);
  unregisterPluginViews(TEST_PLUGIN);
  unregisterPluginViews(PRIVATE_PLUGIN);
  unregisterPluginViews(BUNDLE_PLUGIN);
  rmSync(pluginDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("parseViewTypeParam / parseViewTypeValue", () => {
  it("treats omitted and empty as the historical GUI default", () => {
    expect(parseViewTypeParam(null)).toEqual({
      ok: true,
      viewType: undefined,
    });
    expect(parseViewTypeParam("")).toEqual({ ok: true, viewType: undefined });
    expect(parseViewTypeValue(undefined)).toEqual({
      ok: true,
      viewType: undefined,
    });
    expect(parseViewTypeValue(null)).toEqual({
      ok: true,
      viewType: undefined,
    });
    expect(parseViewTypeValue("")).toEqual({ ok: true, viewType: undefined });
  });

  it.each(["gui", "tui", "xr"] as const)("accepts exact %s", (token) => {
    expect(parseViewTypeParam(token)).toEqual({ ok: true, viewType: token });
    expect(parseViewTypeValue(token)).toEqual({ ok: true, viewType: token });
  });

  it.each(["GUI", "web", " discord", "tui "])(
    "rejects unknown viewType %j",
    (token) => {
      const parsed = parseViewTypeValue(token);
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) {
        expect(parsed.message).toBe("viewType must be one of: gui, tui, xr");
      }
    },
  );

  it.each([1, true, { viewType: "gui" }, ["gui"]])(
    "rejects non-string viewType %j",
    (value) => {
      const parsed = parseViewTypeValue(value);
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) {
        expect(parsed.message).toBe("viewType must be one of: gui, tui, xr");
      }
    },
  );
});

describe("views broadcast WS wiring", () => {
  it("starts unset and round-trips the process broadcasters", () => {
    expect(getViewsBroadcastWs()).toBeNull();
    expect(getViewsBroadcastWsToClientId()).toBeNull();

    const broadcast = vi.fn();
    const toClient = vi.fn(() => 1);
    setViewsBroadcastWs(broadcast, toClient);

    expect(getViewsBroadcastWs()).toBe(broadcast);
    expect(getViewsBroadcastWsToClientId()).toBe(toClient);

    setViewsBroadcastWs(broadcast);
    expect(getViewsBroadcastWs()).toBe(broadcast);
    expect(getViewsBroadcastWsToClientId()).toBeNull();

    setViewsBroadcastWs(null, null);
    expect(getViewsBroadcastWs()).toBeNull();
    expect(getViewsBroadcastWsToClientId()).toBeNull();
  });
});

describe("isViewSwitchFresh / current view state", () => {
  it("is false for null, missing switchedAt, and unparseable timestamps", () => {
    expect(isViewSwitchFresh(null)).toBe(false);
    const base: CurrentViewState = {
      viewId: "wallet",
      viewPath: "/wallet",
      viewLabel: "Wallet",
      viewType: "gui",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    expect(isViewSwitchFresh(base)).toBe(false);
    expect(isViewSwitchFresh({ ...base, switchedAt: "not-a-date" })).toBe(
      false,
    );
  });

  it("is true at the freshness window and false one millisecond past it", () => {
    const switchedAt = "2026-01-01T00:00:00.000Z";
    const t = Date.parse(switchedAt);
    const state: CurrentViewState = {
      viewId: "wallet",
      viewPath: "/wallet",
      viewLabel: "Wallet",
      viewType: "gui",
      switchedAt,
      updatedAt: switchedAt,
    };
    expect(isViewSwitchFresh(state, t)).toBe(true);
    expect(isViewSwitchFresh(state, t + VIEW_SWITCH_FRESH_MS)).toBe(true);
    expect(isViewSwitchFresh(state, t + VIEW_SWITCH_FRESH_MS + 1)).toBe(false);
  });

  it("clears process-global current view state", async () => {
    const { ctx } = makeCtx({
      method: "POST",
      pathname: "/api/views/wallet/navigate",
      body: {},
    });
    await handleViewsRoutes(ctx);
    expect(getCurrentViewState()?.viewId).toBe("wallet");
    clearCurrentViewState();
    expect(getCurrentViewState()).toBeNull();
  });
});

describe("handleViewsRoutes prefix and identity routes", () => {
  it("returns false outside /api/views", async () => {
    const { ctx, json, error } = makeCtx({
      method: "GET",
      pathname: "/api/agent/status",
    });
    await expect(handleViewsRoutes(ctx)).resolves.toBe(false);
    expect(json).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });

  it("returns false for an empty id after the prefix (double slash)", async () => {
    const { ctx } = makeCtx({
      method: "GET",
      pathname: "/api/views//hero",
    });
    await expect(handleViewsRoutes(ctx)).resolves.toBe(false);
  });

  it("returns false for an unmatched method/subresource pair", async () => {
    const { ctx, json, error } = makeCtx({
      method: "PUT",
      pathname: "/api/views/wallet/navigate",
      body: {},
    });
    await expect(handleViewsRoutes(ctx)).resolves.toBe(false);
    expect(json).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });

  it("reports web platform info with dynamic loading allowed", async () => {
    const { ctx, json, error } = makeCtx({
      method: "GET",
      pathname: "/api/views/platform-info",
    });
    await expect(handleViewsRoutes(ctx)).resolves.toBe(true);
    expect(error).not.toHaveBeenCalled();
    expect(json).toHaveBeenCalledWith(ctx.res, {
      platform: "web",
      dynamicLoadingAllowed: true,
      prebuiltOnly: false,
    });
  });

  it("reports ios from X-Eliza-Platform and forbids dynamic loading", async () => {
    const { ctx, json } = makeCtx({
      method: "GET",
      pathname: "/api/views/platform-info",
      headers: { "x-eliza-platform": "ios" },
    });
    await expect(handleViewsRoutes(ctx)).resolves.toBe(true);
    expect(json).toHaveBeenCalledWith(ctx.res, {
      platform: "ios",
      dynamicLoadingAllowed: false,
      prebuiltOnly: true,
    });
  });

  it("detects desktop from an Electrobun user-agent", async () => {
    const { ctx, json } = makeCtx({
      method: "GET",
      pathname: "/api/views/platform-info",
      headers: { "user-agent": "ElizaShell Electrobun/1.0" },
    });
    await expect(handleViewsRoutes(ctx)).resolves.toBe(true);
    expect(json.mock.calls[0][1]).toEqual(
      expect.objectContaining({
        platform: "desktop",
        dynamicLoadingAllowed: true,
      }),
    );
  });

  it("GET /api/views/current is empty before any navigate", async () => {
    const { ctx, json } = makeCtx({
      method: "GET",
      pathname: "/api/views/current",
    });
    await expect(handleViewsRoutes(ctx)).resolves.toBe(true);
    expect(json).toHaveBeenCalledWith(ctx.res, {
      currentView: null,
      justSwitched: false,
    });
  });

  it("GET /api/views lists GUI views and marks builtins", async () => {
    const { ctx, json, error } = makeCtx({
      method: "GET",
      pathname: "/api/views",
    });
    await expect(handleViewsRoutes(ctx)).resolves.toBe(true);
    expect(error).not.toHaveBeenCalled();
    const payload = json.mock.calls[0][1] as {
      views: Array<{ id: string; builtin: boolean }>;
    };
    const ids = payload.views.map((view) => view.id);
    expect(ids).toContain("wallet");
    expect(ids).not.toContain("tui-wallet");
    expect(
      payload.views.every((view) => typeof view.builtin === "boolean"),
    ).toBe(true);
    expect(
      payload.views.some(
        (view) => view.builtin === true && view.id !== "wallet",
      ),
    ).toBe(true);
  });

  it("GET /api/views/ also lists (trailing slash)", async () => {
    const { ctx, json } = makeCtx({
      method: "GET",
      pathname: "/api/views/",
    });
    await expect(handleViewsRoutes(ctx)).resolves.toBe(true);
    expect(json).toHaveBeenCalledTimes(1);
  });

  it("rejects an invalid list viewType before returning the catalog", async () => {
    const { ctx, json, error } = makeCtx({
      method: "GET",
      pathname: "/api/views",
      search: "?viewType=web",
    });
    await expect(handleViewsRoutes(ctx)).resolves.toBe(true);
    expect(error).toHaveBeenCalledWith(
      ctx.res,
      "viewType must be one of: gui, tui, xr",
      400,
    );
    expect(json).not.toHaveBeenCalled();
  });
});

describe("GET /api/views/:id", () => {
  it("400s a malformed percent-encoded view id", async () => {
    const { ctx, json, error } = makeCtx({
      method: "GET",
      pathname: "/api/views/%E0%A4%A",
    });
    await expect(handleViewsRoutes(ctx)).resolves.toBe(true);
    expect(json).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith(ctx.res, "Malformed view id", 400);
  });

  it("404s an unregistered view id", async () => {
    const { ctx, json, error } = makeCtx({
      method: "GET",
      pathname: "/api/views/does-not-exist",
    });
    await expect(handleViewsRoutes(ctx)).resolves.toBe(true);
    expect(json).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith(
      ctx.res,
      'View "does-not-exist" not found',
      404,
    );
  });

  it("returns the registered view metadata", async () => {
    const { ctx, json, error } = makeCtx({
      method: "GET",
      pathname: "/api/views/wallet",
    });
    await expect(handleViewsRoutes(ctx)).resolves.toBe(true);
    expect(error).not.toHaveBeenCalled();
    expect(json.mock.calls[0][1]).toEqual(
      expect.objectContaining({
        id: "wallet",
        label: "Wallet",
        path: "/wallet",
      }),
    );
  });

  it("403s a role-gated view for an unauthorized caller", async () => {
    const { ctx, json, error } = makeCtx({
      method: "GET",
      pathname: "/api/views/owner-ledger",
    });
    await expect(handleViewsRoutes(ctx)).resolves.toBe(true);
    expect(json).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith(
      ctx.res,
      'View "owner-ledger" is not available to this caller',
      403,
    );
  });

  it("serves a role-gated view to OWNER", async () => {
    const { ctx, json, error } = makeCtx({
      method: "GET",
      pathname: "/api/views/owner-ledger",
      callerAuthorization: { ok: true, role: "OWNER" },
    });
    await expect(handleViewsRoutes(ctx)).resolves.toBe(true);
    expect(error).not.toHaveBeenCalled();
    expect(json.mock.calls[0][1]).toEqual(
      expect.objectContaining({ id: "owner-ledger" }),
    );
  });
});

describe("GET /api/views/:id bundle, frame, and assets", () => {
  it("403s dynamic bundle loading on ios", async () => {
    const { ctx, json, error } = makeCtx({
      method: "GET",
      pathname: "/api/views/bundled/bundle.js",
      headers: { "x-eliza-platform": "ios" },
    });
    await expect(handleViewsRoutes(ctx)).resolves.toBe(true);
    expect(json).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith(
      ctx.res,
      "Dynamic view bundle loading is not permitted on this platform.",
      403,
    );
  });

  it("403s dynamic frame loading on android", async () => {
    const { ctx, error } = makeCtx({
      method: "GET",
      pathname: "/api/views/bundled/frame.html",
      headers: { "x-eliza-platform": "android" },
    });
    await expect(handleViewsRoutes(ctx)).resolves.toBe(true);
    expect(error).toHaveBeenCalledWith(
      ctx.res,
      "Dynamic view frame loading is not permitted on this platform.",
      403,
    );
  });

  it("403s dynamic asset loading on ios before filesystem work", async () => {
    const { ctx, error } = makeCtx({
      method: "GET",
      pathname: "/api/views/bundled/chunk.css",
      headers: { "x-eliza-platform": "ios" },
    });
    await expect(handleViewsRoutes(ctx)).resolves.toBe(true);
    expect(error).toHaveBeenCalledWith(
      ctx.res,
      "Dynamic view asset loading is not permitted on this platform.",
      403,
    );
  });

  it("404s a view with no bundle path configured", async () => {
    const { ctx, error } = makeCtx({
      method: "GET",
      pathname: "/api/views/wallet/bundle.js",
    });
    await expect(handleViewsRoutes(ctx)).resolves.toBe(true);
    expect(error).toHaveBeenCalledWith(
      ctx.res,
      'View "wallet" has no bundle path configured. Build the plugin bundle first.',
      404,
    );
  });

  it("404s a view with no frame path configured", async () => {
    const { ctx, error } = makeCtx({
      method: "GET",
      pathname: "/api/views/wallet/frame.html",
    });
    await expect(handleViewsRoutes(ctx)).resolves.toBe(true);
    expect(error).toHaveBeenCalledWith(
      ctx.res,
      'View "wallet" has no frame path configured. Build or declare the sandboxed frame document first.',
      404,
    );
  });

  it("serves the on-disk bundle with javascript content-type and etag", async () => {
    const { ctx, error, writeHead, end } = makeCtx({
      method: "GET",
      pathname: "/api/views/bundled/bundle.js",
    });
    await expect(handleViewsRoutes(ctx)).resolves.toBe(true);
    expect(error).not.toHaveBeenCalled();
    expect(writeHead).toHaveBeenCalledWith(
      200,
      expect.objectContaining({
        "Content-Type": "application/javascript; charset=utf-8",
        "Cache-Control": "no-cache",
      }),
    );
    const headers = writeHead.mock.calls[0][1] as Record<string, string>;
    expect(headers.ETag).toMatch(/^"[0-9a-f]{16}"$/);
    expect(headers["X-Content-Hash"]).toMatch(/^sha256-/);
    expect(end).toHaveBeenCalledWith(Buffer.from("export default 1;\n"));
  });

  it("HEAD of the bundle returns no body and no content hash", async () => {
    const { ctx, writeHead, end } = makeCtx({
      method: "HEAD",
      pathname: "/api/views/bundled/bundle.js",
    });
    await expect(handleViewsRoutes(ctx)).resolves.toBe(true);
    const headers = writeHead.mock.calls[0][1] as Record<string, string>;
    expect(headers["Content-Length"]).toBe(0);
    expect(headers["X-Content-Hash"]).toBeUndefined();
    expect(end).toHaveBeenCalledWith(undefined);
  });

  it("returns 304 when If-None-Match matches the bundle etag", async () => {
    const first = makeCtx({
      method: "GET",
      pathname: "/api/views/bundled/bundle.js",
    });
    await handleViewsRoutes(first.ctx);
    const etag = (first.writeHead.mock.calls[0][1] as Record<string, string>)
      .ETag;
    const second = makeCtx({
      method: "GET",
      pathname: "/api/views/bundled/bundle.js",
      headers: { "if-none-match": etag },
    });
    await expect(handleViewsRoutes(second.ctx)).resolves.toBe(true);
    expect(second.writeHead).toHaveBeenCalledWith(304, {});
    expect(second.end).toHaveBeenCalled();
    expect(second.error).not.toHaveBeenCalled();
  });

  it("serves the sandboxed frame document", async () => {
    const { ctx, writeHead, end } = makeCtx({
      method: "GET",
      pathname: "/api/views/bundled/frame.html",
    });
    await expect(handleViewsRoutes(ctx)).resolves.toBe(true);
    expect(writeHead).toHaveBeenCalledWith(
      200,
      expect.objectContaining({
        "Content-Type": "text/html; charset=utf-8",
        "X-Content-Type-Options": "nosniff",
      }),
    );
    expect(end).toHaveBeenCalledWith(
      Buffer.from("<html><body>frame</body></html>\n"),
    );
  });

  it("maps asset extensions to content types and 404s a missing file", async () => {
    const css = makeCtx({
      method: "GET",
      pathname: "/api/views/bundled/chunk.css",
    });
    await handleViewsRoutes(css.ctx);
    expect(css.writeHead).toHaveBeenCalledWith(
      200,
      expect.objectContaining({
        "Content-Type": "text/css; charset=utf-8",
      }),
    );

    const jsonAsset = makeCtx({
      method: "GET",
      pathname: "/api/views/bundled/data.json",
    });
    await handleViewsRoutes(jsonAsset.ctx);
    expect(jsonAsset.writeHead).toHaveBeenCalledWith(
      200,
      expect.objectContaining({
        "Content-Type": "application/json; charset=utf-8",
      }),
    );

    const svg = makeCtx({
      method: "GET",
      pathname: "/api/views/bundled/picture.svg",
    });
    await handleViewsRoutes(svg.ctx);
    expect(svg.writeHead).toHaveBeenCalledWith(
      200,
      expect.objectContaining({ "Content-Type": "image/svg+xml" }),
    );

    const missing = makeCtx({
      method: "GET",
      pathname: "/api/views/bundled/nope.wasm",
    });
    await handleViewsRoutes(missing.ctx);
    expect(missing.error).toHaveBeenCalledWith(
      missing.ctx.res,
      'View asset "nope.wasm" not found',
      404,
    );
  });

  it.each(["chunk/../bundle.js", "foo\\bar.css", "foo//bar.js", "./chunk.css"])(
    "400s a malformed asset path %j before filesystem work",
    async (asset) => {
      const { ctx, error, writeHead } = makeCtx({
        method: "GET",
        pathname: `/api/views/bundled/${asset}`,
      });
      await expect(handleViewsRoutes(ctx)).resolves.toBe(true);
      expect(error).toHaveBeenCalledWith(
        ctx.res,
        "Malformed view asset path",
        400,
      );
      expect(writeHead).not.toHaveBeenCalled();
    },
  );
});

describe("POST /api/views/events/broadcast", () => {
  it("400s when the request is not a readable JSON stream", async () => {
    const { ctx, json, error } = makeCtx({
      method: "POST",
      pathname: "/api/views/events/broadcast",
      noStream: true,
    });
    await expect(handleViewsRoutes(ctx)).resolves.toBe(true);
    expect(json).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith(
      ctx.res,
      "Missing JSON body for view event broadcast",
      400,
    );
  });

  it("400s a body that omits type", async () => {
    const { ctx, error } = makeCtx({
      method: "POST",
      pathname: "/api/views/events/broadcast",
      body: { payload: { x: 1 } },
    });
    await expect(handleViewsRoutes(ctx)).resolves.toBe(true);
    expect(error).toHaveBeenCalledWith(
      ctx.res,
      'Missing required field "type"',
      400,
    );
  });

  it("broadcasts a typed event and defaults a non-object payload to {}", async () => {
    const { ctx, json, broadcastWs } = makeCtx({
      method: "POST",
      pathname: "/api/views/events/broadcast",
      body: { type: "ping", payload: ["not-an-object"] },
    });
    await expect(handleViewsRoutes(ctx)).resolves.toBe(true);
    expect(broadcastWs).toHaveBeenCalledWith({
      type: "view:event",
      viewEventType: "ping",
      payload: {},
    });
    expect(json).toHaveBeenCalledWith(ctx.res, {
      ok: true,
      type: "ping",
      payload: {},
    });
  });

  it("forwards an object payload on the view:event frame", async () => {
    const { ctx, json, broadcastWs } = makeCtx({
      method: "POST",
      pathname: "/api/views/events/broadcast",
      body: { type: "refresh", payload: { viewId: "wallet" } },
    });
    await handleViewsRoutes(ctx);
    expect(broadcastWs).toHaveBeenCalledWith({
      type: "view:event",
      viewEventType: "refresh",
      payload: { viewId: "wallet" },
    });
    expect(json).toHaveBeenCalledWith(
      ctx.res,
      expect.objectContaining({
        ok: true,
        type: "refresh",
        payload: { viewId: "wallet" },
      }),
    );
  });
});

describe("POST /api/views/:id/elements", () => {
  it("drops malformed snapshot entries and defaults role/label", async () => {
    const { ctx } = makeCtx({
      method: "POST",
      pathname: "/api/views/wallet/navigate",
      body: {},
    });
    await handleViewsRoutes(ctx);

    const report = makeCtx({
      method: "POST",
      pathname: "/api/views/wallet/elements",
      body: {
        elements: [
          null,
          12,
          { role: "button" },
          { id: "" },
          { id: "send", label: "", focused: 1 },
          {
            id: "amount",
            role: "input",
            label: "Amount",
            value: "5",
            focused: true,
          },
        ],
      },
    });
    await expect(handleViewsRoutes(report.ctx)).resolves.toBe(true);
    expect(report.json).toHaveBeenCalledWith(report.ctx.res, {
      ok: true,
      viewId: "wallet",
      accepted: true,
      count: 2,
    });
  });

  it("returns count 0 for a non-array elements body", async () => {
    const { ctx } = makeCtx({
      method: "POST",
      pathname: "/api/views/wallet/navigate",
      body: {},
    });
    await handleViewsRoutes(ctx);
    const report = makeCtx({
      method: "POST",
      pathname: "/api/views/wallet/elements",
      body: { elements: { id: "send" } },
    });
    await handleViewsRoutes(report.ctx);
    expect(report.json).toHaveBeenCalledWith(
      report.ctx.res,
      expect.objectContaining({ accepted: true, count: 0 }),
    );
  });

  it("restores foreground state after a backend restart when the path matches", async () => {
    clearCurrentViewState();
    const report = makeCtx({
      method: "POST",
      pathname: "/api/views/wallet/elements",
      body: {
        viewPath: "/wallet?tab=send",
        elements: [{ id: "send", role: "button", label: "Send" }],
      },
    });
    await handleViewsRoutes(report.ctx);
    expect(report.json).toHaveBeenCalledWith(
      report.ctx.res,
      expect.objectContaining({ accepted: true, count: 1 }),
    );
    expect(getCurrentViewState()?.viewId).toBe("wallet");
    expect(getCurrentViewState()?.viewPath).toBe("/wallet");
  });

  it("does not restore a background view whose reported path does not match", async () => {
    clearCurrentViewState();
    const report = makeCtx({
      method: "POST",
      pathname: "/api/views/wallet/elements",
      body: {
        viewPath: "/settings",
        elements: [{ id: "send" }],
      },
    });
    await handleViewsRoutes(report.ctx);
    expect(report.json).toHaveBeenCalledWith(
      report.ctx.res,
      expect.objectContaining({ accepted: false, count: 1 }),
    );
    expect(getCurrentViewState()).toBeNull();
  });
});

describe("POST /api/views/:id/interact", () => {
  it("400s when the request is not a readable JSON stream", async () => {
    const { ctx, error } = makeCtx({
      method: "POST",
      pathname: "/api/views/wallet/interact",
      noStream: true,
    });
    await expect(handleViewsRoutes(ctx)).resolves.toBe(true);
    expect(error).toHaveBeenCalledWith(
      ctx.res,
      "Missing JSON body for view interaction",
      400,
    );
  });

  it("400s a missing capability", async () => {
    const { ctx, error, json } = makeCtx({
      method: "POST",
      pathname: "/api/views/wallet/interact",
      body: { params: { id: "x" } },
    });
    await expect(handleViewsRoutes(ctx)).resolves.toBe(true);
    expect(json).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith(
      ctx.res,
      "Missing capability in interact body",
      400,
    );
  });

  it("400s a non-string body viewType before dispatch", async () => {
    const { ctx, error, json } = makeCtx({
      method: "POST",
      pathname: "/api/views/wallet/interact",
      body: { capability: "get-state", viewType: 1 },
    });
    await expect(handleViewsRoutes(ctx)).resolves.toBe(true);
    expect(json).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith(
      ctx.res,
      "viewType must be one of: gui, tui, xr",
      400,
    );
  });

  it("prefers body viewType over the query string", async () => {
    const { ctx, error } = makeCtx({
      method: "POST",
      pathname: "/api/views/tui-wallet/interact",
      search: "?viewType=gui",
      body: { capability: "get-state", viewType: "tui" },
    });
    await expect(handleViewsRoutes(ctx)).resolves.toBe(true);
    // tui-wallet exists only in the tui catalog; a query-only lookup would 404.
    expect(error).not.toHaveBeenCalledWith(
      ctx.res,
      expect.stringContaining("not found"),
      404,
    );
  });
});

describe("dispatchViewInteract", () => {
  it("denies a caller that fails the view role gate", async () => {
    const result = await dispatchViewInteract(
      makeEntry({ roleGate: { minRole: "OWNER" } }),
      "dispatch-wallet",
      "get-state",
      undefined,
      { userRoles: ["USER"] },
    );
    expect(result.success).toBe(false);
    expect(result.error).toBe(
      'View "dispatch-wallet" is not available to this caller',
    );
  });

  it("denies a mutating standard capability without the agent-surface grant", async () => {
    const result = await dispatchViewInteract(
      makeEntry(),
      "dispatch-wallet",
      "click-element",
      { elementId: "send" },
      {},
    );
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/does not grant `agent-surface`/);
  });

  it("denies a human-only declared capability", async () => {
    const result = await dispatchViewInteract(
      makeEntry({
        capabilities: [
          {
            id: "confirm-send",
            description: "Human confirm.",
            authority: "human",
          },
        ],
      }),
      "dispatch-wallet",
      "confirm-send",
      undefined,
      {},
    );
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/requires direct human interaction/);
  });

  it("runs serverInteract and broadcasts a view-updated event", async () => {
    const serverInteract = vi.fn(async () => ({ success: true, text: "ok" }));
    const broadcastWs = vi.fn();
    const result = await dispatchViewInteract(
      makeEntry({
        surface: { capabilities: ["agent-surface"] },
        serverInteract,
      }),
      "dispatch-wallet",
      "click-element",
      { elementId: "send" },
      { broadcastWs },
    );
    expect(result.success).toBe(true);
    expect(result.result).toEqual({ success: true, text: "ok" });
    expect(serverInteract).toHaveBeenCalledTimes(1);
    expect(broadcastWs).toHaveBeenCalledWith({
      type: "view:event",
      viewEventType: "view:dispatch-wallet:updated",
      payload: { viewId: "dispatch-wallet", capability: "click-element" },
    });
  });

  it("treats a non-object serverInteract result as success", async () => {
    const result = await dispatchViewInteract(
      makeEntry({
        serverInteract: async () => "pong",
      }),
      "dispatch-wallet",
      "get-state",
      undefined,
      {},
    );
    expect(result.success).toBe(true);
    expect(result.result).toBe("pong");
  });

  it("propagates serverInteract throws without claiming success", async () => {
    const result = await dispatchViewInteract(
      makeEntry({
        serverInteract: async () => {
          throw new Error("disk full");
        },
      }),
      "dispatch-wallet",
      "get-state",
      undefined,
      {},
    );
    expect(result.success).toBe(false);
    expect(result.error).toBe("disk full");
    expect(result.result).toEqual({
      success: false,
      text: 'Cannot invoke capability "get-state" on view "dispatch-wallet": disk full.',
    });
  });

  it("stringifies a non-Error serverInteract throw", async () => {
    const result = await dispatchViewInteract(
      makeEntry({
        serverInteract: async () => {
          throw "nope";
        },
      }),
      "dispatch-wallet",
      "get-state",
      undefined,
      {},
    );
    expect(result.success).toBe(false);
    expect(result.error).toBe("nope");
  });

  it("requires a client id when there is no serverInteract handler", async () => {
    const result = await dispatchViewInteract(
      makeEntry(),
      "dispatch-wallet",
      "get-state",
      undefined,
      {},
    );
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Missing client id/);
  });

  it("requires targeted delivery when a client id is present without a sender", async () => {
    const result = await dispatchViewInteract(
      makeEntry(),
      "dispatch-wallet",
      "get-state",
      undefined,
      { clientId: "shell-1" },
    );
    expect(result.success).toBe(false);
    expect(result.error).toBe(
      "Targeted view interaction delivery is unavailable.",
    );
  });

  it("resolves a frontend round-trip through resolveViewInteractResult", async () => {
    const result = await dispatchViewInteract(
      makeEntry(),
      "dispatch-wallet",
      "get-state",
      undefined,
      {
        clientId: "shell-1",
        broadcastWsToClientId: (_clientId, payload) => {
          const frame = payload as { requestId: string };
          resolveViewInteractResult({
            requestId: frame.requestId,
            success: true,
            result: { visible: "Wallet" },
          });
          return 1;
        },
      },
    );
    expect(result.success).toBe(true);
    expect(result.result).toEqual({ visible: "Wallet" });
    expect(typeof result.requestId).toBe("string");
  });

  it("times out a frontend interact that never posts a result", async () => {
    const result = await dispatchViewInteract(
      makeEntry(),
      "dispatch-wallet",
      "get-state",
      undefined,
      {
        clientId: "shell-1",
        broadcastWsToClientId: () => 1,
      },
      25,
    );
    expect(result.success).toBe(false);
    expect(result.failureKind).toBe("timeout");
    expect(result.error).toMatch(/within 25ms/);
  });

  it("reports an unavailable client when targeted delivery sends to 0 sockets", async () => {
    const result = await dispatchViewInteract(
      makeEntry(),
      "dispatch-wallet",
      "get-state",
      undefined,
      {
        clientId: "shell-missing",
        broadcastWsToClientId: () => 0,
      },
    );
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/No connected view client "shell-missing"/);
  });

  it("falls back to serverInteract when targeted delivery throws", async () => {
    const serverInteract = vi.fn(async () => ({
      success: true,
      via: "server",
    }));
    const result = await dispatchViewInteract(
      makeEntry({
        surface: { capabilities: ["agent-surface"] },
        serverInteract,
      }),
      "dispatch-wallet",
      "click-element",
      { elementId: "send" },
      {
        clientId: "shell-1",
        broadcastWsToClientId: () => {
          throw new Error("socket down");
        },
      },
    );
    expect(result.success).toBe(true);
    expect(result.result).toEqual({ success: true, via: "server" });
    expect(serverInteract).toHaveBeenCalledTimes(1);
  });

  it("is a no-op when resolveViewInteractResult gets an unknown requestId", () => {
    expect(() =>
      resolveViewInteractResult({
        requestId: "missing-request",
        success: true,
      }),
    ).not.toThrow();
  });
});

describe("GET /api/views/search keyword-only scoring", () => {
  it("ranks an exact label above a description match and drops a miss", async () => {
    const { ctx, json, error } = makeCtx({
      method: "GET",
      pathname: "/api/views/search",
      search: "?q=Wallet",
    });
    await expect(handleViewsRoutes(ctx)).resolves.toBe(true);
    expect(error).not.toHaveBeenCalled();
    const payload = json.mock.calls[0][1] as {
      results: Array<{ id: string; _score: number }>;
      semanticEnabled: boolean;
    };
    expect(payload.semanticEnabled).toBe(false);
    expect(payload.results[0]?.id).toBe("wallet");
    expect(payload.results[0]?._score).toBe(40);
  });

  it("returns an empty result set for whitespace without scanning", async () => {
    const { ctx, json } = makeCtx({
      method: "GET",
      pathname: "/api/views/search",
      search: "?q=%20%20",
    });
    await handleViewsRoutes(ctx);
    expect(json).toHaveBeenCalledWith(ctx.res, { results: [], query: "  " });
  });
});
