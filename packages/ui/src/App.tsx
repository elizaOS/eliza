/**
 * Root App component — routing shell.
 */

import { Keyboard } from "@capacitor/keyboard";
import "./components/chat/chat-source-registration";
import {
  type ComponentType,
  type LazyExoticComponent,
  lazy,
  type ReactNode,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import { createNavigateViewHandler } from "./app-navigate-view";
import {
  invokeDesktopBridgeRequest,
  subscribeDesktopBridgeEvent,
} from "./bridge/electrobun-rpc";
import { isElectrobunRuntime } from "./bridge/electrobun-runtime";
import { getOverlayAppLazyComponent } from "./components/apps/AppWindowRenderer";
import { GameViewOverlay } from "./components/apps/GameViewOverlay";
import { getOverlayApp } from "./components/apps/overlay-app-registry";
import { LoginView } from "./components/auth/LoginView";
import { SaveCommandModal } from "./components/chat/SaveCommandModal";
import { CustomActionEditor } from "./components/custom-actions/CustomActionEditor";
import { CustomActionsPanel } from "./components/custom-actions/CustomActionsPanel";
import { AppsPageView } from "./components/pages/AppsPageView";
import { ChatView } from "./components/pages/ChatView";
import type { PageScope } from "./components/pages/page-scoped-conversations";
import { SecretsManagerModalRoot } from "./components/settings/SecretsManagerSection";
import { AssistantOverlay } from "./components/shell/AssistantOverlay";
import { BugReportModal } from "./components/shell/BugReportModal";
import { ChatSurface } from "./components/shell/ChatSurface";
import { ConnectionFailedBanner } from "./components/shell/ConnectionFailedBanner";
import { ConnectionLostOverlay } from "./components/shell/ConnectionLostOverlay";
import { Header } from "./components/shell/Header";
import { HomePill } from "./components/shell/HomePill";
import { KioskViewCanvas } from "./components/shell/KioskViewCanvas";
import {
  ShellControllerProvider,
  useShellControllerContext,
} from "./components/shell/ShellControllerContext";
import { ShellOverlays } from "./components/shell/ShellOverlays";
import { StartupFailureView } from "./components/shell/StartupFailureView";
import { StartupScreen } from "./components/shell/StartupScreen";
import { SystemWarningBanner } from "./components/shell/SystemWarningBanner";
import { useKioskViewSurfaces } from "./components/shell/useKioskViewSurfaces";
import { ErrorBoundary } from "./components/ui/error-boundary";
import { AppWorkspaceChrome } from "./components/workspace/AppWorkspaceChrome";
import { useBootConfig } from "./config/boot-config-react";
import type { CompanionShellComponentProps } from "./config/boot-config-store";
import {
  FOCUS_CONNECTOR_EVENT,
  type FocusConnectorEventDetail,
} from "./events";
import { FirstRunScreen } from "./first-run/FirstRunScreen";
import { BugReportProvider, useBugReportState, useContextMenu } from "./hooks";
import { useAuthStatus } from "./hooks/useAuthStatus";
import { useSecretsManagerShortcut } from "./hooks/useSecretsManagerShortcut";
import { Z_OVERLAY } from "./lib/floating-layers";
import {
  APPS_ENABLED,
  getAppSlugFromPath,
  getWindowNavigationPath,
  isAndroidPhoneSurfaceEnabled,
  isAppsToolTab,
  isRouteRootPath,
  shouldUseHashNavigation,
} from "./navigation";
import { isIOS, isNative } from "./platform/init";
import { type ActionNotice, useApp } from "./state";
import type { FlaminaGuideTopic } from "./state/types";

const MOBILE_NAV_PADDING_CLASS =
  "pb-[calc(var(--eliza-mobile-nav-offset,0px)+var(--safe-area-bottom,0px))]";
type ExtractComponent<TValue> =
  TValue extends ComponentType<infer Props> ? ComponentType<Props> : never;

function lazyNamedView<
  TModule extends Record<string, unknown>,
  TKey extends keyof TModule,
>(
  load: () => Promise<TModule>,
  exportName: TKey,
): LazyExoticComponent<ExtractComponent<TModule[TKey]>> {
  return lazy(async () => {
    const module = await load();
    const component = module[exportName];
    if (typeof component !== "function") {
      throw new Error(`Missing component export: ${String(exportName)}`);
    }
    return {
      default: component as ExtractComponent<TModule[TKey]>,
    };
  });
}

import { fetchWithCsrf } from "./api/csrf-client";
// Import the page registry from its standalone module, NOT the
// `app-shell-components` barrel — that barrel statically re-exports every page
// view, so importing through it folds all of them back into the main chunk.
import {
  type AppShellPageRegistration,
  listAppShellPages,
} from "./app-shell-registry";
// CharacterEditor, DesktopTabBar, and FineTuningView stay static: they are
// already pulled eagerly elsewhere in the app graph (main.tsx / plugin-loader /
// boot-config), so a lazy() boundary here would only fold back into main. The
// remaining page views are lazy-split below.
import { CharacterEditor } from "./components/character/CharacterEditor";
import { DesktopTabBar } from "./components/desktop/DesktopTabBar";
import { FineTuningView } from "./components/training/injected";
import { DynamicViewLoader } from "./components/views/DynamicViewLoader";
import {
  useAvailableViews,
  type ViewRegistryEntry,
} from "./hooks/useAvailableViews";
import { useDesktopTabs } from "./hooks/useDesktopTabs";
import { useIsDeveloperMode } from "./state/useDeveloperMode";

const ViewManagerPage = lazyNamedView(
  () => import("./components/pages/ViewManagerPage"),
  "ViewManagerPage",
);
const AutomationsFeed = lazyNamedView(
  () => import("./components/pages/AutomationsFeed"),
  "AutomationsFeed",
);
const BrowserWorkspaceView = lazyNamedView(
  () => import("./components/pages/BrowserWorkspaceView"),
  "BrowserWorkspaceView",
);
const ContactsPageView = lazyNamedView(
  () => import("./components/pages/ElizaOsAppsView"),
  "ContactsPageView",
);
const DesktopWorkspaceSection = lazyNamedView(
  () => import("./components/settings/DesktopWorkspaceSection"),
  "DesktopWorkspaceSection",
);
const MessagesPageView = lazyNamedView(
  () => import("./components/pages/ElizaOsAppsView"),
  "MessagesPageView",
);
const PhonePageView = lazyNamedView(
  () => import("./components/pages/ElizaOsAppsView"),
  "PhonePageView",
);
const SettingsView = lazyNamedView(
  () => import("./components/pages/SettingsView"),
  "SettingsView",
);
const StreamView = lazyNamedView(
  () => import("./components/pages/StreamView"),
  "StreamView",
);
// Route-level page views — lazy-split out of the main chunk. Each renders
// inside the LazyViewBoundary Suspense below, and none is imported statically
// elsewhere in the app graph, so the dynamic boundary actually defers load.
const DatabasePageView = lazyNamedView(
  () => import("./components/pages/DatabasePageView"),
  "DatabasePageView",
);
const LogsView = lazyNamedView(
  () => import("./components/pages/LogsView"),
  "LogsView",
);
const MemoryViewerView = lazyNamedView(
  () => import("./components/pages/MemoryViewerView"),
  "MemoryViewerView",
);
const PluginsPageView = lazyNamedView(
  () => import("./components/pages/PluginsPageView"),
  "PluginsPageView",
);
const RelationshipsView = lazyNamedView(
  () => import("./components/pages/RelationshipsView"),
  "RelationshipsView",
);
const RuntimeView = lazyNamedView(
  () => import("./components/pages/RuntimeView"),
  "RuntimeView",
);
const SkillsView = lazyNamedView(
  () => import("./components/pages/SkillsView"),
  "SkillsView",
);
const TasksPageView = lazyNamedView(
  () => import("./components/pages/TasksPageView"),
  "TasksPageView",
);
const TrajectoriesView = lazyNamedView(
  () => import("./components/pages/TrajectoriesView"),
  "TrajectoriesView",
);

// Once the shell is interactive, warm the lazy route chunks during idle time so
// the first navigation to each view is instant instead of waiting on a chunk
// fetch. Paths must match the lazy() loaders above exactly so the bundler
// reuses the same chunks. Failures are ignored — this is best-effort warming.
function prefetchRouteViewChunks(): void {
  const loaders: Array<() => Promise<unknown>> = [
    () => import("./components/pages/DatabasePageView"),
    () => import("./components/pages/LogsView"),
    () => import("./components/pages/MemoryViewerView"),
    () => import("./components/pages/PluginsPageView"),
    () => import("./components/pages/RelationshipsView"),
    () => import("./components/pages/RuntimeView"),
    () => import("./components/pages/SkillsView"),
    () => import("./components/pages/TasksPageView"),
    () => import("./components/pages/TrajectoriesView"),
    () => import("./components/pages/SettingsView"),
    () => import("./components/pages/StreamView"),
    () => import("./components/pages/AutomationsFeed"),
    () => import("./components/pages/ViewManagerPage"),
    () => import("./components/pages/BrowserWorkspaceView"),
  ];
  for (const load of loaders) void load().catch(() => {});
}

function LazyViewBoundary({ children }: { children: ReactNode }) {
  return (
    <Suspense
      fallback={
        <div className="flex flex-1 min-h-0 min-w-0 items-center justify-center text-sm text-muted">
          Loading…
        </div>
      }
    >
      {children}
    </Suspense>
  );
}

/** Check if we're in pop-out mode (StreamView only, no chrome). */
function useIsPopout(): boolean {
  const [popout] = useState(() => {
    if (typeof window === "undefined") return false;
    const params = new URLSearchParams(
      window.location.search || window.location.hash.split("?")[1] || "",
    );
    return params.has("popout") && params.get("popout") !== "false";
  });
  return popout;
}

/**
 * Shell mode for the Linux OS overlay windows. The OS launches the same app
 * bundle with `--shell-mode=chat-overlay` (a floating, transparent assistant
 * pill window), `--shell-mode=launcher` (full home view), or
 * `--shell-mode=kiosk` (the locked appliance shell: a single fullscreen
 * view-manager surface with an always-visible bottom chat pill). The mode is
 * read from the URL (`?shellMode=` / `?shell-mode=`) or the
 * `ELIZAOS_SHELL_MODE` global the native shell may inject. Unset = full app.
 */
type ShellMode = "chat-overlay" | "launcher" | "kiosk" | "full";

function readShellMode(): ShellMode {
  if (typeof window === "undefined") return "full";
  const params = new URLSearchParams(
    window.location.search || window.location.hash.split("?")[1] || "",
  );
  const raw =
    params.get("shellMode") ??
    params.get("shell-mode") ??
    (window as unknown as { ELIZAOS_SHELL_MODE?: string }).ELIZAOS_SHELL_MODE ??
    "";
  if (raw === "chat-overlay") return "chat-overlay";
  if (raw === "launcher") return "launcher";
  if (raw === "kiosk") return "kiosk";
  return "full";
}

function useShellMode(): ShellMode {
  const [mode] = useState(readShellMode);
  return mode;
}

/**
 * Floating, transparent assistant overlay surface for the OS chat-overlay
 * window. Renders ONLY the waveform + pill + chat/voice overlay — no app
 * chrome — over a transparent background.
 */
function ChatOverlayShell() {
  return (
    <div
      data-testid="chat-overlay-shell"
      className="pointer-events-none fixed inset-0 flex items-end justify-center bg-transparent"
    >
      <ShellFoundationMount />
    </div>
  );
}

/**
 * Locked appliance shell for the Linux OS kiosk window. The Electrobun bundle
 * runs as the entire GUI: a single fullscreen, frameless, non-closable
 * toplevel. This surface IS the view manager — agent-spawned dynamic views
 * mount in-canvas (see `KioskViewCanvas`) and an always-visible bottom chat
 * pill talks to the local OS agent. No header / tabs / desktop chrome.
 */
function KioskShell() {
  const surfaces = useKioskViewSurfaces();
  return (
    <div
      data-testid="kiosk-shell"
      className="fixed inset-0 flex flex-col overflow-hidden bg-bg"
    >
      <div className="min-h-0 flex-1">
        <KioskViewCanvas surfaces={surfaces} />
      </div>
      {/* Always-visible bottom chat pill + assistant overlay. */}
      <ShellFoundationMount />
    </div>
  );
}

function TabScrollView({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <AppWorkspaceChrome
      testId="tab-scroll-view"
      chatDisabled
      main={
        <div
          data-shell-scroll-region="true"
          className={`flex-1 min-h-0 min-w-0 w-full overflow-y-auto ${className}`}
        >
          {children}
        </div>
      }
    />
  );
}

function TabContentView({
  children,
}: {
  children: ReactNode;
  chatScope?: PageScope;
  chatDisabled?: boolean;
}) {
  return (
    <AppWorkspaceChrome
      testId="tab-content-view"
      chatDisabled
      main={
        <div className="flex flex-col flex-1 min-h-0 min-w-0 w-full overflow-hidden">
          {children}
        </div>
      }
    />
  );
}

interface ResolvedDynamicPage {
  id: string;
  pluginId: string;
  developerOnly: boolean;
  registration?: AppShellPageRegistration;
  componentExport?: string;
}

/**
 * Resolve a tab id against the dynamic registry: first the in-process
 * `registerAppShellPage` registrations, then any loaded plugin's
 * `app.navTabs` declaration. Returns `null` when no plugin claims the tab.
 */
function useResolvedDynamicPage(tab: string): ResolvedDynamicPage | null {
  const { plugins } = useApp();
  return useMemo(() => {
    const registrations = listAppShellPages();
    const registered = registrations.find((entry) => entry.id === tab);
    if (registered) {
      return {
        id: registered.id,
        pluginId: registered.pluginId,
        developerOnly: registered.developerOnly === true,
        registration: registered,
      };
    }
    for (const plugin of plugins) {
      const navTabs = plugin.app?.navTabs;
      if (!navTabs?.length) continue;
      for (const navTab of navTabs) {
        if (navTab.id !== tab) continue;
        const reg = registrations.find(
          (entry) => entry.id === navTab.id && entry.pluginId === plugin.id,
        );
        return {
          id: navTab.id,
          pluginId: plugin.id,
          developerOnly:
            plugin.app?.developerOnly === true || navTab.developerOnly === true,
          registration: reg,
          componentExport: navTab.componentExport,
        };
      }
    }
    return null;
  }, [plugins, tab]);
}

/**
 * Render a dynamically-resolved plugin page. Honors:
 *   1. An in-process registration (`registerAppShellPage`) — preferred.
 *   2. A `componentExport` import-spec like `"@elizaos/plugin-wallet-ui#InventoryView"`,
 *      loaded with dynamic `import()` and rendered via Suspense.
 *
 * Plugins that declare a `componentExport` without a matching
 * registration get a small loading placeholder until the import resolves.
 * (Until a real dynamic-import boundary is plumbed for these strings,
 * this is a documented placeholder; the plugin can also self-register.)
 */
function DynamicPluginPage({ resolved }: { resolved: ResolvedDynamicPage }) {
  if (resolved.registration) {
    const Component = resolved.registration.Component;
    return <Component />;
  }
  // No bundled registration — display a lightweight loading placeholder
  // so the shell stays responsive. Plugins that ship bundled components
  // should call `registerAppShellPage` at boot to avoid this path.
  return (
    <div className="flex flex-1 min-h-0 min-w-0 items-center justify-center text-sm text-muted">
      Loading {resolved.id}…
    </div>
  );
}

function WalletInventoryPage() {
  const registration = listAppShellPages().find(
    (entry) => entry.id === "wallet.inventory" || entry.path === "/inventory",
  );
  if (!registration) {
    return (
      <div className="flex flex-1 min-h-0 min-w-0 items-center justify-center text-sm text-muted">
        Wallet is not registered in this build.
      </div>
    );
  }
  const Component = registration.Component;
  return <Component />;
}

function visibleDynamicPage(
  page: ResolvedDynamicPage | null,
  developerModeEnabled: boolean,
): page is ResolvedDynamicPage {
  return Boolean(page && (developerModeEnabled || !page.developerOnly));
}

function trimmedNavigationPath(navigationPath: string): string {
  return navigationPath.length > 1 && navigationPath.endsWith("/")
    ? navigationPath.slice(0, -1)
    : navigationPath;
}

function remoteViewAvailable(view: ViewRegistryEntry): boolean {
  return Boolean(view.bundleUrl && view.available !== false);
}

function remoteViewMatchesTab(
  view: ViewRegistryEntry,
  tab: string,
  appSlug: string | null,
): boolean {
  return Boolean(
    view.id === tab ||
      view.path === `/${tab}` ||
      view.path === `/apps/${tab}` ||
      (appSlug !== null &&
        (view.id === appSlug ||
          view.path === `/apps/${appSlug}` ||
          view.path === `/${appSlug}`)),
  );
}

function findRemoteViewForRoute(
  views: ViewRegistryEntry[],
  navigationPath: string,
  tab: string,
  appSlug: string | null,
): ViewRegistryEntry | undefined {
  const normalizedPath = trimmedNavigationPath(navigationPath);
  return (
    views.find(
      (view) => remoteViewAvailable(view) && view.path === normalizedPath,
    ) ??
    views.find(
      (view) =>
        remoteViewAvailable(view) && remoteViewMatchesTab(view, tab, appSlug),
    )
  );
}

function renderRemoteView(view: ViewRegistryEntry): ReactNode {
  if (!view.bundleUrl) return null;
  return (
    <TabContentView>
      <DynamicViewLoader
        bundleUrl={view.bundleUrl}
        componentExport={view.componentExport}
        viewId={view.id}
        viewType={view.viewType}
      />
    </TabContentView>
  );
}

/**
 * Fallback shown when a view/tab is unavailable. Chat is the floating overlay
 * (GlobalChatOverlay on the chat tab) + the always-present pill — views never
 * embed an inline ChatView — so an unavailable view falls back to the app/view
 * launcher, not a chat surface.
 */
function ViewUnavailableFallback(): ReactNode {
  return (
    <TabContentView chatDisabled>
      <ViewManagerPage />
    </TabContentView>
  );
}

function renderPhoneSurface(
  enabled: boolean,
  Component: ComponentType,
): ReactNode {
  return enabled ? (
    <TabContentView chatScope="page-phone">
      <Component />
    </TabContentView>
  ) : (
    <ViewUnavailableFallback />
  );
}

function renderAppsSurface(navigationPath: string): ReactNode {
  if (!APPS_ENABLED) return <ViewUnavailableFallback />;
  return (
    <TabContentView chatScope="page-apps">
      {getAppSlugFromPath(navigationPath) ? (
        <AppsPageView />
      ) : (
        <ViewManagerPage />
      )}
    </TabContentView>
  );
}

function renderStaticViewRouterTab({
  tab,
  androidPhoneSurfaceEnabled,
  navigationPath,
  onCharacterHeaderActionsChange,
  LifeOpsPageView,
}: {
  tab: string;
  androidPhoneSurfaceEnabled: boolean;
  navigationPath: string;
  onCharacterHeaderActionsChange?: (actions: ReactNode | null) => void;
  LifeOpsPageView: ComponentType | null | undefined;
}): ReactNode {
  const directViews: Record<string, ReactNode> = {
    onboarding: <FirstRunScreen />,
    chat: <ViewUnavailableFallback />,
    browser: <BrowserWorkspaceView />,
    companion: <ViewUnavailableFallback />,
    stream: <StreamView />,
    tasks: (
      <TabContentView>
        <TasksPageView />
      </TabContentView>
    ),
    automations: <AutomationsFeed />,
    triggers: <AutomationsFeed />,
    voice: (
      <TabContentView>
        <SettingsView key="settings-identity" initialSection="identity" />
      </TabContentView>
    ),
    settings: (
      <TabContentView chatDisabled>
        <SettingsView key="settings-root" />
      </TabContentView>
    ),
    plugins: (
      <TabContentView>
        <PluginsPageView />
      </TabContentView>
    ),
    skills: (
      <TabContentView>
        <SkillsView />
      </TabContentView>
    ),
    trajectories: (
      <TabContentView>
        <TrajectoriesView />
      </TabContentView>
    ),
    relationships: (
      <TabContentView>
        <RelationshipsView />
      </TabContentView>
    ),
    memories: (
      <TabContentView>
        <MemoryViewerView />
      </TabContentView>
    ),
    runtime: (
      <TabContentView>
        <RuntimeView />
      </TabContentView>
    ),
    database: (
      <TabContentView>
        <DatabasePageView />
      </TabContentView>
    ),
    logs: (
      <TabContentView>
        <LogsView />
      </TabContentView>
    ),
    desktop: (
      <TabContentView>
        <DesktopWorkspaceSection />
      </TabContentView>
    ),
  };
  if (tab === "lifeops") {
    return LifeOpsPageView ? <LifeOpsPageView /> : <ViewUnavailableFallback />;
  }
  if (tab === "phone") {
    return renderPhoneSurface(androidPhoneSurfaceEnabled, PhonePageView);
  }
  if (tab === "messages") {
    return renderPhoneSurface(androidPhoneSurfaceEnabled, MessagesPageView);
  }
  if (tab === "contacts") {
    return renderPhoneSurface(androidPhoneSurfaceEnabled, ContactsPageView);
  }
  if (tab === "views" || tab === "apps") {
    return renderAppsSurface(navigationPath);
  }
  if (
    tab === "character" ||
    tab === "character-select" ||
    tab === "documents"
  ) {
    return (
      <TabContentView chatScope="page-character">
        <CharacterEditor
          onHeaderActionsChange={onCharacterHeaderActionsChange}
        />
      </TabContentView>
    );
  }
  if (tab === "inventory") {
    return (
      <TabScrollView>
        <WalletInventoryPage />
      </TabScrollView>
    );
  }
  if (tab === "fine-tuning" || tab === "advanced") {
    return (
      <TabContentView>
        <FineTuningView />
      </TabContentView>
    );
  }
  return directViews[tab] ?? <ViewUnavailableFallback />;
}

function renderViewRouterContent({
  tab,
  dynamicPage,
  dynamicAppPage,
  developerModeEnabled,
  navigationPath,
  availableViews,
  appSlug,
  androidPhoneSurfaceEnabled,
  LifeOpsPageView,
  onCharacterHeaderActionsChange,
}: {
  tab: string;
  dynamicPage: ResolvedDynamicPage | null;
  dynamicAppPage: ResolvedDynamicPage | null;
  developerModeEnabled: boolean;
  navigationPath: string;
  availableViews: ViewRegistryEntry[];
  appSlug: string | null;
  androidPhoneSurfaceEnabled: boolean;
  LifeOpsPageView: ComponentType | null | undefined;
  onCharacterHeaderActionsChange?: (actions: ReactNode | null) => void;
}): ReactNode {
  if (visibleDynamicPage(dynamicPage, developerModeEnabled)) {
    return (
      <TabContentView>
        <DynamicPluginPage resolved={dynamicPage} />
      </TabContentView>
    );
  }
  if (visibleDynamicPage(dynamicAppPage, developerModeEnabled)) {
    return (
      <TabContentView chatScope="page-apps">
        <DynamicPluginPage resolved={dynamicAppPage} />
      </TabContentView>
    );
  }
  const remoteView = findRemoteViewForRoute(
    availableViews,
    navigationPath,
    tab,
    appSlug,
  );
  if (remoteView?.bundleUrl) return renderRemoteView(remoteView);
  return renderStaticViewRouterTab({
    tab,
    androidPhoneSurfaceEnabled,
    navigationPath,
    onCharacterHeaderActionsChange,
    LifeOpsPageView,
  });
}

function ViewRouter({
  onCharacterHeaderActionsChange,
}: {
  onCharacterHeaderActionsChange?: (actions: ReactNode | null) => void;
}) {
  const { tab } = useApp();
  const { lifeOpsPageView: LifeOpsPageView } = useBootConfig();
  const androidPhoneSurfaceEnabled = isAndroidPhoneSurfaceEnabled();
  const dynamicPage = useResolvedDynamicPage(tab);
  const [navigationPath, setNavigationPath] = useState(() =>
    typeof window === "undefined" ? "/" : getWindowNavigationPath(),
  );
  const appSlug =
    tab === "apps" || tab === "views"
      ? getAppSlugFromPath(navigationPath)
      : null;
  const dynamicAppPage = useResolvedDynamicPage(appSlug ?? "");
  const developerModeEnabled = useIsDeveloperMode();

  useEffect(() => {
    if (typeof window === "undefined") return;
    const navEvt = shouldUseHashNavigation() ? "hashchange" : "popstate";
    const handleNavigationChange = () => {
      setNavigationPath(getWindowNavigationPath());
    };
    window.addEventListener(navEvt, handleNavigationChange);
    return () => window.removeEventListener(navEvt, handleNavigationChange);
  }, []);

  // Available views from /api/views — used to route to DynamicViewLoader
  // when a tab ID matches a view entry that ships a remote bundle URL.
  const { views: availableViews } = useAvailableViews();
  const view = renderViewRouterContent({
    tab,
    dynamicPage,
    dynamicAppPage,
    developerModeEnabled,
    navigationPath,
    availableViews,
    appSlug,
    androidPhoneSurfaceEnabled,
    LifeOpsPageView,
    onCharacterHeaderActionsChange,
  });

  return (
    <ErrorBoundary>
      <LazyViewBoundary>{view}</LazyViewBoundary>
    </ErrorBoundary>
  );
}

function greetingForTimeOfDay(): string {
  const hour = new Date().getHours();
  if (hour < 12) return "Good morning! What would you like to do?";
  if (hour < 18) return "Good afternoon! What would you like to do?";
  return "Good evening! What would you like to do?";
}

const APP_SHELL_CLASS =
  "flex flex-col flex-1 min-h-0 w-full font-body text-txt bg-bg";

type ShellContentProps = {
  CompanionShell: ComponentType<CompanionShellComponentProps> | undefined;
  actionNotice: ActionNotice | null;
  characterHeaderActions: ReactNode | null;
  customActionsPanelOpen: boolean;
  desktopTabBar: ReactNode;
  handleDeferredTaskOpen: (task: FlaminaGuideTopic) => void;
  isAppsToolPage: boolean;
  isCharacterPage: boolean;
  isChat: boolean;
  isCompanionTab: boolean;
  isDesktopWorkspacePage: boolean;
  isHeartbeats: boolean;
  isSettingsPage: boolean;
  isWallets: boolean;
  setCharacterHeaderActions: (actions: ReactNode | null) => void;
  setCustomActionsEditorOpen: (open: boolean) => void;
  setCustomActionsPanelOpen: (open: boolean) => void;
  setEditingAction: (action: import("./api").CustomActionDef | null) => void;
  settingsInitialSection: string | null;
  tab: string;
  uiShellMode: string;
};

function CompanionShellContent(props: ShellContentProps): ReactNode {
  if (
    props.uiShellMode === "companion" &&
    props.isCompanionTab &&
    props.CompanionShell
  ) {
    const CompanionShell = props.CompanionShell;
    return <CompanionShell tab="companion" actionNotice={props.actionNotice} />;
  }
  if (!props.isCompanionTab) return null;
  return <div key="companion-shell" className={APP_SHELL_CLASS} />;
}

function StreamShellContent(): ReactNode {
  return (
    <div key="stream-shell" className={APP_SHELL_CLASS}>
      <Header />
      <main
        className={`flex-1 min-h-0 overflow-hidden ${MOBILE_NAV_PADDING_CLASS}`}
      >
        <LazyViewBoundary>
          <StreamView />
        </LazyViewBoundary>
      </main>
    </div>
  );
}

function ChatRouteShellContent(props: ShellContentProps): ReactNode {
  return (
    <div key="chat-route-shell" className={APP_SHELL_CLASS}>
      <div className="flex flex-1 min-h-0 relative">
        <CustomActionsPanel
          open={props.customActionsPanelOpen}
          onClose={() => props.setCustomActionsPanelOpen(false)}
          onOpenEditor={(action) => {
            props.setEditingAction(action ?? null);
            props.setCustomActionsEditorOpen(true);
          }}
        />
      </div>
    </div>
  );
}

function HeartbeatsShellContent(): ReactNode {
  return (
    <div key="heartbeats-shell" className={APP_SHELL_CLASS}>
      <Header />
      <div
        className={`flex flex-1 min-h-0 min-w-0 overflow-hidden ${MOBILE_NAV_PADDING_CLASS}`}
      >
        <LazyViewBoundary>
          <AutomationsFeed key="automations-view-desktop" />
        </LazyViewBoundary>
      </div>
    </div>
  );
}

function SettingsShellContent(props: ShellContentProps): ReactNode {
  return (
    <div key={`settings-shell-${props.tab}`} className={APP_SHELL_CLASS}>
      <Header />
      <AppWorkspaceChrome
        testId="settings-workspace"
        chatDisabled
        main={
          <div className="flex flex-col flex-1 min-h-0 min-w-0 overflow-hidden">
            <LazyViewBoundary>
              <SettingsView
                key={
                  props.tab === "voice" ? "settings-identity" : "settings-root"
                }
                initialSection={
                  props.tab === "voice"
                    ? "identity"
                    : (props.settingsInitialSection ?? undefined)
                }
              />
            </LazyViewBoundary>
          </div>
        }
      />
    </div>
  );
}

function WalletsShellContent(): ReactNode {
  return (
    <div key="wallets-shell" className={APP_SHELL_CLASS}>
      <Header />
      <AppWorkspaceChrome
        testId="wallets-workspace"
        chatDisabled
        main={
          <div className="flex flex-col flex-1 min-h-0 min-w-0 overflow-hidden">
            <LazyViewBoundary>
              <WalletInventoryPage />
            </LazyViewBoundary>
          </div>
        }
      />
    </div>
  );
}

function RoutedShellContent(props: ShellContentProps): ReactNode {
  const headerActions = props.isCharacterPage
    ? props.characterHeaderActions
    : null;
  return (
    <div key={`tab-shell-${props.tab}`} className={APP_SHELL_CLASS}>
      {!isFullBleedRoutedTab(props.tab) ? (
        <Header pageRightExtras={headerActions} />
      ) : null}
      {props.desktopTabBar}
      <main className={routedShellMainClass(props.tab)}>
        <ViewRouter
          onCharacterHeaderActionsChange={props.setCharacterHeaderActions}
        />
      </main>
    </div>
  );
}

function isFullBleedRoutedTab(tab: string): boolean {
  return tab === "orchestrator" || tab === "odysseus";
}

function routedShellMainClass(tab: string): string {
  const pagePadding =
    tab === "browser" ||
    tab === "apps" ||
    tab === "views" ||
    isFullBleedRoutedTab(tab)
      ? ""
      : "px-3 xl:px-5 py-4 xl:py-6";
  const mobilePadding =
    tab === "browser" || isFullBleedRoutedTab(tab)
      ? ""
      : MOBILE_NAV_PADDING_CLASS;
  return `flex flex-1 min-h-0 min-w-0 overflow-hidden ${pagePadding} ${mobilePadding}`;
}

function CharacterShellContent(props: ShellContentProps): ReactNode {
  return (
    <div key={`character-shell-${props.tab}`} className={APP_SHELL_CLASS}>
      <Header pageRightExtras={props.characterHeaderActions} />
      {props.desktopTabBar}
      <div
        className={`flex flex-1 min-h-0 min-w-0 overflow-hidden ${MOBILE_NAV_PADDING_CLASS}`}
      >
        <ViewRouter
          onCharacterHeaderActionsChange={props.setCharacterHeaderActions}
        />
      </div>
    </div>
  );
}

function AppsToolShellContent(props: ShellContentProps): ReactNode {
  return (
    <div key={`apps-tool-shell-${props.tab}`} className={APP_SHELL_CLASS}>
      <Header />
      {props.desktopTabBar}
      <div
        className={`flex flex-1 min-h-0 min-w-0 overflow-hidden ${MOBILE_NAV_PADDING_CLASS}`}
      >
        <ViewRouter />
      </div>
    </div>
  );
}

function DesktopWorkspaceShellContent(props: ShellContentProps): ReactNode {
  return (
    <div key={`desktop-shell-${props.tab}`} className={APP_SHELL_CLASS}>
      <Header />
      {props.desktopTabBar}
      <div
        className={`flex flex-1 min-h-0 min-w-0 ${MOBILE_NAV_PADDING_CLASS}`}
      >
        <LazyViewBoundary>
          <DesktopWorkspaceSection />
        </LazyViewBoundary>
      </div>
    </div>
  );
}

function ShellContent(props: ShellContentProps): ReactNode {
  if (props.isChat) return <ChatRouteShellContent {...props} />;
  const companionContent = CompanionShellContent(props);
  if (companionContent) return companionContent;
  if (props.tab === "stream") return <StreamShellContent />;
  if (props.isHeartbeats) return <HeartbeatsShellContent />;
  if (props.isSettingsPage) return <SettingsShellContent {...props} />;
  if (props.isWallets) return <WalletsShellContent />;
  if (props.isCharacterPage) return <CharacterShellContent {...props} />;
  if (props.isAppsToolPage) return <AppsToolShellContent {...props} />;
  if (props.isDesktopWorkspacePage) {
    return <DesktopWorkspaceShellContent {...props} />;
  }
  return <RoutedShellContent {...props} />;
}

function ShellFoundationMount() {
  const controller = useShellControllerContext();
  if (!controller) return null;

  return (
    <>
      <HomePill
        phase={controller.phase}
        onOpen={controller.open}
        onClose={controller.close}
      />
      <AssistantOverlay phase={controller.phase} onClose={controller.close}>
        <ChatSurface
          messages={controller.messages}
          onSend={controller.send}
          canSend={controller.canSend}
          greeting={greetingForTimeOfDay()}
          recording={controller.recording}
          onToggleRecording={controller.toggleRecording}
        />
      </AssistantOverlay>
    </>
  );
}

/**
 * Web/mobile embedded floating pill. The persistent collapsible chat/voice pill
 * floats bottom-center on top of whichever view is active, so no view embeds its
 * own chat surface. On desktop (Electrobun) the pill instead lives in its own
 * always-on-top OS window (`pill-window.ts` → `chat-overlay` shell), so it is
 * never embedded here; on OS kiosk it is mounted in-canvas by `KioskShell`. The
 * wrapper is pointer-events-none so only the pill itself is interactive, and it
 * clears the mobile bottom nav.
 */
function EmbeddedShellPill(): ReactNode {
  if (isElectrobunRuntime()) return null;
  return (
    <div
      data-testid="embedded-shell-pill"
      className={`pointer-events-none fixed inset-0 flex items-end justify-center ${MOBILE_NAV_PADDING_CLASS}`}
    >
      <ShellFoundationMount />
    </div>
  );
}

function GlobalChatOverlay(): ReactNode {
  return (
    <div
      className="pointer-events-none fixed inset-0 flex justify-center"
      data-testid="global-chat-overlay"
      style={{ zIndex: Z_OVERLAY }}
    >
      <div className="pointer-events-auto flex h-full w-full min-w-0 max-w-[54rem] flex-col bg-bg">
        <ChatView />
      </div>
    </div>
  );
}

export function App() {
  const {
    startupError,
    startupCoordinator,
    retryStartup,
    tab,
    setTab,
    setState,
    actionNotice,
    activeOverlayApp,
    uiTheme,
    backendConnection,
    activeGameViewerUrl,
    gameOverlayEnabled,
    uiShellMode,
    t,
  } = useApp();
  const { companionShell: CompanionShell } = useBootConfig();

  const isPopout = useIsPopout();
  const shellMode = useShellMode();
  // Auth gate — only active after the coordinator reaches "ready".
  // During first-run setup / pairing / startup phases the StartupScreen handles
  // its own gate (bootstrap step), so we skip the check.
  const isCoordinatorReady = startupCoordinator.phase === "ready";

  const { state: authState, refetch: refetchAuth } = useAuthStatus({
    skip: !isCoordinatorReady || isPopout,
  });
  // Don't initialize the 3D scene while the system is still booting — this
  // prevents VrmEngine's Three.js setup from blocking the JS thread and
  // delaying WebSocket agent-status updates (which would freeze the loader).
  const overlayAppActive =
    startupCoordinator.phase === "ready" && activeOverlayApp !== null;
  const resolvedOverlayApp =
    overlayAppActive && activeOverlayApp
      ? getOverlayApp(activeOverlayApp)
      : undefined;
  const contextMenu = useContextMenu();

  useSecretsManagerShortcut();

  // Warm lazy route chunks during idle once the shell is ready, so the first
  // navigation to a code-split view is instant rather than waiting on a fetch.
  useEffect(() => {
    if (startupCoordinator.phase !== "ready" || typeof window === "undefined") {
      return;
    }
    const w = window as Window & {
      requestIdleCallback?: (cb: () => void) => number;
      cancelIdleCallback?: (id: number) => void;
    };
    const schedule =
      w.requestIdleCallback ?? ((cb: () => void) => window.setTimeout(cb, 200));
    const cancel =
      w.cancelIdleCallback ?? ((id: number) => window.clearTimeout(id));
    const id = schedule(() => prefetchRouteViewChunks());
    return () => cancel(id);
  }, [startupCoordinator.phase]);

  useEffect(() => {
    if (!isCoordinatorReady || isPopout || shellMode !== "full") return;
    if (!isRouteRootPath(getWindowNavigationPath())) return;
    setTab("chat");
  }, [isCoordinatorReady, isPopout, setTab, shellMode]);

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.key !== "/" || event.ctrlKey || event.metaKey || event.altKey) {
        return;
      }
      const target = event.target as HTMLElement | null;
      const tag = target?.tagName;
      if (
        tag === "INPUT" ||
        tag === "TEXTAREA" ||
        tag === "SELECT" ||
        target?.isContentEditable
      ) {
        return;
      }
      const composer = document.querySelector<HTMLTextAreaElement>(
        '[data-testid="chat-composer-textarea"]',
      );
      if (!composer) return;
      event.preventDefault();
      composer.focus();
    };

    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  useEffect(() => {
    if (startupCoordinator.phase !== "ready") return;
    if (backendConnection?.state !== "connected") return;

    const report = () => {
      void fetchWithCsrf("/api/apps/overlay-presence", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ appName: activeOverlayApp }),
      }).catch(() => {
        /* ignore */
      });
    };

    report();
    const intervalId = window.setInterval(report, 25_000);
    return () => {
      window.clearInterval(intervalId);
      void fetchWithCsrf("/api/apps/overlay-presence", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ appName: null }),
      }).catch(() => {
        /* ignore */
      });
    };
  }, [activeOverlayApp, backendConnection?.state, startupCoordinator.phase]);

  const [customActionsPanelOpen, setCustomActionsPanelOpen] = useState(false);
  const [customActionsEditorOpen, setCustomActionsEditorOpen] = useState(false);
  const [settingsInitialSection, setSettingsInitialSection] = useState<
    string | null
  >(null);

  // Desktop tab bar — persisted pinned tabs for the Electrobun shell.
  const {
    tabs: desktopTabs,
    openTab: openDesktopTab,
    closeTab: closeDesktopTab,
  } = useDesktopTabs();
  const [activeDesktopTabId, setActiveDesktopTabId] = useState<string | null>(
    null,
  );
  const { views: availableViewsForDesktopTabs } = useAvailableViews();

  const [editingAction, setEditingAction] = useState<
    import("./api").CustomActionDef | null
  >(null);
  const [desktopShuttingDown, setDesktopShuttingDown] = useState(false);
  const [characterHeaderActions, setCharacterHeaderActions] =
    useState<ReactNode | null>(null);

  const isCompanionTab = tab === "companion";
  const isChat = tab === "chat";
  const isCharacterPage =
    tab === "character" || tab === "character-select" || tab === "documents";
  const isWallets = tab === "inventory";
  const isHeartbeats = tab === "triggers" || tab === "automations";
  const isSettingsPage = tab === "settings" || tab === "voice";
  const isAppsToolPage = isAppsToolTab(tab);
  const isDesktopWorkspacePage = tab === "desktop";

  // Keep hook order stable across first-run/auth state transitions.
  // Otherwise React can throw when first-run setup completes and the main shell mounts.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const handler = () => setCustomActionsPanelOpen((v) => !v);
    window.addEventListener("toggle-custom-actions-panel", handler);
    return () =>
      window.removeEventListener("toggle-custom-actions-panel", handler);
  }, []);

  const handleEditorSave = useCallback(() => {
    setCustomActionsEditorOpen(false);
    setEditingAction(null);
  }, []);

  const handleDeferredTaskOpen = useCallback(
    (task: FlaminaGuideTopic) => {
      if (task === "voice") {
        setTab("voice");
        return;
      }
      if (task === "permissions") {
        setSettingsInitialSection("permissions");
      } else if (task === "provider") {
        setSettingsInitialSection("ai-model");
      } else {
        setSettingsInitialSection(null);
      }
      setTab("settings");
    },
    [setTab],
  );

  useEffect(() => {
    if (typeof document === "undefined") return;
    const handleFocusConnector = (event: Event) => {
      const detail = (event as CustomEvent<FocusConnectorEventDetail>).detail;
      if (!detail?.connectorId) return;
      setSettingsInitialSection("connectors");
      setTab("settings");
    };
    document.addEventListener(FOCUS_CONNECTOR_EVENT, handleFocusConnector);
    return () =>
      document.removeEventListener(FOCUS_CONNECTOR_EVENT, handleFocusConnector);
  }, [setTab]);

  // Handle agent-dispatched view navigation events.
  // The VIEWS action (and future agent commands) dispatch this event to navigate
  // the user to a specific view by path or view ID.
  // When the target is "/views" or "/apps" (the ViewManagerPage), we also
  // directly set the tab so the nav bar becomes visible.
  // On desktop, also open the view as a desktop tab if desktopTabEnabled.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const handleNavigateView = createNavigateViewHandler({
      availableViewsForDesktopTabs,
      invokeDesktopBridgeRequest,
      openDesktopTab,
      setActiveDesktopTabId,
      setTab,
    });
    window.addEventListener("eliza:navigate:view", handleNavigateView);
    return () =>
      window.removeEventListener("eliza:navigate:view", handleNavigateView);
  }, [setTab, availableViewsForDesktopTabs, openDesktopTab]);

  useEffect(() => {
    if (isSettingsPage || settingsInitialSection === null) {
      return;
    }
    setSettingsInitialSection(null);
  }, [isSettingsPage, settingsInitialSection]);

  useEffect(() => {
    if (!isNative || !isIOS) {
      return;
    }

    void Keyboard.setScroll({ isDisabled: true }).catch(() => {
      // Ignore bridge failures so web and desktop shells keep working.
    });
  }, []);

  useEffect(() => {
    return subscribeDesktopBridgeEvent({
      rpcMessage: "desktopShutdownStarted",
      ipcChannel: "desktop:shutdownStarted",
      listener: () => {
        setDesktopShuttingDown(true);
      },
    });
  }, []);

  // Handle desktop tab navigation: clicking a tab navigates to its path.
  // Closing the active tab falls back to the chat view.
  const handleDesktopTabClick = useCallback(
    (viewId: string) => {
      const dtab = desktopTabs.find((t) => t.viewId === viewId);
      if (!dtab) return;
      setActiveDesktopTabId(viewId);
      try {
        if (typeof window === "undefined") return;
        if (window.location.protocol === "file:") {
          window.location.hash = dtab.path;
        } else {
          window.history.pushState(null, "", dtab.path);
          window.dispatchEvent(new PopStateEvent("popstate"));
        }
      } catch {
        // sandboxed — ignore
      }
    },
    [desktopTabs],
  );

  const handleDesktopTabClose = useCallback(
    (viewId: string) => {
      closeDesktopTab(viewId);
      if (activeDesktopTabId === viewId) {
        setActiveDesktopTabId(null);
        setTab("chat");
      }
    },
    [closeDesktopTab, activeDesktopTabId, setTab],
  );

  const handleOpenViewManagerFromTabBar = useCallback(() => {
    setTab("views");
  }, [setTab]);

  // desktopTabBar is computed here (after handlers) so the memo below can
  // reference a stable value. Rendered inside each shell variant, not at the
  // outer level, so Header + TabBar + content stack correctly per shell.
  const desktopTabBar = (
    <DesktopTabBar
      tabs={desktopTabs}
      activeViewId={activeDesktopTabId}
      onTabClick={handleDesktopTabClick}
      onTabClose={handleDesktopTabClose}
      onOpenViewManager={handleOpenViewManagerFromTabBar}
    />
  );

  const bugReport = useBugReportState();
  // Loading is handled entirely by StartupScreen.

  useEffect(() => {
    // Safety-net watchdog: the coordinator has its own timeouts per phase, but
    // this catches any edge case where the coordinator gets stuck in a loading
    // phase. During "starting-runtime" the agent-wait loop has its own sliding
    // deadline (up to 900s for embedding downloads), so we only watch the
    // pre-runtime phases.
    const STARTUP_TIMEOUT_MS = 300_000;
    const coordinatorPolling =
      startupCoordinator.phase === "polling-backend" ||
      startupCoordinator.phase === "restoring-session";
    if (coordinatorPolling && !startupError) {
      const timer = setTimeout(() => {
        startupCoordinator.retry();
      }, STARTUP_TIMEOUT_MS);
      return () => clearTimeout(timer);
    }
  }, [startupCoordinator.phase, startupError, startupCoordinator.retry]);

  // shellContent is memoized before early returns to satisfy the Rules of Hooks.
  // Deps are local state/callbacks — not high-frequency AppContext fields like
  // ptySessions/agentStatus — so CompanionSceneHost stays stable across polls.
  const shellContent = useMemo(
    () => (
      <ShellContent
        CompanionShell={CompanionShell}
        actionNotice={actionNotice}
        characterHeaderActions={characterHeaderActions}
        customActionsPanelOpen={customActionsPanelOpen}
        desktopTabBar={desktopTabBar}
        handleDeferredTaskOpen={handleDeferredTaskOpen}
        isAppsToolPage={isAppsToolPage}
        isCharacterPage={isCharacterPage}
        isChat={isChat}
        isCompanionTab={isCompanionTab}
        isDesktopWorkspacePage={isDesktopWorkspacePage}
        isHeartbeats={isHeartbeats}
        isSettingsPage={isSettingsPage}
        isWallets={isWallets}
        setCharacterHeaderActions={setCharacterHeaderActions}
        setCustomActionsEditorOpen={setCustomActionsEditorOpen}
        setCustomActionsPanelOpen={setCustomActionsPanelOpen}
        setEditingAction={setEditingAction}
        settingsInitialSection={settingsInitialSection}
        tab={tab}
        uiShellMode={uiShellMode}
      />
    ),
    [
      CompanionShell,
      tab,
      uiShellMode,
      isCompanionTab,
      actionNotice,
      isChat,
      isCharacterPage,
      isHeartbeats,
      isSettingsPage,
      isWallets,
      isAppsToolPage,
      isDesktopWorkspacePage,
      characterHeaderActions,
      handleDeferredTaskOpen,
      customActionsPanelOpen,
      settingsInitialSection,
      desktopTabBar,
    ],
  );

  // Pop-out mode — render only StreamView, skip startup gates.
  // Platform init is skipped in main.tsx; AppProvider hydrates WS in background.
  if (isPopout) {
    return (
      <div className="flex h-[100dvh] w-full max-w-full flex-col overflow-hidden bg-bg font-body text-txt">
        <LazyViewBoundary>
          <StreamView />
        </LazyViewBoundary>
      </div>
    );
  }

  // OS chat-overlay window — render JUST the floating assistant pill +
  // waveform over a transparent background, no app chrome or onboarding gate.
  if (shellMode === "chat-overlay") {
    return (
      <BugReportProvider value={bugReport}>
        <ShellControllerProvider>
          <ChatOverlayShell />
        </ShellControllerProvider>
        <BugReportModal />
      </BugReportProvider>
    );
  }

  if (!isCoordinatorReady) {
    return (
      <BugReportProvider value={bugReport}>
        <StartupScreen />
        <BugReportModal />
      </BugReportProvider>
    );
  }

  // Auth gate — when the coordinator is ready, check /api/auth/me.
  // "loading" phase: wait (fall through to the coordinator's own "ready" render).
  // "unauthenticated": render LoginView.
  // "authenticated": proceed to the main shell.
  // "server_unavailable": show a retryable startup failure.
  if (isCoordinatorReady && !isPopout) {
    if (authState.phase === "server_unavailable") {
      return (
        <BugReportProvider value={bugReport}>
          <StartupFailureView
            error={{
              reason: "backend-unreachable",
              phase: "starting-backend",
              message: "Backend became unavailable after startup.",
              detail:
                "The auth probe could not reach /api/auth/me. If this is local development, start the local agent API with `bun run dev` or `bun run dev:desktop`, then retry.",
            }}
            onRetry={retryStartup}
          />
          <BugReportModal />
        </BugReportProvider>
      );
    }
    if (authState.phase === "unauthenticated") {
      return (
        <BugReportProvider value={bugReport}>
          <LoginView onLoginSuccess={refetchAuth} reason={authState.reason} />
          <BugReportModal />
        </BugReportProvider>
      );
    }
    // While loading the auth state we allow the main shell to continue
    // rendering (avoids a flash of login screen on refresh when cookies are valid).
  }

  // OS kiosk window — the locked appliance shell: a fullscreen in-window
  // view-manager canvas plus an always-visible bottom chat pill. No app
  // chrome, no tabs. The pill is enabled here regardless of web/native gating.
  if (shellMode === "kiosk") {
    return (
      <BugReportProvider value={bugReport}>
        <ShellControllerProvider>
          <KioskShell />
        </ShellControllerProvider>
        <BugReportModal />
      </BugReportProvider>
    );
  }

  // Coordinator is at "ready" — the app shell renders. No deprecated first-run
  // overlays — the coordinator handled all of that before reaching ready.

  return (
    <BugReportProvider value={bugReport}>
      <ShellControllerProvider>
        <div className="flex h-[100dvh] w-full max-w-full flex-col overflow-hidden">
          <ConnectionFailedBanner />
          <SystemWarningBanner />
          {shellContent}
        </div>
        {/* Full-screen overlay app — renders whichever overlay app is active */}
        {resolvedOverlayApp &&
          (() => {
            const exitToApps = () => {
              setState("activeOverlayApp", null);
              setTab("apps");
            };
            const theme = uiTheme === "dark" ? "dark" : "light";
            const LazyOverlay = getOverlayAppLazyComponent(resolvedOverlayApp);
            if (LazyOverlay) {
              return (
                <Suspense fallback={null}>
                  <LazyOverlay exitToApps={exitToApps} uiTheme={theme} t={t} />
                </Suspense>
              );
            }
            const Component = resolvedOverlayApp.Component;
            if (!Component) return null;
            return <Component exitToApps={exitToApps} uiTheme={theme} t={t} />;
          })()}

        {/* Persistent game overlay — stays visible across all tabs */}
        {activeGameViewerUrl &&
          gameOverlayEnabled &&
          tab !== "apps" &&
          tab !== "views" && <GameViewOverlay />}
        {isChat ? <GlobalChatOverlay /> : <EmbeddedShellPill />}
        <ShellOverlays actionNotice={actionNotice} />
        <SaveCommandModal
          open={contextMenu.saveCommandModalOpen}
          text={contextMenu.saveCommandText}
          onSave={contextMenu.confirmSaveCommand}
          onClose={contextMenu.closeSaveCommandModal}
        />
        <SecretsManagerModalRoot />
        <CustomActionEditor
          open={customActionsEditorOpen}
          action={editingAction}
          onSave={handleEditorSave}
          onClose={() => {
            setCustomActionsEditorOpen(false);
            setEditingAction(null);
          }}
        />
        <ConnectionLostOverlay />
        {desktopShuttingDown ? (
          <div
            className="fixed inset-0 z-[1000] flex items-center justify-center bg-bg/80 "
            role="status"
            aria-live="polite"
          >
            <div className="rounded-sm border border-border/60 bg-card/95 px-6 py-5 text-center ">
              <div className="text-base font-semibold text-txt">
                Shutting down…
              </div>
              <div className="mt-1 text-sm text-muted">
                Closing services and saving state.
              </div>
            </div>
          </div>
        ) : null}
      </ShellControllerProvider>
    </BugReportProvider>
  );
}
