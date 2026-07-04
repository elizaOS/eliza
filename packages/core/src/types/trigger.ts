/**
 * Trigger-configuration types for scheduled and event-driven agent activations:
 * interval/once/cron/event triggers whose target is either a workflow dispatch or
 * a prompt-automation turn, plus per-run bookkeeping records. Consumed by the
 * trigger-scheduling service.
 */
import type { UUID } from "./primitives";

export const TRIGGER_SCHEMA_VERSION = 1 as const;

export type TriggerType = "interval" | "once" | "cron" | "event";
export type TriggerWakeMode = "inject_now" | "next_autonomy_cycle";
export type TriggerLastStatus = "success" | "error" | "skipped";

/**
 * A trigger's target: what fires when the schedule/event condition is met.
 * - `workflow` — dispatch the referenced workflow via WORKFLOW_DISPATCH.
 * - `prompt`   — inject the trigger's `instructions` as an agent turn (a
 *                "prompt automation"), via the prompt-runner / autonomy path.
 */
export type TriggerKind = "workflow" | "prompt";

/** Fields shared by every trigger regardless of kind. */
interface TriggerConfigBase {
	version: typeof TRIGGER_SCHEMA_VERSION;
	triggerId: UUID;
	displayName: string;
	instructions: string;
	triggerType: TriggerType;
	enabled: boolean;
	wakeMode: TriggerWakeMode;
	createdBy: string;
	timezone?: string;
	intervalMs?: number;
	scheduledAtIso?: string;
	cronExpression?: string;
	eventKind?: string;
	maxRuns?: number;
	runCount: number;
	nextRunAtMs?: number;
	lastRunAtIso?: string;
	lastStatus?: TriggerLastStatus;
	lastError?: string;
	dedupeKey?: string;
}

/** A trigger that runs a stored workflow definition. */
export interface WorkflowTriggerConfig extends TriggerConfigBase {
	kind: "workflow";
	workflowId: string;
	workflowName?: string;
}

/** A trigger that runs a free-form prompt as an agent turn (no node graph). */
export interface PromptTriggerConfig extends TriggerConfigBase {
	kind: "prompt";
}

/**
 * A trigger is a discriminated union on `kind`: `workflowId` exists only for
 * `kind === "workflow"`. Narrow on `kind` before reading target fields.
 */
export type TriggerConfig = WorkflowTriggerConfig | PromptTriggerConfig;

export interface TriggerRunRecord {
	triggerRunId: UUID;
	triggerId: UUID;
	taskId: UUID;
	startedAt: number;
	finishedAt: number;
	status: TriggerLastStatus;
	error?: string;
	latencyMs: number;
	source: "scheduler" | "manual" | "event";
	eventKind?: string;
}
