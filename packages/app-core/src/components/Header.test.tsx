// @vitest-environment jsdom

import * as AppContext from "@elizaos/app-core/state";
import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";
import { Header } from "./Header";

// Mock the AppContext
vi.mock("@elizaos/app-core/state", () => ({
  useApp: vi.fn(),
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

describe("Header", () => {
  it("renders agent name and shell toggle", async () => {
    // Mock the useApp hook return value
    const mockUseApp = {
      t: (k: string) => k,
      agentStatus: { state: "running", agentName: "Eliza" },
      elizaCloudEnabled: false,
      elizaCloudConnected: false,
      elizaCloudCredits: null,
      elizaCloudCreditsCritical: false,
      elizaCloudCreditsLow: false,
      elizaCloudTopUpUrl: "",
      lifecycleBusy: false,
      lifecycleAction: null,
      handleRestart: vi.fn(),
      handleStart: vi.fn(),
      loadDropStatus: vi.fn().mockResolvedValue(undefined),
      tab: "chat",
      setTab: vi.fn(),
      setState: vi.fn(),
      plugins: [],
      uiLanguage: "en",
      setUiLanguage: vi.fn(),
      uiTheme: "dark",
      setUiTheme: vi.fn(),
      uiShellMode: "native",
      switchShellView: vi.fn(),
    };

    // @ts-expect-error - test uses a narrowed subset of the full app context type.
    vi.spyOn(AppContext, "useApp").mockReturnValue(mockUseApp);

    let testRenderer: ReactTestRenderer | null = null;
    await act(async () => {
      testRenderer = create(<Header />);
    });
    if (!testRenderer) {
      throw new Error("Failed to render Header");
    }
    const root = (testRenderer as ReactTestRenderer).root;

    // Check shell toggle button
    const shellToggle = root.findByProps({ "data-testid": "ui-shell-toggle" });
    const activeDesktopToggle = root.findByProps({
      "data-testid": "ui-shell-toggle-desktop",
    });
    const inactiveCharacterToggle = root.findByProps({
      "data-testid": "ui-shell-toggle-character",
    });
    const inactiveCompanionToggle = root.findByProps({
      "data-testid": "ui-shell-toggle-companion",
    });
    expect(shellToggle).toBeDefined();
    expect(String(shellToggle.props.className)).toContain("border-border/60");
    expect(String(shellToggle.props.className)).toContain("bg-transparent");
    expect(String(activeDesktopToggle.props.className)).toContain(
      "text-[#8a6500]",
    );
    expect(String(activeDesktopToggle.props.className)).toContain("bg-bg/55");
    expect(String(activeDesktopToggle.props.className)).toContain(
      "dark:text-[#f0b232]",
    );
    expect(String(inactiveCharacterToggle.props.className)).toContain(
      "text-muted-strong",
    );
    expect(String(inactiveCompanionToggle.props.className)).toContain(
      "text-muted-strong",
    );
    expect(mockUseApp.setState).toHaveBeenCalledWith("chatMode", "power");
  });

  it("uses minimal chrome for the character view and hides cloud pricing", async () => {
    const mockUseApp = {
      t: (k: string) => k,
      agentStatus: { state: "running", agentName: "Eliza" },
      elizaCloudEnabled: true,
      elizaCloudConnected: true,
      elizaCloudCredits: 12.34,
      elizaCloudCreditsCritical: false,
      elizaCloudCreditsLow: false,
      elizaCloudTopUpUrl: "https://example.com/topup",
      lifecycleBusy: false,
      lifecycleAction: null,
      handleRestart: vi.fn(),
      handleStart: vi.fn(),
      loadDropStatus: vi.fn().mockResolvedValue(undefined),
      tab: "character",
      setTab: vi.fn(),
      setState: vi.fn(),
      plugins: [],
      uiLanguage: "en",
      setUiLanguage: vi.fn(),
      uiTheme: "dark",
      setUiTheme: vi.fn(),
      uiShellMode: "native",
      switchShellView: vi.fn(),
    };

    // @ts-expect-error - test uses a narrowed subset of the full app context type.
    vi.spyOn(AppContext, "useApp").mockReturnValue(mockUseApp);

    let testRenderer: ReactTestRenderer | null = null;
    await act(async () => {
      testRenderer = create(<Header transparent />);
    });
    if (!testRenderer) {
      throw new Error("Failed to render Header");
    }

    const header = (testRenderer as ReactTestRenderer).root.findByType(
      "header",
    );
    expect(String(header.props.className)).toContain("bg-transparent");
    expect(String(header.props.className)).toContain("border-transparent");
    expect(
      (testRenderer as ReactTestRenderer).root.findAll(
        (node) => node.props.title === "Chat",
      ),
    ).toHaveLength(0);
    expect(
      (testRenderer as ReactTestRenderer).root.findAll(
        (node) => node.props["aria-label"] === "Open navigation menu",
      ),
    ).toHaveLength(0);
    expect(
      (testRenderer as ReactTestRenderer).root.findAll(
        (node) => node.props.title === "header.CloudCreditsBalanc",
      ),
    ).toHaveLength(0);
  });

  it("uses minimal chrome in companion mode", async () => {
    const mockUseApp = {
      t: (k: string) => k,
      agentStatus: { state: "running", agentName: "Eliza" },
      elizaCloudEnabled: false,
      elizaCloudConnected: false,
      elizaCloudCredits: null,
      elizaCloudCreditsCritical: false,
      elizaCloudCreditsLow: false,
      elizaCloudTopUpUrl: "",
      lifecycleBusy: false,
      lifecycleAction: null,
      handleRestart: vi.fn(),
      handleStart: vi.fn(),
      loadDropStatus: vi.fn().mockResolvedValue(undefined),
      tab: "character",
      setTab: vi.fn(),
      setState: vi.fn(),
      plugins: [],
      uiLanguage: "en",
      setUiLanguage: vi.fn(),
      uiTheme: "dark",
      setUiTheme: vi.fn(),
      uiShellMode: "companion",
      switchShellView: vi.fn(),
    };

    // @ts-expect-error - test uses a narrowed subset of the full app context type.
    vi.spyOn(AppContext, "useApp").mockReturnValue(mockUseApp);

    let testRenderer: ReactTestRenderer | null = null;
    await act(async () => {
      testRenderer = create(<Header transparent />);
    });
    if (!testRenderer) {
      throw new Error("Failed to render Header");
    }

    const header = (testRenderer as ReactTestRenderer).root.findByType(
      "header",
    );
    expect(String(header.props.className)).toContain("bg-transparent");
    expect(String(header.props.className)).toContain("border-transparent");
    expect(
      (testRenderer as ReactTestRenderer).root.findAll(
        (node) => node.props.title === "Chat",
      ),
    ).toHaveLength(0);
    expect(
      (testRenderer as ReactTestRenderer).root.findAll(
        (node) => node.props["aria-label"] === "Open navigation menu",
      ),
    ).toHaveLength(0);
  });

  it("routes cloud credits to settings billing instead of an external link", async () => {
    const setTab = vi.fn();
    const setState = vi.fn();
    const mockUseApp = {
      t: (k: string) => k,
      agentStatus: { state: "running", agentName: "Eliza" },
      elizaCloudEnabled: true,
      elizaCloudConnected: true,
      elizaCloudCredits: 12.34,
      elizaCloudCreditsCritical: false,
      elizaCloudCreditsLow: false,
      elizaCloudTopUpUrl: "https://example.com/topup",
      lifecycleBusy: false,
      lifecycleAction: null,
      handleRestart: vi.fn(),
      handleStart: vi.fn(),
      loadDropStatus: vi.fn().mockResolvedValue(undefined),
      tab: "chat",
      setTab,
      setState,
      plugins: [],
      uiLanguage: "en",
      setUiLanguage: vi.fn(),
      uiTheme: "dark",
      setUiTheme: vi.fn(),
      uiShellMode: "native",
      switchShellView: vi.fn(),
    };

    // @ts-expect-error - test uses a narrowed subset of the full app context type.
    vi.spyOn(AppContext, "useApp").mockReturnValue(mockUseApp);

    let testRenderer: ReactTestRenderer | null = null;
    await act(async () => {
      testRenderer = create(<Header />);
    });
    if (!testRenderer) {
      throw new Error("Failed to render Header");
    }

    const creditButton = (testRenderer as ReactTestRenderer).root.find(
      (node) =>
        node.type === "button" &&
        node.props.title === "header.CloudCreditsBalanc",
    );

    await act(async () => {
      creditButton.props.onClick();
    });

    expect(setState).toHaveBeenCalledWith("cloudDashboardView", "billing");
    expect(setTab).toHaveBeenCalledWith("settings");
  });

  it("keeps cloud credits in the mobile menu instead of the small header", async () => {
    const setTab = vi.fn();
    const setState = vi.fn();
    const mockUseApp = {
      t: (k: string) => k,
      agentStatus: { state: "running", agentName: "Eliza" },
      elizaCloudEnabled: true,
      elizaCloudConnected: true,
      elizaCloudCredits: 12.34,
      elizaCloudCreditsCritical: false,
      elizaCloudCreditsLow: false,
      elizaCloudTopUpUrl: "https://example.com/topup",
      lifecycleBusy: false,
      lifecycleAction: null,
      handleRestart: vi.fn(),
      handleStart: vi.fn(),
      loadDropStatus: vi.fn().mockResolvedValue(undefined),
      tab: "chat",
      setTab,
      setState,
      plugins: [],
      uiLanguage: "en",
      setUiLanguage: vi.fn(),
      uiTheme: "dark",
      setUiTheme: vi.fn(),
      uiShellMode: "native",
      switchShellView: vi.fn(),
    };

    // @ts-expect-error - test uses a narrowed subset of the full app context type.
    vi.spyOn(AppContext, "useApp").mockReturnValue(mockUseApp);

    let testRenderer: ReactTestRenderer | null = null;
    await act(async () => {
      testRenderer = create(<Header />);
    });
    if (!testRenderer) {
      throw new Error("Failed to render Header");
    }

    const root = (testRenderer as ReactTestRenderer).root;
    const nav = root.findByType("nav");
    expect(String(nav.props.className)).toContain("hidden sm:flex");
    expect(
      String(
        root.findByProps({ "data-testid": "header-nav-icon-chat" }).props
          .className,
      ),
    ).toContain("inline-flex md:hidden xl:inline-flex");
    expect(
      String(
        root.findByProps({ "data-testid": "header-nav-label-chat" }).props
          .className,
      ),
    ).toContain("hidden md:inline");
    const desktopCreditButton = root.findByProps({
      "data-testid": "header-cloud-credits-desktop",
    });
    expect(String(desktopCreditButton.props.className)).toContain("hidden");
    expect(String(desktopCreditButton.props.className)).toContain(
      "sm:inline-flex",
    );
    const desktopLanguageDropdown = root.findByProps({
      "data-testid": "header-language-dropdown-desktop",
    });
    expect(String(desktopLanguageDropdown.props.className)).toContain("hidden");
    expect(String(desktopLanguageDropdown.props.className)).toContain(
      "sm:inline-flex",
    );
    const desktopThemeToggle = root.findByProps({
      "data-testid": "header-theme-toggle-desktop",
    });
    expect(String(desktopThemeToggle.props.className)).toContain("hidden");
    expect(String(desktopThemeToggle.props.className)).toContain("sm:flex");
    const rightControls = root.findByProps({
      "data-testid": "shell-header-right-controls",
    });
    const rightControlChildren = rightControls.findAll(
      (node) => node.parent === rightControls,
    );
    expect(
      rightControlChildren[rightControlChildren.length - 1]?.props[
        "aria-label"
      ],
    ).toBe("Open navigation menu");

    const menuButton = root.findByProps({
      "aria-label": "Open navigation menu",
    });
    expect(String(menuButton.props.className)).toContain("sm:hidden");

    await act(async () => {
      menuButton.props.onClick();
    });

    const mobileCreditButton = root.findByProps({
      "data-testid": "header-cloud-credits-mobile",
    });
    expect(mobileCreditButton.props.title).toBe("header.CloudCreditsBalanc");
    expect(
      root.findByProps({ "data-testid": "header-language-dropdown-mobile" }),
    ).toBeDefined();
    expect(
      root.findByProps({ "data-testid": "header-theme-toggle-mobile" }),
    ).toBeDefined();

    await act(async () => {
      mobileCreditButton.props.onClick();
    });

    expect(setState).toHaveBeenCalledWith("cloudDashboardView", "billing");
    expect(setTab).toHaveBeenCalledWith("settings");
    expect(
      root.findAll((node) => node.props["aria-label"] === "Navigation menu"),
    ).toHaveLength(0);
  });
});
