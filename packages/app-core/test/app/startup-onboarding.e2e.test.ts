// @vitest-environment jsdom
import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import { beforeEach, describe, expect, it, vi } from "vitest";

type OnboardingStep = "identity" | "connection" | "rpc" | "senses" | "activate";

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
  onboardingActiveGuide: "provider" | "rpc" | "permissions" | "voice" | null;
  onboardingDeferredTasks: Array<
    "provider" | "rpc" | "permissions" | "voice"
  >;
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
  onboardingSelectedChains: Set<string>;
  onboardingRpcSelections: Record<string, string>;
  onboardingRpcKeys: Record<string, string>;
  onboardingAvatar: number;
  onboardingRestarting: boolean;
  elizaCloudConnected: boolean;
  elizaCloudLoginBusy: boolean;
  elizaCloudLoginError: string;
  elizaCloudUserId: string;
  uiShellMode: string;
  [key: string]: unknown;
};

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
    LifoSandboxView: () => React.createElement("div", null, "LifoSandboxView"),
    OnboardingWizard: () => {
      const state = mockUseApp();
      if (state.onboardingStep === "identity") {
        return React.createElement(
          "button",
          {
            onClick: () => state.handleOnboardingNext(),
            type: "button",
          },
          "onboarding.chooseAgent",
        );
      }
      if (state.onboardingStep === "connection") {
        if (!state.onboardingRunMode) {
          return React.createElement(
            React.Fragment,
            null,
            React.createElement(
              "button",
              {
                onClick: () => {
                  state.setState?.("onboardingRunMode", "local");
                },
                type: "button",
              },
              "onboarding.hostingLocal",
            ),
            React.createElement(
              "button",
              {
                onClick: () => {
                  state.setState?.("onboardingMode", "advanced");
                  state.setState?.("onboardingActiveGuide", "provider");
                },
                type: "button",
              },
              "advanced-configuration",
            ),
            state.onboardingMode === "advanced"
              ? React.createElement("div", null, "Flamina guidance")
              : null,
          );
        }
        return React.createElement(
          "button",
          {
            onClick: () => state.handleOnboardingNext(),
            type: "button",
          },
          "onboarding.confirm",
        );
      }
      if (state.onboardingStep === "rpc") {
        return React.createElement(
          "button",
          {
            onClick: () => state.handleOnboardingNext(),
            type: "button",
          },
          "onboarding.rpcSkip",
        );
      }
      if (state.onboardingStep === "senses") {
        return React.createElement(
          "button",
          {
            onClick: () => state.handleOnboardingNext(),
            type: "button",
          },
          "permissions-continue",
        );
      }
      return React.createElement(
        "button",
        {
          onClick: () => state.handleOnboardingNext(),
          type: "button",
        },
        "onboarding.enter",
      );
    },
    PairingView: () => React.createElement("div", null, "PairingView"),
    PermissionsOnboardingSection: ({
      onContinue,
    }: {
      onContinue: (options?: { allowPermissionBypass?: boolean }) => void;
    }) =>
      React.createElement(
        "button",
        { onClick: () => onContinue(), type: "button" },
        "permissions-continue",
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
        { onClick: () => mockUseApp().handleOnboardingNext(), type: "button" },
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
vi.mock("../../../packages/app-core/src/components/CustomActionsPanel", () => ({
  CustomActionsPanel: () =>
    React.createElement("div", null, "CustomActionsPanel"),
}));
vi.mock("../../../packages/app-core/src/components/CustomActionEditor", () => ({
  CustomActionEditor: () =>
    React.createElement("div", null, "CustomActionEditor"),
}));
vi.mock("../../../packages/app-core/src/components/AppsPageView", () => ({
  AppsPageView: () => React.createElement("div", null, "AppsPageView"),
}));
vi.mock("../../../packages/app-core/src/components/AdvancedPageView", () => ({
  AdvancedPageView: () => React.createElement("div", null, "AdvancedPageView"),
}));
vi.mock("../../../packages/app-core/src/components/CharacterView", () => ({
  CharacterView: () => React.createElement("div", null, "CharacterView"),
}));
vi.mock("../../../packages/app-core/src/components/TriggersView", () => ({
  TriggersView: () => React.createElement("div", null, "TriggersView"),
}));
vi.mock("../../../packages/app-core/src/components/ConnectorsPageView", () => ({
  ConnectorsPageView: () =>
    React.createElement("div", null, "ConnectorsPageView"),
}));
vi.mock("../../../packages/app-core/src/components/InventoryView", () => ({
  InventoryView: () => React.createElement("div", null, "InventoryView"),
}));
vi.mock("../../../packages/app-core/src/components/KnowledgeView", () => ({
  KnowledgeView: () => React.createElement("div", null, "KnowledgeView"),
}));
vi.mock("../../../packages/app-core/src/components/LifoSandboxView", () => ({
  LifoSandboxView: () => React.createElement("div", null, "LifoSandboxView"),
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
vi.mock("../../../packages/app-core/src/components/ChatModalView.js", () => ({
  ChatModalView: () => React.createElement("div", null, "ChatModalView"),
}));
vi.mock("../../../packages/app-core/src/components/AvatarSelector", () => ({
  AvatarSelector: () => React.createElement("div", null, "AvatarSelector"),
}));
vi.mock("../../../packages/app-core/src/components/companion/VrmStage", () => ({
  VrmStage: () => React.createElement("div", null, "VrmStage"),
}));
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

function onboardingOptions() {
  return {
    names: ["Eliza"],
    styles: [
      {
        catchphrase: "chaotic",
        hint: "chaotic good",
        bio: ["bio"],
        system: "You are {{name}}",
        style: { all: [], chat: [], post: [] },
        adjectives: [],
        postExamples: [],
        messageExamples: [[{ name: "User", content: { text: "hello" } }]],
      },
    ],
    providers: [
      {
        id: "ollama",
        name: "Ollama",
        envKey: null,
        pluginName: "@elizaos/plugin-ollama",
        keyPrefix: null,
        description: "Use local Ollama",
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
    sharedStyleRules: "",
  };
}

function createHarnessState(): AppHarnessState {
  return {
    onboardingLoading: false,
    startupStatus: "onboarding",
    startupError: null,
    authRequired: false,
    onboardingComplete: false,
    tab: "chat",
    actionNotice: null,
    onboardingStep: "identity",
    onboardingMode: "basic",
    onboardingActiveGuide: null,
    onboardingDeferredTasks: [],
    postOnboardingChecklistDismissed: false,
    onboardingOptions: onboardingOptions(),
    onboardingName: "Eliza",
    onboardingStyle: "",
    onboardingTheme: "eliza",
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
    onboardingSelectedChains: new Set(["evm"]),
    onboardingRpcSelections: {},
    onboardingRpcKeys: {},
    onboardingAvatar: 1,
    selectedVrmIndex: 1,
    customBackgroundUrl: "",
    onboardingRestarting: false,
    elizaCloudConnected: false,
    elizaCloudLoginBusy: false,
    elizaCloudLoginError: "",
    elizaCloudUserId: "",
    plugins: [],
    conversations: [],
    elizaCloudCredits: null,
    uiShellMode: "native",
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

describe("app startup onboarding flow (e2e)", () => {
  let state: AppHarnessState;

  beforeEach(() => {
    state = createHarnessState();

    const STEP_ORDER: OnboardingStep[] = [
      "identity",
      "connection",
      "rpc",
      "senses",
      "activate",
    ];

    const handleOnboardingNext = async () => {
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
    };

    const handleOnboardingBack = () => {
      const idx = STEP_ORDER.indexOf(state.onboardingStep);
      if (idx > 0) {
        state.onboardingStep = STEP_ORDER[idx - 1];
      }
    };

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
      handleOnboardingNext,
      handleOnboardingBack,
      handleCloudLogin: async () => {
        state.elizaCloudConnected = true;
        state.elizaCloudUserId = "test-user";
      },
      handleOnboardingRemoteConnect: async () => {},
      handleOnboardingUseLocalBackend: () => {},
      requestGreeting: vi.fn(async () => ({
        text: "hello",
        agentName: "Eliza",
        generated: true,
        persisted: false,
      })),
    }));
  });

  it("progresses through onboarding and lands in chat", async () => {
    let tree: TestRenderer.ReactTestRenderer | null = null;

    await act(async () => {
      tree = TestRenderer.create(React.createElement(App));
    });
    if (!tree) throw new Error("failed to render App");
    const renderedTree = tree;

    for (let i = 0; i < 20 && !state.onboardingComplete; i += 1) {
      if (
        state.onboardingStep === "connection" &&
        state.onboardingRunMode === "local" &&
        !state.onboardingProvider
      ) {
        state.onboardingProvider = "ollama";
        await rerender(renderedTree);
      }

      if (state.onboardingStep === "senses") {
        clickButton(renderedTree, "permissions-continue");
      } else if (state.onboardingStep === "identity") {
        clickButton(renderedTree, "onboarding.chooseAgent");
      } else if (state.onboardingStep === "connection") {
        if (!state.onboardingRunMode) {
          clickButton(renderedTree, "onboarding.hostingLocal");
        } else {
          clickButton(renderedTree, "onboarding.confirm");
        }
      } else if (state.onboardingStep === "rpc") {
        clickButton(renderedTree, "onboarding.rpcSkip");
      } else if (state.onboardingStep === "activate") {
        clickButton(renderedTree, "onboarding.enter");
      }
      await rerender(renderedTree);
    }

    expect(state.onboardingComplete).toBe(true);

    const renderedText = textOf(renderedTree.root);

    expect(renderedText).toContain("ChatView");
    expect(renderedText).not.toContain("OnboardingWizard");
  });

  it("renders character select when the tab is character-select even if companion mode lingers", async () => {
    state.onboardingComplete = true;
    state.startupStatus = "ready";
    state.tab = "character-select";
    state.uiShellMode = "companion";

    let tree: TestRenderer.ReactTestRenderer | null = null;

    await act(async () => {
      tree = TestRenderer.create(React.createElement(App));
    });
    if (!tree) throw new Error("failed to render App");

    const renderedText = textOf(tree.root);
    expect(renderedText).toContain("CharacterView");
    expect(renderedText).not.toContain("CompanionView");
  });

  it("opens Flamina guidance when advanced configuration is selected", async () => {
    let tree: TestRenderer.ReactTestRenderer | null = null;

    await act(async () => {
      tree = TestRenderer.create(React.createElement(App));
    });
    if (!tree) throw new Error("failed to render App");

    clickButton(tree, "onboarding.chooseAgent");
    await rerender(tree);
    clickButton(tree, "advanced-configuration");
    await rerender(tree);

    expect(textOf(tree.root)).toContain("Flamina guidance");
  });

  it("shows deferred setup checklist after onboarding when setup was skipped", async () => {
    state.onboardingComplete = true;
    state.startupStatus = "ready";
    state.tab = "chat";
    state.uiShellMode = "native";
    state.onboardingDeferredTasks = ["rpc", "permissions"];

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
});
