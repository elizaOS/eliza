import type {
  TrajectoryExportFormat as CoreTrajectoryExportFormat,
  TriggerLastStatus as CoreTriggerLastStatus,
  TriggerRunRecord as CoreTriggerRunRecord,
  TriggerType as CoreTriggerType,
  TriggerWakeMode as CoreTriggerWakeMode,
} from "@elizaos/core";
import type {
  ConversationAutomationType as SharedConversationAutomationType,
  ConversationMetadata as SharedConversationMetadata,
  ConversationScope as SharedConversationScope,
  CreateTriggerRequest as SharedCreateTriggerRequest,
  CustomActionDef as SharedCustomActionDef,
  CustomActionHandler as SharedCustomActionHandler,
  DatabaseProviderType as SharedDatabaseProviderType,
  ReleaseChannel as SharedReleaseChannel,
  StreamEventType as SharedStreamEventType,
  TradePermissionMode as SharedTradePermissionMode,
  TriggerHealthSnapshot as SharedTriggerHealthSnapshot,
  TriggerSummary as SharedTriggerSummary,
  TriggerTaskMetadata as SharedTriggerTaskMetadata,
  UpdateTriggerRequest as SharedUpdateTriggerRequest,
} from "@elizaos/shared";

export type DatabaseProviderType = SharedDatabaseProviderType;
export type ReleaseChannel = SharedReleaseChannel;
export type CustomActionDef = SharedCustomActionDef;
export type CustomActionHandler = SharedCustomActionHandler;
export type ConversationScope = SharedConversationScope;
export type ConversationAutomationType = SharedConversationAutomationType;
export type ConversationMetadata = SharedConversationMetadata;
export type StreamEventType = SharedStreamEventType;
export type TriggerTaskMetadata = SharedTriggerTaskMetadata;
export type TriggerSummary = SharedTriggerSummary;
export type TriggerHealthSnapshot = SharedTriggerHealthSnapshot;
export type CreateTriggerRequest = SharedCreateTriggerRequest;
export type UpdateTriggerRequest = SharedUpdateTriggerRequest;

export type TradePermissionMode = SharedTradePermissionMode;

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
