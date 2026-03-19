/**
 * API client for the Milady backend.
 *
 * Thin fetch wrapper + WebSocket for real-time chat/events.
 * Replaces the gateway WebSocket protocol entirely.
 */

import type {
  AudioGenConfig,
  AudioGenProvider,
  CustomActionDef,
  CustomActionHandler,
  DatabaseProviderType,
  ImageConfig,
  ImageProvider,
  MediaConfig,
  MediaMode,
  ReleaseChannel,
  VideoConfig,
  VideoProvider,
  VisionConfig,
  VisionProvider,
} from "@elizaos/autonomous/contracts/config";
import type { DropStatus, MintResult } from "@elizaos/autonomous/contracts/drop";
import type { VerificationResult } from "@elizaos/autonomous/contracts/verification";
import type {
  CloudProviderOption,
  ConnectorConfig,
  InventoryProviderOption,
  MessageExample,
  MessageExampleContent,
  ModelOption,
  OnboardingConnection,
  OnboardingData,
  OnboardingOptions,
  OpenRouterModelOption,
  PiAiModelOption,
  ProviderOption,
  RpcProviderOption,
  StylePreset,
  SubscriptionProviderStatus,
  SubscriptionStatusResponse,
} from "@elizaos/autonomous/contracts/onboarding";
import type {
  BscTradeExecuteRequest,
  BscTradeExecuteResponse,
  BscTradePreflightResponse,
  BscTradeQuoteRequest,
  BscTradeQuoteResponse,
  BscTradeTxStatusResponse,
  BscTransferExecuteRequest,
  BscTransferExecuteResponse,
  EvmChainBalance,
  EvmNft,
  EvmTokenBalance,
  SolanaNft,
  SolanaTokenBalance,
  WalletAddresses,
  WalletBalancesResponse,
  WalletConfigStatus,
  WalletConfigUpdateRequest,
  WalletNftsResponse,
  WalletRpcChain,
  WalletRpcCredentialKey,
  WalletRpcSelections,
  TradePermissionMode as WalletTradePermissionMode,
  WalletTradingProfileResponse,
  WalletTradingProfileSourceFilter,
  WalletTradingProfileWindow,
} from "@elizaos/autonomous/contracts/wallet";
import {
  DEFAULT_WALLET_RPC_SELECTIONS,
  normalizeWalletRpcProviderId,
  normalizeWalletRpcSelections,
  WALLET_RPC_PROVIDER_OPTIONS,
} from "@elizaos/autonomous/contracts/wallet";
import type {
  AllPermissionsState,
  PermissionState,
  PermissionStatus,
  SystemPermissionDefinition,
  SystemPermissionId,
} from "@elizaos/autonomous/contracts/permissions";
import type { ConfigUiHint } from "../types";
import { stripAssistantStageDirections } from "../utils/assistant-text";
import { mergeStreamingText } from "../utils/streaming-text";

export type {
  AllPermissionsState,
  AudioGenConfig,
  AudioGenProvider,
  BscTradeExecuteRequest,
  BscTradeExecuteResponse,
  BscTradePreflightResponse,
  BscTradeQuoteRequest,
  BscTradeQuoteResponse,
  BscTradeTxStatusResponse,
  BscTransferExecuteRequest,
  BscTransferExecuteResponse,
  CloudProviderOption,
  ConnectorConfig,
  CustomActionDef,
  CustomActionHandler,
  DatabaseProviderType,
  DropStatus,
  EvmChainBalance,
  EvmNft,
  EvmTokenBalance,
  ImageConfig,
  ImageProvider,
  InventoryProviderOption,
  MediaConfig,
  MediaMode,
  MessageExample,
  MessageExampleContent,
  MintResult,
  ModelOption,
  OnboardingConnection,
  OnboardingData,
  OnboardingOptions,
  OpenRouterModelOption,
  PermissionState,
  PermissionStatus,
  PiAiModelOption,
  ProviderOption,
  RpcProviderOption,
  ReleaseChannel,
  SolanaNft,
  SolanaTokenBalance,
  StylePreset,
  SubscriptionProviderStatus,
  SubscriptionStatusResponse,
  SystemPermissionDefinition as PermissionDefinition,
  SystemPermissionId,
  VerificationResult,
  VideoConfig,
  VideoProvider,
  VisionConfig,
  VisionProvider,
  WalletAddresses,
  WalletBalancesResponse,
  WalletConfigStatus,
  WalletConfigUpdateRequest,
  WalletNftsResponse,
  WalletRpcChain,
  WalletRpcCredentialKey,
  WalletRpcSelections,
  WalletTradingProfileResponse,
  WalletTradingProfileSourceFilter,
  WalletTradingProfileWindow,
};

export {
  DEFAULT_WALLET_RPC_SELECTIONS,
  normalizeWalletRpcProviderId,
  normalizeWalletRpcSelections,
  WALLET_RPC_PROVIDER_OPTIONS,
};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DatabaseStatus {
  provider: DatabaseProviderType;
  connected: boolean;
  serverVersion: string | null;
  tableCount: number;
  pgliteDataDir: string | null;
  postgresHost: string | null;
}

export interface DatabaseConfigResponse {
  config: {
    provider?: DatabaseProviderType;
    pglite?: { dataDir?: string };
    postgres?: {
      connectionString?: string;
      host?: string;
      port?: number;
      database?: string;
      user?: string;
      password?: string;
      ssl?: boolean;
    };
  };
  activeProvider: DatabaseProviderType;
  needsRestart: boolean;
}

export interface ConnectionTestResult {
  success: boolean;
  serverVersion: string | null;
  error: string | null;
  durationMs: number;
}

export interface TableInfo {
  name: string;
  schema: string;
  rowCount: number;
  columns: ColumnInfo[];
}

export interface ColumnInfo {
  name: string;
  type: string;
  nullable: boolean;
  defaultValue: string | null;
  isPrimaryKey: boolean;
}

export interface TableRowsResponse {
  table: string;
  rows: Record<string, unknown>[];
  columns: string[];
  total: number;
  offset: number;
  limit: number;
}

export interface QueryResult {
  columns: string[];
  rows: Record<string, unknown>[];
  rowCount: number;
  durationMs: number;
}

export type AgentState =
  | "not_started"
  | "starting"
  | "running"
  | "stopped"
  | "restarting"
  | "error";

export interface AgentStartupDiagnostics {
  phase: string;
  attempt: number;
  lastError?: string;
  lastErrorAt?: number;
  nextRetryAt?: number;
}

export interface AgentStatus {
  state: AgentState;
  agentName: string;
  model: string | undefined;
  uptime: number | undefined;
  startedAt: number | undefined;
  pendingRestart?: boolean;
  pendingRestartReasons?: string[];
  startup?: AgentStartupDiagnostics;
}

export type AgentAutomationMode = "connectors-only" | "full";
export type TradePermissionMode = WalletTradePermissionMode;

export interface AgentAutomationModeResponse {
  mode: AgentAutomationMode;
  options: AgentAutomationMode[];
}

export interface TradePermissionModeResponse {
  mode: TradePermissionMode;
  options: TradePermissionMode[];
}

export interface ApplyProductionWalletDefaultsResponse {
  ok: boolean;
  profile: "pure-privy-safe";
  walletMode: "privy";
  tradePermissionMode: "user-sign-only";
  bscExecutionEnabled: false;
  clearedSecrets: string[];
}

export interface AgentSelfStatusSnapshot {
  generatedAt: string;
  state: AgentState;
  agentName: string;
  model: string | null;
  provider: string | null;
  automationMode: AgentAutomationMode;
  tradePermissionMode: TradePermissionMode;
  shellEnabled: boolean;
  wallet: {
    mode: "privy" | "hybrid";
    evmAddress: string | null;
    evmAddressShort: string | null;
    solanaAddress: string | null;
    solanaAddressShort: string | null;
    hasWallet: boolean;
    hasEvm: boolean;
    hasSolana: boolean;
    localSignerAvailable: boolean;
    managedBscRpcReady: boolean;
  };
  plugins: {
    totalActive: number;
    active: string[];
    aiProviders: string[];
    connectors: string[];
  };
  capabilities: {
    canTrade: boolean;
    canLocalTrade: boolean;
    canAutoTrade: boolean;
    canUseBrowser: boolean;
    canUseComputer: boolean;
    canRunTerminal: boolean;
    canInstallPlugins: boolean;
    canConfigurePlugins: boolean;
    canConfigureConnectors: boolean;
  };
}

// WebSocket connection state tracking
export type WebSocketConnectionState =
  | "connected"
  | "disconnected"
  | "reconnecting"
  | "failed";

export interface ConnectionStateInfo {
  state: WebSocketConnectionState;
  reconnectAttempt: number;
  maxReconnectAttempts: number;
  disconnectedAt: number | null;
}

export type ApiErrorKind = "timeout" | "network" | "http";

export class ApiError extends Error {
  readonly kind: ApiErrorKind;
  readonly status?: number;
  readonly path: string;

  constructor(options: {
    kind: ApiErrorKind;
    path: string;
    message: string;
    status?: number;
    cause?: unknown;
  }) {
    super(options.message);
    this.name = "ApiError";
    this.kind = options.kind;
    this.path = options.path;
    this.status = options.status;
    if (options.cause !== undefined) {
      (
        this as Error & {
          cause?: unknown;
        }
      ).cause = options.cause;
    }
  }
}

export function isApiError(value: unknown): value is ApiError {
  return value instanceof ApiError;
}

export interface RuntimeOrderItem {
  index: number;
  name: string;
  className: string;
  id: string | null;
}

export interface RuntimeServiceOrderItem {
  index: number;
  serviceType: string;
  count: number;
  instances: RuntimeOrderItem[];
}

export interface RuntimeDebugSnapshot {
  runtimeAvailable: boolean;
  generatedAt: number;
  settings: {
    maxDepth: number;
    maxArrayLength: number;
    maxObjectEntries: number;
    maxStringLength: number;
  };
  meta: {
    agentId?: string;
    agentState: AgentState;
    agentName: string;
    model: string | null;
    pluginCount: number;
    actionCount: number;
    providerCount: number;
    evaluatorCount: number;
    serviceTypeCount: number;
    serviceCount: number;
  };
  order: {
    plugins: RuntimeOrderItem[];
    actions: RuntimeOrderItem[];
    providers: RuntimeOrderItem[];
    evaluators: RuntimeOrderItem[];
    services: RuntimeServiceOrderItem[];
  };
  sections: {
    runtime: unknown;
    plugins: unknown;
    actions: unknown;
    providers: unknown;
    evaluators: unknown;
    services: unknown;
  };
}

export type TriggerType = "interval" | "once" | "cron";
export type TriggerWakeMode = "inject_now" | "next_autonomy_cycle";
export type TriggerLastStatus = "success" | "error" | "skipped";

export interface TriggerSummary {
  id: string;
  taskId: string;
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

export interface TriggerRunRecord {
  triggerRunId: string;
  triggerId: string;
  taskId: string;
  startedAt: number;
  finishedAt: number;
  status: TriggerLastStatus;
  error?: string;
  latencyMs: number;
  source: "scheduler" | "manual";
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
export interface SandboxPlatformStatus {
  platform: string;
  arch?: string;
  dockerInstalled?: boolean;
  dockerAvailable?: boolean;
  dockerRunning?: boolean;
  appleContainerAvailable?: boolean;
  wsl2?: boolean;
  recommended?: string;
}

export interface SandboxStartResponse {
  success: boolean;
  message: string;
  waitMs?: number;
  error?: string;
}

export interface SandboxBrowserEndpoints {
  cdpEndpoint?: string | null;
  wsEndpoint?: string | null;
  noVncEndpoint?: string | null;
}

export interface SandboxScreenshotRegion {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface SandboxScreenshotPayload {
  format: string;
  encoding: string;
  width: number | null;
  height: number | null;
  data: string;
}

export interface SandboxWindowInfo {
  id: string;
  title: string;
  app: string;
}

export interface SecretInfo {
  key: string;
  description: string;
  category: string;
  sensitive: boolean;
  required: boolean;
  isSet: boolean;
  maskedValue: string | null;
  usedBy: Array<{ pluginId: string; pluginName: string; enabled: boolean }>;
}

export interface PluginParamDef {
  key: string;
  type: string;
  description: string;
  required: boolean;
  sensitive: boolean;
  default?: string;
  /** Predefined options for dropdown selection (e.g. model names). */
  options?: string[];
  currentValue: string | null;
  isSet: boolean;
}

export interface PluginInfo {
  id: string;
  name: string;
  description: string;
  tags?: string[];
  enabled: boolean;
  configured: boolean;
  envKey: string | null;
  category:
  | "ai-provider"
  | "connector"
  | "streaming"
  | "database"
  | "app"
  | "feature";
  source: "bundled" | "store";
  parameters: PluginParamDef[];
  validationErrors: Array<{ field: string; message: string }>;
  validationWarnings: Array<{ field: string; message: string }>;
  npmName?: string;
  version?: string;
  pluginDeps?: string[];
  /** Whether this plugin is actually loaded and running in the runtime. */
  isActive?: boolean;
  /** Error message when plugin is installed but failed to load. */
  loadError?: string;
  /** Server-provided UI hints for plugin configuration fields. */
  configUiHints?: Record<string, ConfigUiHint>;
  /** Optional icon URL or emoji for the plugin card header. */
  icon?: string | null;
  homepage?: string;
  repository?: string;
  setupGuideUrl?: string;
}

export interface CorePluginEntry {
  npmName: string;
  id: string;
  name: string;
  isCore: boolean;
  loaded: boolean;
  enabled: boolean;
}

export interface CorePluginsResponse {
  core: CorePluginEntry[];
  optional: CorePluginEntry[];
}

export interface ChatMessage {
  role: "user" | "assistant";
  text: string;
  timestamp: number;
}

// Conversations
export interface Conversation {
  id: string;
  title: string;
  roomId: string;
  createdAt: string;
  updatedAt: string;
}

export interface ConversationGreeting {
  text: string;
  agentName: string;
  generated: boolean;
  persisted?: boolean;
}

export interface CreateConversationOptions {
  bootstrapGreeting?: boolean;
  lang?: string;
}

// ── A2UI Content Blocks (Agent-to-UI) ────────────────────────────────

/** A plain text content block. */
export interface TextBlock {
  type: "text";
  text: string;
}

/** An inline config form block — renders ConfigRenderer in chat. */
export interface ConfigFormBlock {
  type: "config-form";
  pluginId: string;
  pluginName?: string;
  schema: Record<string, unknown>;
  hints?: Record<string, unknown>;
  values?: Record<string, unknown>;
}

/** A UiSpec interactive UI block extracted from agent response. */
export interface UiSpecBlock {
  type: "ui-spec";
  spec: Record<string, unknown>;
  raw?: string;
}

/** Union of all content block types. */
export type ContentBlock = TextBlock | ConfigFormBlock | UiSpecBlock;

/** An image attachment to send with a chat message. */
export interface ImageAttachment {
  /** Base64-encoded image data (no data URL prefix). */
  data: string;
  mimeType: string;
  name: string;
}

export interface ConfigSchemaResponse {
  schema: unknown;
  uiHints: Record<string, unknown>;
  version: string;
  generatedAt: string;
}

export interface ConversationMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  timestamp: number;
  /** Structured content blocks (A2UI). When present, `text` is the fallback. */
  blocks?: ContentBlock[];
  /** Source channel when forwarded from another channel (e.g. "autonomy"). */
  source?: string;
  /** Username of the sender (e.g. retake viewer username, discord username). */
  from?: string;
  /** True when the SSE stream was interrupted before receiving a "done" event. */
  interrupted?: boolean;
}

export type ConversationChannelType =
  | "DM"
  | "GROUP"
  | "VOICE_DM"
  | "VOICE_GROUP"
  | "API";

export interface ChatTokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  llmCalls?: number;
  model?: string;
}

export type ConversationMode = "simple" | "power";

export interface SkillInfo {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  scanStatus?: "clean" | "warning" | "critical" | "blocked" | null;
}

export interface SkillScanReportSummary {
  scannedAt: string;
  status: "clean" | "warning" | "critical" | "blocked";
  summary: {
    scannedFiles: number;
    critical: number;
    warn: number;
    info: number;
  };
  findings: Array<{
    ruleId: string;
    severity: string;
    file: string;
    line: number;
    message: string;
    evidence: string;
  }>;
  manifestFindings: Array<{
    ruleId: string;
    severity: string;
    file: string;
    message: string;
  }>;
  skillPath: string;
}

// Skill Catalog types

export interface CatalogSkillStats {
  comments: number;
  downloads: number;
  installsAllTime: number;
  installsCurrent: number;
  stars: number;
  versions: number;
}

export interface CatalogSkillVersion {
  version: string;
  createdAt: number;
  changelog: string;
}

export interface CatalogSkill {
  slug: string;
  displayName: string;
  summary: string | null;
  tags: Record<string, string>;
  stats: CatalogSkillStats;
  createdAt: number;
  updatedAt: number;
  latestVersion: CatalogSkillVersion | null;
  installed?: boolean;
}

export interface CatalogSearchResult {
  slug: string;
  displayName: string;
  summary: string | null;
  score: number;
  latestVersion: string | null;
  downloads: number;
  stars: number;
  installs: number;
}

export interface LogEntry {
  timestamp: number;
  level: string;
  message: string;
  source: string;
  tags: string[];
}

export interface LogsResponse {
  entries: LogEntry[];
  sources: string[];
  tags: string[];
}

export interface LogsFilter {
  source?: string;
  level?: string;
  tag?: string;
  since?: number;
}

export type SecurityAuditSeverity = "info" | "warn" | "error" | "critical";
export type SecurityAuditEventType =
  | "sandbox_mode_transition"
  | "secret_token_replacement_outbound"
  | "secret_sanitization_inbound"
  | "privileged_capability_invocation"
  | "policy_decision"
  | "signing_request_submitted"
  | "signing_request_rejected"
  | "signing_request_approved"
  | "plugin_fallback_attempt"
  | "security_kill_switch"
  | "sandbox_lifecycle"
  | "fetch_proxy_error";

export interface SecurityAuditEntry {
  timestamp: string;
  type: SecurityAuditEventType;
  summary: string;
  metadata?: Record<string, string | number | boolean | null>;
  severity: SecurityAuditSeverity;
  traceId?: string;
}

export interface SecurityAuditFilter {
  type?: SecurityAuditEventType;
  severity?: SecurityAuditSeverity;
  since?: number | string | Date;
  limit?: number;
}

export interface SecurityAuditResponse {
  entries: SecurityAuditEntry[];
  totalBuffered: number;
  replayed: true;
}

export type SecurityAuditStreamEvent =
  | {
    type: "snapshot";
    entries: SecurityAuditEntry[];
    totalBuffered: number;
  }
  | {
    type: "entry";
    entry: SecurityAuditEntry;
  };

export type StreamEventType =
  | "agent_event"
  | "heartbeat_event"
  | "training_event";

export interface StreamEventEnvelope {
  type: StreamEventType;
  version: 1;
  eventId: string;
  ts: number;
  runId?: string;
  seq?: number;
  stream?: string;
  sessionKey?: string;
  agentId?: string;
  roomId?: string;
  payload: object;
}

// Fine-tuning / training
export type TrainingJobStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export interface TrainingStatus {
  runningJobs: number;
  queuedJobs: number;
  completedJobs: number;
  failedJobs: number;
  modelCount: number;
  datasetCount: number;
  runtimeAvailable: boolean;
}

export interface TrainingTrajectorySummary {
  id: string;
  trajectoryId: string;
  agentId: string;
  archetype: string | null;
  createdAt: string;
  totalReward: number | null;
  aiJudgeReward: number | null;
  episodeLength: number | null;
  hasLlmCalls: boolean;
  llmCallCount: number;
}

export interface TrainingTrajectoryDetail extends TrainingTrajectorySummary {
  stepsJson: string;
  aiJudgeReasoning: string | null;
}

export interface TrainingTrajectoryList {
  available: boolean;
  reason?: string;
  total: number;
  trajectories: TrainingTrajectorySummary[];
}

export interface TrainingDatasetRecord {
  id: string;
  createdAt: string;
  jsonlPath: string;
  trajectoryDir: string;
  metadataPath: string;
  sampleCount: number;
  trajectoryCount: number;
}

export interface StartTrainingOptions {
  datasetId?: string;
  maxTrajectories?: number;
  backend?: "mlx" | "cuda" | "cpu";
  model?: string;
  iterations?: number;
  batchSize?: number;
  learningRate?: number;
}

export interface TrainingJobRecord {
  id: string;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  status: TrainingJobStatus;
  phase: string;
  progress: number;
  error: string | null;
  exitCode: number | null;
  signal: string | null;
  options: StartTrainingOptions;
  datasetId: string;
  pythonRoot: string;
  scriptPath: string;
  outputDir: string;
  logPath: string;
  modelPath: string | null;
  adapterPath: string | null;
  modelId: string | null;
  logs: string[];
}

export interface TrainingModelRecord {
  id: string;
  createdAt: string;
  jobId: string;
  outputDir: string;
  modelPath: string;
  adapterPath: string | null;
  sourceModel: string | null;
  backend: "mlx" | "cuda" | "cpu";
  ollamaModel: string | null;
  active: boolean;
  benchmark: {
    status: "not_run" | "passed" | "failed";
    lastRunAt: string | null;
    output: string | null;
  };
}

export type TrainingEventKind =
  | "job_started"
  | "job_progress"
  | "job_log"
  | "job_completed"
  | "job_failed"
  | "job_cancelled"
  | "dataset_built"
  | "model_activated"
  | "model_imported";

export interface TrainingStreamEvent {
  kind: TrainingEventKind;
  ts: number;
  message: string;
  jobId?: string;
  modelId?: string;
  datasetId?: string;
  progress?: number;
  phase?: string;
}

export interface AgentEventsResponse {
  events: StreamEventEnvelope[];
  latestEventId: string | null;
  totalBuffered: number;
  replayed: boolean;
}

export interface ExtensionStatus {
  relayReachable: boolean;
  relayPort: number;
  extensionPath: string | null;
}

// Registry / Plugin Store types

export interface RegistryPlugin {
  name: string;
  gitRepo: string;
  gitUrl: string;
  description: string;
  homepage: string | null;
  topics: string[];
  stars: number;
  language: string;
  npm: {
    package: string;
    v0Version: string | null;
    v1Version: string | null;
    v2Version: string | null;
  };
  git: {
    v0Branch: string | null;
    v1Branch: string | null;
    v2Branch: string | null;
  };
  supports: { v0: boolean; v1: boolean; v2: boolean };
  installed: boolean;
  installedVersion: string | null;
  loaded: boolean;
  bundled: boolean;
  compatibility?: {
    releaseAvailability: "bundled" | "post-release";
    installSurface: "runtime" | "app";
    postReleaseInstallable: boolean;
    requiresDesktopRuntime: boolean;
    requiresLocalRuntime: boolean;
    note?: string;
  };
}

export interface RegistrySearchResult {
  name: string;
  description: string;
  score: number;
  tags: string[];
  latestVersion: string | null;
  stars: number;
  supports: { v0: boolean; v1: boolean; v2: boolean };
  repository: string;
}

export interface InstalledPlugin {
  name: string;
  version: string;
  installPath: string;
  installedAt: string;
}

export interface PluginInstallResult {
  ok: boolean;
  plugin?: { name: string; version: string; installPath: string };
  requiresRestart?: boolean;
  message?: string;
  error?: string;
}

export interface WalletExportResult {
  evm: { privateKey: string; address: string | null } | null;
  solana: { privateKey: string; address: string | null } | null;
}

// Software Updates
export interface UpdateStatus {
  currentVersion: string;
  channel: ReleaseChannel;
  installMethod: string;
  updateAvailable: boolean;
  latestVersion: string | null;
  channels: Record<ReleaseChannel, string | null>;
  distTags: Record<ReleaseChannel, string>;
  lastCheckAt: string | null;
  error: string | null;
}

// Cloud
export interface CloudStatus {
  connected: boolean;
  enabled?: boolean;
  hasApiKey?: boolean;
  userId?: string;
  organizationId?: string;
  topUpUrl?: string;
  reason?: string;
}
export interface CloudCredits {
  connected: boolean;
  balance: number | null;
  low?: boolean;
  critical?: boolean;
  topUpUrl?: string;
}
export interface CloudBillingPaymentMethod {
  id: string;
  type: string;
  label?: string;
  brand?: string;
  last4?: string;
  expiryMonth?: number;
  expiryYear?: number;
  isDefault?: boolean;
  walletAddress?: string;
  network?: string;
}
export interface CloudBillingHistoryItem {
  id: string;
  kind?: string;
  provider?: string;
  status: string;
  amount: number;
  currency: string;
  description?: string;
  receiptUrl?: string;
  createdAt: string;
}
export interface CloudBillingSummary {
  balance: number | null;
  currency?: string;
  low?: boolean;
  critical?: boolean;
  topUpUrl?: string;
  embeddedCheckoutEnabled?: boolean;
  hostedCheckoutEnabled?: boolean;
  cryptoEnabled?: boolean;
  paymentMethods?: CloudBillingPaymentMethod[];
  history?: CloudBillingHistoryItem[];
  [key: string]: unknown;
}
export interface CloudBillingSettings {
  success?: boolean;
  message?: string;
  error?: string;
  settings?: {
    autoTopUp?: {
      enabled?: boolean;
      amount?: number | null;
      threshold?: number | null;
      hasPaymentMethod?: boolean;
    };
    limits?: {
      minAmount?: number;
      maxAmount?: number;
      minThreshold?: number;
      maxThreshold?: number;
    };
  };
  [key: string]: unknown;
}
export interface CloudBillingSettingsUpdateRequest {
  autoTopUp?: {
    enabled?: boolean;
    amount?: number;
    threshold?: number;
  };
}
export interface CloudBillingCheckoutRequest {
  amountUsd: number;
  mode?: "embedded" | "hosted";
}
export interface CloudBillingCheckoutResponse {
  success?: boolean;
  provider?: string;
  mode?: "embedded" | "hosted";
  checkoutUrl?: string;
  url?: string;
  publishableKey?: string;
  clientSecret?: string;
  sessionId?: string;
  message?: string;
  [key: string]: unknown;
}
export interface CloudBillingCryptoQuoteRequest {
  amountUsd: number;
  currency?: string;
  network?: string;
  walletAddress?: string;
}
export interface CloudBillingCryptoQuoteResponse {
  success?: boolean;
  provider?: string;
  invoiceId?: string;
  network?: string;
  currency?: string;
  amount?: string;
  amountUsd?: number;
  payToAddress?: string;
  tokenAddress?: string;
  paymentLinkUrl?: string;
  expiresAt?: string;
  memo?: string;
  [key: string]: unknown;
}
export interface CloudLoginResponse {
  ok: boolean;
  sessionId: string;
  browserUrl: string;
  error?: string;
}
export interface CloudLoginPollResponse {
  status: "pending" | "authenticated" | "expired" | "error";
  keyPrefix?: string;
  error?: string;
}

// Cloud Compat (Eliza Cloud v2 thin-client types)
export interface CloudCompatAgent {
  agent_id: string;
  agent_name: string;
  node_id: string | null;
  container_id: string | null;
  headscale_ip: string | null;
  bridge_url: string | null;
  web_ui_url: string | null;
  status: string;
  agent_config: Record<string, unknown>;
  created_at: string;
  updated_at: string;
  containerUrl: string;
  webUiUrl: string | null;
  database_status: string;
  error_message: string | null;
  last_heartbeat_at: string | null;
}
export interface CloudCompatAgentStatus {
  status: string;
  lastHeartbeat: string | null;
  bridgeUrl: string | null;
  webUiUrl: string | null;
  currentNode: string | null;
  suspendedReason: string | null;
  databaseStatus: string;
}
export interface CloudCompatJob {
  jobId: string;
  type: string;
  status: "queued" | "processing" | "completed" | "failed" | "retrying";
  data: Record<string, unknown>;
  result: Record<string, unknown> | null;
  error: string | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  retryCount: number;
  id: string;
  name: string;
  state: string;
  created_on: string;
  completed_on: string | null;
}

export interface CloudCompatLaunchResult {
  agentId: string;
  agentName: string;
  appUrl: string;
  launchSessionId: string | null;
  issuedAt: string;
  connection: {
    apiBase: string;
    token: string;
  };
}

// Skills Marketplace
export interface SkillMarketplaceResult {
  id: string;
  slug?: string;
  name: string;
  description: string;
  githubUrl?: string;
  repository?: string;
  path?: string;
  tags?: string[];
  score?: number;
  source?: string;
}

// Share Ingest
export interface ShareIngestPayload {
  title?: string;
  url?: string;
  text?: string;
  files?: Array<{ name: string }>;
}

export interface ShareIngestItem {
  suggestedPrompt: string;
  files: Array<{ name: string }>;
}

// Workbench
export interface WorkbenchTask {
  id: string;
  name: string;
  description: string;
  tags: string[];
  isCompleted: boolean;
  updatedAt?: number;
}

export interface WorkbenchTodo {
  id: string;
  name: string;
  description: string;
  priority: number | null;
  isUrgent: boolean;
  isCompleted: boolean;
  type: string;
}

export interface WorkbenchOverview {
  tasks: WorkbenchTask[];
  triggers: TriggerSummary[];
  todos: WorkbenchTodo[];
  autonomy?: {
    enabled: boolean;
    thinking: boolean;
    lastEventAt?: number | null;
  };
}

// Coding Agent Sessions
export interface CodingAgentSession {
  sessionId: string;
  agentType: string;
  label: string;
  originalTask: string;
  workdir: string;
  status:
  | "active"
  | "blocked"
  | "completed"
  | "stopped"
  | "error"
  | "tool_running";
  decisionCount: number;
  autoResolvedCount: number;
  /** Description of the active tool when status is "tool_running". */
  toolDescription?: string;
  /** Latest activity text for the agent activity box. */
  lastActivity?: string;
}

export interface CodingAgentScratchWorkspace {
  sessionId: string;
  label: string;
  path: string;
  status: "pending_decision" | "kept" | "promoted";
  createdAt: number;
  terminalAt: number;
  terminalEvent: "stopped" | "task_complete" | "error";
  expiresAt?: number;
}

export interface AgentPreflightResult {
  adapter?: string;
  installed?: boolean;
  installCommand?: string;
  docsUrl?: string;
}

export interface CodingAgentStatus {
  supervisionLevel: string;
  taskCount: number;
  tasks: CodingAgentSession[];
  pendingConfirmations: number;
}

// MCP
export interface McpServerConfig {
  type: "stdio" | "streamable-http" | "sse";
  command?: string;
  args?: string[];
  url?: string;
  env?: Record<string, string>;
  headers?: Record<string, string>;
}

export interface McpMarketplaceResult {
  name: string;
  description?: string;
  connectionType: string;
  npmPackage?: string;
  dockerImage?: string;
}

export interface McpRegistryServerDetail {
  packages?: Array<{
    environmentVariables: Array<{
      name: string;
      default?: string;
      isRequired?: boolean;
    }>;
    packageArguments?: Array<{ default?: string }>;
  }>;
  remotes?: Array<{
    type?: string;
    url: string;
    headers: Array<{ name: string; isRequired?: boolean }>;
  }>;
}

export interface McpServerStatus {
  name: string;
  connected: boolean;
  error?: string;
}

// Voice / TTS config
export type VoiceProvider = "elevenlabs" | "simple-voice" | "edge";
export type VoiceMode = "cloud" | "own-key";

export interface VoiceConfig {
  provider?: VoiceProvider;
  mode?: VoiceMode;
  elevenlabs?: {
    apiKey?: string;
    voiceId?: string;
    modelId?: string;
    stability?: number;
    similarityBoost?: number;
    speed?: number;
  };
  edge?: {
    voice?: string;
    lang?: string;
    rate?: string;
    pitch?: string;
    volume?: string;
  };
}

// Character
export interface CharacterData {
  name?: string;
  username?: string;
  bio?: string | string[];
  system?: string;
  adjectives?: string[];
  topics?: string[];
  style?: {
    all?: string[];
    chat?: string[];
    post?: string[];
  };
  messageExamples?: Array<{
    examples: Array<{ name: string; content: MessageExampleContent }>;
  }>;
  postExamples?: string[];
}

// Registry plugin (non-app entries from the registry)
export interface RegistryPluginItem {
  name: string;
  description: string;
  stars: number;
  repository: string;
  topics: string[];
  latestVersion: string | null;
  supports: { v0: boolean; v1: boolean; v2: boolean };
  npm: {
    package: string;
    v0Version: string | null;
    v1Version: string | null;
    v2Version: string | null;
  };
}

// App types
export interface AppViewerAuthMessage {
  type: string;
  authToken?: string;
  sessionToken?: string;
  agentId?: string;
}

export interface AppViewerConfig {
  url: string;
  embedParams?: Record<string, string>;
  postMessageAuth?: boolean;
  sandbox?: string;
  authMessage?: AppViewerAuthMessage;
}

export interface AppUiExtensionConfig {
  detailPanelId: string;
}

export interface RegistryAppInfo {
  name: string;
  displayName: string;
  description: string;
  category: string;
  launchType: string;
  launchUrl: string | null;
  icon: string | null;
  capabilities: string[];
  stars: number;
  repository: string;
  latestVersion: string | null;
  supports: { v0: boolean; v1: boolean; v2: boolean };
  npm: {
    package: string;
    v0Version: string | null;
    v1Version: string | null;
    v2Version: string | null;
  };
  uiExtension?: AppUiExtensionConfig;
  viewer?: AppViewerConfig;
}
export interface InstalledAppInfo {
  name: string;
  displayName: string;
  version: string;
  installPath: string;
  installedAt: string;
  isRunning: boolean;
}
export interface AppLaunchResult {
  pluginInstalled: boolean;
  needsRestart: boolean;
  displayName: string;
  launchType: string;
  launchUrl: string | null;
  viewer: AppViewerConfig | null;
}
export interface AppStopResult {
  success: boolean;
  appName: string;
  stoppedAt: string;
  pluginUninstalled: boolean;
  needsRestart: boolean;
  stopScope: "plugin-uninstalled" | "viewer-session" | "no-op";
  message: string;
}

export type HyperscapeScriptedRole =
  | "combat"
  | "woodcutting"
  | "fishing"
  | "mining"
  | "balanced";

export type HyperscapeEmbeddedAgentControlAction =
  | "start"
  | "stop"
  | "pause"
  | "resume";

export type HyperscapeJsonValue =
  | string
  | number
  | boolean
  | null
  | HyperscapeJsonValue[]
  | { [key: string]: HyperscapeJsonValue };

export type HyperscapePosition =
  | [number, number, number]
  | {
    x: number;
    y: number;
    z: number;
  };

export interface HyperscapeEmbeddedAgent {
  agentId: string;
  characterId: string;
  accountId: string;
  name: string;
  scriptedRole: HyperscapeScriptedRole | null;
  state: string;
  entityId: string | null;
  position: HyperscapePosition | null;
  health: number | null;
  maxHealth: number | null;
  startedAt: number | null;
  lastActivity: number | null;
  error: string | null;
}

export interface HyperscapeEmbeddedAgentsResponse {
  success: boolean;
  agents: HyperscapeEmbeddedAgent[];
  count: number;
  error?: string;
}

export interface HyperscapeActionResponse {
  success: boolean;
  message?: string;
  error?: string;
}

export interface HyperscapeEmbeddedAgentMutationResponse
  extends HyperscapeActionResponse {
  agent?: HyperscapeEmbeddedAgent | null;
}

export interface HyperscapeAvailableGoal {
  id: string;
  type: string;
  description: string;
  priority: number;
}

export interface HyperscapeGoalState {
  type?: string;
  description?: string;
  progress?: number;
  target?: number;
  progressPercent?: number;
  elapsedMs?: number;
  startedAt?: number;
  locked?: boolean;
  lockedBy?: string;
}

export interface HyperscapeAgentGoalResponse {
  success: boolean;
  goal: HyperscapeGoalState | null;
  availableGoals?: HyperscapeAvailableGoal[];
  goalsPaused?: boolean;
  message?: string;
  error?: string;
}

export interface HyperscapeQuickCommand {
  id: string;
  label: string;
  command: string;
  icon: string;
  available: boolean;
  reason?: string;
}

export interface HyperscapeNearbyLocation {
  id: string;
  name: string;
  type: string;
  distance: number;
}

export interface HyperscapeInventoryItem {
  id: string;
  name: string;
  slot: number;
  quantity: number;
  canEquip: boolean;
  canUse: boolean;
  canDrop: boolean;
}

export interface HyperscapeQuickActionsResponse {
  success: boolean;
  nearbyLocations: HyperscapeNearbyLocation[];
  availableGoals: HyperscapeAvailableGoal[];
  quickCommands: HyperscapeQuickCommand[];
  inventory: HyperscapeInventoryItem[];
  playerPosition: [number, number, number] | null;
  message?: string;
  error?: string;
}

// Trajectories
export interface TrajectoryRecord {
  id: string;
  agentId: string;
  roomId: string | null;
  entityId: string | null;
  conversationId: string | null;
  source: string;
  status: "active" | "completed" | "error";
  startTime: number;
  endTime: number | null;
  durationMs: number | null;
  llmCallCount: number;
  providerAccessCount: number;
  totalPromptTokens: number;
  totalCompletionTokens: number;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface TrajectoryLlmCall {
  id: string;
  trajectoryId: string;
  stepId: string;
  model: string;
  systemPrompt: string;
  userPrompt: string;
  response: string;
  temperature: number;
  maxTokens: number;
  purpose: string;
  actionType: string;
  latencyMs: number;
  promptTokens?: number;
  completionTokens?: number;
  timestamp: number;
  createdAt: string;
}

export interface TrajectoryProviderAccess {
  id: string;
  trajectoryId: string;
  stepId: string;
  providerName: string;
  purpose: string;
  data: Record<string, unknown>;
  query?: Record<string, unknown>;
  timestamp: number;
  createdAt: string;
}

export interface TrajectoryListOptions {
  limit?: number;
  offset?: number;
  source?: string;
  status?: "active" | "completed" | "error";
  startDate?: string;
  endDate?: string;
  search?: string;
}

export interface TrajectoryListResult {
  trajectories: TrajectoryRecord[];
  total: number;
  offset: number;
  limit: number;
}

export interface TrajectoryDetailResult {
  trajectory: TrajectoryRecord;
  llmCalls: TrajectoryLlmCall[];
  providerAccesses: TrajectoryProviderAccess[];
}

export interface TrajectoryStats {
  totalTrajectories: number;
  totalLlmCalls: number;
  totalProviderAccesses: number;
  totalPromptTokens: number;
  totalCompletionTokens: number;
  averageDurationMs: number;
  bySource: Record<string, number>;
  byModel: Record<string, number>;
}

export interface TrajectoryConfig {
  enabled: boolean;
}

export type TrajectoryExportFormat = "json" | "csv" | "zip";

export interface TrajectoryExportOptions {
  format: TrajectoryExportFormat;
  includePrompts?: boolean;
  trajectoryIds?: string[];
  startDate?: string;
  endDate?: string;
}

// Knowledge types
export interface KnowledgeStats {
  documentCount: number;
  fragmentCount: number;
  agentId: string;
}

export interface KnowledgeDocument {
  id: string;
  filename: string;
  contentType: string;
  fileSize: number;
  createdAt: number;
  fragmentCount: number;
  source: string;
  url?: string;
  content?: { text?: string };
}

export interface KnowledgeDocumentDetail extends KnowledgeDocument {
  content: { text?: string };
}

export interface KnowledgeDocumentsResponse {
  documents: KnowledgeDocument[];
  total: number;
  limit: number;
  offset: number;
}

export interface KnowledgeFragment {
  id: string;
  text: string;
  position?: number;
  createdAt: number;
}

export interface KnowledgeFragmentsResponse {
  documentId: string;
  fragments: KnowledgeFragment[];
  count: number;
}

export interface KnowledgeSearchResult {
  id: string;
  text: string;
  similarity: number;
  documentId?: string;
  documentTitle?: string;
  position?: number;
}

export interface KnowledgeSearchResponse {
  query: string;
  threshold: number;
  results: KnowledgeSearchResult[];
  count: number;
}

export interface KnowledgeUploadResult {
  ok: boolean;
  documentId: string;
  fragmentCount: number;
  filename?: string;
  contentType?: string;
  isYouTubeTranscript?: boolean;
  warnings?: string[];
}

export interface KnowledgeBulkUploadItemResult {
  index: number;
  ok: boolean;
  filename: string;
  documentId?: string;
  fragmentCount?: number;
  error?: string;
  warnings?: string[];
}

export interface KnowledgeBulkUploadResult {
  ok: boolean;
  total: number;
  successCount: number;
  failureCount: number;
  results: KnowledgeBulkUploadItemResult[];
}

// Memory / context command types
export interface MemorySearchResult {
  id: string;
  text: string;
  createdAt: number;
  score: number;
}

export interface MemorySearchResponse {
  query: string;
  results: MemorySearchResult[];
  count: number;
  limit: number;
}

export interface MemoryRememberResponse {
  ok: boolean;
  id: string;
  text: string;
  createdAt: number;
}

export interface QuickContextResponse {
  query: string;
  answer: string;
  memories: MemorySearchResult[];
  knowledge: KnowledgeSearchResult[];
}

// WebSocket

export type WsEventHandler = (data: Record<string, unknown>) => void;

// ---------------------------------------------------------------------------
// ERC-8004 Registry & Drop types
// ---------------------------------------------------------------------------

export interface RegistryStatus {
  registered: boolean;
  tokenId: number;
  agentName: string;
  agentEndpoint: string;
  capabilitiesHash: string;
  isActive: boolean;
  tokenURI: string;
  walletAddress: string;
  totalAgents: number;
  configured: boolean;
}

export interface RegistrationResult {
  tokenId: number;
  txHash: string;
}

export interface RegistryConfig {
  configured: boolean;
  chainId: number;
  registryAddress: string | null;
  collectionAddress: string | null;
  explorerUrl: string;
}

export interface WhitelistStatus {
  eligible: boolean;
  twitterVerified: boolean;
  ogCode: string | null;
  walletAddress: string;
}

export interface VerificationMessageResponse {
  message: string;
  walletAddress: string;
}

// ---------------------------------------------------------------------------
// System Permissions
// ---------------------------------------------------------------------------

declare global {
  interface Window {
    __MILADY_API_BASE__?: string;
    __MILADY_API_TOKEN__?: string;
  }
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

const GENERIC_NO_RESPONSE_TEXT =
  "Sorry, I couldn't generate a response right now. Please try again.";
const AGENT_TRANSFER_MIN_PASSWORD_LENGTH = 4;
const DEFAULT_FETCH_TIMEOUT_MS = 10_000;
const SESSION_STORAGE_API_BASE_KEY = "milady_api_base";
const SESSION_STORAGE_API_TOKEN_KEY = "milady_api_token";

export class MiladyClient {
  private _baseUrl: string;
  private _explicitBase: boolean;
  private _token: string | null;
  private readonly clientId: string;
  private ws: WebSocket | null = null;
  private wsHandlers = new Map<string, Set<WsEventHandler>>();
  private wsSendQueue: string[] = [];
  private readonly wsSendQueueLimit = 32;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private backoffMs = 500;
  private wsHasConnectedOnce = false;

  // Connection state tracking for backend crash handling
  private connectionState: WebSocketConnectionState = "disconnected";
  private reconnectAttempt = 0;
  private disconnectedAt: number | null = null;
  private connectionStateListeners = new Set<
    (state: ConnectionStateInfo) => void
  >();
  private readonly maxReconnectAttempts = 15;

  // UI language propagation — set by AppContext so the backend can
  // localise responses when needed.
  private _uiLanguage: string | null = null;

  /** Store the current UI language so it can be sent as a header on every request. */
  setUiLanguage(lang: string): void {
    this._uiLanguage = lang || null;
  }

  private static resolveDesktopLocalFallbackBase(): string {
    if (typeof window === "undefined") return "";
    const proto = window.location.protocol;
    // In the desktop shell the main process injects the live API base
    // once the embedded agent has bound a port. Avoid eager localhost probes
    // to prevent noisy ERR_CONNECTION_REFUSED logs during startup.
    if (proto === "electrobun:") return "";
    if (proto === "file:") {
      return "http://localhost:2138";
    }
    return "";
  }

  private static generateClientId(): string {
    const random =
      typeof globalThis.crypto?.randomUUID === "function"
        ? globalThis.crypto.randomUUID()
        : `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
    return `ui-${random.replace(/[^a-zA-Z0-9._-]/g, "")}`;
  }

  constructor(baseUrl?: string, token?: string) {
    this.clientId = MiladyClient.generateClientId();
    const stored =
      typeof window !== "undefined"
        ? window.sessionStorage.getItem(SESSION_STORAGE_API_TOKEN_KEY)
        : null;
    const storedBase =
      typeof window !== "undefined"
        ? window.sessionStorage.getItem(SESSION_STORAGE_API_BASE_KEY)
        : null;
    this._explicitBase = baseUrl != null || Boolean(storedBase?.trim());
    this._token = token?.trim() || stored || null;
    // Priority: explicit arg > desktop-injected global > same origin (Vite proxy)
    const injectedBase =
      typeof window !== "undefined" ? window.__MILADY_API_BASE__ : undefined;
    this._baseUrl =
      baseUrl ??
      storedBase ??
      injectedBase ??
      MiladyClient.resolveDesktopLocalFallbackBase();
  }

  /**
   * Resolve the API base URL lazily.
   * In the desktop shell the main process injects window.__MILADY_API_BASE__ after the
   * page loads (once the agent runtime starts). Re-checking on every call
   * ensures we pick up the injected value even if it wasn't set at construction.
   */
  private get baseUrl(): string {
    if (!this._explicitBase && typeof window !== "undefined") {
      const injected = window.__MILADY_API_BASE__;
      // In the desktop shell the API base can be injected after initial render. Always
      // prefer the injected value when present so the client can switch away
      // from the localhost fallback once the main process publishes the real
      // endpoint.
      if (injected && injected !== this._baseUrl) {
        this._baseUrl = injected;
      } else if (!this._baseUrl) {
        this._baseUrl = MiladyClient.resolveDesktopLocalFallbackBase();
      }
    }
    return this._baseUrl;
  }

  private get apiToken(): string | null {
    if (this._token) return this._token;
    if (typeof window === "undefined") return null;
    const injected = window.__MILADY_API_TOKEN__;
    if (typeof injected === "string" && injected.trim()) return injected.trim();
    return null;
  }

  hasToken(): boolean {
    return Boolean(this.apiToken);
  }

  setToken(token: string | null): void {
    this._token = token?.trim() || null;
    if (typeof window !== "undefined") {
      if (this._token) {
        window.__MILADY_API_TOKEN__ = this._token;
        window.sessionStorage.setItem(
          SESSION_STORAGE_API_TOKEN_KEY,
          this._token,
        );
      } else {
        delete window.__MILADY_API_TOKEN__;
        window.sessionStorage.removeItem(SESSION_STORAGE_API_TOKEN_KEY);
      }
    }
  }

  getBaseUrl(): string {
    return this.baseUrl;
  }

  setBaseUrl(baseUrl: string | null): void {
    const normalized = baseUrl?.trim().replace(/\/+$/, "") || "";
    this._explicitBase = normalized.length > 0;
    this._baseUrl = normalized;
    this.disconnectWs();
    if (typeof window !== "undefined") {
      if (normalized) {
        window.__MILADY_API_BASE__ = normalized;
        window.sessionStorage.setItem(SESSION_STORAGE_API_BASE_KEY, normalized);
      } else {
        delete window.__MILADY_API_BASE__;
        window.sessionStorage.removeItem(SESSION_STORAGE_API_BASE_KEY);
      }
    }
  }

  /** True when we have a usable HTTP(S) API endpoint. */
  get apiAvailable(): boolean {
    if (this.baseUrl) return true;
    if (typeof window !== "undefined") {
      const proto = window.location.protocol;
      return proto === "http:" || proto === "https:";
    }
    return false;
  }

  // --- REST API ---

  private async rawRequest(
    path: string,
    init?: RequestInit,
    options?: { allowNonOk?: boolean },
  ): Promise<Response> {
    if (!this.apiAvailable) {
      throw new ApiError({
        kind: "network",
        path,
        message: "API not available (no HTTP origin)",
      });
    }
    const makeRequest = async (token: string | null): Promise<Response> => {
      let timeoutId: ReturnType<typeof setTimeout> | undefined;
      let abortListener: (() => void) | undefined;
      const requestInit: RequestInit = {
        ...init,
        headers: {
          "X-Milady-Client-Id": this.clientId,
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(this._uiLanguage
            ? { "X-Milady-UI-Language": this._uiLanguage }
            : {}),
          ...init?.headers,
        },
      };

      const fetchPromise = fetch(`${this.baseUrl}${path}`, requestInit);
      const pending: Promise<Response>[] = [fetchPromise];

      pending.push(
        new Promise<Response>((_, reject) => {
          timeoutId = setTimeout(() => {
            reject(
              new ApiError({
                kind: "timeout",
                path,
                message: `Request timed out after ${DEFAULT_FETCH_TIMEOUT_MS}ms`,
              }),
            );
          }, DEFAULT_FETCH_TIMEOUT_MS);
        }),
      );

      if (init?.signal) {
        if (init.signal.aborted) {
          throw new ApiError({
            kind: "network",
            path,
            message: "Request aborted",
          });
        }

        pending.push(
          new Promise<Response>((_, reject) => {
            abortListener = () => {
              reject(
                new ApiError({
                  kind: "network",
                  path,
                  message: "Request aborted",
                }),
              );
            };
            init.signal?.addEventListener("abort", abortListener, {
              once: true,
            });
          }),
        );
      }

      try {
        return await Promise.race(pending);
      } catch (err) {
        if (err instanceof ApiError) {
          throw err;
        }
        throw new ApiError({
          kind: "network",
          path,
          message:
            err instanceof Error && err.message
              ? err.message
              : "Network request failed",
          cause: err,
        });
      } finally {
        if (timeoutId !== undefined) {
          clearTimeout(timeoutId);
        }
        if (init?.signal && abortListener) {
          init.signal.removeEventListener("abort", abortListener);
        }
      }
    };

    const token = this.apiToken;
    let res = await makeRequest(token);
    if (res.status === 401 && !token) {
      const retryToken = this.apiToken;
      if (retryToken) {
        res = await makeRequest(retryToken);
      }
    }
    if (!res.ok && !options?.allowNonOk) {
      const body = (await res
        .json()
        .catch(() => ({ error: res.statusText }))) as Record<string, string>;
      throw new ApiError({
        kind: "http",
        path,
        status: res.status,
        message: body.error ?? `HTTP ${res.status}`,
      });
    }
    return res;
  }

  private async fetch<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await this.rawRequest(path, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        ...init?.headers,
      },
    });
    return res.json() as Promise<T>;
  }

  async getStatus(): Promise<AgentStatus> {
    return this.fetch("/api/status");
  }

  async getAgentSelfStatus(): Promise<AgentSelfStatusSnapshot> {
    return this.fetch("/api/agent/self-status");
  }

  async getRuntimeSnapshot(opts?: {
    depth?: number;
    maxArrayLength?: number;
    maxObjectEntries?: number;
    maxStringLength?: number;
  }): Promise<RuntimeDebugSnapshot> {
    const params = new URLSearchParams();
    if (typeof opts?.depth === "number")
      params.set("depth", String(opts.depth));
    if (typeof opts?.maxArrayLength === "number") {
      params.set("maxArrayLength", String(opts.maxArrayLength));
    }
    if (typeof opts?.maxObjectEntries === "number") {
      params.set("maxObjectEntries", String(opts.maxObjectEntries));
    }
    if (typeof opts?.maxStringLength === "number") {
      params.set("maxStringLength", String(opts.maxStringLength));
    }
    const qs = params.toString();
    return this.fetch(`/api/runtime${qs ? `?${qs}` : ""}`);
  }

  async setAutomationMode(
    mode: "connectors-only" | "full",
  ): Promise<{ mode: string }> {
    return this.fetch("/api/permissions/automation-mode", {
      method: "PUT",
      body: JSON.stringify({ mode }),
    });
  }

  async setTradeMode(
    mode: string,
  ): Promise<{ ok: boolean; tradePermissionMode: string }> {
    return this.fetch("/api/permissions/trade-mode", {
      method: "PUT",
      body: JSON.stringify({ mode }),
    });
  }

  async playEmote(emoteId: string): Promise<{ ok: boolean }> {
    return this.fetch("/api/emote", {
      method: "POST",
      body: JSON.stringify({ emoteId }),
    });
  }

  async runTerminalCommand(command: string): Promise<{ ok: boolean }> {
    return this.fetch("/api/terminal/run", {
      method: "POST",
      body: JSON.stringify({ command }),
    });
  }

  async getOnboardingStatus(): Promise<{ complete: boolean }> {
    return this.fetch("/api/onboarding/status");
  }

  async getAuthStatus(): Promise<{
    required: boolean;
    pairingEnabled: boolean;
    expiresAt: number | null;
  }> {
    // Retry with exponential backoff — the server may not be ready during boot.
    const maxRetries = 3;
    const baseBackoffMs = 1000;
    let lastErr: unknown;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await this.fetch("/api/auth/status");
      } catch (err: unknown) {
        const status = (err as Error & { status?: number })?.status;
        if (status === 401) {
          return { required: true, pairingEnabled: false, expiresAt: null };
        }
        if (status === 404) {
          return { required: false, pairingEnabled: false, expiresAt: null };
        }
        lastErr = err;
        const kind = (err as Error & { kind?: string })?.kind;
        if (kind === "timeout" && attempt < maxRetries) {
          await new Promise((r) => setTimeout(r, baseBackoffMs * 2 ** attempt));
          continue;
        }
        if (attempt >= maxRetries) break;
      }
    }
    throw lastErr;
  }

  async pair(code: string): Promise<{ token: string }> {
    const res = await this.fetch<{ token: string }>("/api/auth/pair", {
      method: "POST",
      body: JSON.stringify({ code }),
    });
    return res;
  }

  async getOnboardingOptions(): Promise<OnboardingOptions> {
    return this.fetch("/api/onboarding/options");
  }

  async submitOnboarding(data: OnboardingData): Promise<void> {
    await this.fetch("/api/onboarding", {
      method: "POST",
      body: JSON.stringify(data),
    });
  }

  async startAnthropicLogin(): Promise<{ authUrl: string }> {
    return this.fetch("/api/subscription/anthropic/start", { method: "POST" });
  }

  async exchangeAnthropicCode(code: string): Promise<{
    success: boolean;
    expiresAt?: string;
    error?: string;
  }> {
    return this.fetch("/api/subscription/anthropic/exchange", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code }),
    });
  }

  async submitAnthropicSetupToken(
    token: string,
  ): Promise<{ success: boolean }> {
    return this.fetch("/api/subscription/anthropic/setup-token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    });
  }

  async getSubscriptionStatus(): Promise<SubscriptionStatusResponse> {
    return this.fetch<SubscriptionStatusResponse>("/api/subscription/status");
  }

  async deleteSubscription(provider: string): Promise<{ success: boolean }> {
    return this.fetch(`/api/subscription/${encodeURIComponent(provider)}`, {
      method: "DELETE",
    });
  }

  async switchProvider(
    provider: string,
    apiKey?: string,
  ): Promise<{ success: boolean; provider: string; restarting: boolean }> {
    return this.fetch("/api/provider/switch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider, ...(apiKey ? { apiKey } : {}) }),
    });
  }

  async startOpenAILogin(): Promise<{
    authUrl: string;
    state: string;
    instructions: string;
  }> {
    return this.fetch("/api/subscription/openai/start", { method: "POST" });
  }

  async exchangeOpenAICode(code: string): Promise<{
    success: boolean;
    expiresAt?: string;
    accountId?: string;
    error?: string;
  }> {
    return this.fetch("/api/subscription/openai/exchange", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code }),
    });
  }

  async getSandboxPlatform(): Promise<SandboxPlatformStatus> {
    return this.fetch("/api/sandbox/platform");
  }

  async getSandboxBrowser(): Promise<SandboxBrowserEndpoints> {
    return this.fetch("/api/sandbox/browser");
  }

  async getSandboxScreenshot(
    region?: SandboxScreenshotRegion,
  ): Promise<SandboxScreenshotPayload> {
    if (!region) {
      return this.fetch("/api/sandbox/screen/screenshot", {
        method: "POST",
      });
    }

    return this.fetch("/api/sandbox/screen/screenshot", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(region),
    });
  }

  async getSandboxWindows(): Promise<{
    windows: SandboxWindowInfo[];
    error?: string;
  }> {
    return this.fetch("/api/sandbox/screen/windows");
  }

  async startDocker(): Promise<SandboxStartResponse> {
    return this.fetch("/api/sandbox/docker/start", { method: "POST" });
  }

  async startAgent(): Promise<AgentStatus> {
    const res = await this.fetch<{ status: AgentStatus }>("/api/agent/start", {
      method: "POST",
    });
    return res.status;
  }

  async stopAgent(): Promise<AgentStatus> {
    const res = await this.fetch<{ status: AgentStatus }>("/api/agent/stop", {
      method: "POST",
    });
    return res.status;
  }

  async pauseAgent(): Promise<AgentStatus> {
    const res = await this.fetch<{ status: AgentStatus }>("/api/agent/pause", {
      method: "POST",
    });
    return res.status;
  }

  async resumeAgent(): Promise<AgentStatus> {
    const res = await this.fetch<{ status: AgentStatus }>("/api/agent/resume", {
      method: "POST",
    });
    return res.status;
  }

  async restartAgent(): Promise<AgentStatus> {
    const res = await this.fetch<{ status: AgentStatus }>(
      "/api/agent/restart",
      { method: "POST" },
    );
    return res.status;
  }

  /**
   * Restart the agent if possible, or wait for an in-progress restart to finish.
   * Polls status until the agent state is "running".
   */
  async restartAndWait(maxWaitMs = 30000): Promise<AgentStatus> {
    // Try triggering a restart; 409 means one is already in progress
    try {
      await this.restartAgent();
    } catch {
      // Already restarting — that's fine, we'll poll
    }
    // Poll until running
    const start = Date.now();
    const interval = 1000;
    while (Date.now() - start < maxWaitMs) {
      await new Promise((r) => setTimeout(r, interval));
      try {
        const status = await this.getStatus();
        if (status.state === "running") return status;
      } catch {
        // Server may be briefly unavailable during restart
      }
    }
    // Return whatever we get after timeout
    return this.getStatus();
  }

  async resetAgent(): Promise<void> {
    await this.fetch("/api/agent/reset", { method: "POST" });
  }

  async getConfig(): Promise<Record<string, unknown>> {
    return this.fetch("/api/config");
  }

  async getConfigSchema(): Promise<ConfigSchemaResponse> {
    return this.fetch("/api/config/schema");
  }

  async updateConfig(
    patch: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return this.fetch("/api/config", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
  }

  // ── Custom VRM avatar ────────────────────────────────────────────────

  async uploadCustomVrm(file: File): Promise<void> {
    const buf = await file.arrayBuffer();
    await this.fetch("/api/avatar/vrm", {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body: buf,
    });
  }

  /** Uses raw fetch instead of this.fetch() because HEAD returns no JSON body. */
  async hasCustomVrm(): Promise<boolean> {
    try {
      const res = await this.rawRequest(
        "/api/avatar/vrm",
        { method: "HEAD" },
        { allowNonOk: true },
      );
      return res.ok;
    } catch {
      return false;
    }
  }

  // ── Custom background image ─────────────────────────────────────────

  async uploadCustomBackground(file: File): Promise<void> {
    const buf = await file.arrayBuffer();
    await this.fetch("/api/avatar/background", {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body: buf,
    });
  }

  /** Uses raw fetch instead of this.fetch() because HEAD returns no JSON body. */
  async hasCustomBackground(): Promise<boolean> {
    try {
      const res = await this.rawRequest(
        "/api/avatar/background",
        { method: "HEAD" },
        { allowNonOk: true },
      );
      return res.ok;
    } catch {
      return false;
    }
  }

  // ── Connectors ──────────────────────────────────────────────────────

  async getConnectors(): Promise<{
    connectors: Record<string, ConnectorConfig>;
  }> {
    return this.fetch("/api/connectors");
  }

  async saveConnector(
    name: string,
    config: ConnectorConfig,
  ): Promise<{ connectors: Record<string, ConnectorConfig> }> {
    return this.fetch("/api/connectors", {
      method: "POST",
      body: JSON.stringify({ name, config }),
    });
  }

  async deleteConnector(
    name: string,
  ): Promise<{ connectors: Record<string, ConnectorConfig> }> {
    return this.fetch(`/api/connectors/${encodeURIComponent(name)}`, {
      method: "DELETE",
    });
  }

  async getTriggers(): Promise<{ triggers: TriggerSummary[] }> {
    return this.fetch("/api/triggers");
  }

  async getTrigger(id: string): Promise<{ trigger: TriggerSummary }> {
    return this.fetch(`/api/triggers/${encodeURIComponent(id)}`);
  }

  async createTrigger(
    request: CreateTriggerRequest,
  ): Promise<{ trigger: TriggerSummary }> {
    return this.fetch("/api/triggers", {
      method: "POST",
      body: JSON.stringify(request),
    });
  }

  async updateTrigger(
    id: string,
    request: UpdateTriggerRequest,
  ): Promise<{ trigger: TriggerSummary }> {
    return this.fetch(`/api/triggers/${encodeURIComponent(id)}`, {
      method: "PUT",
      body: JSON.stringify(request),
    });
  }

  async deleteTrigger(id: string): Promise<{ ok: boolean }> {
    return this.fetch(`/api/triggers/${encodeURIComponent(id)}`, {
      method: "DELETE",
    });
  }

  async runTriggerNow(id: string): Promise<{
    ok: boolean;
    result: {
      status: TriggerLastStatus;
      error?: string;
      taskDeleted: boolean;
    };
    trigger?: TriggerSummary;
  }> {
    return this.fetch(`/api/triggers/${encodeURIComponent(id)}/execute`, {
      method: "POST",
    });
  }

  async getTriggerRuns(id: string): Promise<{ runs: TriggerRunRecord[] }> {
    return this.fetch(`/api/triggers/${encodeURIComponent(id)}/runs`);
  }

  async getTriggerHealth(): Promise<TriggerHealthSnapshot> {
    return this.fetch("/api/triggers/health");
  }

  // Fine-tuning / training
  async getTrainingStatus(): Promise<TrainingStatus> {
    return this.fetch("/api/training/status");
  }

  async listTrainingTrajectories(opts?: {
    limit?: number;
    offset?: number;
  }): Promise<TrainingTrajectoryList> {
    const params = new URLSearchParams();
    if (typeof opts?.limit === "number")
      params.set("limit", String(opts.limit));
    if (typeof opts?.offset === "number")
      params.set("offset", String(opts.offset));
    const qs = params.toString();
    return this.fetch(`/api/training/trajectories${qs ? `?${qs}` : ""}`);
  }

  async getTrainingTrajectory(
    trajectoryId: string,
  ): Promise<{ trajectory: TrainingTrajectoryDetail }> {
    return this.fetch(
      `/api/training/trajectories/${encodeURIComponent(trajectoryId)}`,
    );
  }

  async listTrainingDatasets(): Promise<{ datasets: TrainingDatasetRecord[] }> {
    return this.fetch("/api/training/datasets");
  }

  async buildTrainingDataset(options?: {
    limit?: number;
    minLlmCallsPerTrajectory?: number;
  }): Promise<{ dataset: TrainingDatasetRecord }> {
    return this.fetch("/api/training/datasets/build", {
      method: "POST",
      body: JSON.stringify(options ?? {}),
    });
  }

  async listTrainingJobs(): Promise<{ jobs: TrainingJobRecord[] }> {
    return this.fetch("/api/training/jobs");
  }

  async startTrainingJob(
    options?: StartTrainingOptions,
  ): Promise<{ job: TrainingJobRecord }> {
    return this.fetch("/api/training/jobs", {
      method: "POST",
      body: JSON.stringify(options ?? {}),
    });
  }

  async getTrainingJob(jobId: string): Promise<{ job: TrainingJobRecord }> {
    return this.fetch(`/api/training/jobs/${encodeURIComponent(jobId)}`);
  }

  async cancelTrainingJob(jobId: string): Promise<{ job: TrainingJobRecord }> {
    return this.fetch(
      `/api/training/jobs/${encodeURIComponent(jobId)}/cancel`,
      {
        method: "POST",
      },
    );
  }

  async listTrainingModels(): Promise<{ models: TrainingModelRecord[] }> {
    return this.fetch("/api/training/models");
  }

  async importTrainingModelToOllama(
    modelId: string,
    options?: {
      modelName?: string;
      baseModel?: string;
      ollamaUrl?: string;
    },
  ): Promise<{ model: TrainingModelRecord }> {
    return this.fetch(
      `/api/training/models/${encodeURIComponent(modelId)}/import-ollama`,
      {
        method: "POST",
        body: JSON.stringify(options ?? {}),
      },
    );
  }

  async activateTrainingModel(
    modelId: string,
    providerModel?: string,
  ): Promise<{
    modelId: string;
    providerModel: string;
    needsRestart: boolean;
  }> {
    return this.fetch(
      `/api/training/models/${encodeURIComponent(modelId)}/activate`,
      {
        method: "POST",
        body: JSON.stringify({ providerModel }),
      },
    );
  }

  async benchmarkTrainingModel(modelId: string): Promise<{
    status: "passed" | "failed";
    output: string;
  }> {
    return this.fetch(
      `/api/training/models/${encodeURIComponent(modelId)}/benchmark`,
      {
        method: "POST",
      },
    );
  }

  async getPlugins(): Promise<{ plugins: PluginInfo[] }> {
    return this.fetch("/api/plugins");
  }

  async fetchModels(
    provider: string,
    refresh = true,
  ): Promise<{ provider: string; models: unknown[] }> {
    const params = new URLSearchParams({ provider });
    if (refresh) params.set("refresh", "true");
    return this.fetch(`/api/models?${params.toString()}`);
  }

  async getCorePlugins(): Promise<CorePluginsResponse> {
    return this.fetch("/api/plugins/core");
  }

  async toggleCorePlugin(
    npmName: string,
    enabled: boolean,
  ): Promise<{ ok: boolean; restarting?: boolean; message?: string }> {
    return this.fetch("/api/plugins/core/toggle", {
      method: "POST",
      body: JSON.stringify({ npmName, enabled }),
    });
  }

  async updatePlugin(
    id: string,
    config: Record<string, unknown>,
  ): Promise<{ ok: boolean; restarting?: boolean }> {
    return this.fetch(`/api/plugins/${id}`, {
      method: "PUT",
      body: JSON.stringify(config),
    });
  }

  async getSecrets(): Promise<{ secrets: SecretInfo[] }> {
    return this.fetch("/api/secrets");
  }

  async updateSecrets(
    secrets: Record<string, string>,
  ): Promise<{ ok: boolean; updated: string[] }> {
    return this.fetch("/api/secrets", {
      method: "PUT",
      body: JSON.stringify({ secrets }),
    });
  }

  async testPluginConnection(id: string): Promise<{
    success: boolean;
    pluginId: string;
    message?: string;
    error?: string;
    durationMs: number;
  }> {
    return this.fetch(`/api/plugins/${encodeURIComponent(id)}/test`, {
      method: "POST",
    });
  }

  async restart(): Promise<{ ok: boolean }> {
    return this.fetch("/api/restart", { method: "POST" });
  }

  async getSkills(): Promise<{ skills: SkillInfo[] }> {
    return this.fetch("/api/skills");
  }

  async refreshSkills(): Promise<{ ok: boolean; skills: SkillInfo[] }> {
    return this.fetch("/api/skills/refresh", { method: "POST" });
  }

  async getLogs(filter?: LogsFilter): Promise<LogsResponse> {
    const params = new URLSearchParams();
    if (filter?.source) params.set("source", filter.source);
    if (filter?.level) params.set("level", filter.level);
    if (filter?.tag) params.set("tag", filter.tag);
    if (filter?.since) params.set("since", String(filter.since));
    const qs = params.toString();
    return this.fetch(`/api/logs${qs ? `?${qs}` : ""}`);
  }

  private buildSecurityAuditParams(
    filter?: SecurityAuditFilter,
    includeStream = false,
  ): URLSearchParams {
    const params = new URLSearchParams();
    if (filter?.type) params.set("type", filter.type);
    if (filter?.severity) params.set("severity", filter.severity);
    if (filter?.since !== undefined) {
      const sinceValue =
        filter.since instanceof Date
          ? filter.since.toISOString()
          : String(filter.since);
      params.set("since", sinceValue);
    }
    if (filter?.limit !== undefined) params.set("limit", String(filter.limit));
    if (includeStream) params.set("stream", "1");
    return params;
  }

  async getSecurityAudit(
    filter?: SecurityAuditFilter,
  ): Promise<SecurityAuditResponse> {
    const qs = this.buildSecurityAuditParams(filter).toString();
    return this.fetch(`/api/security/audit${qs ? `?${qs}` : ""}`);
  }

  async streamSecurityAudit(
    onEvent: (event: SecurityAuditStreamEvent) => void,
    filter?: SecurityAuditFilter,
    signal?: AbortSignal,
  ): Promise<void> {
    if (!this.apiAvailable) {
      throw new Error("API not available (no HTTP origin)");
    }

    const token = this.apiToken;
    const qs = this.buildSecurityAuditParams(filter, true).toString();
    const res = await fetch(
      `${this.baseUrl}/api/security/audit${qs ? `?${qs}` : ""}`,
      {
        method: "GET",
        headers: {
          Accept: "text/event-stream",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        signal,
      },
    );

    if (!res.ok) {
      const body = (await res
        .json()
        .catch(() => ({ error: res.statusText }))) as Record<string, string>;
      const err = new Error(body.error ?? `HTTP ${res.status}`);
      (err as Error & { status?: number }).status = res.status;
      throw err;
    }

    if (!res.body) {
      throw new Error("Streaming not supported by this browser");
    }

    const parsePayload = (payload: string) => {
      if (!payload) return;
      try {
        const parsed = JSON.parse(payload) as SecurityAuditStreamEvent;
        if (parsed.type === "snapshot" || parsed.type === "entry") {
          onEvent(parsed);
        }
      } catch {
        // Ignore malformed payloads to keep stream consumption resilient.
      }
    };

    const decoder = new TextDecoder();
    const reader = res.body.getReader();
    let buffer = "";

    const findSseEventBreak = (
      chunkBuffer: string,
    ): { index: number; length: number } | null => {
      const lfBreak = chunkBuffer.indexOf("\n\n");
      const crlfBreak = chunkBuffer.indexOf("\r\n\r\n");
      if (lfBreak === -1 && crlfBreak === -1) return null;
      if (lfBreak === -1) return { index: crlfBreak, length: 4 };
      if (crlfBreak === -1) return { index: lfBreak, length: 2 };
      return lfBreak < crlfBreak
        ? { index: lfBreak, length: 2 }
        : { index: crlfBreak, length: 4 };
    };

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      let eventBreak = findSseEventBreak(buffer);
      while (eventBreak) {
        const rawEvent = buffer.slice(0, eventBreak.index);
        buffer = buffer.slice(eventBreak.index + eventBreak.length);
        for (const line of rawEvent.split(/\r?\n/)) {
          if (!line.startsWith("data:")) continue;
          parsePayload(line.slice(5).trim());
        }
        eventBreak = findSseEventBreak(buffer);
      }
    }

    if (buffer.trim()) {
      for (const line of buffer.split(/\r?\n/)) {
        if (!line.startsWith("data:")) continue;
        parsePayload(line.slice(5).trim());
      }
    }
  }

  async getAgentEvents(opts?: {
    afterEventId?: string;
    limit?: number;
    runId?: string;
    fromSeq?: number;
  }): Promise<AgentEventsResponse> {
    const params = new URLSearchParams();
    if (opts?.afterEventId) params.set("after", opts.afterEventId);
    if (typeof opts?.limit === "number")
      params.set("limit", String(opts.limit));
    if (opts?.runId) params.set("runId", opts.runId);
    if (typeof opts?.fromSeq === "number")
      params.set("fromSeq", String(Math.trunc(opts.fromSeq)));
    const qs = params.toString();
    return this.fetch(`/api/agent/events${qs ? `?${qs}` : ""}`);
  }

  async getExtensionStatus(): Promise<ExtensionStatus> {
    return this.fetch("/api/extension/status");
  }

  // Skill Catalog

  async getSkillCatalog(opts?: {
    page?: number;
    perPage?: number;
    sort?: string;
  }): Promise<{
    total: number;
    page: number;
    perPage: number;
    totalPages: number;
    skills: CatalogSkill[];
  }> {
    const params = new URLSearchParams();
    if (opts?.page) params.set("page", String(opts.page));
    if (opts?.perPage) params.set("perPage", String(opts.perPage));
    if (opts?.sort) params.set("sort", opts.sort);
    const qs = params.toString();
    return this.fetch(`/api/skills/catalog${qs ? `?${qs}` : ""}`);
  }

  async searchSkillCatalog(
    query: string,
    limit = 30,
  ): Promise<{
    query: string;
    count: number;
    results: CatalogSearchResult[];
  }> {
    return this.fetch(
      `/api/skills/catalog/search?q=${encodeURIComponent(query)}&limit=${limit}`,
    );
  }

  async getSkillCatalogDetail(slug: string): Promise<{ skill: CatalogSkill }> {
    return this.fetch(`/api/skills/catalog/${encodeURIComponent(slug)}`);
  }

  async refreshSkillCatalog(): Promise<{ ok: boolean; count: number }> {
    return this.fetch("/api/skills/catalog/refresh", { method: "POST" });
  }

  async installCatalogSkill(
    slug: string,
    version?: string,
  ): Promise<{
    ok: boolean;
    slug: string;
    message: string;
    alreadyInstalled?: boolean;
  }> {
    return this.fetch("/api/skills/catalog/install", {
      method: "POST",
      body: JSON.stringify({ slug, version }),
    });
  }

  async uninstallCatalogSkill(slug: string): Promise<{
    ok: boolean;
    slug: string;
    message: string;
  }> {
    return this.fetch("/api/skills/catalog/uninstall", {
      method: "POST",
      body: JSON.stringify({ slug }),
    });
  }

  // Registry / Plugin Store

  async getRegistryPlugins(): Promise<{
    count: number;
    plugins: RegistryPlugin[];
  }> {
    return this.fetch("/api/registry/plugins");
  }

  async getRegistryPluginInfo(
    name: string,
  ): Promise<{ plugin: RegistryPlugin }> {
    return this.fetch(`/api/registry/plugins/${encodeURIComponent(name)}`);
  }

  async getInstalledPlugins(): Promise<{
    count: number;
    plugins: InstalledPlugin[];
  }> {
    return this.fetch("/api/plugins/installed");
  }

  async installRegistryPlugin(
    name: string,
    autoRestart = true,
  ): Promise<PluginInstallResult> {
    return this.fetch("/api/plugins/install", {
      method: "POST",
      body: JSON.stringify({ name, autoRestart }),
    });
  }

  async uninstallRegistryPlugin(
    name: string,
    autoRestart = true,
  ): Promise<{
    ok: boolean;
    pluginName: string;
    message: string;
    error?: string;
  }> {
    return this.fetch("/api/plugins/uninstall", {
      method: "POST",
      body: JSON.stringify({ name, autoRestart }),
    });
  }

  // Agent Export / Import

  /**
   * Export the agent as a password-encrypted .eliza-agent file.
   * Returns the raw Response so the caller can stream the binary body.
   */
  async exportAgent(password: string, includeLogs = false): Promise<Response> {
    if (password.length < AGENT_TRANSFER_MIN_PASSWORD_LENGTH) {
      throw new Error(
        `Password must be at least ${AGENT_TRANSFER_MIN_PASSWORD_LENGTH} characters.`,
      );
    }
    return this.rawRequest("/api/agent/export", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ password, includeLogs }),
    });
  }

  /** Get an estimate of the export size. */
  async getExportEstimate(): Promise<{
    estimatedBytes: number;
    memoriesCount: number;
    entitiesCount: number;
    roomsCount: number;
    worldsCount: number;
    tasksCount: number;
  }> {
    return this.fetch("/api/agent/export/estimate");
  }

  /**
   * Import an agent from a password-encrypted .eliza-agent file.
   * Encodes the password and file into a binary envelope.
   */
  async importAgent(
    password: string,
    fileBuffer: ArrayBuffer,
  ): Promise<{
    success: boolean;
    agentId: string;
    agentName: string;
    counts: Record<string, number>;
  }> {
    if (password.length < AGENT_TRANSFER_MIN_PASSWORD_LENGTH) {
      throw new Error(
        `Password must be at least ${AGENT_TRANSFER_MIN_PASSWORD_LENGTH} characters.`,
      );
    }
    const passwordBytes = new TextEncoder().encode(password);
    const envelope = new Uint8Array(
      4 + passwordBytes.length + fileBuffer.byteLength,
    );
    const view = new DataView(envelope.buffer);
    view.setUint32(0, passwordBytes.length, false);
    envelope.set(passwordBytes, 4);
    envelope.set(new Uint8Array(fileBuffer), 4 + passwordBytes.length);

    const res = await this.rawRequest("/api/agent/import", {
      method: "POST",
      headers: {
        "Content-Type": "application/octet-stream",
      },
      body: envelope,
    });

    const data = (await res.json()) as {
      error?: string;
      success?: boolean;
      agentId?: string;
      agentName?: string;
      counts?: Record<string, number>;
    };
    if (!data.success) {
      throw new Error(data.error ?? `Import failed (${res.status})`);
    }
    return data as {
      success: boolean;
      agentId: string;
      agentName: string;
      counts: Record<string, number>;
    };
  }

  // Character

  async getCharacter(): Promise<{
    character: CharacterData;
    agentName: string;
  }> {
    return this.fetch("/api/character");
  }

  async getRandomName(): Promise<{ name: string }> {
    return this.fetch("/api/character/random-name");
  }

  async generateCharacterField(
    field: string,
    context: {
      name?: string;
      system?: string;
      bio?: string;
      topics?: string[];
      style?: { all?: string[]; chat?: string[]; post?: string[] };
      postExamples?: string[];
    },
    mode?: "append" | "replace",
  ): Promise<{ generated: string }> {
    return this.fetch("/api/character/generate", {
      method: "POST",
      body: JSON.stringify({ field, context, mode }),
    });
  }

  async updateCharacter(
    character: CharacterData,
  ): Promise<{ ok: boolean; character: CharacterData; agentName: string }> {
    return this.fetch("/api/character", {
      method: "PUT",
      body: JSON.stringify(character),
    });
  }

  // Wallet

  async getWalletAddresses(): Promise<WalletAddresses> {
    return this.fetch("/api/wallet/addresses");
  }
  async getWalletBalances(): Promise<WalletBalancesResponse> {
    return this.fetch("/api/wallet/balances");
  }
  async getWalletNfts(): Promise<WalletNftsResponse> {
    return this.fetch("/api/wallet/nfts");
  }
  async getWalletConfig(): Promise<WalletConfigStatus> {
    return this.fetch("/api/wallet/config");
  }
  async updateWalletConfig(
    config: WalletConfigUpdateRequest,
  ): Promise<{ ok: boolean }> {
    return this.fetch("/api/wallet/config", {
      method: "PUT",
      body: JSON.stringify(config),
    });
  }
  async exportWalletKeys(exportToken: string): Promise<WalletExportResult> {
    return this.fetch("/api/wallet/export", {
      method: "POST",
      body: JSON.stringify({ confirm: true, exportToken }),
    });
  }

  // BSC Trading

  async getBscTradePreflight(
    tokenAddress?: string,
  ): Promise<BscTradePreflightResponse> {
    return this.fetch("/api/wallet/trade/preflight", {
      method: "POST",
      body: JSON.stringify(
        tokenAddress?.trim() ? { tokenAddress: tokenAddress.trim() } : {},
      ),
    });
  }

  async getBscTradeQuote(
    request: BscTradeQuoteRequest,
  ): Promise<BscTradeQuoteResponse> {
    return this.fetch("/api/wallet/trade/quote", {
      method: "POST",
      body: JSON.stringify(request),
    });
  }

  async executeBscTrade(
    request: BscTradeExecuteRequest,
  ): Promise<BscTradeExecuteResponse> {
    return this.fetch("/api/wallet/trade/execute", {
      method: "POST",
      body: JSON.stringify(request),
    });
  }

  async executeBscTransfer(
    request: BscTransferExecuteRequest,
  ): Promise<BscTransferExecuteResponse> {
    return this.fetch("/api/wallet/transfer/execute", {
      method: "POST",
      body: JSON.stringify(request),
    });
  }

  async getBscTradeTxStatus(hash: string): Promise<BscTradeTxStatusResponse> {
    return this.fetch(
      `/api/wallet/trade/tx-status?hash=${encodeURIComponent(hash)}`,
    );
  }

  async getWalletTradingProfile(
    window: WalletTradingProfileWindow = "30d",
    source: WalletTradingProfileSourceFilter = "all",
  ): Promise<WalletTradingProfileResponse> {
    const params = new URLSearchParams({
      window,
      source,
    });
    return this.fetch(`/api/wallet/trading/profile?${params.toString()}`);
  }

  async applyProductionWalletDefaults(): Promise<ApplyProductionWalletDefaultsResponse> {
    return this.fetch("/api/wallet/production-defaults", {
      method: "POST",
      body: JSON.stringify({ confirm: true }),
    });
  }

  // Software Updates
  async getUpdateStatus(force = false): Promise<UpdateStatus> {
    return this.fetch(`/api/update/status${force ? "?force=true" : ""}`);
  }
  async setUpdateChannel(
    channel: "stable" | "beta" | "nightly",
  ): Promise<{ channel: string }> {
    return this.fetch("/api/update/channel", {
      method: "PUT",
      body: JSON.stringify({ channel }),
    });
  }

  // Cloud
  async getCloudStatus(): Promise<CloudStatus> {
    return this.fetch("/api/cloud/status");
  }
  async getCloudCredits(): Promise<CloudCredits> {
    return this.fetch("/api/cloud/credits");
  }
  async getCloudBillingSummary(): Promise<CloudBillingSummary> {
    return this.fetch("/api/cloud/billing/summary");
  }
  async getCloudBillingSettings(): Promise<CloudBillingSettings> {
    return this.fetch("/api/cloud/billing/settings");
  }
  async updateCloudBillingSettings(
    request: CloudBillingSettingsUpdateRequest,
  ): Promise<CloudBillingSettings> {
    return this.fetch("/api/cloud/billing/settings", {
      method: "PUT",
      body: JSON.stringify(request),
    });
  }
  async getCloudBillingPaymentMethods(): Promise<{
    success?: boolean;
    data?: CloudBillingPaymentMethod[];
    items?: CloudBillingPaymentMethod[];
    paymentMethods?: CloudBillingPaymentMethod[];
    [key: string]: unknown;
  }> {
    return this.fetch("/api/cloud/billing/payment-methods");
  }
  async getCloudBillingHistory(): Promise<{
    success?: boolean;
    data?: CloudBillingHistoryItem[];
    items?: CloudBillingHistoryItem[];
    history?: CloudBillingHistoryItem[];
    [key: string]: unknown;
  }> {
    return this.fetch("/api/cloud/billing/history");
  }
  async createCloudBillingCheckout(
    request: CloudBillingCheckoutRequest,
  ): Promise<CloudBillingCheckoutResponse> {
    return this.fetch("/api/cloud/billing/checkout", {
      method: "POST",
      body: JSON.stringify(request),
    });
  }
  async createCloudBillingCryptoQuote(
    request: CloudBillingCryptoQuoteRequest,
  ): Promise<CloudBillingCryptoQuoteResponse> {
    return this.fetch("/api/cloud/billing/crypto/quote", {
      method: "POST",
      body: JSON.stringify(request),
    });
  }
  async cloudLogin(): Promise<CloudLoginResponse> {
    return this.fetch("/api/cloud/login", { method: "POST" });
  }
  async cloudLoginPoll(sessionId: string): Promise<CloudLoginPollResponse> {
    return this.fetch(
      `/api/cloud/login/status?sessionId=${encodeURIComponent(sessionId)}`,
    );
  }
  async cloudDisconnect(): Promise<{ ok: boolean }> {
    return this.fetch("/api/cloud/disconnect", { method: "POST" });
  }

  // Cloud Compat (Eliza Cloud v2 thin-client endpoints)

  /** List all cloud-hosted agents for the authenticated user. */
  async getCloudCompatAgents(): Promise<{
    success: boolean;
    data: CloudCompatAgent[];
  }> {
    return this.fetch("/api/cloud/compat/agents");
  }

  /** Create a new cloud-hosted agent. */
  async createCloudCompatAgent(opts: {
    agentName: string;
    agentConfig?: Record<string, unknown>;
    environmentVars?: Record<string, string>;
  }): Promise<{
    success: boolean;
    data: {
      agentId: string;
      agentName: string;
      jobId: string;
      status: string;
      nodeId: string | null;
      message: string;
    };
  }> {
    return this.fetch("/api/cloud/compat/agents", {
      method: "POST",
      body: JSON.stringify(opts),
    });
  }

  /** Get a specific cloud-hosted agent by ID. */
  async getCloudCompatAgent(agentId: string): Promise<{
    success: boolean;
    data: CloudCompatAgent;
  }> {
    return this.fetch(
      `/api/cloud/compat/agents/${encodeURIComponent(agentId)}`,
    );
  }

  /** Delete a cloud-hosted agent. */
  async deleteCloudCompatAgent(agentId: string): Promise<{
    success: boolean;
    data: { jobId: string; status: string; message: string };
  }> {
    return this.fetch(
      `/api/cloud/compat/agents/${encodeURIComponent(agentId)}`,
      { method: "DELETE" },
    );
  }

  /** Get status of a cloud-hosted agent. */
  async getCloudCompatAgentStatus(agentId: string): Promise<{
    success: boolean;
    data: CloudCompatAgentStatus;
  }> {
    return this.fetch(
      `/api/cloud/compat/agents/${encodeURIComponent(agentId)}/status`,
    );
  }

  /** Get logs from a cloud-hosted agent. */
  async getCloudCompatAgentLogs(
    agentId: string,
    tail = 100,
  ): Promise<{ success: boolean; data: string }> {
    return this.fetch(
      `/api/cloud/compat/agents/${encodeURIComponent(agentId)}/logs?tail=${tail}`,
    );
  }

  /** Restart a cloud-hosted agent. */
  async restartCloudCompatAgent(agentId: string): Promise<{
    success: boolean;
    data: { jobId: string; status: string; message: string };
  }> {
    return this.fetch(
      `/api/cloud/compat/agents/${encodeURIComponent(agentId)}/restart`,
      { method: "POST" },
    );
  }

  /** Suspend a cloud-hosted agent. */
  async suspendCloudCompatAgent(agentId: string): Promise<{
    success: boolean;
    data: { jobId: string; status: string; message: string };
  }> {
    return this.fetch(
      `/api/cloud/compat/agents/${encodeURIComponent(agentId)}/suspend`,
      { method: "POST" },
    );
  }

  /** Resume a cloud-hosted agent. */
  async resumeCloudCompatAgent(agentId: string): Promise<{
    success: boolean;
    data: { jobId: string; status: string; message: string };
  }> {
    return this.fetch(
      `/api/cloud/compat/agents/${encodeURIComponent(agentId)}/resume`,
      { method: "POST" },
    );
  }

  /** Launch a managed cloud agent into the Milady app. */
  async launchCloudCompatAgent(agentId: string): Promise<{
    success: boolean;
    data: CloudCompatLaunchResult;
  }> {
    return this.fetch(
      `/api/cloud/compat/agents/${encodeURIComponent(agentId)}/launch`,
      { method: "POST" },
    );
  }

  /** Get cloud availability (capacity info). */
  async getCloudCompatAvailability(): Promise<{
    success: boolean;
    data: {
      totalSlots: number;
      usedSlots: number;
      availableSlots: number;
      acceptingNewAgents: boolean;
    };
  }> {
    return this.fetch("/api/cloud/compat/availability");
  }

  /** Poll a cloud job status by job ID. */
  async getCloudCompatJobStatus(jobId: string): Promise<{
    success: boolean;
    data: CloudCompatJob;
  }> {
    return this.fetch(`/api/cloud/compat/jobs/${encodeURIComponent(jobId)}`);
  }

  // Apps & Registry
  async listApps(): Promise<RegistryAppInfo[]> {
    return this.fetch("/api/apps");
  }
  async searchApps(query: string): Promise<RegistryAppInfo[]> {
    return this.fetch(`/api/apps/search?q=${encodeURIComponent(query)}`);
  }
  async listInstalledApps(): Promise<InstalledAppInfo[]> {
    return this.fetch("/api/apps/installed");
  }
  async stopApp(name: string): Promise<AppStopResult> {
    return this.fetch("/api/apps/stop", {
      method: "POST",
      body: JSON.stringify({ name }),
    });
  }
  async getAppInfo(name: string): Promise<RegistryAppInfo> {
    return this.fetch(`/api/apps/info/${encodeURIComponent(name)}`);
  }
  /** Launch an app: installs its plugin (if needed), returns viewer config for iframe. */
  async launchApp(name: string): Promise<AppLaunchResult> {
    return this.fetch("/api/apps/launch", {
      method: "POST",
      body: JSON.stringify({ name }),
    });
  }
  async listRegistryPlugins(): Promise<RegistryPluginItem[]> {
    return this.fetch("/api/apps/plugins");
  }
  async searchRegistryPlugins(query: string): Promise<RegistryPluginItem[]> {
    return this.fetch(
      `/api/apps/plugins/search?q=${encodeURIComponent(query)}`,
    );
  }
  async listHyperscapeEmbeddedAgents(): Promise<HyperscapeEmbeddedAgentsResponse> {
    return this.fetch("/api/apps/hyperscape/embedded-agents");
  }
  async createHyperscapeEmbeddedAgent(input: {
    characterId: string;
    autoStart?: boolean;
    scriptedRole?: HyperscapeScriptedRole;
  }): Promise<HyperscapeEmbeddedAgentMutationResponse> {
    return this.fetch("/api/apps/hyperscape/embedded-agents", {
      method: "POST",
      body: JSON.stringify(input),
    });
  }
  async controlHyperscapeEmbeddedAgent(
    characterId: string,
    action: HyperscapeEmbeddedAgentControlAction,
  ): Promise<HyperscapeEmbeddedAgentMutationResponse> {
    return this.fetch(
      `/api/apps/hyperscape/embedded-agents/${encodeURIComponent(characterId)}/${action}`,
      { method: "POST" },
    );
  }
  async sendHyperscapeEmbeddedAgentCommand(
    characterId: string,
    command: string,
    data?: { [key: string]: HyperscapeJsonValue },
  ): Promise<HyperscapeActionResponse> {
    return this.fetch(
      `/api/apps/hyperscape/embedded-agents/${encodeURIComponent(characterId)}/command`,
      {
        method: "POST",
        body: JSON.stringify({ command, data }),
      },
    );
  }
  async sendHyperscapeAgentMessage(
    agentId: string,
    content: string,
  ): Promise<HyperscapeActionResponse> {
    return this.fetch(
      `/api/apps/hyperscape/agents/${encodeURIComponent(agentId)}/message`,
      {
        method: "POST",
        body: JSON.stringify({ content }),
      },
    );
  }
  async getHyperscapeAgentGoal(
    agentId: string,
  ): Promise<HyperscapeAgentGoalResponse> {
    return this.fetch(
      `/api/apps/hyperscape/agents/${encodeURIComponent(agentId)}/goal`,
    );
  }
  async getHyperscapeAgentQuickActions(
    agentId: string,
  ): Promise<HyperscapeQuickActionsResponse> {
    return this.fetch(
      `/api/apps/hyperscape/agents/${encodeURIComponent(agentId)}/quick-actions`,
    );
  }

  // Skills Marketplace

  async searchSkillsMarketplace(
    query: string,
    installed: boolean,
    limit: number,
  ): Promise<{ results: SkillMarketplaceResult[] }> {
    const params = new URLSearchParams({
      q: query,
      installed: String(installed),
      limit: String(limit),
    });
    return this.fetch(`/api/skills/marketplace/search?${params}`);
  }

  async getSkillsMarketplaceConfig(): Promise<{ keySet: boolean }> {
    return this.fetch("/api/skills/marketplace/config");
  }

  async updateSkillsMarketplaceConfig(
    apiKey: string,
  ): Promise<{ keySet: boolean }> {
    return this.fetch("/api/skills/marketplace/config", {
      method: "PUT",
      body: JSON.stringify({ apiKey }),
    });
  }

  async installMarketplaceSkill(data: {
    slug?: string;
    githubUrl?: string;
    repository?: string;
    path?: string;
    name?: string;
    description?: string;
    source: string;
    autoRefresh?: boolean;
  }): Promise<void> {
    await this.fetch("/api/skills/marketplace/install", {
      method: "POST",
      body: JSON.stringify(data),
    });
  }

  async uninstallMarketplaceSkill(
    skillId: string,
    autoRefresh: boolean,
  ): Promise<void> {
    await this.fetch("/api/skills/marketplace/uninstall", {
      method: "POST",
      body: JSON.stringify({ id: skillId, autoRefresh }),
    });
  }

  async updateSkill(
    skillId: string,
    enabled: boolean,
  ): Promise<{ skill: SkillInfo }> {
    return this.fetch(`/api/skills/${encodeURIComponent(skillId)}`, {
      method: "PUT",
      body: JSON.stringify({ enabled }),
    });
  }

  // ── Skill CRUD & Security ────────────────────────────────────────────────

  async createSkill(
    name: string,
    description: string,
  ): Promise<{ ok: boolean; skill: SkillInfo; path: string }> {
    return this.fetch("/api/skills/create", {
      method: "POST",
      body: JSON.stringify({ name, description }),
    });
  }

  async openSkill(id: string): Promise<{ ok: boolean; path: string }> {
    return this.fetch(`/api/skills/${encodeURIComponent(id)}/open`, {
      method: "POST",
    });
  }

  async getSkillSource(
    id: string,
  ): Promise<{ ok: boolean; skillId: string; content: string; path: string }> {
    return this.fetch(`/api/skills/${encodeURIComponent(id)}/source`);
  }

  async saveSkillSource(
    id: string,
    content: string,
  ): Promise<{ ok: boolean; skillId: string; skill: SkillInfo }> {
    return this.fetch(`/api/skills/${encodeURIComponent(id)}/source`, {
      method: "PUT",
      body: JSON.stringify({ content }),
    });
  }

  async deleteSkill(
    id: string,
  ): Promise<{ ok: boolean; skillId: string; source: string }> {
    return this.fetch(`/api/skills/${encodeURIComponent(id)}`, {
      method: "DELETE",
    });
  }

  async getSkillScanReport(id: string): Promise<{
    ok: boolean;
    report: SkillScanReportSummary | null;
    acknowledged: boolean;
    acknowledgment: { acknowledgedAt: string; findingCount: number } | null;
  }> {
    return this.fetch(`/api/skills/${encodeURIComponent(id)}/scan`);
  }

  async acknowledgeSkill(
    id: string,
    enable: boolean,
  ): Promise<{
    ok: boolean;
    skillId: string;
    acknowledged: boolean;
    enabled: boolean;
    findingCount: number;
  }> {
    return this.fetch(`/api/skills/${encodeURIComponent(id)}/acknowledge`, {
      method: "POST",
      body: JSON.stringify({ enable }),
    });
  }

  // Workbench

  async getWorkbenchOverview(): Promise<
    WorkbenchOverview & {
      tasksAvailable?: boolean;
      triggersAvailable?: boolean;
      todosAvailable?: boolean;
    }
  > {
    return this.fetch("/api/workbench/overview");
  }

  async listWorkbenchTasks(): Promise<{ tasks: WorkbenchTask[] }> {
    return this.fetch("/api/workbench/tasks");
  }

  async getWorkbenchTask(taskId: string): Promise<{ task: WorkbenchTask }> {
    return this.fetch(`/api/workbench/tasks/${encodeURIComponent(taskId)}`);
  }

  async createWorkbenchTask(data: {
    name: string;
    description?: string;
    tags?: string[];
    isCompleted?: boolean;
  }): Promise<{ task: WorkbenchTask }> {
    return this.fetch("/api/workbench/tasks", {
      method: "POST",
      body: JSON.stringify(data),
    });
  }

  async updateWorkbenchTask(
    taskId: string,
    data: {
      name?: string;
      description?: string;
      tags?: string[];
      isCompleted?: boolean;
    },
  ): Promise<{ task: WorkbenchTask }> {
    return this.fetch(`/api/workbench/tasks/${encodeURIComponent(taskId)}`, {
      method: "PUT",
      body: JSON.stringify(data),
    });
  }

  async deleteWorkbenchTask(taskId: string): Promise<{ ok: boolean }> {
    return this.fetch(`/api/workbench/tasks/${encodeURIComponent(taskId)}`, {
      method: "DELETE",
    });
  }

  async listWorkbenchTodos(): Promise<{ todos: WorkbenchTodo[] }> {
    return this.fetch("/api/workbench/todos");
  }

  async getWorkbenchTodo(todoId: string): Promise<{ todo: WorkbenchTodo }> {
    return this.fetch(`/api/workbench/todos/${encodeURIComponent(todoId)}`);
  }

  async createWorkbenchTodo(data: {
    name: string;
    description?: string;
    priority?: number;
    isUrgent?: boolean;
    type?: string;
    isCompleted?: boolean;
  }): Promise<{ todo: WorkbenchTodo }> {
    return this.fetch("/api/workbench/todos", {
      method: "POST",
      body: JSON.stringify(data),
    });
  }

  async updateWorkbenchTodo(
    todoId: string,
    data: {
      name?: string;
      description?: string;
      priority?: number;
      isUrgent?: boolean;
      type?: string;
      isCompleted?: boolean;
    },
  ): Promise<{ todo: WorkbenchTodo }> {
    return this.fetch(`/api/workbench/todos/${encodeURIComponent(todoId)}`, {
      method: "PUT",
      body: JSON.stringify(data),
    });
  }

  async setWorkbenchTodoCompleted(
    todoId: string,
    isCompleted: boolean,
  ): Promise<void> {
    await this.fetch(
      `/api/workbench/todos/${encodeURIComponent(todoId)}/complete`,
      {
        method: "POST",
        body: JSON.stringify({ isCompleted }),
      },
    );
  }

  async deleteWorkbenchTodo(todoId: string): Promise<{ ok: boolean }> {
    return this.fetch(`/api/workbench/todos/${encodeURIComponent(todoId)}`, {
      method: "DELETE",
    });
  }

  // Registry

  async refreshRegistry(): Promise<void> {
    await this.fetch("/api/apps/refresh", { method: "POST" });
  }

  // Knowledge

  async getKnowledgeStats(): Promise<KnowledgeStats> {
    return this.fetch("/api/knowledge/stats");
  }

  async listKnowledgeDocuments(options?: {
    limit?: number;
    offset?: number;
  }): Promise<KnowledgeDocumentsResponse> {
    const params = new URLSearchParams();
    if (options?.limit) params.set("limit", String(options.limit));
    if (options?.offset) params.set("offset", String(options.offset));
    const query = params.toString();
    return this.fetch(`/api/knowledge/documents${query ? `?${query}` : ""}`);
  }

  async getKnowledgeDocument(
    documentId: string,
  ): Promise<{ document: KnowledgeDocumentDetail }> {
    return this.fetch(
      `/api/knowledge/documents/${encodeURIComponent(documentId)}`,
    );
  }

  async deleteKnowledgeDocument(
    documentId: string,
  ): Promise<{ ok: boolean; deletedFragments: number }> {
    return this.fetch(
      `/api/knowledge/documents/${encodeURIComponent(documentId)}`,
      {
        method: "DELETE",
      },
    );
  }

  async uploadKnowledgeDocument(data: {
    content: string;
    filename: string;
    contentType?: string;
    metadata?: Record<string, unknown>;
  }): Promise<KnowledgeUploadResult> {
    return this.fetch("/api/knowledge/documents", {
      method: "POST",
      body: JSON.stringify(data),
    });
  }

  async uploadKnowledgeDocumentsBulk(data: {
    documents: Array<{
      content: string;
      filename: string;
      contentType?: string;
      metadata?: Record<string, unknown>;
    }>;
  }): Promise<KnowledgeBulkUploadResult> {
    return this.fetch("/api/knowledge/documents/bulk", {
      method: "POST",
      body: JSON.stringify(data),
    });
  }

  async uploadKnowledgeFromUrl(
    url: string,
    metadata?: Record<string, unknown>,
  ): Promise<KnowledgeUploadResult> {
    return this.fetch("/api/knowledge/documents/url", {
      method: "POST",
      body: JSON.stringify({ url, metadata }),
    });
  }

  async searchKnowledge(
    query: string,
    options?: { threshold?: number; limit?: number },
  ): Promise<KnowledgeSearchResponse> {
    const params = new URLSearchParams({ q: query });
    if (options?.threshold !== undefined)
      params.set("threshold", String(options.threshold));
    if (options?.limit !== undefined)
      params.set("limit", String(options.limit));
    return this.fetch(`/api/knowledge/search?${params}`);
  }

  async getKnowledgeFragments(
    documentId: string,
  ): Promise<KnowledgeFragmentsResponse> {
    return this.fetch(
      `/api/knowledge/fragments/${encodeURIComponent(documentId)}`,
    );
  }

  // Memory commands

  async rememberMemory(text: string): Promise<MemoryRememberResponse> {
    return this.fetch("/api/memory/remember", {
      method: "POST",
      body: JSON.stringify({ text }),
    });
  }

  async searchMemory(
    query: string,
    options?: { limit?: number },
  ): Promise<MemorySearchResponse> {
    const params = new URLSearchParams({ q: query });
    if (options?.limit !== undefined)
      params.set("limit", String(options.limit));
    return this.fetch(`/api/memory/search?${params}`);
  }

  async quickContext(
    query: string,
    options?: { limit?: number },
  ): Promise<QuickContextResponse> {
    const params = new URLSearchParams({ q: query });
    if (options?.limit !== undefined)
      params.set("limit", String(options.limit));
    return this.fetch(`/api/context/quick?${params}`);
  }

  // MCP

  async getMcpConfig(): Promise<{ servers: Record<string, McpServerConfig> }> {
    return this.fetch("/api/mcp/config");
  }

  async getMcpStatus(): Promise<{ servers: McpServerStatus[] }> {
    return this.fetch("/api/mcp/status");
  }

  async searchMcpMarketplace(
    query: string,
    limit: number,
  ): Promise<{ results: McpMarketplaceResult[] }> {
    const params = new URLSearchParams({ q: query, limit: String(limit) });
    return this.fetch(`/api/mcp/marketplace/search?${params}`);
  }

  async getMcpServerDetails(
    name: string,
  ): Promise<{ server: McpRegistryServerDetail }> {
    return this.fetch(`/api/mcp/marketplace/${encodeURIComponent(name)}`);
  }

  async addMcpServer(name: string, config: McpServerConfig): Promise<void> {
    await this.fetch("/api/mcp/servers", {
      method: "POST",
      body: JSON.stringify({ name, config }),
    });
  }

  async removeMcpServer(name: string): Promise<void> {
    await this.fetch(`/api/mcp/servers/${encodeURIComponent(name)}`, {
      method: "DELETE",
    });
  }

  // Share Ingest

  async ingestShare(
    payload: ShareIngestPayload,
  ): Promise<{ item: ShareIngestItem }> {
    return this.fetch("/api/ingest/share", {
      method: "POST",
      body: JSON.stringify(payload),
    });
  }

  async consumeShareIngest(): Promise<{ items: ShareIngestItem[] }> {
    return this.fetch("/api/share/consume", { method: "POST" });
  }

  // WebSocket

  connectWs(): void {
    if (this.ws?.readyState === WebSocket.OPEN) return;

    let host: string;
    if (this.baseUrl) {
      host = new URL(this.baseUrl).host;
    } else {
      // In non-HTTP environments (electrobun://, file://, etc.)
      // window.location.host may be empty or a non-routable placeholder like "-".
      const loc = window.location;
      if (loc.protocol !== "http:" && loc.protocol !== "https:") return;
      host = loc.host;
    }

    if (!host) return;

    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    let url = `${protocol}//${host}/ws`;
    const params = new URLSearchParams({ clientId: this.clientId });
    const token = this.apiToken;
    if (token) params.set("token", token);
    url += `?${params.toString()}`;

    this.ws = new WebSocket(url);

    this.ws.onopen = () => {
      this.backoffMs = 500;
      // Reset connection state on successful connection
      this.reconnectAttempt = 0;
      this.disconnectedAt = null;
      this.connectionState = "connected";
      this.emitConnectionStateChange();

      // Notify listeners when the WS reconnects (not on the first connect)
      // so they can re-hydrate state that may have been lost during the gap.
      if (this.wsHasConnectedOnce) {
        const handlers = this.wsHandlers.get("ws-reconnected");
        if (handlers) {
          for (const handler of handlers) {
            handler({ type: "ws-reconnected" });
          }
        }
      }
      this.wsHasConnectedOnce = true;
      if (
        this.wsSendQueue.length > 0 &&
        this.ws?.readyState === WebSocket.OPEN
      ) {
        const pending = this.wsSendQueue;
        this.wsSendQueue = [];
        for (let i = 0; i < pending.length; i++) {
          if (this.ws?.readyState !== WebSocket.OPEN) {
            this.wsSendQueue = pending.slice(i).concat(this.wsSendQueue);
            break;
          }
          try {
            this.ws.send(pending[i]);
          } catch {
            this.wsSendQueue = pending.slice(i).concat(this.wsSendQueue);
            break;
          }
        }
      }
    };

    this.ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data as string) as Record<
          string,
          unknown
        >;
        const type = data.type as string;
        const handlers = this.wsHandlers.get(type);
        if (handlers) {
          for (const handler of handlers) {
            handler(data);
          }
        }
        // Also fire "all" handlers
        const allHandlers = this.wsHandlers.get("*");
        if (allHandlers) {
          for (const handler of allHandlers) {
            handler(data);
          }
        }
      } catch {
        // ignore parse errors
      }
    };

    this.ws.onclose = () => {
      this.ws = null;
      // Track disconnection time if not already set
      if (this.disconnectedAt === null) {
        this.disconnectedAt = Date.now();
      }
      this.reconnectAttempt++;
      // Update state based on attempt count
      if (this.reconnectAttempt >= this.maxReconnectAttempts) {
        this.connectionState = "failed";
      } else {
        this.connectionState = "reconnecting";
      }
      this.emitConnectionStateChange();
      this.scheduleReconnect();
    };

    this.ws.onerror = () => {
      // close handler will fire
    };
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    // Stop reconnecting if we've hit max attempts
    if (this.reconnectAttempt >= this.maxReconnectAttempts) {
      return;
    }
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connectWs();
    }, this.backoffMs);
    this.backoffMs = Math.min(this.backoffMs * 1.5, 10000);
  }

  private emitConnectionStateChange(): void {
    const state = this.getConnectionState();
    for (const listener of this.connectionStateListeners) {
      try {
        listener(state);
      } catch {
        // ignore listener errors
      }
    }
  }

  /** Get the current WebSocket connection state. */
  getConnectionState(): ConnectionStateInfo {
    return {
      state: this.connectionState,
      reconnectAttempt: this.reconnectAttempt,
      maxReconnectAttempts: this.maxReconnectAttempts,
      disconnectedAt: this.disconnectedAt,
    };
  }

  /** Subscribe to connection state changes. Returns an unsubscribe function. */
  onConnectionStateChange(
    listener: (state: ConnectionStateInfo) => void,
  ): () => void {
    this.connectionStateListeners.add(listener);
    return () => {
      this.connectionStateListeners.delete(listener);
    };
  }

  /** Reset connection state and restart reconnection attempts. */
  resetConnection(): void {
    this.reconnectAttempt = 0;
    this.disconnectedAt = null;
    this.connectionState = "disconnected";
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.backoffMs = 500;
    this.emitConnectionStateChange();
    this.connectWs();
  }

  /** Send an arbitrary JSON message over the WebSocket connection. */
  sendWsMessage(data: Record<string, unknown>): void {
    const payload = JSON.stringify(data);
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(payload);
      return;
    }

    // Keep only the newest active-conversation update while disconnected.
    if (data.type === "active-conversation") {
      this.wsSendQueue = this.wsSendQueue.filter((queued) => {
        try {
          const parsed = JSON.parse(queued) as { type?: unknown };
          return parsed.type !== "active-conversation";
        } catch {
          return true;
        }
      });
    }

    if (this.wsSendQueue.length >= this.wsSendQueueLimit) {
      this.wsSendQueue.shift();
    }
    this.wsSendQueue.push(payload);

    if (!this.ws || this.ws.readyState === WebSocket.CLOSED) {
      this.connectWs();
    }
  }

  onWsEvent(type: string, handler: WsEventHandler): () => void {
    if (!this.wsHandlers.has(type)) {
      this.wsHandlers.set(type, new Set());
    }
    this.wsHandlers.get(type)?.add(handler);
    return () => {
      this.wsHandlers.get(type)?.delete(handler);
    };
  }

  private normalizeAssistantText(text: string): string {
    const stripped = stripAssistantStageDirections(text);
    const trimmed = stripped.trim();
    if (trimmed.length === 0) {
      if (
        text.trim().length === 0 ||
        /^\(?no response\)?$/i.test(text.trim())
      ) {
        return GENERIC_NO_RESPONSE_TEXT;
      }
      return "";
    }
    if (/^\(?no response\)?$/i.test(trimmed)) {
      return GENERIC_NO_RESPONSE_TEXT;
    }
    return trimmed;
  }

  private normalizeGreetingText(text: string): string {
    const stripped = stripAssistantStageDirections(text);
    const trimmed = stripped.trim();
    if (trimmed.length === 0 || /^\(?no response\)?$/i.test(trimmed)) {
      return "";
    }
    return trimmed;
  }

  private normalizeConversationMessage(
    message: ConversationMessage,
  ): ConversationMessage {
    if (message.role !== "assistant") return message;
    const text = this.normalizeAssistantText(message.text);
    return text === message.text ? message : { ...message, text };
  }

  private async streamChatEndpoint(
    path: string,
    text: string,
    onToken: (token: string, accumulatedText?: string) => void,
    channelType: ConversationChannelType = "DM",
    signal?: AbortSignal,
    images?: ImageAttachment[],
    conversationMode?: ConversationMode,
  ): Promise<{
    text: string;
    agentName: string;
    completed: boolean;
    usage?: ChatTokenUsage;
  }> {
    const res = await this.rawRequest(path, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "text/event-stream",
      },
      body: JSON.stringify({
        text,
        channelType,
        ...(images?.length ? { images } : {}),
        ...(conversationMode ? { conversationMode } : {}),
      }),
      signal,
    });

    if (!res.body) {
      throw new Error("Streaming not supported by this browser");
    }

    const decoder = new TextDecoder();
    const reader = res.body.getReader();
    let buffer = "";
    let fullText = "";
    let doneText: string | null = null;
    let doneAgentName: string | null = null;
    let doneUsage: ChatTokenUsage | undefined;
    let receivedDone = false;

    const findSseEventBreak = (
      chunkBuffer: string,
    ): { index: number; length: number } | null => {
      const lfBreak = chunkBuffer.indexOf("\n\n");
      const crlfBreak = chunkBuffer.indexOf("\r\n\r\n");

      if (lfBreak === -1 && crlfBreak === -1) return null;
      if (lfBreak === -1) return { index: crlfBreak, length: 4 };
      if (crlfBreak === -1) return { index: lfBreak, length: 2 };
      return lfBreak < crlfBreak
        ? { index: lfBreak, length: 2 }
        : { index: crlfBreak, length: 4 };
    };

    const parseDataLine = (line: string): void => {
      const payload = line.startsWith("data:") ? line.slice(5).trim() : "";
      if (!payload) return;

      let parsed: {
        type?: string;
        text?: string;
        fullText?: string;
        agentName?: string;
        message?: string;
        usage?: {
          promptTokens?: number;
          completionTokens?: number;
          totalTokens?: number;
          model?: string;
        };
      };
      try {
        parsed = JSON.parse(payload) as typeof parsed;
      } catch {
        return;
      }

      if (parsed.type === "token") {
        const chunk = parsed.text ?? "";
        const nextFullText =
          typeof parsed.fullText === "string"
            ? parsed.fullText
            : chunk
              ? mergeStreamingText(fullText, chunk)
              : fullText;
        if (nextFullText === fullText) return;
        fullText = nextFullText;
        onToken(chunk, fullText);
        return;
      }

      if (parsed.type === "done") {
        receivedDone = true;
        if (typeof parsed.fullText === "string") doneText = parsed.fullText;
        if (typeof parsed.agentName === "string" && parsed.agentName.trim()) {
          doneAgentName = parsed.agentName;
        }
        if (parsed.usage) {
          doneUsage = {
            promptTokens: parsed.usage.promptTokens ?? 0,
            completionTokens: parsed.usage.completionTokens ?? 0,
            totalTokens: parsed.usage.totalTokens ?? 0,
            model: parsed.usage.model,
          };
        }
        return;
      }

      if (parsed.type === "error") {
        throw new Error(parsed.message ?? "generation failed");
      }

      // Backward compatibility with legacy stream payloads: { text: "..." }
      if (parsed.text) {
        fullText = mergeStreamingText(fullText, parsed.text);
        onToken(parsed.text, fullText);
      }
    };

    while (true) {
      let done = false;
      let value: Uint8Array | undefined;
      try {
        ({ done, value } = await reader.read());
      } catch (streamErr) {
        console.warn("[api-client] SSE stream interrupted:", streamErr);
        break;
      }
      if (done || !value) break;

      buffer += decoder.decode(value, { stream: true });
      let eventBreak = findSseEventBreak(buffer);
      while (eventBreak) {
        const rawEvent = buffer.slice(0, eventBreak.index);
        buffer = buffer.slice(eventBreak.index + eventBreak.length);
        for (const line of rawEvent.split(/\r?\n/)) {
          if (!line.startsWith("data:")) continue;
          parseDataLine(line);
        }
        eventBreak = findSseEventBreak(buffer);
      }
    }

    if (buffer.trim()) {
      for (const line of buffer.split(/\r?\n/)) {
        if (line.startsWith("data:")) parseDataLine(line);
      }
    }

    const resolvedText = this.normalizeAssistantText(doneText ?? fullText);
    return {
      text: resolvedText,
      agentName: doneAgentName ?? "Milady",
      completed: receivedDone,
      ...(doneUsage ? { usage: doneUsage } : {}),
    };
  }

  /**
   * Send a chat message via the REST endpoint (reliable — does not depend on
   * a WebSocket connection).  Returns the agent's response text.
   */
  async sendChatRest(
    text: string,
    channelType: ConversationChannelType = "DM",
    conversationMode?: ConversationMode,
  ): Promise<{ text: string; agentName: string }> {
    const response = await this.fetch<{ text: string; agentName: string }>(
      "/api/chat",
      {
        method: "POST",
        body: JSON.stringify({
          text,
          channelType,
          ...(conversationMode ? { conversationMode } : {}),
        }),
      },
    );
    return {
      ...response,
      text: this.normalizeAssistantText(response.text),
    };
  }

  async sendChatStream(
    text: string,
    onToken: (token: string, accumulatedText?: string) => void,
    channelType: ConversationChannelType = "DM",
    signal?: AbortSignal,
    conversationMode?: ConversationMode,
  ): Promise<{
    text: string;
    agentName: string;
    completed: boolean;
    usage?: ChatTokenUsage;
  }> {
    return this.streamChatEndpoint(
      "/api/chat/stream",
      text,
      onToken,
      channelType,
      signal,
      undefined,
      conversationMode,
    );
  }

  // Conversations

  async listConversations(): Promise<{ conversations: Conversation[] }> {
    return this.fetch("/api/conversations");
  }

  async createConversation(
    title?: string,
    options?: CreateConversationOptions,
  ): Promise<{ conversation: Conversation; greeting?: ConversationGreeting }> {
    const response = await this.fetch<{
      conversation: Conversation;
      greeting?: ConversationGreeting;
    }>("/api/conversations", {
      method: "POST",
      body: JSON.stringify({
        title,
        ...(options?.bootstrapGreeting === true
          ? { bootstrapGreeting: true }
          : {}),
        ...(typeof options?.lang === "string" && options.lang.trim()
          ? { lang: options.lang.trim() }
          : {}),
      }),
    });
    if (!response.greeting) {
      return response;
    }
    return {
      ...response,
      greeting: {
        ...response.greeting,
        text: this.normalizeGreetingText(response.greeting.text),
      },
    };
  }

  async getConversationMessages(
    id: string,
  ): Promise<{ messages: ConversationMessage[] }> {
    const response = await this.fetch<{ messages: ConversationMessage[] }>(
      `/api/conversations/${encodeURIComponent(id)}/messages`,
    );
    return {
      messages: response.messages.map((message) =>
        this.normalizeConversationMessage(message),
      ),
    };
  }

  async truncateConversationMessages(
    id: string,
    messageId: string,
    options?: { inclusive?: boolean },
  ): Promise<{ ok: boolean; deletedCount: number }> {
    return this.fetch(
      `/api/conversations/${encodeURIComponent(id)}/messages/truncate`,
      {
        method: "POST",
        body: JSON.stringify({
          messageId,
          inclusive: options?.inclusive === true,
        }),
      },
    );
  }

  async sendConversationMessage(
    id: string,
    text: string,
    channelType: ConversationChannelType = "DM",
    images?: ImageAttachment[],
    conversationMode?: ConversationMode,
  ): Promise<{ text: string; agentName: string; blocks?: ContentBlock[] }> {
    const response = await this.fetch<{
      text: string;
      agentName: string;
      blocks?: ContentBlock[];
    }>(`/api/conversations/${encodeURIComponent(id)}/messages`, {
      method: "POST",
      body: JSON.stringify({
        text,
        channelType,
        ...(images?.length ? { images } : {}),
        ...(conversationMode ? { conversationMode } : {}),
      }),
    });
    return {
      ...response,
      text: this.normalizeAssistantText(response.text),
    };
  }

  async sendConversationMessageStream(
    id: string,
    text: string,
    onToken: (token: string, accumulatedText?: string) => void,
    channelType: ConversationChannelType = "DM",
    signal?: AbortSignal,
    images?: ImageAttachment[],
    conversationMode?: ConversationMode,
  ): Promise<{
    text: string;
    agentName: string;
    completed: boolean;
    usage?: ChatTokenUsage;
  }> {
    return this.streamChatEndpoint(
      `/api/conversations/${encodeURIComponent(id)}/messages/stream`,
      text,
      onToken,
      channelType,
      signal,
      images,
      conversationMode,
    );
  }

  async requestGreeting(
    id: string,
    lang?: string,
  ): Promise<{
    text: string;
    agentName: string;
    generated: boolean;
    persisted?: boolean;
  }> {
    const qs = lang ? `?lang=${encodeURIComponent(lang)}` : "";
    const response = await this.fetch<{
      text: string;
      agentName: string;
      generated: boolean;
      persisted?: boolean;
    }>(`/api/conversations/${encodeURIComponent(id)}/greeting${qs}`, {
      method: "POST",
    });
    return {
      ...response,
      text: this.normalizeGreetingText(response.text),
    };
  }

  async renameConversation(
    id: string,
    title: string,
  ): Promise<{ conversation: Conversation }> {
    return this.fetch(`/api/conversations/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify({ title }),
    });
  }

  async deleteConversation(id: string): Promise<{ ok: boolean }> {
    return this.fetch(`/api/conversations/${encodeURIComponent(id)}`, {
      method: "DELETE",
    });
  }

  /** @deprecated Prefer {@link sendChatRest} — WebSocket chat may silently drop messages. */
  sendChat(text: string): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: "chat", text }));
    }
  }

  // ── Database API ──────────────────────────────────────────────────────

  async getDatabaseStatus(): Promise<DatabaseStatus> {
    return this.fetch("/api/database/status");
  }

  async getDatabaseConfig(): Promise<DatabaseConfigResponse> {
    return this.fetch("/api/database/config");
  }

  async saveDatabaseConfig(config: {
    provider?: DatabaseProviderType;
    pglite?: { dataDir?: string };
    postgres?: {
      connectionString?: string;
      host?: string;
      port?: number;
      database?: string;
      user?: string;
      password?: string;
      ssl?: boolean;
    };
  }): Promise<{ saved: boolean; needsRestart: boolean }> {
    return this.fetch("/api/database/config", {
      method: "PUT",
      body: JSON.stringify(config),
    });
  }

  async testDatabaseConnection(creds: {
    connectionString?: string;
    host?: string;
    port?: number;
    database?: string;
    user?: string;
    password?: string;
    ssl?: boolean;
  }): Promise<ConnectionTestResult> {
    return this.fetch("/api/database/test", {
      method: "POST",
      body: JSON.stringify(creds),
    });
  }

  async getDatabaseTables(): Promise<{ tables: TableInfo[] }> {
    return this.fetch("/api/database/tables");
  }

  async getDatabaseRows(
    table: string,
    opts?: {
      offset?: number;
      limit?: number;
      sort?: string;
      order?: "asc" | "desc";
      search?: string;
    },
  ): Promise<TableRowsResponse> {
    const params = new URLSearchParams();
    if (opts?.offset != null) params.set("offset", String(opts.offset));
    if (opts?.limit != null) params.set("limit", String(opts.limit));
    if (opts?.sort) params.set("sort", opts.sort);
    if (opts?.order) params.set("order", opts.order);
    if (opts?.search) params.set("search", opts.search);
    const qs = params.toString();
    return this.fetch(
      `/api/database/tables/${encodeURIComponent(table)}/rows${qs ? `?${qs}` : ""}`,
    );
  }

  async insertDatabaseRow(
    table: string,
    data: Record<string, unknown>,
  ): Promise<{ inserted: boolean; row: Record<string, unknown> | null }> {
    return this.fetch(
      `/api/database/tables/${encodeURIComponent(table)}/rows`,
      {
        method: "POST",
        body: JSON.stringify({ data }),
      },
    );
  }

  async updateDatabaseRow(
    table: string,
    where: Record<string, unknown>,
    data: Record<string, unknown>,
  ): Promise<{ updated: boolean; row: Record<string, unknown> }> {
    return this.fetch(
      `/api/database/tables/${encodeURIComponent(table)}/rows`,
      {
        method: "PUT",
        body: JSON.stringify({ where, data }),
      },
    );
  }

  async deleteDatabaseRow(
    table: string,
    where: Record<string, unknown>,
  ): Promise<{ deleted: boolean; row: Record<string, unknown> }> {
    return this.fetch(
      `/api/database/tables/${encodeURIComponent(table)}/rows`,
      {
        method: "DELETE",
        body: JSON.stringify({ where }),
      },
    );
  }

  async executeDatabaseQuery(
    sql: string,
    readOnly = true,
  ): Promise<QueryResult> {
    return this.fetch("/api/database/query", {
      method: "POST",
      body: JSON.stringify({ sql, readOnly }),
    });
  }

  // ── Trajectories ─────────────────────────────────────────────────────

  async getTrajectories(
    options?: TrajectoryListOptions,
  ): Promise<TrajectoryListResult> {
    const params = new URLSearchParams();
    if (options?.limit) params.set("limit", String(options.limit));
    if (options?.offset) params.set("offset", String(options.offset));
    if (options?.source) params.set("source", options.source);
    if (options?.status) params.set("status", options.status);
    if (options?.startDate) params.set("startDate", options.startDate);
    if (options?.endDate) params.set("endDate", options.endDate);
    if (options?.search) params.set("search", options.search);
    const query = params.toString();
    return this.fetch(`/api/trajectories${query ? `?${query}` : ""}`);
  }

  async getTrajectoryDetail(
    trajectoryId: string,
  ): Promise<TrajectoryDetailResult> {
    return this.fetch(`/api/trajectories/${encodeURIComponent(trajectoryId)}`);
  }

  async getTrajectoryStats(): Promise<TrajectoryStats> {
    return this.fetch("/api/trajectories/stats");
  }

  async getTrajectoryConfig(): Promise<TrajectoryConfig> {
    return this.fetch("/api/trajectories/config");
  }

  async updateTrajectoryConfig(
    config: Partial<TrajectoryConfig>,
  ): Promise<TrajectoryConfig> {
    return this.fetch("/api/trajectories/config", {
      method: "PUT",
      body: JSON.stringify(config),
    });
  }

  async exportTrajectories(options: TrajectoryExportOptions): Promise<Blob> {
    const res = await this.rawRequest("/api/trajectories/export", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(options),
    });
    return res.blob();
  }

  async deleteTrajectories(
    trajectoryIds: string[],
  ): Promise<{ deleted: number }> {
    return this.fetch("/api/trajectories", {
      method: "DELETE",
      body: JSON.stringify({ trajectoryIds }),
    });
  }

  async clearAllTrajectories(): Promise<{ deleted: number }> {
    return this.fetch("/api/trajectories", {
      method: "DELETE",
      body: JSON.stringify({ clearAll: true }),
    });
  }

  // ═══════════════════════════════════════════════════════════════════════
  //  System Permissions
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Get all system permission states.
   */
  async getPermissions(): Promise<AllPermissionsState> {
    return this.fetch("/api/permissions");
  }

  /**
   * Get a single permission state.
   */
  async getPermission(id: SystemPermissionId): Promise<PermissionState> {
    return this.fetch(`/api/permissions/${id}`);
  }

  /**
   * Request a specific permission (triggers OS prompt if applicable).
   */
  async requestPermission(id: SystemPermissionId): Promise<PermissionState> {
    return this.fetch(`/api/permissions/${id}/request`, { method: "POST" });
  }

  /**
   * Open system settings for a specific permission.
   */
  async openPermissionSettings(id: SystemPermissionId): Promise<void> {
    await this.fetch(`/api/permissions/${id}/open-settings`, {
      method: "POST",
    });
  }

  /**
   * Refresh all permission states from the OS.
   */
  async refreshPermissions(): Promise<AllPermissionsState> {
    return this.fetch("/api/permissions/refresh", { method: "POST" });
  }

  /**
   * Enable or disable shell access.
   */
  async setShellEnabled(enabled: boolean): Promise<PermissionState> {
    return this.fetch("/api/permissions/shell", {
      method: "PUT",
      body: JSON.stringify({ enabled }),
    });
  }

  /**
   * Get shell enabled status.
   */
  async isShellEnabled(): Promise<boolean> {
    const result = await this.fetch<{ enabled: boolean }>(
      "/api/permissions/shell",
    );
    return result.enabled;
  }

  /**
   * Get agent automation permission mode.
   */
  async getAgentAutomationMode(): Promise<AgentAutomationModeResponse> {
    return this.fetch("/api/permissions/automation-mode");
  }

  /**
   * Set agent automation permission mode.
   */
  async setAgentAutomationMode(
    mode: AgentAutomationMode,
  ): Promise<AgentAutomationModeResponse> {
    return this.fetch("/api/permissions/automation-mode", {
      method: "PUT",
      body: JSON.stringify({ mode }),
    });
  }

  /**
   * Get wallet trade execution permission mode.
   */
  async getTradePermissionMode(): Promise<TradePermissionModeResponse> {
    return this.fetch("/api/permissions/trade-mode");
  }

  /**
   * Set wallet trade execution permission mode.
   */
  async setTradePermissionMode(
    mode: TradePermissionMode,
  ): Promise<TradePermissionModeResponse> {
    return this.fetch("/api/permissions/trade-mode", {
      method: "PUT",
      body: JSON.stringify({ mode }),
    });
  }

  disconnectWs(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.ws?.close();
    this.ws = null;
    this.wsSendQueue = [];
    // Reset connection state on intentional disconnect
    this.reconnectAttempt = 0;
    this.disconnectedAt = null;
    this.connectionState = "disconnected";
    this.emitConnectionStateChange();
  }

  // ═══════════════════════════════════════════════════════════════════════
  //  ERC-8004 Registry
  // ═══════════════════════════════════════════════════════════════════════

  async getRegistryStatus(): Promise<RegistryStatus> {
    return this.fetch("/api/registry/status");
  }

  async registerAgent(params?: {
    name?: string;
    endpoint?: string;
    tokenURI?: string;
  }): Promise<RegistrationResult> {
    return this.fetch("/api/registry/register", {
      method: "POST",
      body: JSON.stringify(params ?? {}),
    });
  }

  async updateRegistryTokenURI(
    tokenURI: string,
  ): Promise<{ ok: boolean; txHash: string }> {
    return this.fetch("/api/registry/update-uri", {
      method: "POST",
      body: JSON.stringify({ tokenURI }),
    });
  }

  async syncRegistryProfile(params?: {
    name?: string;
    endpoint?: string;
    tokenURI?: string;
  }): Promise<{ ok: boolean; txHash: string }> {
    return this.fetch("/api/registry/sync", {
      method: "POST",
      body: JSON.stringify(params ?? {}),
    });
  }

  async getRegistryConfig(): Promise<RegistryConfig> {
    return this.fetch("/api/registry/config");
  }

  // ═══════════════════════════════════════════════════════════════════════
  //  Drop / Mint
  // ═══════════════════════════════════════════════════════════════════════

  async getDropStatus(): Promise<DropStatus> {
    return this.fetch("/api/drop/status");
  }

  async mintAgent(params?: {
    name?: string;
    endpoint?: string;
    shiny?: boolean;
  }): Promise<MintResult> {
    return this.fetch("/api/drop/mint", {
      method: "POST",
      body: JSON.stringify(params ?? {}),
    });
  }

  async mintAgentWhitelist(params: {
    name?: string;
    endpoint?: string;
    proof: string[];
  }): Promise<MintResult> {
    return this.fetch("/api/drop/mint-whitelist", {
      method: "POST",
      body: JSON.stringify(params),
    });
  }

  // ═══════════════════════════════════════════════════════════════════════
  //  Whitelist
  // ═══════════════════════════════════════════════════════════════════════

  async getWhitelistStatus(): Promise<WhitelistStatus> {
    return this.fetch("/api/whitelist/status");
  }

  async generateTwitterVerificationMessage(): Promise<VerificationMessageResponse> {
    return this.fetch("/api/whitelist/twitter/message", { method: "POST" });
  }

  async verifyTwitter(tweetUrl: string): Promise<VerificationResult> {
    return this.fetch("/api/whitelist/twitter/verify", {
      method: "POST",
      body: JSON.stringify({ tweetUrl }),
    });
  }

  // ── Custom Actions ─────────────────────────────────────────────────────

  async listCustomActions(): Promise<CustomActionDef[]> {
    const data = await this.fetch<{ actions: CustomActionDef[] }>(
      "/api/custom-actions",
    );
    return data.actions;
  }

  async createCustomAction(
    action: Omit<CustomActionDef, "id" | "createdAt" | "updatedAt">,
  ): Promise<CustomActionDef> {
    const data = await this.fetch<{ ok: boolean; action: CustomActionDef }>(
      "/api/custom-actions",
      { method: "POST", body: JSON.stringify(action) },
    );
    return data.action;
  }

  async updateCustomAction(
    id: string,
    action: Partial<CustomActionDef>,
  ): Promise<CustomActionDef> {
    const data = await this.fetch<{ ok: boolean; action: CustomActionDef }>(
      `/api/custom-actions/${encodeURIComponent(id)}`,
      { method: "PUT", body: JSON.stringify(action) },
    );
    return data.action;
  }

  async deleteCustomAction(id: string): Promise<void> {
    await this.fetch(`/api/custom-actions/${encodeURIComponent(id)}`, {
      method: "DELETE",
    });
  }

  async testCustomAction(
    id: string,
    params: Record<string, string>,
  ): Promise<{
    ok: boolean;
    output: string;
    error?: string;
    durationMs: number;
  }> {
    return this.fetch(`/api/custom-actions/${encodeURIComponent(id)}/test`, {
      method: "POST",
      body: JSON.stringify({ params }),
    });
  }

  async generateCustomAction(
    prompt: string,
  ): Promise<{ ok: boolean; generated: Record<string, unknown> }> {
    return this.fetch("/api/custom-actions/generate", {
      method: "POST",
      body: JSON.stringify({ prompt }),
    });
  }

  // ═══════════════════════════════════════════════════════════════════════
  //  WhatsApp Pairing
  // ═══════════════════════════════════════════════════════════════════════

  async getWhatsAppStatus(accountId = "default"): Promise<{
    accountId: string;
    status: string;
    authExists: boolean;
    serviceConnected: boolean;
    servicePhone: string | null;
  }> {
    return this.fetch(
      `/api/whatsapp/status?accountId=${encodeURIComponent(accountId)}`,
    );
  }

  async startWhatsAppPairing(accountId = "default"): Promise<{
    ok: boolean;
    accountId: string;
    status: string;
    error?: string;
  }> {
    return this.fetch("/api/whatsapp/pair", {
      method: "POST",
      body: JSON.stringify({ accountId }),
    });
  }

  async stopWhatsAppPairing(accountId = "default"): Promise<{
    ok: boolean;
    accountId: string;
    status: string;
  }> {
    return this.fetch("/api/whatsapp/pair/stop", {
      method: "POST",
      body: JSON.stringify({ accountId }),
    });
  }

  async disconnectWhatsApp(accountId = "default"): Promise<{
    ok: boolean;
    accountId: string;
  }> {
    return this.fetch("/api/whatsapp/disconnect", {
      method: "POST",
      body: JSON.stringify({ accountId }),
    });
  }

  // --- Bug Report ---

  async checkBugReportInfo(): Promise<{
    nodeVersion?: string;
    platform?: string;
  }> {
    return this.fetch("/api/bug-report/info");
  }

  async submitBugReport(report: {
    description: string;
    stepsToReproduce: string;
    expectedBehavior?: string;
    actualBehavior?: string;
    environment?: string;
    nodeVersion?: string;
    modelProvider?: string;
    logs?: string;
  }): Promise<{ url?: string; fallback?: string }> {
    return this.fetch("/api/bug-report", {
      method: "POST",
      body: JSON.stringify(report),
    });
  }

  // ── Coding Agents ───────────────────────────────────────────────────

  async getCodingAgentStatus(): Promise<CodingAgentStatus | null> {
    try {
      return await this.fetch<CodingAgentStatus>(
        "/api/coding-agents/coordinator/status",
      );
    } catch {
      return null;
    }
  }

  async stopCodingAgent(sessionId: string): Promise<boolean> {
    try {
      await this.fetch(
        `/api/coding-agents/${encodeURIComponent(sessionId)}/stop`,
        { method: "POST" },
      );
      return true;
    } catch {
      return false;
    }
  }

  async listCodingAgentScratchWorkspaces(): Promise<
    CodingAgentScratchWorkspace[]
  > {
    try {
      return await this.fetch<CodingAgentScratchWorkspace[]>(
        "/api/coding-agents/scratch",
      );
    } catch {
      return [];
    }
  }

  async keepCodingAgentScratchWorkspace(sessionId: string): Promise<boolean> {
    try {
      await this.fetch(
        `/api/coding-agents/${encodeURIComponent(sessionId)}/scratch/keep`,
        { method: "POST" },
      );
      return true;
    } catch {
      return false;
    }
  }

  async deleteCodingAgentScratchWorkspace(sessionId: string): Promise<boolean> {
    try {
      // Keep POST for compatibility with plugin route handlers.
      await this.fetch(
        `/api/coding-agents/${encodeURIComponent(sessionId)}/scratch/delete`,
        { method: "POST" },
      );
      return true;
    } catch {
      return false;
    }
  }

  async promoteCodingAgentScratchWorkspace(
    sessionId: string,
    name?: string,
  ): Promise<CodingAgentScratchWorkspace | null> {
    try {
      const response = await this.fetch<{
        success: boolean;
        scratch?: CodingAgentScratchWorkspace;
      }>(
        `/api/coding-agents/${encodeURIComponent(sessionId)}/scratch/promote`,
        {
          method: "POST",
          body: JSON.stringify(name ? { name } : {}),
        },
      );
      return response.scratch ?? null;
    } catch {
      return null;
    }
  }

  // ── PTY Terminal (xterm.js bridge) ─────────────────────────────────────

  /** Subscribe to live PTY output for a session over WebSocket. */
  subscribePtyOutput(sessionId: string): void {
    this.sendWsMessage({ type: "pty-subscribe", sessionId });
  }

  /** Unsubscribe from live PTY output for a session. */
  unsubscribePtyOutput(sessionId: string): void {
    this.sendWsMessage({ type: "pty-unsubscribe", sessionId });
  }

  /** Send raw keyboard input to a PTY session. */
  sendPtyInput(sessionId: string, data: string): void {
    this.sendWsMessage({ type: "pty-input", sessionId, data });
  }

  /** Resize a PTY session's terminal dimensions. */
  resizePty(sessionId: string, cols: number, rows: number): void {
    this.sendWsMessage({ type: "pty-resize", sessionId, cols, rows });
  }

  /** Fetch buffered terminal output (raw ANSI) for xterm.js hydration. */
  async getPtyBufferedOutput(sessionId: string): Promise<string> {
    try {
      const res = await this.fetch<{ output: string }>(
        `/api/coding-agents/${encodeURIComponent(sessionId)}/buffered-output`,
      );
      return res.output ?? "";
    } catch {
      return "";
    }
  }

  // ── Stream controls ─────────────────────────────────────────────────────

  async streamGoLive(): Promise<{
    ok: boolean;
    live: boolean;
    rtmpUrl?: string;
    inputMode?: string;
    audioSource?: string;
    message?: string;
    destination?: string;
  }> {
    return this.fetch("/api/stream/live", { method: "POST" });
  }

  async streamGoOffline(): Promise<{ ok: boolean; live: boolean }> {
    return this.fetch("/api/stream/offline", { method: "POST" });
  }

  async streamStatus(): Promise<{
    ok: boolean;
    running: boolean;
    ffmpegAlive: boolean;
    uptime: number;
    frameCount: number;
    volume: number;
    muted: boolean;
    audioSource: string;
    inputMode: string | null;
    destination?: { id: string; name: string } | null;
  }> {
    return this.fetch("/api/stream/status");
  }

  async getStreamingDestinations(): Promise<{
    ok: boolean;
    destinations: Array<{ id: string; name: string }>;
  }> {
    return this.fetch("/api/streaming/destinations");
  }

  async setActiveDestination(destinationId: string): Promise<{
    ok: boolean;
    destination?: { id: string; name: string };
  }> {
    return this.fetch("/api/streaming/destination", {
      method: "POST",
      body: JSON.stringify({ destinationId }),
    });
  }

  async setStreamVolume(
    volume: number,
  ): Promise<{ ok: boolean; volume: number; muted: boolean }> {
    return this.fetch("/api/stream/volume", {
      method: "POST",
      body: JSON.stringify({ volume }),
    });
  }

  async muteStream(): Promise<{ ok: boolean; muted: boolean; volume: number }> {
    return this.fetch("/api/stream/mute", { method: "POST" });
  }

  async unmuteStream(): Promise<{
    ok: boolean;
    muted: boolean;
    volume: number;
  }> {
    return this.fetch("/api/stream/unmute", { method: "POST" });
  }

  // ── Stream voice (TTS) ───────────────────────────────────────────────

  async getStreamVoice(): Promise<{
    ok: boolean;
    enabled: boolean;
    autoSpeak: boolean;
    provider: string | null;
    configuredProvider: string | null;
    hasApiKey: boolean;
    isSpeaking: boolean;
    isAttached: boolean;
  }> {
    return this.fetch("/api/stream/voice");
  }

  async saveStreamVoice(settings: {
    enabled?: boolean;
    autoSpeak?: boolean;
    provider?: string;
  }): Promise<{
    ok: boolean;
    voice: { enabled: boolean; autoSpeak: boolean };
  }> {
    return this.fetch("/api/stream/voice", {
      method: "POST",
      body: JSON.stringify(settings),
    });
  }

  async streamVoiceSpeak(
    text: string,
  ): Promise<{ ok: boolean; speaking: boolean }> {
    return this.fetch("/api/stream/voice/speak", {
      method: "POST",
      body: JSON.stringify({ text }),
    });
  }

  // ── Overlay layout ────────────────────────────────────────────────────

  async getOverlayLayout(
    destinationId?: string | null,
  ): Promise<{ ok: boolean; layout: unknown; destinationId?: string }> {
    const qs = destinationId
      ? `?destination=${encodeURIComponent(destinationId)}`
      : "";
    return this.fetch(`/api/stream/overlay-layout${qs}`);
  }

  async saveOverlayLayout(
    layout: unknown,
    destinationId?: string | null,
  ): Promise<{ ok: boolean; layout: unknown; destinationId?: string }> {
    const qs = destinationId
      ? `?destination=${encodeURIComponent(destinationId)}`
      : "";
    return this.fetch(`/api/stream/overlay-layout${qs}`, {
      method: "POST",
      body: JSON.stringify({ layout }),
    });
  }

  // ── Stream source picker ──────────────────────────────────────────────

  async getStreamSource(): Promise<{
    source: { type: string; url?: string };
  }> {
    return this.fetch("/api/stream/source");
  }

  async setStreamSource(
    sourceType: string,
    customUrl?: string,
  ): Promise<{ ok: boolean; source: { type: string; url?: string } }> {
    return this.fetch("/api/stream/source", {
      method: "POST",
      body: JSON.stringify({ sourceType, customUrl }),
    });
  }

  // ── Stream visual settings (theme, avatar for headless parity) ────────

  async getStreamSettings(): Promise<{
    ok: boolean;
    settings: { theme?: string; avatarIndex?: number };
  }> {
    return this.fetch("/api/stream/settings");
  }

  async saveStreamSettings(settings: {
    theme?: string;
    avatarIndex?: number;
  }): Promise<{ ok: boolean; settings: unknown }> {
    return this.fetch("/api/stream/settings", {
      method: "POST",
      body: JSON.stringify({ settings }),
    });
  }

  // ── Direct Eliza Cloud Auth (no local backend required) ─────────────

  /**
   * Initiate a direct login to Eliza Cloud without going through a local agent.
   * Used in sandbox mode when no local backend exists yet.
   */
  async cloudLoginDirect(
    cloudApiBase: string,
  ): Promise<{ ok: boolean; browserUrl?: string; sessionId?: string; error?: string }> {
    const res = await fetch(`${cloudApiBase}/api/v1/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    });
    if (!res.ok) {
      return { ok: false, error: `Login failed (${res.status})` };
    }
    return res.json();
  }

  /**
   * Poll a direct Eliza Cloud login session for authentication status.
   */
  async cloudLoginPollDirect(
    cloudApiBase: string,
    sessionId: string,
  ): Promise<{
    status: "pending" | "authenticated" | "expired" | "error";
    token?: string;
    userId?: string;
    error?: string;
  }> {
    const res = await fetch(
      `${cloudApiBase}/api/v1/auth/login/status?sessionId=${encodeURIComponent(sessionId)}`,
    );
    if (!res.ok) {
      return { status: "error", error: `Poll failed (${res.status})` };
    }
    return res.json();
  }

  // ── Eliza Cloud Sandbox Provisioning ───────────────────────────────

  /**
   * Create a sandbox agent on Eliza Cloud and provision it.
   * Returns the bridge URL when provisioning completes.
   *
   * Flow:
   *   1. POST /api/v1/milady/agents — create agent record
   *   2. POST /api/v1/milady/agents/{id}/provision — start async provisioning
   *   3. Poll GET /api/v1/jobs/{jobId} until completed
   *   4. Return bridgeUrl from job result
   */
  async provisionCloudSandbox(options: {
    cloudApiBase: string;
    authToken: string;
    name: string;
    bio?: string[];
    onProgress?: (status: string, detail?: string) => void;
  }): Promise<{ bridgeUrl: string; agentId: string }> {
    const { cloudApiBase, authToken, name, bio, onProgress } = options;
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${authToken}`,
    };

    onProgress?.("creating", "Creating agent...");

    // Step 1: Create agent
    const createRes = await fetch(`${cloudApiBase}/api/v1/milady/agents`, {
      method: "POST",
      headers,
      body: JSON.stringify({ name, bio }),
    });
    if (!createRes.ok) {
      const err = await createRes.text().catch(() => "Unknown error");
      throw new Error(`Failed to create cloud agent: ${err}`);
    }
    const createData = (await createRes.json()) as { id: string };
    const agentId = createData.id;

    onProgress?.("provisioning", "Provisioning sandbox environment...");

    // Step 2: Start provisioning
    const provisionRes = await fetch(
      `${cloudApiBase}/api/v1/milady/agents/${agentId}/provision`,
      { method: "POST", headers },
    );
    if (!provisionRes.ok) {
      const err = await provisionRes.text().catch(() => "Unknown error");
      throw new Error(`Failed to start provisioning: ${err}`);
    }
    const provisionData = (await provisionRes.json()) as { jobId: string };
    const jobId = provisionData.jobId;

    // Step 3: Poll job status
    const deadline = Date.now() + 120_000; // 2 minute timeout
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 2000));

      const jobRes = await fetch(`${cloudApiBase}/api/v1/jobs/${jobId}`, {
        headers,
      });
      if (!jobRes.ok) continue;

      const jobData = (await jobRes.json()) as {
        status: string;
        result?: { bridgeUrl?: string };
        error?: string;
      };

      if (jobData.status === "completed" && jobData.result?.bridgeUrl) {
        onProgress?.("ready", "Sandbox ready!");
        return { bridgeUrl: jobData.result.bridgeUrl, agentId };
      }

      if (jobData.status === "failed") {
        throw new Error(
          `Provisioning failed: ${jobData.error ?? "Unknown error"}`,
        );
      }

      onProgress?.("provisioning", `Status: ${jobData.status}...`);
    }

    throw new Error("Provisioning timed out after 2 minutes");
  }
}

/** @deprecated Use MiladyClient directly. */
export type ElizaClient = MiladyClient;

// Singleton
export const client = new MiladyClient();
