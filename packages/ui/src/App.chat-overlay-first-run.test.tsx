/** Verifies App chat-overlay first-run composition through the package's configured test harness. */
// @vitest-environment jsdom

/**
 * Chat-overlay first-run composition wiring (#9952 / #10720).
 *
 * The desktop bottom bar boots the renderer with `?shellMode=chat-overlay`,
 * which takes App's early chat-overlay return — it never reaches the full-shell
 * return. `FirstRunConductorMount` (the ONLY thing that seeds the in-chat
 * onboarding greeting/runtime/provider/tutorial turns) must therefore mount on
 * the chat-overlay branch too, or a fresh desktop install boots into the bottom
 * bar with no runtime configured and no onboarding ever seeded.
 *
 * These tests mount the REAL App with `?shellMode=chat-overlay` and pin the
 * composition contract:
 *  - first-run incomplete → the conductor mounts inside the chat-overlay
 *    branch (its hook runs), the overlay surface renders, and NO app chrome or
 *    StartupScreen gate appears;
 *  - first-run complete → the mount is still present but UNGATED by App (the
 *    hook self-gates on firstRunComplete — see the no-op coverage in
 *    first-run/use-first-run-conductor.test.ts), and the overlay still renders
 *    chrome-free, so plain web `?shellMode=chat-overlay` loads are unaffected.
 */

import { cleanup, render, waitFor } from "@testing-library/react";
import type * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const appState = vi.hoisted(() => ({
  authPhase: "loading",
  firstRunComplete: false,
  startupPhase: "first-run-required",
}));

const notificationMock = vi.hoisted(() => ({
  init: vi.fn(async () => undefined),
}));

vi.mock("./state/notifications/notification-store", () => ({
  initNotifications: notificationMock.init,
  seedDevNotificationsIfEmpty: vi.fn(async () => undefined),
  useNotifications: () => ({ notifications: [] }),
}));

const conductorMock = vi.hoisted(() => ({
  mount: vi.fn(),
}));

const shellContextMock = vi.hoisted(() => ({
  controller: {
    isOpen: false,
    phase: "idle",
    close: vi.fn(),
  },
}));

// The key mock: App imports FirstRunConductorMount from this module (its only
// importer). The spy proves App composed the conductor into the tree the
// chat-overlay branch actually returns; the marker div (the real component
// renders null) lets the tests assert WHERE it mounted.
vi.mock("./first-run/use-first-run-conductor", () => ({
  FirstRunConductorMount: () => {
    conductorMock.mount();
    return <div data-testid="first-run-conductor-mount" />;
  },
  useFirstRunConductor: (): void => {
    conductorMock.mount();
  },
  surfaceCloudLoginRetryTurn: vi.fn(),
}));

vi.mock("@capacitor/keyboard", () => ({
  Keyboard: { setScroll: vi.fn(async () => undefined) },
}));

vi.mock("./bridge/electrobun-rpc", () => ({
  getElectrobunRendererRpc: vi.fn(() => undefined),
  invokeDesktopBridgeRequest: vi.fn(async () => ({ id: "window-1" })),
  invokeDesktopBridgeRequestWithTimeout: vi.fn(async () => undefined),
  subscribeDesktopBridgeEvent: vi.fn(() => vi.fn()),
  openDesktopAppWindow: vi.fn(async () => ({ id: "window-1" })),
  openDesktopLauncherWindow: vi.fn(async () => ({ id: "launcher-1" })),
}));

vi.mock("./bridge/electrobun-runtime", () => ({
  isElectrobunRuntime: () => true,
}));

vi.mock("./platform/init", () => ({
  isDesktopPlatform: () => false,
  isIOS: false,
  isNative: false,
  isStandalonePwa: () => false,
  isWebPlatform: () => true,
}));

vi.mock("./hooks/useDesktopTabs", () => ({
  useDesktopTabs: () => ({
    tabs: [],
    closeTab: vi.fn(),
    openTab: vi.fn(),
  }),
}));

vi.mock("./hooks/useAvailableViews", () => ({
  useAvailableViews: () => ({ views: [] }),
  useRoutableViews: () => ({ views: [] }),
}));

vi.mock("./hooks/useAuthStatus", () => ({
  isAuthenticatedNow: () => false,
  useIsAuthenticated: () => false,
  subscribeAuthStatus: () => () => undefined,
  useAuthStatus: () => ({
    state: { phase: appState.authPhase },
    refetch: vi.fn(),
  }),
}));

vi.mock("./hooks/useActivityEvents", () => ({
  useActivityEvents: () => ({ events: [], clearEvents: vi.fn() }),
}));

vi.mock("./hooks", () => ({
  BugReportProvider: ({ children }: { children: React.ReactNode }) => (
    <>{children}</>
  ),
  useBugReportState: () => ({}),
  useContextMenu: () => ({
    closeSaveCommandModal: vi.fn(),
    confirmSaveCommand: vi.fn(),
    saveCommandModalOpen: false,
    saveCommandText: "",
  }),
  useMediaQuery: () => false,
  useRenderGuard: vi.fn(),
}));

vi.mock("./state", () => {
  // Rebuilt on each access so `appState.firstRunComplete` / `startupPhase`
  // are read LIVE — tests mutate appState between renders.
  const getAppValue = () => ({
    actionNotice: null,
    activeGameViewerUrl: null,
    activeOverlayApp: null,
    agentStatus: null,
    backendConnection: { state: "connected" },
    characterData: null,
    copyToClipboard: vi.fn(),
    databaseSubTab: "overview",
    dismissSystemWarning: vi.fn(),
    elizaCloudConnected: false,
    elizaCloudVoiceProxyAvailable: false,
    firstRunComplete: appState.firstRunComplete,
    firstRunName: "",
    gameOverlayEnabled: false,
    handlePluginToggle: vi.fn(),
    loadDropStatus: vi.fn(async () => undefined),
    ownerName: "Test Owner",
    plugins: [],
    retryStartup: vi.fn(),
    setActionNotice: vi.fn(),
    setState: vi.fn(),
    setTab: vi.fn(),
    setUiLanguage: vi.fn(),
    setUiTheme: vi.fn(),
    setUiThemeMode: vi.fn(),
    startupCoordinator: {
      phase: appState.startupPhase,
      isShellPaintable: [
        "first-run-required",
        "starting-runtime",
        "hydrating",
        "ready",
      ].includes(appState.startupPhase),
      dispatch: vi.fn(),
      retry: vi.fn(),
    },
    startupError: null,
    systemWarnings: [],
    tab: "chat",
    t: (_key: string, options?: { defaultValue?: string }) =>
      options?.defaultValue ?? "",
    uiLanguage: "en",
    uiShellMode: "default",
    uiTheme: "light",
    uiThemeMode: "system",
  });
  return {
    useApp: () => getAppValue(),
    useAppSelector: <T,>(
      selector: (s: ReturnType<typeof getAppValue>) => T,
    ): T => selector(getAppValue()),
    useAppSelectorShallow: <T,>(
      selector: (s: ReturnType<typeof getAppValue>) => T,
    ): T => selector(getAppValue()),
  };
});

vi.mock("./config/boot-config-react.hooks", () => ({
  useBootConfig: () => ({}),
}));

vi.mock("./components/shell/ShellControllerContext", () => ({
  ShellControllerProvider: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="shell-controller-provider">{children}</div>
  ),
}));

vi.mock("./components/shell/ShellControllerContext.hooks", () => ({
  useShellControllerContext: () => shellContextMock.controller,
}));

vi.mock("./components/shell/ChatOverlay", () => ({
  ChatOverlay: ({ firstRunOpen }: { firstRunOpen?: boolean }) => (
    <div
      data-testid="chat-overlay"
      data-first-run-open={firstRunOpen ? "true" : "false"}
    />
  ),
}));

vi.mock("./components/shell/StartupScreen", () => ({
  StartupScreen: () => <div data-testid="startup-screen" />,
}));

vi.mock("./components/shell/BugReportModal", () => ({
  BugReportModal: () => null,
}));

vi.mock("./components/shell/HomePill", () => ({
  HomePill: () => <button type="button">home pill</button>,
}));

vi.mock("./components/shell/AssistantOverlay", () => ({
  AssistantOverlay: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="assistant-overlay">{children}</div>
  ),
}));

vi.mock("./components/shell/ChatSurface", () => ({
  ChatSurface: () => <div data-testid="chat-surface" />,
}));

vi.mock("./components/shell/SystemWarningBanner", () => ({
  SystemWarningBanner: () => null,
}));

vi.mock("./components/shell/ShellOverlays", () => ({
  ShellOverlays: () => null,
}));

vi.mock("./components/chat/SaveCommandModal", () => ({
  SaveCommandModal: () => null,
}));

vi.mock("./components/pages/ChatView", () => ({
  ChatView: () => <div data-testid="chat-view" />,
  __resetCompanionSpeechMemoryForTests: vi.fn(),
}));

vi.mock("./components/character/CharacterEditor", () => ({
  CharacterEditor: () => <div data-testid="character-editor" />,
}));

vi.mock("./components/pages/LauncherSurface", () => ({
  LauncherSurface: () => <div data-testid="launcher-surface" />,
}));

vi.mock("./widgets/WidgetHost", () => ({
  WidgetHost: () => <div data-testid="home-widget-host" />,
}));

vi.mock("./components/settings/SecretsManagerSection", () => ({
  VaultModal: () => null,
}));

vi.mock("./components/custom-actions/CustomActionEditor", () => ({
  CustomActionEditor: () => null,
}));

vi.mock("./components/shell/ConnectionLostOverlay", () => ({
  ConnectionLostOverlay: () => null,
}));

vi.mock("./components/views/DynamicViewLoader", () => ({
  DynamicViewLoader: () => null,
}));

vi.mock("./hooks/useSecretsManagerShortcut", () => ({
  useSecretsManagerShortcut: vi.fn(),
}));

vi.mock("./hooks/useIsDeveloperMode", () => ({
  useIsDeveloperMode: () => false,
}));

import { App } from "./App";

describe("App chat-overlay first-run composition", () => {
  beforeEach(() => {
    appState.authPhase = "loading";
    appState.firstRunComplete = false;
    appState.startupPhase = "first-run-required";
    window.history.replaceState(null, "", "/?shellMode=chat-overlay");
    conductorMock.mount.mockClear();
    notificationMock.init.mockClear();
  });

  afterEach(() => {
    cleanup();
    window.history.replaceState(null, "", "/");
  });

  it("mounts the first-run conductor inside the chat-overlay branch while first-run is incomplete", () => {
    appState.firstRunComplete = false;
    appState.startupPhase = "first-run-required";

    const { getByTestId } = render(<App />);

    // The overlay surface renders (fresh desktop installs land here)…
    expect(getByTestId("chat-overlay-shell")).toBeTruthy();
    // …and the in-chat onboarding conductor is composed into the SAME tree, so
    // its seed effect (greeting + runtime/provider/tutorial turns) runs.
    expect(conductorMock.mount).toHaveBeenCalled();
    // The controller starts closed on a fresh launch. Onboarding still owns a
    // forced-open ChatOverlay, otherwise its messages are clipped inside the
    // native 64x44 resting pill until the user somehow opens the controller.
    expect(getByTestId("chat-overlay").dataset.firstRunOpen).toBe("true");
    // The conductor mounts inside the shell-controller subtree, mirroring the
    // full-shell composition at the ChatOverlay mount site.
    expect(
      getByTestId("shell-controller-provider").querySelector(
        '[data-testid="first-run-conductor-mount"]',
      ),
    ).not.toBeNull();
  });

  it("bypasses the StartupScreen gate and renders no app chrome during first-run", () => {
    appState.firstRunComplete = false;
    appState.startupPhase = "first-run-required";

    const { container, getByTestId, queryByTestId } = render(<App />);

    expect(getByTestId("chat-overlay-shell")).toBeTruthy();
    // No blocking startup gate in front of the overlay…
    expect(queryByTestId("startup-screen")).toBeNull();
    // …and none of the full-shell chrome leaked into the overlay window.
    expect(queryByTestId("app-opaque-background")).toBeNull();
    expect(
      container.querySelector('[data-shell-content-region="true"]'),
    ).toBeNull();
  });

  it("boots WebSocket notification ingress outside startup and auth early returns", async () => {
    window.history.replaceState(null, "", "/");
    appState.firstRunComplete = true;
    appState.startupPhase = "polling-backend";
    appState.authPhase = "loading";

    const startupGate = render(<App />);
    expect(startupGate.getByTestId("startup-screen")).toBeTruthy();
    await waitFor(() => expect(notificationMock.init).toHaveBeenCalledOnce());
    startupGate.unmount();
  });

  it("keeps the mounted shell across the completion probe, then returns to the boundary on a later probe", () => {
    // Four-state regression (#19191 / maintainer audit on #19336): the hold
    // must be bounded to the completion edge, not a permanent bypass.
    window.history.replaceState(null, "", "/");
    appState.firstRunComplete = false;
    appState.startupPhase = "first-run-required";
    appState.authPhase = "loading";

    // 1. Onboarding: the shell paints (no StartupScreen gate).
    const shell = render(<App />);
    const mountedProvider = shell.getByTestId("shell-controller-provider");
    expect(shell.queryByTestId("startup-screen")).toBeNull();

    // 2. Completion edge: the auth probe is loading, but the already-painted
    //    onboarding shell must stay mounted (same provider instance).
    appState.firstRunComplete = true;
    appState.startupPhase = "ready";
    shell.rerender(<App />);
    expect(shell.queryByTestId("startup-screen")).toBeNull();
    expect(shell.getByTestId("shell-controller-provider")).toBe(
      mountedProvider,
    );

    // 3. Probe resolves: shell remains, and the completion hold is released.
    appState.authPhase = "authenticated";
    shell.rerender(<App />);
    expect(shell.queryByTestId("startup-screen")).toBeNull();
    expect(shell.getByTestId("shell-controller-provider")).toBeTruthy();

    // 4. A later credential refetch must return to the startup/auth boundary
    //    instead of keeping protected shell providers mounted.
    appState.authPhase = "loading";
    shell.rerender(<App />);
    expect(shell.getByTestId("startup-screen")).toBeTruthy();
    expect(shell.queryByTestId("shell-controller-provider")).toBeNull();
  });

  it("holds an ordinary authenticated shell when a later auth probe starts", () => {
    window.history.replaceState(null, "", "/");
    appState.firstRunComplete = true;
    appState.startupPhase = "ready";
    appState.authPhase = "authenticated";

    const shell = render(<App />);
    expect(shell.getByTestId("shell-controller-provider")).toBeTruthy();

    appState.authPhase = "loading";
    shell.rerender(<App />);

    expect(shell.getByTestId("startup-screen")).toBeTruthy();
    expect(shell.queryByTestId("shell-controller-provider")).toBeNull();
  });

  it("keeps the conductor mounted but UNGATED by App once first-run completes (hook self-gates)", () => {
    appState.firstRunComplete = true;
    appState.startupPhase = "ready";

    const { getByTestId, queryByTestId } = render(<App />);

    // The overlay is never gated on first-run state…
    expect(getByTestId("chat-overlay-shell")).toBeTruthy();
    expect(queryByTestId("startup-screen")).toBeNull();
    // …and App does NOT double-gate the conductor: the mount still renders and
    // the hook's own `firstRunComplete === false` check makes it a no-op
    // (behavioral no-op coverage: first-run/use-first-run-conductor.test.ts).
    expect(conductorMock.mount).toHaveBeenCalled();
    expect(queryByTestId("first-run-conductor-mount")).not.toBeNull();
  });
});
