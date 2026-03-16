import { useRenderGuard } from "@elizaos/app-core/hooks";
import { useApp } from "@elizaos/app-core/state";
import { memo, useEffect, useState } from "react";
import { ChatView } from "./ChatView.js";
import { ConversationsSidebar } from "./ConversationsSidebar.js";

const CHAT_MODAL_NARROW_BREAKPOINT = 768;

function useIsNarrowViewport(): boolean {
  const [isNarrow, setIsNarrow] = useState(() =>
    typeof window !== "undefined"
      ? window.innerWidth <= CHAT_MODAL_NARROW_BREAKPOINT
      : false,
  );

  useEffect(() => {
    if (
      typeof window === "undefined" ||
      typeof window.matchMedia !== "function"
    ) {
      return;
    }
    const mediaQuery = window.matchMedia(
      `(max-width: ${CHAT_MODAL_NARROW_BREAKPOINT}px)`,
    );
    const sync = () => {
      setIsNarrow(mediaQuery.matches);
    };
    sync();

    if (typeof mediaQuery.addEventListener === "function") {
      mediaQuery.addEventListener("change", sync);
      return () => mediaQuery.removeEventListener("change", sync);
    }

    mediaQuery.addListener(sync);
    return () => mediaQuery.removeListener(sync);
  }, []);

  return isNarrow;
}

type ChatModalLayoutVariant = "full-overlay" | "companion-dock";

interface ChatModalViewProps {
  variant?: ChatModalLayoutVariant;
  onRequestClose?: () => void;
  showSidebar?: boolean;
  onSidebarClose?: () => void;
}

export const ChatModalView = memo(function ChatModalView({
  variant = "full-overlay",
  showSidebar = false,
  onSidebarClose,
}: ChatModalViewProps) {
  useRenderGuard("ChatModalView");
  const { activeConversationId } = useApp();

  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const isNarrow = useIsNarrowViewport();
  const isCompanionDock = variant === "companion-dock";
  const companionSidebarVisible = isCompanionDock && showSidebar && !isNarrow;

  useEffect(() => {
    if (!isNarrow) {
      setMobileSidebarOpen(false);
    }
  }, [isNarrow]);

  useEffect(() => {
    if (activeConversationId) {
      setMobileSidebarOpen(false);
    }
  }, [activeConversationId]);

  return (
    <div
      className={
        isCompanionDock
          ? "absolute inset-0 z-10 flex flex-col bg-transparent px-4"
          : "absolute inset-[10vh_10vw] z-[100] flex flex-col rounded-2xl bg-black/60"
      }
      data-chat-game-overlay={!isCompanionDock || undefined}
      data-chat-game-dock={isCompanionDock || undefined}
    >
      <div
        className={`flex-1 flex flex-col min-h-0 relative rounded-2xl bg-transparent ${
          isCompanionDock ? "overflow-visible" : "overflow-hidden"
        }`}
        data-chat-game-shell
      >
        {isCompanionDock && showSidebar && isNarrow && (
          <div className="absolute inset-0 z-20 bg-black/60 backdrop-blur-sm">
            <ConversationsSidebar mobile onClose={onSidebarClose} />
          </div>
        )}
        <div className="flex-1 flex min-h-0">
          <aside
            className={`w-[276px] shrink-0 border-r border-white/10 flex flex-col bg-black/20 ${
              mobileSidebarOpen
                ? "block"
                : companionSidebarVisible
                  ? "hidden md:flex"
                  : isCompanionDock
                    ? "hidden"
                    : "hidden md:flex"
            }`}
            data-chat-game-sidebar
          >
            <ConversationsSidebar variant="game-modal" />
          </aside>
          <section
            className={`flex-1 flex flex-col min-w-0 bg-transparent relative ${
              isCompanionDock ? "overflow-visible" : ""
            }`}
            data-chat-game-thread
          >
            <ChatView variant="game-modal" />
          </section>
        </div>
      </div>
    </div>
  );
});
