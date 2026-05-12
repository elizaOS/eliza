import { client, useApp } from "@elizaos/ui";
import type {
  LifeOpsActiveReminderView,
  LifeOpsCalendarEvent,
  LifeOpsCapabilitiesStatus,
  LifeOpsCircadianState,
  LifeOpsGoogleCapability,
  LifeOpsGoogleConnectorStatus,
  LifeOpsInboxChannel,
  LifeOpsInboxMessage,
  LifeOpsOverview,
  LifeOpsScheduleInsight,
  LifeOpsXConnectorStatus,
} from "@elizaos/shared";
import {
  ArrowRight,
  AtSign,
  CalendarDays,
  Flame,
  Loader2,
  Mail,
  MessageCircle,
  MessageSquare,
  Monitor,
  Moon,
  Phone,
  RefreshCw,
  Send,
  Share2,
  Shield,
  Smartphone,
  Sun,
  Target,
  TriangleAlert,
} from "lucide-react";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import type {
  LifeOpsScreenTimeSummary,
  LifeOpsScreenTimeSummaryItem,
  LifeOpsSocialHabitSummary,
} from "../api/client-lifeops.js";
import { useCalendarWeek } from "../hooks/useCalendarWeek.js";
import { useGoogleLifeOpsConnector } from "../hooks/useGoogleLifeOpsConnector.js";
import { useInbox } from "../hooks/useInbox.js";
import { useLifeOpsCapabilitiesStatus } from "../hooks/useLifeOpsCapabilitiesStatus.js";
import type { LifeOpsSection } from "../hooks/useLifeOpsSection.js";
import { useLifeOpsXConnector } from "../hooks/useLifeOpsXConnector.js";
import { BrowserBridgeStatusChip } from "./BrowserBridgeStatusChip.js";
import { DataSourcesStrip } from "./DataSourcesStrip.js";
import {
  LIFEOPS_MAIL_CHANNELS,
  LIFEOPS_MESSAGE_CHANNELS,
} from "./LifeOpsInboxSection.js";
import { useLifeOpsSelection } from "./LifeOpsSelectionContext.js";
import { MissingSourceCard } from "./MissingSourceCard.js";

interface LifeOpsOverviewSectionProps {
  onNavigate: (section: LifeOpsSection) => void;
}

type ReminderUrgency = "overdue" | "soon" | "today" | "later";

type TimelineEntry =
  | {
      id: string;
      kind: "event";
      sortAt: number;
      event: LifeOpsCalendarEvent;
    }
  | {
      id: string;
      kind: "reminder";
      sortAt: number;
      reminder: LifeOpsActiveReminderView;
    };

const URGENCY_STYLES: Record<ReminderUrgency, { dot: string; text: string }> = {
  overdue: {
    dot: "bg-rose-500",
    text: "text-rose-300",
  },
  soon: {
    dot: "bg-amber-400",
    text: "text-amber-300",
  },
  today: {
    dot: "bg-blue-400",
    text: "text-blue-300",
  },
  later: {
    dot: "bg-emerald-400",
    text: "text-emerald-300",
  },
};

const CHANNEL_STYLES: Record<
  LifeOpsInboxChannel,
  { label: string; icon: ReactNode; text: string; bg: string }
> = {
  gmail: {
    label: "Gmail",
    icon: <AtSign className="h-3.5 w-3.5" aria-hidden />,
    text: "text-rose-300",
    bg: "bg-rose-500/12",
  },
  discord: {
    label: "Discord",
    icon: <MessageCircle className="h-3.5 w-3.5" aria-hidden />,
    text: "text-indigo-300",
    bg: "bg-indigo-500/14",
  },
  telegram: {
    label: "Telegram",
    icon: <Send className="h-3.5 w-3.5" aria-hidden />,
    text: "text-sky-300",
    bg: "bg-sky-500/14",
  },
  signal: {
    label: "Signal",
    icon: <Shield className="h-3.5 w-3.5" aria-hidden />,
    text: "text-blue-300",
    bg: "bg-blue-500/14",
  },
  imessage: {
    label: "iMessage",
    icon: <MessageSquare className="h-3.5 w-3.5" aria-hidden />,
    text: "text-emerald-300",
    bg: "bg-emerald-500/14",
  },
  whatsapp: {
    label: "WhatsApp",
    icon: <Smartphone className="h-3.5 w-3.5" aria-hidden />,
    text: "text-lime-300",
    bg: "bg-lime-500/14",
  },
  sms: {
    label: "SMS",
    icon: <Phone className="h-3.5 w-3.5" aria-hidden />,
    text: "text-amber-300",
    bg: "bg-amber-500/14",
  },
  x_dm: {
    label: "X DM",
    icon: <AtSign className="h-3.5 w-3.5" aria-hidden />,
    text: "text-zinc-200",
    bg: "bg-zinc-500/14",
  },
};

const CHANNEL_ORDER: LifeOpsInboxChannel[] = [
  "gmail",
  "imessage",
  "sms",
  "discord",
  "telegram",
  "signal",
  "whatsapp",
  "x_dm",
];

function useGreeting(): string {
  const hour = new Date().getHours();
  if (hour < 5) return "Still up";
  if (hour < 12) return "Morning";
  if (hour < 17) return "Afternoon";
  if (hour < 22) return "Evening";
  return "Wind-down";
}

function formatFullDate(date: Date): string {
  return new Intl.DateTimeFormat(undefined, {
    weekday: "long",
    month: "long",
    day: "numeric",
  }).format(date);
}

function formatClockTime(iso: string | null | undefined): string {
  if (!iso) return "";
  const parsed = Date.parse(iso);
  if (!Number.isFinite(parsed)) return "";
  return new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(parsed));
}

function formatRelative(iso: string): string {
  const parsed = Date.parse(iso);
  if (!Number.isFinite(parsed)) return iso;
  const diffMs = parsed - Date.now();
  const diffMin = Math.round(diffMs / 60_000);
  if (Math.abs(diffMin) < 1) return "now";
  if (diffMin > 0) {
    if (diffMin < 60) return `in ${diffMin}m`;
    const hrs = Math.round(diffMin / 60);
    if (hrs < 24) return `in ${hrs}h`;
    return `in ${Math.round(hrs / 24)}d`;
  }
  const ago = Math.abs(diffMin);
  if (ago < 60) return `${ago}m ago`;
  const agoH = Math.round(ago / 60);
  if (agoH < 24) return `${agoH}h ago`;
  return `${Math.round(agoH / 24)}d ago`;
}

function formatDurationMinutes(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return "";
  }
  const total = Math.round(value);
  if (total < 60) return `${total}m`;
  const hours = Math.floor(total / 60);
  const minutes = total % 60;
  return minutes === 0 ? `${hours}h` : `${hours}h ${minutes}m`;
}

function formatDurationSeconds(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return "";
  }
  return formatDurationMinutes(value / 60);
}

function humanize(value: string | null | undefined): string {
  if (!value) return "";
  return value
    .split("_")
    .filter(Boolean)
    .map((part) => part[0]?.toUpperCase() + part.slice(1))
    .join(" ");
}

function startOfLocalDayIso(date = new Date()): string {
  const start = new Date(date);
  start.setHours(0, 0, 0, 0);
  return start.toISOString();
}

function classifyReminder(iso: string): ReminderUrgency {
  const parsed = Date.parse(iso);
  if (!Number.isFinite(parsed)) return "later";
  const diffMin = Math.round((parsed - Date.now()) / 60_000);
  if (diffMin < 0) return "overdue";
  if (diffMin < 60) return "soon";
  if (diffMin < 60 * 24) return "today";
  return "later";
}

const CIRCADIAN_LABELS: Record<LifeOpsCircadianState, string> = {
  awake: "Awake",
  winding_down: "Winding down",
  sleeping: "Sleeping",
  waking: "Waking up",
  napping: "Napping",
  unclear: "Schedule unclear",
};

function circadianHeadline(
  schedule: LifeOpsScheduleInsight | null | undefined,
): string | null {
  if (!schedule) return null;
  const base = CIRCADIAN_LABELS[schedule.circadianState];
  if (!base) return null;
  if (schedule.circadianState === "winding_down") {
    const minutes = schedule.relativeTime.minutesUntilBedtimeTarget;
    if (typeof minutes === "number" && minutes > 0) {
      const formatted = formatDurationMinutes(minutes);
      if (formatted) return `Winding down for bed in ${formatted}`;
    }
  }
  if (schedule.circadianState === "awake") {
    const minutes = schedule.relativeTime.minutesAwake;
    if (typeof minutes === "number" && minutes > 0) {
      const formatted = formatDurationMinutes(minutes);
      if (formatted) return `Awake for ${formatted}`;
    }
  }
  if (schedule.circadianState === "sleeping") {
    return "Sleeping now";
  }
  return base;
}

function topActiveSession(
  screenTime: LifeOpsScreenTimeSummary | null,
): LifeOpsScreenTimeSummaryItem | null {
  const items = screenTime?.items ?? [];
  if (items.length === 0) return null;
  return items.reduce<LifeOpsScreenTimeSummaryItem>(
    (best, current) =>
      current.totalSeconds > best.totalSeconds ? current : best,
    items[0],
  );
}

function computeWeeklyDelta(args: {
  todayTotalSeconds: number | null | undefined;
  weeklyTotalSeconds: number | null | undefined;
}): { label: string; arrow: "up" | "down" | "flat" } | null {
  const { todayTotalSeconds, weeklyTotalSeconds } = args;
  if (
    typeof todayTotalSeconds !== "number" ||
    typeof weeklyTotalSeconds !== "number" ||
    !Number.isFinite(todayTotalSeconds) ||
    !Number.isFinite(weeklyTotalSeconds) ||
    weeklyTotalSeconds <= 0
  ) {
    return null;
  }
  const dailyAverage = weeklyTotalSeconds / 7;
  if (dailyAverage <= 0) return null;
  const delta = (todayTotalSeconds - dailyAverage) / dailyAverage;
  const percent = Math.round(Math.abs(delta) * 100);
  if (percent < 1) {
    return { label: "On par with avg", arrow: "flat" };
  }
  const arrow: "up" | "down" = delta > 0 ? "up" : "down";
  const symbol = arrow === "up" ? "↑" : "↓";
  return { label: `${symbol} ${percent}% vs avg`, arrow };
}

function sleepStatusLabel(schedule: LifeOpsScheduleInsight | null | undefined) {
  if (!schedule) return "No sleep signal";
  switch (schedule.sleepStatus) {
    case "sleeping_now":
      return "Sleeping now";
    case "slept":
      return "Slept";
    case "likely_missed":
      return "Sleep likely missed";
    case "unknown":
      return humanize(schedule.circadianState) || "Unknown";
  }
}

function buildHeadline(args: {
  schedule: LifeOpsScheduleInsight | null | undefined;
  nextEvent: LifeOpsCalendarEvent | null;
  hasOverdue: boolean;
  hasUnread: boolean;
  hasAnyOverviewAccess: boolean;
}) {
  const { schedule, nextEvent, hasOverdue, hasUnread, hasAnyOverviewAccess } =
    args;
  if (!hasAnyOverviewAccess) {
    return "LifeOps is waiting on access.";
  }
  if (schedule?.sleepStatus === "sleeping_now") {
    return "Sleep is the main event.";
  }
  if (hasOverdue) {
    return "A reminder needs a decision.";
  }
  if (nextEvent) {
    return `${nextEvent.title} at ${formatClockTime(nextEvent.startAt)}.`;
  }
  if (hasUnread) {
    return "Messages need attention.";
  }
  return "The day is open.";
}

function DashboardPanel({
  title,
  icon,
  action,
  className = "",
  children,
}: {
  title: string;
  icon: ReactNode;
  action?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  return (
    <section
      aria-label={title}
      className={`min-w-0 overflow-hidden rounded-lg border border-border/16 bg-card/12 ${className}`}
    >
      <div className="flex items-center justify-between gap-3 border-b border-border/12 px-3 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <h2
            className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-bg/30 text-muted"
            title={title}
          >
            <span className="sr-only">{title}</span>
            {icon}
          </h2>
        </div>
        {action}
      </div>
      <div className="p-4">{children}</div>
    </section>
  );
}

function IconAction({
  label,
  icon,
  onClick,
}: {
  label: string;
  icon: ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted transition-colors hover:bg-bg/40 hover:text-txt"
      onClick={onClick}
    >
      {icon}
    </button>
  );
}

function MetricCell({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: string;
}) {
  return (
    <div className="min-w-0 border-t border-border/12 px-3 py-2 first:border-t-0 sm:border-l sm:border-t-0 sm:first:border-l-0">
      <div className="truncate text-[10px] font-semibold uppercase tracking-wide text-muted">
        {label}
      </div>
      <div
        className={`mt-1 truncate text-lg font-semibold tabular-nums ${tone ?? "text-txt"}`}
      >
        {value}
      </div>
    </div>
  );
}

function EmptyState({ children }: { children: ReactNode }) {
  return <div className="py-6 text-center text-xs text-muted">{children}</div>;
}

function formatLabelList(labels: string[]): string {
  if (labels.length === 0) {
    return "";
  }
  if (labels.length === 1) {
    return labels[0];
  }
  if (labels.length === 2) {
    return `${labels[0]} and ${labels[1]}`;
  }
  return `${labels.slice(0, -1).join(", ")}, and ${labels.at(-1)}`;
}

function sortPriorityMessages(
  messages: LifeOpsInboxMessage[],
): LifeOpsInboxMessage[] {
  return [...messages].sort((left, right) => {
    const leftPriority =
      typeof left.priorityScore === "number" ? left.priorityScore : 0;
    const rightPriority =
      typeof right.priorityScore === "number" ? right.priorityScore : 0;
    if (leftPriority !== rightPriority) {
      return rightPriority - leftPriority;
    }
    if (left.unread !== right.unread) {
      return left.unread ? -1 : 1;
    }
    return right.receivedAt.localeCompare(left.receivedAt);
  });
}

function hasCapabilityAccess(
  status: LifeOpsCapabilitiesStatus | null,
  capabilityId: string,
): boolean {
  const capability = findCapability(status, capabilityId);
  return capability?.state === "working" || capability?.state === "degraded";
}

function findCapability(
  status: LifeOpsCapabilitiesStatus | null,
  capabilityId: string,
) {
  return status?.capabilities.find((item) => item.id === capabilityId);
}

function hasGoogleCapability(
  status: LifeOpsGoogleConnectorStatus | null,
  capabilities: readonly LifeOpsGoogleCapability[],
): boolean {
  if (status?.connected !== true) {
    return false;
  }
  const granted = new Set(status.grantedCapabilities);
  return capabilities.some((capability) => granted.has(capability));
}

function hasXMessageAccess(status: LifeOpsXConnectorStatus | null): boolean {
  return status?.connected === true && (status.dmRead || status.dmInbound);
}

function TinyStatus({ color, label }: { color: string; label: string }) {
  return (
    <div className="flex min-w-0 items-start gap-2">
      <span
        className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${color}`}
        aria-hidden
      />
      <div className="min-w-0">
        <div className="text-sm font-medium leading-5 text-txt">{label}</div>
      </div>
    </div>
  );
}

function CalendarEventRow({
  event,
  onClick,
}: {
  event: LifeOpsCalendarEvent;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full min-w-0 items-start gap-3 py-2 text-left transition-colors hover:text-accent"
    >
      <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-blue-400" />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium text-txt">
          {event.title}
        </span>
      </span>
      <span className="shrink-0 text-[11px] font-medium text-blue-300">
        {event.isAllDay ? "All day" : formatClockTime(event.startAt)}
      </span>
    </button>
  );
}

function ReminderAgendaRow({
  reminder,
  onClick,
}: {
  reminder: LifeOpsActiveReminderView;
  onClick: () => void;
}) {
  const urgency = classifyReminder(reminder.scheduledFor);
  const style = URGENCY_STYLES[urgency];
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full min-w-0 items-start gap-3 py-2 text-left transition-colors hover:text-accent"
    >
      <span
        className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${style.dot}`}
      />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium text-txt">
          {reminder.title}
        </span>
      </span>
      <span className={`shrink-0 text-[11px] font-medium ${style.text}`}>
        {formatRelative(reminder.scheduledFor)}
      </span>
    </button>
  );
}

function InboxMessageRow({
  message,
  onClick,
}: {
  message: LifeOpsInboxMessage;
  onClick: () => void;
}) {
  const style = CHANNEL_STYLES[message.channel];
  const subject = message.subject?.trim() || `${style.label} message`;
  const rowTitle =
    subject === `${style.label} message`
      ? message.sender.displayName
      : `${message.sender.displayName} - ${subject}`;
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full min-w-0 items-start gap-3 py-2 text-left transition-colors hover:text-accent"
    >
      <span
        className={`mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full ${style.bg} ${style.text}`}
      >
        {style.icon}
      </span>
      <span className="min-w-0 flex-1">
        <span
          className={`block truncate text-sm ${
            message.unread
              ? "font-semibold text-txt"
              : "font-medium text-txt/80"
          }`}
        >
          {rowTitle}
        </span>
      </span>
      <span className="shrink-0 text-[11px] font-medium text-muted">
        {formatRelative(message.receivedAt)}
      </span>
    </button>
  );
}

function TimelineRow({
  entry,
  onOpenEvent,
  onOpenReminder,
}: {
  entry: TimelineEntry;
  onOpenEvent: (event: LifeOpsCalendarEvent) => void;
  onOpenReminder: (reminder: LifeOpsActiveReminderView) => void;
}) {
  if (entry.kind === "event") {
    return (
      <CalendarEventRow
        event={entry.event}
        onClick={() => onOpenEvent(entry.event)}
      />
    );
  }
  return (
    <ReminderAgendaRow
      reminder={entry.reminder}
      onClick={() => onOpenReminder(entry.reminder)}
    />
  );
}

function ScreenTimeList({
  screenTime,
  loading,
  error,
}: {
  screenTime: LifeOpsScreenTimeSummary | null;
  loading: boolean;
  error: string | null;
}) {
  if (loading && !screenTime) {
    return (
      <div className="flex items-center gap-2 py-5 text-xs text-muted">
        <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
        Reading screen time...
      </div>
    );
  }
  if (error) {
    return <div className="py-4 text-xs text-rose-300">{error}</div>;
  }
  const items = screenTime?.items ?? [];
  if (items.length === 0) {
    return <EmptyState>No screen-time sessions yet.</EmptyState>;
  }
  return (
    <div className="space-y-2">
      {items.slice(0, 5).map((item) => (
        <div
          key={`${item.source}:${item.identifier}`}
          className="flex min-w-0 items-baseline justify-between gap-3 border-t border-border/10 pt-2 first:border-t-0 first:pt-0"
        >
          <div className="min-w-0">
            <div className="truncate text-sm font-medium text-txt">
              {item.displayName}
            </div>
          </div>
          <div className="shrink-0 text-sm font-semibold tabular-nums text-txt">
            {formatDurationSeconds(item.totalSeconds)}
          </div>
        </div>
      ))}
    </div>
  );
}

export function LifeOpsOverviewSection({
  onNavigate,
}: LifeOpsOverviewSectionProps) {
  const { t } = useApp();
  const { select } = useLifeOpsSelection();
  const today = useMemo(() => new Date(), []);
  const greeting = useGreeting();
  const capabilities = useLifeOpsCapabilitiesStatus();
  const googleConnector = useGoogleLifeOpsConnector({
    includeAccounts: false,
    pollWhileDisconnected: false,
    side: "owner",
  });
  const xConnector = useLifeOpsXConnector("owner");

  const [overview, setOverview] = useState<LifeOpsOverview | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [screenTime, setScreenTime] = useState<LifeOpsScreenTimeSummary | null>(
    null,
  );
  const [screenTimeLoading, setScreenTimeLoading] = useState(false);
  const [screenTimeError, setScreenTimeError] = useState<string | null>(null);
  const [social, setSocial] = useState<LifeOpsSocialHabitSummary | null>(null);
  const [socialLoading, setSocialLoading] = useState(false);
  const [socialError, setSocialError] = useState<string | null>(null);
  const [weeklyScreenTotalSeconds, setWeeklyScreenTotalSeconds] = useState<
    number | null
  >(null);
  const [weeklyScreenTimeError, setWeeklyScreenTimeError] = useState<
    string | null
  >(null);

  const loadOverview = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setOverview(await client.getLifeOpsOverview());
    } catch (cause) {
      setError(
        cause instanceof Error && cause.message.trim().length > 0
          ? cause.message.trim()
          : t("lifeopsoverviewsection.loadFailed", {
              defaultValue: "Failed to load overview.",
            }),
      );
    } finally {
      setLoading(false);
    }
  }, [t]);

  const loadScreenTime = useCallback(async () => {
    setScreenTimeLoading(true);
    setScreenTimeError(null);
    try {
      setScreenTime(
        await client.getLifeOpsScreenTimeSummary({
          since: startOfLocalDayIso(),
          until: new Date().toISOString(),
          topN: 5,
        }),
      );
    } catch (cause) {
      setScreenTimeError(
        cause instanceof Error && cause.message.trim().length > 0
          ? cause.message.trim()
          : "Screen time failed to load.",
      );
    } finally {
      setScreenTimeLoading(false);
    }
  }, []);

  const loadSocial = useCallback(async () => {
    setSocialLoading(true);
    setSocialError(null);
    try {
      setSocial(
        await client.getLifeOpsSocialHabitSummary({
          since: startOfLocalDayIso(),
          until: new Date().toISOString(),
          topN: 5,
        }),
      );
    } catch (cause) {
      setSocialError(
        cause instanceof Error && cause.message.trim().length > 0
          ? cause.message.trim()
          : "Social habits failed to load.",
      );
    } finally {
      setSocialLoading(false);
    }
  }, []);

  const loadWeeklyScreenTime = useCallback(async () => {
    setWeeklyScreenTimeError(null);
    const now = new Date();
    const since = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    try {
      const breakdown = await client.getLifeOpsScreenTimeBreakdown({
        since: since.toISOString(),
        until: now.toISOString(),
        topN: 1,
      });
      setWeeklyScreenTotalSeconds(
        Number.isFinite(breakdown.totalSeconds) ? breakdown.totalSeconds : null,
      );
    } catch (cause) {
      setWeeklyScreenTotalSeconds(null);
      setWeeklyScreenTimeError(
        cause instanceof Error && cause.message.trim().length > 0
          ? cause.message.trim()
          : "Weekly screen-time comparison failed to load.",
      );
    }
  }, []);

  useEffect(() => {
    void loadOverview();
    void loadScreenTime();
    void loadSocial();
    void loadWeeklyScreenTime();
  }, [loadOverview, loadScreenTime, loadSocial, loadWeeklyScreenTime]);

  const calendar = useCalendarWeek({ viewMode: "week" });
  const messagesInbox = useInbox({
    maxResults: 40,
    channels: LIFEOPS_MESSAGE_CHANNELS,
    groupByThread: true,
    chatTypeFilter: ["dm"],
    sortByPriority: true,
  });
  const mailInbox = useInbox({
    maxResults: 40,
    channel: "gmail",
    channels: LIFEOPS_MAIL_CHANNELS,
    groupByThread: true,
    chatTypeFilter: ["dm"],
    sortByPriority: true,
  });

  const upcomingEvents = useMemo(() => {
    const now = Date.now();
    return [...calendar.events]
      .filter((event) => {
        const end = Date.parse(event.endAt);
        return Number.isFinite(end) && end >= now;
      })
      .sort((a, b) => a.startAt.localeCompare(b.startAt))
      .slice(0, 6);
  }, [calendar.events]);

  const summary = overview?.summary;
  const schedule = overview?.schedule ?? null;
  const reminders = overview?.reminders ?? [];
  const activeReminders = reminders.slice(0, 6);
  const priorityMessages = useMemo(
    () => sortPriorityMessages(messagesInbox.messages),
    [messagesInbox.messages],
  );
  const priorityMail = useMemo(
    () => sortPriorityMessages(mailInbox.messages),
    [mailInbox.messages],
  );
  const unreadMessages = [...priorityMessages, ...priorityMail].filter(
    (message) => message.unread,
  );
  const hasUnread = unreadMessages.length > 0;
  const hasOverdue = (summary?.overdueOccurrenceCount ?? 0) > 0;
  const nextEvent = upcomingEvents[0] ?? null;
  const screenTimeLabel = formatDurationSeconds(screenTime?.totalSeconds);
  const socialLabel = formatDurationSeconds(social?.totalSeconds);
  const topSocial = social?.services[0] ?? null;
  const lastSleep = formatDurationMinutes(schedule?.lastSleepDurationMinutes);
  const bedtime = formatClockTime(schedule?.relativeTime.bedtimeTargetAt);
  const sleepAccess =
    Boolean(schedule) ||
    hasCapabilityAccess(capabilities.status, "sleep.relative_time");
  const browserActivityReady =
    findCapability(capabilities.status, "activity.browser")?.state ===
    "working";
  const screenTimeAccess =
    (!screenTimeError && browserActivityReady) || Boolean(screenTime);
  const socialAccess =
    (!socialError && browserActivityReady) || Boolean(social);
  const calendarAccess =
    hasGoogleCapability(googleConnector.status, [
      "google.calendar.read",
      "google.calendar.write",
    ]) || upcomingEvents.length > 0;
  const mailAccess =
    hasGoogleCapability(googleConnector.status, [
      "google.gmail.triage",
      "google.gmail.send",
    ]) || priorityMail.length > 0;
  const messagesAccess =
    hasXMessageAccess(xConnector.status) || priorityMessages.length > 0;
  const remindersAccess =
    hasCapabilityAccess(capabilities.status, "reminders.scheduler") ||
    activeReminders.length > 0 ||
    hasOverdue;
  const hasAnySignalWidget =
    sleepAccess ||
    screenTimeAccess ||
    socialAccess ||
    calendarAccess ||
    messagesAccess ||
    mailAccess;
  const hasAnyOverviewAccess = hasAnySignalWidget || remindersAccess;
  const setupSignalsLoading =
    capabilities.loading || googleConnector.loading || xConnector.loading;
  const missingWidgets = useMemo(
    () =>
      [
        !sleepAccess ? "Sleep" : null,
        !screenTimeAccess ? "Screen Time" : null,
        !socialAccess ? "Social" : null,
        !messagesAccess ? "Messages" : null,
        !mailAccess ? "Mail" : null,
        !calendarAccess ? "Calendar" : null,
      ].filter((value): value is string => Boolean(value)),
    [
      calendarAccess,
      mailAccess,
      messagesAccess,
      screenTimeAccess,
      sleepAccess,
      socialAccess,
    ],
  );
  const showSetupWarning = !setupSignalsLoading && missingWidgets.length > 0;
  const showNoAccessState =
    !setupSignalsLoading &&
    !loading &&
    !screenTimeLoading &&
    !socialLoading &&
    !calendar.loading &&
    !messagesInbox.loading &&
    !mailInbox.loading &&
    !hasAnyOverviewAccess;
  const reminderMetricValue = activeReminders[0]
    ? formatRelative(activeReminders[0].scheduledFor)
    : hasOverdue
      ? `${summary?.overdueOccurrenceCount ?? 0} overdue`
      : (summary?.activeOccurrenceCount ?? 0) > 0
        ? `${summary?.activeOccurrenceCount ?? 0} active`
        : "Clear";
  const reminderMetricTone = hasOverdue
    ? "text-rose-300"
    : (summary?.activeOccurrenceCount ?? 0) > 0
      ? "text-amber-300"
      : "text-muted";

  const timeline = useMemo<TimelineEntry[]>(() => {
    return [
      ...upcomingEvents.map((event) => ({
        id: `event:${event.id}`,
        kind: "event" as const,
        sortAt: Date.parse(event.startAt),
        event,
      })),
      ...activeReminders.map((reminder) => ({
        id: `reminder:${reminder.ownerId}:${reminder.stepIndex}`,
        kind: "reminder" as const,
        sortAt: Date.parse(reminder.scheduledFor),
        reminder,
      })),
    ]
      .filter((entry) => Number.isFinite(entry.sortAt))
      .sort((left, right) => left.sortAt - right.sortAt)
      .slice(0, 7);
  }, [activeReminders, upcomingEvents]);

  const activeChannels = useMemo(() => {
    return CHANNEL_ORDER.filter((channel) =>
      priorityMessages.some((message) => message.channel === channel),
    );
  }, [priorityMessages]);

  const briefingLines = useMemo(() => {
    const lines: string[] = [];
    if (hasUnread) {
      lines.push("Messages need triage");
    }
    if (schedule?.nextMealLabel && schedule.nextMealWindowStartAt) {
      lines.push(
        `${humanize(schedule.nextMealLabel)} window starts ${formatClockTime(
          schedule.nextMealWindowStartAt,
        )}`,
      );
    }
    return lines.slice(0, 5);
  }, [hasUnread, schedule]);

  const circadianLine = useMemo(() => circadianHeadline(schedule), [schedule]);
  const activeSession = useMemo(
    () => topActiveSession(screenTime),
    [screenTime],
  );
  const activeSessionLine = useMemo(() => {
    if (!activeSession) return null;
    const duration = formatDurationSeconds(activeSession.totalSeconds);
    if (!duration) return null;
    return `Current focus: ${activeSession.displayName} (${duration})`;
  }, [activeSession]);
  const hasNowPanelContent =
    Boolean(circadianLine) ||
    Boolean(activeSessionLine) ||
    briefingLines.length > 0;
  const weeklyDelta = useMemo(
    () =>
      computeWeeklyDelta({
        todayTotalSeconds: screenTime?.totalSeconds ?? null,
        weeklyTotalSeconds: weeklyScreenTotalSeconds,
      }),
    [screenTime?.totalSeconds, weeklyScreenTotalSeconds],
  );

  const refresh = useCallback(() => {
    void loadOverview();
    void loadScreenTime();
    void loadSocial();
    void loadWeeklyScreenTime();
    void capabilities.refresh();
    void googleConnector.refresh({ silent: true });
    void xConnector.refresh();
    void calendar.refresh();
    void messagesInbox.refresh();
    void mailInbox.refresh();
  }, [
    calendar.refresh,
    capabilities,
    googleConnector,
    loadSocial,
    loadOverview,
    loadScreenTime,
    loadWeeklyScreenTime,
    mailInbox.refresh,
    messagesInbox.refresh,
    xConnector,
  ]);

  const openEvent = useCallback(
    (event: LifeOpsCalendarEvent) => {
      select({ eventId: event.id });
      onNavigate("calendar");
    },
    [onNavigate, select],
  );

  const openReminder = useCallback(
    (reminder: LifeOpsActiveReminderView) => {
      select({
        reminderId: reminder.ownerId,
        eventId: reminder.eventId ?? null,
      });
      onNavigate("reminders");
    },
    [onNavigate, select],
  );

  return (
    <div className="space-y-4" data-testid="lifeops-overview">
      <header className="border-b border-border/20 pb-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="text-[11px] font-semibold uppercase tracking-wide text-muted">
              {greeting} / {formatFullDate(today)}
            </div>
            <h1 className="mt-2 max-w-4xl text-2xl font-semibold leading-tight text-txt sm:text-3xl">
              {buildHeadline({
                schedule,
                nextEvent,
                hasOverdue,
                hasUnread,
                hasAnyOverviewAccess,
              })}
            </h1>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <BrowserBridgeStatusChip onNavigate={onNavigate} />
            <button
              type="button"
              aria-label="Refresh LifeOps dashboard"
              title="Refresh"
              className="inline-flex h-9 w-9 items-center justify-center rounded-lg border border-border/20 bg-bg/30 text-muted transition-colors hover:border-accent/30 hover:text-txt disabled:opacity-40"
              onClick={refresh}
              disabled={
                loading ||
                screenTimeLoading ||
                calendar.loading ||
                messagesInbox.loading ||
                mailInbox.loading
              }
            >
              <RefreshCw
                className={`h-3.5 w-3.5 ${
                  loading || screenTimeLoading ? "animate-spin" : ""
                }`}
                aria-hidden
              />
            </button>
          </div>
        </div>

        <div className="mt-4 grid overflow-hidden rounded-lg border border-border/16 bg-card/10 sm:grid-cols-3">
          <MetricCell
            label="Sleep"
            value={sleepStatusLabel(schedule)}
            tone={
              schedule?.sleepStatus === "sleeping_now"
                ? "text-blue-300"
                : "text-txt"
            }
          />
          <MetricCell
            label="Reminders"
            value={reminderMetricValue}
            tone={reminderMetricTone}
          />
          <MetricCell
            label="Screen"
            value={screenTimeLabel || "No data"}
            tone={screenTimeLabel ? "text-amber-300" : "text-muted"}
          />
        </div>
      </header>

      {error ? (
        <div
          className="flex items-center gap-2 rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs font-medium text-rose-300"
          title={error}
        >
          <TriangleAlert className="h-3.5 w-3.5 shrink-0" aria-hidden />
          Activity unavailable
        </div>
      ) : null}

      {showSetupWarning ? (
        <div
          className="flex flex-wrap items-start justify-between gap-3 rounded-lg border border-amber-500/25 bg-amber-500/10 px-4 py-3"
          data-testid="lifeops-overview-setup-warning"
        >
          <div className="flex min-w-0 items-center gap-3">
            <span className="mt-0.5 shrink-0 text-amber-300">
              <TriangleAlert className="h-4 w-4" aria-hidden />
            </span>
            <div className="min-w-0">
              <div className="truncate text-sm font-medium text-txt">
                {hasAnyOverviewAccess ? "Partial overview" : "Connect a source"}
              </div>
              <div className="mt-1 text-xs leading-5 text-muted">
                Missing: {formatLabelList(missingWidgets)}
              </div>
            </div>
          </div>
          <button
            type="button"
            aria-label="Open LifeOps settings"
            title="Open setup"
            className="inline-flex h-8 shrink-0 items-center gap-1 rounded-md border border-border/16 bg-bg/50 px-3 text-xs font-medium text-txt transition-colors hover:border-accent/30 hover:text-accent"
            onClick={() => onNavigate("setup")}
          >
            Open setup
            <ArrowRight className="h-3.5 w-3.5" aria-hidden />
          </button>
        </div>
      ) : null}

      {loading && !overview ? (
        <div className="flex items-center gap-2 py-4 text-xs text-muted">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
          Loading dashboard...
        </div>
      ) : null}

      {showNoAccessState ? (
        <div
          className="rounded-lg border border-border/16 bg-card/12 px-5 py-8 text-center"
          data-testid="lifeops-overview-empty-access"
        >
          <div className="mx-auto flex h-10 w-10 items-center justify-center rounded-full bg-amber-500/12 text-amber-300">
            <TriangleAlert className="h-5 w-5" aria-hidden />
          </div>
          <h2 className="mt-4 text-base font-semibold text-txt">
            Connect a source
          </h2>
          <button
            type="button"
            className="mt-4 inline-flex h-9 items-center gap-1 rounded-md border border-border/16 bg-bg/50 px-3 text-sm font-medium text-txt transition-colors hover:border-accent/30 hover:text-accent"
            onClick={() => onNavigate("setup")}
          >
            Open Settings
            <ArrowRight className="h-4 w-4" aria-hidden />
          </button>
        </div>
      ) : null}

      {!showNoAccessState ? (
        <div className="grid items-start gap-4 xl:grid-cols-12">
          {hasNowPanelContent ? (
            <DashboardPanel
              title="Now"
              icon={<Flame className="h-4 w-4" aria-hidden />}
              className="xl:col-span-3"
            >
              <div className="space-y-3">
                {circadianLine ? (
                  <TinyStatus color="bg-indigo-300" label={circadianLine} />
                ) : null}
                {activeSessionLine ? (
                  <TinyStatus color="bg-amber-300" label={activeSessionLine} />
                ) : null}
                {briefingLines.map((line) => (
                  <TinyStatus key={line} color="bg-accent" label={line} />
                ))}
              </div>
            </DashboardPanel>
          ) : null}

          {sleepAccess ? (
            <DashboardPanel
              title="Sleep"
              icon={
                schedule?.sleepStatus === "sleeping_now" ? (
                  <Moon className="h-4 w-4" aria-hidden />
                ) : (
                  <Sun className="h-4 w-4" aria-hidden />
                )
              }
              action={
                <IconAction
                  label="Sleep"
                  icon={<Moon className="h-3.5 w-3.5" aria-hidden />}
                  onClick={() => onNavigate("sleep")}
                />
              }
              className="xl:col-span-3"
            >
              <div className="space-y-3">
                <div>
                  <div className="text-2xl font-semibold leading-none text-txt">
                    {sleepStatusLabel(schedule)}
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-3 border-t border-border/12 pt-3">
                  <TinyStatus
                    color="bg-blue-400"
                    label={lastSleep ? `Last sleep ${lastSleep}` : "No sleep"}
                  />
                  <TinyStatus
                    color="bg-indigo-400"
                    label={bedtime ? `Bed ${bedtime}` : "No target"}
                  />
                </div>
              </div>
            </DashboardPanel>
          ) : (
            <MissingSourceCard
              title="Sleep"
              ctaLabel="Connect Health"
              onCta={() => onNavigate("setup")}
              className="xl:col-span-3"
            />
          )}

          {screenTimeAccess ? (
            <DashboardPanel
              title="Screen Time"
              icon={<Monitor className="h-4 w-4" aria-hidden />}
              action={
                <IconAction
                  label="Screen Time"
                  icon={<Monitor className="h-3.5 w-3.5" aria-hidden />}
                  onClick={() => onNavigate("screen-time")}
                />
              }
              className="xl:col-span-3"
            >
              <div className="mb-3 flex items-end justify-between gap-3">
                <div>
                  <div className="text-2xl font-semibold leading-none text-txt">
                    {screenTimeLabel || "No data"}
                  </div>
                  {weeklyDelta ? (
                    <div
                      className="mt-1 text-[11px] font-medium tabular-nums text-muted"
                      data-testid="lifeops-overview-screen-weekly-delta"
                    >
                      {weeklyDelta.label}
                    </div>
                  ) : null}
                  {weeklyScreenTimeError ? (
                    <div
                      className="mt-1 text-[11px] font-medium text-rose-300"
                      data-testid="lifeops-overview-screen-weekly-error"
                    >
                      Weekly comparison unavailable: {weeklyScreenTimeError}
                    </div>
                  ) : null}
                </div>
              </div>
              <ScreenTimeList
                screenTime={screenTime}
                loading={screenTimeLoading}
                error={screenTimeError}
              />
            </DashboardPanel>
          ) : (
            <MissingSourceCard
              title="Screen Time"
              ctaLabel="Set up tracking"
              onCta={() => onNavigate("setup")}
              className="xl:col-span-3"
            />
          )}

          {socialAccess ? (
            <DashboardPanel
              title="Social"
              icon={<Share2 className="h-4 w-4" aria-hidden />}
              action={
                <IconAction
                  label="Social"
                  icon={<Share2 className="h-3.5 w-3.5" aria-hidden />}
                  onClick={() => onNavigate("screen-time")}
                />
              }
              className="xl:col-span-3"
            >
              <div className="mb-3 text-2xl font-semibold leading-none text-txt">
                {socialLabel || "No data"}
              </div>
              {socialLoading && !social ? (
                <div className="flex items-center gap-2 py-5 text-xs text-muted">
                  <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                  Reading social...
                </div>
              ) : socialError ? (
                <div className="py-4 text-xs text-rose-300">{socialError}</div>
              ) : (
                <div className="space-y-3">
                  <TinyStatus
                    color="bg-cyan-300"
                    label={
                      topSocial
                        ? `${topSocial.label} ${formatDurationSeconds(
                            topSocial.totalSeconds,
                          )}`
                        : "No social time"
                    }
                  />
                  <TinyStatus
                    color="bg-emerald-300"
                    label={`${social?.messages.opened ?? 0} opened / ${
                      social?.messages.outbound ?? 0
                    } sent`}
                  />
                  {(social?.dataSources ?? []).length > 0 ? (
                    <DataSourcesStrip
                      sources={social?.dataSources ?? []}
                      onSetup={() => onNavigate("setup")}
                    />
                  ) : null}
                </div>
              )}
            </DashboardPanel>
          ) : (
            <MissingSourceCard
              title="Social"
              ctaLabel="Set up bridge"
              onCta={() => onNavigate("setup")}
              className="xl:col-span-3"
            />
          )}

          {calendarAccess ? (
            <DashboardPanel
              title="Upcoming"
              icon={<CalendarDays className="h-4 w-4" aria-hidden />}
              action={
                <IconAction
                  label="Calendar"
                  icon={<CalendarDays className="h-3.5 w-3.5" aria-hidden />}
                  onClick={() => onNavigate("calendar")}
                />
              }
              className="xl:col-span-4"
            >
              {calendar.loading && timeline.length === 0 ? (
                <div className="flex items-center gap-2 py-5 text-xs text-muted">
                  <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                  Reading calendar...
                </div>
              ) : timeline.length === 0 ? (
                <EmptyState>Nothing scheduled.</EmptyState>
              ) : (
                <div className="divide-y divide-border/10">
                  {timeline.map((entry) => (
                    <TimelineRow
                      key={entry.id}
                      entry={entry}
                      onOpenEvent={openEvent}
                      onOpenReminder={openReminder}
                    />
                  ))}
                </div>
              )}
            </DashboardPanel>
          ) : (
            <MissingSourceCard
              title="Calendar"
              ctaLabel="Connect Google"
              onCta={() => onNavigate("setup")}
              className="xl:col-span-4"
            />
          )}

          {messagesAccess ? (
            <DashboardPanel
              title="Priority Messages"
              icon={<MessageSquare className="h-4 w-4" aria-hidden />}
              action={
                <IconAction
                  label="Messages"
                  icon={<MessageSquare className="h-3.5 w-3.5" aria-hidden />}
                  onClick={() => onNavigate("messages")}
                />
              }
              className="xl:col-span-4"
            >
              <div className="mb-3 flex flex-wrap gap-2">
                {activeChannels.length === 0 ? (
                  <span className="text-xs text-muted">No live messages.</span>
                ) : (
                  activeChannels.slice(0, 5).map((channel) => {
                    const style = CHANNEL_STYLES[channel];
                    return (
                      <span
                        key={channel}
                        role="img"
                        aria-label={style.label}
                        title={style.label}
                        className={`inline-flex h-7 w-7 items-center justify-center rounded-full ${style.bg} ${style.text}`}
                      >
                        {style.icon}
                      </span>
                    );
                  })
                )}
              </div>
              {messagesInbox.loading && priorityMessages.length === 0 ? (
                <div className="flex items-center gap-2 py-5 text-xs text-muted">
                  <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                  Reading messages...
                </div>
              ) : priorityMessages.length === 0 ? (
                <EmptyState>No priority messages.</EmptyState>
              ) : (
                <div className="divide-y divide-border/10">
                  {priorityMessages.slice(0, 5).map((message) => (
                    <InboxMessageRow
                      key={message.id}
                      message={message}
                      onClick={() => {
                        select({ messageId: message.id });
                        onNavigate("messages");
                      }}
                    />
                  ))}
                </div>
              )}
            </DashboardPanel>
          ) : (
            <MissingSourceCard
              title="Messages"
              ctaLabel="Connect platform"
              onCta={() => onNavigate("setup")}
              className="xl:col-span-4"
            />
          )}

          {mailAccess ? (
            <DashboardPanel
              title="Priority Mail"
              icon={<Mail className="h-4 w-4" aria-hidden />}
              action={
                <IconAction
                  label="Mail"
                  icon={<Mail className="h-3.5 w-3.5" aria-hidden />}
                  onClick={() => onNavigate("mail")}
                />
              }
              className="xl:col-span-4"
            >
              {mailInbox.loading && priorityMail.length === 0 ? (
                <div className="flex items-center gap-2 py-5 text-xs text-muted">
                  <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                  Reading mail...
                </div>
              ) : priorityMail.length === 0 ? (
                <EmptyState>No priority mail.</EmptyState>
              ) : (
                <div className="divide-y divide-border/10">
                  {priorityMail.slice(0, 5).map((message) => (
                    <InboxMessageRow
                      key={message.id}
                      message={message}
                      onClick={() => {
                        select({ messageId: message.id });
                        onNavigate("mail");
                      }}
                    />
                  ))}
                </div>
              )}
            </DashboardPanel>
          ) : (
            <MissingSourceCard
              title="Mail"
              ctaLabel="Connect Google"
              onCta={() => onNavigate("setup")}
              className="xl:col-span-4"
            />
          )}

          {remindersAccess ? (
            <DashboardPanel
              title="Reminders"
              icon={<Target className="h-4 w-4" aria-hidden />}
              action={
                <IconAction
                  label="Reminders"
                  icon={<Target className="h-3.5 w-3.5" aria-hidden />}
                  onClick={() => onNavigate("reminders")}
                />
              }
              className="xl:col-span-4"
            >
              <div className="divide-y divide-border/10">
                {activeReminders.length === 0 ? (
                  <EmptyState>No active reminders.</EmptyState>
                ) : (
                  activeReminders
                    .slice(0, 4)
                    .map((reminder) => (
                      <ReminderAgendaRow
                        key={`${reminder.ownerId}:${reminder.stepIndex}`}
                        reminder={reminder}
                        onClick={() => openReminder(reminder)}
                      />
                    ))
                )}
              </div>
            </DashboardPanel>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
