import type {
  TriggerConfig,
  TriggerKind,
  TriggerLastStatus,
  TriggerRunRecord,
  TriggerType,
  TriggerWakeMode,
  UUID,
} from "@elizaos/core";

export {
  TRIGGER_SCHEMA_VERSION,
  type TriggerConfig,
  type TriggerKind,
  type TriggerLastStatus,
  type TriggerRunRecord,
  type TriggerType,
  type TriggerWakeMode,
} from "@elizaos/core";

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
  kind?: TriggerKind;
  workflowId?: string;
  workflowName?: string;
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
  kind?: TriggerKind;
  workflowId?: string;
  workflowName?: string;
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
  kind?: TriggerKind;
  workflowId?: string;
  workflowName?: string;
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
  kind?: TriggerKind;
  workflowId?: string;
  workflowName?: string;
}
