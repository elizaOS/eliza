// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  addAgentProfileMock,
  clientMock,
  completeOnboardingMock,
  persistMobileRuntimeModeForServerTargetMock,
  savePersistedActiveServerMock,
  setStateMock,
  startupDispatchMock,
  useAppMock,
} = vi.hoisted(() => ({
  addAgentProfileMock: vi.fn(),
  clientMock: {
    getCloudCompatAgents: vi.fn(),
    getCloudCompatAgent: vi.fn(),
    createCloudCompatAgent: vi.fn(),
    provisionCloudCompatAgent: vi.fn(),
    getCloudCompatJobStatus: vi.fn(),
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

vi.mock("../../src/api", () => ({
  client: clientMock,
}));

vi.mock("../../src/state", () => ({
  useApp: () => useAppMock(),
  savePersistedActiveServer: savePersistedActiveServerMock,
  addAgentProfile: addAgentProfileMock,
  clearPersistedActiveServer: vi.fn(),
}));

vi.mock("../../src/bridge/gateway-discovery", () => ({
  discoverGatewayEndpoints: vi.fn(async () => []),
  gatewayEndpointToApiBase: vi.fn(),
}));

vi.mock("../../src/onboarding/mobile-runtime-mode", () => ({
  persistMobileRuntimeModeForServerTarget:
    persistMobileRuntimeModeForServerTargetMock,
  readPersistedMobileRuntimeMode: vi.fn(() => null),
  MOBILE_RUNTIME_MODE_STORAGE_KEY: "eliza:mobile-runtime-mode",
  normalizeMobileRuntimeMode: vi.fn((v: unknown) =>
    typeof v === "string" ? v : null,
  ),
}));

vi.mock("../../src/onboarding/probe-local-agent", () => ({
  shouldShowLocalOption: vi.fn(async () => true),
}));

vi.mock("../../src/platform/init", () => ({
  isDesktopPlatform: vi.fn(() => true),
  isAndroid: false,
  isIOS: false,
  isElizaOS: vi.fn(() => false),
  isNative: false,
  canRunLocal: vi.fn(() => true),
}));

vi.mock("../../src/components/shared/LanguageDropdown", () => ({
  LanguageDropdown: () => null,
}));

vi.mock("../../src/components/shared/ThemeToggle", () => ({
  ThemeToggle: () => null,
}));

import { RuntimeGate } from "../../src/components/shell/RuntimeGate";

function setupApp() {
  useAppMock.mockReturnValue({
    startupCoordinator: {
      phase: "onboarding-required",
      state: { phase: "onboarding-required", serverReachable: false },
      dispatch: startupDispatchMock,
    },
    startupError: null,
    retryStartup: vi.fn(),
    setActionNotice: vi.fn(),
    setState: setStateMock,
    t: (key: string, vars?: { defaultValue?: string }) =>
      vars?.defaultValue ?? key,
    elizaCloudConnected: false,
    elizaCloudLoginBusy: false,
    elizaCloudLoginError: null,
    handleCloudLogin: vi.fn(),
    uiLanguage: "en",
    uiTheme: "system",
    setUiTheme: vi.fn(),
    completeOnboarding: completeOnboardingMock,
  });
}

function openRemoteView() {
  fireEvent.click(screen.getByRole("button", { name: /remote/i }));
  fireEvent.click(screen.getByRole("button", { name: /select remote/i }));
}

describe("launch QA remote onboarding target validation", () => {
  beforeEach(() => {
    setupApp();
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it.each([
    "not a url",
    "localhost:3000",
    "/api",
    "ftp://agent.example.com",
  ])("rejects invalid remote target %s without completing onboarding", async (target) => {
    render(<RuntimeGate />);
    openRemoteView();

    fireEvent.change(
      screen.getByPlaceholderText("https://your-agent.example.com"),
      { target: { value: target } },
    );
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));

    expect(
      await screen.findByText("Enter a valid HTTP or HTTPS remote agent URL."),
    ).toBeTruthy();
    expect(clientMock.setBaseUrl).not.toHaveBeenCalled();
    expect(savePersistedActiveServerMock).not.toHaveBeenCalled();
    expect(completeOnboardingMock).not.toHaveBeenCalled();
    expect(startupDispatchMock).not.toHaveBeenCalled();
  });

  it("accepts a valid HTTPS remote target and persists the active server", async () => {
    render(<RuntimeGate />);
    openRemoteView();

    fireEvent.change(
      screen.getByPlaceholderText("https://your-agent.example.com"),
      { target: { value: " https://agent.example.com/api " } },
    );
    fireEvent.change(screen.getByPlaceholderText("Access token (optional)"), {
      target: { value: "remote-token" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));

    await waitFor(() =>
      expect(clientMock.setBaseUrl).toHaveBeenCalledWith(
        "https://agent.example.com/api",
      ),
    );
    expect(clientMock.setToken).toHaveBeenCalledWith("remote-token");
    expect(savePersistedActiveServerMock).toHaveBeenCalledWith({
      id: "remote:https://agent.example.com/api",
      kind: "remote",
      label: "https://agent.example.com/api",
      apiBase: "https://agent.example.com/api",
      accessToken: "remote-token",
    });
    expect(addAgentProfileMock).toHaveBeenCalledWith({
      kind: "remote",
      label: "https://agent.example.com/api",
      apiBase: "https://agent.example.com/api",
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
