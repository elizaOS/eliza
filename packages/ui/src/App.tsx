/**
 * Root App component — routing shell.
 */

import { Keyboard } from "@capacitor/keyboard";
import { X } from "lucide-react";
import { motion, useReducedMotion } from "motion/react";
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
import {
  type ActiveViewLayout,
  createNavigateViewHandler,
} from "./app-navigate-view";
import {
  invokeDesktopBridgeRequest,
  subscribeDesktopBridgeEvent,
} from "./bridge/electrobun-rpc";
import { getOverlayAppLazyComponent } from "./components/apps/AppWindowRenderer.helpers";
import { GameViewOverlay } from "./components/apps/GameViewOverlay";
import { getOverlayApp } from "./components/apps/overlay-app-registry";
import { LoginView } from "./components/auth/LoginView";
import { SaveCommandModal } from "./components/chat/SaveCommandModal";
import { CustomActionEditor } from "./components/custom-actions/CustomActionEditor";
import { CustomActionsPanel } from "./components/custom-actions/CustomActionsPanel";
import { AppsPageView } from "./components/pages/AppsPageView";
import { SecretsManagerModalRoot } from "./components/settings/SecretsManagerSection";
import { AssistantOverlay } from "./components/shell/AssistantOverlay";
import { BugReportModal } from "./components/shell/BugReportModal";
import { ChatSurface } from "./components/shell/ChatSurface";
import { ConnectionFailedBanner } from "./components/shell/ConnectionFailedBanner";
import { ConnectionLostOverlay } from "./components/shell/ConnectionLostOverlay";
import { ContinuousChatOverlay } from "./components/shell/ContinuousChatOverlay";
import { HomePill } from "./components/shell/HomePill";
import { KioskViewCanvas } from "./components/shell/KioskViewCanvas";
import { ShellControllerProvider } from "./components/shell/ShellControllerContext";
import { useShellControllerContext } from "./components/shell/ShellControllerContext.hooks";
import { ShellOverlays } from "./components/shell/ShellOverlays";
import { StartupFailureView } from "./components/shell/StartupFailureView";
import { StartupScreen } from "./components/shell/StartupScreen";
import { SystemWarningBanner } from "./components/shell/SystemWarningBanner";
import { useKioskViewSurfaces } from "./components/shell/useKioskViewSurfaces";
import { ErrorBoundary } from "./components/ui/error-boundary";
import { AppWorkspaceChrome } from "./components/workspace/AppWorkspaceChrome";
import { useBootConfig } from "./config/boot-config-react.hooks";
import type { CompanionShellComponentProps } from "./config/boot-config-store";
import {
  FOCUS_CONNECTOR_EVENT,
  type FocusConnectorEventDetail,
} from "./events";
import { CompactOnboarding } from "./first-run/CompactOnboarding";
import { FirstRunScreen } from "./first-run/FirstRunScreen";
import { BugReportProvider, useBugReportState, useContextMenu } from "./hooks";
import { useAuthStatus } from "./hooks/useAuthStatus";
import { useSecretsManagerShortcut } from "./hooks/useSecretsManagerShortcut";
import {
  APPS_ENABLED,
  getAppSlugFromPath,
  getWindowNavigationPath,
  isAndroidPhoneSurfaceEnabled,
  isRouteRootPath,
  shouldUseHashNavigation,
} from "./navigation";
import { isIOS, isNative } from "./platform/init";
import { type ActionNotice, useApp } from "./state";

const MOBILE_NAV_PADDING_CLASS =
  "pb-[calc(var(--eliza-mobile-nav-offset,0px)+var(--safe-area-bottom,0px)+var(--eliza-continuous-chat-clearance,5.25rem))]";
type ExtractComponent<TValue> =
  TValue extends ComponentType<infer Props> ? ComponentType<Props> : never;

// Single source of truth for the lazy route-view chunk loaders. Each
// lazyNamedView() call registers its import() thunk here so prefetch (below)
// warms exactly the chunks that are lazy-split — no hand-synced second list to
// drift out of sync.
const routeViewLoaders = new Set<() => Promise<unknown>>();

function lazyNamedView<
  TModule extends Record<string, unknown>,
  TKey extends keyof TModule,
>(
  load: () => Promise<TModule>,
  exportName: TKey,
): LazyExoticComponent<ExtractComponent<TModule[TKey]>> {
  routeViewLoaders.add(load);
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

const ViewCatalog = lazyNamedView(
  () => import("./components/pages/ViewCatalog"),
  "ViewCatalog",
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
// fetch. Iterates the loaders registered by lazyNamedView() above — the same
// thunks the lazy() boundaries use, so the bundler reuses the same chunks and
// the list can't drift. Failures are ignored — this is best-effort warming.
function prefetchRouteViewChunks(): void {
  for (const load of routeViewLoaders) void load().catch(() => {});
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
type ShellMode =
  | "chat-overlay"
  | "onboarding-overlay"
  | "launcher"
  | "kiosk"
  | "full";

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
  if (raw === "onboarding-overlay") return "onboarding-overlay";
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
 * First-run onboarding overlay surface. Renders ONLY the floating
 * CompactOnboarding card over a transparent, click-through background — no app
 * chrome. The native overlay window is `transparent` + `passthrough`, so the
 * empty (pointer-events-none) region lets clicks fall through to the desktop
 * behind while the card stays interactive.
 */
function OnboardingOverlayShell() {
  return (
    <div
      data-testid="onboarding-overlay-shell"
      className="pointer-events-none fixed inset-0 bg-transparent"
    >
      <CompactOnboarding showVoicePill />
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
          className={`eliza-continuous-chat-scroll flex-1 min-h-0 min-w-0 w-full overflow-y-auto pb-[var(--eliza-continuous-chat-clearance,5.25rem)] ${className}`}
        >
          {children}
        </div>
      }
    />
  );
}

function TabContentView({ children }: { children: ReactNode }) {
  return (
    <AppWorkspaceChrome
      testId="tab-content-view"
      chatDisabled
      main={
        <div
          data-shell-content-region="true"
          className="eliza-continuous-chat-scroll flex flex-col flex-1 min-h-0 min-w-0 w-full overflow-hidden pb-[var(--eliza-continuous-chat-clearance,5.25rem)]"
        >
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
 * Plugins that declare a `componentExport` without a matching registration get
 * a small loading fallback until the import resolves. Plugins can avoid this
 * path by self-registering with `registerAppShellPage` at boot.
 */
function DynamicPluginPage({ resolved }: { resolved: ResolvedDynamicPage }) {
  if (resolved.registration) {
    const Component = resolved.registration.Component;
    return <Component />;
  }
  // No bundled registration — display a lightweight loading fallback
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

/**
 * Whether the active app-shell page wants to render edge-to-edge with no host
 * top-bar/chrome. Looks the active tab up in the runtime page registry and
 * reads its `fullBleed` flag — backward-compatible: pages that don't set it
 * keep the normal chrome.
 */
function useTabIsFullBleed(tab: string): boolean {
  return useMemo(
    () =>
      listAppShellPages().some(
        (entry) => entry.id === tab && entry.fullBleed === true,
      ),
    [tab],
  );
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

// These paths are owned by the built-in shell and must never be handed off to
// a remote bundle, even if the view registry returns a bundleUrl for them.
const SHELL_RESERVED_PATHS = new Set([
  "/views",
  "/apps",
  "/apps/plugins",
  "/apps/skills",
  "/apps/trajectories",
  "/apps/relationships",
  "/apps/memories",
  "/apps/runtime",
  "/apps/database",
  "/apps/logs",
  "/apps/tasks",
]);

function findRemoteViewForRoute(
  views: ViewRegistryEntry[],
  navigationPath: string,
  tab: string,
  appSlug: string | null,
): ViewRegistryEntry | undefined {
  const normalizedPath = trimmedNavigationPath(navigationPath);
  if (SHELL_RESERVED_PATHS.has(normalizedPath)) return undefined;
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

function viewLayoutLabel(layout: ActiveViewLayout): string {
  return layout.mode === "split" ? "Split view" : "Tiled views";
}

function splitLayoutIsStacked(layout: ActiveViewLayout): boolean {
  const hint = `${layout.layout ?? ""} ${layout.placement ?? ""}`.toLowerCase();
  return /\b(vertical|rows?|top|bottom|above|below)\b/.test(hint);
}

function viewLayoutGridClass(layout: ActiveViewLayout, count: number): string {
  if (layout.mode === "split") {
    return splitLayoutIsStacked(layout)
      ? "grid-cols-1 grid-rows-2"
      : "grid-cols-1 md:grid-cols-2";
  }
  if (count <= 1) return "grid-cols-1";
  if (count === 2) return "grid-cols-1 md:grid-cols-2";
  return "grid-cols-1 md:grid-cols-2 xl:grid-cols-3";
}

function ViewLayoutSurface({
  availableViews,
  layout,
  onClear,
}: {
  availableViews: ViewRegistryEntry[];
  layout: ActiveViewLayout;
  onClear: () => void;
}): ReactNode {
  const entries = layout.viewIds
    .map((viewId) => availableViews.find((view) => view.id === viewId))
    .filter((view): view is ViewRegistryEntry => Boolean(view));
  const paneClassName =
    "flex min-h-[18rem] min-w-0 flex-col overflow-hidden border border-border/45 bg-bg";

  return (
    <TabContentView>
      <section
        data-testid="view-layout-surface"
        className="flex h-full min-h-0 min-w-0 flex-1 flex-col bg-bg"
      >
        <header className="flex min-h-12 shrink-0 items-center justify-between gap-3 border-b border-border/45 px-3">
          <div className="flex min-w-0 items-center gap-2">
            <span className="truncate text-sm font-medium text-txt">
              {viewLayoutLabel(layout)}
            </span>
            <span className="shrink-0 text-xs tabular-nums text-muted">
              {entries.length}
            </span>
          </div>
          <button
            type="button"
            aria-label="Close layout"
            title="Close layout"
            data-testid="view-layout-close"
            onClick={onClear}
            className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-sm text-muted transition-colors hover:bg-border/35 hover:text-txt focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
          >
            <X className="h-4 w-4" aria-hidden />
          </button>
        </header>
        <div
          className={`grid min-h-0 flex-1 gap-2 overflow-auto p-2 ${viewLayoutGridClass(
            layout,
            entries.length,
          )} eliza-continuous-chat-scroll pb-[calc(0.5rem+var(--eliza-continuous-chat-clearance,5.25rem))]`}
        >
          {entries.length > 0 ? (
            entries.map((view) => (
              <section
                key={view.id}
                data-testid={`view-layout-pane-${view.id}`}
                className={paneClassName}
              >
                <div className="flex h-9 shrink-0 items-center border-b border-border/35 px-2.5">
                  <span className="truncate text-xs font-medium text-muted">
                    {view.label}
                  </span>
                </div>
                <div className="min-h-0 min-w-0 flex-1 overflow-hidden">
                  {view.bundleUrl ? (
                    <DynamicViewLoader
                      bundleUrl={view.bundleUrl}
                      componentExport={view.componentExport}
                      viewId={view.id}
                      viewType={view.viewType}
                    />
                  ) : (
                    <div className="flex h-full min-h-0 items-center justify-center px-4 text-center text-sm text-muted">
                      {view.label} is not available as a dynamic view.
                    </div>
                  )}
                </div>
              </section>
            ))
          ) : (
            <div className="flex min-h-[18rem] items-center justify-center border border-border/45 px-4 text-center text-sm text-muted">
              Requested views are not available.
            </div>
          )}
        </div>
      </section>
    </TabContentView>
  );
}

/**
 * Fallback shown when a view/tab is unavailable. Chat is the always-present
 * ContinuousChatOverlay that floats over every view — views never embed an
 * inline ChatView — so an unavailable view falls back to the app/view
 * launcher, not a chat surface.
 */
function ViewUnavailableFallback(): ReactNode {
  return (
    <TabContentView>
      <ViewCatalog />
    </TabContentView>
  );
}

function renderPhoneSurface(
  enabled: boolean,
  Component: ComponentType,
): ReactNode {
  return enabled ? (
    <TabContentView>
      <Component />
    </TabContentView>
  ) : (
    <ViewUnavailableFallback />
  );
}

function renderAppsSurface(navigationPath: string): ReactNode {
  if (!APPS_ENABLED) return <ViewUnavailableFallback />;
  return (
    <TabContentView>
      {getAppSlugFromPath(navigationPath) ? <AppsPageView /> : <ViewCatalog />}
    </TabContentView>
  );
}

function renderStaticViewRouterTab({
  tab,
  androidPhoneSurfaceEnabled,
  navigationPath,
  settingsInitialSection,
  LifeOpsPageView,
}: {
  tab: string;
  androidPhoneSurfaceEnabled: boolean;
  navigationPath: string;
  settingsInitialSection?: string | null;
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
      <TabContentView>
        <SettingsView
          key="settings-root"
          initialSection={settingsInitialSection ?? undefined}
        />
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
      <TabContentView>
        <CharacterEditor />
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
  settingsInitialSection,
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
  settingsInitialSection?: string | null;
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
      <TabContentView>
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
    settingsInitialSection,
    LifeOpsPageView,
  });
}

function ViewRouter({
  settingsInitialSection,
}: {
  settingsInitialSection?: string | null;
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
    settingsInitialSection,
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
  availableViewsForLayout: ViewRegistryEntry[];
  customActionsPanelOpen: boolean;
  desktopTabBar: ReactNode;
  isChat: boolean;
  isCompanionTab: boolean;
  isFullBleed: boolean;
  setCustomActionsEditorOpen: (open: boolean) => void;
  setCustomActionsPanelOpen: (open: boolean) => void;
  setEditingAction: (action: import("./api").CustomActionDef | null) => void;
  settingsInitialSection: string | null;
  tab: string;
  uiShellMode: string;
  viewLayout: ActiveViewLayout | null;
  onClearViewLayout: () => void;
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

/** Time-of-day greeting for the ambient chat home's backdrop (Her-style). */
function minimalHomeGreeting(): string {
  const h = new Date().getHours();
  if (h < 5) return "still up?";
  if (h < 12) return "good morning";
  if (h < 18) return "good afternoon";
  return "good evening";
}

function ChatRouteShellContent(props: ShellContentProps): ReactNode {
  // The /chat route is the ambient conversational home: open space behind the
  // always-present ContinuousChatOverlay (mounted at the shell root), which is
  // the whole chat experience. Ask it anything, or ask it to open a view ("show
  // me the coding view") which surfaces over this base.
  const reduceMotion = useReducedMotion() ?? false;
  return (
    <div key="chat-shell" className={APP_SHELL_CLASS}>
      <div className="relative flex min-h-0 min-w-0 flex-1 items-center justify-center overflow-hidden">
        {/* The greeting settles in — a slow blur+rise fade — then breathes
            gently so the ambient home feels alive rather than static (Her-style).
            Honors reduced motion (a plain, still fade). */}
        <motion.p
          className="-translate-y-8 select-none text-center text-3xl font-light italic text-muted"
          initial={
            reduceMotion
              ? { opacity: 0 }
              : { opacity: 0, y: 16, filter: "blur(12px)" }
          }
          animate={
            reduceMotion
              ? { opacity: 0.38 }
              : { opacity: [0.3, 0.5, 0.3], y: 0, filter: "blur(0px)" }
          }
          transition={
            reduceMotion
              ? { duration: 0.6 }
              : {
                  y: { duration: 1.9, ease: [0.22, 1, 0.36, 1] },
                  filter: { duration: 1.9, ease: [0.22, 1, 0.36, 1] },
                  opacity: { duration: 8, repeat: Infinity, ease: "easeInOut" },
                }
          }
        >
          {minimalHomeGreeting()}
        </motion.p>
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

function routedShellMainClass(tab: string): string {
  const pagePadding =
    tab === "browser" || tab === "apps" || tab === "views"
      ? ""
      : "px-3 xl:px-5 py-4 xl:py-6";
  const mobilePadding = tab === "browser" ? "" : MOBILE_NAV_PADDING_CLASS;
  return `flex flex-1 min-h-0 min-w-0 overflow-hidden ${pagePadding} ${mobilePadding}`;
}

/**
 * The single routed shell for every view. ViewRouter already resolves every tab
 * — static page views, dynamic plugin pages, and remote view bundles — so the
 * shell only adds the desktop tab bar and per-tab padding around it. Chat is the
 * always-present ContinuousChatOverlay floating over this base, never embedded
 * per-view.
 */
function RoutedShellContent(props: ShellContentProps): ReactNode {
  return (
    <div key={`tab-shell-${props.tab}`} className={APP_SHELL_CLASS}>
      {props.desktopTabBar}
      <main className={routedShellMainClass(props.tab)}>
        {props.viewLayout ? (
          <ViewLayoutSurface
            availableViews={props.availableViewsForLayout}
            layout={props.viewLayout}
            onClear={props.onClearViewLayout}
          />
        ) : (
          <ViewRouter settingsInitialSection={props.settingsInitialSection} />
        )}
      </main>
    </div>
  );
}

/**
 * Edge-to-edge surface for pages that register `fullBleed` — no tab bar, no
 * padding. The page owns its full window (e.g. the odysseus orchestrator).
 */
function FullBleedShellContent(props: ShellContentProps): ReactNode {
  return (
    <div key={`fullbleed-shell-${props.tab}`} className={APP_SHELL_CLASS}>
      <main className="flex flex-1 min-h-0 min-w-0 overflow-hidden">
        <ViewRouter />
      </main>
    </div>
  );
}

/**
 * Picks the shell wrapper for the active tab. Only three surfaces are genuinely
 * distinct from a routed view: `fullBleed` pages (edge-to-edge), the ambient
 * `/chat` home (open space behind the overlay), and the host-injected companion
 * shell. Everything else is a view rendered through the single
 * RoutedShellContent → ViewRouter path.
 */
function ShellContent(props: ShellContentProps): ReactNode {
  if (props.isFullBleed) return <FullBleedShellContent {...props} />;
  if (props.isChat) return <ChatRouteShellContent {...props} />;
  const companionContent = CompanionShellContent(props);
  if (companionContent) return companionContent;
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
 * Reads the shared shell controller from context and renders the always-present
 * continuous chat overlay — one ambient glass conversation (the app's single
 * active conversation via useShellController) that floats over every view,
 * including the /chat route's ambient home. Returns null until a controller
 * provider is present.
 */
function ContinuousChatOverlayMount(): ReactNode {
  const controller = useShellControllerContext();
  if (!controller) return null;
  return <ContinuousChatOverlay controller={controller} />;
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
  const [viewLayout, setViewLayout] = useState<ActiveViewLayout | null>(null);

  const [editingAction, setEditingAction] = useState<
    import("./api").CustomActionDef | null
  >(null);
  const [desktopShuttingDown, setDesktopShuttingDown] = useState(false);

  const isCompanionTab = tab === "companion";
  const isChat = tab === "chat";
  const isSettingsPage = tab === "settings" || tab === "voice";
  const isFullBleed = useTabIsFullBleed(tab);

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
  // When the target is "/views" or "/apps" (the ViewCatalog), we also
  // directly set the tab so the nav bar becomes visible.
  // On desktop, also open the view as a desktop tab if desktopTabEnabled.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const handleNavigateView = createNavigateViewHandler({
      availableViewsForDesktopTabs,
      closeDesktopTab,
      desktopTabs,
      invokeDesktopBridgeRequest,
      openDesktopTab,
      setActiveDesktopTabId,
      setTab,
      setViewLayout,
    });
    window.addEventListener("eliza:navigate:view", handleNavigateView);
    return () =>
      window.removeEventListener("eliza:navigate:view", handleNavigateView);
  }, [
    setTab,
    availableViewsForDesktopTabs,
    closeDesktopTab,
    desktopTabs,
    openDesktopTab,
  ]);

  useEffect(() => {
    if (tab !== "views" && viewLayout) {
      setViewLayout(null);
    }
  }, [tab, viewLayout]);

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
      setViewLayout(null);
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
      setViewLayout(null);
      closeDesktopTab(viewId);
      if (activeDesktopTabId === viewId) {
        setActiveDesktopTabId(null);
        setTab("chat");
      }
    },
    [closeDesktopTab, activeDesktopTabId, setTab],
  );

  const handleOpenViewManagerFromTabBar = useCallback(() => {
    setViewLayout(null);
    setTab("views");
  }, [setTab]);

  const handleClearViewLayout = useCallback(() => {
    setViewLayout(null);
  }, []);

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
        availableViewsForLayout={availableViewsForDesktopTabs}
        customActionsPanelOpen={customActionsPanelOpen}
        desktopTabBar={desktopTabBar}
        isChat={isChat}
        isCompanionTab={isCompanionTab}
        isFullBleed={isFullBleed}
        setCustomActionsEditorOpen={setCustomActionsEditorOpen}
        setCustomActionsPanelOpen={setCustomActionsPanelOpen}
        setEditingAction={setEditingAction}
        settingsInitialSection={settingsInitialSection}
        tab={tab}
        uiShellMode={uiShellMode}
        viewLayout={viewLayout}
        onClearViewLayout={handleClearViewLayout}
      />
    ),
    [
      CompanionShell,
      tab,
      uiShellMode,
      isCompanionTab,
      actionNotice,
      isChat,
      isFullBleed,
      customActionsPanelOpen,
      settingsInitialSection,
      desktopTabBar,
      availableViewsForDesktopTabs,
      viewLayout,
      handleClearViewLayout,
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

  // First-run onboarding overlay window — render JUST the floating onboarding
  // card over a transparent, click-through background, no app chrome or
  // startup gate.
  if (shellMode === "onboarding-overlay") {
    return (
      <BugReportProvider value={bugReport}>
        <ShellControllerProvider>
          <OnboardingOverlayShell />
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
        {/*
          Continuous chat overlay (ContinuousChatOverlay) — one ambient glass
          conversation (the app's single active conversation via
          useShellController) that floats over EVERY view, including the /chat
          route (whose base is now just ambient space). It survives tab/view
          changes because it renders here in the persistent sibling region, and
          is pointer-events-none except its own composer/messages, so the view
          behind stays live.
        */}
        <ContinuousChatOverlayMount />
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
