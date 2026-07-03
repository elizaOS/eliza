import type http from "node:http";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { viewActionAffinityMap } from "../runtime/view-action-affinity.ts";
import {
  registerBuiltinViews,
  registerPluginViews,
  unregisterPluginViews,
} from "./views-registry.ts";
import {
  clearCurrentViewState,
  handleViewsRoutes,
  type ViewsRouteContext,
} from "./views-routes.ts";

// Per-view interact e2e (#8798 acceptance criterion 6 + 7).
//
// Proves the agent reaches a view's capabilities through the interact *path*
// (POST /api/views/:id/interact → capability validation → serverInteract
// dispatch) without a mounted UI — i.e. headlessly, over the route the agent
// actually drives. No browser, no WebSocket frontend, no real loopback server.
//
// Three claims:
//   (a) the `serverInteract` extension point dispatches end-to-end and returns
//       a real result for the views-manager reference capabilities
//       (terminal-list-views / terminal-open-view) — proves serverInteract is a
//       live path, #8798 C7;
//   (b) capability validation against the declared list rejects an undeclared
//       capability and accepts/dispatches a declared one;
//   (c) every view id with action affinity maps to a non-empty action list, so
//       an affinity-mapped view always has at least one reachable domain action.

const REFERENCE_PLUGIN = "@test/views-manager-reference";
const DECLARED_PLUGIN = "@test/views-declared-caps";

/**
 * A deterministic, self-contained stand-in for the plugin-app-control
 * `views-manager` TUI view's `serverInteract` (plugins/plugin-app-control,
 * ~L234). The real impl calls back over loopback HTTP via `createViewsClient`;
 * here we resolve the same capability contract (terminal-list-views /
 * terminal-open-view) purely in-process so the interact round-trip is
 * deterministic and browser-free while exercising the identical dispatch path.
 */
const REFERENCE_VIEWS = [
  { id: "wallet", label: "Wallet" },
  { id: "settings", label: "Settings" },
];
let lastOpenedViewId: string | null = null;

async function referenceServerInteract(
  capability: string,
  params?: Record<string, unknown>,
): Promise<unknown> {
  if (capability === "terminal-list-views") {
    return { views: REFERENCE_VIEWS };
  }
  if (capability === "terminal-open-view") {
    const viewId =
      params && typeof params.viewId === "string" ? params.viewId : undefined;
    if (!viewId) {
      return { success: false, error: "viewId is required" };
    }
    lastOpenedViewId = viewId;
    return { success: true, viewId };
  }
  return { success: false, error: `unknown capability: ${capability}` };
}

function makeCtx(
  method: "POST",
  pathname: string,
  body: Record<string, unknown> | null,
): {
  ctx: ViewsRouteContext;
  json: ReturnType<typeof vi.fn>;
  error: ReturnType<typeof vi.fn>;
  broadcastWs: ReturnType<typeof vi.fn>;
} {
  const req = Readable.from(
    body === null ? [] : [Buffer.from(JSON.stringify(body))],
  ) as unknown as http.IncomingMessage;
  const res = {} as http.ServerResponse;
  const json = vi.fn();
  const error = vi.fn();
  const broadcastWs = vi.fn();
  const ctx: ViewsRouteContext = {
    req,
    res,
    method,
    pathname,
    url: new URL(`http://local${pathname}`),
    json,
    error,
    broadcastWs,
  };
  return { ctx, json, error, broadcastWs };
}

describe("per-view interact e2e — serverInteract reaches view capabilities headlessly (#8798)", () => {
  beforeEach(async () => {
    registerBuiltinViews();
    clearCurrentViewState();
    lastOpenedViewId = null;

    // (a) reference view: capabilities + a headless serverInteract, mirroring
    // the plugin-app-control views-manager TUI declaration.
    await registerPluginViews(
      {
        name: REFERENCE_PLUGIN,
        description: "Synthetic views-manager reference for interact e2e.",
        views: [
          {
            id: "views-manager-ref",
            label: "Views Manager (ref)",
            path: "/views/tui",
            capabilities: [
              {
                id: "terminal-list-views",
                description: "Return the view list as structured data.",
              },
              {
                id: "terminal-open-view",
                description: "Open a listed view by id.",
                params: {
                  viewId: {
                    type: "string",
                    description: "Stable id of the view to open.",
                    required: true,
                  },
                },
              },
            ],
            serverInteract: referenceServerInteract,
          },
        ],
      },
      process.cwd(),
    );

    // (b) a view that declares capabilities AND has a serverInteract, so a
    // declared capability dispatches and an undeclared one is rejected before
    // dispatch.
    await registerPluginViews(
      {
        name: DECLARED_PLUGIN,
        description: "Synthetic view with a declared-capability allowlist.",
        views: [
          {
            id: "declared-caps",
            label: "Declared Caps",
            path: "/declared-caps",
            capabilities: [
              { id: "do-thing", description: "The one declared capability." },
            ],
            serverInteract: async (capability) => ({
              success: true,
              text: `ran ${capability}`,
              capability,
            }),
          },
        ],
      },
      process.cwd(),
    );
  });

  afterEach(() => {
    clearCurrentViewState();
    unregisterPluginViews(REFERENCE_PLUGIN);
    unregisterPluginViews(DECLARED_PLUGIN);
    vi.restoreAllMocks();
  });

  it("dispatches terminal-list-views through serverInteract and returns the view list", async () => {
    const { ctx, json, error } = makeCtx(
      "POST",
      "/api/views/views-manager-ref/interact",
      { capability: "terminal-list-views" },
    );

    await expect(handleViewsRoutes(ctx)).resolves.toBe(true);
    expect(error).not.toHaveBeenCalled();
    expect(json).toHaveBeenCalledTimes(1);

    const payload = json.mock.calls[0][1] as {
      requestId: string;
      success: boolean;
      result: { views: Array<{ id: string; label: string }> };
    };
    expect(typeof payload.requestId).toBe("string");
    expect(payload.success).toBe(true);
    // The dispatched result is the reference view list — proves the round-trip
    // returned real serverInteract output, not just "did not throw".
    expect(payload.result.views).toEqual(REFERENCE_VIEWS);
  });

  it("dispatches terminal-open-view with params and mutates server-side state", async () => {
    const { ctx, json, error } = makeCtx(
      "POST",
      "/api/views/views-manager-ref/interact",
      { capability: "terminal-open-view", params: { viewId: "wallet" } },
    );

    await expect(handleViewsRoutes(ctx)).resolves.toBe(true);
    expect(error).not.toHaveBeenCalled();

    const payload = json.mock.calls[0][1] as {
      success: boolean;
      result: { success: boolean; viewId: string };
    };
    expect(payload.success).toBe(true);
    expect(payload.result).toEqual({ success: true, viewId: "wallet" });
    // The capability actually ran server-side: it recorded which view it opened.
    expect(lastOpenedViewId).toBe("wallet");
  });

  it("propagates a capability-level failure result (params validation inside serverInteract)", async () => {
    // terminal-open-view is declared, so it passes the route allowlist, but the
    // handler rejects the missing viewId — the route reports success=false with
    // the handler's error, proving the result (not the validation) shaped it.
    const { ctx, json, error } = makeCtx(
      "POST",
      "/api/views/views-manager-ref/interact",
      { capability: "terminal-open-view" },
    );

    await expect(handleViewsRoutes(ctx)).resolves.toBe(true);
    expect(error).not.toHaveBeenCalled();

    const payload = json.mock.calls[0][1] as {
      success: boolean;
      result: { success: boolean; error: string };
    };
    // resultSuccess() reads result.success === false from the handler output.
    expect(payload.success).toBe(false);
    expect(payload.result).toEqual({
      success: false,
      error: "viewId is required",
    });
  });

  it("rejects an undeclared capability before dispatch (400, never reaches serverInteract)", async () => {
    const { ctx, json, error } = makeCtx(
      "POST",
      "/api/views/declared-caps/interact",
      { capability: "not-a-real-capability" },
    );

    await expect(handleViewsRoutes(ctx)).resolves.toBe(true);
    // Validation rejects before any dispatch — json (the success path) is not
    // called, and the error carries the view id + capability name.
    expect(json).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledWith(
      ctx.res,
      'Capability "not-a-real-capability" is not declared for view "declared-caps"',
      400,
    );
  });

  it("accepts and dispatches the declared capability on the same view", async () => {
    const { ctx, json, error } = makeCtx(
      "POST",
      "/api/views/declared-caps/interact",
      { capability: "do-thing" },
    );

    await expect(handleViewsRoutes(ctx)).resolves.toBe(true);
    expect(error).not.toHaveBeenCalled();

    const payload = json.mock.calls[0][1] as {
      success: boolean;
      result: { success: boolean; text: string; capability: string };
    };
    expect(payload.success).toBe(true);
    expect(payload.result).toEqual({
      success: true,
      text: "ran do-thing",
      capability: "do-thing",
    });
  });

  it("accepts a standard capability even when the view declares its own allowlist", async () => {
    // get-state is a STANDARD capability accepted on any view, so it bypasses
    // the declared-allowlist gate and dispatches through serverInteract.
    const { ctx, json, error } = makeCtx(
      "POST",
      "/api/views/declared-caps/interact",
      { capability: "get-state" },
    );

    await expect(handleViewsRoutes(ctx)).resolves.toBe(true);
    expect(error).not.toHaveBeenCalled();

    const payload = json.mock.calls[0][1] as {
      success: boolean;
      result: { capability: string };
    };
    expect(payload.success).toBe(true);
    expect(payload.result.capability).toBe("get-state");
  });

  it("404s an interact against an unregistered view id", async () => {
    const { ctx, json, error } = makeCtx(
      "POST",
      "/api/views/no-such-view/interact",
      { capability: "get-state" },
    );

    await expect(handleViewsRoutes(ctx)).resolves.toBe(true);
    expect(json).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith(
      ctx.res,
      'View "no-such-view" not found',
      404,
    );
  });
});

describe("view action affinity completeness (#8798)", () => {
  it("maps every affinity view id to a non-empty, reachable action list", () => {
    registerBuiltinViews();
    const entries = Object.entries(viewActionAffinityMap());
    // Guard against an empty map silently passing the per-view assertions.
    expect(entries.length).toBeGreaterThan(0);

    for (const [viewId, actions] of entries) {
      expect(viewId, `view id "${viewId}" must be non-empty`).not.toBe("");
      expect(
        Array.isArray(actions),
        `view action affinity for "${viewId}" must be an array`,
      ).toBe(true);
      expect(
        actions.length,
        `view action affinity for "${viewId}" must list at least one action`,
      ).toBeGreaterThan(0);
      for (const action of actions) {
        expect(
          typeof action === "string" && action.trim().length > 0,
          `view action affinity for "${viewId}" action names must be non-empty strings`,
        ).toBe(true);
      }
    }
  });
});
