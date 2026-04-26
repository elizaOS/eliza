// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

var getTabGroupsMock = vi.fn();
var isElectrobunRuntimeMock = vi.fn();
var useMediaQueryMock = vi.fn();
var useAppMock = vi.fn();
var getOverlayAppMock = vi.fn();

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

vi.mock("@elizaos/app-core/navigation", async () => {
  const actual = await vi.importActual<
    typeof import("@elizaos/app-core/navigation")
  >("@elizaos/app-core/navigation");
  return {
    ...actual,
    getTabGroups: (...args: unknown[]) => getTabGroupsMock(...args),
  };
});

vi.mock("@elizaos/app-core/state", () => ({
  useApp: () => useAppMock(),
}));

vi.mock("../apps/overlay-app-registry", () => ({
  getOverlayApp: (name: string) => getOverlayAppMock(name),
}));

import { Header } from "./Header";

function buildUseAppState(overrides?: Record<string, unknown>) {
  return {
    activeGameRunId: "",
    activeOverlayApp: null,
    appRuns: [],
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
    getOverlayAppMock.mockReset();
    getOverlayAppMock.mockReturnValue(undefined);

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

  describe("active-app breadcrumb", () => {
    it("hides the breadcrumb when no app is active", () => {
      render(<Header hideCloudCredits />);
      expect(screen.queryByTestId("header-breadcrumb")).toBeNull();
      expect(screen.queryByTestId("header-breadcrumb-home")).toBeNull();
      expect(screen.queryByTestId("header-breadcrumb-current")).toBeNull();
    });

    it("renders 'Apps > <displayName>' from an active overlay app", () => {
      getOverlayAppMock.mockReturnValue({
        name: "@elizaos/app-companion",
        displayName: "Companion",
        description: "",
        category: "",
        icon: null,
        Component: () => null as unknown as JSX.Element,
      });
      useAppMock.mockReturnValue(
        buildUseAppState({ activeOverlayApp: "@elizaos/app-companion" }),
      );

      render(<Header hideCloudCredits />);

      const crumb = screen.getByTestId("header-breadcrumb");
      expect(crumb.getAttribute("aria-label")).toBe("Breadcrumb");
      expect(screen.getByTestId("header-breadcrumb-home").textContent).toBe(
        "Apps",
      );
      const current = screen.getByTestId("header-breadcrumb-current");
      expect(current.textContent).toBe("Companion");
      expect(current.getAttribute("aria-current")).toBe("page");
      expect(current.getAttribute("title")).toBe("Companion");
    });

    it("renders the active game run's displayName when one is active", () => {
      useAppMock.mockReturnValue(
        buildUseAppState({
          activeGameRunId: "run-42",
          appRuns: [
            { runId: "run-42", appName: "trivia", displayName: "Trivia Night" },
          ],
        }),
      );

      render(<Header hideCloudCredits />);
      expect(screen.getByTestId("header-breadcrumb-current").textContent).toBe(
        "Trivia Night",
      );
    });

    it("hides the breadcrumb when the overlay registry returns nothing (no raw slug leak)", () => {
      getOverlayAppMock.mockReturnValue(undefined);
      useAppMock.mockReturnValue(
        buildUseAppState({ activeOverlayApp: "ghost-app-internal-id" }),
      );

      render(<Header hideCloudCredits />);
      expect(screen.queryByTestId("header-breadcrumb")).toBeNull();
      expect(screen.queryByText("ghost-app-internal-id")).toBeNull();
    });

    it("clears active app state and navigates to apps tab on home click", () => {
      const setState = vi.fn();
      const setTab = vi.fn();
      getOverlayAppMock.mockReturnValue({
        name: "@elizaos/app-companion",
        displayName: "Companion",
        description: "",
        category: "",
        icon: null,
        Component: () => null as unknown as JSX.Element,
      });
      useAppMock.mockReturnValue(
        buildUseAppState({
          activeOverlayApp: "@elizaos/app-companion",
          setState,
          setTab,
          tab: "chat",
        }),
      );

      render(<Header hideCloudCredits />);

      const home = screen.getByTestId("header-breadcrumb-home");
      fireEvent.click(home);

      expect(setState).toHaveBeenCalledWith("activeOverlayApp", null);
      expect(setState).toHaveBeenCalledWith("activeGameRunId", "");
      expect(setTab).toHaveBeenCalledWith("apps");
    });

    it("preserves the desktop-window-titlebar-drag-zone test-id when the breadcrumb is shown", () => {
      isElectrobunRuntimeMock.mockReturnValue(true);
      getOverlayAppMock.mockReturnValue({
        name: "@elizaos/app-companion",
        displayName: "Companion",
        description: "",
        category: "",
        icon: null,
        Component: () => null as unknown as JSX.Element,
      });
      useAppMock.mockReturnValue(
        buildUseAppState({ activeOverlayApp: "@elizaos/app-companion" }),
      );

      render(<Header hideCloudCredits />);

      const dragZone = screen.getByTestId("desktop-window-titlebar-drag-zone");
      expect(dragZone).toBeTruthy();
      expect(
        dragZone.querySelector('[data-testid="header-breadcrumb"]'),
      ).toBeTruthy();
      expect(dragZone.getAttribute("data-no-camera-drag")).toBe("true");
    });

    it("renders 'Apps > LifeOps' when on the lifeops tool tab (no overlay needed)", () => {
      useAppMock.mockReturnValue(buildUseAppState({ tab: "lifeops" }));

      render(<Header hideCloudCredits />);

      expect(screen.getByTestId("header-breadcrumb-home").textContent).toBe(
        "Apps",
      );
      expect(screen.getByTestId("header-breadcrumb-current").textContent).toBe(
        "LifeOps",
      );
    });

    it("renders 'Apps > Plugins' when on the plugins tool tab", () => {
      useAppMock.mockReturnValue(buildUseAppState({ tab: "plugins" }));

      render(<Header hideCloudCredits />);

      expect(screen.getByTestId("header-breadcrumb-current").textContent).toBe(
        "Plugins",
      );
    });

    it("renders 'Apps > Skills' when on the skills tool tab", () => {
      useAppMock.mockReturnValue(buildUseAppState({ tab: "skills" }));
      render(<Header hideCloudCredits />);
      expect(screen.getByTestId("header-breadcrumb-current").textContent).toBe(
        "Skills",
      );
    });

    it("does NOT show breadcrumb on top-level tabs that aren't under Apps", () => {
      // chat / browser / inventory / character live in their own nav groups.
      for (const tab of ["chat", "browser", "inventory", "character"]) {
        cleanup();
        useAppMock.mockReturnValue(buildUseAppState({ tab }));
        render(<Header hideCloudCredits />);
        expect(screen.queryByTestId("header-breadcrumb")).toBeNull();
      }
    });

    it("does NOT show breadcrumb on the apps catalog itself (no app selected)", () => {
      useAppMock.mockReturnValue(buildUseAppState({ tab: "apps" }));
      render(<Header hideCloudCredits />);
      expect(screen.queryByTestId("header-breadcrumb")).toBeNull();
    });

    it("tool-tab home click navigates to apps without touching overlay state", () => {
      const setState = vi.fn();
      const setTab = vi.fn();
      useAppMock.mockReturnValue(
        buildUseAppState({ setState, setTab, tab: "lifeops" }),
      );

      render(<Header hideCloudCredits />);
      fireEvent.click(screen.getByTestId("header-breadcrumb-home"));

      // Tool-tab branch: navigate only, no overlay/run reset.
      expect(setTab).toHaveBeenCalledWith("apps");
      expect(setState).not.toHaveBeenCalledWith("activeOverlayApp", null);
      expect(setState).not.toHaveBeenCalledWith("activeGameRunId", "");
    });

    it("opts breadcrumb home button out of camera drag without swallowing pointerdown reach to OS", () => {
      const outerPointerDown = vi.fn();
      getOverlayAppMock.mockReturnValue({
        name: "@elizaos/app-companion",
        displayName: "Companion",
        description: "",
        category: "",
        icon: null,
        Component: () => null as unknown as JSX.Element,
      });
      useAppMock.mockReturnValue(
        buildUseAppState({ activeOverlayApp: "@elizaos/app-companion" }),
      );

      render(
        <div onPointerDown={outerPointerDown}>
          <Header hideCloudCredits />
        </div>,
      );

      const home = screen.getByTestId("header-breadcrumb-home");
      expect(home.getAttribute("data-no-camera-drag")).toBe("true");
      fireEvent.pointerDown(home);
      expect(outerPointerDown).not.toHaveBeenCalled();
    });
  });
});
