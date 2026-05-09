// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const {
  addAgentProfileMock,
  agentStartMock,
  clearPersistedActiveServerMock,
  clientMock,
  completeOnboardingMock,
  platformState,
  persistMobileRuntimeModeForServerTargetMock,
  savePersistedActiveServerMock,
  setStateMock,
  shouldShowLocalOptionMock,
  startupDispatchMock,
  useAppMock,
} = vi.hoisted(() => ({
  addAgentProfileMock: vi.fn(),
  agentStartMock: vi.fn(async () => ({
    state: "starting",
    agentName: null,
    port: 31337,
    startedAt: null,
    error: null,
  })),
  clearPersistedActiveServerMock: vi.fn(),
  clientMock: {
    getCloudCompatAgents: vi.fn(),
    getCloudCompatAgent: vi.fn(),
    createCloudCompatAgent: vi.fn(),
    provisionCloudCompatAgent: vi.fn(),
    getCloudCompatJobStatus: vi.fn(),
    getCloudCompatAgentStatus: vi.fn(),
    getRestAuthToken: vi.fn(() => null),
    switchProvider: vi.fn(),
    setBaseUrl: vi.fn(),
    setToken: vi.fn(),
  },
  completeOnboardingMock: vi.fn(),
  platformState: {
    isAndroid: false,
    isDesktop: false,
    isElizaOS: false,
    isIOS: false,
  },
  persistMobileRuntimeModeForServerTargetMock: vi.fn(),
  savePersistedActiveServerMock: vi.fn(),
  setStateMock: vi.fn(),
  shouldShowLocalOptionMock: vi.fn(async () => false),
  startupDispatchMock: vi.fn(),
  useAppMock: vi.fn(),
}));

vi.mock("react", async () => {
  const { createRequire } = await import("node:module");
  const require = createRequire(import.meta.url);
  return require("react") as typeof import("react");
});

vi.mock("react/jsx-runtime", async () => {
  const { createRequire } = await import("node:module");
  const require = createRequire(import.meta.url);
  return require("react/jsx-runtime") as typeof import("react/jsx-runtime");
});

vi.mock("../../api", () => ({
  client: clientMock,
}));

vi.mock("../../state", () => ({
  useApp: () => useAppMock(),
  savePersistedActiveServer: savePersistedActiveServerMock,
  addAgentProfile: addAgentProfileMock,
  clearPersistedActiveServer: clearPersistedActiveServerMock,
}));

vi.mock("../../bridge/gateway-discovery", () => ({
  discoverGatewayEndpoints: vi.fn(async () => []),
  gatewayEndpointToApiBase: vi.fn(),
}));

vi.mock("../../onboarding/mobile-runtime-mode", () => ({
  ANDROID_LOCAL_AGENT_API_BASE: "http://127.0.0.1:31337",
  ANDROID_LOCAL_AGENT_LABEL: "On-device agent",
  ANDROID_LOCAL_AGENT_SERVER_ID: "local:android",
  MOBILE_LOCAL_AGENT_API_BASE: "http://127.0.0.1:31337",
  MOBILE_LOCAL_AGENT_LABEL: "On-device agent",
  MOBILE_RUNTIME_MODE_STORAGE_KEY: "eliza:mobile-runtime-mode",
  MOBILE_LOCAL_AGENT_SERVER_ID: "local:mobile",
  persistMobileRuntimeModeForServerTarget:
    persistMobileRuntimeModeForServerTargetMock,
}));

vi.mock("@capacitor/core", () => ({
  registerPlugin: vi.fn(() => ({
    start: agentStartMock,
  })),
  Capacitor: {
    Plugins: {
      Agent: {
        start: agentStartMock,
      },
    },
    getPlatform: vi.fn(() => "web"),
    isNativePlatform: vi.fn(() => false),
    registerPlugin: vi.fn(() => ({
      start: agentStartMock,
    })),
  },
}));

vi.mock("../../onboarding/probe-local-agent", () => ({
  shouldShowLocalOption: shouldShowLocalOptionMock,
}));

vi.mock("../../platform/init", () => ({
  isDesktopPlatform: vi.fn(() => platformState.isDesktop),
  get isAndroid() {
    return platformState.isAndroid;
  },
  get isIOS() {
    return platformState.isIOS;
  },
  isElizaOS: vi.fn(() => platformState.isElizaOS),
}));

vi.mock("../../utils", () => ({
  preOpenWindow: vi.fn(() => null),
  resolveAppAssetUrl: (path: string) => path,
  // Returning undefined makes resolveLocalAgentApiBase fall back to the
  // default 127.0.0.1:31337, which is what the tests want — they don't
  // exercise the apiBase-pushed-from-Electrobun path.
  getElizaApiBase: vi.fn(() => undefined),
}));

vi.mock("../shared/LanguageDropdown", () => ({
  LanguageDropdown: () => null,
}));

vi.mock("@elizaos/app-wallet", () => {
  const noop = vi.fn();
  return {
    InventoryView: () => null,
    TokenLogo: () => null,
    buildWalletRpcUpdateRequest: vi.fn((value: unknown) => value),
    resolveInitialWalletRpcSelections: vi.fn(() => ({})),
    useInventoryData: vi.fn(() => ({ rows: [], loading: false })),
    useWalletState: vi.fn(() => ({
      state: {
        browserEnabled: false,
        computerUseEnabled: false,
        walletEnabled: false,
        walletAddresses: {},
        walletConfig: null,
        walletBalances: null,
        walletNfts: [],
        walletLoading: false,
        walletNftsLoading: false,
        inventoryView: "tokens",
        walletExportData: null,
        walletExportVisible: false,
        walletApiKeySaving: false,
        inventorySort: "value",
        inventorySortDirection: "desc",
        inventoryChainFilters: [],
        walletError: null,
        registryStatus: null,
        registryLoading: false,
        registryRegistering: false,
        registryError: null,
        dropStatus: null,
        dropLoading: false,
        mintInProgress: false,
        mintResult: null,
        mintError: null,
        mintShiny: false,
        whitelistStatus: null,
        whitelistLoading: false,
        wallets: [],
        walletPrimary: null,
        walletPrimaryRestarting: false,
        walletPrimaryPending: false,
        cloudRefreshing: false,
      },
      setBrowserEnabled: noop,
      setComputerUseEnabled: noop,
      setWalletEnabled: noop,
      setWalletAddresses: noop,
      setInventoryView: noop,
      setInventorySort: noop,
      setInventorySortDirection: noop,
      setInventoryChainFilters: noop,
      loadWalletConfig: noop,
      loadBalances: noop,
      loadNfts: noop,
      handleWalletApiKeySave: noop,
      handleExportKeys: noop,
      loadRegistryStatus: noop,
      registerOnChain: noop,
      syncRegistryProfile: noop,
      loadDropStatus: noop,
      mintFromDrop: noop,
      loadWhitelistStatus: noop,
      setPrimary: noop,
      refreshCloud: noop,
    })),
  };
});

import { RuntimeGate, resolveRuntimeChoices } from "./RuntimeGate";

const RUNNING_AGENT = {
  agent_id: "agent-1",
  agent_name: "My Agent",
  status: "running",
  bridge_url: "https://agent-1.elizacloud.ai",
  web_ui_url: null,
  webUiUrl: null,
  containerUrl: "",
  error_message: null,
  agent_config: {},
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-01T00:00:00.000Z",
  database_status: "ready",
  last_heartbeat_at: null,
};

const STOPPED_AGENT = {
  ...RUNNING_AGENT,
  status: "stopped",
  bridge_url: null,
  web_ui_url: null,
  webUiUrl: null,
};

function setupApp(
  overrides: Partial<{
    elizaCloudConnected: boolean;
    handleCloudLogin: ReturnType<typeof vi.fn>;
  }> = {},
) {
  useAppMock.mockReturnValue({
    startupCoordinator: {
      phase: "onboarding-required",
      state: { phase: "onboarding-required", serverReachable: false },
      dispatch: startupDispatchMock,
    },
    setState: setStateMock,
    completeOnboarding: completeOnboardingMock,
    elizaCloudConnected: overrides.elizaCloudConnected ?? true,
    elizaCloudLoginBusy: false,
    elizaCloudLoginError: null,
    handleCloudLogin: overrides.handleCloudLogin ?? vi.fn(),
    uiLanguage: "en",
    uiTheme: "dark",
    setUiTheme: vi.fn(),
    t: (key: string, vars?: { defaultValue?: string }) =>
      vars?.defaultValue ?? key,
  });
}

function resetPlatformState() {
  platformState.isAndroid = false;
  platformState.isDesktop = false;
  platformState.isElizaOS = false;
  platformState.isIOS = false;
}

async function openAdvancedRuntimeOptions(): Promise<void> {
  await act(async () => {
    fireEvent.click(
      screen.getByRole("button", { name: /i want to run it myself/i }),
    );
  });
}

async function startLocalFromWelcome(): Promise<void> {
  await openAdvancedRuntimeOptions();
  await act(async () => {
    fireEvent.click(screen.getByText(/use local/i));
  });
}

async function startCloudFromWelcome(): Promise<void> {
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: /get started/i }));
  });
}

function runtimeChoiceNames(): string[] {
  const choices: string[] = [];
  if (screen.queryByRole("button", { name: /get started/i })) {
    choices.push("cloud");
  }
  if (screen.queryByText("I want to run it myself")) {
    choices.push("local", "remote");
  }
  return choices;
}

describe("resolveRuntimeChoices", () => {
  it("offers only working native runtime choices per platform", () => {
    expect(
      resolveRuntimeChoices({
        isAndroid: false,
        isIOS: true,
        isDesktop: false,
        isDev: false,
        showLocalOption: false,
        localProbePending: false,
      }),
    ).toEqual(["cloud", "local", "remote"]);

    expect(
      resolveRuntimeChoices({
        isAndroid: true,
        isIOS: false,
        isDesktop: false,
        isDev: false,
        showLocalOption: false,
        localProbePending: true,
      }),
    ).toEqual(["cloud", "local", "remote"]);
  });
});

describe("RuntimeGate onboarding choices", () => {
  beforeEach(() => {
    resetPlatformState();
    setupApp();
    shouldShowLocalOptionMock.mockResolvedValue(false);
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    resetPlatformState();
  });

  it("offers Local on iOS through the in-process local agent", async () => {
    platformState.isIOS = true;

    render(<RuntimeGate />);
    await openAdvancedRuntimeOptions();

    expect(screen.getByText("Run on this machine")).toBeTruthy();
    expect(screen.getByText("Connect to your own server")).toBeTruthy();
  });

  it.skip("shows Cloud, Local, and Remote on Android while the local probe is pending", () => {
    platformState.isAndroid = true;

    render(<RuntimeGate />);

    expect(runtimeChoiceNames()).toEqual(["cloud", "local", "remote"]);
  });

  it("starts the Android local service without waiting for model downloads", async () => {
    platformState.isAndroid = true;

    render(<RuntimeGate />);
    await startLocalFromWelcome();

    expect(clientMock.setBaseUrl).toHaveBeenCalledWith(
      "http://127.0.0.1:31337",
    );
    expect(clientMock.setToken).toHaveBeenCalledWith(null);
    expect(clearPersistedActiveServerMock).not.toHaveBeenCalled();
    expect(savePersistedActiveServerMock).toHaveBeenCalledWith({
      id: "local:android",
      kind: "remote",
      label: "On-device agent",
      apiBase: "http://127.0.0.1:31337",
    });
    expect(persistMobileRuntimeModeForServerTargetMock).toHaveBeenCalledWith(
      "local",
    );
    expect(startupDispatchMock).toHaveBeenCalledWith({
      type: "SPLASH_CONTINUE",
    });
    expect(completeOnboardingMock).toHaveBeenCalled();
    await waitFor(() => expect(agentStartMock).toHaveBeenCalledTimes(1));
  });

  it("starts iOS local mode through the shared mobile local target", async () => {
    platformState.isIOS = true;

    render(<RuntimeGate />);
    await startLocalFromWelcome();

    expect(clientMock.setBaseUrl).toHaveBeenCalledWith(
      "http://127.0.0.1:31337",
    );
    expect(clientMock.setToken).toHaveBeenCalledWith(null);
    expect(savePersistedActiveServerMock).toHaveBeenCalledWith({
      id: "local:mobile",
      kind: "remote",
      label: "On-device agent",
      apiBase: "http://127.0.0.1:31337",
    });
    expect(persistMobileRuntimeModeForServerTargetMock).toHaveBeenCalledWith(
      "local",
    );
    expect(completeOnboardingMock).toHaveBeenCalled();
    await waitFor(() => expect(agentStartMock).toHaveBeenCalledTimes(1));
  });

  it.skip("connects the iOS Remote path to the user supplied agent URL", () => {
    platformState.isIOS = true;

    const { container } = render(<RuntimeGate />);

    fireEvent.click(
      container.querySelector('[data-runtime-choice="remote"]') as HTMLElement,
    );
    fireEvent.click(screen.getByRole("button", { name: /select remote/i }));
    fireEvent.input(
      screen.getByPlaceholderText("https://your-agent.example.com"),
      {
        target: { value: "https://remote.example.com" },
      },
    );
    fireEvent.input(screen.getByPlaceholderText("Access token (optional)"), {
      target: { value: "remote-token" },
    });
    fireEvent.click(screen.getByRole("button", { name: /^connect$/i }));

    expect(clientMock.setBaseUrl).toHaveBeenCalledWith(
      "https://remote.example.com",
    );
    expect(clientMock.setToken).toHaveBeenCalledWith("remote-token");
    expect(savePersistedActiveServerMock).toHaveBeenCalledWith({
      id: "remote:https://remote.example.com",
      kind: "remote",
      label: "https://remote.example.com",
      apiBase: "https://remote.example.com",
      accessToken: "remote-token",
    });
    expect(persistMobileRuntimeModeForServerTargetMock).toHaveBeenCalledWith(
      "remote",
    );
    expect(setStateMock).toHaveBeenCalledWith(
      "onboardingServerTarget",
      "remote",
    );
    expect(startupDispatchMock).toHaveBeenCalledWith({
      type: "SPLASH_CONTINUE",
    });
    expect(completeOnboardingMock).toHaveBeenCalled();
  });
});

describe("RuntimeGate cloud provisioning startup handoff", () => {
  beforeEach(() => {
    resetPlatformState();
    setupApp();
    clientMock.getCloudCompatAgents.mockResolvedValue({
      success: true,
      data: [STOPPED_AGENT],
    });
    clientMock.getCloudCompatAgent.mockResolvedValue({
      success: true,
      data: RUNNING_AGENT,
    });
    clientMock.getCloudCompatAgentStatus.mockResolvedValue({
      success: true,
      data: {
        status: "running",
        lastHeartbeat: null,
        bridgeUrl: "https://agent-1.elizacloud.ai",
        webUiUrl: null,
        currentNode: null,
        suspendedReason: null,
        databaseStatus: "ready",
      },
    });
    clientMock.createCloudCompatAgent.mockResolvedValue({
      success: true,
      data: { agentId: "agent-1" },
    });
    clientMock.provisionCloudCompatAgent.mockResolvedValue({
      success: true,
      data: { jobId: "" },
    });
    clientMock.getCloudCompatJobStatus.mockResolvedValue({
      success: true,
      data: {
        id: "job-1",
        jobId: "job-1",
        type: "agent_provision",
        status: "completed",
        data: {},
        result: null,
        error: null,
        createdAt: "2026-01-01T00:00:00.000Z",
        startedAt: "2026-01-01T00:00:01.000Z",
        completedAt: "2026-01-01T00:00:02.000Z",
        retryCount: 0,
        name: "agent_provision",
        state: "completed",
        created_on: "2026-01-01T00:00:00.000Z",
        completed_on: "2026-01-01T00:00:02.000Z",
      },
    });
    clientMock.getCloudCompatAgentStatus.mockResolvedValue({
      success: true,
      data: {
        status: "running",
        bridgeUrl: "https://agent-1.elizacloud.ai",
        webUiUrl: null,
        suspendedReason: null,
      },
    });
    clientMock.switchProvider.mockResolvedValue({
      success: true,
      provider: "elizacloud",
    });
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.clearAllMocks();
    resetPlatformState();
  });

  it.skip("polls an async provisioning job, connects to the running agent, and completes startup", async () => {
    vi.useFakeTimers();
    clientMock.provisionCloudCompatAgent.mockResolvedValue({
      success: true,
      data: { jobId: "job-1", agentId: "agent-1", status: "pending" },
    });

    render(<RuntimeGate />);
    await startCloudFromWelcome();

    await vi.waitFor(() =>
      expect(clientMock.provisionCloudCompatAgent).toHaveBeenCalledWith(
        "agent-1",
      ),
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2500);
    });

    await vi.waitFor(() =>
      expect(clientMock.getCloudCompatJobStatus).toHaveBeenCalledWith("job-1"),
    );
    await vi.waitFor(() =>
      expect(clientMock.setBaseUrl).toHaveBeenCalledWith(
        "https://agent-1.elizacloud.ai",
      ),
    );

    expect(savePersistedActiveServerMock).toHaveBeenCalledWith({
      id: "cloud:agent-1",
      kind: "cloud",
      label: "My Agent",
      apiBase: "https://agent-1.elizacloud.ai",
    });
    expect(addAgentProfileMock).toHaveBeenCalledWith({
      kind: "cloud",
      label: "My Agent",
      cloudAgentId: "agent-1",
      apiBase: "https://agent-1.elizacloud.ai",
    });
    expect(persistMobileRuntimeModeForServerTargetMock).toHaveBeenCalledWith(
      "elizacloud",
    );
    expect(setStateMock).toHaveBeenCalledWith(
      "onboardingServerTarget",
      "elizacloud",
    );
    expect(completeOnboardingMock).toHaveBeenCalledTimes(1);
  });

  it("uses the completed provisioning job bridge URL when agent status has not hydrated yet", async () => {
    vi.useFakeTimers();
    clientMock.provisionCloudCompatAgent.mockResolvedValue({
      success: true,
      data: { jobId: "job-1", agentId: "agent-1", status: "pending" },
    });
    clientMock.getCloudCompatJobStatus.mockResolvedValue({
      success: true,
      data: {
        id: "job-1",
        jobId: "job-1",
        type: "agent_provision",
        status: "completed",
        data: {},
        result: { bridgeUrl: "https://job-result-agent.elizacloud.ai" },
        error: null,
        createdAt: "2026-01-01T00:00:00.000Z",
        startedAt: "2026-01-01T00:00:01.000Z",
        completedAt: "2026-01-01T00:00:02.000Z",
        retryCount: 0,
        name: "agent_provision",
        state: "completed",
        created_on: "2026-01-01T00:00:00.000Z",
        completed_on: "2026-01-01T00:00:02.000Z",
      },
    });
    clientMock.getCloudCompatAgent.mockResolvedValue({
      success: true,
      data: { ...RUNNING_AGENT, bridge_url: null, containerUrl: "" },
    });

    render(<RuntimeGate />);
    await startCloudFromWelcome();

    await vi.waitFor(() =>
      expect(clientMock.provisionCloudCompatAgent).toHaveBeenCalledWith(
        "agent-1",
      ),
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2500);
    });

    await vi.waitFor(() =>
      expect(clientMock.setBaseUrl).toHaveBeenCalledWith(
        "https://job-result-agent.elizacloud.ai",
      ),
    );
    expect(savePersistedActiveServerMock).toHaveBeenCalledWith({
      id: "cloud:agent-1",
      kind: "cloud",
      label: "My Agent",
      apiBase: "https://job-result-agent.elizacloud.ai",
    });
    expect(completeOnboardingMock).toHaveBeenCalledTimes(1);
  });

  it("logs in from the Cloud screen, provisions the first agent, and completes startup", async () => {
    vi.useFakeTimers();
    const handleCloudLoginMock = vi.fn(async () => {
      setupApp({
        elizaCloudConnected: true,
        handleCloudLogin: handleCloudLoginMock,
      });
    });
    setupApp({
      elizaCloudConnected: false,
      handleCloudLogin: handleCloudLoginMock,
    });
    clientMock.provisionCloudCompatAgent.mockResolvedValue({
      success: true,
      data: { jobId: "job-1", agentId: "agent-1", status: "pending" },
    });

    const { rerender } = render(<RuntimeGate />);
    await startCloudFromWelcome();
    await act(async () => {
      fireEvent.click(screen.getByText("Sign in with Eliza Cloud"));
    });

    expect(handleCloudLoginMock).toHaveBeenCalledTimes(1);

    rerender(<RuntimeGate />);
    await vi.waitFor(() =>
      expect(clientMock.getCloudCompatAgents).toHaveBeenCalled(),
    );
    await vi.waitFor(() =>
      expect(clientMock.provisionCloudCompatAgent).toHaveBeenCalledWith(
        "agent-1",
      ),
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2500);
    });

    await vi.waitFor(() =>
      expect(clientMock.setBaseUrl).toHaveBeenCalledWith(
        "https://agent-1.elizacloud.ai",
      ),
    );
    expect(savePersistedActiveServerMock).toHaveBeenCalledWith({
      id: "cloud:agent-1",
      kind: "cloud",
      label: "My Agent",
      apiBase: "https://agent-1.elizacloud.ai",
    });
    expect(completeOnboardingMock).toHaveBeenCalledTimes(1);
  });

  it("surfaces provisioning API failures without completing onboarding", async () => {
    clientMock.provisionCloudCompatAgent.mockResolvedValue({
      success: false,
      error: "Insufficient credits",
      requiredBalance: 5,
      currentBalance: 0,
    });

    render(<RuntimeGate />);
    await startCloudFromWelcome();

    await waitFor(() =>
      expect(screen.getByText("Insufficient credits")).toBeTruthy(),
    );
    expect(clientMock.getCloudCompatJobStatus).not.toHaveBeenCalled();
    expect(clientMock.setBaseUrl).not.toHaveBeenCalled();
    expect(completeOnboardingMock).not.toHaveBeenCalled();
  });

  it("times out before the first provisioning response instead of hanging on startup", async () => {
    vi.useFakeTimers();
    clientMock.provisionCloudCompatAgent.mockImplementation(
      () => new Promise(() => undefined),
    );

    render(<RuntimeGate />);
    await startCloudFromWelcome();

    await vi.waitFor(() =>
      expect(clientMock.provisionCloudCompatAgent).toHaveBeenCalledWith(
        "agent-1",
      ),
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });

    expect(
      screen.getByText("Waiting for Cloud to accept provisioning..."),
    ).toBeTruthy();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });

    await vi.waitFor(() =>
      expect(
        screen.getByText(
          "Cloud did not return a provisioning job. Please retry.",
        ),
      ).toBeTruthy(),
    );
    expect(clientMock.getCloudCompatJobStatus).not.toHaveBeenCalled();
    expect(clientMock.setBaseUrl).not.toHaveBeenCalled();
    expect(completeOnboardingMock).not.toHaveBeenCalled();
  });

  it("stops polling when a provisioning job never leaves the queued or processing states", async () => {
    vi.useFakeTimers();
    clientMock.provisionCloudCompatAgent.mockResolvedValue({
      success: true,
      data: { jobId: "job-1", agentId: "agent-1", status: "pending" },
      polling: { intervalMs: 60_000 },
    });
    clientMock.getCloudCompatJobStatus.mockResolvedValue({
      success: true,
      data: {
        id: "job-1",
        jobId: "job-1",
        type: "agent_provision",
        status: "processing",
        data: {},
        result: null,
        error: null,
        createdAt: "2026-01-01T00:00:00.000Z",
        startedAt: "2026-01-01T00:00:01.000Z",
        completedAt: null,
        retryCount: 0,
        name: "agent_provision",
        state: "processing",
        created_on: "2026-01-01T00:00:00.000Z",
        completed_on: null,
      },
    });

    render(<RuntimeGate />);
    await startCloudFromWelcome();

    await vi.waitFor(() =>
      expect(clientMock.provisionCloudCompatAgent).toHaveBeenCalledWith(
        "agent-1",
      ),
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(600_000);
    });

    await vi.waitFor(() =>
      expect(
        screen.getByText(
          "Cloud provisioning is still running after several minutes. Retry to resume status checks.",
        ),
      ).toBeTruthy(),
    );
    expect(clientMock.setBaseUrl).not.toHaveBeenCalled();
    expect(completeOnboardingMock).not.toHaveBeenCalled();
  });

  it("surfaces repeated async provisioning poll failures without hanging startup", async () => {
    vi.useFakeTimers();
    clientMock.provisionCloudCompatAgent.mockResolvedValue({
      success: true,
      data: { jobId: "job-1", agentId: "agent-1", status: "pending" },
    });
    clientMock.getCloudCompatJobStatus.mockRejectedValue(
      new Error("Job lookup failed"),
    );

    render(<RuntimeGate />);
    await startCloudFromWelcome();

    await vi.waitFor(() =>
      expect(clientMock.provisionCloudCompatAgent).toHaveBeenCalledWith(
        "agent-1",
      ),
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });

    await vi.waitFor(() =>
      expect(screen.getByText("Job lookup failed")).toBeTruthy(),
    );
    expect(clientMock.getCloudCompatJobStatus).toHaveBeenCalledTimes(3);
    expect(clientMock.setBaseUrl).not.toHaveBeenCalled();
    expect(completeOnboardingMock).not.toHaveBeenCalled();
  });

  it("surfaces 'hosting unavailable' when create returns nodeId=null and skips provision", async () => {
    clientMock.getCloudCompatAgents.mockResolvedValue({
      success: true,
      data: [],
    });
    clientMock.createCloudCompatAgent.mockResolvedValue({
      success: true,
      data: { agentId: "agent-1", nodeId: null, status: "queued" },
    });

    render(<RuntimeGate />);
    await startCloudFromWelcome();

    await waitFor(() =>
      expect(
        screen.getByText(
          "Cloud agent hosting isn't available on this instance. Try a local or remote agent.",
        ),
      ).toBeTruthy(),
    );
    expect(clientMock.provisionCloudCompatAgent).not.toHaveBeenCalled();
    expect(completeOnboardingMock).not.toHaveBeenCalled();
  });

  it("times out async provisioning that stays queued past PROVISION_JOB_DEADLINE_MS", async () => {
    vi.useFakeTimers();
    clientMock.getCloudCompatAgents.mockResolvedValue({
      success: true,
      data: [],
    });
    clientMock.createCloudCompatAgent.mockResolvedValue({
      success: true,
      data: { agentId: "agent-1", nodeId: "node-1", status: "queued" },
    });
    clientMock.provisionCloudCompatAgent.mockResolvedValue({
      success: true,
      data: { jobId: "job-1", agentId: "agent-1", status: "queued" },
    });
    clientMock.getCloudCompatJobStatus.mockResolvedValue({
      success: true,
      data: {
        id: "job-1",
        jobId: "job-1",
        type: "agent_provision",
        status: "queued",
        data: {},
        result: null,
        error: null,
        createdAt: "2026-01-01T00:00:00.000Z",
        startedAt: null,
        completedAt: null,
        retryCount: 0,
        name: "agent_provision",
        state: "queued",
        created_on: "2026-01-01T00:00:00.000Z",
        completed_on: null,
      },
    });

    render(<RuntimeGate />);
    await startCloudFromWelcome();

    await vi.waitFor(() =>
      expect(clientMock.provisionCloudCompatAgent).toHaveBeenCalledWith(
        "agent-1",
      ),
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(600_000);
    });

    await vi.waitFor(() =>
      expect(
        screen.getByText(
          "Cloud provisioning is still running after several minutes. Retry to resume status checks.",
        ),
      ).toBeTruthy(),
    );
    expect(clientMock.setBaseUrl).not.toHaveBeenCalled();
    expect(completeOnboardingMock).not.toHaveBeenCalled();
  });

  it("re-provisions an existing agent whose /api/health probe fails", async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error("Network unreachable");
    });
    vi.stubGlobal("fetch", fetchMock);

    clientMock.getCloudCompatAgents.mockResolvedValue({
      success: true,
      data: [RUNNING_AGENT],
    });
    clientMock.provisionCloudCompatAgent.mockResolvedValue({
      success: true,
      data: { jobId: "", agentId: "agent-1", status: "running" },
    });

    render(<RuntimeGate />);
    await startCloudFromWelcome();

    await vi.waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "https://agent-1.elizacloud.ai/api/health",
        expect.objectContaining({ method: "GET" }),
      ),
    );
    await vi.waitFor(() =>
      expect(clientMock.provisionCloudCompatAgent).toHaveBeenCalledWith(
        "agent-1",
      ),
    );

    vi.unstubAllGlobals();
  });
});
