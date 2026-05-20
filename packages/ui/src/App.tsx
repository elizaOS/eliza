/**
 * Root App component — routing shell.
 */

import { Keyboard } from "@capacitor/keyboard";
import {
  ArrowDownLeft,
  ArrowLeftRight,
  Layers3,
  MessagesSquare,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRightClose,
  PanelRightOpen,
} from "lucide-react";

import "./components/chat/chat-source-registration";
import {
  type ComponentProps,
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
import { CloudVideoBackground } from "./backgrounds/CloudVideoBackground";
import {
  invokeDesktopBridgeRequest,
  subscribeDesktopBridgeEvent,
} from "./bridge/electrobun-rpc";
import { getOverlayAppLazyComponent } from "./components/apps/AppWindowRenderer";
import { GameViewOverlay } from "./components/apps/GameViewOverlay";
import { getOverlayApp } from "./components/apps/overlay-app-registry";
import { LoginView } from "./components/auth/LoginView";
import { SaveCommandModal } from "./components/chat/SaveCommandModal";
import { TasksEventsPanel } from "./components/chat/TasksEventsPanel";
import { DeferredSetupChecklist } from "./components/cloud/FlaminaGuide";
import { ConversationsSidebar } from "./components/conversations/ConversationsSidebar";
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
import { ShellOverlays } from "./components/shell/ShellOverlays";
import { StartupFailureView } from "./components/shell/StartupFailureView";
import { StartupShell } from "./components/shell/StartupShell";
import { SystemWarningBanner } from "./components/shell/SystemWarningBanner";
import { useShellState } from "./components/shell/useShellState";
import { Button } from "./components/ui/button";
import { ErrorBoundary } from "./components/ui/error-boundary";
import {
  AppWorkspaceChrome,
  type AppWorkspaceChromeProps,
} from "./components/workspace/AppWorkspaceChrome";
import { useBootConfig } from "./config/boot-config-react";
import type { CompanionShellComponentProps } from "./config/boot-config-store";
import {
  FOCUS_CONNECTOR_EVENT,
  type FocusConnectorEventDetail,
} from "./events";
import {
  BugReportProvider,
  useBugReportState,
  useContextMenu,
  useRenderGuard,
} from "./hooks";
import { useActivityEvents } from "./hooks/useActivityEvents";
import { useAuthStatus } from "./hooks/useAuthStatus";
import { useSecretsManagerShortcut } from "./hooks/useSecretsManagerShortcut";
import {
  APPS_ENABLED,
  getAppSlugFromPath,
  getWindowNavigationPath,
  isAndroidPhoneSurfaceEnabled,
  isAppsToolTab,
  shouldUseHashNavigation,
} from "./navigation";
import { isIOS, isNative } from "./platform/init";
import { type ActionNotice, useApp } from "./state";
import type { FlaminaGuideTopic } from "./state/types";

const CHAT_MOBILE_BREAKPOINT_PX = 820;
const MOBILE_NAV_PADDING_CLASS =
  "pb-[calc(var(--eliza-mobile-nav-offset,0px)+var(--safe-area-bottom,0px))]";
const WALLET_CHAT_PREFILL_EVENT = "eliza:chat:prefill";
type MobileChatSurface = "left" | "center" | "right";
type NavigateViewDetail = {
  viewId?: string;
  viewPath?: string;
  viewLabel?: string;
  viewType?: "gui" | "tui";
  action?: string;
};

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
import {
  type AppShellPageRegistration,
  listAppShellPages,
} from "./app-shell-components";
// Static imports for views that AppWindowRenderer (and DetachedShellRoot)
// also import statically. WHY not lazy here: a `lazy()` for a module that
// any other importer pulls eagerly is folded back into the main chunk by
// Rollup with a warning, since the dynamic boundary can't actually defer
// load. Going all-static makes the load path honest. If you want true
// route-level splitting back, lift `lazy()` to a single owning call site.
import { CharacterEditor } from "./components/character/CharacterEditor";
import { DesktopTabBar } from "./components/desktop/DesktopTabBar";
import { DatabasePageView } from "./components/pages/DatabasePageView";
import { LogsView } from "./components/pages/LogsView";
import { MemoryViewerView } from "./components/pages/MemoryViewerView";
import { PluginsPageView } from "./components/pages/PluginsPageView";
import { RelationshipsView } from "./components/pages/RelationshipsView";
import { RuntimeView } from "./components/pages/RuntimeView";
import { SkillsView } from "./components/pages/SkillsView";
import { TasksPageView } from "./components/pages/TasksPageView";
import { TrajectoriesView } from "./components/pages/TrajectoriesView";
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

function prefillWalletChat(text: string): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent(WALLET_CHAT_PREFILL_EVENT, {
      detail: { text, select: true },
    }),
  );
}

function WalletChatGuideBody() {
  const items = [
    {
      icon: ArrowLeftRight,
      label: "Swap, bridge, send, or receive",
    },
    {
      icon: Layers3,
      label: "Inspect tokens, NFTs, LPs, and activity",
    },
    {
      icon: MessagesSquare,
      label: "Ask how the agent can use this wallet",
    },
  ];

  return (
    <div className="grid gap-2">
      {items.map((item) => (
        <div
          key={item.label}
          className="flex items-center gap-2 text-xs-tight text-muted"
        >
          <item.icon className="h-3.5 w-3.5 shrink-0 text-accent" />
          <span>{item.label}</span>
        </div>
      ))}
    </div>
  );
}

function WalletChatGuideActions() {
  const actions = [
    {
      label: "Swap",
      prompt:
        "Prepare a wallet swap. Ask me for source token, destination token, amount, slippage, and route before any transaction.",
      icon: ArrowLeftRight,
    },
    {
      label: "Bridge",
      prompt:
        "Prepare a bridge. Ask me for token, amount, destination address, destination network requirements, and route before any transaction.",
      icon: Layers3,
    },
    {
      label: "Receive",
      prompt:
        "Show the EVM and Solana receive addresses available in this wallet and ask which address I want to use.",
      icon: ArrowDownLeft,
    },
  ];

  return (
    <>
      {actions.map((action) => (
        <Button
          key={action.label}
          variant="outline"
          size="sm"
          className="rounded-full"
          onClick={() => prefillWalletChat(action.prompt)}
        >
          <action.icon className="mr-1.5 h-3.5 w-3.5" />
          {action.label}
        </Button>
      ))}
    </>
  );
}

interface MobileChatSurfaceButtonProps {
  icon: typeof PanelLeftOpen;
  label: string;
  onClick: () => void;
  surface: MobileChatSurface;
}

function MobileChatSurfaceButton({
  icon: Icon,
  label,
  onClick,
  surface,
}: MobileChatSurfaceButtonProps) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      data-testid={`chat-mobile-surface-${surface}`}
      onClick={onClick}
      className="inline-flex h-9 w-9 items-center justify-center rounded-md border border-border/40 bg-card/80 text-muted shadow-sm  transition-colors hover:text-txt"
    >
      <Icon className="h-4 w-4" aria-hidden />
    </button>
  );
}

function buildWalletPageScopedChatPaneProps(): NonNullable<
  AppWorkspaceChromeProps["pageScopedChatPaneProps"]
> {
  return {
    persistentIntro: true,
    placeholderOverride: "Ask about how the agent can use a wallet",
    introOverride: {
      title: "Wallet agent",
      body: <WalletChatGuideBody />,
      actions: <WalletChatGuideActions />,
    },
  };
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

function TabScrollView({
  children,
  className = "",
  chat,
  chatScope,
  pageScopedChatPaneProps,
}: {
  children: ReactNode;
  className?: string;
  chat?: ReactNode;
  chatScope?: PageScope;
  pageScopedChatPaneProps?: AppWorkspaceChromeProps["pageScopedChatPaneProps"];
}) {
  return (
    <AppWorkspaceChrome
      testId="tab-scroll-view"
      chat={chat}
      chatScope={chat ? undefined : chatScope}
      pageScopedChatPaneProps={chat ? undefined : pageScopedChatPaneProps}
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
  chatScope,
  chatDisabled = false,
}: {
  children: ReactNode;
  chatScope?: PageScope;
  chatDisabled?: boolean;
}) {
  const { activeGameRunId, appsSubTab } = useApp();
  const gameOwnsChat =
    chatScope === "page-apps" &&
    appsSubTab === "games" &&
    activeGameRunId.trim().length > 0;

  return (
    <AppWorkspaceChrome
      testId="tab-content-view"
      chatScope={chatScope}
      chatDisabled={chatDisabled || gameOwnsChat}
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

function renderPhoneSurface(
  enabled: boolean,
  Component: ComponentType,
): ReactNode {
  return enabled ? (
    <TabContentView chatScope="page-phone">
      <Component />
    </TabContentView>
  ) : (
    <ChatView />
  );
}

function renderAppsSurface(navigationPath: string): ReactNode {
  if (!APPS_ENABLED) return <ChatView />;
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
    chat: <ChatView />,
    browser: <BrowserWorkspaceView />,
    companion: <ChatView />,
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
    return LifeOpsPageView ? <LifeOpsPageView /> : <ChatView />;
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
      <TabScrollView
        chatScope="page-wallet"
        pageScopedChatPaneProps={buildWalletPageScopedChatPaneProps()}
      >
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
  return directViews[tab] ?? <ChatView />;
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

function pathForNavigateViewDetail(detail: NavigateViewDetail): string | null {
  return detail.viewPath ?? (detail.viewId ? `/apps/${detail.viewId}` : null);
}

function directTabForNavigateView(
  detail: NavigateViewDetail,
  path: string,
): "views" | "apps" | null {
  if (path === "/views") return "views";
  if (path === "/apps") return "apps";
  if (detail.viewId === "views-manager" && detail.viewType !== "tui") {
    return "views";
  }
  return null;
}

function navigateBrowserPath(path: string): void {
  if (typeof window === "undefined") return;
  try {
    if (window.location.protocol === "file:") {
      window.location.hash = path;
      return;
    }
    window.history.pushState(null, "", path);
    window.dispatchEvent(new PopStateEvent("popstate"));
  } catch {
    return;
  }
}

function desktopEntryForDetail(
  views: ViewRegistryEntry[],
  viewId: string,
): ViewRegistryEntry | undefined {
  return views.find((view) => view.id === viewId);
}

const APP_SHELL_CLASS =
  "flex flex-col flex-1 min-h-0 w-full font-body text-txt bg-bg";

type ShellContentProps = {
  CompanionShell: ComponentType<CompanionShellComponentProps> | undefined;
  actionNotice: ActionNotice | null;
  activityEvents: ComponentProps<typeof TasksEventsPanel>["events"];
  characterHeaderActions: ReactNode | null;
  clearActivityEvents: ComponentProps<typeof TasksEventsPanel>["clearEvents"];
  customActionsPanelOpen: boolean;
  desktopTabBar: ReactNode;
  handleDeferredTaskOpen: (task: FlaminaGuideTopic) => void;
  handleToggleWidgetsCollapsed: (next: boolean) => void;
  isAppsToolPage: boolean;
  isCharacterPage: boolean;
  isChat: boolean;
  isChatMobileLayout: boolean;
  isChatWorkspace: boolean;
  isCompanionTab: boolean;
  isDesktopWorkspacePage: boolean;
  isHeartbeats: boolean;
  isSettingsPage: boolean;
  isWallets: boolean;
  mobileChatControls: { left: ReactNode; right: ReactNode } | null;
  mobileChatSurface: MobileChatSurface;
  setCharacterHeaderActions: (actions: ReactNode | null) => void;
  setCustomActionsEditorOpen: (open: boolean) => void;
  setCustomActionsPanelOpen: (open: boolean) => void;
  setEditingAction: (action: import("./api").CustomActionDef | null) => void;
  setMobileChatSurface: (surface: MobileChatSurface) => void;
  settingsInitialSection: string | null;
  tab: string;
  uiShellMode: string;
  widgetsPanelCollapsed: boolean;
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

function ChatWorkspaceShellContent(props: ShellContentProps): ReactNode {
  return (
    <div key={`chat-shell-${props.tab}`} className={APP_SHELL_CLASS}>
      <Header
        mobileLeft={props.mobileChatControls?.left}
        pageRightExtras={props.mobileChatControls?.right}
        tasksEventsPanelOpen={props.isChat && !props.isChatMobileLayout}
        hideNav={props.isChat}
      />
      <div className="flex flex-1 min-h-0 relative">
        {!props.isChatMobileLayout && props.isChat ? (
          <div
            className="pointer-events-none absolute inset-x-0 bottom-0 h-[5.75rem]"
            data-chat-shell-composer-underlay
          />
        ) : null}
        {props.isChatMobileLayout ? (
          <MobileChatWorkspaceShellContent {...props} />
        ) : (
          <DesktopChatWorkspaceShellContent {...props} />
        )}
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

function MobileChatWorkspaceShellContent(props: ShellContentProps): ReactNode {
  const surfacePadding =
    props.mobileChatSurface === "center" ? "px-2 pt-2" : "";
  return (
    <div
      className={`flex flex-col flex-1 min-h-0 min-w-0 overflow-hidden ${surfacePadding}`}
    >
      {props.mobileChatSurface === "left" ? (
        <ConversationsSidebar
          key="chat-sidebar-mobile"
          mobile
          onClose={() => props.setMobileChatSurface("center")}
        />
      ) : props.mobileChatSurface === "right" && props.isChat ? (
        <TasksEventsPanel
          open
          events={props.activityEvents}
          clearEvents={props.clearActivityEvents}
          mobile
        />
      ) : (
        <>
          <DeferredSetupChecklist
            className="mb-3"
            onOpenTask={props.handleDeferredTaskOpen}
          />
          <ChatView />
        </>
      )}
    </div>
  );
}

function DesktopChatWorkspaceShellContent(props: ShellContentProps): ReactNode {
  return (
    <>
      <ConversationsSidebar key="chat-sidebar-desktop" />
      <div className="flex flex-col flex-1 min-h-0 min-w-0 overflow-hidden">
        <DeferredSetupChecklist
          className="mx-3 mb-3 mt-3 xl:mx-5"
          onOpenTask={props.handleDeferredTaskOpen}
        />
        <ChatView key="chat-view-desktop" />
      </div>
      {props.isChat ? (
        <TasksEventsPanel
          open
          events={props.activityEvents}
          clearEvents={props.clearActivityEvents}
          collapsed={props.widgetsPanelCollapsed}
          onToggleCollapsed={props.handleToggleWidgetsCollapsed}
        />
      ) : null}
    </>
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
        chatScope="page-settings"
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
        chatScope="page-wallet"
        pageScopedChatPaneProps={buildWalletPageScopedChatPaneProps()}
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
      <Header pageRightExtras={headerActions} />
      {props.desktopTabBar}
      <main className={routedShellMainClass(props.tab)}>
        <ViewRouter
          onCharacterHeaderActionsChange={props.setCharacterHeaderActions}
        />
      </main>
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
  const companionContent = CompanionShellContent(props);
  if (companionContent) return companionContent;
  if (props.tab === "stream") return <StreamShellContent />;
  if (props.isChatWorkspace) return <ChatWorkspaceShellContent {...props} />;
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
  const app = useApp();
  const { state, send } = useShellState();

  // Drive BOOT_READY from Shaw's startup coordinator.
  const ready = app.startupCoordinator.phase === "ready";
  useEffect(() => {
    if (ready) send({ type: "BOOT_READY" });
  }, [ready, send]);

  // v1: mocked agent. Echoes the user's text after 400ms. When the agent
  // integration sub-project lands, replace this with a real `client` stream
  // subscription that pushes RESPONSE_DELTA / RESPONSE_DONE / RESPONSE_ERROR.
  const onSend = useCallback(
    (text: string) => {
      send({ type: "SEND", text });
      window.setTimeout(() => {
        send({ type: "RESPONSE_DELTA", delta: `Echo: ${text}` });
        send({ type: "RESPONSE_DONE" });
      }, 400);
    },
    [send],
  );

  const onOpen = useCallback(() => send({ type: "OPEN" }), [send]);
  const onClose = useCallback(() => send({ type: "CLOSE" }), [send]);

  // Match shellReducer's SEND guard exactly. The reducer only accepts SEND
  // from `summoned` or `listening`; offering input while `responding` would
  // silently drop the user's text.
  const canSend = state.phase === "summoned" || state.phase === "listening";

  return (
    <>
      <HomePill phase={state.phase} onOpen={onOpen} onClose={onClose} />
      <AssistantOverlay phase={state.phase} onClose={onClose}>
        <ChatSurface
          messages={state.messages}
          onSend={onSend}
          canSend={canSend}
          greeting={greetingForTimeOfDay()}
        />
      </AssistantOverlay>
    </>
  );
}

export function App() {
  useRenderGuard("App");
  const {
    startupError,
    startupCoordinator,
    onboardingComplete,
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
  // Auth gate — only active after the coordinator reaches "ready".
  // During onboarding / pairing / startup phases the StartupShell handles
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

  const [widgetsPanelCollapsed, setWidgetsPanelCollapsed] = useState(() => {
    if (typeof window === "undefined") return false;
    try {
      return (
        window.localStorage.getItem("elizaos:chat:widgets-collapsed") === "true"
      );
    } catch {
      return false;
    }
  });
  const handleToggleWidgetsCollapsed = useCallback((next: boolean) => {
    setWidgetsPanelCollapsed(next);
    try {
      window.localStorage.setItem(
        "elizaos:chat:widgets-collapsed",
        String(next),
      );
    } catch {
      // localStorage unavailable in sandboxed environments — non-fatal.
    }
  }, []);
  const { events: activityEvents, clearEvents: clearActivityEvents } =
    useActivityEvents();
  const [editingAction, setEditingAction] = useState<
    import("./api").CustomActionDef | null
  >(null);
  const [isChatMobileLayout, setIsChatMobileLayout] = useState(() =>
    typeof window !== "undefined"
      ? window.innerWidth < CHAT_MOBILE_BREAKPOINT_PX
      : false,
  );
  const [mobileChatSurface, setMobileChatSurface] =
    useState<MobileChatSurface>("center");
  const [desktopShuttingDown, setDesktopShuttingDown] = useState(false);
  const [characterHeaderActions, setCharacterHeaderActions] =
    useState<ReactNode | null>(null);

  const isCompanionTab = tab === "companion";
  const isChat = tab === "chat";
  const isChatWorkspace = isChat;
  const isCharacterPage =
    tab === "character" || tab === "character-select" || tab === "documents";
  const isWallets = tab === "inventory";
  const isHeartbeats = tab === "triggers" || tab === "automations";
  const isSettingsPage = tab === "settings" || tab === "voice";
  const isAppsToolPage = isAppsToolTab(tab);
  const isDesktopWorkspacePage = tab === "desktop";
  const mobileChatControls = useMemo(() => {
    if (!isChatMobileLayout) return null;

    const leftLabel = t("conversations.chats", { defaultValue: "Chats" });
    const rightLabel = t("taskseventspanel.Title", {
      defaultValue: "Tasks & Events",
    });
    const leftOpen = mobileChatSurface === "left";
    const rightOpen = mobileChatSurface === "right";

    return {
      // Left toggle: only render when nothing else is open OR it's the active one.
      // Tapping again returns to center.
      left: rightOpen ? null : (
        <MobileChatSurfaceButton
          icon={leftOpen ? PanelLeftClose : PanelLeftOpen}
          label={leftOpen ? `Hide ${leftLabel}` : `Show ${leftLabel}`}
          onClick={() => setMobileChatSurface(leftOpen ? "center" : "left")}
          surface="left"
        />
      ),
      // Right toggle: only on chat tab, hidden when left is open.
      right:
        isChat && !leftOpen ? (
          <MobileChatSurfaceButton
            icon={rightOpen ? PanelRightClose : PanelRightOpen}
            label={rightOpen ? `Hide ${rightLabel}` : `Show ${rightLabel}`}
            onClick={() => setMobileChatSurface(rightOpen ? "center" : "right")}
            surface="right"
          />
        ) : null,
    };
  }, [isChat, isChatMobileLayout, mobileChatSurface, t]);

  // Keep hook order stable across onboarding/auth state transitions.
  // Otherwise React can throw when onboarding completes and the main shell mounts.
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
    const handleNavigateView = (event: Event) => {
      const detail = (event as CustomEvent<NavigateViewDetail>).detail;
      if (!detail) return;
      const path = pathForNavigateViewDetail(detail);
      if (!path) return;
      const directTab = directTabForNavigateView(detail, path);
      if (directTab) {
        setTab(directTab);
        return;
      }
      if (detail.action === "open-window" && detail.viewId) {
        const entry = desktopEntryForDetail(
          availableViewsForDesktopTabs,
          detail.viewId,
        );
        const viewPath = entry?.path ?? `/apps/${detail.viewId}`;
        const viewLabel = entry?.label ?? detail.viewId;
        void invokeDesktopBridgeRequest<{ id: string }>({
          rpcMethod: "desktopOpenAppWindow",
          ipcChannel: "desktop:openAppWindow",
          params: {
            title: viewLabel,
            path: viewPath,
            alwaysOnTop: false,
          },
        }).catch(() => {
          // Not in Electrobun runtime — fall through to URL navigation.
        });
        return;
      }
      if (detail.viewId) {
        const entry = desktopEntryForDetail(
          availableViewsForDesktopTabs,
          detail.viewId,
        );
        if (entry && (detail.action === "pin-tab" || entry.desktopTabEnabled)) {
          openDesktopTab(entry);
          setActiveDesktopTabId(entry.id);
        }
      }
      navigateBrowserPath(path);
    };
    window.addEventListener("eliza:navigate:view", handleNavigateView);
    return () =>
      window.removeEventListener("eliza:navigate:view", handleNavigateView);
  }, [setTab, availableViewsForDesktopTabs, openDesktopTab]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const handleResize = () => {
      setIsChatMobileLayout(window.innerWidth < CHAT_MOBILE_BREAKPOINT_PX);
    };
    handleResize();
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, []);

  useEffect(() => {
    if (!isChatMobileLayout) {
      setMobileChatSurface("center");
    }
  }, [isChatMobileLayout]);

  useEffect(() => {
    if (!isChatWorkspace) {
      setMobileChatSurface("center");
    }
    if (!isChat && mobileChatSurface === "right") {
      setMobileChatSurface("center");
    }
  }, [isChat, isChatWorkspace, mobileChatSurface]);

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
  // Loading is handled entirely by StartupShell — no separate loader needed.

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
        activityEvents={activityEvents}
        characterHeaderActions={characterHeaderActions}
        clearActivityEvents={clearActivityEvents}
        customActionsPanelOpen={customActionsPanelOpen}
        desktopTabBar={desktopTabBar}
        handleDeferredTaskOpen={handleDeferredTaskOpen}
        handleToggleWidgetsCollapsed={handleToggleWidgetsCollapsed}
        isAppsToolPage={isAppsToolPage}
        isCharacterPage={isCharacterPage}
        isChat={isChat}
        isChatMobileLayout={isChatMobileLayout}
        isChatWorkspace={isChatWorkspace}
        isCompanionTab={isCompanionTab}
        isDesktopWorkspacePage={isDesktopWorkspacePage}
        isHeartbeats={isHeartbeats}
        isSettingsPage={isSettingsPage}
        isWallets={isWallets}
        mobileChatControls={mobileChatControls}
        mobileChatSurface={mobileChatSurface}
        setCharacterHeaderActions={setCharacterHeaderActions}
        setCustomActionsEditorOpen={setCustomActionsEditorOpen}
        setCustomActionsPanelOpen={setCustomActionsPanelOpen}
        setEditingAction={setEditingAction}
        setMobileChatSurface={setMobileChatSurface}
        settingsInitialSection={settingsInitialSection}
        tab={tab}
        uiShellMode={uiShellMode}
        widgetsPanelCollapsed={widgetsPanelCollapsed}
      />
    ),
    [
      CompanionShell,
      tab,
      uiShellMode,
      isCompanionTab,
      actionNotice,
      isChat,
      isChatWorkspace,
      isCharacterPage,
      isHeartbeats,
      isSettingsPage,
      isWallets,
      isAppsToolPage,
      isDesktopWorkspacePage,
      isChatMobileLayout,
      mobileChatSurface,
      mobileChatControls,
      characterHeaderActions,
      handleDeferredTaskOpen,
      activityEvents,
      clearActivityEvents,
      customActionsPanelOpen,
      handleToggleWidgetsCollapsed,
      settingsInitialSection,
      widgetsPanelCollapsed,
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

  // StartupCoordinator gate — the coordinator is the sole startup authority.
  // Non-ready phases are handled by StartupShell (which renders the appropriate
  // view for each coordinator phase: loading, pairing, onboarding, or error).
  if (startupCoordinator.phase !== "ready" || !onboardingComplete) {
    const preAgentBackgroundStyle = isNative
      ? { height: "100%" }
      : { minHeight: "100vh" };
    const preAgentShellClassName = isNative
      ? "flex h-full min-h-0 w-full flex-col text-txt"
      : "flex min-h-[100vh] w-full flex-col text-txt";

    // Pre-agent / home-screen surface: ORANGE theme over CLOUDS, BLACK text per
    // brand. xs corners. The CloudVideoBackground itself handles
    // prefers-reduced-motion (pauses video, leaves poster). No glass overlay.
    return (
      <BugReportProvider value={bugReport}>
        <CloudVideoBackground
          speed="8x"
          basePath="/clouds"
          poster="/clouds/poster-960.jpg"
          animated={false}
          scrim={0.05}
          style={preAgentBackgroundStyle}
        >
          <div
            data-testid="pre-agent-cloud-shell"
            className={preAgentShellClassName}
            style={{ borderRadius: "var(--radius-xs, 2px)" }}
          >
            <StartupShell />
          </div>
        </CloudVideoBackground>
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

  // Coordinator is at "ready" — the app shell renders. No legacy onboarding
  // overlays — the coordinator handled all of that before reaching ready.

  return (
    <BugReportProvider value={bugReport}>
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
      <ShellOverlays actionNotice={actionNotice} />
      {isCoordinatorReady && <ShellFoundationMount />}
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
          <div className="rounded border border-border/60 bg-card/95 px-6 py-5 text-center shadow-sm">
            <div className="text-base font-semibold text-txt">
              Shutting down…
            </div>
            <div className="mt-1 text-sm text-muted">
              Closing services and saving state.
            </div>
          </div>
        </div>
      ) : null}
    </BugReportProvider>
  );
}
