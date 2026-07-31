/**
 * Server half of the agent view-switch contract: POST /api/views/:id/navigate
 * resolves a view (builtin registry, body path override, or synthetic ids) and
 * broadcasts the shell navigate-view WS frame, threading action/alwaysOnTop/
 * subview/split-layout fields, recording current-view state, and stamping a
 * turn-scoped switch-freshness marker; also covers view:event broadcasts after a
 * server-backed interact. Focused route unit tests with real body parsing — no
 * PGLite, runtime, or LLM.
 */
import type http from "node:http";
import { Readable } from "node:stream";
import {
  normalizeShellNavigateViewPayload,
  SHELL_NAVIGATE_VIEW_WS_EVENT,
} from "@elizaos/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getActiveViewContext,
  setActiveViewElements,
} from "../runtime/view-action-affinity.ts";
import {
  MAX_ACKNOWLEDGED_VIEW_OPERATIONS,
  MAX_VIEW_OPERATION_BYTES,
} from "./view-navigation-outbox.ts";
import {
  registerBuiltinViews,
  registerPluginViews,
  unregisterPluginViews,
} from "./views-registry.ts";
import {
  type CurrentViewState,
  clearCurrentViewState,
  getCurrentViewRevision,
  getCurrentViewState,
  handleViewsRoutes,
  isViewSwitchFresh,
  MAX_VIEW_STATE_SCOPES,
  pruneIdleCurrentViewScopes,
  registerCurrentViewScopeWebSocket,
  releaseCurrentViewScope,
  VIEW_SCOPE_IDLE_TTL_MS,
  VIEW_SWITCH_FRESH_MS,
  type ViewsRouteContext,
} from "./views-routes.ts";

// Server half of the agent view-switch contract. When the VIEWS action (or any
// caller) hits POST /api/views/:id/navigate, the route must broadcast a
// `SHELL_NAVIGATE_VIEW_WS_EVENT` WebSocket frame. The frontend half — that this exact
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
  options: {
    clientId?: string;
    unscoped?: boolean;
    autoRevision?: boolean;
    recipientCount?: number;
    headers?: Record<string, string>;
    runtime?: ViewsRouteContext["runtime"];
  } = {},
): {
  ctx: ViewsRouteContext;
  json: ReturnType<typeof vi.fn>;
  error: ReturnType<typeof vi.fn>;
  broadcastWs: ReturnType<typeof vi.fn>;
  broadcastWsToClientId: ReturnType<typeof vi.fn>;
} {
  const effectiveClientId = options.unscoped
    ? undefined
    : (options.clientId ?? "__default__");
  // `readJsonBody` reads the request as a Node stream; Readable.from yields the
  // JSON exactly as an inbound HTTP request body would.
  const bodyWithRevision =
    body &&
    options.autoRevision !== false &&
    body.expectedRevision === undefined &&
    body.source !== "user" &&
    body.rehydrate !== true
      ? {
          ...body,
          expectedRevision: getCurrentViewRevision(effectiveClientId),
        }
      : body;
  const req = Readable.from(
    bodyWithRevision === null
      ? []
      : [Buffer.from(JSON.stringify(bodyWithRevision))],
  ) as unknown as http.IncomingMessage;
  req.headers = {
    ...options.headers,
    ...(effectiveClientId ? { "x-elizaos-client-id": effectiveClientId } : {}),
  };
  const res = {} as http.ServerResponse;
  const json = vi.fn();
  const error = vi.fn();
  const broadcastWs = vi.fn();
  const broadcastWsToClientId = vi.fn((_clientId: string, frame: object) => {
    if (options.clientId === undefined && !options.unscoped) {
      broadcastWs(frame);
    }
    return 1;
  });
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
    broadcastWsRecipientCount: () => options.recipientCount ?? 1,
    broadcastWsToClientId,
    runtime: options.runtime,
  };
  return { ctx, json, error, broadcastWs, broadcastWsToClientId };
}

function makeInteractCtx(
  id: string,
  body: NavigateBody | null,
  search = "",
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
    url: new URL(`http://local${pathname}${search}`),
    json,
    error,
    broadcastWs,
  };
  return { ctx, json, error, broadcastWs };
}

function makeOperationAckCtx(
  operationId: string,
  expectedOperationRevision: number,
  clientId: string,
): {
  ctx: ViewsRouteContext;
  json: ReturnType<typeof vi.fn>;
  error: ReturnType<typeof vi.fn>;
} {
  const body = { expectedOperationRevision };
  const req = Readable.from([
    Buffer.from(JSON.stringify(body)),
  ]) as unknown as http.IncomingMessage;
  req.headers = { "x-elizaos-client-id": clientId };
  const res = {} as http.ServerResponse;
  const json = vi.fn();
  const error = vi.fn();
  const pathname = `/api/views/operations/${encodeURIComponent(operationId)}/ack`;
  const ctx: ViewsRouteContext = {
    req,
    res,
    method: "POST",
    pathname,
    url: new URL(`http://local${pathname}`),
    json,
    error,
    broadcastWs: vi.fn(),
  };
  return { ctx, json, error };
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
      type: SHELL_NAVIGATE_VIEW_WS_EVENT,
      viewId: "settings",
      viewPath: "/settings",
      viewLabel: "Settings",
      viewType: "gui",
      source: "agent",
      revision: 1,
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
      source: "agent",
    });

    await expect(handleViewsRoutes(ctx)).resolves.toBe(true);

    expect(broadcastWs).toHaveBeenCalledWith({
      type: SHELL_NAVIGATE_VIEW_WS_EVENT,
      viewId: "settings",
      viewPath: "/settings",
      viewLabel: "Settings",
      viewType: "gui",
      action: "pin-tab",
      alwaysOnTop: true,
      source: "agent",
      revision: 1,
    });
  });

  it("carries opaque deep-link payloads to the shell frame and response", async () => {
    const payload = { permissionRequest: { permission: "microphone" } };
    const { ctx, json, broadcastWs } = makeNavigateCtx("settings", {
      path: "/settings",
      subview: "permissions",
      source: "agent",
      payload,
    });

    await expect(handleViewsRoutes(ctx)).resolves.toBe(true);

    expect(broadcastWs).toHaveBeenCalledWith({
      type: SHELL_NAVIGATE_VIEW_WS_EVENT,
      viewId: "settings",
      viewPath: "/settings",
      viewLabel: "Settings",
      viewType: "gui",
      subview: "permissions",
      source: "agent",
      payload,
      revision: 1,
    });
    expect(json).toHaveBeenCalledWith(
      ctx.res,
      expect.objectContaining({
        ok: true,
        viewId: "settings",
        subview: "permissions",
        payload,
      }),
    );
  });

  it("broadcasts close actions without requiring a navigation path consumer", async () => {
    const { ctx, broadcastWs } = makeNavigateCtx("settings", {
      action: "close",
      source: "agent",
    });

    await expect(handleViewsRoutes(ctx)).resolves.toBe(true);

    expect(broadcastWs).toHaveBeenCalledWith({
      type: SHELL_NAVIGATE_VIEW_WS_EVENT,
      viewId: "settings",
      viewPath: "/settings",
      viewLabel: "Settings",
      viewType: "gui",
      action: "close",
      source: "agent",
      revision: 0,
    });
  });

  it("retains one exact outbox operation through frame, reconnect, ack, and retry", async () => {
    const operationId = "views:turn-1";
    const request = makeNavigateCtx(
      "settings",
      { deliveryOwner: "outbox", operationId },
      "",
      { clientId: "outbox-client" },
    );

    await handleViewsRoutes(request.ctx);

    const frame = request.broadcastWsToClientId.mock.calls[0]?.[1] as Record<
      string,
      unknown
    >;
    expect(normalizeShellNavigateViewPayload(frame)).toMatchObject({
      deliveryOwner: "outbox",
      operationId,
      operationRevision: 1,
      revision: 1,
      viewId: "settings",
      viewType: "gui",
    });
    expect(request.json).toHaveBeenCalledWith(
      request.ctx.res,
      expect.objectContaining({
        accepted: true,
        delivery: "pending",
        deliveryOwner: "outbox",
        operationId,
        operationRevision: 1,
        revision: 1,
      }),
    );

    const current = makeCurrentCtx("outbox-client");
    await handleViewsRoutes(current.ctx);
    expect(current.json).toHaveBeenCalledWith(
      current.ctx.res,
      expect.objectContaining({
        revision: 1,
        pendingOperations: [
          expect.objectContaining({
            deliveryOwner: "outbox",
            operationId,
            operationRevision: 1,
            revision: 1,
          }),
        ],
      }),
    );

    const ack = makeOperationAckCtx(operationId, 1, "outbox-client");
    await handleViewsRoutes(ack.ctx);
    expect(ack.json).toHaveBeenCalledWith(ack.ctx.res, {
      ok: true,
      acked: true,
      alreadyAcked: false,
      operationId,
      operationRevision: 1,
    });

    const exactRetry = makeNavigateCtx(
      "settings",
      {
        deliveryOwner: "outbox",
        operationId,
        expectedRevision: 0,
      },
      "",
      { clientId: "outbox-client", autoRevision: false },
    );
    await handleViewsRoutes(exactRetry.ctx);
    expect(exactRetry.json).toHaveBeenCalledWith(
      exactRetry.ctx.res,
      expect.objectContaining({
        acknowledged: true,
        delivery: "client-owned",
        operationId,
        operationRevision: 1,
        revision: 1,
      }),
    );
    expect(exactRetry.broadcastWsToClientId).not.toHaveBeenCalled();
    expect(getCurrentViewRevision("outbox-client")).toBe(1);
  });

  it("rejects operation-id reuse with another destination before stale CAS", async () => {
    const operationId = "views:turn-conflict";
    const first = makeNavigateCtx(
      "settings",
      { deliveryOwner: "outbox", operationId },
      "",
      { clientId: "conflict-client" },
    );
    await handleViewsRoutes(first.ctx);

    const mismatch = makeNavigateCtx(
      "character",
      {
        deliveryOwner: "outbox",
        operationId,
        expectedRevision: 0,
      },
      "",
      { clientId: "conflict-client", autoRevision: false },
    );
    await handleViewsRoutes(mismatch.ctx);

    expect(mismatch.error).toHaveBeenCalledWith(
      mismatch.ctx.res,
      `View operation "${operationId}" conflicts with an existing operation`,
      409,
    );
    expect(getCurrentViewRevision("conflict-client")).toBe(1);
    expect(getCurrentViewState("conflict-client")?.viewId).toBe("settings");
    expect(mismatch.broadcastWsToClientId).not.toHaveBeenCalled();
  });

  it("gives an outbox close edge a positive revision when the view is absent", async () => {
    const request = makeNavigateCtx(
      "settings",
      {
        action: "close",
        deliveryOwner: "outbox",
        operationId: "views:close-absent",
      },
      "",
      { clientId: "close-client" },
    );

    await handleViewsRoutes(request.ctx);

    const frame = request.broadcastWsToClientId.mock.calls[0]?.[1] as Record<
      string,
      unknown
    >;
    expect(normalizeShellNavigateViewPayload(frame)).toMatchObject({
      action: "close",
      operationId: "views:close-absent",
      operationRevision: 1,
      revision: 1,
    });
    expect(getCurrentViewState("close-client")).toBeNull();
    expect(getCurrentViewRevision("close-client")).toBe(1);
  });

  it.each([
    { action: "show" },
    { action: "close-all" },
    { action: "split-view" },
    { action: "tile-views", views: ["settings", 7] },
  ])("rejects malformed outbox topology before mutation: %j", async (extra) => {
    const request = makeNavigateCtx(
      "settings",
      {
        deliveryOwner: "outbox",
        operationId: "views:malformed",
        ...extra,
      },
      "",
      { clientId: "malformed-client" },
    );

    await handleViewsRoutes(request.ctx);

    expect(request.error).toHaveBeenCalledWith(
      request.ctx.res,
      expect.any(String),
      400,
    );
    expect(getCurrentViewRevision("malformed-client")).toBe(0);
    expect(request.broadcastWsToClientId).not.toHaveBeenCalled();
  });

  it("rejects oversized outbox payloads before view state or delivery changes", async () => {
    const request = makeNavigateCtx(
      "settings",
      {
        deliveryOwner: "outbox",
        operationId: "views:oversized",
        payload: "x".repeat(MAX_VIEW_OPERATION_BYTES),
      },
      "",
      { clientId: "oversized-client" },
    );

    await handleViewsRoutes(request.ctx);

    expect(request.error).toHaveBeenCalledWith(
      request.ctx.res,
      `View operation exceeds the ${MAX_VIEW_OPERATION_BYTES}-byte limit`,
      413,
    );
    expect(getCurrentViewState("oversized-client")).toBeNull();
    expect(getCurrentViewRevision("oversized-client")).toBe(0);
    expect(request.broadcastWsToClientId).not.toHaveBeenCalled();
  });

  it("reserves tombstone capacity before accepting a visible operation", async () => {
    const clientId = "retention-client";
    for (let index = 0; index < MAX_ACKNOWLEDGED_VIEW_OPERATIONS - 1; index++) {
      const operationId = `views:acked-${index}`;
      const navigate = makeNavigateCtx(
        "settings",
        { deliveryOwner: "outbox", operationId },
        "",
        { clientId },
      );
      await handleViewsRoutes(navigate.ctx);
      const ack = makeOperationAckCtx(operationId, index + 1, clientId);
      await handleViewsRoutes(ack.ctx);
      expect(ack.error).not.toHaveBeenCalled();
    }
    const reservedId = "views:reserved";
    const reserved = makeNavigateCtx(
      "settings",
      { deliveryOwner: "outbox", operationId: reservedId },
      "",
      { clientId },
    );
    await handleViewsRoutes(reserved.ctx);
    const revisionBeforeOverflow = getCurrentViewRevision(clientId);

    const overflow = makeNavigateCtx(
      "character",
      { deliveryOwner: "outbox", operationId: "views:overflow" },
      "",
      { clientId },
    );
    await handleViewsRoutes(overflow.ctx);

    expect(overflow.error).toHaveBeenCalledWith(
      overflow.ctx.res,
      expect.stringContaining("outbox"),
      503,
    );
    expect(getCurrentViewRevision(clientId)).toBe(revisionBeforeOverflow);
    expect(getCurrentViewState(clientId)?.viewId).toBe("settings");
    expect(overflow.broadcastWsToClientId).not.toHaveBeenCalled();
  });

  it("broadcasts split and tile layout metadata to the shell", async () => {
    const { ctx, broadcastWs, json } = makeNavigateCtx("settings", {
      action: "split-view",
      views: ["settings", "character"],
      layout: "horizontal",
      placement: "right",
    });

    await expect(handleViewsRoutes(ctx)).resolves.toBe(true);

    expect(broadcastWs).toHaveBeenCalledWith(
      expect.objectContaining({
        type: SHELL_NAVIGATE_VIEW_WS_EVENT,
        viewId: "settings",
        action: "split-view",
        views: ["settings", "character"],
        layout: "horizontal",
        placement: "right",
      }),
    );
    expect(json).toHaveBeenCalledWith(
      ctx.res,
      expect.objectContaining({
        ok: true,
        action: "split-view",
        views: ["settings", "character"],
        layout: "horizontal",
        placement: "right",
      }),
    );
  });

  it("preserves exact same-id multimodal panes through frame, response, and state", async () => {
    await registerPluginViews(
      {
        name: "@test/views-route",
        description: "Multimodal layout fixture.",
        views: [
          { id: "hybrid", label: "Hybrid", viewType: "gui", path: "/hybrid" },
          {
            id: "hybrid",
            label: "Hybrid XR",
            viewType: "xr",
            path: "/hybrid-xr",
          },
        ],
      },
      process.cwd(),
    );
    const panes = [
      { viewId: "hybrid", viewType: "gui" as const },
      { viewId: "hybrid", viewType: "xr" as const },
    ];
    const request = makeNavigateCtx(
      "hybrid",
      {
        action: "split-view",
        views: ["hybrid", "hybrid"],
        panes,
        layout: "horizontal",
      },
      "?viewType=gui",
      { clientId: "client-a" },
    );

    await handleViewsRoutes(request.ctx);

    expect(request.broadcastWsToClientId).toHaveBeenCalledWith(
      "client-a",
      expect.objectContaining({ panes, views: ["hybrid", "hybrid"] }),
    );
    expect(request.json).toHaveBeenCalledWith(
      request.ctx.res,
      expect.objectContaining({ panes, revision: 1 }),
    );
    expect(getCurrentViewState("client-a")?.panes).toEqual(panes);

    const closeXr = makeNavigateCtx(
      "hybrid",
      { action: "close", expectedRevision: 1 },
      "?viewType=xr",
      { clientId: "client-a" },
    );
    await handleViewsRoutes(closeXr.ctx);
    expect(getCurrentViewState("client-a")).toMatchObject({
      viewId: "hybrid",
      viewType: "gui",
    });
    expect(getCurrentViewState("client-a")?.panes).toBeUndefined();
  });

  it("treats a same-id modality switch as a new view identity", async () => {
    await registerPluginViews(
      {
        name: "@test/views-route",
        description: "Multimodal switch fixture.",
        views: [
          { id: "hybrid", label: "Hybrid", viewType: "gui", path: "/hybrid" },
          {
            id: "hybrid",
            label: "Hybrid TUI",
            viewType: "tui",
            path: "/hybrid-tui",
          },
        ],
      },
      process.cwd(),
    );
    const emitEvent = vi.fn(async () => undefined);
    const runtime = { emitEvent } as unknown as ViewsRouteContext["runtime"];
    const gui = makeNavigateCtx("hybrid", {}, "?viewType=gui", {
      clientId: "client-a",
      runtime,
    });
    await handleViewsRoutes(gui.ctx);
    const guiSwitchedAt = getCurrentViewState("client-a")?.switchedAt;
    await new Promise((resolve) => setTimeout(resolve, 20));

    const tui = makeNavigateCtx("hybrid", {}, "?viewType=tui", {
      clientId: "client-a",
      runtime,
    });
    await handleViewsRoutes(tui.ctx);
    const tuiSwitchedAt = getCurrentViewState("client-a")?.switchedAt;

    expect(getCurrentViewState("client-a")).toMatchObject({
      viewId: "hybrid",
      viewType: "tui",
    });
    expect(tuiSwitchedAt).not.toBe(guiSwitchedAt);
    expect(emitEvent).toHaveBeenCalledTimes(2);
    expect(emitEvent).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({ viewId: "hybrid", viewType: "tui" }),
    );

    await new Promise((resolve) => setTimeout(resolve, 20));
    const sameTui = makeNavigateCtx("hybrid", {}, "?viewType=tui", {
      clientId: "client-a",
      runtime,
    });
    await handleViewsRoutes(sameTui.ctx);
    expect(getCurrentViewState("client-a")?.switchedAt).toBe(tuiSwitchedAt);
    expect(emitEvent).toHaveBeenCalledTimes(2);
  });

  it("rejects an unavailable requested modality without state or delivery", async () => {
    const request = makeNavigateCtx("settings", {}, "?viewType=tui", {
      clientId: "client-a",
    });

    await handleViewsRoutes(request.ctx);

    expect(request.error).toHaveBeenCalledWith(
      request.ctx.res,
      'View "settings" does not support viewType "tui"',
      404,
    );
    expect(getCurrentViewState("client-a")).toBeNull();
    expect(request.broadcastWs).not.toHaveBeenCalled();
    expect(request.broadcastWsToClientId).not.toHaveBeenCalled();
  });

  it("isolates state, revisions, and navigation delivery by renderer", async () => {
    const first = makeNavigateCtx("settings", {}, "", {
      clientId: "client-a",
    });
    const second = makeNavigateCtx("character", {}, "", {
      clientId: "client-b",
    });

    await handleViewsRoutes(first.ctx);
    await handleViewsRoutes(second.ctx);

    expect(getCurrentViewState("client-a")?.viewId).toBe("settings");
    expect(getCurrentViewState("client-b")?.viewId).toBe("character");
    expect(getCurrentViewRevision("client-a")).toBe(1);
    expect(getCurrentViewRevision("client-b")).toBe(1);
    expect(first.broadcastWs).not.toHaveBeenCalled();
    expect(first.broadcastWsToClientId).toHaveBeenCalledWith(
      "client-a",
      expect.objectContaining({ viewId: "settings" }),
    );
    expect(second.broadcastWsToClientId).toHaveBeenCalledWith(
      "client-b",
      expect.objectContaining({ viewId: "character" }),
    );
  });

  it("rejects stale conditional navigation without changing state or broadcasting", async () => {
    const first = makeNavigateCtx("settings", {}, "", {
      clientId: "client-a",
    });
    await handleViewsRoutes(first.ctx);
    const stale = makeNavigateCtx("character", { expectedRevision: 0 }, "", {
      clientId: "client-a",
    });

    await expect(handleViewsRoutes(stale.ctx)).resolves.toBe(true);

    expect(stale.json).toHaveBeenCalledWith(
      stale.ctx.res,
      expect.objectContaining({
        ok: false,
        conflict: true,
        revision: 1,
      }),
      409,
    );
    expect(stale.broadcastWs).not.toHaveBeenCalled();
    expect(stale.broadcastWsToClientId).not.toHaveBeenCalled();
    expect(getCurrentViewState("client-a")?.viewId).toBe("settings");
    expect(getCurrentViewRevision("client-a")).toBe(1);
  });

  it("requires agent navigation CAS before any state or frame mutation", async () => {
    const request = makeNavigateCtx("settings", {}, "", {
      clientId: "client-a",
      autoRevision: false,
    });

    await handleViewsRoutes(request.ctx);

    expect(request.error).toHaveBeenCalledWith(
      request.ctx.res,
      'Missing "expectedRevision" for agent-owned navigation',
      400,
    );
    expect(getCurrentViewState("client-a")).toBeNull();
    expect(getCurrentViewRevision("client-a")).toBe(0);
    expect(request.broadcastWs).not.toHaveBeenCalled();
    expect(request.broadcastWsToClientId).not.toHaveBeenCalled();
  });

  it.each([{ source: "user" }, { rehydrate: true }])(
    "rejects unscoped client-owned navigation: %j",
    async (body) => {
      const request = makeNavigateCtx("settings", body, "", {
        unscoped: true,
      });
      await handleViewsRoutes(request.ctx);

      expect(request.error).toHaveBeenCalledWith(
        request.ctx.res,
        "User-owned navigation and rehydration require X-ElizaOS-Client-Id",
        400,
      );
      expect(getCurrentViewState()).toBeNull();
      expect(request.broadcastWs).not.toHaveBeenCalled();
    },
  );

  it("applies scoped user navigation last-write-wins without echo", async () => {
    const agent = makeNavigateCtx("settings", {}, "", {
      clientId: "client-a",
    });
    await handleViewsRoutes(agent.ctx);
    const user = makeNavigateCtx(
      "character",
      { source: "user", expectedRevision: 0 },
      "",
      { clientId: "client-a" },
    );

    await handleViewsRoutes(user.ctx);

    expect(getCurrentViewState("client-a")?.viewId).toBe("character");
    expect(getCurrentViewRevision("client-a")).toBe(2);
    expect(user.broadcastWs).not.toHaveBeenCalled();
    expect(user.broadcastWsToClientId).not.toHaveBeenCalled();
    expect(user.json).toHaveBeenCalledWith(
      user.ctx.res,
      expect.objectContaining({
        accepted: true,
        delivery: "client-owned",
        revision: 2,
      }),
    );
  });

  it("rejects mismatched canonical, legacy, and body identities before mutation", async () => {
    const headerMismatch = makeNavigateCtx(
      "settings",
      { expectedRevision: 0 },
      "",
      {
        clientId: "client-a",
        headers: { "x-eliza-client-id": "client-b" },
      },
    );
    await handleViewsRoutes(headerMismatch.ctx);
    expect(headerMismatch.error).toHaveBeenCalledWith(
      headerMismatch.ctx.res,
      "View client-id headers must match",
      400,
    );

    const bodyMismatch = makeNavigateCtx(
      "settings",
      { expectedRevision: 0, clientId: "client-b" },
      "",
      { clientId: "client-a" },
    );
    await handleViewsRoutes(bodyMismatch.ctx);
    expect(bodyMismatch.error).toHaveBeenCalledWith(
      bodyMismatch.ctx.res,
      "Header and body view client ids must match",
      400,
    );
    expect(getCurrentViewState("client-a")).toBeNull();
    expect(getCurrentViewState("client-b")).toBeNull();
    expect(headerMismatch.broadcastWsToClientId).not.toHaveBeenCalled();
    expect(bodyMismatch.broadcastWsToClientId).not.toHaveBeenCalled();
  });

  it("persists scoped offline navigation as pending without global broadcast", async () => {
    const request = makeNavigateCtx("settings", {}, "", {
      clientId: "offline-client",
    });
    request.broadcastWsToClientId.mockReturnValue(0);

    await handleViewsRoutes(request.ctx);

    expect(getCurrentViewState("offline-client")?.viewId).toBe("settings");
    expect(request.broadcastWs).not.toHaveBeenCalled();
    expect(request.json).toHaveBeenCalledWith(
      request.ctx.res,
      expect.objectContaining({ delivery: "pending", revision: 1 }),
    );
  });

  it("marks same-primary pending layout and subview destinations fresh for reconnect", async () => {
    const initial = makeNavigateCtx(
      "settings",
      {
        action: "split-view",
        panes: [
          { viewId: "settings", viewType: "gui" },
          { viewId: "character", viewType: "gui" },
        ],
        layout: "horizontal",
      },
      "",
      { clientId: "offline-client" },
    );
    await handleViewsRoutes(initial.ctx);
    const firstSwitchedAt = getCurrentViewState("offline-client")?.switchedAt;
    await new Promise((resolve) => setTimeout(resolve, 2));

    const changedLayout = makeNavigateCtx(
      "settings",
      {
        action: "split-view",
        panes: [
          { viewId: "settings", viewType: "gui" },
          { viewId: "documents", viewType: "gui" },
        ],
        layout: "vertical",
        subview: "voice",
      },
      "",
      { clientId: "offline-client" },
    );
    changedLayout.broadcastWsToClientId.mockReturnValue(0);
    await handleViewsRoutes(changedLayout.ctx);

    expect(changedLayout.error).not.toHaveBeenCalled();
    const state = getCurrentViewState("offline-client");
    expect(state?.switchedAt).not.toBe(firstSwitchedAt);
    expect(state).toMatchObject({
      viewId: "settings",
      subview: "voice",
      layout: "vertical",
      panes: [
        { viewId: "settings", viewType: "gui" },
        { viewId: "documents", viewType: "gui" },
      ],
    });
    expect(isViewSwitchFresh(state)).toBe(true);
    expect(changedLayout.broadcastWsToClientId).toHaveBeenCalledWith(
      "offline-client",
      expect.objectContaining({ revision: 2 }),
    );
    expect(changedLayout.json).toHaveBeenCalledWith(
      changedLayout.ctx.res,
      expect.objectContaining({ delivery: "pending", revision: 2 }),
    );
  });

  it("requires shell rehydration to compare-and-set the observed revision", async () => {
    const initial = makeNavigateCtx("settings", {}, "", {
      clientId: "client-a",
    });
    await handleViewsRoutes(initial.ctx);

    const missing = makeNavigateCtx("character", { rehydrate: true }, "", {
      clientId: "client-a",
    });
    await handleViewsRoutes(missing.ctx);
    expect(missing.error).toHaveBeenCalledWith(
      missing.ctx.res,
      'Missing "expectedRevision" for shell rehydration',
      400,
    );

    const stale = makeNavigateCtx(
      "character",
      { rehydrate: true, expectedRevision: 0 },
      "",
      { clientId: "client-a" },
    );
    await handleViewsRoutes(stale.ctx);
    expect(stale.json).toHaveBeenCalledWith(
      stale.ctx.res,
      expect.objectContaining({
        ok: false,
        conflict: true,
        revision: 1,
        currentView: expect.objectContaining({ viewId: "settings" }),
      }),
      409,
    );
    expect(getCurrentViewState("client-a")?.viewId).toBe("settings");
    expect(stale.broadcastWsToClientId).not.toHaveBeenCalled();
  });

  it("rejects unscoped agent navigation even when multiple clients are connected", async () => {
    const request = makeNavigateCtx("settings", {}, "", {
      recipientCount: 2,
      unscoped: true,
    });
    await handleViewsRoutes(request.ctx);

    expect(request.error).toHaveBeenCalledWith(
      request.ctx.res,
      "Agent-owned navigation requires X-ElizaOS-Client-Id",
      400,
    );
    expect(getCurrentViewState()).toBeNull();
    expect(request.broadcastWs).not.toHaveBeenCalled();
    expect(request.broadcastWsToClientId).not.toHaveBeenCalled();
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
      type: SHELL_NAVIGATE_VIEW_WS_EVENT,
      viewId: "ghost-view",
      viewPath: "/apps/ghost-view",
      viewLabel: "ghost-view",
      viewType: "gui",
      source: "agent",
      revision: 1,
    });
  });

  it("routes the synthetic __view-manager__ id to the /apps tab", async () => {
    const { ctx, broadcastWs } = makeNavigateCtx("__view-manager__", {});

    await expect(handleViewsRoutes(ctx)).resolves.toBe(true);

    expect(broadcastWs).toHaveBeenCalledWith(
      expect.objectContaining({
        type: SHELL_NAVIGATE_VIEW_WS_EVENT,
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

  it("dispatches interaction to the exact same-id modality", async () => {
    const guiInteract = vi.fn(async () => ({
      success: true,
      text: "GUI response",
    }));
    const tuiInteract = vi.fn(async () => ({
      success: true,
      text: "TUI response",
    }));
    await registerPluginViews(
      {
        name: "@test/views-route",
        description: "Exact interaction fixture.",
        views: [
          {
            id: "hybrid",
            label: "Hybrid GUI",
            viewType: "gui",
            capabilities: [{ id: "get-state", description: "Read GUI." }],
            serverInteract: guiInteract,
          },
          {
            id: "hybrid",
            label: "Hybrid TUI",
            viewType: "tui",
            capabilities: [{ id: "get-state", description: "Read TUI." }],
            serverInteract: tuiInteract,
          },
        ],
      },
      process.cwd(),
    );
    const request = makeInteractCtx(
      "hybrid",
      { capability: "get-state", viewType: "tui" },
      "?viewType=tui",
    );

    await handleViewsRoutes(request.ctx);

    expect(tuiInteract).toHaveBeenCalledTimes(1);
    expect(guiInteract).not.toHaveBeenCalled();
    expect(request.json).toHaveBeenCalledWith(
      request.ctx.res,
      expect.objectContaining({
        success: true,
        result: expect.objectContaining({ text: "TUI response" }),
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

  // ── #9945: settings subview deep-linking ──────────────────────────────────

  it("threads a body subview into the frame, response, and current state", async () => {
    const { ctx, json, broadcastWs } = makeNavigateCtx("settings", {
      subview: "voice",
    });

    await expect(handleViewsRoutes(ctx)).resolves.toBe(true);

    expect(broadcastWs).toHaveBeenCalledWith(
      expect.objectContaining({
        type: SHELL_NAVIGATE_VIEW_WS_EVENT,
        viewId: "settings",
        subview: "voice",
      }),
    );
    expect(json).toHaveBeenCalledWith(
      ctx.res,
      expect.objectContaining({
        ok: true,
        viewId: "settings",
        subview: "voice",
      }),
    );
    expect(getCurrentViewState()?.subview).toBe("voice");
  });

  it("accepts `section` as an alias for `subview`", async () => {
    const { ctx, broadcastWs } = makeNavigateCtx("settings", {
      section: "connectors",
    });

    await expect(handleViewsRoutes(ctx)).resolves.toBe(true);

    expect(broadcastWs).toHaveBeenCalledWith(
      expect.objectContaining({ viewId: "settings", subview: "connectors" }),
    );
  });

  it("omits subview from the frame when the body has none", async () => {
    const { ctx, broadcastWs } = makeNavigateCtx("settings", {});

    await expect(handleViewsRoutes(ctx)).resolves.toBe(true);

    const frame = broadcastWs.mock.calls[0][0] as Record<string, unknown>;
    expect("subview" in frame).toBe(false);
  });

  // ── #8788: turn-scoped "view switch just happened" stamp ──────────────────

  function makeCurrentCtx(clientId?: string): {
    ctx: ViewsRouteContext;
    json: ReturnType<typeof vi.fn>;
  } {
    const req = Readable.from([]) as unknown as http.IncomingMessage;
    req.headers = clientId ? { "x-elizaos-client-id": clientId } : {};
    const res = {} as http.ServerResponse;
    const json = vi.fn();
    const pathname = "/api/views/current";
    const ctx: ViewsRouteContext = {
      req,
      res,
      method: "GET",
      pathname,
      url: new URL(`http://local${pathname}`),
      json,
      error: vi.fn(),
      broadcastWs: vi.fn(),
    };
    return { ctx, json };
  }

  it("preserves one renderer's state across a reconnect with the same client id", async () => {
    const nav = makeNavigateCtx("settings", {}, "", {
      clientId: "reconnecting-client",
    });
    await handleViewsRoutes(nav.ctx);

    const reconnected = makeCurrentCtx("reconnecting-client");
    await handleViewsRoutes(reconnected.ctx);

    expect(reconnected.json).toHaveBeenCalledWith(
      reconnected.ctx.res,
      expect.objectContaining({
        currentView: expect.objectContaining({ viewId: "settings" }),
        revision: 1,
      }),
    );
  });

  it("retains an unacknowledged operation across disconnect and idle pruning", async () => {
    const clientId = "pending-reconnect-client";
    const nav = makeNavigateCtx(
      "settings",
      {
        deliveryOwner: "outbox",
        operationId: "views:pending-reconnect",
      },
      "",
      { clientId },
    );
    await handleViewsRoutes(nav.ctx);

    releaseCurrentViewScope(clientId);
    pruneIdleCurrentViewScopes(Date.now() + VIEW_SCOPE_IDLE_TTL_MS + 1);
    const reconnected = makeCurrentCtx(clientId);
    await handleViewsRoutes(reconnected.ctx);

    expect(reconnected.json).toHaveBeenCalledWith(
      reconnected.ctx.res,
      expect.objectContaining({
        revision: 1,
        pendingOperations: [
          expect.objectContaining({
            operationId: "views:pending-reconnect",
            operationRevision: 1,
          }),
        ],
      }),
    );
  });

  it("restores scoped view affinity only after the retained operation is acknowledged", async () => {
    const clientId = "ack-restores-context";
    const operationId = "views:ack-restores-context";
    const nav = makeNavigateCtx(
      "settings",
      { deliveryOwner: "outbox", operationId },
      "",
      { clientId },
    );
    await handleViewsRoutes(nav.ctx);

    releaseCurrentViewScope(clientId);
    expect(getActiveViewContext(clientId)).toBeNull();
    registerCurrentViewScopeWebSocket(clientId);
    expect(getActiveViewContext(clientId)).toBeNull();
    expect(
      setActiveViewElements(
        "settings",
        [{ id: "voice", role: "button", label: "Voice" }],
        clientId,
        "gui",
        clientId,
      ),
    ).toBe(false);

    const ack = makeOperationAckCtx(operationId, 1, clientId);
    await handleViewsRoutes(ack.ctx);

    expect(getActiveViewContext(clientId)).toMatchObject({
      viewId: "settings",
      viewType: "gui",
      clientId,
    });
    expect(
      setActiveViewElements(
        "settings",
        [{ id: "voice", role: "button", label: "Voice" }],
        clientId,
        "gui",
        clientId,
      ),
    ).toBe(true);
    expect(getActiveViewContext(clientId)?.elements).toEqual([
      { id: "voice", role: "button", label: "Voice" },
    ]);

    const nextOperationId = "views:ack-restores-next-context";
    const next = makeNavigateCtx(
      "character",
      { deliveryOwner: "outbox", operationId: nextOperationId },
      "",
      { clientId },
    );
    await handleViewsRoutes(next.ctx);
    releaseCurrentViewScope(clientId);

    const repeatedOldAck = makeOperationAckCtx(operationId, 1, clientId);
    await handleViewsRoutes(repeatedOldAck.ctx);
    expect(repeatedOldAck.json).toHaveBeenCalledWith(
      repeatedOldAck.ctx.res,
      expect.objectContaining({ alreadyAcked: true }),
    );
    expect(getActiveViewContext(clientId)).toBeNull();

    const nextAck = makeOperationAckCtx(nextOperationId, 2, clientId);
    await handleViewsRoutes(nextAck.ctx);
    expect(getActiveViewContext(clientId)).toMatchObject({
      viewId: "character",
      viewType: "gui",
      clientId,
    });
  });

  it("evicts an idle renderer scope instead of retaining stale navigation state", async () => {
    const nav = makeNavigateCtx("settings", {}, "", {
      clientId: "idle-client",
    });
    await handleViewsRoutes(nav.ctx);

    pruneIdleCurrentViewScopes(Date.now() + VIEW_SCOPE_IDLE_TTL_MS + 1);
    const afterIdle = makeCurrentCtx("idle-client");
    await handleViewsRoutes(afterIdle.ctx);

    expect(afterIdle.json).toHaveBeenCalledWith(
      afterIdle.ctx.res,
      expect.objectContaining({ currentView: null, revision: 0 }),
    );
  });

  it("does not let reads evict state and rejects overflow when every scope is connected", async () => {
    for (let index = 0; index < MAX_VIEW_STATE_SCOPES; index += 1) {
      const clientId = `connected-${index}`;
      const nav = makeNavigateCtx("settings", {}, "", { clientId });
      await handleViewsRoutes(nav.ctx);
      registerCurrentViewScopeWebSocket(clientId);
    }

    const readOnly = makeCurrentCtx("read-only-client");
    await handleViewsRoutes(readOnly.ctx);
    expect(readOnly.json).toHaveBeenCalledWith(
      readOnly.ctx.res,
      expect.objectContaining({ currentView: null, revision: 0 }),
    );
    expect(getCurrentViewState("connected-0")?.viewId).toBe("settings");

    const overflow = makeNavigateCtx("character", {}, "", {
      clientId: "overflow-client",
    });
    await handleViewsRoutes(overflow.ctx);
    expect(overflow.error).toHaveBeenCalledWith(
      overflow.ctx.res,
      "View state capacity is occupied by connected clients; retry after a client disconnects",
      503,
    );
    expect(getCurrentViewState("overflow-client")).toBeNull();
    expect(overflow.broadcastWsToClientId).not.toHaveBeenCalled();
  });

  it("keeps connected scopes during idle pruning while reclaiming REST-only state", async () => {
    const connected = makeNavigateCtx("settings", {}, "", {
      clientId: "connected-client",
    });
    const restOnly = makeNavigateCtx("character", {}, "", {
      clientId: "rest-client",
    });
    await handleViewsRoutes(connected.ctx);
    await handleViewsRoutes(restOnly.ctx);
    registerCurrentViewScopeWebSocket("connected-client");

    pruneIdleCurrentViewScopes(Date.now() + VIEW_SCOPE_IDLE_TTL_MS + 1);

    expect(getCurrentViewState("connected-client")?.viewId).toBe("settings");
    expect(getCurrentViewState("rest-client")).toBeNull();
  });

  it("stamps switchedAt + source=agent on navigate and reports justSwitched via GET current", async () => {
    const nav = makeNavigateCtx("settings", {});
    await handleViewsRoutes(nav.ctx);

    const state = getCurrentViewState();
    expect(typeof state?.switchedAt).toBe("string");
    expect(state?.source).toBe("agent");
    expect(isViewSwitchFresh(state)).toBe(true);

    const cur = makeCurrentCtx();
    await handleViewsRoutes(cur.ctx);
    expect(cur.json).toHaveBeenCalledWith(
      cur.ctx.res,
      expect.objectContaining({
        currentView: expect.objectContaining({ viewId: "settings" }),
        justSwitched: true,
      }),
    );
  });

  it("marks source=user and skips the shell echo for a user-reported switch", async () => {
    const nav = makeNavigateCtx("settings", { source: "user" }, "", {
      clientId: "user-client",
    });
    await handleViewsRoutes(nav.ctx);
    // State is recorded (so the agent observes the user's manual switch)...
    expect(getCurrentViewState("user-client")?.source).toBe("user");
    // ...but the shell:navigate:view echo is suppressed (the client already
    // navigated locally — re-broadcasting would loop).
    expect(nav.broadcastWs).not.toHaveBeenCalled();
  });

  it("re-stamps only when the normalized shell destination changes", async () => {
    const first = makeNavigateCtx("settings", {});
    await handleViewsRoutes(first.ctx);
    const switchedAt = getCurrentViewState()?.switchedAt;
    expect(typeof switchedAt).toBe("string");

    const second = makeNavigateCtx("settings", {});
    await handleViewsRoutes(second.ctx);
    expect(getCurrentViewState()?.switchedAt).toBe(switchedAt);

    await new Promise((resolve) => setTimeout(resolve, 2));
    const third = makeNavigateCtx("settings", { action: "pin-tab" });
    await handleViewsRoutes(third.ctx);
    expect(getCurrentViewState()?.switchedAt).not.toBe(switchedAt);
  });

  it("isViewSwitchFresh expires a stale switch after the freshness window", () => {
    const base: CurrentViewState = {
      viewId: "settings",
      viewPath: "/settings",
      viewLabel: "Settings",
      viewType: "gui",
      switchedAt: new Date(1_000_000).toISOString(),
      source: "agent",
      updatedAt: new Date(1_000_000).toISOString(),
    };
    // Within the window → fresh; past it → stale; missing stamp → never fresh.
    expect(isViewSwitchFresh(base, 1_000_000 + VIEW_SWITCH_FRESH_MS - 1)).toBe(
      true,
    );
    expect(isViewSwitchFresh(base, 1_000_000 + VIEW_SWITCH_FRESH_MS + 1)).toBe(
      false,
    );
    expect(isViewSwitchFresh({ ...base, switchedAt: undefined })).toBe(false);
    expect(isViewSwitchFresh(null)).toBe(false);
  });
});
