import { memo } from "react";
import { useRenderGuard } from "../../hooks/useRenderGuard";
import { useTranslation } from "../../state";
import { ChatPanelLayout } from "./ChatPanelLayout";
import { ChatView } from "./ChatView";
import { ConversationsSidebar } from "../conversations/ConversationsSidebar";
import {
  DrawerSheet,
  DrawerSheetContent,
  DrawerSheetHeader,
  DrawerSheetTitle,
} from "../ui/drawer-sheet";

type ChatModalLayoutVariant = "full-overlay" | "companion-dock";

interface ChatModalViewProps {
  variant?: ChatModalLayoutVariant;
  showSidebar?: boolean;
  onSidebarClose?: () => void;
  /** Override click handler for agent activity box sessions. */
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
            className="!inset-0 !left-0 !right-0 !bottom-0 !top-0 !h-[100dvh] !max-h-none !rounded-none !border-0 p-0"
            data-chat-sidebar-overlay
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
