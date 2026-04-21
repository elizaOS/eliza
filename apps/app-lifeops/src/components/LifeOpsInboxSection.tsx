import {
  Badge,
  Button,
  Input,
  openExternalUrl,
  Spinner,
  useApp,
} from "@elizaos/app-core";
import {
  LIFEOPS_INBOX_CHANNELS,
  type LifeOpsUnifiedMessage,
} from "@elizaos/shared/contracts/lifeops";
import { ExternalLink, MessageSquareReply, Search } from "lucide-react";
import { useCallback, useEffect, useMemo } from "react";
import {
  type InboxChannel,
  useUnifiedInbox,
} from "../hooks/useUnifiedInbox.js";
import { buildReplyPrefill, postToChat } from "./LifeOpsChatAdapter.js";
import {
  type LifeOpsSelection,
  useLifeOpsSelection,
} from "./LifeOpsSelectionContext.js";

function formatRelativeTime(receivedAt: string): string {
  const parsed = Date.parse(receivedAt);
  if (!Number.isFinite(parsed)) {
    return "";
  }
  const diffMs = Date.now() - parsed;
  const diffMinutes = Math.floor(diffMs / 60_000);
  if (diffMinutes < 1) {
    return "now";
  }
  if (diffMinutes < 60) {
    return `${diffMinutes}m ago`;
  }
  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours < 24) {
    return `${diffHours}h ago`;
  }
  const diffDays = Math.floor(diffHours / 24);
  return `${diffDays}d ago`;
}

function formatAbsoluteTime(receivedAt: string): string {
  const parsed = Date.parse(receivedAt);
  return Number.isFinite(parsed) ? new Date(parsed).toLocaleString() : "";
}

const CHANNEL_LABELS: Record<InboxChannel, string> = {
  all: "All",
  gmail: "Gmail",
  discord: "Discord",
  telegram: "Telegram",
  signal: "Signal",
  imessage: "iMessage",
  whatsapp: "WhatsApp",
  sms: "SMS",
};

const CHANNEL_FILTERS: InboxChannel[] = ["all", ...LIFEOPS_INBOX_CHANNELS];

function getChannelLabel(channel: InboxChannel): string {
  return CHANNEL_LABELS[channel] ?? channel;
}

function ChannelChip({
  channel,
  active,
  label,
  onClick,
}: {
  channel: InboxChannel;
  active: boolean;
  label: string;
  onClick: (ch: InboxChannel) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onClick(channel)}
      className={`rounded-full px-3 py-1 text-xs font-medium transition-colors ${
        active
          ? "bg-accent/20 text-accent-fg"
          : "text-muted hover:bg-bg-hover/40 hover:text-txt"
      }`}
    >
      {label}
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
  const subject =
    message.subject?.trim() || `${getChannelLabel(message.channel)} message`;

  return (
    <div
      className={`group flex cursor-pointer items-start gap-3 border-b border-border/10 px-4 py-3 transition-colors last:border-b-0 ${
        selected ? "bg-accent/8" : "hover:bg-bg-hover/30"
      }`}
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
    >
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-2">
          <span
            className={`truncate text-sm ${
              message.unread
                ? "font-semibold text-txt"
                : "font-medium text-txt/80"
            }`}
          >
            {message.sender.displayName}
          </span>
          <span className="shrink-0 text-[11px] text-muted">
            {formatRelativeTime(message.receivedAt)}
          </span>
        </div>
        <div className="mt-0.5 truncate text-xs text-muted">{subject}</div>
        <div className="mt-1 line-clamp-2 text-xs text-muted/75">
          {message.snippet}
        </div>
        <div className="mt-1.5 flex items-center gap-2">
          {message.unread ? (
            <span className="h-1.5 w-1.5 rounded-full bg-accent" />
          ) : null}
          <Badge variant="outline" className="text-3xs">
            {getChannelLabel(message.channel)}
          </Badge>
        </div>
      </div>
      <button
        type="button"
        aria-label="Reply"
        onClick={(e) => {
          e.stopPropagation();
          onReply();
        }}
        className="mt-0.5 shrink-0 rounded-full p-1.5 text-muted opacity-0 transition-opacity hover:bg-bg-hover/40 hover:text-txt group-hover:opacity-100"
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
      <div className="flex flex-1 items-center justify-center text-xs text-muted">
        {t("lifeopsInbox.selectMessage", {
          defaultValue: "Select a message to read it.",
        })}
      </div>
    );
  }

  const subject =
    message.subject?.trim() || `${getChannelLabel(message.channel)} message`;
  const receivedAt = formatAbsoluteTime(message.receivedAt);

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <div className="border-b border-border/12 px-5 py-4">
        <div className="text-sm font-semibold text-txt">{subject}</div>
        <div className="mt-1 text-xs text-muted">
          {t("lifeopsInbox.from", { defaultValue: "From" })}:{" "}
          {message.sender.displayName}
        </div>
        {receivedAt ? (
          <div className="mt-0.5 text-[11px] text-muted/70">{receivedAt}</div>
        ) : null}
      </div>

      <div className="flex-1 overflow-y-auto px-5 py-4">
        <p className="whitespace-pre-wrap text-sm leading-relaxed text-txt/80">
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

  const selectByIndex = useCallback(
    (index: number) => {
      const msg = inbox.messages[index];
      if (msg) {
        onSelect({ messageId: msg.id });
      }
    },
    [inbox.messages, onSelect],
  );

  const handleReply = useCallback((msg: LifeOpsUnifiedMessage) => {
    const text = buildReplyPrefill({
      channel: msg.channel === "gmail" ? "email" : getChannelLabel(msg.channel),
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
      className="overflow-hidden rounded-3xl border border-border/16 bg-card/18"
      data-testid="lifeops-inbox-section"
    >
      <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-4">
        <div className="text-sm font-semibold text-txt">
          {t("lifeopsInbox.heading", { defaultValue: "Inbox" })}
        </div>
        <div className="flex items-center gap-2">
          {CHANNEL_FILTERS.map((ch) => (
            <ChannelChip
              key={ch}
              channel={ch}
              active={inbox.channel === ch}
              label={getChannelLabel(ch)}
              onClick={inbox.setChannel}
            />
          ))}
        </div>
      </div>

      <div className="border-t border-border/12">
        {inbox.error ? (
          <div className="px-5 py-4 text-xs text-danger">{inbox.error}</div>
        ) : inbox.loading && inbox.messages.length === 0 ? (
          <div className="flex items-center gap-2 px-5 py-8 text-xs text-muted">
            <Spinner size={14} />
            {t("lifeopsInbox.loading", { defaultValue: "Loading inbox…" })}
          </div>
        ) : (
          <div className="flex h-[520px]">
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
                className="flex-1 overflow-y-auto"
                role="listbox"
                aria-label={t("lifeopsInbox.listAria", {
                  defaultValue: "Messages",
                })}
              >
                {inbox.messages.length === 0 ? (
                  <div className="px-4 py-8 text-center text-xs text-muted">
                    {inbox.searchQuery
                      ? t("lifeopsInbox.noResults", {
                          defaultValue: "No messages match your search.",
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
      </div>
    </section>
  );
}
