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
  registerBuiltinViews,
  registerPluginViews,
  unregisterPluginViews,
} from "./views-registry.ts";
import {
  clearCurrentViewState,
  handleViewsRoutes,
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

describe("POST /api/views/interact-result resolves a pending interact", () => {
  beforeEach(async () => {
    registerBuiltinViews();
    clearCurrentViewState();
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
    } = makeCtx("POST", "/api/views/frontend-only/interact", {
      capability: "get-state",
      timeoutMs: 5_000,
    });
    const interactPromise = handleViewsRoutes(interactCtx);

    // The route broadcasts `view:interact` carrying the requestId. Poll the spy
    // until that frame lands (the body read + waitFor registration are async).
    let requestId: string | undefined;
    for (let i = 0; i < 50 && !requestId; i++) {
      const frame = broadcastWs.mock.calls
        .map((c) => c[0] as Record<string, unknown>)
        .find((p) => p.type === "view:interact");
      if (frame && typeof frame.requestId === "string") {
        requestId = frame.requestId;
        break;
      }
      await new Promise((r) => setImmediate(r));
    }
    expect(requestId).toBeTruthy();

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
