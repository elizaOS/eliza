import { useRenderGuard } from "@miladyai/app-core/hooks";
import { useApp } from "@miladyai/app-core/state";
import { Button } from "@miladyai/ui";
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
              variant="ghost"
              size="sm"
              aria-label={
                chatAgentVoiceMuted ? "Agent voice off" : "Agent voice on"
              }
              aria-pressed={!chatAgentVoiceMuted}
              title={chatAgentVoiceMuted ? "Agent voice off" : "Agent voice on"}
              className="h-11 min-h-[44px] min-w-[44px] rounded-full border border-border/50 bg-card/80 px-4 text-sm text-txt shadow-sm backdrop-blur-sm hover:bg-bg-hover"
              onClick={() =>
                setState("chatAgentVoiceMuted", !chatAgentVoiceMuted)
              }
            >
              {chatAgentVoiceMuted ? (
                <VolumeX className="mr-1.5 h-3.5 w-3.5" />
              ) : (
                <Volume2 className="mr-1.5 h-3.5 w-3.5" />
              )}
              Voice
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              aria-label="New Chat"
              title="New Chat"
              className="hidden h-11 min-h-[44px] min-w-[44px] rounded-full border border-border/50 bg-card/80 px-4 text-sm text-black shadow-sm backdrop-blur-sm hover:text-black dark:text-txt dark:hover:text-txt sm:inline-flex"
              onClick={() => void handleStartDraftConversation()}
            >
              <MessageCircle className="mr-1 h-3.5 w-3.5" />
              New Chat
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
