import { useRenderGuard } from "@elizaos/app-core/hooks";
import { useApp } from "@elizaos/app-core/state";
import { Button } from "@elizaos/ui";
import { MessageCircle, Volume2, VolumeX } from "lucide-react";
import { memo, useCallback, useEffect } from "react";
import { ChatModalView } from "./ChatModalView";
import { CompanionHeader } from "./companion/CompanionHeader";
import {
  CompanionSceneHost,
  useSharedCompanionScene,
} from "./companion/CompanionSceneHost";

export const CompanionView = memo(function CompanionView() {
  useRenderGuard("CompanionView");
  const {
    uiLanguage,
    setUiLanguage,
    uiTheme,
    setUiTheme,
    chatAgentVoiceMuted,
    handleStartDraftConversation,
    setState,
    switchShellView,
    t,
  } = useApp();
  const hasSharedCompanionScene = useSharedCompanionScene();

  const handleShellViewChange = useCallback(
    (view: "companion" | "character" | "desktop") => {
      switchShellView(view);
    },
    [switchShellView],
  );

  useEffect(() => {
    setState("chatMode", "simple");
  }, [setState]);

  const overlay = (
    <div className="absolute inset-0 z-10 flex flex-col pointer-events-none">
      <CompanionHeader
        activeShellView="companion"
        onShellViewChange={handleShellViewChange}
        uiLanguage={uiLanguage}
        setUiLanguage={setUiLanguage}
        uiTheme={uiTheme}
        setUiTheme={setUiTheme}
        t={t}
      >
        <div className="flex items-center justify-center">
          <div
            className="inline-flex items-center gap-2"
            data-testid="companion-header-chat-controls"
            data-no-camera-drag="true"
          >
            <Button
              type="button"
              variant="outline"
              size="sm"
              aria-label={
                chatAgentVoiceMuted ? t("companion.agentVoiceOff") : t("companion.agentVoiceOn")
              }
              aria-pressed={!chatAgentVoiceMuted}
              title={chatAgentVoiceMuted ? t("companion.agentVoiceOff") : t("companion.agentVoiceOn")}
              className="inline-flex h-11 min-h-[44px] min-w-[44px] select-none items-center rounded-full border border-border/50 bg-bg/50 px-4 text-sm font-medium text-txt shadow-sm backdrop-blur-md transition-all duration-300 hover:-translate-y-0.5 hover:border-accent hover:text-txt hover:shadow-[0_0_15px_rgba(var(--accent),0.5)] active:scale-95"
              onClick={() =>
                setState("chatAgentVoiceMuted", !chatAgentVoiceMuted)
              }
            >
              {chatAgentVoiceMuted ? (
                <VolumeX className="mr-1.5 h-3.5 w-3.5" />
              ) : (
                <Volume2 className="mr-1.5 h-3.5 w-3.5" />
              )}
              {t("companion.voice")}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              aria-label={t("companion.newChat")}
              title={t("companion.newChat")}
              className="hidden h-11 min-h-[44px] min-w-[44px] select-none items-center rounded-full border border-border/50 bg-bg/50 px-4 text-sm font-medium text-txt shadow-sm backdrop-blur-md transition-all duration-300 hover:-translate-y-0.5 hover:border-accent hover:text-txt hover:shadow-[0_0_15px_rgba(var(--accent),0.5)] active:scale-95 sm:inline-flex"
              onClick={() => void handleStartDraftConversation()}
            >
              <MessageCircle className="mr-1 h-3.5 w-3.5" />
              {t("companion.newChat")}
            </Button>
          </div>
        </div>
      </CompanionHeader>

      <div className="absolute bottom-6 left-1/2 -translate-x-1/2 w-full max-w-3xl h-[45%] z-20 pointer-events-auto">
        <ChatModalView variant="companion-dock" />
      </div>

      {/* Main Content Area */}
      <div className="flex-1 grid grid-cols-[1fr_auto] gap-6 min-h-0 relative">
        {/* Center (Empty to show character) */}
        <div className="w-full h-full" />
      </div>
    </div>
  );

  return hasSharedCompanionScene ? (
    overlay
  ) : (
    <CompanionSceneHost active>{overlay}</CompanionSceneHost>
  );
});
