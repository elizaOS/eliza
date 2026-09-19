/** Verifies bindReadyPhase pty hydration readiness gate through the package's configured test harness. */
// @vitest-environment jsdom

/**
 * The ready-phase view-interact wiring (`startup-phase-hydrate.bindReadyPhase`):
 * agent-driven navigate-view WS events are dispatched to the shell and
 * view-interact requests are forwarded. jsdom with the API client and
 * view-interact dispatch mocked — no live agent.
 */
import {
  NAVIGATE_VIEW_EVENT,
  SHELL_NAVIGATE_VIEW_WS_EVENT,
} from "@elizaos/shared/events";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginInfo } from "../api";
import { RESYNC_EVENT } from "./AppContext.hooks";
import {
  bindReadyPhase,
  isCodingAgentFeatureEnabled,
  type ReadyPhaseDeps,
} from "./startup-phase-hydrate";

const clientMock = vi.hoisted(() => {
  const handlers = new Map<string, (data: Record<string, unknown>) => void>();
  return {
    connectWs: vi.fn(),
    disconnectWs: vi.fn(),
    getCodingAgentStatus: vi.fn(async () => ({ tasks: [] })),
    handlers,
    onWsEvent: vi.fn(
      (event: string, handler: (data: Record<string, unknown>) => void) => {
        handlers.set(event, handler);
        return () => {
          handlers.delete(event);
        };
      },
    ),
    sendWsMessage: vi.fn(),
  };
});

const viewInteractMock = vi.hoisted(() => ({
  dispatchViewInteract: vi.fn(async () => {}),
}));

vi.mock("../api", () => ({
  client: clientMock,
}));

vi.mock("../components/views/view-interact-registry", () => viewInteractMock);

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
    isCodingAgentFeatureAvailable: () => true,
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

describe("bindReadyPhase pty hydration readiness gate", () => {
  it("only polls coding-agent status once the agent is running", () => {
    clientMock.getCodingAgentStatus.mockClear();
    vi.useFakeTimers();
    try {
      const deps = makeDeps();
      const cleanup = bindReadyPhase({ current: deps });

      // Agent not running: the periodic poll must not touch the orchestrator/ACP
      // routes (they 404/503 during the boot window).
      vi.advanceTimersByTime(5_000);
      expect(clientMock.getCodingAgentStatus).not.toHaveBeenCalled();

      // Agent enters "running": the poll's catch-all hydrates exactly once.
      deps.agentRunningRef.current = true;
      vi.advanceTimersByTime(5_000);
      expect(clientMock.getCodingAgentStatus).toHaveBeenCalledTimes(1);

      cleanup();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not poll a disabled orchestrator feature even while the agent runs", () => {
    clientMock.getCodingAgentStatus.mockClear();
    vi.useFakeTimers();
    try {
      const deps = makeDeps();
      deps.isCodingAgentFeatureAvailable = () => false;
      deps.agentRunningRef.current = true;
      const cleanup = bindReadyPhase({ current: deps });

      vi.advanceTimersByTime(15_000);
      expect(clientMock.getCodingAgentStatus).not.toHaveBeenCalled();

      cleanup();
    } finally {
      vi.useRealTimers();
    }
  });

  it("hydrates when the feature becomes enabled after startup, and re-arms on disable", () => {
    clientMock.getCodingAgentStatus.mockClear();
    vi.useFakeTimers();
    try {
      let enabled = false;
      const deps = makeDeps();
      deps.isCodingAgentFeatureAvailable = () => enabled;
      deps.agentRunningRef.current = true;
      const cleanup = bindReadyPhase({ current: deps });

      vi.advanceTimersByTime(5_000);
      expect(clientMock.getCodingAgentStatus).not.toHaveBeenCalled();

      enabled = true;
      vi.advanceTimersByTime(5_000);
      expect(clientMock.getCodingAgentStatus).toHaveBeenCalledTimes(1);

      // Still active: no repeat while there are no live PTY sessions.
      vi.advanceTimersByTime(5_000);
      expect(clientMock.getCodingAgentStatus).toHaveBeenCalledTimes(1);

      // Disable then re-enable: the gate re-arms and hydrates again.
      enabled = false;
      vi.advanceTimersByTime(5_000);
      enabled = true;
      vi.advanceTimersByTime(5_000);
      expect(clientMock.getCodingAgentStatus).toHaveBeenCalledTimes(2);

      cleanup();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("isCodingAgentFeatureEnabled", () => {
  const plugin = (overrides: Partial<PluginInfo>): PluginInfo =>
    ({
      id: "agent-orchestrator",
      name: "Agent Orchestrator",
      enabled: false,
      ...overrides,
    }) as PluginInfo;

  it("requires the orchestrator plugin to be enabled or active", () => {
    expect(isCodingAgentFeatureEnabled([])).toBe(false);
    expect(isCodingAgentFeatureEnabled(undefined)).toBe(false);
    expect(
      isCodingAgentFeatureEnabled([
        plugin({ enabled: false, isActive: false }),
      ]),
    ).toBe(false);
    expect(isCodingAgentFeatureEnabled([plugin({ enabled: true })])).toBe(true);
    expect(
      isCodingAgentFeatureEnabled([plugin({ enabled: false, isActive: true })]),
    ).toBe(true);
  });

  it("ignores an unrelated plugin even when enabled", () => {
    expect(
      isCodingAgentFeatureEnabled([
        plugin({
          id: "other",
          name: "Other",
          npmName: "@elizaos/plugin-other",
          enabled: true,
        }),
      ]),
    ).toBe(false);
  });
});

describe("bindReadyPhase reconnect conversation hydration", () => {
  it("keeps the transcript until the restarted agent reports running", async () => {
    vi.useFakeTimers();
    try {
      const deps = makeDeps();
      deps.activeConversationIdRef.current = "conv-1";
      const onResync = vi.fn();
      window.addEventListener(RESYNC_EVENT, onResync);
      const cleanup = bindReadyPhase({ current: deps });

      clientMock.handlers.get("ws-reconnected")?.({});
      await Promise.resolve();

      expect(onResync).not.toHaveBeenCalled();
      expect(clientMock.sendWsMessage).toHaveBeenCalledWith({
        type: "active-conversation",
        conversationId: "conv-1",
      });

      clientMock.handlers.get("status")?.({
        state: "running",
        agentName: "Eliza",
      });
      expect(onResync).toHaveBeenCalledTimes(1);
      expect((onResync.mock.calls[0][0] as CustomEvent).detail).toEqual({
        conversationId: "conv-1",
        reason: "connection-recovered",
      });

      cleanup();
      window.removeEventListener(RESYNC_EVENT, onResync);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("bindReadyPhase view interaction bridge", () => {
  beforeEach(() => {
    clientMock.handlers.clear();
    clientMock.connectWs.mockClear();
    clientMock.disconnectWs.mockClear();
    clientMock.getCodingAgentStatus.mockClear();
    clientMock.onWsEvent.mockClear();
    clientMock.sendWsMessage.mockClear();
    viewInteractMock.dispatchViewInteract.mockClear();
  });

  it("routes view:interact websocket events through the view dispatcher", async () => {
    const cleanup = bindReadyPhase({ current: makeDeps() });

    clientMock.handlers.get("view:interact")?.({
      requestId: "req-1",
      viewId: "remote-ledger",
      viewType: "gui",
      capability: "get-state",
      params: { selector: "[data-view-state]" },
    });

    await vi.waitFor(
      () =>
        expect(viewInteractMock.dispatchViewInteract).toHaveBeenCalledWith(
          "remote-ledger",
          "gui",
          "get-state",
          { selector: "[data-view-state]" },
          "req-1",
        ),
      { timeout: 10_000 },
    );

    cleanup();
    expect(clientMock.disconnectWs).toHaveBeenCalled();
    expect(clientMock.handlers.has("view:interact")).toBe(false);
  }, 60_000);

  it("routes future headset view:interact websocket events through the view dispatcher", async () => {
    const cleanup = bindReadyPhase({ current: makeDeps() });

    clientMock.handlers.get("view:interact")?.({
      requestId: "req-xr-1",
      viewId: "spatial-room",
      viewType: "xr",
      capability: "get-state",
    });

    await vi.waitFor(
      () =>
        expect(viewInteractMock.dispatchViewInteract).toHaveBeenCalledWith(
          "spatial-room",
          "xr",
          "get-state",
          undefined,
          "req-xr-1",
        ),
      { timeout: 10_000 },
    );

    cleanup();
  }, 60_000);

  it("ignores malformed view:interact websocket events before dispatch", async () => {
    const cleanup = bindReadyPhase({ current: makeDeps() });

    clientMock.handlers.get("view:interact")?.({
      requestId: "req-missing-view",
      capability: "get-state",
    });
    clientMock.handlers.get("view:interact")?.({
      requestId: "req-array-params",
      viewId: "remote-ledger",
      capability: "get-state",
      params: ["not", "an", "object"],
    });

    await vi.waitFor(
      () =>
        expect(viewInteractMock.dispatchViewInteract).toHaveBeenCalledWith(
          "remote-ledger",
          undefined,
          "get-state",
          undefined,
          "req-array-params",
        ),
      { timeout: 10_000 },
    );
    expect(viewInteractMock.dispatchViewInteract).toHaveBeenCalledTimes(1);

    cleanup();
    expect(clientMock.handlers.has("view:interact")).toBe(false);
  }, 60_000);

  it("dispatches valid shell:navigate:view events to the browser shell", () => {
    const navHandler = vi.fn();
    window.addEventListener(NAVIGATE_VIEW_EVENT, navHandler);
    const cleanup = bindReadyPhase({ current: makeDeps() });

    clientMock.handlers.get(SHELL_NAVIGATE_VIEW_WS_EVENT)?.({
      viewId: "remote-ledger",
      viewPath: "/views/remote-ledger",
      viewLabel: "Remote Ledger",
      viewType: "gui",
      action: "pin-tab",
      alwaysOnTop: true,
    });

    expect(navHandler).toHaveBeenCalledTimes(1);
    const event = navHandler.mock.calls[0][0] as CustomEvent;
    expect(event.detail).toEqual({
      viewId: "remote-ledger",
      viewPath: "/views/remote-ledger",
      viewLabel: "Remote Ledger",
      viewType: "gui",
      action: "pin-tab",
      alwaysOnTop: true,
    });

    cleanup();
    window.removeEventListener(NAVIGATE_VIEW_EVENT, navHandler);
  });

  it("dispatches valid XR shell:navigate:view events to the browser shell", () => {
    const navHandler = vi.fn();
    window.addEventListener(NAVIGATE_VIEW_EVENT, navHandler);
    const cleanup = bindReadyPhase({ current: makeDeps() });

    clientMock.handlers.get(SHELL_NAVIGATE_VIEW_WS_EVENT)?.({
      viewId: "spatial-room",
      viewPath: "/apps/spatial-room",
      viewLabel: "Spatial Room",
      viewType: "xr",
    });

    expect(navHandler).toHaveBeenCalledTimes(1);
    const event = navHandler.mock.calls[0][0] as CustomEvent;
    expect(event.detail).toEqual({
      viewId: "spatial-room",
      viewPath: "/apps/spatial-room",
      viewLabel: "Spatial Room",
      viewType: "xr",
      action: undefined,
      alwaysOnTop: false,
    });

    cleanup();
    window.removeEventListener(NAVIGATE_VIEW_EVENT, navHandler);
  });

  it("normalizes malformed shell:navigate:view fields before dispatch", () => {
    const navHandler = vi.fn();
    window.addEventListener(NAVIGATE_VIEW_EVENT, navHandler);
    const cleanup = bindReadyPhase({ current: makeDeps() });

    clientMock.handlers.get(SHELL_NAVIGATE_VIEW_WS_EVENT)?.({
      viewId: 12,
      viewPath: false,
      viewLabel: null,
      viewType: "web",
      action: ["pin-tab"],
      alwaysOnTop: "true",
    });

    expect(navHandler).toHaveBeenCalledTimes(1);
    const event = navHandler.mock.calls[0][0] as CustomEvent;
    expect(event.detail).toEqual({
      viewId: undefined,
      viewPath: undefined,
      viewLabel: undefined,
      viewType: undefined,
      action: undefined,
      alwaysOnTop: false,
    });

    cleanup();
    window.removeEventListener(NAVIGATE_VIEW_EVENT, navHandler);
  });
});
