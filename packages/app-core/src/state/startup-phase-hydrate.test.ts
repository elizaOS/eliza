// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { clientMock, wsHandlers } = vi.hoisted(() => {
  const handlers = new Map<string, (data: Record<string, unknown>) => void>();
  const client = {
    getCodingAgentStatus: vi.fn(async () => ({ tasks: [] })),
    connectWs: vi.fn(),
    disconnectWs: vi.fn(),
    onWsEvent: vi.fn(
      (event: string, handler: (data: Record<string, unknown>) => void) => {
        handlers.set(event, handler);
        return () => {
          handlers.delete(event);
        };
      },
    ),
  };

  return { clientMock: client, wsHandlers: handlers };
});

vi.mock("../api", () => ({
  client: clientMock,
}));

vi.mock("../coding", () => ({
  mapServerTasksToSessions: vi.fn(() => []),
}));

vi.mock("../events", () => ({
  dispatchAppEmoteEvent: vi.fn(),
}));

import type { ReadyPhaseDeps } from "./startup-phase-hydrate";
import { bindReadyPhase } from "./startup-phase-hydrate";

function createReadyDeps(
  overrides: Partial<ReadyPhaseDeps> = {},
): ReadyPhaseDeps {
  return {
    setAgentStatusIfChanged: vi.fn(),
    setPendingRestart: vi.fn(),
    setPendingRestartReasons: vi.fn(),
    setSystemWarnings: vi.fn(),
    showRestartBanner: vi.fn(),
    setPtySessions: vi.fn(),
    hasPtySessionsRef: { current: false },
    setTabRaw: vi.fn(),
    setConversationMessages: vi.fn(),
    setUnreadConversations: vi.fn(),
    setConversations: vi.fn(),
    appendAutonomousEvent: vi.fn(),
    notifyAssistantEvent: vi.fn(),
    notifyHeartbeatEvent: vi.fn(),
    loadPlugins: vi.fn(async () => undefined),
    loadWalletConfig: vi.fn(async () => undefined),
    pollCloudCredits: vi.fn(),
    activeConversationIdRef: { current: null },
    elizaCloudPollInterval: { current: null },
    elizaCloudLoginPollTimer: { current: null },
    ...overrides,
  };
}

describe("bindReadyPhase wallet recovery", () => {
  beforeEach(() => {
    wsHandlers.clear();
    vi.clearAllMocks();
  });

  afterEach(() => {
    wsHandlers.clear();
  });

  it("reloads wallet config when the websocket reconnects", async () => {
    const deps = createReadyDeps();
    const cleanup = bindReadyPhase({
      current: deps,
    });

    wsHandlers.get("ws-reconnected")?.({ type: "ws-reconnected" });
    await Promise.resolve();

    expect(deps.loadWalletConfig).toHaveBeenCalledTimes(1);
    expect(deps.pollCloudCredits).toHaveBeenCalledTimes(1);

    cleanup();
  });

  it("reloads wallet config after a restarted status event", async () => {
    const deps = createReadyDeps();
    const cleanup = bindReadyPhase({
      current: deps,
    });

    wsHandlers.get("status")?.({
      state: "running",
      agentName: "Milady",
      restarted: true,
    });
    await Promise.resolve();

    expect(deps.loadPlugins).toHaveBeenCalledTimes(1);
    expect(deps.loadWalletConfig).toHaveBeenCalledTimes(1);
    expect(deps.pollCloudCredits).toHaveBeenCalledTimes(1);
    expect(deps.setPendingRestart).toHaveBeenCalledWith(false);
    expect(deps.setPendingRestartReasons).toHaveBeenCalledWith([]);

    cleanup();
  });

  it("rehydrates PTY sessions immediately after an error event", async () => {
    const setPtySessions = vi.fn();
    const deps = createReadyDeps({
      setPtySessions,
      hasPtySessionsRef: { current: true },
    });
    const cleanup = bindReadyPhase({
      current: deps,
    });

    expect(clientMock.getCodingAgentStatus).toHaveBeenCalledTimes(1);

    wsHandlers.get("pty-session-event")?.({
      eventType: "error",
      sessionId: "ghost-session",
      data: { message: "Cannot create process, error code: 2" },
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(clientMock.getCodingAgentStatus).toHaveBeenCalledTimes(2);

    cleanup();
  });
});
