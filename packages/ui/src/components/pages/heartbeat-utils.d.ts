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

import { parsePositiveInteger } from "@elizaos/shared";
import type { TranslateFn as AppTranslateFn } from "../../types";
export type TranslateFn = AppTranslateFn;
export declare const DURATION_UNITS: readonly [
  {
    readonly unit: "seconds";
    readonly ms: 1000;
    readonly labelKey: "heartbeatsview.durationUnitSeconds";
  },
  {
    readonly unit: "minutes";
    readonly ms: 60000;
    readonly labelKey: "heartbeatsview.durationUnitMinutes";
  },
  {
    readonly unit: "hours";
    readonly ms: 3600000;
    readonly labelKey: "heartbeatsview.durationUnitHours";
  },
  {
    readonly unit: "days";
    readonly ms: 86400000;
    readonly labelKey: "heartbeatsview.durationUnitDays";
  },
];
export type DurationUnit = (typeof DURATION_UNITS)[number]["unit"];
export declare function bestFitUnit(ms: number): {
  value: number;
  unit: DurationUnit;
};
export declare function durationToMs(value: number, unit: DurationUnit): number;
export declare function durationUnitLabel(
  unit: DurationUnit,
  t: TranslateFn,
): string;
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
export declare const emptyForm: TriggerFormState;
export interface HeartbeatTemplate {
  id: string;
  name: string;
  instructions: string;
  interval: string;
  unit: DurationUnit;
  nameKey?: string;
  instructionsKey?: string;
}
export declare const TEMPLATES_STORAGE_KEY = "elizaos:heartbeat-templates";
export declare const BUILT_IN_TEMPLATES: HeartbeatTemplate[];
export declare function isValidTemplate(v: unknown): v is HeartbeatTemplate;
export declare function loadUserTemplates(): HeartbeatTemplate[];
export declare function saveUserTemplates(templates: HeartbeatTemplate[]): void;
export declare function getTemplateName(
  template: HeartbeatTemplate,
  t: (key: string, options?: Record<string, unknown>) => string,
): string;
export declare function getTemplateInstructions(
  template: HeartbeatTemplate,
  t: (key: string, options?: Record<string, unknown>) => string,
): string;
export declare function railMonogram(label: string): string;
export { parsePositiveInteger };
export declare function scheduleLabel(
  trigger: TriggerSummary,
  t: TranslateFn,
  locale?: string,
): string;
export declare function humanizeEventKind(value: string): string;
export declare function formFromTrigger(
  trigger: TriggerSummary,
): TriggerFormState;
export declare function buildCreateRequest(
  form: TriggerFormState,
): CreateTriggerRequest;
export declare function buildUpdateRequest(
  form: TriggerFormState,
): UpdateTriggerRequest;
/**
 * Validate a 5-field cron expression using cron-parser.
 * Returns `{ ok: true, message: null }` on success or
 * `{ ok: false, message: string }` with the parser error message on failure.
 */
export declare function validateCronExpression(expr: string):
  | {
      ok: true;
      message: null;
    }
  | {
      ok: false;
      message: string;
    };
/**
 * Compute the next N fire dates for an interval trigger (ms between fires).
 * Returns an empty array when intervalMs is not positive.
 */
export declare function nextRunsForInterval(
  intervalMs: number,
  count: number,
  from?: Date,
): Date[];
/**
 * Compute the next N fire dates for a cron expression.
 * Returns an empty array when parsing fails.
 */
export declare function nextRunsForCron(
  expr: string,
  count: number,
  from?: Date,
): Date[];
/**
 * Validates the kind-specific payload fields only (no schedule validation).
 * Returns an error message when invalid, null when valid.
 */
export declare function validateTriggerKind(
  form: TriggerFormState,
  t: TranslateFn,
): string | null;
export declare function validateForm(
  form: TriggerFormState,
  t: TranslateFn,
): string | null;
export declare function toneForLastStatus(
  status?: string,
): "success" | "warning" | "danger" | "muted";
export declare function localizedExecutionStatus(
  status: string,
  t: TranslateFn,
): string;
//# sourceMappingURL=heartbeat-utils.d.ts.map
