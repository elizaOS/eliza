// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
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

const desktopTabsState = vi.hoisted(() => ({
  tabs: [] as Array<{
    viewId: string;
    label: string;
    path: string;
    icon?: string;
    pinned: boolean;
  }>,
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

const viewsManagerView = {
  id: "views-manager",
  label: "View Manager",
  available: true,
  pluginName: "@elizaos/plugin-app-control",
  path: "/views",
  bundleUrl: "/api/views/views-manager/bundle.js",
  viewType: "gui" as const,
};

const viewsManagerTuiView = {
  ...viewsManagerView,
  path: "/views/tui",
  viewType: "tui" as const,
};

const notesView = {
  id: "notes",
  label: "Notes",
  available: true,
  pluginName: "@elizaos/plugin-simple-views",
  path: "/notes",
  bundleUrl: "/api/views/notes/bundle.js",
  viewType: "gui" as const,
};

const calendarView = {
  id: "calendar",
  label: "Calendar",
  available: true,
  pluginName: "@elizaos/plugin-simple-views",
  path: "/calendar",
  bundleUrl: "/api/views/calendar/bundle.js",
  viewType: "gui" as const,
};

const documentsView = {
  id: "documents",
  label: "Knowledge",
  available: true,
  pluginName: "@elizaos/plugin-documents",
  path: "/documents",
  bundleUrl: "/api/views/documents/bundle.js",
  viewType: "gui" as const,
};

const mockAvailableViews = [
  remoteLedgerView,
  viewsManagerView,
  viewsManagerTuiView,
  notesView,
  calendarView,
  documentsView,
];

vi.mock("@capacitor/keyboard", () => ({
  Keyboard: { setScroll: vi.fn(async () => undefined) },
}));

vi.mock("./bridge/electrobun-rpc", () => desktopBridgeMock);

vi.mock("./bridge/electrobun-runtime", () => ({
  isElectrobunRuntime: () => true,
}));

vi.mock("./platform/init", () => ({
  isDesktopPlatform: () => false,
  isIOS: false,
  isNative: false,
  isWebPlatform: () => true,
}));

vi.mock("./hooks/useDesktopTabs", () => ({
  useDesktopTabs: () => ({
    tabs: desktopTabsState.tabs,
    closeTab: desktopTabsMock.closeTab,
    openTab: desktopTabsMock.openTab,
  }),
}));

vi.mock("./hooks/useAvailableViews", () => ({
  useAvailableViews: () => ({
    views: mockAvailableViews,
  }),
  useRoutableViews: () => ({
    views: mockAvailableViews,
  }),
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

vi.mock("./state", () => {
  // Rebuilt on each access so `appState.tab`/`setTab` are read LIVE — the
  // navigation tests mutate appState between renders, and useApp / the selector
  // hooks must reflect that (mirrors the original fresh-object-per-call mock).
  const getAppValue = () => ({
    actionNotice: null,
    activeGameViewerUrl: null,
    activeOverlayApp: null,
    agentStatus: null,
    backendConnection: { state: "connected" },
    cloudHandoffPhase: "idle",
    copyToClipboard: vi.fn(),
    databaseSubTab: "overview",
    dismissActionBanner: vi.fn(),
    dismissSystemWarning: vi.fn(),
    elizaCloudConnected: false,
    elizaCloudVoiceProxyAvailable: false,
    gameOverlayEnabled: false,
    handlePluginToggle: vi.fn(),
    loadDropStatus: vi.fn(async () => undefined),
    firstRunComplete: true,
    ownerName: "Test Owner",
    plugins: [],
    retryStartup: vi.fn(),
    setActionNotice: vi.fn(),
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
    systemWarnings: [],
    tab: appState.tab,
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

vi.mock("./components/pages/ChatView", () => ({
  ChatView: () => <div data-testid="chat-view" />,
  __resetCompanionSpeechMemoryForTests: vi.fn(),
}));

vi.mock("./components/character/CharacterEditor", () => ({
  CharacterEditor: ({ initialPage }: { initialPage?: string }) => (
    <div
      data-initial-page={initialPage ?? ""}
      data-testid={
        initialPage === "documents" ? "documents-view" : "character-editor"
      }
    />
  ),
}));

vi.mock("./components/pages/ViewCatalog", () => ({
  ViewCatalog: () => <div data-testid="view-manager-page" />,
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
    Reflect.deleteProperty(window, "__ELIZA_API_BASE__");
    Reflect.deleteProperty(window, "__ELIZAOS_API_BASE__");
    Reflect.deleteProperty(window, "__ELIZA_API_TOKEN__");
    Reflect.deleteProperty(window, "__ELIZAOS_API_TOKEN__");
    appState.tab = "chat";
    desktopTabsState.tabs = [];
    appState.setTab.mockClear();
    desktopTabsMock.openTab.mockClear();
    desktopTabsMock.closeTab.mockClear();
    desktopBridgeMock.invokeDesktopBridgeRequest.mockClear();
    desktopBridgeMock.subscribeDesktopBridgeEvent.mockClear();
    dynamicViewLoaderMock.render.mockClear();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
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

    const { container, getByTestId } = render(<App />);

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
    expect(
      container
        .querySelector('[data-shell-content-region="true"]')
        ?.className.includes("pb-[var(--eliza-continuous-chat-clearance"),
    ).toBe(true);
  });

  it("reports user desktop-tab clicks to the agent without a navigation echo", async () => {
    appState.tab = "apps";
    window.history.replaceState(null, "", "/apps");
    desktopTabsState.tabs = [
      {
        viewId: "remote-ledger",
        label: "Remote Ledger",
        path: "/apps/remote-ledger",
        pinned: true,
      },
    ];
    (
      window as Window & {
        __ELIZA_API_BASE__?: string;
        __ELIZAOS_API_BASE__?: string;
      }
    ).__ELIZA_API_BASE__ = "http://agent.local";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/api/commands")) {
          return new Response(JSON.stringify({ commands: [] }), {
            headers: { "Content-Type": "application/json" },
            status: 200,
          });
        }
        if (url.includes("/api/custom-actions")) {
          return new Response(JSON.stringify({ actions: [] }), {
            headers: { "Content-Type": "application/json" },
            status: 200,
          });
        }
        return new Response("{}", { status: 200 });
      }),
    );

    render(<App />);

    fireEvent.click(screen.getByRole("button", { name: "Remote Ledger" }));

    await waitFor(() => {
      expect(globalThis.fetch).toHaveBeenCalledWith(
        "http://agent.local/api/views/remote-ledger/navigate",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({
            source: "user",
            path: "/apps/remote-ledger",
          }),
        }),
      );
    });
    expect(window.location.pathname).toBe("/apps/remote-ledger");
  });

  it("renders split-view events as a live dynamic view layout", async () => {
    appState.tab = "views";
    window.history.replaceState(null, "", "/views");

    const { getAllByTestId, getByTestId } = render(<App />);

    navigateView({
      action: "split-view",
      viewId: "notes",
      views: ["notes", "calendar"],
      layout: "horizontal",
      placement: "right",
    });

    await waitFor(() => {
      expect(getByTestId("view-layout-surface")).toBeTruthy();
    });
    expect(getByTestId("view-layout-pane-notes")).toBeTruthy();
    expect(getByTestId("view-layout-pane-calendar")).toBeTruthy();
    const loaders = getAllByTestId("dynamic-view-loader");
    expect(
      loaders.map((loader) => loader.getAttribute("data-view-id")),
    ).toEqual(["notes", "calendar"]);
    expect(desktopTabsMock.openTab).toHaveBeenCalledWith(notesView, {
      pinned: false,
    });
    expect(desktopTabsMock.openTab).toHaveBeenCalledWith(calendarView, {
      pinned: false,
    });
  });

  it("renders registered documents bundles inside split-view when registry wins", async () => {
    appState.tab = "views";
    window.history.replaceState(null, "", "/views");

    const { getAllByTestId, getByTestId } = render(<App />);

    navigateView({
      action: "split-view",
      viewId: "documents",
      views: ["documents", "calendar"],
      layout: "horizontal",
    });

    await waitFor(() => {
      expect(getByTestId("view-layout-surface")).toBeTruthy();
    });
    expect(getByTestId("view-layout-pane-documents")).toBeTruthy();
    expect(
      getAllByTestId("dynamic-view-loader").map((loader) =>
        loader.getAttribute("data-view-id"),
      ),
    ).toEqual(["documents", "calendar"]);
    expect(desktopTabsMock.openTab).toHaveBeenCalledWith(documentsView, {
      pinned: false,
    });
    expect(desktopTabsMock.openTab).toHaveBeenCalledWith(calendarView, {
      pinned: false,
    });
  });

  it("keeps /views on the built-in manager page instead of the remote manager bundle", async () => {
    appState.tab = "views";
    window.history.replaceState(null, "", "/views");

    const { getByTestId, queryByTestId } = render(<App />);

    await waitFor(() => {
      expect(getByTestId("view-manager-page")).toBeTruthy();
    });
    expect(queryByTestId("dynamic-view-loader")).toBeNull();
    expect(dynamicViewLoaderMock.render).not.toHaveBeenCalled();
  });
});
