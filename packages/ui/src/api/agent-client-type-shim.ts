import type {
  TrajectoryExportFormat as CoreTrajectoryExportFormat,
  TriggerLastStatus as CoreTriggerLastStatus,
  TriggerRunRecord as CoreTriggerRunRecord,
  TriggerType as CoreTriggerType,
  TriggerWakeMode as CoreTriggerWakeMode,
  TriggerConfig,
  TriggerKind,
  UUID,
} from "@elizaos/core";
import type {
  CustomActionDef as SharedCustomActionDef,
  CustomActionHandler as SharedCustomActionHandler,
  DatabaseProviderType as SharedDatabaseProviderType,
  ReleaseChannel as SharedReleaseChannel,
} from "@elizaos/shared";

export type DatabaseProviderType = SharedDatabaseProviderType;
export type ReleaseChannel = SharedReleaseChannel;
export type CustomActionDef = SharedCustomActionDef;
export type CustomActionHandler = SharedCustomActionHandler;

export type ConversationScope =
  | "general"
  | "automation-coordinator"
  | "automation-workflow"
  | "automation-workflow-draft"
  | "automation-draft"
  | "page-character"
  | "page-apps"
  | "page-connectors"
  | "page-phone"
  | "page-plugins"
  | "page-lifeops"
  | "page-settings"
  | "page-wallet"
  | "page-browser"
  | "page-automations";

export type ConversationAutomationType = "coordinator_text" | "workflow";

export interface ConversationMetadata {
  scope?: ConversationScope;
  automationType?: ConversationAutomationType;
  taskId?: string;
  triggerId?: string;
  workflowId?: string;
  workflowName?: string;
  draftId?: string;
  pageId?: string;
  sourceConversationId?: string;
  terminalBridgeConversationId?: string;
}

export type StreamEventType =
  | "agent_event"
  | "heartbeat_event"
  | "training_event";

export type TradePermissionMode =
  | "user-sign-only"
  | "agent-auto"
  | "manual-local-key"
  | "disabled";

export type SignalPairingStatus =
  | "idle"
  | "initializing"
  | "waiting_for_qr"
  | "connected"
  | "disconnected"
  | "timeout"
  | "error";

export type WhatsAppPairingStatus = SignalPairingStatus;

export type TrajectoryExportFormat = CoreTrajectoryExportFormat;
export type TriggerLastStatus = CoreTriggerLastStatus;
export type TriggerRunRecord = CoreTriggerRunRecord;
export type TriggerType = CoreTriggerType;
export type TriggerWakeMode = CoreTriggerWakeMode;

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
  eventKind?: string;
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
  eventKind?: string;
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
  eventKind?: string;
  maxRuns?: number;
  kind?: TriggerKind;
  workflowId?: string;
  workflowName?: string;
}
