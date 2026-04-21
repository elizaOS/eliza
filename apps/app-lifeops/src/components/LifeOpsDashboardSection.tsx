/**
 * LifeOps Dashboard section — today's timeline + next-up reminders + schedule strip.
 */
import { client, useApp } from "@elizaos/app-core";
import type {
  LifeOpsActiveReminderView,
  LifeOpsOverview,
} from "@elizaos/shared/contracts/lifeops";
import { Bell, CalendarDays, Loader2, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import type { LifeOpsSection } from "../hooks/useLifeOpsSection.js";
import { useLifeOpsSelection } from "./LifeOpsSelectionContext.js";
import { LifeOpsSetupGate, useLifeOpsSetupGate } from "./LifeOpsSetupGate.js";

interface LifeOpsDashboardSectionProps {
  onNavigate: (section: LifeOpsSection) => void;
}

function formatRelative(isoString: string): string {
  const date = new Date(isoString);
  if (!Number.isFinite(date.getTime())) {
    return isoString;
  }
  const now = Date.now();
  const diffMs = date.getTime() - now;
  const diffMin = Math.round(diffMs / 60_000);
  if (Math.abs(diffMin) < 1) {
    return "now";
  }
  if (diffMin > 0) {
    if (diffMin < 60) {
      return `in ${diffMin}m`;
    }
    const hrs = Math.round(diffMin / 60);
    return `in ${hrs}h`;
  }
  const ago = Math.abs(diffMin);
  if (ago < 60) {
    return `${ago}m ago`;
  }
  return `${Math.round(ago / 60)}h ago`;
}

function ReminderRow({
  reminder,
  onClick,
}: {
  reminder: LifeOpsActiveReminderView;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className="flex w-full items-start gap-3 rounded-xl px-3 py-2.5 text-left transition-colors hover:bg-bg/60"
      onClick={onClick}
    >
      <Bell className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted" />
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium text-txt">
          {reminder.title}
        </div>
        <div className="mt-0.5 text-xs text-muted">
          {formatRelative(reminder.scheduledFor)}
          {reminder.stepLabel ? ` · ${reminder.stepLabel}` : ""}
        </div>
      </div>
    </button>
  );
}

export function LifeOpsDashboardSection({
  onNavigate,
}: LifeOpsDashboardSectionProps) {
  const { t } = useApp();
  const { select } = useLifeOpsSelection();
  const { dismissed, dismiss } = useLifeOpsSetupGate();

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
          : t("lifeopsdashboard.loadFailed", {
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

  if (!dismissed) {
    return <LifeOpsSetupGate onDismiss={dismiss} />;
  }

  return (
    <div className="space-y-6" data-testid="lifeops-dashboard">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-sm font-semibold text-txt">
          {t("lifeopsdashboard.title", {
            defaultValue: "Dashboard",
          })}
        </h2>
        <button
          type="button"
          className="flex items-center gap-1.5 rounded-lg px-2 py-1 text-xs text-muted transition-colors hover:bg-bg/60 hover:text-txt disabled:opacity-40"
          onClick={() => void load()}
          disabled={loading}
          aria-label={t("common.refresh", { defaultValue: "Refresh" })}
        >
          <RefreshCw
            className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`}
          />
          {t("common.refresh", { defaultValue: "Refresh" })}
        </button>
      </div>

      {error ? (
        <div className="rounded-2xl bg-danger/10 px-3 py-2 text-xs text-danger">
          {error}
        </div>
      ) : null}

      {loading && !overview ? (
        <div className="flex items-center gap-2 py-6 text-xs text-muted">
          <Loader2 className="h-4 w-4 animate-spin" />
          {t("lifeopsdashboard.loading", {
            defaultValue: "Loading overview…",
          })}
        </div>
      ) : null}

      {overview ? (
        <>
          {/* Summary metrics */}
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <div className="space-y-1 rounded-2xl border border-border/16 bg-card/18 px-3 py-3">
              <div className="text-2xs font-semibold uppercase tracking-wide text-muted">
                {t("lifeopsdashboard.activeItems", {
                  defaultValue: "Active",
                })}
              </div>
              <div className="text-xl font-semibold text-txt">
                {overview.summary.activeOccurrenceCount}
              </div>
            </div>
            <div className="space-y-1 rounded-2xl border border-border/16 bg-card/18 px-3 py-3">
              <div className="text-2xs font-semibold uppercase tracking-wide text-muted">
                {t("lifeopsdashboard.overdue", {
                  defaultValue: "Overdue",
                })}
              </div>
              <div className="text-xl font-semibold text-txt">
                {overview.summary.overdueOccurrenceCount}
              </div>
            </div>
            <div className="space-y-1 rounded-2xl border border-border/16 bg-card/18 px-3 py-3">
              <div className="text-2xs font-semibold uppercase tracking-wide text-muted">
                {t("lifeopsdashboard.reminders", {
                  defaultValue: "Reminders",
                })}
              </div>
              <div className="text-xl font-semibold text-txt">
                {overview.summary.activeReminderCount}
              </div>
            </div>
            <div className="space-y-1 rounded-2xl border border-border/16 bg-card/18 px-3 py-3">
              <div className="text-2xs font-semibold uppercase tracking-wide text-muted">
                {t("lifeopsdashboard.goals", {
                  defaultValue: "Goals",
                })}
              </div>
              <div className="text-xl font-semibold text-txt">
                {overview.summary.activeGoalCount}
              </div>
            </div>
          </div>

          {/* Schedule strip */}
          {overview.schedule ? (
            <div className="space-y-2">
              <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-muted">
                <CalendarDays className="h-3.5 w-3.5" />
                {t("lifeopsdashboard.schedule", {
                  defaultValue: "Schedule",
                })}
              </div>
              <div className="rounded-2xl border border-border/16 bg-card/18 px-4 py-3 text-sm text-txt">
                <span className="font-medium capitalize">
                  {overview.schedule.phase?.replace(/_/g, " ") ?? "—"}
                </span>
                {overview.schedule.wakeAt ? (
                  <span className="ml-2 text-xs text-muted">
                    wake {formatRelative(overview.schedule.wakeAt)}
                  </span>
                ) : null}
                {overview.schedule.typicalSleepHour != null ? (
                  <span className="ml-2 text-xs text-muted">
                    sleep ~{overview.schedule.typicalSleepHour}:00
                  </span>
                ) : null}
              </div>
            </div>
          ) : null}

          {/* Next-up reminders */}
          {overview.reminders.length > 0 ? (
            <div className="space-y-1">
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-muted">
                  <Bell className="h-3.5 w-3.5" />
                  {t("lifeopsdashboard.nextUp", {
                    defaultValue: "Next up",
                  })}
                </div>
                <button
                  type="button"
                  className="text-xs text-muted hover:text-txt"
                  onClick={() => onNavigate("reminders")}
                >
                  {t("common.seeAll", { defaultValue: "See all" })}
                </button>
              </div>
              <div className="rounded-2xl border border-border/12 bg-card/12">
                {overview.reminders.slice(0, 5).map((reminder) => (
                  <ReminderRow
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
            </div>
          ) : (
            <div className="rounded-2xl border border-border/12 bg-card/12 px-4 py-6 text-center text-xs text-muted">
              {t("lifeopsdashboard.noReminders", {
                defaultValue: "No upcoming reminders.",
              })}
            </div>
          )}
        </>
      ) : null}
    </div>
  );
}
