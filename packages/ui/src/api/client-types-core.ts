/**
 * Core-domain client DTOs: Database*, Agent*, ApiError, Runtime*, WebSocket*,
 * ConnectionState*, Sandbox*. One slice of the ElizaClient type surface,
 * re-exported through client-types.ts.
 */

import type {
  TrajectoryExportFormat,
  TriggerLastStatus,
  TriggerRunRecord,
  TriggerType,
  TriggerWakeMode,
} from "@elizaos/core";
import type {
  CustomActionDef,
  CustomActionHandler,
  DatabaseProviderType,
  ReleaseChannel,
  AgentAutomationMode as SharedAgentAutomationMode,
  ColumnInfo as SharedColumnInfo,
  ConnectionTestResult as SharedConnectionTestResult,
  ConversationAutomationType as SharedConversationAutomationType,
  ConversationMetadata as SharedConversationMetadata,
  ConversationScope as SharedConversationScope,
  CreateTriggerRequest as SharedCreateTriggerRequest,
  DatabaseStatus as SharedDatabaseStatus,
  QueryResult as SharedQueryResult,
  RuntimeOrderItem as SharedRuntimeOrderItem,
  RuntimeServiceOrderItem as SharedRuntimeServiceOrderItem,
  StreamEventEnvelope as SharedStreamEventEnvelope,
  StreamEventType as SharedStreamEventType,
  TableInfo as SharedTableInfo,
  TradePermissionMode as SharedTradePermissionMode,
  TriggerHealthSnapshot as SharedTriggerHealthSnapshot,
  TriggerSummary as SharedTriggerSummary,
  TriggerTaskMetadata as SharedTriggerTaskMetadata,
  UpdateTriggerRequest as SharedUpdateTriggerRequest,
} from "@elizaos/shared";
import type { BrowserBridgeCompanionReleaseManifest } from "./browser-contracts";

export type {
  CustomActionDef,
  CustomActionHandler,
  DatabaseProviderType,
  ReleaseChannel,
  TrajectoryExportFormat,
  TriggerLastStatus,
  TriggerRunRecord,
  TriggerType,
  TriggerWakeMode,
};

// Use server-types / types only — do not re-export from api/server or
// api/trajectory-routes (those modules pull the full API + app-training into Vite).

export type ConversationScope = SharedConversationScope;
export type ConversationAutomationType = SharedConversationAutomationType;
export type ConversationMetadata = SharedConversationMetadata;
export type StreamEventType = SharedStreamEventType;
export type StreamEventEnvelope = SharedStreamEventEnvelope;
export type AgentAutomationMode = SharedAgentAutomationMode;
export type TriggerTaskMetadata = SharedTriggerTaskMetadata;
export type TriggerSummary = SharedTriggerSummary;
export type TriggerHealthSnapshot = SharedTriggerHealthSnapshot;
export type CreateTriggerRequest = SharedCreateTriggerRequest;
export type UpdateTriggerRequest = SharedUpdateTriggerRequest;
export type DatabaseStatus = SharedDatabaseStatus;
export type ConnectionTestResult = SharedConnectionTestResult;
export type TableInfo = SharedTableInfo;
export type ColumnInfo = SharedColumnInfo;
export type QueryResult = SharedQueryResult;
export type RuntimeOrderItem = SharedRuntimeOrderItem;
export type RuntimeServiceOrderItem = SharedRuntimeServiceOrderItem;

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

export interface TableRowsResponse {
  table: string;
  rows: Record<string, unknown>[];
  columns: string[];
  total: number;
  offset: number;
  limit: number;
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
  /** Local embedding (GGUF) warmup — from status overlay */
  embeddingPhase?: "checking" | "downloading" | "loading" | "ready";
  embeddingDetail?: string;
  /** 0–100 when parseable from embedding detail */
  embeddingProgressPct?: number;
}

export interface AgentStatus {
  state: AgentState;
  agentName: string;
  model: string | undefined;
  /**
   * First-turn capability online: the agent has a live runtime + a registered
   * TEXT handler and can actually answer (distinct from a bare "running" with no
   * provider wired). Server-authoritative (`/api/health` + `/api/status`); drives
   * the async-generate + fade-in of the chat composer. Optional for back-compat
   * with older agents/transports that don't report it.
   */
  canRespond?: boolean;
  uptime: number | undefined;
  startedAt: number | undefined;
  port?: number;
  pendingRestart?: boolean;
  pendingRestartReasons?: string[];
  startup?: AgentStartupDiagnostics;
  /**
   * Live resume/provision progress for a dedicated cloud agent that answered
   * the status probe with `202 Accepted` while it warms (#14040 sub-defect 2).
   * Present only during an in-flight resume; carries the cloud proxy's honest
   * progress body (`{status,jobId,retryAfterMs}`) so the launcher can render a
   * "resuming…" state (and reset its slow-boot escalation) instead of an
   * indistinguishable spinner. Absent for a normal running/stopped status.
   */
  resumeProgress?: AgentResumeProgress;
}

/**
 * The cloud dedicated-agent-proxy's `202` resume body, mapped onto
 * {@link AgentStatus.resumeProgress}. A truthy `jobId` (or any freshly-observed
 * progress) is the launcher's "boot is still making progress" signal.
 */
export interface AgentResumeProgress {
  /** The proxy's `status` field for the in-flight resume (e.g. "starting"). */
  status: string;
  /** The resume job's id when the proxy reports one; a change signals progress. */
  jobId?: string;
  /** Advertised retry interval (ms) the proxy asked the client to wait. */
  retryAfterMs?: number;
  /** True when the proxy reported the resume was already underway. */
  alreadyInProgress?: boolean;
  /**
   * Client-side timestamp (ms) of THIS observed resume probe. A single
   * long-running resume keeps the same `status`/`jobId` across polls, so those
   * alone can't distinguish "still progressing" from "stalled"; a fresh
   * `observedAt` on every successful 202 is the "a live probe just succeeded"
   * heartbeat that resets the launcher's slow-boot escalation window (#14040
   * sub-defect 3). Stamped by the status client on each observation, not by the
   * server.
   */
  observedAt?: number;
}

export interface AgentBootProgress {
  state: "not_started" | "starting" | "running" | "stopped" | "error";
  phase: string | null;
  lastError: string | null;
  pluginsLoaded: number | null;
  pluginsFailed: number | null;
  database: "ok" | "unknown" | "error" | null;
  agentName: string | null;
  port: number | null;
  startedAt: number | null;
  updatedAt: string;
}

export type LaunchPhase =
  | "static-shell"
  | "agent-process-starting"
  | "agent-api-waiting"
  | "agent-api-ready"
  | "auth-checking"
  | "pairing-required"
  | "first-run-checking"
  | "runtime-gate-required"
  | "cloud-bootstrap-required"
  | "remote-seeding"
  | "model-background-queue"
  | "ready"
  | "error";

export interface LaunchSnapshot {
  phase: LaunchPhase;
  agent: {
    state: "not_started" | "starting" | "running" | "stopped" | "error";
    port: number | null;
    apiBase: string | null;
    startedAt: number | null;
    error: string | null;
  };
  boot: {
    runtimePhase: string | null;
    pluginsLoaded: number | null;
    pluginsFailed: number | null;
    database: "ok" | "unknown" | "error" | null;
  };
  auth: {
    checked: boolean;
    required: boolean | null;
    pairingEnabled?: boolean;
    error?: string | null;
  };
  firstRun: {
    checked: boolean;
    complete: boolean | null;
    cloudProvisioned?: boolean;
    requiredGate?: "runtime" | "bootstrap" | "pairing" | null;
    error?: string | null;
  };
  remotes: {
    seeded: boolean;
    requiredStarted: boolean;
    errors: Array<{ id: string; error: string }>;
  };
  localModel: {
    backgroundDownloadQueued: boolean;
    blocking: false;
    error?: string | null;
  };
  diagnostics: {
    logPath: string;
    statusPath: string;
    logTail?: string;
  };
  recovery: {
    canRetry: boolean;
    canOpenLogs: boolean;
    canCreateBugReport: boolean;
    suggestedAction?: string;
  };
  updatedAt: string;
}

export type ProviderModelCategory =
  | "chat"
  | "embedding"
  | "image"
  | "tts"
  | "stt"
  | "other";

export interface ProviderModelRecord {
  id: string;
  name: string;
  category: ProviderModelCategory;
}

/**
 * One selectable model in the validated provider→model→efforts catalog that
 * every `GET /api/models` response carries (`catalog` field). Mirrors
 * `ModelCatalogEntry` in packages/agent/src/api/model-catalog.ts — the server
 * validates `POST /api/models/config` writes against exactly this shape.
 */
export interface ModelCatalogEntry {
  id: string;
  display: string;
  /** Accepted reasoning-effort levels; empty = the model has no effort knob. */
  efforts: string[];
  defaultEffort?: string;
  roles: Array<"small" | "large" | "coding">;
  costHint?: string;
  /** false = listed by the provider but not callable via the API tier. */
  apiSupported?: boolean;
}

/** Provider→entries map inside the `catalog` field of `GET /api/models`. */
export type ModelCatalogProviders = Record<string, ModelCatalogEntry[]>;

/** The slice of the `GET /api/models` response the model completions consume. */
export interface ModelCatalogResponse {
  catalog: { providers: ModelCatalogProviders };
}

export interface ModelCatalog {
  providers: ModelCatalogProviders;
}

export type ModelsConfigTarget = "small" | "large" | "coding";

/**
 * Coding backend wire values accepted by `POST /api/models/config`. The
 * in-house backend is spelled `eliza-code` on the wire (the server persists it
 * as `ELIZA_DEFAULT_AGENT_TYPE=elizaos`).
 */
export type ModelsConfigCodingBackend =
  | "codex"
  | "claude"
  | "opencode"
  | "eliza-code";

/** Which config seam won for a key reported by `GET /api/models/config`. */
export type ModelsConfigSource =
  | "config.env"
  | "config.env.vars"
  | "process.env"
  | "default";

export interface ModelsConfigEffectiveValue {
  value: string;
  source: ModelsConfigSource;
}

export interface ModelsConfigResponse {
  targets: {
    small: Record<string, ModelsConfigEffectiveValue | null>;
    large: Record<string, ModelsConfigEffectiveValue | null>;
    coding: Record<string, ModelsConfigEffectiveValue | null>;
  };
}

export interface ModelsConfigWriteRequest {
  target: ModelsConfigTarget;
  /** Chat targets: cerebras | elizacloud | claude-chat. */
  provider?: string;
  /** Coding target only. */
  backend?: ModelsConfigCodingBackend;
  model: string;
  effort?: string;
  /** Persist this backend as ELIZA_DEFAULT_AGENT_TYPE alongside the write. */
  defaultBackend?: ModelsConfigCodingBackend;
}

/**
 * Normalized `POST /api/models/config` outcome. The route answers three
 * designed shapes — 2xx applied/deduped, 400 `MODEL_CONFIG_INVALID`, 409
 * operation-busy — which the client folds into one discriminated union so
 * panels render each as a distinct state instead of losing the 400 context
 * payload inside a generic ApiError message. Transport failures and 500s
 * still throw.
 */
export type ModelsConfigWriteResult =
  | {
      kind: "applied";
      /** True when the write requires (and already triggered) an agent restart. */
      restart: boolean;
      keys: string[];
      operationId?: string;
      /** True when an identical restart was already in flight and this write joined it. */
      deduped?: boolean;
      /** Keys whose process-env value came from outside the config (service env). */
      conflictingServiceEnvKeys?: string[];
    }
  | {
      kind: "invalid";
      error: string;
      /** Values the route would have accepted, when the failure names them. */
      supported?: string[];
    }
  | { kind: "busy"; error: string; activeOperationId: string };

export interface AgentAutomationModeResponse {
  mode: AgentAutomationMode;
  options: AgentAutomationMode[];
}

export interface TradePermissionModeResponse {
  mode: TradePermissionMode;
  tradePermissionMode: TradePermissionMode;
  options?: TradePermissionMode[];
  ok?: boolean;
  canUserLocalExecute?: boolean;
  canAgentAutoTrade?: boolean;
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
    walletSource: "local" | "managed" | "none";
    evmAddress: string | null;
    evmAddressShort: string | null;
    solanaAddress: string | null;
    solanaAddressShort: string | null;
    hasWallet: boolean;
    hasEvm: boolean;
    hasSolana: boolean;
    localSignerAvailable: boolean;
    managedBscRpcReady: boolean;
    rpcReady: boolean;
    pluginEvmLoaded: boolean;
    pluginEvmRequired: boolean;
    executionReady: boolean;
    executionBlockedReason: string | null;
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

export type ApiErrorKind = "timeout" | "network" | "http" | "parse";

export class ApiError extends Error {
  readonly kind: ApiErrorKind;
  readonly status?: number;
  readonly path: string;
  /** Application error code from the JSON body (e.g. "rate_limit_exceeded"). */
  readonly code?: string;
  /** Seconds until the caller should retry, from the JSON body or Retry-After header. */
  readonly retryAfter?: number;

  constructor(options: {
    kind: ApiErrorKind;
    path: string;
    message: string;
    status?: number;
    code?: string;
    retryAfter?: number;
    cause?: unknown;
  }) {
    super(options.message);
    this.name = "ApiError";
    this.kind = options.kind;
    this.path = options.path;
    this.status = options.status;
    this.code = options.code;
    this.retryAfter = options.retryAfter;
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

export function isRateLimitedError(value: unknown): value is ApiError {
  return (
    value instanceof ApiError &&
    (value.status === 429 || value.code === "rate_limit_exceeded")
  );
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
  chromeBuildPath?: string | null;
  chromePackagePath?: string | null;
  safariWebExtensionPath?: string | null;
  safariAppPath?: string | null;
  safariPackagePath?: string | null;
  releaseManifest?: BrowserBridgeCompanionReleaseManifest | null;
}

// WebSocket
export type WsEventHandler = (data: Record<string, unknown>) => void;

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

// ---------------------------------------------------------------------------
// LifeOps ScheduledTask — transport view (GET /api/lifeops/scheduled-tasks)
// ---------------------------------------------------------------------------
//
// The canonical `ScheduledTask` interface is frozen in
// `@elizaos/plugin-scheduling` (the one-scheduler spine). The UI must not
// import a plugin, so this is the read-only transport projection of the fields
// the dashboard surfaces. It is intentionally a subset — additive widening is
// safe, but it must never diverge in meaning from the runner's contract.
// Mirrors the wire shape returned by the route's `runner.list()` JSON.

export type ScheduledTaskKindView =
  | "reminder"
  | "checkin"
  | "followup"
  | "approval"
  | "recap"
  | "watcher"
  | "output"
  | "custom";

export type ScheduledTaskStatusView =
  | "scheduled"
  | "fired"
  | "acknowledged"
  | "completed"
  | "skipped"
  | "expired"
  | "failed"
  | "dismissed";

export type ScheduledTaskSourceView =
  | "default_pack"
  | "user_chat"
  | "first_run"
  | "plugin";

/**
 * Discriminated trigger view. Matches `ScheduledTaskTrigger` in the spine;
 * the adapter only reads `kind` plus the cron `expression`/anchor, so the
 * remaining trigger payloads are widened to optional opaque fields rather
 * than fully re-typed (they are not rendered).
 */
export type ScheduledTaskTriggerView =
  | { kind: "once"; atIso: string }
  | { kind: "cron"; expression: string; tz: string }
  | { kind: "interval"; everyMinutes: number; from?: string; until?: string }
  | { kind: "relative_to_anchor"; anchorKey: string; offsetMinutes: number }
  | { kind: "during_window"; windowKey: string }
  | { kind: "event"; eventKind: string }
  | { kind: "manual" }
  | { kind: "after_task"; taskId: string; outcome: string };

export interface ScheduledTaskStateView {
  status: ScheduledTaskStatusView;
  firedAt?: string;
  acknowledgedAt?: string;
  completedAt?: string;
  followupCount: number;
  lastFollowupAt?: string;
  lastDecisionLog?: string;
}

export interface ScheduledTaskView {
  taskId: string;
  kind: ScheduledTaskKindView;
  promptInstructions: string;
  trigger: ScheduledTaskTriggerView;
  priority: "low" | "medium" | "high";
  respectsGlobalPause: boolean;
  state: ScheduledTaskStateView;
  source: ScheduledTaskSourceView;
  createdBy: string;
  ownerVisible: boolean;
  metadata?: Record<string, unknown>;
}

/** Optional filter accepted by `GET /api/lifeops/scheduled-tasks`. */
export interface ScheduledTaskListFilter {
  kind?: ScheduledTaskKindView;
  status?: ScheduledTaskStatusView;
  source?: ScheduledTaskSourceView;
  firedSince?: string;
  /** Restrict to owner-visible rows (passed as `ownerVisibleOnly=1`). */
  ownerVisibleOnly?: boolean;
}

export interface ScheduledTaskListResponse {
  tasks: ScheduledTaskView[];
}
