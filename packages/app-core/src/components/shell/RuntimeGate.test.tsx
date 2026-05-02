// @vitest-environment jsdom
/**
 * Tests for the "Use local embeddings" checkbox added to RuntimeGate.
 * The checkbox is elizacloud-scoped: it renders only when the user has
 * selected the cloud sub-view (equivalent to onboardingProvider = "elizacloud")
 * and is hidden on all other paths.
 */

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── Hoisted mocks ────────────────────────────────────────────────────────────

const { clientMock, completeOnboardingMock, setStateMock, useAppMock } =
  vi.hoisted(() => ({
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
    setStateMock: vi.fn(),
    useAppMock: vi.fn(),
  }));

vi.mock("../../api", () => ({
  client: clientMock,
}));

vi.mock("../../state", () => ({
  useApp: () => useAppMock(),
  savePersistedActiveServer: vi.fn(),
  addAgentProfile: vi.fn(),
  clearPersistedActiveServer: vi.fn(),
}));

vi.mock("../../bridge/gateway-discovery", () => ({
  discoverGatewayEndpoints: vi.fn(async () => []),
  gatewayEndpointToApiBase: vi.fn(),
}));

vi.mock("../../onboarding/mobile-runtime-mode", () => ({
  persistMobileRuntimeModeForServerTarget: vi.fn(),
  readPersistedMobileRuntimeMode: vi.fn(() => null),
  MOBILE_RUNTIME_MODE_STORAGE_KEY: "eliza:mobile-runtime-mode",
  normalizeMobileRuntimeMode: vi.fn((v: unknown) =>
    typeof v === "string" ? v : null,
  ),
}));

vi.mock("../../onboarding/probe-local-agent", () => ({
  shouldShowLocalOption: vi.fn(async () => false),
}));

vi.mock("../../platform/init", () => ({
  isDesktopPlatform: vi.fn(() => false),
  isAndroid: false,
  isIOS: false,
  isMiladyOS: vi.fn(() => false),
  isNative: false,
  canRunLocal: vi.fn(() => false),
}));

vi.mock("../shared/LanguageDropdown", () => ({
  LanguageDropdown: () => null,
}));

import { RuntimeGate } from "./RuntimeGate";

const MOCK_AGENT = {
  agent_id: "agent-1",
  agent_name: "My Agent",
  status: "running",
  web_ui_url: "http://cloud.example.com",
  webUiUrl: undefined as string | undefined,
  bridge_url: undefined as string | undefined,
};

function setupApp(overrides: { elizaCloudConnected?: boolean } = {}) {
  const startupCoordinator = {
    phase: "onboarding-required" as const,
    state: { phase: "onboarding-required" as const, serverReachable: false },
    dispatch: vi.fn(),
  };
  useAppMock.mockReturnValue({
    startupCoordinator,
    startupError: null,
    retryStartup: vi.fn(),
    setActionNotice: vi.fn(),
    setState: setStateMock,
    t: (key: string, vars?: { defaultValue?: string }) =>
      vars?.defaultValue ?? key,
    elizaCloudConnected: overrides.elizaCloudConnected ?? false,
    elizaCloudLoginBusy: false,
    handleCloudLogin: vi.fn(),
    uiLanguage: "en",
    completeOnboarding: completeOnboardingMock,
  });
}

describe("RuntimeGate — Use local embeddings checkbox", () => {
  beforeEach(() => {
    setupApp();
    clientMock.switchProvider.mockResolvedValue({
      success: true,
      provider: "elizacloud",
      restarting: false,
    });
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("does NOT render the local embeddings checkbox on the chooser screen (non-elizacloud path)", () => {
    render(<RuntimeGate />);
    // The chooser is the default view — no cloud provider selected yet.
    expect(screen.queryByLabelText("Use local embeddings")).toBeNull();
    expect(screen.queryByText("Use local embeddings")).toBeNull();
  });

  it("renders the local embeddings checkbox when the cloud (elizacloud) sub-view is active", () => {
    render(<RuntimeGate />);

    // Navigate into the cloud sub-view — equivalent to selecting elizacloud.
    fireEvent.click(screen.getByText("Select Cloud"));

    expect(screen.getByText("Use local embeddings")).toBeTruthy();
    expect(
      screen.getByRole("checkbox", { name: /use local embeddings/i }),
    ).toBeTruthy();
  });

  it("defaults the local embeddings checkbox to unchecked", () => {
    render(<RuntimeGate />);
    fireEvent.click(screen.getByText("Select Cloud"));

    const checkbox = screen.getByRole("checkbox", {
      name: /use local embeddings/i,
    });
    // Radix Checkbox uses aria-checked on the button element.
    expect(checkbox.getAttribute("aria-checked")).toBe("false");
  });

  it("toggling the checkbox before connecting causes switchProvider to receive useLocalEmbeddings: true", async () => {
    // Provide a controlled promise so we can toggle the checkbox before the
    // agent-list response resolves. This avoids a race between the auto-connect
    // effect and the checkbox toggle.
    let resolveAgents!: (value: {
      success: true;
      data: (typeof MOCK_AGENT)[];
    }) => void;
    const agentsPromise = new Promise<{
      success: true;
      data: (typeof MOCK_AGENT)[];
    }>((res) => {
      resolveAgents = res;
    });
    clientMock.getCloudCompatAgents.mockReturnValue(agentsPromise);

    // elizaCloudConnected=true → cloudStage starts as "loading" → the effect
    // fires getCloudCompatAgents (the controlled promise) immediately on mount
    // of the cloud sub-view.
    setupApp({ elizaCloudConnected: true });

    render(<RuntimeGate />);

    // Navigate to the cloud sub-view. The effect fires but awaits the promise.
    fireEvent.click(screen.getByText("Select Cloud"));

    // Checkbox is visible (cloudStage === "loading", not "connecting").
    const checkbox = screen.getByRole("checkbox", {
      name: /use local embeddings/i,
    });
    expect(checkbox.getAttribute("aria-checked")).toBe("false");

    // Toggle the checkbox on before the agent list resolves.
    fireEvent.click(checkbox);
    await waitFor(() =>
      expect(checkbox.getAttribute("aria-checked")).toBe("true"),
    );

    // Resolve the agent list — auto-connect fires finishAsCloud(MOCK_AGENT).
    resolveAgents({ success: true, data: [MOCK_AGENT] });

    // finishAsCloud calls switchProvider with useLocalEmbeddings: true because
    // the checkbox was checked at the time of connection.
    await waitFor(() =>
      expect(clientMock.switchProvider).toHaveBeenCalledWith(
        "elizacloud",
        undefined,
        undefined,
        { useLocalEmbeddings: true },
      ),
    );
  });
});
