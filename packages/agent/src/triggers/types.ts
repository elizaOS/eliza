import type { TriggerConfig, TriggerRunRecord } from "@elizaos/core";

export {
  TRIGGER_SCHEMA_VERSION,
  type TriggerConfig,
  type TriggerKind,
  type TriggerLastStatus,
  type TriggerRunRecord,
  type TriggerType,
  type TriggerWakeMode,
} from "@elizaos/core";
export type {
  CreateTriggerRequest,
  TriggerHealthSnapshot,
  TriggerSummary,
  TriggerTaskMetadata as TriggerTaskMetadataBase,
  UpdateTriggerRequest,
} from "@elizaos/shared";

export interface TriggerTaskMetadata {
  updatedAt?: number;
  updateInterval?: number;
  blocking?: boolean;
  trigger?: TriggerConfig;
  triggerRuns?: TriggerRunRecord[];
  idempotencyKey?: string;
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

export interface NormalizedTriggerDraft {
  displayName: string;
  instructions: string;
  triggerType: import("@elizaos/core").TriggerType;
  wakeMode: import("@elizaos/core").TriggerWakeMode;
  enabled: boolean;
  createdBy: string;
  timezone?: string;
  intervalMs?: number;
  scheduledAtIso?: string;
  cronExpression?: string;
  eventKind?: string;
  maxRuns?: number;
  kind?: import("@elizaos/core").TriggerKind;
  workflowId?: string;
  workflowName?: string;
}
