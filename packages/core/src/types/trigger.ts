import type { UUID } from "./primitives";

export const TRIGGER_SCHEMA_VERSION = 1 as const;

export type TriggerType = "interval" | "once" | "cron" | "event";
export type TriggerWakeMode = "inject_now" | "next_autonomy_cycle";
export type TriggerLastStatus = "success" | "error" | "skipped";
export type TriggerKind = "text" | "workflow";

export interface TriggerConfig {
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
	// When undefined, treat as "text" for back-compat.
	kind?: TriggerKind;
	workflowId?: string;
	workflowName?: string;
}

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
