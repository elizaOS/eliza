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

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const {
  addAgentProfileMock,
  clearPersistedActiveServerMock,
  clientMock,
  completeOnboardingMock,
  persistMobileRuntimeModeForServerTargetMock,
  savePersistedActiveServerMock,
  setStateMock,
  startupDispatchMock,
  useAppMock,
} = vi.hoisted(() => ({
  addAgentProfileMock: vi.fn(),
  clearPersistedActiveServerMock: vi.fn(),
  clientMock: {
    getCloudCompatAgents: vi.fn(),
    getCloudCompatAgent: vi.fn(),
    createCloudCompatAgent: vi.fn(),
    provisionCloudCompatAgent: vi.fn(),
    getCloudCompatJobStatus: vi.fn(),
    getRestAuthToken: vi.fn(() => null),
    switchProvider: vi.fn(),
    setBaseUrl: vi.fn(),
    setToken: vi.fn(),
  },
  completeOnboardingMock: vi.fn(),
  persistMobileRuntimeModeForServerTargetMock: vi.fn(),
  savePersistedActiveServerMock: vi.fn(),
  setStateMock: vi.fn(),
  startupDispatchMock: vi.fn(),
  useAppMock: vi.fn(),
}));

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
  persistMobileRuntimeModeForServerTarget:
    persistMobileRuntimeModeForServerTargetMock,
}));

vi.mock("../../onboarding/probe-local-agent", () => ({
  shouldShowLocalOption: vi.fn(async () => false),
}));

vi.mock("../../platform/init", () => ({
  isDesktopPlatform: vi.fn(() => false),
  isAndroid: false,
  isIOS: false,
  isElizaOS: vi.fn(() => false),
}));

vi.mock("../../utils", () => ({
  preOpenWindow: vi.fn(() => null),
  resolveAppAssetUrl: (path: string) => path,
}));

vi.mock("../shared/LanguageDropdown", () => ({
  LanguageDropdown: () => null,
}));

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

function setupApp() {
  useAppMock.mockReturnValue({
    startupCoordinator: {
      phase: "onboarding-required",
      state: { phase: "onboarding-required", serverReachable: false },
      dispatch: startupDispatchMock,
    },
    setState: setStateMock,
    completeOnboarding: completeOnboardingMock,
    elizaCloudConnected: true,
    elizaCloudLoginBusy: false,
    elizaCloudLoginError: null,
    handleCloudLogin: vi.fn(),
    uiLanguage: "en",
    uiTheme: "dark",
    setUiTheme: vi.fn(),
    t: (key: string, vars?: { defaultValue?: string }) =>
      vars?.defaultValue ?? key,
  });
}

describe("resolveRuntimeChoices", () => {
  it("keeps the cloud entry path available on mobile, desktop, and web", () => {
    expect(
      resolveRuntimeChoices({
        isAndroid: false,
        isIOS: true,
        isDesktop: false,
        isDev: false,
        showLocalOption: false,
        localProbePending: false,
      }),
    ).toEqual(["cloud", "remote"]);

    expect(
      resolveRuntimeChoices({
        isAndroid: false,
        isIOS: false,
        isDesktop: true,
        isDev: false,
        showLocalOption: true,
        localProbePending: false,
      }),
    ).toEqual(["cloud", "local", "remote"]);

    expect(
      resolveRuntimeChoices({
        isAndroid: false,
        isIOS: false,
        isDesktop: false,
        isDev: false,
        showLocalOption: false,
        localProbePending: false,
      }),
    ).toEqual(["cloud", "remote"]);
  });

  it("keeps Cloud available on Android while adding Local when the probe succeeds", () => {
    expect(
      resolveRuntimeChoices({
        isAndroid: true,
        isIOS: false,
        isDesktop: false,
        isDev: false,
        showLocalOption: false,
        localProbePending: true,
      }),
    ).toEqual(["cloud", "remote"]);

    expect(
      resolveRuntimeChoices({
        isAndroid: true,
        isIOS: false,
        isDesktop: false,
        isDev: false,
        showLocalOption: true,
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
        localProbePending: false,
      }),
    ).toEqual(["cloud", "remote"]);
  });
});

describe("RuntimeGate cloud provisioning startup handoff", () => {
  beforeEach(() => {
    setupApp();
    clientMock.getCloudCompatAgents.mockResolvedValue({
      success: true,
      data: [STOPPED_AGENT],
    });
    clientMock.getCloudCompatAgent.mockResolvedValue({
      success: true,
      data: RUNNING_AGENT,
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
    clientMock.switchProvider.mockResolvedValue({
      success: true,
      provider: "elizacloud",
    });
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("polls an async provisioning job, connects to the running agent, and completes startup", async () => {
    vi.useFakeTimers();
    clientMock.provisionCloudCompatAgent.mockResolvedValue({
      success: true,
      data: { jobId: "job-1", agentId: "agent-1", status: "pending" },
    });

    render(<RuntimeGate />);
    await act(async () => {
      fireEvent.click(screen.getByText("Select Cloud"));
    });

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

  it("surfaces provisioning API failures without completing onboarding", async () => {
    clientMock.provisionCloudCompatAgent.mockResolvedValue({
      success: false,
      error: "Insufficient credits",
      requiredBalance: 5,
      currentBalance: 0,
    });

    render(<RuntimeGate />);
    await act(async () => {
      fireEvent.click(screen.getByText("Select Cloud"));
    });

    await waitFor(() =>
      expect(screen.getByText("Insufficient credits")).toBeTruthy(),
    );
    expect(clientMock.getCloudCompatJobStatus).not.toHaveBeenCalled();
    expect(clientMock.setBaseUrl).not.toHaveBeenCalled();
    expect(completeOnboardingMock).not.toHaveBeenCalled();
  });
});
