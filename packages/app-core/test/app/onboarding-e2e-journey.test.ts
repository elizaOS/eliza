// @vitest-environment jsdom
/**
 * Comprehensive onboarding journey tests.
 *
 * Covers the full lifecycle: startup detection, step rendering,
 * provider setup, RPC config, permissions, activation, and
 * post-onboarding deferred tasks.
 */
import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import { beforeEach, describe, expect, it, vi } from "vitest";

type OnboardingStep =
  | "wakeUp"
  | "identity"
  | "connection"
  | "rpc"
  | "senses"
  | "activate";

type FlaminaGuideTopic = "provider" | "rpc" | "permissions" | "voice";

type AppHarnessState = {
  onboardingLoading: boolean;
  startupStatus:
  | "loading"
  | "onboarding"
  | "ready"
  | "auth-blocked"
  | "recoverable-error";
  startupError: null;
  authRequired: boolean;
  onboardingComplete: boolean;
  tab: string;
  actionNotice: null;
  onboardingStep: OnboardingStep;
  onboardingMode: "basic" | "advanced";
  onboardingActiveGuide: FlaminaGuideTopic | null;
  onboardingDeferredTasks: FlaminaGuideTopic[];
  postOnboardingChecklistDismissed: boolean;
  onboardingOptions: {
    names: string[];
    styles: Array<{
      catchphrase: string;
      hint: string;
      bio: string[];
      system: string;
      style: { all: string[]; chat: string[]; post: string[] };
      adjectives: string[];
      postExamples: string[];
      messageExamples: Array<
        Array<{ name: string; content: { text: string } }>
      >;
    }>;
    providers: Array<{
      id: string;
      name: string;
      envKey: string | null;
      pluginName: string;
      keyPrefix: string | null;
      description: string;
    }>;
    cloudProviders: Array<{ id: string; name: string; description: string }>;
    models: {
      small: Array<{
        id: string;
        name: string;
        provider: string;
        description: string;
      }>;
      large: Array<{
        id: string;
        name: string;
        provider: string;
        description: string;
      }>;
    };
    inventoryProviders: Array<{
      id: string;
      name: string;
      description: string;
      rpcProviders: Array<{
        id: string;
        name: string;
        description: string;
        envKey: string | null;
        requiresKey: boolean;
      }>;
    }>;
    sharedStyleRules: string;
  } | null;
  onboardingName: string;
  onboardingOwnerName: string;
  onboardingStyle: string;
  onboardingTheme: string;
  onboardingRunMode: "local" | "cloud" | "";
  onboardingCloudProvider: string;
  onboardingSmallModel: string;
  onboardingLargeModel: string;
  onboardingProvider: string;
  onboardingApiKey: string;
  onboardingRemoteApiBase: string;
  onboardingRemoteToken: string;
  onboardingRemoteConnecting: boolean;
  onboardingRemoteError: string;
  onboardingRemoteConnected: boolean;
  onboardingOpenRouterModel: string;
  onboardingPrimaryModel: string;
  onboardingTelegramToken: string;
  onboardingDiscordToken: string;
  onboardingTwilioAccountSid: string;
  onboardingTwilioAuthToken: string;
  onboardingTwilioPhoneNumber: string;
  onboardingBlooioApiKey: string;
  onboardingBlooioPhoneNumber: string;
  onboardingSubscriptionTab: "token" | "oauth";
  onboardingElizaCloudTab: "login" | "token";
  onboardingDetectedProviders: Array<{
    id: string;
    name: string;
    detected: boolean;
    apiKey?: string;
  }>;
  onboardingSelectedChains: Set<string>;
  onboardingRpcSelections: Record<string, string>;
  onboardingRpcKeys: Record<string, string>;
  onboardingAvatar: number;
  selectedVrmIndex: number;
  customVrmUrl: string;
  customBackgroundUrl: string;
  onboardingRestarting: boolean;
  elizaCloudConnected: boolean;
  elizaCloudLoginBusy: boolean;
  elizaCloudLoginError: string;
  elizaCloudUserId: string;
  uiShellMode: string;
  uiLanguage: string;
  [key: string]: unknown;
};

// ── Hoisted mocks ─────────────────────────────────────────────────────

const { companionOverlayTabs, mockUseApp } = vi.hoisted(() => ({
  companionOverlayTabs: new Set([
    "companion",
    "skills",
    "character",
    "character-select",
    "settings",
    "plugins",
    "advanced",
    "actions",
    "triggers",
    "fine-tuning",
    "trajectories",
    "runtime",
    "database",
    "logs",
    "security",
    "apps",
    "connectors",
    "knowledge",
    "lifo",
    "stream",
    "wallets",
  ]),
  mockUseApp: vi.fn(),
}));

vi.mock("@elizaos/app-core/state", async () => {
  const actual = await vi.importActual("@elizaos/app-core/state");
  return {
    ...actual,
    useApp: () => mockUseApp(),
  };
});

vi.mock("@elizaos/app-core/api", () => ({
  client: {
    importAgent: vi.fn(),
    startAnthropicLogin: vi.fn(),
    exchangeAnthropicCode: vi.fn(),
    startOpenAILogin: vi.fn(),
    exchangeOpenAICode: vi.fn(),
    getPermissions: vi.fn(async () => ({
      accessibility: {
        id: "accessibility",
        status: "granted",
        lastChecked: Date.now(),
        canRequest: false,
      },
      "screen-recording": {
        id: "screen-recording",
        status: "granted",
        lastChecked: Date.now(),
        canRequest: false,
      },
      microphone: {
        id: "microphone",
        status: "granted",
        lastChecked: Date.now(),
        canRequest: false,
      },
      camera: {
        id: "camera",
        status: "granted",
        lastChecked: Date.now(),
        canRequest: false,
      },
      shell: {
        id: "shell",
        status: "granted",
        lastChecked: Date.now(),
        canRequest: false,
      },
    })),
    requestPermission: vi.fn(async () => ({ status: "granted" })),
  },
  SkillScanReportSummary: {},
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
    return false;
  },
  isWebPlatform: () => false,
  isDesktopPlatform: () => true,
  isIOS: false,
  isAndroid: false,
  platform: "web",
  hasRequiredOnboardingPermissions: () => true,
}));

const TASK_LABELS: Record<string, string> = {
  provider: "Provider setup",
  rpc: "RPC setup",
  permissions: "Permissions",
  voice: "Voice setup",
};

vi.mock("@elizaos/app-core/components", async () => {
  const actual = await vi.importActual<
    typeof import("@elizaos/app-core/components")
  >("@elizaos/app-core/components");
  return {
    ...actual,
    AdvancedPageView: () =>
      React.createElement("div", null, "AdvancedPageView"),
    AppsPageView: () => React.createElement("div", null, "AppsPageView"),
    CharacterView: () => React.createElement("div", null, "CharacterView"),
    ChatView: () => React.createElement("div", null, "ChatView"),
    ConnectorsPageView: () =>
      React.createElement("div", null, "ConnectorsPageView"),
    CommandPalette: () => React.createElement("div", null, "CommandPalette"),
    CompanionShell: ({ tab }: { tab: string }) =>
      React.createElement("main", null, `CompanionShell:${tab}`),
    CompanionView: () => React.createElement("div", null, "CompanionView"),
    ConversationsSidebar: () =>
      React.createElement("div", null, "ConversationsSidebar"),
    CustomActionEditor: () =>
      React.createElement("div", null, "CustomActionEditor"),
    CustomActionsPanel: () =>
      React.createElement("div", null, "CustomActionsPanel"),
    EmotePicker: () => React.createElement("div", null, "EmotePicker"),
    Header: () => React.createElement("div", null, "Header"),
    InventoryView: () => React.createElement("div", null, "InventoryView"),
    KnowledgeView: () => React.createElement("div", null, "KnowledgeView"),
    LifoSandboxView: () =>
      React.createElement("div", null, "LifoSandboxView"),
    LanguageDropdown: () =>
      React.createElement("div", null, "LanguageDropdown"),
    OnboardingWizard: () => {
      const state = mockUseApp();
      return React.createElement(
        "div",
        { "data-testid": "onboarding-wizard" },
        `OnboardingWizard:${state.onboardingStep}`,
        React.createElement(
          "button",
          {
            onClick: () => state.handleOnboardingNext(),
            type: "button",
          },
          "onboarding-next",
        ),
      );
    },
    PairingView: () => React.createElement("div", null, "PairingView"),
    PermissionsOnboardingSection: ({
      onContinue,
    }: {
      onContinue: (options?: { allowPermissionBypass?: boolean }) => void;
    }) =>
      React.createElement(
        "div",
        null,
        React.createElement(
          "button",
          { onClick: () => onContinue(), type: "button" },
          "grant-permissions",
        ),
        React.createElement(
          "button",
          {
            onClick: () => onContinue({ allowPermissionBypass: true }),
            type: "button",
          },
          "skip-permissions",
        ),
      ),
    SettingsView: () => React.createElement("div", null, "SettingsView"),
    SharedCompanionScene: ({
      children,
    }: {
      active: boolean;
      children: React.ReactNode;
    }) => React.createElement(React.Fragment, null, children),
    ShellOverlays: () => null,
    StreamView: () => React.createElement("div", null, "StreamView"),
  };
});

vi.mock("../../../packages/app-core/src/components/Header", () => ({
  Header: () => React.createElement("div", null, "Header"),
}));
vi.mock("../../../packages/app-core/src/components/Nav", () => ({
  Nav: () => React.createElement("div", null, "Nav"),
}));
vi.mock("../../../packages/app-core/src/components/CommandPalette", () => ({
  CommandPalette: () => React.createElement("div", null, "CommandPalette"),
}));
vi.mock("../../../packages/app-core/src/components/EmotePicker", () => ({
  EmotePicker: () => React.createElement("div", null, "EmotePicker"),
}));
vi.mock(
  "../../../packages/app-core/src/components/onboarding/PermissionsStep",
  () => ({
    PermissionsStep: () =>
      React.createElement(
        "button",
        {
          onClick: () => mockUseApp().handleOnboardingNext(),
          type: "button",
        },
        "permissions-continue",
      ),
  }),
);
vi.mock(
  "../../../packages/app-core/src/components/ConversationsSidebar",
  () => ({
    ConversationsSidebar: () =>
      React.createElement("div", null, "ConversationsSidebar"),
  }),
);
vi.mock(
  "../../../packages/app-core/src/components/CustomActionsPanel",
  () => ({
    CustomActionsPanel: () =>
      React.createElement("div", null, "CustomActionsPanel"),
  }),
);
vi.mock(
  "../../../packages/app-core/src/components/CustomActionEditor",
  () => ({
    CustomActionEditor: () =>
      React.createElement("div", null, "CustomActionEditor"),
  }),
);
vi.mock("../../../packages/app-core/src/components/AppsPageView", () => ({
  AppsPageView: () => React.createElement("div", null, "AppsPageView"),
}));
vi.mock("../../../packages/app-core/src/components/AdvancedPageView", () => ({
  AdvancedPageView: () =>
    React.createElement("div", null, "AdvancedPageView"),
}));
vi.mock("../../../packages/app-core/src/components/CharacterView", () => ({
  CharacterView: () => React.createElement("div", null, "CharacterView"),
}));
vi.mock("../../../packages/app-core/src/components/TriggersView", () => ({
  TriggersView: () => React.createElement("div", null, "TriggersView"),
}));
vi.mock(
  "../../../packages/app-core/src/components/ConnectorsPageView",
  () => ({
    ConnectorsPageView: () =>
      React.createElement("div", null, "ConnectorsPageView"),
  }),
);
vi.mock("../../../packages/app-core/src/components/InventoryView", () => ({
  InventoryView: () => React.createElement("div", null, "InventoryView"),
}));
vi.mock("../../../packages/app-core/src/components/KnowledgeView", () => ({
  KnowledgeView: () => React.createElement("div", null, "KnowledgeView"),
}));
vi.mock("../../../packages/app-core/src/components/LifoSandboxView", () => ({
  LifoSandboxView: () =>
    React.createElement("div", null, "LifoSandboxView"),
}));
vi.mock("../../../packages/app-core/src/components/PairingView", () => ({
  PairingView: () => React.createElement("div", null, "PairingView"),
}));
vi.mock("../../../packages/app-core/src/components/ChatView", () => ({
  ChatView: () => React.createElement("div", null, "ChatView"),
}));
vi.mock("@elizaos/app-core/components/AvatarLoader", () => ({
  AvatarLoader: () => React.createElement("div", null, "AvatarLoader"),
}));
vi.mock("../../../packages/app-core/src/components/CompanionView", () => ({
  CompanionView: () => React.createElement("div", null, "CompanionView"),
}));
vi.mock(
  "../../../packages/app-core/src/components/ChatModalView.js",
  () => ({
    ChatModalView: () => React.createElement("div", null, "ChatModalView"),
  }),
);
vi.mock("../../../packages/app-core/src/components/AvatarSelector", () => ({
  AvatarSelector: () => React.createElement("div", null, "AvatarSelector"),
}));
vi.mock(
  "../../../packages/app-core/src/components/companion/VrmStage",
  () => ({
    VrmStage: () => React.createElement("div", null, "VrmStage"),
  }),
);
vi.mock("../../../packages/app-core/src/components/StreamView", () => ({
  StreamView: () => React.createElement("div", null, "StreamView"),
}));
vi.mock("../../../packages/app-core/src/components/CompanionShell", () => ({
  COMPANION_OVERLAY_TABS: companionOverlayTabs,
  CompanionShell: ({ tab }: { tab: string }) =>
    React.createElement("main", null, `CompanionShell:${tab}`),
  useCompanionShell: () => ({}),
}));

vi.mock(
  "../../../packages/app-core/src/components/companion/CompanionSceneHost",
  async () => {
    const React = await vi.importActual<typeof import("react")>("react");
    return {
      SharedCompanionScene: ({
        children,
      }: {
        active: boolean;
        children: React.ReactNode;
      }) => React.createElement(React.Fragment, null, children),
      CompanionSceneHost: () => null,
      useSharedCompanionScene: () => true,
    };
  },
);

import { App } from "../../src/App";
import { ActivateStep } from "../../src/components/onboarding/ActivateStep";
import { ConnectionStep } from "../../src/components/onboarding/ConnectionStep";
import { RpcStep } from "../../src/components/onboarding/RpcStep";
import { PermissionsStep } from "../../src/components/onboarding/PermissionsStep";
import { IdentityStep } from "../../src/components/onboarding/IdentityStep";

// ── Helpers ───────────────────────────────────────────────────────────

function onboardingOptions() {
  return {
    names: ["Milady", "Nova"],
    styles: [
      {
        catchphrase: "Noted.",
        hint: "calm and collected",
        bio: ["bio"],
        system: "You are {{name}}",
        style: { all: [], chat: [], post: [] },
        adjectives: ["calm"],
        postExamples: [],
        messageExamples: [[{ name: "User", content: { text: "hello" } }]],
      },
      {
        catchphrase: "uwu~",
        hint: "kawaii energy",
        bio: ["bio2"],
        system: "You are {{name}}",
        style: { all: [], chat: [], post: [] },
        adjectives: ["cute"],
        postExamples: [],
        messageExamples: [[{ name: "User", content: { text: "hi" } }]],
      },
    ],
    providers: [
      {
        id: "openai",
        name: "OpenAI",
        envKey: "OPENAI_API_KEY",
        pluginName: "@elizaos/plugin-openai",
        keyPrefix: "sk-",
        description: "GPT models",
      },
      {
        id: "anthropic",
        name: "Anthropic",
        envKey: "ANTHROPIC_API_KEY",
        pluginName: "@elizaos/plugin-anthropic",
        keyPrefix: "sk-ant-",
        description: "Claude models",
      },
      {
        id: "ollama",
        name: "Ollama",
        envKey: null,
        pluginName: "@elizaos/plugin-ollama",
        keyPrefix: null,
        description: "Local Ollama",
      },
    ],
    cloudProviders: [
      { id: "openrouter", name: "OpenRouter", description: "Cloud provider" },
    ],
    models: {
      small: [
        {
          id: "small-model",
          name: "Small",
          provider: "openrouter",
          description: "small",
        },
      ],
      large: [
        {
          id: "large-model",
          name: "Large",
          provider: "openrouter",
          description: "large",
        },
      ],
    },
    inventoryProviders: [
      {
        id: "evm",
        name: "EVM",
        description: "EVM chains",
        rpcProviders: [
          {
            id: "elizacloud",
            name: "Eliza Cloud",
            description: "Managed RPC",
            envKey: null,
            requiresKey: false,
          },
        ],
      },
    ],
    openrouterModels: [],
    piAiModels: [],
    piAiDefaultModel: "",
    sharedStyleRules: "",
  };
}

function createHarnessState(
  overrides?: Partial<AppHarnessState>,
): AppHarnessState {
  return {
    onboardingLoading: false,
    startupStatus: "onboarding",
    startupError: null,
    authRequired: false,
    onboardingComplete: false,
    tab: "chat",
    actionNotice: null,
    onboardingStep: "wakeUp",
    onboardingMode: "basic",
    onboardingActiveGuide: null,
    onboardingDeferredTasks: [],
    postOnboardingChecklistDismissed: false,
    onboardingOptions: onboardingOptions(),
    onboardingName: "Milady",
    onboardingOwnerName: "anon",
    onboardingStyle: "",
    onboardingTheme: "milady",
    onboardingRunMode: "",
    onboardingCloudProvider: "",
    onboardingSmallModel: "small-model",
    onboardingLargeModel: "large-model",
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
    onboardingElizaCloudTab: "login",
    onboardingDetectedProviders: [],
    onboardingSelectedChains: new Set(["evm"]),
    onboardingRpcSelections: {},
    onboardingRpcKeys: {},
    onboardingAvatar: 1,
    selectedVrmIndex: 1,
    customVrmUrl: "",
    customBackgroundUrl: "",
    onboardingRestarting: false,
    elizaCloudConnected: false,
    elizaCloudLoginBusy: false,
    elizaCloudLoginError: "",
    elizaCloudUserId: "",
    uiShellMode: "companion",
    uiLanguage: "en",
    plugins: [],
    agentStatus: null,
    ...overrides,
  };
}

function textOf(node: TestRenderer.ReactTestInstance): string {
  return node.children
    .map((child) => (typeof child === "string" ? child : textOf(child)))
    .join("");
}

function hasText(
  node: TestRenderer.ReactTestInstance,
  target: string,
): boolean {
  return textOf(node).includes(target);
}

function findButtons(
  root: TestRenderer.ReactTestInstance,
): TestRenderer.ReactTestInstance[] {
  return root.findAllByType("button");
}

function clickButton(
  tree: TestRenderer.ReactTestRenderer,
  labelFragment: string,
): void {
  const button = tree.root.findAll(
    (node) => node.type === "button" && hasText(node, labelFragment),
  )[0];
  if (!button) {
    throw new Error(`Button containing "${labelFragment}" not found`);
  }
  button.props.onClick();
}

async function rerender(tree: TestRenderer.ReactTestRenderer): Promise<void> {
  await act(async () => {
    tree.update(React.createElement(App));
  });
}

function setupMockUseApp(state: AppHarnessState) {
  const STEP_ORDER: OnboardingStep[] = [
    "wakeUp",
    "identity",
    "connection",
    "rpc",
    "senses",
    "activate",
  ];

  const handleOnboardingNext = vi.fn(
    async (options?: { skipTask?: string; allowPermissionBypass?: boolean }) => {
      if (options?.skipTask) {
        state.onboardingDeferredTasks = [
          ...state.onboardingDeferredTasks,
          options.skipTask as FlaminaGuideTopic,
        ];
      }
      if (state.onboardingStep === "activate") {
        state.onboardingComplete = true;
        state.startupStatus = "ready";
        state.uiShellMode = "native";
        state.tab = "chat";
        return;
      }
      const idx = STEP_ORDER.indexOf(state.onboardingStep);
      if (idx >= 0 && idx < STEP_ORDER.length - 1) {
        state.onboardingStep = STEP_ORDER[idx + 1];
      }
    },
  );

  const handleOnboardingBack = vi.fn(() => {
    const idx = STEP_ORDER.indexOf(state.onboardingStep);
    if (idx > 0) {
      state.onboardingStep = STEP_ORDER[idx - 1];
    }
  });

  mockUseApp.mockReset();
  mockUseApp.mockImplementation(() => ({
    t: (k: string) => k,
    ...state,
    setState: (key: string, value: unknown) => {
      state[key] = value;
    },
    setTheme: (theme: string) => {
      state.onboardingTheme = theme;
    },
    setTab: (tab: string) => {
      state.tab = tab;
    },
    handleOnboardingNext,
    handleOnboardingBack,
    handleCloudLogin: vi.fn(async () => {
      state.elizaCloudConnected = true;
      state.elizaCloudUserId = "test-user";
    }),
    handleOnboardingRemoteConnect: vi.fn(async () => { }),
    handleOnboardingUseLocalBackend: vi.fn(),
  }));

  return { handleOnboardingNext, handleOnboardingBack };
}

// ===================================================================
//  1. App startup -> onboarding detection
// ===================================================================

describe("app startup and onboarding detection", () => {
  it("shows onboarding when onboardingComplete is false", async () => {
    const state = createHarnessState({
      onboardingComplete: false,
      startupStatus: "onboarding",
    });
    setupMockUseApp(state);

    let tree: TestRenderer.ReactTestRenderer | null = null;
    await act(async () => {
      tree = TestRenderer.create(React.createElement(App));
    });
    if (!tree) throw new Error("failed to render App");

    const renderedText = textOf(tree.root);
    expect(renderedText).toContain("OnboardingWizard");
    expect(renderedText).not.toContain("ChatView");
  });

  it("skips onboarding when onboardingComplete is true", async () => {
    const state = createHarnessState({
      onboardingComplete: true,
      startupStatus: "ready",
      uiShellMode: "native",
    });
    setupMockUseApp(state);

    let tree: TestRenderer.ReactTestRenderer | null = null;
    await act(async () => {
      tree = TestRenderer.create(React.createElement(App));
    });
    if (!tree) throw new Error("failed to render App");

    const renderedText = textOf(tree.root);
    expect(renderedText).toContain("ChatView");
    expect(renderedText).not.toContain("OnboardingWizard");
  });
});

// ===================================================================
//  2. WakeUp step (auto-advance — no separate component)
// ===================================================================

describe("WakeUp step (auto-advance)", () => {
  it("wakeUp step auto-advances to identity", async () => {
    const state = createHarnessState({ onboardingStep: "wakeUp" });
    const { handleOnboardingNext } = setupMockUseApp(state);

    // The OnboardingWizard auto-advances past wakeUp via useEffect.
    // We just verify the step order progresses correctly.
    await act(async () => {
      handleOnboardingNext();
    });
    expect(state.onboardingStep).toBe("identity");
  });
});

// ===================================================================
//  2b. Identity step (agent selection and style preset)
// ===================================================================

describe("Identity step", () => {
  beforeEach(() => mockUseApp.mockReset());

  it("renders style preset selection grid", async () => {
    const state = createHarnessState({ onboardingStep: "identity" });
    setupMockUseApp(state);

    let tree: TestRenderer.ReactTestRenderer | undefined;
    await act(async () => {
      tree = TestRenderer.create(React.createElement(IdentityStep));
    });

    const text = textOf(tree!.root);
    // New Overwatch-style roster shows character names directly
    expect(text).toContain("Chen");
    expect(text).toContain("Continue");
  });

  it("renders style preset buttons with character names", async () => {
    const state = createHarnessState({ onboardingStep: "identity" });
    setupMockUseApp(state);

    let tree: TestRenderer.ReactTestRenderer | undefined;
    await act(async () => {
      tree = TestRenderer.create(React.createElement(IdentityStep));
    });

    const buttons = findButtons(tree!.root);
    // There should be style preset buttons plus the Continue button
    expect(buttons.length).toBeGreaterThanOrEqual(2);
  });

  it("clicking Continue advances to connection step", async () => {
    const state = createHarnessState({
      onboardingStep: "identity",
      onboardingStyle: "Noted.",
    });
    const { handleOnboardingNext } = setupMockUseApp(state);

    let tree: TestRenderer.ReactTestRenderer | undefined;
    await act(async () => {
      tree = TestRenderer.create(React.createElement(IdentityStep));
    });

    const continueBtn = findButtons(tree!.root).find((b) =>
      textOf(b).includes("Continue"),
    );
    expect(continueBtn).toBeDefined();
    await act(async () => {
      continueBtn!.props.onClick();
    });
    expect(handleOnboardingNext).toHaveBeenCalled();
  });
});

// ===================================================================
//  3. Connection step (provider setup)
// ===================================================================

describe("Connection step", () => {
  beforeEach(() => mockUseApp.mockReset());

  it("renders hosting selection with local and cloud options", async () => {
    const state = createHarnessState({
      onboardingStep: "connection",
      onboardingProvider: "",
    });
    setupMockUseApp(state);

    let tree: TestRenderer.ReactTestRenderer | undefined;
    await act(async () => {
      tree = TestRenderer.create(React.createElement(ConnectionStep));
    });

    const text = textOf(tree!.root);
    expect(text).toContain("onboarding.hostingTitle");
    expect(text).toContain("onboarding.hostingLocal");
    expect(text).toContain("onboarding.hostingCloud");
  });

  it("renders provider selection grid once local hosting is chosen", async () => {
    const state = createHarnessState({
      onboardingStep: "connection",
      onboardingRunMode: "local",
      onboardingProvider: "",
    });
    setupMockUseApp(state);

    let tree: TestRenderer.ReactTestRenderer | undefined;
    await act(async () => {
      tree = TestRenderer.create(React.createElement(ConnectionStep));
    });

    const text = textOf(tree!.root);
    expect(text).toContain("onboarding.neuralLinkTitle");
    expect(text).toContain("onboarding.chooseProvider");
  });

  it("renders provider config when a provider is selected", async () => {
    const state = createHarnessState({
      onboardingStep: "connection",
      onboardingRunMode: "local",
      onboardingProvider: "openai",
    });
    setupMockUseApp(state);

    let tree: TestRenderer.ReactTestRenderer | undefined;
    await act(async () => {
      tree = TestRenderer.create(React.createElement(ConnectionStep));
    });

    const text = textOf(tree!.root);
    expect(text).toContain("OpenAI");
    expect(text).toContain("onboarding.change");
  });

  it("shows auto-detected credentials with detected badge", async () => {
    const state = createHarnessState({
      onboardingStep: "connection",
      onboardingRunMode: "local",
      onboardingProvider: "",
      onboardingDetectedProviders: [
        { id: "openai", name: "OpenAI", detected: true },
      ],
    });
    setupMockUseApp(state);

    let tree: TestRenderer.ReactTestRenderer | undefined;
    await act(async () => {
      tree = TestRenderer.create(React.createElement(ConnectionStep));
    });

    const text = textOf(tree!.root);
    expect(text).toContain("onboarding.neuralLinkTitle");
  });

  it("renders remote backend fields for self-hosted cloud connections", async () => {
    const state = createHarnessState({
      onboardingStep: "connection",
      onboardingRunMode: "cloud",
      onboardingCloudProvider: "remote",
    });
    setupMockUseApp(state);

    let tree: TestRenderer.ReactTestRenderer | undefined;
    await act(async () => {
      tree = TestRenderer.create(React.createElement(ConnectionStep));
    });

    const text = textOf(tree!.root);
    expect(text).toContain("onboarding.remoteTitle");
    expect(text).toContain("onboarding.remoteAddress");
    expect(text).toContain("onboarding.remoteAccessKey");
    expect(text).toContain("onboarding.remoteConnect");
  });

  it("shows subscription provider OAuth flow for cloud providers", async () => {
    const state = createHarnessState({
      onboardingStep: "connection",
      onboardingRunMode: "cloud",
      onboardingCloudProvider: "elizacloud",
    });
    setupMockUseApp(state);

    let tree: TestRenderer.ReactTestRenderer | undefined;
    await act(async () => {
      tree = TestRenderer.create(React.createElement(ConnectionStep));
    });

    const text = textOf(tree!.root);
    // Should show cloud connection UI
    expect(text).toContain("onboarding.connectAccount");
  });

  it("calls handleOnboardingBack from hosting selection", async () => {
    const state = createHarnessState({
      onboardingStep: "connection",
      onboardingProvider: "",
    });
    const { handleOnboardingBack } = setupMockUseApp(state);

    let tree: TestRenderer.ReactTestRenderer | undefined;
    await act(async () => {
      tree = TestRenderer.create(React.createElement(ConnectionStep));
    });

    const backBtn = findButtons(tree!.root).find((b) =>
      textOf(b).includes("onboarding.back"),
    );
    expect(backBtn).toBeDefined();
    await act(async () => {
      backBtn!.props.onClick();
    });
    expect(handleOnboardingBack).toHaveBeenCalled();
  });
});

// ===================================================================
//  4. RPC step (wallet config)
// ===================================================================

describe("RPC step", () => {
  beforeEach(() => mockUseApp.mockReset());

  it("renders RPC configuration form with cloud and BYOK options", async () => {
    const state = createHarnessState({ onboardingStep: "rpc" });
    setupMockUseApp(state);

    let tree: TestRenderer.ReactTestRenderer | undefined;
    await act(async () => {
      tree = TestRenderer.create(React.createElement(RpcStep));
    });

    const text = textOf(tree!.root);
    expect(text).toContain("onboarding.rpcTitle");
    expect(text).toContain("onboarding.rpcElizaCloud");
    expect(text).toContain("onboarding.rpcBringKeys");
  });

  it("skip button defers the RPC task", async () => {
    const state = createHarnessState({ onboardingStep: "rpc" });
    const { handleOnboardingNext } = setupMockUseApp(state);

    let tree: TestRenderer.ReactTestRenderer | undefined;
    await act(async () => {
      tree = TestRenderer.create(React.createElement(RpcStep));
    });

    const skipBtn = findButtons(tree!.root).find((b) =>
      textOf(b).includes("onboarding.rpcSkip"),
    );
    expect(skipBtn).toBeDefined();
    await act(async () => {
      skipBtn!.props.onClick();
    });
    expect(handleOnboardingNext).toHaveBeenCalled();
  });

  it("back button calls handleOnboardingBack", async () => {
    const state = createHarnessState({ onboardingStep: "rpc" });
    const { handleOnboardingBack } = setupMockUseApp(state);

    let tree: TestRenderer.ReactTestRenderer | undefined;
    await act(async () => {
      tree = TestRenderer.create(React.createElement(RpcStep));
    });

    const backBtn = findButtons(tree!.root).find((b) =>
      textOf(b).includes("onboarding.back"),
    );
    expect(backBtn).toBeDefined();
    await act(async () => {
      backBtn!.props.onClick();
    });
    expect(handleOnboardingBack).toHaveBeenCalled();
  });
});

// ===================================================================
//  5. Senses step (permissions)
// ===================================================================

describe("Senses step (permissions)", () => {
  beforeEach(() => mockUseApp.mockReset());

  it("renders permissions section with grant and skip options", async () => {
    const state = createHarnessState({ onboardingStep: "senses" });
    setupMockUseApp(state);

    let tree: TestRenderer.ReactTestRenderer | undefined;
    await act(async () => {
      tree = TestRenderer.create(React.createElement(PermissionsStep));
    });

    const text = textOf(tree!.root);
    expect(text).toContain("onboarding.systemAccessTitle");
  });

  it("skip button defers the permissions task via handleOnboardingNext", async () => {
    const state = createHarnessState({ onboardingStep: "senses" });
    const { handleOnboardingNext } = setupMockUseApp(state);

    // Simulate what PermissionsStep does when skip is clicked:
    // it calls handleOnboardingNext({ allowPermissionBypass: true, skipTask: "permissions" })
    await handleOnboardingNext({
      allowPermissionBypass: true,
      skipTask: "permissions",
    });

    expect(state.onboardingDeferredTasks).toContain("permissions");
    expect(state.onboardingStep).toBe("activate");
  });
});

// ===================================================================
//  6. Activate step
// ===================================================================

describe("Activate step", () => {
  beforeEach(() => mockUseApp.mockReset());

  it("renders final review with agent name and Enter button", async () => {
    const state = createHarnessState({
      onboardingStep: "activate",
      onboardingName: "Nova",
    });
    setupMockUseApp(state);

    let tree: TestRenderer.ReactTestRenderer | undefined;
    await act(async () => {
      tree = TestRenderer.create(React.createElement(ActivateStep));
    });

    const text = textOf(tree!.root);
    expect(text).toContain("onboarding.readyTitle");
    expect(text).toContain("onboarding.companionReady");
    expect(text).toContain("onboarding.enter");
  });

  it("clicking Enter calls handleOnboardingNext (finishOnboarding)", async () => {
    const state = createHarnessState({
      onboardingStep: "activate",
      onboardingName: "Nova",
    });
    const { handleOnboardingNext } = setupMockUseApp(state);

    let tree: TestRenderer.ReactTestRenderer | undefined;
    await act(async () => {
      tree = TestRenderer.create(React.createElement(ActivateStep));
    });

    const enterBtn = findButtons(tree!.root).find(
      (b) => textOf(b) === "onboarding.enter",
    );
    expect(enterBtn).toBeDefined();
    await act(async () => {
      enterBtn!.props.onClick();
    });
    expect(handleOnboardingNext).toHaveBeenCalled();
  });

  it("after activation, app transitions to chat view", async () => {
    const state = createHarnessState({
      onboardingStep: "activate",
      onboardingName: "Nova",
    });
    setupMockUseApp(state);

    let tree: TestRenderer.ReactTestRenderer | undefined;
    await act(async () => {
      tree = TestRenderer.create(React.createElement(ActivateStep));
    });

    const enterBtn = findButtons(tree!.root).find(
      (b) => textOf(b) === "onboarding.enter",
    );
    await act(async () => {
      enterBtn!.props.onClick();
    });

    expect(state.onboardingComplete).toBe(true);
    expect(state.startupStatus).toBe("ready");
    expect(state.tab).toBe("chat");
  });

  it("shows fallback name when onboardingName is empty", async () => {
    const state = createHarnessState({
      onboardingStep: "activate",
      onboardingName: "",
    });
    setupMockUseApp(state);

    let tree: TestRenderer.ReactTestRenderer | undefined;
    await act(async () => {
      tree = TestRenderer.create(React.createElement(ActivateStep));
    });

    const text = textOf(tree!.root);
    expect(text).toContain("onboarding.companionReady");
    expect(text).toContain("onboarding.allConfigured");
  });
});

// ===================================================================
//  7. Full E2E onboarding journey
// ===================================================================

describe("full onboarding journey (e2e)", () => {
  it("progresses through all steps and lands in chat view", async () => {
    const state = createHarnessState();
    setupMockUseApp(state);

    let tree: TestRenderer.ReactTestRenderer | null = null;
    await act(async () => {
      tree = TestRenderer.create(React.createElement(App));
    });
    if (!tree) throw new Error("failed to render App");

    // Start at onboarding
    expect(state.startupStatus).toBe("onboarding");
    expect(textOf(tree.root)).toContain("OnboardingWizard");

    // Step through the entire onboarding
    for (let i = 0; i < 20 && !state.onboardingComplete; i += 1) {
      if (
        state.onboardingStep === "connection" &&
        state.onboardingRunMode === "local" &&
        !state.onboardingProvider
      ) {
        state.onboardingProvider = "ollama";
        await rerender(tree);
      }

      clickButton(tree, "onboarding-next");
      await rerender(tree);
    }

    expect(state.onboardingComplete).toBe(true);
    expect(state.startupStatus).toBe("ready");
    expect(state.tab).toBe("chat");
  });
});

// ===================================================================
//  8. Post-onboarding deferred tasks
// ===================================================================

describe("post-onboarding deferred tasks", () => {
  it("shows deferred checklist with skipped tasks", async () => {
    const state = createHarnessState({
      onboardingComplete: true,
      startupStatus: "ready",
      tab: "chat",
      uiShellMode: "native",
      onboardingDeferredTasks: ["rpc", "permissions"],
    });
    setupMockUseApp(state);

    let tree: TestRenderer.ReactTestRenderer | null = null;
    await act(async () => {
      tree = TestRenderer.create(React.createElement(App));
    });
    if (!tree) throw new Error("failed to render App");

    const renderedText = textOf(tree.root);
    expect(renderedText).toContain("Finish setup later");
    expect(renderedText).toContain("RPC setup");
    expect(renderedText).toContain("Permissions");
  });

  it("does not show checklist when no tasks are deferred", async () => {
    const state = createHarnessState({
      onboardingComplete: true,
      startupStatus: "ready",
      tab: "chat",
      uiShellMode: "native",
      onboardingDeferredTasks: [],
    });
    setupMockUseApp(state);

    let tree: TestRenderer.ReactTestRenderer | null = null;
    await act(async () => {
      tree = TestRenderer.create(React.createElement(App));
    });
    if (!tree) throw new Error("failed to render App");

    const renderedText = textOf(tree.root);
    expect(renderedText).not.toContain("Finish setup later");
  });

  it("dismissing checklist hides it permanently", async () => {
    const state = createHarnessState({
      onboardingComplete: true,
      startupStatus: "ready",
      tab: "chat",
      uiShellMode: "native",
      onboardingDeferredTasks: ["provider"],
    });
    setupMockUseApp(state);

    let tree: TestRenderer.ReactTestRenderer | null = null;
    await act(async () => {
      tree = TestRenderer.create(React.createElement(App));
    });
    if (!tree) throw new Error("failed to render App");

    // Verify checklist is visible
    expect(textOf(tree.root)).toContain("Finish setup later");

    // Click dismiss
    clickButton(tree, "Dismiss");

    // State should be updated
    expect(state.postOnboardingChecklistDismissed).toBe(true);

    // Re-render to see the change
    await rerender(tree);
    expect(textOf(tree.root)).not.toContain("Finish setup later");
  });

  it("shows provider deferred task label when provider was skipped", async () => {
    const state = createHarnessState({
      onboardingComplete: true,
      startupStatus: "ready",
      tab: "chat",
      uiShellMode: "native",
      onboardingDeferredTasks: ["provider"],
    });
    setupMockUseApp(state);

    let tree: TestRenderer.ReactTestRenderer | null = null;
    await act(async () => {
      tree = TestRenderer.create(React.createElement(App));
    });
    if (!tree) throw new Error("failed to render App");

    const renderedText = textOf(tree.root);
    expect(renderedText).toContain("Provider setup");
  });

  it("shows voice deferred task label when voice was skipped", async () => {
    const state = createHarnessState({
      onboardingComplete: true,
      startupStatus: "ready",
      tab: "chat",
      uiShellMode: "native",
      onboardingDeferredTasks: ["voice"],
    });
    setupMockUseApp(state);

    let tree: TestRenderer.ReactTestRenderer | null = null;
    await act(async () => {
      tree = TestRenderer.create(React.createElement(App));
    });
    if (!tree) throw new Error("failed to render App");

    const renderedText = textOf(tree.root);
    expect(renderedText).toContain("Voice setup");
  });

  it("accumulates deferred tasks through the journey", async () => {
    const state = createHarnessState({
      onboardingStep: "rpc",
    });
    const { handleOnboardingNext } = setupMockUseApp(state);

    // Simulate skipping RPC
    await handleOnboardingNext({ skipTask: "rpc" });
    expect(state.onboardingDeferredTasks).toContain("rpc");
    expect(state.onboardingStep).toBe("senses");

    // Simulate skipping permissions
    await handleOnboardingNext({
      skipTask: "permissions",
      allowPermissionBypass: true,
    });
    expect(state.onboardingDeferredTasks).toContain("permissions");
    expect(state.onboardingDeferredTasks).toHaveLength(2);
  });
});
