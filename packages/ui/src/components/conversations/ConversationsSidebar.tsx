/**
 * The chat surface's left rail: a unified, source-scoped list of conversations.
 * It merges three streams into one flat, time-bucketed model — dashboard
 * conversations, connector inbox chats (Discord, Telegram, …, polled every few
 * seconds), and Terminal PTY sessions — each carrying a namespaced id
 * (`inbox:` / `terminal:`) so selection stays unambiguous against dashboard
 * UUIDs. A source/world scope dropdown filters the list; the keyword-search
 * panel (`MessageSearchPanel`) can jump to a message, loading a window centered
 * on an out-of-view hit before scrolling to it.
 *
 * List shaping (sections, scope options, bucket ranks) lives in
 * `conversation-sidebar-model.ts`; this component owns fetching, polling,
 * selection, rename/delete, collapsed/expanded rail rendering, and the mobile
 * drawer. Barrel-exported and mounted inside the chat panel layout.
 */

import {
  Bell,
  BellOff,
  MessagesSquare,
  Plus,
  Search,
  Terminal as TerminalIcon,
} from "lucide-react";
import type React from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { client } from "../../api";
import type {
  Conversation,
  ConversationMessageSearchResult,
} from "../../api/client-types-chat";
import {
  PULSE_STATUSES,
  STATUS_DOT,
} from "../../chat/coding-agent-session-state";
import { CHAT_MESSAGE_SEARCH_EVENT } from "../../events";
import { CHAT_TRANSCRIPT_REVEAL_WINDOW_EVENT } from "../../hooks/useConversationRenderWindow";
import { useIntervalWhenDocumentVisible } from "../../hooks/useDocumentVisibility";
import { useAppSelectorShallow } from "../../state";
import { usePtySessions } from "../../state/PtySessionsContext.hooks";
import { shellLocalStorage } from "../../surface-realm-channel";
import { errorMessage } from "../../utils/errors";
import { emitViewEvent } from "../../views/view-event-bus";
import { MessageSearchPanel } from "../chat/message-search/MessageSearchPanel";
import { ChatConversationItem } from "../composites/chat/chat-conversation-item";
import { getChatMessageAnchorId } from "../composites/chat/chat-message";
import { ChatSourceIcon } from "../composites/chat/chat-source";
import { getChatSourceMeta } from "../composites/chat/chat-source.helpers";
import { SidebarCollapsedActionButton } from "../composites/sidebar/sidebar-collapsed-rail";
import { SidebarContent } from "../composites/sidebar/sidebar-content";
import { SidebarPanel } from "../composites/sidebar/sidebar-panel";
import { SidebarScrollRegion } from "../composites/sidebar/sidebar-scroll-region";
import { AppPageSidebar } from "../shared/AppPageSidebar";
import { CollapsibleSidebarSection } from "../shared/CollapsibleSidebarSection";
import { Button } from "../ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import { TooltipProvider } from "../ui/tooltip";
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
  muted?: boolean;
  mutedScope?: "room" | "server";
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
    loadConversationMessagesAround,
    handleDeleteConversation,
    ensurePluginsLoaded = async () => {},
    setActionNotice,
    setTab,
    setState,
    tab,
    t,
  } = useAppSelectorShallow((s) => ({
    conversations: s.conversations,
    activeConversationId: s.activeConversationId,
    activeInboxChat: s.activeInboxChat,
    activeTerminalSessionId: s.activeTerminalSessionId,
    unreadConversations: s.unreadConversations,
    handleNewConversation: s.handleNewConversation,
    handleSelectConversation: s.handleSelectConversation,
    loadConversationMessagesAround: s.loadConversationMessagesAround,
    handleDeleteConversation: s.handleDeleteConversation,
    ensurePluginsLoaded: s.ensurePluginsLoaded,
    setActionNotice: s.setActionNotice,
    setTab: s.setTab,
    setState: s.setState,
    tab: s.tab,
    t: s.t,
  }));
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
  const [muteBusyIds, setMuteBusyIds] = useState<Set<string>>(() => new Set());
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
      // error-policy:J3 corrupt/blocked localStorage — default width
    }
    return CHAT_SIDEBAR_DEFAULT_WIDTH;
  });
  // Fires per frame during a resize drag: state only. Persistence happens
  // once per drag in the commit handler below — a synchronous localStorage
  // write per frame stalls the drag on high-rate pointer devices.
  const handleSidebarWidthChange = useCallback((next: number) => {
    setSidebarWidth(next);
  }, []);
  const handleSidebarWidthCommit = useCallback((next: number) => {
    try {
      shellLocalStorage.setItem(CHAT_SIDEBAR_WIDTH_KEY, String(next));
    } catch {
      // error-policy:J6 best-effort persistence — width still applies for
      // this session; private-mode storage may reject writes
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
          muted: chat.muted,
          mutedScope: chat.mutedScope,
          roomType: chat.roomType,
          source: chat.source,
          transportSource: chat.transportSource,
          title: chat.title,
          worldId: chat.worldId,
          worldLabel: chat.worldLabel,
        })),
      );
    } catch {
      // error-policy:J4 poll — keep the last successful snapshot on transient
      // failures; the next tick refreshes.
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
          // error-policy:J4 hide-empty-draft probe — on failure the
          // conversation stays visible (fail open), never wrongly hidden
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
      // error-policy:J4 failure surfaces as an action notice
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

  // ── Keyword message search (#9955) ───────────────────────────────────────
  const [messageSearchOpen, setMessageSearchOpen] = useState(false);

  // A chat-side affordance (or shortcut) can request the search panel.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const open = () => setMessageSearchOpen(true);
    window.addEventListener(CHAT_MESSAGE_SEARCH_EVENT, open);
    return () => window.removeEventListener(CHAT_MESSAGE_SEARCH_EVENT, open);
  }, []);

  const searchMessages = useCallback(
    async (query: string, signal: AbortSignal) => {
      const { results } = await client.searchConversationMessages(query, {
        signal,
      });
      return results;
    },
    [],
  );

  // Scroll a now-mounted message into view and flash it (brand accent).
  // Self-contained — no external CSS rule needed.
  const scrollAndFlashAnchor = useCallback((el: HTMLElement) => {
    el.scrollIntoView({ block: "center", behavior: "smooth" });
    el.style.transition = "outline-color 0.5s ease-out";
    el.style.outline = "2px solid var(--primary)";
    el.style.outlineOffset = "2px";
    el.style.borderRadius = "8px";
    window.setTimeout(() => {
      el.style.outline = "2px solid transparent";
    }, 1200);
    window.setTimeout(() => {
      el.style.removeProperty("outline");
      el.style.removeProperty("outline-offset");
      el.style.removeProperty("transition");
    }, 1800);
  }, []);

  // Poll a bounded number of animation frames for the anchor to mount (the
  // thread re-renders asynchronously after a selection / window reload).
  // Resolves the element once present, or null once the frame budget is spent.
  const waitForAnchor = useCallback(
    (anchorId: string, maxFrames: number): Promise<HTMLElement | null> =>
      new Promise((resolve) => {
        let frames = 0;
        const step = () => {
          const el = document.getElementById(anchorId);
          if (el) {
            resolve(el);
            return;
          }
          if (frames++ < maxFrames) {
            requestAnimationFrame(step);
            return;
          }
          resolve(null);
        };
        requestAnimationFrame(step);
      }),
    [],
  );

  const jumpToMessage = useCallback(
    (result: ConversationMessageSearchResult) => {
      const anchorId = getChatMessageAnchorId(result.messageId);
      void (async () => {
        // Clear any active terminal/inbox surface and land on the chat tab
        // BEFORE selecting — ChatView renders the terminal branch first and the
        // inbox branch second, so without this a search-result jump switched
        // the conversation invisibly underneath a terminal/connector chat, the
        // anchor never mounted, and the user saw nothing (mirrors
        // handleRowSelect / handleNewChat).
        setState("activeInboxChat", null);
        setState("activeTerminalSessionId", null);
        setTab("chat");
        // Select the conversation and let its recent window load first, so the
        // in-window case (the common one) scrolls without a second fetch.
        await handleSelectConversation(result.conversationId);
        let el = await waitForAnchor(anchorId, 20);
        if (!el) {
          // The hit is older than the loaded recent window (#9955): load the
          // window CENTERED on it, then reveal the transcript's full loaded set
          // so the centered pivot is not sliced out of the render window
          // (#15281) — without the reveal, a windowed ChatView/overlay drops the
          // anchor and the jump silently no-ops. waitForAnchor's 20-frame budget
          // covers the reveal re-render.
          const loaded = await loadConversationMessagesAround(
            result.conversationId,
            result.messageId,
          );
          if (loaded) {
            emitViewEvent(CHAT_TRANSCRIPT_REVEAL_WINDOW_EVENT);
            el = await waitForAnchor(anchorId, 20);
          }
        }
        if (el) {
          scrollAndFlashAnchor(el);
        }
      })();
      if (mobile) onClose?.();
    },
    [
      handleSelectConversation,
      loadConversationMessagesAround,
      waitForAnchor,
      scrollAndFlashAnchor,
      setState,
      setTab,
      mobile,
      onClose,
    ],
  );

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
    // Mirror handleRowSelect's conversation branch: an active terminal session
    // otherwise keeps rendering over the fresh conversation (ChatView prefers
    // the terminal branch), making "New chat" look dead.
    setState("activeTerminalSessionId", null);
    setTab("chat");
    void handleNewConversation();
    onClose?.();
  };

  const updateInboxChatMute = useCallback(
    async (
      row: ConversationsSidebarRow,
      action: "mute" | "unmute",
      options?: { durationMinutes?: number; scope?: "room" | "server" },
    ) => {
      if (row.kind !== "inbox" || muteBusyIds.has(row.id)) return;
      setMuteBusyIds((prev) => new Set(prev).add(row.id));
      try {
        const result = await client.setInboxChatMute({
          action,
          roomId: row.id,
          scope: options?.scope ?? "room",
          ...(options?.durationMinutes
            ? { durationMinutes: options.durationMinutes }
            : {}),
        });
        setInboxChats((prev) =>
          prev.map((chat) => {
            if (options?.scope === "server" && chat.worldId === row.worldId) {
              if (result.mutedScope === "server") {
                return { ...chat, muted: true, mutedScope: "server" };
              }
              if (chat.mutedScope !== "server") {
                return chat;
              }
              const { mutedScope: _mutedScope, ...rest } = chat;
              return { ...rest, muted: false };
            }
            return chat.id === row.id
              ? {
                  ...chat,
                  muted: result.muted,
                  mutedScope: result.mutedScope,
                }
              : chat;
          }),
        );
      } catch (err) {
        // error-policy:J4 failure surfaces as an action notice — the optimistic
        // row state was not applied
        setActionNotice(
          t("conversations.muteFailed", {
            defaultValue: "Failed to update mute state: {{message}}",
            message: errorMessage(err),
          }),
          "error",
          4800,
        );
      } finally {
        setMuteBusyIds((prev) => {
          const next = new Set(prev);
          next.delete(row.id);
          return next;
        });
      }
    },
    [muteBusyIds, setActionNotice, t],
  );

  const isGameModal = variant === "game-modal";

  // Plugins supply the scope-chip icons, so load them eagerly so the
  // per-connector group headers can show brand icons without waiting on a
  // user action.
  useEffect(() => {
    void ensurePluginsLoaded();
  }, [ensurePluginsLoaded]);

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
          serverMuted: group.rows.some(
            (row) => row.muted && row.mutedScope === "server",
          ),
          serverMutable: group.rows.some((row) => Boolean(row.worldId)),
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
              className="text-danger "
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
        onWidthCommit={handleSidebarWidthCommit}
        onCollapseRequest={() => setSidebarCollapsed(true)}
        contentIdentity={
          mobile ? "chat-mobile" : isGameModal ? "chat-modal" : "chat"
        }
        collapseButtonTestId="chat-sidebar-collapse-toggle"
        expandButtonTestId="chat-sidebar-expand-toggle"
        collapseButtonAriaLabel={t("aria.closePanel")}
        expandButtonAriaLabel={t("aria.expandChatsPanel")}
        collapsedRailAction={
          // Chat-first: the single collapsed-rail "+" always starts a new
          // CHAT. New terminal stays reachable from the expanded terminal
          // section header — a shell session is never the primary affordance.
          showNewChatAction ? (
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
            <div className="mt-0.5 space-y-2">
              {messageSearchOpen ? (
                <div className="rounded-lg border border-border/60 bg-muted/30 p-2">
                  <MessageSearchPanel
                    search={searchMessages}
                    onJump={jumpToMessage}
                    onClose={() => setMessageSearchOpen(false)}
                  />
                </div>
              ) : (
                <Button
                  variant="outline"
                  data-testid="conversations-search-messages"
                  onClick={() => setMessageSearchOpen(true)}
                  className="h-auto w-full justify-start gap-2 rounded-lg border-border/60 px-2.5 py-1.5 text-sm font-normal text-muted-foreground hover:bg-muted/40 hover:text-foreground"
                >
                  <Search className="h-3.5 w-3.5" />
                  {t("conversations.searchMessages", {
                    defaultValue: "Search messages",
                  })}
                </Button>
              )}
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
                  serverMuted={section.serverMuted}
                  onToggleSectionMute={
                    section.serverMutable
                      ? (action, durationMinutes) => {
                          const row = section.rows.find(
                            (candidate) => candidate.worldId,
                          );
                          if (!row) return;
                          void updateInboxChatMute(row, action, {
                            durationMinutes,
                            scope: "server",
                          });
                        }
                      : undefined
                  }
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
                  onToggleInboxMute={updateInboxChatMute}
                />
              ))}
            </div>
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
  serverMuted?: boolean;
  onToggleSectionMute?: (
    action: "mute" | "unmute",
    durationMinutes?: number,
  ) => void;
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
  onToggleInboxMute?: (
    row: ConversationsSidebarRow,
    action: "mute" | "unmute",
    options?: { durationMinutes?: number; scope?: "room" | "server" },
  ) => void | Promise<void>;
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
  serverMuted = false,
  onToggleSectionMute,
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
  onToggleInboxMute,
}: CollapsibleChannelSectionProps) {
  const sectionMuteLabel = serverMuted
    ? t("conversations.unmuteServer", { defaultValue: "Unmute server" })
    : t("conversations.muteServer", { defaultValue: "Mute server" });
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
      {onToggleSectionMute ? (
        <div className="mb-1 flex items-center gap-1 pl-1 pr-2">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-6 min-w-0 flex-1 justify-start gap-1.5 rounded-sm px-2 text-2xs text-muted hover:text-txt"
            onClick={() => onToggleSectionMute(serverMuted ? "unmute" : "mute")}
            title={sectionMuteLabel}
            aria-label={sectionMuteLabel}
          >
            {serverMuted ? (
              <BellOff className="h-3.5 w-3.5 shrink-0" aria-hidden />
            ) : (
              <Bell className="h-3.5 w-3.5 shrink-0" aria-hidden />
            )}
            <span className="truncate">{sectionMuteLabel}</span>
          </Button>
          {!serverMuted ? (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  className="h-6 w-6 shrink-0 rounded-sm text-muted hover:text-txt"
                  aria-label={t("conversations.muteServerDuration", {
                    defaultValue: "Mute server duration",
                  })}
                  title={t("conversations.muteServerDuration", {
                    defaultValue: "Mute server duration",
                  })}
                >
                  <BellOff className="h-3.5 w-3.5" aria-hidden />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-36">
                <DropdownMenuItem
                  onClick={() => onToggleSectionMute("mute", 60)}
                >
                  {t("conversations.muteForHour", {
                    defaultValue: "Mute 1 hour",
                  })}
                </DropdownMenuItem>
                <DropdownMenuItem
                  onClick={() => onToggleSectionMute("mute", 60 * 8)}
                >
                  {t("conversations.muteForDay", {
                    defaultValue: "Mute 8 hours",
                  })}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          ) : null}
        </div>
      ) : null}
      {rows.map((row) => {
        const conversationId = rowListId(row);
        return (
          <div key={conversationId} className="flex min-w-0 items-center gap-1">
            <div className="min-w-0 flex-1">
              <ChatConversationItem
                conversation={{
                  id: conversationId,
                  ...(row.source ? { source: row.source } : {}),
                  title: row.title,
                  updatedAtLabel: row.muted
                    ? row.mutedScope === "server"
                      ? t("conversations.serverMuted", {
                          defaultValue: "Server muted",
                        })
                      : t("conversations.channelMuted", {
                          defaultValue: "Channel muted",
                        })
                    : row.updatedAtLabel,
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
            </div>
            {row.kind === "inbox" && onToggleInboxMute ? (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    className="h-7 w-7 shrink-0 rounded-sm text-muted hover:text-txt"
                    aria-label={
                      row.muted
                        ? t("conversations.unmuteChannel", {
                            defaultValue: "Unmute channel",
                          })
                        : t("conversations.muteChannel", {
                            defaultValue: "Mute channel",
                          })
                    }
                    title={
                      row.muted
                        ? t("conversations.unmuteChannel", {
                            defaultValue: "Unmute channel",
                          })
                        : t("conversations.muteChannel", {
                            defaultValue: "Mute channel",
                          })
                    }
                  >
                    {row.muted ? (
                      <BellOff className="h-3.5 w-3.5" aria-hidden />
                    ) : (
                      <Bell className="h-3.5 w-3.5" aria-hidden />
                    )}
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-40">
                  {row.muted ? (
                    <DropdownMenuItem
                      onClick={() => void onToggleInboxMute(row, "unmute")}
                    >
                      {t("conversations.unmuteChannel", {
                        defaultValue: "Unmute channel",
                      })}
                    </DropdownMenuItem>
                  ) : (
                    <>
                      <DropdownMenuItem
                        onClick={() => void onToggleInboxMute(row, "mute")}
                      >
                        {t("conversations.muteChannel", {
                          defaultValue: "Mute channel",
                        })}
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        onClick={() =>
                          void onToggleInboxMute(row, "mute", {
                            durationMinutes: 60,
                          })
                        }
                      >
                        {t("conversations.muteForHour", {
                          defaultValue: "Mute 1 hour",
                        })}
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        onClick={() =>
                          void onToggleInboxMute(row, "mute", {
                            durationMinutes: 60 * 8,
                          })
                        }
                      >
                        {t("conversations.muteForDay", {
                          defaultValue: "Mute 8 hours",
                        })}
                      </DropdownMenuItem>
                    </>
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
            ) : null}
          </div>
        );
      })}
    </CollapsibleSidebarSection>
  );
}
