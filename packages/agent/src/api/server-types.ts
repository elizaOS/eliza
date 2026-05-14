/**
 * Shared type definitions extracted from server.ts to break circular
 * dependencies.  Route files and services that only need type information
 * should import from this module instead of the full server.ts.
 */

import type http from "node:http";
import type { AgentRuntime, Media, UUID } from "@elizaos/core";
import type { CloudRouteState } from "@elizaos/plugin-elizacloud";
import type {
  AgentAutomationMode,
  AgentStartupDiagnostics,
  ConversationMetadata,
  LogEntry,
  PluginParamDef,
  SkillEntry,
  StreamEventEnvelope,
} from "@elizaos/shared";
import type { ElizaConfig } from "../config/config.ts";
import type { AppManager } from "../services/app-manager.ts";
import type { SandboxManager } from "../services/sandbox-manager.ts";
import type { ConnectorHealthMonitor } from "./connector-health.ts";

// PluginEntry and PluginParamDef are defined here to avoid a circular dependency
// with plugin-discovery-helpers.ts (which imports from server-helpers.ts).
// PluginParamDef is now canonical in @elizaos/shared; re-exported below.

// Re-export shared types so existing imports from this module continue to work.
export type {
  AgentAutomationMode,
  AgentStartupDiagnostics,
  ChatImageAttachment,
  ConversationAutomationType,
  ConversationMetadata,
  ConversationScope,
  LogEntry,
  PluginParamDef,
  SkillEntry,
  StreamEventEnvelope,
  StreamEventType,
} from "@elizaos/shared";
export type {
  TrainingServiceLike,
  TrainingServiceWithRuntime,
} from "./training-service-like.ts";

import type { TrainingServiceWithRuntime } from "./training-service-like.ts";

// ConversationScope, ConversationAutomationType, ConversationMetadata,
// ChatImageAttachment, SkillEntry, LogEntry, AgentStartupDiagnostics are
// canonical in @elizaos/shared and re-exported at the top of this file.

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

// StreamEventType, StreamEventEnvelope, AgentAutomationMode, PluginParamDef are
// canonical in @elizaos/shared and re-exported at the top of this file.

/** A connector-registered route handler. Returns `true` if the request was handled. */
export type ConnectorRouteHandler = (
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pathname: string,
  method: string,
) => Promise<boolean>;

export type { TradePermissionMode } from "@elizaos/shared";

// ---------------------------------------------------------------------------
// Plugin entry types (canonical definitions — re-exported by plugin-discovery-helpers)
// ---------------------------------------------------------------------------

// PluginParamDef is canonical in @elizaos/shared and re-exported at the top of this file.

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
  directory?: string | null;
  registryKind?: string;
  origin?: "builtin" | "third-party" | string;
  registrySource?: string;
  support?: "first-party" | "community" | string;
  builtIn?: boolean;
  firstParty?: boolean;
  thirdParty?: boolean;
  status?: string;
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
  _anthropicFlow?: import("../auth/anthropic.ts").AnthropicFlow;
  _codexFlow?: import("../auth/openai-codex.ts").CodexFlow;
  _codexFlowTimer?: ReturnType<typeof setTimeout>;
  /** System permission states (cached from the desktop bridge). */
  permissionStates?: Record<string, import("@elizaos/shared").PermissionState>;
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
    import("@elizaos/plugin-whatsapp").WhatsAppPairingSession
  >;
  /** Active Signal pairing sessions (device linking flow). */
  signalPairingSessions?: Map<
    string,
    import("@elizaos/plugin-signal").SignalPairingSession
  >;
  /** Last known Signal pairing snapshots, including terminal failures. */
  signalPairingSnapshots?: Map<
    string,
    import("@elizaos/plugin-signal").SignalPairingSnapshot
  >;
  /** Active Telegram account auth session (user-account login flow). */
  telegramAccountAuthSession?:
    | import("@elizaos/plugin-telegram").TelegramAccountAuthSessionLike
    | null;
}

/**
 * Extension of the core Media attachment shape that carries raw image bytes for
 * action handlers (e.g. POST operation=send) while the message is in-memory.
 */
export interface ChatAttachmentWithData extends Media {
  /** Raw base64 image data -- never written to the database. */
  _data: string;
  /** MIME type corresponding to `_data`. */
  _mimeType: string;
}
