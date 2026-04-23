import { client, useApp } from "@elizaos/app-core";
import type {
  LifeOpsActiveReminderView,
  LifeOpsCalendarEvent,
  LifeOpsCapabilityStatus,
  LifeOpsInboxChannel,
  LifeOpsOverview,
  LifeOpsScheduleInsight,
  LifeOpsUnifiedMessage,
} from "@elizaos/shared/contracts/lifeops";
import {
  Activity,
  AtSign,
  CalendarDays,
  Clock3,
  Flame,
  Loader2,
  MessageCircle,
  MessageSquare,
  Monitor,
  Moon,
  Phone,
  RefreshCw,
  Send,
  Shield,
  Smartphone,
  Sun,
  Target,
} from "lucide-react";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import type { LifeOpsScreenTimeSummary } from "../api/client-lifeops.js";
import { useCalendarWeek } from "../hooks/useCalendarWeek.js";
import { useLifeOpsCapabilitiesStatus } from "../hooks/useLifeOpsCapabilitiesStatus.js";
import type { LifeOpsSection } from "../hooks/useLifeOpsSection.js";
import { useUnifiedInbox } from "../hooks/useUnifiedInbox.js";
import { useLifeOpsSelection } from "./LifeOpsSelectionContext.js";
import { LifeOpsSetupGate, useLifeOpsSetupGate } from "./LifeOpsSetupGate.js";

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

function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return "";
  const parsed = Date.parse(iso);
  if (!Number.isFinite(parsed)) return "";
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
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

function formatPercent(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return "";
  }
  return new Intl.NumberFormat(undefined, {
    style: "percent",
    maximumFractionDigits: 0,
  }).format(value);
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

function isToday(iso: string): boolean {
  const parsed = new Date(iso);
  if (!Number.isFinite(parsed.getTime())) return false;
  const today = new Date();
  return (
    parsed.getFullYear() === today.getFullYear() &&
    parsed.getMonth() === today.getMonth() &&
    parsed.getDate() === today.getDate()
  );
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

function plural(count: number, singular: string, pluralLabel = `${singular}s`) {
  return `${count} ${count === 1 ? singular : pluralLabel}`;
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
  overdueCount: number;
  unreadCount: number;
}) {
  const { schedule, nextEvent, overdueCount, unreadCount } = args;
  if (schedule?.sleepStatus === "sleeping_now") {
    return "Sleep is the main event.";
  }
  if (overdueCount > 0) {
    return `${plural(overdueCount, "overdue item")} needs a decision.`;
  }
  if (nextEvent) {
    return `${nextEvent.title} at ${formatClockTime(nextEvent.startAt)}.`;
  }
  if (unreadCount > 0) {
    return `${plural(unreadCount, "unread message")} waiting.`;
  }
  return "The day is open.";
}

function buildSubheadline(args: {
  schedule: LifeOpsScheduleInsight | null | undefined;
  screenTime: LifeOpsScreenTimeSummary | null;
  todayEvents: number;
  reminders: number;
}) {
  const { schedule, screenTime, todayEvents, reminders } = args;
  const parts: string[] = [];
  if (schedule) {
    const confidence = formatPercent(schedule.stateConfidence);
    parts.push(
      `${humanize(schedule.circadianState)}${confidence ? ` (${confidence})` : ""}`,
    );
  }
  const screenTimeLabel = formatDurationSeconds(screenTime?.totalSeconds);
  if (screenTimeLabel) {
    parts.push(`${screenTimeLabel} screen time`);
  }
  if (todayEvents > 0) {
    parts.push(plural(todayEvents, "event"));
  }
  if (reminders > 0) {
    parts.push(plural(reminders, "reminder"));
  }
  return parts.length > 0
    ? parts.join(" / ")
    : "LifeOps is collecting today's signals.";
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
      className={`min-w-0 overflow-hidden rounded-lg border border-border/16 bg-card/12 ${className}`}
    >
      <div className="flex items-center justify-between gap-3 border-b border-border/12 px-4 py-3">
        <div className="flex min-w-0 items-center gap-2">
          <span className="shrink-0 text-muted">{icon}</span>
          <h2 className="truncate text-xs font-semibold uppercase tracking-wide text-muted">
            {title}
          </h2>
        </div>
        {action}
      </div>
      <div className="p-4">{children}</div>
    </section>
  );
}

function PanelAction({
  label,
  onClick,
}: {
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className="text-[11px] font-medium text-muted hover:text-txt"
      onClick={onClick}
    >
      {label}
    </button>
  );
}

function MetricCell({
  label,
  value,
  detail,
  tone,
}: {
  label: string;
  value: string;
  detail?: string;
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
      {detail ? (
        <div className="mt-0.5 truncate text-[11px] text-muted">{detail}</div>
      ) : null}
    </div>
  );
}

function EmptyState({ children }: { children: ReactNode }) {
  return <div className="py-6 text-center text-xs text-muted">{children}</div>;
}

function TinyStatus({
  color,
  label,
  detail,
}: {
  color: string;
  label: string;
  detail?: string;
}) {
  return (
    <div className="flex min-w-0 items-start gap-2">
      <span
        className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${color}`}
        aria-hidden
      />
      <div className="min-w-0">
        <div className="text-sm font-medium leading-5 text-txt">{label}</div>
        {detail ? (
          <div className="mt-0.5 text-[11px] leading-4 text-muted">
            {detail}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function CalendarEventRow({
  event,
  compact = false,
  onClick,
}: {
  event: LifeOpsCalendarEvent;
  compact?: boolean;
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
        {!compact && event.location ? (
          <span className="mt-0.5 block truncate text-[11px] text-muted">
            {event.location}
          </span>
        ) : null}
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
        {reminder.stepLabel ? (
          <span className="mt-0.5 block truncate text-[11px] text-muted">
            {reminder.stepLabel}
          </span>
        ) : null}
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
  message: LifeOpsUnifiedMessage;
  onClick: () => void;
}) {
  const style = CHANNEL_STYLES[message.channel];
  const subject = message.subject?.trim() || `${style.label} message`;
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
          {message.sender.displayName}
        </span>
        <span className="mt-0.5 block truncate text-[11px] text-muted">
          {subject}
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
            <div className="text-[11px] text-muted">{item.source}</div>
          </div>
          <div className="shrink-0 text-sm font-semibold tabular-nums text-txt">
            {formatDurationSeconds(item.totalSeconds)}
          </div>
        </div>
      ))}
    </div>
  );
}

function CapabilityLine({
  capability,
}: {
  capability: LifeOpsCapabilityStatus;
}) {
  const tone =
    capability.state === "working"
      ? "bg-emerald-400"
      : capability.state === "degraded"
        ? "bg-amber-400"
        : capability.state === "blocked"
          ? "bg-rose-500"
          : "bg-zinc-400";
  return (
    <TinyStatus
      color={tone}
      label={capability.label}
      detail={capability.summary}
    />
  );
}

export function LifeOpsOverviewSection({
  onNavigate,
}: LifeOpsOverviewSectionProps) {
  const { t } = useApp();
  const { select } = useLifeOpsSelection();
  const { dismissed, dismiss } = useLifeOpsSetupGate();
  const greeting = useGreeting();
  const today = useMemo(() => new Date(), []);

  const [overview, setOverview] = useState<LifeOpsOverview | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [screenTime, setScreenTime] = useState<LifeOpsScreenTimeSummary | null>(
    null,
  );
  const [screenTimeLoading, setScreenTimeLoading] = useState(false);
  const [screenTimeError, setScreenTimeError] = useState<string | null>(null);

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

  useEffect(() => {
    void loadOverview();
    void loadScreenTime();
  }, [loadOverview, loadScreenTime]);

  const calendar = useCalendarWeek({ viewMode: "week" });
  const inbox = useUnifiedInbox({ maxResults: 12 });
  const capabilities = useLifeOpsCapabilitiesStatus();

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

  const todayEvents = useMemo(
    () => upcomingEvents.filter((event) => isToday(event.startAt)),
    [upcomingEvents],
  );

  const summary = overview?.summary;
  const schedule = overview?.schedule ?? null;
  const reminders = overview?.reminders ?? [];
  const activeReminders = reminders.slice(0, 6);
  const unreadMessages = inbox.messages.filter((message) => message.unread);
  const nextEvent = upcomingEvents[0] ?? null;
  const topScreenItem = screenTime?.items[0] ?? null;
  const screenTimeLabel = formatDurationSeconds(screenTime?.totalSeconds);
  const minutesAwake = formatDurationMinutes(
    schedule?.relativeTime.minutesAwake,
  );
  const lastSleep = formatDurationMinutes(schedule?.lastSleepDurationMinutes);
  const bedtime = formatClockTime(schedule?.relativeTime.bedtimeTargetAt);
  const lastActive = formatDateTime(schedule?.lastActiveAt);
  const firstActive = formatDateTime(schedule?.firstActiveAt);

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

  const channelBreakdown = useMemo(() => {
    return CHANNEL_ORDER.map((channel) => {
      const messages = inbox.messages.filter(
        (message) => message.channel === channel,
      );
      return {
        channel,
        total: messages.length,
        unread: messages.filter((message) => message.unread).length,
      };
    }).filter((entry) => entry.total > 0);
  }, [inbox.messages]);

  const capabilityIssues = useMemo(
    () =>
      (capabilities.status?.capabilities ?? [])
        .filter((capability) => capability.state !== "working")
        .slice(0, 4),
    [capabilities.status],
  );

  const briefingLines = useMemo(() => {
    const lines: string[] = [];
    if (nextEvent) {
      lines.push(
        `Next: ${nextEvent.title} at ${formatClockTime(nextEvent.startAt)}`,
      );
    }
    if (activeReminders[0]) {
      lines.push(
        `Reminder: ${activeReminders[0].title} ${formatRelative(
          activeReminders[0].scheduledFor,
        )}`,
      );
    }
    if (unreadMessages.length > 0) {
      lines.push(
        `${plural(unreadMessages.length, "unread message")} to triage`,
      );
    }
    if (topScreenItem) {
      lines.push(
        `${topScreenItem.displayName} leads screen time at ${formatDurationSeconds(
          topScreenItem.totalSeconds,
        )}`,
      );
    }
    if (schedule?.nextMealLabel && schedule.nextMealWindowStartAt) {
      lines.push(
        `${humanize(schedule.nextMealLabel)} window starts ${formatClockTime(
          schedule.nextMealWindowStartAt,
        )}`,
      );
    }
    return lines.slice(0, 5);
  }, [
    activeReminders,
    nextEvent,
    schedule,
    topScreenItem,
    unreadMessages.length,
  ]);

  const refresh = useCallback(() => {
    void loadOverview();
    void loadScreenTime();
    void calendar.refresh();
    void inbox.refresh();
    void capabilities.refresh();
  }, [calendar, capabilities, inbox, loadOverview, loadScreenTime]);

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

  if (!dismissed) {
    return <LifeOpsSetupGate onDismiss={dismiss} />;
  }

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
                overdueCount: summary?.overdueOccurrenceCount ?? 0,
                unreadCount: unreadMessages.length,
              })}
            </h1>
            <div className="mt-2 text-sm leading-6 text-muted">
              {buildSubheadline({
                schedule,
                screenTime,
                todayEvents: todayEvents.length,
                reminders: summary?.activeReminderCount ?? 0,
              })}
            </div>
          </div>
          <button
            type="button"
            aria-label="Refresh LifeOps dashboard"
            className="inline-flex h-9 items-center gap-2 rounded-lg border border-border/20 bg-bg/30 px-3 text-xs font-medium text-muted transition-colors hover:border-accent/30 hover:text-txt disabled:opacity-40"
            onClick={refresh}
            disabled={
              loading || screenTimeLoading || calendar.loading || inbox.loading
            }
          >
            <RefreshCw
              className={`h-3.5 w-3.5 ${
                loading || screenTimeLoading ? "animate-spin" : ""
              }`}
              aria-hidden
            />
            Refresh
          </button>
        </div>

        <div className="mt-4 grid overflow-hidden rounded-lg border border-border/16 bg-card/10 sm:grid-cols-4">
          <MetricCell
            label="Sleep"
            value={sleepStatusLabel(schedule)}
            detail={
              minutesAwake
                ? `Awake ${minutesAwake}`
                : bedtime
                  ? `Bed ${bedtime}`
                  : undefined
            }
            tone={
              schedule?.sleepStatus === "sleeping_now"
                ? "text-blue-300"
                : "text-txt"
            }
          />
          <MetricCell
            label="Work"
            value={nextEvent ? formatClockTime(nextEvent.startAt) : "Open"}
            detail={
              nextEvent?.title ?? plural(summary?.activeGoalCount ?? 0, "goal")
            }
            tone="text-blue-300"
          />
          <MetricCell
            label="Screen"
            value={screenTimeLabel || "No data"}
            detail={topScreenItem?.displayName}
            tone={screenTimeLabel ? "text-amber-300" : "text-muted"}
          />
          <MetricCell
            label="Inbox"
            value={String(unreadMessages.length)}
            detail={plural(inbox.messages.length, "message")}
            tone={unreadMessages.length > 0 ? "text-emerald-300" : "text-muted"}
          />
        </div>
      </header>

      {error ? (
        <div className="rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-300">
          {error}
        </div>
      ) : null}

      {loading && !overview ? (
        <div className="flex items-center gap-2 py-4 text-xs text-muted">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
          Loading dashboard...
        </div>
      ) : null}

      <div className="grid items-start gap-4 xl:grid-cols-12">
        <DashboardPanel
          title="Briefing"
          icon={<Flame className="h-4 w-4" aria-hidden />}
          className="xl:col-span-5"
        >
          <div className="space-y-3">
            {briefingLines.length === 0 ? (
              <EmptyState>No urgent signal.</EmptyState>
            ) : (
              briefingLines.map((line) => (
                <TinyStatus key={line} color="bg-accent" label={line} />
              ))
            )}
          </div>
        </DashboardPanel>

        <DashboardPanel
          title="Sleep"
          icon={
            schedule?.sleepStatus === "sleeping_now" ? (
              <Moon className="h-4 w-4" aria-hidden />
            ) : (
              <Sun className="h-4 w-4" aria-hidden />
            )
          }
          className="xl:col-span-3"
        >
          <div className="space-y-3">
            <div>
              <div className="text-2xl font-semibold leading-none text-txt">
                {sleepStatusLabel(schedule)}
              </div>
              <div className="mt-2 text-xs leading-5 text-muted">
                {schedule
                  ? `${humanize(schedule.circadianState)} / ${
                      formatPercent(schedule.sleepConfidence) || "calibrating"
                    } confidence`
                  : "No schedule state yet."}
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3 border-t border-border/12 pt-3">
              <TinyStatus
                color="bg-blue-400"
                label={lastSleep || "No sleep duration"}
                detail="Last sleep"
              />
              <TinyStatus
                color="bg-indigo-400"
                label={bedtime || "No target"}
                detail="Bedtime"
              />
            </div>
            {schedule?.regularity ? (
              <div className="border-t border-border/12 pt-3 text-xs leading-5 text-muted">
                {humanize(schedule.regularity.regularityClass)} / SRI{" "}
                {Math.round(schedule.regularity.sri)}
              </div>
            ) : null}
          </div>
        </DashboardPanel>

        <DashboardPanel
          title="Screen Time"
          icon={<Monitor className="h-4 w-4" aria-hidden />}
          className="xl:col-span-4"
        >
          <div className="mb-3 flex items-end justify-between gap-3">
            <div>
              <div className="text-2xl font-semibold leading-none text-txt">
                {screenTimeLabel || "No data"}
              </div>
              <div className="mt-1 text-xs text-muted">Today</div>
            </div>
            {topScreenItem ? (
              <div className="max-w-[12rem] truncate text-right text-xs text-muted">
                {topScreenItem.displayName}
              </div>
            ) : null}
          </div>
          <ScreenTimeList
            screenTime={screenTime}
            loading={screenTimeLoading}
            error={screenTimeError}
          />
        </DashboardPanel>

        <DashboardPanel
          title="Timeline"
          icon={<CalendarDays className="h-4 w-4" aria-hidden />}
          action={
            <PanelAction
              label="Calendar"
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

        <DashboardPanel
          title="Inbox"
          icon={<MessageSquare className="h-4 w-4" aria-hidden />}
          action={
            <PanelAction label="Open" onClick={() => onNavigate("messages")} />
          }
          className="xl:col-span-4"
        >
          <div className="mb-3 flex flex-wrap gap-2">
            {channelBreakdown.length === 0 ? (
              <span className="text-xs text-muted">No live messages.</span>
            ) : (
              channelBreakdown.slice(0, 5).map((entry) => {
                const style = CHANNEL_STYLES[entry.channel];
                return (
                  <span
                    key={entry.channel}
                    className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] ${style.bg} ${style.text}`}
                  >
                    {style.icon}
                    {style.label}
                    <span className="tabular-nums">
                      {entry.unread > 0 ? entry.unread : entry.total}
                    </span>
                  </span>
                );
              })
            )}
          </div>
          {inbox.loading && inbox.messages.length === 0 ? (
            <div className="flex items-center gap-2 py-5 text-xs text-muted">
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
              Reading inbox...
            </div>
          ) : inbox.messages.length === 0 ? (
            <EmptyState>Inbox clear.</EmptyState>
          ) : (
            <div className="divide-y divide-border/10">
              {inbox.messages.slice(0, 5).map((message) => (
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

        <DashboardPanel
          title="Work"
          icon={<Target className="h-4 w-4" aria-hidden />}
          action={
            <PanelAction
              label="Reminders"
              onClick={() => onNavigate("reminders")}
            />
          }
          className="xl:col-span-4"
        >
          <div className="grid grid-cols-3 gap-3 border-b border-border/12 pb-3">
            <div>
              <div className="text-xl font-semibold tabular-nums text-txt">
                {summary?.activeOccurrenceCount ?? 0}
              </div>
              <div className="text-[11px] text-muted">active</div>
            </div>
            <div>
              <div className="text-xl font-semibold tabular-nums text-rose-300">
                {summary?.overdueOccurrenceCount ?? 0}
              </div>
              <div className="text-[11px] text-muted">overdue</div>
            </div>
            <div>
              <div className="text-xl font-semibold tabular-nums text-emerald-300">
                {summary?.activeGoalCount ?? 0}
              </div>
              <div className="text-[11px] text-muted">goals</div>
            </div>
          </div>
          <div className="mt-3 divide-y divide-border/10">
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

        <DashboardPanel
          title="Activity"
          icon={<Activity className="h-4 w-4" aria-hidden />}
          className="xl:col-span-5"
        >
          <div className="grid gap-3 sm:grid-cols-2">
            <TinyStatus
              color="bg-emerald-400"
              label={lastActive || "No recent activity"}
              detail="Last active"
            />
            <TinyStatus
              color="bg-blue-400"
              label={firstActive || "No start signal"}
              detail="First active"
            />
            <TinyStatus
              color="bg-amber-400"
              label={String(
                schedule?.awakeProbability.contributingSources.length ?? 0,
              )}
              detail="Activity sources"
            />
            <TinyStatus
              color="bg-zinc-400"
              label={String(capabilities.status?.summary.workingCount ?? 0)}
              detail="Capabilities working"
            />
          </div>
        </DashboardPanel>

        <DashboardPanel
          title="Systems"
          icon={<Clock3 className="h-4 w-4" aria-hidden />}
          className="xl:col-span-3"
        >
          {capabilities.loading && !capabilities.status ? (
            <div className="flex items-center gap-2 py-5 text-xs text-muted">
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
              Checking systems...
            </div>
          ) : capabilityIssues.length === 0 ? (
            <TinyStatus
              color="bg-emerald-400"
              label="All tracked systems working"
              detail={
                capabilities.status
                  ? `${capabilities.status.summary.workingCount}/${capabilities.status.summary.totalCount}`
                  : undefined
              }
            />
          ) : (
            <div className="space-y-3">
              {capabilityIssues.map((capability) => (
                <CapabilityLine key={capability.id} capability={capability} />
              ))}
            </div>
          )}
          {capabilities.error ? (
            <div className="mt-3 text-xs text-rose-300">
              {capabilities.error}
            </div>
          ) : null}
        </DashboardPanel>
      </div>
    </div>
  );
}
