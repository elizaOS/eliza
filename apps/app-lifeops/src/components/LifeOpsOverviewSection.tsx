/**
 * LifeOps Overview — today-first landing.
 *
 * Renders a Google-Calendar-style "Today" hero with a colour-coded agenda
 * that mixes calendar events, reminders, and inbox attention in one list.
 * Navigation is handled by the sidebar, so we do not render jump-to cards.
 */
import { client, useApp } from "@elizaos/app-core";
import type {
  LifeOpsActiveReminderView,
  LifeOpsOverview,
} from "@elizaos/shared/contracts/lifeops";
import {
  Bell,
  CalendarDays,
  Flame,
  Loader2,
  RefreshCw,
  Sparkles,
  Target,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { LifeOpsSection } from "../hooks/useLifeOpsSection.js";
import { useLifeOpsSelection } from "./LifeOpsSelectionContext.js";
import { LifeOpsSetupGate, useLifeOpsSetupGate } from "./LifeOpsSetupGate.js";

interface LifeOpsOverviewSectionProps {
  onNavigate: (section: LifeOpsSection) => void;
}

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

function formatTime(iso: string): string {
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

const URGENCY_CLASS: Record<
  ReminderUrgency,
  { dot: string; pill: string; ring: string }
> = {
  overdue: {
    dot: "bg-rose-500",
    pill: "text-rose-300 bg-rose-500/12",
    ring: "ring-rose-500/30",
  },
  soon: {
    dot: "bg-amber-400",
    pill: "text-amber-300 bg-amber-500/12",
    ring: "ring-amber-500/30",
  },
  today: {
    dot: "bg-blue-400",
    pill: "text-blue-300 bg-blue-500/12",
    ring: "ring-blue-500/30",
  },
  later: {
    dot: "bg-muted",
    pill: "text-muted bg-bg-muted/40",
    ring: "ring-border/30",
  },
};

interface StatPillProps {
  label: string;
  value: number;
  accent: string;
  icon: React.ReactNode;
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

function AgendaReminderRow({
  reminder,
  onClick,
}: {
  reminder: LifeOpsActiveReminderView;
  onClick: () => void;
}) {
  const urgency = classifyReminder(reminder.scheduledFor);
  const cls = URGENCY_CLASS[urgency];
  return (
    <button
      type="button"
      onClick={onClick}
      className="group flex w-full items-center gap-3 px-3 py-2.5 text-left transition-colors hover:bg-bg-muted/30"
    >
      <span
        className={`h-2 w-2 shrink-0 rounded-full ${cls.dot}`}
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
        className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold ${cls.pill}`}
      >
        {formatRelative(reminder.scheduledFor)}
      </span>
    </button>
  );
}

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

  const load = useCallback(async () => {
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
    void load();
  }, [load]);

  const today = useMemo(() => new Date(), []);
  const reminders = overview?.reminders ?? [];
  const summary = overview?.summary;

  if (!dismissed) {
    return <LifeOpsSetupGate onDismiss={dismiss} />;
  }

  return (
    <div className="space-y-6" data-testid="lifeops-overview">
      {/* Hero */}
      <div className="relative overflow-hidden rounded-3xl border border-border/16 bg-gradient-to-br from-violet-500/12 via-blue-500/10 to-emerald-500/10 px-5 py-5">
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
            {overview?.schedule?.phase ? (
              <div className="mt-1 text-xs text-muted">
                <span className="capitalize">
                  {overview.schedule.phase.replace(/_/g, " ")}
                </span>
                {overview.schedule.wakeAt ? (
                  <>
                    {" · "}wake {formatRelative(overview.schedule.wakeAt)}
                  </>
                ) : null}
              </div>
            ) : null}
          </div>
          <button
            type="button"
            className="inline-flex items-center gap-1.5 rounded-full border border-border/20 bg-card/40 px-3 py-1.5 text-xs font-medium text-muted transition-colors hover:border-accent/30 hover:text-txt disabled:opacity-40"
            onClick={() => void load()}
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
          {t("lifeopsoverviewsection.loading", {
            defaultValue: "Loading overview…",
          })}
        </div>
      ) : null}

      {summary ? (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <StatPill
            label={t("lifeopsoverviewsection.activeItems", {
              defaultValue: "Active",
            })}
            value={summary.activeOccurrenceCount}
            accent="bg-violet-500/20 text-violet-300"
            icon={<Flame className="h-4 w-4" aria-hidden />}
          />
          <StatPill
            label={t("lifeopsoverviewsection.overdue", {
              defaultValue: "Overdue",
            })}
            value={summary.overdueOccurrenceCount}
            accent="bg-rose-500/20 text-rose-300"
            icon={<Bell className="h-4 w-4" aria-hidden />}
            onClick={() => onNavigate("reminders")}
          />
          <StatPill
            label={t("lifeopsoverviewsection.reminders", {
              defaultValue: "Reminders",
            })}
            value={summary.activeReminderCount}
            accent="bg-amber-500/20 text-amber-300"
            icon={<Bell className="h-4 w-4" aria-hidden />}
            onClick={() => onNavigate("reminders")}
          />
          <StatPill
            label={t("lifeopsoverviewsection.goals", {
              defaultValue: "Goals",
            })}
            value={summary.activeGoalCount}
            accent="bg-emerald-500/20 text-emerald-300"
            icon={<Target className="h-4 w-4" aria-hidden />}
          />
        </div>
      ) : null}

      {overview ? (
        <section className="overflow-hidden rounded-3xl border border-border/16 bg-card/18">
          <div className="flex items-center justify-between gap-3 border-b border-border/12 px-4 py-3">
            <div className="flex items-center gap-2 text-sm font-semibold text-txt">
              <CalendarDays className="h-4 w-4 text-blue-300" aria-hidden />
              {t("lifeopsoverviewsection.nextUp", {
                defaultValue: "Next up",
              })}
            </div>
            <button
              type="button"
              className="text-[11px] font-medium text-muted hover:text-txt"
              onClick={() => onNavigate("reminders")}
            >
              {t("common.seeAll", { defaultValue: "See all" })}
            </button>
          </div>
          {reminders.length === 0 ? (
            <div className="px-4 py-8 text-center text-xs text-muted">
              {t("lifeopsoverviewsection.noReminders", {
                defaultValue: "No upcoming reminders.",
              })}
            </div>
          ) : (
            <div className="divide-y divide-border/8">
              {reminders.slice(0, 6).map((reminder) => (
                <AgendaReminderRow
                  key={`${reminder.ownerId}:${reminder.stepIndex}`}
                  reminder={reminder}
                  onClick={() =>
                    select({
                      reminderId: reminder.ownerId,
                      eventId: reminder.eventId ?? null,
                    })
                  }
                />
              ))}
            </div>
          )}
        </section>
      ) : null}
    </div>
  );
}
