import {
  Button,
  client,
  Input,
  openExternalUrl,
  Spinner,
  useApp,
  useMediaQuery,
} from "@elizaos/ui";
import {
  LIFEOPS_INBOX_CHANNELS,
  type LifeOpsGmailNeedsResponseFeed,
  type LifeOpsGmailSpamReviewFeed,
  type LifeOpsGmailUnrespondedFeed,
  type LifeOpsInboxChannel,
  type LifeOpsInboxMessage,
  type LifeOpsInboxThreadGroup,
} from "@elizaos/shared";
import {
  AlarmClock,
  ArrowLeft,
  AtSign,
  CalendarClock,
  ExternalLink,
  MessageCircle,
  MessageSquare,
  MessageSquareReply,
  Phone,
  Search,
  Send,
  Shield,
  Smartphone,
  Sparkles,
} from "lucide-react";
import {
  type JSX,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import {
  type InboxChannel,
  type InboxChatType,
  useInbox,
} from "../hooks/useInbox.js";
import {
  buildMessageChatPrefill,
  buildReplyPrefill,
  useLifeOpsChatLauncher,
} from "./LifeOpsChatAdapter.js";
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

export const LIFEOPS_MESSAGE_CHANNELS: LifeOpsInboxChannel[] =
  LIFEOPS_INBOX_CHANNELS.filter((channel) => channel !== "gmail");
export const LIFEOPS_MAIL_CHANNELS: LifeOpsInboxChannel[] = ["gmail"];

const IMPORTANT_PRIORITY_SCORE_THRESHOLD = 70;
const MISSED_REPLY_GAP_MS = 24 * 60 * 60 * 1000;
const MISSED_MIN_PRIORITY = 50;
const ALL_GMAIL_ACCOUNTS = "__all__";

type MailWorkflowKind = "needs_response" | "unresponded" | "spam_review";

interface MailWorkflowState {
  kind: MailWorkflowKind | null;
  loading: boolean;
  summary: string | null;
  error: string | null;
}

function styleFor(channel: LifeOpsInboxChannel): ChannelStyle {
  return CHANNEL_STYLES[channel];
}

function styleForFilter(channel: InboxChannel): ChannelStyle {
  return channel === "all"
    ? ALL_CHANNEL_STYLE
    : CHANNEL_STYLES[channel as LifeOpsInboxChannel];
}

function messagesForThreadGroup(
  group: LifeOpsInboxThreadGroup,
): LifeOpsInboxMessage[] {
  const messages = Array.isArray(group.messages) ? group.messages : [];
  return messages.length > 0 ? messages : [group.latestMessage];
}

function computeMissedAgeMs(message: LifeOpsInboxMessage): number | null {
  if (typeof message.repliedAt === "string" && message.repliedAt.length > 0) {
    return null;
  }
  const received = Date.parse(message.receivedAt);
  if (!Number.isFinite(received)) return null;
  const age = Date.now() - received;
  return age >= MISSED_REPLY_GAP_MS ? age : null;
}

function formatMissedAge(ageMs: number): string {
  const days = Math.floor(ageMs / (24 * 60 * 60 * 1000));
  if (days >= 1) return `${days}d ago`;
  const hours = Math.max(1, Math.floor(ageMs / (60 * 60 * 1000)));
  return `${hours}h ago`;
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

function GmailAccountChip({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  const style = CHANNEL_STYLES.gmail;
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={[
        "inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-medium transition-colors",
        active
          ? `${style.bg} ${style.text} ring-1 ${style.ring}`
          : "bg-bg-muted/30 text-muted hover:text-txt",
      ].join(" ")}
    >
      <span className={`shrink-0 ${active ? style.text : "text-muted/80"}`}>
        {style.icon}
      </span>
      <span>{label}</span>
    </button>
  );
}

function MailWorkflowButton({
  kind,
  active,
  loading,
  onClick,
}: {
  kind: MailWorkflowKind;
  active: boolean;
  loading: boolean;
  onClick: (kind: MailWorkflowKind) => void;
}) {
  const label =
    kind === "needs_response"
      ? "Needs response"
      : kind === "unresponded"
        ? "Unresponded"
        : "Spam review";
  const icon =
    kind === "spam_review" ? (
      <Shield className="h-3.5 w-3.5" aria-hidden />
    ) : kind === "unresponded" ? (
      <AlarmClock className="h-3.5 w-3.5" aria-hidden />
    ) : (
      <MessageSquareReply className="h-3.5 w-3.5" aria-hidden />
    );
  return (
    <button
      type="button"
      aria-pressed={active}
      disabled={loading}
      onClick={() => onClick(kind)}
      className={[
        "inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-medium transition-colors disabled:opacity-60",
        active
          ? "bg-rose-500/16 text-rose-300 ring-1 ring-rose-500/40"
          : "bg-bg-muted/30 text-muted hover:text-txt",
      ].join(" ")}
    >
      {icon}
      <span>{loading ? "Loading..." : label}</span>
    </button>
  );
}

function summarizeNeedsResponseFeed(
  feed: LifeOpsGmailNeedsResponseFeed,
): string {
  return `${feed.summary.totalCount} thread${
    feed.summary.totalCount === 1 ? "" : "s"
  } need response`;
}

function summarizeUnrespondedFeed(feed: LifeOpsGmailUnrespondedFeed): string {
  const oldest = feed.summary.oldestDaysWaiting;
  return oldest === null
    ? `${feed.summary.totalCount} sent thread${
        feed.summary.totalCount === 1 ? "" : "s"
      } awaiting reply`
    : `${feed.summary.totalCount} sent thread${
        feed.summary.totalCount === 1 ? "" : "s"
      } awaiting reply, oldest ${oldest}d`;
}

function summarizeSpamReviewFeed(feed: LifeOpsGmailSpamReviewFeed): string {
  return `${feed.summary.pendingCount} pending spam review item${
    feed.summary.pendingCount === 1 ? "" : "s"
  }`;
}

interface ThreadRowProps {
  group: LifeOpsInboxThreadGroup;
  selected: boolean;
  onSelect: () => void;
  onReply: () => void;
  showAccountSubtitle: boolean;
}

function ThreadRow({
  group,
  selected,
  onSelect,
  onReply,
  showAccountSubtitle,
}: ThreadRowProps) {
  const message = group.latestMessage;
  const style = styleFor(message.channel);
  const subject = message.subject?.trim() || `${style.label} message`;
  const score = group.maxPriorityScore ?? message.priorityScore ?? 0;
  const category = group.priorityCategory ?? message.priorityCategory ?? null;
  const isImportant =
    score >= IMPORTANT_PRIORITY_SCORE_THRESHOLD || category === "important";
  const isPlanning = category === "planning";
  const missedAge = computeMissedAgeMs(message);
  const isMissed = missedAge !== null && score >= MISSED_MIN_PRIORITY;
  const senderLabel =
    group.chatType === "group" && typeof group.participantCount === "number"
      ? `${message.sender.displayName} (${group.participantCount})`
      : message.sender.displayName;

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
            {senderLabel}
          </span>
          <div className="flex shrink-0 items-center gap-1.5">
            {group.totalCount > 1 ? (
              <span className="text-[10px] tabular-nums text-muted">
                {group.totalCount}
              </span>
            ) : null}
            {group.unreadCount > 0 ? (
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
        <div className="mt-1 flex flex-wrap items-center gap-1.5">
          {isImportant ? (
            <span
              className="inline-flex items-center gap-1 rounded-full bg-amber-500/16 px-1.5 py-0.5 text-[10px] font-semibold text-amber-300 ring-1 ring-amber-500/40"
              title={`Priority score ${score}`}
            >
              <Sparkles className="h-2.5 w-2.5" aria-hidden />
              Important
            </span>
          ) : null}
          {isPlanning ? (
            <span className="inline-flex items-center gap-1 rounded-full bg-sky-500/16 px-1.5 py-0.5 text-[10px] font-semibold text-sky-300 ring-1 ring-sky-500/40">
              <CalendarClock className="h-2.5 w-2.5" aria-hidden />
              Planning
            </span>
          ) : null}
          {showAccountSubtitle && message.gmailAccountEmail ? (
            <span className="truncate text-[10px] text-muted/70">
              {message.gmailAccountEmail}
            </span>
          ) : null}
        </div>
      </div>

      <div className="flex shrink-0 flex-col items-end gap-1">
        {isMissed && missedAge !== null ? (
          <span
            className="inline-flex items-center gap-1 rounded-full bg-amber-500/16 px-1.5 py-0.5 text-[10px] font-semibold text-amber-300 ring-1 ring-amber-500/40"
            title="Unreplied for over 24h"
          >
            <AlarmClock className="h-2.5 w-2.5" aria-hidden />
            Missed · {formatMissedAge(missedAge)}
          </span>
        ) : null}
        <button
          type="button"
          aria-label="Reply"
          onClick={(e) => {
            e.stopPropagation();
            onReply();
          }}
          className="mt-0.5 rounded-full p-1.5 text-muted opacity-0 transition-opacity hover:bg-bg-muted/40 hover:text-txt group-hover:opacity-100"
        >
          <MessageSquareReply className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}

function MessageRow({
  message,
  selected,
  onSelect,
  onReply,
}: {
  message: LifeOpsInboxMessage;
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
  threadGroup,
  onReply,
  onChat,
  onBack,
}: {
  threadGroup: LifeOpsInboxThreadGroup | null;
  onReply: (msg: LifeOpsInboxMessage) => void;
  onChat: (msg: LifeOpsInboxMessage) => void;
  onBack?: () => void;
}) {
  const { t } = useApp();
  const message = threadGroup?.latestMessage ?? null;

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
  const threadMessages = threadGroup
    ? [...messagesForThreadGroup(threadGroup)].sort(
        (left, right) =>
          Date.parse(left.receivedAt) - Date.parse(right.receivedAt),
      )
    : [];

  return (
    <div className="flex flex-1 flex-col overflow-hidden bg-bg/10">
      <div className="flex items-start gap-3 border-b border-border/12 px-5 py-4">
        {onBack ? (
          <button
            type="button"
            aria-label={t("lifeopsInbox.backToList", {
              defaultValue: "Back to inbox list",
            })}
            onClick={onBack}
            className="mt-0.5 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-muted transition-colors hover:bg-bg-muted/40 hover:text-txt"
          >
            <ArrowLeft className="h-4 w-4" />
          </button>
        ) : null}
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
            <span>
              {threadMessages.length > 1
                ? `${threadMessages.length} messages`
                : message.sender.displayName}
            </span>
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
        <div className="space-y-3">
          {(threadMessages.length > 0 ? threadMessages : [message]).map(
            (item) => {
              const itemStyle = styleFor(item.channel);
              return (
                <article
                  key={item.id}
                  className="rounded-xl border border-border/12 bg-bg/20 px-3 py-3"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="truncate text-sm font-medium text-txt">
                        {item.sender.displayName}
                      </div>
                      <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[11px] text-muted">
                        <span
                          className={`inline-flex items-center gap-1 ${itemStyle.text}`}
                        >
                          {itemStyle.icon}
                          {itemStyle.label}
                        </span>
                        {item.sender.email ? (
                          <span>{item.sender.email}</span>
                        ) : null}
                      </div>
                    </div>
                    <span className="shrink-0 text-[11px] tabular-nums text-muted">
                      {formatAbsoluteTime(item.receivedAt)}
                    </span>
                  </div>
                  <p className="mt-3 whitespace-pre-wrap text-sm leading-relaxed text-txt/85">
                    {item.snippet}
                  </p>
                </article>
              );
            },
          )}
        </div>
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
        <Button
          size="sm"
          variant="ghost"
          className="h-8 rounded-xl px-3 text-xs font-semibold text-muted"
          onClick={() => onChat(message)}
        >
          <MessageSquare className="mr-1.5 h-3.5 w-3.5" />
          {t("common.chat", { defaultValue: "Chat" })}
        </Button>
        {message.channel === "gmail" ? (
          <InboxUnsubscribeButton message={message} />
        ) : null}
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

function InboxUnsubscribeButton({
  message,
}: {
  message: LifeOpsInboxMessage;
}): JSX.Element | null {
  const senderEmail = message.sender.email?.trim().toLowerCase() || null;
  const [state, setState] = useState<"idle" | "working" | "done" | "error">(
    "idle",
  );
  const [note, setNote] = useState<string | null>(null);

  const onClick = useCallback(async () => {
    if (!senderEmail) return;
    if (!window.confirm(`Send an unsubscribe request to ${senderEmail}?`)) {
      return;
    }
    setState("working");
    try {
      const result = await client.unsubscribeLifeOpsEmailSender({
        senderEmail,
        blockAfter: false,
        trashExisting: false,
        confirmed: true,
      });
      setState(result.record.status === "succeeded" ? "done" : "error");
      setNote(result.record.status);
    } catch (error) {
      setState("error");
      setNote(error instanceof Error ? error.message : String(error));
    }
  }, [senderEmail]);

  // Hide entirely when the message has no parsed From email (chat channels,
  // malformed Gmail headers). Showing a button that can't work is worse than
  // not showing it.
  if (!senderEmail) return null;

  const label =
    state === "working"
      ? "Unsubscribing…"
      : state === "done"
        ? "Unsubscribed"
        : state === "error"
          ? `Failed${note ? `: ${note}` : ""}`
          : "Unsubscribe";

  return (
    <Button
      size="sm"
      variant="ghost"
      className="h-8 rounded-xl px-3 text-xs font-semibold text-muted"
      disabled={state === "working" || state === "done"}
      onClick={() => void onClick()}
      title={`Send RFC 8058 one-click unsubscribe to ${senderEmail}`}
    >
      {label}
    </Button>
  );
}

interface InboxListPaneProps {
  inbox: ReturnType<typeof useInbox>;
  selectedMessageId: string | null;
  onSelect: (args: Partial<LifeOpsSelection>) => void;
  onReply: (msg: LifeOpsInboxMessage) => void;
  emptyLabel?: string;
  groupedMode: boolean;
  visibleThreadGroups: LifeOpsInboxThreadGroup[];
  showGmailAccountSubtitles: boolean;
}

function InboxListPane({
  inbox,
  selectedMessageId,
  onSelect,
  onReply,
  emptyLabel,
  groupedMode,
  visibleThreadGroups,
  showGmailAccountSubtitles,
}: InboxListPaneProps) {
  const { t } = useApp();
  const isEmpty = groupedMode
    ? visibleThreadGroups.length === 0
    : inbox.messages.length === 0;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
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
        {isEmpty ? (
          <div className="px-4 py-8 text-center text-xs text-muted">
            {inbox.searchQuery
              ? t("lifeopsInbox.noResults", {
                  defaultValue: "No matches.",
                })
              : t("lifeopsInbox.empty", {
                  defaultValue: emptyLabel ?? "Inbox clear.",
                })}
          </div>
        ) : groupedMode ? (
          visibleThreadGroups.map((group) => (
            <ThreadRow
              key={group.threadId}
              group={group}
              selected={
                group.latestMessage.id === selectedMessageId ||
                messagesForThreadGroup(group).some(
                  (message) => message.id === selectedMessageId,
                )
              }
              onSelect={() => onSelect({ messageId: group.latestMessage.id })}
              onReply={() => onReply(group.latestMessage)}
              showAccountSubtitle={showGmailAccountSubtitles}
            />
          ))
        ) : (
          inbox.messages.map((msg) => (
            <MessageRow
              key={msg.id}
              message={msg}
              selected={msg.id === selectedMessageId}
              onSelect={() => onSelect({ messageId: msg.id })}
              onReply={() => onReply(msg)}
            />
          ))
        )}
      </div>
    </div>
  );
}

export interface LifeOpsInboxSectionProps {
  selection?: LifeOpsSelection;
  onSelect?: (args: Partial<LifeOpsSelection>) => void;
  channels?: readonly LifeOpsInboxChannel[];
  title?: string;
  emptyLabel?: string;
}

export function LifeOpsInboxSection(props: LifeOpsInboxSectionProps = {}) {
  const ctx = useLifeOpsSelection();
  const selection = props.selection ?? ctx.selection;
  const onSelect = props.onSelect ?? ctx.select;
  const { t } = useApp();
  const { openLifeOpsChat } = useLifeOpsChatLauncher();
  const compactLayout = useMediaQuery("(max-width: 767px)");
  const allowedChannels = props.channels ?? LIFEOPS_INBOX_CHANNELS;

  // Derive the section mode from the channel set passed in by the route.
  // Mail mode is gmail-only; everything else is the Messages section, which
  // is intentionally direct-message only.
  const isMailMode =
    allowedChannels.length === 1 && allowedChannels[0] === "gmail";
  const isMessagesMode = !isMailMode;

  const channelFilters = useMemo<InboxChannel[]>(
    () =>
      allowedChannels.length > 1
        ? ["all", ...allowedChannels]
        : [...allowedChannels],
    [allowedChannels],
  );

  const [selectedGmailAccount, setSelectedGmailAccount] =
    useState<string>(ALL_GMAIL_ACCOUNTS);
  const [missedOnly, setMissedOnly] = useState<boolean>(false);
  const [mailWorkflow, setMailWorkflow] = useState<MailWorkflowState>({
    kind: null,
    loading: false,
    summary: null,
    error: null,
  });

  const chatTypeFilter = useMemo<ReadonlyArray<InboxChatType> | undefined>(
    () =>
      isMessagesMode
        ? (["dm"] as const)
        : isMailMode
          ? (["dm"] as const)
          : undefined,
    [isMessagesMode, isMailMode],
  );

  const inbox = useInbox({
    maxResults: 40,
    channel: allowedChannels.length === 1 ? allowedChannels[0] : "all",
    channels: allowedChannels,
    groupByThread: true,
    chatTypeFilter,
    maxParticipants: undefined,
    gmailAccountId:
      isMailMode && selectedGmailAccount !== ALL_GMAIL_ACCOUNTS
        ? selectedGmailAccount
        : undefined,
    missedOnly: isMessagesMode ? missedOnly : false,
    // Mail mode keeps recency-first because email priority is less actionable.
    sortByPriority: isMessagesMode,
  });

  const selectedMessageId = selection.messageId ?? null;

  // Build the messages-by-id index from both flat messages and thread groups
  // so the reader pane can resolve the active message regardless of how we
  // ended up selecting it.
  const messageById = useMemo(() => {
    const map = new Map<string, LifeOpsInboxMessage>();
    for (const msg of inbox.messages) map.set(msg.id, msg);
    for (const group of inbox.threadGroups) {
      map.set(group.latestMessage.id, group.latestMessage);
      for (const msg of messagesForThreadGroup(group)) {
        map.set(msg.id, msg);
      }
    }
    return map;
  }, [inbox.messages, inbox.threadGroups]);

  const threadGroupByMessageId = useMemo(() => {
    const map = new Map<string, LifeOpsInboxThreadGroup>();
    for (const group of inbox.threadGroups) {
      map.set(group.latestMessage.id, group);
      for (const msg of messagesForThreadGroup(group)) {
        map.set(msg.id, group);
      }
    }
    return map;
  }, [inbox.threadGroups]);

  const selectedMessage =
    (selectedMessageId ? messageById.get(selectedMessageId) : null) ?? null;
  const selectedThread =
    (selectedMessageId
      ? threadGroupByMessageId.get(selectedMessageId)
      : null) ?? null;

  // Distinct Gmail accounts visible in the current feed. Only show the chip
  // group when more than one Gmail account has produced messages.
  const gmailAccountOptions = useMemo<
    Array<{ id: string; label: string }>
  >(() => {
    if (!isMailMode) return [];
    const seen = new Map<string, string>();
    for (const group of inbox.threadGroups) {
      const id = group.latestMessage.gmailAccountId;
      const email = group.latestMessage.gmailAccountEmail;
      if (id && email && !seen.has(id)) seen.set(id, email);
    }
    if (seen.size === 0) {
      for (const msg of inbox.messages) {
        if (
          msg.gmailAccountId &&
          msg.gmailAccountEmail &&
          !seen.has(msg.gmailAccountId)
        ) {
          seen.set(msg.gmailAccountId, msg.gmailAccountEmail);
        }
      }
    }
    return Array.from(seen.entries()).map(([id, label]) => ({ id, label }));
  }, [inbox.threadGroups, inbox.messages, isMailMode]);

  const showGmailAccountChips = isMailMode && gmailAccountOptions.length > 1;
  // Subtitle on every Gmail row when more than one account is connected, so
  // users can tell apart two senders that exist in both inboxes.
  const showGmailAccountSubtitles = showGmailAccountChips;
  const activeGmailGrantId =
    isMailMode && selectedGmailAccount !== ALL_GMAIL_ACCOUNTS
      ? selectedGmailAccount
      : undefined;

  const runMailWorkflow = useCallback(
    async (kind: MailWorkflowKind) => {
      setMailWorkflow({ kind, loading: true, summary: null, error: null });
      try {
        const request = {
          maxResults: 40,
          grantId: activeGmailGrantId,
        };
        const summary =
          kind === "needs_response"
            ? summarizeNeedsResponseFeed(
                await client.getLifeOpsGmailNeedsResponse(request),
              )
            : kind === "unresponded"
              ? summarizeUnrespondedFeed(
                  await client.getLifeOpsGmailUnresponded({
                    ...request,
                    olderThanDays: 3,
                  }),
                )
              : summarizeSpamReviewFeed(
                  await client.getLifeOpsGmailSpamReview({
                    ...request,
                    status: "pending",
                  }),
                );
        setMailWorkflow({ kind, loading: false, summary, error: null });
      } catch (error) {
        setMailWorkflow({
          kind,
          loading: false,
          summary: null,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
    [activeGmailGrantId],
  );

  // Reset to "all" if the previously selected account disappears from the
  // current feed (e.g. account disconnected).
  useEffect(() => {
    if (
      selectedGmailAccount !== ALL_GMAIL_ACCOUNTS &&
      !gmailAccountOptions.some((opt) => opt.id === selectedGmailAccount)
    ) {
      setSelectedGmailAccount(ALL_GMAIL_ACCOUNTS);
    }
  }, [gmailAccountOptions, selectedGmailAccount]);

  const channelCounts = useMemo(() => {
    const base = Object.fromEntries(
      channelFilters.map((channel) => [channel, { total: 0, unread: 0 }]),
    ) as Record<InboxChannel, { total: number; unread: number }>;
    for (const message of inbox.messages) {
      const all = base.all;
      if (all) {
        all.total++;
        if (message.unread) all.unread++;
      }
      const bucket = base[message.channel as InboxChannel];
      if (bucket) {
        bucket.total++;
        if (message.unread) bucket.unread++;
      }
    }
    return base;
  }, [channelFilters, inbox.messages]);

  // Build the navigable list (thread rows in grouped modes, flat messages
  // otherwise) so j/k keyboard navigation walks the same items the user sees.
  const navigableItems = useMemo<LifeOpsInboxMessage[]>(
    () => inbox.threadGroups.map((g) => g.latestMessage),
    [inbox.threadGroups],
  );

  const navigableSelectedIndex = useMemo(
    () => navigableItems.findIndex((m) => m.id === selectedMessageId),
    [navigableItems, selectedMessageId],
  );

  const selectByIndex = useCallback(
    (index: number) => {
      const msg = navigableItems[index];
      if (msg) onSelect({ messageId: msg.id });
    },
    [navigableItems, onSelect],
  );

  const handleReply = useCallback(
    (msg: LifeOpsInboxMessage) => {
      const label = styleFor(msg.channel).label;
      const text = buildReplyPrefill({
        channel: msg.channel === "gmail" ? "email" : label,
        sender: msg.sender.displayName,
        snippet: msg.snippet,
        deepLink: msg.deepLink,
      });
      openLifeOpsChat(text, { messageId: msg.id });
    },
    [openLifeOpsChat],
  );

  const handleChat = useCallback(
    (msg: LifeOpsInboxMessage) => {
      openLifeOpsChat(buildMessageChatPrefill(msg), {
        messageId: msg.id,
      });
    },
    [openLifeOpsChat],
  );

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
        selectByIndex(
          Math.min(navigableSelectedIndex + 1, navigableItems.length - 1),
        );
      } else if (e.key === "k") {
        e.preventDefault();
        selectByIndex(Math.max(navigableSelectedIndex - 1, 0));
      } else if (e.key === "r" && selectedMessage) {
        e.preventDefault();
        handleReply(selectedMessage);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [
    handleReply,
    navigableItems.length,
    navigableSelectedIndex,
    selectByIndex,
    selectedMessage,
  ]);

  useEffect(() => {
    if (
      !compactLayout &&
      navigableItems.length > 0 &&
      (!selectedMessageId || navigableSelectedIndex === -1)
    ) {
      onSelect({ messageId: navigableItems[0].id });
    }
  }, [
    compactLayout,
    navigableItems,
    navigableSelectedIndex,
    onSelect,
    selectedMessageId,
  ]);

  return (
    <section
      className="flex h-full min-h-0 flex-col overflow-hidden rounded-3xl border border-border/16 bg-card/18"
      data-testid="lifeops-inbox-section"
    >
      <div className="flex flex-wrap items-center gap-2 border-b border-border/12 px-3 py-2.5">
        <div className="mr-auto px-1 text-sm font-semibold text-txt">
          {props.title ?? "Messages"}
        </div>
        {channelFilters.map((ch) => {
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
        {isMessagesMode ? (
          <button
            type="button"
            aria-pressed={missedOnly}
            onClick={() => setMissedOnly((prev) => !prev)}
            title={t("lifeopsInbox.missedTooltip", {
              defaultValue:
                "Threads you have not replied to in 24h with priority ≥ 50",
            })}
            className={[
              "inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-medium transition-colors",
              missedOnly
                ? "bg-amber-500/16 text-amber-300 ring-1 ring-amber-500/40"
                : "bg-bg-muted/30 text-muted hover:text-txt",
            ].join(" ")}
          >
            <AlarmClock className="h-3.5 w-3.5" aria-hidden />
            {t("lifeopsInbox.missed", { defaultValue: "Missed" })}
          </button>
        ) : null}
        {isMailMode
          ? (["needs_response", "unresponded", "spam_review"] as const).map(
              (kind) => (
                <MailWorkflowButton
                  key={kind}
                  kind={kind}
                  active={mailWorkflow.kind === kind}
                  loading={mailWorkflow.kind === kind && mailWorkflow.loading}
                  onClick={(nextKind) => void runMailWorkflow(nextKind)}
                />
              ),
            )
          : null}
      </div>

      {isMailMode && (mailWorkflow.summary || mailWorkflow.error) ? (
        <div
          className={[
            "border-b border-border/10 px-4 py-2 text-xs",
            mailWorkflow.error ? "text-rose-300" : "text-muted",
          ].join(" ")}
        >
          {mailWorkflow.error ?? mailWorkflow.summary}
        </div>
      ) : null}

      {showGmailAccountChips ? (
        <div className="flex flex-wrap items-center gap-2 border-b border-border/10 px-3 py-2">
          <GmailAccountChip
            label={t("lifeopsInbox.allGmail", { defaultValue: "All Gmail" })}
            active={selectedGmailAccount === ALL_GMAIL_ACCOUNTS}
            onClick={() => setSelectedGmailAccount(ALL_GMAIL_ACCOUNTS)}
          />
          {gmailAccountOptions.map((opt) => (
            <GmailAccountChip
              key={opt.id}
              label={`Gmail · ${opt.label}`}
              active={selectedGmailAccount === opt.id}
              onClick={() => setSelectedGmailAccount(opt.id)}
            />
          ))}
        </div>
      ) : null}

      {inbox.error ? (
        <div className="px-5 py-4 text-xs text-rose-300">{inbox.error}</div>
      ) : inbox.loading && inbox.messages.length === 0 ? (
        <div className="flex items-center gap-2 px-5 py-8 text-xs text-muted">
          <Spinner size={14} />
          {t("lifeopsInbox.loading", { defaultValue: "Loading inbox…" })}
        </div>
      ) : (
        <div className="flex min-h-0 flex-1">
          {compactLayout ? (
            selectedThread ? (
              <ReaderPane
                threadGroup={selectedThread}
                onReply={handleReply}
                onChat={handleChat}
                onBack={() => onSelect({ messageId: null })}
              />
            ) : (
              <InboxListPane
                inbox={inbox}
                selectedMessageId={selectedMessageId}
                onSelect={onSelect}
                onReply={handleReply}
                emptyLabel={props.emptyLabel}
                groupedMode={true}
                visibleThreadGroups={inbox.threadGroups}
                showGmailAccountSubtitles={showGmailAccountSubtitles}
              />
            )
          ) : (
            <>
              <div className="flex w-72 shrink-0 flex-col border-r border-border/12">
                <InboxListPane
                  inbox={inbox}
                  selectedMessageId={selectedMessageId}
                  onSelect={onSelect}
                  onReply={handleReply}
                  emptyLabel={props.emptyLabel}
                  groupedMode={true}
                  visibleThreadGroups={inbox.threadGroups}
                  showGmailAccountSubtitles={showGmailAccountSubtitles}
                />
              </div>

              <ReaderPane
                threadGroup={selectedThread}
                onReply={handleReply}
                onChat={handleChat}
              />
            </>
          )}
        </div>
      )}
    </section>
  );
}
