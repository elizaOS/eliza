/**
 * Unit test for POST /api/views/:id/activate. Contract: `{ elementId }` resolves
 * the element against the active-view snapshot (for context) and dispatches the
 * standard CLICK_ELEMENT capability through the same interact path as `/interact`
 * — a `serverInteract` handler when present. Drives the route handler in-process
 * (no HTTP server) with a mocked serverInteract and the real views registry.
 */
import type http from "node:http";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  setActiveViewContext,
  setActiveViewElements,
} from "../runtime/view-action-affinity.ts";
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

const TEST_PLUGIN = "@test/views-activate";

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

describe("POST /api/views/:id/activate", () => {
  const serverInteract = vi.fn(
    async (_capability: string, _params?: Record<string, unknown>) => ({
      success: true,
      text: "clicked",
    }),
  );

  beforeEach(async () => {
    registerBuiltinViews();
    clearCurrentViewState();
    serverInteract.mockClear();
    await registerPluginViews(
      {
        name: TEST_PLUGIN,
        description: "Synthetic activate test plugin.",
        views: [
          {
            id: "approve",
            label: "Approve",
            path: "/approve",
            // A serverInteract handler takes the in-process dispatch path so the
            // test does not need a frontend round-trip.
            serverInteract,
            surface: { capabilities: ["agent-surface"] },
            capabilities: [{ id: "get-state", description: "Read state." }],
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

  it("dispatches CLICK_ELEMENT for the element and echoes the resolved element", async () => {
    // Mark the view active + report its element snapshot so the route resolves
    // the element for context.
    setActiveViewContext({
      viewId: "approve",
      viewLabel: "Approve",
      viewType: "tui",
      viewPath: "/approve",
    });
    setActiveViewElements("approve", [
      { id: "send-it", role: "button", label: "Send it" },
    ]);

    const { ctx, json, broadcastWs } = makeCtx(
      "POST",
      "/api/views/approve/activate",
      { elementId: "send-it" },
    );
    await expect(handleViewsRoutes(ctx)).resolves.toBe(true);

    // The view's serverInteract was invoked with the click-element capability
    // and the element id in params.
    expect(serverInteract).toHaveBeenCalledTimes(1);
    expect(serverInteract).toHaveBeenCalledWith(
      "click-element",
      expect.objectContaining({ elementId: "send-it" }),
    );
    // A view-updated event is broadcast.
    expect(broadcastWs).toHaveBeenCalledWith(
      expect.objectContaining({ type: "view:event" }),
    );
    // The response carries ok + the resolved element + the dispatch result.
    expect(json).toHaveBeenCalledWith(
      ctx.res,
      expect.objectContaining({
        ok: true,
        viewId: "approve",
        elementId: "send-it",
        element: expect.objectContaining({ id: "send-it", role: "button" }),
        dispatch: expect.objectContaining({ success: true }),
      }),
    );
  });

  it("dispatches by id even with no element snapshot (element omitted)", async () => {
    const { ctx, json } = makeCtx("POST", "/api/views/approve/activate", {
      elementId: "send-it",
    });
    await expect(handleViewsRoutes(ctx)).resolves.toBe(true);

    expect(serverInteract).toHaveBeenCalledTimes(1);
    const payload = json.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(payload.ok).toBe(true);
    expect(payload.element).toBeUndefined();
  });

  it("rejects an activate body that omits elementId", async () => {
    const { ctx, json, error } = makeCtx(
      "POST",
      "/api/views/approve/activate",
      {},
    );
    await expect(handleViewsRoutes(ctx)).resolves.toBe(true);
    expect(error).toHaveBeenCalledWith(
      ctx.res,
      "Missing elementId in activate body",
      400,
    );
    expect(json).not.toHaveBeenCalled();
    expect(serverInteract).not.toHaveBeenCalled();
  });

  it("404s when the view is not registered", async () => {
    const { ctx, error } = makeCtx("POST", "/api/views/nope/activate", {
      elementId: "x",
    });
    await expect(handleViewsRoutes(ctx)).resolves.toBe(true);
    expect(error).toHaveBeenCalledWith(ctx.res, 'View "nope" not found', 404);
  });
});
