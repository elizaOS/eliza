// @vitest-environment jsdom

import { beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import { bindReadyPhase, type ReadyPhaseDeps } from "./startup-phase-hydrate";

// Integration coverage for the full frontend ingestion of an agent-driven view
// switch: a *raw* WebSocket frame (the literal JSON the agent backend emits via
// broadcastWs({ type: "shell:navigate:view", ... }) at
// packages/agent/src/api/views-routes.ts:788) is dispatched exactly the way the
// real ElizaClient does it — JSON.parse(event.data), read `data.type`, fan out
// to handlers registered for that type (client-base.ts:836-859) — and handed to
// the real `bindReadyPhase` "shell:navigate:view" handler
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
    notifyAssistantEvent: vi.fn(),
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
    window.addEventListener("eliza:navigate:view", navHandler);
    cleanup = bindReadyPhase({ current: makeDeps() });
  });

  function teardown() {
    cleanup();
    window.removeEventListener("eliza:navigate:view", navHandler);
  }

  it("registers a shell:navigate:view handler on ready-phase start", () => {
    expect(clientMock.wsHandlers.has("shell:navigate:view")).toBe(true);
    teardown();
  });

  it("normalizes a full backend pin-tab frame carrying the type discriminator", () => {
    // Mirrors broadcastWs(...) when the navigate body has action + alwaysOnTop.
    clientMock.deliverFrame(
      JSON.stringify({
        type: "shell:navigate:view",
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

  it("preserves split/tile layout metadata from backend navigate frames", () => {
    clientMock.deliverFrame(
      JSON.stringify({
        type: "shell:navigate:view",
        viewId: "notes",
        viewPath: "/notes",
        viewLabel: "Notes",
        viewType: "gui",
        action: "split-view",
        views: [" notes ", "calendar", "", 7],
        layout: " horizontal ",
        placement: " right ",
      }),
    );

    expect(navHandler).toHaveBeenCalledTimes(1);
    const detail = (navHandler.mock.calls[0][0] as CustomEvent).detail;
    expect(detail).toEqual({
      viewId: "notes",
      viewPath: "/notes",
      viewLabel: "Notes",
      viewType: "gui",
      action: "split-view",
      alwaysOnTop: false,
      views: ["notes", "calendar"],
      layout: "horizontal",
      placement: "right",
    });
    teardown();
  });

  it("fills defaults when the backend omits action and alwaysOnTop", () => {
    // The backend spreads `action`/`alwaysOnTop` only when truthy
    // (views-routes.ts:794-795), so a plain `show` navigation omits both keys.
    clientMock.deliverFrame(
      JSON.stringify({
        type: "shell:navigate:view",
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
        type: "shell:navigate:view",
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

  it("routes an xr view frame through the same type dispatch", () => {
    clientMock.deliverFrame(
      JSON.stringify({
        type: "shell:navigate:view",
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
    expect(clientMock.wsHandlers.get("shell:navigate:view")?.size ?? 0).toBe(0);

    clientMock.deliverFrame(
      JSON.stringify({
        type: "shell:navigate:view",
        viewId: "remote-ledger",
        viewPath: "/views/remote-ledger",
        viewType: "gui",
      }),
    );
    expect(navHandler).not.toHaveBeenCalled();
    window.removeEventListener("eliza:navigate:view", navHandler);
  });
});
