import {
  CharacterEditor,
  type OverlayAppContext,
} from "@elizaos/ui/components";
import { useRenderGuard } from "@elizaos/ui/hooks";
import { useApp } from "@elizaos/ui/state";
import { memo, useEffect, useState } from "react";
import { CompanionHeader, type CompanionShellView } from "./CompanionHeader";
import { CompanionSceneHost } from "./CompanionSceneHost";
import { CompanionSettingsPanel } from "./CompanionSettingsPanel";
import { EmotePicker } from "./EmotePicker";

const CompanionOverlay = memo(function CompanionOverlay({
  activeView,
  setActiveView,
  exitToApps,
}: {
  activeView: CompanionShellView;
  setActiveView: (view: CompanionShellView) => void;
  exitToApps: () => void;
}) {
  useRenderGuard("CompanionAppView");
  const {
    chatAgentVoiceMuted,
    closeEmotePicker,
    emotePickerOpen,
    handleNewConversation,
    openEmotePicker,
    setState,
    setUiLanguage,
    setUiTheme,
    t,
    uiLanguage,
    uiTheme,
  } = useApp();

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !emotePickerOpen) {
        exitToApps();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [emotePickerOpen, exitToApps]);

  const toggleEmotePicker = () => {
    if (emotePickerOpen) {
      closeEmotePicker();
      return;
    }
    openEmotePicker();
  };

  return (
    <div className="absolute inset-0 z-10 flex flex-col pointer-events-none">
      <CompanionHeader
        activeView={activeView}
        onExitToDesktop={exitToApps}
        onExitToCharacter={() => setActiveView("character")}
        onOpenSettings={() => setActiveView("settings")}
        onSwitchToCompanion={() => setActiveView("companion")}
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
        onToggleEmotePicker={toggleEmotePicker}
      />
      <EmotePicker />

      {activeView === "character" ? <CharacterEditor sceneOverlay /> : null}
      {activeView === "settings" ? <CompanionSettingsPanel /> : null}
      {activeView === "companion" ? (
        <div className="flex-1 grid grid-cols-[1fr_auto] gap-6 min-h-0 relative">
          <div className="w-full h-full" />
        </div>
      ) : null}
    </div>
  );
});

export function CompanionAppView(props: OverlayAppContext) {
  const [activeView, setActiveView] = useState<CompanionShellView>("companion");

  return (
    <div className="fixed inset-0 z-50 h-[100vh] w-full min-h-0 overflow-hidden supports-[height:100dvh]:h-[100dvh]">
      <CompanionSceneHost active>
        <CompanionOverlay
          activeView={activeView}
          setActiveView={setActiveView}
          exitToApps={props.exitToApps}
        />
      </CompanionSceneHost>
    </div>
  );
}
