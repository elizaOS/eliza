import {
  Button,
  ChatConversationItem,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  NewActionButton,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Sidebar,
  SidebarCollapsedActionButton,
  SidebarContent,
  SidebarHeader,
  SidebarPanel,
  SidebarScrollRegion,
  TooltipProvider,
} from "@elizaos/app-core";
import { Plus } from "lucide-react";
import type React from "react";
import { useDeferredValue, useEffect, useMemo, useRef, useState } from "react";

import { client } from "../../api";
import { useApp } from "../../state";
import { ConversationRenameDialog } from "./ConversationRenameDialog";
import {
  ALL_WORLDS_SCOPE,
  buildConversationsSidebarModel,
  type ConversationsSidebarRow,
  ELIZA_SOURCE_SCOPE,
} from "./conversation-sidebar-model";

/**
 * Id namespace for inbox-chat entries merged into the sidebar list.
 * Sidebar selection uses a flat string id; connector chats carry a
 * prefix so we can distinguish them from dashboard conversation UUIDs.
 */
const INBOX_ID_PREFIX = "inbox:";

/** How often the inbox chat list refreshes while the sidebar is open. */
const INBOX_CHATS_REFRESH_MS = 5_000;

interface InboxChatRow {
  avatarUrl?: string;
  canSend?: boolean;
  id: string;
  lastMessageAt: number;
  source: string;
  transportSource?: string;
  title: string;
  worldId?: string;
  worldLabel: string;
}

type ConversationsSidebarVariant = "default" | "game-modal";

interface ConversationsSidebarProps {
  mobile?: boolean;
  onClose?: () => void;
  variant?: ConversationsSidebarVariant;
}

function railMonogram(label: string): string {
  const words = label.trim().split(/\s+/).filter(Boolean);
  const initials = words
    .slice(0, 2)
    .map((word) => word[0]?.toUpperCase() ?? "")
    .join("");
  return (initials || label.slice(0, 1).toUpperCase() || "?").slice(0, 2);
}

function renderRailIdentity(row: ConversationsSidebarRow) {
  if (row.avatarUrl) {
    return (
      <img
        src={row.avatarUrl}
        alt={`${row.title} avatar`}
        className="h-8 w-8 rounded-full object-cover"
      />
    );
  }

  return railMonogram(row.title);
}

function rowListId(row: ConversationsSidebarRow): string {
  return row.kind === "inbox" ? `${INBOX_ID_PREFIX}${row.id}` : row.id;
}

function selectLabel(option: {
  count: number;
  icon?: React.ComponentType<{ className?: string }>;
  label: string;
}) {
  const Icon = option.icon;
  if (Icon) {
    return (
      <span className="inline-flex items-center gap-1.5">
        <Icon className="h-3.5 w-3.5 shrink-0" />
        <span>{option.label}</span>
        <span className="text-muted">({option.count})</span>
      </span>
    );
  }
  return `${option.label} (${option.count})`;
}

export function ConversationsSidebar({
  mobile = false,
  onClose,
  variant = "default",
}: ConversationsSidebarProps) {
  const {
    conversations,
    activeConversationId,
    activeInboxChat,
    unreadConversations,
    handleNewConversation,
    handleSelectConversation,
    handleDeleteConversation,
    setState,
    t,
  } = useApp();

  const [inboxChats, setInboxChats] = useState<InboxChatRow[]>([]);
  const [renameTarget, setRenameTarget] = useState<{
    id: string;
    title: string;
  } | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [menuConversation, setMenuConversation] = useState<{
    id: string;
    title: string;
  } | null>(null);
  const [menuPosition, setMenuPosition] = useState({ x: 0, y: 0 });
  const menuAnchorRef = useRef<HTMLDivElement>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const deferredSearchQuery = useDeferredValue(searchQuery);
  const [sourceScope, setSourceScope] = useState(ELIZA_SOURCE_SCOPE);
  const [worldScope, setWorldScope] = useState(ALL_WORLDS_SCOPE);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const response = await client.getInboxChats();
        if (cancelled) return;
        setInboxChats(
          response.chats.map((chat) => ({
            avatarUrl: chat.avatarUrl,
            canSend: chat.canSend,
            id: chat.id,
            lastMessageAt: chat.lastMessageAt,
            source: chat.source,
            transportSource: chat.transportSource,
            title: chat.title,
            worldId: chat.worldId,
            worldLabel: chat.worldLabel,
          })),
        );
      } catch {
        // Keep the last successful snapshot on transient failures.
      }
    };
    void load();
    const timer = window.setInterval(load, INBOX_CHATS_REFRESH_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  const sidebarModel = useMemo(
    () =>
      buildConversationsSidebarModel({
        conversations,
        inboxChats,
        searchQuery: deferredSearchQuery,
        sourceScope,
        t,
        worldScope,
      }),
    [
      conversations,
      deferredSearchQuery,
      inboxChats,
      sourceScope,
      t,
      worldScope,
    ],
  );

  useEffect(() => {
    if (sourceScope !== sidebarModel.sourceScope) {
      setSourceScope(sidebarModel.sourceScope);
    }
  }, [sidebarModel.sourceScope, sourceScope]);

  useEffect(() => {
    if (worldScope !== sidebarModel.worldScope) {
      setWorldScope(sidebarModel.worldScope);
    }
  }, [sidebarModel.worldScope, worldScope]);

  const openRenameDialog = (conversation: { id: string; title: string }) => {
    setConfirmDeleteId(null);
    setMenuConversation(null);
    setRenameTarget({ id: conversation.id, title: conversation.title });
  };

  const openActionsMenu = (
    event: React.MouseEvent<HTMLElement> | React.TouchEvent<HTMLElement>,
    conversation: { id: string; title: string },
  ) => {
    event.preventDefault();
    event.stopPropagation();
    setConfirmDeleteId(null);
    setMenuConversation(conversation);
    if ("touches" in event) {
      const touch = event.touches[0] ?? event.changedTouches[0];
      setMenuPosition({ x: touch?.clientX ?? 0, y: touch?.clientY ?? 0 });
      return;
    }
    setMenuPosition({ x: event.clientX, y: event.clientY });
  };

  const handleConfirmDelete = async (id: string) => {
    if (deletingId) return;
    setDeletingId(id);
    try {
      await handleDeleteConversation(id);
    } finally {
      setDeletingId(null);
      setConfirmDeleteId((current) => (current === id ? null : current));
    }
  };

  const handleRowSelect = (row: ConversationsSidebarRow) => {
    setConfirmDeleteId(null);
    setMenuConversation(null);

    if (row.kind === "inbox") {
      setState("activeInboxChat", {
        avatarUrl: row.avatarUrl,
        canSend:
          row.kind === "inbox" && typeof row.canSend === "boolean"
            ? row.canSend
            : undefined,
        id: row.id,
        source: row.source ?? "",
        transportSource: row.transportSource,
        title: row.title,
        worldId: row.worldId,
        worldLabel: row.worldLabel,
      });
    } else {
      setState("activeInboxChat", null);
      void handleSelectConversation(row.id);
    }

    onClose?.();
  };

  const handleNewChat = () => {
    setSourceScope(ELIZA_SOURCE_SCOPE);
    setWorldScope(ALL_WORLDS_SCOPE);
    setState("activeInboxChat", null);
    void handleNewConversation();
    onClose?.();
  };

  const isGameModal = variant === "game-modal";
  const newChatAction = isGameModal ? (
    <Button
      variant="outline"
      className="h-11 w-full rounded-xl border-[color:var(--onboarding-accent-border)] bg-[color:var(--onboarding-accent-bg)] px-3 py-2 text-sm font-medium text-[color:var(--onboarding-text-strong)] shadow-[0_12px_28px_rgba(0,0,0,0.18)] hover:border-[color:var(--onboarding-accent-border-hover)] hover:bg-[color:var(--onboarding-accent-bg-hover)] active:scale-[0.98]"
      onClick={handleNewChat}
    >
      {t("conversations.newChat")}
    </Button>
  ) : (
    <NewActionButton onClick={handleNewChat}>
      {t("conversations.newChat")}
    </NewActionButton>
  );

  const activeListId = activeInboxChat
    ? `${INBOX_ID_PREFIX}${activeInboxChat.id}`
    : activeConversationId;
  const emptyStateLabel = searchQuery.trim()
    ? t("conversations.noMatchingChats", {
        defaultValue: "No matching chats",
      })
    : sidebarModel.sourceScope === ELIZA_SOURCE_SCOPE
      ? t("conversations.noneApp", {
          defaultValue: "No chats yet",
        })
      : t("conversations.noneConnectors", {
          defaultValue: "No chats in this view",
        });

  return (
    <TooltipProvider delayDuration={280} skipDelayDuration={120}>
      <ConversationRenameDialog
        open={renameTarget !== null}
        conversationId={renameTarget?.id ?? null}
        initialTitle={renameTarget?.title ?? ""}
        onClose={() => setRenameTarget(null)}
      />

      <DropdownMenu
        open={menuConversation !== null}
        onOpenChange={(open) => {
          if (!open) setMenuConversation(null);
        }}
      >
        <DropdownMenuTrigger asChild>
          <div
            ref={menuAnchorRef}
            aria-hidden
            className="fixed h-0 w-0 pointer-events-none"
            style={{
              left: menuPosition.x,
              top: menuPosition.y,
            }}
          />
        </DropdownMenuTrigger>
        {menuConversation ? (
          <DropdownMenuContent
            sideOffset={6}
            align="start"
            className="w-40"
            onCloseAutoFocus={(event) => event.preventDefault()}
            onClick={(event) => event.stopPropagation()}
            onPointerDown={(event) => event.stopPropagation()}
            onPointerDownOutside={() => setMenuConversation(null)}
            onInteractOutside={() => setMenuConversation(null)}
            avoidCollisions
            collisionPadding={12}
          >
            <DropdownMenuItem
              data-testid="conv-menu-edit"
              onClick={() => {
                if (!menuConversation) return;
                openRenameDialog(menuConversation);
              }}
            >
              {t("conversations.rename")}
            </DropdownMenuItem>
            <DropdownMenuItem
              data-testid="conv-menu-delete"
              className="text-danger focus:text-danger"
              onClick={() => {
                if (!menuConversation) return;
                setRenameTarget(null);
                setConfirmDeleteId(menuConversation.id);
                setMenuConversation(null);
              }}
            >
              {t("conversations.delete")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        ) : null}
      </DropdownMenu>

      <Sidebar
        testId="conversations-sidebar"
        variant={mobile ? "mobile" : isGameModal ? "game-modal" : "default"}
        collapsible={!mobile && !isGameModal}
        contentIdentity={
          mobile ? "chat-mobile" : isGameModal ? "chat-modal" : "chat"
        }
        collapseButtonTestId="chat-sidebar-collapse-toggle"
        expandButtonTestId="chat-sidebar-expand-toggle"
        collapseButtonAriaLabel={t("conversations.closePanel")}
        expandButtonAriaLabel={t("aria.expandChatsPanel")}
        header={
          <SidebarHeader
            search={{
              value: searchQuery,
              onChange: (event) => setSearchQuery(event.target.value),
              onClear: () => setSearchQuery(""),
              placeholder: t("conversations.searchChats", {
                defaultValue: "Search chats",
              }),
              "aria-label": t("conversations.searchChats", {
                defaultValue: "Search chats",
              }),
              clearLabel: t("common.clear", { defaultValue: "Clear" }),
              autoComplete: "off",
              spellCheck: false,
            }}
          />
        }
        collapsedRailAction={
          <SidebarCollapsedActionButton
            aria-label={t("conversations.newChat")}
            onClick={handleNewChat}
          >
            <Plus className="h-4 w-4" />
          </SidebarCollapsedActionButton>
        }
        collapsedRailItems={sidebarModel.rows.map((row) => (
          <SidebarContent.RailItem
            key={rowListId(row)}
            aria-label={row.title}
            title={row.title}
            active={rowListId(row) === activeListId}
            indicatorTone={
              row.kind === "conversation" && unreadConversations.has(row.id)
                ? "accent"
                : undefined
            }
            onClick={() => handleRowSelect(row)}
          >
            {renderRailIdentity(row)}
          </SidebarContent.RailItem>
        ))}
        onMobileClose={mobile ? onClose : undefined}
        mobileCloseLabel={t("conversations.closePanel")}
        mobileTitle={
          mobile ? (
            <SidebarContent.SectionLabel>
              {t("conversations.chats")}
            </SidebarContent.SectionLabel>
          ) : undefined
        }
        mobileMeta={mobile ? String(sidebarModel.rows.length) : undefined}
        data-no-window-drag=""
        aria-label={t("conversations.chats")}
      >
        <SidebarScrollRegion variant={isGameModal ? "game-modal" : "default"}>
          <SidebarPanel variant={isGameModal ? "game-modal" : "default"}>
            <div className="mb-3">{newChatAction}</div>

            <div className="mb-3 grid gap-2">
              <div
                className={
                  sidebarModel.showWorldFilter
                    ? "grid gap-2 sm:grid-cols-2"
                    : "grid gap-2"
                }
              >
                <div className="grid gap-1">
                  <span className="px-1 text-2xs font-semibold uppercase tracking-[0.16em] text-muted">
                    {t("conversations.filterScope", {
                      defaultValue: "Source",
                    })}
                  </span>
                  <Select
                    value={sidebarModel.sourceScope}
                    onValueChange={(value) => {
                      setSourceScope(value);
                      setWorldScope(ALL_WORLDS_SCOPE);
                    }}
                  >
                    <SelectTrigger
                      className="h-10 rounded-2xl border-border/45 bg-card/55 text-left shadow-[inset_0_1px_0_rgba(255,255,255,0.06)]"
                      aria-label={t("conversations.filterScope", {
                        defaultValue: "Source",
                      })}
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {sidebarModel.sourceOptions.map((option) => (
                        <SelectItem key={option.value} value={option.value}>
                          {selectLabel(option)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                {sidebarModel.showWorldFilter ? (
                  <div className="grid gap-1">
                    <span className="px-1 text-2xs font-semibold uppercase tracking-[0.16em] text-muted">
                      {t("conversations.filterWorld", {
                        defaultValue: "Server / world",
                      })}
                    </span>
                    <Select
                      value={sidebarModel.worldScope}
                      onValueChange={setWorldScope}
                    >
                      <SelectTrigger
                        className="h-10 rounded-2xl border-border/45 bg-card/55 text-left shadow-[inset_0_1px_0_rgba(255,255,255,0.06)]"
                        aria-label={t("conversations.filterWorld", {
                          defaultValue: "Server / world",
                        })}
                      >
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {sidebarModel.worldOptions.map((option) => (
                          <SelectItem key={option.value} value={option.value}>
                            {selectLabel(option)}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                ) : null}
              </div>
            </div>

            {sidebarModel.sections.length === 0 ? (
              <SidebarContent.EmptyState
                variant={isGameModal ? "game-modal" : "default"}
                className={
                  !isGameModal ? "border-border/50 bg-bg/35" : undefined
                }
              >
                {emptyStateLabel}
              </SidebarContent.EmptyState>
            ) : (
              <div className="space-y-4">
                {sidebarModel.sections.map((section) => (
                  <section key={section.key} className="space-y-2">
                    <SidebarContent.SectionHeader meta={String(section.count)}>
                      <SidebarContent.SectionLabel>
                        {section.label}
                      </SidebarContent.SectionLabel>
                    </SidebarContent.SectionHeader>

                    <div className="space-y-2">
                      {section.rows.map((row) => {
                        const conversationId = rowListId(row);
                        return (
                          <ChatConversationItem
                            key={conversationId}
                            conversation={{
                              avatarUrl: row.avatarUrl,
                              id: conversationId,
                              ...(row.source ? { source: row.source } : {}),
                              title: row.title,
                              updatedAtLabel: row.updatedAtLabel,
                            }}
                            deleting={deletingId === row.id}
                            isActive={conversationId === activeListId}
                            isConfirmingDelete={
                              row.kind === "conversation" &&
                              confirmDeleteId === row.id
                            }
                            isUnread={
                              row.kind === "conversation" &&
                              unreadConversations.has(row.id)
                            }
                            labels={{
                              delete: t("conversations.delete"),
                              deleteConfirm: t("conversations.deleteConfirm"),
                              deleteNo: t("conversations.deleteNo"),
                              deleteYes: t("conversations.deleteYes"),
                              rename: t("conversations.rename"),
                            }}
                            mobile={mobile}
                            onCancelDelete={() => setConfirmDeleteId(null)}
                            onConfirmDelete={() => {
                              if (row.kind === "inbox") return;
                              void handleConfirmDelete(row.id);
                            }}
                            onOpenActions={(event) => {
                              if (row.kind === "inbox") {
                                event.preventDefault();
                                event.stopPropagation();
                                return;
                              }
                              openActionsMenu(event, {
                                id: row.id,
                                title: row.title,
                              });
                            }}
                            onRequestDeleteConfirm={() => {
                              if (row.kind === "inbox") return;
                              setMenuConversation(null);
                              setRenameTarget(null);
                              setConfirmDeleteId(row.id);
                            }}
                            onRequestRename={() => {
                              if (row.kind === "inbox") return;
                              openRenameDialog({
                                id: row.id,
                                title: row.title,
                              });
                            }}
                            onSelect={() => handleRowSelect(row)}
                            variant={variant}
                          />
                        );
                      })}
                    </div>
                  </section>
                ))}
              </div>
            )}
          </SidebarPanel>
        </SidebarScrollRegion>
      </Sidebar>
    </TooltipProvider>
  );
}
