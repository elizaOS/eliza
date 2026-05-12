// Static import: CharacterEditor is statically re-exported by app-core's
// browser entry, so the previous lazy() was eagerly merged back into the
// main chunk. Drop the wrapper to silence the dynamic↔static collision
// warning and remove the unnecessary Suspense boundary overhead.
import {
  CharacterEditor,
  ChatModalView,
  useApp,
  usePtySessions,
  useRenderGuard,
} from "@elizaos/ui";
import {
  memo,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import { PtyConsoleSidePanel } from "../../../../app-task-coordinator/src/PtyConsoleSidePanel";
import { CompanionHeader, type CompanionShellView } from "./CompanionHeader";
import { CompanionSceneHost } from "./CompanionSceneHost";
import { CompanionSettingsPanel } from "./CompanionSettingsPanel";
import { EmotePicker } from "./EmotePicker";
import { InferenceCloudAlertButton } from "./InferenceCloudAlertButton";
import { resolveCompanionInferenceNotice } from "./resolve-companion-inference-notice";

const COMPANION_DOCK_HEIGHT = "min(42vh, 24rem)";

/**
 * Isolated wrapper for the PTY side panel so that CompanionViewOverlay doesn't
 * need to subscribe to ptySessions (which polls every 5 s) for a panel that is
 * only visible when the user has explicitly clicked a session.
 */
const CompanionPtyPanel = memo(function CompanionPtyPanel({
  sessionId,
  onClose,
}: {
  sessionId: string;
  onClose: () => void;
}) {
  const { ptySessions } = usePtySessions();
  if (ptySessions.length === 0) return null;
  return (
    <PtyConsoleSidePanel
      activeSessionId={sessionId}
      sessions={ptySessions}
      onClose={onClose}
    />
  );
});

/**
 * Inner overlay that subscribes to useApp() for frequently-changing data
 * (conversationMessages, chatLastUsage, etc.). Extracted so that
 * CompanionView itself doesn't subscribe — keeping the children prop
 * passed to CompanionSceneHost referentially stable and avoiding
 * cascading re-renders into the 3D scene.
 */
const CompanionViewOverlay = memo(function CompanionViewOverlay() {
  useRenderGuard("CompanionView");
  const {
    uiLanguage,
    setUiLanguage,
    uiTheme,
    setUiTheme,
    chatAgentVoiceMuted,
    chatLastUsage,
    conversationMessages,
    elizaCloudAuthRejected,
    elizaCloudConnected,
    elizaCloudCreditsError,
    elizaCloudEnabled,
    emotePickerOpen,
    openEmotePicker,
    closeEmotePicker,
    handleNewConversation,
    navigation,
    setState,
    setTab,
    t,
  } = useApp();

  const [companionView, setCompanionView] =
    useState<CompanionShellView>("companion");

  const [ptySidePanelSessionId, setPtySidePanelSessionId] = useState<
    string | null
  >(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const handleSidebarClose = useCallback(() => setHistoryOpen(false), []);
  const handlePtySessionClick = useCallback(
    (id: string) =>
      setPtySidePanelSessionId((prev) => (prev === id ? null : id)),
    [],
  );
  const handlePtyPanelClose = useCallback(
    () => setPtySidePanelSessionId(null),
    [],
  );

  const handleExitToDesktop = useCallback(() => {
    setState("activeOverlayApp", null);
    setTab("chat");
  }, [setState, setTab]);

  const handleSwitchToCharacter = useCallback(() => {
    setCompanionView("character");
  }, []);

  const handleOpenSettings = useCallback(() => {
    setCompanionView("settings");
  }, []);

  const handleSwitchToCompanion = useCallback(() => {
    setCompanionView("companion");
  }, []);

  const handleToggleEmotePicker = useCallback(() => {
    if (emotePickerOpen) {
      closeEmotePicker();
      return;
    }
    openEmotePicker();
  }, [closeEmotePicker, emotePickerOpen, openEmotePicker]);

  useEffect(() => {
    setState(
      "chatMode",
      elizaCloudEnabled || elizaCloudConnected ? "power" : "simple",
    );
  }, [elizaCloudConnected, elizaCloudEnabled, setState]);

  const hasInterruptedAssistant = useMemo(
    () =>
      conversationMessages.some((m) => m.role === "assistant" && m.interrupted),
    [conversationMessages],
  );

  const inferenceNotice = useMemo(
    () =>
      resolveCompanionInferenceNotice({
        elizaCloudConnected,
        elizaCloudAuthRejected,
        elizaCloudCreditsError,
        elizaCloudEnabled,
        chatLastUsageModel: chatLastUsage?.model,
        hasInterruptedAssistant,
        t,
      }),
    [
      chatLastUsage?.model,
      elizaCloudAuthRejected,
      elizaCloudConnected,
      elizaCloudCreditsError,
      elizaCloudEnabled,
      hasInterruptedAssistant,
      t,
    ],
  );

  const handleInferenceAlertClick = useCallback(() => {
    if (!inferenceNotice) return;
    setState("activeOverlayApp", null);
    navigation.scheduleAfterTabCommit(() => {
      setTab("settings");
      if (inferenceNotice.kind === "cloud") {
        setState("cloudDashboardView", "billing");
      }
    });
  }, [inferenceNotice, navigation, setState, setTab]);

  const companionHeaderRightExtras = (
    <>
      {inferenceNotice ? (
        <InferenceCloudAlertButton
          notice={inferenceNotice}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={handleInferenceAlertClick}
        />
      ) : null}
    </>
  );

  return (
    <div className="absolute inset-0 z-10 flex flex-col pointer-events-none">
      <div>
        <CompanionHeader
          activeView={companionView}
          onExitToDesktop={handleExitToDesktop}
          onExitToCharacter={handleSwitchToCharacter}
          onOpenSettings={handleOpenSettings}
          onSwitchToCompanion={handleSwitchToCompanion}
          uiLanguage={uiLanguage}
          setUiLanguage={setUiLanguage}
          uiTheme={uiTheme}
          setUiTheme={setUiTheme}
          t={t}
          chatAgentVoiceMuted={chatAgentVoiceMuted}
          onToggleVoiceMute={() =>
            setState("chatAgentVoiceMuted", !chatAgentVoiceMuted)
          }
          onNewChat={() => void handleNewConversation()}
          onToggleEmotePicker={handleToggleEmotePicker}
          rightExtras={companionHeaderRightExtras}
        />
      </div>

      {companionView === "companion" && (
        <div
          className="pointer-events-auto absolute inset-x-0 bottom-0 z-20 flex justify-center px-1.5 sm:px-4"
          style={{
            paddingBottom: "calc(var(--safe-area-bottom, 0px) + 0.75rem)",
          }}
        >
          <div
            data-testid="companion-chat-dock"
            className="relative w-full max-w-5xl min-w-0"
            style={{ height: COMPANION_DOCK_HEIGHT, minHeight: "17rem" }}
          >
            <ChatModalView
              variant="companion-dock"
              showSidebar={historyOpen}
              onSidebarClose={handleSidebarClose}
              onPtySessionClick={handlePtySessionClick}
            />
          </div>
        </div>
      )}

      {companionView === "character" && (
        <Suspense fallback={null}>
          <CharacterEditor sceneOverlay />
        </Suspense>
      )}

      {companionView === "settings" && <CompanionSettingsPanel />}

      {/* PTY console side panel */}
      {ptySidePanelSessionId && companionView === "companion" && (
        <div className="pointer-events-auto">
          <CompanionPtyPanel
            sessionId={ptySidePanelSessionId}
            onClose={handlePtyPanelClose}
          />
        </div>
      )}

      <EmotePicker />

      {/* Center (empty to show character) */}
      <div className="flex-1 grid grid-cols-[1fr_auto] gap-6 min-h-0 relative">
        <div className="w-full h-full" />
      </div>
    </div>
  );
});

/**
 * CompanionView — thin shell that composes CompanionSceneHost + overlay.
 * Does NOT subscribe to useApp() so CompanionSceneHost receives stable
 * children and avoids re-rendering the 3D scene on unrelated state changes.
 */
export const CompanionView = memo(function CompanionView() {
  return (
    <CompanionSceneHost active>
      <CompanionViewOverlay />
    </CompanionSceneHost>
  );
});
