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
// TriggerSummary, TriggerHealthSnapshot, CreateTriggerRequest, UpdateTriggerRequest
// are canonical in @elizaos/shared. Re-export them here for backwards compat.
// TriggerTaskMetadata from shared is the base shape. The agent-internal version
// adds `idempotencyKey` for dedup of scheduled workflow fires.
export type {
  CreateTriggerRequest,
  TriggerHealthSnapshot,
  TriggerSummary,
  TriggerTaskMetadata as TriggerTaskMetadataBase,
  UpdateTriggerRequest,
} from "@elizaos/shared";

/**
 * Agent-internal TriggerTaskMetadata: extends the shared base with the
 * `idempotencyKey` field used for dedup of scheduled workflow fires.
 */
export interface TriggerTaskMetadata {
  updatedAt?: number;
  updateInterval?: number;
  blocking?: boolean;
  trigger?: TriggerConfig;
  triggerRuns?: TriggerRunRecord[];
  /**
   * Per-fire idempotency key. Workflow-kind scheduled triggers populate
   * this with `${workflowId}:${minuteBucket}` so dispatch can dedup
   * back-to-back fires inside the same minute. Refreshed on every
   * persist so each scheduled fire gets a fresh window.
   */
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
