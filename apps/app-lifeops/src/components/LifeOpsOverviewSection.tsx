/**
 * LifeOps Overview - today-first unified feed.
 *
 * Shows a single agenda that interleaves today's calendar events, active
 * reminders, and the freshest inbox messages, each coloured by type.
 * Clicking an item deep-links into the dedicated section. Navigation is
 * handled by the sidebar so we do not render jump cards.
 */
import { client, useApp } from "@elizaos/app-core";
import type {
  LifeOpsActiveReminderView,
  LifeOpsCalendarEvent,
  LifeOpsInboxChannel,
  LifeOpsOverview,
  LifeOpsUnifiedMessage,
} from "@elizaos/shared/contracts/lifeops";
import {
  AtSign,
  Bell,
  CalendarDays,
  Flame,
  Loader2,
  MessageCircle,
  MessageSquare,
  Phone,
  RefreshCw,
  Send,
  Shield,
  Smartphone,
  Sparkles,
  Target,
} from "lucide-react";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import { useCalendarWeek } from "../hooks/useCalendarWeek.js";
import type { LifeOpsSection } from "../hooks/useLifeOpsSection.js";
import { useUnifiedInbox } from "../hooks/useUnifiedInbox.js";
import { useLifeOpsSelection } from "./LifeOpsSelectionContext.js";
import { LifeOpsSetupGate, useLifeOpsSetupGate } from "./LifeOpsSetupGate.js";

interface LifeOpsOverviewSectionProps {
  onNavigate: (section: LifeOpsSection) => void;
}

// Date helpers

function useGreeting(): string {
  const hour = new Date().getHours();
  if (hour < 5) return "Still up?";
  if (hour < 12) return "Good morning";
  if (hour < 17) return "Good afternoon";
  if (hour < 22) return "Good evening";
  return "Winding down";
}

function formatFullDate(date: Date): string {
  return new Intl.DateTimeFormat(undefined, {
    weekday: "long",
    month: "long",
    day: "numeric",
  }).format(date);
}

function formatClockTime(iso: string): string {
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

// Classification and style tokens

type ReminderUrgency = "overdue" | "soon" | "today" | "later";

function classifyReminder(iso: string): ReminderUrgency {
  const parsed = Date.parse(iso);
  if (!Number.isFinite(parsed)) return "later";
  const diffMin = Math.round((parsed - Date.now()) / 60_000);
  if (diffMin < 0) return "overdue";
  if (diffMin < 60) return "soon";
  if (diffMin < 60 * 24) return "today";
  return "later";
}

const URGENCY_STYLES: Record<
  ReminderUrgency,
  { dot: string; pill: string; label: string }
> = {
  overdue: {
    dot: "bg-rose-500",
    pill: "text-rose-300 bg-rose-500/12",
    label: "Overdue",
  },
  soon: {
    dot: "bg-amber-400",
    pill: "text-amber-300 bg-amber-500/12",
    label: "Soon",
  },
  today: {
    dot: "bg-blue-400",
    pill: "text-blue-300 bg-blue-500/12",
    label: "Today",
  },
  later: {
    dot: "bg-emerald-400",
    pill: "text-emerald-300 bg-emerald-500/12",
    label: "Later",
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

// Small UI primitives

interface StatPillProps {
  label: string;
  value: number;
  accent: string;
  icon: ReactNode;
  onClick?: () => void;
}

function StatPill({ label, value, accent, icon, onClick }: StatPillProps) {
  const content = (
    <div className="flex items-center gap-3">
      <span
        className={`flex h-9 w-9 items-center justify-center rounded-xl ${accent}`}
      >
        {icon}
      </span>
      <div className="min-w-0">
        <div className="text-xl font-semibold leading-none text-txt tabular-nums">
          {value}
        </div>
        <div className="mt-1 truncate text-[11px] uppercase tracking-wide text-muted">
          {label}
        </div>
      </div>
    </div>
  );
  if (onClick) {
    return (
      <button
        type="button"
        onClick={onClick}
        className="flex w-full items-center rounded-2xl border border-border/16 bg-card/22 px-3.5 py-3 text-left transition-colors hover:border-accent/30 hover:bg-card/32"
      >
        {content}
      </button>
    );
  }
  return (
    <div className="flex w-full items-center rounded-2xl border border-border/16 bg-card/22 px-3.5 py-3">
      {content}
    </div>
  );
}

function SectionCard({
  title,
  icon,
  count,
  onSeeAll,
  children,
}: {
  title: string;
  icon: ReactNode;
  count: number;
  onSeeAll: () => void;
  children: ReactNode;
}) {
  return (
    <section className="flex flex-col overflow-hidden rounded-3xl border border-border/16 bg-card/18">
      <div className="flex items-center justify-between gap-3 border-b border-border/12 px-4 py-3">
        <div className="flex items-center gap-2 text-sm font-semibold text-txt">
          {icon}
          <span>{title}</span>
          <span className="rounded-full bg-bg-muted/40 px-1.5 py-0.5 text-[10px] font-medium text-muted tabular-nums">
            {count}
          </span>
        </div>
        <button
          type="button"
          className="text-[11px] font-medium text-muted hover:text-txt"
          onClick={onSeeAll}
        >
          See all
        </button>
      </div>
      <div className="divide-y divide-border/8">{children}</div>
    </section>
  );
}

// Row renderers

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
      className="group flex w-full items-center gap-3 px-3 py-2.5 text-left transition-colors hover:bg-bg-muted/30"
    >
      <span className="h-2 w-2 shrink-0 rounded-full bg-blue-400" aria-hidden />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm text-txt">{event.title}</span>
        {event.location ? (
          <span className="mt-0.5 block truncate text-[11px] text-muted">
            {event.location}
          </span>
        ) : null}
      </span>
      <span className="shrink-0 rounded-full bg-blue-500/12 px-2 py-0.5 text-[10px] font-semibold text-blue-300">
        {event.isAllDay
          ? "All day"
          : `${formatClockTime(event.startAt)} · ${formatRelative(event.startAt)}`}
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
      className="group flex w-full items-center gap-3 px-3 py-2.5 text-left transition-colors hover:bg-bg-muted/30"
    >
      <span
        className={`h-2 w-2 shrink-0 rounded-full ${style.dot}`}
        aria-hidden
      />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm text-txt">
          {reminder.title}
        </span>
        {reminder.stepLabel ? (
          <span className="mt-0.5 block truncate text-[11px] text-muted">
            {reminder.stepLabel}
          </span>
        ) : null}
      </span>
      <span
        className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold ${style.pill}`}
      >
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
      className="group flex w-full items-center gap-3 px-3 py-2.5 text-left transition-colors hover:bg-bg-muted/30"
    >
      <span
        className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full ${style.bg} ${style.text}`}
        aria-hidden
      >
        {style.icon}
      </span>
      <span className="min-w-0 flex-1">
        <span
          className={`flex items-center gap-2 truncate text-sm ${
            message.unread ? "font-semibold text-txt" : "text-txt/85"
          }`}
        >
          <span className="truncate">{message.sender.displayName}</span>
          {message.unread ? (
            <span
              className="inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-accent"
              aria-hidden
            />
          ) : null}
        </span>
        <span className="mt-0.5 block truncate text-[11px] text-muted">
          {subject}
        </span>
      </span>
      <span
        className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold ${style.bg} ${style.text}`}
      >
        {formatRelative(message.receivedAt)}
      </span>
    </button>
  );
}

// Main section

export function LifeOpsOverviewSection({
  onNavigate,
}: LifeOpsOverviewSectionProps) {
  const { t } = useApp();
  const { select } = useLifeOpsSelection();
  const { dismissed, dismiss } = useLifeOpsSetupGate();
  const greeting = useGreeting();

  const [overview, setOverview] = useState<LifeOpsOverview | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadOverview = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await client.getLifeOpsOverview();
      setOverview(data);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : t("lifeopsoverviewsection.loadFailed", {
              defaultValue: "Failed to load overview.",
            }),
      );
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void loadOverview();
  }, [loadOverview]);

  const calendar = useCalendarWeek({ viewMode: "week" });
  const inbox = useUnifiedInbox({ maxResults: 6 });

  const upcomingEvents = useMemo(() => {
    const now = Date.now();
    return [...calendar.events]
      .filter((event) => {
        const end = Date.parse(event.endAt);
        return Number.isFinite(end) && end >= now;
      })
      .sort((a, b) => a.startAt.localeCompare(b.startAt))
      .slice(0, 5);
  }, [calendar.events]);

  const todayEvents = useMemo(
    () => upcomingEvents.filter((event) => isToday(event.startAt)),
    [upcomingEvents],
  );

  const today = useMemo(() => new Date(), []);
  const reminders = overview?.reminders ?? [];
  const activeReminders = reminders.slice(0, 5);
  const summary = overview?.summary;

  const refresh = useCallback(() => {
    void loadOverview();
    void calendar.refresh();
    void inbox.refresh();
  }, [calendar, inbox, loadOverview]);

  if (!dismissed) {
    return <LifeOpsSetupGate onDismiss={dismiss} />;
  }

  return (
    <div className="space-y-6" data-testid="lifeops-overview">
      {/* Hero */}
      <div className="relative overflow-hidden rounded-3xl border border-border/16 bg-gradient-to-br from-violet-500/14 via-blue-500/10 to-emerald-500/12 px-5 py-5">
        <div className="pointer-events-none absolute -right-6 -top-6 h-32 w-32 rounded-full bg-violet-500/20 blur-3xl" />
        <div className="pointer-events-none absolute -bottom-10 -left-6 h-32 w-32 rounded-full bg-blue-500/20 blur-3xl" />
        <div className="relative flex flex-wrap items-end justify-between gap-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-blue-300">
              <Sparkles className="h-3.5 w-3.5" aria-hidden />
              {greeting}
            </div>
            <h1 className="mt-1 text-2xl font-semibold tracking-tight text-txt">
              {formatFullDate(today)}
            </h1>
            <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted">
              {overview?.schedule?.phase ? (
                <span className="capitalize">
                  {overview.schedule.phase.replace(/_/g, " ")}
                </span>
              ) : null}
              {todayEvents.length > 0 ? (
                <span className="inline-flex items-center gap-1 rounded-full bg-blue-500/14 px-2 py-0.5 text-blue-300">
                  <CalendarDays className="h-3 w-3" aria-hidden />
                  {todayEvents.length} event
                  {todayEvents.length === 1 ? "" : "s"} today
                </span>
              ) : null}
              {summary && summary.activeReminderCount > 0 ? (
                <span className="inline-flex items-center gap-1 rounded-full bg-amber-500/14 px-2 py-0.5 text-amber-300">
                  <Bell className="h-3 w-3" aria-hidden />
                  {summary.activeReminderCount} reminder
                  {summary.activeReminderCount === 1 ? "" : "s"}
                </span>
              ) : null}
            </div>
          </div>
          <button
            type="button"
            className="inline-flex items-center gap-1.5 rounded-full border border-border/20 bg-card/40 px-3 py-1.5 text-xs font-medium text-muted transition-colors hover:border-accent/30 hover:text-txt disabled:opacity-40"
            onClick={refresh}
            disabled={loading}
          >
            <RefreshCw
              className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`}
              aria-hidden
            />
            {t("common.refresh", { defaultValue: "Refresh" })}
          </button>
        </div>
      </div>

      {error ? (
        <div className="rounded-2xl border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-300">
          {error}
        </div>
      ) : null}

      {loading && !overview ? (
        <div className="flex items-center gap-2 py-6 text-xs text-muted">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
          Loading overview...
        </div>
      ) : null}

      {/* Stat pills */}
      {summary ? (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <StatPill
            label="Active"
            value={summary.activeOccurrenceCount}
            accent="bg-violet-500/20 text-violet-300"
            icon={<Flame className="h-4 w-4" aria-hidden />}
          />
          <StatPill
            label="Overdue"
            value={summary.overdueOccurrenceCount}
            accent="bg-rose-500/20 text-rose-300"
            icon={<Bell className="h-4 w-4" aria-hidden />}
            onClick={() => onNavigate("reminders")}
          />
          <StatPill
            label="Reminders"
            value={summary.activeReminderCount}
            accent="bg-amber-500/20 text-amber-300"
            icon={<Bell className="h-4 w-4" aria-hidden />}
            onClick={() => onNavigate("reminders")}
          />
          <StatPill
            label="Goals"
            value={summary.activeGoalCount}
            accent="bg-emerald-500/20 text-emerald-300"
            icon={<Target className="h-4 w-4" aria-hidden />}
          />
        </div>
      ) : null}

      {/* Three-up unified feed */}
      <div className="grid gap-4 lg:grid-cols-3">
        <SectionCard
          title="Up next"
          icon={<CalendarDays className="h-4 w-4 text-blue-300" aria-hidden />}
          count={upcomingEvents.length}
          onSeeAll={() => onNavigate("calendar")}
        >
          {calendar.loading && upcomingEvents.length === 0 ? (
            <div className="px-4 py-6 text-center text-xs text-muted">
              Loading...
            </div>
          ) : upcomingEvents.length === 0 ? (
            <div className="px-4 py-8 text-center text-xs text-muted">
              Nothing scheduled.
            </div>
          ) : (
            upcomingEvents.map((event) => (
              <CalendarEventRow
                key={event.id}
                event={event}
                onClick={() => {
                  select({ eventId: event.id });
                  onNavigate("calendar");
                }}
              />
            ))
          )}
        </SectionCard>

        <SectionCard
          title="Reminders"
          icon={<Bell className="h-4 w-4 text-amber-300" aria-hidden />}
          count={reminders.length}
          onSeeAll={() => onNavigate("reminders")}
        >
          {loading && activeReminders.length === 0 ? (
            <div className="px-4 py-6 text-center text-xs text-muted">
              Loading...
            </div>
          ) : activeReminders.length === 0 ? (
            <div className="px-4 py-8 text-center text-xs text-muted">
              All clear.
            </div>
          ) : (
            activeReminders.map((reminder) => (
              <ReminderAgendaRow
                key={`${reminder.ownerId}:${reminder.stepIndex}`}
                reminder={reminder}
                onClick={() => {
                  select({
                    reminderId: reminder.ownerId,
                    eventId: reminder.eventId ?? null,
                  });
                  onNavigate("reminders");
                }}
              />
            ))
          )}
        </SectionCard>

        <SectionCard
          title="Inbox"
          icon={
            <MessageSquare className="h-4 w-4 text-emerald-300" aria-hidden />
          }
          count={inbox.messages.length}
          onSeeAll={() => onNavigate("messages")}
        >
          {inbox.loading && inbox.messages.length === 0 ? (
            <div className="px-4 py-6 text-center text-xs text-muted">
              Loading...
            </div>
          ) : inbox.messages.length === 0 ? (
            <div className="px-4 py-8 text-center text-xs text-muted">
              Inbox clear.
            </div>
          ) : (
            inbox.messages.slice(0, 5).map((message) => (
              <InboxMessageRow
                key={message.id}
                message={message}
                onClick={() => {
                  select({ messageId: message.id });
                  onNavigate("messages");
                }}
              />
            ))
          )}
        </SectionCard>
      </div>
    </div>
  );
}
