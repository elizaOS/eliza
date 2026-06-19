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
  getCurrentViewState,
  handleViewsRoutes,
  type ViewsRouteContext,
} from "./views-routes.ts";

// Server half of the agent view-switch contract. When the VIEWS action (or any
// caller) hits POST /api/views/:id/navigate, the route must broadcast a
// `shell:navigate:view` WebSocket frame. The frontend half — that this exact
// frame normalizes into an `eliza:navigate:view` DOM event — is covered by
// packages/ui/src/state/startup-phase-hydrate.navigate-frame.test.ts. Together
// they pin the wire contract end to end without the scenario harness.
//
// This is a focused route unit test: real request body parsing, no PGLite, no
// runtime, no LLM. The agent-turn → action → navigate path (real AgentRuntime)
// is exercised by packages/scenario-runner/test/scenarios/
// deterministic-view-switching.scenario.ts.

type NavigateBody = Record<string, unknown>;

function makeNavigateCtx(
  id: string,
  body: NavigateBody | null,
  search = "",
): {
  ctx: ViewsRouteContext;
  json: ReturnType<typeof vi.fn>;
  error: ReturnType<typeof vi.fn>;
  broadcastWs: ReturnType<typeof vi.fn>;
} {
  // `readJsonBody` reads the request as a Node stream; Readable.from yields the
  // JSON exactly as an inbound HTTP request body would.
  const req = Readable.from(
    body === null ? [] : [Buffer.from(JSON.stringify(body))],
  ) as unknown as http.IncomingMessage;
  const res = {} as http.ServerResponse;
  const json = vi.fn();
  const error = vi.fn();
  const broadcastWs = vi.fn();
  const pathname = `/api/views/${encodeURIComponent(id)}/navigate`;
  const ctx: ViewsRouteContext = {
    req,
    res,
    method: "POST",
    pathname,
    url: new URL(`http://local${pathname}${search}`),
    json,
    error,
    broadcastWs,
  };
  return { ctx, json, error, broadcastWs };
}

function makeInteractCtx(
  id: string,
  body: NavigateBody | null,
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
  const pathname = `/api/views/${encodeURIComponent(id)}/interact`;
  const ctx: ViewsRouteContext = {
    req,
    res,
    method: "POST",
    pathname,
    url: new URL(`http://local${pathname}`),
    json,
    error,
    broadcastWs,
  };
  return { ctx, json, error, broadcastWs };
}

describe("POST /api/views/:id/navigate broadcast contract", () => {
  beforeEach(() => {
    registerBuiltinViews();
    clearCurrentViewState();
  });

  afterEach(() => {
    clearCurrentViewState();
    unregisterPluginViews("@test/views-route");
    vi.restoreAllMocks();
  });

  it("broadcasts a registered view's resolved frame and echoes it in the response", async () => {
    const { ctx, json, broadcastWs } = makeNavigateCtx("settings", {});

    await expect(handleViewsRoutes(ctx)).resolves.toBe(true);

    // Resolved from the builtin registry (id "settings" → /settings, "Settings").
    expect(broadcastWs).toHaveBeenCalledTimes(1);
    expect(broadcastWs).toHaveBeenCalledWith({
      type: "shell:navigate:view",
      viewId: "settings",
      viewPath: "/settings",
      viewLabel: "Settings",
      viewType: "gui",
    });
    // No action / alwaysOnTop keys when the body omits them.
    const frame = broadcastWs.mock.calls[0][0] as Record<string, unknown>;
    expect("action" in frame).toBe(false);
    expect("alwaysOnTop" in frame).toBe(false);

    expect(json).toHaveBeenCalledWith(
      ctx.res,
      expect.objectContaining({
        ok: true,
        viewId: "settings",
        viewPath: "/settings",
        viewType: "gui",
      }),
    );
  });

  it("includes action and alwaysOnTop in the frame only when present in the body", async () => {
    const { ctx, broadcastWs } = makeNavigateCtx("settings", {
      action: "pin-tab",
      alwaysOnTop: true,
    });

    await expect(handleViewsRoutes(ctx)).resolves.toBe(true);

    expect(broadcastWs).toHaveBeenCalledWith({
      type: "shell:navigate:view",
      viewId: "settings",
      viewPath: "/settings",
      viewLabel: "Settings",
      viewType: "gui",
      action: "pin-tab",
      alwaysOnTop: true,
    });
  });

  it("broadcasts close actions without requiring a navigation path consumer", async () => {
    const { ctx, broadcastWs } = makeNavigateCtx("settings", {
      action: "close",
    });

    await expect(handleViewsRoutes(ctx)).resolves.toBe(true);

    expect(broadcastWs).toHaveBeenCalledWith({
      type: "shell:navigate:view",
      viewId: "settings",
      viewPath: "/settings",
      viewLabel: "Settings",
      viewType: "gui",
      action: "close",
    });
  });

  it("broadcasts split and tile layout metadata to the shell", async () => {
    const { ctx, broadcastWs, json } = makeNavigateCtx("notes", {
      action: "split-view",
      views: ["notes", "calendar"],
      layout: "horizontal",
      placement: "right",
    });

    await expect(handleViewsRoutes(ctx)).resolves.toBe(true);

    expect(broadcastWs).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "shell:navigate:view",
        viewId: "notes",
        action: "split-view",
        views: ["notes", "calendar"],
        layout: "horizontal",
        placement: "right",
      }),
    );
    expect(json).toHaveBeenCalledWith(
      ctx.res,
      expect.objectContaining({
        ok: true,
        action: "split-view",
        views: ["notes", "calendar"],
        layout: "horizontal",
        placement: "right",
      }),
    );
  });

  it("drops a non-boolean alwaysOnTop and a non-string action", async () => {
    const { ctx, broadcastWs } = makeNavigateCtx("settings", {
      action: 7,
      alwaysOnTop: "true",
    });

    await expect(handleViewsRoutes(ctx)).resolves.toBe(true);

    const frame = broadcastWs.mock.calls[0][0] as Record<string, unknown>;
    expect("action" in frame).toBe(false);
    expect("alwaysOnTop" in frame).toBe(false);
  });

  it("honors a body path override and falls back to the id as the label", async () => {
    const { ctx, broadcastWs } = makeNavigateCtx("ghost-view", {
      path: "/apps/ghost-view",
    });

    await expect(handleViewsRoutes(ctx)).resolves.toBe(true);

    expect(broadcastWs).toHaveBeenCalledWith({
      type: "shell:navigate:view",
      viewId: "ghost-view",
      viewPath: "/apps/ghost-view",
      viewLabel: "ghost-view",
      viewType: "gui",
    });
  });

  it("routes the synthetic __view-manager__ id to the /apps tab", async () => {
    const { ctx, broadcastWs } = makeNavigateCtx("__view-manager__", {});

    await expect(handleViewsRoutes(ctx)).resolves.toBe(true);

    expect(broadcastWs).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "shell:navigate:view",
        viewId: "__view-manager__",
        viewPath: "/apps",
        viewType: "gui",
      }),
    );
  });

  it("broadcasts generic view update events after server-backed interactions", async () => {
    await registerPluginViews(
      {
        name: "@test/views-route",
        description: "Synthetic view route test plugin.",
        views: [
          {
            id: "scratchpad",
            label: "Scratchpad",
            path: "/scratchpad",
            capabilities: [{ id: "get-state", description: "Read state." }],
            serverInteract: async () => ({
              success: true,
              text: "Read scratchpad state.",
            }),
          },
        ],
      },
      process.cwd(),
    );
    const { ctx, json, broadcastWs } = makeInteractCtx("scratchpad", {
      capability: "get-state",
    });

    await expect(handleViewsRoutes(ctx)).resolves.toBe(true);

    expect(broadcastWs).toHaveBeenCalledWith({
      type: "view:event",
      viewEventType: "view:scratchpad:updated",
      payload: { viewId: "scratchpad", capability: "get-state" },
    });
    expect(json).toHaveBeenCalledWith(
      ctx.res,
      expect.objectContaining({
        success: true,
        result: expect.objectContaining({
          text: "Read scratchpad state.",
        }),
      }),
    );
  });

  it("uses the request viewType for an unregistered id from the query param", async () => {
    const { ctx, broadcastWs } = makeNavigateCtx(
      "spatial-room",
      { path: "/apps/spatial-room" },
      "?viewType=xr",
    );

    await expect(handleViewsRoutes(ctx)).resolves.toBe(true);

    expect(broadcastWs).toHaveBeenCalledWith(
      expect.objectContaining({
        viewId: "spatial-room",
        viewPath: "/apps/spatial-room",
        viewType: "xr",
      }),
    );
  });

  it("records the navigated view as the current view state", async () => {
    const { ctx } = makeNavigateCtx("settings", { action: "pin-tab" });

    await handleViewsRoutes(ctx);

    const state = getCurrentViewState();
    expect(state?.viewId).toBe("settings");
    expect(state?.viewPath).toBe("/settings");
    expect(state?.viewType).toBe("gui");
    expect(state?.action).toBe("pin-tab");
  });
});
