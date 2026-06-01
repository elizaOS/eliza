// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";
import { bindReadyPhase, type ReadyPhaseDeps } from "./startup-phase-hydrate";

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
    window.addEventListener("eliza:navigate:view", navHandler);
    const cleanup = bindReadyPhase({ current: makeDeps() });

    clientMock.handlers.get("shell:navigate:view")?.({
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
    window.removeEventListener("eliza:navigate:view", navHandler);
  });

  it("normalizes malformed shell:navigate:view fields before dispatch", () => {
    const navHandler = vi.fn();
    window.addEventListener("eliza:navigate:view", navHandler);
    const cleanup = bindReadyPhase({ current: makeDeps() });

    clientMock.handlers.get("shell:navigate:view")?.({
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
    window.removeEventListener("eliza:navigate:view", navHandler);
  });
});
