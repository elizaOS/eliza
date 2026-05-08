// ---------------------------------------------------------------------------
// Core types — Database*, Agent*, ApiError, Runtime*, WebSocket*, ConnectionState*, Sandbox*
// Re-exports from external packages included here.
// ---------------------------------------------------------------------------

import type {
  DatabaseProviderType,
  TradePermissionMode as WalletTradePermissionMode,
} from "@elizaos/agent";

// Use server-types / types only — do not re-export from api/server or
// api/trajectory-routes (those modules pull the full API + app-training into Vite).
export type {
  StreamEventType,
  TrajectoryExportFormat,
  TriggerLastStatus,
  TriggerType,
  TriggerWakeMode,
} from "@elizaos/agent";

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
  uptime: number | undefined;
  startedAt: number | undefined;
  port?: number;
  pendingRestart?: boolean;
  pendingRestartReasons?: string[];
  startup?: AgentStartupDiagnostics;
}

export type AgentAutomationMode = "connectors-only" | "full";

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

export interface StreamEventEnvelope {
  type: import("@elizaos/agent/api/server-types").StreamEventType;
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
  releaseManifest?:
    | import("@elizaos/plugin-browser/contracts").BrowserBridgeCompanionReleaseManifest
    | null;
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
