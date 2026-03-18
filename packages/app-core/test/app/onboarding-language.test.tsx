import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockUseApp } = vi.hoisted(() => ({
  mockUseApp: vi.fn(),
}));

vi.mock("@elizaos/app-core/state", async () => {
  const actual = await vi.importActual<
    typeof import("@elizaos/app-core/state")
  >("@elizaos/app-core/state");
  return {
    ...actual,
    useApp: () => mockUseApp(),
    THEMES: [{ id: "eliza", label: "Eliza", hint: "default" }],
    getVrmPreviewUrl: () => "/vrms/previews/eliza-1.png",
    getVrmUrl: () => "/vrms/eliza-1.vrm.gz",
    getVrmBackgroundUrl: () => "/vrms/backgrounds/eliza-1.png",
  };
});

vi.mock("@elizaos/app-core/components", async () => {
  const actual = await vi.importActual<
    typeof import("@elizaos/app-core/components")
  >("@elizaos/app-core/components");
  return {
    ...actual,
    PermissionsOnboardingSection: () => null,
  };
});

vi.mock("../../src/components/AvatarSelector", () => ({
  AvatarSelector: () => null,
}));

vi.mock("../../src/components/companion/VrmStage", () => ({
  VrmStage: () => null,
}));

vi.mock("@elizaos/app-core/api", () => ({
  client: {
    startAnthropicLogin: vi.fn(),
    exchangeAnthropicCode: vi.fn(),
    startOpenAILogin: vi.fn(),
    exchangeOpenAICode: vi.fn(),
  },
}));

import { OnboardingWizard } from "../../src/components/OnboardingWizard";

function createOnboardingContext(
  overrides?: Record<string, unknown>,
): Record<string, unknown> {
  return {
    t: (k: string) => k,
    onboardingStep: "identity",
    selectedVrmIndex: 1,
    customBackgroundUrl: "",
    onboardingOptions: {
      names: ["Eliza"],
      styles: [],
      cloudProviders: [],
      providers: [],
      models: { small: [], large: [] },
      openrouterModels: [],
      piModels: [],
      piDefaultModel: "",
    },
    onboardingName: "Eliza",
    onboardingOwnerName: "anon",
    onboardingStyle: "default",
    onboardingTheme: "eliza",
    onboardingRunMode: "",
    onboardingCloudProvider: "",
    onboardingSmallModel: "",
    onboardingLargeModel: "",
    onboardingProvider: "",
    onboardingApiKey: "",
    onboardingRemoteApiBase: "",
    onboardingRemoteToken: "",
    onboardingRemoteConnecting: false,
    onboardingRemoteError: "",
    onboardingRemoteConnected: false,
    onboardingOpenRouterModel: "",
    onboardingPrimaryModel: "",
    onboardingTelegramToken: "",
    onboardingDiscordToken: "",
    onboardingTwilioAccountSid: "",
    onboardingTwilioAuthToken: "",
    onboardingTwilioPhoneNumber: "",
    onboardingBlooioApiKey: "",
    onboardingBlooioPhoneNumber: "",
    onboardingSubscriptionTab: "token",
    onboardingSelectedChains: new Set<string>(),
    onboardingRpcSelections: {},
    onboardingRpcKeys: {},
    onboardingAvatar: 1,
    customVrmUrl: "",
    onboardingRestarting: false,
    uiLanguage: "en",
    elizaCloudConnected: false,
    elizaCloudLoginBusy: false,
    elizaCloudLoginError: "",
    handleOnboardingNext: vi.fn(async () => {}),
    handleOnboardingBack: vi.fn(),
    handleOnboardingRemoteConnect: vi.fn(async () => {}),
    handleOnboardingUseLocalBackend: vi.fn(),
    setState: vi.fn(),
    setTheme: vi.fn(),
    handleCloudLogin: vi.fn(async () => {}),
    ...overrides,
  };
}

function collectText(node: TestRenderer.ReactTestInstance): string {
  return node.children
    .map((child) => (typeof child === "string" ? child : collectText(child)))
    .join(" ");
}

describe("Onboarding language mode", () => {
  beforeEach(() => {
    mockUseApp.mockReset();
  });

  it("shows english copy by default", async () => {
    mockUseApp.mockReturnValue(createOnboardingContext({ uiLanguage: "en" }));
    let tree: TestRenderer.ReactTestRenderer | undefined;
    await act(async () => {
      tree = TestRenderer.create(React.createElement(OnboardingWizard));
    });
    if (!tree) {
      throw new Error(
        "Expected onboarding wizard test renderer to be created.",
      );
    }

    expect(collectText(tree.root)).toContain("Continue");
  });

  it("shows chinese copy when uiLanguage is zh-CN", async () => {
    mockUseApp.mockReturnValue(
      createOnboardingContext({ uiLanguage: "zh-CN" }),
    );
    let tree: TestRenderer.ReactTestRenderer | undefined;
    await act(async () => {
      tree = TestRenderer.create(React.createElement(OnboardingWizard));
    });
    if (!tree) {
      throw new Error(
        "Expected onboarding wizard test renderer to be created.",
      );
    }

    const text = collectText(tree.root);
    expect(text).toContain("Continue");
    expect(text).toContain("onboarding.restoreFromBackup");
  });
});
