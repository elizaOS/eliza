import { computeNextCronRunAtMs } from "@elizaos/core";

import type { AnchorRegistry } from "../registries/anchor-registry.js";
import type {
  OwnerFactsView,
  ScheduledTask,
  ScheduledTaskStatus,
  ScheduledTaskTrigger,
} from "./types.js";

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;
const CRON_CATCHUP_WINDOW_MS = 36 * 60 * MINUTE_MS;

export interface ScheduledTaskDueContext {
  now: Date;
  ownerFacts?: OwnerFactsView;
  anchors?: AnchorRegistry | null;
}

export interface ScheduledTaskDueDecision {
  due: boolean;
  reason: string;
  occurrenceAtIso?: string;
}

function parseIsoMs(value: unknown): number | null {
  if (typeof value !== "string" || value.length === 0) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function isTerminalStatus(status: ScheduledTaskStatus): boolean {
  return (
    status === "completed" ||
    status === "skipped" ||
    status === "expired" ||
    status === "failed" ||
    status === "dismissed"
  );
}

export function isRecurringTrigger(trigger: ScheduledTaskTrigger): boolean {
  return (
    trigger.kind === "cron" ||
    trigger.kind === "interval" ||
    trigger.kind === "relative_to_anchor" ||
    trigger.kind === "during_window"
  );
}

function localParts(
  date: Date,
  timeZone: string,
): {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
} {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const parts = formatter.formatToParts(date);
  const read = (type: string): number =>
    Number(parts.find((part) => part.type === type)?.value ?? 0);
  return {
    year: read("year"),
    month: read("month"),
    day: read("day"),
    hour: read("hour") % 24,
    minute: read("minute"),
  };
}

function localDateKey(date: Date, timeZone: string): string {
  const parts = localParts(date, timeZone);
  return `${parts.year.toString().padStart(4, "0")}-${parts.month
    .toString()
    .padStart(2, "0")}-${parts.day.toString().padStart(2, "0")}`;
}

function minutesFromHHMM(value: string | undefined): number | null {
  if (!value) return null;
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value);
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

function localHHMMToIso(
  now: Date,
  hhmm: string | undefined,
  timeZone: string,
): string | null {
  const minutes = minutesFromHHMM(hhmm);
  if (minutes === null) return null;
  const parts = localParts(now, timeZone);
  const hour = Math.floor(minutes / 60);
  const minute = minutes % 60;
  const localAsUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    hour,
    minute,
  );
  const offsetFormatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    timeZoneName: "longOffset",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const offsetParts = offsetFormatter.formatToParts(new Date(localAsUtc));
  const offsetValue =
    offsetParts.find((part) => part.type === "timeZoneName")?.value ?? "GMT";
  const offsetMatch = /GMT([+-]\d{1,2})(?::?(\d{2}))?/.exec(offsetValue);
  let offsetMinutes = 0;
  if (offsetMatch) {
    const sign = offsetMatch[1]?.startsWith("-") ? -1 : 1;
    const hours = Math.abs(Number.parseInt(offsetMatch[1] ?? "0", 10));
    const minutesPart = Number.parseInt(offsetMatch[2] ?? "0", 10);
    offsetMinutes = sign * (hours * 60 + minutesPart);
  }
  return new Date(localAsUtc - offsetMinutes * MINUTE_MS).toISOString();
}

function metadataCreatedAtMs(task: ScheduledTask): number | null {
  return (
    parseIsoMs(task.metadata?.createdAtIso) ??
    parseIsoMs(task.metadata?.createdAt) ??
    parseIsoMs(task.metadata?.scheduledAtIso)
  );
}

function wasFiredOnOrAfter(task: ScheduledTask, occurrenceMs: number): boolean {
  const firedAtMs = parseIsoMs(task.state.firedAt);
  return firedAtMs !== null && firedAtMs >= occurrenceMs;
}

function scheduledOverrideDue(
  task: ScheduledTask,
  nowMs: number,
): ScheduledTaskDueDecision | null {
  if (task.state.status !== "scheduled") return null;
  const fireAtMs = parseIsoMs(task.state.firedAt);
  if (fireAtMs === null) return null;
  if (fireAtMs > nowMs) {
    return { due: false, reason: "scheduled_override_pending" };
  }
  return {
    due: true,
    reason: "scheduled_override_due",
    occurrenceAtIso: new Date(fireAtMs).toISOString(),
  };
}

function onceDue(
  task: ScheduledTask,
  trigger: Extract<ScheduledTaskTrigger, { kind: "once" }>,
  nowMs: number,
): ScheduledTaskDueDecision {
  if (task.state.firedAt) {
    return { due: false, reason: "once_already_fired" };
  }
  const atMs = parseIsoMs(trigger.atIso);
  if (atMs === null) return { due: false, reason: "once_invalid_at" };
  return atMs <= nowMs
    ? {
        due: true,
        reason: "once_due",
        occurrenceAtIso: new Date(atMs).toISOString(),
      }
    : { due: false, reason: "once_pending" };
}

function intervalDue(
  task: ScheduledTask,
  trigger: Extract<ScheduledTaskTrigger, { kind: "interval" }>,
  nowMs: number,
): ScheduledTaskDueDecision {
  if (!Number.isFinite(trigger.everyMinutes) || trigger.everyMinutes <= 0) {
    return { due: false, reason: "interval_invalid" };
  }
  const fromMs = parseIsoMs(trigger.from);
  const untilMs = parseIsoMs(trigger.until);
  if (fromMs !== null && nowMs < fromMs) {
    return { due: false, reason: "interval_before_from" };
  }
  if (untilMs !== null && nowMs > untilMs) {
    return { due: false, reason: "interval_after_until" };
  }
  const lastFireMs = parseIsoMs(task.state.firedAt);
  if (lastFireMs === null) {
    const firstMs = fromMs ?? nowMs;
    return firstMs <= nowMs
      ? {
          due: true,
          reason: "interval_first_due",
          occurrenceAtIso: new Date(firstMs).toISOString(),
        }
      : { due: false, reason: "interval_first_pending" };
  }
  const nextMs = lastFireMs + trigger.everyMinutes * MINUTE_MS;
  return nextMs <= nowMs
    ? {
        due: true,
        reason: "interval_due",
        occurrenceAtIso: new Date(nextMs).toISOString(),
      }
    : { due: false, reason: "interval_pending" };
}

function cronDue(
  task: ScheduledTask,
  trigger: Extract<ScheduledTaskTrigger, { kind: "cron" }>,
  nowMs: number,
): ScheduledTaskDueDecision {
  const baseMs =
    parseIsoMs(task.state.firedAt) ??
    metadataCreatedAtMs(task) ??
    nowMs - CRON_CATCHUP_WINDOW_MS;
  const nextMs = computeNextCronRunAtMs(trigger.expression, baseMs, trigger.tz);
  if (nextMs === null) return { due: false, reason: "cron_invalid" };
  return nextMs <= nowMs
    ? {
        due: true,
        reason: "cron_due",
        occurrenceAtIso: new Date(nextMs).toISOString(),
      }
    : { due: false, reason: "cron_pending" };
}

async function resolveAnchorIso(
  trigger: Extract<ScheduledTaskTrigger, { kind: "relative_to_anchor" }>,
  context: ScheduledTaskDueContext,
): Promise<string | null> {
  const ownerFacts = context.ownerFacts ?? {};
  const registryAnchor = context.anchors?.get(trigger.anchorKey) as {
    resolve?: (
      ctx: unknown,
    ) => Promise<{ atIso: string } | null> | { atIso: string } | null;
  } | null;
  if (typeof registryAnchor?.resolve === "function") {
    const resolved = await registryAnchor.resolve({
      nowIso: context.now.toISOString(),
      ownerFacts,
    });
    if (resolved?.atIso && Number.isFinite(Date.parse(resolved.atIso))) {
      return resolved.atIso;
    }
  }

  const timeZone = ownerFacts.timezone ?? "UTC";
  if (
    trigger.anchorKey === "wake.confirmed" ||
    trigger.anchorKey === "wake.observed" ||
    trigger.anchorKey === "morning.start"
  ) {
    return localHHMMToIso(
      context.now,
      ownerFacts.morningWindow?.start,
      timeZone,
    );
  }
  if (trigger.anchorKey === "bedtime.target") {
    return (
      localHHMMToIso(context.now, ownerFacts.eveningWindow?.end, timeZone) ??
      localHHMMToIso(context.now, "22:30", timeZone)
    );
  }
  if (trigger.anchorKey === "night.start") {
    return localHHMMToIso(
      context.now,
      ownerFacts.eveningWindow?.start,
      timeZone,
    );
  }
  if (trigger.anchorKey === "lunch.start") {
    return localHHMMToIso(context.now, "12:00", timeZone);
  }
  return null;
}

async function relativeAnchorDue(
  task: ScheduledTask,
  trigger: Extract<ScheduledTaskTrigger, { kind: "relative_to_anchor" }>,
  context: ScheduledTaskDueContext,
  nowMs: number,
): Promise<ScheduledTaskDueDecision> {
  const anchorIso = await resolveAnchorIso(trigger, context);
  const anchorMs = parseIsoMs(anchorIso);
  if (anchorMs === null) {
    return { due: false, reason: "anchor_unresolved" };
  }
  const occurrenceMs = anchorMs + trigger.offsetMinutes * MINUTE_MS;
  if (occurrenceMs > nowMs) {
    return { due: false, reason: "anchor_pending" };
  }
  if (wasFiredOnOrAfter(task, occurrenceMs)) {
    return { due: false, reason: "anchor_already_fired" };
  }
  return {
    due: true,
    reason: "anchor_due",
    occurrenceAtIso: new Date(occurrenceMs).toISOString(),
  };
}

function windowBoundsMinutes(
  windowKey: string,
  ownerFacts: OwnerFactsView,
): Array<{ name: string; start: number; end: number }> {
  const morningStart =
    minutesFromHHMM(ownerFacts.morningWindow?.start) ?? 6 * 60;
  const morningEnd = minutesFromHHMM(ownerFacts.morningWindow?.end) ?? 11 * 60;
  const eveningStart =
    minutesFromHHMM(ownerFacts.eveningWindow?.start) ?? 18 * 60;
  const eveningEnd = minutesFromHHMM(ownerFacts.eveningWindow?.end) ?? 22 * 60;
  const afternoonStart = morningEnd;
  const afternoonEnd = eveningStart;
  const windows: Record<
    string,
    Array<{ name: string; start: number; end: number }>
  > = {
    morning: [{ name: "morning", start: morningStart, end: morningEnd }],
    afternoon: [
      { name: "afternoon", start: afternoonStart, end: afternoonEnd },
    ],
    evening: [{ name: "evening", start: eveningStart, end: eveningEnd }],
    night: [
      { name: "night", start: eveningEnd, end: 24 * 60 },
      { name: "night", start: 0, end: morningStart },
    ],
    morning_or_night: [
      { name: "morning", start: morningStart, end: morningEnd },
      { name: "night", start: eveningEnd, end: 24 * 60 },
      { name: "night", start: 0, end: morningStart },
    ],
    morning_or_evening: [
      { name: "morning", start: morningStart, end: morningEnd },
      { name: "evening", start: eveningStart, end: eveningEnd },
    ],
  };
  return windows[windowKey] ?? [];
}

function duringWindowDue(
  task: ScheduledTask,
  trigger: Extract<ScheduledTaskTrigger, { kind: "during_window" }>,
  context: ScheduledTaskDueContext,
): ScheduledTaskDueDecision {
  const ownerFacts = context.ownerFacts ?? {};
  const timeZone = ownerFacts.timezone ?? "UTC";
  const parts = localParts(context.now, timeZone);
  const nowMinutes = parts.hour * 60 + parts.minute;
  const windows = windowBoundsMinutes(trigger.windowKey, ownerFacts);
  const active = windows.find(
    (window) => nowMinutes >= window.start && nowMinutes < window.end,
  );
  if (!active) return { due: false, reason: "window_inactive" };
  const fireKey = `${localDateKey(context.now, timeZone)}:${trigger.windowKey}:${active.name}`;
  if (task.metadata?.lastWindowFireKey === fireKey) {
    return { due: false, reason: "window_already_fired" };
  }
  return {
    due: true,
    reason: "window_due",
    occurrenceAtIso: context.now.toISOString(),
  };
}

export async function isScheduledTaskDue(
  task: ScheduledTask,
  context: ScheduledTaskDueContext,
): Promise<ScheduledTaskDueDecision> {
  if (task.state.status === "dismissed") {
    return { due: false, reason: "dismissed" };
  }
  if (
    isTerminalStatus(task.state.status) &&
    !isRecurringTrigger(task.trigger)
  ) {
    return { due: false, reason: "terminal_non_recurring" };
  }
  const nowMs = context.now.getTime();
  const override = scheduledOverrideDue(task, nowMs);
  if (override) return override;

  switch (task.trigger.kind) {
    case "once":
      return onceDue(task, task.trigger, nowMs);
    case "interval":
      return intervalDue(task, task.trigger, nowMs);
    case "cron":
      return cronDue(task, task.trigger, nowMs);
    case "relative_to_anchor":
      return relativeAnchorDue(task, task.trigger, context, nowMs);
    case "during_window":
      return duringWindowDue(task, task.trigger, context);
    case "manual":
      return { due: false, reason: "manual" };
    case "event":
      return { due: false, reason: "event_driven" };
    case "after_task":
      return { due: false, reason: "after_task_pipeline_driven" };
    default: {
      const exhaustive: never = task.trigger;
      return { due: false, reason: `unknown:${String(exhaustive)}` };
    }
  }
}

export function markWindowFireIfNeeded(
  task: ScheduledTask,
  context: ScheduledTaskDueContext,
): Record<string, unknown> | null {
  if (task.trigger.kind !== "during_window") return null;
  const ownerFacts = context.ownerFacts ?? {};
  const timeZone = ownerFacts.timezone ?? "UTC";
  const parts = localParts(context.now, timeZone);
  const nowMinutes = parts.hour * 60 + parts.minute;
  const active = windowBoundsMinutes(task.trigger.windowKey, ownerFacts).find(
    (window) => nowMinutes >= window.start && nowMinutes < window.end,
  );
  if (!active) return null;
  return {
    ...(task.metadata ?? {}),
    lastWindowFireKey: `${localDateKey(context.now, timeZone)}:${task.trigger.windowKey}:${active.name}`,
  };
}

export function isCompletionTimeoutDue(
  task: ScheduledTask,
  now: Date,
): ScheduledTaskDueDecision {
  if (task.state.status !== "fired") {
    return { due: false, reason: "not_fired" };
  }
  const followupAfterMinutes = task.completionCheck?.followupAfterMinutes;
  if (
    typeof followupAfterMinutes !== "number" ||
    !Number.isFinite(followupAfterMinutes) ||
    followupAfterMinutes <= 0
  ) {
    return { due: false, reason: "no_completion_timeout" };
  }
  const firedAtMs = parseIsoMs(task.state.firedAt);
  if (firedAtMs === null) {
    return { due: false, reason: "missing_fired_at" };
  }
  const timeoutMs = firedAtMs + followupAfterMinutes * MINUTE_MS;
  return timeoutMs <= now.getTime()
    ? {
        due: true,
        reason: "completion_timeout_due",
        occurrenceAtIso: new Date(timeoutMs).toISOString(),
      }
    : { due: false, reason: "completion_timeout_pending" };
}

export function expectedReplyKindForTask(
  task: ScheduledTask,
): "any" | "yes_no" | "approval" | "free_form" {
  if (task.kind === "approval" || task.completionCheck?.kind === "approval") {
    return "approval";
  }
  if (task.completionCheck?.kind === "user_acknowledged") {
    return "yes_no";
  }
  return "free_form";
}

export function pendingPromptRoomIdForTask(task: ScheduledTask): string | null {
  const metadataRoomId = task.metadata?.pendingPromptRoomId;
  if (typeof metadataRoomId === "string" && metadataRoomId.length > 0) {
    return metadataRoomId;
  }
  const target = task.output?.target;
  if (typeof target !== "string") return null;
  const [channelKey, roomId] = target.split(":", 2);
  if (channelKey === "in_app" && roomId) return roomId;
  return null;
}
