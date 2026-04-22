/**
 * LifeOpsInboxSection — unified inbox with colour-coded channel avatars.
 *
 * Each channel has its own accent colour so the user can scan the list
 * quickly. Selecting a message opens a reader pane with reply + open-source
 * actions; the list stays in view on wide screens.
 */
import {
  Button,
  Input,
  openExternalUrl,
  Spinner,
  useApp,
} from "@elizaos/app-core";
import {
  LIFEOPS_INBOX_CHANNELS,
  type LifeOpsInboxChannel,
  type LifeOpsUnifiedMessage,
} from "@elizaos/shared/contracts/lifeops";
import {
  AtSign,
  ExternalLink,
  MessageCircle,
  MessageSquare,
  MessageSquareReply,
  Phone,
  Search,
  Send,
  Shield,
  Smartphone,
} from "lucide-react";
import { type ReactNode, useCallback, useEffect, useMemo } from "react";
import {
  type InboxChannel,
  useUnifiedInbox,
} from "../hooks/useUnifiedInbox.js";
import { buildReplyPrefill, postToChat } from "./LifeOpsChatAdapter.js";
import {
  type LifeOpsSelection,
  useLifeOpsSelection,
} from "./LifeOpsSelectionContext.js";

interface ChannelStyle {
  label: string;
  bg: string;
  ring: string;
  text: string;
  icon: ReactNode;
}

const CHANNEL_STYLES: Record<LifeOpsInboxChannel, ChannelStyle> = {
  gmail: {
    label: "Gmail",
    bg: "bg-rose-500/16",
    ring: "ring-rose-500/40",
    text: "text-rose-300",
    icon: <AtSign className="h-3.5 w-3.5" aria-hidden />,
  },
  x_dm: {
    label: "X DMs",
    bg: "bg-zinc-500/18",
    ring: "ring-zinc-400/40",
    text: "text-zinc-200",
    icon: <MessageSquareReply className="h-3.5 w-3.5" aria-hidden />,
  },
  discord: {
    label: "Discord",
    bg: "bg-indigo-500/18",
    ring: "ring-indigo-500/40",
    text: "text-indigo-300",
    icon: <MessageCircle className="h-3.5 w-3.5" aria-hidden />,
  },
  telegram: {
    label: "Telegram",
    bg: "bg-sky-500/18",
    ring: "ring-sky-500/40",
    text: "text-sky-300",
    icon: <Send className="h-3.5 w-3.5" aria-hidden />,
  },
  signal: {
    label: "Signal",
    bg: "bg-blue-500/18",
    ring: "ring-blue-500/40",
    text: "text-blue-300",
    icon: <Shield className="h-3.5 w-3.5" aria-hidden />,
  },
  imessage: {
    label: "iMessage",
    bg: "bg-emerald-500/18",
    ring: "ring-emerald-500/40",
    text: "text-emerald-300",
    icon: <MessageSquare className="h-3.5 w-3.5" aria-hidden />,
  },
  whatsapp: {
    label: "WhatsApp",
    bg: "bg-lime-500/18",
    ring: "ring-lime-500/40",
    text: "text-lime-300",
    icon: <Smartphone className="h-3.5 w-3.5" aria-hidden />,
  },
  sms: {
    label: "SMS",
    bg: "bg-amber-500/18",
    ring: "ring-amber-500/40",
    text: "text-amber-300",
    icon: <Phone className="h-3.5 w-3.5" aria-hidden />,
  },
};

const ALL_CHANNEL_STYLE: ChannelStyle = {
  label: "All",
  bg: "bg-violet-500/16",
  ring: "ring-violet-500/40",
  text: "text-violet-300",
  icon: <MessageSquare className="h-3.5 w-3.5" aria-hidden />,
};

const CHANNEL_FILTERS: InboxChannel[] = ["all", ...LIFEOPS_INBOX_CHANNELS];

function styleFor(channel: LifeOpsInboxChannel): ChannelStyle {
  return CHANNEL_STYLES[channel];
}

function styleForFilter(channel: InboxChannel): ChannelStyle {
  return channel === "all"
    ? ALL_CHANNEL_STYLE
    : CHANNEL_STYLES[channel as LifeOpsInboxChannel];
}

function formatRelativeTime(receivedAt: string): string {
  const parsed = Date.parse(receivedAt);
  if (!Number.isFinite(parsed)) return "";
  const diffMs = Date.now() - parsed;
  const diffMin = Math.floor(diffMs / 60_000);
  if (diffMin < 1) return "now";
  if (diffMin < 60) return `${diffMin}m`;
  const diffH = Math.floor(diffMin / 60);
  if (diffH < 24) return `${diffH}h`;
  const diffD = Math.floor(diffH / 24);
  return `${diffD}d`;
}

function formatAbsoluteTime(receivedAt: string): string {
  const parsed = Date.parse(receivedAt);
  return Number.isFinite(parsed) ? new Date(parsed).toLocaleString() : "";
}

function initialsFor(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0]?.slice(0, 2).toUpperCase() ?? "?";
  return `${parts[0]?.[0] ?? ""}${parts[1]?.[0] ?? ""}`.toUpperCase();
}

function ChannelChip({
  channel,
  active,
  count,
  unread,
  onClick,
}: {
  channel: InboxChannel;
  active: boolean;
  count: number;
  unread: number;
  onClick: (ch: InboxChannel) => void;
}) {
  const style = styleForFilter(channel);
  return (
    <button
      type="button"
      onClick={() => onClick(channel)}
      aria-pressed={active}
      className={[
        "group inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-medium transition-colors",
        active
          ? `${style.bg} ${style.text} ring-1 ${style.ring}`
          : "bg-bg-muted/30 text-muted hover:text-txt",
      ].join(" ")}
    >
      <span className={`shrink-0 ${active ? style.text : "text-muted/80"}`}>
        {style.icon}
      </span>
      <span>{style.label}</span>
      {count > 0 ? (
        <span
          className={`ml-0.5 rounded-full px-1.5 text-[10px] tabular-nums ${
            unread > 0 ? `${style.text} bg-white/4` : "text-muted bg-white/4"
          }`}
        >
          {unread > 0 ? unread : count}
        </span>
      ) : null}
    </button>
  );
}

function MessageRow({
  message,
  selected,
  onSelect,
  onReply,
}: {
  message: LifeOpsUnifiedMessage;
  selected: boolean;
  onSelect: () => void;
  onReply: () => void;
}) {
  const style = styleFor(message.channel);
  const subject = message.subject?.trim() || `${style.label} message`;

  return (
    <div
      role="option"
      aria-selected={selected}
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSelect();
        }
      }}
      className={[
        "group flex cursor-pointer items-start gap-3 border-l-2 px-3 py-2.5 transition-colors",
        selected
          ? "border-accent bg-accent/8"
          : message.unread
            ? "border-transparent bg-bg/30 hover:bg-bg-muted/30"
            : "border-transparent hover:bg-bg-muted/20",
      ].join(" ")}
    >
      <div className="relative h-8 w-8 shrink-0">
        <div
          className={`flex h-full w-full items-center justify-center overflow-hidden rounded-full text-[11px] font-semibold ${style.bg} ${style.text}`}
        >
          {message.sender.avatarUrl ? (
            <img
              src={message.sender.avatarUrl}
              alt=""
              aria-hidden
              className="h-full w-full object-cover"
            />
          ) : (
            initialsFor(message.sender.displayName)
          )}
        </div>
        <span
          className={`pointer-events-none absolute -bottom-1 -right-1 inline-flex h-4 w-4 items-center justify-center rounded-full bg-bg ring-2 ring-bg ${style.text} [&>svg]:h-2.5 [&>svg]:w-2.5`}
          aria-hidden
        >
          {style.icon}
        </span>
      </div>

      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-2">
          <span
            className={`truncate text-sm ${
              message.unread
                ? "font-semibold text-txt"
                : "font-medium text-txt/85"
            }`}
          >
            {message.sender.displayName}
          </span>
          <div className="flex shrink-0 items-center gap-1.5">
            {message.unread ? (
              <span className="h-1.5 w-1.5 rounded-full bg-accent" />
            ) : null}
            <span className="text-[10px] tabular-nums text-muted">
              {formatRelativeTime(message.receivedAt)}
            </span>
          </div>
        </div>
        <div className="mt-0.5 truncate text-xs text-muted">{subject}</div>
        <div className="mt-0.5 line-clamp-1 text-[11px] text-muted/70">
          {message.snippet}
        </div>
      </div>

      <button
        type="button"
        aria-label="Reply"
        onClick={(e) => {
          e.stopPropagation();
          onReply();
        }}
        className="mt-0.5 shrink-0 rounded-full p-1.5 text-muted opacity-0 transition-opacity hover:bg-bg-muted/40 hover:text-txt group-hover:opacity-100"
      >
        <MessageSquareReply className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

function ReaderPane({
  message,
  onReply,
}: {
  message: LifeOpsUnifiedMessage | null;
  onReply: (msg: LifeOpsUnifiedMessage) => void;
}) {
  const { t } = useApp();

  if (!message) {
    return (
      <div className="flex flex-1 items-center justify-center bg-bg/20 text-xs text-muted">
        <div className="flex flex-col items-center gap-2 text-center">
          <MessageSquare className="h-6 w-6 text-muted/50" aria-hidden />
          {t("lifeopsInbox.selectMessage", {
            defaultValue: "Select a message",
          })}
        </div>
      </div>
    );
  }

  const style = styleFor(message.channel);
  const subject = message.subject?.trim() || `${style.label} message`;
  const receivedAt = formatAbsoluteTime(message.receivedAt);

  return (
    <div className="flex flex-1 flex-col overflow-hidden bg-bg/10">
      <div className="flex items-start gap-3 border-b border-border/12 px-5 py-4">
        <div
          className={`flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-full text-xs font-semibold ${style.bg} ${style.text}`}
        >
          {message.sender.avatarUrl ? (
            <img
              src={message.sender.avatarUrl}
              alt=""
              aria-hidden
              className="h-full w-full object-cover"
            />
          ) : (
            initialsFor(message.sender.displayName)
          )}
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-base font-semibold text-txt">{subject}</div>
          <div className="mt-0.5 flex flex-wrap items-center gap-2 text-xs text-muted">
            <span className={`inline-flex items-center gap-1 ${style.text}`}>
              {style.icon}
              {style.label}
            </span>
            <span>·</span>
            <span>{message.sender.displayName}</span>
            {receivedAt ? (
              <>
                <span>·</span>
                <span>{receivedAt}</span>
              </>
            ) : null}
          </div>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-5 py-4">
        <p className="whitespace-pre-wrap text-sm leading-relaxed text-txt/85">
          {message.snippet}
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-2 border-t border-border/12 px-5 py-3">
        <Button
          size="sm"
          className="h-8 rounded-xl px-3 text-xs font-semibold"
          onClick={() => onReply(message)}
        >
          <MessageSquareReply className="mr-1.5 h-3.5 w-3.5" />
          {t("lifeopsInbox.reply", { defaultValue: "Reply" })}
        </Button>
        {message.deepLink ? (
          <Button
            size="sm"
            variant="ghost"
            className="h-8 rounded-xl px-3 text-xs font-semibold text-muted"
            onClick={() =>
              message.deepLink && void openExternalUrl(message.deepLink)
            }
          >
            <ExternalLink className="mr-1.5 h-3.5 w-3.5" />
            {t("lifeopsInbox.openSource", { defaultValue: "Open source" })}
          </Button>
        ) : null}
      </div>
    </div>
  );
}

export interface LifeOpsInboxSectionProps {
  selection?: LifeOpsSelection;
  onSelect?: (args: Partial<LifeOpsSelection>) => void;
}

export function LifeOpsInboxSection(props: LifeOpsInboxSectionProps = {}) {
  const ctx = useLifeOpsSelection();
  const selection = props.selection ?? ctx.selection;
  const onSelect = props.onSelect ?? ctx.select;
  const { t } = useApp();
  const inbox = useUnifiedInbox({ maxResults: 40 });

  const selectedMessageId = selection.messageId ?? null;

  const selectedIndex = useMemo(
    () => inbox.messages.findIndex((m) => m.id === selectedMessageId),
    [inbox.messages, selectedMessageId],
  );
  const selectedMessage = inbox.messages[selectedIndex] ?? null;

  const channelCounts = useMemo(() => {
    const base = Object.fromEntries(
      CHANNEL_FILTERS.map((channel) => [channel, { total: 0, unread: 0 }]),
    ) as Record<InboxChannel, { total: number; unread: number }>;
    for (const message of inbox.messages) {
      base.all.total++;
      if (message.unread) base.all.unread++;
      const bucket = base[message.channel as InboxChannel];
      if (bucket) {
        bucket.total++;
        if (message.unread) bucket.unread++;
      }
    }
    return base;
  }, [inbox.messages]);

  const selectByIndex = useCallback(
    (index: number) => {
      const msg = inbox.messages[index];
      if (msg) onSelect({ messageId: msg.id });
    },
    [inbox.messages, onSelect],
  );

  const handleReply = useCallback((msg: LifeOpsUnifiedMessage) => {
    const label = styleFor(msg.channel).label;
    const text = buildReplyPrefill({
      channel: msg.channel === "gmail" ? "email" : label,
      sender: msg.sender.displayName,
      snippet: msg.snippet,
      deepLink: msg.deepLink,
    });
    postToChat(text);
  }, []);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement).tagName;
      if (
        tag === "INPUT" ||
        tag === "TEXTAREA" ||
        (e.target as HTMLElement).isContentEditable
      ) {
        return;
      }
      if (e.key === "j") {
        e.preventDefault();
        selectByIndex(Math.min(selectedIndex + 1, inbox.messages.length - 1));
      } else if (e.key === "k") {
        e.preventDefault();
        selectByIndex(Math.max(selectedIndex - 1, 0));
      } else if (e.key === "r" && selectedMessage) {
        e.preventDefault();
        handleReply(selectedMessage);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [
    handleReply,
    inbox.messages.length,
    selectByIndex,
    selectedIndex,
    selectedMessage,
  ]);

  useEffect(() => {
    if (
      inbox.messages.length > 0 &&
      (!selectedMessageId || selectedIndex === -1)
    ) {
      onSelect({ messageId: inbox.messages[0].id });
    }
  }, [inbox.messages, onSelect, selectedIndex, selectedMessageId]);

  return (
    <section
      className="flex h-full min-h-0 flex-col overflow-hidden rounded-3xl border border-border/16 bg-card/18"
      data-testid="lifeops-inbox-section"
    >
      <div className="flex flex-wrap items-center gap-2 border-b border-border/12 px-3 py-2.5">
        {CHANNEL_FILTERS.map((ch) => {
          const counts = channelCounts[ch];
          return (
            <ChannelChip
              key={ch}
              channel={ch}
              active={inbox.channel === ch}
              count={counts?.total ?? 0}
              unread={counts?.unread ?? 0}
              onClick={inbox.setChannel}
            />
          );
        })}
      </div>

      {inbox.error ? (
        <div className="px-5 py-4 text-xs text-rose-300">{inbox.error}</div>
      ) : inbox.loading && inbox.messages.length === 0 ? (
        <div className="flex items-center gap-2 px-5 py-8 text-xs text-muted">
          <Spinner size={14} />
          {t("lifeopsInbox.loading", { defaultValue: "Loading inbox…" })}
        </div>
      ) : (
        <div className="flex min-h-0 flex-1">
          <div className="flex w-72 shrink-0 flex-col border-r border-border/12">
            <div className="border-b border-border/10 px-3 py-2">
              <div className="relative">
                <Search className="absolute left-2.5 top-2 h-3.5 w-3.5 text-muted" />
                <Input
                  value={inbox.searchQuery}
                  onChange={(e) => inbox.setSearchQuery(e.target.value)}
                  placeholder={t("lifeopsInbox.search", {
                    defaultValue: "Search…",
                  })}
                  aria-label={t("lifeopsInbox.searchAria", {
                    defaultValue: "Search inbox",
                  })}
                  className="h-8 pl-8 text-xs"
                />
              </div>
            </div>

            <div
              className="min-h-0 flex-1 overflow-y-auto"
              role="listbox"
              aria-label={t("lifeopsInbox.listAria", {
                defaultValue: "Messages",
              })}
            >
              {inbox.messages.length === 0 ? (
                <div className="px-4 py-8 text-center text-xs text-muted">
                  {inbox.searchQuery
                    ? t("lifeopsInbox.noResults", {
                        defaultValue: "No matches.",
                      })
                    : t("lifeopsInbox.empty", {
                        defaultValue: "Inbox clear.",
                      })}
                </div>
              ) : (
                inbox.messages.map((msg) => (
                  <MessageRow
                    key={msg.id}
                    message={msg}
                    selected={msg.id === selectedMessageId}
                    onSelect={() => onSelect({ messageId: msg.id })}
                    onReply={() => handleReply(msg)}
                  />
                ))
              )}
            </div>
          </div>

          <ReaderPane message={selectedMessage} onReply={handleReply} />
        </div>
      )}
    </section>
  );
}
