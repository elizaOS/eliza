/**
 * Trigger type surface for the package: re-exports the canonical trigger config
 * and request/summary types from core and shared, and defines the persisted
 * task-metadata shape (`TriggerTaskMetadata`) plus the normalized draft shape
 * (`NormalizedTriggerDraft`) used when building a trigger from user input.
 */
import type { TriggerConfig, TriggerRunRecord } from "@elizaos/core";

export {
  type PromptTriggerConfig,
  TRIGGER_SCHEMA_VERSION,
  type TriggerConfig,
  type TriggerKind,
  type TriggerLastStatus,
  type TriggerRunRecord,
  type TriggerType,
  type TriggerWakeMode,
  type WorkflowTriggerConfig,
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
  kind: import("@elizaos/core").TriggerKind;
  // Present only for `kind === "workflow"`. `buildTriggerConfig` produces the
  // strict `TriggerConfig` union member for the draft's kind.
  workflowId?: string;
  workflowName?: string;
}
