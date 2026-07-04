/**
 * Root App component — routing shell.
 */

import {
  type AppShellBackgroundPolicy,
  type EnabledViewKinds,
  isViewVisible,
  type ViewKind,
} from "@elizaos/core";
import { X } from "lucide-react";
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
  useSyncExternalStore,
} from "react";
import {
  type ActiveViewLayout,
  createNavigateViewHandler,
  type NavigateViewDetail,
} from "./app-navigate-view";
import { AppBackground } from "./backgrounds/AppBackground";
import {
  invokeDesktopBridgeRequest,
  subscribeDesktopBridgeEvent,
} from "./bridge/electrobun-rpc";
import { isElectrobunRuntime } from "./bridge/electrobun-runtime";
import {
  NAVIGATE_SETTINGS_EVENT,
  type NavigateSettingsDetail,
  reportUserViewSwitch,
  useSlashCommandController,
} from "./chat/useSlashCommandController";
import { getOverlayAppLazyComponent } from "./components/apps/AppWindowRenderer.helpers";
import { GameViewOverlay } from "./components/apps/GameViewOverlay";
import { getOverlayApp } from "./components/apps/overlay-app-registry";
import { LoginView } from "./components/auth/LoginView";
import { SaveCommandModal } from "./components/chat/SaveCommandModal";
import { CustomActionEditor } from "./components/custom-actions/CustomActionEditor";
import { CustomActionsPanel } from "./components/custom-actions/CustomActionsPanel";
import { AppsPageView } from "./components/pages/AppsPageView";
import { TutorialOverlay } from "./components/pages/tutorial/TutorialOverlay";
import { PermissionPrimingOverlay } from "./components/permissions/PermissionPrimingOverlay";
import { ActionBanner } from "./components/shell/ActionBanner";
import { AssistantOverlay } from "./components/shell/AssistantOverlay";
import { BugReportModal } from "./components/shell/BugReportModal";
import { ChatSurface } from "./components/shell/ChatSurface";
import { CloudHandoffBanner } from "./components/shell/CloudHandoffBanner";
import { ConnectionFailedBanner } from "./components/shell/ConnectionFailedBanner";
import { ConnectionLostOverlay } from "./components/shell/ConnectionLostOverlay";
import { ContinuousChatOverlay } from "./components/shell/ContinuousChatOverlay";
import { HomeLauncherSurface } from "./components/shell/HomeLauncherSurface";
import { HomePill } from "./components/shell/HomePill";
import { HomeScreen, type HomeTileTarget } from "./components/shell/HomeScreen";
import { KioskViewCanvas } from "./components/shell/KioskViewCanvas";
import { NotificationCenter } from "./components/shell/NotificationCenter";
import { ShellControllerProvider } from "./components/shell/ShellControllerContext";
import { useShellControllerContext } from "./components/shell/ShellControllerContext.hooks";
import { ShellOverlays } from "./components/shell/ShellOverlays";
import { StartupFailureView } from "./components/shell/StartupFailureView";
import { StartupScreen } from "./components/shell/StartupScreen";
import { SystemWarningBanner } from "./components/shell/SystemWarningBanner";
import { TrayLauncher } from "./components/shell/TrayLauncher";
import { useBarSurfaceWindows } from "./components/shell/useBarSurfaceWindows";
import { useKioskViewSurfaces } from "./components/shell/useKioskViewSurfaces";
import { Button } from "./components/ui/button";
import { KeepAliveViewHost } from "./components/views/KeepAliveViewHost";
import { ViewErrorBoundary } from "./components/views/ViewErrorBoundary";
import { AppWorkspaceChrome } from "./components/workspace/AppWorkspaceChrome";
import { useBootConfig } from "./config/boot-config-react.hooks";
import {
  CONNECT_EVENT,
  dispatchNavigateViewEvent,
  FOCUS_CONNECTOR_EVENT,
  type FocusConnectorEventDetail,
  NAVIGATE_VIEW_EVENT,
} from "./events";
import { adoptRemoteAgentFirstRun } from "./first-run/adopt-remote-first-run";
import { persistMobileRuntimeModeForServerTarget } from "./first-run/mobile-runtime-mode";
import { FirstRunConductorMount } from "./first-run/use-first-run-conductor";
import { BugReportProvider, useBugReportState, useContextMenu } from "./hooks";
import { useAuthStatus } from "./hooks/useAuthStatus";
import { useRole } from "./hooks/useRole";
import { useSecretsManagerModalState } from "./hooks/useSecretsManagerModal";
import { useSecretsManagerShortcut } from "./hooks/useSecretsManagerShortcut";
import {
  APPS_ENABLED,
  getAppSlugFromPath,
  getWindowNavigationPath,
  isAospShellEnabled,
  isRouteRootPath,
  pathForTab,
  shouldUseHashNavigation,
  TAB_PATHS,
  tabFromPath,
} from "./navigation";
import { applyLaunchConnection } from "./platform";
import { isIOS, isNative } from "./platform/init";
import { RetainedLazyComponent } from "./retained-lazy";
import {
  type ActionNotice,
  useAppSelector,
  useAppSelectorShallow,
} from "./state";
import { isShellPaintable } from "./state/startup-coordinator";
import { firstRunOwnsLoginSurface } from "./state/top-level-auth-gate";
import { isLoopbackGatewayHost } from "./state/use-startup-shell-controller";
import { confirmDesktopAction } from "./utils/desktop-dialogs";
import { VoiceSelfTestShell } from "./voice/voice-selftest/VoiceSelfTestShell";
import { VoiceWorkbenchShell } from "./voice/voice-selftest/VoiceWorkbenchShell";

const MOBILE_NAV_PADDING_CLASS =
  "pb-[calc(var(--eliza-mobile-nav-offset,0px)+max(var(--safe-area-bottom,0px),var(--android-gesture-inset-bottom,0px))+var(--eliza-continuous-chat-clearance,5.25rem))]";
type ExtractComponent<TValue> =
  TValue extends ComponentType<infer Props> ? ComponentType<Props> : never;

function gatewayHostForDisplay(gatewayUrl: string): string {
  try {
    return new URL(gatewayUrl).host || gatewayUrl;
  } catch {
    return gatewayUrl;
  }
}

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

import { client } from "./api";
import { fetchWithCsrf } from "./api/csrf-client";
// Import the page registry from its standalone module, NOT the
// `app-shell-components` barrel — that barrel statically re-exports every page
// view, so importing through it folds all of them back into the main chunk.
import {
  type AppShellPageRegistration,
  getAppShellPageRegistrySnapshot,
  listAppShellPages,
  subscribeAppShellPages,
} from "./app-shell-registry";
// CharacterEditor, DesktopTabBar, and FineTuningView stay static: they are
// already pulled eagerly elsewhere in the app graph (main.tsx / plugin-loader /
// boot-config), so a lazy() boundary here would only fold back into main. The
// remaining page views are lazy-split below.
import { CharacterEditor } from "./components/character/CharacterEditor";
import { DesktopTabBar } from "./components/desktop/DesktopTabBar";
import { LauncherSurface } from "./components/pages/LauncherSurface";
import {
  isWalletSectionPath,
  WalletSectionNav,
} from "./components/pages/WalletSectionNav";
import { FineTuningView } from "./components/training/injected";
import { DynamicViewLoader } from "./components/views/DynamicViewLoader";
import {
  useAvailableViews,
  useRoutableViews,
  type ViewRegistryEntry,
} from "./hooks/useAvailableViews";
import { useDesktopTabs } from "./hooks/useDesktopTabs";
import { useEnabledViewKinds } from "./state/useViewKinds";
import { WidgetHost } from "./widgets";

const BackgroundView = lazyNamedView(
  () => import("./components/pages/BackgroundView"),
  "BackgroundView",
);
const AutomationsFeed = lazyNamedView(
  () => import("./components/pages/AutomationsFeed"),
  "AutomationsFeed",
);
const BrowserWorkspaceView = lazyNamedView(
  () => import("./components/pages/BrowserWorkspaceView"),
  "BrowserWorkspaceView",
);
const TranscriptsPageView = lazyNamedView(
  () => import("./components/transcripts/TranscriptsPage"),
  "TranscriptsPage",
);
const CameraPageView = lazyNamedView(
  () => import("./components/pages/CameraPageView"),
  "CameraPageView",
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
const TutorialView = lazyNamedView(
  () => import("./components/pages/tutorial/TutorialView"),
  "TutorialView",
);
const HelpView = lazyNamedView(
  () => import("./components/pages/help/HelpView"),
  "HelpView",
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
const FilesView = lazyNamedView(
  () => import("./components/pages/FilesView"),
  "FilesView",
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
const KnowledgeView = lazyNamedView(
  () => import("./components/pages/KnowledgeView"),
  "KnowledgeView",
);
const CharacterExperienceView = lazyNamedView(
  () => import("./components/character/CharacterExperienceView"),
  "CharacterExperienceView",
);
const CharacterSkillsView = lazyNamedView(
  () => import("./components/character/CharacterSkillsView"),
  "CharacterSkillsView",
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

const ROUTE_PREFETCH_MAX_CHUNKS = 4;

function shouldWarmRouteViewChunks(): boolean {
  if (typeof window === "undefined" || typeof document === "undefined") {
    return false;
  }
  if (document.visibilityState === "hidden") return false;
  const navigatorWithHints = navigator as Navigator & {
    connection?: { effectiveType?: string; saveData?: boolean };
    deviceMemory?: number;
  };
  if (navigatorWithHints.connection?.saveData) return false;
  if (
    navigatorWithHints.connection?.effectiveType === "slow-2g" ||
    navigatorWithHints.connection?.effectiveType === "2g"
  ) {
    return false;
  }
  if (
    typeof navigatorWithHints.deviceMemory === "number" &&
    navigatorWithHints.deviceMemory <= 4
  ) {
    return false;
  }
  return true;
}

// Once the shell is interactive, warm a small number of lazy route chunks
// during idle time on capable devices. Full views still stay lazy by default:
// this is a bounded best-effort path, not an eager import of the whole shell.
function scheduleRouteViewChunkPrefetch(): () => void {
  if (!shouldWarmRouteViewChunks()) return () => {};
  const loaders = [...routeViewLoaders].slice(0, ROUTE_PREFETCH_MAX_CHUNKS);
  if (loaders.length === 0) return () => {};
  let cancelled = false;
  let scheduledId: number | null = null;
  const w = window as Window & {
    requestIdleCallback?: (
      cb: () => void,
      options?: { timeout?: number },
    ) => number;
    cancelIdleCallback?: (id: number) => void;
  };

  const scheduleNext = () => {
    if (cancelled || loaders.length === 0) return;
    const run = () => {
      scheduledId = null;
      if (cancelled) return;
      const load = loaders.shift();
      if (load) void load().catch(() => {});
      scheduleNext();
    };
    scheduledId =
      w.requestIdleCallback?.(run, { timeout: 2_000 }) ??
      window.setTimeout(run, 750);
  };

  scheduleNext();
  return () => {
    cancelled = true;
    if (scheduledId === null) return;
    if (w.cancelIdleCallback) {
      w.cancelIdleCallback(scheduledId);
    } else {
      window.clearTimeout(scheduledId);
    }
  };
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
 * Shell mode for focused native surfaces. The OS launches the same app
 * bundle with `--shell-mode=chat-overlay` (transparent assistant overlay),
 * `--shell-mode=launcher` (full home view), or
 * `--shell-mode=kiosk` (the locked appliance shell: a single fullscreen
 * view-manager surface with an always-visible bottom chat pill). The mode is
 * read from the URL (`?shellMode=` / `?shell-mode=`) or the
 * `ELIZAOS_SHELL_MODE` global the native shell may inject. Unset = full app.
 */
type ShellMode =
  | "chat-overlay"
  | "tray-popover"
  | "voice-selftest"
  | "voice-workbench"
  | "launcher"
  | "kiosk"
  | "full";

declare global {
  interface Window {
    ELIZAOS_SHELL_MODE?: string;
  }
}

function readShellMode(): ShellMode {
  if (typeof window === "undefined") return "full";
  const params = new URLSearchParams(
    window.location.search || window.location.hash.split("?")[1] || "",
  );
  const raw =
    params.get("shellMode") ??
    params.get("shell-mode") ??
    window.ELIZAOS_SHELL_MODE ??
    "";
  if (raw === "chat-overlay") return "chat-overlay";
  if (raw === "tray-popover") return "tray-popover";
  if (raw === "voice-selftest") return "voice-selftest";
  if (raw === "voice-workbench") return "voice-workbench";
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
  // The bar has no inline tab system, so "show a view" / "show the launcher"
  // intents open dedicated on-demand desktop windows instead (#9953 Phase 3).
  useBarSurfaceWindows();
  const controller = useShellControllerContext();
  const overlayOpen = controller?.isOpen ?? false;
  // Escape collapses the overlay first — while it is open, AssistantOverlay's
  // own Escape handler closes it. Once already collapsed, Escape hides the
  // desktop window entirely (#12184) so the pill dismisses to the background
  // like a summoned panel. Desktop-only (web has no window to hide).
  useEffect(() => {
    if (typeof document === "undefined" || !isElectrobunRuntime()) {
      return undefined;
    }
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== "Escape" || overlayOpen) return;
      void invokeDesktopBridgeRequest<void>({
        rpcMethod: "desktopHideWindow",
        ipcChannel: "desktop:hideWindow",
      });
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [overlayOpen]);
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
 * Native tray popover surface (#9953 Phase 4 / #12184). Renders the compact
 * launcher (the `DESKTOP_VIEW_WINDOWS` catalog + "Open Eliza", registered by
 * the desktop host) above the shell widget registry's "home" slot inside the
 * frameless, transparent, always-on-top window the native tray anchors near its
 * icon — no app chrome. Each widget self-hides when it has nothing to show, so
 * the popover is a compact at-a-glance panel + one-click launcher.
 */
function TrayPopoverShell() {
  return (
    <div
      data-testid="tray-popover-shell"
      className="fixed inset-0 flex flex-col gap-3 overflow-y-auto bg-transparent p-3"
    >
      <TrayLauncher />
      <WidgetHost slot="home" layout="stack" />
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
  nav,
}: {
  children: ReactNode;
  className?: string;
  nav?: ReactNode;
}) {
  return (
    <AppWorkspaceChrome
      testId="tab-scroll-view"
      nav={nav}
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

function TabContentView({
  children,
  surface = "opaque",
  nav,
}: {
  children: ReactNode;
  surface?: "opaque" | "transparent";
  nav?: ReactNode;
}) {
  return (
    <AppWorkspaceChrome
      testId="tab-content-view"
      surface={surface}
      nav={nav}
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
  viewKind?: ViewKind;
  backgroundPolicy?: AppShellBackgroundPolicy;
  registration?: AppShellPageRegistration;
  componentExport?: string;
}

function useAppShellPageRegistryVersion(): number {
  return useSyncExternalStore(
    subscribeAppShellPages,
    getAppShellPageRegistrySnapshot,
    getAppShellPageRegistrySnapshot,
  );
}

/**
 * Resolve a tab id against the dynamic registry: first the in-process
 * `registerAppShellPage` registrations, then any loaded plugin's
 * `app.navTabs` declaration. Returns `null` when no plugin claims the tab.
 */
function useResolvedDynamicPage(tab: string): ResolvedDynamicPage | null {
  const plugins = useAppSelector((s) => s.plugins);
  const registryVersion = useAppShellPageRegistryVersion();
  return useMemo(() => {
    void registryVersion;
    const registrations = listAppShellPages();
    const registered = registrations.find((entry) => entry.id === tab);
    if (registered) {
      return {
        id: registered.id,
        pluginId: registered.pluginId,
        developerOnly: registered.developerOnly === true,
        viewKind: registered.viewKind,
        backgroundPolicy: registered.backgroundPolicy,
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
          // A nav tab's own kind wins; otherwise inherit the app's kind.
          viewKind: navTab.viewKind ?? plugin.app?.viewKind,
          backgroundPolicy: navTab.backgroundPolicy,
          registration: reg,
          componentExport: navTab.componentExport,
        };
      }
    }
    return null;
  }, [plugins, registryVersion, tab]);
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
/**
 * Props every app-shell page view receives, mirroring the OverlayAppContext that
 * `DynamicViewLoader` injects on web/desktop. Overlay-app views (polymarket,
 * …) read `t` / `exitToApps` from props and crash ("t is not a
 * function") if mounted with none — which is exactly what happens on iOS/Android
 * where these views render through the in-process app-shell path instead of
 * DynamicViewLoader. Views that read translations from hooks ignore the extras.
 */
function exitAppShellPageToViews(): void {
  if (typeof window !== "undefined") {
    window.history.pushState(null, "", "/views");
    window.dispatchEvent(new PopStateEvent("popstate"));
  }
}
const APP_SHELL_VIEW_PROPS = {
  exitToApps: exitAppShellPageToViews,
  t: (
    key: string,
    options?: { defaultValue?: string } | Record<string, unknown>,
  ): string =>
    typeof options === "object" &&
    options !== null &&
    "defaultValue" in options &&
    typeof options.defaultValue === "string"
      ? options.defaultValue
      : key,
};

function RegisteredAppShellPage({
  registration,
}: {
  registration: AppShellPageRegistration;
}) {
  if (registration.Component) {
    const Component = registration.Component;
    return <Component />;
  }
  if (registration.loader) {
    return (
      <RetainedLazyComponent
        loader={registration.loader}
        cacheKey={registration.id}
        componentProps={APP_SHELL_VIEW_PROPS}
        fallback={
          <div className="flex flex-1 min-h-0 min-w-0 items-center justify-center text-sm text-muted">
            Loading {registration.label}…
          </div>
        }
        onError={(error) => (
          <div className="flex flex-1 min-h-0 min-w-0 items-center justify-center px-4 text-center text-sm text-destructive">
            Failed to load {registration.label}: {error.message}
          </div>
        )}
      />
    );
  }
  return (
    <div className="flex flex-1 min-h-0 min-w-0 items-center justify-center text-sm text-muted">
      {registration.label} is not available in this build.
    </div>
  );
}

function DynamicPluginPage({ resolved }: { resolved: ResolvedDynamicPage }) {
  if (resolved.registration) {
    return <RegisteredAppShellPage registration={resolved.registration} />;
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
  return <RegisteredAppShellPage registration={registration} />;
}

function visibleDynamicPage(
  page: ResolvedDynamicPage | null,
  enabledKinds: EnabledViewKinds,
): page is ResolvedDynamicPage {
  return Boolean(page && isViewVisible(page, enabledKinds));
}

/**
 * Whether the active app-shell page wants to render edge-to-edge with no host
 * top-bar/chrome. Looks the active tab up in the runtime page registry and
 * reads its `fullBleed` flag — backward-compatible: pages that don't set it
 * keep the normal chrome.
 */
function useTabIsFullBleed(tab: string): boolean {
  const registryVersion = useAppShellPageRegistryVersion();
  return useMemo(() => {
    void registryVersion;
    return listAppShellPages().some(
      (entry) => entry.id === tab && entry.fullBleed === true,
    );
  }, [registryVersion, tab]);
}

function useCurrentNavigationPath(): string {
  const [navigationPath, setNavigationPath] = useState(() =>
    typeof window === "undefined" ? "/" : getWindowNavigationPath(),
  );

  useEffect(() => {
    if (typeof window === "undefined") return;
    const handleNavigationChange = () => {
      setNavigationPath(getWindowNavigationPath());
    };
    window.addEventListener("hashchange", handleNavigationChange);
    window.addEventListener("popstate", handleNavigationChange);
    return () => {
      window.removeEventListener("hashchange", handleNavigationChange);
      window.removeEventListener("popstate", handleNavigationChange);
    };
  }, []);

  return navigationPath;
}

function normalizeBackgroundPolicy(
  policy: AppShellBackgroundPolicy | undefined,
): AppShellBackgroundPolicy {
  return policy === "shared" ? "shared" : "opaque";
}

function builtinRouteBackgroundPolicy(
  tab: string,
  navigationPath: string,
): AppShellBackgroundPolicy | null {
  const normalizedPath = trimmedNavigationPath(navigationPath);
  if (tab === "chat" || tab === "background") return "shared";
  if (tab === "settings") return "shared";
  if (tab === "views" && normalizedPath === "/views") return "shared";
  if (tab === "apps" && normalizedPath === "/apps") return "shared";
  return null;
}

function resolveActiveScreenBackgroundPolicy({
  tab,
  navigationPath,
  availableViews,
  viewLayout,
}: {
  tab: string;
  navigationPath: string;
  availableViews: ViewRegistryEntry[];
  viewLayout: ActiveViewLayout | null;
}): AppShellBackgroundPolicy {
  if (viewLayout) return "opaque";

  const appShellPageForRoute = findAppShellPageForRoute(navigationPath);
  if (appShellPageForRoute) {
    return normalizeBackgroundPolicy(appShellPageForRoute.backgroundPolicy);
  }

  const appSlug =
    tab === "apps" || tab === "views"
      ? getAppSlugFromPath(navigationPath)
      : null;
  const remoteView = findRemoteViewForRoute(
    availableViews,
    navigationPath,
    tab,
    appSlug,
  );
  if (remoteView) return normalizeBackgroundPolicy(remoteView.backgroundPolicy);

  const appShellPageForTab = listAppShellPages().find(
    (entry) => entry.id === tab,
  );
  if (appShellPageForTab) {
    return normalizeBackgroundPolicy(appShellPageForTab.backgroundPolicy);
  }

  const builtinPolicy = builtinRouteBackgroundPolicy(tab, navigationPath);
  if (builtinPolicy) return builtinPolicy;

  const registeredView = availableViews.find(
    (view) =>
      view.builtin !== true &&
      (view.id === tab ||
        view.path === navigationPath ||
        view.path === trimmedNavigationPath(navigationPath)),
  );
  if (registeredView) {
    return normalizeBackgroundPolicy(registeredView.backgroundPolicy);
  }

  return "opaque";
}

function useActiveScreenBackgroundPolicy({
  tab,
  navigationPath,
  availableViews,
  viewLayout,
}: {
  tab: string;
  navigationPath: string;
  availableViews: ViewRegistryEntry[];
  viewLayout: ActiveViewLayout | null;
}): AppShellBackgroundPolicy {
  const registryVersion = useAppShellPageRegistryVersion();
  return useMemo(() => {
    void registryVersion;
    return resolveActiveScreenBackgroundPolicy({
      tab,
      navigationPath,
      availableViews,
      viewLayout,
    });
  }, [availableViews, navigationPath, registryVersion, tab, viewLayout]);
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
  "/character/documents",
  "/character/experience",
  "/character/skills",
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

const SHELL_RESERVED_TABS = new Set(Object.keys(TAB_PATHS));

function findRemoteViewForRoute(
  views: ViewRegistryEntry[],
  navigationPath: string,
  tab: string,
  appSlug: string | null,
): ViewRegistryEntry | undefined {
  const normalizedPath = trimmedNavigationPath(navigationPath);
  if (SHELL_RESERVED_PATHS.has(normalizedPath)) return undefined;
  if (tab !== "views" && tab !== "apps" && SHELL_RESERVED_TABS.has(tab)) {
    return undefined;
  }
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

function renderRemoteView(view: ViewRegistryEntry, nav?: ReactNode): ReactNode {
  if (!view.bundleUrl) return null;
  return (
    <TabContentView nav={nav}>
      <DynamicViewLoader
        bundleUrl={view.bundleUrl}
        componentExport={view.componentExport}
        viewId={view.id}
        viewType={view.viewType}
      />
    </TabContentView>
  );
}

function findAppShellPageForRoute(
  navigationPath: string,
): AppShellPageRegistration | undefined {
  const normalizedPath = trimmedNavigationPath(navigationPath);
  return listAppShellPages().find(
    (entry) => trimmedNavigationPath(entry.path) === normalizedPath,
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
  const routeOverrideForView = (
    view: ViewRegistryEntry,
  ): ViewRouterRouteOverride => {
    const navigationPath =
      view.path ??
      (SHELL_RESERVED_TABS.has(view.id)
        ? pathForTab(view.id)
        : `/apps/${view.id}`);
    return {
      navigationPath,
      tab: tabFromPath(navigationPath) ?? view.id,
    };
  };

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
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Close layout"
            title="Close layout"
            data-testid="view-layout-close"
            onClick={onClear}
            className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-sm text-muted transition-colors hover:bg-border/35 hover:text-txt    "
          >
            <X className="h-4 w-4" aria-hidden />
          </Button>
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
                    <ViewRouter routeOverride={routeOverrideForView(view)} />
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
 * inline ChatView — so an unavailable view falls back to the Launcher page
 * of the retained Home/Launcher surface, not a chat surface.
 */
function ViewUnavailableFallback(): ReactNode {
  return <HomeScreenMount initialPage="launcher" />;
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
  if (!getAppSlugFromPath(navigationPath)) {
    return <HomeScreenMount initialPage="launcher" />;
  }
  return (
    <TabContentView>
      <AppsPageView />
    </TabContentView>
  );
}

function renderStaticViewRouterTab({
  tab,
  nativeOsSurfaceEnabled,
  navigationPath,
  settingsInitialSection,
  walletNav,
}: {
  tab: string;
  nativeOsSurfaceEnabled: boolean;
  navigationPath: string;
  settingsInitialSection?: string | null;
  walletNav?: ReactNode;
}): ReactNode {
  const directViews: Record<string, ReactNode> = {
    tutorial: (
      <TabContentView>
        <TutorialView />
      </TabContentView>
    ),
    help: (
      <TabContentView>
        <HelpView />
      </TabContentView>
    ),
    chat: <ViewUnavailableFallback />,
    browser: <BrowserWorkspaceView />,
    stream: <StreamView />,
    tasks: (
      <TabContentView>
        <TasksPageView />
      </TabContentView>
    ),
    automations: <AutomationsFeed />,
    triggers: <AutomationsFeed />,
    settings: (
      <TabContentView surface="transparent">
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
    transcripts: (
      <TabContentView>
        <TranscriptsPageView />
      </TabContentView>
    ),
    relationships: (
      <TabContentView>
        <RelationshipsView />
      </TabContentView>
    ),
    documents: (
      <TabContentView>
        <KnowledgeView />
      </TabContentView>
    ),
    experience: (
      <TabContentView>
        <CharacterExperienceView />
      </TabContentView>
    ),
    "character-skills": (
      <TabContentView>
        <CharacterSkillsView />
      </TabContentView>
    ),
    memories: (
      <TabContentView>
        <MemoryViewerView />
      </TabContentView>
    ),
    files: (
      <TabScrollView>
        <FilesView />
      </TabScrollView>
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
  if (tab === "camera") {
    // Camera is an AOSP-ElizaOS-fork-only surface — gate the route on the same
    // marker as the home tile, so a deep-link off the fork falls back to
    // "unavailable" instead of rendering on web/desktop/iOS/Play-Store Android.
    return renderPhoneSurface(isAospShellEnabled(), CameraPageView);
  }
  if (tab === "phone") {
    return renderPhoneSurface(nativeOsSurfaceEnabled, PhonePageView);
  }
  if (tab === "messages") {
    return renderPhoneSurface(nativeOsSurfaceEnabled, MessagesPageView);
  }
  if (tab === "contacts") {
    return renderPhoneSurface(nativeOsSurfaceEnabled, ContactsPageView);
  }
  if (tab === "views" || tab === "apps") {
    return renderAppsSurface(navigationPath);
  }
  if (tab === "background") {
    // Rendered directly (no opaque TabContentView chrome) so the live app
    // background shows through behind the controls.
    return <BackgroundView />;
  }
  if (tab === "character" || tab === "character-select") {
    return (
      <TabContentView>
        <CharacterEditor />
      </TabContentView>
    );
  }
  if (tab === "inventory") {
    return (
      <TabScrollView nav={walletNav}>
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
  enabledKinds,
  navigationPath,
  availableViews,
  appSlug,
  nativeOsSurfaceEnabled,
  settingsInitialSection,
}: {
  tab: string;
  dynamicPage: ResolvedDynamicPage | null;
  dynamicAppPage: ResolvedDynamicPage | null;
  enabledKinds: EnabledViewKinds;
  navigationPath: string;
  availableViews: ViewRegistryEntry[];
  appSlug: string | null;
  nativeOsSurfaceEnabled: boolean;
  settingsInitialSection?: string | null;
}): ReactNode {
  if (visibleDynamicPage(dynamicPage, enabledKinds)) {
    return (
      <TabContentView>
        <DynamicPluginPage resolved={dynamicPage} />
      </TabContentView>
    );
  }
  if (visibleDynamicPage(dynamicAppPage, enabledKinds)) {
    return (
      <TabContentView>
        <DynamicPluginPage resolved={dynamicAppPage} />
      </TabContentView>
    );
  }
  // Hyperliquid + Polymarket are sub-views of Wallet: the wallet family of
  // routes shares one sub-nav rendered in the workspace chrome nav slot.
  const walletNav = isWalletSectionPath(navigationPath) ? (
    <WalletSectionNav activePath={navigationPath} />
  ) : undefined;

  const appShellPageForRoute = findAppShellPageForRoute(navigationPath);
  if (
    appShellPageForRoute &&
    isViewVisible(appShellPageForRoute, enabledKinds)
  ) {
    return (
      <TabContentView nav={walletNav}>
        <RegisteredAppShellPage registration={appShellPageForRoute} />
      </TabContentView>
    );
  }
  const remoteView = findRemoteViewForRoute(
    availableViews,
    navigationPath,
    tab,
    appSlug,
  );
  if (remoteView?.bundleUrl) return renderRemoteView(remoteView, walletNav);
  return renderStaticViewRouterTab({
    tab,
    nativeOsSurfaceEnabled,
    navigationPath,
    settingsInitialSection,
    walletNav,
  });
}

type ViewRouterRouteOverride = {
  tab: string;
  navigationPath: string;
};

function ViewRouter({
  routeOverride,
  settingsInitialSection,
}: {
  routeOverride?: ViewRouterRouteOverride;
  settingsInitialSection?: string | null;
}) {
  const activeTab = useAppSelector((s) => s.tab);
  const tab = routeOverride?.tab ?? activeTab;
  // Phone / messages / contacts are AOSP-fork-only native-OS surfaces (like
  // camera + the home tiles + the launcher tiles) — never rendered on web,
  // desktop, iOS, or stock Play-Store Android, even via a deep link.
  const nativeOsSurfaceEnabled = isAospShellEnabled();
  const dynamicPage = useResolvedDynamicPage(tab);
  const [navigationPath, setNavigationPath] = useState(
    () =>
      routeOverride?.navigationPath ??
      (typeof window === "undefined" ? "/" : getWindowNavigationPath()),
  );
  const routeOverridePath = routeOverride?.navigationPath;
  const appSlug =
    tab === "apps" || tab === "views"
      ? getAppSlugFromPath(navigationPath)
      : null;
  const dynamicAppPage = useResolvedDynamicPage(appSlug ?? "");
  const enabledKinds = useEnabledViewKinds();

  useEffect(() => {
    if (routeOverridePath) {
      setNavigationPath(routeOverridePath);
      return;
    }
    if (typeof window === "undefined") return;
    const navEvt = shouldUseHashNavigation() ? "hashchange" : "popstate";
    const handleNavigationChange = () => {
      setNavigationPath(getWindowNavigationPath());
    };
    window.addEventListener(navEvt, handleNavigationChange);
    return () => window.removeEventListener(navEvt, handleNavigationChange);
  }, [routeOverridePath]);

  // Available views from /api/views — used to route to DynamicViewLoader
  // when a tab ID matches a view entry that ships a remote bundle URL.
  const { views: availableViews } = useAvailableViews();
  const view = renderViewRouterContent({
    tab,
    dynamicPage,
    dynamicAppPage,
    enabledKinds,
    navigationPath,
    availableViews,
    appSlug,
    nativeOsSurfaceEnabled,
    settingsInitialSection,
  });

  // A distinct lifecycle identity per routed surface: builtin tab id, or
  // tab:slug for a remote/app route so two remote views get independent
  // boundaries + telemetry.
  const activeViewId = appSlug ? `${tab}:${appSlug}` : tab;

  // Split-view panes (routeOverride) keep a simple per-pane crash boundary; only
  // the PRIMARY router drives the single global view-lifecycle controller +
  // keep-alive host, so multiple ViewRouters never fight over the active id.
  if (routeOverride) {
    return (
      <ViewErrorBoundary viewId={`pane:${activeViewId}`}>
        <LazyViewBoundary>{view}</LazyViewBoundary>
      </ViewErrorBoundary>
    );
  }

  // The keep-alive host wraps the active view in a per-view ViewErrorBoundary +
  // ViewTelemetryProfiler + ViewLifecycleSlot and drives the lifecycle
  // controller (pause on app-background / tab-hidden / memory-pressure). With
  // the default unmount-on-hide policy the host mounts exactly the active view —
  // behaviorally identical to the prior single-branch ViewRouter.
  return (
    <KeepAliveViewHost
      activeViewId={activeViewId}
      renderView={(viewId) =>
        viewId === activeViewId ? (
          <LazyViewBoundary>{view}</LazyViewBoundary>
        ) : null
      }
    />
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

// Home/Launcher and Background opt into the unified app background (mounted
// once at the shell root), so their shell is transparent — no `bg-bg` to paint
// over it. Every other view keeps the opaque shell (its own background).
const APP_SHELL_CLASS_TRANSPARENT =
  "flex flex-col flex-1 min-h-0 w-full font-body text-txt";

type ShellContentProps = {
  actionNotice: ActionNotice | null;
  availableViewsForLayout: ViewRegistryEntry[];
  customActionsPanelOpen: boolean;
  desktopTabBar: ReactNode;
  isChat: boolean;
  isFullBleed: boolean;
  screenBackgroundPolicy: AppShellBackgroundPolicy;
  setCustomActionsEditorOpen: (open: boolean) => void;
  setCustomActionsPanelOpen: (open: boolean) => void;
  setEditingAction: (action: import("./api").CustomActionDef | null) => void;
  settingsInitialSection: string | null;
  tab: string;
  uiShellMode: string;
  viewLayout: ActiveViewLayout | null;
  onClearViewLayout: () => void;
};

function ChatRouteShellContent(props: ShellContentProps): ReactNode {
  // The /chat route is the ambient conversational home: open space behind the
  // always-present ContinuousChatOverlay (mounted at the shell root), which is
  // the whole chat experience. Ask it anything, or ask it to open a view ("show
  // me the coding view") which surfaces over this base. The home is wordless,
  // sitting directly on the unified app background (mounted once at the shell
  // root) — its shell is transparent so that background shows through.
  return (
    <div key="chat-shell" className={APP_SHELL_CLASS_TRANSPARENT}>
      <div className="relative flex min-h-0 min-w-0 flex-1 items-center justify-center overflow-hidden">
        <HomeScreenMount initialPage="home" />
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
  // One tight page gutter for every routed view: minimal top so headers sit
  // right under the chrome, a small side gutter, modest bottom. Views that own
  // their full surface (browser/apps/views/background) still get zero padding.
  const pagePadding =
    tab === "browser" ||
    tab === "apps" ||
    tab === "views" ||
    tab === "background"
      ? ""
      : "px-2 sm:px-3 pt-2 pb-4";
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
  // Routes with `backgroundPolicy: "shared"` intentionally sit on the unified
  // Home/Launcher background. Every other route is opaque; the shell root
  // also paints a full-window underlay so status/home-indicator safe areas do
  // not expose the shared background around app views.
  const shellClass =
    props.screenBackgroundPolicy === "shared"
      ? APP_SHELL_CLASS_TRANSPARENT
      : APP_SHELL_CLASS;
  return (
    <div key={`tab-shell-${props.tab}`} className={shellClass}>
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
 * padding. The page owns its full window (e.g. the orchestrator).
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
  return <RoutedShellContent {...props} />;
}

/**
 * Vault modal, loaded on first open (#11351). `SecretsManagerSection` pulls the
 * whole vault surface (tabs, tables, routing editor) plus its data layer; a
 * static import here kept all of it on the eager boot graph even though the
 * modal only ever renders after an explicit open dispatch (launcher row, ⌘⌥⌃V
 * chord, menu accelerator). The open/close state lives in the lightweight
 * `useSecretsManagerModal` hook module, so this mount can subscribe eagerly
 * (never missing an open event) while the modal body stays on a lazy chunk
 * until the first open. After that it stays mounted so close animations and
 * in-modal state behave exactly as before.
 */
const VaultModal = lazy(() =>
  import("./components/settings/SecretsManagerSection").then((m) => ({
    default: m.VaultModal,
  })),
);

function SecretsManagerModalMount(): ReactNode {
  const { isOpen, initialTab, focusKey, focusProfileId, setOpen, clearFocus } =
    useSecretsManagerModalState();
  const [hasOpened, setHasOpened] = useState(false);
  useEffect(() => {
    if (isOpen) setHasOpened(true);
  }, [isOpen]);
  if (!hasOpened) return null;
  return (
    <Suspense fallback={null}>
      <VaultModal
        open={isOpen}
        onOpenChange={setOpen}
        initialTab={initialTab}
        initialFocusKey={focusKey}
        initialFocusProfileId={focusProfileId}
        onConsumeInitial={clearFocus}
      />
    </Suspense>
  );
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
          onVision={controller.captureVision}
          visionActive={controller.visionCapturing}
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
  const { characterData, agentStatus, firstRunComplete } =
    useAppSelectorShallow((s) => ({
      characterData: s.characterData,
      agentStatus: s.agentStatus,
      firstRunComplete: s.firstRunComplete,
    }));
  // #12087 Item 20: derive the slash-command authority from the authoritative
  // role instead of the fail-open defaults. Elevated (owner-only) commands
  // require OWNER; authenticated commands require rank ≥ USER. A remote
  // USER/GUEST no longer sees elevated commands.
  const { isOwner, atLeast } = useRole();
  const slash = useSlashCommandController({
    isElevated: isOwner,
    isAuthorized: atLeast("USER"),
  });
  if (!controller) return null;
  // The live agent's name drives the composer placeholder ("Ask {name}").
  // Character name wins (what the user configured), then the running agent's
  // reported name; "Eliza" is the default the overlay falls back to.
  const agentName =
    characterData?.name?.trim() || agentStatus?.agentName?.trim() || undefined;
  return (
    <ContinuousChatOverlay
      controller={controller}
      agentName={agentName}
      slash={slash}
      firstRunOpen={firstRunComplete === false}
    />
  );
}

/**
 * The iOS-style home dashboard for the /chat route — recent activity, recent
 * messages, and a customizable widget area. Sits beside the retained
 * Launcher page behind the always-present chat overlay. Wires tile taps to the real nav:
 * builtin tabs via setTab, plugin/remote views via the eliza:navigate:view event.
 */
function HomeScreenMount({
  initialPage = "home",
}: {
  initialPage?: "home" | "launcher";
}): ReactNode {
  const setTab = useAppSelector((s) => s.setTab);
  const { views } = useAvailableViews();
  // Host apps can override the home screen via the `homeScreen` boot-config slot
  // (whitelabel seam); fall back to the built-in HomeScreen.
  const { homeScreen: HomeScreenOverride } = useBootConfig();
  const onOpenTile = useCallback(
    (target: HomeTileTarget) => {
      if (target.kind === "tab") {
        setTab(target.tab);
        // Report the tab id as a surface so the proactive decider reacts to
        // user-initiated tile navigation (#8792). Fire-and-forget.
        reportUserViewSwitch(target.tab);
      } else {
        dispatchNavigateViewEvent({ viewPath: target.path });
        // The tile only carries a path; resolve the registered view id so the
        // decider keys off the same id the rest of the navigation bus uses
        // (#8792). Skip the report when no view is registered at that path.
        const viewId = views.find((v) => v.path === target.path)?.id;
        if (viewId) reportUserViewSwitch(viewId, target.path);
      }
    },
    [setTab, views],
  );
  const Home = HomeScreenOverride ?? HomeScreen;
  const home = useMemo(
    () => (
      <Home onOpenTile={onOpenTile} showNativeOsTiles={isAospShellEnabled()} />
    ),
    [Home, onOpenTile],
  );
  const launcher = useMemo(() => <LauncherSurface />, []);
  return (
    <div className="relative min-h-0 min-w-0 flex-1 self-stretch overflow-hidden">
      <HomeLauncherSurface
        home={home}
        launcher={launcher}
        initialPage={initialPage}
      />
    </div>
  );
}

export function App() {
  const {
    startupError,
    startupCoordinator,
    firstRunComplete,
    retryStartup,
    tab,
    setTab,
    setState,
    setActionNotice,
    actionNotice,
    activeOverlayApp,
    uiTheme,
    backendConnection,
    activeGameViewerUrl,
    gameOverlayEnabled,
    uiShellMode,
    uiLanguage,
    t,
  } = useAppSelectorShallow((s) => ({
    startupError: s.startupError,
    startupCoordinator: s.startupCoordinator,
    firstRunComplete: s.firstRunComplete,
    retryStartup: s.retryStartup,
    tab: s.tab,
    setTab: s.setTab,
    setState: s.setState,
    setActionNotice: s.setActionNotice,
    actionNotice: s.actionNotice,
    activeOverlayApp: s.activeOverlayApp,
    uiTheme: s.uiTheme,
    backendConnection: s.backendConnection,
    activeGameViewerUrl: s.activeGameViewerUrl,
    gameOverlayEnabled: s.gameOverlayEnabled,
    uiShellMode: s.uiShellMode,
    uiLanguage: s.uiLanguage,
    t: s.t,
  }));
  const isPopout = useIsPopout();
  const shellMode = useShellMode();
  // Auth gate — only active after the coordinator reaches "ready".
  // During first-run setup / pairing / startup phases the StartupScreen handles
  // its own gate (bootstrap step), so we skip the check.
  const isCoordinatorReady = startupCoordinator.phase === "ready";
  // The live shell may MOUNT once the backend is reached and the agent boot is
  // underway (first-run-required / starting-runtime / hydrating / ready) —
  // first-turn capability then fades in behind it (see useShellController's
  // agentReady). first-run-required paints the shell so onboarding can run IN
  // the live chat. Only the truly pre-shell phases (session restore, backend
  // polling, pairing, error) keep the full-screen StartupScreen.
  // Runtime-dependent effects and overlay apps below stay gated on
  // `isCoordinatorReady` and defer safely.
  const isShellPaintableNow = isShellPaintable(startupCoordinator.phase);

  useEffect(() => {
    if (!isShellPaintableNow) return;

    const handleConnect = async (event: Event): Promise<void> => {
      const detail = (event as CustomEvent<unknown>).detail;
      const payload =
        detail && typeof detail === "object" && !Array.isArray(detail)
          ? (detail as {
              gatewayUrl?: unknown;
              token?: unknown;
              completeFirstRun?: unknown;
              skipConfirm?: unknown;
            })
          : null;
      if (typeof payload?.gatewayUrl !== "string") {
        return;
      }

      const completeFirstRun = payload.completeFirstRun === true;
      const skipConfirm = payload.skipConfirm === true;
      if (!skipConfirm && !isLoopbackGatewayHost(payload.gatewayUrl)) {
        const approved = await confirmDesktopAction({
          type: "warning",
          title: "Connect to this server?",
          message: `Point this app at "${gatewayHostForDisplay(payload.gatewayUrl)}"?`,
          detail:
            "A link asked to connect this app to a different agent server. Only continue if you trust it — that server will handle your messages and data.",
          confirmLabel: "Connect",
          cancelLabel: "Cancel",
        });
        if (!approved) {
          setActionNotice("Connection request cancelled.", "info", 4200);
          return;
        }
      }

      try {
        const connection = applyLaunchConnection({
          kind: "remote",
          apiBase: payload.gatewayUrl,
          token: typeof payload.token === "string" ? payload.token : null,
          allowPublicHttps: true,
        });
        persistMobileRuntimeModeForServerTarget("remote");
        setState("firstRunRuntimeTarget", "remote");
        setState("firstRunRemoteApiBase", connection.apiBase);
        setState("firstRunRemoteToken", connection.token ?? "");
        setState("firstRunRemoteConnected", true);
        setState("firstRunRemoteError", null);
        if (completeFirstRun) {
          await adoptRemoteAgentFirstRun(client, {
            apiBase: connection.apiBase,
            token: connection.token,
            uiLanguage,
          });
          setState("firstRunComplete", true);
          startupCoordinator.dispatch({ type: "FIRST_RUN_COMPLETE" });
        }
        setActionNotice("Connected to remote backend.", "success", 4200);
        retryStartup();
      } catch (err) {
        setActionNotice(
          err instanceof Error
            ? err.message
            : "Failed to connect remote backend.",
          "error",
          8000,
        );
      }
    };

    document.addEventListener(CONNECT_EVENT, handleConnect);
    return () => document.removeEventListener(CONNECT_EVENT, handleConnect);
  }, [
    isShellPaintableNow,
    retryStartup,
    setActionNotice,
    setState,
    startupCoordinator.dispatch,
    uiLanguage,
  ]);

  // Skip the auth probe during first-run-required: there is no agent/session
  // yet, so /api/auth/me would spuriously trip server_unavailable/unauthenticated
  // on top of the in-chat onboarding (see useAuthStatus's own skip-during-first-run
  // note). The in-chat conductor owns the first-run flow.
  const { state: authState, refetch: refetchAuth } = useAuthStatus({
    skip:
      !isShellPaintableNow ||
      startupCoordinator.phase === "first-run-required" ||
      isPopout,
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
  const overlayAppSurfaceActive = Boolean(resolvedOverlayApp);
  const contextMenu = useContextMenu();

  useSecretsManagerShortcut();

  // Warm a small, device-aware subset of lazy route chunks once the shell is
  // ready. The scheduler itself skips hidden/low-memory/save-data sessions.
  useEffect(() => {
    if (startupCoordinator.phase !== "ready" || typeof window === "undefined") {
      return;
    }
    return scheduleRouteViewChunkPrefetch();
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

    const report = (appName: string | null) => {
      void fetchWithCsrf("/api/apps/overlay-presence", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ appName }),
      }).catch(() => {
        /* ignore */
      });
    };

    if (activeOverlayApp === null) {
      report(null);
      return;
    }

    report(activeOverlayApp);
    const intervalId = window.setInterval(
      () => report(activeOverlayApp),
      25_000,
    );
    return () => {
      window.clearInterval(intervalId);
      report(null);
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
  const { views: availableViewsForDesktopTabs } = useRoutableViews();
  const [viewLayout, setViewLayout] = useState<ActiveViewLayout | null>(null);
  const navigationPath = useCurrentNavigationPath();
  const screenBackgroundPolicy = useActiveScreenBackgroundPolicy({
    tab,
    navigationPath,
    availableViews: availableViewsForDesktopTabs,
    viewLayout,
  });
  const renderSharedAppBackground =
    screenBackgroundPolicy === "shared" && !overlayAppSurfaceActive;
  const renderOpaqueAppBackground =
    screenBackgroundPolicy === "opaque" || overlayAppSurfaceActive;

  const [editingAction, setEditingAction] = useState<
    import("./api").CustomActionDef | null
  >(null);
  const [desktopShuttingDown, setDesktopShuttingDown] = useState(false);

  const isChat = tab === "chat";
  const isSettingsPage = tab === "settings";
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

  // Slash-command settings navigation (e.g. `/settings model`): open the
  // settings tab focused on the requested section (or the hub when absent).
  useEffect(() => {
    if (typeof window === "undefined") return;
    const handleNavigateSettings = (event: Event) => {
      const detail = (event as CustomEvent<NavigateSettingsDetail>).detail;
      setSettingsInitialSection(detail?.section ?? null);
      setTab("settings");
    };
    window.addEventListener(NAVIGATE_SETTINGS_EVENT, handleNavigateSettings);
    return () =>
      window.removeEventListener(
        NAVIGATE_SETTINGS_EVENT,
        handleNavigateSettings,
      );
  }, [setTab]);

  // Handle agent-dispatched view navigation events.
  // The VIEWS action (and future agent commands) dispatch this event to navigate
  // the user to a specific view by path or view ID.
  // When the target is "/views" or "/apps" (legacy launcher aliases), we also
  // directly set the tab so the nav bar becomes visible.
  // On desktop, also open the view as a desktop tab if desktopTabEnabled.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const baseHandler = createNavigateViewHandler({
      availableViewsForDesktopTabs,
      closeDesktopTab,
      desktopTabs,
      invokeDesktopBridgeRequest,
      openDesktopTab,
      setActiveDesktopTabId,
      setTab,
      setViewLayout,
    });
    // An agent-dispatched navigate to the Settings view that carries a `subview`
    // deep-links a section. Route it through the same settings state the
    // slash-command path uses (initialSection + #hash) instead of the generic
    // path nav, which would drop the requested section.
    const handleNavigateView = (event: Event) => {
      const detail = (event as CustomEvent<NavigateViewDetail>).detail;
      if (
        detail?.subview &&
        (detail.viewId === "settings" || detail.viewPath === "/settings")
      ) {
        console.debug(
          `[SettingsNavigate] routing subview "${detail.subview}" to SettingsView initialSection`,
        );
        setSettingsInitialSection(detail.subview);
        setTab("settings");
        return;
      }
      baseHandler(event);
    };
    window.addEventListener(NAVIGATE_VIEW_EVENT, handleNavigateView);
    return () =>
      window.removeEventListener(NAVIGATE_VIEW_EVENT, handleNavigateView);
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

    // Dynamic import keeps @capacitor/keyboard (a native-only, devDependency
    // plugin) out of the static module graph, so server consumers that pull in
    // the @elizaos/ui barrel (e.g. plugin-inbox in the Node agent image) don't
    // crash trying to resolve a package that's only installed for mobile.
    void import("@capacitor/keyboard")
      .then(({ Keyboard }) => Keyboard.setScroll({ isDisabled: true }))
      .catch(() => {
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
      reportUserViewSwitch(viewId, dtab.path);
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
  // ptySessions/agentStatus — so the shell subtree stays stable across polls.
  const shellContent = useMemo(
    () => (
      <ShellContent
        actionNotice={actionNotice}
        availableViewsForLayout={availableViewsForDesktopTabs}
        customActionsPanelOpen={customActionsPanelOpen}
        desktopTabBar={desktopTabBar}
        isChat={isChat}
        isFullBleed={isFullBleed}
        screenBackgroundPolicy={screenBackgroundPolicy}
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
      tab,
      uiShellMode,
      actionNotice,
      isChat,
      isFullBleed,
      screenBackgroundPolicy,
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

  // Self-driving voice round-trip test screen — runs the real STT->agent->TTS
  // loop against a known phrase and reports PASS/FAIL with no human in the loop.
  // Self-contained (its own ElizaClient + AudioContext); no app chrome / gate.
  if (shellMode === "voice-selftest") {
    return <VoiceSelfTestShell />;
  }

  // Multi-turn voice SCENARIO player — drives a declarative VoiceScenario through
  // the real STT->agent->TTS loop turn-by-turn and reports a per-turn verdict.
  // Self-contained (its own ElizaClient + AudioContext); no app chrome / gate.
  if (shellMode === "voice-workbench") {
    return <VoiceWorkbenchShell />;
  }

  // OS chat-overlay window — render JUST the floating assistant pill +
  // waveform over a transparent background, no app chrome and no blocking
  // StartupScreen gate. The desktop bottom bar boots straight into this branch
  // (createMainWindow appends ?shellMode=chat-overlay), so a fresh install's
  // FIRST surface is this overlay — the in-chat first-run conductor must mount
  // here too (#9952/#10720): while firstRunComplete is false it seeds the
  // onboarding greeting + choices into the SAME live transcript the overlay
  // renders. The hook self-gates on firstRunComplete, so after onboarding (and
  // on any plain web ?shellMode=chat-overlay load) it is a headless no-op.
  if (shellMode === "chat-overlay") {
    return (
      <BugReportProvider value={bugReport}>
        <ShellControllerProvider>
          <ChatOverlayShell />
          <FirstRunConductorMount />
        </ShellControllerProvider>
        <BugReportModal />
      </BugReportProvider>
    );
  }

  // Native tray popover window — render JUST the widget surface, no app chrome
  // or onboarding gate. The native tray anchors this transparent, always-on-top
  // window beside its icon (#9953 Phase 4).
  if (shellMode === "tray-popover") {
    return (
      <BugReportProvider value={bugReport}>
        <TrayPopoverShell />
        <BugReportModal />
      </BugReportProvider>
    );
  }

  if (!isShellPaintableNow) {
    return (
      <BugReportProvider value={bugReport}>
        <StartupScreen />
        <BugReportModal />
      </BugReportProvider>
    );
  }

  // Auth gate — once the shell is paintable (agent may still be warming up),
  // check /api/auth/me. "loading": wait (fall through to the main shell render).
  // "unauthenticated": render LoginView. "authenticated": proceed.
  // "server_unavailable": show a retryable startup failure.
  if (
    isShellPaintableNow &&
    !isPopout &&
    !firstRunOwnsLoginSurface(startupCoordinator.phase, firstRunComplete)
  ) {
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
            onRetry={() => {
              // This screen is triggered by the AUTH probe failing
              // (useAuthStatus publishes `server_unavailable` after its 10×1s
              // retry budget), so `retryStartup()` alone is a no-op here —
              // the startup coordinator is already in a ready/hydrating phase
              // whose reducer has no RETRY arm. Re-probe auth so a transient
              // outage (agent restart, phone network blip) actually recovers,
              // and still kick the startup retry for the mixed case.
              refetchAuth();
              retryStartup();
            }}
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

  // The app shell renders once paintable (the agent may still be warming up —
  // the chat composer queues sends until first-turn capability fades in; views
  // show their own loading states until the runtime is live). No deprecated
  // first-run overlays — the coordinator handled all of that before this point.

  return (
    <BugReportProvider value={bugReport}>
      <ShellControllerProvider>
        <div
          // SAFE-AREA FILL INVARIANT (do not break): this root stays
          // `position: relative` ONLY. It must NEVER acquire compositor,
          // filter, perspective, or containment declarations. Any of those
          // makes this element the containing block for the fixed background
          // layers below (the opaque `app-opaque-background` underlay and the
          // `AppBackground` wallpaper), so instead of anchoring to the viewport
          // they would anchor to this padded box (top = safe-area-top) — leaving
          // an unfilled band under the notch (the WKWebView host color, brand
          // orange, would show through). Keeping the backgrounds viewport-fixed
          // is what lets every view fill edge-to-edge under the notch while the
          // `paddingTop` below keeps CONTENT notch-aware. Locked by
          // App.safe-area-fill.test.ts.
          className="relative flex h-[100dvh] w-full max-w-full flex-col overflow-hidden"
          // Reserve a TIGHT status-bar inset: enough to clear the notch/Dynamic
          // Island but no oversized empty band above the content (the repeated
          // "too much space at the top" report). Shave the inset down from the
          // full safe area, with a 1.25rem floor so notch-less phones still
          // clear their status bar. Top banners bleed their bg back up via
          // `.mobile-top-banner:first-child` (styles.css). No-op on web.
          style={{
            paddingTop:
              "max(calc(var(--safe-area-top, 0px) - 1.25rem), 1.25rem)",
          }}
        >
          {/* The unified app background, mounted once here so it persists
              seamlessly across shared-background routes. It keeps the
              background event channel mounted for the whole session, but only
              renders the visual wallpaper when the active route opts into the
              Home/Launcher background. */}
          <AppBackground visible={renderSharedAppBackground} />
          {/* Readability scrim for text-dense shared-background views. It sits
              between the wallpaper (z-0) and content (z-10) and covers safe
              areas too. Opaque or overlay-app routes use the plain underlay
              instead, so the wallpaper cannot leak through. */}
          {renderSharedAppBackground && isSettingsPage ? (
            <div
              aria-hidden="true"
              data-testid="app-background-scrim"
              className="pointer-events-none fixed inset-0 z-[1] bg-bg/55"
            />
          ) : null}
          {renderOpaqueAppBackground ? (
            <div
              aria-hidden="true"
              data-testid="app-opaque-background"
              className="pointer-events-none fixed inset-0 z-0 bg-bg"
            />
          ) : null}
          <div className="relative z-10 flex min-h-0 w-full flex-1 flex-col">
            <ConnectionFailedBanner />
            <SystemWarningBanner />
            <ActionBanner />
            <CloudHandoffBanner />
            {shellContent}
          </div>
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
        {/* In-chat first-run conductor (headless) — while firstRunComplete is
            false it seeds the onboarding greeting + choices into the SAME live
            transcript the overlay renders and routes first-run picks to the
            headless finish use case. Renders null. */}
        <FirstRunConductorMount />
        {/* Interactive tutorial: a persistent spotlight overlay that survives
            navigation (it sends the user to Settings, back home, …). Renders
            only when the tutorial is active (launched from the home Tutorial
            tile or the Help view). */}
        <TutorialOverlay />
        {/* Post-login permission priming: a one-time soft-ask modal that walks
            the user through the platform's onboarding permission set (voice,
            location, notifications) BEFORE any OS prompt. Self-gates on
            authenticated + firstRunComplete !== false + no active tutorial, so
            it never collides with the in-chat first-run conductor. Renders null
            when not eligible; re-triggerable from Settings → Permissions. */}
        <PermissionPrimingOverlay />
        {/* Notification center, headless for now: the visible bell is hidden,
            but this still self-boots the notification store (hydrate + live
            stream) and routes interrupt toasts through ActionNotice. Restore
            the floating bell by rendering <NotificationCenter /> in a
            top-right fixed wrapper again (HomePill owns bottom-center). */}
        <NotificationCenter headless />
        <ShellOverlays actionNotice={actionNotice} />
        <SaveCommandModal
          open={contextMenu.saveCommandModalOpen}
          text={contextMenu.saveCommandText}
          onSave={contextMenu.confirmSaveCommand}
          onClose={contextMenu.closeSaveCommandModal}
        />
        <SecretsManagerModalMount />
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
