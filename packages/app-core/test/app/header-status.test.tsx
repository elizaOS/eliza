// @vitest-environment jsdom
import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockUseApp } = vi.hoisted(() => ({
  mockUseApp: vi.fn(),
}));

vi.mock("@elizaos/app-core/state", () => ({
  useApp: () => mockUseApp(),
}));

vi.mock("@elizaos/app-core/hooks", () => ({
  useBugReport: () => ({ isOpen: false, open: vi.fn(), close: vi.fn() }),
}));

vi.mock("@elizaos/app-core/navigation", () => ({
  getTabGroups: () => [
    {
      label: "Chat",
      tabs: ["chat"],
      icon: () => React.createElement("span", null, "💬"),
      description: "Chat",
    },
  ],
}));

vi.mock("@elizaos/app-core/components", () => ({
  LanguageDropdown: () => React.createElement("div", null, "LanguageDropdown"),
  ThemeToggle: () => React.createElement("div", null, "ThemeToggle"),
}));

vi.mock("@elizaos/ui", () => ({
  IconTooltip: ({
    children,
  }: {
    children: React.ReactNode;
    content?: string;
    side?: string;
  }) => React.createElement("div", null, children),
}));

vi.mock("lucide-react", () => ({
  AlertTriangle: () => React.createElement("span", null, "⚠"),
  CircleUserRound: () => React.createElement("span", null, "👤"),
  Bug: () => React.createElement("span", null, "🐛"),
  CircleDollarSign: () => React.createElement("span", null, "💰"),
  Menu: () => React.createElement("span", null, "☰"),
  Monitor: () => React.createElement("span", null, "🖥"),
  Smartphone: () => React.createElement("span", null, "📱"),
  UserRound: () => React.createElement("span", null, "👤"),
  Users: () => React.createElement("span", null, "👥"),
  X: () => React.createElement("span", null, "✕"),
}));

import { Header } from "../../src/components/Header";

let baseAppState: Record<string, unknown>;

describe("header status", () => {
  beforeEach(() => {
    mockUseApp.mockReset();
    baseAppState = {
      t: (k: string) => k,
      agentStatus: {
        state: "running",
        agentName: "Eliza",
        model: undefined,
        startedAt: undefined,
        uptime: undefined,
      },
      elizaCloudEnabled: false,
      elizaCloudConnected: false,
      elizaCloudCredits: null,
      elizaCloudCreditsCritical: false,
      elizaCloudCreditsLow: false,
      elizaCloudTopUpUrl: "",
      walletAddresses: null,
      lifecycleBusy: false,
      lifecycleAction: null,

      handleRestart: vi.fn(),
      handleStart: vi.fn(),
      openCommandPalette: vi.fn(),
      copyToClipboard: vi.fn(),
      tab: "chat",
      setTab: vi.fn(),
      setState: vi.fn(),
      dropStatus: null,
      loadDropStatus: vi.fn().mockResolvedValue(undefined),
      registryStatus: null,
      plugins: [],
      uiShellMode: "native",
      setUiShellMode: vi.fn(),
      uiLanguage: "en",
      setUiLanguage: vi.fn(),
      uiTheme: "dark",
      setUiTheme: vi.fn(),
    };
    mockUseApp.mockReturnValue(baseAppState);
  });

  it("renders shell toggle button", async () => {
    let tree: TestRenderer.ReactTestRenderer | undefined;
    await act(async () => {
      tree = TestRenderer.create(React.createElement(Header));
    });
    expect(tree).toBeDefined();
    const shellToggle = tree?.root.findByProps({
      "data-testid": "ui-shell-toggle",
    });
    expect(shellToggle).toBeDefined();
    expect(baseAppState.setState).toHaveBeenCalledWith("chatMode", "power");
  });

  it("renders language and theme controls", async () => {
    let tree: TestRenderer.ReactTestRenderer | undefined;
    await act(async () => {
      tree = TestRenderer.create(React.createElement(Header));
    });
    expect(tree).toBeDefined();
    const controls = tree?.root.findAll(
      (node) =>
        typeof node.children?.[0] === "string" &&
        (node.children[0] === "LanguageDropdown" ||
          node.children[0] === "ThemeToggle"),
    );
    expect(controls?.length).toBeGreaterThan(0);
  });

  it("uses accent classes for the active native tab", async () => {
    let tree: TestRenderer.ReactTestRenderer | undefined;
    await act(async () => {
      tree = TestRenderer.create(React.createElement(Header));
    });
    expect(tree).toBeDefined();

    const activeTabButton = tree?.root.find(
      (node) =>
        node.type === "button" &&
        node.props.title === "Chat" &&
        typeof node.props.className === "string",
    );

    expect(String(activeTabButton?.props.className)).toContain("text-accent");
    expect(String(activeTabButton?.props.className)).toContain("bg-accent/15");
  });
});
