import React from "react";
import {
  act,
  create,
  type ReactTestInstance,
  type ReactTestRenderer,
} from "react-test-renderer";
import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockGetConfig = vi.fn();
const mockGetOnboardingOptions = vi.fn();
const mockGetSubscriptionStatus = vi.fn();
const mockUpdateConfig = vi.fn();
const mockSwitchProvider = vi.fn();

vi.mock("@elizaos/app-core/api", () => ({
  client: {
    getConfig: (...args: unknown[]) => mockGetConfig(...args),
    getOnboardingOptions: (...args: unknown[]) =>
      mockGetOnboardingOptions(...args),
    getSubscriptionStatus: (...args: unknown[]) =>
      mockGetSubscriptionStatus(...args),
    updateConfig: (...args: unknown[]) => mockUpdateConfig(...args),
    switchProvider: (...args: unknown[]) => mockSwitchProvider(...args),
  },
}));

vi.mock("@elizaos/app-core/components", async () => {
  const actual = await vi.importActual<
    typeof import("@elizaos/app-core/components")
  >("@elizaos/app-core/components");
  return {
    ...actual,
    ApiKeyConfig: () => null,
    SubscriptionStatus: () => null,
  };
});
vi.mock("@elizaos/app-core/config", () => ({
  ConfigRenderer: () => null,
  defaultRegistry: {},
}));

import { ProviderSwitcher } from "@elizaos/app-core/components";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function defaultProps() {
  return {
    elizaCloudEnabled: false,
    elizaCloudConnected: false,
    elizaCloudCredits: null,
    elizaCloudCreditsLow: false,
    elizaCloudCreditsCritical: false,
    elizaCloudTopUpUrl: "",
    elizaCloudUserId: null,
    elizaCloudLoginBusy: false,
    elizaCloudLoginError: null,
    cloudDisconnecting: false,
    plugins: [
      {
        id: "plugin-anthropic",
        name: "Anthropic",
        category: "ai-provider",
        enabled: true,
        configured: true,
        parameters: [],
      },
    ],
    pluginSaving: new Set<string>(),
    pluginSaveSuccess: new Set<string>(),
    loadPlugins: vi.fn(async () => {}),
    handlePluginToggle: vi.fn(async () => {}),
    handlePluginConfigSave: vi.fn(),
    handleCloudLogin: vi.fn(async () => {}),
    handleCloudDisconnect: vi.fn(async () => {}),
    setState: vi.fn(),
    setTab: vi.fn(),
  };
}

function getSelectValue(tree: ReactTestRenderer): string | undefined {
  const root = tree.root;
  const selects = root.findAll(
    (node: ReactTestInstance) =>
      node.type === "select" && node.props.value !== undefined,
  );
  return selects.length > 0 ? selects[0].props.value : undefined;
}

function getSelect(tree: ReactTestRenderer): ReactTestInstance {
  const root = tree.root;
  return root.find(
    (node: ReactTestInstance) =>
      node.type === "select" && node.props.value !== undefined,
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ProviderSwitcher provider dropdown default", () => {
  beforeEach(() => {
    mockGetConfig.mockReset();
    mockGetOnboardingOptions.mockReset();
    mockGetSubscriptionStatus.mockReset();
    mockUpdateConfig.mockReset();
    mockSwitchProvider.mockReset();
    mockUpdateConfig.mockResolvedValue({ ok: true });
    mockSwitchProvider.mockResolvedValue({ ok: true });
  });

  it("does not auto-select __cloud__ when config returns non-cloud inference", async () => {
    // Config returns cloud.enabled=false — not a cloud user
    mockGetConfig.mockResolvedValue({
      models: { small: "some-local-model", large: "some-local-model" },
      cloud: { enabled: false },
      agents: {},
      env: { vars: {} },
    });
    mockGetOnboardingOptions.mockResolvedValue({
      models: [],
      piAiModels: [],
      piAiDefaultModel: "",
    });
    mockGetSubscriptionStatus.mockResolvedValue({ providers: [] });

    let tree!: ReactTestRenderer;
    await act(async () => {
      tree = create(React.createElement(ProviderSwitcher, defaultProps()));
    });

    // Let the async config load settle
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });

    const selectValue = getSelectValue(tree);
    // With the fix, the dropdown should resolve to the enabled plugin
    // (plugin-anthropic), NOT "__cloud__"
    expect(selectValue).toBe("plugin-anthropic");
  });

  it("selects __cloud__ when config returns cloud inference enabled", async () => {
    mockGetConfig.mockResolvedValue({
      models: {},
      cloud: {
        enabled: true,
        inferenceMode: "cloud",
        services: { inference: true },
      },
      agents: {},
      env: { vars: {} },
    });
    mockGetOnboardingOptions.mockResolvedValue({
      models: [],
      piAiModels: [],
      piAiDefaultModel: "",
    });
    mockGetSubscriptionStatus.mockResolvedValue({ providers: [] });

    let tree!: ReactTestRenderer;
    await act(async () => {
      tree = create(
        React.createElement(ProviderSwitcher, {
          ...defaultProps(),
          elizaCloudEnabled: true,
        }),
      );
    });

    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });

    const selectValue = getSelectValue(tree);
    expect(selectValue).toBe("__cloud__");
  });

  it("switches to subscription providers even when plugin ids use short slugs", async () => {
    mockGetConfig.mockResolvedValue({
      models: {},
      cloud: {
        enabled: true,
        inferenceMode: "cloud",
        services: { inference: true },
      },
      agents: {},
      env: { vars: {} },
    });
    mockGetOnboardingOptions.mockResolvedValue({
      models: [],
      piAiModels: [],
      piAiDefaultModel: "",
    });
    mockGetSubscriptionStatus.mockResolvedValue({
      providers: [
        {
          provider: "anthropic-subscription",
          configured: true,
          valid: true,
          expiresAt: null,
        },
      ],
    });

    const handlePluginToggle = vi.fn(async () => {});

    let tree!: ReactTestRenderer;
    await act(async () => {
      tree = create(
        React.createElement(ProviderSwitcher, {
          ...defaultProps(),
          elizaCloudEnabled: true,
          plugins: [
            {
              id: "plugin-openai",
              name: "OpenAI",
              category: "ai-provider",
              enabled: true,
              configured: true,
              parameters: [],
            },
            {
              id: "plugin-anthropic",
              name: "Anthropic",
              category: "ai-provider",
              enabled: false,
              configured: true,
              parameters: [],
            },
          ],
          handlePluginToggle,
        }),
      );
    });

    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });

    await act(async () => {
      getSelect(tree).props.onChange({
        target: { value: "anthropic-subscription" },
      });
      await Promise.resolve();
    });

    expect(mockUpdateConfig).toHaveBeenCalledWith({
      cloud: {
        services: { inference: false },
        inferenceMode: "byok",
      },
      env: { vars: { ELIZA_USE_PI_AI: "" } },
    });
    expect(mockSwitchProvider).toHaveBeenCalledWith("anthropic-subscription");
    expect(handlePluginToggle).toHaveBeenCalledWith("plugin-anthropic", true);
    expect(handlePluginToggle).toHaveBeenCalledWith("plugin-openai", false);
  });

  it("restores Claude Subscription from saved config instead of collapsing to anthropic", async () => {
    mockGetConfig.mockResolvedValue({
      models: {},
      cloud: {
        enabled: false,
        inferenceMode: "byok",
        services: { inference: false },
      },
      agents: {
        defaults: {
          subscriptionProvider: "anthropic-subscription",
        },
      },
      env: { vars: {} },
    });
    mockGetOnboardingOptions.mockResolvedValue({
      models: [],
      piAiModels: [],
      piAiDefaultModel: "",
    });
    mockGetSubscriptionStatus.mockResolvedValue({ providers: [] });

    let tree!: ReactTestRenderer;
    await act(async () => {
      tree = create(React.createElement(ProviderSwitcher, defaultProps()));
    });

    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });

    expect(getSelectValue(tree)).toBe("anthropic-subscription");
  });
});
