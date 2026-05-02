import {
  ChatConversationItem,
  ChatSourceIcon,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  getChatSourceMeta,
  SidebarCollapsedActionButton,
  SidebarContent,
  SidebarPanel,
  SidebarScrollRegion,
  Switch,
  TooltipProvider,
  useIntervalWhenDocumentVisible,
} from "@elizaos/ui";
import {
  MessagesSquare,
  Plus,
  Settings2,
  Terminal as TerminalIcon,
} from "lucide-react";
import type React from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { client } from "../../api";
import type { Conversation } from "../../api/client-types-chat";
import {
  PULSE_STATUSES,
  STATUS_DOT,
} from "../../chat/coding-agent-session-state";
import { useApp } from "../../state";
import { usePtySessions } from "../../state/PtySessionsContext";
import { errorMessage } from "../../utils/errors";
import {
  ALWAYS_ON_PLUGIN_IDS,
  iconImageSource,
  resolveIcon,
} from "../pages/plugin-list-utils";
import { AppPageSidebar } from "../shared/AppPageSidebar";
import { CollapsibleSidebarSection } from "../shared/CollapsibleSidebarSection";
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

function isLegacyUntitledConversationCandidate(
  conversation: Conversation,
): boolean {
  if (conversation.metadata?.scope) {
    return false;
  }
  return conversation.title.trim().toLowerCase() === "default";
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
    setActionNotice,
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
  // Each section (messages, terminal, per-connector) is independently
  // collapsible. Sections default to expanded — users only care that
  // state is preserved across mounts.
  const [collapsedSections, setCollapsedSections] = useState<Set<string>>(
    () => new Set(),
  );
  // Controlled collapse state lets us hide the sidebar's default header
  // bar and put our own collapse button inline with the first section
  // header (Messages), keeping that row at the top of the rail.
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [hiddenConversationIds, setHiddenConversationIds] = useState<
    Set<string>
  >(() => new Set());
  const CHAT_SIDEBAR_WIDTH_KEY = "eliza:chat:conversations-sidebar:width";
  const CHAT_SIDEBAR_DEFAULT_WIDTH = 240;
  const CHAT_SIDEBAR_MIN_WIDTH = 200;
  const CHAT_SIDEBAR_MAX_WIDTH = 520;
  const [sidebarWidth, setSidebarWidth] = useState<number>(() => {
    if (typeof window === "undefined") return CHAT_SIDEBAR_DEFAULT_WIDTH;
    try {
      const raw = window.localStorage.getItem(CHAT_SIDEBAR_WIDTH_KEY);
      const parsed = raw ? Number.parseInt(raw, 10) : NaN;
      if (Number.isFinite(parsed)) {
        return Math.min(
          Math.max(parsed, CHAT_SIDEBAR_MIN_WIDTH),
          CHAT_SIDEBAR_MAX_WIDTH,
        );
      }
    } catch {
      /* ignore */
    }
    return CHAT_SIDEBAR_DEFAULT_WIDTH;
  });
  const handleSidebarWidthChange = useCallback((next: number) => {
    setSidebarWidth(next);
    try {
      window.localStorage.setItem(CHAT_SIDEBAR_WIDTH_KEY, String(next));
    } catch {
      /* ignore */
    }
  }, []);
  const toggleSectionCollapsed = useCallback((key: string) => {
    setCollapsedSections((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  }, []);

  const loadInboxChats = useCallback(async () => {
    try {
      const response = await client.getInboxChats();
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
  }, []);

  useEffect(() => {
    void loadInboxChats();
  }, [loadInboxChats]);

  useIntervalWhenDocumentVisible(() => {
    void loadInboxChats();
  }, INBOX_CHATS_REFRESH_MS);

  useEffect(() => {
    const candidates = conversations.filter(
      (conversation) =>
        conversation.id !== activeConversationId &&
        isLegacyUntitledConversationCandidate(conversation),
    );
    if (candidates.length === 0) {
      setHiddenConversationIds((prev) =>
        prev.size === 0 ? prev : new Set<string>(),
      );
      return;
    }

    let cancelled = false;
    void Promise.all(
      candidates.map(async (conversation) => {
        try {
          const { messages } = await client.getConversationMessages(
            conversation.id,
          );
          const hasUserTurn = messages.some(
            (message) => message.role === "user",
          );
          return hasUserTurn ? null : conversation.id;
        } catch {
          return null;
        }
      }),
    ).then((ids) => {
      if (cancelled) return;
      setHiddenConversationIds(
        new Set(ids.filter((id): id is string => typeof id === "string")),
      );
    });

    return () => {
      cancelled = true;
    };
  }, [activeConversationId, conversations]);

  const visibleConversations = useMemo(
    () =>
      conversations.filter(
        (conversation) => !hiddenConversationIds.has(conversation.id),
      ),
    [conversations, hiddenConversationIds],
  );

  // Messages section: conversations live under the eliza scope.
  const messagesModel = useMemo(
    () =>
      buildConversationsSidebarModel({
        conversations: visibleConversations,
        inboxChats,
        searchQuery: "",
        sourceScope: ELIZA_SOURCE_SCOPE,
        t,
        worldScope: ALL_WORLDS_SCOPE,
      }),
    [inboxChats, t, visibleConversations],
  );

  // Connector sections: surfaces every active connector (Discord, Telegram,
  // …) grouped by world. One section per (source, world) tuple.
  const connectorsModel = useMemo(
    () =>
      buildConversationsSidebarModel({
        conversations: [],
        inboxChats,
        searchQuery: "",
        sourceScope: ALL_CONNECTORS_SOURCE_SCOPE,
        t,
        worldScope: ALL_WORLDS_SCOPE,
      }),
    [inboxChats, t],
  );

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
      setActionNotice(
        t("conversations.newTerminalFailed", {
          defaultValue: "Failed to start terminal: {{message}}",
          message: errorMessage(err),
        }),
        "error",
        4800,
      );
    } finally {
      spawnShellBusyRef.current = false;
    }
  }, [setActionNotice, setState, setTab, t]);

  const selectTerminalSession = useCallback(
    (sessionId: string) => {
      setState("activeInboxChat", null);
      setState("activeTerminalSessionId", sessionId);
      setTab("chat");
      onClose?.();
    },
    [onClose, setState, setTab],
  );

  // If a terminal session is active but its section is collapsed, make
  // sure the Terminal section stays visible so the user can see what's
  // selected. Same guarantee for inbox/connector selections.
  useEffect(() => {
    if (!activeTerminalSessionId) return;
    setCollapsedSections((prev) => {
      if (!prev.has(TERMINAL_SOURCE_SCOPE)) return prev;
      const next = new Set(prev);
      next.delete(TERMINAL_SOURCE_SCOPE);
      return next;
    });
  }, [activeTerminalSessionId]);

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

  const terminalRows = useMemo<ConversationsSidebarRow[]>(
    () =>
      ptySessions.map((session) => ({
        id: session.sessionId,
        kind: "conversation",
        sortKey: 0,
        source: TERMINAL_SOURCE_SCOPE,
        sourceKey: TERMINAL_SOURCE_SCOPE,
        title: session.label,
        updatedAtLabel: "",
        worldKey: null,
      })),
    [ptySessions],
  );

  const messagesSection = useMemo(
    () => ({
      key: ELIZA_SOURCE_SCOPE,
      label: t("conversations.sectionMessages", { defaultValue: "Messages" }),
      icon: <MessagesSquare className="h-3.5 w-3.5" aria-hidden />,
      rows: messagesModel.rows,
    }),
    [messagesModel.rows, t],
  );

  const terminalIndicator = useMemo(() => {
    if (ptySessions.length === 0) return null;
    // Choose the most-alerting status so the header dot reflects the session
    // that most needs attention: error > blocked > active/tool_running.
    const hasError = ptySessions.some((s) => s.status === "error");
    const hasBlocked = ptySessions.some((s) => s.status === "blocked");
    const hasActive = ptySessions.some((s) => PULSE_STATUSES.has(s.status));
    const dominant = hasError
      ? "error"
      : hasBlocked
        ? "blocked"
        : hasActive
          ? "active"
          : (ptySessions[0]?.status ?? "active");
    const dotClass = STATUS_DOT[dominant] ?? "bg-muted";
    const pulse = PULSE_STATUSES.has(dominant) ? " animate-pulse" : "";
    return (
      <span
        aria-hidden
        data-testid="channel-section-indicator-terminal"
        className="inline-flex items-center gap-1 rounded-full bg-bg-hover/40 px-1.5 py-0.5 text-3xs font-semibold tabular-nums text-muted"
      >
        <span
          className={`inline-block h-1.5 w-1.5 shrink-0 rounded-full ${dotClass}${pulse}`}
        />
        {ptySessions.length}
      </span>
    );
  }, [ptySessions]);

  const terminalSection = useMemo(
    () => ({
      key: TERMINAL_SOURCE_SCOPE,
      label: t("conversations.scopeTerminal", { defaultValue: "Terminal" }),
      icon: <TerminalIcon className="h-3.5 w-3.5" aria-hidden />,
      indicator: terminalIndicator,
      rows: terminalRows,
    }),
    [terminalIndicator, terminalRows, t],
  );

  // Connector sections: one section per source (Discord, Telegram, …) with
  // every room from that source listed underneath. No world sub-grouping
  // and no time-bucket headers — just a flat, newest-first list.
  // Connector sections: one section per (source, world) tuple. Each Discord
  // server / Telegram account / etc. gets its own collapsible header listing
  // its channels. Falls back to a single source-level section if a connector
  // doesn't expose worlds.
  const connectorSections = useMemo(() => {
    const groups = new Map<
      string,
      {
        key: string;
        label: string;
        sourceKey: string;
        worldKey: string | null;
        rows: ConversationsSidebarRow[];
      }
    >();
    for (const row of connectorsModel.rows) {
      const sourceKey = row.sourceKey;
      const worldKey = row.worldKey;
      const groupKey = worldKey ? `${sourceKey}:${worldKey}` : sourceKey;
      const sourceMeta = getChatSourceMeta(sourceKey);
      const label = row.worldLabel?.trim() || sourceMeta.label;
      const existing = groups.get(groupKey);
      if (existing) {
        existing.rows.push(row);
        continue;
      }
      groups.set(groupKey, {
        key: groupKey,
        label,
        sourceKey,
        worldKey,
        rows: [row],
      });
    }
    return Array.from(groups.values())
      .map((group) => {
        const Brand = getBrandIcon(group.sourceKey);
        return {
          ...group,
          icon: Brand ? (
            <Brand className="h-3.5 w-3.5" />
          ) : (
            <ChatSourceIcon
              source={group.sourceKey}
              className="h-3.5 w-3.5"
              decorative
            />
          ),
          rows: [...group.rows].sort(
            (left, right) => right.sortKey - left.sortKey,
          ),
        };
      })
      .sort((left, right) => {
        // Group by source first, then alphabetical by world label so all
        // Discord servers cluster, all Telegram accounts cluster, etc.
        if (left.sourceKey !== right.sourceKey) {
          return left.sourceKey.localeCompare(right.sourceKey);
        }
        return left.label.localeCompare(right.label);
      });
  }, [connectorsModel.rows]);

  const terminalListId = activeTerminalSessionId
    ? `${TERMINAL_ID_PREFIX}${activeTerminalSessionId}`
    : null;
  const activeListId = activeTerminalSessionId
    ? terminalListId
    : activeInboxChat
      ? `${INBOX_ID_PREFIX}${activeInboxChat.id}`
      : activeConversationId;

  // Flat row list for the collapsed rail (mobile / collapsed sidebar).
  const displayRows = useMemo(
    () => [
      ...messagesSection.rows,
      ...terminalSection.rows,
      ...connectorSections.flatMap((s) => s.rows),
    ],
    [messagesSection.rows, terminalSection.rows, connectorSections],
  );

  const showNewChatAction = tab === "chat";
  const showNewTerminalAction = tab === "chat";
  const manageConnectionsButton = (() => {
    const channelsLabel = t("conversations.channels", {
      defaultValue: "Channels",
    });
    const manageLabel = t("conversations.manageConnections", {
      defaultValue: "Manage",
    });
    const toggleLabel = isManageConnectionsActive ? channelsLabel : manageLabel;
    const ToggleIcon = isManageConnectionsActive ? MessagesSquare : Settings2;
    return (
      <button
        type="button"
        data-testid="chat-sidebar-manage-toggle"
        aria-pressed={isManageConnectionsActive}
        aria-label={toggleLabel}
        title={toggleLabel}
        onClick={handleManageConnections}
        className={`inline-flex h-7 shrink-0 items-center gap-1.5 rounded-[var(--radius-sm)] bg-transparent px-2 text-[11px] leading-none font-medium whitespace-nowrap transition-colors ${
          isManageConnectionsActive ? "text-txt" : "text-muted hover:text-txt"
        }`}
      >
        <ToggleIcon className="h-3.5 w-3.5" aria-hidden />
        <span>{toggleLabel}</span>
      </button>
    );
  })();

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

      <AppPageSidebar
        testId="conversations-sidebar"
        variant={mobile ? "mobile" : isGameModal ? "game-modal" : "default"}
        className={mobile || isGameModal ? "!mt-0" : undefined}
        collapsible={!mobile && !isGameModal}
        collapsed={!mobile && !isGameModal ? sidebarCollapsed : undefined}
        onCollapsedChange={
          !mobile && !isGameModal ? setSidebarCollapsed : undefined
        }
        resizable={!mobile && !isGameModal}
        width={!mobile && !isGameModal ? sidebarWidth : undefined}
        minWidth={CHAT_SIDEBAR_MIN_WIDTH}
        maxWidth={CHAT_SIDEBAR_MAX_WIDTH}
        onWidthChange={handleSidebarWidthChange}
        onCollapseRequest={() => setSidebarCollapsed(true)}
        contentIdentity={
          mobile ? "chat-mobile" : isGameModal ? "chat-modal" : "chat"
        }
        collapseButtonTestId="chat-sidebar-collapse-toggle"
        expandButtonTestId="chat-sidebar-expand-toggle"
        collapseButtonAriaLabel={t("aria.closePanel")}
        expandButtonAriaLabel={t("aria.expandChatsPanel")}
        bottomAction={
          !mobile && !isGameModal ? manageConnectionsButton : undefined
        }
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
        mobileCloseLabel={t("aria.closePanel")}
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
          className={isGameModal ? undefined : "px-1 pb-2 pt-2"}
        >
          <SidebarPanel
            variant={isGameModal ? "game-modal" : "default"}
            className={
              isGameModal ? undefined : "bg-transparent gap-0 p-0 shadow-none"
            }
          >
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
                        <div className="flex h-auto min-w-0 flex-1 self-stretch items-center gap-2 rounded-none p-0 text-left">
                          <SidebarContent.ItemIcon className="mt-0 h-8 w-8 shrink-0 p-1.5">
                            {renderConnectorIcon(plugin)}
                          </SidebarContent.ItemIcon>
                          <SidebarContent.ItemBody>
                            <span className="block truncate text-sm font-semibold leading-5 text-txt">
                              {plugin.name}
                            </span>
                          </SidebarContent.ItemBody>
                        </div>
                        <Switch
                          checked={plugin.enabled}
                          disabled={toggleDisabled}
                          onClick={(event) => {
                            event.stopPropagation();
                          }}
                          onKeyDown={(event) => {
                            event.stopPropagation();
                          }}
                          onCheckedChange={(checked) => {
                            void handleConnectorToggle(plugin.id, checked);
                          }}
                          aria-label={`${plugin.enabled ? t("common.off") : t("common.on")} ${plugin.name}`}
                        />
                      </SidebarContent.Item>
                    );
                  })
                )}
              </div>
            ) : (
              <div className="mt-0.5 space-y-2">
                <CollapsibleChannelSection
                  sectionKey={messagesSection.key}
                  label={messagesSection.label}
                  icon={messagesSection.icon}
                  rows={messagesSection.rows}
                  collapsed={collapsedSections.has(messagesSection.key)}
                  onToggleCollapsed={toggleSectionCollapsed}
                  onAdd={showNewChatAction ? handleNewChat : undefined}
                  addLabel={t("conversations.newChat", {
                    defaultValue: "New chat",
                  })}
                  emptyLabel={t("conversations.noneApp", {
                    defaultValue: "No chats yet",
                  })}
                  activeListId={activeListId}
                  rowListId={rowListId}
                  isTerminalRow={isTerminalRow}
                  deletingId={deletingId}
                  confirmDeleteId={confirmDeleteId}
                  unreadConversations={unreadConversations}
                  mobile={mobile}
                  variant={variant}
                  t={t}
                  onCancelDelete={() => setConfirmDeleteId(null)}
                  onConfirmDelete={handleConfirmDelete}
                  onOpenActions={openActionsMenu}
                  onRequestDeleteConfirm={(row) => {
                    setMenuConversation(null);
                    setRenameTarget(null);
                    setConfirmDeleteId(row.id);
                  }}
                  onRequestRename={(row) =>
                    openRenameDialog({ id: row.id, title: row.title })
                  }
                  onSelectRow={handleRowSelect}
                />

                <CollapsibleChannelSection
                  sectionKey={terminalSection.key}
                  label={terminalSection.label}
                  icon={terminalSection.icon}
                  indicator={terminalSection.indicator}
                  rows={terminalSection.rows}
                  collapsed={collapsedSections.has(terminalSection.key)}
                  onToggleCollapsed={toggleSectionCollapsed}
                  onAdd={
                    showNewTerminalAction ? () => void spawnShell() : undefined
                  }
                  addLabel={t("conversations.newTerminal", {
                    defaultValue: "New terminal",
                  })}
                  activeListId={activeListId}
                  rowListId={rowListId}
                  isTerminalRow={isTerminalRow}
                  deletingId={deletingId}
                  confirmDeleteId={confirmDeleteId}
                  unreadConversations={unreadConversations}
                  mobile={mobile}
                  variant={variant}
                  t={t}
                  onCancelDelete={() => setConfirmDeleteId(null)}
                  onConfirmDelete={handleConfirmDelete}
                  onOpenActions={openActionsMenu}
                  onRequestDeleteConfirm={(row) => {
                    setMenuConversation(null);
                    setRenameTarget(null);
                    setConfirmDeleteId(row.id);
                  }}
                  onRequestRename={(row) =>
                    openRenameDialog({ id: row.id, title: row.title })
                  }
                  onSelectRow={handleRowSelect}
                />

                {connectorSections.map((section) => (
                  <CollapsibleChannelSection
                    key={section.key}
                    sectionKey={section.key}
                    label={section.label}
                    icon={section.icon}
                    rows={section.rows}
                    collapsed={collapsedSections.has(section.key)}
                    onToggleCollapsed={toggleSectionCollapsed}
                    emptyLabel={t("conversations.none", {
                      defaultValue: "No chats in this view",
                    })}
                    activeListId={activeListId}
                    rowListId={rowListId}
                    isTerminalRow={isTerminalRow}
                    deletingId={deletingId}
                    confirmDeleteId={confirmDeleteId}
                    unreadConversations={unreadConversations}
                    mobile={mobile}
                    variant={variant}
                    t={t}
                    onCancelDelete={() => setConfirmDeleteId(null)}
                    onConfirmDelete={handleConfirmDelete}
                    onOpenActions={openActionsMenu}
                    onRequestDeleteConfirm={(row) => {
                      setMenuConversation(null);
                      setRenameTarget(null);
                      setConfirmDeleteId(row.id);
                    }}
                    onRequestRename={(row) =>
                      openRenameDialog({ id: row.id, title: row.title })
                    }
                    onSelectRow={handleRowSelect}
                  />
                ))}
              </div>
            )}
          </SidebarPanel>
        </SidebarScrollRegion>
      </AppPageSidebar>
    </TooltipProvider>
  );
}

type TranslateFn = (key: string, options?: Record<string, unknown>) => string;

interface CollapsibleChannelSectionProps {
  sectionKey: string;
  label: string;
  icon?: React.ReactNode;
  /** Small status element rendered between the label and the chevron. */
  indicator?: React.ReactNode;
  rows: ConversationsSidebarRow[];
  collapsed: boolean;
  onToggleCollapsed: (key: string) => void;
  onAdd?: () => void;
  addLabel?: string;
  emptyLabel?: string;
  activeListId: string | null;
  rowListId: (row: ConversationsSidebarRow) => string;
  isTerminalRow: (row: ConversationsSidebarRow) => boolean;
  deletingId: string | null;
  confirmDeleteId: string | null;
  unreadConversations: Set<string>;
  mobile: boolean;
  variant: ConversationsSidebarVariant;
  t: TranslateFn;
  onCancelDelete: () => void;
  onConfirmDelete: (id: string) => void | Promise<void>;
  onOpenActions: (
    event: React.MouseEvent<HTMLElement> | React.TouchEvent<HTMLElement>,
    conversation: { id: string; title: string },
  ) => void;
  onRequestDeleteConfirm: (row: ConversationsSidebarRow) => void;
  onRequestRename: (row: ConversationsSidebarRow) => void;
  onSelectRow: (row: ConversationsSidebarRow) => void;
}

function CollapsibleChannelSection({
  sectionKey,
  label,
  icon,
  indicator,
  rows,
  collapsed,
  onToggleCollapsed,
  onAdd,
  addLabel,
  emptyLabel,
  activeListId,
  rowListId,
  isTerminalRow,
  deletingId,
  confirmDeleteId,
  unreadConversations,
  mobile,
  variant,
  t,
  onCancelDelete,
  onConfirmDelete,
  onOpenActions,
  onRequestDeleteConfirm,
  onRequestRename,
  onSelectRow,
}: CollapsibleChannelSectionProps) {
  return (
    <CollapsibleSidebarSection
      sectionKey={sectionKey}
      label={label}
      icon={icon}
      indicator={indicator}
      collapsed={collapsed}
      onToggleCollapsed={onToggleCollapsed}
      onAdd={onAdd}
      addLabel={addLabel}
      emptyLabel={emptyLabel}
      emptyClassName="pl-7 pr-3 py-1 text-2xs text-muted"
      bodyClassName="space-y-0 pl-4"
      hoverActionsOnDesktop={!mobile}
      testIdPrefix="channel-section"
    >
      {rows.map((row) => {
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
              deleteNo: t("common.no"),
              deleteYes: t("common.yes"),
              rename: t("conversations.rename"),
            }}
            mobile={mobile}
            onCancelDelete={onCancelDelete}
            onConfirmDelete={() => {
              if (row.kind === "inbox" || isTerminalRow(row)) return;
              void onConfirmDelete(row.id);
            }}
            onOpenActions={(event) => {
              if (row.kind === "inbox" || isTerminalRow(row)) {
                event.preventDefault();
                event.stopPropagation();
                return;
              }
              onOpenActions(event, { id: row.id, title: row.title });
            }}
            onRequestDeleteConfirm={() => {
              if (row.kind === "inbox" || isTerminalRow(row)) return;
              onRequestDeleteConfirm(row);
            }}
            onRequestRename={() => {
              if (row.kind === "inbox" || isTerminalRow(row)) return;
              onRequestRename(row);
            }}
            onSelect={() => onSelectRow(row)}
            variant={variant}
          />
        );
      })}
    </CollapsibleSidebarSection>
  );
}
