/**
 * Root App component — routing shell.
 */

import { Keyboard } from "@capacitor/keyboard";

import { subscribeDesktopBridgeEvent } from "./bridge/electrobun-rpc";
import { isIOS, isNative } from "./platform/init";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import { AppsPageView } from "./components/pages/AppsPageView";
import { BrowserWorkspaceView } from "./components/pages/BrowserWorkspaceView";
import { BugReportModal } from "./components/shell/BugReportModal";
import { CharacterEditor } from "./components/character/CharacterEditor";
import { ChatView } from "./components/pages/ChatView";
import { ConnectionFailedBanner } from "./components/shell/ConnectionFailedBanner";
import { ConnectionLostOverlay } from "./components/shell/ConnectionLostOverlay";
import { ConversationsSidebar } from "./components/conversations/ConversationsSidebar";
import { CustomActionEditor } from "./components/custom-actions/CustomActionEditor";
import { CustomActionsPanel } from "./components/custom-actions/CustomActionsPanel";
import { DatabasePageView } from "./components/pages/DatabasePageView";
import { ConnectorsPageView } from "./components/pages/ConnectorsPageView";
import { DesktopWorkspaceSection } from "./components/settings/DesktopWorkspaceSection";
import { FineTuningView } from "@elizaos/app-training/ui/FineTuningView";
import { GameViewOverlay } from "./components/apps/GameViewOverlay";
import { Header } from "./components/shell/Header";
import { AutomationsView } from "./components/pages/AutomationsView";
import { HeartbeatsDesktopShell } from "./components/pages/HeartbeatsView";
import { HeartbeatsView } from "./components/pages/HeartbeatsView";
import { InventoryView } from "./components/pages/InventoryView";
import { LogsPageView } from "./components/pages/LogsPageView";
import { MemoryViewerView } from "./components/pages/MemoryViewerView";
import { PluginsPageView } from "./components/pages/PluginsPageView";
import { RelationshipsView } from "./components/pages/RelationshipsView";
import { RuntimeView } from "./components/pages/RuntimeView";
import { SaveCommandModal } from "./components/chat/SaveCommandModal";
import { SettingsView } from "./components/pages/SettingsView";
import { ShellOverlays } from "./components/shell/ShellOverlays";
import { SkillsView } from "./components/pages/SkillsView";
import { StartupShell } from "./components/shell/StartupShell";
import { StreamView } from "./components/pages/StreamView";
import { SystemWarningBanner } from "./components/shell/SystemWarningBanner";
import { TasksPageView } from "./components/pages/TasksPageView";
import { TrajectoriesView } from "./components/pages/TrajectoriesView";
import { getOverlayApp } from "./components/apps/overlay-app-registry";
import { TasksEventsPanel } from "./components/chat/TasksEventsPanel";
import { DeferredSetupChecklist } from "./components/cloud/FlaminaGuide";
import { useBootConfig } from "./config";
import { MusicPlayerGlobal } from "./components/music/MusicPlayerGlobal";
import {
  BugReportProvider,
  useBugReportState,
  useContextMenu,
  useStreamPopoutNavigation,
} from "./hooks";
import { useActivityEvents } from "./hooks/useActivityEvents";
import { APPS_ENABLED, isAppsToolTab } from "./navigation";
import { useApp } from "./state";
import type { FlaminaGuideTopic } from "./state/types";
import { Button, DrawerSheet, DrawerSheetContent, DrawerSheetHeader, DrawerSheetTitle, ErrorBoundary } from "@elizaos/ui";

const CHAT_MOBILE_BREAKPOINT_PX = 820;
const CHAT_DESKTOP_COMPOSER_UNDERLAY_CLASS =
  "pointer-events-none absolute inset-x-0 bottom-0 h-[5.75rem]";

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
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      data-shell-scroll-region="true"
      className={`flex-1 min-h-0 min-w-0 w-full overflow-y-auto ${className}`}
    >
      {children}
    </div>
  );
}

function TabContentView({ children }: { children: ReactNode }) {
  return (
    <div className="flex flex-col flex-1 min-h-0 min-w-0 w-full overflow-hidden">
      {children}
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
  const view = (() => {
    switch (tab) {
      case "chat":
        return <ChatView />;
      case "lifeops":
        return LifeOpsPageView ? (
          <TabScrollView>
            <LifeOpsPageView />
          </TabScrollView>
        ) : (
          <ChatView />
        );
      case "browser":
        return (
          <TabContentView>
            <BrowserWorkspaceView />
          </TabContentView>
        );
      case "companion":
        // Companion is now an app — redirect /companion URL to chat
        return <ChatView />;
      case "stream":
        return <StreamView />;
      case "apps":
        // Apps disabled in production builds; fall through to chat
        return APPS_ENABLED ? (
          <TabScrollView>
            <AppsPageView />
          </TabScrollView>
        ) : (
          <ChatView />
        );
      case "tasks":
        return (
          <TabContentView>
            <AutomationsView />
          </TabContentView>
        );
      case "character":
      case "character-select":
      case "knowledge":
        return (
          <TabContentView>
            <CharacterEditor
              onHeaderActionsChange={onCharacterHeaderActionsChange}
            />
          </TabContentView>
        );
      case "inventory":
        return (
          <TabScrollView>
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
        return (
          <TabContentView>
            <AutomationsView />
          </TabContentView>
        );
      case "voice":
        return (
          <TabContentView>
            <SettingsView key="settings-media" initialSection="media" />
          </TabContentView>
        );
      case "settings":
        return (
          <TabContentView>
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
            <LogsPageView />
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

  return <ErrorBoundary>{view}</ErrorBoundary>;
}

export function App() {
  const {
    startupError,
    startupCoordinator,
    tab,
    setTab,
    setState,
    actionNotice,
    activeOverlayApp,
    uiTheme,
    agentStatus,
    backendConnection,
    unreadConversations,
    activeGameViewerUrl,
    gameOverlayEnabled,
    uiShellMode,
    t,
  } = useApp();
  const { companionShell: CompanionShell } = useBootConfig();

  const isPopout = useIsPopout();
  const companionShellVisible = activeOverlayApp !== null;
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

  useEffect(() => {
    if (startupCoordinator.phase !== "ready") return;
    if (backendConnection?.state !== "connected") return;

    const report = () => {
      void fetch("/api/apps/overlay-presence", {
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
      void fetch("/api/apps/overlay-presence", {
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
  const [tasksEventsPanelOpen, setTasksEventsPanelOpen] = useState(false);
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
  const [mobileConversationsOpen, setMobileConversationsOpen] = useState(false);
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
  const unreadCount = unreadConversations?.size ?? 0;
  const mobileChatControls = useMemo(
    () =>
      isChatMobileLayout ? (
        <div className="flex items-center gap-2 w-max">
          <Button
            variant="outline"
            size="sm"
            className={`inline-flex items-center gap-2 px-3 py-2 text-xs font-semibold transition-all cursor-pointer ${
              mobileConversationsOpen
                ? "border-accent bg-accent-subtle text-txt"
                : "border-border bg-card text-txt hover:border-accent hover:text-txt"
            }`}
            onClick={() => {
              setMobileConversationsOpen(true);
            }}
            aria-label={t("aria.openChatsPanel")}
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden
            >
              <title>{t("conversations.chats")}</title>
              <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
            </svg>
            {t("conversations.chats")}
            {unreadCount > 0 && (
              <span className="inline-flex min-w-[18px] h-[18px] items-center justify-center rounded-full bg-accent text-accent-fg text-2xs font-bold px-1">
                {unreadCount > 99 ? "99+" : unreadCount}
              </span>
            )}
          </Button>
        </div>
      ) : undefined,
    [isChatMobileLayout, mobileConversationsOpen, unreadCount, t],
  );

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
      setMobileConversationsOpen(false);
      setTasksEventsPanelOpen(false);
    }
  }, [isChatMobileLayout]);

  useEffect(() => {
    if (!isChatWorkspace) {
      setMobileConversationsOpen(false);
    }
    if (!isChat) {
      setTasksEventsPanelOpen(false);
    }
  }, [isChat, isChatWorkspace]);

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

    // Disable the iOS WebView scroll only while the companion shell is active.
    void Keyboard.setScroll({ isDisabled: companionShellVisible }).catch(() => {
      // Ignore bridge failures so web and desktop shells keep working.
    });
  }, [companionShellVisible]);

  useEffect(() => {
    if (!isNative || !isIOS) {
      return;
    }

    return () => {
      void Keyboard.setScroll({ isDisabled: false }).catch(() => {
        // Ignore cleanup failures when the native bridge is unavailable.
      });
    };
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
      uiShellMode === "companion" &&
      tab !== "character" &&
      tab !== "character-select" &&
      CompanionShell ? (
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
          <main className="flex-1 min-h-0 overflow-hidden">
            <StreamView />
          </main>
        </div>
      ) : isChatWorkspace ? (
        <div
          key={`chat-shell-${tab}`}
          className="flex flex-col flex-1 min-h-0 w-full font-body text-txt bg-bg"
        >
          <Header
            mobileLeft={mobileChatControls}
            tasksEventsPanelOpen={
              isChat && (isChatMobileLayout ? tasksEventsPanelOpen : true)
            }
            onToggleTasksPanel={
              isChat && isChatMobileLayout
                ? () => setTasksEventsPanelOpen((o) => !o)
                : undefined
            }
          />
          <div className="flex flex-1 min-h-0 relative">
            {!isChatMobileLayout && isChat ? (
              <div
                className={CHAT_DESKTOP_COMPOSER_UNDERLAY_CLASS}
                data-chat-shell-composer-underlay
              />
            ) : null}
            {isChatMobileLayout ? (
              <>
                <div className="flex flex-col flex-1 min-h-0 min-w-0 overflow-hidden pt-2 px-2">
                  {isChat ? (
                    <>
                      <DeferredSetupChecklist
                        className="mb-3"
                        onOpenTask={handleDeferredTaskOpen}
                      />
                      <ChatView />
                    </>
                  ) : (
                    <ConnectorsPageView />
                  )}
                </div>

                {mobileConversationsOpen && (
                  <DrawerSheet
                    open={mobileConversationsOpen}
                    onOpenChange={setMobileConversationsOpen}
                  >
                    <DrawerSheetContent
                      aria-describedby={undefined}
                      className="h-[min(calc(100dvh-1rem-var(--safe-area-top,0px)-var(--safe-area-bottom,0px)),46rem)] p-0"
                      showCloseButton
                    >
                      <DrawerSheetHeader className="sr-only">
                        <DrawerSheetTitle>
                          {t("conversations.chats")}
                        </DrawerSheetTitle>
                      </DrawerSheetHeader>
                      <ConversationsSidebar
                        key="chat-sidebar-mobile"
                        mobile
                        onClose={() => setMobileConversationsOpen(false)}
                      />
                    </DrawerSheetContent>
                  </DrawerSheet>
                )}

                {isChat && tasksEventsPanelOpen && (
                  <DrawerSheet
                    open={tasksEventsPanelOpen}
                    onOpenChange={setTasksEventsPanelOpen}
                  >
                    <DrawerSheetContent
                      aria-describedby={undefined}
                      className="h-[min(calc(100dvh-1rem-var(--safe-area-top,0px)-var(--safe-area-bottom,0px)),46rem)] p-0"
                      showCloseButton={false}
                    >
                      <DrawerSheetHeader className="sr-only">
                        <DrawerSheetTitle>
                          {t("taskseventspanel.Title", {
                            defaultValue: "Chat widgets",
                          })}
                        </DrawerSheetTitle>
                      </DrawerSheetHeader>
                      <TasksEventsPanel
                        open
                        events={activityEvents}
                        clearEvents={clearActivityEvents}
                        mobile
                      />
                    </DrawerSheetContent>
                  </DrawerSheet>
                )}
              </>
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
                    <ConnectorsPageView />
                  )}
                </div>
                {isChat ? (
                  <TasksEventsPanel
                    open
                    events={activityEvents}
                    clearEvents={clearActivityEvents}
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
          <div className="flex flex-1 min-h-0 min-w-0 overflow-hidden">
            <AutomationsView key="automations-view-desktop" />
          </div>
        </div>
      ) : isSettingsPage ? (
        <div
          key={`settings-shell-${tab}`}
          className="flex flex-col flex-1 min-h-0 w-full font-body text-txt bg-bg"
        >
          <Header />
          <div className="flex flex-1 min-h-0 min-w-0 overflow-hidden">
            <SettingsView
              key={
                tab === "voice"
                  ? "settings-media"
                  : tab === "connectors"
                    ? "settings-connectors"
                    : "settings-root"
              }
              initialSection={
                tab === "voice"
                  ? "media"
                  : tab === "connectors"
                    ? "connectors"
                    : (settingsInitialSection ?? undefined)
              }
            />
          </div>
        </div>
      ) : isWallets ? (
        <div
          key="wallets-shell"
          className="flex flex-col flex-1 min-h-0 w-full font-body text-txt bg-bg"
        >
          <Header />
          <div className="flex flex-1 min-h-0 min-w-0 overflow-hidden">
            <InventoryView />
          </div>
        </div>
      ) : isCharacterPage ? (
        <div
          key={`character-shell-${tab}`}
          className="flex flex-col flex-1 min-h-0 w-full font-body text-txt bg-bg"
        >
          <Header pageRightExtras={characterHeaderActions} />
          <div className="flex flex-1 min-h-0 min-w-0 overflow-hidden">
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
          <div className="flex flex-1 min-h-0 min-w-0 overflow-hidden">
            <ViewRouter />
          </div>
        </div>
      ) : isDesktopWorkspacePage ? (
        <div
          key={`desktop-shell-${tab}`}
          className="flex flex-col flex-1 min-h-0 w-full font-body text-txt bg-bg"
        >
          <Header />
          <div className="flex flex-1 min-h-0 min-w-0">
            <DesktopWorkspaceSection />
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
              tab === "browser" ? "" : "px-3 xl:px-5 py-4 xl:py-6"
            }`}
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
      isConnectors,
      isCharacterPage,
      isHeartbeats,
      isSettingsPage,
      isWallets,
      isAppsToolPage,
      isDesktopWorkspacePage,
      isChatMobileLayout,
      mobileConversationsOpen,
      mobileChatControls,
      characterHeaderActions,
      tasksEventsPanelOpen,
      handleDeferredTaskOpen,
      activityEvents,
      clearActivityEvents,
      customActionsPanelOpen,
      setCharacterHeaderActions,
      settingsInitialSection,
      t,
    ],
  );

  // Pop-out mode — render only StreamView, skip startup gates.
  // Platform init is skipped in main.tsx; AppProvider hydrates WS in background.
  if (isPopout) {
    return (
      <div className="flex flex-col h-screen w-screen font-body text-txt bg-bg overflow-hidden">
        <StreamView />
      </div>
    );
  }

  // StartupCoordinator gate — the coordinator is the sole startup authority.
  // Non-ready phases are handled by StartupShell (which renders the appropriate
  // view for each coordinator phase: loading, pairing, onboarding, or error).
  if (startupCoordinator.phase !== "ready") {
    return (
      <BugReportProvider value={bugReport}>
        <StartupShell />
        <BugReportModal />
      </BugReportProvider>
    );
  }

  // Coordinator is at "ready" — the app shell renders. No legacy onboarding
  // overlays — the coordinator handled all of that before reaching ready.

  return (
    <BugReportProvider value={bugReport}>
      <div className="flex flex-col h-screen w-screen overflow-hidden">
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
      <MusicPlayerGlobal />

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
