import type {
  CreateLifeOpsDefinitionRequest,
  LifeOpsActiveReminderView,
  LifeOpsCadence,
  LifeOpsDefinitionRecord,
  LifeOpsTaskDefinition,
  LifeOpsWindowPolicy,
  SnoozeLifeOpsOccurrenceRequest,
} from "@elizaos/shared";
import { client, useApp } from "@elizaos/ui";
import {
  AlarmClock,
  Apple,
  Bell,
  Check,
  ChevronDown,
  Clock,
  Loader2,
  MessageSquare,
  Plus,
  RefreshCw,
  Repeat,
  Trash2,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLifeOpsChatLauncher } from "./LifeOpsChatAdapter.js";
import {
  type LifeOpsSelection,
  useLifeOpsSelection,
} from "./LifeOpsSelectionContext.js";

// ---------------------------------------------------------------------------
// Types & constants
// ---------------------------------------------------------------------------

type UrgencyKey = "overdue" | "soon" | "today" | "later";
type TabKey = "reminders" | "alarms";

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

// Mirror of NATIVE_APPLE_REMINDER_METADATA_KEY from
// `eliza/plugins/app-lifeops/src/lifeops/apple-reminders.ts` — that module pulls
// in `node:child_process` so we cannot import it from a browser bundle.
// Keep this constant in sync with apple-reminders.ts.
const NATIVE_APPLE_REMINDER_METADATA_KEY = "nativeAppleReminder";
const LIFEOPS_ALARM_METADATA_KEY = "lifeOpsAlarm";

interface NativeAppleReminderMetadataView {
  kind: "alarm" | "reminder";
  reminderId: string | null;
}

const WEEKDAY_LABELS: ReadonlyArray<{
  key: number;
  short: string;
  long: string;
}> = [
  { key: 1, short: "M", long: "Monday" },
  { key: 2, short: "T", long: "Tuesday" },
  { key: 3, short: "W", long: "Wednesday" },
  { key: 4, short: "T", long: "Thursday" },
  { key: 5, short: "F", long: "Friday" },
  { key: 6, short: "S", long: "Saturday" },
  { key: 0, short: "S", long: "Sunday" },
];

interface SnoozeOption {
  key: string;
  label: string;
  request: SnoozeLifeOpsOccurrenceRequest;
}

const SNOOZE_OPTIONS: ReadonlyArray<SnoozeOption> = [
  { key: "5m", label: "+5 min", request: { minutes: 5 } },
  { key: "15m", label: "+15 min", request: { preset: "15m" } },
  { key: "30m", label: "+30 min", request: { preset: "30m" } },
  { key: "1h", label: "+1 hour", request: { preset: "1h" } },
  { key: "1d", label: "+1 day", request: { minutes: 60 * 24 } },
];

const DEFAULT_SNOOZE: SnoozeOption = SNOOZE_OPTIONS[1] ?? {
  key: "15m",
  label: "+15 min",
  request: { preset: "15m" },
};

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

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

function formatTimeOfDay(iso: string): { primary: string; suffix: string } {
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) {
    return { primary: iso, suffix: "" };
  }
  const formatter = new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
  const formatted = formatter.format(date);
  // Split off the trailing AM/PM if present so we can render it small.
  const match = formatted.match(/^(.*?)(\s*[AaPp][Mm])$/);
  if (match) {
    return { primary: match[1].trim(), suffix: match[2].trim() };
  }
  return { primary: formatted, suffix: "" };
}

function formatNextFireDay(iso: string): string {
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return "";
  const now = new Date();
  const isSameDay =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();
  if (isSameDay) return "Today";
  const tomorrow = new Date(now);
  tomorrow.setDate(now.getDate() + 1);
  if (
    date.getFullYear() === tomorrow.getFullYear() &&
    date.getMonth() === tomorrow.getMonth() &&
    date.getDate() === tomorrow.getDate()
  ) {
    return "Tomorrow";
  }
  return new Intl.DateTimeFormat(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
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
    case "in_app":
      return "In-app";
    case "voice":
      return "Voice";
    case "whatsapp":
      return "WhatsApp";
    default:
      return channel;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readNativeAppleMetadata(
  metadata: unknown,
): NativeAppleReminderMetadataView | null {
  if (!isRecord(metadata)) return null;
  const raw = metadata[NATIVE_APPLE_REMINDER_METADATA_KEY];
  if (!isRecord(raw)) return null;
  const kind =
    raw.kind === "alarm" || raw.kind === "reminder" ? raw.kind : null;
  if (!kind) return null;
  const reminderId =
    typeof raw.reminderId === "string" && raw.reminderId.trim().length > 0
      ? raw.reminderId.trim()
      : null;
  return { kind, reminderId };
}

function describeRecurrence(
  cadence: LifeOpsCadence | undefined,
): string | null {
  if (!cadence) return null;
  switch (cadence.kind) {
    case "once":
      return null;
    case "daily":
      return "Daily";
    case "interval": {
      const minutes = cadence.everyMinutes;
      if (minutes >= 60 && minutes % 60 === 0) {
        const hours = minutes / 60;
        return hours === 1 ? "Every hour" : `Every ${hours}h`;
      }
      return `Every ${minutes}m`;
    }
    case "times_per_day": {
      const slots = cadence.slots?.length ?? 0;
      return slots > 0 ? `${slots}x/day` : "Daily";
    }
    case "weekly": {
      const weekdays = Array.isArray(cadence.weekdays) ? cadence.weekdays : [];
      if (weekdays.length === 0) return "Weekly";
      if (weekdays.length === 7) return "Daily";
      const labels = WEEKDAY_LABELS.filter((day) => weekdays.includes(day.key))
        .sort((a, b) => {
          // Sort Mon..Sun (0=Sun -> last)
          const order = (k: number) => (k === 0 ? 7 : k);
          return order(a.key) - order(b.key);
        })
        .map((day) => day.long.slice(0, 3));
      return `Weekly ${labels.join("/")}`;
    }
    default:
      return null;
  }
}

interface AlarmScheduleDraft {
  cadence: LifeOpsCadence;
  windowPolicy?: LifeOpsWindowPolicy;
  nativeAppleSyncEligible: boolean;
}

function sortedWeekdays(weekdays: ReadonlySet<number>): number[] {
  return Array.from(weekdays).sort((a, b) => a - b);
}

function buildAlarmScheduleDraft(
  hour: number,
  minute: number,
  weekdays: ReadonlySet<number>,
  timezone: string,
): AlarmScheduleDraft {
  const minuteOfDay = hour * 60 + minute;
  if (weekdays.size === 0) {
    const now = new Date();
    const candidate = new Date(now);
    candidate.setHours(hour, minute, 0, 0);
    if (candidate.getTime() <= now.getTime()) {
      candidate.setDate(candidate.getDate() + 1);
    }
    return {
      cadence: { kind: "once", dueAt: candidate.toISOString() },
      nativeAppleSyncEligible: true,
    };
  }
  if (weekdays.size === 7) {
    return {
      cadence: {
        kind: "times_per_day",
        slots: [
          {
            key: "alarm",
            label: "Alarm",
            minuteOfDay,
            durationMinutes: 1,
          },
        ],
      },
      nativeAppleSyncEligible: false,
    };
  }
  const customWindow: LifeOpsWindowPolicy["windows"][number] = {
    name: "custom",
    label: "Alarm",
    startMinute: minuteOfDay,
    endMinute: minuteOfDay + 1,
  };
  return {
    cadence: {
      kind: "weekly",
      weekdays: sortedWeekdays(weekdays),
      windows: [customWindow.name],
      visibilityLeadMinutes: 0,
      visibilityLagMinutes: 0,
    },
    windowPolicy: {
      timezone,
      windows: [customWindow],
    },
    nativeAppleSyncEligible: false,
  };
}

function defaultTimezone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

// ---------------------------------------------------------------------------
// Snooze / Complete control bundle
// ---------------------------------------------------------------------------

interface RowControlsProps {
  occurrenceId: string | null;
  busyAction: "snooze" | "complete" | null;
  optimisticState: "idle" | "snoozed" | "completed";
  onSnooze: (option: SnoozeOption) => void;
  onComplete: () => void;
  onCustomSnooze: () => void;
}

function SnoozeSplitButton({
  occurrenceId,
  busyAction,
  optimisticState,
  onSnooze,
  onCustomSnooze,
}: Pick<
  RowControlsProps,
  | "occurrenceId"
  | "busyAction"
  | "optimisticState"
  | "onSnooze"
  | "onCustomSnooze"
>) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (event: MouseEvent) => {
      if (!containerRef.current) return;
      if (!containerRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  const disabled =
    !occurrenceId || optimisticState !== "idle" || busyAction !== null;

  return (
    <div
      ref={containerRef}
      className="relative inline-flex items-stretch overflow-hidden rounded-lg border border-border/15 bg-bg-muted/30 text-[11px] font-semibold text-muted"
    >
      <button
        type="button"
        disabled={disabled}
        onClick={() => onSnooze(DEFAULT_SNOOZE)}
        className="inline-flex items-center gap-1 px-2 py-1 transition-colors hover:bg-bg-muted/60 hover:text-txt disabled:cursor-not-allowed disabled:opacity-40"
        title={
          occurrenceId
            ? `Snooze ${DEFAULT_SNOOZE.label}`
            : "Snooze unavailable for this reminder"
        }
        aria-label={`Snooze ${DEFAULT_SNOOZE.label}`}
      >
        {busyAction === "snooze" ? (
          <Loader2 className="h-3 w-3 animate-spin" />
        ) : (
          <Clock className="h-3 w-3" aria-hidden />
        )}
        {DEFAULT_SNOOZE.label}
      </button>
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen((prev) => !prev)}
        className="inline-flex items-center border-l border-border/15 px-1.5 py-1 transition-colors hover:bg-bg-muted/60 hover:text-txt disabled:cursor-not-allowed disabled:opacity-40"
        aria-label="Snooze options"
        aria-expanded={open}
      >
        <ChevronDown className="h-3 w-3" aria-hidden />
      </button>
      {open ? (
        <div
          role="menu"
          className="absolute right-0 top-full z-20 mt-1 w-40 overflow-hidden rounded-lg border border-border/20 bg-card shadow-lg"
        >
          {SNOOZE_OPTIONS.map((option) => (
            <button
              key={option.key}
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                onSnooze(option);
              }}
              className="block w-full px-3 py-1.5 text-left text-[11px] font-medium text-txt transition-colors hover:bg-bg-muted/40"
            >
              {option.label}
            </button>
          ))}
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              onCustomSnooze();
            }}
            className="block w-full border-t border-border/12 px-3 py-1.5 text-left text-[11px] font-medium text-txt transition-colors hover:bg-bg-muted/40"
          >
            Custom…
          </button>
        </div>
      ) : null}
    </div>
  );
}

function CompleteButton({
  occurrenceId,
  busyAction,
  optimisticState,
  onComplete,
}: Pick<
  RowControlsProps,
  "occurrenceId" | "busyAction" | "optimisticState" | "onComplete"
>) {
  const disabled =
    !occurrenceId || optimisticState !== "idle" || busyAction !== null;
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onComplete}
      className="inline-flex h-7 w-7 items-center justify-center rounded-lg border border-border/15 bg-bg-muted/30 text-emerald-300 transition-colors hover:bg-emerald-500/15 hover:text-emerald-200 disabled:cursor-not-allowed disabled:opacity-40"
      title={
        occurrenceId
          ? "Mark complete"
          : "Complete unavailable for this reminder"
      }
      aria-label="Mark complete"
    >
      {busyAction === "complete" ? (
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
      ) : (
        <Check className="h-3.5 w-3.5" aria-hidden />
      )}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Delivery channel label
// ---------------------------------------------------------------------------

function DeliveryChannelLabel({ channel }: { channel: string }) {
  return (
    <span
      className="inline-flex items-center rounded-full px-1.5 py-0.5 text-[10px] font-medium text-muted/80"
      title={`Delivery channel: ${channelLabel(channel)}`}
    >
      via {channelLabel(channel)}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Reminder row
// ---------------------------------------------------------------------------

interface ReminderRowProps {
  reminder: LifeOpsActiveReminderView;
  urgency: UrgencyKey;
  isSelected: boolean;
  apple: NativeAppleReminderMetadataView | null;
  recurrence: string | null;
  busyAction: "snooze" | "complete" | null;
  optimisticState: "idle" | "snoozed" | "completed";
  onSelect: () => void;
  onChat: () => void;
  onSnooze: (option: SnoozeOption) => void;
  onComplete: () => void;
  onCustomSnooze: () => void;
}

function ReminderRow({
  reminder,
  urgency,
  isSelected,
  apple,
  recurrence,
  busyAction,
  optimisticState,
  onSelect,
  onChat,
  onSnooze,
  onComplete,
  onCustomSnooze,
}: ReminderRowProps) {
  const style = URGENCY_STYLES[urgency];
  const occurrenceId = reminder.occurrenceId;
  const fading = optimisticState !== "idle";
  return (
    <div
      className={[
        "group flex items-stretch gap-2 border-b border-border/8 pr-3 last:border-b-0",
        isSelected ? "bg-accent/8" : "hover:bg-bg-muted/25",
        fading ? "opacity-50" : "",
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
            <span className="flex flex-wrap items-center gap-1.5">
              <span className="truncate text-sm font-medium text-txt">
                {reminder.title}
              </span>
              {recurrence ? (
                <span
                  className="inline-flex items-center gap-0.5 rounded-full bg-bg-muted/40 px-1.5 py-0 text-[10px] font-medium text-muted"
                  title={`Repeats: ${recurrence}`}
                >
                  <Repeat className="h-2.5 w-2.5" aria-hidden />
                  {recurrence}
                </span>
              ) : null}
              <SourceBadge apple={apple} />
              {optimisticState === "snoozed" ? (
                <span className="rounded-full bg-blue-500/15 px-1.5 py-0 text-[10px] font-medium text-blue-300">
                  snoozed
                </span>
              ) : null}
              {optimisticState === "completed" ? (
                <span className="rounded-full bg-emerald-500/15 px-1.5 py-0 text-[10px] font-medium text-emerald-300">
                  completed
                </span>
              ) : null}
            </span>
            <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-muted">
              <span>{formatClock(reminder.scheduledFor)}</span>
              {reminder.stepLabel ? (
                <span className="text-muted/70">· {reminder.stepLabel}</span>
              ) : null}
              <span className="text-muted/70">·</span>
              <DeliveryChannelLabel channel={reminder.channel} />
            </span>
          </span>
          <span
            className={`mt-1 shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold tabular-nums ${style.pill}`}
          >
            {formatRelative(reminder.scheduledFor)}
          </span>
        </span>
      </button>
      <div className="flex shrink-0 items-center gap-1.5 py-2.5">
        <SnoozeSplitButton
          occurrenceId={occurrenceId}
          busyAction={busyAction}
          optimisticState={optimisticState}
          onSnooze={onSnooze}
          onCustomSnooze={onCustomSnooze}
        />
        <CompleteButton
          occurrenceId={occurrenceId}
          busyAction={busyAction}
          optimisticState={optimisticState}
          onComplete={onComplete}
        />
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

function SourceBadge({
  apple,
}: {
  apple: NativeAppleReminderMetadataView | null;
}) {
  if (apple?.reminderId) {
    return (
      <span
        className="inline-flex items-center gap-0.5 rounded-full bg-rose-500/15 px-1.5 py-0 text-[10px] font-medium text-rose-200"
        title="Synced to Reminders.app on macOS."
      >
        <Apple className="h-2.5 w-2.5" aria-hidden />
        Reminders.app
      </span>
    );
  }
  return (
    <span
      className="inline-flex items-center gap-0.5 rounded-full bg-bg-muted/40 px-1.5 py-0 text-[10px] font-medium text-muted"
      title="Delivered by LifeOps in-app reminders."
    >
      In-app
    </span>
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

// ---------------------------------------------------------------------------
// Alarms tab
// ---------------------------------------------------------------------------

interface AlarmEntry {
  definition: LifeOpsTaskDefinition;
  reminder: LifeOpsActiveReminderView | null;
  recurrence: string;
  nextFireIso: string | null;
  apple: NativeAppleReminderMetadataView | null;
}

function isAlarmDefinition(definition: LifeOpsTaskDefinition): boolean {
  const nativeApple = readNativeAppleMetadata(definition.metadata);
  return (
    nativeApple?.kind === "alarm" ||
    definition.metadata[LIFEOPS_ALARM_METADATA_KEY] === true ||
    definition.source === "lifeops_ui_alarm"
  );
}

function buildAlarmEntries(
  definitions: LifeOpsDefinitionRecord[],
  reminders: LifeOpsActiveReminderView[],
): AlarmEntry[] {
  const remindersByDefId = new Map<string, LifeOpsActiveReminderView>();
  for (const reminder of reminders) {
    if (reminder.definitionId && !remindersByDefId.has(reminder.definitionId)) {
      remindersByDefId.set(reminder.definitionId, reminder);
    }
  }
  const entries: AlarmEntry[] = [];
  for (const record of definitions) {
    const apple = readNativeAppleMetadata(record.definition.metadata);
    if (!isAlarmDefinition(record.definition)) continue;
    if (record.definition.status === "archived") continue;
    const reminder = remindersByDefId.get(record.definition.id) ?? null;
    const recurrence = describeRecurrence(record.definition.cadence) ?? "Once";
    const nextFireIso = computeNextFireIso(record.definition, reminder);
    entries.push({
      definition: record.definition,
      reminder,
      recurrence,
      nextFireIso,
      apple,
    });
  }
  entries.sort((a, b) => {
    if (a.nextFireIso && b.nextFireIso) {
      return a.nextFireIso.localeCompare(b.nextFireIso);
    }
    if (a.nextFireIso) return -1;
    if (b.nextFireIso) return 1;
    return a.definition.title.localeCompare(b.definition.title);
  });
  return entries;
}

function computeNextFireIso(
  definition: LifeOpsTaskDefinition,
  reminder: LifeOpsActiveReminderView | null,
): string | null {
  if (reminder?.scheduledFor) return reminder.scheduledFor;
  const cadence = definition.cadence;
  const now = new Date();
  if (cadence.kind === "once") return cadence.dueAt;
  if (cadence.kind === "times_per_day") {
    const slot = cadence.slots?.[0];
    if (!slot) return null;
    const candidate = new Date(now);
    candidate.setHours(0, 0, 0, 0);
    candidate.setMinutes(slot.minuteOfDay);
    if (candidate.getTime() <= now.getTime()) {
      candidate.setDate(candidate.getDate() + 1);
    }
    return candidate.toISOString();
  }
  if (cadence.kind === "weekly") {
    const weekdays = cadence.weekdays ?? [];
    if (weekdays.length === 0) return null;
    const windowNames = new Set(cadence.windows ?? []);
    const startMinute =
      definition.windowPolicy.windows
        .filter((window) => windowNames.has(window.name))
        .sort((a, b) => a.startMinute - b.startMinute)[0]?.startMinute ?? 0;
    const candidate = new Date(now);
    for (let offset = 0; offset < 8; offset += 1) {
      const probe = new Date(candidate);
      probe.setDate(candidate.getDate() + offset);
      probe.setHours(0, 0, 0, 0);
      probe.setMinutes(startMinute);
      if (
        weekdays.includes(probe.getDay()) &&
        probe.getTime() > now.getTime()
      ) {
        return probe.toISOString();
      }
    }
  }
  return null;
}

interface AddAlarmFormProps {
  saving: boolean;
  onSave: (input: {
    label: string;
    hour: number;
    minute: number;
    weekdays: ReadonlySet<number>;
  }) => void;
  onCancel: () => void;
}

function AddAlarmForm({ saving, onSave, onCancel }: AddAlarmFormProps) {
  const [time, setTime] = useState("07:00");
  const [label, setLabel] = useState("");
  const [weekdays, setWeekdays] = useState<Set<number>>(new Set());

  const toggleWeekday = (key: number) => {
    setWeekdays((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  };

  const handleSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const [hStr, mStr] = time.split(":");
    const hour = Number.parseInt(hStr ?? "", 10);
    const minute = Number.parseInt(mStr ?? "", 10);
    if (!Number.isFinite(hour) || hour < 0 || hour > 23) return;
    if (!Number.isFinite(minute) || minute < 0 || minute > 59) return;
    onSave({ label: label.trim(), hour, minute, weekdays });
  };

  return (
    <form
      onSubmit={handleSubmit}
      className="space-y-3 rounded-2xl border border-border/15 bg-card/30 p-4"
    >
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 text-[11px] font-medium text-muted">
          Time
          <input
            type="time"
            value={time}
            onChange={(e) => setTime(e.target.value)}
            className="rounded-lg border border-border/20 bg-bg-muted/30 px-3 py-1.5 text-base font-semibold text-txt tabular-nums focus:border-accent focus:outline-none"
            required
          />
        </label>
        <label className="flex min-w-[12rem] flex-1 flex-col gap-1 text-[11px] font-medium text-muted">
          Label (optional)
          <input
            type="text"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="Morning workout"
            className="rounded-lg border border-border/20 bg-bg-muted/30 px-3 py-1.5 text-sm text-txt focus:border-accent focus:outline-none"
            maxLength={120}
          />
        </label>
      </div>
      <div className="space-y-1">
        <span className="text-[11px] font-medium text-muted">Repeat</span>
        <div className="flex flex-wrap gap-1">
          {WEEKDAY_LABELS.map((day) => {
            const active = weekdays.has(day.key);
            return (
              <button
                key={day.key}
                type="button"
                onClick={() => toggleWeekday(day.key)}
                aria-pressed={active}
                title={day.long}
                className={[
                  "h-8 w-8 rounded-full border text-[11px] font-semibold transition-colors",
                  active
                    ? "border-accent bg-accent/20 text-accent"
                    : "border-border/20 bg-bg-muted/20 text-muted hover:bg-bg-muted/40",
                ].join(" ")}
              >
                {day.short}
              </button>
            );
          })}
        </div>
        <p className="pt-0.5 text-[10px] text-muted/70">
          {weekdays.size === 0
            ? "Single fire (next occurrence)."
            : weekdays.size === 7
              ? "Repeats every day."
              : `Repeats on ${weekdays.size} day${weekdays.size === 1 ? "" : "s"}.`}
        </p>
      </div>
      <div className="flex items-center justify-end gap-2 pt-1">
        <button
          type="button"
          onClick={onCancel}
          className="rounded-lg px-3 py-1.5 text-[11px] font-semibold text-muted hover:bg-bg-muted/40 hover:text-txt"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={saving}
          className="inline-flex items-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 text-[11px] font-semibold text-bg shadow-sm transition-colors hover:bg-accent/90 disabled:opacity-50"
        >
          {saving ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
          Save alarm
        </button>
      </div>
    </form>
  );
}

interface AlarmRowProps {
  entry: AlarmEntry;
  busyAction: "snooze" | "complete" | "delete" | null;
  optimisticState: "idle" | "snoozed" | "completed" | "deleted";
  onSnooze: (option: SnoozeOption) => void;
  onComplete: () => void;
  onCustomSnooze: () => void;
  onDelete: () => void;
}

function AlarmRow({
  entry,
  busyAction,
  optimisticState,
  onSnooze,
  onComplete,
  onCustomSnooze,
  onDelete,
}: AlarmRowProps) {
  const occurrenceId = entry.reminder?.occurrenceId ?? null;
  const time = entry.nextFireIso ? formatTimeOfDay(entry.nextFireIso) : null;
  const day = entry.nextFireIso ? formatNextFireDay(entry.nextFireIso) : "";
  const fading = optimisticState !== "idle";
  return (
    <div
      className={[
        "flex flex-wrap items-center gap-4 rounded-2xl border border-border/15 bg-card/30 px-4 py-3",
        fading ? "opacity-50" : "",
      ].join(" ")}
    >
      <div className="flex min-w-[10rem] items-baseline gap-1">
        {time ? (
          <>
            <span className="font-mono text-4xl font-light tabular-nums text-txt">
              {time.primary}
            </span>
            {time.suffix ? (
              <span className="text-xs font-medium uppercase text-muted">
                {time.suffix}
              </span>
            ) : null}
          </>
        ) : (
          <span className="text-2xl font-light text-muted">--:--</span>
        )}
      </div>
      <div className="min-w-0 flex-1 space-y-0.5">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="truncate text-sm font-medium text-txt">
            {entry.definition.title}
          </span>
          <span
            className="inline-flex items-center gap-0.5 rounded-full bg-bg-muted/40 px-1.5 py-0 text-[10px] font-medium text-muted"
            title={`Repeats: ${entry.recurrence}`}
          >
            <Repeat className="h-2.5 w-2.5" aria-hidden />
            {entry.recurrence}
          </span>
          <SourceBadge apple={entry.apple} />
          {optimisticState === "deleted" ? (
            <span className="rounded-full bg-rose-500/15 px-1.5 py-0 text-[10px] font-medium text-rose-300">
              deleted
            </span>
          ) : null}
        </div>
        <div className="text-[11px] text-muted">
          {day ? `${day} · ` : ""}
          {entry.nextFireIso
            ? formatRelative(entry.nextFireIso)
            : "No upcoming fire"}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        <SnoozeSplitButton
          occurrenceId={occurrenceId}
          busyAction={busyAction === "delete" ? null : busyAction}
          optimisticState={
            optimisticState === "deleted" ? "snoozed" : optimisticState
          }
          onSnooze={onSnooze}
          onCustomSnooze={onCustomSnooze}
        />
        <CompleteButton
          occurrenceId={occurrenceId}
          busyAction={busyAction === "delete" ? null : busyAction}
          optimisticState={
            optimisticState === "deleted" ? "completed" : optimisticState
          }
          onComplete={onComplete}
        />
        <button
          type="button"
          onClick={onDelete}
          disabled={busyAction !== null || optimisticState === "deleted"}
          className="inline-flex h-7 w-7 items-center justify-center rounded-lg border border-border/15 bg-bg-muted/30 text-rose-300 transition-colors hover:bg-rose-500/15 hover:text-rose-200 disabled:cursor-not-allowed disabled:opacity-40"
          aria-label="Delete alarm"
          title="Delete alarm"
        >
          {busyAction === "delete" ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Trash2 className="h-3.5 w-3.5" aria-hidden />
          )}
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Top-level section
// ---------------------------------------------------------------------------

export function LifeOpsRemindersSection() {
  const { t } = useApp();
  const { selection, select } = useLifeOpsSelection();
  const { chatAboutReminder } = useLifeOpsChatLauncher();

  const [tab, setTab] = useState<TabKey>("reminders");
  const [reminders, setReminders] = useState<LifeOpsActiveReminderView[]>([]);
  const [definitions, setDefinitions] = useState<LifeOpsDefinitionRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showAddAlarm, setShowAddAlarm] = useState(false);
  const [savingAlarm, setSavingAlarm] = useState(false);
  const [rowState, setRowState] = useState<
    Record<
      string,
      {
        busy: "snooze" | "complete" | "delete" | null;
        optimistic: "idle" | "snoozed" | "completed" | "deleted";
      }
    >
  >({});

  const setRowBusy = useCallback(
    (key: string, busy: "snooze" | "complete" | "delete" | null) => {
      setRowState((prev) => ({
        ...prev,
        [key]: { ...(prev[key] ?? { optimistic: "idle" }), busy },
      }));
    },
    [],
  );
  const setRowOptimistic = useCallback(
    (key: string, optimistic: "idle" | "snoozed" | "completed" | "deleted") => {
      setRowState((prev) => ({
        ...prev,
        [key]: { ...(prev[key] ?? { busy: null }), optimistic },
      }));
    },
    [],
  );

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [overview, defs] = await Promise.all([
        client.getLifeOpsOverview(),
        client.listLifeOpsDefinitions(),
      ]);
      setReminders(overview.reminders);
      setDefinitions(defs.definitions);
      setRowState({});
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

  const definitionById = useMemo(() => {
    const map = new Map<string, LifeOpsDefinitionRecord>();
    for (const record of definitions) {
      map.set(record.definition.id, record);
    }
    return map;
  }, [definitions]);

  const buckets = useMemo(() => {
    const map: Record<UrgencyKey, LifeOpsActiveReminderView[]> = {
      overdue: [],
      soon: [],
      today: [],
      later: [],
    };
    for (const reminder of reminders) {
      // Hide reminders whose backing definition is flagged as alarm — they
      // live in the Alarms tab.
      if (reminder.definitionId) {
        const record = definitionById.get(reminder.definitionId);
        const apple = readNativeAppleMetadata(record?.definition.metadata);
        if (apple?.kind === "alarm") continue;
      }
      map[classifyReminder(reminder.scheduledFor)].push(reminder);
    }
    for (const key of BUCKET_ORDER) {
      map[key].sort((a, b) => a.scheduledFor.localeCompare(b.scheduledFor));
    }
    return map;
  }, [reminders, definitionById]);

  const reminderCount = useMemo(
    () =>
      buckets.overdue.length +
      buckets.soon.length +
      buckets.today.length +
      buckets.later.length,
    [buckets],
  );

  const alarmEntries = useMemo(
    () => buildAlarmEntries(definitions, reminders),
    [definitions, reminders],
  );

  const handleSnooze = useCallback(
    async (
      rowKey: string,
      occurrenceId: string | null,
      option: SnoozeOption,
    ) => {
      if (!occurrenceId) return;
      setRowBusy(rowKey, "snooze");
      try {
        await client.snoozeLifeOpsOccurrence(occurrenceId, option.request);
        setRowOptimistic(rowKey, "snoozed");
        // Refetch shortly so the optimistic state can be reconciled.
        setTimeout(() => {
          void load();
        }, 400);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "Snooze failed.");
      } finally {
        setRowBusy(rowKey, null);
      }
    },
    [load, setRowBusy, setRowOptimistic],
  );

  const handleComplete = useCallback(
    async (rowKey: string, occurrenceId: string | null) => {
      if (!occurrenceId) return;
      setRowBusy(rowKey, "complete");
      try {
        await client.completeLifeOpsOccurrence(occurrenceId, {});
        setRowOptimistic(rowKey, "completed");
        setTimeout(() => {
          void load();
        }, 400);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "Complete failed.");
      } finally {
        setRowBusy(rowKey, null);
      }
    },
    [load, setRowBusy, setRowOptimistic],
  );

  const handleCustomSnooze = useCallback(
    async (rowKey: string, occurrenceId: string | null) => {
      if (!occurrenceId) return;
      const raw = window.prompt("Snooze for how many minutes?", "45");
      if (!raw) return;
      const minutes = Number.parseInt(raw, 10);
      if (!Number.isFinite(minutes) || minutes <= 0) {
        setError("Snooze duration must be a positive number of minutes.");
        return;
      }
      await handleSnooze(rowKey, occurrenceId, {
        key: `custom-${minutes}`,
        label: `+${minutes}m`,
        request: { minutes },
      });
    },
    [handleSnooze],
  );

  const handleDeleteAlarm = useCallback(
    async (definitionId: string) => {
      const rowKey = `alarm:${definitionId}`;
      setRowBusy(rowKey, "delete");
      try {
        await client.updateLifeOpsDefinition(definitionId, {
          status: "archived",
        });
        setRowOptimistic(rowKey, "deleted");
        setTimeout(() => {
          void load();
        }, 400);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "Delete failed.");
      } finally {
        setRowBusy(rowKey, null);
      }
    },
    [load, setRowBusy, setRowOptimistic],
  );

  const handleCreateAlarm = useCallback(
    async (input: {
      label: string;
      hour: number;
      minute: number;
      weekdays: ReadonlySet<number>;
    }) => {
      setSavingAlarm(true);
      setError(null);
      try {
        const timezone = defaultTimezone();
        const schedule = buildAlarmScheduleDraft(
          input.hour,
          input.minute,
          input.weekdays,
          timezone,
        );
        const title =
          input.label.length > 0
            ? input.label
            : `Alarm ${String(input.hour).padStart(2, "0")}:${String(input.minute).padStart(2, "0")}`;
        const request: CreateLifeOpsDefinitionRequest = {
          kind: "task",
          title,
          description: "Eliza alarm.",
          originalIntent: title,
          timezone,
          priority: 1,
          cadence: schedule.cadence,
          ...(schedule.windowPolicy
            ? { windowPolicy: schedule.windowPolicy }
            : {}),
          source: "lifeops_ui_alarm",
          metadata: {
            [LIFEOPS_ALARM_METADATA_KEY]: true,
            ...(schedule.nativeAppleSyncEligible
              ? {
                  [NATIVE_APPLE_REMINDER_METADATA_KEY]: {
                    kind: "alarm",
                    provider: "apple_reminders",
                    reminderId: null,
                    source: "heuristic",
                  },
                }
              : {}),
          },
          reminderPlan: {
            steps: [
              {
                channel: "in_app",
                offsetMinutes: 0,
                label: "Alarm",
              },
            ],
          },
        };
        await client.createLifeOpsDefinition(request);
        setShowAddAlarm(false);
        await load();
      } catch (cause) {
        setError(
          cause instanceof Error ? cause.message : "Failed to create alarm.",
        );
      } finally {
        setSavingAlarm(false);
      }
    },
    [load],
  );

  return (
    <div className="space-y-4" data-testid="lifeops-reminders">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <h2 className="text-base font-semibold tracking-tight text-txt">
            {t("lifeopsreminders.title", { defaultValue: "Reminders" })}
          </h2>
          <span className="rounded-full bg-bg-muted/40 px-2 py-0.5 text-[10px] font-medium text-muted tabular-nums">
            {tab === "reminders" ? reminderCount : alarmEntries.length}
          </span>
        </div>
        <div className="flex items-center gap-2">
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

      <div
        role="tablist"
        className="inline-flex items-center gap-1 rounded-lg border border-border/15 bg-bg-muted/20 p-0.5 text-[11px] font-semibold"
      >
        <button
          type="button"
          role="tab"
          aria-selected={tab === "reminders"}
          onClick={() => setTab("reminders")}
          className={[
            "inline-flex items-center gap-1.5 rounded-md px-3 py-1 transition-colors",
            tab === "reminders"
              ? "bg-card text-txt shadow-sm"
              : "text-muted hover:text-txt",
          ].join(" ")}
        >
          <Bell className="h-3 w-3" aria-hidden />
          Reminders
          <span className="rounded-full bg-bg-muted/50 px-1.5 text-[10px] tabular-nums text-muted">
            {reminderCount}
          </span>
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === "alarms"}
          onClick={() => setTab("alarms")}
          className={[
            "inline-flex items-center gap-1.5 rounded-md px-3 py-1 transition-colors",
            tab === "alarms"
              ? "bg-card text-txt shadow-sm"
              : "text-muted hover:text-txt",
          ].join(" ")}
        >
          <AlarmClock className="h-3 w-3" aria-hidden />
          Alarms
          <span className="rounded-full bg-bg-muted/50 px-1.5 text-[10px] tabular-nums text-muted">
            {alarmEntries.length}
          </span>
        </button>
      </div>

      {error ? (
        <div className="rounded-2xl border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-300">
          {error}
        </div>
      ) : null}

      {tab === "reminders" ? (
        <RemindersTabBody
          loading={loading}
          buckets={buckets}
          reminderCount={reminderCount}
          definitionById={definitionById}
          rowState={rowState}
          selection={selection}
          select={select}
          chatAboutReminder={chatAboutReminder}
          onSnooze={handleSnooze}
          onComplete={handleComplete}
          onCustomSnooze={handleCustomSnooze}
          loadingLabel={t("lifeopsreminders.loading", {
            defaultValue: "Loading reminders…",
          })}
          emptyLabel={t("lifeopsreminders.empty", {
            defaultValue: "All clear. No active reminders.",
          })}
        />
      ) : (
        <AlarmsTabBody
          loading={loading}
          alarmEntries={alarmEntries}
          rowState={rowState}
          showAddAlarm={showAddAlarm}
          savingAlarm={savingAlarm}
          onSnooze={handleSnooze}
          onComplete={handleComplete}
          onCustomSnooze={handleCustomSnooze}
          onDelete={handleDeleteAlarm}
          onToggleAdd={() => setShowAddAlarm((prev) => !prev)}
          onSaveAlarm={handleCreateAlarm}
          onCancelAdd={() => setShowAddAlarm(false)}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tab body components
// ---------------------------------------------------------------------------

type RowStateMap = Record<
  string,
  {
    busy: "snooze" | "complete" | "delete" | null;
    optimistic: "idle" | "snoozed" | "completed" | "deleted";
  }
>;

interface RemindersTabBodyProps {
  loading: boolean;
  buckets: Record<UrgencyKey, LifeOpsActiveReminderView[]>;
  reminderCount: number;
  definitionById: Map<string, LifeOpsDefinitionRecord>;
  rowState: RowStateMap;
  selection: LifeOpsSelection;
  select: (next: { reminderId: string; eventId: string | null }) => void;
  chatAboutReminder: (reminder: LifeOpsActiveReminderView) => void;
  onSnooze: (
    rowKey: string,
    occurrenceId: string | null,
    option: SnoozeOption,
  ) => void;
  onComplete: (rowKey: string, occurrenceId: string | null) => void;
  onCustomSnooze: (rowKey: string, occurrenceId: string | null) => void;
  loadingLabel: string;
  emptyLabel: string;
}

function RemindersTabBody({
  loading,
  buckets,
  reminderCount,
  definitionById,
  rowState,
  selection,
  select,
  chatAboutReminder,
  onSnooze,
  onComplete,
  onCustomSnooze,
  loadingLabel,
  emptyLabel,
}: RemindersTabBodyProps) {
  if (loading && reminderCount === 0) {
    return (
      <div className="flex items-center gap-2 py-6 text-xs text-muted">
        <Loader2 className="h-4 w-4 animate-spin" />
        {loadingLabel}
      </div>
    );
  }
  if (reminderCount === 0) {
    return (
      <div className="rounded-2xl border border-border/12 bg-card/12 px-4 py-10 text-center text-xs text-muted">
        {emptyLabel}
      </div>
    );
  }
  return (
    <div className="space-y-4">
      {BUCKET_ORDER.map((urgency) => {
        const bucket = buckets[urgency];
        if (bucket.length === 0) return null;
        return (
          <div key={urgency} className="space-y-1.5">
            <BucketHeader urgency={urgency} count={bucket.length} />
            <div className="overflow-hidden rounded-2xl border border-border/12 bg-card/12">
              {bucket.map((reminder) => {
                const rowKey = `${reminder.ownerType}:${reminder.ownerId}:${reminder.stepIndex}`;
                const record = reminder.definitionId
                  ? definitionById.get(reminder.definitionId)
                  : null;
                const apple = readNativeAppleMetadata(
                  record?.definition.metadata,
                );
                const recurrence = describeRecurrence(
                  record?.definition.cadence,
                );
                const isSelected = selection.reminderId === reminder.ownerId;
                const state = rowState[rowKey] ?? {
                  busy: null,
                  optimistic: "idle",
                };
                return (
                  <ReminderRow
                    key={rowKey}
                    reminder={reminder}
                    urgency={urgency}
                    isSelected={isSelected}
                    apple={apple}
                    recurrence={recurrence}
                    busyAction={state.busy === "delete" ? null : state.busy}
                    optimisticState={
                      state.optimistic === "deleted" ? "idle" : state.optimistic
                    }
                    onSelect={() =>
                      select({
                        reminderId: reminder.ownerId,
                        eventId: reminder.eventId ?? null,
                      })
                    }
                    onChat={() => chatAboutReminder(reminder)}
                    onSnooze={(option) =>
                      onSnooze(rowKey, reminder.occurrenceId, option)
                    }
                    onComplete={() => onComplete(rowKey, reminder.occurrenceId)}
                    onCustomSnooze={() =>
                      onCustomSnooze(rowKey, reminder.occurrenceId)
                    }
                  />
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}

interface AlarmsTabBodyProps {
  loading: boolean;
  alarmEntries: AlarmEntry[];
  rowState: RowStateMap;
  showAddAlarm: boolean;
  savingAlarm: boolean;
  onSnooze: (
    rowKey: string,
    occurrenceId: string | null,
    option: SnoozeOption,
  ) => void;
  onComplete: (rowKey: string, occurrenceId: string | null) => void;
  onCustomSnooze: (rowKey: string, occurrenceId: string | null) => void;
  onDelete: (definitionId: string) => void;
  onToggleAdd: () => void;
  onSaveAlarm: (input: {
    label: string;
    hour: number;
    minute: number;
    weekdays: ReadonlySet<number>;
  }) => void;
  onCancelAdd: () => void;
}

function AlarmsTabBody({
  loading,
  alarmEntries,
  rowState,
  showAddAlarm,
  savingAlarm,
  onSnooze,
  onComplete,
  onCustomSnooze,
  onDelete,
  onToggleAdd,
  onSaveAlarm,
  onCancelAdd,
}: AlarmsTabBodyProps) {
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-[11px] text-muted">
          Clock-time LifeOps alerts. One-time alarms sync to Reminders.app on
          macOS after native sync succeeds.
        </p>
        <button
          type="button"
          onClick={onToggleAdd}
          className="inline-flex items-center gap-1 rounded-lg border border-border/15 bg-bg-muted/30 px-2 py-1 text-[11px] font-semibold text-muted transition-colors hover:bg-bg-muted/60 hover:text-txt"
        >
          <Plus className="h-3 w-3" aria-hidden />
          {showAddAlarm ? "Close" : "Add alarm"}
        </button>
      </div>

      {showAddAlarm ? (
        <AddAlarmForm
          saving={savingAlarm}
          onSave={onSaveAlarm}
          onCancel={onCancelAdd}
        />
      ) : null}

      {loading && alarmEntries.length === 0 ? (
        <div className="flex items-center gap-2 py-6 text-xs text-muted">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading alarms…
        </div>
      ) : null}

      {!loading && alarmEntries.length === 0 ? (
        <div className="rounded-2xl border border-border/12 bg-card/12 px-4 py-10 text-center text-xs text-muted">
          No alarms yet. Click “Add alarm” to schedule one.
        </div>
      ) : null}

      {alarmEntries.length > 0 ? (
        <div className="space-y-2">
          {alarmEntries.map((entry) => {
            const rowKey = `alarm:${entry.definition.id}`;
            const state = rowState[rowKey] ?? {
              busy: null,
              optimistic: "idle",
            };
            return (
              <AlarmRow
                key={entry.definition.id}
                entry={entry}
                busyAction={state.busy}
                optimisticState={state.optimistic}
                onSnooze={(option) =>
                  onSnooze(rowKey, entry.reminder?.occurrenceId ?? null, option)
                }
                onComplete={() =>
                  onComplete(rowKey, entry.reminder?.occurrenceId ?? null)
                }
                onCustomSnooze={() =>
                  onCustomSnooze(rowKey, entry.reminder?.occurrenceId ?? null)
                }
                onDelete={() => onDelete(entry.definition.id)}
              />
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
