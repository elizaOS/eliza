// @vitest-environment jsdom

import { cleanup, render, waitFor } from "@testing-library/react";
import type * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const appState = vi.hoisted(() => ({
  setTab: vi.fn(),
  tab: "chat",
}));

const desktopTabsMock = vi.hoisted(() => ({
  closeTab: vi.fn(),
  openTab: vi.fn(),
}));

const desktopBridgeMock = vi.hoisted(() => ({
  getElectrobunRendererRpc: vi.fn(() => undefined),
  invokeDesktopBridgeRequest: vi.fn(async () => ({ id: "window-1" })),
  subscribeDesktopBridgeEvent: vi.fn(() => vi.fn()),
}));

const dynamicViewLoaderMock = vi.hoisted(() => ({
  render: vi.fn(
    ({
      bundleUrl,
      viewId,
      viewType,
    }: {
      bundleUrl: string;
      viewId: string;
      viewType?: string;
    }) => (
      <div
        data-bundle-url={bundleUrl}
        data-testid="dynamic-view-loader"
        data-view-id={viewId}
        data-view-type={viewType ?? ""}
      />
    ),
  ),
}));

const remoteLedgerView = {
  id: "remote-ledger",
  label: "Remote Ledger",
  available: true,
  pluginName: "@local/plugin-ledger",
  path: "/apps/remote-ledger",
  bundleUrl: "/api/views/remote-ledger/bundle.js",
  viewType: "gui" as const,
};

vi.mock("@capacitor/keyboard", () => ({
  Keyboard: { setScroll: vi.fn(async () => undefined) },
}));

vi.mock("./bridge/electrobun-rpc", () => desktopBridgeMock);

vi.mock("./platform/init", () => ({
  isDesktopPlatform: () => false,
  isIOS: false,
  isNative: false,
  isWebPlatform: () => true,
}));

vi.mock("./hooks/useDesktopTabs", () => ({
  useDesktopTabs: () => ({
    tabs: [],
    closeTab: desktopTabsMock.closeTab,
    openTab: desktopTabsMock.openTab,
  }),
}));

vi.mock("./hooks/useAvailableViews", () => ({
  useAvailableViews: () => ({ views: [remoteLedgerView] }),
}));

vi.mock("./hooks/useAuthStatus", () => ({
  useAuthStatus: () => ({
    state: { phase: "authenticated" },
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

vi.mock("./state", () => ({
  useApp: () => ({
    actionNotice: null,
    activeGameViewerUrl: null,
    activeOverlayApp: null,
    backendConnection: { state: "connected" },
    gameOverlayEnabled: false,
    loadDropStatus: vi.fn(async () => undefined),
    firstRunComplete: true,
    ownerName: "Test Owner",
    plugins: [],
    retryStartup: vi.fn(),
    setState: vi.fn(),
    setTab: appState.setTab,
    setUiLanguage: vi.fn(),
    setUiTheme: vi.fn(),
    setUiThemeMode: vi.fn(),
    startupCoordinator: {
      phase: "ready",
      retry: vi.fn(),
    },
    startupError: null,
    tab: appState.tab,
    t: (_key: string, options?: { defaultValue?: string }) =>
      options?.defaultValue ?? "",
    uiLanguage: "en",
    uiShellMode: "default",
    uiTheme: "light",
    uiThemeMode: "system",
  }),
}));

vi.mock("./config/boot-config-react", () => ({
  useBootConfig: () => ({ companionShell: null }),
}));

vi.mock("./components/shell/ShellControllerContext", () => ({
  ShellControllerProvider: ({ children }: { children: React.ReactNode }) => (
    <>{children}</>
  ),
  useShellControllerContext: () => ({
    canSend: true,
    close: vi.fn(),
    messages: [],
    open: vi.fn(),
    phase: "idle",
    recording: false,
    send: vi.fn(),
    toggleRecording: vi.fn(),
    startRecording: vi.fn(),
    stopRecording: vi.fn(),
    waveformMode: "idle",
  }),
}));

vi.mock("./components/voice/VoiceWaveform", () => ({
  VoiceWaveform: () => <div data-testid="voice-waveform" />,
}));

vi.mock("./components/views/DynamicViewLoader", () => ({
  DynamicViewLoader: dynamicViewLoaderMock.render,
}));

vi.mock("./components/shell/BugReportModal", () => ({
  BugReportModal: () => null,
}));

vi.mock("./components/shell/ChatSurface", () => ({
  ChatSurface: () => <div data-testid="chat-surface" />,
}));

vi.mock("./components/shell/HomePill", () => ({
  HomePill: () => <button type="button">home pill</button>,
}));

vi.mock("./components/shell/AssistantOverlay", () => ({
  AssistantOverlay: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="assistant-overlay">{children}</div>
  ),
}));

vi.mock("./components/shell/ConnectionFailedBanner", () => ({
  ConnectionFailedBanner: () => null,
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

vi.mock("./components/settings/SecretsManagerSection", () => ({
  SecretsManagerModalRoot: () => null,
}));

vi.mock("./components/custom-actions/CustomActionEditor", () => ({
  CustomActionEditor: () => null,
}));

vi.mock("./components/shell/ConnectionLostOverlay", () => ({
  ConnectionLostOverlay: () => null,
}));

vi.mock("./hooks/useSecretsManagerShortcut", () => ({
  useSecretsManagerShortcut: vi.fn(),
}));

vi.mock("./hooks/useIsDeveloperMode", () => ({
  useIsDeveloperMode: () => false,
}));

import { App } from "./App";

function navigateView(detail: Record<string, unknown>) {
  window.dispatchEvent(new CustomEvent("eliza:navigate:view", { detail }));
}

describe("App navigate-view event wiring", () => {
  beforeEach(() => {
    window.history.replaceState(null, "", "/?shellMode=chat-overlay");
    appState.tab = "chat";
    appState.setTab.mockClear();
    desktopTabsMock.openTab.mockClear();
    desktopTabsMock.closeTab.mockClear();
    desktopBridgeMock.invokeDesktopBridgeRequest.mockClear();
    desktopBridgeMock.subscribeDesktopBridgeEvent.mockClear();
    dynamicViewLoaderMock.render.mockClear();
  });

  afterEach(() => {
    cleanup();
  });

  it("routes view-manager events through the mounted App listener", async () => {
    render(<App />);

    navigateView({ viewPath: "/views" });
    navigateView({ viewId: "views-manager", viewType: "gui" });

    await waitFor(() => {
      expect(appState.setTab).toHaveBeenCalledWith("views");
    });
    expect(appState.setTab).toHaveBeenCalledTimes(2);
    expect(desktopTabsMock.openTab).not.toHaveBeenCalled();
  });

  it("pins remote views and opens remote view windows through App wiring", async () => {
    render(<App />);

    navigateView({ action: "pin-tab", viewId: "remote-ledger" });

    await waitFor(() => {
      expect(desktopTabsMock.openTab).toHaveBeenCalledWith(remoteLedgerView, {
        pinned: true,
      });
    });
    expect(window.location.pathname).toBe("/apps/remote-ledger");

    navigateView({
      action: "open-window",
      viewId: "remote-ledger",
      alwaysOnTop: true,
    });

    await waitFor(() => {
      expect(desktopBridgeMock.invokeDesktopBridgeRequest).toHaveBeenCalledWith(
        {
          ipcChannel: "desktop:openAppWindow",
          params: {
            alwaysOnTop: true,
            path: "/apps/remote-ledger",
            title: "Remote Ledger",
          },
          rpcMethod: "desktopOpenAppWindow",
        },
      );
    });
  });

  it("renders a remote module route through DynamicViewLoader in the mounted App", async () => {
    appState.tab = "apps";
    window.history.replaceState(null, "", "/apps/remote-ledger");

    const { getByTestId } = render(<App />);

    await waitFor(() => {
      expect(dynamicViewLoaderMock.render).toHaveBeenCalledWith(
        expect.objectContaining({
          bundleUrl: "/api/views/remote-ledger/bundle.js",
          viewId: "remote-ledger",
          viewType: "gui",
        }),
        undefined,
      );
    });
    const loader = getByTestId("dynamic-view-loader");
    expect(loader.getAttribute("data-bundle-url")).toBe(
      "/api/views/remote-ledger/bundle.js",
    );
    expect(loader.getAttribute("data-view-id")).toBe("remote-ledger");
    expect(loader.getAttribute("data-view-type")).toBe("gui");
  });
});
