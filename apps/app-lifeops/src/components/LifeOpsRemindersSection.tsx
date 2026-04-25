import { client, useApp } from "@elizaos/app-core";
import type { LifeOpsActiveReminderView } from "@elizaos/shared/contracts/lifeops";
import { Bell, Loader2, MessageSquare, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useLifeOpsChatLauncher } from "./LifeOpsChatAdapter.js";
import { useLifeOpsSelection } from "./LifeOpsSelectionContext.js";

type UrgencyKey = "overdue" | "soon" | "today" | "later";

interface UrgencyStyle {
  label: string;
  dot: string;
  pill: string;
  accent: string;
  chip: string;
}

const URGENCY_STYLES: Record<UrgencyKey, UrgencyStyle> = {
  overdue: {
    label: "Overdue",
    dot: "bg-rose-500",
    pill: "bg-rose-500/15 text-rose-300",
    accent: "bg-rose-500/70",
    chip: "text-rose-300",
  },
  soon: {
    label: "Within the hour",
    dot: "bg-amber-400",
    pill: "bg-amber-500/15 text-amber-300",
    accent: "bg-amber-400/70",
    chip: "text-amber-300",
  },
  today: {
    label: "Today",
    dot: "bg-blue-400",
    pill: "bg-blue-500/15 text-blue-300",
    accent: "bg-blue-400/70",
    chip: "text-blue-300",
  },
  later: {
    label: "Later this week",
    dot: "bg-emerald-400",
    pill: "bg-emerald-500/15 text-emerald-300",
    accent: "bg-emerald-400/70",
    chip: "text-emerald-300",
  },
};

const BUCKET_ORDER: UrgencyKey[] = ["overdue", "soon", "today", "later"];

function classifyReminder(iso: string): UrgencyKey {
  const parsed = Date.parse(iso);
  if (!Number.isFinite(parsed)) return "later";
  const diffMin = Math.round((parsed - Date.now()) / 60_000);
  if (diffMin < 0) return "overdue";
  if (diffMin < 60) return "soon";
  if (diffMin < 60 * 24) return "today";
  return "later";
}

function formatRelative(iso: string): string {
  const parsed = Date.parse(iso);
  if (!Number.isFinite(parsed)) return iso;
  const diffMin = Math.round((parsed - Date.now()) / 60_000);
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

function formatClock(iso: string): string {
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return iso;
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
    case "email":
      return "Email";
    case "sms":
      return "SMS";
    default:
      return channel;
  }
}

interface ReminderRowProps {
  reminder: LifeOpsActiveReminderView;
  urgency: UrgencyKey;
  isSelected: boolean;
  onSelect: () => void;
  onChat: () => void;
}

function ReminderRow({
  reminder,
  urgency,
  isSelected,
  onSelect,
  onChat,
}: ReminderRowProps) {
  const style = URGENCY_STYLES[urgency];
  return (
    <div
      className={[
        "group flex items-stretch gap-2 border-b border-border/8 pr-3 last:border-b-0",
        isSelected ? "bg-accent/8" : "hover:bg-bg-muted/25",
      ].join(" ")}
    >
      <button
        type="button"
        aria-pressed={isSelected}
        className="flex min-w-0 flex-1 items-stretch gap-3 text-left"
        onClick={onSelect}
      >
        <span
          aria-hidden
          className={`w-1 shrink-0 ${style.accent} ${isSelected ? "" : "opacity-70 group-hover:opacity-100"}`}
        />
        <span className="flex min-w-0 flex-1 items-start gap-3 py-2.5">
          <span className="mt-1 flex h-7 w-7 shrink-0 items-center justify-center rounded-xl bg-bg-muted/30 text-muted">
            <Bell className="h-3.5 w-3.5" aria-hidden />
          </span>
          <span className="min-w-0 flex-1 space-y-0.5">
            <span className="block truncate text-sm font-medium text-txt">
              {reminder.title}
            </span>
            <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-muted">
              <span>{formatClock(reminder.scheduledFor)}</span>
              {reminder.stepLabel ? (
                <span className="text-muted/70">· {reminder.stepLabel}</span>
              ) : null}
              <span className="text-muted/70">
                · {channelLabel(reminder.channel)}
              </span>
            </span>
          </span>
          <span
            className={`mt-1 shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold tabular-nums ${style.pill}`}
          >
            {formatRelative(reminder.scheduledFor)}
          </span>
        </span>
      </button>
      <div className="flex shrink-0 items-center py-2.5">
        <button
          type="button"
          onClick={onChat}
          className="inline-flex h-7 items-center gap-1.5 rounded-lg px-2.5 text-[11px] font-semibold text-muted transition-colors hover:bg-bg-muted/40 hover:text-txt"
          aria-label={`Chat about ${reminder.title}`}
        >
          <MessageSquare className="h-3.5 w-3.5" aria-hidden />
          Chat
        </button>
      </div>
    </div>
  );
}

function BucketHeader({
  urgency,
  count,
}: {
  urgency: UrgencyKey;
  count: number;
}) {
  const style = URGENCY_STYLES[urgency];
  return (
    <div className="flex items-center gap-2 px-1 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted">
      <span className={`h-1.5 w-1.5 rounded-full ${style.dot}`} aria-hidden />
      <span className={style.chip}>{style.label}</span>
      <span className="text-muted/60">· {count}</span>
    </div>
  );
}

export function LifeOpsRemindersSection() {
  const { t } = useApp();
  const { selection, select } = useLifeOpsSelection();
  const { chatAboutReminder } = useLifeOpsChatLauncher();

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

  const buckets = useMemo(() => {
    const map: Record<UrgencyKey, LifeOpsActiveReminderView[]> = {
      overdue: [],
      soon: [],
      today: [],
      later: [],
    };
    for (const reminder of reminders) {
      map[classifyReminder(reminder.scheduledFor)].push(reminder);
    }
    for (const key of BUCKET_ORDER) {
      map[key].sort((a, b) => a.scheduledFor.localeCompare(b.scheduledFor));
    }
    return map;
  }, [reminders]);

  return (
    <div className="space-y-4" data-testid="lifeops-reminders">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <h2 className="text-base font-semibold tracking-tight text-txt">
            {t("lifeopsreminders.title", { defaultValue: "Reminders" })}
          </h2>
          <span className="rounded-full bg-bg-muted/40 px-2 py-0.5 text-[10px] font-medium text-muted tabular-nums">
            {reminders.length}
          </span>
        </div>
        <div className="flex items-center gap-2">
          {BUCKET_ORDER.map((urgency) => {
            const count = buckets[urgency].length;
            if (count === 0) return null;
            const style = URGENCY_STYLES[urgency];
            return (
              <span
                key={urgency}
                className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold ${style.pill}`}
              >
                <span
                  className={`h-1.5 w-1.5 rounded-full ${style.dot}`}
                  aria-hidden
                />
                {count} {style.label.toLowerCase()}
              </span>
            );
          })}
          <button
            type="button"
            className="inline-flex items-center gap-1.5 rounded-lg px-2 py-1 text-xs text-muted transition-colors hover:bg-bg-muted/40 hover:text-txt disabled:opacity-40"
            onClick={() => void load()}
            disabled={loading}
            aria-label={t("common.refresh", { defaultValue: "Refresh" })}
          >
            <RefreshCw
              className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`}
            />
          </button>
        </div>
      </div>

      {error ? (
        <div className="rounded-2xl border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-300">
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
        <div className="rounded-2xl border border-border/12 bg-card/12 px-4 py-10 text-center text-xs text-muted">
          {t("lifeopsreminders.empty", {
            defaultValue: "All clear. No active reminders.",
          })}
        </div>
      ) : null}

      {reminders.length > 0 ? (
        <div className="space-y-4">
          {BUCKET_ORDER.map((urgency) => {
            const bucket = buckets[urgency];
            if (bucket.length === 0) return null;
            return (
              <div key={urgency} className="space-y-1.5">
                <BucketHeader urgency={urgency} count={bucket.length} />
                <div className="overflow-hidden rounded-2xl border border-border/12 bg-card/12">
                  {bucket.map((reminder) => {
                    const rowKey = `${reminder.ownerId}:${reminder.stepIndex}`;
                    const isSelected =
                      selection.reminderId === reminder.ownerId;
                    return (
                      <ReminderRow
                        key={rowKey}
                        reminder={reminder}
                        urgency={urgency}
                        isSelected={isSelected}
                        onSelect={() =>
                          select({
                            reminderId: reminder.ownerId,
                            eventId: reminder.eventId ?? null,
                          })
                        }
                        onChat={() => chatAboutReminder(reminder)}
                      />
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
