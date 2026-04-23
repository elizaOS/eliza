// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  getTabGroupsMock,
  isElectrobunRuntimeMock,
  useMediaQueryMock,
  useAppMock,
} = vi.hoisted(() => ({
  getTabGroupsMock: vi.fn(),
  isElectrobunRuntimeMock: vi.fn(),
  useMediaQueryMock: vi.fn(),
  useAppMock: vi.fn(),
}));

vi.mock("@elizaos/app-companion/ui", () => ({
  InferenceCloudAlertButton: () => null,
  resolveCompanionInferenceNotice: () => null,
}));

vi.mock("@elizaos/app-core/bridge/electrobun-runtime", () => ({
  isElectrobunRuntime: () => isElectrobunRuntimeMock(),
}));

vi.mock("../../bridge/electrobun-runtime", () => ({
  isElectrobunRuntime: () => isElectrobunRuntimeMock(),
}));

vi.mock("@elizaos/app-core/components/cloud/CloudStatusBadge", () => ({
  CloudStatusBadge: () => <div data-testid="header-cloud-status" />,
}));

vi.mock("@elizaos/app-core/components/shared/LanguageDropdown", () => ({
  LANGUAGE_DROPDOWN_TRIGGER_CLASSNAME: "",
  LanguageDropdown: () => <div data-testid="header-language-dropdown" />,
}));

vi.mock("@elizaos/app-core/components/shared/ThemeToggle", () => ({
  ThemeToggle: () => <div data-testid="header-theme-toggle" />,
}));

vi.mock("@elizaos/app-core/hooks", () => ({
  useMediaQuery: (query: string) => useMediaQueryMock(query),
}));

vi.mock("@elizaos/app-core/navigation", () => ({
  getTabGroups: (...args: unknown[]) => getTabGroupsMock(...args),
}));

vi.mock("@elizaos/app-core/state", () => ({
  useApp: () => useAppMock(),
}));

import { Header } from "./Header";

function buildUseAppState(overrides?: Record<string, unknown>) {
  return {
    browserEnabled: true,
    chatLastUsage: null,
    conversationMessages: [],
    elizaCloudAuthRejected: false,
    elizaCloudConnected: false,
    elizaCloudCredits: null,
    elizaCloudCreditsCritical: false,
    elizaCloudCreditsError: null,
    elizaCloudCreditsLow: false,
    elizaCloudEnabled: false,
    loadDropStatus: vi.fn().mockResolvedValue(undefined),
    plugins: [],
    setState: vi.fn(),
    setTab: vi.fn(),
    tab: "settings",
    t: (key: string, options?: { defaultValue?: string }) =>
      options?.defaultValue ?? key,
    uiLanguage: "en",
    uiTheme: "dark",
    setUiLanguage: vi.fn(),
    setUiTheme: vi.fn(),
    walletEnabled: false,
    ...overrides,
  };
}

describe("Header", () => {
  beforeEach(() => {
    cleanup();
    useAppMock.mockReset();
    isElectrobunRuntimeMock.mockReset();
    getTabGroupsMock.mockReset();
    useMediaQueryMock.mockReset();

    Object.defineProperty(window.navigator, "userAgent", {
      configurable: true,
      value: "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_4)",
    });
    window.history.replaceState(null, "", "/");

    useAppMock.mockReturnValue(buildUseAppState());
    isElectrobunRuntimeMock.mockReturnValue(false);
    useMediaQueryMock.mockReturnValue(false);
    getTabGroupsMock.mockReturnValue([
      {
        description: "Chat",
        icon: () => <svg aria-hidden="true" />,
        label: "Chat",
        tabs: ["chat"],
      },
      {
        description: "Settings",
        icon: () => <svg aria-hidden="true" />,
        label: "Settings",
        tabs: ["settings"],
      },
    ]);
  });

  afterEach(() => {
    cleanup();
  });

  it("shows the centered desktop title bar on the macOS Electrobun main window", () => {
    isElectrobunRuntimeMock.mockReturnValue(true);

    render(<Header hideCloudCredits />);

    const titlebar = screen.getByTestId("desktop-window-titlebar");
    expect(titlebar).toBeTruthy();
    expect(
      titlebar.closest("header")?.hasAttribute("data-no-camera-drag"),
    ).toBe(false);
    expect(
      document.documentElement.classList.contains(
        "eliza-electrobun-custom-titlebar",
      ),
    ).toBe(true);
    expect(
      screen.getByTestId("desktop-window-titlebar-drag-zone"),
    ).toBeTruthy();
    expect(screen.queryByText("Milady")).toBeNull();
  });

  it("skips the custom title bar for detached desktop shells", () => {
    isElectrobunRuntimeMock.mockReturnValue(true);
    window.history.replaceState(null, "", "/?shell=surface&tab=chat");

    render(<Header hideCloudCredits />);

    expect(screen.queryByTestId("desktop-window-titlebar")).toBeNull();
  });

  it("skips the custom title bar outside macOS desktop runtime", () => {
    Object.defineProperty(window.navigator, "userAgent", {
      configurable: true,
      value: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
    });
    isElectrobunRuntimeMock.mockReturnValue(true);

    render(<Header hideCloudCredits />);

    expect(screen.queryByTestId("desktop-window-titlebar")).toBeNull();
  });

  it("moves mobile global navigation into the bottom dock", () => {
    const setTab = vi.fn();
    useMediaQueryMock.mockImplementation(
      (query: string) => query === "(max-width: 639px)",
    );
    useAppMock.mockReturnValue(buildUseAppState({ setTab, tab: "chat" }));

    render(<Header hideCloudCredits />);

    expect(screen.queryByTestId("header-mobile-top-nav")).toBeNull();
    expect(screen.queryByTestId("header-settings-button")).toBeNull();
    expect(screen.getByTestId("header-mobile-bottom-nav")).toBeTruthy();
    expect(
      screen.getByTestId("header-mobile-bottom-nav-button-chat"),
    ).toBeTruthy();
    const settingsNavButton = screen.getByTestId(
      "header-mobile-bottom-nav-button-settings",
    );
    expect(settingsNavButton).toBeTruthy();
    fireEvent.click(settingsNavButton);
    expect(setTab).toHaveBeenCalledWith("settings");
    expect(screen.queryByText("Milady")).toBeNull();
    expect(screen.queryByTestId("header-language-dropdown")).toBeNull();
    expect(screen.queryByTestId("header-theme-toggle")).toBeNull();
    expect(
      document.documentElement.classList.contains("eliza-mobile-bottom-nav"),
    ).toBe(true);
  });

  it("keeps desktop titlebar buttons out of drag handling and clickable", () => {
    const setTab = vi.fn();
    const outerPointerDown = vi.fn();
    isElectrobunRuntimeMock.mockReturnValue(true);
    useAppMock.mockReturnValue(buildUseAppState({ setTab, tab: "chat" }));
    getTabGroupsMock.mockReturnValue([
      {
        description: "Chat",
        icon: () => <svg aria-hidden="true" />,
        label: "Chat",
        tabs: ["chat"],
      },
      {
        description: "Apps",
        icon: () => <svg aria-hidden="true" />,
        label: "Apps",
        tabs: ["apps"],
      },
      {
        description: "Settings",
        icon: () => <svg aria-hidden="true" />,
        label: "Settings",
        tabs: ["settings"],
      },
    ]);

    render(
      <div onPointerDown={outerPointerDown}>
        <Header hideCloudCredits />
      </div>,
    );

    const appsButton = screen.getByTestId("header-nav-button-apps");
    expect(appsButton.getAttribute("data-no-camera-drag")).toBe("true");
    fireEvent.pointerDown(appsButton);
    expect(outerPointerDown).not.toHaveBeenCalled();
    fireEvent.click(appsButton);
    expect(setTab).toHaveBeenCalledWith("apps");

    const settingsButton = screen.getByTestId("header-settings-button");
    expect(settingsButton.getAttribute("data-no-camera-drag")).toBe("true");
    fireEvent.pointerDown(settingsButton);
    expect(outerPointerDown).not.toHaveBeenCalled();
    fireEvent.click(settingsButton);
    expect(setTab).toHaveBeenCalledWith("settings");
  });
});
