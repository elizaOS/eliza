// @vitest-environment jsdom

/**
 * Unit coverage for App-level navigate-view event wiring: a dispatched
 * navigate-view event drives the tab switch through the rendered shell. Boot
 * config + desktop tabs mocked, no runtime.
 */

import { createNavigateViewEvent } from "@elizaos/shared/events";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_BOOT_CONFIG, setBootConfig } from "./config/boot-config";
import type { ViewRegistryEntry } from "./hooks/useAvailableViews";

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

const mediaQueryState = vi.hoisted(() => ({
  matches: false,
}));

const desktopBridgeMock = vi.hoisted(() => ({
  getElectrobunRendererRpc: vi.fn(() => undefined),
  invokeDesktopBridgeRequest: vi.fn(async () => ({ id: "window-1" })),
  subscribeDesktopBridgeEvent: vi.fn(() => vi.fn()),
  // The bottom-bar shell (useBarSurfaceWindows) imports these desktop-window
  // helpers; the whole-module mock must define them. The open-window flow under
  // test calls invokeDesktopBridgeRequest directly, so plain stubs suffice here.
  openDesktopAppWindow: vi.fn(async () => ({ id: "window-1" })),
  openDesktopLauncherWindow: vi.fn(async () => ({ id: "launcher-1" })),
}));

const dynamicViewLoaderMock = vi.hoisted(() => ({
  render: vi.fn(
    ({
      bundleUrl,
      frameUrl,
      surface,
      viewId,
      viewType,
    }: {
      bundleUrl?: string;
      frameUrl?: string;
      surface?: { capabilities?: string[]; isolation?: string };
      viewId: string;
      viewType?: string;
    }) => (
      <div
        data-bundle-url={bundleUrl ?? ""}
        data-frame-url={frameUrl ?? ""}
        data-surface-capabilities={surface?.capabilities?.join(",") ?? ""}
        data-testid="dynamic-view-loader"
        data-view-id={viewId}
        data-view-type={viewType ?? ""}
      />
    ),
  ),
}));

const settingsViewMock = vi.hoisted(() => ({
  render: vi.fn(
    (_props: {
      initialSection?: string;
      navigatePayload?: unknown;
      navigateSequence?: number;
    }) => <div data-testid="settings-view" />,
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

const shopifyView = {
  id: "shopify",
  label: "Shopify",
  available: true,
  pluginName: "@elizaos/plugin-shopify",
  path: "/shopify",
  bundleUrl: "/api/views/shopify/bundle.js",
  viewType: "gui" as const,
};

const shopifyAgentSurfaceView = {
  ...shopifyView,
  surface: { capabilities: ["agent-surface" as const] },
};

const calendarView = {
  id: "calendar",
  label: "Calendar",
  available: true,
  pluginName: "@elizaos/plugin-calendar",
  path: "/calendar",
  bundleUrl: "/api/views/calendar/bundle.js",
  viewType: "gui" as const,
};

const sharedCanvasView = {
  id: "shared-canvas",
  label: "Shared Canvas",
  available: true,
  pluginName: "@elizaos/plugin-shared-canvas",
  path: "/shared-canvas",
  bundleUrl: "/api/views/shared-canvas/bundle.js",
  viewType: "gui" as const,
  // Sharing the Home/Launcher wallpaper is grant-gated (#13452): the surface
  // manifest must declare `background: "shared"` AND the `wallpaper`
  // capability. A bare `backgroundPolicy: "shared"` resolves to opaque by
  // design (no view opts into the wallpaper by accident).
  surface: {
    background: "shared" as const,
    capabilities: ["wallpaper"] as const,
  },
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

const sandboxedFrameView = {
  id: "sandboxed-frame",
  label: "Sandboxed Frame",
  available: true,
  pluginName: "@elizaos/plugin-sandboxed-frame",
  path: "/apps/sandboxed-frame",
  frameUrl: "/api/views/sandboxed-frame/frame.html",
  surface: { isolation: "sandboxed-iframe" as const },
  viewType: "gui" as const,
};

const mockAvailableViews: ViewRegistryEntry[] = [
  remoteLedgerView,
  viewsManagerView,
  shopifyView,
  calendarView,
  sharedCanvasView,
  documentsView,
];

function resetMockAvailableViews() {
  mockAvailableViews.splice(
    0,
    mockAvailableViews.length,
    remoteLedgerView,
    viewsManagerView,
    shopifyView,
    calendarView,
    sharedCanvasView,
    documentsView,
  );
}

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
  isStandalonePwa: () => false,
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
  // Home widgets gate their loaders on this (#11084); the mounted App renders
  // them, so the mock must export it alongside useAuthStatus.
  useIsAuthenticated: () => true,
}));

vi.mock("./hooks/useMediaQuery", () => ({
  useMediaQuery: () => mediaQueryState.matches,
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
  useMediaQuery: () => mediaQueryState.matches,
  useRenderGuard: vi.fn(),
}));

vi.mock("./state", async () => {
  // Pure static constants pass through from the real leaf module (side-effect
  // free by design) so the mock never drifts from product preset data.
  const { ACCENT_PRESETS } = await vi.importActual<
    typeof import("./state/ui-preferences")
  >("./state/ui-preferences");
  // Rebuilt on each access so `appState.tab`/`setTab` are read LIVE — the
  // navigation tests mutate appState between renders, and useApp / the selector
  // hooks must reflect that (mirrors the original fresh-object-per-call mock).
  const getAppValue = () => ({
    actionNotice: null,
    activeGameViewerUrl: null,
    activeOverlayApp: null,
    agentStatus: null,
    backendConnection: { state: "connected" },
    copyToClipboard: vi.fn(),
    databaseSubTab: "overview",
    dismissSystemWarning: vi.fn(),
    elizaCloudConnected: false,
    elizaCloudVoiceProxyAvailable: false,
    gameOverlayEnabled: false,
    handlePluginToggle: vi.fn(),
    loadDropStatus: vi.fn(async () => undefined),
    firstRunComplete: true,
    firstRunName: "",
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
    ACCENT_PRESETS,
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

vi.mock("./components/pages/SettingsView", () => ({
  SettingsView: (props: {
    initialSection?: string;
    navigatePayload?: unknown;
    navigateSequence?: number;
  }) => settingsViewMock.render(props),
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

vi.mock("./components/pages/LauncherSurface", () => ({
  LauncherSurface: () => <div data-testid="launcher-surface" />,
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

vi.mock("./hooks/useSecretsManagerShortcut", () => ({
  useSecretsManagerShortcut: vi.fn(),
}));

vi.mock("./hooks/useIsDeveloperMode", () => ({
  useIsDeveloperMode: () => false,
}));

import { App } from "./App";

function navigateView(detail: Record<string, unknown>) {
  window.dispatchEvent(createNavigateViewEvent(detail));
}

describe("App navigate-view event wiring", () => {
  beforeEach(() => {
    window.history.replaceState(null, "", "/?shellMode=chat-overlay");
    // The post-onboarding permission-priming modal (#12331) arms on a mounted
    // App with first-run complete and covers the surfaces under test — mark it
    // already shown.
    window.localStorage.setItem("eliza:permissions-primed", "1");
    setBootConfig(DEFAULT_BOOT_CONFIG);
    Reflect.deleteProperty(window, "__ELIZAOS_API_BASE__");
    Reflect.deleteProperty(window, "__ELIZA_API_TOKEN__");
    Reflect.deleteProperty(window, "__ELIZAOS_API_TOKEN__");
    appState.tab = "chat";
    mediaQueryState.matches = false;
    desktopTabsState.tabs = [];
    resetMockAvailableViews();
    appState.setTab.mockClear();
    desktopTabsMock.openTab.mockClear();
    desktopTabsMock.closeTab.mockClear();
    desktopBridgeMock.invokeDesktopBridgeRequest.mockClear();
    desktopBridgeMock.subscribeDesktopBridgeEvent.mockClear();
    dynamicViewLoaderMock.render.mockClear();
    settingsViewMock.render.mockClear();
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

  it("routes a settings subview navigate to the settings tab (#9945)", async () => {
    render(<App />);

    navigateView({
      viewId: "settings",
      viewPath: "/settings",
      subview: "voice",
    });

    // A settings deep-link with a subview switches to the settings tab (the
    // section itself is applied via SettingsView's initialSection prop) and
    // does NOT fall through to a desktop-tab open.
    await waitFor(() => {
      expect(appState.setTab).toHaveBeenCalledWith("settings");
    });
    expect(desktopTabsMock.openTab).not.toHaveBeenCalled();
  });

  it("passes settings navigate payloads into SettingsView for targeted permission priming", async () => {
    appState.tab = "settings";
    window.history.replaceState(null, "", "/?shellMode=full");
    const payload = { permissionRequest: { permission: "microphone" } };
    render(<App />);

    fireEvent(
      window,
      createNavigateViewEvent({
        viewId: "settings",
        viewPath: "/settings",
        subview: "permissions",
        payload,
      }),
    );

    await waitFor(() => {
      expect(settingsViewMock.render).toHaveBeenCalledWith(
        expect.objectContaining({
          initialSection: "permissions",
          navigatePayload: payload,
          navigateSequence: 1,
        }),
      );
    });
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

    const { container, getByTestId, queryByTestId } = render(<App />);

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
    expect(
      container
        .querySelector('[data-shell-content-region="true"]')
        ?.className.includes("pe-[var(--eliza-continuous-chat-side-clearance"),
    ).toBe(true);
    expect(getByTestId("app-opaque-background")).toBeTruthy();
    expect(queryByTestId("app-background-shader")).toBeNull();
  });

  it("routes frame-only sandboxed views through DynamicViewLoader with frameUrl", async () => {
    mockAvailableViews.push(sandboxedFrameView);
    appState.tab = "apps";
    window.history.replaceState(null, "", "/apps/sandboxed-frame");

    const { getByTestId } = render(<App />);

    await waitFor(() => {
      expect(dynamicViewLoaderMock.render).toHaveBeenCalledWith(
        expect.objectContaining({
          bundleUrl: undefined,
          frameUrl: "/api/views/sandboxed-frame/frame.html",
          viewId: "sandboxed-frame",
          viewType: "gui",
        }),
        undefined,
      );
    });

    const loader = getByTestId("dynamic-view-loader");
    expect(loader.getAttribute("data-bundle-url")).toBe("");
    expect(loader.getAttribute("data-frame-url")).toBe(
      "/api/views/sandboxed-frame/frame.html",
    );
  });

  it("renders no global corner back button on app routes (removed in favor of per-page back affordances + browser/OS back)", async () => {
    appState.tab = "apps";
    window.history.replaceState(null, "", "/chat");
    window.history.pushState(null, "", "/apps/remote-ledger");

    const { queryByTestId } = render(<App />);

    // The route mounts (its remote view loader is requested)…
    await waitFor(() => {
      expect(dynamicViewLoaderMock.render).toHaveBeenCalled();
    });

    // …but the floating top-left corner back button that used to overlap page
    // content (Apps gallery section headings, the Character/Knowledge
    // breadcrumb) is gone. Pages that need a back affordance render their own
    // in-context control; everyone can also use browser/OS back.
    expect(queryByTestId("shell-back-button")).toBeNull();
    expect(screen.queryByRole("button", { name: "Go back" })).toBeNull();
  });

  it("lets a view explicitly share the Home/Launcher background", async () => {
    appState.tab = "views";
    window.history.replaceState(null, "", "/shared-canvas");

    const { getByTestId, queryByTestId } = render(<App />);

    await waitFor(() => {
      expect(dynamicViewLoaderMock.render).toHaveBeenCalledWith(
        expect.objectContaining({
          bundleUrl: "/api/views/shared-canvas/bundle.js",
          viewId: "shared-canvas",
        }),
        undefined,
      );
    });

    expect(getByTestId("app-background-shader")).toBeTruthy();
    expect(queryByTestId("app-opaque-background")).toBeNull();
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
    setBootConfig({ ...DEFAULT_BOOT_CONFIG, apiBase: "http://agent.local" });
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

    const splitViews = [shopifyAgentSurfaceView, calendarView];
    mockAvailableViews.splice(0, mockAvailableViews.length, ...splitViews);

    navigateView({
      action: "split-view",
      viewId: "shopify",
      views: ["shopify", "calendar"],
      layout: "horizontal",
      placement: "right",
    });

    await waitFor(() => {
      expect(getByTestId("view-layout-surface")).toBeTruthy();
    });
    expect(getByTestId("view-layout-pane-shopify")).toBeTruthy();
    expect(getByTestId("view-layout-pane-calendar")).toBeTruthy();
    const loaders = getAllByTestId("dynamic-view-loader");
    expect(
      loaders.map((loader) => loader.getAttribute("data-view-id")),
    ).toEqual(["shopify", "calendar"]);
    expect(loaders[0]?.getAttribute("data-surface-capabilities")).toBe(
      "agent-surface",
    );
    expect(loaders[1]?.getAttribute("data-surface-capabilities")).toBe("");
    expect(desktopTabsMock.openTab).toHaveBeenCalledWith(
      shopifyAgentSurfaceView,
      {
        pinned: false,
      },
    );
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

  it("keeps /views on the built-in Launcher instead of the remote manager bundle", async () => {
    appState.tab = "views";
    window.history.replaceState(null, "", "/views");

    const { getByTestId, queryByTestId } = render(<App />);

    await waitFor(() => {
      expect(getByTestId("launcher-surface")).toBeTruthy();
    });
    expect(queryByTestId("dynamic-view-loader")).toBeNull();
    expect(dynamicViewLoaderMock.render).not.toHaveBeenCalled();
    expect(getByTestId("app-background-shader")).toBeTruthy();
    expect(queryByTestId("app-opaque-background")).toBeNull();
  });
});
