import type { UUID } from "@elizaos/core";
import {
  type NormalizedTriggerDraft,
  TRIGGER_SCHEMA_VERSION,
  type TriggerConfig,
  type TriggerKind,
  type TriggerTaskMetadata,
  type TriggerType,
  type TriggerWakeMode,
} from "./types.ts";

export const MIN_TRIGGER_INTERVAL_MS = 60_000;
export const MAX_TRIGGER_INTERVAL_MS = 31 * 24 * 60 * 60 * 1000;
export const DISABLED_TRIGGER_INTERVAL_MS = 365 * 24 * 60 * 60 * 1000;
export const MAX_TRIGGER_RUN_HISTORY = 100;

const CRON_FIELDS = 5;
const CRON_SCAN_WINDOW_MS = 366 * 24 * 60 * 60 * 1000;
const CRON_MINUTE_MS = 60_000;

interface CronRange {
  min: number;
  max: number;
}

interface CronSchedule {
  minute: Set<number>;
  hour: Set<number>;
  dayOfMonth: Set<number>;
  month: Set<number>;
  dayOfWeek: Set<number>;
}

const CRON_RANGES: readonly [
  CronRange,
  CronRange,
  CronRange,
  CronRange,
  CronRange,
] = [
  { min: 0, max: 59 },
  { min: 0, max: 23 },
  { min: 1, max: 31 },
  { min: 1, max: 12 },
  { min: 0, max: 6 },
];

export interface TriggerTiming {
  updatedAt: number;
  updateIntervalMs: number;
  nextRunAtMs: number;
}

interface DraftInput {
  displayName?: string;
  instructions?: string;
  triggerType?: TriggerType;
  wakeMode?: TriggerWakeMode;
  enabled?: boolean;
  createdBy?: string;
  timezone?: string;
  intervalMs?: number;
  scheduledAtIso?: string;
  cronExpression?: string;
  eventKind?: string;
  maxRuns?: number;
  kind?: TriggerKind;
  workflowId?: string;
  workflowName?: string;
}

function parseInteger(raw: string): number | null {
  if (!/^-?\d+$/.test(raw)) return null;
  const value = Number(raw);
  if (!Number.isFinite(value)) return null;
  return value;
}

function clamp(value: number, min: number, max: number): number {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

export function normalizeText(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function parseCronPart(part: string, range: CronRange): Set<number> | null {
  const output = new Set<number>();
  const chunks = part.split(",");

  for (const chunkRaw of chunks) {
    const chunk = chunkRaw.trim();
    if (!chunk) return null;

    const [baseRaw, stepRaw, extraStep] = chunk.split("/");
    if (baseRaw === undefined || extraStep !== undefined) return null;
    const step = stepRaw === undefined ? 1 : parseInteger(stepRaw.trim());
    if (step === null || step <= 0) return null;

    const base = baseRaw.trim();
    if (base === "*") {
      for (let value = range.min; value <= range.max; value += step) {
        output.add(value);
      }
      continue;
    }

    const [rangeStartRaw, rangeEndRaw, extraRange] = base.split("-");
    if (rangeStartRaw === undefined || extraRange !== undefined) return null;
    if (rangeEndRaw === undefined) {
      const single = parseInteger(rangeStartRaw.trim());
      if (single === null) return null;
      if (single < range.min || single > range.max) return null;
      output.add(single);
      continue;
    }

    const start = parseInteger(rangeStartRaw.trim());
    const end = parseInteger(rangeEndRaw.trim());
    if (start === null || end === null) return null;
    if (start > end) return null;
    if (start < range.min || end > range.max) return null;
    for (let value = start; value <= end; value += step) {
      output.add(value);
    }
  }

  return output.size > 0 ? output : null;
}

export function parseCronExpression(expression: string): CronSchedule | null {
  const trimmed = expression.trim();
  if (!trimmed) return null;
  const parts = trimmed.split(/\s+/);
  if (parts.length !== CRON_FIELDS) return null;

  const [minuteExpr, hourExpr, dayOfMonthExpr, monthExpr, dayOfWeekExpr] =
    parts;
  if (
    minuteExpr === undefined ||
    hourExpr === undefined ||
    dayOfMonthExpr === undefined ||
    monthExpr === undefined ||
    dayOfWeekExpr === undefined
  ) {
    return null;
  }

  const minute = parseCronPart(minuteExpr, CRON_RANGES[0]);
  const hour = parseCronPart(hourExpr, CRON_RANGES[1]);
  const dayOfMonth = parseCronPart(dayOfMonthExpr, CRON_RANGES[2]);
  const month = parseCronPart(monthExpr, CRON_RANGES[3]);
  const dayOfWeek = parseCronPart(dayOfWeekExpr, CRON_RANGES[4]);

  if (!minute || !hour || !dayOfMonth || !month || !dayOfWeek) {
    return null;
  }

  return {
    minute,
    hour,
    dayOfMonth,
    month,
    dayOfWeek,
  };
}

function cronMatchesUTC(schedule: CronSchedule, candidateMs: number): boolean {
  const candidate = new Date(candidateMs);
  return (
    schedule.minute.has(candidate.getUTCMinutes()) &&
    schedule.hour.has(candidate.getUTCHours()) &&
    schedule.dayOfMonth.has(candidate.getUTCDate()) &&
    schedule.month.has(candidate.getUTCMonth() + 1) &&
    schedule.dayOfWeek.has(candidate.getUTCDay())
  );
}

function getTimezoneOffsetMs(
  timezone: string | undefined,
  atMs: number,
): number {
  if (!timezone || timezone === "UTC") return 0;
  try {
    const formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    });
    const parts = formatter.formatToParts(new Date(atMs));
    const get = (type: string): number => {
      const part = parts.find((p) => p.type === type);
      return part ? Number(part.value) : 0;
    };
    const tzDate = Date.UTC(
      get("year"),
      get("month") - 1,
      get("day"),
      get("hour"),
      get("minute"),
      get("second"),
    );
    return tzDate - atMs;
  } catch {
    return 0;
  }
}

function cronMatches(
  schedule: CronSchedule,
  candidateMs: number,
  timezone?: string,
): boolean {
  if (!timezone || timezone === "UTC") {
    return cronMatchesUTC(schedule, candidateMs);
  }
  const offsetMs = getTimezoneOffsetMs(timezone, candidateMs);
  const wallClockMs = candidateMs + offsetMs;
  return cronMatchesUTC(schedule, wallClockMs);
}

export function computeNextCronRunAtMs(
  expression: string,
  fromMs: number,
  timezone?: string,
): number | null {
  const schedule = parseCronExpression(expression);
  if (!schedule) return null;

  const start = Math.floor(fromMs / CRON_MINUTE_MS) * CRON_MINUTE_MS;
  const cutoff = start + CRON_SCAN_WINDOW_MS;
  for (
    let candidate = start + CRON_MINUTE_MS;
    candidate <= cutoff;
    candidate += CRON_MINUTE_MS
  ) {
    if (cronMatches(schedule, candidate, timezone)) {
      return candidate;
    }
  }
  return null;
}

export function parseScheduledAtIso(scheduledAtIso: string): number | null {
  const parsed = Date.parse(scheduledAtIso);
  if (!Number.isFinite(parsed)) return null;
  return parsed;
}

export function normalizeTriggerIntervalMs(intervalMs: number): number {
  if (!Number.isFinite(intervalMs)) return MIN_TRIGGER_INTERVAL_MS;
  const rounded = Math.floor(intervalMs);
  return clamp(rounded, MIN_TRIGGER_INTERVAL_MS, MAX_TRIGGER_INTERVAL_MS);
}

export function resolveTriggerTiming(
  trigger: TriggerConfig,
  nowMs: number,
): TriggerTiming | null {
  if (!trigger.enabled) return null;

  if (trigger.triggerType === "interval") {
    const intervalMs = normalizeTriggerIntervalMs(trigger.intervalMs ?? 0);
    return {
      updatedAt: nowMs,
      updateIntervalMs: intervalMs,
      nextRunAtMs: nowMs + intervalMs,
    };
  }

  if (trigger.triggerType === "once") {
    const scheduledAt = trigger.scheduledAtIso
      ? parseScheduledAtIso(trigger.scheduledAtIso)
      : null;
    if (scheduledAt === null) return null;
    const nextRunAtMs = Math.max(nowMs, scheduledAt);
    return {
      updatedAt: nowMs,
      updateIntervalMs: Math.max(0, nextRunAtMs - nowMs),
      nextRunAtMs,
    };
  }

  if (trigger.triggerType === "event") {
    return {
      updatedAt: nowMs,
      updateIntervalMs: DISABLED_TRIGGER_INTERVAL_MS,
      nextRunAtMs: nowMs + DISABLED_TRIGGER_INTERVAL_MS,
    };
  }

  const nextRunAtMs = trigger.cronExpression
    ? computeNextCronRunAtMs(trigger.cronExpression, nowMs, trigger.timezone)
    : null;
  if (nextRunAtMs === null) return null;
  return {
    updatedAt: nowMs,
    updateIntervalMs: Math.max(0, nextRunAtMs - nowMs),
    nextRunAtMs,
  };
}

export function buildTriggerMetadata(params: {
  existingMetadata?: TriggerTaskMetadata;
  trigger: TriggerConfig;
  nowMs: number;
}): TriggerTaskMetadata | null {
  const timing = resolveTriggerTiming(params.trigger, params.nowMs);
  if (!timing) return null;

  return {
    ...(params.existingMetadata ?? {}),
    blocking: true,
    updatedAt: timing.updatedAt,
    updateInterval: timing.updateIntervalMs,
    trigger: {
      ...params.trigger,
      nextRunAtMs: timing.nextRunAtMs,
    },
  };
}

export function buildTriggerDedupeKey(parts: {
  triggerType: TriggerType;
  instructions: string;
  intervalMs?: number;
  scheduledAtIso?: string;
  cronExpression?: string;
  eventKind?: string;
  wakeMode: TriggerWakeMode;
  kind?: TriggerKind;
  workflowId?: string;
}): string {
  // Phase 2E: every persisted trigger is `kind: "workflow"`. Stale
  // `kind: "text"` records are tolerated only on read (legacy hash) until
  // the boot migration rewrites them.
  const effectiveKind: TriggerKind = parts.kind ?? "workflow";
  const normalizedParts = [
    parts.triggerType,
    normalizeText(parts.instructions).toLowerCase(),
    String(parts.intervalMs ?? ""),
    parts.scheduledAtIso ?? "",
    parts.cronExpression ?? "",
    parts.eventKind ?? "",
    parts.wakeMode,
  ];
  if (effectiveKind === "workflow") {
    normalizedParts.push(effectiveKind, parts.workflowId ?? "");
  }
  const normalized = normalizedParts.join("|");
  let hash = 5381;
  for (const char of normalized) {
    hash = (hash * 33) ^ char.charCodeAt(0);
  }
  return `trigger-${Math.abs(hash >>> 0).toString(16)}`;
}

export function buildTriggerConfig(params: {
  draft: NormalizedTriggerDraft;
  triggerId: UUID;
  previous?: TriggerConfig;
}): TriggerConfig {
  const previous = params.previous;
  return {
    version: TRIGGER_SCHEMA_VERSION,
    triggerId: params.triggerId,
    displayName: params.draft.displayName,
    instructions: params.draft.instructions,
    triggerType: params.draft.triggerType,
    enabled: params.draft.enabled,
    wakeMode: params.draft.wakeMode,
    createdBy: params.draft.createdBy,
    timezone: params.draft.timezone,
    intervalMs:
      params.draft.triggerType === "interval"
        ? normalizeTriggerIntervalMs(params.draft.intervalMs ?? 0)
        : undefined,
    scheduledAtIso:
      params.draft.triggerType === "once"
        ? params.draft.scheduledAtIso
        : undefined,
    cronExpression:
      params.draft.triggerType === "cron"
        ? params.draft.cronExpression
        : undefined,
    eventKind:
      params.draft.triggerType === "event" ? params.draft.eventKind : undefined,
    maxRuns: params.draft.maxRuns,
    runCount: previous?.runCount ?? 0,
    dedupeKey: buildTriggerDedupeKey({
      triggerType: params.draft.triggerType,
      instructions: params.draft.instructions,
      intervalMs: params.draft.intervalMs,
      scheduledAtIso: params.draft.scheduledAtIso,
      cronExpression: params.draft.cronExpression,
      eventKind: params.draft.eventKind,
      wakeMode: params.draft.wakeMode,
      kind: params.draft.kind,
      workflowId: params.draft.workflowId,
    }),
    nextRunAtMs: previous?.nextRunAtMs,
    lastRunAtIso: previous?.lastRunAtIso,
    lastStatus: previous?.lastStatus,
    lastError: previous?.lastError,
    kind: params.draft.kind,
    workflowId: params.draft.workflowId,
    workflowName: params.draft.workflowName,
  };
}

export function normalizeTriggerDraft(params: {
  input: DraftInput;
  fallback: {
    displayName: string;
    instructions: string;
    triggerType: TriggerType;
    wakeMode: TriggerWakeMode;
    enabled: boolean;
    createdBy: string;
  };
}): { draft?: NormalizedTriggerDraft; error?: string } {
  const kind: TriggerKind | undefined = params.input.kind;
  const workflowId = params.input.workflowId?.trim();
  const workflowName = params.input.workflowName?.trim();

  const displayName =
    normalizeText(params.input.displayName ?? "") ||
    normalizeText(params.fallback.displayName);

  // Workflow-kind triggers don't require user-provided instructions; we
  // synthesize them so display/dedupe logic downstream keeps working.
  let instructions: string;
  if (kind === "workflow") {
    if (!workflowId) {
      return { error: "workflowId is required for workflow triggers" };
    }
    const synthesized = `Run workflow ${workflowName ?? workflowId}`;
    instructions =
      normalizeText(params.input.instructions ?? "") ||
      normalizeText(params.fallback.instructions) ||
      normalizeText(synthesized);
  } else {
    instructions =
      normalizeText(params.input.instructions ?? "") ||
      normalizeText(params.fallback.instructions);
  }

  if (!displayName) {
    return { error: "displayName is required" };
  }
  if (!instructions) {
    return { error: "instructions is required" };
  }

  const triggerType =
    params.input.triggerType ?? params.fallback.triggerType ?? "interval";
  const wakeMode = params.input.wakeMode ?? params.fallback.wakeMode;
  const enabled = params.input.enabled ?? params.fallback.enabled;
  const createdBy = params.input.createdBy ?? params.fallback.createdBy;
  const timezone = params.input.timezone;
  const intervalMsRaw =
    typeof params.input.intervalMs === "number"
      ? params.input.intervalMs
      : undefined;
  const scheduledAtIso = params.input.scheduledAtIso?.trim();
  const cronExpression = params.input.cronExpression?.trim();
  const eventKind = params.input.eventKind?.trim();
  const maxRuns =
    typeof params.input.maxRuns === "number"
      ? Math.floor(params.input.maxRuns)
      : undefined;

  if (wakeMode !== "inject_now" && wakeMode !== "next_autonomy_cycle") {
    return { error: "wakeMode must be inject_now or next_autonomy_cycle" };
  }

  if (maxRuns !== undefined && maxRuns <= 0) {
    return { error: "maxRuns must be a positive integer" };
  }

  if (triggerType === "interval") {
    if (intervalMsRaw === undefined) {
      return { error: "intervalMs is required for interval triggers" };
    }
    const intervalMs = normalizeTriggerIntervalMs(intervalMsRaw);
    return {
      draft: {
        displayName,
        instructions,
        triggerType,
        wakeMode,
        enabled,
        createdBy,
        timezone,
        intervalMs,
        maxRuns,
        kind,
        workflowId,
        workflowName,
      },
    };
  }

  if (triggerType === "once") {
    if (!scheduledAtIso || parseScheduledAtIso(scheduledAtIso) === null) {
      return { error: "scheduledAtIso must be a valid ISO timestamp" };
    }
    return {
      draft: {
        displayName,
        instructions,
        triggerType,
        wakeMode,
        enabled,
        createdBy,
        timezone,
        scheduledAtIso,
        maxRuns,
        kind,
        workflowId,
        workflowName,
      },
    };
  }

  if (triggerType === "event") {
    if (!eventKind) {
      return { error: "eventKind is required for event triggers" };
    }
    return {
      draft: {
        displayName,
        instructions,
        triggerType,
        wakeMode,
        enabled,
        createdBy,
        timezone,
        eventKind,
        maxRuns,
        kind,
        workflowId,
        workflowName,
      },
    };
  }

  if (!cronExpression || !parseCronExpression(cronExpression)) {
    return { error: "cronExpression must be a valid 5-field cron expression" };
  }

  return {
    draft: {
      displayName,
      instructions,
      triggerType,
      wakeMode,
      enabled,
      createdBy,
      timezone,
      cronExpression,
      maxRuns,
      kind,
      workflowId,
      workflowName,
    },
  };
}
