/**
 * Tests for the onboarding step components:
 * IdentityStep, ConnectionStep, ActivateStep
 *
 * Validates rendering, user interaction, and navigation callbacks.
 */
import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import { beforeEach, describe, expect, it, vi } from "vitest";

// ── Hoisted mock ──────────────────────────────────────────────────────
const { mockUseApp, mockIsNativeFn } = vi.hoisted(() => ({
  mockUseApp: vi.fn(),
  mockIsNativeFn: { value: false },
}));

vi.mock("@elizaos/app-core/state", () => ({
  useApp: () => mockUseApp(),
  getVrmPreviewUrl: (index: number) => `/vrms/preview-${index}.png`,
}));

vi.mock("@elizaos/app-core/api", () => ({
  client: {
    importAgent: vi.fn(),
    startAnthropicLogin: vi.fn(),
    exchangeAnthropicCode: vi.fn(),
    startOpenAILogin: vi.fn(),
    exchangeOpenAICode: vi.fn(),
  },
}));

vi.mock("@elizaos/app-core/providers", async () => {
  const actual = await vi.importActual<
    typeof import("@elizaos/app-core/providers")
  >("@elizaos/app-core/providers");
  return {
    ...actual,
    getProviderLogo: () => "/logos/placeholder.png",
  };
});

vi.mock("@elizaos/app-core/platform", () => ({
  get isNative() {
    return mockIsNativeFn.value;
  },
  isWebPlatform: () => false,
  isDesktopPlatform: () => true,
  isIOS: false,
  isAndroid: false,
  platform: "web",
}));

import { ActivateStep } from "../../src/components/onboarding/ActivateStep";
import { ConnectionStep } from "../../src/components/onboarding/ConnectionStep";
import { IdentityStep } from "../../src/components/onboarding/IdentityStep";

// ── Helpers ───────────────────────────────────────────────────────────

function baseContext(overrides?: Record<string, unknown>) {
  return {
    t: (k: string) => k,
    onboardingStep: "wakeUp",
    onboardingOptions: {
      names: ["Eliza", "Nova"],
      styles: [{ catchphrase: "default" }],
      cloudProviders: [],
      providers: [
        { id: "openai", name: "OpenAI", description: "GPT API" },
        { id: "anthropic", name: "Anthropic", description: "Claude API" },
      ],
      models: { small: [], large: [] },
      openrouterModels: [],
      piAiModels: [],
      piAiDefaultModel: "",
    },
    onboardingName: "Eliza",
    onboardingOwnerName: "anon",
    onboardingStyle: "default",
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
    onboardingSubscriptionTab: "token" as const,
    onboardingElizaCloudTab: "login" as const,
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
    handleOnboardingNext: vi.fn(async () => { }),
    handleOnboardingBack: vi.fn(),
    handleOnboardingRemoteConnect: vi.fn(async () => { }),
    handleOnboardingUseLocalBackend: vi.fn(),
    handleCloudLogin: vi.fn(async () => { }),
    setState: vi.fn(),
    ...overrides,
  };
}

function collectText(node: TestRenderer.ReactTestInstance): string {
  return node.children
    .map((child) => (typeof child === "string" ? child : collectText(child)))
    .join(" ");
}

function findButtons(
  root: TestRenderer.ReactTestInstance,
): TestRenderer.ReactTestInstance[] {
  return root.findAllByType("button");
}

// ===================================================================
//  IdentityStep
// ===================================================================

describe("IdentityStep", () => {
  beforeEach(() => mockUseApp.mockReset());

  it("renders character select roster with preset characters", async () => {
    mockUseApp.mockReturnValue(baseContext({ onboardingStep: "identity" }));
    let tree: TestRenderer.ReactTestRenderer | undefined;
    await act(async () => {
      tree = TestRenderer.create(React.createElement(IdentityStep));
    });

    const text = collectText(tree?.root as TestRenderer.ReactTestInstance);
    // Should show character names from FRONTEND_PRESETS
    expect(text).toContain("Chen");
    expect(text).toContain("Continue");
  });

  it("calls handleOnboardingNext when Continue is clicked", async () => {
    const next = vi.fn(async () => { });
    mockUseApp.mockReturnValue(baseContext({ onboardingStep: "identity", handleOnboardingNext: next }));
    let tree: TestRenderer.ReactTestRenderer | undefined;
    await act(async () => {
      tree = TestRenderer.create(React.createElement(IdentityStep));
    });

    const buttons = findButtons(tree?.root as TestRenderer.ReactTestInstance);
    const continueBtn = buttons.find(
      (b) => collectText(b) === "Continue",
    );
    expect(continueBtn).toBeDefined();
    await act(async () => {
      continueBtn?.props.onClick();
    });
    expect(next).toHaveBeenCalled();
  });

  it("shows Restore from Backup option", async () => {
    mockUseApp.mockReturnValue(baseContext({ onboardingStep: "identity" }));
    let tree: TestRenderer.ReactTestRenderer | undefined;
    await act(async () => {
      tree = TestRenderer.create(React.createElement(IdentityStep));
    });

    const text = collectText(tree?.root as TestRenderer.ReactTestInstance);
    expect(text).toContain("onboarding.restoreFromBackup");
  });

  it("switches to import view when Restore from Backup is clicked", async () => {
    mockUseApp.mockReturnValue(baseContext({ onboardingStep: "identity" }));
    let tree: TestRenderer.ReactTestRenderer | undefined;
    await act(async () => {
      tree = TestRenderer.create(React.createElement(IdentityStep));
    });

    const buttons = findButtons(tree?.root as TestRenderer.ReactTestInstance);
    const restoreBtn = buttons.find(
      (b) => collectText(b) === "onboarding.restoreFromBackup",
    );
    expect(restoreBtn).toBeDefined();
    await act(async () => {
      restoreBtn?.props.onClick();
    });

    const text = collectText(tree?.root as TestRenderer.ReactTestInstance);
    expect(text).toContain("onboarding.importAgent");
    expect(text).toContain("onboarding.cancel");
    expect(text).toContain("onboarding.restore");
  });
});

// ===================================================================
//  ConnectionStep
// ===================================================================

describe("ConnectionStep", () => {
  beforeEach(() => mockUseApp.mockReset());

  it("renders hosting selection before provider setup", async () => {
    mockUseApp.mockReturnValue(baseContext({ onboardingProvider: "" }));
    let tree: TestRenderer.ReactTestRenderer | undefined;
    await act(async () => {
      tree = TestRenderer.create(React.createElement(ConnectionStep));
    });

    const text = collectText(tree?.root as TestRenderer.ReactTestInstance);
    expect(text).toContain("onboarding.hostingTitle");
    expect(text).toContain("onboarding.hostingQuestion");
    expect(text).toContain("onboarding.hostingLocal");
    expect(text).toContain("onboarding.hostingCloud");
    expect(text).toContain("onboarding.back");
  });

  it("calls handleOnboardingBack from hosting selection", async () => {
    const back = vi.fn();
    mockUseApp.mockReturnValue(
      baseContext({ onboardingProvider: "", handleOnboardingBack: back }),
    );
    let tree: TestRenderer.ReactTestRenderer | undefined;
    await act(async () => {
      tree = TestRenderer.create(React.createElement(ConnectionStep));
    });

    const buttons = findButtons(tree?.root as TestRenderer.ReactTestInstance);
    const backBtn = buttons.find((b) =>
      collectText(b).includes("onboarding.back"),
    );
    expect(backBtn).toBeDefined();
    await act(async () => {
      backBtn?.props.onClick();
    });
    expect(back).toHaveBeenCalled();
  });

  it("renders provider selection grid once local hosting is chosen", async () => {
    mockUseApp.mockReturnValue(
      baseContext({ onboardingRunMode: "local", onboardingProvider: "" }),
    );
    let tree: TestRenderer.ReactTestRenderer | undefined;
    await act(async () => {
      tree = TestRenderer.create(React.createElement(ConnectionStep));
    });

    const text = collectText(tree?.root as TestRenderer.ReactTestInstance);
    expect(text).toContain("onboarding.neuralLinkTitle");
    expect(text).toContain("onboarding.chooseProvider");
  });

  it("renders provider config when a provider is selected", async () => {
    mockUseApp.mockReturnValue(
      baseContext({
        onboardingRunMode: "local",
        onboardingProvider: "openai",
      }),
    );
    let tree: TestRenderer.ReactTestRenderer | undefined;
    await act(async () => {
      tree = TestRenderer.create(React.createElement(ConnectionStep));
    });

    const text = collectText(tree?.root as TestRenderer.ReactTestInstance);
    // Should show provider name and change button
    expect(text).toContain("OpenAI");
    expect(text).toContain("onboarding.change");
  });

  it("renders remote backend fields for self-hosted cloud connections", async () => {
    mockUseApp.mockReturnValue(
      baseContext({
        onboardingRunMode: "cloud",
        onboardingCloudProvider: "remote",
      }),
    );
    let tree: TestRenderer.ReactTestRenderer | undefined;
    await act(async () => {
      tree = TestRenderer.create(React.createElement(ConnectionStep));
    });

    const text = collectText(tree?.root as TestRenderer.ReactTestInstance);
    expect(text).toContain("onboarding.remoteTitle");
    expect(text).toContain("onboarding.remoteAddress");
    expect(text).toContain("onboarding.remoteAccessKey");
    expect(text).toContain("onboarding.remoteConnect");
  });

  it("shows only cloud hosting on mobile (isNative = true)", async () => {
    mockIsNativeFn.value = true;
    mockUseApp.mockReturnValue(
      baseContext({
        onboardingProvider: "",
        onboardingOptions: {
          names: ["Eliza"],
          styles: [{ catchphrase: "default" }],
          cloudProviders: [],
          providers: [
            { id: "elizacloud", name: "Eliza Cloud", description: "Free" },
            { id: "openai", name: "OpenAI", description: "GPT API" },
            { id: "anthropic", name: "Anthropic", description: "Claude API" },
          ],
          models: { small: [], large: [] },
          openrouterModels: [],
          piAiModels: [],
          piAiDefaultModel: "",
        },
      }),
    );
    let tree: TestRenderer.ReactTestRenderer | undefined;
    await act(async () => {
      tree = TestRenderer.create(React.createElement(ConnectionStep));
    });

    const text = collectText(tree?.root as TestRenderer.ReactTestInstance);
    expect(text).toContain("onboarding.hostingCloud");
    expect(text).not.toContain("onboarding.hostingLocal");
    mockIsNativeFn.value = false;
  });
});

// ===================================================================
//  ActivateStep
// ===================================================================

describe("ActivateStep", () => {
  beforeEach(() => mockUseApp.mockReset());

  it("renders ready screen with agent name", async () => {
    mockUseApp.mockReturnValue(baseContext({ onboardingName: "Nova" }));
    let tree: TestRenderer.ReactTestRenderer | undefined;
    await act(async () => {
      tree = TestRenderer.create(React.createElement(ActivateStep));
    });

    const text = collectText(tree?.root as TestRenderer.ReactTestInstance);
    expect(text).toContain("onboarding.readyTitle");
    expect(text).toContain("onboarding.companionReady");
    expect(text).toContain("onboarding.enter");
  });

  it("calls handleOnboardingNext when Enter is clicked", async () => {
    const next = vi.fn(async () => { });
    mockUseApp.mockReturnValue(
      baseContext({ onboardingName: "Nova", handleOnboardingNext: next }),
    );
    let tree: TestRenderer.ReactTestRenderer | undefined;
    await act(async () => {
      tree = TestRenderer.create(React.createElement(ActivateStep));
    });

    const buttons = findButtons(tree?.root as TestRenderer.ReactTestInstance);
    const enterBtn = buttons.find((b) => collectText(b) === "onboarding.enter");
    expect(enterBtn).toBeDefined();
    await act(async () => {
      enterBtn?.props.onClick();
    });
    expect(next).toHaveBeenCalled();
  });

  it("shows fallback name when onboardingName is empty", async () => {
    mockUseApp.mockReturnValue(baseContext({ onboardingName: "" }));
    let tree: TestRenderer.ReactTestRenderer | undefined;
    await act(async () => {
      tree = TestRenderer.create(React.createElement(ActivateStep));
    });

    const text = collectText(tree?.root as TestRenderer.ReactTestInstance);
    expect(text).toContain("onboarding.companionReady");
    expect(text).toContain("onboarding.allConfigured");
  });
});
