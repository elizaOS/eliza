/**
 * LifeOps Reminders section — lists active reminders with fire times.
 * Clicking a row sets the SelectionContext.
 */
import { client, useApp } from "@elizaos/app-core";
import type { LifeOpsActiveReminderView } from "@elizaos/shared/contracts/lifeops";
import { Bell, Loader2, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useLifeOpsSelection } from "./LifeOpsSelectionContext.js";

function formatFireTime(isoString: string): string {
  const date = new Date(isoString);
  if (!Number.isFinite(date.getTime())) {
    return isoString;
  }
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

function channelLabel(channel: string): string {
  switch (channel) {
    case "telegram":
      return "Telegram";
    case "discord":
      return "Discord";
    case "imessage":
      return "iMessage";
    case "signal":
      return "Signal";
    case "push":
      return "Push";
    default:
      return channel;
  }
}

interface ReminderRowProps {
  reminder: LifeOpsActiveReminderView;
  isSelected: boolean;
  onSelect: () => void;
}

function ReminderRow({ reminder, isSelected, onSelect }: ReminderRowProps) {
  return (
    <button
      type="button"
      aria-pressed={isSelected}
      className={[
        "flex w-full items-start gap-3 border-b border-border/8 px-4 py-3 text-left transition-colors last:border-b-0",
        isSelected ? "bg-accent/8" : "hover:bg-bg/60",
      ].join(" ")}
      onClick={onSelect}
    >
      <Bell
        className={`mt-0.5 h-4 w-4 shrink-0 ${isSelected ? "text-accent" : "text-muted"}`}
      />
      <div className="min-w-0 flex-1 space-y-0.5">
        <div className="truncate text-sm font-medium text-txt">
          {reminder.title}
        </div>
        <div className="flex flex-wrap gap-2 text-xs text-muted">
          <span>{formatFireTime(reminder.scheduledFor)}</span>
          {reminder.stepLabel ? (
            <span className="text-muted/60">{reminder.stepLabel}</span>
          ) : null}
          <span className="text-muted/60">
            {channelLabel(reminder.channel)}
          </span>
        </div>
      </div>
    </button>
  );
}

export function LifeOpsRemindersSection() {
  const { t } = useApp();
  const { selection, select } = useLifeOpsSelection();

  const [reminders, setReminders] = useState<LifeOpsActiveReminderView[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await client.getLifeOpsOverview();
      setReminders(data.reminders);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : t("lifeopsreminders.loadFailed", {
              defaultValue: "Failed to load reminders.",
            }),
      );
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="space-y-4" data-testid="lifeops-reminders">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-sm font-semibold text-txt">
          {t("lifeopsreminders.title", {
            defaultValue: "Reminders",
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

      {loading && reminders.length === 0 ? (
        <div className="flex items-center gap-2 py-6 text-xs text-muted">
          <Loader2 className="h-4 w-4 animate-spin" />
          {t("lifeopsreminders.loading", {
            defaultValue: "Loading reminders…",
          })}
        </div>
      ) : null}

      {!loading && reminders.length === 0 ? (
        <div className="rounded-2xl border border-border/12 bg-card/12 px-4 py-8 text-center text-xs text-muted">
          {t("lifeopsreminders.empty", {
            defaultValue: "No active reminders.",
          })}
        </div>
      ) : null}

      {reminders.length > 0 ? (
        <div className="overflow-hidden rounded-2xl border border-border/16 bg-card/12">
          {reminders.map((reminder) => {
            const rowKey = `${reminder.ownerId}:${reminder.stepIndex}`;
            const isSelected = selection.reminderId === reminder.ownerId;
            return (
              <ReminderRow
                key={rowKey}
                reminder={reminder}
                isSelected={isSelected}
                onSelect={() =>
                  select({
                    reminderId: reminder.ownerId,
                    eventId: reminder.eventId ?? null,
                  })
                }
              />
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
