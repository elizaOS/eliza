// @vitest-environment jsdom

import {
  NAVIGATE_VIEW_EVENT,
  SHELL_NAVIGATE_VIEW_WS_EVENT,
} from "@elizaos/shared/events";
import { beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import { bindReadyPhase, type ReadyPhaseDeps } from "./startup-phase-hydrate";

// Integration coverage for the full frontend ingestion of an agent-driven view
// switch: a *raw* WebSocket frame (the literal JSON the agent backend emits via
// broadcastWs({ type: SHELL_NAVIGATE_VIEW_WS_EVENT, ... }) at
// packages/agent/src/api/views-routes.ts:788) is dispatched exactly the way the
// real ElizaClient does it — JSON.parse(event.data), read `data.type`, fan out
// to handlers registered for that type (client-base.ts:836-859) — and handed to
// the real `bindReadyPhase` SHELL_NAVIGATE_VIEW_WS_EVENT handler
// (startup-phase-hydrate.ts:414), which must re-dispatch a normalized DOM
// `eliza:navigate:view` CustomEvent.
//
// The sibling startup-phase-hydrate.view-interact.test.ts feeds *pre-parsed*
// objects straight into the handler map. This file proves the missing seam: the
// server's wire frame, carrying the `type` discriminator and the server's
// conditional field omission, actually reaches the handler keyed by its `type`
// and survives untrusted-input normalization end to end.

// Faithful re-implementation of ElizaClient's WS message routing
// (client-base.ts:836-859) so we can feed a literal JSON string frame. This is
// the boundary under test — kept intentionally tiny and mirrored from source.
const clientMock = vi.hoisted(() => {
  const wsHandlers = new Map<
    string,
    Set<(data: Record<string, unknown>) => void>
  >();
  return {
    connectWs: vi.fn(),
    disconnectWs: vi.fn(),
    getCodingAgentStatus: vi.fn(async () => ({ tasks: [] })),
    onWsEvent: vi.fn(
      (type: string, handler: (data: Record<string, unknown>) => void) => {
        if (!wsHandlers.has(type)) wsHandlers.set(type, new Set());
        wsHandlers.get(type)?.add(handler);
        return () => {
          wsHandlers.get(type)?.delete(handler);
        };
      },
    ),
    sendWsMessage: vi.fn(),
    wsHandlers,
    /** Deliver a raw server frame exactly as ElizaClient.onmessage would. */
    deliverFrame(raw: string) {
      let data: Record<string, unknown>;
      try {
        data = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        return; // ElizaClient swallows parse errors (client-base.ts:856)
      }
      const type = data.type as string;
      for (const handler of wsHandlers.get(type) ?? []) handler(data);
      for (const handler of wsHandlers.get("*") ?? []) handler(data);
    },
  };
});

vi.mock("../api", () => ({ client: clientMock }));
vi.mock("../components/views/view-interact-registry", () => ({
  dispatchViewInteract: vi.fn(async () => {}),
}));

function makeDeps(): ReadyPhaseDeps {
  return {
    setActionNotice: vi.fn(),
    setAgentStatusIfChanged: vi.fn(),
    setPendingRestart: vi.fn(),
    setPendingRestartReasons: vi.fn(),
    setSystemWarnings: vi.fn(),
    showRestartBanner: vi.fn(),
    setPtySessions: vi.fn(),
    hasPtySessionsRef: { current: false },
    agentRunningRef: { current: false },
    setTabRaw: vi.fn(),
    setConversationMessages: vi.fn(),
    setUnreadConversations: vi.fn(),
    setConversations: vi.fn(),
    appendAutonomousEvent: vi.fn(),
    notifyHeartbeatEvent: vi.fn(),
    loadPlugins: vi.fn(async () => {}),
    loadWalletConfig: vi.fn(async () => {}),
    pollCloudCredits: vi.fn(),
    activeConversationIdRef: { current: null },
    elizaCloudPollInterval: { current: null },
    elizaCloudLoginPollTimer: { current: null },
  };
}

describe("agent view-switch raw WS frame to DOM navigate event", () => {
  let navHandler: Mock;
  let cleanup: () => void;

  beforeEach(() => {
    clientMock.wsHandlers.clear();
    clientMock.connectWs.mockClear();
    clientMock.disconnectWs.mockClear();
    clientMock.onWsEvent.mockClear();
    navHandler = vi.fn();
    window.addEventListener(NAVIGATE_VIEW_EVENT, navHandler);
    cleanup = bindReadyPhase({ current: makeDeps() });
  });

  function teardown() {
    cleanup();
    window.removeEventListener(NAVIGATE_VIEW_EVENT, navHandler);
  }

  it("registers a shell:navigate:view handler on ready-phase start", () => {
    expect(clientMock.wsHandlers.has(SHELL_NAVIGATE_VIEW_WS_EVENT)).toBe(true);
    teardown();
  });

  it("normalizes a full backend pin-tab frame carrying the type discriminator", () => {
    // Mirrors broadcastWs(...) when the navigate body has action + alwaysOnTop.
    clientMock.deliverFrame(
      JSON.stringify({
        type: SHELL_NAVIGATE_VIEW_WS_EVENT,
        viewId: "remote-ledger",
        viewPath: "/views/remote-ledger",
        viewLabel: "Remote Ledger",
        viewType: "gui",
        action: "pin-tab",
        alwaysOnTop: true,
      }),
    );

    expect(navHandler).toHaveBeenCalledTimes(1);
    const detail = (navHandler.mock.calls[0][0] as CustomEvent).detail;
    expect(detail).toEqual({
      viewId: "remote-ledger",
      viewPath: "/views/remote-ledger",
      viewLabel: "Remote Ledger",
      viewType: "gui",
      action: "pin-tab",
      alwaysOnTop: true,
    });
    teardown();
  });

  it("forwards a settings subview from the raw frame into the DOM event (#9945)", () => {
    clientMock.deliverFrame(
      JSON.stringify({
        type: SHELL_NAVIGATE_VIEW_WS_EVENT,
        viewId: "settings",
        viewPath: "/settings",
        viewLabel: "Settings",
        viewType: "gui",
        subview: "voice",
      }),
    );

    expect(navHandler).toHaveBeenCalledTimes(1);
    const detail = (navHandler.mock.calls[0][0] as CustomEvent).detail;
    expect(detail.viewId).toBe("settings");
    expect(detail.subview).toBe("voice");
    teardown();
  });

  it("fills defaults when the backend omits action and alwaysOnTop", () => {
    // The backend spreads `action`/`alwaysOnTop` only when truthy
    // (views-routes.ts:794-795), so a plain `show` navigation omits both keys.
    clientMock.deliverFrame(
      JSON.stringify({
        type: SHELL_NAVIGATE_VIEW_WS_EVENT,
        viewId: "settings",
        viewPath: "/settings",
        viewLabel: "Settings",
        viewType: "gui",
      }),
    );

    expect(navHandler).toHaveBeenCalledTimes(1);
    const detail = (navHandler.mock.calls[0][0] as CustomEvent).detail;
    expect(detail).toEqual({
      viewId: "settings",
      viewPath: "/settings",
      viewLabel: "Settings",
      viewType: "gui",
      action: undefined,
      alwaysOnTop: false,
    });
    teardown();
  });

  it("drops untrusted non-string / wrong-typed fields from a raw frame", () => {
    clientMock.deliverFrame(
      JSON.stringify({
        type: SHELL_NAVIGATE_VIEW_WS_EVENT,
        viewId: 42,
        viewPath: { nested: "x" },
        viewLabel: ["arr"],
        viewType: "web",
        action: 7,
        alwaysOnTop: "yes",
      }),
    );

    expect(navHandler).toHaveBeenCalledTimes(1);
    const detail = (navHandler.mock.calls[0][0] as CustomEvent).detail;
    expect(detail).toEqual({
      viewId: undefined,
      viewPath: undefined,
      viewLabel: undefined,
      viewType: undefined,
      action: undefined,
      alwaysOnTop: false,
    });
    teardown();
  });

  it("forwards the split/tile layout fields so a multi-view action keeps every view", () => {
    // Mirrors broadcastWs(...) for POST /api/views/:id/navigate with
    // action:"tile-views" — the server spreads `layoutPayload`
    // (views/layout/placement, views-routes.ts) into the frame. Dropping any
    // of them here degrades an agent "tile A and B" to a single view.
    clientMock.deliverFrame(
      JSON.stringify({
        type: SHELL_NAVIGATE_VIEW_WS_EVENT,
        viewId: "browser",
        viewPath: "/apps/browser",
        viewLabel: "Browser",
        viewType: "gui",
        action: "tile-views",
        views: ["browser", "wallet"],
        layout: "horizontal",
        placement: "left",
      }),
    );

    expect(navHandler).toHaveBeenCalledTimes(1);
    const detail = (navHandler.mock.calls[0][0] as CustomEvent).detail;
    expect(detail.action).toBe("tile-views");
    expect(detail.views).toEqual(["browser", "wallet"]);
    expect(detail.layout).toBe("horizontal");
    expect(detail.placement).toBe("left");
    teardown();
  });

  it("sanitizes untrusted layout fields (non-string views entries, wrong types)", () => {
    clientMock.deliverFrame(
      JSON.stringify({
        type: SHELL_NAVIGATE_VIEW_WS_EVENT,
        viewId: "browser",
        viewPath: "/apps/browser",
        viewType: "gui",
        action: "split-view",
        views: ["browser", 7, "", null, "wallet"],
        layout: 42,
        placement: ["top"],
      }),
    );

    expect(navHandler).toHaveBeenCalledTimes(1);
    const detail = (navHandler.mock.calls[0][0] as CustomEvent).detail;
    expect(detail.views).toEqual(["browser", "wallet"]);
    expect(detail.layout).toBeUndefined();
    expect(detail.placement).toBeUndefined();
    teardown();
  });

  it("omits the layout fields on a plain single-view frame", () => {
    clientMock.deliverFrame(
      JSON.stringify({
        type: SHELL_NAVIGATE_VIEW_WS_EVENT,
        viewId: "settings",
        viewPath: "/settings",
        viewType: "gui",
      }),
    );

    expect(navHandler).toHaveBeenCalledTimes(1);
    const detail = (navHandler.mock.calls[0][0] as CustomEvent).detail;
    expect(detail.views).toBeUndefined();
    expect(detail.layout).toBeUndefined();
    expect(detail.placement).toBeUndefined();
    teardown();
  });

  it("routes an xr view frame through the same type dispatch", () => {
    clientMock.deliverFrame(
      JSON.stringify({
        type: SHELL_NAVIGATE_VIEW_WS_EVENT,
        viewId: "spatial-room",
        viewPath: "/apps/spatial-room",
        viewLabel: "Spatial Room",
        viewType: "xr",
      }),
    );

    expect(navHandler).toHaveBeenCalledTimes(1);
    const detail = (navHandler.mock.calls[0][0] as CustomEvent).detail;
    expect(detail.viewId).toBe("spatial-room");
    expect(detail.viewType).toBe("xr");
    teardown();
  });

  it("swallows malformed JSON without throwing or dispatching", () => {
    expect(() => clientMock.deliverFrame("not-json{")).not.toThrow();
    expect(navHandler).not.toHaveBeenCalled();
    teardown();
  });

  it("does not dispatch a navigate event for an unrelated frame type", () => {
    clientMock.deliverFrame(
      JSON.stringify({ type: "agent-status", state: "running" }),
    );
    expect(navHandler).not.toHaveBeenCalled();
    teardown();
  });

  it("unbinds the shell:navigate:view handler on ready-phase cleanup", () => {
    cleanup();
    // Real ElizaClient unbind deletes the handler from the per-type Set but
    // leaves the (now empty) Set in the map, so assert no live handlers remain.
    expect(
      clientMock.wsHandlers.get(SHELL_NAVIGATE_VIEW_WS_EVENT)?.size ?? 0,
    ).toBe(0);

    clientMock.deliverFrame(
      JSON.stringify({
        type: SHELL_NAVIGATE_VIEW_WS_EVENT,
        viewId: "remote-ledger",
        viewPath: "/views/remote-ledger",
        viewType: "gui",
      }),
    );
    expect(navHandler).not.toHaveBeenCalled();
    window.removeEventListener(NAVIGATE_VIEW_EVENT, navHandler);
  });
});
