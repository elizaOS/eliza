// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  getTabGroupsMock,
  isElectrobunRuntimeMock,
  useMediaQueryMock,
  useAppMock,
  useBrandingMock,
} = vi.hoisted(() => ({
  getTabGroupsMock: vi.fn(),
  isElectrobunRuntimeMock: vi.fn(),
  useMediaQueryMock: vi.fn(),
  useAppMock: vi.fn(),
  useBrandingMock: vi.fn(),
}));

vi.mock("@elizaos/app-companion/ui", () => ({
  InferenceCloudAlertButton: () => null,
  resolveCompanionInferenceNotice: () => null,
}));

vi.mock("@elizaos/app-core/bridge/electrobun-runtime", () => ({
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

vi.mock("@elizaos/app-core/config/branding", () => ({
  useBranding: () => useBrandingMock(),
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
    useBrandingMock.mockReset();
    isElectrobunRuntimeMock.mockReset();
    getTabGroupsMock.mockReset();
    useMediaQueryMock.mockReset();

    Object.defineProperty(window.navigator, "userAgent", {
      configurable: true,
      value: "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_4)",
    });
    window.history.replaceState(null, "", "/");

    useAppMock.mockReturnValue(buildUseAppState());
    useBrandingMock.mockReturnValue({ appName: "Milady" });
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

    expect(screen.getByTestId("desktop-window-titlebar")).toBeTruthy();
    expect(
      document.documentElement.classList.contains(
        "eliza-electrobun-custom-titlebar",
      ),
    ).toBe(true);
    expect(
      screen.getByTestId("desktop-window-titlebar-label").textContent,
    ).toBe("Milady");
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

  it("renders the bottom navigation on mobile without desktop chrome controls", () => {
    useMediaQueryMock.mockImplementation(
      (query: string) => query === "(max-width: 639px)",
    );

    render(<Header hideCloudCredits />);

    expect(screen.getByTestId("header-mobile-bottom-nav")).toBeTruthy();
    expect(screen.queryByTestId("header-language-dropdown")).toBeNull();
    expect(screen.queryByTestId("header-theme-toggle")).toBeNull();
    expect(
      document.documentElement.classList.contains("eliza-mobile-bottom-nav"),
    ).toBe(true);
  });
});
