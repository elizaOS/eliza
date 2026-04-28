// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { clientMock, useAppMock } = vi.hoisted(() => ({
  clientMock: {
    getConfig: vi.fn(),
    getOnboardingOptions: vi.fn(),
    getSubscriptionStatus: vi.fn(),
    restartAgent: vi.fn(),
    switchProvider: vi.fn(),
    updateConfig: vi.fn(),
  },
  useAppMock: vi.fn(),
}));

vi.mock("../../api", () => ({
  client: clientMock,
}));

vi.mock("../../state", () => ({
  useApp: () => useAppMock(),
}));

vi.mock("../local-inference/LocalInferencePanel", () => ({
  LocalInferencePanel: () => <div>Local model downloads</div>,
}));

vi.mock("../pages/ElizaCloudDashboard", () => ({
  CloudDashboard: () => <div>Eliza Cloud account</div>,
}));

vi.mock("./ApiKeyConfig", () => ({
  ApiKeyConfig: ({
    selectedProvider,
  }: {
    selectedProvider: { id: string } | null;
  }) => (
    <div>
      {selectedProvider
        ? `API config for ${selectedProvider.id}`
        : "No API provider selected"}
    </div>
  ),
}));

vi.mock("./SubscriptionStatus", () => ({
  SubscriptionStatus: ({
    resolvedSelectedId,
  }: {
    resolvedSelectedId: string;
  }) => <div>Subscription config for {resolvedSelectedId}</div>,
}));

import { ProviderSwitcher } from "./ProviderSwitcher";

const baseConfig = {
  cloud: {},
  models: {},
  serviceRouting: {
    llmText: {
      backend: "elizacloud",
      transport: "cloud-proxy",
    },
  },
};

function mockApp() {
  useAppMock.mockReturnValue({
    elizaCloudConnected: true,
    loadPlugins: vi.fn(),
    pluginSaveSuccess: new Set<string>(),
    pluginSaving: new Set<string>(),
    plugins: [
      {
        category: "ai-provider",
        configured: true,
        enabled: true,
        id: "@elizaos/plugin-anthropic",
        name: "Anthropic",
        parameters: [{ key: "ANTHROPIC_API_KEY", type: "string" }],
      },
    ],
    setActionNotice: vi.fn(),
    t: (key: string, vars?: { defaultValue?: string }) =>
      vars?.defaultValue ?? key,
  });
}

describe("ProviderSwitcher", () => {
  beforeEach(() => {
    mockApp();
    clientMock.getSubscriptionStatus.mockResolvedValue({ providers: [] });
    clientMock.getOnboardingOptions.mockResolvedValue({
      models: {
        large: [{ id: "large-model", name: "Large Model" }],
        medium: [],
        mega: [],
        nano: [],
        small: [],
      },
    });
    clientMock.getConfig.mockResolvedValue(baseConfig);
    clientMock.restartAgent.mockResolvedValue(undefined);
    clientMock.switchProvider.mockResolvedValue({
      provider: "elizacloud",
      restarting: false,
      success: true,
    });
    clientMock.updateConfig.mockResolvedValue(undefined);
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("uses a provider list instead of a provider dropdown", () => {
    render(<ProviderSwitcher />);

    expect(screen.queryByLabelText("Provider")).toBeNull();
    expect(screen.getByText("Providers")).toBeTruthy();
    expect(screen.getAllByText("Eliza Cloud").length).toBeGreaterThan(0);
    expect(screen.getByText("Local provider")).toBeTruthy();
  });

  it("opens local model management from the Local provider", () => {
    render(<ProviderSwitcher />);

    fireEvent.click(screen.getByRole("button", { name: /Local provider/ }));

    expect(screen.getByText("Local model downloads")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Use local only/ })).toBeTruthy();
  });

  it("opens API key provider settings from the provider list", () => {
    render(<ProviderSwitcher />);

    fireEvent.click(screen.getByRole("button", { name: /Anthropic/ }));

    expect(
      screen.getByText("API config for @elizaos/plugin-anthropic"),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: /Use provider/ })).toBeTruthy();
  });

  it("keeps direct providers usable when local-only mode is active", async () => {
    clientMock.getConfig.mockResolvedValueOnce({
      cloud: {
        enabled: false,
        inferenceMode: "local",
        services: { inference: false },
      },
      models: {},
    });

    render(<ProviderSwitcher />);

    await screen.findByRole("button", { name: /Local only active/ });
    fireEvent.click(screen.getByRole("button", { name: /Anthropic/ }));

    const useProvider = screen.getByRole("button", { name: /Use provider/ });
    fireEvent.click(useProvider);

    await waitFor(() =>
      expect(clientMock.switchProvider).toHaveBeenCalledWith("anthropic"),
    );
  });

  it("does not treat direct API routing as local-only just because cloud is disabled", async () => {
    clientMock.getConfig.mockResolvedValueOnce({
      cloud: { enabled: false },
      models: {},
      serviceRouting: {
        llmText: {
          backend: "anthropic",
          transport: "direct",
        },
      },
    });

    render(<ProviderSwitcher />);

    await waitFor(() =>
      expect(
        screen.getByText("API config for @elizaos/plugin-anthropic"),
      ).toBeTruthy(),
    );
    expect(screen.queryByRole("button", { name: /Local only active/ })).toBe(
      null,
    );
  });
});
