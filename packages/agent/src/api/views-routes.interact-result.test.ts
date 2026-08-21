/**
 * Verifies POST /api/views/interact-result and the pending-request handshake it
 * completes: an interact on a serverInteract-less view parks on the module-level
 * pending map and broadcasts a requestId, which interact-result then resolves so
 * the parked interact route echoes the posted result. Also covers an orphan
 * requestId ack and a missing-requestId rejection. In-process route calls with
 * real body parsing — no HTTP server, no runtime.
 */
import type http from "node:http";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getActiveViewContext,
  setActiveViewContext,
} from "../runtime/view-action-affinity.ts";
import {
  getView,
  registerBuiltinViews,
  registerPluginViews,
  unregisterPluginViews,
} from "./views-registry.ts";
import {
  clearCurrentViewState,
  dispatchViewInteract,
  getCurrentViewState,
  handleViewsRoutes,
  resolveViewInteractResult,
  type ViewsRouteContext,
} from "./views-routes.ts";

// Unit test for POST /api/views/interact-result (views-routes.ts ~L863) and the
// pending-request handshake it completes.
//
// The handshake: POST /api/views/:id/interact for a view *without* a
// serverInteract handler registers a pending slot in the module-level
// PendingRequestMap (via waitFor), broadcasts a `view:interact` frame carrying
// the generated requestId, and awaits the result. POST
// /api/views/interact-result?requestId=… resolves that slot, fulfilling the
// interact promise so its handler responds with the posted result.

const TEST_PLUGIN = "@test/views-interact-result";
const mixedServerInteract = vi.fn(
  async (capability: string, params?: Record<string, unknown>) => ({
    success: true,
    source: "server",
    capability,
    params,
  }),
);

function makeCtx(
  method: "POST",
  pathname: string,
  body: Record<string, unknown> | null,
): {
  ctx: ViewsRouteContext;
  json: ReturnType<typeof vi.fn>;
  error: ReturnType<typeof vi.fn>;
  broadcastWs: ReturnType<typeof vi.fn>;
  broadcastWsToClientId: ReturnType<typeof vi.fn>;
} {
  const req = Readable.from(
    body === null ? [] : [Buffer.from(JSON.stringify(body))],
  ) as unknown as http.IncomingMessage;
  req.headers = {};
  const res = {} as http.ServerResponse;
  const json = vi.fn();
  const error = vi.fn();
  const broadcastWs = vi.fn();
  const broadcastWsToClientId = vi.fn(() => 1);
  const ctx: ViewsRouteContext = {
    req,
    res,
    method,
    pathname,
    url: new URL(`http://local${pathname}`),
    json,
    error,
    broadcastWs,
    broadcastWsToClientId,
  };
  return { ctx, json, error, broadcastWs, broadcastWsToClientId };
}

describe("POST /api/views/interact-result resolves a pending interact", () => {
  beforeEach(async () => {
    registerBuiltinViews();
    clearCurrentViewState();
    mixedServerInteract.mockClear();
    await registerPluginViews(
      {
        name: TEST_PLUGIN,
        description: "Synthetic interact-result test plugin.",
        views: [
          {
            // No serverInteract → the route takes the frontend round-trip path
            // (waitFor + broadcast), which is what interact-result resolves.
            id: "frontend-only",
            label: "Frontend Only",
            path: "/frontend-only",
            capabilities: [
              { id: "get-state", description: "Read view state." },
            ],
          },
          {
            id: "mixed-view",
            label: "Mixed View",
            path: "/mixed-view",
            surface: { capabilities: ["agent-surface"] },
            capabilities: [
              {
                id: "maps-search-places",
                description: "Search normalized map places.",
              },
            ],
            serverInteract: mixedServerInteract,
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

  it("resolves the original interact promise with the posted result", async () => {
    // Kick off the interact; do NOT await yet — it parks on the pending slot.
    const {
      ctx: interactCtx,
      json: interactJson,
      broadcastWs,
      broadcastWsToClientId,
    } = makeCtx("POST", "/api/views/frontend-only/interact", {
      capability: "get-state",
      clientId: "client-one",
      timeoutMs: 5_000,
    });
    const interactPromise = handleViewsRoutes(interactCtx);

    // The route broadcasts `view:interact` carrying the requestId. Poll the spy
    // until that frame lands (the body read + waitFor registration are async).
    let requestId: string | undefined;
    for (let i = 0; i < 50 && !requestId; i++) {
      const frame = broadcastWsToClientId.mock.calls
        .filter(([clientId]) => clientId === "client-one")
        .map((c) => c[1] as Record<string, unknown>)
        .find((p) => p.type === "view:interact");
      if (frame && typeof frame.requestId === "string") {
        requestId = frame.requestId;
        break;
      }
      await new Promise((r) => setImmediate(r));
    }
    expect(requestId).toBeTruthy();
    expect(broadcastWs).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "view:interact" }),
    );

    // Now resolve it via the interact-result route with a matching requestId.
    const { ctx: resultCtx, json: resultJson } = makeCtx(
      "POST",
      "/api/views/interact-result",
      {
        requestId,
        success: true,
        result: { text: "state was read", value: 42 },
      },
    );
    await expect(handleViewsRoutes(resultCtx)).resolves.toBe(true);
    // interact-result acks with { ok: true }.
    expect(resultJson).toHaveBeenCalledWith(resultCtx.res, { ok: true });

    // The parked interact route now finishes and echoes the posted result.
    await expect(interactPromise).resolves.toBe(true);
    expect(interactJson).toHaveBeenCalledTimes(1);
    expect(interactJson).toHaveBeenCalledWith(
      interactCtx.res,
      expect.objectContaining({
        requestId,
        success: true,
        result: { text: "state was read", value: 42 },
      }),
    );
  });

  it("routes a mixed view's agent-surface capability to its targeted mounted frontend", async () => {
    const { ctx, json, broadcastWs, broadcastWsToClientId } = makeCtx(
      "POST",
      "/api/views/mixed-view/interact",
      {
        capability: "agent-click",
        params: { id: "maps-search-submit" },
        clientId: "maps-shell",
        timeoutMs: 5_000,
      },
    );
    const interactPromise = handleViewsRoutes(ctx);

    let frame: Record<string, unknown> | undefined;
    for (let i = 0; i < 50 && !frame; i++) {
      frame = broadcastWsToClientId.mock.calls
        .filter(([clientId]) => clientId === "maps-shell")
        .map((call) => call[1] as Record<string, unknown>)
        .find((payload) => payload.type === "view:interact");
      if (!frame) await new Promise((resolve) => setImmediate(resolve));
    }

    expect(frame).toMatchObject({
      type: "view:interact",
      viewId: "mixed-view",
      capability: "agent-click",
      params: { id: "maps-search-submit" },
    });
    expect(mixedServerInteract).not.toHaveBeenCalled();
    expect(broadcastWs).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "view:interact" }),
    );

    const { ctx: resultCtx } = makeCtx("POST", "/api/views/interact-result", {
      requestId: frame?.requestId,
      success: true,
      result: { ok: true, activated: "maps-search-submit" },
    });
    await handleViewsRoutes(resultCtx);
    await interactPromise;
    expect(json).toHaveBeenCalledWith(
      ctx.res,
      expect.objectContaining({
        success: true,
        result: { ok: true, activated: "maps-search-submit" },
      }),
    );
  });

  it("keeps a mixed view's declared read capability on serverInteract", async () => {
    const { ctx, json, broadcastWsToClientId } = makeCtx(
      "POST",
      "/api/views/mixed-view/interact",
      {
        capability: "maps-search-places",
        params: { query: "cafe" },
        clientId: "maps-shell",
      },
    );

    await expect(handleViewsRoutes(ctx)).resolves.toBe(true);

    expect(broadcastWsToClientId).not.toHaveBeenCalled();
    expect(mixedServerInteract).toHaveBeenCalledWith(
      "maps-search-places",
      { query: "cafe" },
      { runtime: ctx.runtime },
    );
    expect(json).toHaveBeenCalledWith(
      ctx.res,
      expect.objectContaining({
        success: true,
        result: expect.objectContaining({ source: "server" }),
      }),
    );
  });

  it("preserves the structured serverInteract exception response", async () => {
    mixedServerInteract.mockRejectedValueOnce(new Error("provider exploded"));
    const { ctx, json } = makeCtx("POST", "/api/views/mixed-view/interact", {
      capability: "maps-search-places",
      params: { query: "cafe" },
    });

    await expect(handleViewsRoutes(ctx)).resolves.toBe(true);

    expect(json).toHaveBeenCalledWith(ctx.res, {
      requestId: expect.any(String),
      success: false,
      error: "provider exploded",
      result: {
        success: false,
        text: 'Cannot invoke capability "maps-search-places" on view "mixed-view": provider exploded.',
      },
    });
  });

  it("preserves headless serverInteract fallback for standard capabilities", async () => {
    const { ctx, json, broadcastWsToClientId } = makeCtx(
      "POST",
      "/api/views/mixed-view/interact",
      {
        capability: "get-text",
        params: {},
      },
    );

    await expect(handleViewsRoutes(ctx)).resolves.toBe(true);

    expect(broadcastWsToClientId).not.toHaveBeenCalled();
    expect(mixedServerInteract).toHaveBeenCalledWith(
      "get-text",
      {},
      {
        runtime: ctx.runtime,
      },
    );
    expect(json).toHaveBeenCalledWith(
      ctx.res,
      expect.objectContaining({ success: true }),
    );
  });

  it("falls back to serverInteract when a targeted client is no longer connected", async () => {
    const { ctx, json, broadcastWsToClientId } = makeCtx(
      "POST",
      "/api/views/mixed-view/interact",
      {
        capability: "agent-click",
        params: { id: "maps-retry-search" },
        clientId: "gone-shell",
      },
    );
    broadcastWsToClientId.mockReturnValue(0);

    await expect(handleViewsRoutes(ctx)).resolves.toBe(true);

    expect(broadcastWsToClientId).toHaveBeenCalledWith(
      "gone-shell",
      expect.objectContaining({ capability: "agent-click" }),
    );
    expect(mixedServerInteract).toHaveBeenCalledWith(
      "agent-click",
      { id: "maps-retry-search" },
      { runtime: ctx.runtime },
    );
    expect(json).toHaveBeenCalledWith(
      ctx.res,
      expect.objectContaining({ success: true }),
    );
  });

  it("uses the same targeted frontend selection for internal dispatch", async () => {
    const entry = getView("mixed-view");
    if (!entry) throw new Error("mixed view is missing");
    let frame: Record<string, unknown> | undefined;
    const dispatchPromise = dispatchViewInteract(
      entry,
      "mixed-view",
      "agent-focus",
      { id: "maps-search-query" },
      {
        clientId: "internal-shell",
        broadcastWsToClientId: (clientId, payload) => {
          expect(clientId).toBe("internal-shell");
          frame = payload as Record<string, unknown>;
          return 1;
        },
      },
      5_000,
    );

    expect(frame).toMatchObject({
      type: "view:interact",
      capability: "agent-focus",
      params: { id: "maps-search-query" },
    });
    resolveViewInteractResult({
      requestId: String(frame?.requestId),
      success: true,
      result: { ok: true },
    });
    await expect(dispatchPromise).resolves.toMatchObject({
      success: true,
      result: { ok: true },
    });
    expect(mixedServerInteract).not.toHaveBeenCalled();
  });

  it("rejects frontend interact dispatch without global broadcast when client id is missing", async () => {
    const { ctx, json, broadcastWs, broadcastWsToClientId } = makeCtx(
      "POST",
      "/api/views/frontend-only/interact",
      {
        capability: "get-state",
        timeoutMs: 5_000,
      },
    );

    await expect(handleViewsRoutes(ctx)).resolves.toBe(true);

    expect(broadcastWs).not.toHaveBeenCalled();
    expect(broadcastWsToClientId).not.toHaveBeenCalled();
    expect(json).toHaveBeenCalledWith(
      ctx.res,
      expect.objectContaining({
        success: false,
        error: expect.stringContaining("Missing client id"),
      }),
    );
  });

  it("targets the mounted active-view owner when interact has no explicit client id", async () => {
    setActiveViewContext({
      viewId: "frontend-only",
      viewLabel: "Frontend Only",
      viewType: "gui",
      viewPath: "/frontend-only",
    });
    const { ctx: elementsCtx } = makeCtx(
      "POST",
      "/api/views/frontend-only/elements",
      {
        clientId: "mounted-shell",
        elements: [{ id: "refresh", role: "button", label: "Refresh" }],
      },
    );
    await expect(handleViewsRoutes(elementsCtx)).resolves.toBe(true);

    const { ctx, broadcastWs, broadcastWsToClientId, json } = makeCtx(
      "POST",
      "/api/views/frontend-only/interact",
      {
        capability: "get-state",
        timeoutMs: 5_000,
      },
    );
    const interactPromise = handleViewsRoutes(ctx);

    let requestId: string | undefined;
    for (let i = 0; i < 50 && !requestId; i++) {
      const frame = broadcastWsToClientId.mock.calls
        .filter(([clientId]) => clientId === "mounted-shell")
        .map((c) => c[1] as Record<string, unknown>)
        .find((p) => p.type === "view:interact");
      if (frame && typeof frame.requestId === "string") {
        requestId = frame.requestId;
        break;
      }
      await new Promise((r) => setImmediate(r));
    }

    expect(requestId).toBeTruthy();
    expect(broadcastWs).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "view:interact" }),
    );

    const { ctx: resultCtx } = makeCtx("POST", "/api/views/interact-result", {
      requestId,
      success: true,
      result: { text: "mounted owner handled it" },
    });
    await expect(handleViewsRoutes(resultCtx)).resolves.toBe(true);
    await expect(interactPromise).resolves.toBe(true);
    expect(json).toHaveBeenCalledWith(
      ctx.res,
      expect.objectContaining({
        requestId,
        success: true,
        result: { text: "mounted owner handled it" },
      }),
    );
  });

  it("restores a mounted foreground view after backend state restarts", async () => {
    const { ctx, json } = makeCtx("POST", "/api/views/frontend-only/elements", {
      clientId: "restored-shell",
      viewPath: "/frontend-only?restored=1",
      viewType: "gui",
      elements: [{ id: "card-1", role: "card", label: "Current card" }],
    });

    await expect(handleViewsRoutes(ctx)).resolves.toBe(true);

    expect(json).toHaveBeenCalledWith(ctx.res, {
      ok: true,
      viewId: "frontend-only",
      accepted: true,
      count: 1,
    });
    expect(getCurrentViewState()).toMatchObject({
      viewId: "frontend-only",
      viewPath: "/frontend-only",
      viewLabel: "Frontend Only",
      viewType: "gui",
    });
    expect(getCurrentViewState()?.switchedAt).toBeUndefined();
    expect(getActiveViewContext()).toMatchObject({
      viewId: "frontend-only",
      clientId: "restored-shell",
      elements: [{ id: "card-1", label: "Current card" }],
    });
  });

  it("does not restore a background view whose route is not visible", async () => {
    const { ctx, json } = makeCtx("POST", "/api/views/frontend-only/elements", {
      viewPath: "/chat",
      viewType: "gui",
      elements: [{ id: "card-1", role: "card", label: "Hidden card" }],
    });

    await expect(handleViewsRoutes(ctx)).resolves.toBe(true);

    expect(json).toHaveBeenCalledWith(ctx.res, {
      ok: true,
      viewId: "frontend-only",
      accepted: false,
      count: 1,
    });
    expect(getCurrentViewState()).toBeNull();
    expect(getActiveViewContext()).toBeNull();
  });

  it("acks gracefully for an unknown requestId without throwing", async () => {
    // No pending slot exists for this id — resolve() is a no-op, but the route
    // still matches and acks. This must not throw or hang.
    const { ctx, json, error } = makeCtx("POST", "/api/views/interact-result", {
      requestId: "00000000-0000-0000-0000-000000000000",
      success: true,
      result: { text: "orphan" },
    });

    await expect(handleViewsRoutes(ctx)).resolves.toBe(true);
    expect(json).toHaveBeenCalledWith(ctx.res, { ok: true });
    expect(error).not.toHaveBeenCalled();
  });

  it("rejects an interact-result body that omits requestId", async () => {
    const { ctx, json, error } = makeCtx("POST", "/api/views/interact-result", {
      success: true,
      result: {},
    });

    await expect(handleViewsRoutes(ctx)).resolves.toBe(true);
    expect(error).toHaveBeenCalledWith(
      ctx.res,
      "Missing requestId in interact-result body",
      400,
    );
    expect(json).not.toHaveBeenCalled();
  });
});
