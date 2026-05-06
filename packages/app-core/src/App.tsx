/**
 * Root App component — routing shell.
 */

import { Keyboard } from "@capacitor/keyboard";
import {
  ArrowDownLeft,
  ArrowLeftRight,
  Layers3,
  ListTodo,
  MessagesSquare,
  PanelLeft,
} from "lucide-react";

import "./components/chat/chat-source-registration";
import { Button, ErrorBoundary } from "@elizaos/ui";
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
import { subscribeDesktopBridgeEvent } from "./bridge/electrobun-rpc";
import { GameViewOverlay } from "./components/apps/GameViewOverlay";
import { getOverlayApp } from "./components/apps/overlay-app-registry";
import { LoginView } from "./components/auth/LoginView";
import { SaveCommandModal } from "./components/chat/SaveCommandModal";
import { TasksEventsPanel } from "./components/chat/TasksEventsPanel";
import { DeferredSetupChecklist } from "./components/cloud/FlaminaGuide";
import { ConversationsSidebar } from "./components/conversations/ConversationsSidebar";
import { CustomActionEditor } from "./components/custom-actions/CustomActionEditor";
import { CustomActionsPanel } from "./components/custom-actions/CustomActionsPanel";
import { ChatView } from "./components/pages/ChatView";
import type { PageScope } from "./components/pages/page-scoped-conversations";
import { SecretsManagerModalRoot } from "./components/settings/SecretsManagerSection";
import { BugReportModal } from "./components/shell/BugReportModal";
import { ConnectionFailedBanner } from "./components/shell/ConnectionFailedBanner";
import { ConnectionLostOverlay } from "./components/shell/ConnectionLostOverlay";
import { Header } from "./components/shell/Header";
import { ShellOverlays } from "./components/shell/ShellOverlays";
import { StartupFailureView } from "./components/shell/StartupFailureView";
import { StartupShell } from "./components/shell/StartupShell";
import { SystemWarningBanner } from "./components/shell/SystemWarningBanner";
import {
  AppWorkspaceChrome,
  type AppWorkspaceChromeProps,
} from "./components/workspace/AppWorkspaceChrome";
import { useBootConfig } from "./config/boot-config-react";
import {
  BugReportProvider,
  useBugReportState,
  useContextMenu,
  useStreamPopoutNavigation,
} from "./hooks";
import { useActivityEvents } from "./hooks/useActivityEvents";
import { useAuthStatus } from "./hooks/useAuthStatus";
import { useSecretsManagerShortcut } from "./hooks/useSecretsManagerShortcut";
import {
  APPS_ENABLED,
  isAndroidPhoneSurfaceEnabled,
  isAppsToolTab,
} from "./navigation";
import { isIOS, isNative } from "./platform/init";
import { useApp } from "./state";
import type { FlaminaGuideTopic } from "./state/types";

const CHAT_MOBILE_BREAKPOINT_PX = 820;
const MOBILE_NAV_PADDING_CLASS =
  "pb-[calc(var(--eliza-mobile-nav-offset,0px)+var(--safe-area-bottom,0px))]";
const WALLET_CHAT_PREFILL_EVENT = "eliza:chat:prefill";
type MobileChatSurface = "left" | "center" | "right";

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

import { InventoryView } from "@elizaos/app-wallet/ui";
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
import { useIsDeveloperMode } from "./state/useDeveloperMode";

// True lazy boundaries: these views are only imported here, so Rollup can
// honour the split into separate chunks.
const AppsPageView = lazyNamedView(
  () => import("./components/pages/AppsPageView"),
  "AppsPageView",
);
const AutomationsDesktopShell = lazyNamedView(
  () => import("./components/pages/AutomationsView"),
  "AutomationsDesktopShell",
);
const BrowserWorkspaceView = lazyNamedView(
  () => import("./components/pages/BrowserWorkspaceView"),
  "BrowserWorkspaceView",
);
const ConnectorsPageView = lazyNamedView(
  () => import("./components/pages/ConnectorsPageView"),
  "ConnectorsPageView",
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
  active: boolean;
  icon: typeof PanelLeft;
  label: string;
  onClick: () => void;
  surface: MobileChatSurface;
}

function MobileChatSurfaceButton({
  active,
  icon: Icon,
  label,
  onClick,
  surface,
}: MobileChatSurfaceButtonProps) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-current={active ? "page" : undefined}
      title={label}
      data-testid={`chat-mobile-surface-${surface}`}
      onClick={onClick}
      className={`inline-flex h-9 w-9 items-center justify-center rounded-md border border-border/40 bg-card/55 text-muted shadow-sm transition-colors hover:text-txt ${
        active ? "border-accent/70 bg-accent text-accent-fg" : ""
      }`}
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
 *   2. A `componentExport` import-spec like `"@elizaos/app-wallet/ui#InventoryView"`,
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

function ViewRouter({
  onCharacterHeaderActionsChange,
}: {
  onCharacterHeaderActionsChange?: (actions: ReactNode | null) => void;
}) {
  const { tab } = useApp();
  const { lifeOpsPageView: LifeOpsPageView } = useBootConfig();
  const androidPhoneSurfaceEnabled = isAndroidPhoneSurfaceEnabled();
  const dynamicPage = useResolvedDynamicPage(tab);
  const developerModeEnabled = useIsDeveloperMode();
  const view = (() => {
    if (dynamicPage && (developerModeEnabled || !dynamicPage.developerOnly)) {
      return (
        <TabContentView>
          <DynamicPluginPage resolved={dynamicPage} />
        </TabContentView>
      );
    }
    switch (tab) {
      case "chat":
        return <ChatView />;
      case "phone":
        return androidPhoneSurfaceEnabled ? (
          <TabContentView chatScope="page-phone">
            <PhonePageView />
          </TabContentView>
        ) : (
          <ChatView />
        );
      case "messages":
        return androidPhoneSurfaceEnabled ? (
          <TabContentView chatScope="page-phone">
            <MessagesPageView />
          </TabContentView>
        ) : (
          <ChatView />
        );
      case "contacts":
        return androidPhoneSurfaceEnabled ? (
          <TabContentView chatScope="page-phone">
            <ContactsPageView />
          </TabContentView>
        ) : (
          <ChatView />
        );
      case "lifeops":
        // LifeOpsPageView owns its own AppWorkspaceChrome (nav rail + main
        // + right chat), so don't double-wrap.
        return LifeOpsPageView ? <LifeOpsPageView /> : <ChatView />;
      case "browser":
        // BrowserWorkspaceView owns its own AppWorkspaceChrome, so don't
        // double-wrap.
        return <BrowserWorkspaceView />;
      case "companion":
        // Companion is now an app — redirect /companion URL to chat
        return <ChatView />;
      case "stream":
        return <StreamView />;
      case "apps":
        // Apps disabled in production builds; fall through to chat
        return APPS_ENABLED ? (
          <TabContentView chatScope="page-apps">
            <AppsPageView />
          </TabContentView>
        ) : (
          <ChatView />
        );
      case "tasks":
        return (
          <TabContentView>
            <TasksPageView />
          </TabContentView>
        );
      case "character":
      case "character-select":
      case "knowledge":
        return (
          <TabContentView chatScope="page-character">
            <CharacterEditor
              onHeaderActionsChange={onCharacterHeaderActionsChange}
            />
          </TabContentView>
        );
      case "inventory":
        return (
          <TabScrollView
            chatScope="page-wallet"
            pageScopedChatPaneProps={buildWalletPageScopedChatPaneProps()}
          >
            <InventoryView />
          </TabScrollView>
        );
      case "connectors":
        return (
          <TabContentView>
            <ConnectorsPageView connectorDesktopPlacement="right" />
          </TabContentView>
        );
      case "automations":
      case "triggers":
        return <AutomationsDesktopShell />;
      case "voice":
        return (
          <TabContentView>
            <SettingsView key="settings-identity" initialSection="identity" />
          </TabContentView>
        );
      case "settings":
        return (
          <TabContentView chatDisabled>
            <SettingsView key="settings-root" />
          </TabContentView>
        );
      case "plugins":
        return (
          <TabContentView>
            <PluginsPageView />
          </TabContentView>
        );
      case "skills":
        return (
          <TabContentView>
            <SkillsView />
          </TabContentView>
        );
      case "trajectories":
        return (
          <TabContentView>
            <TrajectoriesView />
          </TabContentView>
        );
      case "relationships":
        return (
          <TabContentView>
            <RelationshipsView />
          </TabContentView>
        );
      case "memories":
        return (
          <TabContentView>
            <MemoryViewerView />
          </TabContentView>
        );
      case "runtime":
        return (
          <TabContentView>
            <RuntimeView />
          </TabContentView>
        );
      case "database":
        return (
          <TabContentView>
            <DatabasePageView />
          </TabContentView>
        );
      case "logs":
        return (
          <TabContentView>
            <LogsView />
          </TabContentView>
        );
      case "fine-tuning":
      case "advanced":
        return (
          <TabContentView>
            <FineTuningView />
          </TabContentView>
        );
      case "desktop":
        return (
          <TabContentView>
            <DesktopWorkspaceSection />
          </TabContentView>
        );
      default:
        return <ChatView />;
    }
  })();

  return (
    <ErrorBoundary>
      <LazyViewBoundary>{view}</LazyViewBoundary>
    </ErrorBoundary>
  );
}

export function App() {
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

  useStreamPopoutNavigation(setTab);
  useSecretsManagerShortcut();

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

  const isConnectors = tab === "connectors";
  const isCompanionTab = tab === "companion";
  const isChat = tab === "chat";
  const isChatWorkspace = isChat || isConnectors;
  const isCharacterPage =
    tab === "character" || tab === "character-select" || tab === "knowledge";
  const isWallets = tab === "inventory";
  const isHeartbeats = tab === "triggers" || tab === "automations";
  const isSettingsPage = tab === "settings" || tab === "voice";
  const isAppsToolPage = isAppsToolTab(tab);
  const isDesktopWorkspacePage = tab === "desktop";
  const mobileChatControls = useMemo(() => {
    if (!isChatMobileLayout) return null;

    return {
      center: (
        <MobileChatSurfaceButton
          active={mobileChatSurface === "center"}
          icon={MessagesSquare}
          label={t("nav.chat", { defaultValue: "Chat" })}
          onClick={() => setMobileChatSurface("center")}
          surface="center"
        />
      ),
      left: (
        <MobileChatSurfaceButton
          active={mobileChatSurface === "left"}
          icon={PanelLeft}
          label={t("conversations.chats", { defaultValue: "Chats" })}
          onClick={() => setMobileChatSurface("left")}
          surface="left"
        />
      ),
      right: isChat ? (
        <MobileChatSurfaceButton
          active={mobileChatSurface === "right"}
          icon={ListTodo}
          label={t("taskseventspanel.Title", {
            defaultValue: "Tasks & Events",
          })}
          onClick={() => setMobileChatSurface("right")}
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
    () =>
      uiShellMode === "companion" && isCompanionTab && CompanionShell ? (
        <CompanionShell tab="companion" actionNotice={actionNotice} />
      ) : isCompanionTab ? (
        // Native mode with companion tab: the overlay app renders the companion UI.
        // Render an empty shell so the overlay app is unobstructed and no Header appears.
        <div
          key="companion-shell"
          className="flex flex-col flex-1 min-h-0 w-full font-body text-txt bg-bg"
        />
      ) : tab === "stream" ? (
        <div
          key="stream-shell"
          className="flex flex-col flex-1 min-h-0 w-full font-body text-txt bg-bg"
        >
          <Header />
          <main
            className={`flex-1 min-h-0 overflow-hidden ${MOBILE_NAV_PADDING_CLASS}`}
          >
            <LazyViewBoundary>
              <StreamView />
            </LazyViewBoundary>
          </main>
        </div>
      ) : isChatWorkspace ? (
        <div
          key={`chat-shell-${tab}`}
          className="flex flex-col flex-1 min-h-0 w-full font-body text-txt bg-bg"
        >
          <Header
            mobileCenter={mobileChatControls?.center}
            mobileLeft={mobileChatControls?.left}
            pageRightExtras={mobileChatControls?.right}
            tasksEventsPanelOpen={isChat && !isChatMobileLayout}
          />
          <div className="flex flex-1 min-h-0 relative">
            {!isChatMobileLayout && isChat ? (
              <div
                className="pointer-events-none absolute inset-x-0 bottom-0 h-[5.75rem]"
                data-chat-shell-composer-underlay
              />
            ) : null}
            {isChatMobileLayout ? (
              <div
                className={`flex flex-col flex-1 min-h-0 min-w-0 overflow-hidden ${
                  mobileChatSurface === "center" ? "px-2 pt-2" : ""
                }`}
              >
                {mobileChatSurface === "left" ? (
                  <ConversationsSidebar
                    key="chat-sidebar-mobile"
                    mobile
                    onClose={() => setMobileChatSurface("center")}
                  />
                ) : mobileChatSurface === "right" && isChat ? (
                  <TasksEventsPanel
                    open
                    events={activityEvents}
                    clearEvents={clearActivityEvents}
                    mobile
                  />
                ) : isChat ? (
                  <>
                    <DeferredSetupChecklist
                      className="mb-3"
                      onOpenTask={handleDeferredTaskOpen}
                    />
                    <ChatView />
                  </>
                ) : (
                  <LazyViewBoundary>
                    <ConnectorsPageView />
                  </LazyViewBoundary>
                )}
              </div>
            ) : (
              <>
                <ConversationsSidebar key="chat-sidebar-desktop" />
                <div className="flex flex-col flex-1 min-h-0 min-w-0 overflow-hidden">
                  {isChat ? (
                    <>
                      <DeferredSetupChecklist
                        className="mx-3 mb-3 mt-3 xl:mx-5"
                        onOpenTask={handleDeferredTaskOpen}
                      />
                      <ChatView key="chat-view-desktop" />
                    </>
                  ) : (
                    <LazyViewBoundary>
                      <ConnectorsPageView />
                    </LazyViewBoundary>
                  )}
                </div>
                {isChat ? (
                  <TasksEventsPanel
                    open
                    events={activityEvents}
                    clearEvents={clearActivityEvents}
                    collapsed={widgetsPanelCollapsed}
                    onToggleCollapsed={handleToggleWidgetsCollapsed}
                  />
                ) : null}
              </>
            )}
            <CustomActionsPanel
              open={customActionsPanelOpen}
              onClose={() => setCustomActionsPanelOpen(false)}
              onOpenEditor={(action) => {
                setEditingAction(action ?? null);
                setCustomActionsEditorOpen(true);
              }}
            />
          </div>
        </div>
      ) : isHeartbeats ? (
        <div
          key="heartbeats-shell"
          className="flex flex-col flex-1 min-h-0 w-full font-body text-txt bg-bg"
        >
          <Header />
          <div
            className={`flex flex-1 min-h-0 min-w-0 overflow-hidden ${MOBILE_NAV_PADDING_CLASS}`}
          >
            <LazyViewBoundary>
              <AutomationsDesktopShell key="automations-view-desktop" />
            </LazyViewBoundary>
          </div>
        </div>
      ) : isSettingsPage ? (
        <div
          key={`settings-shell-${tab}`}
          className="flex flex-col flex-1 min-h-0 w-full font-body text-txt bg-bg"
        >
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
                      tab === "voice"
                        ? "settings-identity"
                        : tab === "connectors"
                          ? "settings-connectors"
                          : "settings-root"
                    }
                    initialSection={
                      tab === "voice"
                        ? "identity"
                        : tab === "connectors"
                          ? "connectors"
                          : (settingsInitialSection ?? undefined)
                    }
                  />
                </LazyViewBoundary>
              </div>
            }
          />
        </div>
      ) : isWallets ? (
        <div
          key="wallets-shell"
          className="flex flex-col flex-1 min-h-0 w-full font-body text-txt bg-bg"
        >
          <Header />
          <AppWorkspaceChrome
            testId="wallets-workspace"
            chatScope="page-wallet"
            pageScopedChatPaneProps={buildWalletPageScopedChatPaneProps()}
            main={
              <div className="flex flex-col flex-1 min-h-0 min-w-0 overflow-hidden">
                <LazyViewBoundary>
                  <InventoryView />
                </LazyViewBoundary>
              </div>
            }
          />
        </div>
      ) : isCharacterPage ? (
        <div
          key={`character-shell-${tab}`}
          className="flex flex-col flex-1 min-h-0 w-full font-body text-txt bg-bg"
        >
          <Header pageRightExtras={characterHeaderActions} />
          <div
            className={`flex flex-1 min-h-0 min-w-0 overflow-hidden ${MOBILE_NAV_PADDING_CLASS}`}
          >
            <ViewRouter
              onCharacterHeaderActionsChange={setCharacterHeaderActions}
            />
          </div>
        </div>
      ) : isAppsToolPage ? (
        <div
          key={`apps-tool-shell-${tab}`}
          className="flex flex-col flex-1 min-h-0 w-full font-body text-txt bg-bg"
        >
          <Header />
          <div
            className={`flex flex-1 min-h-0 min-w-0 overflow-hidden ${MOBILE_NAV_PADDING_CLASS}`}
          >
            <ViewRouter />
          </div>
        </div>
      ) : isDesktopWorkspacePage ? (
        <div
          key={`desktop-shell-${tab}`}
          className="flex flex-col flex-1 min-h-0 w-full font-body text-txt bg-bg"
        >
          <Header />
          <div
            className={`flex flex-1 min-h-0 min-w-0 ${MOBILE_NAV_PADDING_CLASS}`}
          >
            <LazyViewBoundary>
              <DesktopWorkspaceSection />
            </LazyViewBoundary>
          </div>
        </div>
      ) : (
        <div
          key={`tab-shell-${tab}`}
          className="flex flex-col flex-1 min-h-0 w-full font-body text-txt bg-bg"
        >
          <Header
            pageRightExtras={isCharacterPage ? characterHeaderActions : null}
          />
          <main
            className={`flex flex-1 min-h-0 min-w-0 overflow-hidden ${
              tab === "browser" || tab === "apps"
                ? ""
                : "px-3 xl:px-5 py-4 xl:py-6"
            } ${tab === "browser" ? "" : MOBILE_NAV_PADDING_CLASS}`}
          >
            <ViewRouter
              onCharacterHeaderActionsChange={setCharacterHeaderActions}
            />
          </main>
        </div>
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
    return (
      <BugReportProvider value={bugReport}>
        <StartupShell />
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
      <div
        className="flex h-[100dvh] w-full max-w-full flex-col overflow-hidden"
        style={{
          paddingTop: "var(--safe-area-top, env(safe-area-inset-top, 0px))",
          paddingBottom:
            "var(--safe-area-bottom, env(safe-area-inset-bottom, 0px))",
          paddingLeft: "var(--safe-area-left, env(safe-area-inset-left, 0px))",
          paddingRight:
            "var(--safe-area-right, env(safe-area-inset-right, 0px))",
        }}
      >
        <ConnectionFailedBanner />
        <SystemWarningBanner />
        {shellContent}
      </div>
      {/* Full-screen overlay app — renders whichever overlay app is active */}
      {resolvedOverlayApp && (
        <resolvedOverlayApp.Component
          exitToApps={() => {
            setState("activeOverlayApp", null);
            setTab("apps");
          }}
          uiTheme={uiTheme === "dark" ? "dark" : "light"}
          t={t}
        />
      )}

      {/* Persistent game overlay — stays visible across all tabs */}
      {activeGameViewerUrl && gameOverlayEnabled && tab !== "apps" && (
        <GameViewOverlay />
      )}
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
          className="fixed inset-0 z-[1000] flex items-center justify-center bg-bg/80 backdrop-blur-sm"
          role="status"
          aria-live="polite"
        >
          <div className="rounded-2xl border border-border/60 bg-card/95 px-6 py-5 text-center shadow-2xl">
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
