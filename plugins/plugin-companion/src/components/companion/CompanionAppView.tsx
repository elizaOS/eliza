// Static import: CharacterEditor is statically re-exported by app-core's
// browser entry, so the previous lazy() was eagerly merged back into the
// main chunk. Drop the wrapper to silence the dynamic↔static collision
// warning and remove the unnecessary Suspense boundary overhead.
import {
  CharacterEditor,
  type OverlayAppContext,
  useApp,
  useRenderGuard,
} from "@elizaos/ui";
import { memo, Suspense, useCallback, useMemo, useState } from "react";
import { CompanionHeader, type CompanionShellView } from "./CompanionHeader";
import { CompanionSceneHost } from "./CompanionSceneHost";
import { CompanionSettingsPanel } from "./CompanionSettingsPanel";
import { EmotePicker } from "./EmotePicker";
import { InferenceCloudAlertButton } from "./InferenceCloudAlertButton";
import { resolveCompanionInferenceNotice } from "./resolve-companion-inference-notice";

/**
 * Inner overlay — subscribes to useApp() for chat state.
 * Extracted so CompanionSceneHost receives stable children.
 */
const CompanionOverlay = memo(function CompanionOverlay() {
  useRenderGuard("CompanionAppView");
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

  // Exit companion overlay → navigate to chat / desktop mode
  const handleExitToDesktop = useCallback(() => {
    setState("activeOverlayApp", null);
    setTab("chat");
  }, [setState, setTab]);

  // Switch to character editor within the companion overlay
  const handleSwitchToCharacter = useCallback(() => {
    setCompanionView("character");
  }, []);

  const handleOpenSettings = useCallback(() => {
    setCompanionView("settings");
  }, []);

  // Switch back to companion chat within the overlay
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
          onPointerDown={(e: React.PointerEvent) => e.stopPropagation()}
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

      {/* In-view chat removed — the global floating pill is the only chat
          surface. Chat/voice happen in the pill on top of every view. */}

      {companionView === "character" && (
        <Suspense fallback={null}>
          <CharacterEditor sceneOverlay />
        </Suspense>
      )}

      {companionView === "settings" && <CompanionSettingsPanel />}

      <EmotePicker />

      <div className="flex-1 grid grid-cols-[1fr_auto] gap-6 min-h-0 relative">
        <div className="w-full h-full" />
      </div>
    </div>
  );
});

/**
 * CompanionAppView — top-level overlay app component.
 *
 * Mounts CompanionSceneHost (which owns VrmStage → VrmViewer → VrmEngine).
 * Everything loads on mount, everything disposes on unmount.
 */
export function CompanionAppView(_props: OverlayAppContext) {
  return (
    <div className="fixed inset-0 z-50 h-[100vh] w-full min-h-0 overflow-hidden supports-[height:100dvh]:h-[100dvh]">
      <CompanionSceneHost active>
        <CompanionOverlay />
      </CompanionSceneHost>
    </div>
  );
}
