import { Plus } from "lucide-react";
import type * as React from "react";

import { Button } from "../../ui/button";
import { NewActionButton } from "../../ui/new-action-button";
import {
  Sidebar,
  SidebarCollapsedActionButton,
  SidebarContent,
  SidebarHeader,
  SidebarPanel,
  SidebarScrollRegion,
} from "../sidebar";
import { ChatConversationItem } from "./chat-conversation-item";
import { ChatConversationRenameDialog } from "./chat-conversation-rename-dialog";
import { ChatSourceIcon } from "./chat-source";
import type {
  ChatConversationLabels,
  ChatConversationSummary,
  ChatVariant,
} from "./chat-types";

function railMonogram(label: string): string {
  const words = label.trim().split(/\s+/).filter(Boolean);
  const initials = words
    .slice(0, 2)
    .map((word) => word[0]?.toUpperCase() ?? "")
    .join("");
  return (initials || label.slice(0, 1).toUpperCase() || "?").slice(0, 2);
}

function renderRailIdentity(conversation: ChatConversationSummary) {
  if (
    typeof conversation.source === "string" &&
    conversation.source.trim().length > 0
  ) {
    return <ChatSourceIcon source={conversation.source} className="h-4 w-4" />;
  }

  return railMonogram(conversation.title);
}

export interface ChatSidebarProps {
  activeConversationId: string | null;
  confirmDeleteId?: string | null;
  conversations: ChatConversationSummary[];
  deletingId?: string | null;
  labels?: ChatConversationLabels;
  mobile?: boolean;
  onCancelDelete?: () => void;
  onClose?: () => void;
  onConfirmDelete?: (id: string) => void | Promise<void>;
  onCreate: () => void;
  onOpenActions?: (
    event:
      | React.MouseEvent<HTMLButtonElement | HTMLDivElement>
      | React.TouchEvent<HTMLButtonElement | HTMLDivElement>,
    conversation: ChatConversationSummary,
  ) => void;
  onRequestDeleteConfirm?: (id: string) => void;
  onRequestRename?: (conversation: ChatConversationSummary) => void;
  onSearchChange?: React.ChangeEventHandler<HTMLInputElement>;
  onSearchClear?: () => void;
  onSelect: (id: string) => void;
  searchValue?: string;
  testId?: string;
  unreadConversations?: Set<string>;
  variant?: ChatVariant;
}

function ChatSidebarRoot({
  activeConversationId,
  confirmDeleteId = null,
  conversations,
  deletingId = null,
  labels = {},
  mobile = false,
  onCancelDelete,
  onClose,
  onConfirmDelete,
  onCreate,
  onOpenActions,
  onRequestDeleteConfirm,
  onRequestRename,
  onSearchChange,
  onSearchClear,
  onSelect,
  searchValue = "",
  testId = "conversations-sidebar",
  unreadConversations = new Set<string>(),
  variant = "default",
}: ChatSidebarProps) {
  const isGameModal = variant === "game-modal";
  const canCollapse = !mobile && !isGameModal;
  const hasSearch = typeof onSearchChange === "function";
  const searchLabel = labels.searchChats ?? "Search chats";
  const newChatAction = isGameModal ? (
    <Button
      variant="outline"
      className="h-11 w-full rounded-xl border-[color:var(--onboarding-accent-border)] bg-[color:var(--onboarding-accent-bg)] px-3 py-2 text-sm font-medium text-[color:var(--onboarding-text-strong)] shadow-[0_12px_28px_rgba(0,0,0,0.18)] hover:border-[color:var(--onboarding-accent-border-hover)] hover:bg-[color:var(--onboarding-accent-bg-hover)] active:scale-[0.98]"
      onClick={() => {
        onCreate();
        onClose?.();
      }}
    >
      {labels.newChat ?? "New chat"}
    </Button>
  ) : (
    <NewActionButton
      onClick={() => {
        onCreate();
        onClose?.();
      }}
    >
      {labels.newChat ?? "New chat"}
    </NewActionButton>
  );

  return (
    <Sidebar
      testId={testId}
      variant={mobile ? "mobile" : isGameModal ? "game-modal" : "default"}
      collapsible={canCollapse}
      contentIdentity={
        mobile ? "chat-mobile" : isGameModal ? "chat-modal" : "chat"
      }
      collapseButtonTestId="chat-sidebar-collapse-toggle"
      expandButtonTestId="chat-sidebar-expand-toggle"
      collapseButtonAriaLabel={labels.closePanel ?? "Close panel"}
      expandButtonAriaLabel={labels.expandChatsPanel ?? "Expand chats panel"}
      header={
        hasSearch ? (
          <SidebarHeader
            search={{
              value: searchValue,
              onChange: onSearchChange,
              onClear: onSearchClear,
              placeholder: searchLabel,
              "aria-label": searchLabel,
              clearLabel: labels.clearSearch ?? "Clear search",
              autoComplete: "off",
              spellCheck: false,
            }}
          />
        ) : undefined
      }
      collapsedRailAction={
        <SidebarCollapsedActionButton
          aria-label={labels.newChat ?? "New chat"}
          onClick={() => {
            onCreate();
            onClose?.();
          }}
        >
          <Plus className="h-4 w-4" />
        </SidebarCollapsedActionButton>
      }
      collapsedRailItems={conversations.map((conversation) => (
        <SidebarContent.RailItem
          key={conversation.id}
          aria-label={conversation.title}
          title={conversation.title}
          active={conversation.id === activeConversationId}
          indicatorTone={
            unreadConversations.has(conversation.id) ? "accent" : undefined
          }
          onClick={() => {
            onSelect(conversation.id);
            onClose?.();
          }}
        >
          {renderRailIdentity(conversation)}
        </SidebarContent.RailItem>
      ))}
      onMobileClose={mobile ? onClose : undefined}
      mobileCloseLabel={labels.closePanel ?? "Close panel"}
      mobileTitle={
        mobile ? (
          <SidebarContent.SectionLabel>
            {labels.chats ?? "Chats"}
          </SidebarContent.SectionLabel>
        ) : undefined
      }
      mobileMeta={mobile ? String(conversations.length) : undefined}
      data-no-window-drag=""
      aria-label={labels.chats ?? "Chats"}
    >
      <SidebarScrollRegion variant={isGameModal ? "game-modal" : "default"}>
        <SidebarPanel variant={isGameModal ? "game-modal" : "default"}>
          <div className="mb-3">{newChatAction}</div>
          {conversations.length === 0 ? (
            <SidebarContent.EmptyState
              variant={isGameModal ? "game-modal" : "default"}
              className={!isGameModal ? "border-border/50 bg-bg/35" : undefined}
            >
              {searchValue.trim()
                ? (labels.noMatchingChats ?? "No matching chats")
                : (labels.none ?? "No conversations yet")}
            </SidebarContent.EmptyState>
          ) : (
            conversations.map((conversation) => (
              <ChatConversationItem
                key={conversation.id}
                conversation={conversation}
                deleting={deletingId === conversation.id}
                isActive={conversation.id === activeConversationId}
                isConfirmingDelete={confirmDeleteId === conversation.id}
                isUnread={unreadConversations.has(conversation.id)}
                labels={labels}
                mobile={mobile}
                onCancelDelete={onCancelDelete}
                onConfirmDelete={() => onConfirmDelete?.(conversation.id)}
                onOpenActions={onOpenActions}
                onRequestDeleteConfirm={() =>
                  onRequestDeleteConfirm?.(conversation.id)
                }
                onRequestRename={() => onRequestRename?.(conversation)}
                onSelect={() => {
                  onSelect(conversation.id);
                  onClose?.();
                }}
                variant={variant}
              />
            ))
          )}
        </SidebarPanel>
      </SidebarScrollRegion>
    </Sidebar>
  );
}

export const ChatSidebar = Object.assign(ChatSidebarRoot, {
  Content: SidebarContent,
  Item: ChatConversationItem,
  Panel: SidebarPanel,
  RenameDialog: ChatConversationRenameDialog,
  ScrollRegion: SidebarScrollRegion,
});
