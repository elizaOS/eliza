import type { UUID } from "@elizaos/core";
import {
  computeNextCronRunAtMs,
  DISABLED_TRIGGER_INTERVAL_MS,
  MAX_TRIGGER_INTERVAL_MS,
  MIN_TRIGGER_INTERVAL_MS,
  normalizeTriggerIntervalMs,
  parseCronExpression,
  parseScheduledAtIso,
  resolveTriggerTiming,
  type TriggerTiming,
} from "@elizaos/core";
import {
  type NormalizedTriggerDraft,
  TRIGGER_SCHEMA_VERSION,
  type TriggerConfig,
  type TriggerKind,
  type TriggerTaskMetadata,
  type TriggerType,
  type TriggerWakeMode,
} from "./types.ts";

export {
  computeNextCronRunAtMs,
  DISABLED_TRIGGER_INTERVAL_MS,
  MAX_TRIGGER_INTERVAL_MS,
  MIN_TRIGGER_INTERVAL_MS,
  normalizeTriggerIntervalMs,
  parseCronExpression,
  parseScheduledAtIso,
  resolveTriggerTiming,
  type TriggerTiming,
};

export const MAX_TRIGGER_RUN_HISTORY = 100;

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

export function normalizeText(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

export function buildTriggerMetadata(params: {
  existingMetadata?: TriggerTaskMetadata;
  trigger: TriggerConfig;
  nowMs: number;
}): TriggerTaskMetadata | null {
  const timing = resolveTriggerTiming(params.trigger, params.nowMs);
  if (!timing) return null;

  const existingMetadata = params.existingMetadata
    ? { ...params.existingMetadata }
    : {};

  return {
    ...existingMetadata,
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
  kind: TriggerKind;
  workflowId?: string;
}): string {
  const normalizedParts = [
    parts.triggerType,
    normalizeText(parts.instructions).toLowerCase(),
    String(parts.intervalMs ?? ""),
    parts.scheduledAtIso ?? "",
    parts.cronExpression ?? "",
    parts.eventKind ?? "",
    parts.wakeMode,
    parts.kind,
    parts.workflowId ?? "",
  ];
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
  const base = {
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
  } as const;

  if (params.draft.kind === "prompt") {
    return { ...base, kind: "prompt" };
  }
  // Workflow kind requires a real workflowId. `normalizeTriggerDraft` already
  // rejects a workflow draft without one, so reaching here without it means a
  // broken pipeline — fail loudly rather than persist an empty target.
  const { workflowId } = params.draft;
  if (!workflowId) {
    throw new Error(
      "buildTriggerConfig: workflow-kind trigger requires a workflowId",
    );
  }
  return {
    ...base,
    kind: "workflow",
    workflowId,
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
  const kind: TriggerKind = params.input.kind ?? "workflow";
  const workflowId =
    kind === "workflow" ? params.input.workflowId?.trim() : undefined;
  const workflowName =
    kind === "workflow" ? params.input.workflowName?.trim() : undefined;

  const displayName =
    normalizeText(params.input.displayName ?? "") ||
    normalizeText(params.fallback.displayName);

  if (kind === "workflow" && !workflowId) {
    return { error: "workflowId is required for workflow triggers" };
  }
  const synthesized =
    kind === "workflow"
      ? `Run workflow ${workflowName ?? workflowId}`
      : "Run prompt automation";
  const instructions =
    normalizeText(params.input.instructions ?? "") ||
    normalizeText(params.fallback.instructions) ||
    normalizeText(synthesized);

  if (!displayName) {
    return { error: "displayName is required" };
  }
  if (!instructions) {
    return { error: "instructions is required" };
  }

  const triggerType = params.input.triggerType ?? params.fallback.triggerType;
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
