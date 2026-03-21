import type { UUID } from "@elizaos/core";

export const TRIGGER_SCHEMA_VERSION = 1 as const;

export type TriggerType = "interval" | "once" | "cron";
export type TriggerWakeMode = "inject_now" | "next_autonomy_cycle";
export type TriggerLastStatus = "success" | "error" | "skipped";

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
  maxRuns?: number;
  runCount: number;
  dedupeKey?: string;
  nextRunAtMs?: number;
  lastRunAtIso?: string;
  lastStatus?: TriggerLastStatus;
  lastError?: string;
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
  source: "scheduler" | "manual";
}

export interface TriggerTaskMetadata {
  updatedAt?: number;
  updateInterval?: number;
  blocking?: boolean;
  trigger?: TriggerConfig;
  triggerRuns?: TriggerRunRecord[];
  [key: string]:
    | string
    | number
    | boolean
    | string[]
    | number[]
    | Record<string, string | number | boolean>
    | undefined
    | TriggerConfig
    | TriggerRunRecord[];
}

export interface TriggerSummary {
  id: UUID;
  taskId: UUID;
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
  maxRuns?: number;
  runCount: number;
  nextRunAtMs?: number;
  lastRunAtIso?: string;
  lastStatus?: TriggerLastStatus;
  lastError?: string;
  updatedAt?: number;
  updateInterval?: number;
}

export interface TriggerHealthSnapshot {
  triggersEnabled: boolean;
  activeTriggers: number;
  disabledTriggers: number;
  totalExecutions: number;
  totalFailures: number;
  totalSkipped: number;
  lastExecutionAt?: number;
}

export interface CreateTriggerRequest {
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
  maxRuns?: number;
}

export interface UpdateTriggerRequest {
  displayName?: string;
  instructions?: string;
  triggerType?: TriggerType;
  wakeMode?: TriggerWakeMode;
  enabled?: boolean;
  timezone?: string;
  intervalMs?: number;
  scheduledAtIso?: string;
  cronExpression?: string;
  maxRuns?: number;
}

export interface NormalizedTriggerDraft {
  displayName: string;
  instructions: string;
  triggerType: TriggerType;
  wakeMode: TriggerWakeMode;
  enabled: boolean;
  createdBy: string;
  timezone?: string;
  intervalMs?: number;
  scheduledAtIso?: string;
  cronExpression?: string;
  maxRuns?: number;
}
