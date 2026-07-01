/**
 * `POST /api/views/:id/navigate` → `EventType.VIEW_SWITCHED` emission contract
 * (#8792). The navigate route is the one server-side seam that turns a view
 * change — agent-initiated OR client-reported (`source: "user"`) — into the
 * first-class interaction event the proactive decider keys off. This pins that
 * contract: emit on a real change, carry `initiatedBy` + `previousViewId`, and
 * stay quiet on a re-navigate or a close (which would otherwise spam the
 * decider). The broadcast/state half is covered by
 * views-routes.navigate-broadcast.test.ts.
 */
import type http from "node:http";
import { Readable } from "node:stream";
import { EventType, type IAgentRuntime } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerBuiltinViews } from "./views-registry.ts";
import {
  clearCurrentViewState,
  handleViewsRoutes,
  type ViewsRouteContext,
} from "./views-routes.ts";

function makeCtx(
  id: string,
  body: Record<string, unknown> | null,
): {
  ctx: ViewsRouteContext;
  emitEvent: ReturnType<typeof vi.fn>;
} {
  const req = Readable.from(
    body === null ? [] : [Buffer.from(JSON.stringify(body))],
  ) as unknown as http.IncomingMessage;
  const res = {} as http.ServerResponse;
  const emitEvent = vi.fn(async () => {});
  const pathname = `/api/views/${encodeURIComponent(id)}/navigate`;
  const ctx: ViewsRouteContext = {
    req,
    res,
    method: "POST",
    pathname,
    url: new URL(`http://local${pathname}`),
    json: vi.fn(),
    error: vi.fn(),
    broadcastWs: vi.fn(),
    runtime: { emitEvent } as unknown as IAgentRuntime,
  };
  return { ctx, emitEvent };
}

function viewSwitchedCalls(emitEvent: ReturnType<typeof vi.fn>) {
  return emitEvent.mock.calls.filter(
    (call) => call[0] === EventType.VIEW_SWITCHED,
  );
}

describe("POST /api/views/:id/navigate — VIEW_SWITCHED emission (#8792)", () => {
  beforeEach(() => {
    registerBuiltinViews();
    clearCurrentViewState();
  });
  afterEach(() => {
    clearCurrentViewState();
    vi.restoreAllMocks();
  });

  it("emits VIEW_SWITCHED with initiatedBy=user for a client-reported switch", async () => {
    const { ctx, emitEvent } = makeCtx("wallet", { source: "user" });
    await handleViewsRoutes(ctx);

    const calls = viewSwitchedCalls(emitEvent);
    expect(calls).toHaveLength(1);
    expect(calls[0][1]).toEqual(
      expect.objectContaining({
        viewId: "wallet",
        initiatedBy: "user",
        previousViewId: null,
        source: "view-navigate:user",
      }),
    );
  });

  it("emits VIEW_SWITCHED with initiatedBy=agent for a default (agent) switch", async () => {
    const { ctx, emitEvent } = makeCtx("settings", {});
    await handleViewsRoutes(ctx);

    const calls = viewSwitchedCalls(emitEvent);
    expect(calls).toHaveLength(1);
    expect(calls[0][1]).toEqual(
      expect.objectContaining({ viewId: "settings", initiatedBy: "agent" }),
    );
  });

  it("does NOT re-emit when re-navigating to the same view", async () => {
    const first = makeCtx("wallet", { source: "user" });
    await handleViewsRoutes(first.ctx);
    expect(viewSwitchedCalls(first.emitEvent)).toHaveLength(1);

    // Same view again (e.g. a re-tap) must not re-fire the decider.
    const second = makeCtx("wallet", { source: "user" });
    await handleViewsRoutes(second.ctx);
    expect(viewSwitchedCalls(second.emitEvent)).toHaveLength(0);
  });

  it("carries the previous view id on a real change", async () => {
    const first = makeCtx("wallet", { source: "user" });
    await handleViewsRoutes(first.ctx);

    const second = makeCtx("calendar", { source: "user" });
    await handleViewsRoutes(second.ctx);

    const calls = viewSwitchedCalls(second.emitEvent);
    expect(calls).toHaveLength(1);
    expect(calls[0][1]).toEqual(
      expect.objectContaining({ viewId: "calendar", previousViewId: "wallet" }),
    );
  });

  it("does NOT emit for a close action (the view is being dismissed, not switched to)", async () => {
    // Seed an active view, then close it.
    await handleViewsRoutes(makeCtx("wallet", { source: "user" }).ctx);
    const { ctx, emitEvent } = makeCtx("wallet", {
      source: "user",
      action: "close",
    });
    await handleViewsRoutes(ctx);
    expect(viewSwitchedCalls(emitEvent)).toHaveLength(0);
  });

  it("does not throw when no runtime is bound (event emission is best-effort)", async () => {
    const req = Readable.from([
      Buffer.from(JSON.stringify({ source: "user" })),
    ]) as unknown as http.IncomingMessage;
    const pathname = "/api/views/wallet/navigate";
    const ctx: ViewsRouteContext = {
      req,
      res: {} as http.ServerResponse,
      method: "POST",
      pathname,
      url: new URL(`http://local${pathname}`),
      json: vi.fn(),
      error: vi.fn(),
      broadcastWs: vi.fn(),
      runtime: null,
    };
    await expect(handleViewsRoutes(ctx)).resolves.toBe(true);
  });
});
