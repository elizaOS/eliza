// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { clientMock, wsHandlers } = vi.hoisted(() => {
  const handlers = new Map<string, (data: Record<string, unknown>) => void>();
  const client = {
    getCodingAgentStatus: vi.fn(async () => ({ tasks: [] })),
    connectWs: vi.fn(),
    disconnectWs: vi.fn(),
    getConfig: vi.fn(async () => ({})),
    getStreamSettings: vi.fn(async () => ({ settings: { avatarIndex: 1 } })),
    getWalletAddresses: vi.fn(async () => ({})),
    hasCustomBackground: vi.fn(async () => false),
    hasCustomVrm: vi.fn(async () => false),
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

vi.mock("../components/companion/injected", () => ({
  prefetchVrmToCache: vi.fn(async () => undefined),
}));

import type { HydratingDeps, ReadyPhaseDeps } from "./startup-phase-hydrate";
import { bindReadyPhase, runHydrating } from "./startup-phase-hydrate";

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

function createHydratingDeps(
  overrides: Partial<HydratingDeps> = {},
): HydratingDeps {
  return {
    setStartupError: vi.fn(),
    setOnboardingLoading: vi.fn(),
    hydrateInitialConversationState: vi.fn(async () => null),
    requestGreetingWhenRunningRef: { current: vi.fn(async () => undefined) },
    loadWorkbench: vi.fn(async () => undefined),
    loadPlugins: vi.fn(async () => undefined),
    loadSkills: vi.fn(async () => undefined),
    loadCharacter: vi.fn(async () => undefined),
    loadWalletConfig: vi.fn(async () => undefined),
    loadInventory: vi.fn(async () => undefined),
    loadUpdateStatus: vi.fn(async () => undefined),
    checkExtensionStatus: vi.fn(async () => undefined),
    pollCloudCredits: vi.fn(),
    fetchAutonomyReplay: vi.fn(async () => undefined),
    setSelectedVrmIndex: vi.fn(),
    setCustomVrmUrl: vi.fn(),
    setCustomBackgroundUrl: vi.fn(),
    setWalletAddresses: vi.fn(),
    setTab: vi.fn(),
    setTabRaw: vi.fn(),
    onboardingCompletionCommittedRef: { current: false },
    initialTabSetRef: { current: false },
    onboardingMode: "basic",
    ...overrides,
  };
}

describe("bindReadyPhase wallet recovery", () => {
  beforeEach(() => {
    wsHandlers.clear();
    vi.clearAllMocks();
    window.history.replaceState(null, "", "/");
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

  it("tracks hash navigation inside desktop app windows", () => {
    window.history.replaceState(null, "", "/?appWindow=1#/apps/plugin-viewer");
    const deps = createReadyDeps();
    const cleanup = bindReadyPhase({
      current: deps,
    });

    window.location.hash = "#/apps/skills";
    window.dispatchEvent(new HashChangeEvent("hashchange"));

    expect(deps.setTabRaw).toHaveBeenCalledWith("skills");

    cleanup();
  });
});

describe("runHydrating app-window routing", () => {
  beforeEach(() => {
    wsHandlers.clear();
    vi.clearAllMocks();
    window.history.replaceState(null, "", "/");
  });

  it("keeps app windows on their hash route instead of forcing chat", async () => {
    window.history.replaceState(null, "", "/?appWindow=1#/apps/plugin-viewer");
    const deps = createHydratingDeps();

    await runHydrating(deps, vi.fn(), { current: false });

    expect(deps.setTab).not.toHaveBeenCalledWith("chat");
    expect(deps.setTabRaw).toHaveBeenCalledWith("apps");
  });
});
