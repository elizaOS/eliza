/**
 * Shared type definitions extracted from server.ts to break circular
 * dependencies.  Route files and services that only need type information
 * should import from this module instead of the full server.ts.
 */

import type http from "node:http";
import type { AgentRuntime, Media, UUID } from "@elizaos/core";
import type { ElizaConfig } from "../config/config.js";
import type { AppManager } from "../services/app-manager.js";
import type { SandboxManager } from "../services/sandbox-manager.js";
import type { CloudRouteState } from "@elizaos/plugin-elizacloud/routes/cloud-routes-autonomous";
import type { ConnectorHealthMonitor } from "./connector-health.js";

// PluginEntry and PluginParamDef are defined here to avoid a circular dependency
// with plugin-discovery-helpers.ts (which imports from server-helpers.ts).

export type {
  TrainingServiceLike,
  TrainingServiceWithRuntime,
} from "./training-service-like.js";

import type { TrainingServiceWithRuntime } from "./training-service-like.js";

// ---------------------------------------------------------------------------
// Conversation metadata
// ---------------------------------------------------------------------------

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

export type ConversationAutomationType = "coordinator_text" | "n8n_workflow";

export interface ConversationMetadata {
  scope?: ConversationScope;
  automationType?: ConversationAutomationType;
  taskId?: string;
  triggerId?: string;
  workflowId?: string;
  workflowName?: string;
  draftId?: string;
  /** Sub-entity id for page-scoped conversations (e.g. a character id). */
  pageId?: string;
  sourceConversationId?: string;
  terminalBridgeConversationId?: string;
}

/** Metadata for a web-chat conversation. */
export interface ConversationMeta {
  id: string;
  title: string;
  roomId: UUID;
  metadata?: ConversationMetadata;
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Agent startup diagnostics
// ---------------------------------------------------------------------------

export interface AgentStartupDiagnostics {
  phase: string;
  attempt: number;
  lastError?: string;
  lastErrorAt?: number;
  nextRetryAt?: number;
}

// ---------------------------------------------------------------------------
// Supporting types used by ServerState
// ---------------------------------------------------------------------------

export interface ShareIngestItem {
  id: string;
  source: string;
  title?: string;
  url?: string;
  text?: string;
  suggestedPrompt: string;
  receivedAt: number;
}

export interface SkillEntry {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  /** Set automatically when a scan report exists for this skill. */
  scanStatus?: "clean" | "warning" | "critical" | "blocked" | null;
}

export interface LogEntry {
  timestamp: number;
  level: string;
  message: string;
  source: string;
  tags: string[];
}

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
  roomId?: UUID;
  payload: unknown;
}

/** A connector-registered route handler. Returns `true` if the request was handled. */
export type ConnectorRouteHandler = (
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pathname: string,
  method: string,
) => Promise<boolean>;

export type AgentAutomationMode = "connectors-only" | "full";

export type TradePermissionMode =
  import("./trade-safety.js").TradePermissionMode;

// ---------------------------------------------------------------------------
// Plugin entry types (canonical definitions — re-exported by plugin-discovery-helpers)
// ---------------------------------------------------------------------------

export interface PluginParamDef {
  key: string;
  type: string;
  description: string;
  required: boolean;
  sensitive: boolean;
  default?: string;
  /** Predefined options for dropdown selection (e.g. model names). */
  options?: string[];
  /** Current value from process.env (masked if sensitive). */
  currentValue: string | null;
  /** Whether a value is currently set in the environment. */
  isSet: boolean;
}

export interface PluginEntry {
  id: string;
  name: string;
  description: string;
  tags: string[];
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
  /** Where the plugin comes from: "bundled" (ships with Eliza) or "store" (user-installed from registry). */
  source: "bundled" | "store";
  configKeys: string[];
  parameters: PluginParamDef[];
  validationErrors: Array<{ field: string; message: string }>;
  validationWarnings: Array<{ field: string; message: string }>;
  npmName?: string;
  version?: string;
  releaseStream?: "latest" | "beta";
  requestedVersion?: string;
  latestVersion?: string | null;
  betaVersion?: string | null;
  pluginDeps?: string[];
  /** Whether this plugin is currently active in the runtime. */
  isActive?: boolean;
  /** Error message when plugin is enabled/installed but failed to load. */
  loadError?: string;
  /** Server-provided UI hints for plugin configuration fields. */
  configUiHints?: Record<string, Record<string, unknown>>;
  /** Optional icon URL or emoji for the plugin card header. */
  icon?: string | null;
  homepage?: string;
  repository?: string;
  setupGuideUrl?: string;
  autoEnabled?: boolean;
  managementMode?: "standard" | "core-optional";
  capabilityStatus?:
    | "loaded"
    | "auto-enabled"
    | "blocked"
    | "missing-prerequisites"
    | "disabled";
  capabilityReason?: string | null;
  prerequisites?: Array<{ label: string; met: boolean }>;
}

// ---------------------------------------------------------------------------
// ServerState
// ---------------------------------------------------------------------------

export interface ServerState {
  runtime: AgentRuntime | null;
  config: ElizaConfig;
  agentState:
    | "not_started"
    | "starting"
    | "running"
    | "paused"
    | "stopped"
    | "restarting"
    | "error";
  agentName: string;
  model: string | undefined;
  startedAt: number | undefined;
  startup: AgentStartupDiagnostics;
  plugins: PluginEntry[];
  skills: SkillEntry[];
  logBuffer: LogEntry[];
  eventBuffer: StreamEventEnvelope[];
  nextEventId: number;
  chatRoomId: UUID | null;
  chatUserId: UUID | null;
  chatConnectionReady: { userId: UUID; roomId: UUID; worldId: UUID } | null;
  chatConnectionPromise: Promise<void> | null;
  adminEntityId: UUID | null;
  /** Conversation metadata by conversation id. */
  conversations: Map<string, ConversationMeta>;
  /** Pending restore of persisted conversations into the in-memory map. */
  conversationRestorePromise: Promise<void> | null;
  /** Tombstones for conversation IDs explicitly deleted by the user. */
  deletedConversationIds: Set<string>;
  /** Cloud manager for Eliza Cloud integration (null when cloud is disabled). */
  cloudManager: CloudRouteState["cloudManager"];
  sandboxManager: SandboxManager | null;
  /** App manager for launching and managing elizaOS apps. */
  appManager: AppManager;
  /** Fine-tuning/training orchestration service. */
  trainingService: TrainingServiceWithRuntime | null;
  /** In-memory queue for share ingest items. */
  shareIngestQueue: ShareIngestItem[];
  /** Broadcast current agent status to all WebSocket clients. Set by startApiServer. */
  broadcastStatus: (() => void) | null;
  /** Broadcast an arbitrary JSON message to all WebSocket clients. Set by startApiServer. */
  broadcastWs: ((data: object) => void) | null;
  /** Broadcast a JSON payload to WebSocket clients bound to a specific client id. */
  broadcastWsToClientId: ((clientId: string, data: object) => number) | null;
  /** Currently active conversation ID from the frontend (sent via WS). */
  activeConversationId: string | null;
  /** Transient OAuth flow state for subscription auth. */
  _anthropicFlow?: import("../auth/anthropic.js").AnthropicFlow;
  _codexFlow?: import("../auth/openai-codex.js").CodexFlow;
  _codexFlowTimer?: ReturnType<typeof setTimeout>;
  /** System permission states (cached from the desktop bridge). */
  permissionStates?: Record<
    string,
    import("@elizaos/shared/contracts/permissions").PermissionState
  >;
  /** Whether shell access is enabled (can be toggled in UI). */
  shellEnabled?: boolean;
  /** Agent automation permission mode for self-directed config changes. */
  agentAutomationMode?: AgentAutomationMode;
  /** Wallet trade execution permission mode (user-sign/manual/agent-auto). */
  tradePermissionMode?: TradePermissionMode;
  /** Reasons a restart is pending. Empty array = no restart needed. */
  pendingRestartReasons: string[];
  /** Route handlers registered by connector plugins (loaded dynamically). */
  connectorRouteHandlers: ConnectorRouteHandler[];
  /** Connector health monitor for detecting dead connectors. */
  connectorHealthMonitor: ConnectorHealthMonitor | null;
  /** Active WhatsApp pairing sessions (QR code flow). */
  whatsappPairingSessions?: Map<
    string,
    import("../services/whatsapp-pairing.js").WhatsAppPairingSession
  >;
  /** Active Signal pairing sessions (device linking flow). */
  signalPairingSessions?: Map<
    string,
    import("../services/signal-pairing.js").SignalPairingSession
  >;
  /** Last known Signal pairing snapshots, including terminal failures. */
  signalPairingSnapshots?: Map<
    string,
    import("../services/signal-pairing.js").SignalPairingSnapshot
  >;
  /** Active Telegram account auth session (user-account login flow). */
  telegramAccountAuthSession?:
    | import("../services/telegram-account-auth.js").TelegramAccountAuthSessionLike
    | null;
}

/**
 * Extension of the core Media attachment shape that carries raw image bytes for
 * action handlers (e.g. POST_TWEET) while the message is in-memory.
 */
export interface ChatAttachmentWithData extends Media {
  /** Raw base64 image data -- never written to the database. */
  _data: string;
  /** MIME type corresponding to `_data`. */
  _mimeType: string;
}
