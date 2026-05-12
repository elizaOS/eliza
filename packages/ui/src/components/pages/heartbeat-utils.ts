/**
 * heartbeat-utils.ts — Pure functions, types, and constants for the Heartbeats feature.
 *
 * Extracted from HeartbeatsView.tsx so tests and sibling components can
 * import them directly instead of duplicating logic.
 */

import type {
  CreateTriggerRequest,
  TriggerSummary,
  TriggerType,
  TriggerWakeMode,
  UpdateTriggerRequest,
} from "../../api/client";

export type TriggerKind = "text" | "workflow";

import { CronExpressionParser } from "cron-parser";
import type { TranslateFn as AppTranslateFn } from "../../types";
import { formatDurationMs } from "../../utils/format";

// ── Translation helper type ────────────────────────────────────────

export type TranslateFn = AppTranslateFn;

// ── Duration units ─────────────────────────────────────────────────

export const DURATION_UNITS = [
  {
    unit: "seconds",
    ms: 1000,
    labelKey: "heartbeatsview.durationUnitSeconds",
  },
  {
    unit: "minutes",
    ms: 60_000,
    labelKey: "heartbeatsview.durationUnitMinutes",
  },
  {
    unit: "hours",
    ms: 3_600_000,
    labelKey: "heartbeatsview.durationUnitHours",
  },
  {
    unit: "days",
    ms: 86_400_000,
    labelKey: "heartbeatsview.durationUnitDays",
  },
] as const;

export type DurationUnit = (typeof DURATION_UNITS)[number]["unit"];

export function bestFitUnit(ms: number): { value: number; unit: DurationUnit } {
  for (let i = DURATION_UNITS.length - 1; i >= 0; i -= 1) {
    const unit = DURATION_UNITS[i];
    if (ms >= unit.ms && ms % unit.ms === 0) {
      return { value: ms / unit.ms, unit: unit.unit };
    }
  }
  return { value: ms / 1000, unit: "seconds" };
}

export function durationToMs(value: number, unit: DurationUnit): number {
  const found = DURATION_UNITS.find((candidate) => candidate.unit === unit);
  return value * (found?.ms ?? 1000);
}

export function durationUnitLabel(unit: DurationUnit, t: TranslateFn): string {
  const found = DURATION_UNITS.find((candidate) => candidate.unit === unit);
  return found ? t(found.labelKey) : unit;
}

// ── Form state ─────────────────────────────────────────────────────

export interface TriggerFormState {
  displayName: string;
  instructions: string;
  kind: TriggerKind;
  workflowId: string;
  workflowName: string;
  triggerType: TriggerType;
  eventKind: string;
  wakeMode: TriggerWakeMode;
  scheduledAtIso: string;
  cronExpression: string;
  maxRuns: string;
  enabled: boolean;
  durationValue: string;
  durationUnit: DurationUnit;
}

export const emptyForm: TriggerFormState = {
  displayName: "",
  instructions: "",
  kind: "text",
  workflowId: "",
  workflowName: "",
  triggerType: "interval",
  eventKind: "message.received",
  wakeMode: "inject_now",
  scheduledAtIso: "",
  cronExpression: "0 * * * *",
  maxRuns: "",
  enabled: true,
  durationValue: "1",
  durationUnit: "hours",
};

// ── Template types & storage ───────────────────────────────────────

export interface HeartbeatTemplate {
  id: string;
  name: string;
  instructions: string;
  interval: string;
  unit: DurationUnit;
  nameKey?: string;
  instructionsKey?: string;
}

export const TEMPLATES_STORAGE_KEY = "elizaos:heartbeat-templates";

export const BUILT_IN_TEMPLATES: HeartbeatTemplate[] = [
  {
    id: "__builtin_crypto",
    name: "Check crypto prices",
    nameKey: "heartbeatsview.template.crypto.name",
    instructions:
      "Check the current prices of BTC, ETH, and SOL. Summarize any significant moves in the last hour.",
    instructionsKey: "heartbeatsview.template.crypto.instructions",
    interval: "30",
    unit: "minutes",
  },
  {
    id: "__builtin_journal",
    name: "Daily journal prompt",
    nameKey: "heartbeatsview.template.journal.name",
    instructions:
      "Write a brief, thoughtful journal prompt for the user based on current events or seasonal themes. Keep it under 2 sentences.",
    instructionsKey: "heartbeatsview.template.journal.instructions",
    interval: "24",
    unit: "hours",
  },
  {
    id: "__builtin_trending",
    name: "Trending topics digest",
    nameKey: "heartbeatsview.template.trending.name",
    instructions:
      "Scan for trending topics on crypto Twitter and tech news. Give a 3-bullet summary of what's worth paying attention to.",
    instructionsKey: "heartbeatsview.template.trending.instructions",
    interval: "4",
    unit: "hours",
  },
];

export function isValidTemplate(v: unknown): v is HeartbeatTemplate {
  if (typeof v !== "object" || v == null) return false;
  const t = v as Record<string, unknown>;
  return (
    typeof t.id === "string" &&
    typeof t.name === "string" &&
    typeof t.instructions === "string" &&
    typeof t.interval === "string" &&
    typeof t.unit === "string"
  );
}

export function loadUserTemplates(): HeartbeatTemplate[] {
  try {
    const raw = localStorage.getItem(TEMPLATES_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isValidTemplate);
  } catch {
    return [];
  }
}

export function saveUserTemplates(templates: HeartbeatTemplate[]): void {
  try {
    localStorage.setItem(TEMPLATES_STORAGE_KEY, JSON.stringify(templates));
  } catch {
    // localStorage full or unavailable
  }
}

export function getTemplateName(
  template: HeartbeatTemplate,
  t: (key: string, options?: Record<string, unknown>) => string,
): string {
  return template.nameKey
    ? t(template.nameKey, { defaultValue: template.name })
    : template.name;
}

export function getTemplateInstructions(
  template: HeartbeatTemplate,
  t: (key: string, options?: Record<string, unknown>) => string,
): string {
  return template.instructionsKey
    ? t(template.instructionsKey, { defaultValue: template.instructions })
    : template.instructions;
}

// ── Misc helpers ───────────────────────────────────────────────────

export function railMonogram(label: string): string {
  const words = label.trim().split(/\s+/).filter(Boolean);
  const initials = words
    .slice(0, 2)
    .map((word) => word[0]?.toUpperCase() ?? "")
    .join("");
  return (initials || label.slice(0, 1).toUpperCase() || "?").slice(0, 2);
}

export function parsePositiveInteger(value: string): number | undefined {
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) return undefined;
  const parsed = Number.parseInt(trimmed, 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

export function scheduleLabel(
  trigger: TriggerSummary,
  t: TranslateFn,
  locale?: string,
): string {
  if (trigger.triggerType === "interval") {
    return `${t("heartbeatsview.every")} ${formatDurationMs(trigger.intervalMs, { t })}`;
  }
  if (trigger.triggerType === "once") {
    return trigger.scheduledAtIso
      ? t("heartbeatsview.onceAt", {
          time: formatDateTime(trigger.scheduledAtIso, { locale }),
        })
      : t("heartbeatsview.once");
  }
  if (trigger.triggerType === "cron") {
    return `${t("heartbeatsview.cronPrefix")} ${trigger.cronExpression ?? "\u2014"}`;
  }
  if (trigger.triggerType === "event") {
    return `On ${humanizeEventKind(trigger.eventKind ?? "event")}`;
  }
  return trigger.triggerType;
}

export function humanizeEventKind(value: string): string {
  return value
    .trim()
    .replace(/[_-]+/g, ".")
    .split(".")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

export function formFromTrigger(trigger: TriggerSummary): TriggerFormState {
  const intervalMs = trigger.intervalMs ?? 3_600_000;
  const { value, unit } = bestFitUnit(intervalMs);
  return {
    displayName: trigger.displayName,
    instructions: trigger.instructions,
    kind: trigger.kind ?? "text",
    workflowId: trigger.workflowId ?? "",
    workflowName: trigger.workflowName ?? "",
    triggerType: trigger.triggerType,
    eventKind: trigger.eventKind ?? "message.received",
    wakeMode: trigger.wakeMode,
    scheduledAtIso: trigger.scheduledAtIso ?? "",
    cronExpression: trigger.cronExpression ?? "0 * * * *",
    maxRuns: trigger.maxRuns ? String(trigger.maxRuns) : "",
    enabled: trigger.enabled,
    durationValue: String(value),
    durationUnit: unit,
  };
}

export function buildCreateRequest(
  form: TriggerFormState,
): CreateTriggerRequest {
  const maxRuns = parsePositiveInteger(form.maxRuns);
  return {
    displayName: form.displayName.trim(),
    instructions: form.kind === "text" ? form.instructions.trim() : undefined,
    kind: form.kind,
    workflowId: form.kind === "workflow" ? form.workflowId : undefined,
    workflowName:
      form.kind === "workflow" ? form.workflowName || undefined : undefined,
    triggerType: form.triggerType,
    wakeMode: form.wakeMode,
    enabled: form.enabled,
    intervalMs:
      form.triggerType === "interval"
        ? durationToMs(Number(form.durationValue) || 1, form.durationUnit)
        : undefined,
    scheduledAtIso:
      form.triggerType === "once" ? form.scheduledAtIso.trim() : undefined,
    cronExpression:
      form.triggerType === "cron" ? form.cronExpression.trim() : undefined,
    eventKind: form.triggerType === "event" ? form.eventKind.trim() : undefined,
    maxRuns,
  };
}

export function buildUpdateRequest(
  form: TriggerFormState,
): UpdateTriggerRequest {
  return { ...buildCreateRequest(form) };
}

// ── Cron validation ────────────────────────────────────────────────

/**
 * Validate a 5-field cron expression using cron-parser.
 * Returns `{ ok: true, message: null }` on success or
 * `{ ok: false, message: string }` with the parser error message on failure.
 */
export function validateCronExpression(
  expr: string,
): { ok: true; message: null } | { ok: false; message: string } {
  const trimmed = expr.trim();
  if (!trimmed) return { ok: false, message: "Expression is empty" };
  try {
    CronExpressionParser.parse(trimmed);
    return { ok: true, message: null };
  } catch (err) {
    return {
      ok: false,
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

// ── Schedule preview ───────────────────────────────────────────────

/**
 * Compute the next N fire dates for an interval trigger (ms between fires).
 * Returns an empty array when intervalMs is not positive.
 */
export function nextRunsForInterval(
  intervalMs: number,
  count: number,
  from = new Date(),
): Date[] {
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) return [];
  const results: Date[] = [];
  for (let i = 1; i <= count; i++) {
    results.push(new Date(from.getTime() + intervalMs * i));
  }
  return results;
}

/**
 * Compute the next N fire dates for a cron expression.
 * Returns an empty array when parsing fails.
 */
export function nextRunsForCron(
  expr: string,
  count: number,
  from = new Date(),
): Date[] {
  const trimmed = expr.trim();
  if (!trimmed) return [];
  try {
    const schedule = CronExpressionParser.parse(trimmed, {
      currentDate: from,
    });
    const results: Date[] = [];
    for (let i = 0; i < count; i++) {
      results.push(schedule.next().toDate());
    }
    return results;
  } catch {
    return [];
  }
}

/**
 * Validates the kind-specific payload fields only (no schedule validation).
 * Returns an error message when invalid, null when valid.
 */
export function validateTriggerKind(
  form: TriggerFormState,
  t: TranslateFn,
): string | null {
  if (form.kind === "workflow") {
    if (!form.workflowId) {
      return t("triggers.workflowPlaceholder");
    }
    return null;
  }
  // kind === "text"
  if (!form.instructions.trim()) {
    return t("heartbeatsview.validationInstructionsRequired");
  }
  return null;
}

export function validateForm(
  form: TriggerFormState,
  t: TranslateFn,
): string | null {
  if (!form.displayName.trim()) {
    return t("heartbeatsview.validationDisplayNameRequired");
  }
  const kindError = validateTriggerKind(form, t);
  if (kindError) return kindError;
  if (form.triggerType === "interval") {
    const value = Number(form.durationValue);
    if (!Number.isFinite(value) || value <= 0) {
      return t("heartbeatsview.validationIntervalPositive");
    }
  }
  if (form.triggerType === "once") {
    const raw = form.scheduledAtIso.trim();
    if (!raw) return t("heartbeatsview.validationScheduledTimeRequired");
    if (!Number.isFinite(Date.parse(raw))) {
      return t("heartbeatsview.validationScheduledTimeInvalid");
    }
  }
  if (form.triggerType === "cron") {
    const cronTrimmed = form.cronExpression.trim();
    if (!cronTrimmed) return t("heartbeatsview.validationCronRequired");
    const cronResult = validateCronExpression(cronTrimmed);
    if (!cronResult.ok) {
      return `${t("triggers.cronError")} ${cronResult.message}`;
    }
  }
  if (form.triggerType === "event" && !form.eventKind.trim()) {
    return "Event is required.";
  }
  if (form.maxRuns.trim() && !parsePositiveInteger(form.maxRuns)) {
    return t("heartbeatsview.validationMaxRunsPositive");
  }
  return null;
}

export function toneForLastStatus(
  status?: string,
): "success" | "warning" | "danger" | "muted" {
  if (!status) return "muted";
  if (status === "success" || status === "completed") return "success";
  if (status === "skipped" || status === "queued") return "warning";
  if (status === "error" || status === "failed") return "danger";
  return "muted";
}

export function localizedExecutionStatus(
  status: string,
  t: TranslateFn,
): string {
  switch (status) {
    case "success":
      // Trigger "success" currently means the instruction was queued into the
      // autonomy room, not that the autonomous action already completed.
      return t("common.queued");
    case "completed":
      return t("common.completed");
    case "skipped":
      return t("heartbeatsview.statusSkipped");
    case "queued":
      return t("common.queued");
    case "error":
      return t("common.error");
    case "failed":
      return t("heartbeatsview.statusFailed");
    default:
      return status;
  }
}

// ── Private import used by scheduleLabel ───────────────────────────

import { formatDateTime } from "../../utils/format";
