import {
  Button,
  ChatConversationItem,
  ChatSourceIcon,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Sidebar,
  SidebarCollapsedActionButton,
  SidebarContent,
  SidebarPanel,
  SidebarScrollRegion,
  TooltipProvider,
} from "@elizaos/ui";
import {
  Globe,
  MessagesSquare,
  Plus,
  Search,
  Settings2,
  Terminal as TerminalIcon,
  X,
} from "lucide-react";
import type React from "react";
import {
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { client } from "../../api";
import type { PluginInfo } from "../../api/client-types-config";
import { useApp } from "../../state";
import { usePtySessions } from "../../state/PtySessionsContext";
import {
  ALWAYS_ON_PLUGIN_IDS,
  iconImageSource,
  resolveIcon,
} from "../pages/plugin-list-utils";
import { getBrandIcon } from "./brand-icons";
import { ConversationRenameDialog } from "./ConversationRenameDialog";
import {
  ALL_CONNECTORS_SOURCE_SCOPE,
  ALL_WORLDS_SCOPE,
  buildConversationsSidebarModel,
  type ConversationsSidebarRow,
  ELIZA_SOURCE_SCOPE,
  TERMINAL_SOURCE_SCOPE,
} from "./conversation-sidebar-model";

/**
 * Id namespace for inbox-chat entries merged into the sidebar list.
 * Sidebar selection uses a flat string id; connector chats carry a
 * prefix so we can distinguish them from dashboard conversation UUIDs.
 */
const INBOX_ID_PREFIX = "inbox:";

/** Id namespace for PTY sessions surfaced under the Terminal channel. */
const TERMINAL_ID_PREFIX = "terminal:";

/** How often the inbox chat list refreshes while the sidebar is open. */
const INBOX_CHATS_REFRESH_MS = 5_000;

interface InboxChatRow {
  avatarUrl?: string;
  canSend?: boolean;
  id: string;
  lastMessageAt: number;
  roomType?: string;
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

function isTerminalRow(row: ConversationsSidebarRow): boolean {
  return row.sourceKey === TERMINAL_SOURCE_SCOPE;
}

function renderRailIdentity(row: ConversationsSidebarRow) {
  if (isTerminalRow(row)) {
    return <TerminalIcon className="h-4 w-4" />;
  }
  if (row.kind === "inbox" && typeof row.source === "string" && row.source) {
    return <ChatSourceIcon source={row.source} className="h-4 w-4" />;
  }

  return railMonogram(row.title);
}

function rowListId(row: ConversationsSidebarRow): string {
  if (isTerminalRow(row)) return `${TERMINAL_ID_PREFIX}${row.id}`;
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
      </span>
    );
  }
  return option.label;
}

function renderPluginIcon(plugin: PluginInfo): React.ReactNode | null {
  const icon = resolveIcon(plugin);
  if (!icon) return null;
  if (typeof icon === "string") {
    const src = iconImageSource(icon);
    return src ? (
      <img
        src={src}
        alt=""
        aria-hidden
        className="h-4 w-4 shrink-0 object-contain"
      />
    ) : (
      <span aria-hidden className="text-sm leading-none">
        {icon}
      </span>
    );
  }
  const IconComponent = icon;
  return <IconComponent className="h-4 w-4" />;
}

function renderSourceScopeIcon(
  option: {
    icon?: React.ComponentType<{ className?: string }>;
    value: string;
  },
  plugins: PluginInfo[],
) {
  if (option.value === ELIZA_SOURCE_SCOPE) {
    return <MessagesSquare className="h-4 w-4" />;
  }
  if (option.value === TERMINAL_SOURCE_SCOPE) {
    return <TerminalIcon className="h-4 w-4" />;
  }
  const Brand = getBrandIcon(option.value);
  if (Brand) {
    return <Brand className="h-4 w-4" />;
  }
  const plugin = plugins.find((p) => p.id === option.value);
  if (plugin) {
    const rendered = renderPluginIcon(plugin);
    if (rendered) return rendered;
  }
  const Icon = option.icon ?? MessagesSquare;
  return <Icon className="h-4 w-4" />;
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
    activeTerminalSessionId,
    unreadConversations,
    handleNewConversation,
    handleSelectConversation,
    handleDeleteConversation,
    plugins = [],
    ensurePluginsLoaded = async () => {},
    handlePluginToggle,
    setTab,
    setState,
    tab,
    t,
  } = useApp();
  const { ptySessions } = usePtySessions();

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
            roomType: chat.roomType,
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

  const spawnShellBusyRef = useRef(false);
  const spawnShell = useCallback(async () => {
    if (spawnShellBusyRef.current) return;
    spawnShellBusyRef.current = true;
    try {
      const { sessionId } = await client.spawnShellSession();
      setState("activeInboxChat", null);
      setState("activeTerminalSessionId", sessionId);
      setTab("chat");
    } catch (err) {
      console.error("[ConversationsSidebar] spawnShellSession failed:", err);
    } finally {
      spawnShellBusyRef.current = false;
    }
  }, [setState, setTab]);

  const selectTerminalSession = useCallback(
    (sessionId: string) => {
      setState("activeInboxChat", null);
      setState("activeTerminalSessionId", sessionId);
      setTab("chat");
      onClose?.();
    },
    [onClose, setState, setTab],
  );

  // When the Terminal channel is opened with no existing sessions,
  // immediately spawn one so the channel is never empty.
  useEffect(() => {
    if (
      sourceScope === TERMINAL_SOURCE_SCOPE &&
      ptySessions.length === 0 &&
      !activeTerminalSessionId
    ) {
      void spawnShell();
    }
  }, [sourceScope, ptySessions.length, activeTerminalSessionId, spawnShell]);

  // If something outside the sidebar (AgentActivityBox click, error auto-
  // promote) focuses a terminal session, switch the sidebar scope to match
  // so the user sees the session list rather than a stale channel.
  useEffect(() => {
    if (activeTerminalSessionId && sourceScope !== TERMINAL_SOURCE_SCOPE) {
      setSourceScope(TERMINAL_SOURCE_SCOPE);
    }
  }, [activeTerminalSessionId, sourceScope]);

  const handleRowSelect = (row: ConversationsSidebarRow) => {
    setConfirmDeleteId(null);
    setMenuConversation(null);

    if (isTerminalRow(row)) {
      selectTerminalSession(row.id);
      return;
    }

    if (row.kind === "inbox") {
      setState("activeTerminalSessionId", null);
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
      setState("activeTerminalSessionId", null);
      void handleSelectConversation(row.id);
    }

    setTab("chat");
    onClose?.();
  };

  const handleNewChat = () => {
    setSourceScope(ELIZA_SOURCE_SCOPE);
    setWorldScope(ALL_WORLDS_SCOPE);
    setState("activeInboxChat", null);
    setTab("chat");
    void handleNewConversation();
    onClose?.();
  };

  const handleManageConnections = () => {
    if (tab === "connectors") {
      setTab("chat");
    } else {
      setTab("connectors");
    }
    onClose?.();
  };

  const isGameModal = variant === "game-modal";
  const isManageConnectionsActive = tab === "connectors";

  // Plugins supply the scope-chip icons, so load them eagerly (not only
  // when the user opens the manage panel).
  useEffect(() => {
    void ensurePluginsLoaded();
  }, [ensurePluginsLoaded]);

  const connectorPlugins = useMemo(
    () =>
      plugins.filter(
        (p) =>
          p.category === "connector" &&
          !ALWAYS_ON_PLUGIN_IDS.has(p.id) &&
          p.visible !== false,
      ),
    [plugins],
  );

  const [togglingPlugins, setTogglingPlugins] = useState<Set<string>>(
    new Set(),
  );
  const handleConnectorToggle = useCallback(
    async (pluginId: string, enabled: boolean) => {
      setTogglingPlugins((prev) => new Set(prev).add(pluginId));
      try {
        await handlePluginToggle(pluginId, enabled);
      } finally {
        setTogglingPlugins((prev) => {
          const next = new Set(prev);
          next.delete(pluginId);
          return next;
        });
      }
    },
    [handlePluginToggle],
  );

  const renderConnectorIcon = useCallback((plugin: (typeof plugins)[0]) => {
    const Brand = getBrandIcon(plugin.id);
    if (Brand) return <Brand className="h-4 w-4" />;
    const icon = resolveIcon(plugin);
    if (!icon) return <span className="text-sm">🧩</span>;
    if (typeof icon === "string") {
      const src = iconImageSource(icon);
      return src ? (
        <img
          src={src}
          alt=""
          className="h-4 w-4 shrink-0 rounded-[var(--radius-sm)] object-contain"
          onError={(e) => {
            (e.currentTarget as HTMLImageElement).style.display = "none";
          }}
        />
      ) : (
        <span className="text-sm">{icon}</span>
      );
    }
    const IconComponent = icon;
    return <IconComponent className="h-4 w-4" />;
  }, []);

  const isTerminalScope = sidebarModel.sourceScope === TERMINAL_SOURCE_SCOPE;

  const showNewChatAction =
    tab === "chat" && sidebarModel.sourceScope === ELIZA_SOURCE_SCOPE;
  const showNewTerminalAction = tab === "chat" && isTerminalScope;
  const newChatAction = isGameModal ? (
    <Button
      variant="outline"
      className="h-11 w-full rounded-sm border-[color:var(--onboarding-accent-border)] bg-[color:var(--onboarding-accent-bg)] px-3 py-2 text-sm font-medium text-[color:var(--onboarding-text-strong)] shadow-md hover:border-[color:var(--onboarding-accent-border-hover)] hover:bg-[color:var(--onboarding-accent-bg-hover)] active:scale-[0.98]"
      onClick={handleNewChat}
    >
      {t("conversations.newChat")}
    </Button>
  ) : (
    <button
      type="button"
      onClick={handleNewChat}
      className="inline-flex h-6 items-center gap-1 rounded-[var(--radius-sm)] bg-transparent px-1 text-2xs font-semibold uppercase tracking-[0.12em] text-muted transition-colors hover:text-txt"
    >
      <Plus className="h-3.5 w-3.5" aria-hidden />
      <span>{t("conversations.newChatShort", { defaultValue: "New" })}</span>
    </button>
  );
  const newTerminalAction = (
    <button
      type="button"
      onClick={() => void spawnShell()}
      className="inline-flex h-6 items-center gap-1 rounded-[var(--radius-sm)] bg-transparent px-1 text-2xs font-semibold uppercase tracking-[0.12em] text-muted transition-colors hover:text-txt"
    >
      <Plus className="h-3.5 w-3.5" aria-hidden />
      <span>
        {t("conversations.newTerminalShort", { defaultValue: "New" })}
      </span>
    </button>
  );

  const terminalRows = useMemo(() => {
    if (!isTerminalScope) return [] as ConversationsSidebarRow[];
    return ptySessions.map<ConversationsSidebarRow>((session) => ({
      id: session.sessionId,
      kind: "conversation",
      sortKey: 0,
      source: TERMINAL_SOURCE_SCOPE,
      sourceKey: TERMINAL_SOURCE_SCOPE,
      title: session.label,
      updatedAtLabel: "",
      worldKey: null,
    }));
  }, [isTerminalScope, ptySessions]);

  const terminalListId = activeTerminalSessionId
    ? `${TERMINAL_ID_PREFIX}${activeTerminalSessionId}`
    : null;
  const activeListId = isTerminalScope
    ? terminalListId
    : activeInboxChat
      ? `${INBOX_ID_PREFIX}${activeInboxChat.id}`
      : activeConversationId;

  const displayRows = isTerminalScope ? terminalRows : sidebarModel.rows;
  const displaySections = isTerminalScope
    ? terminalRows.length > 0
      ? [
          {
            count: terminalRows.length,
            key: TERMINAL_SOURCE_SCOPE,
            label: t("conversations.scopeTerminal", {
              defaultValue: "Terminal",
            }),
            rows: terminalRows,
          },
        ]
      : []
    : sidebarModel.sections;

  const emptyStateLabel = searchQuery.trim()
    ? t("conversations.noMatchingChats", {
        defaultValue: "No matching chats",
      })
    : isTerminalScope
      ? t("conversations.noneTerminal", {
          defaultValue: "Spawning a terminal…",
        })
      : sidebarModel.sourceScope === ELIZA_SOURCE_SCOPE
        ? t("conversations.noneApp", {
            defaultValue: "No chats yet",
          })
        : t("conversations.noneConnectors", {
            defaultValue: "No chats in this view",
          });
  const searchControl = !isManageConnectionsActive ? (
    <div className="relative w-full">
      <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted" />
      <input
        type="text"
        data-testid="chat-sidebar-search-input"
        value={searchQuery}
        onChange={(event) => setSearchQuery(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            setSearchQuery("");
            (event.currentTarget as HTMLInputElement).blur();
          }
        }}
        placeholder={t("conversations.searchChats", {
          defaultValue: "Search chats",
        })}
        aria-label={t("conversations.searchChats", {
          defaultValue: "Search chats",
        })}
        autoComplete="off"
        spellCheck={false}
        className="h-11 w-full rounded-sm border border-border/32 bg-transparent pl-8 pr-7 text-sm text-txt placeholder:text-muted focus:border-border/60 focus:outline-none"
      />
      {searchQuery ? (
        <button
          type="button"
          onClick={() => setSearchQuery("")}
          className="absolute right-2 top-1/2 -translate-y-1/2 text-muted hover:text-txt"
          aria-label={t("common.clear", {
            defaultValue: "Clear",
          })}
        >
          <X className="h-3.5 w-3.5" aria-hidden />
        </button>
      ) : null}
    </div>
  ) : undefined;
  const manageConnectionsButton = (
    <button
      type="button"
      data-testid="chat-sidebar-manage-toggle"
      aria-pressed={isManageConnectionsActive}
      onClick={handleManageConnections}
      className={`inline-flex h-6 shrink-0 items-center gap-1 rounded-[var(--radius-sm)] bg-transparent px-1 text-2xs font-semibold uppercase tracking-[0.12em] transition-colors ${
        isManageConnectionsActive ? "text-txt" : "text-muted hover:text-txt"
      }`}
    >
      <Settings2 className="h-3.5 w-3.5" aria-hidden />
      <span>
        {t("conversations.manageConnections", {
          defaultValue: "Manage",
        })}
      </span>
    </button>
  );

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
        onOpenChange={(open: boolean) => {
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
            onCloseAutoFocus={(event: Event) => event.preventDefault()}
            onClick={(event: React.MouseEvent) => event.stopPropagation()}
            onPointerDown={(event: React.PointerEvent) =>
              event.stopPropagation()
            }
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
        className={
          !mobile && !isGameModal
            ? "!mt-0 !h-full !bg-none !bg-transparent !rounded-none !border-0 !border-r !border-r-border/30 !shadow-none !backdrop-blur-none !ring-0"
            : undefined
        }
        collapseButtonTestId="chat-sidebar-collapse-toggle"
        expandButtonTestId="chat-sidebar-expand-toggle"
        collapseButtonAriaLabel={t("conversations.closePanel")}
        expandButtonAriaLabel={t("aria.expandChatsPanel")}
        header={undefined}
        collapseButtonLeading={
          <div className="flex items-center gap-1.5 px-1 text-xs font-semibold uppercase tracking-wider text-muted">
            <MessagesSquare className="h-3.5 w-3.5" aria-hidden />
            <span>
              {t("conversations.filterScope", {
                defaultValue: "Channels",
              })}
            </span>
          </div>
        }
        footer={
          searchControl ? (
            <div className="w-full px-3 pb-3 pt-2">{searchControl}</div>
          ) : undefined
        }
        footerClassName="border-t border-border/30 !justify-start !px-0 !pb-0 !pt-0"
        collapsedRailAction={
          showNewTerminalAction ? (
            <SidebarCollapsedActionButton
              aria-label={t("conversations.newTerminal", {
                defaultValue: "New terminal",
              })}
              onClick={() => void spawnShell()}
            >
              <Plus className="h-4 w-4" />
            </SidebarCollapsedActionButton>
          ) : showNewChatAction ? (
            <SidebarCollapsedActionButton
              aria-label={t("conversations.newChat")}
              onClick={handleNewChat}
            >
              <Plus className="h-4 w-4" />
            </SidebarCollapsedActionButton>
          ) : undefined
        }
        collapsedRailItems={displayRows.map((row) => (
          <SidebarContent.RailItem
            key={rowListId(row)}
            aria-label={row.title}
            title={row.title}
            active={rowListId(row) === activeListId}
            indicatorTone={
              row.kind === "conversation" &&
              !isTerminalRow(row) &&
              unreadConversations.has(row.id)
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
        mobileMeta={mobile ? String(displayRows.length) : undefined}
        data-no-window-drag=""
        aria-label={t("conversations.chats")}
      >
        <SidebarScrollRegion
          variant={isGameModal ? "game-modal" : "default"}
          className={isGameModal ? undefined : "px-1 pb-2 pt-0"}
        >
          <SidebarPanel
            variant={isGameModal ? "game-modal" : "default"}
            className={
              isGameModal ? undefined : "bg-transparent gap-0 p-0 shadow-none"
            }
          >
            {!isManageConnectionsActive ? (
              <div className="flex min-w-0 items-center gap-1 px-1 pb-1">
                <div className="flex min-w-0 flex-1 flex-wrap items-center gap-0.5">
                  {sidebarModel.sourceOptions.map((option) => {
                    if (option.value === ALL_CONNECTORS_SOURCE_SCOPE)
                      return null;
                    const isActive = sidebarModel.sourceScope === option.value;
                    return (
                      <button
                        key={option.value}
                        type="button"
                        aria-label={option.label}
                        title={option.label}
                        onClick={() => {
                          setSourceScope(option.value);
                          setWorldScope(ALL_WORLDS_SCOPE);
                        }}
                        className={`inline-flex h-6 w-6 items-center justify-center rounded-[var(--radius-sm)] bg-transparent transition-colors ${
                          isActive ? "text-txt" : "text-muted hover:text-txt"
                        }`}
                      >
                        {renderSourceScopeIcon(option, plugins)}
                      </button>
                    );
                  })}
                </div>
                {sidebarModel.showWorldFilter ? (
                  <div className="min-w-0 max-w-[42%] shrink">
                    <Select
                      value={sidebarModel.worldScope}
                      onValueChange={setWorldScope}
                    >
                      <SelectTrigger
                        className="h-6 min-h-0 gap-1 rounded-[var(--radius-sm)] border-transparent bg-transparent px-1 text-2xs font-medium uppercase tracking-[0.08em] text-muted shadow-none hover:text-txt [&>span]:flex [&>span]:min-w-0 [&>span]:items-center [&>span]:gap-1.5 [&>span]:truncate"
                        aria-label={t("conversations.filterWorld", {
                          defaultValue: "Server / world",
                        })}
                      >
                        <Globe className="h-3.5 w-3.5 shrink-0" />
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent className="min-w-[18rem] max-w-[24rem]">
                        {sidebarModel.worldOptions.map((option) => (
                          <SelectItem
                            key={option.value}
                            value={option.value}
                            className="[&>span:last-child]:min-w-0 [&>span:last-child]:max-w-full [&>span:last-child]:truncate [&>span:last-child]:whitespace-nowrap"
                          >
                            {selectLabel(option)}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                ) : null}
                {manageConnectionsButton}
              </div>
            ) : (
              <div className="flex items-center justify-between gap-2 px-1 pb-1">
                <span className="text-2xs font-semibold uppercase tracking-[0.16em] text-muted">
                  {t("conversations.connectors", {
                    defaultValue: "Connectors",
                  })}
                </span>
                {manageConnectionsButton}
              </div>
            )}

            {isManageConnectionsActive ? (
              <div className="space-y-1">
                {connectorPlugins.length === 0 ? (
                  <SidebarContent.EmptyState className="px-4 py-6">
                    {t("pluginsview.NoConnectorsAvailable", {
                      defaultValue: "No connectors available.",
                    })}
                  </SidebarContent.EmptyState>
                ) : (
                  connectorPlugins.map((plugin) => {
                    const isToggleBusy = togglingPlugins.has(plugin.id);
                    const toggleDisabled =
                      isToggleBusy ||
                      (togglingPlugins.size > 0 && !isToggleBusy);
                    return (
                      <SidebarContent.Item
                        key={plugin.id}
                        as="div"
                        className="items-center gap-1.5 px-2.5 py-2"
                      >
                        <SidebarContent.ItemButton
                          className="items-center gap-2"
                          onClick={() => {
                            /* selecting handled by main content */
                          }}
                        >
                          <SidebarContent.ItemIcon className="mt-0 h-8 w-8 shrink-0 p-1.5">
                            {renderConnectorIcon(plugin)}
                          </SidebarContent.ItemIcon>
                          <SidebarContent.ItemBody>
                            <span className="block truncate text-sm font-semibold leading-5 text-txt">
                              {plugin.name}
                            </span>
                          </SidebarContent.ItemBody>
                        </SidebarContent.ItemButton>
                        <Button
                          variant="outline"
                          size="sm"
                          className={`h-7 min-h-0 min-w-[3.5rem] shrink-0 rounded-[var(--radius-sm)] border px-2.5 py-0 text-2xs font-bold leading-none tracking-[0.16em] transition-colors ${
                            plugin.enabled
                              ? "border-accent bg-accent text-accent-fg"
                              : "border-border bg-transparent text-muted hover:border-accent/40 hover:text-txt"
                          } ${
                            toggleDisabled
                              ? "cursor-not-allowed opacity-60"
                              : "cursor-pointer"
                          }`}
                          onClick={(event: React.MouseEvent) => {
                            event.stopPropagation();
                            void handleConnectorToggle(
                              plugin.id,
                              !plugin.enabled,
                            );
                          }}
                          disabled={toggleDisabled}
                        >
                          {isToggleBusy
                            ? "..."
                            : plugin.enabled
                              ? t("common.on")
                              : t("common.off")}
                        </Button>
                      </SidebarContent.Item>
                    );
                  })
                )}
              </div>
            ) : displaySections.length === 0 ? (
              <>
                {showNewChatAction || showNewTerminalAction ? (
                  <div className="mb-1 flex justify-end px-1.5">
                    {showNewTerminalAction ? newTerminalAction : newChatAction}
                  </div>
                ) : null}
                <SidebarContent.EmptyState
                  variant={isGameModal ? "game-modal" : "default"}
                  className={
                    !isGameModal ? "border-border/50 bg-bg/35" : undefined
                  }
                >
                  {emptyStateLabel}
                </SidebarContent.EmptyState>
              </>
            ) : (
              <div className="mt-0.5 space-y-1">
                {displaySections.map((section, sectionIndex) => (
                  <section key={section.key} className="space-y-0">
                    <SidebarContent.SectionHeader className="mb-0 px-2.5 pt-0 pb-0">
                      <SidebarContent.SectionLabel className="text-muted/80">
                        {section.label}
                      </SidebarContent.SectionLabel>
                      {sectionIndex === 0 &&
                      !isManageConnectionsActive &&
                      (showNewChatAction || showNewTerminalAction)
                        ? showNewTerminalAction
                          ? newTerminalAction
                          : newChatAction
                        : null}
                    </SidebarContent.SectionHeader>

                    <div className="space-y-0">
                      {section.rows.map((row) => {
                        const conversationId = rowListId(row);
                        return (
                          <ChatConversationItem
                            key={conversationId}
                            conversation={{
                              id: conversationId,
                              ...(row.source ? { source: row.source } : {}),
                              title: row.title,
                              updatedAtLabel: row.updatedAtLabel,
                            }}
                            deleting={deletingId === row.id}
                            isActive={conversationId === activeListId}
                            isConfirmingDelete={
                              row.kind === "conversation" &&
                              !isTerminalRow(row) &&
                              confirmDeleteId === row.id
                            }
                            isUnread={
                              row.kind === "conversation" &&
                              !isTerminalRow(row) &&
                              unreadConversations.has(row.id)
                            }
                            labels={{
                              actions: t("conversations.actions", {
                                defaultValue: "More actions",
                              }),
                              delete: t("conversations.delete"),
                              deleteConfirm: t("conversations.deleteConfirm"),
                              deleteNo: t("conversations.deleteNo"),
                              deleteYes: t("conversations.deleteYes"),
                              rename: t("conversations.rename"),
                            }}
                            mobile={mobile}
                            onCancelDelete={() => setConfirmDeleteId(null)}
                            onConfirmDelete={() => {
                              if (row.kind === "inbox" || isTerminalRow(row))
                                return;
                              void handleConfirmDelete(row.id);
                            }}
                            onOpenActions={(event) => {
                              if (row.kind === "inbox" || isTerminalRow(row)) {
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
                              if (row.kind === "inbox" || isTerminalRow(row))
                                return;
                              setMenuConversation(null);
                              setRenameTarget(null);
                              setConfirmDeleteId(row.id);
                            }}
                            onRequestRename={() => {
                              if (row.kind === "inbox" || isTerminalRow(row))
                                return;
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
