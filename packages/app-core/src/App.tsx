/**
 * Root App component — routing shell.
 */

import { Keyboard } from "@capacitor/keyboard";
import {
  isIOS,
  isLifoPopoutValue,
  isNative,
} from "@miladyai/app-core/platform";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import {
  AdvancedPageView,
  AppsPageView,
  AvatarLoader,
  CharacterView,
  ChatView,
  CompanionShell,
  CompanionView,
  ConnectionFailedBanner,
  ConnectorsPageView,
  ConversationsSidebar,
  CustomActionEditor,
  CustomActionsPanel,
  ErrorBoundary,
  GameViewOverlay,
  Header,
  MiladyBar,
  HeartbeatsView,
  InventoryView,
  KnowledgeView,
  OnboardingWizard,
  PairingView,
  SaveCommandModal,
  SettingsView,
  SharedCompanionScene,
  ShellOverlays,
  StartupFailureView,
  StreamView,
  SystemWarningBanner,
} from "./components";
import {
  BugReportProvider,
  useBugReportState,
  useContextMenu,
  useStreamPopoutNavigation,
} from "./hooks";
import type { Tab } from "./navigation";
import { APPS_ENABLED, COMPANION_ENABLED } from "./navigation";
import { useApp } from "./state";

const CHAT_MOBILE_BREAKPOINT_PX = 1024;

/** Check if we're in pop-out mode (StreamView only, no chrome).
 *  Legacy LIFO popout values are ignored so the normal app shell still loads. */
function useIsPopout(): boolean {
  const [popout] = useState(() => {
    if (typeof window === "undefined") return false;
    const params = new URLSearchParams(
      window.location.search || window.location.hash.split("?")[1] || "",
    );
    if (!params.has("popout")) return false;
    return !isLifoPopoutValue(params.get("popout"));
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
    <div className="flex-1 min-h-0 min-w-0 w-full overflow-hidden">
      {children}
    </div>
  );
}

function isCharacterTab(tab: Tab): boolean {
  return tab === "character" || tab === "character-select";
}

function ViewRouter({
  characterSceneVisible = false,
}: {
  characterSceneVisible?: boolean;
}) {
  const { tab } = useApp();
  const view = (() => {
    switch (tab) {
      case "chat":
        return <ChatView />;
      case "companion":
        return COMPANION_ENABLED ? <CompanionView /> : <ChatView />;
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
      case "character":
      case "character-select":
        return (
          <TabScrollView>
            <CharacterView sceneOverlay={characterSceneVisible} />
          </TabScrollView>
        );
      case "wallets":
        return (
          <TabScrollView>
            <InventoryView />
          </TabScrollView>
        );
      case "knowledge":
        return (
          <TabScrollView>
            <KnowledgeView />
          </TabScrollView>
        );
      case "connectors":
        return (
          <TabScrollView>
            <ConnectorsPageView />
          </TabScrollView>
        );
      case "triggers":
        return (
          <TabScrollView>
            <section className="w-full px-4 py-4 lg:px-6">
              <HeartbeatsView />
            </section>
          </TabScrollView>
        );
      case "voice":
        return (
          <TabScrollView className="settings-scroll-region">
            <SettingsView key="settings-voice" initialSection="voice" />
          </TabScrollView>
        );
      case "settings":
        return (
          <TabScrollView className="settings-scroll-region">
            <SettingsView key="settings-root" />
          </TabScrollView>
        );
      case "advanced":
      case "plugins":
      case "skills":
      case "actions":
      case "fine-tuning":
      case "trajectories":
      case "runtime":
      case "database":
      case "lifo":
      case "logs":
      case "security":
        return (
          <TabContentView>
            <AdvancedPageView />
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
    onboardingLoading,
    startupPhase,
    startupError,
    authRequired,
    onboardingComplete,
    retryStartup,
    tab,
    setTab,
    actionNotice,
    uiShellMode,
    agentStatus,
    unreadConversations,
    activeGameViewerUrl,
    gameOverlayEnabled,
  } = useApp();

  const isPopout = useIsPopout();
  const shellMode =
    tab === "character" || tab === "character-select"
      ? "native"
      : (uiShellMode ?? "companion");
  const effectiveTab: Tab =
    shellMode === "companion"
      ? "companion"
      : tab === "companion"
        ? "chat"
        : tab;
  const characterSceneVisible =
    shellMode === "native" &&
    (isCharacterTab(effectiveTab) || isCharacterTab(tab));
  const companionShellVisible = shellMode === "companion";
  const companionSceneActive =
    COMPANION_ENABLED && (companionShellVisible || characterSceneVisible);
  const contextMenu = useContextMenu();

  useStreamPopoutNavigation(setTab);

  const [customActionsPanelOpen, setCustomActionsPanelOpen] = useState(false);
  const [customActionsEditorOpen, setCustomActionsEditorOpen] = useState(false);
  const [editingAction, setEditingAction] = useState<
    import("./api").CustomActionDef | null
  >(null);
  const [isChatMobileLayout, setIsChatMobileLayout] = useState(() =>
    typeof window !== "undefined"
      ? window.innerWidth < CHAT_MOBILE_BREAKPOINT_PX
      : false,
  );
  const [mobileConversationsOpen, setMobileConversationsOpen] = useState(false);

  const isChat = tab === "chat";
  const unreadCount = unreadConversations?.size ?? 0;
  const mobileChatControls = isChatMobileLayout ? (
    <div className="flex items-center gap-2 w-max">
      <button
        type="button"
        className={`inline-flex items-center gap-2 px-3 py-2 border rounded-md text-[12px] font-semibold transition-all cursor-pointer ${
          mobileConversationsOpen
            ? "border-accent bg-accent-subtle text-txt"
            : "border-border bg-card text-txt hover:border-accent hover:text-txt"
        }`}
        onClick={() => {
          setMobileConversationsOpen(true);
        }}
        aria-label="Open chats panel"
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
          <title>Chats</title>
          <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
        </svg>
        Chats
        {unreadCount > 0 && (
          <span className="inline-flex min-w-[18px] h-[18px] items-center justify-center rounded-full bg-accent text-accent-fg text-[10px] font-bold px-1">
            {unreadCount > 99 ? "99+" : unreadCount}
          </span>
        )}
      </button>
    </div>
  ) : undefined;

  // Keep hook order stable across onboarding/auth state transitions.
  // Otherwise React can throw when onboarding completes and the main shell mounts.
  useEffect(() => {
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
    }
  }, [isChatMobileLayout]);

  useEffect(() => {
    if (!isChat) {
      setMobileConversationsOpen(false);
    }
  }, [isChat]);

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

  const bugReport = useBugReportState();
  const agentStarting = agentStatus?.state === "starting";

  useEffect(() => {
    const STARTUP_TIMEOUT_MS = 300_000;
    if ((startupPhase as string) !== "ready" && !startupError) {
      const timer = setTimeout(() => {
        retryStartup();
      }, STARTUP_TIMEOUT_MS);
      return () => clearTimeout(timer);
    }
  }, [startupPhase, startupError, retryStartup]);

  // Pop-out mode — render only StreamView, skip startup gates.
  // Platform init is skipped in main.tsx; AppProvider hydrates WS in background.
  if (isPopout) {
    return (
      <div className="flex flex-col h-screen w-screen font-body text-txt bg-bg overflow-hidden">
        <StreamView />
      </div>
    );
  }

  if (startupError) {
    return <StartupFailureView error={startupError} onRetry={retryStartup} />;
  }

  const shouldLoad = onboardingLoading || agentStarting;
  const [loaderFadingOut, setLoaderFadingOut] = useState(false);
  const showLoaderRef = useRef(true);
  const [showLoader, setShowLoader] = useState(true);

  useEffect(() => {
    if (shouldLoad) {
      showLoaderRef.current = true;
      setShowLoader(true);
      setLoaderFadingOut(false);
    } else if (showLoaderRef.current) {
      showLoaderRef.current = false;
      setLoaderFadingOut(true);
      const timer = setTimeout(() => {
        setShowLoader(false);
        setLoaderFadingOut(false);
      }, 800);
      return () => clearTimeout(timer);
    }
  }, [shouldLoad]);

  if (authRequired && !shouldLoad) return <PairingView />;
  if (!onboardingComplete && !shouldLoad) return <OnboardingWizard />;

  const shellContent = companionShellVisible ? (
    <CompanionShell tab={effectiveTab} actionNotice={actionNotice} />
  ) : tab === "stream" ? (
    <div className="flex flex-col flex-1 min-h-0 w-full font-body text-txt bg-bg">
      <Header hideCloudCredits />
      <MiladyBar />
      <main className="flex-1 min-h-0 overflow-hidden">
        <StreamView />
      </main>
    </div>
  ) : isChat ? (
    <div className="flex flex-col flex-1 min-h-0 w-full font-body text-txt bg-bg">
      <Header mobileLeft={mobileChatControls} hideCloudCredits />
      <MiladyBar />
      <div className="flex flex-1 min-h-0 relative">
        {isChatMobileLayout ? (
          <>
            <main className="flex flex-col flex-1 min-h-0 min-w-0 overflow-hidden pt-2 px-2">
              <ChatView />
            </main>

            {mobileConversationsOpen && (
              <div className="fixed inset-0 z-[120] bg-bg">
                <ConversationsSidebar
                  mobile
                  onClose={() => setMobileConversationsOpen(false)}
                />
              </div>
            )}
          </>
        ) : (
          <>
            <ConversationsSidebar />
            <main className="flex flex-col flex-1 min-h-0 min-w-0 overflow-hidden pt-3 px-3 xl:px-5">
              <ChatView />
            </main>
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
  ) : (
    <div
      className={`flex flex-col flex-1 min-h-0 w-full font-body text-txt ${
        characterSceneVisible ? "bg-transparent" : "bg-bg"
      }`}
    >
      <Header transparent={characterSceneVisible} hideCloudCredits={!characterSceneVisible} />
      {!characterSceneVisible && <MiladyBar />}
      <main
        className={`flex flex-1 min-h-0 min-w-0 overflow-hidden px-3 xl:px-5 ${
          characterSceneVisible ? "pb-4 pt-2 xl:pb-6" : "py-4 xl:py-6"
        }`}
      >
        <ViewRouter characterSceneVisible={characterSceneVisible} />
      </main>
    </div>
  );

  const appShell = COMPANION_ENABLED ? (
    <SharedCompanionScene
      active={companionSceneActive}
      interactive={companionShellVisible}
    >
      {shellContent}
    </SharedCompanionScene>
  ) : (
    shellContent
  );

  return (
    <BugReportProvider value={bugReport}>
      {appShell}
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
      <ConnectionFailedBanner />
      <SystemWarningBanner />
      {showLoader && (
        <AvatarLoader
          label={agentStarting ? "Initializing agent" : "Starting systems"}
          fullScreen
          fadingOut={loaderFadingOut}
        />
      )}
    </BugReportProvider>
  );
}
