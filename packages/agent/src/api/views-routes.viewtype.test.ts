/**
 * GET /api/views and GET /api/views/search `viewType` identity.
 *
 * Unknown tokens used to fall through to the GUI default catalog, so
 * `viewType=GUI` / `viewType=web` silently served GUI views. Omitted/empty
 * still means GUI. Exact `gui` / `tui` / `xr` still select that modality.
 */
import type http from "node:http";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  registerBuiltinViews,
  registerPluginViews,
  unregisterPluginViews,
} from "./views-registry.ts";
import {
  clearCurrentViewState,
  handleViewsRoutes,
  parseViewTypeParam,
  type ViewsRouteContext,
} from "./views-routes.ts";

const TEST_PLUGIN = "@test/views-viewtype";

function makeCtx(
  pathname: string,
  search: string,
): {
  ctx: ViewsRouteContext;
  json: ReturnType<typeof vi.fn>;
  error: ReturnType<typeof vi.fn>;
} {
  const req = Object.assign(Readable.from([]), {
    headers: {},
  }) as unknown as http.IncomingMessage;
  const res = {} as http.ServerResponse;
  const json = vi.fn();
  const error = vi.fn();
  const ctx: ViewsRouteContext = {
    req,
    res,
    method: "GET",
    pathname,
    url: new URL(`http://local${pathname}${search}`),
    json,
    error,
    broadcastWs: vi.fn(),
  };
  return { ctx, json, error };
}

describe("parseViewTypeParam", () => {
  it("keeps omitted and empty as the historical GUI default", () => {
    expect(parseViewTypeParam(null)).toEqual({ ok: true, viewType: undefined });
    expect(parseViewTypeParam("")).toEqual({ ok: true, viewType: undefined });
  });

  it.each(["gui", "tui", "xr"] as const)("accepts exact %s", (token) => {
    expect(parseViewTypeParam(token)).toEqual({ ok: true, viewType: token });
  });

  it.each(["GUI", "TUI", "XR", "web", "discord", " gui", "tui "])(
    "rejects unknown viewType %j",
    (token) => {
      const parsed = parseViewTypeParam(token);
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) {
        expect(parsed.message).toBe("viewType must be one of: gui, tui, xr");
      }
    },
  );
});

describe("GET /api/views viewType identity", () => {
  beforeEach(async () => {
    registerBuiltinViews();
    clearCurrentViewState();
    await registerPluginViews(
      {
        name: TEST_PLUGIN,
        description: "Synthetic viewType identity plugin.",
        views: [
          {
            id: "wallet",
            label: "Wallet",
            path: "/wallet",
            description: "GUI wallet.",
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
  });

  afterEach(() => {
    clearCurrentViewState();
    unregisterPluginViews(TEST_PLUGIN);
    vi.restoreAllMocks();
  });

  it("omitted viewType still serves the GUI catalog", async () => {
    const { ctx, json, error } = makeCtx("/api/views", "");
    await expect(handleViewsRoutes(ctx)).resolves.toBe(true);
    expect(error).not.toHaveBeenCalled();
    const views = (json.mock.calls[0][1] as { views: { id: string }[] }).views;
    const ids = views.map((view) => view.id);
    expect(ids).toContain("wallet");
    expect(ids).not.toContain("tui-wallet");
  });

  it("viewType=tui selects the TUI catalog", async () => {
    const { ctx, json, error } = makeCtx("/api/views", "?viewType=tui");
    await expect(handleViewsRoutes(ctx)).resolves.toBe(true);
    expect(error).not.toHaveBeenCalled();
    const views = (json.mock.calls[0][1] as { views: { id: string }[] }).views;
    expect(views.some((view) => view.id === "tui-wallet")).toBe(true);
  });

  it.each(["GUI", "web", "discord"])(
    "rejects viewType=%s with 400 before listing the GUI catalog",
    async (token) => {
      const { ctx, json, error } = makeCtx("/api/views", `?viewType=${token}`);
      await expect(handleViewsRoutes(ctx)).resolves.toBe(true);
      expect(error).toHaveBeenCalledWith(
        expect.anything(),
        "viewType must be one of: gui, tui, xr",
        400,
      );
      expect(json).not.toHaveBeenCalled();
    },
  );

  it("rejects viewType=GUI on search before scoring", async () => {
    const { ctx, json, error } = makeCtx(
      "/api/views/search",
      "?q=wallet&viewType=GUI",
    );
    await expect(handleViewsRoutes(ctx)).resolves.toBe(true);
    expect(error).toHaveBeenCalledWith(
      expect.anything(),
      "viewType must be one of: gui, tui, xr",
      400,
    );
    expect(json).not.toHaveBeenCalled();
  });
});
