// @vitest-environment jsdom

/**
 * Shell-mode switching E2E test.
 *
 * Verifies that:
 * 1. Every view renders valid content in NATIVE shell mode.
 * 2. Only the companion tab uses COMPANION shell; settings/skills/etc. use native layout.
 * 3. Switching from native → companion → native produces valid output each time.
 * 4. No console errors or unexpected warnings are emitted during any transition.
 */

import type { Tab } from "@miladyai/app-core/navigation";
import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockKeyboardSetScroll, mockUseApp, noop, sceneHostState } = vi.hoisted(
  () => ({
    mockKeyboardSetScroll: vi.fn(async () => undefined),
    mockUseApp: vi.fn(),
    noop: vi.fn(),
    sceneHostState: {
      activeHistory: [] as boolean[],
      interactiveHistory: [] as boolean[],
      mounts: 0,
      unmounts: 0,
    },
  }),
);

vi.mock("@capacitor/keyboard", () => ({
  Keyboard: {
    setScroll: mockKeyboardSetScroll,
  },
}));

vi.mock("@miladyai/app-core/platform", async () => {
  const actual = await vi.importActual<
    typeof import("@miladyai/app-core/platform")
  >("@miladyai/app-core/platform");
  return {
    ...actual,
    isIOS: true,
    isNative: true,
  };
});

/* ── Mock every leaf component ────────────────────────────────────── */

vi.mock("@miladyai/app-core/state", async () => {
  const actual = await vi.importActual<
    typeof import("@miladyai/app-core/state")
  >("@miladyai/app-core/state");
  return {
    ...actual,
    useApp: () => mockUseApp(),
    getVrmUrl: vi.fn(() => "mock-vrm-url"),
    getVrmPreviewUrl: vi.fn(() => "mock-vrm-preview"),
    getVrmBackgroundUrl: vi.fn(() => "mock-vrm-bg"),
  };
});

vi.mock("@miladyai/app-core/components", async () => {
  const actual = await vi.importActual<
    typeof import("@miladyai/app-core/components")
  >("@miladyai/app-core/components");
  return {
    ...actual,
    AdvancedPageView: () =>
      React.createElement("section", null, "AdvancedPageView Ready"),
    AppsPageView: () =>
      React.createElement("section", null, "AppsPageView Ready"),
    BugReportModal: () => React.createElement("div", null, "BugReportModal"),
    CharacterView: () =>
      React.createElement("section", null, "CharacterView Ready"),
    ChatView: () => React.createElement("section", null, "ChatView Ready"),
    CloudDashboard: () =>
      React.createElement("section", null, "ElizaCloudDashboard Ready"),
    CommandPalette: () => React.createElement("div", null, "CommandPalette"),
    CompanionShell: ({ tab }: { tab: string }) =>
      React.createElement("main", null, `CompanionShell Ready: ${tab}`),
    CompanionView: () =>
      React.createElement("section", null, "CompanionView Ready"),
    ConnectorsPageView: () =>
      React.createElement("section", null, "ConnectorsPageView Ready"),
    ConversationsSidebar: () =>
      React.createElement("aside", null, "ConversationsSidebar"),
    CustomActionEditor: () =>
      React.createElement("aside", null, "CustomActionEditor"),
    CustomActionsPanel: () =>
      React.createElement("aside", null, "CustomActionsPanel"),
    EmotePicker: () => React.createElement("div", null, "EmotePicker"),
    ErrorBoundary: ({ children }: { children: React.ReactNode }) =>
      React.createElement(React.Fragment, null, children),
    Header: () => React.createElement("header", null, "Header"),
    HeartbeatsView: () =>
      React.createElement("section", null, "HeartbeatsView Ready"),
    InventoryView: () =>
      React.createElement("section", null, "InventoryView Ready"),
    KnowledgeView: () =>
      React.createElement("section", null, "KnowledgeView Ready"),
    PairingView: () => React.createElement("div", null, "PairingView"),
    PluginsPageView: () =>
      React.createElement("section", null, "PluginsPageView Ready"),
    PluginsView: () =>
      React.createElement("section", null, "PluginsView Ready"),
    SaveCommandModal: () =>
      React.createElement("div", null, "SaveCommandModal"),
    ConnectionFailedBanner: () =>
      React.createElement("div", null, "ConnectionFailedBanner"),
    OnboardingWizard: () =>
      React.createElement("div", null, "OnboardingWizard"),
    SettingsView: () =>
      React.createElement("section", null, "SettingsView Ready"),
    SharedCompanionScene: ({
      active,
      interactive,
      children,
    }: {
      active: boolean;
      interactive?: boolean;
      children: React.ReactNode;
    }) => {
      const { useEffect } = React;
      useEffect(() => {
        sceneHostState.mounts += 1;
        return () => {
          sceneHostState.unmounts += 1;
        };
      }, []);
      sceneHostState.activeHistory.push(active);
      sceneHostState.interactiveHistory.push(Boolean(interactive));
      return React.createElement(React.Fragment, null, children);
    },
    ShellOverlays: () => null,
    SkillsView: () => React.createElement("section", null, "SkillsView Ready"),
    StreamView: () => React.createElement("section", null, "StreamView Ready"),
    SystemWarningBanner: () =>
      React.createElement("div", null, "SystemWarningBanner"),
  };
});

vi.mock("../../../packages/app-core/src/components/Header", () => ({
  Header: () => React.createElement("header", null, "Header"),
}));

vi.mock("../../../packages/app-core/src/components/CommandPalette", () => ({
  CommandPalette: () => React.createElement("div", null, "CommandPalette"),
}));

vi.mock("../../../packages/app-core/src/components/EmotePicker", () => ({
  EmotePicker: () => React.createElement("div", null, "EmotePicker"),
}));

vi.mock("../../../packages/app-core/src/components/PairingView", () => ({
  PairingView: () => React.createElement("div", null, "PairingView"),
}));

vi.mock("../../../packages/app-core/src/components/OnboardingWizard", () => ({
  OnboardingWizard: () => React.createElement("div", null, "OnboardingWizard"),
}));

vi.mock("../../../packages/app-core/src/components/ChatView", () => ({
  ChatView: () => React.createElement("section", null, "ChatView Ready"),
}));

vi.mock("../../../packages/app-core/src/components/StreamView", () => ({
  StreamView: () => React.createElement("section", null, "StreamView Ready"),
}));

vi.mock(
  "../../../packages/app-core/src/components/ConversationsSidebar",
  () => ({
    ConversationsSidebar: () =>
      React.createElement("aside", null, "ConversationsSidebar"),
  }),
);

vi.mock("../../../packages/app-core/src/components/CustomActionsPanel", () => ({
  CustomActionsPanel: () =>
    React.createElement("aside", null, "CustomActionsPanel"),
}));

vi.mock("../../../packages/app-core/src/components/CustomActionEditor", () => ({
  CustomActionEditor: () =>
    React.createElement("aside", null, "CustomActionEditor"),
}));

vi.mock("../../../packages/app-core/src/components/AppsPageView", () => ({
  AppsPageView: () =>
    React.createElement("section", null, "AppsPageView Ready"),
}));

vi.mock("../../../packages/app-core/src/components/CharacterView", () => ({
  CharacterView: () =>
    React.createElement("section", null, "CharacterView Ready"),
}));

vi.mock("../../../packages/app-core/src/components/AdvancedPageView", () => ({
  AdvancedPageView: () =>
    React.createElement("section", null, "AdvancedPageView Ready"),
}));

vi.mock("../../../packages/app-core/src/components/CompanionView", () => ({
  CompanionView: () =>
    React.createElement("section", null, "CompanionView Ready"),
}));

vi.mock(
  "../../../packages/app-core/src/components/companion/CompanionSceneHost",
  async () => {
    const React = await vi.importActual<typeof import("react")>("react");
    return {
      SharedCompanionScene: ({
        active,
        interactive,
        children,
      }: {
        active: boolean;
        interactive?: boolean;
        children: React.ReactNode;
      }) => {
        const { useEffect } = React;
        useEffect(() => {
          sceneHostState.mounts += 1;
          return () => {
            sceneHostState.unmounts += 1;
          };
        }, []);
        sceneHostState.activeHistory.push(active);
        sceneHostState.interactiveHistory.push(Boolean(interactive));
        return React.createElement(React.Fragment, null, children);
      },
      CompanionSceneHost: () => null,
      useSharedCompanionScene: () => true,
    };
  },
);

vi.mock("../../../packages/app-core/src/components/companion/VrmStage", () => ({
  VrmStage: () => React.createElement("div", null, "VrmStage Ready"),
}));

vi.mock("../../../packages/app-core/src/components/TriggersView", () => ({
  TriggersView: () =>
    React.createElement("section", null, "TriggersView Ready"),
}));

vi.mock("../../../packages/app-core/src/components/ConnectorsPageView", () => ({
  ConnectorsPageView: () =>
    React.createElement("section", null, "ConnectorsPageView Ready"),
}));

vi.mock("../../../packages/app-core/src/components/InventoryView", () => ({
  InventoryView: () =>
    React.createElement("section", null, "InventoryView Ready"),
}));

vi.mock("../../../packages/app-core/src/components/KnowledgeView", () => ({
  KnowledgeView: () =>
    React.createElement("section", null, "KnowledgeView Ready"),
}));

vi.mock("@miladyai/app-core/components/AvatarLoader", () => ({
  AvatarLoader: () => React.createElement("div", null, "AvatarLoader"),
}));

vi.mock("../../../packages/app-core/src/components/PluginsPageView", () => ({
  PluginsPageView: () =>
    React.createElement("section", null, "PluginsPageView Ready"),
}));

vi.mock("../../../packages/app-core/src/components/PluginsView", () => ({
  PluginsView: () => React.createElement("section", null, "PluginsView Ready"),
}));

vi.mock("../../../packages/app-core/src/components/SkillsView", () => ({
  SkillsView: () => React.createElement("section", null, "SkillsView Ready"),
}));

vi.mock("../../../packages/app-core/src/components/CustomActionsView", () => ({
  CustomActionsView: () =>
    React.createElement("section", null, "CustomActionsView Ready"),
}));

vi.mock("../../../packages/app-core/src/components/FineTuningView", () => ({
  FineTuningView: () =>
    React.createElement("section", null, "FineTuningView Ready"),
}));

vi.mock("../../../packages/app-core/src/components/TrajectoriesView", () => ({
  TrajectoriesView: () =>
    React.createElement("section", null, "TrajectoriesView Ready"),
}));

vi.mock(
  "../../../packages/app-core/src/components/TrajectoryDetailView",
  () => ({
    TrajectoryDetailView: () =>
      React.createElement("section", null, "TrajectoryDetailView Ready"),
  }),
);

vi.mock("../../../packages/app-core/src/components/LifoSandboxView", () => ({
  LifoSandboxView: () =>
    React.createElement("section", null, "LifoSandboxView Ready"),
}));

vi.mock("@miladyai/app-core/hooks", async () => {
  const actual = await vi.importActual<
    typeof import("@miladyai/app-core/hooks")
  >("@miladyai/app-core/hooks");
  return {
    ...actual,
    useContextMenu: () => ({
      saveCommandModalOpen: false,
      saveCommandText: "",
      confirmSaveCommand: noop,
      closeSaveCommandModal: noop,
    }),
  };
});

import { App } from "../../src/App";

/* ── Harness state ────────────────────────────────────────────────── */

type HarnessState = {
  onboardingLoading: boolean;
  authRequired: boolean;
  onboardingComplete: boolean;
  tab: Tab;
  uiShellMode: "native" | "companion";
  actionNotice: null;
  setTab: (tab: Tab) => void;
  setUiShellMode: (mode: "native" | "companion") => void;
  [key: string]: unknown;
};

function shellModeForTab(tab: Tab): "native" | "companion" {
  return tab === "companion" ? "companion" : "native";
}

function tFn(k: string): string {
  const labels: Record<string, string> = {
    "nav.chat": "Chat",
    "nav.companion": "Companion",
    "nav.stream": "Stream",
    "nav.character": "Character",
    "nav.wallets": "Wallets",
    "nav.knowledge": "Knowledge",
    "nav.social": "Connectors",
    "nav.apps": "Apps",
    "nav.settings": "Settings",
    "nav.heartbeats": "Heartbeats",
    "nav.advanced": "Advanced",
    "nav.cloud": "Cloud",
    "nav.plugins": "Plugins",
    "nav.skills": "Skills",
    "nav.channels": "Channels",
    "nav.talents": "Talents",
    "companion.switchToNativeUi": "Switch to native UI",
    "companion.zoomIn": "Zoom in",
    "companion.zoomOut": "Zoom out",
  };
  return labels[k] ?? k;
}

function makeState(overrides?: Partial<HarnessState>): HarnessState {
  const state: HarnessState = {
    t: tFn,
    onboardingLoading: false,
    authRequired: false,
    onboardingComplete: true,
    tab: "chat",
    actionNotice: null,
    plugins: [],
    conversations: [],
    elizaCloudCredits: null,
    uiShellMode: "native",
    setUiShellMode: vi.fn((mode: "native" | "companion") => {
      state.uiShellMode = mode;
      state.tab = mode === "companion" ? "companion" : "chat";
    }),
    uiLanguage: "en",
    agentStatus: { state: "running", agentName: "Milady" },
    loadDropStatus: vi.fn(),
    unreadConversations: new Set(),
    activeGameViewerUrl: null,
    gameOverlayEnabled: false,
    startupPhase: "ready",
    startupError: null,
    retryStartup: vi.fn(),
    setActionNotice: vi.fn(),
    setTab: (tab: Tab) => {
      state.tab = tab;
      state.uiShellMode = shellModeForTab(tab);
    },
    ...overrides,
  };
  return state;
}

/* ── Helpers ──────────────────────────────────────────────────────── */

function textOf(node: TestRenderer.ReactTestInstance): string {
  return node.children
    .map((child) => (typeof child === "string" ? child : textOf(child)))
    .join("");
}

function expectValidContent(content: string): void {
  expect(content.trim().length).toBeGreaterThan(0);
  const invalidPatterns = [
    /\bundefined\b/i,
    /\bnull\b/i,
    /\bnan\b/i,
    /\btypeerror\b/i,
    /\breferenceerror\b/i,
    /\berror:\b/i,
  ];
  for (const pattern of invalidPatterns) {
    expect(pattern.test(content)).toBe(false);
  }
}

function filterRealErrors(spy: ReturnType<typeof vi.spyOn>): Array<unknown[]> {
  return spy.mock.calls.filter((args) => {
    const msg = typeof args[0] === "string" ? args[0] : "";
    return (
      !msg.includes("react-test-renderer is deprecated") &&
      !msg.includes(
        "The current testing environment is not configured to support act(...)",
      ) &&
      !msg.startsWith("ERROR:")
    );
  });
}

function requireTree(
  tree: TestRenderer.ReactTestRenderer | null,
): TestRenderer.ReactTestRenderer {
  if (!tree) throw new Error("failed to render App");
  return tree;
}

function expectShellForTab(text: string, tab: Tab): void {
  const expectedToken = (() => {
    switch (tab) {
      case "chat":
        return "ChatView Ready";
      case "companion":
        return "CompanionShell Ready: companion";
      case "character":
      case "character-select":
        return "CharacterView Ready";
      case "wallets":
        return "InventoryView Ready";
      case "knowledge":
        return "KnowledgeView Ready";
      case "connectors":
        return "ConnectorsPageView Ready";
      case "triggers":
        return "HeartbeatsView Ready";
      case "apps":
        return "AppsPageView Ready";
      case "settings":
      case "voice":
        return "SettingsView Ready";
      case "stream":
        return "StreamView Ready";
      case "advanced":
      case "plugins":
      case "skills":
      case "actions":
      case "fine-tuning":
      case "trajectories":
      case "runtime":
      case "database":
      case "lifo":
      case "logs":
      case "security":
        return "AdvancedPageView Ready";
      default:
        return "ChatView Ready";
    }
  })();

  expect(text).toContain(expectedToken);
  if (tab === "companion") {
    expect(text).not.toContain("Header");
  } else {
    expect(text).toContain("Header");
  }
  expectValidContent(text);
}

/* ── Tests ────────────────────────────────────────────────────────── */

describe("shell mode switching (e2e)", () => {
  let state: HarnessState;

  beforeEach(() => {
    state = makeState();
    mockKeyboardSetScroll.mockClear();
    mockUseApp.mockReset();
    mockUseApp.mockImplementation(() => state);
    sceneHostState.activeHistory = [];
    sceneHostState.interactiveHistory = [];
    sceneHostState.mounts = 0;
    sceneHostState.unmounts = 0;
  });

  it("renders every tab with the shell implied by its tab", async () => {
    const errorSpy = vi.spyOn(console, "error");
    const warnSpy = vi.spyOn(console, "warn");

    const tabsToVerify: Tab[] = [
      "chat",
      "companion",
      "character",
      "wallets",
      "knowledge",
      "connectors",
      "triggers",
      "plugins",
      "skills",
      "settings",
      "advanced",
      "fine-tuning",
      "trajectories",
      "runtime",
      "database",
      "lifo",
      "logs",
    ];

    let tree!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      tree = TestRenderer.create(React.createElement(App));
    });
    for (const tab of tabsToVerify) {
      state.setTab(tab);
      await act(async () => {
        tree.update(React.createElement(App));
      });
      const text = textOf(requireTree(tree).root);
      expectShellForTab(text, tab);
    }

    expect(filterRealErrors(errorSpy).length).toBe(0);
    expect(
      warnSpy.mock.calls.filter(
        (args) =>
          !(typeof args[0] === "string" && args[0].includes("[RenderGuard]")),
      ).length,
    ).toBe(0);
    errorSpy.mockRestore();
    warnSpy.mockRestore();
  });

  it("uses the companion shell only for the companion tab", async () => {
    const errorSpy = vi.spyOn(console, "error");
    const warnSpy = vi.spyOn(console, "warn");

    state.setTab("companion");
    let tree!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      tree = TestRenderer.create(React.createElement(App));
    });
    let text = textOf(requireTree(tree).root);
    expectShellForTab(text, "companion");

    const nativeTabs: Tab[] = [
      "settings",
      "triggers",
      "skills",
      "character",
      "wallets",
    ];

    for (const tab of nativeTabs) {
      state.setTab(tab);
      await act(async () => {
        tree.update(React.createElement(App));
      });
      text = textOf(requireTree(tree).root);
      expectShellForTab(text, tab);
    }

    expect(filterRealErrors(errorSpy).length).toBe(0);
    expect(
      warnSpy.mock.calls.filter(
        (args) =>
          !(typeof args[0] === "string" && args[0].includes("[RenderGuard]")),
      ).length,
    ).toBe(0);
    errorSpy.mockRestore();
    warnSpy.mockRestore();
  });

  it("switches between native tabs and companion without stale rendering", async () => {
    const errorSpy = vi.spyOn(console, "error");
    const warnSpy = vi.spyOn(console, "warn");

    let tree!: TestRenderer.ReactTestRenderer;

    state.setTab("chat");
    await act(async () => {
      tree = TestRenderer.create(React.createElement(App));
    });
    let text = textOf(requireTree(tree).root);
    expectShellForTab(text, "chat");

    state.setTab("settings");
    await act(async () => {
      tree.update(React.createElement(App));
    });
    text = textOf(requireTree(tree).root);
    expectShellForTab(text, "settings");

    state.setTab("companion");
    await act(async () => {
      tree.update(React.createElement(App));
    });
    text = textOf(requireTree(tree).root);
    expectShellForTab(text, "companion");

    state.setTab("skills");
    await act(async () => {
      tree.update(React.createElement(App));
    });
    text = textOf(requireTree(tree).root);
    expectShellForTab(text, "skills");

    state.setTab("companion");
    await act(async () => {
      tree.update(React.createElement(App));
    });
    text = textOf(requireTree(tree).root);
    expectShellForTab(text, "companion");

    state.setTab("chat");
    await act(async () => {
      tree.update(React.createElement(App));
    });
    text = textOf(requireTree(tree).root);
    expectShellForTab(text, "chat");

    for (const nextTab of [
      "character",
      "wallets",
      "plugins",
      "settings",
    ] as Tab[]) {
      state.setTab(nextTab);
      await act(async () => {
        tree.update(React.createElement(App));
      });
      text = textOf(requireTree(tree).root);
      expectShellForTab(text, nextTab);
    }

    expect(filterRealErrors(errorSpy).length).toBe(0);
    expect(
      warnSpy.mock.calls.filter(
        (args) =>
          !(typeof args[0] === "string" && args[0].includes("[RenderGuard]")),
      ).length,
    ).toBe(0);
    errorSpy.mockRestore();
    warnSpy.mockRestore();
  });

  it("handles rapid tab switching without stale shell state", async () => {
    const errorSpy = vi.spyOn(console, "error");
    const warnSpy = vi.spyOn(console, "warn");

    state.setTab("companion");

    let tree!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      tree = TestRenderer.create(React.createElement(App));
    });
    const rapidTabs: Tab[] = [
      "companion",
      "skills",
      "companion",
      "settings",
      "companion",
      "character",
    ];

    for (const tab of rapidTabs) {
      state.setTab(tab);
      await act(async () => {
        tree.update(React.createElement(App));
      });
      const text = textOf(requireTree(tree).root);
      expectShellForTab(text, tab);
    }

    expect(filterRealErrors(errorSpy).length).toBe(0);
    expect(
      warnSpy.mock.calls.filter(
        (args) =>
          !(typeof args[0] === "string" && args[0].includes("[RenderGuard]")),
      ).length,
    ).toBe(0);
    errorSpy.mockRestore();
    warnSpy.mockRestore();
  });

  it("toggles between chat and companion multiple times without stale rendering", async () => {
    const errorSpy = vi.spyOn(console, "error");
    const warnSpy = vi.spyOn(console, "warn");

    let tree!: TestRenderer.ReactTestRenderer;
    state.setTab("chat");
    await act(async () => {
      tree = TestRenderer.create(React.createElement(App));
    });
    for (let i = 0; i < 5; i++) {
      const nextTab = i % 2 === 0 ? "companion" : "chat";
      state.setTab(nextTab);
      await act(async () => {
        tree.update(React.createElement(App));
      });
      const text = textOf(requireTree(tree).root);
      expectShellForTab(text, nextTab);
    }

    expect(filterRealErrors(errorSpy).length).toBe(0);
    expect(
      warnSpy.mock.calls.filter(
        (args) =>
          !(typeof args[0] === "string" && args[0].includes("[RenderGuard]")),
      ).length,
    ).toBe(0);
    errorSpy.mockRestore();
    warnSpy.mockRestore();
  });

  it("keeps the shared companion scene mounted while shell mode changes", async () => {
    let tree!: TestRenderer.ReactTestRenderer;

    state.setTab("chat");
    await act(async () => {
      tree = TestRenderer.create(React.createElement(App));
    });
    state.setTab("companion");
    await act(async () => {
      tree.update(React.createElement(App));
    });

    state.setTab("chat");
    await act(async () => {
      tree.update(React.createElement(App));
    });

    const activeTransitions = sceneHostState.activeHistory.filter(
      (active, index, history) => index === 0 || active !== history[index - 1],
    );

    expect(sceneHostState.mounts).toBe(1);
    expect(sceneHostState.unmounts).toBe(0);
    expect(activeTransitions).toEqual([false, true, false]);
  });

  it("keeps character tabs in the native shell while the companion scene stays active", async () => {
    let tree!: TestRenderer.ReactTestRenderer;

    state.setTab("chat");
    await act(async () => {
      tree = TestRenderer.create(React.createElement(App));
    });
    state.setTab("companion");
    await act(async () => {
      tree.update(React.createElement(App));
    });

    let text = textOf(requireTree(tree).root);
    expectShellForTab(text, "companion");
    expect(sceneHostState.activeHistory.at(-1)).toBe(true);
    expect(sceneHostState.interactiveHistory.at(-1)).toBe(true);

    state.setTab("character");
    await act(async () => {
      tree.update(React.createElement(App));
    });

    text = textOf(requireTree(tree).root);
    expectShellForTab(text, "character");
    expect(sceneHostState.activeHistory.at(-1)).toBe(true);
    expect(sceneHostState.interactiveHistory.at(-1)).toBe(false);
  });

  it("disables iOS native scrolling only while the companion shell is visible", async () => {
    let tree!: TestRenderer.ReactTestRenderer;

    state.setTab("chat");
    await act(async () => {
      tree = TestRenderer.create(React.createElement(App));
    });

    state.setTab("settings");
    await act(async () => {
      tree.update(React.createElement(App));
    });
    expect(mockKeyboardSetScroll).toHaveBeenLastCalledWith({
      isDisabled: false,
    });

    state.setTab("companion");
    await act(async () => {
      tree.update(React.createElement(App));
    });

    state.setTab("character");
    await act(async () => {
      tree.update(React.createElement(App));
    });
    expect(mockKeyboardSetScroll).toHaveBeenLastCalledWith({
      isDisabled: false,
    });

    state.setTab("chat");
    await act(async () => {
      tree.update(React.createElement(App));
    });

    if (mockKeyboardSetScroll.mock.calls.length > 0) {
      expect(mockKeyboardSetScroll).toHaveBeenCalledWith({ isDisabled: true });
      expect(mockKeyboardSetScroll).toHaveBeenCalledWith({
        isDisabled: false,
      });
    }
  });
});
