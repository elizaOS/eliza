import {
  ChatPanelLayout,
  DrawerSheet,
  DrawerSheetContent,
  DrawerSheetHeader,
  DrawerSheetTitle,
} from "@elizaos/ui";

import "../chat/chat-source-registration.js";

import { memo } from "react";
import { useRenderGuard } from "../../hooks/useRenderGuard";
import { useTranslation } from "../../state";
import { ConversationsSidebar } from "../conversations/ConversationsSidebar.js";
import { ChatView } from "./ChatView.js";

type ChatModalLayoutVariant = "full-overlay" | "companion-dock";

interface ChatModalViewProps {
  variant?: ChatModalLayoutVariant;
  onRequestClose?: () => void;
  showSidebar?: boolean;
  onSidebarClose?: () => void;
  /** Override click handler for agent activity box sessions (e.g. open side panel in companion). */
  onPtySessionClick?: (sessionId: string) => void;
}

export const ChatModalView = memo(function ChatModalView({
  variant = "full-overlay",
  showSidebar = false,
  onSidebarClose,
  onPtySessionClick,
}: ChatModalViewProps) {
  useRenderGuard("ChatModalView");
  const { t } = useTranslation();

  return (
    <ChatPanelLayout
      variant={variant}
      mobileSidebar={
        <DrawerSheet
          open
          onOpenChange={(open: boolean) => {
            if (!open) {
              onSidebarClose?.();
            }
          }}
        >
          <DrawerSheetContent
            aria-describedby={undefined}
            className="h-[min(calc(100dvh-1rem-var(--safe-area-top,0px)-var(--safe-area-bottom,0px)),36rem)] p-0"
            data-chat-game-sidebar-overlay
            showCloseButton={false}
          >
            <DrawerSheetHeader className="sr-only">
              <DrawerSheetTitle>{t("conversations.chats")}</DrawerSheetTitle>
            </DrawerSheetHeader>
            <ConversationsSidebar mobile onClose={onSidebarClose} />
          </DrawerSheetContent>
        </DrawerSheet>
      }
      sidebar={<ConversationsSidebar variant="game-modal" />}
      showSidebar={showSidebar}
      thread={
        <ChatView variant="game-modal" onPtySessionClick={onPtySessionClick} />
      }
    />
  );
});
