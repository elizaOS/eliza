/**
 * REST API server for the Milady Control UI.
 *
 * Exposes HTTP endpoints that the UI frontend expects, backed by the
 * elizaOS AgentRuntime. Default port: 2138. In dev mode, the Vite UI
 * dev server proxies /api and /ws here (see scripts/dev-ui.mjs).
 */

import crypto from "node:crypto";
import { lookup as dnsLookup } from "node:dns/promises";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  type AgentRuntime,
  ChannelType,
  type Content,
  ContentType,
  createMessageMemory,
  logger,
  type Media,
  ModelType,
  stringToUuid,
  type Task,
  type UUID,
} from "@elizaos/core";
import { ethers } from "ethers";
import { type WebSocket, WebSocketServer } from "ws";
import { getGlobalAwarenessRegistry } from "../awareness/registry";
import { CharacterSchema } from "../config/character-schema";
import {
  configFileExists,
  loadElizaConfig,
  type ElizaConfig,
  saveElizaConfig,
} from "../config/config";
import { resolveModelsCacheDir, resolveStateDir } from "../config/paths";
import {
  isConnectorConfigured,
  isStreamingDestinationConfigured,
} from "../config/plugin-auto-enable";
import type { ConnectorConfig, CustomActionDef } from "../config/types.eliza";
import { createIntegrationTelemetrySpan } from "../diagnostics/integration-observability";
import { EMOTE_BY_ID, EMOTE_CATALOG } from "../emotes/catalog";
import { resolveDefaultAgentWorkspaceDir } from "../providers/workspace";
import {
  type AgentEventPayloadLike,
  type AgentEventServiceLike,
  getAgentEventService,
} from "../runtime/agent-event-service";
import { CORE_PLUGINS, OPTIONAL_CORE_PLUGINS } from "../runtime/core-plugins";
import {
  buildTestHandler,
  registerCustomActionLive,
} from "../runtime/custom-actions";
import {
  classifyRegistryPluginRelease,
  getBundledRuntimePluginIds,
} from "../runtime/release-plugin-policy";
import {
  AUDIT_EVENT_TYPES,
  AUDIT_SEVERITIES,
  getAuditFeedSize,
  queryAuditFeed,
  subscribeAuditFeed,
} from "../security/audit-log";
import {
  isBlockedPrivateOrLinkLocalIp,
  isLoopbackHost,
  normalizeHostLike,
} from "../security/network-policy";
import {
  AgentExportError,
  estimateExportSize,
  exportAgent,
  importAgent,
} from "../services/agent-export";
import { AppManager } from "../services/app-manager";
import { FallbackTrainingService } from "../services/fallback-training-service";
import {
  getMcpServerDetails,
  searchMcpMarketplace,
} from "../services/mcp-marketplace";
import {
  type CoreManagerLike,
  type InstallProgressLike,
  isCoreManagerLike,
  isPluginManagerLike,
  type PluginManagerLike,
} from "../services/plugin-manager-types";
import {
  ensurePrivyWalletsForCustomUser,
  isPrivyWalletProvisioningEnabled,
} from "../services/privy-wallets";
import type { SandboxManager } from "../services/sandbox-manager";
import {
  SignalPairingSession,
  sanitizeAccountId as sanitizeSignalAccountId,
  signalAuthExists,
  signalLogout,
} from "../services/signal-pairing";
import {
  installMarketplaceSkill,
  listInstalledMarketplaceSkills,
  searchSkillsMarketplace,
  uninstallMarketplaceSkill,
} from "../services/skill-marketplace";
import { streamManager } from "../services/stream-manager";
import {
  sanitizeAccountId as sanitizeWhatsAppAccountId,
  WhatsAppPairingSession,
  whatsappAuthExists,
  whatsappLogout,
} from "../services/whatsapp-pairing";
import {
  executeTriggerTask,
  getTriggerHealthSnapshot,
  getTriggerLimit,
  listTriggerTasks,
  readTriggerConfig,
  readTriggerRuns,
  TRIGGER_TASK_NAME,
  TRIGGER_TASK_TAGS,
  taskToTriggerSummary,
  triggersFeatureEnabled,
} from "../triggers/runtime";
import {
  buildTriggerConfig,
  buildTriggerMetadata,
  DISABLED_TRIGGER_INTERVAL_MS,
  normalizeTriggerDraft,
} from "../triggers/scheduling";
import { parseClampedInteger } from "../utils/number-parsing";
import { sanitizeSpeechText } from "../utils/spoken-text";
import { handleAgentAdminRoutes } from "./agent-admin-routes";
import { handleAgentLifecycleRoutes } from "./agent-lifecycle-routes";
import { detectRuntimeModel, resolveProviderFromModel } from "./agent-model";
import { handleAgentTransferRoutes } from "./agent-transfer-routes";
import { handleAppsRoutes } from "./apps-routes";
import { handleAuthRoutes } from "./auth-routes";
import {
  buildBscApproveUnsignedTx,
  buildBscBuyUnsignedTx,
  buildBscSellUnsignedTx,
  buildBscTradePreflight,
  buildBscTradeQuote,
  resolvePrimaryBscRpcUrl,
} from "./bsc-trade";
import { handleBugReportRoutes } from "./bug-report-routes";
import { handleCharacterRoutes } from "./character-routes";
import { handleCloudBillingRoute } from "./cloud-billing-routes";
import { handleCloudCompatRoute } from "./cloud-compat-routes";
import { type CloudRouteState, handleCloudRoute } from "./cloud-routes";
import { handleCloudStatusRoutes } from "./cloud-status-routes";
import {
  extractAnthropicSystemAndLastUser,
  extractCompatTextContent,
  extractOpenAiSystemAndLastUser,
  resolveCompatRoomKey,
} from "./compat-utils";
import { ConnectorHealthMonitor } from "./connector-health";
import { wireCoordinatorBridgesWhenReady } from "./coordinator-wiring";
import {
  isInsufficientCreditsError,
  isInsufficientCreditsMessage,
} from "./credit-detection";
import { handleDatabaseRoute } from "./database";
import { handleDiagnosticsRoutes } from "./diagnostics-routes";
import { DropService } from "./drop-service";
import {
  readJsonBody as parseJsonBody,
  type ReadJsonBodyOptions,
  readRequestBody,
  readRequestBodyBuffer,
  sendJson,
  sendJsonError,
} from "./http-helpers";
import { handleKnowledgeRoutes } from "./knowledge-routes";
import {
  evictOldestConversation,
  getOrReadCachedFile,
  pushWithBatchEvict,
  sweepExpiredEntries,
} from "./memory-bounds";
import { handleMemoryRoutes } from "./memory-routes";
import { buildWhitelistTree, generateProof } from "./merkle-tree";
import { handleModelsRoutes } from "./models-routes";
import { handleNfaRoutes } from "./nfa-routes";
import { verifyAndWhitelistHolder } from "./nft-verify";
import type { PTYService } from "./parse-action-block";
import { handlePermissionRoutes } from "./permissions-routes";
import {
  type PluginParamInfo,
  validatePluginConfig,
} from "./plugin-validation";
import {
  applySubscriptionProviderConfig,
  clearSubscriptionProviderConfig,
  resolveExistingOnboardingConnection,
} from "./provider-switch-config";
import { handleRegistryRoutes } from "./registry-routes";
import { RegistryService } from "./registry-service";
import { handleSandboxRoute } from "./sandbox-routes";
import { applySignalQrOverride, handleSignalRoute } from "./signal-routes";
import { resolveStreamingUpdate } from "./streaming-text";
import { handleSubscriptionRoutes } from "./subscription-routes";
import { resolveTerminalRunLimits } from "./terminal-run-limits";
import { handleTrainingRoutes } from "./training-routes";
import type { TrainingServiceWithRuntime } from "./training-service-like";
import { handleTrajectoryRoute } from "./trajectory-routes";
import { handleTriggerRoutes } from "./trigger-routes";
import {
  generateVerificationMessage,
  isAddressWhitelisted,
  markAddressVerified,
  verifyTweet,
} from "./twitter-verify";
import { TxService } from "./tx-service";
import { generateWalletKeys, getWalletAddresses } from "./wallet";
import { handleWalletRoutes } from "./wallet-routes";
import { resolveWalletRpcReadiness } from "./wallet-rpc";
import {
  loadWalletTradingProfile,
  recordWalletTradeLedgerEntry,
  updateWalletTradeLedgerEntryStatus,
} from "./wallet-trading-profile";
import {
  applyWhatsAppQrOverride,
  handleWhatsAppRoute,
} from "./whatsapp-routes";

/**
 * Local stubs for types removed from @elizaos/plugin-agent-orchestrator 2.x.
 * These are only used as structural types for the SwarmCoordinator callbacks;
 * no runtime import is needed.
 */
// biome-ignore lint/suspicious/noExplicitAny: legacy coordinator event payload
type SwarmEvent = Record<string, any>;
// biome-ignore lint/suspicious/noExplicitAny: legacy coordinator task context
type TaskContext = Record<string, any>;
interface CoordinationLLMResponse {
  action: string;
  reasoning: string;
  response?: string;
  useKeys?: boolean;
  keys?: string[];
}
interface TaskCompletionSummary {
  sessionId: string;
  label: string;
  agentType: string;
  originalTask: string;
  status: string;
  completionSummary: string;
  [key: string]: unknown;
}

type PiAiPluginModule = typeof import("@elizaos/plugin-pi-ai");
let _piAiPluginModule: PiAiPluginModule | null = null;
async function loadPiAiPluginModule(): Promise<PiAiPluginModule> {
  if (!_piAiPluginModule) {
    _piAiPluginModule = await import("@elizaos/plugin-pi-ai");
  }
  return _piAiPluginModule;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A connector-registered route handler. Returns `true` if the request was handled. */
type ConnectorRouteHandler = (
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pathname: string,
  method: string,
) => Promise<boolean>;

function getAgentEventSvc(
  runtime: AgentRuntime | null,
): AgentEventServiceLike | null {
  return getAgentEventService(runtime);
}

function requirePluginManager(runtime: AgentRuntime | null): PluginManagerLike {
  const service = runtime?.getService("plugin_manager");
  if (!isPluginManagerLike(service)) {
    throw new Error("Plugin manager service not found");
  }
  return service;
}

function requireCoreManager(runtime: AgentRuntime | null): CoreManagerLike {
  const service = runtime?.getService("core_manager");
  if (!isCoreManagerLike(service)) {
    throw new Error("Core manager service not found");
  }
  return service;
}

function isUuidLike(value: string): value is UUID {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
    value,
  );
}

const OG_FILENAME = ".og";
const DELETED_CONVERSATIONS_FILENAME = "deleted-conversations.v1.json";
const MAX_DELETED_CONVERSATION_IDS = 5000;

interface DeletedConversationsStateFile {
  version: 1;
  updatedAt: string;
  ids: string[];
}

function readDeletedConversationIdsFromState(): Set<string> {
  const filePath = path.join(resolveStateDir(), DELETED_CONVERSATIONS_FILENAME);
  if (!fs.existsSync(filePath)) return new Set();
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(raw) as Partial<DeletedConversationsStateFile>;
    const ids = Array.isArray(parsed.ids) ? parsed.ids : [];
    return new Set(
      ids
        .map((id) => (typeof id === "string" ? id.trim() : ""))
        .filter((id) => id.length > 0),
    );
  } catch (err) {
    logger.warn(
      `[milady-api] Failed to read deleted conversations state: ${err instanceof Error ? err.message : String(err)}`,
    );
    return new Set();
  }
}

function persistDeletedConversationIdsToState(ids: Set<string>): void {
  const dir = resolveStateDir();
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }

  const normalized = Array.from(ids)
    .map((id) => id.trim())
    .filter((id) => id.length > 0)
    .slice(-MAX_DELETED_CONVERSATION_IDS);

  const filePath = path.join(dir, DELETED_CONVERSATIONS_FILENAME);
  const tmpFilePath = `${filePath}.${process.pid}.tmp`;
  const payload: DeletedConversationsStateFile = {
    version: 1,
    updatedAt: new Date().toISOString(),
    ids: normalized,
  };

  fs.writeFileSync(tmpFilePath, `${JSON.stringify(payload, null, 2)}\n`, {
    encoding: "utf-8",
    mode: 0o600,
  });
  fs.renameSync(tmpFilePath, filePath);
}

function readOGCodeFromState(): string | null {
  const filePath = path.join(resolveStateDir(), OG_FILENAME);
  if (!fs.existsSync(filePath)) return null;
  return fs.readFileSync(filePath, "utf-8").trim();
}

function initializeOGCodeInState(): void {
  const dir = resolveStateDir();
  const filePath = path.join(dir, OG_FILENAME);
  if (fs.existsSync(filePath)) return;

  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  fs.writeFileSync(filePath, crypto.randomUUID(), {
    encoding: "utf-8",
    mode: 0o600,
  });
}

/** Metadata for a web-chat conversation. */
export interface ConversationMeta {
  id: string;
  title: string;
  roomId: UUID;
  createdAt: string;
  updatedAt: string;
}

function hasPersistedOnboardingState(config: ElizaConfig): boolean {
  if (config.meta?.onboardingComplete === true) {
    return true;
  }

  const existingConnection = resolveExistingOnboardingConnection(
    config as Record<string, unknown>,
  );
  if (existingConnection?.kind === "local-provider") {
    return true;
  }
  if (existingConnection?.kind === "remote-provider") {
    return Boolean(existingConnection.remoteApiBase.trim());
  }
  if (existingConnection?.kind === "cloud-managed") {
    return Boolean(
      existingConnection.apiKey?.trim() &&
        existingConnection.smallModel?.trim() &&
        existingConnection.largeModel?.trim(),
    );
  }

  const agents = config.agents;
  if (!agents) {
    return false;
  }

  if (Array.isArray(agents.list) && agents.list.length > 0) {
    return true;
  }

  return Boolean(
    agents.defaults?.workspace?.trim() ||
      agents.defaults?.adminEntityId?.trim(),
  );
}

function resolveConversationGreetingText(
  runtime: AgentRuntime,
  lang: string,
): string {
  const localizedExamples =
    lang === "zh-CN"
      ? ((runtime.character as Record<string, unknown>).postExamples_zhCN as
          | string[]
          | undefined)
      : undefined;
  const postExamples =
    localizedExamples && localizedExamples.length > 0
      ? localizedExamples
      : (runtime.character.postExamples ?? []);
  return postExamples[Math.floor(Math.random() * postExamples.length)] ?? "";
}

interface AgentStartupDiagnostics {
  phase: string;
  attempt: number;
  lastError?: string;
  lastErrorAt?: number;
  nextRetryAt?: number;
}

interface ServerState {
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
  trainingService: TrainingServiceLike | null;
  /** ERC-8004 registry service (null when not configured). */
  registryService: RegistryService | null;
  /** Drop/mint service (null when not configured). */
  dropService: DropService | null;
  /** In-memory queue for share ingest items. */
  shareIngestQueue: ShareIngestItem[];
  /** Broadcast current agent status to all WebSocket clients. Set by startApiServer. */
  broadcastStatus: (() => void) | null;
  /** Broadcast an arbitrary JSON message to all WebSocket clients. Set by startApiServer. */
  broadcastWs: ((data: Record<string, unknown>) => void) | null;
  /** Broadcast a JSON payload to WebSocket clients bound to a specific client id. */
  broadcastWsToClientId:
    | ((clientId: string, data: Record<string, unknown>) => number)
    | null;
  /** Currently active conversation ID from the frontend (sent via WS). */
  activeConversationId: string | null;
  /** Transient OAuth flow state for subscription auth. */
  _anthropicFlow?: import("../auth/anthropic").AnthropicFlow;
  _codexFlow?: import("../auth/openai-codex").CodexFlow;
  _codexFlowTimer?: ReturnType<typeof setTimeout>;
  /** System permission states (cached from the desktop bridge). */
  permissionStates?: Record<
    string,
    {
      id: string;
      status: string;
      lastChecked: number;
      canRequest: boolean;
    }
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
    import("../services/whatsapp-pairing").WhatsAppPairingSession
  >;
  /** Active Signal pairing sessions (device linking flow). */
  signalPairingSessions?: Map<
    string,
    import("../services/signal-pairing").SignalPairingSession
  >;
}

interface ShareIngestItem {
  id: string;
  source: string;
  title?: string;
  url?: string;
  text?: string;
  suggestedPrompt: string;
  receivedAt: number;
}

interface PluginParamDef {
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

interface PluginEntry {
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
  /** Where the plugin comes from: "bundled" (ships with Milady) or "store" (user-installed from registry). */
  source: "bundled" | "store";
  configKeys: string[];
  parameters: PluginParamDef[];
  validationErrors: Array<{ field: string; message: string }>;
  validationWarnings: Array<{ field: string; message: string }>;
  npmName?: string;
  version?: string;
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
}

interface SkillEntry {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  /** Set automatically when a scan report exists for this skill. */
  scanStatus?: "clean" | "warning" | "critical" | "blocked" | null;
}

interface LogEntry {
  timestamp: number;
  level: string;
  message: string;
  source: string;
  tags: string[];
}

type StreamEventType = "agent_event" | "heartbeat_event" | "training_event";

interface StreamEventEnvelope {
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
  payload: object;
}

// ---------------------------------------------------------------------------
// Response block extraction — parse agent text for structured UI blocks
// ---------------------------------------------------------------------------

/** Content block types returned in the /api/chat and /api/conversations/:id/messages responses. */
type ResponseBlock =
  | { type: "text"; text: string }
  | { type: "ui-spec"; spec: Record<string, unknown>; raw: string }
  | {
      type: "config-form";
      pluginId: string;
      pluginName?: string;
      schema: Record<string, unknown>;
      hints?: Record<string, unknown>;
      values?: Record<string, unknown>;
    };

/** Regex matching fenced JSON code blocks: ```json ... ``` or ``` ... ``` */
const FENCED_JSON_RE_SERVER = /```(?:json)?\s*\n([\s\S]*?)```/g;

/** CONFIG marker pattern: [CONFIG:pluginId] */
const CONFIG_MARKER_RE = /\[CONFIG:([^\]]+)\]/g;

function tryParseJsonServer(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function isUiSpecObject(
  obj: unknown,
): obj is { root: string; elements: Record<string, unknown> } {
  if (obj === null || typeof obj !== "object" || Array.isArray(obj))
    return false;
  const c = obj as Record<string, unknown>;
  return (
    typeof c.root === "string" &&
    c.elements !== null &&
    typeof c.elements === "object" &&
    !Array.isArray(c.elements)
  );
}

/**
 * Scan agent response text for:
 * 1. Fenced UiSpec JSON blocks → extract as { type: "ui-spec", spec, raw }
 * 2. [CONFIG:pluginId] markers → generate { type: "config-form", ... } from plugin list
 * 3. Remaining text → { type: "text", text }
 *
 * Returns { cleanText, blocks } where cleanText has UI blocks/markers removed.
 */
function _extractResponseBlocks(
  responseText: string,
  plugins: PluginEntry[],
): { cleanText: string; blocks: ResponseBlock[] } {
  const blocks: ResponseBlock[] = [];
  let text = responseText;

  // Pass 1: extract fenced UiSpec JSON blocks
  FENCED_JSON_RE_SERVER.lastIndex = 0;
  const uiSpecRanges: Array<{
    start: number;
    end: number;
    block: ResponseBlock;
  }> = [];
  let match: RegExpExecArray | null = FENCED_JSON_RE_SERVER.exec(text);

  while (match !== null) {
    const jsonContent = match[1].trim();
    const parsed = tryParseJsonServer(jsonContent);
    if (parsed !== null && isUiSpecObject(parsed)) {
      uiSpecRanges.push({
        start: match.index,
        end: match.index + match[0].length,
        block: {
          type: "ui-spec",
          spec: parsed as Record<string, unknown>,
          raw: jsonContent,
        },
      });
    }
    match = FENCED_JSON_RE_SERVER.exec(text);
  }

  // Remove UiSpec blocks from text (reverse order to preserve indices)
  if (uiSpecRanges.length > 0) {
    for (let i = uiSpecRanges.length - 1; i >= 0; i--) {
      const r = uiSpecRanges[i];
      blocks.unshift(r.block);
      text = text.slice(0, r.start) + text.slice(r.end);
    }
  }

  // Pass 2: extract [CONFIG:pluginId] markers
  CONFIG_MARKER_RE.lastIndex = 0;
  const configMarkers: Array<{ start: number; end: number; pluginId: string }> =
    [];
  match = CONFIG_MARKER_RE.exec(text);
  while (match !== null) {
    configMarkers.push({
      start: match.index,
      end: match.index + match[0].length,
      pluginId: match[1].trim(),
    });
    match = CONFIG_MARKER_RE.exec(text);
  }

  if (configMarkers.length > 0) {
    for (let i = configMarkers.length - 1; i >= 0; i--) {
      const m = configMarkers[i];
      const plugin = plugins.find((p) => p.id === m.pluginId);
      if (plugin) {
        const schema: Record<string, unknown> = {};
        const values: Record<string, unknown> = {};
        for (const param of plugin.parameters) {
          schema[param.key] = {
            type: param.type,
            description: param.description,
            required: param.required,
          };
          if (param.currentValue !== null)
            values[param.key] = param.currentValue;
        }
        blocks.push({
          type: "config-form",
          pluginId: m.pluginId,
          pluginName: plugin.name,
          schema,
          hints: plugin.configUiHints ?? {},
          values,
        });
      }
      text = text.slice(0, m.start) + text.slice(m.end);
    }
  }

  // Build clean text (trim whitespace from block removal)
  const cleanText = text.replace(/\n{3,}/g, "\n\n").trim();

  // If there's remaining text content, prepend it as a text block
  if (cleanText) {
    blocks.unshift({ type: "text", text: cleanText });
  }

  return { cleanText, blocks };
}

// ---------------------------------------------------------------------------
// Package root resolution (for reading bundled plugins.json)
// ---------------------------------------------------------------------------

export function findOwnPackageRoot(startDir: string): string {
  const KNOWN_NAMES = new Set(["milady", "milaidy", "miladyai"]);
  let dir = startDir;
  for (let i = 0; i < 10; i++) {
    const pkgPath = path.join(dir, "package.json");
    if (fs.existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8")) as Record<
          string,
          unknown
        >;
        const pkgName =
          typeof pkg.name === "string" ? pkg.name.toLowerCase() : "";
        if (KNOWN_NAMES.has(pkgName)) return dir;
        // Also match if plugins.json exists at this level (resilient to renames)
        if (fs.existsSync(path.join(dir, "plugins.json"))) return dir;
      } catch {
        /* keep searching */
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return startDir;
}

function getReleaseBundledPluginIds(): Set<string> {
  const packageRoot = findOwnPackageRoot(
    import.meta.dirname ?? path.dirname(fileURLToPath(import.meta.url)),
  );
  const packageJsonPath = path.join(packageRoot, "package.json");

  try {
    const pkg = JSON.parse(fs.readFileSync(packageJsonPath, "utf-8")) as {
      dependencies?: Record<string, string>;
    };
    return new Set(
      getBundledRuntimePluginIds(Object.keys(pkg.dependencies ?? {})),
    );
  } catch (err) {
    logger.warn(
      `[milady-api] Failed to resolve bundled release plugins from package.json: ${err instanceof Error ? err.message : err}`,
    );
    return new Set();
  }
}

// ---------------------------------------------------------------------------
// Plugin discovery
// ---------------------------------------------------------------------------

interface PluginIndexEntry {
  id: string;
  dirName: string;
  name: string;
  npmName: string;
  description: string;
  tags?: string[];
  category:
    | "ai-provider"
    | "connector"
    | "streaming"
    | "database"
    | "app"
    | "feature";
  envKey: string | null;
  configKeys: string[];
  pluginParameters?: Record<string, Record<string, unknown>>;
  version?: string;
  pluginDeps?: string[];
  configUiHints?: Record<string, Record<string, unknown>>;
  logoUrl?: string;
  icon?: string;
  homepage?: string;
  repository?: string;
  setupGuideUrl?: string;
}

interface PluginIndex {
  $schema: string;
  generatedAt: string;
  count: number;
  plugins: PluginIndexEntry[];
}

function maskValue(value: string): string {
  if (value.length <= 8) return "****";
  return `${value.slice(0, 4)}...${value.slice(-4)}`;
}

function buildParamDefs(
  pluginParams: Record<string, Record<string, unknown>>,
): PluginParamDef[] {
  return Object.entries(pluginParams).map(([key, def]) => {
    const envValue = process.env[key];
    const isSet = Boolean(envValue?.trim());
    const sensitive = Boolean(def.sensitive);
    return {
      key,
      type: (def.type as string) ?? "string",
      description: (def.description as string) ?? "",
      required: Boolean(def.required),
      sensitive,
      default: def.default as string | undefined,
      options: Array.isArray(def.options)
        ? (def.options as string[])
        : undefined,
      currentValue: isSet
        ? sensitive
          ? maskValue(envValue ?? "")
          : (envValue ?? "")
        : null,
      isSet,
    };
  });
}

/**
 * Infer parameter definitions from bare config key names when explicit
 * pluginParameters metadata is not provided.  Uses naming conventions to
 * determine type, sensitivity, requirement level, and a human-readable
 * description.
 */
function _inferParamDefs(configKeys: string[]): PluginParamDef[] {
  return configKeys.map((key) => {
    const upper = key.toUpperCase();

    // Detect sensitive keys
    const sensitive =
      upper.includes("_API_KEY") ||
      upper.includes("_SECRET") ||
      upper.includes("_TOKEN") ||
      upper.includes("_PASSWORD") ||
      upper.includes("_PRIVATE_KEY") ||
      upper.includes("_SIGNING_") ||
      upper.includes("ENCRYPTION_");

    // Detect booleans
    const isBoolean =
      upper.includes("ENABLED") ||
      upper.includes("_ENABLE_") ||
      upper.startsWith("ENABLE_") ||
      upper.includes("DRY_RUN") ||
      upper.includes("_DEBUG") ||
      upper.includes("_VERBOSE") ||
      upper.includes("AUTO_") ||
      upper.includes("FORCE_") ||
      upper.includes("DISABLE_") ||
      upper.includes("SHOULD_") ||
      upper.endsWith("_SSL");

    // Detect numbers
    const isNumber =
      upper.endsWith("_PORT") ||
      upper.endsWith("_INTERVAL") ||
      upper.endsWith("_TIMEOUT") ||
      upper.endsWith("_MS") ||
      upper.endsWith("_MINUTES") ||
      upper.endsWith("_SECONDS") ||
      upper.endsWith("_LIMIT") ||
      upper.endsWith("_MAX") ||
      upper.endsWith("_MIN") ||
      upper.includes("_MAX_") ||
      upper.includes("_MIN_") ||
      upper.endsWith("_COUNT") ||
      upper.endsWith("_SIZE") ||
      upper.endsWith("_STEPS");

    const type = isBoolean ? "boolean" : isNumber ? "number" : "string";

    // Primary keys are required (API keys, tokens, bot tokens, account IDs)
    const required =
      sensitive &&
      (upper.endsWith("_API_KEY") ||
        upper.endsWith("_BOT_TOKEN") ||
        upper.endsWith("_TOKEN") ||
        upper.endsWith("_PRIVATE_KEY"));

    // Generate a human-readable description from the key name
    const description = inferDescription(key);

    const envValue = process.env[key];
    const isSet = Boolean(envValue?.trim());

    return {
      key,
      type,
      description,
      required,
      sensitive,
      default: undefined,
      options: undefined,
      currentValue: isSet
        ? sensitive
          ? maskValue(envValue ?? "")
          : (envValue ?? "")
        : null,
      isSet,
    };
  });
}

/** Derive a human-readable description from an environment variable key. */
function inferDescription(key: string): string {
  const upper = key.toUpperCase();

  // Special well-known suffixes
  if (upper.endsWith("_API_KEY"))
    return `API key for ${prefixLabel(key, "_API_KEY")}`;
  if (upper.endsWith("_BOT_TOKEN"))
    return `Bot token for ${prefixLabel(key, "_BOT_TOKEN")}`;
  if (upper.endsWith("_TOKEN"))
    return `Authentication token for ${prefixLabel(key, "_TOKEN")}`;
  if (upper.endsWith("_SECRET"))
    return `Secret for ${prefixLabel(key, "_SECRET")}`;
  if (upper.endsWith("_PRIVATE_KEY"))
    return `Private key for ${prefixLabel(key, "_PRIVATE_KEY")}`;
  if (upper.endsWith("_PASSWORD"))
    return `Password for ${prefixLabel(key, "_PASSWORD")}`;
  if (upper.endsWith("_RPC_URL"))
    return `RPC endpoint URL for ${prefixLabel(key, "_RPC_URL")}`;
  if (upper.endsWith("_BASE_URL"))
    return `Base URL for ${prefixLabel(key, "_BASE_URL")}`;
  if (upper.endsWith("_URL")) return `URL for ${prefixLabel(key, "_URL")}`;
  if (upper.endsWith("_ENDPOINT"))
    return `Endpoint for ${prefixLabel(key, "_ENDPOINT")}`;
  if (upper.endsWith("_HOST"))
    return `Host address for ${prefixLabel(key, "_HOST")}`;
  if (upper.endsWith("_PORT"))
    return `Port number for ${prefixLabel(key, "_PORT")}`;
  if (upper.endsWith("_MODEL") || upper.includes("_MODEL_"))
    return `Model identifier for ${prefixLabel(key, "_MODEL")}`;
  if (upper.endsWith("_VOICE") || upper.includes("_VOICE_"))
    return `Voice setting for ${prefixLabel(key, "_VOICE")}`;
  if (upper.endsWith("_DIR") || upper.endsWith("_PATH"))
    return `Directory path for ${prefixLabel(key, "_DIR").replace(/_PATH$/i, "")}`;
  if (upper.endsWith("_ENABLED") || upper.startsWith("ENABLE_"))
    return `Enable/disable ${prefixLabel(key, "_ENABLED").replace(/^ENABLE_/i, "")}`;
  if (upper.includes("DRY_RUN")) return `Dry-run mode (no real actions)`;
  if (upper.endsWith("_INTERVAL") || upper.endsWith("_INTERVAL_MINUTES"))
    return `Check interval for ${prefixLabel(key, "_INTERVAL")}`;
  if (upper.endsWith("_TIMEOUT") || upper.endsWith("_TIMEOUT_MS"))
    return `Timeout setting for ${prefixLabel(key, "_TIMEOUT")}`;

  // Generic: convert KEY_NAME to "Key name"
  return key
    .split("_")
    .map((w, i) =>
      i === 0
        ? w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()
        : w.toLowerCase(),
    )
    .join(" ");
}

/** Extract the plugin/service prefix label from a key by removing a known suffix. */
function prefixLabel(key: string, suffix: string): string {
  const raw = key.replace(new RegExp(`${suffix}$`, "i"), "").replace(/_+$/, "");
  if (!raw) return key;
  return raw
    .split("_")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(" ");
}

// ---------------------------------------------------------------------------
// Blocked env keys — dangerous system vars that must never be written via API
// ---------------------------------------------------------------------------

const BLOCKED_ENV_KEYS = new Set([
  // System-level injection vectors
  "LD_PRELOAD",
  "LD_LIBRARY_PATH",
  "DYLD_INSERT_LIBRARIES",
  "DYLD_LIBRARY_PATH",
  "NODE_OPTIONS",
  "NODE_EXTRA_CA_CERTS",
  // TLS bypass — setting to "0" disables ALL certificate verification,
  // enabling MITM interception of every outbound HTTPS request (API keys
  // for OpenAI, Anthropic, ElevenLabs etc. sent in plaintext headers).
  "NODE_TLS_REJECT_UNAUTHORIZED",
  // Proxy hijack — routes all HTTP/HTTPS traffic through attacker proxy,
  // exposing Authorization headers and API keys in transit.
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
  // Module resolution override
  "NODE_PATH",
  // CA certificate override — trust rogue CAs for MITM
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "CURL_CA_BUNDLE",
  "PATH",
  "HOME",
  "SHELL",
  // Auth / step-up tokens — writable via API would grant privilege escalation
  "ELIZA_API_TOKEN",
  "MILADY_API_TOKEN",
  "MILADY_WALLET_EXPORT_TOKEN",
  "MILADY_TERMINAL_RUN_TOKEN",
  "HYPERSCAPE_AUTH_TOKEN",
  // Wallet private keys — writable via API would enable key theft / replacement
  "EVM_PRIVATE_KEY",
  "SOLANA_PRIVATE_KEY",
  // Opinion Trade plugin secrets
  "OPINION_PRIVATE_KEY",
  "OPINION_API_KEY",
  // Third-party auth tokens
  "GITHUB_TOKEN",
  // Database connection strings
  "DATABASE_URL",
  "POSTGRES_URL",
]);

/**
 * Top-level config keys accepted by `PUT /api/config`.
 * Keep this in sync with ElizaConfig root fields and include both modern and
 * legacy aliases (e.g. `connectors` + `channels`).
 */
export const CONFIG_WRITE_ALLOWED_TOP_KEYS = new Set([
  "meta",
  "auth",
  "env",
  "wizard",
  "diagnostics",
  "logging",
  "update",
  "browser",
  "ui",
  "skills",
  "plugins",
  "models",
  "nodeHost",
  "agents",
  "tools",
  "bindings",
  "broadcast",
  "audio",
  "messages",
  "commands",
  "approvals",
  "session",
  "web",
  "connectors",
  "channels",
  "cron",
  "hooks",
  "discovery",
  "talk",
  "gateway",
  "memory",
  "database",
  "cloud",
  "x402",
  "mcp",
  "features",
]);

/**
 * Stream names accepted by `POST /api/agent/event`.
 * Plugins emit events to these streams for the StreamView UI.
 */
export const AGENT_EVENT_ALLOWED_STREAMS = new Set([
  "chat",
  "terminal",
  "game",
  "autonomy",

  "retake",
  "stream",
  "system",
  // Retake plugin event streams (chat-poll.ts emits these)
  "message",
  "new_viewer",
  "assistant",
  "thought",
  "action",
  "viewer_stats",
]);

// ---------------------------------------------------------------------------
// Secrets aggregation — collect all sensitive params across plugins
// ---------------------------------------------------------------------------

interface SecretEntry {
  key: string;
  description: string;
  category: string;
  sensitive: boolean;
  required: boolean;
  isSet: boolean;
  maskedValue: string | null;
  usedBy: Array<{ pluginId: string; pluginName: string; enabled: boolean }>;
}

const AI_PROVIDERS = new Set([
  "OPENAI",
  "ANTHROPIC",
  "GOOGLE",
  "MISTRAL",
  "GROQ",
  "COHERE",
  "TOGETHER",
  "FIREWORKS",
  "PERPLEXITY",
  "DEEPSEEK",
  "XAI",
  "OPENROUTER",
  "ELEVENLABS",
  "REPLICATE",
  "HUGGINGFACE",
]);

function inferSecretCategory(key: string): string {
  const upper = key.toUpperCase();

  // AI provider keys
  if (upper.endsWith("_API_KEY")) {
    const prefix = upper.replace(/_API_KEY$/, "");
    if (AI_PROVIDERS.has(prefix)) return "ai-provider";
  }

  // Blockchain
  if (
    upper.endsWith("_RPC_URL") ||
    upper.endsWith("_PRIVATE_KEY") ||
    upper.startsWith("SOLANA_") ||
    upper.startsWith("EVM_") ||
    upper.includes("_WALLET_") ||
    upper.includes("HELIUS") ||
    upper.includes("ALCHEMY") ||
    upper.includes("INFURA") ||
    upper.includes("ANKR") ||
    upper.includes("BIRDEYE")
  ) {
    return "blockchain";
  }

  // Connectors
  if (
    upper.endsWith("_BOT_TOKEN") ||
    upper.startsWith("TELEGRAM_") ||
    upper.startsWith("DISCORD_") ||
    upper.startsWith("TWITTER_") ||
    upper.startsWith("SLACK_") ||
    upper.startsWith("FARCASTER_")
  ) {
    return "connector";
  }

  // Auth
  if (
    upper.endsWith("_TOKEN") ||
    upper.endsWith("_SECRET") ||
    upper.endsWith("_PASSWORD")
  ) {
    return "auth";
  }

  return "other";
}

function aggregateSecrets(plugins: PluginEntry[]): SecretEntry[] {
  const map = new Map<string, SecretEntry>();

  for (const plugin of plugins) {
    for (const param of plugin.parameters) {
      if (!param.sensitive) continue;

      const existing = map.get(param.key);
      if (existing) {
        existing.usedBy.push({
          pluginId: plugin.id,
          pluginName: plugin.name,
          enabled: plugin.enabled,
        });
        // Only mark required if an *enabled* plugin requires it
        if (param.required && plugin.enabled) existing.required = true;
      } else {
        const envValue = process.env[param.key];
        const isSet = Boolean(envValue?.trim());
        map.set(param.key, {
          key: param.key,
          description: param.description || inferDescription(param.key),
          category: inferSecretCategory(param.key),
          sensitive: true,
          required: param.required && plugin.enabled,
          isSet,
          maskedValue: isSet ? maskValue(envValue ?? "") : null,
          usedBy: [
            {
              pluginId: plugin.id,
              pluginName: plugin.name,
              enabled: plugin.enabled,
            },
          ],
        });
      }
    }
  }

  return Array.from(map.values());
}

/**
 * Discover user-installed plugins from the Store (not bundled in the manifest).
 * Reads from config.plugins.installs and tries to enrich with package.json metadata.
 */
export function discoverInstalledPlugins(
  config: ElizaConfig,
  bundledIds: Set<string>,
): PluginEntry[] {
  const installs = config.plugins?.installs;
  if (!installs || typeof installs !== "object") return [];

  const entries: PluginEntry[] = [];

  for (const [packageName, record] of Object.entries(installs)) {
    // Derive a short id from the package name (e.g. "@elizaos/plugin-foo" -> "foo")
    const id = packageName
      .replace(/^@[^/]+\/plugin-/, "")
      .replace(/^@[^/]+\//, "")
      .replace(/^plugin-/, "");

    // Skip if it's already covered by the bundled manifest
    if (bundledIds.has(id)) continue;

    const category = categorizePlugin(id);
    const installPath = (record as Record<string, string>).installPath;

    // Try to read the plugin's package.json for metadata
    let name = packageName;
    let description = `Installed from registry (v${(record as Record<string, string>).version ?? "unknown"})`;
    let pluginConfigKeys: string[] = [];
    let pluginParameters: PluginParamDef[] = [];
    let pluginTags: string[] = [];

    let pluginIcon: string | null = null;
    let pluginHomepage: string | undefined;
    let pluginRepository: string | undefined;

    if (installPath) {
      // Check npm layout first, then direct layout
      const candidates = [
        path.join(
          installPath,
          "node_modules",
          ...packageName.split("/"),
          "package.json",
        ),
        path.join(installPath, "package.json"),
      ];
      for (const pkgPath of candidates) {
        try {
          if (fs.existsSync(pkgPath)) {
            const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8")) as {
              name?: string;
              description?: string;
              homepage?: string;
              repository?: string | { type?: string; url?: string };
              keywords?: string[];
              elizaos?: {
                displayName?: string;
                configKeys?: string[];
                configDefaults?: Record<string, string>;
                logoUrl?: string;
              };
              agentConfig?: {
                pluginParameters?: Record<string, Record<string, unknown>>;
              };
              logoUrl?: string;
              icon?: string;
            };
            if (pkg.name) name = pkg.name;
            if (pkg.description) description = pkg.description;
            pluginTags = normalizePluginMetadataTags(pkg.keywords);
            if (pkg.elizaos?.displayName) name = pkg.elizaos.displayName;
            if (pkg.elizaos?.configKeys) {
              pluginConfigKeys = pkg.elizaos.configKeys;
              const defaults = pkg.elizaos.configDefaults ?? {};
              pluginParameters = pluginConfigKeys.map((key) => ({
                key,
                label: key,
                description: "",
                required: false,
                sensitive:
                  key.toLowerCase().includes("key") ||
                  key.toLowerCase().includes("secret"),
                type: "string" as const,
                default: defaults[key] ?? undefined,
                isSet: Boolean(process.env[key]?.trim()),
                currentValue: null,
              }));
            } else if (pkg.agentConfig?.pluginParameters) {
              pluginConfigKeys = Object.keys(pkg.agentConfig.pluginParameters);
              pluginParameters = buildParamDefs(
                pkg.agentConfig.pluginParameters,
              );
            }
            // Map logoUrl or icon from package.json if available
            pluginIcon =
              pkg.logoUrl ?? pkg.elizaos?.logoUrl ?? pkg.icon ?? null;
            pluginHomepage =
              typeof pkg.homepage === "string" ? pkg.homepage : undefined;
            pluginRepository =
              normalizeRepositoryUrl(pkg.repository) ??
              deriveMiladyRepositoryUrl(packageName, `plugin-${id}`);
            break;
          }
        } catch {
          // ignore read errors
        }
      }
    }

    const resolvedDescription = resolvePluginDescription(
      id,
      name,
      category,
      description,
    );
    const resolvedTags = resolvePluginTags(id, category, pluginTags);

    entries.push({
      id,
      name,
      npmName: packageName,
      description: resolvedDescription,
      tags: resolvedTags,
      enabled: false, // Will be updated against the runtime below
      configured:
        pluginConfigKeys.length === 0 || pluginParameters.some((p) => p.isSet),
      envKey: pluginConfigKeys[0] ?? null,
      category,
      source: "store",
      configKeys: pluginConfigKeys,
      parameters: pluginParameters,
      validationErrors: [],
      validationWarnings: [],
      icon: pluginIcon,
      homepage: pluginHomepage,
      repository: pluginRepository,
      setupGuideUrl: resolvePluginSetupGuideUrl(id),
    });
  }

  return entries.sort((a, b) => a.name.localeCompare(b.name));
}

// applyWhatsAppQrOverride is imported from ./whatsapp-routes

/**
 * Discover available plugins from the bundled plugins.json manifest.
 * Falls back to filesystem scanning for monorepo development.
 */
export function discoverPluginsFromManifest(): PluginEntry[] {
  const thisDir =
    import.meta.dirname ?? path.dirname(fileURLToPath(import.meta.url));
  const packageRoot = findOwnPackageRoot(thisDir);
  const manifestPath = path.join(packageRoot, "plugins.json");

  if (fs.existsSync(manifestPath)) {
    try {
      const index = JSON.parse(
        fs.readFileSync(manifestPath, "utf-8"),
      ) as PluginIndex;
      // Keys that are auto-injected by infrastructure and should never be
      // exposed as user-facing "config keys" or parameter definitions.
      const HIDDEN_KEYS = new Set(["VERCEL_OIDC_TOKEN"]);
      const entries = index.plugins
        .map((p) => {
          const inferredCategory = categorizePlugin(p.id);
          const category =
            inferredCategory === "feature"
              ? (p.category ?? inferredCategory)
              : inferredCategory;
          const envKey = p.envKey;
          const bundledMeta = readBundledPluginPackageMetadata(
            packageRoot,
            p.dirName,
            p.npmName,
          );
          const filteredConfigKeys = p.configKeys.filter(
            (k) => !HIDDEN_KEYS.has(k),
          );
          const configured = envKey
            ? Boolean(process.env[envKey])
            : filteredConfigKeys.length === 0;
          const filteredParams = p.pluginParameters
            ? Object.fromEntries(
                Object.entries(p.pluginParameters).filter(
                  ([k]) => !HIDDEN_KEYS.has(k),
                ),
              )
            : undefined;
          const parameters = filteredParams
            ? buildParamDefs(filteredParams)
            : [];
          const paramInfos: PluginParamInfo[] = parameters.map((pd) => ({
            key: pd.key,
            required: pd.required,
            sensitive: pd.sensitive,
            type: pd.type,
            description: pd.description,
            default: pd.default,
          }));
          const validation = validatePluginConfig(
            p.id,
            category,
            envKey,
            filteredConfigKeys,
            undefined,
            paramInfos,
          );

          const description = resolvePluginDescription(
            p.id,
            p.name,
            category,
            p.description || bundledMeta.description,
          );
          const tags = resolvePluginTags(
            p.id,
            category,
            p.tags,
            bundledMeta.tags,
          );

          return {
            id: p.id,
            name: p.name,
            description,
            tags,
            enabled: false,
            configured,
            envKey,
            category,
            source: "bundled" as const,
            configKeys: filteredConfigKeys,
            parameters,
            validationErrors: validation.errors,
            validationWarnings: validation.warnings,
            npmName: p.npmName,
            version: p.version,
            pluginDeps: p.pluginDeps,
            ...(p.configUiHints ? { configUiHints: p.configUiHints } : {}),
            icon: p.logoUrl ?? p.icon ?? bundledMeta.icon ?? null,
            homepage: p.homepage ?? bundledMeta.homepage,
            repository:
              p.repository ??
              bundledMeta.repository ??
              deriveMiladyRepositoryUrl(p.npmName, p.dirName),
            setupGuideUrl: p.setupGuideUrl ?? resolvePluginSetupGuideUrl(p.id),
          };
        })
        .sort((a, b) => a.name.localeCompare(b.name));

      applyWhatsAppQrOverride(entries, resolveDefaultAgentWorkspaceDir());
      applySignalQrOverride(
        entries,
        resolveDefaultAgentWorkspaceDir(),
        signalAuthExists,
      );

      return entries;
    } catch (err) {
      logger.debug(
        `[milady-api] Failed to read plugins.json: ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  // Fallback: no manifest found
  logger.debug(
    "[milady-api] plugins.json not found — run `npm run generate:plugins`",
  );
  return [];
}

function categorizePlugin(
  id: string,
): "ai-provider" | "connector" | "streaming" | "database" | "feature" {
  const aiProviders = [
    "openai",
    "anthropic",
    "groq",
    "xai",
    "ollama",
    "openrouter",
    "google-genai",
    "local-ai",
    "vercel-ai-gateway",
    "deepseek",
    "together",
    "mistral",
    "cohere",
    "perplexity",
    "qwen",
    "minimax",
    "zai",
    "pi-ai",
  ];
  const connectors = [
    "telegram",
    "discord",
    "slack",
    "twitter",
    "whatsapp",
    "signal",
    "imessage",
    "bluebubbles",
    "farcaster",
    "bluesky",
    "matrix",
    "nostr",
    "msteams",
    "mattermost",
    "google-chat",
    "feishu",
    "line",
    "zalo",
    "zalouser",
    "tlon",
    "nextcloud-talk",
    "instagram",
    "blooio",
    "twitch",
  ];
  const streamingDests = [
    "streaming-base",
    "retake",
    "custom-rtmp",
    "youtube",
    "youtube-streaming",
    "twitch-streaming",
    "x-streaming",
    "pumpfun-streaming",
  ];
  const databases = ["sql", "localdb", "inmemorydb"];

  if (aiProviders.includes(id)) return "ai-provider";
  if (streamingDests.includes(id)) return "streaming";
  if (connectors.includes(id)) return "connector";
  if (databases.includes(id)) return "database";
  return "feature";
}

const PLUGIN_SETUP_GUIDE_ROOT = "https://docs.milady.ai/plugin-setup-guide";
const MILADY_REPO_ROOT = "https://github.com/milady-ai/milady";
const PLUGIN_METADATA_TAG_STOPWORDS = new Set([
  "plugin",
  "plugins",
  "eliza",
  "elizaos",
  "milady",
  "elizaos-plugin",
  "elizaos-plugins",
  "feature",
]);
const SOCIAL_CHAT_CONNECTOR_IDS = new Set([
  "telegram",
  "discord",
  "slack",
  "whatsapp",
  "signal",
  "imessage",
  "bluebubbles",
  "matrix",
  "mattermost",
  "msteams",
  "google-chat",
  "feishu",
  "line",
  "zalo",
  "zalouser",
  "tlon",
  "nextcloud-talk",
  "blooio",
  "twilio",
  "twitch",
]);
const SOCIAL_FEED_CONNECTOR_IDS = new Set([
  "twitter",
  "bluesky",
  "farcaster",
  "instagram",
  "nostr",
]);
const PLUGIN_METADATA_CATEGORY_TAGS: Record<string, string[]> = {
  "ai-provider": ["ai-provider", "llm"],
  connector: ["connector"],
  streaming: ["streaming", "broadcast"],
  database: ["database", "storage"],
  app: ["app", "interactive"],
  feature: ["feature"],
};
const PLUGIN_DESCRIPTION_OVERRIDES: Record<string, string> = {
  slack: "Slack workspace connector for chatting with your agent",
  signal: "Signal connector for secure chats with your agent",
  mattermost: "Mattermost connector for team chat with your agent",
  msteams: "Microsoft Teams connector for chatting with your agent",
  "nextcloud-talk": "Nextcloud Talk connector for chatting with your agent",
  blooio: "Blooio SMS connector for texting your agent",
  github:
    "GitHub connector for issues, pull requests, and repository automation",
  "gmail-watch":
    "Gmail watcher that turns new incoming emails into agent events",
  mcp: "Model Context Protocol connector for external tools and servers",
};

const PLUGIN_SETUP_GUIDE_ANCHORS: Record<string, string> = {
  openai: "#openai",
  anthropic: "#anthropic",
  "google-genai": "#google-gemini",
  groq: "#groq",
  openrouter: "#openrouter",
  xai: "#xai-grok",
  ollama: "#ollama-local-models",
  "local-ai": "#local-ai",
  "vercel-ai-gateway": "#vercel-ai-gateway",
  discord: "#discord",
  telegram: "#telegram",
  twitter: "#twitter--x",
  slack: "#slack",
  whatsapp: "#whatsapp",
  instagram: "#instagram",
  bluesky: "#bluesky",
  farcaster: "#farcaster",
  github: "#github",
  twitch: "#twitch",
  twilio: "#twilio-sms--voice",
  matrix: "#matrix",
  msteams: "#microsoft-teams",
  "google-chat": "#google-chat",
  signal: "#signal",
  imessage: "#imessage-macos-only",
  bluebubbles: "#bluebubbles-imessage-from-any-platform",
  blooio: "#blooio-sms-via-api",
  nostr: "#nostr",
  line: "#line",
  feishu: "#feishu-lark",
  mattermost: "#mattermost",
  "nextcloud-talk": "#nextcloud-talk",
  tlon: "#tlon-urbit",
  zalo: "#zalo-vietnam-messaging",
  zalouser: "#zalo-user-personal",
  acp: "#acp-agent-communication-protocol",
  mcp: "#mcp-model-context-protocol",
  iq: "#iq-solana-on-chain",
  "gmail-watch": "#gmail-watch",
  retake: "#retaketv",
  "streaming-base": "#enable-streaming-streaming-base",
  "twitch-streaming": "#twitch-streaming",
  "youtube-streaming": "#youtube-streaming",
  "x-streaming": "#x-streaming",
  "pumpfun-streaming": "#pumpfun-streaming",
  "custom-rtmp": "#custom-rtmp",
};

export function resolvePluginSetupGuideUrl(id: string): string | undefined {
  const anchor = PLUGIN_SETUP_GUIDE_ANCHORS[id];
  return anchor ? `${PLUGIN_SETUP_GUIDE_ROOT}${anchor}` : undefined;
}

export function normalizeRepositoryUrl(
  repository: string | { type?: string; url?: string } | null | undefined,
): string | undefined {
  const raw =
    typeof repository === "string"
      ? repository.trim()
      : repository?.url?.trim() || "";
  if (!raw) return undefined;
  if (/^[\w.-]+\/[\w.-]+$/.test(raw)) return `https://github.com/${raw}`;
  if (raw.startsWith("git@github.com:")) {
    return `https://github.com/${raw
      .slice("git@github.com:".length)
      .replace(/\.git$/, "")}`;
  }
  if (raw.startsWith("git+https://")) return raw.slice(4).replace(/\.git$/, "");
  if (raw.startsWith("https://") || raw.startsWith("http://")) {
    return raw.replace(/\.git$/, "");
  }
  return undefined;
}

function deriveMiladyRepositoryUrl(
  npmName: string | undefined,
  dirName: string | undefined,
): string | undefined {
  if (!npmName?.startsWith("@miladyai/")) return undefined;
  if (!dirName?.startsWith("plugin-")) return undefined;
  return `${MILADY_REPO_ROOT}/tree/main/packages/${dirName}`;
}

function normalizePluginMetadataTag(tag: string): string | null {
  const normalized = tag
    .trim()
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!normalized || PLUGIN_METADATA_TAG_STOPWORDS.has(normalized)) {
    return null;
  }
  return normalized;
}

function normalizePluginMetadataTags(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  const tags: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    if (typeof value !== "string") continue;
    const normalized = normalizePluginMetadataTag(value);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    tags.push(normalized);
  }
  return tags;
}

function mergePluginMetadataTags(...sources: unknown[]): string[] {
  const tags: string[] = [];
  const seen = new Set<string>();
  for (const source of sources) {
    for (const tag of normalizePluginMetadataTags(source)) {
      if (seen.has(tag)) continue;
      seen.add(tag);
      tags.push(tag);
    }
  }
  return tags;
}

function pluginIdTags(id: string): string[] {
  return normalizePluginMetadataTags([id, ...id.split("-")]);
}

function connectorMetadataTags(id: string): string[] {
  if (SOCIAL_CHAT_CONNECTOR_IDS.has(id)) {
    return ["social", "social-chat", "messaging"];
  }
  if (SOCIAL_FEED_CONNECTOR_IDS.has(id)) {
    return ["social", "social-feed"];
  }
  return ["integration"];
}

function resolvePluginDescription(
  id: string,
  name: string,
  category: PluginEntry["category"],
  description: string | undefined,
): string {
  const displayName = name.startsWith("@") ? formatPluginName(id) : name;
  const trimmed = description?.trim();
  if (trimmed) return trimmed;
  if (PLUGIN_DESCRIPTION_OVERRIDES[id]) return PLUGIN_DESCRIPTION_OVERRIDES[id];
  if (category === "ai-provider") {
    return `${displayName} AI provider for Milady agents`;
  }
  if (category === "connector") {
    if (SOCIAL_CHAT_CONNECTOR_IDS.has(id)) {
      return `${displayName} connector for chatting with your agent`;
    }
    if (SOCIAL_FEED_CONNECTOR_IDS.has(id)) {
      return `${displayName} social connector for connecting your agent to ${displayName}`;
    }
    return `${displayName} connector plugin for Milady agents`;
  }
  if (category === "streaming") {
    return `${displayName} streaming destination for live agent broadcasts`;
  }
  if (category === "database") {
    return `${displayName} storage plugin for Milady agents`;
  }
  if (category === "app") {
    return `${displayName} interactive app for Milady agents`;
  }
  return `${displayName} plugin for Milady agents`;
}

function resolvePluginTags(
  id: string,
  category: PluginEntry["category"],
  ...sources: unknown[]
): string[] {
  return mergePluginMetadataTags(
    ...sources,
    PLUGIN_METADATA_CATEGORY_TAGS[category] ?? [],
    category === "connector" ? connectorMetadataTags(id) : [],
    pluginIdTags(id),
  );
}

function formatPluginName(id: string): string {
  return id
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function readBundledPluginPackageMetadata(
  packageRoot: string,
  dirName: string,
  npmName?: string,
): {
  description?: string;
  homepage?: string;
  repository?: string;
  icon?: string | null;
  tags?: string[];
} {
  const pkgPath = path.join(packageRoot, "packages", dirName, "package.json");
  if (!fs.existsSync(pkgPath)) {
    return {
      repository: deriveMiladyRepositoryUrl(npmName, dirName),
      tags: [],
    };
  }
  try {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8")) as {
      description?: string;
      homepage?: string;
      repository?: string | { type?: string; url?: string };
      keywords?: string[];
      logoUrl?: string;
      icon?: string;
      elizaos?: { logoUrl?: string };
    };
    return {
      description: pkg.description?.trim() || undefined,
      homepage: pkg.homepage ?? undefined,
      repository:
        normalizeRepositoryUrl(pkg.repository) ??
        deriveMiladyRepositoryUrl(npmName, dirName),
      icon: pkg.logoUrl ?? pkg.elizaos?.logoUrl ?? pkg.icon ?? null,
      tags: normalizePluginMetadataTags(pkg.keywords),
    };
  } catch {
    return {
      repository: deriveMiladyRepositoryUrl(npmName, dirName),
      tags: [],
    };
  }
}

// ---------------------------------------------------------------------------
// Skills discovery + database-backed preferences
// ---------------------------------------------------------------------------

/** Cache key for persisting skill enable/disable state in the agent database. */
const SKILL_PREFS_CACHE_KEY = "milady:skill-preferences";

/** Shape stored in the cache: maps skill ID → enabled flag. */
type SkillPreferencesMap = Record<string, boolean>;

/**
 * Load persisted skill preferences from the agent's database.
 * Returns an empty map when the runtime or database isn't available.
 */
async function loadSkillPreferences(
  runtime: AgentRuntime | null,
): Promise<SkillPreferencesMap> {
  if (!runtime) return {};
  try {
    const prefs = await runtime.getCache<SkillPreferencesMap>(
      SKILL_PREFS_CACHE_KEY,
    );
    return prefs ?? {};
  } catch {
    return {};
  }
}

/**
 * Persist skill preferences to the agent's database.
 */
async function saveSkillPreferences(
  runtime: AgentRuntime,
  prefs: SkillPreferencesMap,
): Promise<void> {
  try {
    await runtime.setCache(SKILL_PREFS_CACHE_KEY, prefs);
  } catch (err) {
    logger.debug(
      `[milady-api] Failed to save skill preferences: ${err instanceof Error ? err.message : err}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Skill scan acknowledgments — tracks user review of security findings
// ---------------------------------------------------------------------------

const SKILL_ACK_CACHE_KEY = "milady:skill-scan-acknowledgments";

type SkillAcknowledgmentMap = Record<
  string,
  { acknowledgedAt: string; findingCount: number }
>;

async function loadSkillAcknowledgments(
  runtime: AgentRuntime | null,
): Promise<SkillAcknowledgmentMap> {
  if (!runtime) return {};
  try {
    const acks =
      await runtime.getCache<SkillAcknowledgmentMap>(SKILL_ACK_CACHE_KEY);
    return acks ?? {};
  } catch {
    return {};
  }
}

async function saveSkillAcknowledgments(
  runtime: AgentRuntime,
  acks: SkillAcknowledgmentMap,
): Promise<void> {
  try {
    await runtime.setCache(SKILL_ACK_CACHE_KEY, acks);
  } catch (err) {
    logger.debug(
      `[milady-api] Failed to save skill acknowledgments: ${err instanceof Error ? err.message : err}`,
    );
  }
}

/**
 * Load a .scan-results.json from the skill's directory on disk.
 *
 * Checks multiple locations because skills can be installed from different sources:
 * - Workspace skills: {workspace}/skills/{id}/
 * - Marketplace skills: {workspace}/skills/.marketplace/{id}/
 * - Catalog-installed (managed) skills: {managed-dir}/{id}/ (default: ./skills/)
 *
 * Also queries the AgentSkillsService for the skill's path when a runtime is available,
 * which covers all sources regardless of directory layout.
 */
async function loadScanReportFromDisk(
  skillId: string,
  workspaceDir: string,
  runtime?: AgentRuntime | null,
): Promise<Record<string, unknown> | null> {
  const fsSync = await import("node:fs");
  const pathMod = await import("node:path");

  const candidates = [
    pathMod.join(workspaceDir, "skills", skillId, ".scan-results.json"),
    pathMod.join(
      workspaceDir,
      "skills",
      ".marketplace",
      skillId,
      ".scan-results.json",
    ),
  ];

  // Also check the path reported by the AgentSkillsService (covers catalog-installed skills
  // whose managed dir might differ from the workspace dir)
  if (runtime) {
    const svc = runtime.getService("AGENT_SKILLS_SERVICE") as
      | { getLoadedSkills?: () => Array<{ slug: string; path: string }> }
      | undefined;
    if (svc?.getLoadedSkills) {
      const loaded = svc.getLoadedSkills().find((s) => s.slug === skillId);
      if (loaded?.path) {
        candidates.push(pathMod.join(loaded.path, ".scan-results.json"));
      }
    }
  }

  // Deduplicate in case paths overlap
  const seen = new Set<string>();
  for (const candidate of candidates) {
    const resolved = pathMod.resolve(candidate);
    if (seen.has(resolved)) continue;
    seen.add(resolved);

    if (!fsSync.existsSync(resolved)) continue;
    const content = fsSync.readFileSync(resolved, "utf-8");
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(content) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (
      typeof parsed.scannedAt === "string" &&
      typeof parsed.status === "string" &&
      Array.isArray(parsed.findings) &&
      Array.isArray(parsed.manifestFindings)
    ) {
      return parsed as Record<string, unknown>;
    }
  }

  return null;
}

/**
 * Determine whether a skill should be enabled.
 *
 * Priority (highest first):
 *   1. Database preferences (per-agent, persisted via PUT /api/skills/:id)
 *   2. `skills.denyBundled` config — always blocks
 *   3. `skills.entries[id].enabled` config — per-skill default
 *   4. `skills.allowBundled` config — whitelist mode
 *   5. Default: enabled
 */
function resolveSkillEnabled(
  id: string,
  config: ElizaConfig,
  dbPrefs: SkillPreferencesMap,
): boolean {
  // Database preference takes priority (explicit user action)
  if (id in dbPrefs) return dbPrefs[id];

  const skillsCfg = config.skills;

  // Deny list always blocks
  if (skillsCfg?.denyBundled?.includes(id)) return false;

  // Per-skill config entry
  const entry = skillsCfg?.entries?.[id];
  if (entry && entry.enabled === false) return false;
  if (entry && entry.enabled === true) return true;

  // Allowlist: if set, only listed skills are enabled
  if (skillsCfg?.allowBundled && skillsCfg.allowBundled.length > 0) {
    return skillsCfg.allowBundled.includes(id);
  }

  return true;
}

function parseSkillDirsSetting(raw: unknown): string[] {
  if (typeof raw !== "string") return [];
  return raw
    .split(",")
    .map((dir) => dir.trim())
    .filter((dir) => dir.length > 0);
}

/**
 * Discover skills from @elizaos/skills and workspace, applying
 * database preferences and config filtering.
 *
 * When a runtime is available, skills are primarily sourced from the
 * AgentSkillsService (which has already loaded, validated, and
 * precedence-resolved all skills). Filesystem scanning is used as a
 * fallback when the service isn't registered.
 */
async function discoverSkills(
  workspaceDir: string,
  config: ElizaConfig,
  runtime: AgentRuntime | null,
): Promise<SkillEntry[]> {
  // Load persisted preferences from the agent database
  const dbPrefs = await loadSkillPreferences(runtime);

  // ── Primary path: pull from AgentSkillsService (most accurate) ──────────
  if (runtime) {
    try {
      const service = runtime.getService("AGENT_SKILLS_SERVICE");
      // eslint-disable-next-line -- runtime service is loosely typed; cast via unknown
      const svc = service as unknown as
        | {
            getLoadedSkills?: () => Array<{
              slug: string;
              name: string;
              description: string;
              source: string;
              path: string;
            }>;
            getSkillScanStatus?: (
              slug: string,
            ) => "clean" | "warning" | "critical" | "blocked" | null;
          }
        | undefined;
      if (svc && typeof svc.getLoadedSkills === "function") {
        const loadedSkills = svc.getLoadedSkills();

        if (loadedSkills.length > 0) {
          const skills: SkillEntry[] = loadedSkills.map((s) => {
            // Get scan status from in-memory map (fast) or from disk report
            let scanStatus: SkillEntry["scanStatus"] = null;
            if (svc.getSkillScanStatus) {
              scanStatus = svc.getSkillScanStatus(s.slug);
            }
            if (!scanStatus) {
              // Check for .scan-results.json on disk
              const reportPath = path.join(s.path, ".scan-results.json");
              if (fs.existsSync(reportPath)) {
                const raw = fs.readFileSync(reportPath, "utf-8");
                try {
                  const parsed = JSON.parse(raw) as { status?: string };
                  if (parsed.status) {
                    scanStatus = parsed.status as
                      | "clean"
                      | "warning"
                      | "critical"
                      | "blocked";
                  }
                } catch {
                  // Malformed scan report — treat as unscanned.
                }
              }
            }

            return {
              id: s.slug,
              name: s.name || s.slug,
              description: (s.description || "").slice(0, 200),
              enabled: resolveSkillEnabled(s.slug, config, dbPrefs),
              scanStatus,
            };
          });

          return skills.sort((a, b) => a.name.localeCompare(b.name));
        }
      }
    } catch {
      logger.debug(
        "[milady-api] AgentSkillsService not available, falling back to filesystem scan",
      );
    }
  }

  // ── Fallback: filesystem scanning ───────────────────────────────────────
  const skillsDirs = new Set<string>();

  // Bundled skills from the @elizaos/skills package
  try {
    const skillsPkg = (await import(/* @vite-ignore */ "@elizaos/skills")) as {
      getSkillsDir: () => string;
    };
    const bundledDir = skillsPkg.getSkillsDir();
    if (bundledDir && fs.existsSync(bundledDir)) {
      skillsDirs.add(bundledDir);
    }
  } catch {
    logger.debug(
      "[milady-api] @elizaos/skills not available for skill discovery",
    );
  }

  // Runtime-provided skill directories (works even when @elizaos/skills is not installed
  // as a direct dependency and AgentSkillsService catalog sync is degraded).
  if (runtime && typeof runtime.getSetting === "function") {
    for (const dir of parseSkillDirsSetting(
      runtime.getSetting("BUNDLED_SKILLS_DIRS"),
    )) {
      if (fs.existsSync(dir)) skillsDirs.add(dir);
    }
    for (const dir of parseSkillDirsSetting(
      runtime.getSetting("EXTRA_SKILLS_DIRS"),
    )) {
      if (fs.existsSync(dir)) skillsDirs.add(dir);
    }
    for (const dir of parseSkillDirsSetting(
      runtime.getSetting("WORKSPACE_SKILLS_DIR"),
    )) {
      if (fs.existsSync(dir)) skillsDirs.add(dir);
    }
  }

  // Managed skills in the state dir (~/.milady/skills by default)
  const managedSkills = path.join(resolveStateDir(), "skills");
  if (fs.existsSync(managedSkills)) {
    skillsDirs.add(managedSkills);
  }

  // Workspace-local skills
  const workspaceSkills = path.join(workspaceDir, "skills");
  if (fs.existsSync(workspaceSkills)) {
    skillsDirs.add(workspaceSkills);
  }

  // Marketplace-installed skills (stored under .marketplace, skipped by dot-prefix filter)
  const marketplaceSkills = path.join(workspaceDir, "skills", ".marketplace");
  if (fs.existsSync(marketplaceSkills)) {
    skillsDirs.add(marketplaceSkills);
  }

  // Extra dirs from config
  const extraDirs = config.skills?.load?.extraDirs;
  if (extraDirs) {
    for (const dir of extraDirs) {
      if (fs.existsSync(dir)) skillsDirs.add(dir);
    }
  }

  const skills: SkillEntry[] = [];
  const seen = new Set<string>();

  for (const dir of skillsDirs) {
    scanSkillsDir(dir, skills, seen, config, dbPrefs);
  }

  return skills.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Recursively scan a directory for SKILL.md files, applying config filtering.
 */
function scanSkillsDir(
  dir: string,
  skills: SkillEntry[],
  seen: Set<string>,
  config: ElizaConfig,
  dbPrefs: SkillPreferencesMap,
): void {
  if (!fs.existsSync(dir)) return;

  for (const entry of fs.readdirSync(dir)) {
    if (
      entry.startsWith(".") ||
      entry === "node_modules" ||
      entry === "src" ||
      entry === "dist"
    )
      continue;

    const entryPath = path.join(dir, entry);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(entryPath);
    } catch {
      continue;
    }

    if (!stat.isDirectory()) continue;

    const skillMd = path.join(entryPath, "SKILL.md");
    if (fs.existsSync(skillMd)) {
      if (seen.has(entry)) continue;
      seen.add(entry);

      try {
        const content = fs.readFileSync(skillMd, "utf-8");

        let skillName = entry;
        let description = "";

        // Parse YAML frontmatter
        const fmMatch = /^---\s*\n([\s\S]*?)\n---/.exec(content);
        if (fmMatch) {
          const fmBlock = fmMatch[1];
          const nameMatch = /^name:\s*(.+)$/m.exec(fmBlock);
          const descMatch = /^description:\s*(.+)$/m.exec(fmBlock);
          if (nameMatch)
            skillName = nameMatch[1].trim().replace(/^["']|["']$/g, "");
          if (descMatch)
            description = descMatch[1].trim().replace(/^["']|["']$/g, "");
        }

        // Fallback to heading / first paragraph
        if (!description) {
          const lines = content.split("\n");
          const heading = lines.find((l) => l.trim().startsWith("#"));
          if (heading) skillName = heading.replace(/^#+\s*/, "").trim();
          const descLine = lines.find(
            (l) =>
              l.trim() &&
              !l.trim().startsWith("#") &&
              !l.trim().startsWith("---"),
          );
          description = descLine?.trim() ?? "";
        }

        skills.push({
          id: entry,
          name: skillName,
          description: description.slice(0, 200),
          enabled: resolveSkillEnabled(entry, config, dbPrefs),
        });
      } catch {
        /* skip unreadable */
      }
    } else {
      // Recurse into subdirectories for nested skill groups
      scanSkillsDir(entryPath, skills, seen, config, dbPrefs);
    }
  }
}

// ---------------------------------------------------------------------------
// Request helpers
// ---------------------------------------------------------------------------

/** Maximum request body size (1 MB) — prevents memory-based DoS. */
const MAX_BODY_BYTES = 1_048_576;

/**
 * Raised body limit for chat endpoints that accept base64-encoded image
 * attachments. A single smartphone JPEG is typically 2–5 MB binary
 * (~3–7 MB base64); 20 MB accommodates up to 4 images with room to spare.
 */
const CHAT_MAX_BODY_BYTES = 20 * 1_048_576;
const ELEVENLABS_FETCH_TIMEOUT_MS = 20_000;
const ELEVENLABS_AUDIO_MAX_BYTES = 20 * 1_048_576;

type StreamableServerResponse = Pick<
  http.ServerResponse,
  "write" | "once" | "off" | "removeListener"
> & {
  writableEnded?: boolean;
  destroyed?: boolean;
};

function removeResponseListener(
  res: StreamableServerResponse,
  event: "drain" | "error",
  handler: (...args: unknown[]) => void,
): void {
  if (typeof res.off === "function") {
    res.off(event, handler);
    return;
  }
  if (typeof res.removeListener === "function") {
    res.removeListener(event, handler);
  }
}

function responseContentLength(headers: Pick<Headers, "get">): number | null {
  const raw = headers.get("content-length");
  if (!raw) return null;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return parsed;
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException
    ? error.name === "AbortError" || error.name === "TimeoutError"
    : error instanceof Error &&
        (error.name === "AbortError" || error.name === "TimeoutError");
}

function createTimeoutError(message: string): Error {
  const timeoutError = new Error(message);
  timeoutError.name = "TimeoutError";
  return timeoutError;
}

export async function fetchWithTimeoutGuard(
  input: string | URL,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const upstreamSignal = init.signal;
  let timedOut = false;

  const onAbort = () => {
    controller.abort();
  };

  if (upstreamSignal) {
    if (upstreamSignal.aborted) {
      controller.abort();
    } else {
      upstreamSignal.addEventListener("abort", onAbort, { once: true });
    }
  }

  const timeoutHandle = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  try {
    return await fetch(input, {
      ...init,
      signal: controller.signal,
    });
  } catch (err) {
    if (timedOut && isAbortError(err)) {
      throw createTimeoutError(
        `Upstream request timed out after ${timeoutMs}ms`,
      );
    }
    throw err;
  } finally {
    clearTimeout(timeoutHandle);
    if (upstreamSignal) {
      upstreamSignal.removeEventListener("abort", onAbort);
    }
  }
}

async function waitForDrain(res: StreamableServerResponse): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const onDrain = () => {
      cleanup();
      resolve();
    };
    const onError = (err: unknown) => {
      cleanup();
      reject(err instanceof Error ? err : new Error(String(err)));
    };
    const cleanup = () => {
      removeResponseListener(
        res,
        "drain",
        onDrain as (...args: unknown[]) => void,
      );
      removeResponseListener(
        res,
        "error",
        onError as (...args: unknown[]) => void,
      );
    };

    res.once("drain", onDrain);
    res.once("error", onError);
  });
}

/**
 * Stream a web Response body to an HTTP response while enforcing a strict byte cap.
 * Returns the number of bytes forwarded.
 */
export async function streamResponseBodyWithByteLimit(
  upstream: Response,
  res: StreamableServerResponse,
  maxBytes: number,
  timeoutMs?: number,
): Promise<number> {
  const declaredLength = responseContentLength(upstream.headers);
  if (declaredLength !== null && declaredLength > maxBytes) {
    throw new Error(
      `Upstream response exceeds maximum size of ${maxBytes} bytes`,
    );
  }

  if (!upstream.body) {
    throw new Error("Upstream response did not include a body stream");
  }

  const reader = upstream.body.getReader();
  let totalBytes = 0;
  let streamTimeoutHandle: ReturnType<typeof setTimeout> | null = null;
  const streamTimeoutPromise =
    typeof timeoutMs === "number" && timeoutMs > 0
      ? new Promise<never>((_resolve, reject) => {
          streamTimeoutHandle = setTimeout(() => {
            reject(
              createTimeoutError(
                `Upstream response body timed out after ${timeoutMs}ms`,
              ),
            );
          }, timeoutMs);
        })
      : null;

  try {
    while (true) {
      const { done, value } = streamTimeoutPromise
        ? await Promise.race([reader.read(), streamTimeoutPromise])
        : await reader.read();
      if (done) break;
      if (!value || value.byteLength === 0) continue;

      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        throw new Error(
          `Upstream response exceeds maximum size of ${maxBytes} bytes`,
        );
      }

      if (res.writableEnded || res.destroyed) {
        throw new Error("Client connection closed while streaming response");
      }

      const canContinue = res.write(Buffer.from(value));
      if (!canContinue) {
        await waitForDrain(res);
      }
    }
  } catch (err) {
    try {
      await reader.cancel(err);
    } catch {
      // Best effort cleanup; keep original error.
    }
    throw err;
  } finally {
    if (streamTimeoutHandle !== null) {
      clearTimeout(streamTimeoutHandle);
    }
    reader.releaseLock();
  }

  return totalBytes;
}

/**
 * Read and parse a JSON request body with size limits and error handling.
 * Returns null (and sends a 4xx response) if reading or parsing fails.
 */
async function readJsonBody<T = Record<string, unknown>>(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  options: ReadJsonBodyOptions = {},
): Promise<T | null> {
  return parseJsonBody(req, res, {
    maxBytes: MAX_BODY_BYTES,
    ...options,
  });
}

const readBody = (req: http.IncomingMessage): Promise<string> =>
  readRequestBody(req, { maxBytes: MAX_BODY_BYTES }).then(
    (value) => value ?? "",
  );

let activeTerminalRunCount = 0;

function json(res: http.ServerResponse, data: unknown, status = 200): void {
  sendJson(res, data, status);
}

function error(res: http.ServerResponse, message: string, status = 400): void {
  sendJsonError(res, message, status);
}

// ---------------------------------------------------------------------------
// Static UI serving (production)
// ---------------------------------------------------------------------------

// Serves the built React dashboard from apps/app/dist/ in production mode.

const STATIC_MIME: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".gif": "image/gif",
  ".gz": "application/octet-stream",
  ".glb": "model/gltf-binary",
  ".gltf": "model/gltf+json",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json",
  ".mjs": "application/javascript; charset=utf-8",
  ".mp3": "audio/mpeg",
  ".ogg": "audio/ogg",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ttf": "font/ttf",
  ".txt": "text/plain; charset=utf-8",
  ".vrm": "model/gltf-binary",
  ".wasm": "application/wasm",
  ".wav": "audio/wav",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

/** Resolved UI directory. Lazily computed once on first request. */
let uiDir: string | null | undefined;
let uiIndexHtml: Buffer | null = null;

function resolveUiDir(): string | null {
  if (uiDir !== undefined) return uiDir;
  if (process.env.NODE_ENV !== "production") {
    uiDir = null;
    return null;
  }

  const thisDir = path.dirname(fileURLToPath(import.meta.url));
  const packageRoot = findOwnPackageRoot(thisDir);
  const candidates = [
    path.resolve("apps/app/dist"),
    path.resolve(packageRoot, "apps", "app", "dist"),
  ];

  for (const candidate of candidates) {
    const indexPath = path.join(candidate, "index.html");
    try {
      if (fs.statSync(indexPath).isFile()) {
        uiDir = candidate;
        uiIndexHtml = fs.readFileSync(indexPath);
        logger.info(`[milady-api] Serving dashboard UI from ${candidate}`);
        return uiDir;
      }
    } catch {
      // Candidate not present, keep searching.
    }
  }

  uiDir = null;
  logger.info("[milady-api] No built UI found — dashboard routes are disabled");
  return null;
}

function sendStaticResponse(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  status: number,
  headers: Record<string, string | number>,
  body?: Buffer,
): void {
  res.writeHead(status, headers);
  if (req.method === "HEAD") {
    res.end();
    return;
  }
  res.end(body);
}

// ── Static file cache ─────────────────────────────────────────────────
const STATIC_CACHE_MAX = 50;
const STATIC_CACHE_FILE_LIMIT = 512 * 1024; // 512 KB
const staticFileCache = new Map<string, { body: Buffer; mtimeMs: number }>();

function getCachedFile(filePath: string, mtimeMs: number): Buffer {
  return getOrReadCachedFile(
    staticFileCache,
    filePath,
    mtimeMs,
    (p) => fs.readFileSync(p),
    STATIC_CACHE_MAX,
    STATIC_CACHE_FILE_LIMIT,
  );
}

/**
 * Serve built dashboard assets from apps/app/dist with SPA fallback.
 * Returns true when the request is handled.
 */
export function injectApiBaseIntoHtml(
  html: Buffer,
  externalBase?: string | null,
): Buffer {
  const trimmedBase = externalBase?.trim();
  if (!trimmedBase) return html;

  const headCloseTag = "</head>";
  const headCloseIndex = html.indexOf(headCloseTag);
  if (headCloseIndex < 0) return html;

  const injection = Buffer.from(
    `<script>window.__MILADY_API_BASE__=${JSON.stringify(trimmedBase)};</script>`,
  );

  return Buffer.concat([
    html.subarray(0, headCloseIndex),
    injection,
    html.subarray(headCloseIndex),
  ]);
}

function serveStaticUi(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pathname: string,
): boolean {
  const root = resolveUiDir();
  if (!root) return false;

  // Keep API and WebSocket namespaces exclusively owned by server handlers.
  if (pathname === "/api" || pathname.startsWith("/api/")) return false;
  if (pathname === "/v1" || pathname.startsWith("/v1/")) return false;
  if (pathname === "/ws") return false;

  let decodedPath: string;
  try {
    decodedPath = decodeURIComponent(pathname);
  } catch {
    error(res, "Invalid URL path encoding", 400);
    return true;
  }

  const relativePath = decodedPath.replace(/^\/+/, "");
  const candidatePath = path.resolve(root, relativePath);
  if (
    candidatePath !== root &&
    !candidatePath.startsWith(`${root}${path.sep}`)
  ) {
    error(res, "Forbidden", 403);
    return true;
  }

  try {
    const stat = fs.statSync(candidatePath);
    if (stat.isFile()) {
      const ext = path.extname(candidatePath).toLowerCase();
      const body = getCachedFile(candidatePath, stat.mtimeMs);
      const cacheControl = relativePath.startsWith("assets/")
        ? "public, max-age=31536000, immutable"
        : "public, max-age=0, must-revalidate";
      sendStaticResponse(
        req,
        res,
        200,
        {
          "Cache-Control": cacheControl,
          "Content-Length": body.length,
          "Content-Type": STATIC_MIME[ext] ?? "application/octet-stream",
        },
        body,
      );
      return true;
    }
  } catch {
    // Missing file falls through to SPA index fallback below.
  }

  // Only serve the SPA index.html for navigation-like requests (no file extension
  // or .html). Asset requests (.vrm, .js, .png, etc.) that miss on disk should 404
  // rather than silently returning HTML — which breaks binary loaders like GLTFLoader.
  const reqExt = path.extname(decodedPath).toLowerCase();
  if (reqExt && reqExt !== ".html") return false;

  if (!uiIndexHtml) return false;

  // When served behind a reverse proxy that rewrites the app under a path prefix,
  // inject the
  // API base so the UI client sends requests to the correct path prefix.
  const html = injectApiBaseIntoHtml(
    uiIndexHtml,
    process.env.MILADY_EXTERNAL_BASE_URL,
  );

  sendStaticResponse(
    req,
    res,
    200,
    {
      "Cache-Control": "public, max-age=0, must-revalidate",
      "Content-Length": html.length,
      "Content-Type": "text/html; charset=utf-8",
    },
    html,
  );
  return true;
}

interface ChatGenerationResult {
  text: string;
  agentName: string;
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    model?: string;
  };
}

interface ChatGenerateOptions {
  onChunk?: (chunk: string) => void;
  onSnapshot?: (text: string) => void;
  isAborted?: () => boolean;
  resolveNoResponseText?: () => string;
}

const INSUFFICIENT_CREDITS_CHAT_REPLIES = [
  "Sorry, we're out of credits right now. Please top up your credits and try again.",
  "No model credits left in the tank. Time to top up your credits.",
  "I can't answer on zero credits. Top up your credits and ping me again.",
  "Credit meter is empty. Please top up your credits so I can keep going.",
  "Out of credits, boss. Top up your credits and I am back online.",
] as const;

const GENERIC_NO_RESPONSE_CHAT_REPLY =
  "Sorry, I couldn't generate a response right now. Please try again.";

function getErrorMessage(err: unknown, fallback = "generation failed"): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  return fallback;
}

function pickInsufficientCreditsChatReply(): string {
  const idx = Math.floor(
    Math.random() * INSUFFICIENT_CREDITS_CHAT_REPLIES.length,
  );
  return INSUFFICIENT_CREDITS_CHAT_REPLIES[idx];
}

function findRecentInsufficientCreditsLog(
  logBuffer: LogEntry[],
  lookbackMs = 60_000,
): LogEntry | null {
  const now = Date.now();
  for (let i = logBuffer.length - 1; i >= 0; i--) {
    const entry = logBuffer[i];
    if (now - entry.timestamp > lookbackMs) break;
    if (isInsufficientCreditsMessage(entry.message)) {
      return entry;
    }
  }
  return null;
}

function resolveNoResponseFallback(
  logBuffer: LogEntry[],
  runtime?: AgentRuntime | null,
  lang = "en",
): string {
  if (findRecentInsufficientCreditsLog(logBuffer)) {
    return pickInsufficientCreditsChatReply();
  }
  const characterDefault = runtime
    ? resolveConversationGreetingText(runtime, lang).trim()
    : "";
  if (characterDefault) {
    return characterDefault;
  }
  return GENERIC_NO_RESPONSE_CHAT_REPLY;
}

function getInsufficientCreditsReplyFromError(err: unknown): string | null {
  return isInsufficientCreditsError(err)
    ? pickInsufficientCreditsChatReply()
    : null;
}

const STAGE_DIRECTION_FIRST_WORDS = new Set([
  "beam",
  "beams",
  "beaming",
  "blink",
  "blinks",
  "blinking",
  "blush",
  "blushes",
  "blushing",
  "bow",
  "bows",
  "bowing",
  "breathe",
  "breathes",
  "breathing",
  "cheer",
  "cheers",
  "cheering",
  "chuckle",
  "chuckles",
  "chuckling",
  "clap",
  "claps",
  "clapping",
  "cry",
  "cries",
  "crying",
  "curtsy",
  "curtsies",
  "curtsying",
  "dance",
  "dances",
  "dancing",
  "frown",
  "frowns",
  "frowning",
  "gasp",
  "gasps",
  "gasping",
  "gesture",
  "gestures",
  "gesturing",
  "giggle",
  "giggles",
  "giggling",
  "glance",
  "glances",
  "glancing",
  "grin",
  "grins",
  "grinning",
  "laugh",
  "laughs",
  "laughing",
  "lean",
  "leans",
  "leaning",
  "look",
  "looks",
  "looking",
  "nod",
  "nods",
  "nodding",
  "pause",
  "pauses",
  "pausing",
  "point",
  "points",
  "pointing",
  "pose",
  "poses",
  "posing",
  "pout",
  "pouts",
  "pouting",
  "raise",
  "raises",
  "raising",
  "shrug",
  "shrugs",
  "shrugging",
  "sigh",
  "sighs",
  "sighing",
  "smile",
  "smiles",
  "smiling",
  "smirk",
  "smirks",
  "smirking",
  "spin",
  "spins",
  "spinning",
  "stare",
  "stares",
  "staring",
  "stretch",
  "stretches",
  "stretching",
  "sway",
  "sways",
  "swaying",
  "tilt",
  "tilts",
  "tilting",
  "wave",
  "waves",
  "waving",
  "whisper",
  "whispers",
  "whispering",
  "wink",
  "winks",
  "winking",
  "yawn",
  "yawns",
  "yawning",
]);

function isNoResponsePlaceholder(text: string): boolean {
  const trimmed = text.trim();
  return trimmed.length === 0 || /^\(?no response\)?$/i.test(trimmed);
}

function collapseInlineWhitespace(input: string): string {
  return input.replace(/[ \t]+/g, " ").trim();
}

function looksLikeStageDirection(input: string): boolean {
  const normalized = collapseInlineWhitespace(input)
    .replace(/^[^A-Za-z]+/, "")
    .replace(/[^A-Za-z'-]+$/, "");
  if (!normalized) return false;
  const [firstWord = ""] = normalized.toLowerCase().split(/\s+/, 1);
  return STAGE_DIRECTION_FIRST_WORDS.has(firstWord);
}

function stripWrappedStageDirections(input: string, pattern: RegExp): string {
  return input.replace(
    pattern,
    (match: string, inner: string, offset: number, source: string) => {
      const prev = source[offset - 1] ?? "";
      const next = source[offset + match.length] ?? "";
      const hasSafeLeftBoundary =
        offset === 0 || /[\s([{>"'“‘.!?,;:-]/.test(prev);
      const hasSafeRightBoundary =
        offset + match.length >= source.length ||
        /[\s)\]}<"'”’.!?,;:-]/.test(next);
      if (
        !hasSafeLeftBoundary ||
        !hasSafeRightBoundary ||
        !looksLikeStageDirection(inner)
      ) {
        return match;
      }
      return " ";
    },
  );
}

function tidyAssistantTextSpacing(input: string): string {
  return input
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/ ?([,.;!?])/g, "$1")
    .replace(/\(\s+/g, "(")
    .replace(/\s+\)/g, ")");
}

function stripAssistantStageDirections(input: string): string {
  let normalized = input;
  normalized = stripWrappedStageDirections(normalized, /\*([^*\n]+)\*/g);
  normalized = stripWrappedStageDirections(normalized, /_([^_\n]+)_/g);
  return tidyAssistantTextSpacing(normalized);
}

function isClientVisibleNoResponse(text: string): boolean {
  if (isNoResponsePlaceholder(text)) return true;
  return isNoResponsePlaceholder(stripAssistantStageDirections(text));
}

function normalizeChatResponseText(
  text: string,
  logBuffer: LogEntry[],
  runtime?: AgentRuntime | null,
): string {
  if (!isClientVisibleNoResponse(text)) return text;
  return resolveNoResponseFallback(logBuffer, runtime);
}

function initSse(res: http.ServerResponse): void {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
}

function writeSse(
  res: http.ServerResponse,
  payload: Record<string, string | number | boolean | null | undefined>,
): void {
  if (res.writableEnded || res.destroyed) return;
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function writeChatTokenSse(
  res: http.ServerResponse,
  text: string,
  fullText: string,
): void {
  writeSse(res, { type: "token", text, fullText });
}

function writeSseData(
  res: http.ServerResponse,
  data: string,
  event?: string,
): void {
  if (res.writableEnded || res.destroyed) return;
  if (event) res.write(`event: ${event}\n`);
  res.write(`data: ${data}\n\n`);
}

function writeSseJson(
  res: http.ServerResponse,
  payload: unknown,
  event?: string,
): void {
  writeSseData(res, JSON.stringify(payload), event);
}

async function generateChatResponse(
  runtime: AgentRuntime,
  message: ReturnType<typeof createMessageMemory>,
  agentName: string,
  opts?: ChatGenerateOptions,
): Promise<ChatGenerationResult> {
  type StreamSource = "unset" | "callback" | "onStreamChunk";
  let responseText = "";
  let activeStreamSource: StreamSource = "unset";
  const messageSource =
    typeof message.content.source === "string" &&
    message.content.source.trim().length > 0
      ? message.content.source
      : "api";
  const emitChunk = (chunk: string): void => {
    if (!chunk) return;
    responseText += chunk;
    opts?.onChunk?.(chunk);
  };
  const emitSnapshot = (text: string): void => {
    if (!text) return;
    responseText = text;
    opts?.onSnapshot?.(text);
  };
  const claimStreamSource = (
    source: Exclude<StreamSource, "unset">,
  ): boolean => {
    if (activeStreamSource === "unset") {
      activeStreamSource = source;
      return true;
    }
    return activeStreamSource === source;
  };
  const appendIncomingText = (incoming: string): void => {
    const update = resolveStreamingUpdate(responseText, incoming);
    if (update.kind === "noop") return;
    if (update.kind === "append") {
      emitChunk(update.emittedText);
      return;
    }
    emitSnapshot(update.nextText);
  };

  // The core message service emits MESSAGE_SENT but not MESSAGE_RECEIVED.
  // Emit inbound events here so trajectory/session hooks run for API chat.
  try {
    if (typeof runtime.emitEvent === "function") {
      await runtime.emitEvent("MESSAGE_RECEIVED", {
        message,
        source: messageSource,
      });
    }
  } catch (err) {
    runtime.logger?.warn(
      {
        err,
        src: "milady-api",
        messageId: message.id,
        roomId: message.roomId,
      },
      "Failed to emit MESSAGE_RECEIVED event",
    );
  }

  // Fallback when MESSAGE_RECEIVED hooks are unavailable: start a trajectory
  // directly so /api/chat still produces rows for the Trajectories view.

  let result:
    | Awaited<
        ReturnType<NonNullable<AgentRuntime["messageService"]>["handleMessage"]>
      >
    | undefined;
  let _handlerError: unknown = null;
  try {
    result = await runtime.messageService?.handleMessage(
      runtime,
      message,
      async (content: Content) => {
        if (opts?.isAborted?.()) {
          throw new Error("client_disconnected");
        }

        // Trace action callback invocations so we can verify handlers execute.
        const actionTag = (content as Record<string, unknown>)?.action;
        if (actionTag) {
          runtime.logger?.info(
            {
              src: "milady-api",
              action: actionTag,
              hasText: Boolean(extractCompatTextContent(content)),
            },
            `[milady-api] Action callback fired: ${actionTag}`,
          );
        }

        const chunk = extractCompatTextContent(content);
        if (!chunk) return [];
        if (!claimStreamSource("callback")) return [];
        appendIncomingText(chunk);
        return [];
      },
      {
        onStreamChunk: opts?.onChunk
          ? async (chunk: string) => {
              if (opts?.isAborted?.()) {
                throw new Error("client_disconnected");
              }
              if (!chunk) return;
              if (!claimStreamSource("onStreamChunk")) return;
              appendIncomingText(chunk);
            }
          : undefined,
      },
    );

    // Ensure MESSAGE_SENT hooks run for API chat flows. Some runtimes emit this
    // internally, but API wrappers can bypass those hooks.
    try {
      const responseMessages = Array.isArray(result?.responseMessages)
        ? (result.responseMessages as Array<{ id?: string; content?: Content }>)
        : [];
      if (
        responseMessages.length > 0 &&
        typeof runtime.emitEvent === "function"
      ) {
        for (const responseMessage of responseMessages) {
          const memoryLike = {
            id: responseMessage.id ?? crypto.randomUUID(),
            roomId: message.roomId,
            entityId: runtime.agentId,
            content: responseMessage.content ?? { text: "" },
            metadata: message.metadata,
          } as unknown as ReturnType<typeof createMessageMemory>;
          await runtime.emitEvent("MESSAGE_SENT", {
            message: memoryLike,
            source: messageSource,
          });
        }
      }
    } catch (err) {
      runtime.logger?.warn(
        {
          err,
          src: "milady-api",
          messageId: message.id,
          roomId: message.roomId,
        },
        "Failed to emit MESSAGE_SENT event",
      );
    }
  } catch (err) {
    _handlerError = err;
    throw err;
  }

  // Log the response mode and actions for debugging action execution
  if (result) {
    const rc = result.responseContent as Record<string, unknown> | null;
    const resultRecord = result as unknown as Record<string, unknown>;
    runtime.logger?.info(
      {
        src: "milady-api",
        mode: resultRecord.mode,
        actions: rc?.actions,
        simple: rc?.simple,
        hasText: Boolean(rc?.text),
      },
      "[milady-api] Chat response metadata",
    );
  }

  const resultText = extractCompatTextContent(result?.responseContent);

  // Fallback: if callbacks weren't used for text, stream + return final text.
  if (!responseText && resultText) {
    if (opts?.onSnapshot) {
      emitSnapshot(resultText);
    } else {
      emitChunk(resultText);
    }
  } else if (
    resultText &&
    resultText !== responseText &&
    resultText.startsWith(responseText)
  ) {
    // Keep streaming monotonic when final text extends emitted chunks.
    emitChunk(resultText.slice(responseText.length));
  } else if (resultText && resultText !== responseText) {
    // Canonical final response may differ from streamed chunks (normalization).
    if (opts?.onSnapshot) {
      emitSnapshot(resultText);
    } else {
      responseText = resultText;
    }
  }

  const noResponseFallback = opts?.resolveNoResponseText?.();
  const finalText = isClientVisibleNoResponse(responseText)
    ? (noResponseFallback ?? (responseText || "(no response)"))
    : responseText;

  // Estimate token usage from text lengths (~4 chars per token)
  const promptText = extractCompatTextContent(message.content) ?? "";
  const estPromptTokens = Math.ceil(promptText.length / 4);
  const estCompletionTokens = Math.ceil(finalText.length / 4);

  return {
    text: finalText,
    agentName,
    usage: {
      promptTokens: estPromptTokens,
      completionTokens: estCompletionTokens,
      totalTokens: estPromptTokens + estCompletionTokens,
      model: detectRuntimeModel(runtime, undefined) ?? undefined,
    },
  };
}

async function generateConversationTitle(
  runtime: AgentRuntime,
  userMessage: string,
  agentName: string,
): Promise<string | null> {
  // Use small model for speed
  const modelClass = ModelType.TEXT_SMALL;

  const prompt = `Based on the user's first message in a new chat, generate a very short, concise title (max 4-5 words) for the conversation.
The agent's name is "${agentName}". The title should reflect the topic or intent of the user.
Ideally, the title should fit the persona/vibe of the agent if possible, but clarity is more important.
Do not use quotes. Do not include "Title:" prefix.

User message: "${userMessage}"

Title:`;

  try {
    // Use maxTokens instead of max_tokens
    const title = await runtime.useModel(modelClass, {
      prompt,
      maxTokens: 20,
      temperature: 0.7,
    });

    if (!title) return null;

    let cleanTitle = title.trim();
    // Remove surrounding quotes if present
    if (
      (cleanTitle.startsWith('"') && cleanTitle.endsWith('"')) ||
      (cleanTitle.startsWith("'") && cleanTitle.endsWith("'"))
    ) {
      cleanTitle = cleanTitle.slice(1, -1);
    }

    // Fallback if empty or too long
    if (!cleanTitle || cleanTitle.length > 50) return null;

    return cleanTitle;
  } catch (err) {
    logger.warn(
      `[milady] Failed to generate conversation title: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}

function isDuplicateMemoryError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message.toLowerCase();
  return (
    msg.includes("duplicate") ||
    msg.includes("already exists") ||
    msg.includes("unique constraint")
  );
}

async function persistConversationMemory(
  runtime: AgentRuntime,
  memory: ReturnType<typeof createMessageMemory>,
): Promise<void> {
  try {
    await runtime.createMemory(memory, "messages");
  } catch (err) {
    if (isDuplicateMemoryError(err)) return;
    throw err;
  }
}

async function hasRecentAssistantMemory(
  runtime: AgentRuntime,
  roomId: UUID,
  text: string,
  sinceMs: number,
): Promise<boolean> {
  const trimmed = text.trim();
  if (!trimmed) return false;

  try {
    const recent = await runtime.getMemories({
      roomId,
      tableName: "messages",
      count: 12,
    });

    return recent.some((memory) => {
      const contentText = (memory.content as { text?: string })?.text?.trim();
      const createdAt = memory.createdAt ?? 0;
      return (
        memory.entityId === runtime.agentId &&
        contentText === trimmed &&
        createdAt >= sinceMs - 2000
      );
    });
  } catch {
    return false;
  }
}

async function persistAssistantConversationMemory(
  runtime: AgentRuntime,
  roomId: UUID,
  text: string,
  channelType: ChannelType,
  dedupeSinceMs?: number,
): Promise<void> {
  const trimmed = text.trim();
  if (!trimmed) return;

  if (typeof dedupeSinceMs === "number") {
    const alreadyPersisted = await hasRecentAssistantMemory(
      runtime,
      roomId,
      trimmed,
      dedupeSinceMs,
    );
    if (alreadyPersisted) return;
  }

  await persistConversationMemory(
    runtime,
    createMessageMemory({
      id: crypto.randomUUID() as UUID,
      entityId: runtime.agentId,
      agentId: runtime.agentId,
      roomId,
      content: {
        text: trimmed,
        source: "client_chat",
        channelType,
      },
    }),
  );
}

const VALID_CHANNEL_TYPES = new Set<string>(Object.values(ChannelType));
const VALID_CONVERSATION_MODES = new Set(["simple", "power"]);

function parseRequestChannelType(
  value: unknown,
  fallback: ChannelType = ChannelType.DM,
): ChannelType | null {
  if (value === undefined || value === null) {
    return fallback;
  }
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim().toUpperCase();
  if (!VALID_CHANNEL_TYPES.has(normalized)) {
    return null;
  }
  return normalized as ChannelType;
}

function parseConversationMode(
  value: unknown,
): "simple" | "power" | undefined | null {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim().toLowerCase();
  if (!VALID_CONVERSATION_MODES.has(normalized)) {
    return null;
  }
  return normalized as "simple" | "power";
}

interface ChatImageAttachment {
  /** Base64-encoded image data (no data URL prefix). */
  data: string;
  mimeType: string;
  name: string;
}

const MAX_CHAT_IMAGES = 4;

/** Maximum base64 data length for a single image (~3.75 MB binary). */
const MAX_IMAGE_DATA_BYTES = 5 * 1_048_576;

/** Maximum length of an image filename. */
const MAX_IMAGE_NAME_LENGTH = 255;

/** Matches a valid standard-alphabet base64 string (RFC 4648 §4, `+/`, optional `=` padding). */
const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

const ALLOWED_IMAGE_MIME_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
]);

export const IMAGE_ONLY_CHAT_FALLBACK_PROMPT =
  "Please describe the attached image.";

/** Returns an error message string, or null if valid. Exported for unit tests. */
export function validateChatImages(images: unknown): string | null {
  if (!Array.isArray(images) || images.length === 0) return null;
  if (images.length > MAX_CHAT_IMAGES)
    return `Too many images (max ${MAX_CHAT_IMAGES})`;
  for (const img of images) {
    if (!img || typeof img !== "object") return "Each image must be an object";
    const { data, mimeType, name } = img as Record<string, unknown>;
    if (typeof data !== "string" || !data)
      return "Each image must have a non-empty data string";
    if (data.startsWith("data:"))
      return "Image data must be raw base64, not a data URL";
    if (data.length > MAX_IMAGE_DATA_BYTES)
      return `Image too large (max ${MAX_IMAGE_DATA_BYTES / 1_048_576} MB per image)`;
    if (!BASE64_RE.test(data))
      return "Image data contains invalid base64 characters";
    if (typeof mimeType !== "string" || !mimeType)
      return "Each image must have a mimeType string";
    if (!ALLOWED_IMAGE_MIME_TYPES.has(mimeType.toLowerCase()))
      return `Unsupported image type: ${mimeType}`;
    if (typeof name !== "string" || !name)
      return "Each image must have a name string";
    if (name.length > MAX_IMAGE_NAME_LENGTH)
      return `Image name too long (max ${MAX_IMAGE_NAME_LENGTH} characters)`;
  }
  return null;
}

/**
 * Extension of the core Media attachment shape that carries raw image bytes for
 * action handlers (e.g. POST_TWEET) while the message is in-memory. The
 * extra fields are intentionally stripped before the message is persisted.
 *
 * Note: `_data`/`_mimeType` survive only because elizaOS passes the
 * `userMessage` object reference directly to action handlers without
 * deep-cloning or serializing it. If that ever changes, action handlers
 * that read these fields will silently receive `undefined`.
 */
export interface ChatAttachmentWithData extends Media {
  /** Raw base64 image data — never written to the database. */
  _data: string;
  /** MIME type corresponding to `_data`. */
  _mimeType: string;
}

/**
 * Builds in-memory and compact (DB-persisted) attachment arrays from
 * validated images. Exported so it can be unit-tested independently.
 */
export function buildChatAttachments(
  images: ChatImageAttachment[] | undefined,
): {
  /** In-memory attachments that include `_data`/`_mimeType` for action handlers. */
  attachments: ChatAttachmentWithData[] | undefined;
  /** Persistence-safe attachments with `_data`/`_mimeType` stripped. */
  compactAttachments: Media[] | undefined;
} {
  if (!images?.length)
    return { attachments: undefined, compactAttachments: undefined };
  // Compact placeholder URL (no base64) keeps the LLM context lean. The raw
  // image bytes are stashed in `_data`/`_mimeType` for action handlers (e.g.
  // POST_TWEET) that need to upload them.
  const attachments: ChatAttachmentWithData[] = images.map((img, i) => ({
    id: `img-${i}`,
    url: `attachment:img-${i}`,
    title: img.name,
    source: "client_chat",
    description: "User-attached image",
    text: "",
    contentType: ContentType.IMAGE,
    _data: img.data,
    _mimeType: img.mimeType,
  }));
  // DB-persisted version omits _data/_mimeType so raw bytes aren't stored.
  const compactAttachments: Media[] = attachments.map(
    ({ _data: _d, _mimeType: _m, ...rest }) => rest,
  );
  return { attachments, compactAttachments };
}

export function normalizeIncomingChatPrompt(
  text: string | null | undefined,
  images: ChatImageAttachment[] | null | undefined,
): string | null {
  const normalizedText = typeof text === "string" ? text.trim() : "";
  if (normalizedText.length > 0) {
    return normalizedText;
  }
  return Array.isArray(images) && images.length > 0
    ? IMAGE_ONLY_CHAT_FALLBACK_PROMPT
    : null;
}

type MessageMemory = ReturnType<typeof createMessageMemory>;

/**
 * Constructs the in-memory user message (with image data for action handlers)
 * and the persistence-safe counterpart (image data stripped). Extracted to
 * avoid duplicating this logic across the stream and non-stream chat endpoints.
 */
export function buildUserMessages(params: {
  images: ChatImageAttachment[] | undefined;
  prompt: string;
  userId: UUID;
  agentId: UUID;
  roomId: UUID;
  channelType: ChannelType;
  conversationMode?: "simple" | "power";
}): { userMessage: MessageMemory; messageToStore: MessageMemory } {
  const {
    images,
    prompt,
    userId,
    agentId,
    roomId,
    channelType,
    conversationMode,
  } = params;
  const { attachments, compactAttachments } = buildChatAttachments(images);
  const id = crypto.randomUUID() as UUID;
  // In-memory message carries _data/_mimeType so action handlers can upload.
  const userMessage = createMessageMemory({
    id,
    entityId: userId,
    agentId,
    roomId,
    content: {
      text: prompt,
      source: "client_chat",
      channelType,
      ...(conversationMode ? { conversationMode } : {}),
      ...(attachments?.length ? { attachments } : {}),
    },
  });
  // Persisted message: compact placeholder URL, no raw bytes in DB.
  const messageToStore = compactAttachments?.length
    ? createMessageMemory({
        id,
        entityId: userId,
        agentId,
        roomId,
        content: {
          text: prompt,
          source: "client_chat",
          channelType,
          ...(conversationMode ? { conversationMode } : {}),
          attachments: compactAttachments,
        },
      })
    : userMessage;
  return { userMessage, messageToStore };
}

async function readChatRequestPayload(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  helpers: {
    readJsonBody: <T = Record<string, unknown>>(
      req: http.IncomingMessage,
      res: http.ServerResponse,
      options?: ReadJsonBodyOptions,
    ) => Promise<T | null>;
    error: (res: http.ServerResponse, message: string, status?: number) => void;
  },
  /** Body size limit. Image-capable endpoints pass CHAT_MAX_BODY_BYTES (20 MB);
   *  legacy/cloud-proxy endpoints that don't process images pass MAX_BODY_BYTES (1 MB). */
  maxBytes = CHAT_MAX_BODY_BYTES,
): Promise<{
  prompt: string;
  channelType: ChannelType;
  images?: ChatImageAttachment[];
  conversationMode?: "simple" | "power";
} | null> {
  const body = await helpers.readJsonBody<{
    text?: string;
    channelType?: string;
    images?: ChatImageAttachment[];
    conversationMode?: string;
  }>(req, res, { maxBytes });
  if (!body) return null;
  const normalizedPrompt = normalizeIncomingChatPrompt(body.text, body.images);
  if (!normalizedPrompt) {
    helpers.error(res, "text is required");
    return null;
  }
  const channelType = parseRequestChannelType(body.channelType, ChannelType.DM);
  if (!channelType) {
    helpers.error(res, "channelType is invalid", 400);
    return null;
  }
  const conversationMode = parseConversationMode(body.conversationMode);
  if (conversationMode === null) {
    helpers.error(res, "conversationMode is invalid", 400);
    return null;
  }
  const imageValidationError = validateChatImages(body.images);
  if (imageValidationError) {
    helpers.error(res, imageValidationError, 400);
    return null;
  }
  // Normalize mimeType to lowercase so downstream consumers (Twitter
  // uploadMedia, content-type headers) never encounter mixed-case variants
  // that slipped past the allowlist check.
  const images = Array.isArray(body.images)
    ? (body.images as ChatImageAttachment[]).map((img) => ({
        ...img,
        mimeType: img.mimeType.toLowerCase(),
      }))
    : undefined;
  return {
    prompt: normalizedPrompt,
    channelType,
    images,
    ...(conversationMode ? { conversationMode } : {}),
  };
}

function parseBoundedLimit(rawLimit: string | null, fallback = 15): number {
  return parseClampedInteger(rawLimit, {
    min: 1,
    max: 50,
    fallback,
  });
}

// ---------------------------------------------------------------------------
// Config redaction
// ---------------------------------------------------------------------------

/**
 * Key patterns that indicate a value is sensitive and must be redacted.
 * Matches against the property key at unknown nesting depth.  Aligned with
 * SENSITIVE_PATTERNS in src/config/schema.ts so every field the UI marks
 * as sensitive is also redacted in the API response.
 *
 * RESIDUAL RISK: Key-based redaction is heuristic — secrets stored under
 * generic keys (e.g. "value", "data", "config") will not be caught.  A
 * stronger approach would be either (a) schema-level `sensitive: true`
 * annotations that drive redaction, or (b) an allowlist that only exposes
 * known-safe fields and strips everything else.  Both require deeper
 * changes to the config schema infrastructure.
 */
const SENSITIVE_KEY_RE =
  /password|secret|api.?key|private.?key|seed.?phrase|authorization|connection.?string|credential|(?<!max)tokens?$/i;

function isBlockedObjectKey(key: string): boolean {
  return (
    key === "__proto__" ||
    key === "constructor" ||
    key === "prototype" ||
    // Block config include directives — if an API caller embeds "$include"
    // inside a config patch, the next loadElizaConfig() → resolveConfigIncludes
    // pass would read arbitrary local files and merge them into the config.
    key === "$include"
  );
}

function hasBlockedObjectKeyDeep(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (Array.isArray(value)) return value.some(hasBlockedObjectKeyDeep);
  if (typeof value !== "object") return false;

  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (isBlockedObjectKey(key)) return true;
    if (hasBlockedObjectKeyDeep(child)) return true;
  }
  return false;
}

export function cloneWithoutBlockedObjectKeys<T>(value: T): T {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) {
    return value.map((item) => cloneWithoutBlockedObjectKeys(item)) as T;
  }
  if (typeof value !== "object") return value;

  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (isBlockedObjectKey(key)) continue;
    out[key] = cloneWithoutBlockedObjectKeys(child);
  }
  return out as T;
}

/**
 * Replace unknown non-empty value with "[REDACTED]".  For arrays, each string
 * element is individually redacted; for objects, all string leaves are
 * redacted.  Non-string primitives (booleans, numbers) are replaced with
 * the string "[REDACTED]" to avoid leaking e.g. numeric PINs.
 */
function redactValue(val: unknown): unknown {
  if (val === null || val === undefined) return val;
  if (typeof val === "string") return val.length > 0 ? "[REDACTED]" : "";
  if (typeof val === "number" || typeof val === "boolean") return "[REDACTED]";
  if (Array.isArray(val)) return val.map(redactValue);
  if (typeof val === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(val as Record<string, unknown>)) {
      out[k] = redactValue(v);
    }
    return out;
  }
  return "[REDACTED]";
}

/**
 * Recursively walk a JSON-safe value.  For every object property whose key
 * matches SENSITIVE_KEY_RE, redact the **entire value** regardless of type
 * (string, array, nested object).  This prevents leaks when secrets are
 * stored as arrays (e.g. `apiKeys: ["sk-1","sk-2"]`) or objects.
 * Returns a deep copy — the original is never mutated.
 */
function redactDeep(val: unknown): unknown {
  if (val === null || val === undefined) return val;
  if (Array.isArray(val)) return val.map(redactDeep);
  if (typeof val === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(val as Record<string, unknown>)) {
      if (SENSITIVE_KEY_RE.test(key)) {
        out[key] = redactValue(child);
      } else {
        out[key] = redactDeep(child);
      }
    }
    return out;
  }
  return val;
}

/**
 * Return a deep copy of the config with every sensitive value replaced by
 * "[REDACTED]".  Uses a recursive walk so that ANY future config field
 * whose key matches the sensitive pattern is automatically covered —
 * no manual enumeration required.
 */
function redactConfigSecrets(
  config: Record<string, unknown>,
): Record<string, unknown> {
  return redactDeep(config) as Record<string, unknown>;
}

function isRedactedSecretValue(value: unknown): boolean {
  return (
    typeof value === "string" && value.trim().toUpperCase() === "[REDACTED]"
  );
}

// ---------------------------------------------------------------------------
// Skill-ID path-traversal guard
// ---------------------------------------------------------------------------

/**
 * Validate that a user-supplied skill ID is safe to use in filesystem paths.
 * Rejects IDs containing path separators, ".." sequences, or unknown characters
 * outside the safe set used by the marketplace (`safeName()` in
 * skill-marketplace.ts).  Returns `null` and sends a 400 response if the
 * ID is invalid.
 */
const SAFE_SKILL_ID_RE = /^[a-zA-Z0-9._-]+$/;

function validateSkillId(
  skillId: string,
  res: http.ServerResponse,
): string | null {
  if (
    !skillId ||
    !SAFE_SKILL_ID_RE.test(skillId) ||
    skillId === "." ||
    skillId.includes("..")
  ) {
    const safeDisplay = skillId.slice(0, 80).replace(/[^\x20-\x7e]/g, "?");
    error(res, `Invalid skill ID: "${safeDisplay}"`, 400);
    return null;
  }
  return skillId;
}

const ALLOWED_MCP_CONFIG_TYPES = new Set([
  "stdio",
  "http",
  "streamable-http",
  "sse",
]);

const ALLOWED_MCP_COMMANDS = new Set([
  "npx",
  "node",
  "bun",
  "bunx",
  "deno",
  "python",
  "python3",
  "uvx",
  "uv",
  "docker",
  "podman",
]);

const BLOCKED_MCP_ENV_KEYS = new Set([
  "LD_PRELOAD",
  "LD_LIBRARY_PATH",
  "DYLD_INSERT_LIBRARIES",
  "DYLD_LIBRARY_PATH",
  "NODE_OPTIONS",
  "NODE_EXTRA_CA_CERTS",
  "NODE_TLS_REJECT_UNAUTHORIZED",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
  "NODE_PATH",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "CURL_CA_BUNDLE",
  "PATH",
  "HOME",
  "SHELL",
]);

const INTERPRETER_MCP_COMMANDS = new Set([
  "node",
  "bun",
  "deno",
  "python",
  "python3",
  "uv",
]);

const PACKAGE_RUNNER_MCP_COMMANDS = new Set(["npx", "bunx", "uvx"]);
const CONTAINER_MCP_COMMANDS = new Set(["docker", "podman"]);

const BLOCKED_INTERPRETER_FLAGS = new Set([
  "-e",
  "--eval",
  "-p",
  "--print",
  "-r",
  "--require",
  "--import",
  "--loader",
  "--experimental-loader",
  "--preload",
  "-c",
  "-m",
  // V8 inspector — opens an unauthenticated debug port (default 9229) that
  // allows arbitrary code execution via Chrome DevTools Protocol.  If bound
  // to 0.0.0.0, any network peer can connect → RCE without any token.
  "--inspect",
  "--inspect-brk",
  "--inspect-wait",
  "--inspect-port",
  "--inspect-publish-uid",
  // Policy / diagnostics file access
  "--experimental-policy",
  "--diagnostic-dir",
]);

const BLOCKED_PACKAGE_RUNNER_FLAGS = new Set(["-c", "--call", "-e", "--eval"]);
const BLOCKED_CONTAINER_FLAGS = new Set([
  "--privileged",
  "-v",
  "--volume",
  "--mount",
  "--cap-add",
  "--security-opt",
  "--pid",
  "--network",
  "--device",
  "--ipc",
  "--uts",
  "--userns",
  "--cgroupns",
]);
const BLOCKED_DENO_SUBCOMMANDS = new Set(["eval"]);
const BLOCKED_MCP_REMOTE_HOST_LITERALS = new Set([
  "localhost",
  "metadata.google.internal",
]);

function normalizeMcpCommand(command: string): string {
  const baseName = command.replace(/\\/g, "/").split("/").pop() ?? "";
  return baseName.replace(/\.(exe|cmd|bat)$/i, "").toLowerCase();
}

function hasBlockedFlag(
  args: string[],
  blockedFlags: ReadonlySet<string>,
): string | null {
  for (const arg of args) {
    const trimmed = arg.trim();
    for (const flag of blockedFlags) {
      if (trimmed === flag || trimmed.startsWith(`${flag}=`)) {
        return flag;
      }
      // Block attached short-option forms like -cpayload or -epayload.
      if (
        /^-[A-Za-z]$/.test(flag) &&
        trimmed.startsWith(flag) &&
        trimmed.length > flag.length
      ) {
        return flag;
      }
    }
  }
  return null;
}

function firstPositionalArg(args: string[]): string | null {
  for (const arg of args) {
    const trimmed = arg.trim();
    if (!trimmed || trimmed === "--" || trimmed.startsWith("-")) continue;
    return trimmed.toLowerCase();
  }
  return null;
}

async function resolveMcpRemoteUrlRejection(
  rawUrl: string,
): Promise<string | null> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return "URL must be a valid absolute URL";
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return "URL must use http:// or https://";
  }

  const hostname = normalizeHostLike(parsed.hostname);
  if (!hostname) return "URL hostname is required";

  if (
    BLOCKED_MCP_REMOTE_HOST_LITERALS.has(hostname) ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local")
  ) {
    return `URL host "${hostname}" is blocked for security reasons`;
  }

  if (net.isIP(hostname)) {
    if (isBlockedPrivateOrLinkLocalIp(hostname)) {
      return `URL host "${hostname}" is blocked for security reasons`;
    }
    return null;
  }

  let addresses: Array<{ address: string }>;
  try {
    const resolved = await dnsLookup(hostname, { all: true });
    addresses = Array.isArray(resolved) ? resolved : [resolved];
  } catch {
    return `Could not resolve URL host "${hostname}"`;
  }

  if (addresses.length === 0) {
    return `Could not resolve URL host "${hostname}"`;
  }

  for (const entry of addresses) {
    if (isBlockedPrivateOrLinkLocalIp(entry.address)) {
      return `URL host "${hostname}" resolves to blocked address ${entry.address}`;
    }
  }

  return null;
}

export async function validateMcpServerConfig(
  config: Record<string, unknown>,
): Promise<string | null> {
  const configType = config.type;
  if (
    typeof configType !== "string" ||
    !ALLOWED_MCP_CONFIG_TYPES.has(configType)
  ) {
    return `Invalid config type. Must be one of: ${[...ALLOWED_MCP_CONFIG_TYPES].join(", ")}`;
  }

  if (configType === "stdio") {
    const command =
      typeof config.command === "string" ? config.command.trim() : "";
    if (!command) {
      return "Command is required for stdio servers";
    }
    if (!/^[A-Za-z0-9._-]+$/.test(command)) {
      return "Command must be a bare executable name without path separators";
    }

    const normalizedCommand = normalizeMcpCommand(command);
    if (!ALLOWED_MCP_COMMANDS.has(normalizedCommand)) {
      return (
        `Command "${command}" is not allowed. ` +
        `Allowed commands: ${[...ALLOWED_MCP_COMMANDS].join(", ")}`
      );
    }

    if (config.args !== undefined) {
      if (!Array.isArray(config.args)) {
        return "args must be an array of strings";
      }
      for (const arg of config.args) {
        if (typeof arg !== "string") {
          return "Each arg must be a string";
        }
      }
      const args = config.args as string[];
      if (INTERPRETER_MCP_COMMANDS.has(normalizedCommand)) {
        const blocked = hasBlockedFlag(args, BLOCKED_INTERPRETER_FLAGS);
        if (blocked) {
          return `Flag "${blocked}" is not allowed for ${normalizedCommand} MCP servers`;
        }
      }
      if (PACKAGE_RUNNER_MCP_COMMANDS.has(normalizedCommand)) {
        const blocked = hasBlockedFlag(args, BLOCKED_PACKAGE_RUNNER_FLAGS);
        if (blocked) {
          return `Flag "${blocked}" is not allowed for ${normalizedCommand} MCP servers`;
        }
      }
      if (CONTAINER_MCP_COMMANDS.has(normalizedCommand)) {
        const blocked = hasBlockedFlag(args, BLOCKED_CONTAINER_FLAGS);
        if (blocked) {
          return `Flag "${blocked}" is not allowed for ${normalizedCommand} MCP servers`;
        }
      }
      if (normalizedCommand === "deno") {
        const subcommand = firstPositionalArg(args);
        if (subcommand && BLOCKED_DENO_SUBCOMMANDS.has(subcommand)) {
          return `Subcommand "${subcommand}" is not allowed for deno MCP servers`;
        }
      }
    }
  } else {
    const url = typeof config.url === "string" ? config.url.trim() : "";
    if (!url) {
      return "URL is required for remote servers";
    }
    const urlRejection = await resolveMcpRemoteUrlRejection(url);
    if (urlRejection) return urlRejection;
  }

  if (config.env !== undefined) {
    if (
      typeof config.env !== "object" ||
      config.env === null ||
      Array.isArray(config.env)
    ) {
      return "env must be a plain object of string key-value pairs";
    }

    for (const [key, value] of Object.entries(config.env)) {
      if (isBlockedObjectKey(key)) {
        return `env key "${key}" is blocked for security reasons`;
      }
      if (typeof value !== "string") {
        return `env.${key} must be a string`;
      }
      if (BLOCKED_MCP_ENV_KEYS.has(key.toUpperCase())) {
        return `env variable "${key}" is not allowed for security reasons`;
      }
    }
  }

  if (config.cwd !== undefined && typeof config.cwd !== "string") {
    return "cwd must be a string";
  }

  if (config.timeoutInMillis !== undefined) {
    if (
      typeof config.timeoutInMillis !== "number" ||
      !Number.isFinite(config.timeoutInMillis) ||
      config.timeoutInMillis < 0
    ) {
      return "timeoutInMillis must be a non-negative number";
    }
  }

  return null;
}

export async function resolveMcpServersRejection(
  servers: Record<string, unknown>,
): Promise<string | null> {
  for (const [serverName, serverConfig] of Object.entries(servers)) {
    if (isBlockedObjectKey(serverName)) {
      return `Invalid server name: "${serverName}"`;
    }
    if (
      !serverConfig ||
      typeof serverConfig !== "object" ||
      Array.isArray(serverConfig)
    ) {
      return `Server "${serverName}" config must be a JSON object`;
    }
    if (hasBlockedObjectKeyDeep(serverConfig)) {
      return `Server "${serverName}" contains blocked object keys`;
    }
    const configError = await validateMcpServerConfig(
      serverConfig as Record<string, unknown>,
    );
    if (configError) {
      return `Server "${serverName}": ${configError}`;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Onboarding helpers
// ---------------------------------------------------------------------------

// Use shared presets for full parity between CLI and GUI onboarding.
import { STYLE_PRESETS } from "../onboarding-presets";

import { pickRandomNames } from "../runtime/onboarding-names";

function getProviderOptions(): Array<{
  id: string;
  name: string;
  envKey: string | null;
  pluginName: string;
  keyPrefix: string | null;
  description: string;
}> {
  return [
    {
      id: "elizacloud",
      name: "Eliza Cloud",
      envKey: null,
      pluginName: "@elizaos/plugin-elizacloud",
      keyPrefix: null,
      description:
        "Managed hosting for Eliza agents and bundled infrastructure.",
    },
    {
      id: "anthropic-subscription",
      name: "Anthropic Subscription",
      envKey: null,
      pluginName: "@elizaos/plugin-anthropic",
      keyPrefix: null,
      description:
        "Use your $20-200/mo Claude subscription via OAuth or setup token.",
    },
    {
      id: "openai-subscription",
      name: "OpenAI Subscription",
      envKey: null,
      pluginName: "@elizaos/plugin-openai",
      keyPrefix: null,
      description: "Use your $20-200/mo ChatGPT subscription via OAuth.",
    },
    {
      id: "pi-ai",
      name: "Pi Credentials (pi-ai)",
      envKey: null,
      pluginName: "@elizaos/plugin-pi-ai",
      keyPrefix: null,
      description:
        "Use credentials from ~/.pi/agent/auth.json (API keys or OAuth).",
    },
    {
      id: "anthropic",
      name: "Anthropic (API Key)",
      envKey: "ANTHROPIC_API_KEY",
      pluginName: "@elizaos/plugin-anthropic",
      keyPrefix: "sk-ant-",
      description: "Claude models via API key.",
    },
    {
      id: "openai",
      name: "OpenAI (API Key)",
      envKey: "OPENAI_API_KEY",
      pluginName: "@elizaos/plugin-openai",
      keyPrefix: "sk-",
      description: "GPT models via API key.",
    },
    {
      id: "openrouter",
      name: "OpenRouter",
      envKey: "OPENROUTER_API_KEY",
      pluginName: "@elizaos/plugin-openrouter",
      keyPrefix: "sk-or-",
      description: "Access multiple models via one API key.",
    },
    {
      id: "gemini",
      name: "Gemini",
      envKey: "GOOGLE_GENERATIVE_AI_API_KEY",
      pluginName: "@elizaos/plugin-google-genai",
      keyPrefix: null,
      description: "Google's Gemini models.",
    },
    {
      id: "grok",
      name: "Grok",
      envKey: "XAI_API_KEY",
      pluginName: "@elizaos/plugin-xai",
      keyPrefix: "xai-",
      description: "xAI's Grok models.",
    },
    {
      id: "groq",
      name: "Groq",
      envKey: "GROQ_API_KEY",
      pluginName: "@elizaos/plugin-groq",
      keyPrefix: "gsk_",
      description: "Fast inference.",
    },
    {
      id: "deepseek",
      name: "DeepSeek",
      envKey: "DEEPSEEK_API_KEY",
      pluginName: "@elizaos/plugin-deepseek",
      keyPrefix: "sk-",
      description: "DeepSeek models.",
    },
    {
      id: "mistral",
      name: "Mistral",
      envKey: "MISTRAL_API_KEY",
      pluginName: "@elizaos/plugin-mistral",
      keyPrefix: null,
      description: "Mistral AI models.",
    },
    {
      id: "together",
      name: "Together AI",
      envKey: "TOGETHER_API_KEY",
      pluginName: "@elizaos/plugin-together",
      keyPrefix: null,
      description: "Open-source model hosting.",
    },
    {
      id: "ollama",
      name: "Ollama (local)",
      envKey: null,
      pluginName: "@elizaos/plugin-ollama",
      keyPrefix: null,
      description: "Local models, no API key needed.",
    },
    {
      id: "zai",
      name: "z.ai (GLM Coding Plan)",
      envKey: "ZAI_API_KEY",
      pluginName: "@homunculuslabs/plugin-zai",
      keyPrefix: null,
      description: "GLM models via z.ai Coding Plan.",
    },
  ];
}

function getCloudProviderOptions(): Array<{
  id: string;
  name: string;
  description: string;
}> {
  return [
    {
      id: "elizacloud",
      name: "Eliza Cloud",
      description:
        "Managed cloud infrastructure. Wallets, LLMs, and RPCs included.",
    },
  ];
}

function getModelOptions(): {
  small: Array<{
    id: string;
    name: string;
    provider: string;
    description: string;
  }>;
  large: Array<{
    id: string;
    name: string;
    provider: string;
    description: string;
  }>;
} {
  // All models available via Eliza Cloud (Vercel AI Gateway).
  // IDs use "provider/model" format to match the cloud API routing.
  return {
    small: [
      // OpenAI
      {
        id: "openai/gpt-5-mini",
        name: "GPT-5 Mini",
        provider: "OpenAI",
        description: "Fast and affordable.",
      },
      {
        id: "openai/gpt-4o-mini",
        name: "GPT-4o Mini",
        provider: "OpenAI",
        description: "Compact multimodal model.",
      },
      // Anthropic
      {
        id: "anthropic/claude-sonnet-4",
        name: "Claude Sonnet 4",
        provider: "Anthropic",
        description: "Balanced speed and capability.",
      },
      // Google
      {
        id: "google/gemini-2.5-flash-lite",
        name: "Gemini 2.5 Flash Lite",
        provider: "Google",
        description: "Fastest option.",
      },
      {
        id: "google/gemini-2.5-flash",
        name: "Gemini 2.5 Flash",
        provider: "Google",
        description: "Fast and smart.",
      },
      {
        id: "google/gemini-2.0-flash",
        name: "Gemini 2.0 Flash",
        provider: "Google",
        description: "Multimodal flash model.",
      },
      // Moonshot AI
      {
        id: "moonshotai/kimi-k2-turbo",
        name: "Kimi K2 Turbo",
        provider: "Moonshot AI",
        description: "Extra speed.",
      },
      // DeepSeek
      {
        id: "deepseek/deepseek-v3.2-exp",
        name: "DeepSeek V3.2",
        provider: "DeepSeek",
        description: "Open and powerful.",
      },
    ],
    large: [
      // Anthropic
      {
        id: "anthropic/claude-sonnet-4.5",
        name: "Claude Sonnet 4.5",
        provider: "Anthropic",
        description: "Newest Claude. Excellent reasoning.",
      },
      {
        id: "anthropic/claude-opus-4.5",
        name: "Claude Opus 4.5",
        provider: "Anthropic",
        description: "Most capable Claude model.",
      },
      {
        id: "anthropic/claude-opus-4.1",
        name: "Claude Opus 4.1",
        provider: "Anthropic",
        description: "Deep reasoning powerhouse.",
      },
      {
        id: "anthropic/claude-sonnet-4",
        name: "Claude Sonnet 4",
        provider: "Anthropic",
        description: "Balanced performance.",
      },
      // OpenAI
      {
        id: "openai/gpt-5",
        name: "GPT-5",
        provider: "OpenAI",
        description: "Most capable OpenAI model.",
      },
      {
        id: "openai/gpt-4o",
        name: "GPT-4o",
        provider: "OpenAI",
        description: "Flagship multimodal model.",
      },
      // Google
      {
        id: "google/gemini-3-pro-preview",
        name: "Gemini 3 Pro Preview",
        provider: "Google",
        description: "Advanced reasoning.",
      },
      {
        id: "google/gemini-2.5-pro",
        name: "Gemini 2.5 Pro",
        provider: "Google",
        description: "Strong multimodal reasoning.",
      },
      // Moonshot AI
      {
        id: "moonshotai/kimi-k2-0905",
        name: "Kimi K2",
        provider: "Moonshot AI",
        description: "Fast and capable.",
      },
      // DeepSeek
      {
        id: "deepseek/deepseek-r1",
        name: "DeepSeek R1",
        provider: "DeepSeek",
        description: "Reasoning model.",
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Dynamic model catalog — per-provider cache, fetch, and serve model lists
// ---------------------------------------------------------------------------

type ModelCategory = "chat" | "embedding" | "image" | "tts" | "stt" | "other";

interface CachedModel {
  id: string;
  name: string;
  category: ModelCategory;
}

interface ProviderCache {
  version: 1;
  providerId: string;
  fetchedAt: string;
  models: CachedModel[];
}

function classifyModel(modelId: string): ModelCategory {
  const id = modelId.toLowerCase();
  if (id.includes("embed") || id.includes("text-embedding")) return "embedding";
  if (
    id.includes("dall-e") ||
    id.includes("dalle") ||
    id.includes("imagen") ||
    id.includes("stable-diffusion") ||
    id.includes("midjourney") ||
    id.includes("flux")
  )
    return "image";
  if (
    id.includes("tts") ||
    id.includes("text-to-speech") ||
    id.includes("eleven_")
  )
    return "tts";
  if (id.includes("whisper") || id.includes("stt") || id.includes("transcrib"))
    return "stt";
  if (
    id.includes("moderation") ||
    id.includes("guard") ||
    id.includes("safety")
  )
    return "other";
  return "chat";
}

/** Map param key → expected model category */
function paramKeyToCategory(paramKey: string): ModelCategory {
  const k = paramKey.toUpperCase();
  if (k.includes("EMBEDDING")) return "embedding";
  if (k.includes("IMAGE")) return "image";
  if (k.includes("TTS")) return "tts";
  if (k.includes("STT") || k.includes("TRANSCRIPTION")) return "stt";
  return "chat";
}

const MODELS_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

const PROVIDER_ENV_KEYS: Record<
  string,
  { envKey: string; altEnvKeys?: string[]; baseUrl?: string }
> = {
  anthropic: { envKey: "ANTHROPIC_API_KEY" },
  openai: { envKey: "OPENAI_API_KEY" },
  groq: { envKey: "GROQ_API_KEY", baseUrl: "https://api.groq.com/openai/v1" },
  xai: { envKey: "XAI_API_KEY", baseUrl: "https://api.x.ai/v1" },
  openrouter: {
    envKey: "OPENROUTER_API_KEY",
    baseUrl: "https://openrouter.ai/api/v1",
  },
  "google-genai": {
    envKey: "GOOGLE_GENERATIVE_AI_API_KEY",
    altEnvKeys: ["GOOGLE_API_KEY", "GEMINI_API_KEY"],
  },
  ollama: { envKey: "OLLAMA_BASE_URL" },
  "vercel-ai-gateway": {
    envKey: "AI_GATEWAY_API_KEY",
    altEnvKeys: ["AIGATEWAY_API_KEY"],
  },
};

// ── Per-provider cache read/write ────────────────────────────────────────

function providerCachePath(providerId: string): string {
  return path.join(resolveModelsCacheDir(), `${providerId}.json`);
}

function readProviderCache(providerId: string): ProviderCache | null {
  try {
    const raw = fs.readFileSync(providerCachePath(providerId), "utf-8");
    const cache = JSON.parse(raw) as ProviderCache;
    if (cache.version !== 1 || !cache.fetchedAt || !cache.models) return null;
    const age = Date.now() - new Date(cache.fetchedAt).getTime();
    if (age > MODELS_CACHE_TTL_MS) return null;
    return cache;
  } catch {
    return null;
  }
}

function writeProviderCache(cache: ProviderCache): void {
  try {
    const dir = resolveModelsCacheDir();
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      providerCachePath(cache.providerId),
      JSON.stringify(cache, null, 2),
    );
  } catch (e) {
    logger.warn(
      `[model-catalog] Failed to write cache for ${cache.providerId}: ${e instanceof Error ? e.message : e}`,
    );
  }
}

// ── Provider fetchers ────────────────────────────────────────────────────

/** Fetch models from unknown provider's /v1/models endpoint (standard REST). */
async function fetchModelsREST(
  providerId: string,
  apiKey: string,
  baseUrl: string,
): Promise<CachedModel[]> {
  try {
    const url = `${baseUrl.replace(/\/+$/, "")}/models`;
    const headers: Record<string, string> = {};
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
    const res = await fetch(url, { headers });
    if (!res.ok) return [];
    const data = (await res.json()) as {
      data?: Array<{ id: string; name?: string; type?: string }>;
    };
    return (data.data ?? [])
      .map((m) => ({
        id: m.id,
        name: m.name ?? m.id,
        category: m.type ? restTypeToCategory(m.type) : classifyModel(m.id),
      }))
      .sort((a, b) => a.id.localeCompare(b.id));
  } catch (e) {
    logger.warn(
      `[model-catalog] Failed to fetch models for ${providerId}: ${e instanceof Error ? e.message : e}`,
    );
    return [];
  }
}

function restTypeToCategory(type: string): ModelCategory {
  const t = type.toLowerCase();
  if (t.includes("embed")) return "embedding";
  if (t === "image" || t.includes("image-generation")) return "image";
  if (t.includes("tts") || t.includes("speech")) return "tts";
  if (t.includes("stt") || t.includes("transcription") || t.includes("whisper"))
    return "stt";
  if (t === "language" || t === "chat" || t.includes("text")) return "chat";
  return classifyModel(type);
}

async function fetchAnthropicModels(apiKey: string): Promise<CachedModel[]> {
  try {
    const headers: Record<string, string> = {
      "anthropic-version": "2023-06-01",
    };
    if (apiKey) headers["x-api-key"] = apiKey;
    const res = await fetch("https://api.anthropic.com/v1/models?limit=100", {
      headers,
    });
    if (!res.ok) return [];
    const data = (await res.json()) as {
      data?: Array<{ id: string; display_name?: string; type?: string }>;
    };
    return (data.data ?? [])
      .map((m) => ({
        id: m.id,
        name: m.display_name ?? m.id,
        category: classifyModel(m.id),
      }))
      .sort((a, b) => a.id.localeCompare(b.id));
  } catch (e) {
    logger.warn(
      `[model-catalog] Failed to fetch Anthropic models: ${e instanceof Error ? e.message : e}`,
    );
    return [];
  }
}

async function fetchGoogleModels(apiKey: string): Promise<CachedModel[]> {
  try {
    const url = apiKey
      ? `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}`
      : "https://generativelanguage.googleapis.com/v1beta/models";
    const res = await fetch(url);
    if (!res.ok) return [];
    const data = (await res.json()) as {
      models?: Array<{ name: string; displayName?: string }>;
    };
    return (data.models ?? []).map((m) => {
      const id = m.name.replace("models/", "");
      return {
        id,
        name: m.displayName ?? id,
        category: classifyModel(id),
      };
    });
  } catch (e) {
    logger.warn(
      `[model-catalog] Failed to fetch Google models: ${e instanceof Error ? e.message : e}`,
    );
    return [];
  }
}

async function fetchOllamaModels(baseUrl: string): Promise<CachedModel[]> {
  try {
    let urlStr = baseUrl.replace(/\/+$/, "");
    if (!urlStr.startsWith("http://") && !urlStr.startsWith("https://")) {
      urlStr = `http://${urlStr}`;
    }
    const res = await fetch(`${urlStr}/api/tags`);
    if (!res.ok) return [];
    const data = (await res.json()) as { models?: Array<{ name: string }> };
    return (data.models ?? []).map((m) => ({
      id: m.name,
      name: m.name,
      category: classifyModel(m.name),
    }));
  } catch (e) {
    logger.warn(
      `[model-catalog] Failed to fetch Ollama models: ${e instanceof Error ? e.message : e}`,
    );
    return [];
  }
}

/** Fetch ALL OpenRouter models: chat (/api/v1/models) + embeddings (/api/v1/embeddings/models). */
async function fetchOpenRouterModels(apiKey: string): Promise<CachedModel[]> {
  const headers: Record<string, string> = {};
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

  interface ORModel {
    id: string;
    name?: string;
    architecture?: { modality?: string; output_modalities?: string[] };
  }

  // Fetch chat/text models and embedding models in parallel
  const [chatRes, embedRes] = await Promise.all([
    fetch("https://openrouter.ai/api/v1/models", { headers }).catch(() => null),
    fetch("https://openrouter.ai/api/v1/embeddings/models", { headers }).catch(
      () => null,
    ),
  ]);

  const models: CachedModel[] = [];

  // Parse chat/text/image models
  if (chatRes?.ok) {
    try {
      const data = (await chatRes.json()) as { data?: ORModel[] };
      for (const m of data.data ?? []) {
        const outputs = m.architecture?.output_modalities ?? [];
        let category: ModelCategory = "chat";
        if (outputs.includes("image")) category = "image";
        else if (outputs.includes("audio")) category = "tts";
        models.push({ id: m.id, name: m.name ?? m.id, category });
      }
    } catch {
      /* parse error */
    }
  }

  // Parse embedding models
  if (embedRes?.ok) {
    try {
      const data = (await embedRes.json()) as { data?: ORModel[] };
      for (const m of data.data ?? []) {
        models.push({ id: m.id, name: m.name ?? m.id, category: "embedding" });
      }
    } catch {
      /* parse error */
    }
  }

  models.sort((a, b) => a.id.localeCompare(b.id));
  return models;
}

/** Fetch Vercel AI Gateway models — no auth required, response has `type` field. */
async function fetchVercelGatewayModels(
  baseUrl: string,
): Promise<CachedModel[]> {
  try {
    const url = `${baseUrl.replace(/\/+$/, "")}/models`;
    const res = await fetch(url);
    if (!res.ok) return [];
    const data = (await res.json()) as {
      data?: Array<{ id: string; name?: string; type?: string }>;
    };
    return (data.data ?? [])
      .map((m) => ({
        id: m.id,
        name: m.name ?? m.id,
        category: m.type ? restTypeToCategory(m.type) : classifyModel(m.id),
      }))
      .sort((a, b) => a.id.localeCompare(b.id));
  } catch (e) {
    logger.warn(
      `[model-catalog] Failed to fetch Vercel AI Gateway models: ${e instanceof Error ? e.message : e}`,
    );
    return [];
  }
}

async function fetchProviderModels(
  providerId: string,
  apiKey: string,
  baseUrl?: string,
): Promise<CachedModel[]> {
  switch (providerId) {
    case "anthropic":
      return fetchAnthropicModels(apiKey);
    case "google-genai":
      return fetchGoogleModels(apiKey);
    case "ollama":
      return fetchOllamaModels(baseUrl || "http://localhost:11434");
    case "openrouter":
      return fetchOpenRouterModels(apiKey);
    case "openai":
      return fetchModelsREST(
        providerId,
        apiKey,
        baseUrl ?? "https://api.openai.com/v1",
      );
    case "groq":
      return fetchModelsREST(
        providerId,
        apiKey,
        baseUrl ?? "https://api.groq.com/openai/v1",
      );
    case "xai":
      return fetchModelsREST(
        providerId,
        apiKey,
        baseUrl ?? "https://api.x.ai/v1",
      );
    case "vercel-ai-gateway":
      return fetchVercelGatewayModels(
        baseUrl ?? "https://ai-gateway.vercel.sh/v1",
      );
    default:
      return [];
  }
}

/** Fetch + cache a single provider. Returns cached models or empty array. */
async function getOrFetchProvider(
  providerId: string,
  force = false,
): Promise<CachedModel[]> {
  if (!force) {
    const cached = readProviderCache(providerId);
    if (cached) return cached.models;
  }

  const cfg = PROVIDER_ENV_KEYS[providerId];
  if (!cfg) return [];

  let keyValue = process.env[cfg.envKey]?.trim();
  if (!keyValue && cfg.altEnvKeys) {
    for (const alt of cfg.altEnvKeys) {
      keyValue = process.env[alt]?.trim();
      if (keyValue) break;
    }
  }

  let baseUrl = cfg.baseUrl;
  if (providerId === "vercel-ai-gateway") {
    baseUrl =
      process.env.AI_GATEWAY_BASE_URL?.trim() ||
      "https://ai-gateway.vercel.sh/v1";
  }

  // Listing models doesn't require an API key — fetch from all providers
  const models = await fetchProviderModels(providerId, keyValue ?? "", baseUrl);
  if (models.length > 0) {
    writeProviderCache({
      version: 1,
      providerId,
      fetchedAt: new Date().toISOString(),
      models,
    });
  }
  return models;
}

/** Fetch all configured providers (parallel). Returns map of providerId → models. */
async function getOrFetchAllProviders(
  force = false,
): Promise<Record<string, CachedModel[]>> {
  const result: Record<string, CachedModel[]> = {};
  const fetches: Array<Promise<void>> = [];

  for (const providerId of Object.keys(PROVIDER_ENV_KEYS)) {
    fetches.push(
      getOrFetchProvider(providerId, force).then((models) => {
        if (models.length > 0) result[providerId] = models;
      }),
    );
  }

  await Promise.all(fetches);
  return result;
}

function getInventoryProviderOptions(): Array<{
  id: string;
  name: string;
  description: string;
  rpcProviders: Array<{
    id: string;
    name: string;
    description: string;
    envKey: string | null;
    requiresKey: boolean;
  }>;
}> {
  return [
    {
      id: "evm",
      name: "EVM",
      description: "Ethereum, Base, Arbitrum, Optimism, Polygon.",
      rpcProviders: [
        {
          id: "eliza-cloud",
          name: "Eliza Cloud",
          description: "Managed RPC. No setup needed.",
          envKey: null,
          requiresKey: false,
        },
        {
          id: "infura",
          name: "Infura",
          description: "Reliable EVM infrastructure.",
          envKey: "INFURA_API_KEY",
          requiresKey: true,
        },
        {
          id: "alchemy",
          name: "Alchemy",
          description: "Full-featured EVM data platform.",
          envKey: "ALCHEMY_API_KEY",
          requiresKey: true,
        },
        {
          id: "ankr",
          name: "Ankr",
          description: "Decentralized RPC provider.",
          envKey: "ANKR_API_KEY",
          requiresKey: true,
        },
      ],
    },
    {
      id: "bsc",
      name: "BSC",
      description: "BNB Smart Chain tokens, NFTs, and trades.",
      rpcProviders: [
        {
          id: "eliza-cloud",
          name: "Eliza Cloud",
          description: "Managed RPC. No setup needed.",
          envKey: null,
          requiresKey: false,
        },
        {
          id: "alchemy",
          name: "Alchemy",
          description: "Managed BSC RPC via Alchemy.",
          envKey: "ALCHEMY_API_KEY",
          requiresKey: true,
        },
        {
          id: "ankr",
          name: "Ankr",
          description: "Decentralized BSC RPC provider.",
          envKey: "ANKR_API_KEY",
          requiresKey: true,
        },
        {
          id: "nodereal",
          name: "NodeReal",
          description: "Dedicated BSC RPC endpoint.",
          envKey: "NODEREAL_BSC_RPC_URL",
          requiresKey: true,
        },
        {
          id: "quicknode",
          name: "QuickNode",
          description: "Managed BSC RPC endpoint.",
          envKey: "QUICKNODE_BSC_RPC_URL",
          requiresKey: true,
        },
      ],
    },
    {
      id: "solana",
      name: "Solana",
      description: "Solana mainnet tokens and NFTs.",
      rpcProviders: [
        {
          id: "eliza-cloud",
          name: "Eliza Cloud",
          description: "Managed RPC. No setup needed.",
          envKey: null,
          requiresKey: false,
        },
        {
          id: "helius-birdeye",
          name: "Helius + Birdeye",
          description: "Solana balances and NFT metadata.",
          envKey: "HELIUS_API_KEY",
          requiresKey: true,
        },
      ],
    },
  ];
}

function ensureWalletKeysInEnvAndConfig(config: ElizaConfig): boolean {
  const missingEvm =
    typeof process.env.EVM_PRIVATE_KEY !== "string" ||
    !process.env.EVM_PRIVATE_KEY.trim();
  const missingSolana =
    typeof process.env.SOLANA_PRIVATE_KEY !== "string" ||
    !process.env.SOLANA_PRIVATE_KEY.trim();

  if (!missingEvm && !missingSolana) {
    return false;
  }

  try {
    const walletKeys = generateWalletKeys();
    if (
      !config.env ||
      typeof config.env !== "object" ||
      Array.isArray(config.env)
    ) {
      config.env = {};
    }
    const envConfig = config.env as Record<string, string>;

    if (missingEvm) {
      envConfig.EVM_PRIVATE_KEY = walletKeys.evmPrivateKey;
      process.env.EVM_PRIVATE_KEY = walletKeys.evmPrivateKey;
      logger.info(
        `[milady-api] Generated EVM wallet: ${walletKeys.evmAddress}`,
      );
    }

    if (missingSolana) {
      envConfig.SOLANA_PRIVATE_KEY = walletKeys.solanaPrivateKey;
      process.env.SOLANA_PRIVATE_KEY = walletKeys.solanaPrivateKey;
      logger.info(
        `[milady-api] Generated Solana wallet: ${walletKeys.solanaAddress}`,
      );
    }

    return true;
  } catch (err) {
    logger.warn(
      `[milady-api] Failed to generate wallet keys: ${err instanceof Error ? err.message : String(err)}`,
    );
    return false;
  }
}

// ---------------------------------------------------------------------------
// Trade permission helpers (exported for use by awareness contributors)
// ---------------------------------------------------------------------------

export type TradePermissionMode =
  | "user-sign-only"
  | "manual-local-key"
  | "agent-auto";

/**
 * Resolve the active trade permission mode from config.
 * Falls back to "user-sign-only" when not configured.
 */
export function resolveTradePermissionMode(
  config: ElizaConfig,
): TradePermissionMode {
  const raw = (config.features as Record<string, unknown> | undefined)
    ?.tradePermissionMode;
  if (
    raw === "user-sign-only" ||
    raw === "manual-local-key" ||
    raw === "agent-auto"
  ) {
    return raw;
  }
  return "user-sign-only";
}

/**
 * Returns true if local-key execution is permitted for the given actor.
 * @param mode    The resolved trade permission mode.
 * @param isAgent True when the caller is the agent (autonomous), false for user-initiated flows.
 */
export function canUseLocalTradeExecution(
  mode: TradePermissionMode,
  isAgent: boolean,
): boolean {
  if (mode === "agent-auto") return true;
  if (mode === "manual-local-key") return !isAgent;
  return false;
}

// ---------------------------------------------------------------------------
// Automation & agent permission helpers
// ---------------------------------------------------------------------------

type AgentAutomationMode = "connectors-only" | "full";

const AGENT_AUTOMATION_HEADER = "x-milady-agent-action";
const AGENT_AUTOMATION_MODES = new Set<AgentAutomationMode>([
  "connectors-only",
  "full",
]);

function parseAgentAutomationMode(value: unknown): AgentAutomationMode | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  if (!AGENT_AUTOMATION_MODES.has(normalized as AgentAutomationMode)) {
    return null;
  }
  return normalized as AgentAutomationMode;
}

function resolveAgentAutomationModeFromConfig(
  config: ElizaConfig,
): AgentAutomationMode {
  const features =
    config.features && typeof config.features === "object"
      ? (config.features as Record<string, unknown>)
      : null;
  const agentAutomation =
    features?.agentAutomation &&
    typeof features.agentAutomation === "object" &&
    !Array.isArray(features.agentAutomation)
      ? (features.agentAutomation as Record<string, unknown>)
      : null;
  return parseAgentAutomationMode(agentAutomation?.mode) ?? "full";
}

function isAgentAutomationRequest(req: http.IncomingMessage): boolean {
  const raw = req.headers[AGENT_AUTOMATION_HEADER];
  if (typeof raw !== "string") return false;
  return /^(1|true|yes|agent)$/i.test(raw.trim());
}

function persistAgentAutomationMode(
  state: ServerState,
  mode: AgentAutomationMode,
): void {
  state.agentAutomationMode = mode;
  if (!state.config.features) {
    state.config.features = {};
  }

  const features = state.config.features as Record<
    string,
    boolean | { enabled?: boolean; [k: string]: unknown }
  >;
  const current = features.agentAutomation;
  const currentObject =
    current && typeof current === "object" && !Array.isArray(current)
      ? (current as Record<string, unknown>)
      : {};

  features.agentAutomation = {
    ...currentObject,
    enabled: true,
    mode,
  };
}

// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------

interface RequestContext {
  onRestart: (() => Promise<AgentRuntime | null>) | null;
  onRuntimeSwapped?: () => void;
}

type TrainingServiceLike = TrainingServiceWithRuntime;

type TrainingServiceCtor = new (options: {
  getRuntime: () => AgentRuntime | null;
  getConfig: () => ElizaConfig;
  setConfig: (nextConfig: ElizaConfig) => void;
}) => TrainingServiceLike;

async function resolveTrainingServiceCtor(): Promise<TrainingServiceCtor | null> {
  const candidates = [
    "../services/training-service",
    "@elizaos/plugin-training",
  ] as const;

  for (const specifier of candidates) {
    try {
      const loaded = (await import(/* @vite-ignore */ specifier)) as Record<
        string,
        unknown
      >;
      const ctor = loaded.TrainingService;
      if (typeof ctor === "function") {
        return ctor as TrainingServiceCtor;
      }
    } catch {
      // Keep trying fallbacks.
    }
  }

  return null;
}

function mcpServersIncludeStdio(servers: Record<string, unknown>): boolean {
  return Object.values(servers).some((serverConfig) => {
    if (
      !serverConfig ||
      typeof serverConfig !== "object" ||
      Array.isArray(serverConfig)
    ) {
      return false;
    }
    return (serverConfig as Record<string, unknown>).type === "stdio";
  });
}

export function resolveMcpTerminalAuthorizationRejection(
  req: Pick<http.IncomingMessage, "headers">,
  servers: Record<string, unknown>,
  body: { terminalToken?: string },
): TerminalRunRejection | null {
  if (!mcpServersIncludeStdio(servers)) {
    return null;
  }
  return resolveTerminalRunRejection(req as http.IncomingMessage, body);
}

const LOCAL_ORIGIN_RE =
  /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\]|\[0:0:0:0:0:0:0:1\])(:\d+)?$/i;
const APP_ORIGIN_RE = /^(capacitor|app|tauri|file|electrobun):\/\/.*$/i;

/**
 * Hostname allowlist for DNS rebinding protection.
 * Requests with a Host header that doesn't match a known loopback name are
 * rejected before CORS / auth processing.  This prevents a malicious page
 * from rebinding its DNS to 127.0.0.1 and reading the unauthenticated API.
 */
const LOCAL_HOST_RE =
  /^(localhost|127\.0\.0\.1|\[?::1\]?|\[?0:0:0:0:0:0:0:1\]?|::ffff:127\.0\.0\.1)$/;

/** Wildcard bind addresses that listen on all interfaces. */
const WILDCARD_BIND_RE = /^(0\.0\.0\.0|::|0:0:0:0:0:0:0:0)$/;

/** Strip an optional port suffix from a hostname string. */
function stripPort(host: string): string {
  return host.replace(/:\d+$/, "");
}

export function isAllowedHost(req: http.IncomingMessage): boolean {
  const raw = req.headers.host;
  if (!raw) return true; // No Host header → non-browser client (e.g. curl)

  let hostname: string;
  const trimmed = raw.trim().toLowerCase();
  if (!trimmed) return true;

  if (trimmed.startsWith("[")) {
    // Bracketed IPv6: [::1]:31337 → ::1
    const close = trimmed.indexOf("]");
    hostname = close > 0 ? trimmed.slice(1, close) : trimmed.slice(1);
  } else if ((trimmed.match(/:/g) || []).length >= 2) {
    // Bare IPv6 (multiple colons, no brackets): ::1 → ::1
    hostname = trimmed;
  } else {
    // IPv4 or hostname: localhost:31337 → localhost
    hostname = stripPort(trimmed);
  }

  if (!hostname) return true;

  const bindHost = (process.env.ELIZA_API_BIND ?? process.env.MILADY_API_BIND ?? "").trim().toLowerCase();

  // When binding on all interfaces (0.0.0.0 / ::), any Host is acceptable —
  // ensureApiTokenForBindHost already enforces a token for non-loopback binds.
  if (WILDCARD_BIND_RE.test(stripPort(bindHost))) {
    return true;
  }

  // Allow the exact configured bind hostname.
  if (bindHost && hostname === stripPort(bindHost)) {
    return true;
  }

  // Allow explicitly listed extra hostnames via ELIZA_ALLOWED_HOSTS / MILADY_ALLOWED_HOSTS
  // (comma-separated, e.g. "myserver.local,192.168.1.10").
  const extra = process.env.ELIZA_ALLOWED_HOSTS ?? process.env.MILADY_ALLOWED_HOSTS;
  if (extra) {
    const allowed = extra
      .split(",")
      .map((h) => stripPort(h.trim().toLowerCase()))
      .filter(Boolean);
    if (allowed.includes(hostname)) return true;
  }

  return LOCAL_HOST_RE.test(hostname);
}

export function resolveCorsOrigin(origin?: string): string | null {
  if (!origin) return null;
  const trimmed = origin.trim();
  if (!trimmed) return null;

  // When bound to a wildcard address, allow any origin. Non-loopback binds still
  // require an explicit token, so this only relaxes the browser origin check.
  const bindHost = (process.env.ELIZA_API_BIND ?? process.env.MILADY_API_BIND ?? "").trim().toLowerCase();
  if (WILDCARD_BIND_RE.test(stripPort(bindHost))) return trimmed;

  // Explicit allowlist via env (comma-separated)
  const extra = process.env.MILADY_ALLOWED_ORIGINS;
  if (extra) {
    const allow = extra
      .split(",")
      .map((v) => v.trim())
      .filter(Boolean);
    if (allow.includes(trimmed)) return trimmed;
  }

  if (LOCAL_ORIGIN_RE.test(trimmed)) return trimmed;
  if (APP_ORIGIN_RE.test(trimmed)) return trimmed;
  if (trimmed === "null" || trimmed === "file://") {
    if (process.env.MILADY_ALLOW_NULL_ORIGIN === "1") {
      return "null";
    }
  }
  return null;
}

function applyCors(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): boolean {
  const origin =
    typeof req.headers.origin === "string" ? req.headers.origin : undefined;
  const allowed = resolveCorsOrigin(origin);

  if (origin && !allowed) return false;

  if (allowed) {
    res.setHeader("Access-Control-Allow-Origin", allowed);
    res.setHeader("Vary", "Origin");
    res.setHeader(
      "Access-Control-Allow-Methods",
      "GET, POST, PUT, DELETE, OPTIONS",
    );
    res.setHeader(
      "Access-Control-Allow-Headers",
      "Content-Type, Authorization, X-Milady-Token, X-Api-Key, X-Milady-Export-Token, X-Milady-Client-Id, X-Milady-Terminal-Token, X-Milady-UI-Language",
    );
  }

  // Security headers
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("X-XSS-Protection", "1; mode=block");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");

  return true;
}

const PAIRING_TTL_MS = 10 * 60 * 1000;
const PAIRING_WINDOW_MS = 10 * 60 * 1000;
const PAIRING_MAX_ATTEMPTS = 5;
const PAIRING_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

let pairingCode: string | null = null;
/** Guard against concurrent provider switch requests (P0 §3). */
let providerSwitchInProgress = false;
let pairingExpiresAt = 0;
const pairingAttempts = new Map<string, { count: number; resetAt: number }>();

function pairingEnabled(): boolean {
  return (
    Boolean((process.env.ELIZA_API_TOKEN ?? process.env.MILADY_API_TOKEN)?.trim()) &&
    process.env.MILADY_PAIRING_DISABLED !== "1"
  );
}

function normalizePairingCode(code: string): string {
  return code.replace(/[^a-zA-Z0-9]/g, "").toUpperCase();
}

function generatePairingCode(): string {
  const bytes = crypto.randomBytes(8);
  let raw = "";
  for (let i = 0; i < bytes.length; i++) {
    raw += PAIRING_ALPHABET[bytes[i] % PAIRING_ALPHABET.length];
  }
  return `${raw.slice(0, 4)}-${raw.slice(4, 8)}`;
}

function ensurePairingCode(): string | null {
  if (!pairingEnabled()) return null;
  const now = Date.now();
  if (!pairingCode || now > pairingExpiresAt) {
    pairingCode = generatePairingCode();
    pairingExpiresAt = now + PAIRING_TTL_MS;
    logger.warn(
      `[milady-api] Pairing code: ${pairingCode} (valid for 10 minutes)`,
    );
  }
  return pairingCode;
}

function rateLimitPairing(ip: string | null): boolean {
  const key = ip ?? "unknown";
  const now = Date.now();

  // Lazy sweep: evict expired entries when map grows beyond 100
  sweepExpiredEntries(pairingAttempts, now, 100);

  const current = pairingAttempts.get(key);
  if (!current || now > current.resetAt) {
    pairingAttempts.set(key, { count: 1, resetAt: now + PAIRING_WINDOW_MS });
    return true;
  }
  if (current.count >= PAIRING_MAX_ATTEMPTS) return false;
  current.count += 1;
  return true;
}

export function extractAuthToken(req: http.IncomingMessage): string | null {
  const auth =
    typeof req.headers.authorization === "string"
      ? req.headers.authorization.trim()
      : "";
  if (auth) {
    const match = /^Bearer\s+(.+)$/i.exec(auth);
    if (match?.[1]) return match[1].trim();
  }

  const header =
    (typeof req.headers["x-eliza-token"] === "string" &&
      req.headers["x-eliza-token"]) ||
    (typeof req.headers["x-milady-token"] === "string" &&
      req.headers["x-milady-token"]) ||
    (typeof req.headers["x-api-key"] === "string" && req.headers["x-api-key"]);
  if (typeof header === "string" && header.trim()) return header.trim();

  return null;
}

const SAFE_WS_CLIENT_ID_RE = /^[A-Za-z0-9._-]{1,128}$/;

export function normalizeWsClientId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (!SAFE_WS_CLIENT_ID_RE.test(trimmed)) return null;
  return trimmed;
}

function firstHeaderValue(value: string | string[] | undefined): string | null {
  if (typeof value === "string") return value;
  if (Array.isArray(value) && typeof value[0] === "string") return value[0];
  return null;
}

export function resolveTerminalRunClientId(
  req: Pick<http.IncomingMessage, "headers">,
  body: { clientId?: unknown } | null | undefined,
): string | null {
  const headerClientId = normalizeWsClientId(
    firstHeaderValue(req.headers["x-milady-client-id"]),
  );
  if (headerClientId) return headerClientId;
  return normalizeWsClientId(body?.clientId);
}

const SHARED_TERMINAL_CLIENT_IDS = new Set([
  "runtime-terminal-action",
  "runtime-shell-action",
]);

function isSharedTerminalClientId(clientId: string): boolean {
  return SHARED_TERMINAL_CLIENT_IDS.has(clientId);
}

/**
 * Resolve Authorization for Hyperscape API relays.
 *
 * Security: never forward the incoming request Authorization header
 * (which typically carries MILADY_API_TOKEN for this API). Hyperscape relay
 * auth must come from the dedicated HYPERSCAPE_AUTH_TOKEN secret instead.
 */
export function resolveHyperscapeAuthorizationHeader(
  req: Pick<http.IncomingMessage, "headers">,
): string | null {
  void req;
  const envToken = process.env.HYPERSCAPE_AUTH_TOKEN?.trim();
  if (!envToken) return null;
  return /^Bearer\s+/i.test(envToken) ? envToken : `Bearer ${envToken}`;
}

function tokenMatches(expected: string, provided: string): boolean {
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(provided, "utf8");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function isLoopbackBindHost(host: string): boolean {
  let normalized = host.trim().toLowerCase();

  if (!normalized) return true;

  // Allow users to provide full URLs by mistake (e.g. http://localhost:2138)
  if (normalized.startsWith("http://") || normalized.startsWith("https://")) {
    try {
      const parsed = new URL(normalized);
      normalized = parsed.hostname.toLowerCase();
    } catch {
      // Fall through and parse as raw host value.
    }
  }

  // [::1]:2138 -> ::1
  const bracketedIpv6 = /^\[([^\]]+)\](?::\d+)?$/.exec(normalized);
  if (bracketedIpv6?.[1]) {
    normalized = bracketedIpv6[1];
  } else {
    // localhost:2138 -> localhost, 127.0.0.1:2138 -> 127.0.0.1
    const singleColonHostPort = /^([^:]+):(\d+)$/.exec(normalized);
    if (singleColonHostPort?.[1]) {
      normalized = singleColonHostPort[1];
    }
  }

  normalized = normalized.replace(/^\[|\]$/g, "");
  if (!normalized) return true;
  if (
    normalized === "localhost" ||
    normalized === "::1" ||
    normalized === "0:0:0:0:0:0:0:1" ||
    normalized === "::ffff:127.0.0.1"
  ) {
    return true;
  }
  if (normalized.startsWith("127.")) return true;
  return false;
}

export function ensureApiTokenForBindHost(host: string): void {
  const token = (process.env.ELIZA_API_TOKEN ?? process.env.MILADY_API_TOKEN)?.trim();
  if (token) return;
  if (isLoopbackBindHost(host)) return;

  const generated = crypto.randomBytes(32).toString("hex");
  process.env.ELIZA_API_TOKEN = generated;
  process.env.MILADY_API_TOKEN = generated;

  logger.warn(
    `[milady-api] ELIZA_API_BIND/MILADY_API_BIND=${host} is non-loopback and ELIZA_API_TOKEN/MILADY_API_TOKEN is unset.`,
  );
  const tokenFingerprint = `${generated.slice(0, 4)}...${generated.slice(-4)}`;
  logger.warn(
    `[milady-api] Generated temporary API token (${tokenFingerprint}) for this process. Set ELIZA_API_TOKEN explicitly to override.`,
  );
}

export function isAuthorized(req: http.IncomingMessage): boolean {
  const expected = (process.env.ELIZA_API_TOKEN ?? process.env.MILADY_API_TOKEN)?.trim();
  if (!expected) return true;
  const provided = extractAuthToken(req);
  if (!provided) return false;
  return tokenMatches(expected, provided);
}

export interface PluginConfigMutationRejection {
  field: string;
  message: string;
}

export function resolvePluginConfigMutationRejections(
  pluginParams: Array<{ key: string }>,
  config: Record<string, unknown>,
): PluginConfigMutationRejection[] {
  const allowedParamKeys = new Set(
    pluginParams.map((p) => p.key.toUpperCase().trim()),
  );
  const rejections: PluginConfigMutationRejection[] = [];

  for (const key of Object.keys(config)) {
    const normalized = key.toUpperCase().trim();

    if (!allowedParamKeys.has(normalized)) {
      rejections.push({
        field: key,
        message: `${key} is not a declared config key for this plugin`,
      });
      continue;
    }

    if (BLOCKED_ENV_KEYS.has(normalized)) {
      rejections.push({
        field: key,
        message: `${key} is blocked for security reasons`,
      });
    }
  }

  return rejections;
}

interface WalletExportRequestBody {
  confirm?: boolean;
  exportToken?: string;
}

export interface WalletExportRejection {
  status: 401 | 403;
  reason: string;
}

export function resolveWalletExportRejection(
  req: http.IncomingMessage,
  body: WalletExportRequestBody,
): WalletExportRejection | null {
  if (!body.confirm) {
    return {
      status: 403,
      reason:
        'Export requires explicit confirmation. Send { "confirm": true } in the request body.',
    };
  }

  const expected = process.env.MILADY_WALLET_EXPORT_TOKEN?.trim();
  if (!expected) {
    return {
      status: 403,
      reason:
        "Wallet export is disabled. Set MILADY_WALLET_EXPORT_TOKEN to enable secure exports.",
    };
  }

  const headerToken =
    typeof req.headers["x-milady-export-token"] === "string"
      ? req.headers["x-milady-export-token"].trim()
      : "";
  const bodyToken =
    typeof body.exportToken === "string" ? body.exportToken.trim() : "";
  const provided = headerToken || bodyToken;

  if (!provided) {
    return {
      status: 401,
      reason:
        "Missing export token. Provide X-Milady-Export-Token header or exportToken in request body.",
    };
  }

  if (!tokenMatches(expected, provided)) {
    return { status: 401, reason: "Invalid export token." };
  }

  return null;
}

interface TerminalRunRequestBody {
  terminalToken?: string;
}

export interface TerminalRunRejection {
  status: 401 | 403;
  reason: string;
}

export function resolveTerminalRunRejection(
  req: http.IncomingMessage,
  body: TerminalRunRequestBody,
): TerminalRunRejection | null {
  const expected = process.env.MILADY_TERMINAL_RUN_TOKEN?.trim();
  const apiTokenEnabled = Boolean((process.env.ELIZA_API_TOKEN ?? process.env.MILADY_API_TOKEN)?.trim());

  // Compatibility mode: local loopback sessions without API token keep
  // existing behavior unless an explicit terminal token is configured.
  if (!expected && !apiTokenEnabled) {
    return null;
  }

  if (!expected) {
    return {
      status: 403,
      reason:
        "Terminal run is disabled for token-authenticated API sessions. Set MILADY_TERMINAL_RUN_TOKEN to enable command execution.",
    };
  }

  const headerToken =
    typeof req.headers["x-milady-terminal-token"] === "string"
      ? req.headers["x-milady-terminal-token"].trim()
      : "";
  const bodyToken =
    typeof body.terminalToken === "string" ? body.terminalToken.trim() : "";
  const provided = headerToken || bodyToken;

  if (!provided) {
    return {
      status: 401,
      reason:
        "Missing terminal token. Provide X-Milady-Terminal-Token header or terminalToken in request body.",
    };
  }

  if (!tokenMatches(expected, provided)) {
    return {
      status: 401,
      reason: "Invalid terminal token.",
    };
  }

  return null;
}

function extractWsQueryToken(url: URL): string | null {
  const allowQueryToken = process.env.MILADY_ALLOW_WS_QUERY_TOKEN === "1";
  if (!allowQueryToken) return null;

  const token =
    url.searchParams.get("token") ??
    url.searchParams.get("apiKey") ??
    url.searchParams.get("api_key");
  return token?.trim() || null;
}

function isWebSocketAuthorized(
  request: http.IncomingMessage,
  url: URL,
): boolean {
  const expected = (process.env.ELIZA_API_TOKEN ?? process.env.MILADY_API_TOKEN)?.trim();
  if (!expected) return true;

  const headerToken = extractAuthToken(request);
  if (headerToken) return tokenMatches(expected, headerToken);

  const queryToken = extractWsQueryToken(url);
  if (!queryToken) return false;
  return tokenMatches(expected, queryToken);
}

export interface WebSocketUpgradeRejection {
  status: 401 | 403 | 404;
  reason: string;
}

export function resolveWebSocketUpgradeRejection(
  req: http.IncomingMessage,
  wsUrl: URL,
): WebSocketUpgradeRejection | null {
  if (wsUrl.pathname !== "/ws") {
    return { status: 404, reason: "Not found" };
  }

  const origin =
    typeof req.headers.origin === "string" ? req.headers.origin : undefined;
  const allowedOrigin = resolveCorsOrigin(origin);
  if (origin && !allowedOrigin) {
    return { status: 403, reason: "Origin not allowed" };
  }

  if (!isWebSocketAuthorized(req, wsUrl)) {
    return { status: 401, reason: "Unauthorized" };
  }

  return null;
}

const RESET_STATE_ALLOWED_SEGMENTS = new Set([".milady", "milady"]);

function hasAllowedResetSegment(resolvedState: string): boolean {
  return resolvedState
    .split(path.sep)
    .some((segment) =>
      RESET_STATE_ALLOWED_SEGMENTS.has(segment.trim().toLowerCase()),
    );
}

export function isSafeResetStateDir(
  resolvedState: string,
  homeDir: string,
): boolean {
  const normalizedState = path.resolve(resolvedState);
  const normalizedHome = path.resolve(homeDir);
  const parsedRoot = path.parse(normalizedState).root;

  if (normalizedState === parsedRoot) return false;
  if (normalizedState === normalizedHome) return false;

  const relativeToHome = path.relative(normalizedHome, normalizedState);
  const isUnderHome =
    relativeToHome.length > 0 &&
    !relativeToHome.startsWith("..") &&
    !path.isAbsolute(relativeToHome);
  if (!isUnderHome) return false;

  return hasAllowedResetSegment(normalizedState);
}

type ConversationRoomTitleRef = Pick<
  ConversationMeta,
  "id" | "title" | "roomId"
>;

export async function persistConversationRoomTitle(
  runtime: Pick<AgentRuntime, "getRoom" | "adapter"> | null | undefined,
  conversation: ConversationRoomTitleRef,
): Promise<boolean> {
  if (!runtime) return false;
  const room = await runtime.getRoom(conversation.roomId);
  if (!room) return false;
  if (room.name === conversation.title) return false;

  const adapter = runtime.adapter as {
    updateRoom?: (nextRoom: typeof room) => Promise<void>;
  };
  if (typeof adapter.updateRoom !== "function") return false;

  await adapter.updateRoom({ ...room, name: conversation.title });
  return true;
}

function rejectWebSocketUpgrade(
  socket: import("node:stream").Duplex,
  statusCode: number,
  message: string,
): void {
  const statusText =
    statusCode === 401
      ? "Unauthorized"
      : statusCode === 403
        ? "Forbidden"
        : statusCode === 404
          ? "Not Found"
          : "Bad Request";
  const body = `${message}\n`;
  socket.write(
    `HTTP/1.1 ${statusCode} ${statusText}\r\n` +
      "Connection: close\r\n" +
      "Content-Type: text/plain; charset=utf-8\r\n" +
      `Content-Length: ${Buffer.byteLength(body)}\r\n` +
      "\r\n" +
      body,
    () => socket.end(),
  );
}

function decodePathComponent(
  raw: string,
  res: http.ServerResponse,
  fieldName: string,
): string | null {
  try {
    return decodeURIComponent(raw);
  } catch {
    error(res, `Invalid ${fieldName}: malformed URL encoding`, 400);
    return null;
  }
}

const WORKBENCH_TASK_TAG = "workbench-task";
const WORKBENCH_TODO_TAG = "workbench-todo";

interface WorkbenchTaskView {
  id: string;
  name: string;
  description: string;
  tags: string[];
  isCompleted: boolean;
  updatedAt?: number;
}

interface WorkbenchTodoView {
  id: string;
  name: string;
  description: string;
  priority: number | null;
  isUrgent: boolean;
  isCompleted: boolean;
  type: string;
}

interface TodoDataServiceLike {
  createTodo: (input: Record<string, unknown>) => Promise<string>;
  getTodos: (
    filters?: Record<string, unknown>,
  ) => Promise<Array<Record<string, unknown>>>;
  getTodo: (todoId: string) => Promise<Record<string, unknown> | null>;
  updateTodo: (
    todoId: string,
    updates: Record<string, unknown>,
  ) => Promise<boolean>;
  deleteTodo: (todoId: string) => Promise<boolean>;
}

function asObject(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function normalizeTimestamp(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (value instanceof Date) return value.getTime();
  if (typeof value === "string") {
    const asNumber = Number(value);
    if (Number.isFinite(asNumber)) return asNumber;
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function parseNullableNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function readTaskMetadata(task: Task): Record<string, unknown> {
  return asObject(task.metadata) ?? {};
}

function normalizeTaskId(task: Task): string | null {
  return typeof task.id === "string" && task.id.trim().length > 0
    ? task.id
    : null;
}

function readTaskCompleted(task: Task): boolean {
  const metadata = readTaskMetadata(task);
  if (typeof metadata.isCompleted === "boolean") return metadata.isCompleted;
  const todoMeta =
    asObject(metadata.workbenchTodo) ?? asObject(metadata.todo) ?? null;
  if (todoMeta && typeof todoMeta.isCompleted === "boolean") {
    return todoMeta.isCompleted;
  }
  return false;
}

function isWorkbenchTodoTask(task: Task): boolean {
  if (readTriggerConfig(task)) return false;
  const tags = new Set(normalizeStringArray(task.tags));
  if (tags.has(WORKBENCH_TODO_TAG) || tags.has("todo")) return true;
  const metadata = readTaskMetadata(task);
  return (
    asObject(metadata.workbenchTodo) !== null ||
    asObject(metadata.todo) !== null
  );
}

function toWorkbenchTask(task: Task): WorkbenchTaskView | null {
  if (readTriggerConfig(task) || isWorkbenchTodoTask(task)) return null;
  const id = normalizeTaskId(task);
  if (!id) return null;
  const metadata = readTaskMetadata(task);
  const updatedAt =
    normalizeTimestamp(
      (task as unknown as Record<string, unknown>).updatedAt,
    ) ?? normalizeTimestamp(metadata.updatedAt);
  return {
    id,
    name:
      typeof task.name === "string" && task.name.trim().length > 0
        ? task.name
        : "Task",
    description: typeof task.description === "string" ? task.description : "",
    tags: normalizeStringArray(task.tags),
    isCompleted: readTaskCompleted(task),
    ...(updatedAt !== undefined ? { updatedAt } : {}),
  };
}

function toWorkbenchTodo(task: Task): WorkbenchTodoView | null {
  if (!isWorkbenchTodoTask(task)) return null;
  const id = normalizeTaskId(task);
  if (!id) return null;
  const metadata = readTaskMetadata(task);
  const todoMeta =
    asObject(metadata.workbenchTodo) ?? asObject(metadata.todo) ?? {};
  return {
    id,
    name:
      typeof task.name === "string" && task.name.trim().length > 0
        ? task.name
        : "Todo",
    description:
      typeof todoMeta.description === "string"
        ? todoMeta.description
        : typeof task.description === "string"
          ? task.description
          : "",
    priority: parseNullableNumber(todoMeta.priority),
    isUrgent: todoMeta.isUrgent === true,
    isCompleted: readTaskCompleted(task),
    type:
      typeof todoMeta.type === "string" && todoMeta.type.trim().length > 0
        ? todoMeta.type
        : "task",
  };
}

function normalizeTags(value: unknown, required: string[] = []): string[] {
  const next = new Set<string>([
    ...normalizeStringArray(value),
    ...required.map((tag) => tag.trim()).filter((tag) => tag.length > 0),
  ]);
  return [...next];
}

async function getTodoDataService(
  runtime: AgentRuntime,
): Promise<TodoDataServiceLike | null> {
  try {
    const todoModule = (await import("@elizaos/plugin-todo")) as Record<
      string,
      unknown
    >;
    const createTodoDataService = todoModule.createTodoDataService as
      | ((rt: AgentRuntime) => TodoDataServiceLike)
      | undefined;
    if (!createTodoDataService) return null;
    return createTodoDataService(runtime);
  } catch {
    return null;
  }
}

function toWorkbenchTodoFromRecord(
  todo: Record<string, unknown>,
): WorkbenchTodoView | null {
  const id =
    typeof todo.id === "string" && todo.id.trim().length > 0 ? todo.id : null;
  const name =
    typeof todo.name === "string" && todo.name.trim().length > 0
      ? todo.name
      : null;
  if (!id || !name) return null;
  return {
    id,
    name,
    description: typeof todo.description === "string" ? todo.description : "",
    priority: parseNullableNumber(todo.priority),
    isUrgent: todo.isUrgent === true,
    isCompleted: todo.isCompleted === true,
    type:
      typeof todo.type === "string" && todo.type.trim().length > 0
        ? todo.type
        : "task",
  };
}

// ── Runtime debug serialization ─────────────────────────────────────

const RUNTIME_DEBUG_DEFAULT_MAX_DEPTH = 10;
const RUNTIME_DEBUG_MAX_DEPTH_CAP = 24;
const RUNTIME_DEBUG_DEFAULT_MAX_ARRAY_LENGTH = 1000;
const RUNTIME_DEBUG_DEFAULT_MAX_OBJECT_ENTRIES = 1000;
const RUNTIME_DEBUG_DEFAULT_MAX_STRING_LENGTH = 8000;

interface RuntimeDebugSerializeOptions {
  maxDepth: number;
  maxArrayLength: number;
  maxObjectEntries: number;
  maxStringLength: number;
}

interface RuntimeOrderItem {
  index: number;
  name: string;
  className: string;
  id: string | null;
}

interface RuntimeServiceOrderItem {
  index: number;
  serviceType: string;
  count: number;
  instances: RuntimeOrderItem[];
}

function parseDebugPositiveInt(
  raw: string | null,
  fallback: number,
  min: number,
  max: number,
): number {
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return fallback;
  const intValue = Math.floor(parsed);
  if (intValue < min) return min;
  if (intValue > max) return max;
  return intValue;
}

function classNameFor(value: object): string {
  const ctor = (value as { constructor?: { name?: string } }).constructor;
  const maybeName = typeof ctor?.name === "string" ? ctor.name.trim() : "";
  return maybeName || "Object";
}

function stringDataProperty(value: unknown, key: string): string | null {
  if (!value || typeof value !== "object") return null;
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor || !("value" in descriptor)) return null;
  const maybeString = descriptor.value;
  if (typeof maybeString !== "string") return null;
  const trimmed = maybeString.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function describeRuntimeOrder(
  values: unknown[],
  fallbackLabel: string,
): RuntimeOrderItem[] {
  return values.map((value, index) => {
    const className =
      value && typeof value === "object" ? classNameFor(value) : typeof value;
    const name =
      stringDataProperty(value, "name") ??
      stringDataProperty(value, "id") ??
      stringDataProperty(value, "key") ??
      stringDataProperty(value, "serviceType") ??
      `${fallbackLabel} ${index + 1}`;
    const id =
      stringDataProperty(value, "id") ?? stringDataProperty(value, "name");
    return { index, name, className, id };
  });
}

function describeRuntimeServiceOrder(
  servicesMap: Map<string, unknown[]>,
): RuntimeServiceOrderItem[] {
  return Array.from(servicesMap.entries()).map(
    ([serviceType, instances], i) => {
      const values = Array.isArray(instances) ? instances : [];
      return {
        index: i,
        serviceType,
        count: values.length,
        instances: describeRuntimeOrder(values, serviceType),
      };
    },
  );
}

function serializeForRuntimeDebug(
  value: unknown,
  options: RuntimeDebugSerializeOptions,
): unknown {
  const seen = new WeakMap<object, string>();

  const visit = (current: unknown, path: string, depth: number): unknown => {
    if (current === null) return null;

    const kind = typeof current;

    if (kind === "string") {
      if ((current as string).length <= options.maxStringLength) return current;
      return {
        __type: "string",
        length: (current as string).length,
        preview: `${(current as string).slice(0, options.maxStringLength)}...`,
        truncated: true,
      };
    }
    if (kind === "number") {
      const n = current as number;
      if (Number.isFinite(n)) return n;
      return { __type: "number", value: String(n) };
    }
    if (kind === "boolean") return current;
    if (kind === "bigint") return { __type: "bigint", value: String(current) };
    if (kind === "undefined") return { __type: "undefined" };
    if (kind === "symbol") return { __type: "symbol", value: String(current) };
    if (kind === "function") {
      const fn = current as (...args: unknown[]) => unknown;
      return {
        __type: "function",
        name: fn.name || "(anonymous)",
        length: fn.length,
      };
    }

    const obj = current as object;

    if (obj instanceof Date) {
      return { __type: "date", value: obj.toISOString() };
    }
    if (obj instanceof RegExp) {
      return { __type: "regexp", value: String(obj) };
    }
    if (obj instanceof Error) {
      const err = obj as Error & { cause?: unknown };
      const out: Record<string, unknown> = {
        __type: "error",
        name: err.name,
        message: err.message,
      };
      if (err.stack) {
        out.stack =
          err.stack.length > options.maxStringLength
            ? `${err.stack.slice(0, options.maxStringLength)}...`
            : err.stack;
      }
      if (err.cause !== undefined) {
        out.cause = visit(err.cause, `${path}.cause`, depth + 1);
      }
      return out;
    }
    if (Buffer.isBuffer(obj)) {
      const previewLength = Math.min(obj.length, 64);
      return {
        __type: "buffer",
        length: obj.length,
        previewHex: obj.subarray(0, previewLength).toString("hex"),
        truncated: obj.length > previewLength,
      };
    }
    if (ArrayBuffer.isView(obj)) {
      const view = obj as ArrayBufferView;
      const previewLength = Math.min(view.byteLength, 64);
      const bytes = new Uint8Array(view.buffer, view.byteOffset, previewLength);
      return {
        __type: classNameFor(obj),
        byteLength: view.byteLength,
        previewHex: Buffer.from(bytes).toString("hex"),
        truncated: view.byteLength > previewLength,
      };
    }
    if (obj instanceof ArrayBuffer) {
      const previewLength = Math.min(obj.byteLength, 64);
      const bytes = new Uint8Array(obj, 0, previewLength);
      return {
        __type: "array-buffer",
        byteLength: obj.byteLength,
        previewHex: Buffer.from(bytes).toString("hex"),
        truncated: obj.byteLength > previewLength,
      };
    }

    const seenPath = seen.get(obj);
    if (seenPath) return { __type: "circular", ref: seenPath };
    if (depth >= options.maxDepth) {
      return {
        __type: "max-depth",
        className: classNameFor(obj),
        path,
      };
    }
    seen.set(obj, path);

    if (Array.isArray(obj)) {
      const arr = obj as unknown[];
      const limit = Math.min(arr.length, options.maxArrayLength);
      const items = new Array<unknown>(limit);
      for (let i = 0; i < limit; i++) {
        items[i] = visit(arr[i], `${path}[${i}]`, depth + 1);
      }
      const out: Record<string, unknown> = {
        __type: "array",
        length: arr.length,
        items,
      };
      if (arr.length > limit) out.truncatedItems = arr.length - limit;
      return out;
    }

    if (obj instanceof Map) {
      const entries: Array<{ key: unknown; value: unknown }> = [];
      let i = 0;
      for (const [entryKey, entryValue] of obj.entries()) {
        if (i >= options.maxObjectEntries) break;
        entries.push({
          key: visit(entryKey, `${path}.<key:${i}>`, depth + 1),
          value: visit(entryValue, `${path}.<value:${i}>`, depth + 1),
        });
        i += 1;
      }
      const out: Record<string, unknown> = {
        __type: "map",
        size: obj.size,
        entries,
      };
      if (obj.size > entries.length) {
        out.truncatedEntries = obj.size - entries.length;
      }
      return out;
    }

    if (obj instanceof Set) {
      const values: unknown[] = [];
      let i = 0;
      for (const entry of obj.values()) {
        if (i >= options.maxArrayLength) break;
        values.push(visit(entry, `${path}.<set:${i}>`, depth + 1));
        i += 1;
      }
      const out: Record<string, unknown> = {
        __type: "set",
        size: obj.size,
        values,
      };
      if (obj.size > values.length)
        out.truncatedEntries = obj.size - values.length;
      return out;
    }

    if (obj instanceof WeakMap) {
      return { __type: "weak-map" };
    }
    if (obj instanceof WeakSet) {
      return { __type: "weak-set" };
    }
    if (obj instanceof Promise) {
      return { __type: "promise" };
    }

    const ownNames = Object.getOwnPropertyNames(obj);
    const ownSymbols = Object.getOwnPropertySymbols(obj);
    const allKeys: Array<string | symbol> = [...ownNames, ...ownSymbols];
    const limit = Math.min(allKeys.length, options.maxObjectEntries);
    const properties: Record<string, unknown> = {};

    for (let i = 0; i < limit; i++) {
      const propertyKey = allKeys[i];
      const keyLabel =
        typeof propertyKey === "string"
          ? propertyKey
          : `[${String(propertyKey)}]`;
      const descriptor = Object.getOwnPropertyDescriptor(obj, propertyKey);
      if (!descriptor) continue;
      if ("value" in descriptor) {
        properties[keyLabel] = visit(
          descriptor.value,
          `${path}.${keyLabel}`,
          depth + 1,
        );
      } else {
        properties[keyLabel] = {
          __type: "accessor",
          hasGetter: typeof descriptor.get === "function",
          hasSetter: typeof descriptor.set === "function",
          enumerable: descriptor.enumerable,
        };
      }
    }

    if (allKeys.length > limit) {
      properties.__truncatedKeys = allKeys.length - limit;
    }

    const prototype = Object.getPrototypeOf(obj);
    const isPlainObject = prototype === Object.prototype || prototype === null;
    if (isPlainObject) return properties;

    return {
      __type: "object",
      className: classNameFor(obj),
      properties,
    };
  };

  return visit(value, "$", 0);
}

// ── Autonomy → User message routing ──────────────────────────────────

/**
 * Route non-conversation text output to the user's active conversation.
 * Stores the message as a Memory in the conversation room and broadcasts
 * a `proactive-message` WS event to the frontend.
 */
export async function routeAutonomyTextToUser(
  state: ServerState,
  responseText: string,
  source = "autonomy",
): Promise<void> {
  const runtime = state.runtime;
  if (!runtime) return;

  const normalizedText = responseText.trim();
  if (!normalizedText) return;

  // Find target conversation (active, or most recent)
  let conv: ConversationMeta | undefined;
  if (state.activeConversationId) {
    conv = state.conversations.get(state.activeConversationId);
  }
  if (!conv) {
    // Fall back to most recently updated conversation
    const sorted = Array.from(state.conversations.values()).sort(
      (a, b) =>
        new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
    );
    conv = sorted[0];
  }
  if (!conv) return; // No conversations exist yet

  // Ephemeral sources: broadcast to UI but don't persist to DB.
  // Coding-agent status updates and coordinator decisions are transient —
  // they bloat the database without adding long-term value.
  const ephemeralSources = new Set(["coding-agent", "coordinator", "action"]);

  const messageId = crypto.randomUUID() as UUID;

  if (!ephemeralSources.has(source)) {
    const agentMessage = createMessageMemory({
      id: messageId,
      entityId: runtime.agentId,
      roomId: conv.roomId,
      content: {
        text: normalizedText,
        source,
      },
    });
    await runtime.createMemory(agentMessage, "messages");
  }
  conv.updatedAt = new Date().toISOString();

  // Broadcast to all WS clients (always, even for ephemeral sources)
  state.broadcastWs?.({
    type: "proactive-message",
    conversationId: conv.id,
    message: {
      id: messageId,
      role: "assistant",
      text: normalizedText,
      timestamp: Date.now(),
      source,
    },
  });
}

// ── Coding Agent Chat Bridge ──────────────────────────────────────────

/**
 * Get the SwarmCoordinator from the runtime services (if available).
 * Discovers via runtime.getService("SWARM_COORDINATOR") — the coordinator
 * registers itself during PTYService.start().
 */
function getCoordinatorFromRuntime(runtime: AgentRuntime): {
  setChatCallback?: (
    cb: (text: string, source?: string) => Promise<void>,
  ) => void;
  setWsBroadcast?: (cb: (event: SwarmEvent) => void) => void;
  setAgentDecisionCallback?: (
    cb: (
      eventDescription: string,
      sessionId: string,
      taskContext: TaskContext,
    ) => Promise<CoordinationLLMResponse | null>,
  ) => void;
  setSwarmCompleteCallback?: (
    cb: (payload: {
      tasks: TaskCompletionSummary[];
      total: number;
      completed: number;
      stopped: number;
      errored: number;
    }) => Promise<void>,
  ) => void;
} | null {
  const coordinator = runtime.getService("SWARM_COORDINATOR");
  if (coordinator)
    return coordinator as ReturnType<typeof getCoordinatorFromRuntime>;
  return null;
}

/**
 * Wire the SwarmCoordinator's chatCallback so coordinator messages
 * appear in the user's chat UI via the existing proactive-message flow.
 * Returns true if successfully wired.
 */
function wireCodingAgentChatBridge(st: ServerState): boolean {
  if (!st.runtime) return false;
  const coordinator = getCoordinatorFromRuntime(st.runtime);
  if (!coordinator?.setChatCallback) return false;
  coordinator.setChatCallback(async (text: string, source?: string) => {
    await routeAutonomyTextToUser(st, text, source ?? "coding-agent");
  });
  return true;
}

/**
 * Wire the SwarmCoordinator's wsBroadcast callback so coordinator events
 * are relayed to all WebSocket clients as "pty-session-event" messages.
 * Returns true if successfully wired.
 */
function wireCodingAgentWsBridge(st: ServerState): boolean {
  if (!st.runtime) return false;
  const coordinator = getCoordinatorFromRuntime(st.runtime);
  if (!coordinator?.setWsBroadcast) return false;
  coordinator.setWsBroadcast((event: SwarmEvent) => {
    // Preserve the coordinator's event type (task_registered, task_complete, etc.)
    // as `eventType` so it doesn't overwrite the WS message dispatch type.
    const { type: eventType, ...rest } = event;
    st.broadcastWs?.({ type: "pty-session-event", eventType, ...rest });
  });
  return true;
}

/**
 * Wire the SwarmCoordinator's swarmCompleteCallback so that when all agents
 * finish, we synthesize a summary via the agent's LLM and post it as a
 * persisted message in the conversation.
 */
function wireCodingAgentSwarmSynthesis(st: ServerState): boolean {
  if (!st.runtime) return false;
  const coordinator = getCoordinatorFromRuntime(st.runtime);
  if (!coordinator?.setSwarmCompleteCallback) return false;

  coordinator.setSwarmCompleteCallback((payload) =>
    handleSwarmSynthesis(st, payload),
  );
  return true;
}

/**
 * Handle swarm completion by synthesizing a summary via the LLM.
 * Extracted from wireCodingAgentSwarmSynthesis for testability.
 *
 * Paths: (A) LLM returns synthesis → route to user,
 *        (B) LLM returns empty → warn,
 *        (C) LLM throws → fallback generic message.
 */
export async function handleSwarmSynthesis(
  st: { runtime: AgentRuntime | null },
  payload: {
    tasks: Array<{
      sessionId: string;
      label: string;
      agentType: string;
      originalTask: string;
      status: string;
      completionSummary: string;
    }>;
    total: number;
    completed: number;
    stopped: number;
    errored: number;
  },
  routeMessage: (text: string, source: string) => Promise<void> = (
    text,
    source,
  ) => routeAutonomyTextToUser(st as ServerState, text, source),
): Promise<void> {
  const runtime = st.runtime;
  if (!runtime) {
    logger.warn("[swarm-synthesis] No runtime available — skipping synthesis");
    return;
  }

  logger.info(
    `[swarm-synthesis] Generating synthesis for ${payload.total} tasks (${payload.completed} completed, ${payload.stopped} stopped, ${payload.errored} errored)`,
  );

  const taskLines = payload.tasks
    .map(
      (t) =>
        `- [${t.status.toUpperCase()}] "${t.label}" (${t.agentType})\n  Task: ${t.originalTask}\n  Result: ${t.completionSummary || "No summary available"}`,
    )
    .join("\n\n");

  const prompt =
    `You are summarizing the results of a coding agent swarm for the user. ` +
    `${payload.total} agents were dispatched. ${payload.completed} completed, ` +
    `${payload.stopped} stopped, ${payload.errored} errored.\n\n` +
    `Here are the individual task results:\n\n${taskLines}\n\n` +
    `Write a concise, conversational summary of what was accomplished. ` +
    `Highlight key outcomes (PRs created, issues found, research results). ` +
    `If any tasks failed or stopped, mention what went wrong. ` +
    `Keep your personality — be warm and helpful but brief.`;

  try {
    const synthesis = await runtime.useModel(ModelType.TEXT_SMALL, {
      prompt,
      maxTokens: 2048,
      temperature: 0.7,
    });

    if (synthesis?.trim()) {
      logger.info("[swarm-synthesis] Synthesis generated, routing to user");
      await routeMessage(synthesis.trim(), "swarm_synthesis");
    } else {
      logger.warn("[swarm-synthesis] LLM returned empty synthesis");
    }
  } catch (err) {
    logger.error(`[swarm-synthesis] LLM call failed: ${err}`);
    const parts: string[] = [];
    if (payload.completed > 0) parts.push(`${payload.completed} completed`);
    if (payload.stopped > 0) parts.push(`${payload.stopped} stopped`);
    if (payload.errored > 0) parts.push(`${payload.errored} errored`);
    await routeMessage(
      `All ${payload.total} coding agents finished (${parts.join(", ")}). Review their work when you're ready.`,
      "coding-agent",
    );
  }
}

// ── Parse Action Block from Milady's Response ─────────────────────────
import {
  parseActionBlock,
  stripActionBlockFromDisplay,
} from "./parse-action-block";

// ── Coordinator Event Routing ───────────────────────────────────────────

/**
 * Wire the SwarmCoordinator's agentDecisionCallback so coordinator events
 * (blocked prompts, turn completions) route through Milady's full
 * elizaOS pipeline (memory, personality, actions) so she has conversation
 * context to make informed decisions. The pipeline's model size is
 * The pipeline's model size is temporarily overridden to TEXT_SMALL
 * via the private `runtime.llmModeOption` (no public setter exists).
 * This is intentional — coordinator decisions must be fast to avoid
 * stalling CLI agents waiting for input.
 *
 * Events are serialized (one at a time) to prevent context confusion.
 * Milady's response appears in chat via WS broadcast, and the embedded
 * JSON action block is parsed and returned to the coordinator for execution.
 *
 * If the callback fails or Milady's response has no action block,
 * returns null → coordinator falls back to the small LLM.
 */
function wireCoordinatorEventRouting(st: ServerState): boolean {
  if (!st.runtime) return false;
  const coordinator = getCoordinatorFromRuntime(st.runtime);
  if (!coordinator?.setAgentDecisionCallback) return false;

  // Serialization queue — one coordinator event at a time
  let eventQueue: Promise<void> = Promise.resolve();

  coordinator.setAgentDecisionCallback(
    async (
      eventDescription: string,
      _sessionId: string,
      _taskCtx: TaskContext,
    ): Promise<CoordinationLLMResponse | null> => {
      let resolveOuter!: (v: CoordinationLLMResponse | null) => void;
      const resultPromise = new Promise<CoordinationLLMResponse | null>((r) => {
        resolveOuter = r;
      });

      eventQueue = eventQueue.then(async () => {
        try {
          const runtime = st.runtime;
          if (!runtime) {
            resolveOuter(null);
            return;
          }

          // Ensure the legacy chat connection exists (creates room/world if needed).
          // We inline the setup here because ensureLegacyChatConnection is
          // closure-scoped in the route handler and not accessible at module level.
          const agentName = runtime.character.name ?? "Milady";
          if (!st.chatUserId || !st.chatRoomId) {
            const adminId =
              st.adminEntityId ??
              (stringToUuid(`${st.agentName}-admin-entity`) as UUID);
            st.adminEntityId = adminId;
            st.chatUserId = adminId;
            st.chatRoomId =
              st.chatRoomId ??
              (stringToUuid(`${agentName}-web-chat-room`) as UUID);
            const worldId = stringToUuid(`${agentName}-web-chat-world`) as UUID;
            const messageServerId = stringToUuid(
              `${agentName}-web-server`,
            ) as UUID;
            await runtime.ensureConnection({
              entityId: adminId,
              roomId: st.chatRoomId,
              worldId,
              userName: "User",
              source: "client_chat",
              channelId: `${agentName}-web-chat`,
              type: ChannelType.DM,
              messageServerId,
              metadata: { ownership: { ownerId: adminId } },
            });
          }
          if (!st.chatUserId || !st.chatRoomId) {
            resolveOuter(null);
            return;
          }

          // Create a message memory so the event enters Milady's conversation history.
          const message = createMessageMemory({
            id: crypto.randomUUID() as UUID,
            entityId: st.chatUserId,
            agentId: runtime.agentId,
            roomId: st.chatRoomId,
            content: {
              text: eventDescription,
              source: "coordinator",
              channelType: "DM",
            },
          });

          // Temporarily force TEXT_SMALL — coordinator events are time-sensitive
          // and TEXT_LARGE can timeout while CLI agents stall waiting for input.
          // llmModeOption is private with no public setter; cast is intentional.
          const rt = runtime as unknown as Record<string, unknown>;
          const prevLlmMode = rt.llmModeOption;
          rt.llmModeOption = "SMALL";
          let result: { text: string; agentName?: string };
          try {
            result = await generateChatResponse(runtime, message, agentName, {
              resolveNoResponseText: () => "I'll look into that.",
            });
          } finally {
            rt.llmModeOption = prevLlmMode;
          }

          // WS broadcast the natural language portion (strip JSON action block).
          // Both fenced (```json ... ```) and bare JSON must be removed since
          // the LLM may return either format.
          if (result.text && result.text !== "(no response)") {
            const displayText = stripActionBlockFromDisplay(result.text);
            if (displayText && displayText.length > 2) {
              const conv = st.activeConversationId
                ? st.conversations.get(st.activeConversationId)
                : Array.from(st.conversations.values()).sort(
                    (a, b) =>
                      new Date(b.updatedAt).getTime() -
                      new Date(a.updatedAt).getTime(),
                  )[0];
              if (conv) {
                st.broadcastWs?.({
                  type: "proactive-message",
                  conversationId: conv.id,
                  message: {
                    id: `coordinator-${Date.now()}`,
                    role: "assistant",
                    text: displayText,
                    timestamp: Date.now(),
                    source: "coordinator",
                  },
                });
              }
            }
          }

          resolveOuter(parseActionBlock(result.text ?? ""));
        } catch (err) {
          logger.error(
            `Coordinator event routing failed: ${err instanceof Error ? err.message : String(err)}`,
          );
          resolveOuter(null);
        }
      });

      return resultPromise;
    },
  );

  return true;
}

/**
 * Fallback handler for /api/coding-agents/* routes when the plugin
 * doesn't export createCodingAgentRouteHandler.
 * Uses the AgentOrchestratorService (CODE_TASK) to provide task data.
 */
async function handleCodingAgentsFallback(
  runtime: AgentRuntime,
  pathname: string,
  method: string,
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<boolean> {
  type ScratchStatus = "pending_decision" | "kept" | "promoted";
  type ScratchTerminalEvent = "stopped" | "task_complete" | "error";
  type ScratchRecord = {
    sessionId: string;
    label: string;
    path: string;
    status: ScratchStatus;
    createdAt: number;
    terminalAt: number;
    terminalEvent: ScratchTerminalEvent;
    expiresAt?: number;
  };
  type AgentPreflightRecord = {
    adapter?: string;
    installed?: boolean;
    installCommand?: string;
    docsUrl?: string;
  };
  type CodeTaskService = {
    getTasks?: () => Promise<
      Array<{
        id?: string;
        name?: string;
        description?: string;
        metadata?: {
          status?: string;
          providerId?: string;
          providerLabel?: string;
          workingDirectory?: string;
          progress?: number;
          steps?: Array<{ status?: string }>;
        };
      }>
    >;
    getAgentPreflight?: () => Promise<unknown>;
    listAgentPreflight?: () => Promise<unknown>;
    preflightCodingAgents?: () => Promise<unknown>;
    preflight?: () => Promise<unknown>;
    listScratchWorkspaces?: () => Promise<unknown>;
    getScratchWorkspaces?: () => Promise<unknown>;
    listScratch?: () => Promise<unknown>;
    keepScratchWorkspace?: (sessionId: string) => Promise<unknown>;
    keepScratch?: (sessionId: string) => Promise<unknown>;
    deleteScratchWorkspace?: (sessionId: string) => Promise<unknown>;
    deleteScratch?: (sessionId: string) => Promise<unknown>;
    promoteScratchWorkspace?: (
      sessionId: string,
      name?: string,
    ) => Promise<unknown>;
    promoteScratch?: (sessionId: string, name?: string) => Promise<unknown>;
  };

  const codeTaskService = runtime.getService(
    "CODE_TASK",
  ) as CodeTaskService | null;

  const toNumber = (value: unknown, fallback = 0): number => {
    const parsed =
      typeof value === "number"
        ? value
        : typeof value === "string"
          ? Number(value)
          : Number.NaN;
    return Number.isFinite(parsed) ? parsed : fallback;
  };
  const toScratchStatus = (value: unknown): ScratchStatus => {
    if (value === "kept" || value === "promoted") return value;
    return "pending_decision";
  };
  const toTerminalEvent = (value: unknown): ScratchTerminalEvent => {
    if (value === "stopped" || value === "error") return value;
    return "task_complete";
  };
  const normalizeScratchRecord = (value: unknown): ScratchRecord | null => {
    if (!value || typeof value !== "object") return null;
    const raw = value as Record<string, unknown>;
    const sessionId =
      typeof raw.sessionId === "string" ? raw.sessionId.trim() : "";
    const pathValue = typeof raw.path === "string" ? raw.path.trim() : "";
    if (!sessionId || !pathValue) return null;
    const createdAt = toNumber(raw.createdAt, Date.now());
    const terminalAt = toNumber(raw.terminalAt, createdAt);
    const expiresAt = toNumber(raw.expiresAt, 0);
    return {
      sessionId,
      label:
        typeof raw.label === "string" && raw.label.trim().length > 0
          ? raw.label
          : sessionId,
      path: pathValue,
      status: toScratchStatus(raw.status),
      createdAt,
      terminalAt,
      terminalEvent: toTerminalEvent(raw.terminalEvent),
      ...(expiresAt > 0 ? { expiresAt } : {}),
    };
  };
  const parseSessionId = (raw: string): string | null => {
    let sessionId = "";
    try {
      sessionId = decodeURIComponent(raw);
    } catch {
      return null;
    }
    if (!sessionId || sessionId.includes("/") || sessionId.includes("..")) {
      return null;
    }
    return sessionId;
  };

  // GET /api/coding-agents/preflight
  if (method === "GET" && pathname === "/api/coding-agents/preflight") {
    try {
      const loaders: Array<(() => Promise<unknown>) | undefined> = [
        codeTaskService?.getAgentPreflight,
        codeTaskService?.listAgentPreflight,
        codeTaskService?.preflightCodingAgents,
        codeTaskService?.preflight,
      ];
      let rows: unknown[] = [];
      for (const loader of loaders) {
        if (!loader) continue;
        const maybeRows = await loader.call(codeTaskService);
        if (Array.isArray(maybeRows)) {
          rows = maybeRows;
          break;
        }
      }
      const normalized = rows.flatMap((item): AgentPreflightRecord[] => {
        if (!item || typeof item !== "object") return [];
        const raw = item as Record<string, unknown>;
        const adapter =
          typeof raw.adapter === "string" ? raw.adapter.trim() : "";
        if (!adapter) return [];
        return [
          {
            adapter,
            installed: Boolean(raw.installed),
            installCommand:
              typeof raw.installCommand === "string"
                ? raw.installCommand
                : undefined,
            docsUrl: typeof raw.docsUrl === "string" ? raw.docsUrl : undefined,
          },
        ];
      });
      json(res, normalized);
      return true;
    } catch (e) {
      error(res, `Failed to get coding agent preflight: ${e}`, 500);
      return true;
    }
  }

  // GET /api/coding-agents/coordinator/status
  if (
    method === "GET" &&
    pathname === "/api/coding-agents/coordinator/status"
  ) {
    if (!codeTaskService?.getTasks) {
      // Return empty status if service not available
      json(res, {
        supervisionLevel: "autonomous",
        taskCount: 0,
        tasks: [],
        pendingConfirmations: 0,
      });
      return true;
    }

    try {
      const tasks = await codeTaskService.getTasks();

      // Map tasks to the CodingAgentSession format expected by frontend
      const mappedTasks = tasks.map((task) => {
        const meta = task.metadata ?? {};
        // Map orchestrator status to frontend status
        let status: string = "active";
        switch (meta.status) {
          case "completed":
            status = "completed";
            break;
          case "failed":
          case "error":
            status = "error";
            break;
          case "cancelled":
            status = "stopped";
            break;
          case "paused":
            status = "blocked";
            break;
          case "running":
            status = "active";
            break;
          case "pending":
            status = "active";
            break;
          default:
            status = "active";
        }

        return {
          sessionId: task.id ?? "",
          agentType: meta.providerId ?? "eliza",
          label: meta.providerLabel ?? task.name ?? "Task",
          originalTask: task.description ?? task.name ?? "",
          workdir: meta.workingDirectory ?? process.cwd(),
          status,
          decisionCount: meta.steps?.length ?? 0,
          autoResolvedCount:
            meta.steps?.filter((s) => s.status === "completed").length ?? 0,
        };
      });

      json(res, {
        supervisionLevel: "autonomous",
        taskCount: mappedTasks.length,
        tasks: mappedTasks,
        pendingConfirmations: 0,
      });
      return true;
    } catch (e) {
      error(res, `Failed to get coding agent status: ${e}`, 500);
      return true;
    }
  }

  // POST /api/coding-agents/:sessionId/stop - Stop a coding agent task
  const stopMatch = pathname.match(/^\/api\/coding-agents\/([^/]+)\/stop$/);
  if (method === "POST" && stopMatch) {
    const sessionId = parseSessionId(stopMatch[1]);
    if (!sessionId) {
      error(res, "Invalid session ID", 400);
      return true;
    }
    const ptyService = runtime.getService("PTY_SERVICE") as PTYService | null;

    if (!ptyService?.stopSession) {
      error(res, "PTY Service not available", 503);
      return true;
    }

    try {
      await ptyService.stopSession(sessionId);
      json(res, { ok: true });
      return true;
    } catch (e) {
      error(res, `Failed to stop session: ${e}`, 500);
      return true;
    }
  }

  // GET /api/coding-agents/scratch
  if (method === "GET" && pathname === "/api/coding-agents/scratch") {
    try {
      const loaders: Array<(() => Promise<unknown>) | undefined> = [
        codeTaskService?.listScratchWorkspaces,
        codeTaskService?.getScratchWorkspaces,
        codeTaskService?.listScratch,
      ];
      let rows: unknown[] = [];
      for (const loader of loaders) {
        if (!loader) continue;
        const maybeRows = await loader.call(codeTaskService);
        if (Array.isArray(maybeRows)) {
          rows = maybeRows;
          break;
        }
      }
      const normalized = rows
        .map((item) => normalizeScratchRecord(item))
        .filter((item): item is ScratchRecord => item !== null);
      json(res, normalized);
      return true;
    } catch (e) {
      error(res, `Failed to list scratch workspaces: ${e}`, 500);
      return true;
    }
  }

  const keepMatch = pathname.match(
    /^\/api\/coding-agents\/([^/]+)\/scratch\/keep$/,
  );
  if (method === "POST" && keepMatch) {
    const sessionId = parseSessionId(keepMatch[1]);
    if (!sessionId) {
      error(res, "Invalid session ID", 400);
      return true;
    }
    const keeper =
      codeTaskService?.keepScratchWorkspace ?? codeTaskService?.keepScratch;
    if (!keeper) {
      error(res, "Scratch keep is not available", 503);
      return true;
    }
    try {
      await keeper.call(codeTaskService, sessionId);
      json(res, { ok: true });
      return true;
    } catch (e) {
      error(res, `Failed to keep scratch workspace: ${e}`, 500);
      return true;
    }
  }

  const deleteMatch = pathname.match(
    /^\/api\/coding-agents\/([^/]+)\/scratch\/delete$/,
  );
  if (method === "POST" && deleteMatch) {
    const sessionId = parseSessionId(deleteMatch[1]);
    if (!sessionId) {
      error(res, "Invalid session ID", 400);
      return true;
    }
    const deleter =
      codeTaskService?.deleteScratchWorkspace ?? codeTaskService?.deleteScratch;
    if (!deleter) {
      error(res, "Scratch delete is not available", 503);
      return true;
    }
    try {
      await deleter.call(codeTaskService, sessionId);
      json(res, { ok: true });
      return true;
    } catch (e) {
      error(res, `Failed to delete scratch workspace: ${e}`, 500);
      return true;
    }
  }

  const promoteMatch = pathname.match(
    /^\/api\/coding-agents\/([^/]+)\/scratch\/promote$/,
  );
  if (method === "POST" && promoteMatch) {
    const sessionId = parseSessionId(promoteMatch[1]);
    if (!sessionId) {
      error(res, "Invalid session ID", 400);
      return true;
    }
    const promoter =
      codeTaskService?.promoteScratchWorkspace ??
      codeTaskService?.promoteScratch;
    if (!promoter) {
      error(res, "Scratch promote is not available", 503);
      return true;
    }
    const body = await readJsonBody<{ name?: string }>(req, res);
    if (body === null) return true;
    const name =
      typeof body.name === "string" && body.name.trim().length > 0
        ? body.name.trim()
        : undefined;
    try {
      const promoted = await promoter.call(codeTaskService, sessionId, name);
      const scratch = normalizeScratchRecord(promoted);
      json(res, { success: true, ...(scratch ? { scratch } : {}) });
      return true;
    } catch (e) {
      error(res, `Failed to promote scratch workspace: ${e}`, 500);
      return true;
    }
  }

  // Not handled by fallback
  return false;
}

/**
 * Get the PTYConsoleBridge from the PTYService (if available).
 * Used by the WS PTY handlers to subscribe to output and forward input.
 */
function getPtyConsoleBridge(st: ServerState) {
  if (!st.runtime) return null;
  const ptyService = st.runtime.getService(
    "PTY_SERVICE",
  ) as unknown as PTYService | null;
  return ptyService?.consoleBridge ?? null;
}

/**
 * Route non-conversation agent events into the active user chat.
 * This avoids monkey-patching the message service and relies on explicit
 * event stream plumbing from AGENT_EVENT.
 */
async function maybeRouteAutonomyEventToConversation(
  state: ServerState,
  event: AgentEventPayloadLike,
): Promise<void> {
  if (event.stream !== "assistant") return;

  const payload =
    event.data && typeof event.data === "object"
      ? (event.data as Record<string, unknown>)
      : null;
  const text = typeof payload?.text === "string" ? payload.text.trim() : "";
  if (!text) return;

  const hasExplicitSource =
    typeof payload?.source === "string" && payload.source.trim().length > 0;
  const source = hasExplicitSource
    ? (payload?.source as string).trim()
    : "autonomy";

  // Regular user conversation turns should never be re-routed as proactive.
  // Some AGENT_EVENT payloads may omit roomId metadata, so rely on source too.
  if (source === "client_chat") return;
  if (!hasExplicitSource && !event.roomId) return;

  // Keep regular conversation messages in their own room only.
  if (
    event.roomId &&
    Array.from(state.conversations.values()).some(
      (c) => c.roomId === event.roomId,
    )
  ) {
    return;
  }

  await routeAutonomyTextToUser(state, text, source);
}

async function handleRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  state: ServerState,
  ctx?: RequestContext,
): Promise<void> {
  const method = req.method ?? "GET";
  let url: URL;
  try {
    url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  } catch {
    error(res, "Invalid request URL", 400);
    return;
  }
  const pathname = url.pathname;
  const isAuthEndpoint = pathname.startsWith("/api/auth/");
  const registryService = state.registryService;
  const dropService = state.dropService;

  const scheduleRuntimeRestart = (reason: string): void => {
    if (state.pendingRestartReasons.length >= 50) {
      // Prevent unbounded growth — keep only first entry + latest
      state.pendingRestartReasons.splice(
        1,
        state.pendingRestartReasons.length - 1,
      );
    }
    if (!state.pendingRestartReasons.includes(reason)) {
      state.pendingRestartReasons.push(reason);
    }
    logger.info(
      `[milady-api] Restart required: ${reason} (${state.pendingRestartReasons.length} pending)`,
    );
    state.broadcastWs?.({
      type: "restart-required",
      reasons: [...state.pendingRestartReasons],
    });
  };

  const resolveHyperscapeApiBaseUrl = async (): Promise<string> => {
    const fromEnv = process.env.HYPERSCAPE_API_URL?.trim();
    if (fromEnv) {
      return fromEnv.replace(/\/+$/, "");
    }
    // Default to the local Hyperscape API server. Viewer URLs can point at a
    // client dev server (for example :3333) which does not expose API routes.
    return "http://localhost:5555";
  };

  const relayHyperscapeApi = async (
    outboundMethod: "GET" | "POST",
    outboundPath: string,
    options?: {
      rawBodyOverride?: string;
      contentTypeOverride?: string | null;
    },
  ): Promise<void> => {
    const baseUrl = await resolveHyperscapeApiBaseUrl();

    let upstreamUrl: URL;
    try {
      upstreamUrl = new URL(outboundPath, baseUrl);
      upstreamUrl.search = url.search;
    } catch {
      error(res, `Invalid Hyperscape API URL: ${baseUrl}`, 500);
      return;
    }

    let rawBody: string | undefined;
    if (options?.rawBodyOverride !== undefined) {
      rawBody = options.rawBodyOverride;
    } else if (outboundMethod === "POST") {
      try {
        rawBody = await readBody(req);
        if (rawBody.trim().length === 0) {
          rawBody = undefined;
        }
      } catch (err) {
        error(
          res,
          `Failed to read request body: ${err instanceof Error ? err.message : String(err)}`,
          400,
        );
        return;
      }
    }

    const outboundHeaders: Record<string, string> = {};
    const contentType =
      options?.contentTypeOverride !== undefined
        ? options.contentTypeOverride
        : typeof req.headers["content-type"] === "string"
          ? req.headers["content-type"]
          : null;
    if (contentType && rawBody !== undefined) {
      outboundHeaders["Content-Type"] = contentType;
    }
    const authorization = resolveHyperscapeAuthorizationHeader(req);
    if (authorization) {
      outboundHeaders.Authorization = authorization;
    }

    let upstreamResponse: Response;
    try {
      upstreamResponse = await fetch(upstreamUrl.toString(), {
        method: outboundMethod,
        headers: outboundHeaders,
        body: rawBody !== undefined ? rawBody : undefined,
      });
    } catch (err) {
      error(
        res,
        `Failed to reach Hyperscape API: ${err instanceof Error ? err.message : String(err)}`,
        502,
      );
      return;
    }

    const responseText = await upstreamResponse.text();
    const responseType = upstreamResponse.headers.get("content-type");
    if (responseType) {
      res.setHeader("Content-Type", responseType);
    }
    res.statusCode = upstreamResponse.status;
    res.end(responseText);
  };

  // ── DNS rebinding protection ──────────────────────────────────────────
  // Reject requests whose Host header doesn't match a known loopback
  // hostname.  Without this check an attacker can rebind their domain's
  // DNS to 127.0.0.1 and read the unauthenticated localhost API from a
  // malicious page.
  if (!isAllowedHost(req)) {
    const incomingHost = req.headers.host ?? "your-hostname";
    json(
      res,
      {
        error: "Forbidden — invalid Host header",
        hint: `To allow this host, set ELIZA_ALLOWED_HOSTS=${incomingHost} (or MILADY_ALLOWED_HOSTS) in your environment, or access via http://localhost`,
        docs: "https://docs.milady.ai/configuration#allowed-hosts",
      },
      403,
    );
    return;
  }

  if (!applyCors(req, res)) {
    json(res, { error: "Origin not allowed" }, 403);
    return;
  }

  // Serve dashboard static assets before the auth gate.  serveStaticUi
  // already refuses /api/, /v1/, and /ws paths, so API endpoints remain
  // fully protected by the token check below.
  if (method === "GET" || method === "HEAD") {
    if (serveStaticUi(req, res, pathname)) return;
  }

  if (method !== "OPTIONS" && !isAuthEndpoint && !isAuthorized(req)) {
    json(res, { error: "Unauthorized" }, 401);
    return;
  }

  // CORS preflight
  if (method === "OPTIONS") {
    res.statusCode = 204;
    res.end();
    return;
  }

  // ── POST /api/provider/switch ─────────────────────────────────────────
  // Atomically switch the active AI provider.  Clears competing credentials
  // and env vars so the runtime loads the correct plugin on restart.
  if (method === "POST" && pathname === "/api/provider/switch") {
    const body = await readJsonBody<{ provider: string; apiKey?: string }>(
      req,
      res,
    );
    if (!body) return;
    const provider = body.provider;
    if (!provider || typeof provider !== "string") {
      error(res, "Missing provider", 400);
      return;
    }

    // P1 §7 — explicit provider allowlist
    const VALID_PROVIDERS = new Set([
      "elizacloud",
      "pi-ai",
      "openai-codex",
      "openai-subscription",
      "anthropic-subscription",
      "openai",
      "anthropic",
      "deepseek",
      "google",
      "groq",
      "xai",
      "openrouter",
    ]);
    if (!VALID_PROVIDERS.has(provider)) {
      error(res, "Invalid provider", 400);
      return;
    }

    const normalizedProvider = provider;

    // P0 §3 — race guard: reject concurrent provider switch requests
    if (providerSwitchInProgress) {
      error(res, "Provider switch already in progress", 409);
      return;
    }
    providerSwitchInProgress = true;

    const config = state.config;
    if (!config.cloud) config.cloud = {} as NonNullable<typeof config.cloud>;
    if (!config.env) config.env = {};
    const envCfg = config.env as Record<string, string>;

    // Helper: disable cloud inference while preserving cloud connection
    // for RPC and other services.  Does NOT delete cloud.apiKey or
    // cloud.enabled — only toggles inference off.
    const disableCloudInference = () => {
      const cloudCfg = config.cloud as Record<string, unknown>;
      cloudCfg.inferenceMode = "byok";
      if (!cloudCfg.services || typeof cloudCfg.services !== "object") {
        cloudCfg.services = {};
      }
      (cloudCfg.services as Record<string, unknown>).inference = false;
      // Clean cloud model env vars so the cloud plugin doesn't intercept
      // model calls — user's own keys handle models.
      delete process.env.ELIZAOS_CLOUD_SMALL_MODEL;
      delete process.env.ELIZAOS_CLOUD_LARGE_MODEL;
    };

    // Helper: enable cloud inference (switching TO cloud)
    const enableCloudInference = () => {
      const cloudCfg = config.cloud as Record<string, unknown>;
      cloudCfg.inferenceMode = "cloud";
      if (!cloudCfg.services || typeof cloudCfg.services !== "object") {
        cloudCfg.services = {};
      }
      (cloudCfg.services as Record<string, unknown>).inference = true;
    };

    // Helper: clear pi-ai mode
    const clearPiAi = () => {
      delete process.env.MILADY_USE_PI_AI;
      delete envCfg.MILADY_USE_PI_AI;

      const envRoot = config.env as Record<string, unknown>;
      const vars = envRoot.vars;
      if (vars && typeof vars === "object" && !Array.isArray(vars)) {
        delete (vars as Record<string, unknown>).MILADY_USE_PI_AI;
      }

      if (state.runtime?.character?.secrets) {
        const secrets = state.runtime.character.secrets as Record<
          string,
          unknown
        >;
        delete secrets.MILADY_USE_PI_AI;
      }
    };

    // Helper: clear subscription credentials
    const clearSubscriptions = async () => {
      try {
        const { deleteCredentials } = await import("../auth/index");
        deleteCredentials("anthropic-subscription");
        deleteCredentials("openai-codex");
      } catch (err) {
        logger.warn(
          `[api] Failed to clear subscriptions: ${err instanceof Error ? err.message : err}`,
        );
      }
      // Don't clear the env keys here — applySubscriptionCredentials on
      // restart will simply not set them if creds are gone.
    };

    // Provider-specific env key map
    const PROVIDER_ENV_KEYS: Record<string, string> = {
      openai: "OPENAI_API_KEY",
      anthropic: "ANTHROPIC_API_KEY",
      deepseek: "DEEPSEEK_API_KEY",
      google: "GOOGLE_GENERATIVE_AI_API_KEY",
      groq: "GROQ_API_KEY",
      xai: "XAI_API_KEY",
      openrouter: "OPENROUTER_API_KEY",
    };

    // Helper: clear all direct API keys from env (except the one we're switching to)
    const clearOtherApiKeys = (keepKey?: string) => {
      for (const [, envKey] of Object.entries(PROVIDER_ENV_KEYS)) {
        if (envKey === keepKey) continue;
        delete process.env[envKey];
        delete envCfg[envKey];
        // P1 §6 — also clear from runtime character secrets
        if (state.runtime?.character?.secrets) {
          const secrets = state.runtime.character.secrets as Record<
            string,
            unknown
          >;
          delete secrets[envKey];
        }
      }

      // Clear the legacy Gemini alias too so provider switches don't leave
      // multiple Google keys behind.
      if (keepKey !== "GOOGLE_API_KEY") {
        delete process.env.GOOGLE_API_KEY;
        delete envCfg.GOOGLE_API_KEY;
        if (state.runtime?.character?.secrets) {
          const secrets = state.runtime.character.secrets as Record<
            string,
            unknown
          >;
          delete secrets.GOOGLE_API_KEY;
        }
      }
    };

    try {
      // P0 §4 — input validation for direct API key providers
      if (PROVIDER_ENV_KEYS[normalizedProvider]) {
        const trimmedKey =
          typeof body.apiKey === "string" ? body.apiKey.trim() : "";
        if (!trimmedKey) {
          providerSwitchInProgress = false;
          error(res, "API key is required for this provider", 400);
          return;
        }
        if (trimmedKey.length > 512) {
          providerSwitchInProgress = false;
          error(res, "API key is too long", 400);
          return;
        }
        // Store trimmed key back for use below
        body.apiKey = trimmedKey;
      }

      if (normalizedProvider === "elizacloud") {
        // Switching TO elizacloud for inference
        clearPiAi();
        await clearSubscriptions();
        clearOtherApiKeys();
        clearSubscriptionProviderConfig(config);
        enableCloudInference();
        // Ensure cloud is enabled — the actual API key should already be in
        // config.cloud.apiKey from the original cloud login.
        (config.cloud as Record<string, unknown>).enabled = true;
        if (config.cloud.apiKey) {
          process.env.ELIZAOS_CLOUD_API_KEY = config.cloud.apiKey;
          process.env.ELIZAOS_CLOUD_ENABLED = "true";
        }
      } else if (normalizedProvider === "pi-ai") {
        // Switching TO pi-ai credentials mode
        disableCloudInference();
        await clearSubscriptions();
        clearOtherApiKeys();
        process.env.MILADY_USE_PI_AI = "1";
        envCfg.MILADY_USE_PI_AI = "1";

        const envRoot = config.env as Record<string, unknown>;
        const vars =
          envRoot.vars &&
          typeof envRoot.vars === "object" &&
          !Array.isArray(envRoot.vars)
            ? (envRoot.vars as Record<string, unknown>)
            : {};
        vars.MILADY_USE_PI_AI = "1";
        envRoot.vars = vars;
      } else if (
        normalizedProvider === "openai-codex" ||
        normalizedProvider === "openai-subscription"
      ) {
        // Switching TO OpenAI subscription — keep cloud for RPC
        clearPiAi();
        disableCloudInference();
        clearOtherApiKeys("OPENAI_API_KEY");
        applySubscriptionProviderConfig(config, provider);
        // Delete Anthropic subscription but keep OpenAI
        try {
          const { deleteCredentials } = await import("../auth/index");
          deleteCredentials("anthropic-subscription");
        } catch (err) {
          logger.warn(
            `[api] Failed to clear Anthropic subscription: ${err instanceof Error ? err.message : err}`,
          );
        }
        // Apply the OpenAI subscription credentials to env + install stealth
        try {
          const { applySubscriptionCredentials } = await import(
            "../auth/index"
          );
          await applySubscriptionCredentials(config);
        } catch (err) {
          logger.warn(
            `[api] Failed to apply OpenAI subscription creds: ${err instanceof Error ? err.message : err}`,
          );
        }
      } else if (normalizedProvider === "anthropic-subscription") {
        // Switching TO Anthropic subscription — keep cloud for RPC
        clearPiAi();
        disableCloudInference();
        clearOtherApiKeys("ANTHROPIC_API_KEY");
        applySubscriptionProviderConfig(config, provider);
        // Delete OpenAI subscription but keep Anthropic
        try {
          const { deleteCredentials } = await import("../auth/index");
          deleteCredentials("openai-codex");
        } catch (err) {
          logger.warn(
            `[api] Failed to clear OpenAI subscription: ${err instanceof Error ? err.message : err}`,
          );
        }
        // Apply the Anthropic subscription credentials to env + install stealth
        try {
          const { applySubscriptionCredentials } = await import(
            "../auth/index"
          );
          await applySubscriptionCredentials(config);
        } catch (err) {
          logger.warn(
            `[api] Failed to apply Anthropic subscription creds: ${err instanceof Error ? err.message : err}`,
          );
        }
      } else if (PROVIDER_ENV_KEYS[normalizedProvider]) {
        // Switching TO a direct API key provider — keep cloud for RPC
        clearPiAi();
        disableCloudInference();
        await clearSubscriptions();
        clearSubscriptionProviderConfig(config);
        const envKey = PROVIDER_ENV_KEYS[normalizedProvider];
        clearOtherApiKeys(envKey);
        const apiKey = body.apiKey;
        if (!apiKey) {
          providerSwitchInProgress = false;
          error(res, "API key is required for this provider", 400);
          return;
        }
        process.env[envKey] = apiKey;
        envCfg[envKey] = apiKey;
      }

      saveElizaConfig(config);

      // Schedule runtime restart so the new provider takes effect.
      scheduleRuntimeRestart(`provider switch to ${normalizedProvider}`);
      // Keep the lock briefly in restart-capable environments to prevent
      // double-submits from racing with restart-required propagation.
      if (ctx?.onRestart) {
        setTimeout(() => {
          providerSwitchInProgress = false;
        }, 250);
      } else {
        providerSwitchInProgress = false;
      }

      json(res, {
        success: true,
        provider,
        restarting: true,
      });
    } catch (err) {
      providerSwitchInProgress = false;
      // P1 §8 — don't leak internal error details to client
      logger.error(
        `[api] Provider switch failed: ${err instanceof Error ? err.stack : err}`,
      );
      error(res, "Provider switch failed", 500);
    }
    return;
  }

  if (
    await handleAuthRoutes({
      req,
      res,
      method,
      pathname,
      readJsonBody,
      json,
      error,
      pairingEnabled,
      ensurePairingCode,
      normalizePairingCode,
      rateLimitPairing,
      getPairingExpiresAt: () => pairingExpiresAt,
      clearPairing: () => {
        pairingCode = null;
        pairingExpiresAt = 0;
      },
    })
  ) {
    return;
  }

  if (
    await handleSubscriptionRoutes({
      req,
      res,
      method,
      pathname,
      state,
      readJsonBody,
      json,
      error,
      saveConfig: saveElizaConfig,
      loadSubscriptionAuth: async () =>
        (await import("../auth/index")) as never,
    } as never)
  ) {
    return;
  }

  // ── GET /api/status ─────────────────────────────────────────────────────
  if (method === "GET" && pathname === "/api/status") {
    const uptime = state.startedAt ? Date.now() - state.startedAt : undefined;
    const cloudStatus = {
      connectionStatus: "disconnected",
      activeAgentId: null,
    };

    json(res, {
      state: state.agentState,
      agentName: state.agentName,
      model: state.model,
      startedAt: state.startedAt,
      uptime,
      startup: state.startup,
      cloud: cloudStatus,
      pendingRestart: state.pendingRestartReasons.length > 0,
      pendingRestartReasons: state.pendingRestartReasons,
    });
    return;
  }

  // ── GET /api/health ──────────────────────────────────────────────────────
  // Structured health check endpoint returning subsystem status.
  if (method === "GET" && pathname === "/api/health") {
    const runtime = state.runtime;
    const uptime = state.startedAt
      ? Math.floor((Date.now() - state.startedAt) / 1000)
      : 0;

    const loadedPlugins = state.plugins.filter((p) => p.enabled);
    const failedPlugins = state.plugins.filter(
      (p) => !p.enabled && !p.configured,
    );

    let coordinatorStatus: "ok" | "not_wired" = "not_wired";
    try {
      if (runtime?.getService("SWARM_COORDINATOR")) {
        coordinatorStatus = "ok";
      }
    } catch {
      // not available
    }

    const connectors: Record<string, string> = state.connectorHealthMonitor
      ? state.connectorHealthMonitor.getConnectorStatuses()
      : {};
    if (Object.keys(connectors).length === 0 && state.config.connectors) {
      for (const [name, cfg] of Object.entries(state.config.connectors)) {
        if (
          cfg &&
          typeof cfg === "object" &&
          (cfg as Record<string, unknown>).enabled !== false
        ) {
          connectors[name] = "configured";
        }
      }
    }

    const ready =
      state.agentState !== "starting" && state.agentState !== "restarting";

    json(res, {
      ready,
      runtime: runtime ? "ok" : "not_initialized",
      database: runtime ? "ok" : "unknown",
      plugins: {
        loaded: loadedPlugins.length,
        failed: failedPlugins.length,
      },
      coordinator: coordinatorStatus,
      connectors,
      uptime,
      agentState: state.agentState,
      startup: state.startup,
    });
    return;
  }

  // ── GET /api/runtime ───────────────────────────────────────────────────
  // Deep runtime introspection endpoint for advanced debugging UI.
  if (method === "GET" && pathname === "/api/runtime") {
    const maxDepth = parseDebugPositiveInt(
      url.searchParams.get("depth"),
      RUNTIME_DEBUG_DEFAULT_MAX_DEPTH,
      1,
      RUNTIME_DEBUG_MAX_DEPTH_CAP,
    );
    const maxArrayLength = parseDebugPositiveInt(
      url.searchParams.get("maxArrayLength"),
      RUNTIME_DEBUG_DEFAULT_MAX_ARRAY_LENGTH,
      1,
      5000,
    );
    const maxObjectEntries = parseDebugPositiveInt(
      url.searchParams.get("maxObjectEntries"),
      RUNTIME_DEBUG_DEFAULT_MAX_OBJECT_ENTRIES,
      1,
      5000,
    );
    const maxStringLength = parseDebugPositiveInt(
      url.searchParams.get("maxStringLength"),
      RUNTIME_DEBUG_DEFAULT_MAX_STRING_LENGTH,
      64,
      100_000,
    );

    const serializeOptions: RuntimeDebugSerializeOptions = {
      maxDepth,
      maxArrayLength,
      maxObjectEntries,
      maxStringLength,
    };

    const runtime = state.runtime;
    const generatedAt = Date.now();

    if (!runtime) {
      json(res, {
        runtimeAvailable: false,
        generatedAt,
        settings: serializeOptions,
        meta: {
          agentState: state.agentState,
          agentName: state.agentName,
          model: state.model ?? null,
          pluginCount: 0,
          actionCount: 0,
          providerCount: 0,
          evaluatorCount: 0,
          serviceTypeCount: 0,
          serviceCount: 0,
        },
        order: {
          plugins: [],
          actions: [],
          providers: [],
          evaluators: [],
          services: [],
        },
        sections: {
          runtime: null,
          plugins: [],
          actions: [],
          providers: [],
          evaluators: [],
          services: {},
        },
      });
      return;
    }

    try {
      const servicesMap = runtime.services as unknown as Map<string, unknown[]>;
      const serviceCount = Array.from(servicesMap.values()).reduce(
        (sum, entries) => sum + (Array.isArray(entries) ? entries.length : 0),
        0,
      );
      const orderServices = describeRuntimeServiceOrder(servicesMap);
      const orderPlugins = describeRuntimeOrder(runtime.plugins, "plugin");
      const orderActions = describeRuntimeOrder(runtime.actions, "action");
      const orderProviders = describeRuntimeOrder(
        runtime.providers,
        "provider",
      );
      const orderEvaluators = describeRuntimeOrder(
        runtime.evaluators,
        "evaluator",
      );

      json(res, {
        runtimeAvailable: true,
        generatedAt,
        settings: serializeOptions,
        meta: {
          agentId: runtime.agentId,
          agentState: state.agentState,
          agentName: runtime.character.name ?? state.agentName,
          model: state.model ?? null,
          pluginCount: runtime.plugins.length,
          actionCount: runtime.actions.length,
          providerCount: runtime.providers.length,
          evaluatorCount: runtime.evaluators.length,
          serviceTypeCount: servicesMap.size,
          serviceCount,
        },
        order: {
          plugins: orderPlugins,
          actions: orderActions,
          providers: orderProviders,
          evaluators: orderEvaluators,
          services: orderServices,
        },
        sections: {
          runtime: serializeForRuntimeDebug(runtime, serializeOptions),
          plugins: serializeForRuntimeDebug(runtime.plugins, serializeOptions),
          actions: serializeForRuntimeDebug(runtime.actions, serializeOptions),
          providers: serializeForRuntimeDebug(
            runtime.providers,
            serializeOptions,
          ),
          evaluators: serializeForRuntimeDebug(
            runtime.evaluators,
            serializeOptions,
          ),
          services: serializeForRuntimeDebug(servicesMap, serializeOptions),
        },
      });
    } catch (err) {
      error(
        res,
        `Failed to build runtime debug snapshot: ${err instanceof Error ? err.message : String(err)}`,
        500,
      );
    }
    return;
  }

  // ── GET /api/onboarding/status ──────────────────────────────────────────
  if (method === "GET" && pathname === "/api/onboarding/status") {
    let config = state.config;
    let complete = configFileExists() && hasPersistedOnboardingState(config);

    // Hot restarts and transient config-load failures can leave state.config
    // stale even though the persisted config is valid. Re-read from disk once
    // before telling the client to fall back into onboarding.
    if (!complete && configFileExists()) {
      try {
        config = loadElizaConfig();
        complete = hasPersistedOnboardingState(config);
        if (complete) {
          state.config = config;
        }
      } catch (err) {
        logger.warn(
          `[milady-api] Failed to refresh config for onboarding status: ${err instanceof Error ? err.message : err}`,
        );
      }
    }
    json(res, { complete });
    return;
  }

  // ── GET /api/onboarding/options ─────────────────────────────────────────
  if (method === "GET" && pathname === "/api/onboarding/options") {
    let piAiModels: Array<{
      id: string;
      name: string;
      provider: string;
      isDefault: boolean;
    }> = [];
    let piAiDefaultModel: string | null = null;

    try {
      const piAi = await (await loadPiAiPluginModule()).listPiAiModelOptions();
      piAiModels = piAi.models;
      piAiDefaultModel = piAi.defaultModelSpec ?? null;
    } catch (err) {
      logger.warn(
        `[api] Failed to load pi-ai model options: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    json(res, {
      names: pickRandomNames(5),
      styles: STYLE_PRESETS,
      providers: getProviderOptions(),
      cloudProviders: getCloudProviderOptions(),
      models: getModelOptions(),
      piAiModels,
      piAiDefaultModel,
      inventoryProviders: getInventoryProviderOptions(),
      sharedStyleRules: "Keep responses brief. Be helpful and concise.",
      githubOAuthAvailable: Boolean(process.env.GITHUB_OAUTH_CLIENT_ID?.trim()),
    });
    return;
  }

  // ── POST /api/onboarding ────────────────────────────────────────────────
  if (method === "POST" && pathname === "/api/onboarding") {
    const body = await readJsonBody(req, res);
    if (!body) return;

    // ── Validate required fields ──────────────────────────────────────────
    if (!body.name || typeof body.name !== "string" || !body.name.trim()) {
      error(res, "Missing or invalid agent name", 400);
      return;
    }
    // Theme is UI-only (milady, haxor, qt314, etc.) — no server validation needed
    if (body.runMode && body.runMode !== "local" && body.runMode !== "cloud") {
      error(res, "Invalid runMode: must be 'local' or 'cloud'", 400);
      return;
    }

    const config = state.config;

    if (!config.agents) config.agents = {};
    if (!config.agents.defaults) config.agents.defaults = {};
    config.agents.defaults.workspace = resolveDefaultAgentWorkspaceDir();
    const onboardingAdminEntityId = stringToUuid(
      `${(body.name as string).trim()}-admin-entity`,
    ) as UUID;
    config.agents.defaults.adminEntityId = onboardingAdminEntityId;
    state.adminEntityId = onboardingAdminEntityId;
    state.chatUserId = onboardingAdminEntityId;
    state.chatConnectionReady = null;
    state.chatConnectionPromise = null;

    if (!config.agents.list) config.agents.list = [];
    if (config.agents.list.length === 0) {
      config.agents.list.push({ id: "main", default: true });
    }
    const agent = config.agents.list[0];
    agent.name = (body.name as string).trim();
    agent.workspace = resolveDefaultAgentWorkspaceDir();
    if (body.bio) agent.bio = body.bio as string[];
    if (body.systemPrompt) agent.system = body.systemPrompt as string;
    if (body.style)
      agent.style = body.style as {
        all?: string[];
        chat?: string[];
        post?: string[];
      };
    if (body.adjectives) agent.adjectives = body.adjectives as string[];
    if (body.topics) {
      (agent as Record<string, unknown>).topics = body.topics as string[];
    }
    if (body.postExamples) agent.postExamples = body.postExamples as string[];
    if (body.messageExamples) {
      // Normalise to the {examples: [{name, content}]} format that @elizaos/core expects.
      const raw = body.messageExamples as unknown[];
      agent.messageExamples = raw.map((item) => {
        if (
          item &&
          typeof item === "object" &&
          "examples" in (item as Record<string, unknown>)
        ) {
          return item as {
            examples: { name: string; content: { text: string } }[];
          };
        }
        // Old format: [{user, content}, ...] → {examples: [{name, content}, ...]}
        const arr = item as {
          user?: string;
          name?: string;
          content: { text: string };
        }[];
        return {
          examples: arr.map((m) => ({
            name: m.name ?? m.user ?? "",
            content: m.content,
          })),
        };
        // biome-ignore lint/suspicious/noExplicitAny: mixed legacy/new formats
      }) as any;
    }

    // ── Theme preference ──────────────────────────────────────────────────
    if (body.theme) {
      if (!config.ui) config.ui = {};
      config.ui.theme = body.theme as
        | "eliza"
        | "qt314"
        | "web2000"
        | "programmer"
        | "haxor"
        | "psycho";
    }

    // ── Run mode & cloud configuration ────────────────────────────────────
    const runMode = (body.runMode as string) || "local";
    if (!config.cloud) config.cloud = {};
    config.cloud.enabled = runMode === "cloud";

    // ── Sandbox mode (from 3-mode onboarding: off / light / standard / max)
    const sandboxMode = (body.sandboxMode as string) || "off";
    if (sandboxMode !== "off") {
      if (!config.agents) config.agents = {};
      if (!config.agents.defaults) config.agents.defaults = {};
      if (!(config.agents.defaults as Record<string, unknown>).sandbox) {
        (config.agents.defaults as Record<string, unknown>).sandbox = {};
      }
      (
        (config.agents.defaults as Record<string, unknown>).sandbox as Record<
          string,
          unknown
        >
      ).mode = sandboxMode;
      logger.info(`[milady-api] Sandbox mode set to: ${sandboxMode}`);
    }

    if (runMode === "cloud") {
      if (body.cloudProvider) {
        config.cloud.provider = body.cloudProvider as string;
      }
      if (
        typeof body.providerApiKey === "string" &&
        body.providerApiKey.trim().length > 0
      ) {
        const cloudApiKey = body.providerApiKey.trim();
        config.cloud.apiKey = cloudApiKey;
        process.env.ELIZAOS_CLOUD_API_KEY = cloudApiKey;
      }
      // Always ensure model defaults when cloud is selected so the cloud
      // plugin has valid models to call even if the user didn't pick unknown.
      if (!config.models) config.models = {};
      config.models.small =
        (body.smallModel as string) ||
        config.models.small ||
        "openai/gpt-5-mini";
      config.models.large =
        (body.largeModel as string) ||
        config.models.large ||
        "anthropic/claude-sonnet-4.5";
    }

    // ── Local LLM provider ────────────────────────────────────────────────
    {
      if (!config.env) config.env = {};
      const envCfg = config.env as Record<string, unknown>;
      const vars = (envCfg.vars ?? {}) as Record<string, string>;
      const providerId = typeof body.provider === "string" ? body.provider : "";

      // Persist vars back onto config.env
      (envCfg as Record<string, unknown>).vars = vars;

      const clearPiAiFlag = () => {
        delete vars.MILADY_USE_PI_AI;
        delete (config.env as Record<string, string>).MILADY_USE_PI_AI;
        delete process.env.MILADY_USE_PI_AI;
      };

      if (runMode === "local" && providerId === "pi-ai") {
        vars.MILADY_USE_PI_AI = "1";
        process.env.MILADY_USE_PI_AI = "1";

        // Optional primary model override (provider/model).
        if (!config.agents) config.agents = {};
        if (!config.agents.defaults) config.agents.defaults = {};
        const defaults = config.agents.defaults as Record<string, unknown>;
        const modelConfig = (defaults.model ?? {}) as Record<string, unknown>;
        const primaryModel =
          typeof body.primaryModel === "string" ? body.primaryModel.trim() : "";

        if (primaryModel) {
          modelConfig.primary = primaryModel;
        } else {
          delete modelConfig.primary;
        }

        defaults.model = modelConfig;
      } else {
        clearPiAiFlag();
      }

      // API-key providers (envKey backed)
      if (runMode === "local" && providerId && body.providerApiKey) {
        const providerOpt = getProviderOptions().find(
          (p) => p.id === providerId,
        );
        if (providerOpt?.envKey) {
          (config.env as Record<string, string>)[providerOpt.envKey] =
            body.providerApiKey as string;
          process.env[providerOpt.envKey] = body.providerApiKey as string;
        }
      }
    }

    // ── Subscription providers (no API key needed — uses OAuth) ──────────
    // If the user selected a subscription provider during onboarding,
    // note it in config. The actual OAuth flow happens via
    // /api/subscription/{provider}/start + /exchange endpoints.
    if (
      runMode === "local" &&
      (body.provider === "anthropic-subscription" ||
        body.provider === "openai-subscription")
    ) {
      if (!config.agents) config.agents = {};
      if (!config.agents.defaults) config.agents.defaults = {};
      (config.agents.defaults as Record<string, unknown>).subscriptionProvider =
        body.provider;
      logger.info(
        `[milady-api] Subscription provider selected: ${body.provider} — complete OAuth via /api/subscription/ endpoints`,
      );

      // Handle Anthropic setup token (sk-ant-oat01-...) provided during
      // onboarding. The API-key gate above skips subscription providers
      // because their envKey is null. Mirrors POST /api/subscription/
      // anthropic/setup-token in subscription-routes.ts.
      if (
        body.provider === "anthropic-subscription" &&
        typeof body.providerApiKey === "string" &&
        body.providerApiKey.trim().startsWith("sk-ant-")
      ) {
        const token = body.providerApiKey.trim();
        if (!config.env) config.env = {};
        (config.env as Record<string, string>).ANTHROPIC_API_KEY = token;
        process.env.ANTHROPIC_API_KEY = token;
        logger.info(
          "[milady-api] Anthropic setup token saved during onboarding",
        );
      }
    }

    // ── GitHub token ────────────────────────────────────────────────────
    if (
      body.githubToken &&
      typeof body.githubToken === "string" &&
      body.githubToken.trim()
    ) {
      if (!config.env) config.env = {};
      (config.env as Record<string, string>).GITHUB_TOKEN =
        body.githubToken.trim();
      process.env.GITHUB_TOKEN = body.githubToken.trim();
    }

    // ── Connectors (Telegram, Discord, WhatsApp, Twilio, Blooio) ────────
    if (!config.connectors) config.connectors = {};
    if (
      body.telegramToken &&
      typeof body.telegramToken === "string" &&
      body.telegramToken.trim()
    ) {
      config.connectors.telegram = { botToken: body.telegramToken.trim() };
    }
    if (
      body.discordToken &&
      typeof body.discordToken === "string" &&
      body.discordToken.trim()
    ) {
      config.connectors.discord = { token: body.discordToken.trim() };
    }
    if (
      body.whatsappSessionPath &&
      typeof body.whatsappSessionPath === "string" &&
      body.whatsappSessionPath.trim()
    ) {
      config.connectors.whatsapp = {
        sessionPath: body.whatsappSessionPath.trim(),
      };
    }
    if (
      body.twilioAccountSid &&
      typeof body.twilioAccountSid === "string" &&
      body.twilioAccountSid.trim() &&
      body.twilioAuthToken &&
      typeof body.twilioAuthToken === "string" &&
      body.twilioAuthToken.trim()
    ) {
      if (!config.env) config.env = {};
      (config.env as Record<string, string>).TWILIO_ACCOUNT_SID = (
        body.twilioAccountSid as string
      ).trim();
      (config.env as Record<string, string>).TWILIO_AUTH_TOKEN = (
        body.twilioAuthToken as string
      ).trim();
      process.env.TWILIO_ACCOUNT_SID = (body.twilioAccountSid as string).trim();
      process.env.TWILIO_AUTH_TOKEN = (body.twilioAuthToken as string).trim();
      if (
        body.twilioPhoneNumber &&
        typeof body.twilioPhoneNumber === "string" &&
        body.twilioPhoneNumber.trim()
      ) {
        (config.env as Record<string, string>).TWILIO_PHONE_NUMBER = (
          body.twilioPhoneNumber as string
        ).trim();
        process.env.TWILIO_PHONE_NUMBER = (
          body.twilioPhoneNumber as string
        ).trim();
      }
    }
    if (
      body.blooioApiKey &&
      typeof body.blooioApiKey === "string" &&
      body.blooioApiKey.trim()
    ) {
      if (!config.env) config.env = {};
      const trimmedKey = (body.blooioApiKey as string).trim();
      (config.env as Record<string, string>).BLOOIO_API_KEY = trimmedKey;
      process.env.BLOOIO_API_KEY = trimmedKey;

      const blooioConnector: Record<string, string> = { apiKey: trimmedKey };

      if (
        body.blooioPhoneNumber &&
        typeof body.blooioPhoneNumber === "string" &&
        body.blooioPhoneNumber.trim()
      ) {
        const trimmedPhone = (body.blooioPhoneNumber as string).trim();
        (config.env as Record<string, string>).BLOOIO_PHONE_NUMBER =
          trimmedPhone;
        process.env.BLOOIO_PHONE_NUMBER = trimmedPhone;
        blooioConnector.fromNumber = trimmedPhone;
      }

      config.connectors.blooio = blooioConnector;
    }

    // ── Inventory / RPC providers ─────────────────────────────────────────
    if (Array.isArray(body.inventoryProviders)) {
      if (!config.env) config.env = {};
      const allInventory = getInventoryProviderOptions();
      for (const inv of body.inventoryProviders as Array<{
        chain: string;
        rpcProvider: string;
        rpcApiKey?: string;
      }>) {
        const chainDef = allInventory.find((ip) => ip.id === inv.chain);
        if (!chainDef) continue;
        const rpcDef = chainDef.rpcProviders.find(
          (rp) => rp.id === inv.rpcProvider,
        );
        if (rpcDef?.envKey && inv.rpcApiKey) {
          (config.env as Record<string, string>)[rpcDef.envKey] = inv.rpcApiKey;
          process.env[rpcDef.envKey] = inv.rpcApiKey;
        }
      }
    }

    // ── Ensure wallet keys exist so inventory can resolve addresses ───────
    ensureWalletKeysInEnvAndConfig(config);

    if (!config.meta) {
      config.meta = {};
    }
    config.meta.onboardingComplete = true;

    state.config = config;
    state.agentName = (body.name as string) ?? state.agentName;
    try {
      saveElizaConfig(config);
    } catch (err) {
      logger.error(
        `[milady-api] Failed to save config after onboarding: ${err}`,
      );
      error(res, "Failed to save configuration", 500);
      return;
    }

    // Post-save verification: ensure the config file actually landed on disk.
    // This catches silent write failures that previously caused onboarding
    // to repeat on every restart.
    if (!configFileExists()) {
      logger.error(
        `[milady-api] Config file does not exist after save — onboarding data will be lost on restart`,
      );
      error(res, "Configuration file was not persisted to disk", 500);
      return;
    }

    logger.info(
      `[milady-api] Onboarding complete for agent "${body.name}" (mode: ${(body.runMode as string) || "local"})`,
    );
    json(res, { ok: true });
    return;
  }

  if (
    await handleAgentLifecycleRoutes({
      req,
      res,
      method,
      pathname,
      state,
      error,
      json,
      readJsonBody,
    })
  ) {
    return;
  }

  const triggerHandled = await handleTriggerRoutes({
    req,
    res,
    method,
    pathname,
    runtime: state.runtime,
    readJsonBody,
    json,
    error,
    executeTriggerTask: executeTriggerTask as never,
    getTriggerHealthSnapshot,
    getTriggerLimit: getTriggerLimit as never,
    listTriggerTasks: listTriggerTasks as never,
    readTriggerConfig,
    readTriggerRuns,
    taskToTriggerSummary: taskToTriggerSummary as never,
    triggersFeatureEnabled,
    buildTriggerConfig: buildTriggerConfig as never,
    buildTriggerMetadata: buildTriggerMetadata as never,
    normalizeTriggerDraft: normalizeTriggerDraft as never,
    DISABLED_TRIGGER_INTERVAL_MS,
    TRIGGER_TASK_NAME,
    TRIGGER_TASK_TAGS: [...TRIGGER_TASK_TAGS],
  });
  if (triggerHandled) {
    return;
  }

  if (pathname.startsWith("/api/training")) {
    if (!state.trainingService) {
      error(res, "Training service is not available", 503);
      return;
    }
    const trainingHandled = await handleTrainingRoutes({
      req,
      res,
      method,
      pathname,
      runtime: state.runtime,
      trainingService: state.trainingService,
      readJsonBody,
      json,
      error,
      isLoopbackHost,
    });
    if (trainingHandled) return;
  }

  // ── Knowledge routes (/api/knowledge/*) ─────────────────────────────────
  if (pathname.startsWith("/api/knowledge")) {
    const knowledgeHandled = await handleKnowledgeRoutes({
      req,
      res,
      method,
      pathname,
      url,
      runtime: state.runtime,
      readJsonBody,
      json,
      error,
    });
    if (knowledgeHandled) return;
  }

  if (pathname.startsWith("/api/memory") || pathname === "/api/context/quick") {
    const memoryHandled = await handleMemoryRoutes({
      req,
      res,
      method,
      pathname,
      url,
      runtime: state.runtime,
      agentName: state.agentName,
      readJsonBody,
      json,
      error,
    });
    if (memoryHandled) return;
  }

  if (
    await handleAgentAdminRoutes({
      req,
      res,
      method,
      pathname,
      state,
      onRestart: ctx?.onRestart ?? undefined,
      onRuntimeSwapped: ctx?.onRuntimeSwapped,
      json,
      error,
      resolveStateDir,
      resolvePath: path.resolve,
      getHomeDir: os.homedir,
      isSafeResetStateDir,
      stateDirExists: fs.existsSync,
      removeStateDir: (resolvedState) => {
        fs.rmSync(resolvedState, { recursive: true, force: true });
      },
      logWarn: (message) => logger.warn(message),
    })
  ) {
    return;
  }

  if (
    await handleAgentTransferRoutes({
      req,
      res,
      method,
      pathname,
      state,
      readJsonBody,
      json,
      error,
      exportAgent,
      estimateExportSize,
      importAgent,
      isAgentExportError: (err: unknown) => err instanceof AgentExportError,
    })
  ) {
    return;
  }

  if (
    await handleCharacterRoutes({
      req,
      res,
      method,
      pathname,
      state,
      readJsonBody,
      json,
      error,
      pickRandomNames,
      saveConfig: saveElizaConfig as never,
      validateCharacter: (body) => CharacterSchema.safeParse(body) as never,
    })
  ) {
    return;
  }

  if (
    await handleModelsRoutes({
      req,
      res,
      method,
      pathname,
      url,
      json,
      providerCachePath,
      getOrFetchProvider,
      getOrFetchAllProviders,
      resolveModelsCacheDir,
      pathExists: fs.existsSync,
      readDir: fs.readdirSync,
      unlinkFile: fs.unlinkSync,
      joinPath: path.join,
    })
  ) {
    return;
  }

  if (
    await handleNfaRoutes({
      req,
      res,
      method,
      pathname,
      json,
      error,
    })
  ) {
    return;
  }

  if (
    await handleRegistryRoutes({
      req,
      res,
      method,
      pathname,
      url,
      json,
      error,
      getPluginManager: () => requirePluginManager(state.runtime) as never,
      getLoadedPluginNames: () =>
        state.runtime?.plugins.map((plugin) => plugin.name) ?? [],
      getBundledPluginIds: () => getReleaseBundledPluginIds(),
      classifyRegistryPluginRelease,
    })
  ) {
    return;
  }

  // ── GET /api/plugins ────────────────────────────────────────────────────
  if (method === "GET" && pathname === "/api/plugins") {
    // Re-read config from disk so we pick up plugins installed since server start.
    let freshConfig: ElizaConfig;
    try {
      freshConfig = loadElizaConfig();
    } catch {
      freshConfig = state.config;
    }

    // Merge user-installed plugins into the list (they don't exist in plugins.json)
    const bundledIds = new Set(state.plugins.map((p) => p.id));
    const installedEntries = discoverInstalledPlugins(freshConfig, bundledIds);
    const allPlugins: PluginEntry[] = [...state.plugins, ...installedEntries];

    // Resolve enabled state from config and loaded state from runtime.
    // "enabled" = user wants it active (config). "isActive" = actually loaded.
    const configEntries = (
      freshConfig.plugins as Record<string, unknown> | undefined
    )?.entries as Record<string, { enabled?: boolean }> | undefined;
    const loadedNames = state.runtime
      ? state.runtime.plugins.map((p) => p.name)
      : [];
    for (const plugin of allPlugins) {
      const suffix = `plugin-${plugin.id}`;
      const packageName = `@elizaos/plugin-${plugin.id}`;
      const npmPkgName = plugin.npmName;
      const isLoaded =
        loadedNames.length > 0 &&
        loadedNames.some((name) => {
          return (
            name === plugin.id ||
            name === suffix ||
            name === packageName ||
            (npmPkgName != null && name === npmPkgName) ||
            name.endsWith(`/${suffix}`) ||
            name.includes(plugin.id)
          );
        });
      plugin.isActive = isLoaded;
      // Set enabled from config if available, otherwise from runtime
      const configEntry = configEntries?.[plugin.id];
      if (configEntry && typeof configEntry.enabled === "boolean") {
        plugin.enabled = configEntry.enabled;
      } else {
        plugin.enabled = isLoaded;
      }
      // Detect installed-but-failed-to-load plugins
      plugin.loadError = undefined;
      if (plugin.enabled && !isLoaded && state.runtime) {
        const installs = freshConfig.plugins?.installs as
          | Record<string, unknown>
          | undefined;
        const packageName = `@elizaos/plugin-${plugin.id}`;
        const hasInstallRecord =
          installs?.[packageName] || installs?.[plugin.id];
        if (hasInstallRecord) {
          plugin.loadError =
            "Plugin installed but failed to load — the package may be missing compiled files.";
        }
      }
    }

    // Always refresh current env values and re-validate
    for (const plugin of allPlugins) {
      for (const param of plugin.parameters) {
        const envValue = process.env[param.key];
        param.isSet = Boolean(envValue?.trim());
        param.currentValue = param.isSet
          ? param.sensitive
            ? maskValue(envValue ?? "")
            : (envValue ?? "")
          : null;
      }
      const paramInfos: PluginParamInfo[] = plugin.parameters.map((p) => ({
        key: p.key,
        required: p.required,
        sensitive: p.sensitive,
        type: p.type,
        description: p.description,
        default: p.default,
      }));
      const validation = validatePluginConfig(
        plugin.id,
        plugin.category,
        plugin.envKey,
        plugin.configKeys,
        undefined,
        paramInfos,
      );
      plugin.validationErrors = validation.errors;
      plugin.validationWarnings = validation.warnings;
    }

    applyWhatsAppQrOverride(allPlugins, resolveDefaultAgentWorkspaceDir());
    applySignalQrOverride(
      allPlugins,
      resolveDefaultAgentWorkspaceDir(),
      signalAuthExists,
    );

    // Inject per-provider model options into configUiHints for MODEL fields.
    // Each provider's cache is independent — no cross-population.
    // Always set type: "select" on MODEL fields so they render as dropdowns,
    // even when no models are cached yet (empty dropdown prompts user to fetch).
    for (const plugin of allPlugins) {
      const providerModels = readProviderCache(plugin.id)?.models ?? [];

      for (const param of plugin.parameters) {
        if (!param.key.toUpperCase().includes("MODEL")) continue;

        // Filter to the category this field expects (chat, embedding, image, etc.)
        const expectedCat = paramKeyToCategory(param.key);
        const filtered = providerModels.filter(
          (m) => m.category === expectedCat,
        );

        if (!plugin.configUiHints) plugin.configUiHints = {};
        plugin.configUiHints[param.key] = {
          ...plugin.configUiHints[param.key],
          type: "select",
          options: filtered.map((m) => ({
            value: m.id,
            label: m.name !== m.id ? `${m.name} (${m.id})` : m.id,
          })),
        };
      }
    }

    json(res, { plugins: allPlugins });
    return;
  }

  // ── PUT /api/plugins/:id ────────────────────────────────────────────────
  if (method === "PUT" && pathname.startsWith("/api/plugins/")) {
    const pluginId = pathname.slice("/api/plugins/".length);
    const body = await readJsonBody<{
      enabled?: boolean;
      config?: Record<string, string>;
    }>(req, res);
    if (!body) return;

    // Search both bundled plugins AND store-installed plugins
    let plugin = state.plugins.find((p) => p.id === pluginId);
    if (!plugin) {
      // Check store-installed plugins from config
      let freshCfg: ElizaConfig;
      try {
        freshCfg = loadElizaConfig();
      } catch {
        freshCfg = state.config;
      }
      const bundledIds = new Set(state.plugins.map((p) => p.id));
      const installed = discoverInstalledPlugins(freshCfg, bundledIds);
      const found = installed.find((p) => p.id === pluginId);
      if (found) {
        // Temporarily add to state.plugins so toggle logic works the same way
        state.plugins.push(found);
        plugin = found;
      }
    }
    if (!plugin) {
      error(res, `Plugin "${pluginId}" not found`, 404);
      return;
    }

    if (body.enabled !== undefined) {
      plugin.enabled = body.enabled;
    }
    if (body.config) {
      const configRejections = resolvePluginConfigMutationRejections(
        plugin.parameters,
        body.config,
      );
      if (configRejections.length > 0) {
        json(
          res,
          { ok: false, plugin, validationErrors: configRejections },
          422,
        );
        return;
      }

      // Only validate the fields actually being submitted — not all required
      // fields. Users may save partial config (e.g. just the API key) from
      // the Settings page; blocking the save because OTHER required fields
      // aren't set yet is counterproductive.
      const configObj = body.config;
      const submittedParamInfos: PluginParamInfo[] = plugin.parameters
        .filter((p) => p.key in configObj)
        .map((p) => ({
          key: p.key,
          required: p.required,
          sensitive: p.sensitive,
          type: p.type,
          description: p.description,
          default: p.default,
        }));
      const configValidation = validatePluginConfig(
        pluginId,
        plugin.category,
        plugin.envKey,
        plugin.configKeys,
        body.config,
        submittedParamInfos,
      );

      if (!configValidation.valid) {
        json(
          res,
          { ok: false, plugin, validationErrors: configValidation.errors },
          422,
        );
        return;
      }

      const allowedParamKeys = new Set(plugin.parameters.map((p) => p.key));

      // Persist config values to state.config.env so they survive restarts
      if (!state.config.env) {
        state.config.env = {};
      }
      for (const [key, value] of Object.entries(body.config)) {
        if (
          allowedParamKeys.has(key) &&
          !BLOCKED_ENV_KEYS.has(key.toUpperCase()) &&
          typeof value === "string" &&
          value.trim()
        ) {
          process.env[key] = value;
          (state.config.env as Record<string, unknown>)[key] = value;
        }
      }
      plugin.configured = true;

      // Save config even when only config values changed (no enable toggle)
      if (body.enabled === undefined) {
        try {
          saveElizaConfig(state.config);
        } catch (err) {
          logger.warn(
            `[milady-api] Failed to save config: ${err instanceof Error ? err.message : err}`,
          );
        }
      }
    }

    // Refresh validation
    const refreshParamInfos: PluginParamInfo[] = plugin.parameters.map((p) => ({
      key: p.key,
      required: p.required,
      sensitive: p.sensitive,
      type: p.type,
      description: p.description,
      default: p.default,
    }));
    const updated = validatePluginConfig(
      pluginId,
      plugin.category,
      plugin.envKey,
      plugin.configKeys,
      undefined,
      refreshParamInfos,
    );
    plugin.validationErrors = updated.errors;
    plugin.validationWarnings = updated.warnings;

    // Update config.plugins.entries so the runtime loads/skips this plugin
    if (body.enabled !== undefined) {
      const packageName = `@elizaos/plugin-${pluginId}`;

      if (!state.config.plugins) {
        state.config.plugins = {};
      }
      if (!state.config.plugins.entries) {
        (state.config.plugins as Record<string, unknown>).entries = {};
      }

      const entries = (state.config.plugins as Record<string, unknown>)
        .entries as Record<string, Record<string, unknown>>;
      entries[pluginId] = { enabled: body.enabled };
      logger.info(
        `[milady-api] ${body.enabled ? "Enabled" : "Disabled"} plugin: ${packageName}`,
      );

      // Persist capability toggle state in config.features so the runtime
      // can gate related behaviour (e.g. disabling image description when
      // vision is toggled off).
      const CAPABILITY_FEATURE_IDS = new Set([
        "vision",
        "browser",
        "computeruse",
        "coding-agent",
      ]);
      if (CAPABILITY_FEATURE_IDS.has(pluginId)) {
        if (!state.config.features) {
          state.config.features = {};
        }
        state.config.features[pluginId] = body.enabled;
      }

      // Save updated config
      try {
        saveElizaConfig(state.config);
      } catch (err) {
        logger.warn(
          `[milady-api] Failed to save config: ${err instanceof Error ? err.message : err}`,
        );
      }

      scheduleRuntimeRestart(`Plugin toggle: ${pluginId}`);
    }

    json(res, { ok: true, plugin });
    return;
  }

  // ── GET /api/secrets ─────────────────────────────────────────────────
  if (method === "GET" && pathname === "/api/secrets") {
    // Merge bundled + installed plugins for full parameter coverage
    const bundledIds = new Set(state.plugins.map((p) => p.id));
    const installedEntries = discoverInstalledPlugins(state.config, bundledIds);
    const allPlugins: PluginEntry[] = [...state.plugins, ...installedEntries];

    // Sync enabled status from runtime (same logic as GET /api/plugins)
    if (state.runtime) {
      const loadedNames = state.runtime.plugins.map((p) => p.name);
      for (const plugin of allPlugins) {
        const suffix = `plugin-${plugin.id}`;
        const packageName = `@elizaos/plugin-${plugin.id}`;
        plugin.enabled = loadedNames.some(
          (name) =>
            name === plugin.id ||
            name === suffix ||
            name === packageName ||
            name.endsWith(`/${suffix}`) ||
            name.includes(plugin.id),
        );
      }
    }

    const secrets = aggregateSecrets(allPlugins);
    json(res, { secrets });
    return;
  }

  // ── PUT /api/secrets ─────────────────────────────────────────────────
  if (method === "PUT" && pathname === "/api/secrets") {
    const body = await readJsonBody<{ secrets: Record<string, string> }>(
      req,
      res,
    );
    if (!body) return;
    if (!body.secrets || typeof body.secrets !== "object") {
      error(res, "Missing or invalid 'secrets' object", 400);
      return;
    }

    // Build allowlist from all plugin-declared sensitive params
    const bundledIds = new Set(state.plugins.map((p) => p.id));
    const installedEntries = discoverInstalledPlugins(state.config, bundledIds);
    const allPlugins: PluginEntry[] = [...state.plugins, ...installedEntries];
    const allowedKeys = new Set<string>();
    for (const plugin of allPlugins) {
      for (const param of plugin.parameters) {
        if (param.sensitive) allowedKeys.add(param.key);
      }
    }

    const updated: string[] = [];
    for (const [key, value] of Object.entries(body.secrets)) {
      if (typeof value !== "string" || !value.trim()) continue;
      if (!allowedKeys.has(key)) continue;
      if (BLOCKED_ENV_KEYS.has(key.toUpperCase())) continue;
      process.env[key] = value;
      updated.push(key);
    }

    // Mark affected plugins as configured
    for (const plugin of allPlugins) {
      const pluginKeys = new Set(plugin.parameters.map((p) => p.key));
      if (updated.some((k) => pluginKeys.has(k))) {
        plugin.configured = true;
      }
    }

    json(res, { ok: true, updated });
    return;
  }

  // ── POST /api/plugins/:id/test ────────────────────────────────────────
  // Test a plugin's connection / configuration validity.
  const pluginTestMatch =
    method === "POST" && pathname.match(/^\/api\/plugins\/([^/]+)\/test$/);
  if (pluginTestMatch) {
    const pluginId = decodeURIComponent(pluginTestMatch[1]);
    const startMs = Date.now();

    try {
      // Find the plugin in the runtime
      const allPlugins = state.runtime?.plugins ?? [];
      const normalizePluginId = (value: string): string =>
        value.replace(/^@[^/]+\//, "").replace(/^plugin-/, "");

      const normalizedPluginId = normalizePluginId(pluginId);

      const plugin = allPlugins.find((p: { id?: string; name?: string }) => {
        const runtimeName = p.name ?? "";
        const runtimeId = normalizePluginId(runtimeName);
        return (
          p.id === pluginId ||
          p.name === pluginId ||
          runtimeId === pluginId ||
          runtimeId === normalizedPluginId
        );
      });

      if (!plugin) {
        json(
          res,
          {
            success: false,
            pluginId,
            error: "Plugin not found or not loaded",
            durationMs: Date.now() - startMs,
          },
          404,
        );
        return;
      }

      // Check if plugin exposes a test/health method
      const testFn =
        (plugin as unknown as Record<string, unknown>).testConnection ??
        (plugin as unknown as Record<string, unknown>).healthCheck;
      if (typeof testFn === "function") {
        const result = await (
          testFn as () => Promise<{ ok: boolean; message?: string }>
        )();
        json(res, {
          success: result.ok !== false,
          pluginId,
          message:
            result.message ??
            (result.ok !== false
              ? "Connection successful"
              : "Connection failed"),
          durationMs: Date.now() - startMs,
        });
        return;
      }

      // No test function — return a basic "plugin is loaded" status
      json(res, {
        success: true,
        pluginId,
        message: "Plugin is loaded and active (no custom test available)",
        durationMs: Date.now() - startMs,
      });
    } catch (err) {
      json(
        res,
        {
          success: false,
          pluginId,
          error: err instanceof Error ? err.message : String(err),
          durationMs: Date.now() - startMs,
        },
        500,
      );
    }
    return;
  }

  // ── POST /api/plugins/install ───────────────────────────────────────────
  // Install a plugin from the registry and restart the agent.
  if (method === "POST" && pathname === "/api/plugins/install") {
    const body = await readJsonBody<{ name: string; autoRestart?: boolean }>(
      req,
      res,
    );
    if (!body) return;
    const pluginName = body.name?.trim();

    if (!pluginName) {
      error(res, "Request body must include 'name' (plugin package name)", 400);
      return;
    }

    const npmNamePattern =
      /^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/;
    if (!npmNamePattern.test(pluginName)) {
      error(res, "Invalid plugin name format", 400);
      return;
    }

    try {
      const pluginManager = requirePluginManager(state.runtime);
      const result = await pluginManager.installPlugin(
        pluginName,
        (progress: InstallProgressLike) => {
          logger.info(`[install] ${progress.phase}: ${progress.message}`);
          state.broadcastWs?.({
            type: "install-progress",
            pluginName: progress.pluginName,
            phase: progress.phase,
            message: progress.message,
          });
        },
      );

      if (!result.success) {
        json(res, { ok: false, error: result.error }, 422);
        return;
      }

      // Auto-enable the newly installed plugin so the runtime loads it after restart.
      const installedId = (result.pluginName ?? pluginName)
        .replace(/^@[^/]+\/plugin-/, "")
        .replace(/^@[^/]+\//, "")
        .replace(/^plugin-/, "");
      if (!state.config.plugins) {
        state.config.plugins = {};
      }
      if (!state.config.plugins.entries) {
        (state.config.plugins as Record<string, unknown>).entries = {};
      }
      const pluginEntries = (state.config.plugins as Record<string, unknown>)
        .entries as Record<string, Record<string, unknown>>;
      pluginEntries[installedId] = { enabled: true };
      try {
        saveElizaConfig(state.config);
      } catch (err) {
        logger.warn(
          `[milady-api] Failed to save config after install: ${err instanceof Error ? err.message : err}`,
        );
      }

      // If autoRestart is not explicitly false, restart the agent
      if (body.autoRestart !== false && result.requiresRestart) {
        scheduleRuntimeRestart(`Plugin ${result.pluginName} installed`);
      }

      json(res, {
        ok: true,
        plugin: {
          name: result.pluginName,
          version: result.version,
          installPath: result.installPath,
        },
        requiresRestart: result.requiresRestart,
        message: result.requiresRestart
          ? `${result.pluginName} installed. Agent will restart to load it.`
          : `${result.pluginName} installed.`,
      });
    } catch (err) {
      error(
        res,
        `Install failed: ${err instanceof Error ? err.message : String(err)}`,
        500,
      );
    }
    return;
  }

  // ── POST /api/plugins/uninstall ─────────────────────────────────────────
  if (method === "POST" && pathname === "/api/plugins/uninstall") {
    const body = await readJsonBody<{ name: string; autoRestart?: boolean }>(
      req,
      res,
    );
    if (!body) return;
    const pluginName = body.name?.trim();

    if (!pluginName) {
      error(res, "Request body must include 'name' (plugin package name)", 400);
      return;
    }

    try {
      const pluginManager = requirePluginManager(state.runtime);
      const result = await pluginManager.uninstallPlugin(pluginName);

      if (!result.success) {
        json(res, { ok: false, error: result.error }, 422);
        return;
      }

      if (body.autoRestart !== false && result.requiresRestart) {
        scheduleRuntimeRestart(`Plugin ${pluginName} uninstalled`);
      }

      json(res, {
        ok: true,
        pluginName: result.pluginName,
        requiresRestart: result.requiresRestart,
        message: result.requiresRestart
          ? `${pluginName} uninstalled. Agent will restart.`
          : `${pluginName} uninstalled.`,
      });
    } catch (err) {
      error(
        res,
        `Uninstall failed: ${err instanceof Error ? err.message : String(err)}`,
        500,
      );
    }
    return;
  }

  // ── POST /api/plugins/:id/eject ─────────────────────────────────────────
  if (method === "POST" && pathname.match(/^\/api\/plugins\/[^/]+\/eject$/)) {
    const pluginName = decodeURIComponent(
      pathname.slice("/api/plugins/".length, pathname.length - "/eject".length),
    );
    try {
      const pluginManager = requirePluginManager(state.runtime);
      // Ensure the method exists on the service (it should)
      if (typeof pluginManager.ejectPlugin !== "function") {
        throw new Error("Plugin manager does not support ejecting plugins");
      }
      const result = await pluginManager.ejectPlugin(pluginName);
      if (!result.success) {
        json(res, { ok: false, error: result.error }, 422);
        return;
      }
      if (result.requiresRestart) {
        scheduleRuntimeRestart(`Plugin ${pluginName} ejected`);
      }
      json(res, {
        ok: true,
        pluginName: result.pluginName,
        requiresRestart: result.requiresRestart,
        message: `${pluginName} ejected to local source.`,
      });
    } catch (err) {
      error(
        res,
        `Eject failed: ${err instanceof Error ? err.message : String(err)}`,
        500,
      );
    }
    return;
  }

  // ── POST /api/plugins/:id/sync ──────────────────────────────────────────
  if (method === "POST" && pathname.match(/^\/api\/plugins\/[^/]+\/sync$/)) {
    const pluginName = decodeURIComponent(
      pathname.slice("/api/plugins/".length, pathname.length - "/sync".length),
    );
    try {
      const pluginManager = requirePluginManager(state.runtime);
      if (typeof pluginManager.syncPlugin !== "function") {
        throw new Error("Plugin manager does not support syncing plugins");
      }
      const result = await pluginManager.syncPlugin(pluginName);
      if (!result.success) {
        json(res, { ok: false, error: result.error }, 422);
        return;
      }
      if (result.requiresRestart) {
        scheduleRuntimeRestart(`Plugin ${pluginName} synced`);
      }
      json(res, {
        ok: true,
        pluginName: result.pluginName,
        requiresRestart: result.requiresRestart,
        message: `${pluginName} synced with upstream.`,
      });
    } catch (err) {
      error(
        res,
        `Sync failed: ${err instanceof Error ? err.message : String(err)}`,
        500,
      );
    }
    return;
  }

  // ── POST /api/plugins/:id/reinject ──────────────────────────────────────
  if (
    method === "POST" &&
    pathname.match(/^\/api\/plugins\/[^/]+\/reinject$/)
  ) {
    const pluginName = decodeURIComponent(
      pathname.slice(
        "/api/plugins/".length,
        pathname.length - "/reinject".length,
      ),
    );
    try {
      const pluginManager = requirePluginManager(state.runtime);
      if (typeof pluginManager.reinjectPlugin !== "function") {
        throw new Error("Plugin manager does not support reinjecting plugins");
      }
      const result = await pluginManager.reinjectPlugin(pluginName);
      if (!result.success) {
        json(res, { ok: false, error: result.error }, 422);
        return;
      }
      if (result.requiresRestart) {
        scheduleRuntimeRestart(`Plugin ${pluginName} reinjected`);
      }
      json(res, {
        ok: true,
        pluginName: result.pluginName,
        requiresRestart: result.requiresRestart,
        message: `${pluginName} restored to registry version.`,
      });
    } catch (err) {
      error(
        res,
        `Reinject failed: ${err instanceof Error ? err.message : String(err)}`,
        500,
      );
    }
    return;
  }

  // ── GET /api/plugins/installed ──────────────────────────────────────────
  // List plugins that were installed from the registry at runtime.
  if (method === "GET" && pathname === "/api/plugins/installed") {
    try {
      const pluginManager = requirePluginManager(state.runtime);
      const installed = await pluginManager.listInstalledPlugins();
      json(res, { count: installed.length, plugins: installed });
    } catch (err) {
      error(
        res,
        `Failed to list installed plugins: ${err instanceof Error ? err.message : String(err)}`,
        500,
      );
    }
    return;
  }

  // ── GET /api/plugins/ejected ────────────────────────────────────────────
  // List plugins ejected to local source checkouts with upstream metadata.
  if (method === "GET" && pathname === "/api/plugins/ejected") {
    try {
      const pluginManager = requirePluginManager(state.runtime);
      if (typeof pluginManager.listEjectedPlugins !== "function") {
        throw new Error(
          "Plugin manager does not support listing ejected plugins",
        );
      }
      const plugins = await pluginManager.listEjectedPlugins();
      json(res, { count: plugins.length, plugins });
    } catch (err) {
      error(
        res,
        `Failed to list ejected plugins: ${err instanceof Error ? err.message : String(err)}`,
        500,
      );
    }
    return;
  }

  // ── GET /api/core/status ────────────────────────────────────────────────
  // Returns whether @elizaos/core is ejected or resolved from npm.
  if (method === "GET" && pathname === "/api/core/status") {
    try {
      const coreManager = requireCoreManager(state.runtime);
      const status = await coreManager.getCoreStatus();
      json(res, status);
    } catch (err) {
      error(
        res,
        `Failed to get core status: ${err instanceof Error ? err.message : String(err)}`,
        500,
      );
    }
    return;
  }

  // ── GET /api/plugins/core ────────────────────────────────────────────
  // Returns all core and optional core plugins with their loaded/running status.
  if (method === "GET" && pathname === "/api/plugins/core") {
    // Build a set of loaded plugin names for robust matching.
    // Plugin internal names vary wildly (e.g. "local-ai" for plugin-local-embedding,
    // "eliza-coder" for plugin-code), so we check loaded names against multiple
    // derived forms of the npm package name.
    const loadedNames = state.runtime
      ? new Set(state.runtime.plugins.map((p: { name: string }) => p.name))
      : new Set<string>();

    const isLoaded = (npmName: string): boolean => {
      if (loadedNames.has(npmName)) return true;
      // @elizaos/plugin-foo -> plugin-foo
      const withoutScope = npmName.replace("@elizaos/", "");
      if (loadedNames.has(withoutScope)) return true;
      // plugin-foo -> foo
      const shortId = withoutScope.replace("plugin-", "");
      if (loadedNames.has(shortId)) return true;
      // Check if ANY loaded name contains the short id or vice versa
      for (const n of loadedNames) {
        if (n.includes(shortId) || shortId.includes(n)) return true;
      }
      return false;
    };

    // Check which optional plugins are currently in the allow list
    const allowList = new Set(state.config.plugins?.allow ?? []);

    const makeEntry = (npm: string, isCore: boolean) => {
      const id = npm.replace("@elizaos/plugin-", "");
      return {
        npmName: npm,
        id,
        name: id
          .split("-")
          .map((w: string) => w.charAt(0).toUpperCase() + w.slice(1))
          .join(" "),
        isCore,
        loaded: isLoaded(npm),
        enabled: isCore || allowList.has(npm) || allowList.has(id),
      };
    };

    const coreList = CORE_PLUGINS.map((npm: string) => makeEntry(npm, true));
    const optionalList = OPTIONAL_CORE_PLUGINS.map((npm: string) =>
      makeEntry(npm, false),
    );

    json(res, { core: coreList, optional: optionalList });
    return;
  }

  // ── POST /api/plugins/core/toggle ─────────────────────────────────────
  // Enable or disable an optional core plugin by updating the allow list.
  if (method === "POST" && pathname === "/api/plugins/core/toggle") {
    const body = await readJsonBody<{ npmName: string; enabled: boolean }>(
      req,
      res,
    );
    if (!body || !body.npmName) return;

    // Only allow toggling optional plugins, not core
    const isCorePlugin = (CORE_PLUGINS as readonly string[]).includes(
      body.npmName,
    );
    if (isCorePlugin) {
      error(res, "Core plugins cannot be disabled");
      return;
    }
    const isOptional = (OPTIONAL_CORE_PLUGINS as readonly string[]).includes(
      body.npmName,
    );
    if (!isOptional) {
      error(res, "Unknown optional plugin");
      return;
    }

    // Update the allow list in config
    state.config.plugins = state.config.plugins ?? {};
    state.config.plugins.allow = state.config.plugins.allow ?? [];
    const allow = state.config.plugins.allow;
    const shortId = body.npmName.replace("@elizaos/plugin-", "");

    if (body.enabled) {
      if (!allow.includes(body.npmName) && !allow.includes(shortId)) {
        allow.push(body.npmName);
      }
    } else {
      state.config.plugins.allow = allow.filter(
        (p: string) => p !== body.npmName && p !== shortId,
      );
    }

    try {
      saveElizaConfig(state.config);
    } catch (err) {
      logger.warn(
        `[api] Config save failed: ${err instanceof Error ? err.message : err}`,
      );
    }

    // Auto-restart so the change takes effect
    scheduleRuntimeRestart(
      `Plugin ${shortId} ${body.enabled ? "enabled" : "disabled"}`,
    );

    json(res, {
      ok: true,
      restarting: true,
      message: `${shortId} ${body.enabled ? "enabled" : "disabled"}. Restarting...`,
    });
    return;
  }

  // ── GET /api/skills/catalog ───────────────────────────────────────────
  // Browse the full skill catalog (paginated).
  if (method === "GET" && pathname === "/api/skills/catalog") {
    try {
      const { getCatalogSkills } = await import(
        "../services/skill-catalog-client"
      );
      const all = await getCatalogSkills();
      const page = Math.max(1, Number(url.searchParams.get("page")) || 1);
      const perPage = Math.min(
        100,
        Math.max(1, Number(url.searchParams.get("perPage")) || 50),
      );
      const sort = url.searchParams.get("sort") ?? "downloads";
      const sorted = [...all];
      if (sort === "downloads")
        sorted.sort(
          (a, b) =>
            b.stats.downloads - a.stats.downloads || b.updatedAt - a.updatedAt,
        );
      else if (sort === "stars")
        sorted.sort(
          (a, b) => b.stats.stars - a.stats.stars || b.updatedAt - a.updatedAt,
        );
      else if (sort === "updated")
        sorted.sort((a, b) => b.updatedAt - a.updatedAt);
      else if (sort === "name")
        sorted.sort((a, b) =>
          (a.displayName ?? a.slug).localeCompare(b.displayName ?? b.slug),
        );

      // Resolve installed status from the AgentSkillsService
      const installedSlugs = new Set<string>();
      if (state.runtime) {
        try {
          const svc = state.runtime.getService("AGENT_SKILLS_SERVICE") as
            | {
                getLoadedSkills?: () => Array<{ slug: string; source: string }>;
              }
            | undefined;
          if (svc && typeof svc.getLoadedSkills === "function") {
            for (const s of svc.getLoadedSkills()) {
              installedSlugs.add(s.slug);
            }
          }
        } catch (err) {
          logger.debug(
            `[api] Service not available: ${err instanceof Error ? err.message : err}`,
          );
        }
      }
      // Also check locally discovered skills
      for (const s of state.skills) {
        installedSlugs.add(s.id);
      }

      const start = (page - 1) * perPage;
      const skills = sorted.slice(start, start + perPage).map((s) => ({
        ...s,
        installed: installedSlugs.has(s.slug),
      }));
      json(res, {
        total: all.length,
        page,
        perPage,
        totalPages: Math.ceil(all.length / perPage),
        installedCount: installedSlugs.size,
        skills,
      });
    } catch (err) {
      error(
        res,
        `Failed to load skill catalog: ${err instanceof Error ? err.message : String(err)}`,
        500,
      );
    }
    return;
  }

  // ── GET /api/skills/catalog/search ─────────────────────────────────────
  if (method === "GET" && pathname === "/api/skills/catalog/search") {
    const q = url.searchParams.get("q");
    if (!q) {
      error(res, "Missing query parameter ?q=", 400);
      return;
    }
    try {
      const { searchCatalogSkills } = await import(
        "../services/skill-catalog-client"
      );
      const limit = Math.min(
        100,
        Math.max(1, Number(url.searchParams.get("limit")) || 30),
      );
      const results = await searchCatalogSkills(q, limit);
      json(res, { query: q, count: results.length, results });
    } catch (err) {
      error(
        res,
        `Skill catalog search failed: ${err instanceof Error ? err.message : String(err)}`,
        500,
      );
    }
    return;
  }

  // ── GET /api/skills/catalog/:slug ──────────────────────────────────────
  if (method === "GET" && pathname.startsWith("/api/skills/catalog/")) {
    const slug = decodeURIComponent(
      pathname.slice("/api/skills/catalog/".length),
    );
    // Exclude "search" which is handled above
    if (slug && slug !== "search") {
      try {
        const { getCatalogSkill } = await import(
          "../services/skill-catalog-client"
        );
        const skill = await getCatalogSkill(slug);
        if (!skill) {
          error(res, `Skill "${slug}" not found in catalog`, 404);
          return;
        }
        json(res, { skill });
      } catch (err) {
        error(
          res,
          `Failed to fetch skill: ${err instanceof Error ? err.message : String(err)}`,
          500,
        );
      }
      return;
    }
  }

  // ── POST /api/skills/catalog/refresh ───────────────────────────────────
  if (method === "POST" && pathname === "/api/skills/catalog/refresh") {
    try {
      const { refreshCatalog } = await import(
        "../services/skill-catalog-client"
      );
      const skills = await refreshCatalog();
      json(res, { ok: true, count: skills.length });
    } catch (err) {
      error(
        res,
        `Catalog refresh failed: ${err instanceof Error ? err.message : String(err)}`,
        500,
      );
    }
    return;
  }

  // ── POST /api/skills/catalog/install ───────────────────────────────────
  if (method === "POST" && pathname === "/api/skills/catalog/install") {
    const body = await readJsonBody<{ slug: string; version?: string }>(
      req,
      res,
    );
    if (!body) return;
    if (!body.slug) {
      error(res, "Missing required field: slug", 400);
      return;
    }

    if (!state.runtime) {
      error(res, "Agent runtime not available — start the agent first", 503);
      return;
    }

    try {
      const service = state.runtime.getService("AGENT_SKILLS_SERVICE") as
        | {
            install?: (
              slug: string,
              opts?: { version?: string; force?: boolean },
            ) => Promise<boolean>;
            isInstalled?: (slug: string) => Promise<boolean>;
          }
        | undefined;

      if (!service || typeof service.install !== "function") {
        error(
          res,
          "AgentSkillsService not available — ensure @elizaos/plugin-agent-skills is loaded",
          501,
        );
        return;
      }

      const alreadyInstalled =
        typeof service.isInstalled === "function"
          ? await service.isInstalled(body.slug)
          : false;

      if (alreadyInstalled) {
        json(res, {
          ok: true,
          slug: body.slug,
          message: `Skill "${body.slug}" is already installed`,
          alreadyInstalled: true,
        });
        return;
      }

      const success = await service.install(body.slug, {
        version: body.version,
      });

      if (success) {
        // Refresh the skills list so the UI picks up the new skill
        const workspaceDir =
          state.config.agents?.defaults?.workspace ??
          resolveDefaultAgentWorkspaceDir();
        state.skills = await discoverSkills(
          workspaceDir,
          state.config,
          state.runtime,
        );

        json(res, {
          ok: true,
          slug: body.slug,
          message: `Skill "${body.slug}" installed successfully`,
        });
      } else {
        error(res, `Failed to install skill "${body.slug}"`, 500);
      }
    } catch (err) {
      error(
        res,
        `Skill install failed: ${err instanceof Error ? err.message : String(err)}`,
        500,
      );
    }
    return;
  }

  // ── POST /api/skills/catalog/uninstall ─────────────────────────────────
  if (method === "POST" && pathname === "/api/skills/catalog/uninstall") {
    const body = await readJsonBody<{ slug: string }>(req, res);
    if (!body) return;
    if (!body.slug) {
      error(res, "Missing required field: slug", 400);
      return;
    }

    if (!state.runtime) {
      error(res, "Agent runtime not available — start the agent first", 503);
      return;
    }

    try {
      const service = state.runtime.getService("AGENT_SKILLS_SERVICE") as
        | {
            uninstall?: (slug: string) => Promise<boolean>;
          }
        | undefined;

      if (!service || typeof service.uninstall !== "function") {
        error(
          res,
          "AgentSkillsService not available — ensure @elizaos/plugin-agent-skills is loaded",
          501,
        );
        return;
      }

      const success = await service.uninstall(body.slug);

      if (success) {
        // Refresh the skills list
        const workspaceDir =
          state.config.agents?.defaults?.workspace ??
          resolveDefaultAgentWorkspaceDir();
        state.skills = await discoverSkills(
          workspaceDir,
          state.config,
          state.runtime,
        );

        json(res, {
          ok: true,
          slug: body.slug,
          message: `Skill "${body.slug}" uninstalled successfully`,
        });
      } else {
        error(
          res,
          `Failed to uninstall skill "${body.slug}" — it may be a bundled skill`,
          400,
        );
      }
    } catch (err) {
      error(
        res,
        `Skill uninstall failed: ${err instanceof Error ? err.message : String(err)}`,
        500,
      );
    }
    return;
  }

  // ── GET /api/skills ─────────────────────────────────────────────────────
  if (method === "GET" && pathname === "/api/skills") {
    json(res, { skills: state.skills });
    return;
  }

  // ── POST /api/skills/refresh ──────────────────────────────────────────
  if (method === "POST" && pathname === "/api/skills/refresh") {
    try {
      const workspaceDir =
        state.config.agents?.defaults?.workspace ??
        resolveDefaultAgentWorkspaceDir();
      state.skills = await discoverSkills(
        workspaceDir,
        state.config,
        state.runtime,
      );
      json(res, { ok: true, skills: state.skills });
    } catch (err) {
      error(
        res,
        `Failed to refresh skills: ${err instanceof Error ? err.message : err}`,
        500,
      );
    }
    return;
  }

  // ── GET /api/skills/:id/scan ───────────────────────────────────────────
  if (method === "GET" && pathname.match(/^\/api\/skills\/[^/]+\/scan$/)) {
    const skillId = validateSkillId(
      decodeURIComponent(pathname.split("/")[3]),
      res,
    );
    if (!skillId) return;
    const workspaceDir =
      state.config.agents?.defaults?.workspace ??
      resolveDefaultAgentWorkspaceDir();
    const report = await loadScanReportFromDisk(
      skillId,
      workspaceDir,
      state.runtime,
    );
    const acks = await loadSkillAcknowledgments(state.runtime);
    const ack = acks[skillId] ?? null;
    json(res, { ok: true, report, acknowledged: !!ack, acknowledgment: ack });
    return;
  }

  // ── POST /api/skills/:id/acknowledge ──────────────────────────────────
  if (
    method === "POST" &&
    pathname.match(/^\/api\/skills\/[^/]+\/acknowledge$/)
  ) {
    const skillId = validateSkillId(
      decodeURIComponent(pathname.split("/")[3]),
      res,
    );
    if (!skillId) return;
    const body = await readJsonBody<{ enable?: boolean }>(req, res);
    if (!body) return;

    const workspaceDir =
      state.config.agents?.defaults?.workspace ??
      resolveDefaultAgentWorkspaceDir();
    const report = await loadScanReportFromDisk(
      skillId,
      workspaceDir,
      state.runtime,
    );
    if (!report) {
      error(res, `No scan report found for skill "${skillId}".`, 404);
      return;
    }
    if (report.status === "blocked") {
      error(
        res,
        `Skill "${skillId}" is blocked and cannot be acknowledged.`,
        403,
      );
      return;
    }
    if (report.status === "clean") {
      json(res, {
        ok: true,
        message: "No findings to acknowledge.",
        acknowledged: true,
      });
      return;
    }

    const findings = report.findings as Array<Record<string, unknown>>;
    const manifestFindings = report.manifestFindings as Array<
      Record<string, unknown>
    >;
    const totalFindings = findings.length + manifestFindings.length;

    if (state.runtime) {
      const acks = await loadSkillAcknowledgments(state.runtime);
      acks[skillId] = {
        acknowledgedAt: new Date().toISOString(),
        findingCount: totalFindings,
      };
      await saveSkillAcknowledgments(state.runtime, acks);
    }

    if (body.enable === true) {
      const skill = state.skills.find((s) => s.id === skillId);
      if (skill) {
        skill.enabled = true;
        if (state.runtime) {
          const prefs = await loadSkillPreferences(state.runtime);
          prefs[skillId] = true;
          await saveSkillPreferences(state.runtime, prefs);
        }
      }
    }

    json(res, {
      ok: true,
      skillId,
      acknowledged: true,
      enabled: body.enable === true,
      findingCount: totalFindings,
    });
    return;
  }

  // ── POST /api/skills/create ───────────────────────────────────────────
  if (method === "POST" && pathname === "/api/skills/create") {
    const body = await readJsonBody<{ name: string; description?: string }>(
      req,
      res,
    );
    if (!body) return;
    const rawName = body.name?.trim();
    if (!rawName) {
      error(res, "Skill name is required", 400);
      return;
    }

    const slug = rawName
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-+|-+$/g, "");
    if (!slug || slug.length > 64) {
      error(
        res,
        "Skill name must produce a valid slug (1-64 chars, lowercase alphanumeric + hyphens)",
        400,
      );
      return;
    }

    const workspaceDir =
      state.config.agents?.defaults?.workspace ??
      resolveDefaultAgentWorkspaceDir();
    const skillDir = path.join(workspaceDir, "skills", slug);

    if (fs.existsSync(skillDir)) {
      error(res, `Skill "${slug}" already exists`, 409);
      return;
    }

    const description =
      body.description?.trim() || "Describe what this skill does.";
    const template = `---\nname: ${slug}\ndescription: ${description.replace(/"/g, '\\"')}\n---\n\n## Instructions\n\n[Describe what this skill does and how the agent should use it]\n\n## When to Use\n\nUse this skill when [describe trigger conditions].\n\n## Steps\n\n1. [First step]\n2. [Second step]\n3. [Third step]\n`;

    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, "SKILL.md"), template, "utf-8");

    state.skills = await discoverSkills(
      workspaceDir,
      state.config,
      state.runtime,
    );
    const skill = state.skills.find((s) => s.id === slug);
    json(res, {
      ok: true,
      skill: skill ?? { id: slug, name: slug, description, enabled: true },
      path: skillDir,
    });
    return;
  }

  // ── POST /api/skills/:id/open ─────────────────────────────────────────
  if (method === "POST" && pathname.match(/^\/api\/skills\/[^/]+\/open$/)) {
    const skillId = validateSkillId(
      decodeURIComponent(pathname.split("/")[3]),
      res,
    );
    if (!skillId) return;
    const workspaceDir =
      state.config.agents?.defaults?.workspace ??
      resolveDefaultAgentWorkspaceDir();

    const candidates = [
      path.join(workspaceDir, "skills", skillId),
      path.join(workspaceDir, "skills", ".marketplace", skillId),
    ];
    let skillPath: string | null = null;
    for (const c of candidates) {
      if (fs.existsSync(path.join(c, "SKILL.md"))) {
        skillPath = c;
        break;
      }
    }

    // Try AgentSkillsService for bundled skills — copy to workspace for editing
    if (!skillPath && state.runtime) {
      try {
        const svc = state.runtime.getService("AGENT_SKILLS_SERVICE") as
          | {
              getLoadedSkills?: () => Array<{
                slug: string;
                path: string;
                source: string;
              }>;
            }
          | undefined;
        if (svc?.getLoadedSkills) {
          const loaded = svc.getLoadedSkills().find((s) => s.slug === skillId);
          if (loaded) {
            if (loaded.source === "bundled" || loaded.source === "plugin") {
              const targetDir = path.join(workspaceDir, "skills", skillId);
              if (!fs.existsSync(targetDir)) {
                fs.cpSync(loaded.path, targetDir, { recursive: true });
                state.skills = await discoverSkills(
                  workspaceDir,
                  state.config,
                  state.runtime,
                );
              }
              skillPath = targetDir;
            } else {
              skillPath = loaded.path;
            }
          }
        }
      } catch (err) {
        logger.debug(
          `[api] Service not available: ${err instanceof Error ? err.message : err}`,
        );
      }
    }

    if (!skillPath) {
      error(res, `Skill "${skillId}" not found`, 404);
      return;
    }

    const { execFile } = await import("node:child_process");
    const opener =
      process.platform === "darwin"
        ? "open"
        : process.platform === "win32"
          ? "explorer"
          : "xdg-open";
    execFile(opener, [skillPath], (err) => {
      if (err)
        logger.warn(`[milady-api] Failed to open skill folder: ${err.message}`);
    });
    json(res, { ok: true, path: skillPath });
    return;
  }

  // ── GET /api/skills/:id/source ──────────────────────────────────────────
  if (method === "GET" && pathname.match(/^\/api\/skills\/[^/]+\/source$/)) {
    const skillId = validateSkillId(
      decodeURIComponent(pathname.split("/")[3]),
      res,
    );
    if (!skillId) return;
    const workspaceDir =
      state.config.agents?.defaults?.workspace ??
      resolveDefaultAgentWorkspaceDir();

    const candidates = [
      path.join(workspaceDir, "skills", skillId),
      path.join(workspaceDir, "skills", ".marketplace", skillId),
    ];
    let skillMdPath: string | null = null;
    for (const c of candidates) {
      const md = path.join(c, "SKILL.md");
      if (fs.existsSync(md)) {
        skillMdPath = md;
        break;
      }
    }

    // Try AgentSkillsService for bundled/plugin skills — copy to workspace for editing
    if (!skillMdPath && state.runtime) {
      try {
        const svc = state.runtime.getService("AGENT_SKILLS_SERVICE") as
          | {
              getLoadedSkills?: () => Array<{
                slug: string;
                path: string;
                source: string;
              }>;
            }
          | undefined;
        if (svc?.getLoadedSkills) {
          const loaded = svc.getLoadedSkills().find((s) => s.slug === skillId);
          if (loaded) {
            if (loaded.source === "bundled" || loaded.source === "plugin") {
              const targetDir = path.join(workspaceDir, "skills", skillId);
              if (!fs.existsSync(targetDir)) {
                fs.cpSync(loaded.path, targetDir, { recursive: true });
                state.skills = await discoverSkills(
                  workspaceDir,
                  state.config,
                  state.runtime,
                );
              }
              const md = path.join(targetDir, "SKILL.md");
              if (fs.existsSync(md)) skillMdPath = md;
            } else {
              const md = path.join(loaded.path, "SKILL.md");
              if (fs.existsSync(md)) skillMdPath = md;
            }
          }
        }
      } catch {
        /* ignore */
      }
    }

    if (!skillMdPath) {
      error(res, `Skill "${skillId}" not found`, 404);
      return;
    }

    try {
      const content = fs.readFileSync(skillMdPath, "utf-8");
      json(res, { ok: true, skillId, content, path: skillMdPath });
    } catch (err) {
      error(
        res,
        `Failed to read skill: ${err instanceof Error ? err.message : "unknown"}`,
        500,
      );
    }
    return;
  }

  // ── PUT /api/skills/:id/source ──────────────────────────────────────────
  if (method === "PUT" && pathname.match(/^\/api\/skills\/[^/]+\/source$/)) {
    const skillId = validateSkillId(
      decodeURIComponent(pathname.split("/")[3]),
      res,
    );
    if (!skillId) return;
    const body = await readBody(req);
    if (!body) return;

    let parsed: { content?: string };
    try {
      parsed = JSON.parse(body);
    } catch {
      error(res, "Invalid JSON body", 400);
      return;
    }
    if (typeof parsed.content !== "string") {
      error(res, "Missing 'content' field", 400);
      return;
    }

    const workspaceDir =
      state.config.agents?.defaults?.workspace ??
      resolveDefaultAgentWorkspaceDir();

    const candidates = [
      path.join(workspaceDir, "skills", skillId),
      path.join(workspaceDir, "skills", ".marketplace", skillId),
    ];
    let skillMdPath: string | null = null;
    for (const c of candidates) {
      const md = path.join(c, "SKILL.md");
      if (fs.existsSync(md)) {
        skillMdPath = md;
        break;
      }
    }

    // Try AgentSkillsService for bundled/plugin skills — copy to workspace for editing
    if (!skillMdPath && state.runtime) {
      try {
        const svc = state.runtime.getService("AGENT_SKILLS_SERVICE") as
          | {
              getLoadedSkills?: () => Array<{
                slug: string;
                path: string;
                source: string;
              }>;
            }
          | undefined;
        if (svc?.getLoadedSkills) {
          const loaded = svc.getLoadedSkills().find((s) => s.slug === skillId);
          if (loaded) {
            if (loaded.source === "bundled" || loaded.source === "plugin") {
              const targetDir = path.join(workspaceDir, "skills", skillId);
              if (!fs.existsSync(targetDir)) {
                fs.cpSync(loaded.path, targetDir, { recursive: true });
              }
              const md = path.join(targetDir, "SKILL.md");
              if (fs.existsSync(md)) skillMdPath = md;
            } else {
              const md = path.join(loaded.path, "SKILL.md");
              if (fs.existsSync(md)) skillMdPath = md;
            }
          }
        }
      } catch {
        /* ignore */
      }
    }

    if (!skillMdPath) {
      error(res, `Skill "${skillId}" not found`, 404);
      return;
    }

    try {
      fs.writeFileSync(skillMdPath, parsed.content, "utf-8");
      // Re-discover skills to pick up unknown name/description changes
      state.skills = await discoverSkills(
        workspaceDir,
        state.config,
        state.runtime,
      );
      const skill = state.skills.find((s) => s.id === skillId);
      json(res, { ok: true, skillId, skill });
    } catch (err) {
      error(
        res,
        `Failed to save skill: ${err instanceof Error ? err.message : "unknown"}`,
        500,
      );
    }
    return;
  }

  // ── DELETE /api/skills/:id ────────────────────────────────────────────
  if (
    method === "DELETE" &&
    pathname.match(/^\/api\/skills\/[^/]+$/) &&
    !pathname.includes("/marketplace")
  ) {
    const skillId = validateSkillId(
      decodeURIComponent(pathname.slice("/api/skills/".length)),
      res,
    );
    if (!skillId) return;
    const workspaceDir =
      state.config.agents?.defaults?.workspace ??
      resolveDefaultAgentWorkspaceDir();

    const wsDir = path.join(workspaceDir, "skills", skillId);
    const mpDir = path.join(workspaceDir, "skills", ".marketplace", skillId);
    let deleted = false;
    let source = "";

    if (fs.existsSync(path.join(wsDir, "SKILL.md"))) {
      fs.rmSync(wsDir, { recursive: true, force: true });
      deleted = true;
      source = "workspace";
    } else if (fs.existsSync(path.join(mpDir, "SKILL.md"))) {
      try {
        const { uninstallMarketplaceSkill } = await import(
          "../services/skill-marketplace"
        );
        await uninstallMarketplaceSkill(workspaceDir, skillId);
        deleted = true;
        source = "marketplace";
      } catch (err) {
        error(
          res,
          `Failed to uninstall: ${err instanceof Error ? err.message : String(err)}`,
          500,
        );
        return;
      }
    } else if (state.runtime) {
      try {
        const svc = state.runtime.getService("AGENT_SKILLS_SERVICE") as
          | { uninstall?: (slug: string) => Promise<boolean> }
          | undefined;
        if (svc?.uninstall) {
          deleted = await svc.uninstall(skillId);
          source = "catalog";
        }
      } catch (err) {
        logger.debug(
          `[api] Service not available: ${err instanceof Error ? err.message : err}`,
        );
      }
    }

    if (!deleted) {
      error(
        res,
        `Skill "${skillId}" not found or is a bundled skill that cannot be deleted`,
        404,
      );
      return;
    }

    state.skills = await discoverSkills(
      workspaceDir,
      state.config,
      state.runtime,
    );
    if (state.runtime) {
      const prefs = await loadSkillPreferences(state.runtime);
      delete prefs[skillId];
      await saveSkillPreferences(state.runtime, prefs);
      const acks = await loadSkillAcknowledgments(state.runtime);
      delete acks[skillId];
      await saveSkillAcknowledgments(state.runtime, acks);
    }
    json(res, { ok: true, skillId, source });
    return;
  }

  // ── GET /api/skills/marketplace/search ─────────────────────────────────
  if (method === "GET" && pathname === "/api/skills/marketplace/search") {
    const query = url.searchParams.get("q") ?? "";
    if (!query.trim()) {
      error(res, "Query parameter 'q' is required", 400);
      return;
    }
    try {
      const limitStr = url.searchParams.get("limit");
      const limit = limitStr
        ? parseClampedInteger(limitStr, { min: 1, max: 50, fallback: 20 })
        : 20;
      const results = await searchSkillsMarketplace(query, { limit });
      json(res, { ok: true, results });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      error(res, msg, 502);
    }
    return;
  }

  // ── GET /api/skills/marketplace/installed ─────────────────────────────
  if (method === "GET" && pathname === "/api/skills/marketplace/installed") {
    try {
      const workspaceDir =
        state.config.agents?.defaults?.workspace ??
        resolveDefaultAgentWorkspaceDir();
      const installed = await listInstalledMarketplaceSkills(workspaceDir);
      json(res, { ok: true, skills: installed });
    } catch (err) {
      error(
        res,
        `Failed to list installed skills: ${err instanceof Error ? err.message : err}`,
        500,
      );
    }
    return;
  }

  // ── POST /api/skills/marketplace/install ──────────────────────────────
  if (method === "POST" && pathname === "/api/skills/marketplace/install") {
    const body = await readJsonBody<{
      slug?: string;
      githubUrl?: string;
      repository?: string;
      path?: string;
      name?: string;
      description?: string;
      source?: "clawhub" | "skillsmp" | "manual";
    }>(req, res);
    if (!body) return;

    const slug = body.slug?.trim() || "";
    const githubUrl = body.githubUrl?.trim() || "";
    const repository = body.repository?.trim() || "";

    if (!slug && !githubUrl && !repository) {
      error(res, "Install requires a slug, githubUrl, or repository", 400);
      return;
    }

    try {
      const workspaceDir =
        state.config.agents?.defaults?.workspace ??
        resolveDefaultAgentWorkspaceDir();

      // ClawHub-native install path (slug-based via AgentSkillsService).
      if (slug && !githubUrl && !repository) {
        if (!state.runtime) {
          error(
            res,
            "Agent runtime not available — start the agent first",
            503,
          );
          return;
        }

        const service = state.runtime.getService("AGENT_SKILLS_SERVICE") as
          | {
              install?: (
                skillSlug: string,
                opts?: { version?: string; force?: boolean },
              ) => Promise<boolean>;
              isInstalled?: (skillSlug: string) => Promise<boolean>;
            }
          | undefined;

        if (!service || typeof service.install !== "function") {
          error(
            res,
            "AgentSkillsService not available — ensure @elizaos/plugin-agent-skills is loaded",
            501,
          );
          return;
        }

        const alreadyInstalled =
          typeof service.isInstalled === "function"
            ? await service.isInstalled(slug)
            : false;

        if (alreadyInstalled) {
          json(res, {
            ok: true,
            skill: {
              id: slug,
              name: body.name?.trim() || slug,
              source: "clawhub",
              installedAt: new Date().toISOString(),
            },
            alreadyInstalled: true,
          });
          return;
        }

        const success = await service.install(slug);
        if (!success) {
          error(res, `Failed to install skill "${slug}"`, 500);
          return;
        }

        state.skills = await discoverSkills(
          workspaceDir,
          state.config,
          state.runtime,
        );

        json(res, {
          ok: true,
          skill: {
            id: slug,
            name: body.name?.trim() || slug,
            source: "clawhub",
            installedAt: new Date().toISOString(),
          },
        });
      } else {
        const result = await installMarketplaceSkill(workspaceDir, {
          githubUrl: body.githubUrl,
          repository: body.repository,
          path: body.path,
          name: body.name,
          description: body.description,
          source:
            body.source === "manual" || body.source === "skillsmp"
              ? body.source
              : "clawhub",
        });

        state.skills = await discoverSkills(
          workspaceDir,
          state.config,
          state.runtime,
        );

        json(res, { ok: true, skill: result });
      }
    } catch (err) {
      error(
        res,
        `Install failed: ${err instanceof Error ? err.message : err}`,
        500,
      );
    }
    return;
  }

  // ── POST /api/skills/marketplace/uninstall ────────────────────────────
  if (method === "POST" && pathname === "/api/skills/marketplace/uninstall") {
    const body = await readJsonBody<{ id?: string }>(req, res);
    if (!body) return;

    if (!body.id?.trim()) {
      error(res, "Request body must include 'id' (skill id to uninstall)", 400);
      return;
    }

    const uninstallId = validateSkillId(body.id.trim(), res);
    if (!uninstallId) return;

    try {
      const workspaceDir =
        state.config.agents?.defaults?.workspace ??
        resolveDefaultAgentWorkspaceDir();
      const result = await uninstallMarketplaceSkill(workspaceDir, uninstallId);

      state.skills = await discoverSkills(
        workspaceDir,
        state.config,
        state.runtime,
      );

      json(res, { ok: true, skill: result });
    } catch (err) {
      error(
        res,
        `Uninstall failed: ${err instanceof Error ? err.message : err}`,
        500,
      );
    }
    return;
  }

  // ── GET /api/skills/marketplace/config ──────────────────────────────────
  if (method === "GET" && pathname === "/api/skills/marketplace/config") {
    json(res, { keySet: Boolean(process.env.SKILLSMP_API_KEY?.trim()) });
    return;
  }

  // ── PUT /api/skills/marketplace/config ─────────────────────────────────
  if (method === "PUT" && pathname === "/api/skills/marketplace/config") {
    const body = await readJsonBody<{ apiKey?: string }>(req, res);
    if (!body) return;
    const apiKey = typeof body.apiKey === "string" ? body.apiKey.trim() : "";
    if (!apiKey) {
      error(res, "Request body must include 'apiKey'", 400);
      return;
    }
    process.env.SKILLSMP_API_KEY = apiKey;
    if (!state.config.env) state.config.env = {};
    (state.config.env as Record<string, string>).SKILLSMP_API_KEY = apiKey;
    saveElizaConfig(state.config);
    json(res, { ok: true, keySet: true });
    return;
  }

  // ── PUT /api/skills/:id ────────────────────────────────────────────────
  // IMPORTANT: This wildcard route MUST be after all /api/skills/<specific-path> routes
  if (method === "PUT" && pathname.startsWith("/api/skills/")) {
    const skillId = validateSkillId(
      decodeURIComponent(pathname.slice("/api/skills/".length)),
      res,
    );
    if (!skillId) return;
    const body = await readJsonBody<{ enabled?: boolean }>(req, res);
    if (!body) return;

    const skill = state.skills.find((s) => s.id === skillId);
    if (!skill) {
      error(res, `Skill "${skillId}" not found`, 404);
      return;
    }

    // Block enabling skills with unacknowledged scan findings
    if (body.enabled === true) {
      const workspaceDir =
        state.config.agents?.defaults?.workspace ??
        resolveDefaultAgentWorkspaceDir();
      const report = await loadScanReportFromDisk(
        skillId,
        workspaceDir,
        state.runtime,
      );
      if (
        report &&
        (report.status === "critical" || report.status === "warning")
      ) {
        const acks = await loadSkillAcknowledgments(state.runtime);
        const ack = acks[skillId];
        const findings = report.findings as Array<Record<string, unknown>>;
        const manifestFindings = report.manifestFindings as Array<
          Record<string, unknown>
        >;
        const totalFindings = findings.length + manifestFindings.length;
        if (!ack || ack.findingCount !== totalFindings) {
          error(
            res,
            `Skill "${skillId}" has ${totalFindings} security finding(s) that must be acknowledged first. Use POST /api/skills/${skillId}/acknowledge.`,
            409,
          );
          return;
        }
      }
    }

    if (body.enabled !== undefined) {
      skill.enabled = body.enabled;
      if (state.runtime) {
        const prefs = await loadSkillPreferences(state.runtime);
        prefs[skillId] = body.enabled;
        await saveSkillPreferences(state.runtime, prefs);
      }
    }

    json(res, { ok: true, skill });
    return;
  }

  if (
    await handleDiagnosticsRoutes({
      req,
      res,
      method,
      pathname,
      url,
      logBuffer: state.logBuffer,
      eventBuffer: state.eventBuffer,
      initSse,
      writeSseJson,
      json,
      auditEventTypes: AUDIT_EVENT_TYPES,
      auditSeverities: AUDIT_SEVERITIES,
      getAuditFeedSize,
      queryAuditFeed: (query) => queryAuditFeed(query as never) as never,
      subscribeAuditFeed,
    })
  ) {
    return;
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Bug report routes
  // ═══════════════════════════════════════════════════════════════════════
  if (
    await handleBugReportRoutes({
      req,
      res,
      method,
      pathname,
      readJsonBody,
      json,
      error,
    })
  ) {
    return;
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Wallet / Inventory routes
  // ═══════════════════════════════════════════════════════════════════════
  if (
    await handleWalletRoutes({
      req,
      res,
      method,
      pathname,
      config: state.config,
      saveConfig: saveElizaConfig,
      ensureWalletKeysInEnvAndConfig,
      resolveWalletExportRejection,
      scheduleRuntimeRestart,
      readJsonBody,
      json,
      error,
    })
  ) {
    return;
  }

  // ═══════════════════════════════════════════════════════════════════════
  //  ERC-8004 Registry Routes
  // ═══════════════════════════════════════════════════════════════════════

  if (method === "GET" && pathname === "/api/registry/status") {
    if (!registryService) {
      json(res, {
        registered: false,
        tokenId: 0,
        agentName: "",
        agentEndpoint: "",
        capabilitiesHash: "",
        isActive: false,
        tokenURI: "",
        walletAddress: "",
        totalAgents: 0,
        configured: false,
      });
      return;
    }
    const status = await registryService.getStatus();
    json(res, { ...status, configured: true });
    return;
  }

  if (method === "POST" && pathname === "/api/registry/register") {
    if (!registryService) {
      error(
        res,
        "Registry service not configured. Set registry config and EVM_PRIVATE_KEY.",
        503,
      );
      return;
    }
    const body = await readJsonBody<{
      name?: string;
      endpoint?: string;
      tokenURI?: string;
    }>(req, res);
    if (!body) return;

    const agentName = body.name || state.agentName || "Milady Agent";
    const endpoint = body.endpoint || "";
    const tokenURI = body.tokenURI || "";

    const result = await registryService.register({
      name: agentName,
      endpoint,
      capabilitiesHash: RegistryService.defaultCapabilitiesHash(),
      tokenURI,
    });
    json(res, result);
    return;
  }

  if (method === "POST" && pathname === "/api/registry/update-uri") {
    if (!registryService) {
      error(res, "Registry service not configured.", 503);
      return;
    }
    const body = await readJsonBody<{ tokenURI?: string }>(req, res);
    if (!body || !body.tokenURI) {
      error(res, "tokenURI is required");
      return;
    }
    const txHash = await registryService.updateTokenURI(body.tokenURI);
    json(res, { ok: true, txHash });
    return;
  }

  if (method === "POST" && pathname === "/api/registry/sync") {
    if (!registryService) {
      error(res, "Registry service not configured.", 503);
      return;
    }
    const body = await readJsonBody<{
      name?: string;
      endpoint?: string;
      tokenURI?: string;
    }>(req, res);
    if (!body) return;

    const agentName = body.name || state.agentName || "Milady Agent";
    const endpoint = body.endpoint || "";
    const tokenURI = body.tokenURI || "";

    const txHash = await registryService.syncProfile({
      name: agentName,
      endpoint,
      capabilitiesHash: RegistryService.defaultCapabilitiesHash(),
      tokenURI,
    });
    // Refresh status after sync
    json(res, { ok: true, txHash });
    return;
  }

  if (method === "GET" && pathname === "/api/registry/config") {
    const registryConfig = state.config.registry;
    let chainId = 1;
    if (registryService) {
      try {
        chainId = await registryService.getChainId();
      } catch {
        // Keep default if chain RPC is unavailable.
      }
    }

    const explorerByChainId: Record<number, string> = {
      1: "https://etherscan.io",
      10: "https://optimistic.etherscan.io",
      137: "https://polygonscan.com",
      8453: "https://basescan.org",
      42161: "https://arbiscan.io",
    };

    json(res, {
      configured: Boolean(registryService),
      chainId,
      registryAddress: registryConfig?.registryAddress ?? null,
      collectionAddress: registryConfig?.collectionAddress ?? null,
      explorerUrl: explorerByChainId[chainId] ?? "",
    });
    return;
  }

  // ═══════════════════════════════════════════════════════════════════════
  //  Drop / Mint Routes
  // ═══════════════════════════════════════════════════════════════════════

  if (method === "GET" && pathname === "/api/drop/status") {
    if (!dropService) {
      json(res, {
        dropEnabled: false,
        publicMintOpen: false,
        whitelistMintOpen: false,
        mintedOut: false,
        currentSupply: 0,
        maxSupply: 2138,
        shinyPrice: "0.1",
        userHasMinted: false,
      });
      return;
    }
    const status = await dropService.getStatus();
    json(res, status);
    return;
  }

  if (method === "POST" && pathname === "/api/drop/mint") {
    if (!dropService) {
      error(res, "Drop service not configured.", 503);
      return;
    }
    const body = await readJsonBody<{
      name?: string;
      endpoint?: string;
      shiny?: boolean;
    }>(req, res);
    if (!body) return;

    const agentName = body.name || state.agentName || "Milady Agent";
    const endpoint = body.endpoint || "";

    const result = body.shiny
      ? await dropService.mintShiny(agentName, endpoint)
      : await dropService.mint(agentName, endpoint);
    json(res, result);
    return;
  }

  if (method === "POST" && pathname === "/api/drop/mint-whitelist") {
    if (!dropService) {
      error(res, "Drop service not configured.", 503);
      return;
    }
    const body = await readJsonBody<{
      name?: string;
      endpoint?: string;
      proof?: string[];
    }>(req, res);
    if (!body) return;
    let proof = body.proof;
    if (!proof || proof.length === 0) {
      const addrs = getWalletAddresses();
      const walletAddress = addrs.evmAddress ?? "";
      if (!walletAddress) {
        error(res, "EVM wallet not configured.");
        return;
      }
      const proofResult = generateProof(walletAddress);
      if (!proofResult.isWhitelisted) {
        error(
          res,
          "Address not whitelisted. Complete Twitter or NFT verification first.",
        );
        return;
      }
      proof = proofResult.proof;
    }

    const agentName = body.name || state.agentName || "Milady Agent";
    const endpoint = body.endpoint || "";
    const result = await dropService.mintWithWhitelist(
      agentName,
      endpoint,
      proof,
    );
    json(res, result);
    return;
  }

  // ═══════════════════════════════════════════════════════════════════════
  //  Whitelist Routes
  // ═══════════════════════════════════════════════════════════════════════

  if (method === "GET" && pathname === "/api/whitelist/status") {
    const addrs = getWalletAddresses();
    const walletAddress = addrs.evmAddress ?? "";
    const twitterVerified = walletAddress
      ? isAddressWhitelisted(walletAddress)
      : false;
    const ogCode = readOGCodeFromState();

    const { info } = buildWhitelistTree();
    const proofReady = walletAddress
      ? generateProof(walletAddress).isWhitelisted
      : false;

    json(res, {
      eligible: twitterVerified,
      twitterVerified,
      nftVerified: twitterVerified, // We'll leave it as is if there's no way to distinguish, or we can check the file
      whitelisted: walletAddress ? isAddressWhitelisted(walletAddress) : false,
      ogCode: ogCode ?? null,
      walletAddress,
      merkle: {
        root: info.root,
        addressCount: info.addressCount,
        proofReady,
      },
    });
    return;
  }

  if (method === "POST" && pathname === "/api/whitelist/twitter/message") {
    const addrs = getWalletAddresses();
    const walletAddress = addrs.evmAddress ?? "";
    if (!walletAddress) {
      error(res, "EVM wallet not configured. Complete onboarding first.");
      return;
    }
    const agentName = state.agentName || "Milady Agent";
    const message = generateVerificationMessage(agentName, walletAddress);
    json(res, { message, walletAddress });
    return;
  }

  if (method === "POST" && pathname === "/api/whitelist/twitter/verify") {
    const body = await readJsonBody<{ tweetUrl?: string }>(req, res);
    if (!body || !body.tweetUrl) {
      error(res, "tweetUrl is required");
      return;
    }

    const addrs = getWalletAddresses();
    const walletAddress = addrs.evmAddress ?? "";
    if (!walletAddress) {
      error(res, "EVM wallet not configured.");
      return;
    }

    const result = await verifyTweet(body.tweetUrl, walletAddress);
    if (result.verified && result.handle) {
      markAddressVerified(walletAddress, body.tweetUrl, result.handle);
    }
    json(res, result);
    return;
  }

  // ── POST /api/whitelist/nft/verify ───────────────────────────────────────
  // Verify Milady NFT ownership for whitelist eligibility.
  // Security: only verifies the agent's own wallet — does not accept
  // arbitrary addresses to prevent whitelist injection from local processes.
  if (method === "POST" && pathname === "/api/whitelist/nft/verify") {
    // PR 518 FIX: Restrict to the agent's own wallet to prevent injection
    const addrs = getWalletAddresses();
    const address = addrs.evmAddress || "";
    if (!address) {
      error(res, "Wallet address is required. Complete onboarding first.", 400);
      return;
    }

    try {
      const result = await verifyAndWhitelistHolder(address);
      json(res, { ...result, walletAddress: address });
    } catch (err) {
      error(
        res,
        `NFT verification failed: ${err instanceof Error ? err.message : String(err)}`,
        500,
      );
    }
    return;
  }

  // ── GET /api/whitelist/nft/status ────────────────────────────────────────
  // Check NFT verification status without modifying the whitelist.
  if (method === "GET" && pathname === "/api/whitelist/nft/status") {
    const addrs = getWalletAddresses();
    const walletAddress = addrs.evmAddress ?? "";
    const whitelisted = walletAddress
      ? isAddressWhitelisted(walletAddress)
      : false;

    json(res, {
      walletAddress,
      whitelisted,
      contractAddress:
        process.env.MILADY_NFT_CONTRACT?.trim() ||
        "0x5Af0D9827E0c53E4799BB226655A1de152A425a5",
      message: whitelisted
        ? "Address is whitelisted for mint."
        : "Address is not whitelisted. Use POST /api/whitelist/nft/verify to verify NFT ownership.",
    });
    return;
  }

  // ── GET /api/whitelist/merkle/root — tree info and root hash
  if (method === "GET" && pathname === "/api/whitelist/merkle/root") {
    const { info } = buildWhitelistTree();
    json(res, {
      root: info.root,
      addressCount: info.addressCount,
      proofReady: true,
    });
    return;
  }

  // ── GET /api/whitelist/merkle/proof?address=0x... — proof for an address
  if (method === "GET" && pathname === "/api/whitelist/merkle/proof") {
    const url = new URL(req.url ?? "", `http://${req.headers.host}`);
    const addr = url.searchParams.get("address");
    if (!addr) {
      error(res, "address query parameter is required", 400);
      return;
    }
    const result = generateProof(addr);
    json(res, result);
    return;
  }

  // ── GET /api/update/status ───────────────────────────────────────────────
  if (method === "GET" && pathname === "/api/update/status") {
    const { VERSION } = await import("../runtime/version");
    const {
      resolveChannel,
      checkForUpdate,
      fetchAllChannelVersions,
      CHANNEL_DIST_TAGS,
    } = await import("../services/update-checker");
    const { detectInstallMethod } = await import("../services/self-updater");
    const channel = resolveChannel(state.config.update);

    const [check, versions] = await Promise.all([
      checkForUpdate({ force: req.url?.includes("force=true") }),
      fetchAllChannelVersions(),
    ]);

    json(res, {
      currentVersion: VERSION,
      channel,
      installMethod: detectInstallMethod(),
      updateAvailable: check.updateAvailable,
      latestVersion: check.latestVersion,
      channels: {
        stable: versions.stable,
        beta: versions.beta,
        nightly: versions.nightly,
      },
      distTags: CHANNEL_DIST_TAGS,
      lastCheckAt: state.config.update?.lastCheckAt ?? null,
      error: check.error,
    });
    return;
  }

  // ── PUT /api/update/channel ────────────────────────────────────────────
  if (method === "PUT" && pathname === "/api/update/channel") {
    const body = (await readJsonBody(req, res)) as { channel?: string } | null;
    if (!body) return;
    const ch = body.channel;
    if (ch !== "stable" && ch !== "beta" && ch !== "nightly") {
      error(res, `Invalid channel "${ch}". Must be stable, beta, or nightly.`);
      return;
    }
    state.config.update = {
      ...state.config.update,
      channel: ch,
      lastCheckAt: undefined,
      lastCheckVersion: undefined,
    };
    saveElizaConfig(state.config);
    json(res, { channel: ch });
    return;
  }

  // ── GET /api/connectors ──────────────────────────────────────────────────
  if (method === "GET" && pathname === "/api/connectors") {
    const connectors = state.config.connectors ?? state.config.channels ?? {};
    json(res, {
      connectors: redactConfigSecrets(connectors as Record<string, unknown>),
    });
    return;
  }

  // ── POST /api/connectors ─────────────────────────────────────────────────
  if (method === "POST" && pathname === "/api/connectors") {
    const body = await readJsonBody(req, res);
    if (!body) return;
    const name = body.name;
    const config = body.config;
    if (!name || typeof name !== "string" || !name.trim()) {
      error(res, "Missing connector name", 400);
      return;
    }
    // Prevent prototype pollution via special keys
    const connectorName = name.trim();
    if (isBlockedObjectKey(connectorName)) {
      error(
        res,
        'Invalid connector name: "__proto__", "constructor", and "prototype" are reserved',
        400,
      );
      return;
    }
    if (!config || typeof config !== "object") {
      error(res, "Missing connector config", 400);
      return;
    }
    if (!state.config.connectors) state.config.connectors = {};
    state.config.connectors[connectorName] = cloneWithoutBlockedObjectKeys(
      config,
    ) as ConnectorConfig;
    try {
      saveElizaConfig(state.config);
    } catch {
      /* test envs */
    }
    json(res, {
      connectors: redactConfigSecrets(
        (state.config.connectors ?? {}) as Record<string, unknown>,
      ),
    });
    return;
  }

  // ── DELETE /api/connectors/:name ─────────────────────────────────────────
  if (method === "DELETE" && pathname.startsWith("/api/connectors/")) {
    const name = decodeURIComponent(pathname.slice("/api/connectors/".length));
    if (!name || isBlockedObjectKey(name)) {
      error(res, "Missing or invalid connector name", 400);
      return;
    }
    if (
      state.config.connectors &&
      Object.hasOwn(state.config.connectors, name)
    ) {
      delete state.config.connectors[name];
    }
    // Also remove from legacy channels key
    if (state.config.channels && Object.hasOwn(state.config.channels, name)) {
      delete state.config.channels[name];
    }
    try {
      saveElizaConfig(state.config);
    } catch {
      /* test envs */
    }
    json(res, {
      connectors: redactConfigSecrets(
        (state.config.connectors ?? {}) as Record<string, unknown>,
      ),
    });
    return;
  }

  // ── WhatsApp routes (/api/whatsapp/*) ────────────────────────────────────
  // Auth: these routes are protected by the isAuthorized(req) gate at L5331.
  if (pathname.startsWith("/api/whatsapp")) {
    if (!state.whatsappPairingSessions) {
      state.whatsappPairingSessions = new Map();
    }
    // Clean up disconnected or timed-out sessions
    for (const [id, session] of state.whatsappPairingSessions) {
      const status = session.getStatus();
      if (
        status === "disconnected" ||
        status === "timeout" ||
        status === "error"
      ) {
        session.stop();
        state.whatsappPairingSessions.delete(id);
      }
    }
    const handled = await handleWhatsAppRoute(
      req,
      res,
      pathname,
      method,
      {
        whatsappPairingSessions: state.whatsappPairingSessions,
        broadcastWs: state.broadcastWs ?? undefined,
        config: state.config,
        runtime: state.runtime ?? undefined,
        saveConfig: () => saveElizaConfig(state.config),
        workspaceDir: resolveDefaultAgentWorkspaceDir(),
      },
      {
        sanitizeAccountId: sanitizeWhatsAppAccountId,
        whatsappAuthExists,
        whatsappLogout,
        createWhatsAppPairingSession: (options) =>
          new WhatsAppPairingSession(options as never),
      },
    );
    if (handled) return;
  }

  // ── Signal routes (/api/signal/*) ─────────────────────────────────────
  if (pathname.startsWith("/api/signal")) {
    if (!state.signalPairingSessions) {
      state.signalPairingSessions = new Map();
    }
    for (const [id, session] of state.signalPairingSessions) {
      const status = session.getStatus();
      if (
        status === "disconnected" ||
        status === "timeout" ||
        status === "error"
      ) {
        session.stop();
        state.signalPairingSessions.delete(id);
      }
    }
    const handled = await handleSignalRoute(
      req,
      res,
      pathname,
      method,
      {
        signalPairingSessions: state.signalPairingSessions,
        broadcastWs: state.broadcastWs ?? undefined,
        config: state.config,
        runtime: state.runtime ?? undefined,
        saveConfig: () => saveElizaConfig(state.config),
        workspaceDir: resolveDefaultAgentWorkspaceDir(),
      },
      {
        sanitizeAccountId: sanitizeSignalAccountId,
        signalAuthExists,
        signalLogout,
        createSignalPairingSession: (options) =>
          new SignalPairingSession(options as never),
      },
    );
    if (handled) return;
  }

  // ── POST /api/restart ───────────────────────────────────────────────────
  if (method === "POST" && pathname === "/api/restart") {
    state.agentState = "restarting";
    state.startup = {
      ...state.startup,
      phase: "restarting",
    };
    state.broadcastStatus?.();
    json(res, { ok: true, message: "Restarting...", restarting: true });
    setTimeout(() => process.exit(0), 1000);
    return;
  }

  // ── POST /api/tts/elevenlabs ─────────────────────────────────────────────
  if (method === "POST" && pathname === "/api/tts/elevenlabs") {
    const body = await readJsonBody<{
      text?: string;
      voiceId?: string;
      modelId?: string;
      outputFormat?: string;
      apiKey?: string;
      apply_text_normalization?: "auto" | "on" | "off";
      voice_settings?: {
        stability?: number;
        similarity_boost?: number;
        speed?: number;
      };
    }>(req, res);
    if (!body) return;

    const text =
      typeof body.text === "string" ? sanitizeSpeechText(body.text) : "";
    if (!text) {
      error(res, "Missing text", 400);
      return;
    }

    const messages =
      state.config && typeof state.config === "object"
        ? ((state.config as Record<string, unknown>).messages as
            | Record<string, unknown>
            | undefined)
        : undefined;
    const tts =
      messages && typeof messages === "object"
        ? ((messages.tts as Record<string, unknown>) ?? undefined)
        : undefined;
    const eleven =
      tts && typeof tts === "object"
        ? ((tts.elevenlabs as Record<string, unknown>) ?? undefined)
        : undefined;

    const requestedApiKey =
      typeof body.apiKey === "string" ? body.apiKey.trim() : "";
    const configuredApiKey =
      typeof eleven?.apiKey === "string" ? eleven.apiKey.trim() : "";
    const envApiKey =
      typeof process.env.ELEVENLABS_API_KEY === "string"
        ? process.env.ELEVENLABS_API_KEY.trim()
        : "";

    const resolvedApiKey =
      requestedApiKey && !isRedactedSecretValue(requestedApiKey)
        ? requestedApiKey
        : configuredApiKey && !isRedactedSecretValue(configuredApiKey)
          ? configuredApiKey
          : envApiKey && !isRedactedSecretValue(envApiKey)
            ? envApiKey
            : "";

    if (!resolvedApiKey) {
      error(
        res,
        "ElevenLabs API key is not available. Set ELEVENLABS_API_KEY in Secrets.",
        400,
      );
      return;
    }

    const voiceId =
      (typeof body.voiceId === "string" && body.voiceId.trim()) ||
      (typeof eleven?.voiceId === "string" && eleven.voiceId.trim()) ||
      "EXAVITQu4vr4xnSDxMaL";
    const modelId =
      (typeof body.modelId === "string" && body.modelId.trim()) ||
      (typeof eleven?.modelId === "string" && eleven.modelId.trim()) ||
      "eleven_flash_v2_5";
    const outputFormat =
      (typeof body.outputFormat === "string" && body.outputFormat.trim()) ||
      "mp3_22050_32";

    const requestedVoiceSettings =
      body.voice_settings &&
      typeof body.voice_settings === "object" &&
      !Array.isArray(body.voice_settings)
        ? body.voice_settings
        : undefined;

    const voiceSettings: Record<string, number> = {};
    const stability = requestedVoiceSettings?.stability;
    if (typeof stability === "number" && stability >= 0 && stability <= 1) {
      voiceSettings.stability = stability;
    }
    const similarityBoost = requestedVoiceSettings?.similarity_boost;
    if (
      typeof similarityBoost === "number" &&
      similarityBoost >= 0 &&
      similarityBoost <= 1
    ) {
      voiceSettings.similarity_boost = similarityBoost;
    }
    const speed = requestedVoiceSettings?.speed;
    if (typeof speed === "number" && speed >= 0.5 && speed <= 2) {
      voiceSettings.speed = speed;
    }

    const payload: Record<string, unknown> = {
      text,
      model_id: modelId,
      apply_text_normalization:
        body.apply_text_normalization === "on" ||
        body.apply_text_normalization === "off"
          ? body.apply_text_normalization
          : "auto",
    };
    if (Object.keys(voiceSettings).length > 0) {
      payload.voice_settings = voiceSettings;
    }

    try {
      const upstreamUrl = new URL(
        `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}/stream`,
      );
      upstreamUrl.searchParams.set("output_format", outputFormat);

      const upstream = await fetchWithTimeoutGuard(
        upstreamUrl.toString(),
        {
          method: "POST",
          headers: {
            "xi-api-key": resolvedApiKey,
            "Content-Type": "application/json",
            Accept: "audio/mpeg",
          },
          body: JSON.stringify(payload),
        },
        ELEVENLABS_FETCH_TIMEOUT_MS,
      );

      if (!upstream.ok) {
        const upstreamBody = await upstream.text().catch(() => "");
        error(
          res,
          `ElevenLabs request failed (${upstream.status}): ${upstreamBody.slice(0, 240)}`,
          upstream.status === 429 ? 429 : 502,
        );
        return;
      }

      const contentType = upstream.headers.get("content-type") || "audio/mpeg";
      const contentLength = responseContentLength(upstream.headers);
      if (
        contentLength !== null &&
        contentLength > ELEVENLABS_AUDIO_MAX_BYTES
      ) {
        error(
          res,
          `ElevenLabs response exceeds maximum size of ${ELEVENLABS_AUDIO_MAX_BYTES} bytes`,
          502,
        );
        return;
      }

      res.writeHead(200, {
        "Content-Type": contentType,
        "Cache-Control": "no-store",
        ...(contentLength !== null
          ? { "Content-Length": String(contentLength) }
          : {}),
      });

      await streamResponseBodyWithByteLimit(
        upstream,
        res,
        ELEVENLABS_AUDIO_MAX_BYTES,
        ELEVENLABS_FETCH_TIMEOUT_MS,
      );
      res.end();
      return;
    } catch (err) {
      if (res.headersSent) {
        res.destroy(
          err instanceof Error
            ? err
            : new Error(
                `ElevenLabs proxy error: ${typeof err === "string" ? err : String(err)}`,
              ),
        );
        return;
      }
      error(
        res,
        `ElevenLabs proxy error: ${err instanceof Error ? err.message : String(err)}`,
        isAbortError(err) ? 504 : 502,
      );
      return;
    }
  }

  // ── POST /api/avatar/vrm ─────────────────────────────────────────────────
  // Upload a custom VRM avatar file. Saved to ~/.milady/avatars/custom.vrm.
  if (method === "POST" && pathname === "/api/avatar/vrm") {
    const MAX_VRM_BYTES = 50 * 1024 * 1024; // 50 MB
    const rawBody = await readRequestBodyBuffer(req, {
      maxBytes: MAX_VRM_BYTES,
      returnNullOnTooLarge: true,
    });
    if (!rawBody || rawBody.length === 0) {
      error(res, "Request body is empty or exceeds 50 MB", 400);
      return;
    }
    // VRM files are GLB (binary glTF) — validate the 4-byte magic header
    const GLB_MAGIC = Buffer.from([0x67, 0x6c, 0x54, 0x46]); // "glTF"
    if (rawBody.length < 4 || !rawBody.subarray(0, 4).equals(GLB_MAGIC)) {
      error(res, "Invalid VRM file: not a valid glTF/GLB file", 400);
      return;
    }
    const avatarDir = path.join(resolveStateDir(), "avatars");
    fs.mkdirSync(avatarDir, { recursive: true });
    const vrmPath = path.join(avatarDir, "custom.vrm");
    fs.writeFileSync(vrmPath, rawBody);
    json(res, { ok: true, size: rawBody.length });
    return;
  }

  // ── GET /api/avatar/vrm ──────────────────────────────────────────────────
  // Serve the user's custom VRM avatar file if it exists.
  if (
    (method === "GET" || method === "HEAD") &&
    pathname === "/api/avatar/vrm"
  ) {
    const vrmPath = path.join(resolveStateDir(), "avatars", "custom.vrm");
    try {
      const stat = fs.statSync(vrmPath);
      if (!stat.isFile()) {
        error(res, "No custom avatar found", 404);
        return;
      }
      const headers: Record<string, string | number> = {
        "Content-Type": "model/gltf-binary",
        "Content-Length": stat.size,
        "Cache-Control": "no-cache",
      };
      if (method === "HEAD") {
        res.writeHead(200, headers);
        res.end();
        return;
      }
      const body = fs.readFileSync(vrmPath);
      res.writeHead(200, headers);
      res.end(body);
    } catch {
      error(res, "No custom avatar found", 404);
    }
    return;
  }

  // ── POST /api/avatar/background ──────────────────────────────────────────
  // Upload a custom background image. Saved to ~/.milady/avatars/custom-background.<ext>.
  if (method === "POST" && pathname === "/api/avatar/background") {
    const MAX_BG_BYTES = 10 * 1024 * 1024; // 10 MB
    const rawBody = await readRequestBodyBuffer(req, {
      maxBytes: MAX_BG_BYTES,
      returnNullOnTooLarge: true,
    });
    if (!rawBody || rawBody.length === 0) {
      error(res, "Request body is empty or exceeds 10 MB", 400);
      return;
    }
    // Detect image format from magic bytes
    let ext = "";
    if (
      rawBody[0] === 0x89 &&
      rawBody[1] === 0x50 &&
      rawBody[2] === 0x4e &&
      rawBody[3] === 0x47
    ) {
      ext = "png";
    } else if (rawBody[0] === 0xff && rawBody[1] === 0xd8) {
      ext = "jpg";
    } else if (
      rawBody[0] === 0x52 &&
      rawBody[1] === 0x49 &&
      rawBody[2] === 0x46 &&
      rawBody[3] === 0x46 &&
      rawBody.length >= 12 &&
      rawBody[8] === 0x57 &&
      rawBody[9] === 0x45 &&
      rawBody[10] === 0x42 &&
      rawBody[11] === 0x50
    ) {
      ext = "webp";
    } else {
      error(res, "Invalid image file: expected PNG, JPEG, or WebP", 400);
      return;
    }
    const avatarDir = path.join(resolveStateDir(), "avatars");
    fs.mkdirSync(avatarDir, { recursive: true });
    // Remove any previous custom background (may have a different extension)
    for (const old of ["png", "jpg", "webp"]) {
      const p = path.join(avatarDir, `custom-background.${old}`);
      try {
        fs.unlinkSync(p);
      } catch {}
    }
    const bgPath = path.join(avatarDir, `custom-background.${ext}`);
    fs.writeFileSync(bgPath, rawBody);
    json(res, { ok: true, size: rawBody.length });
    return;
  }

  // ── GET /api/avatar/background ─────────────────────────────────────────────
  // Serve the user's custom background image if it exists.
  if (
    (method === "GET" || method === "HEAD") &&
    pathname === "/api/avatar/background"
  ) {
    const avatarDir = path.join(resolveStateDir(), "avatars");
    const MIME: Record<string, string> = {
      png: "image/png",
      jpg: "image/jpeg",
      webp: "image/webp",
    };
    let found = "";
    for (const ext of ["png", "jpg", "webp"]) {
      const p = path.join(avatarDir, `custom-background.${ext}`);
      try {
        if (fs.statSync(p).isFile()) {
          found = p;
          break;
        }
      } catch {}
    }
    if (!found) {
      error(res, "No custom background found", 404);
      return;
    }
    const stat = fs.statSync(found);
    const fileExt = path.extname(found).slice(1);
    const headers: Record<string, string | number> = {
      "Content-Type": MIME[fileExt] || "application/octet-stream",
      "Content-Length": stat.size,
      "Cache-Control": "no-cache",
    };
    if (method === "HEAD") {
      res.writeHead(200, headers);
      res.end();
      return;
    }
    const body = fs.readFileSync(found);
    res.writeHead(200, headers);
    res.end(body);
    return;
  }

  // ── GET /api/config/schema ───────────────────────────────────────────────
  if (method === "GET" && pathname === "/api/config/schema") {
    const { buildConfigSchema } = await import("../config/schema");
    const result = buildConfigSchema();
    json(res, result);
    return;
  }

  // ── GET /api/config ──────────────────────────────────────────────────────
  if (method === "GET" && pathname === "/api/config") {
    json(res, redactConfigSecrets(state.config));
    return;
  }

  // ── PUT /api/config ─────────────────────────────────────────────────────
  if (method === "PUT" && pathname === "/api/config") {
    const body = await readJsonBody(req, res);
    if (!body) return;

    // --- Security: validate and safely merge config updates ----------------

    // Keys that could enable prototype pollution.
    /**
     * Deep-merge `src` into `target`, only touching keys present in `src`.
     * Prevents prototype pollution by rejecting dangerous key names at every
     * level.  Performs a recursive merge for plain objects so that partial
     * updates don't wipe sibling keys.
     */
    function safeMerge(
      target: Record<string, unknown>,
      src: Record<string, unknown>,
    ): void {
      for (const key of Object.keys(src)) {
        if (isBlockedObjectKey(key)) continue;
        const srcVal = src[key];
        const tgtVal = target[key];
        if (
          srcVal !== null &&
          typeof srcVal === "object" &&
          !Array.isArray(srcVal) &&
          tgtVal !== null &&
          typeof tgtVal === "object" &&
          !Array.isArray(tgtVal)
        ) {
          safeMerge(
            tgtVal as Record<string, unknown>,
            srcVal as Record<string, unknown>,
          );
        } else {
          target[key] = srcVal;
        }
      }
    }

    // Filter to allowed top-level keys, then deep-merge.
    const filtered: Record<string, unknown> = {};
    for (const key of Object.keys(body)) {
      if (CONFIG_WRITE_ALLOWED_TOP_KEYS.has(key) && !isBlockedObjectKey(key)) {
        filtered[key] = body[key];
      }
    }

    // Security: keep auth/step-up secrets out of API-driven config writes so
    // secret rotation remains an out-of-band operation.
    if (
      filtered.env &&
      typeof filtered.env === "object" &&
      !Array.isArray(filtered.env)
    ) {
      const envPatch = filtered.env as Record<string, unknown>;
      // Defense-in-depth: strip step-up secrets from persisted config before
      // merge, even though BLOCKED_ENV_KEYS also blocks them during process.env
      // sync below. Keeping both guards prevents accidental persistence if one
      // path changes in future refactors.
      delete envPatch.ELIZA_API_TOKEN;
      delete envPatch.MILADY_API_TOKEN;
      delete envPatch.MILADY_WALLET_EXPORT_TOKEN;
      delete envPatch.MILADY_TERMINAL_RUN_TOKEN;
      delete envPatch.HYPERSCAPE_AUTH_TOKEN;
      delete envPatch.EVM_PRIVATE_KEY;
      delete envPatch.SOLANA_PRIVATE_KEY;
      delete envPatch.GITHUB_TOKEN;
      if (
        envPatch.vars &&
        typeof envPatch.vars === "object" &&
        !Array.isArray(envPatch.vars)
      ) {
        const vars = envPatch.vars as Record<string, unknown>;
        delete vars.ELIZA_API_TOKEN;
        delete vars.MILADY_API_TOKEN;
        delete vars.MILADY_WALLET_EXPORT_TOKEN;
        delete vars.MILADY_TERMINAL_RUN_TOKEN;
        delete vars.HYPERSCAPE_AUTH_TOKEN;
        delete vars.EVM_PRIVATE_KEY;
        delete vars.SOLANA_PRIVATE_KEY;
        delete vars.GITHUB_TOKEN;
      }

      // Defense-in-depth: strip ALL BLOCKED_ENV_KEYS from the env patch
      // before safeMerge.  The explicit deletes above cover known step-up
      // secrets; this loop catches process-level injection keys
      // (NODE_OPTIONS, LD_PRELOAD, etc.) so they never reach
      // saveElizaConfig() and the persistence→restart RCE chain is closed.
      for (const key of Object.keys(envPatch)) {
        if (key === "vars" || key === "shellEnv") continue;
        if (BLOCKED_ENV_KEYS.has(key.toUpperCase())) {
          delete envPatch[key];
        }
      }
      if (
        envPatch.vars &&
        typeof envPatch.vars === "object" &&
        !Array.isArray(envPatch.vars)
      ) {
        const innerVars = envPatch.vars as Record<string, unknown>;
        for (const key of Object.keys(innerVars)) {
          if (BLOCKED_ENV_KEYS.has(key.toUpperCase())) {
            delete innerVars[key];
          }
        }
      }
    }

    if (
      filtered.mcp &&
      typeof filtered.mcp === "object" &&
      !Array.isArray(filtered.mcp)
    ) {
      const mcpPatch = filtered.mcp as Record<string, unknown>;
      if (mcpPatch.servers !== undefined) {
        if (
          !mcpPatch.servers ||
          typeof mcpPatch.servers !== "object" ||
          Array.isArray(mcpPatch.servers)
        ) {
          error(res, "mcp.servers must be a JSON object", 400);
          return;
        }
        const mcpRejection = await resolveMcpServersRejection(
          mcpPatch.servers as Record<string, unknown>,
        );
        if (mcpRejection) {
          error(res, mcpRejection, 400);
          return;
        }
        const mcpTerminalRejection = resolveMcpTerminalAuthorizationRejection(
          req,
          mcpPatch.servers as Record<string, unknown>,
          body as { terminalToken?: string },
        );
        if (mcpTerminalRejection) {
          error(
            res,
            `Configuring stdio MCP servers via /api/config requires terminal authorization. ${mcpTerminalRejection.reason}`,
            mcpTerminalRejection.status,
          );
          return;
        }
      }
    }

    safeMerge(state.config as Record<string, unknown>, filtered);

    // If the client updated env vars, synchronise them into process.env so
    // subsequent hot-restarts see the latest values (loadElizaConfig()
    // only fills missing env vars and does not override existing ones).
    if (
      filtered.env &&
      typeof filtered.env === "object" &&
      !Array.isArray(filtered.env)
    ) {
      const envPatch = filtered.env as Record<string, unknown>;

      // 1) env.vars.* (preferred)
      const vars = envPatch.vars;
      if (vars && typeof vars === "object" && !Array.isArray(vars)) {
        for (const [k, v] of Object.entries(vars as Record<string, unknown>)) {
          if (BLOCKED_ENV_KEYS.has(k.toUpperCase())) continue;
          const str = typeof v === "string" ? v : "";
          if (str.trim()) {
            process.env[k] = str;
          } else {
            delete process.env[k];
          }
        }
      }

      // 2) Direct env.* string keys (legacy)
      for (const [k, v] of Object.entries(envPatch)) {
        if (k === "vars" || k === "shellEnv") continue;
        if (BLOCKED_ENV_KEYS.has(k.toUpperCase())) continue;
        if (typeof v !== "string") continue;
        if (v.trim()) process.env[k] = v;
        else delete process.env[k];
      }

      // Keep config clean: drop empty env.vars entries so we don't persist
      // null/empty-string tombstones forever.
      const cfgEnv = (state.config as Record<string, unknown>).env;
      if (cfgEnv && typeof cfgEnv === "object" && !Array.isArray(cfgEnv)) {
        const cfgVars = (cfgEnv as Record<string, unknown>).vars;
        if (cfgVars && typeof cfgVars === "object" && !Array.isArray(cfgVars)) {
          for (const [k, v] of Object.entries(
            cfgVars as Record<string, unknown>,
          )) {
            if (typeof v !== "string" || !v.trim()) {
              delete (cfgVars as Record<string, unknown>)[k];
            }
          }
        }
      }
    }

    try {
      saveElizaConfig(state.config);
    } catch (err) {
      logger.warn(
        `[api] Config save failed: ${err instanceof Error ? err.message : err}`,
      );
    }
    json(res, redactConfigSecrets(state.config));
    return;
  }

  // ── GET /api/permissions/automation-mode ──────────────────────────────
  // Return agent automation permission mode for self-directed config actions.
  if (method === "GET" && pathname === "/api/permissions/automation-mode") {
    const mode = state.agentAutomationMode ?? "full";
    json(res, {
      mode,
      options: ["connectors-only", "full"] as AgentAutomationMode[],
    });
    return;
  }

  // ── PUT /api/permissions/automation-mode ──────────────────────────────
  // Update agent automation permission mode.
  if (method === "PUT" && pathname === "/api/permissions/automation-mode") {
    const body = await readJsonBody<{ mode?: unknown }>(req, res);
    if (!body) return;
    const parsed = parseAgentAutomationMode(body.mode);
    if (!parsed) {
      error(res, 'Invalid mode. Expected "connectors-only" or "full".', 400);
      return;
    }

    persistAgentAutomationMode(state, parsed);
    saveElizaConfig(state.config);

    json(res, {
      mode: parsed,
      options: ["connectors-only", "full"] as AgentAutomationMode[],
    });
    return;
  }

  // ── GET /api/permissions/trade-mode ────────────────────────────────────
  // Returns the current trade permission mode (must be before handlePermissionRoutes).
  if (method === "GET" && pathname === "/api/permissions/trade-mode") {
    const mode = resolveTradePermissionMode(state.config);
    json(res, {
      tradePermissionMode: mode,
      canUserLocalExecute: canUseLocalTradeExecution(mode, false),
      canAgentAutoTrade: canUseLocalTradeExecution(mode, true),
    });
    return;
  }

  // ── PUT /api/permissions/trade-mode ────────────────────────────────────
  // Update the trade permission mode.
  if (method === "PUT" && pathname === "/api/permissions/trade-mode") {
    const body = await readJsonBody<{ mode?: string }>(req, res);
    if (!body) return;

    const newMode = body.mode;
    if (
      newMode !== "user-sign-only" &&
      newMode !== "manual-local-key" &&
      newMode !== "agent-auto"
    ) {
      error(
        res,
        'mode must be "user-sign-only", "manual-local-key", or "agent-auto"',
        400,
      );
      return;
    }

    if (!state.config.features) {
      state.config.features = {};
    }
    (state.config.features as Record<string, unknown>).tradePermissionMode =
      newMode;

    try {
      saveElizaConfig(state.config);
    } catch (err) {
      logger.warn(
        `[api] Trade-mode config save failed: ${err instanceof Error ? err.message : err}`,
      );
    }

    json(res, {
      ok: true,
      tradePermissionMode: newMode,
      canUserLocalExecute: canUseLocalTradeExecution(newMode, false),
      canAgentAutoTrade: canUseLocalTradeExecution(newMode, true),
    });
    return;
  }

  if (
    await handlePermissionRoutes({
      req,
      res,
      method,
      pathname,
      state,
      readJsonBody,
      json,
      error,
      saveConfig: saveElizaConfig,
      scheduleRuntimeRestart,
    })
  ) {
    return;
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Agent self-status route
  // ═══════════════════════════════════════════════════════════════════════

  // ── GET /api/agent/self-status ──────────────────────────────────────────
  // Returns a snapshot of the agent's current capabilities and status,
  // used by action handlers (can-i, etc.) to evaluate permissions.
  if (method === "GET" && pathname === "/api/agent/self-status") {
    const addrs = getWalletAddresses();
    const evmAddress = addrs.evmAddress ?? null;
    const tradePermissionMode = resolveTradePermissionMode(state.config);
    const localSigner = Boolean(process.env.EVM_PRIVATE_KEY?.trim());
    const walletRpcReadiness = resolveWalletRpcReadiness(state.config);
    const bscRpcReady = walletRpcReadiness.managedBscRpcReady;
    const canLocalTrade = canUseLocalTradeExecution(tradePermissionMode, false);
    const canAgentAutoTrade = canUseLocalTradeExecution(
      tradePermissionMode,
      true,
    );
    const canTrade = Boolean(evmAddress) && bscRpcReady;
    const automationMode: "connectors-only" | "full" =
      (state.config.features as Record<string, unknown> | undefined)
        ?.automationMode === "full"
        ? "full"
        : "connectors-only";

    // Include registry snapshot summary if available
    let registrySummary: string | null = null;
    const registry = getGlobalAwarenessRegistry();
    if (registry && state.runtime) {
      try {
        registrySummary = await registry.composeSummary(state.runtime);
      } catch {
        // Non-fatal: registry may not be initialized yet
      }
    }

    // Resolve model from multiple sources (state.model → config → env)
    const resolvedModel =
      state.model ??
      detectRuntimeModel(state.runtime ?? null, state.config) ??
      null;

    // Derive provider label from model string
    const resolvedProvider = resolvedModel
      ? resolveProviderFromModel(resolvedModel)
      : null;

    // Gather plugin info from the runtime
    const pluginNames: string[] = [];
    const aiProviderNames: string[] = [];
    const connectorNames: string[] = [];
    const BROWSER_PLUGIN_IDS = new Set([
      "browser",
      "browserbase",
      "chrome-extension",
    ]);
    const COMPUTER_PLUGIN_IDS = new Set(["computeruse", "computer-use"]);
    let hasBrowserPlugin = false;
    let hasComputerPlugin = false;

    if (state.runtime && Array.isArray(state.runtime.plugins)) {
      for (const plugin of state.runtime.plugins) {
        const name = typeof plugin?.name === "string" ? plugin.name.trim() : "";
        if (!name) continue;
        pluginNames.push(name);
        const lower = name.toLowerCase();
        if (
          lower.includes("openai") ||
          lower.includes("anthropic") ||
          lower.includes("groq") ||
          lower.includes("gemini") ||
          lower.includes("openrouter") ||
          lower.includes("deepseek") ||
          lower.includes("ollama")
        ) {
          aiProviderNames.push(name);
        }
        if (
          lower.includes("discord") ||
          lower.includes("telegram") ||
          lower.includes("twitter") ||
          lower.includes("slack")
        ) {
          connectorNames.push(name);
        }
        if (BROWSER_PLUGIN_IDS.has(lower)) hasBrowserPlugin = true;
        if (COMPUTER_PLUGIN_IDS.has(lower)) hasComputerPlugin = true;
      }
    }

    json(res, {
      generatedAt: new Date().toISOString(),
      state: state.agentState,
      agentName: state.agentName,
      model: resolvedModel,
      provider: resolvedProvider,
      automationMode,
      tradePermissionMode,
      shellEnabled: state.shellEnabled !== false,
      wallet: {
        hasWallet: Boolean(evmAddress || addrs.solanaAddress),
        hasEvm: Boolean(evmAddress),
        hasSolana: Boolean(addrs.solanaAddress),
        evmAddress,
        evmAddressShort:
          evmAddress && evmAddress.length >= 12
            ? `${evmAddress.slice(0, 6)}...${evmAddress.slice(-4)}`
            : evmAddress,
        solanaAddress: addrs.solanaAddress ?? null,
        solanaAddressShort:
          addrs.solanaAddress && addrs.solanaAddress.length >= 12
            ? `${addrs.solanaAddress.slice(0, 4)}...${addrs.solanaAddress.slice(-4)}`
            : (addrs.solanaAddress ?? null),
        localSignerAvailable: localSigner,
        managedBscRpcReady: bscRpcReady,
      },
      plugins: {
        totalActive: pluginNames.length,
        active: pluginNames,
        aiProviders: aiProviderNames,
        connectors: connectorNames,
      },
      capabilities: {
        canTrade,
        canLocalTrade: canTrade && localSigner && canLocalTrade,
        canAutoTrade: canTrade && localSigner && canAgentAutoTrade,
        canUseBrowser: hasBrowserPlugin,
        canUseComputer: hasComputerPlugin,
        canRunTerminal: state.shellEnabled !== false,
        canInstallPlugins: true,
        canConfigurePlugins: true,
        canConfigureConnectors: true,
      },
      ...(registrySummary !== null ? { registrySummary } : {}),
    });
    return;
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Privy wallet routes
  // ═══════════════════════════════════════════════════════════════════════

  // ── GET /api/privy/status ───────────────────────────────────────────────
  if (method === "GET" && pathname === "/api/privy/status") {
    const enabled = isPrivyWalletProvisioningEnabled();
    json(res, { enabled, configured: enabled });
    return;
  }

  // ── POST /api/privy/login ───────────────────────────────────────────────
  // Provisions Privy wallets for a custom user ID (agent identifier).
  if (method === "POST" && pathname === "/api/privy/login") {
    if (!isPrivyWalletProvisioningEnabled()) {
      error(res, "Privy wallet provisioning is not configured.", 503);
      return;
    }
    const body = await readJsonBody<{ userId?: string }>(req, res);
    if (!body) return;

    const userId = (body.userId ?? "").trim();
    if (!userId) {
      error(res, "userId is required", 400);
      return;
    }

    try {
      const result = await ensurePrivyWalletsForCustomUser(userId);
      json(res, { ok: true, ...result });
    } catch (err) {
      logger.error(
        `[api] Privy login failed: ${err instanceof Error ? err.message : err}`,
      );
      error(
        res,
        `Privy login failed: ${err instanceof Error ? err.message : "unknown error"}`,
        500,
      );
    }
    return;
  }

  // ── POST /api/privy/logout ──────────────────────────────────────────────
  if (method === "POST" && pathname === "/api/privy/logout") {
    // No-op for server-side managed wallets; Privy sessions are stateless.
    json(res, { ok: true });
    return;
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Subscription status route
  // ═══════════════════════════════════════════════════════════════════════

  // ── GET /api/subscription/status (direct handler fallback) ─────────────
  // Note: subscription-routes.ts handles /api/subscription/* but this is
  // kept here in case the prefix routing is not active.
  // (handleSubscriptionRoutes already covers this, so no duplicate needed.)

  // ═══════════════════════════════════════════════════════════════════════
  // BSC trade routes
  // ═══════════════════════════════════════════════════════════════════════

  // ── POST /api/wallet/trade/preflight ───────────────────────────────────
  // Check BSC trade readiness (wallet, RPC, chain, gas).
  if (method === "POST" && pathname === "/api/wallet/trade/preflight") {
    const body = await readJsonBody<{ tokenAddress?: string }>(req, res);
    if (!body) return;

    const addrs = getWalletAddresses();
    const walletRpcReadiness = resolveWalletRpcReadiness(state.config);
    try {
      const result = await buildBscTradePreflight({
        walletAddress: addrs.evmAddress ?? null,
        tokenAddress: body.tokenAddress,
        rpcUrls: walletRpcReadiness.bscRpcUrls,
        cloudManagedAccess: walletRpcReadiness.cloudManagedAccess,
      });
      json(res, result);
    } catch (err) {
      logger.error(
        `[api] BSC trade preflight failed: ${err instanceof Error ? err.message : err}`,
      );
      error(
        res,
        `Trade preflight failed: ${err instanceof Error ? err.message : "unknown error"}`,
        500,
      );
    }
    return;
  }

  // ── POST /api/wallet/trade/quote ────────────────────────────────────────
  // Produce a BSC trade quote (unsigned transaction data).
  if (method === "POST" && pathname === "/api/wallet/trade/quote") {
    const body = await readJsonBody<{
      side?: string;
      tokenAddress?: string;
      amount?: string;
      slippageBps?: number;
    }>(req, res);
    if (!body) return;

    if (!body.side || !body.tokenAddress || !body.amount) {
      error(res, "side, tokenAddress, and amount are required", 400);
      return;
    }

    const addrs = getWalletAddresses();
    const walletRpcReadiness = resolveWalletRpcReadiness(state.config);
    try {
      const result = await buildBscTradeQuote({
        walletAddress: addrs.evmAddress ?? null,
        rpcUrls: walletRpcReadiness.bscRpcUrls,
        cloudManagedAccess: walletRpcReadiness.cloudManagedAccess,
        request: {
          side: body.side as "buy" | "sell",
          tokenAddress: body.tokenAddress,
          amount: body.amount,
          slippageBps: body.slippageBps,
        },
      });
      json(res, result);
    } catch (err) {
      logger.error(
        `[api] BSC trade quote failed: ${err instanceof Error ? err.message : err}`,
      );
      error(
        res,
        `Trade quote failed: ${err instanceof Error ? err.message : "unknown error"}`,
        500,
      );
    }
    return;
  }

  // ── POST /api/wallet/trade/execute ─────────────────────────────────────
  // Execute or prepare a BSC trade. In "user-sign-only" mode, returns an
  // unsigned transaction for the user to sign. In local-key modes, executes
  // using the server-side EVM private key.
  if (method === "POST" && pathname === "/api/wallet/trade/execute") {
    const body = await readJsonBody<{
      side?: string;
      tokenAddress?: string;
      amount?: string;
      slippageBps?: number;
      deadlineSeconds?: number;
      confirm?: boolean;
      source?: "agent" | "manual";
    }>(req, res);
    if (!body) return;

    if (!body.side || !body.tokenAddress || !body.amount) {
      error(res, "side, tokenAddress, and amount are required", 400);
      return;
    }

    const tradePermissionMode = resolveTradePermissionMode(state.config);
    const isAgentRequest = isAgentAutomationRequest(req);
    const hasLocalKey = Boolean(process.env.EVM_PRIVATE_KEY?.trim());
    const canExecuteLocally = canUseLocalTradeExecution(
      tradePermissionMode,
      isAgentRequest,
    );
    const addrs = getWalletAddresses();
    const walletRpcReadiness = resolveWalletRpcReadiness(state.config);

    try {
      const quote = await buildBscTradeQuote({
        walletAddress: addrs.evmAddress ?? null,
        rpcUrls: walletRpcReadiness.bscRpcUrls,
        cloudManagedAccess: walletRpcReadiness.cloudManagedAccess,
        request: {
          side: body.side as "buy" | "sell",
          tokenAddress: body.tokenAddress,
          amount: body.amount,
          slippageBps: body.slippageBps,
        },
      });

      const walletAddress = addrs.evmAddress ?? null;

      // Build the unsigned trade transaction
      const unsignedTx =
        quote.side === "buy"
          ? buildBscBuyUnsignedTx(quote, walletAddress, body.deadlineSeconds)
          : buildBscSellUnsignedTx(quote, walletAddress, body.deadlineSeconds);

      // Build approval tx for sell (if needed)
      let unsignedApprovalTx:
        | import("../contracts/wallet").BscUnsignedApprovalTx
        | undefined;
      let requiresApproval = false;
      if (quote.side === "sell" && walletAddress) {
        unsignedApprovalTx = buildBscApproveUnsignedTx(
          quote.tokenAddress,
          walletAddress,
          quote.routerAddress,
          quote.quoteIn.amountWei,
        );
        requiresApproval = true;
      }

      // If local execution is not permitted or no private key, return unsigned tx
      if (!hasLocalKey || !canExecuteLocally || body.confirm !== true) {
        json(res, {
          ok: true,
          side: quote.side,
          mode: hasLocalKey && canExecuteLocally ? "local-key" : "user-sign",
          quote,
          executed: false,
          requiresUserSignature: true,
          unsignedTx,
          unsignedApprovalTx,
          requiresApproval,
        });
        return;
      }

      // Execute locally with EVM private key
      const rpcUrl = resolvePrimaryBscRpcUrl({
        rpcUrls: walletRpcReadiness.bscRpcUrls,
        cloudManagedAccess: walletRpcReadiness.cloudManagedAccess,
      });

      if (!rpcUrl) {
        error(res, "BSC RPC not configured for local execution.", 503);
        return;
      }

      const evmKey = process.env.EVM_PRIVATE_KEY ?? "";
      const provider = new ethers.JsonRpcProvider(rpcUrl);
      const wallet = new ethers.Wallet(
        evmKey.startsWith("0x") ? evmKey : `0x${evmKey}`,
        provider,
      );

      const nonce = await provider.getTransactionCount(
        wallet.address,
        "pending",
      );

      // Execute approval first if needed
      let approvalHash: string | undefined;
      if (requiresApproval && unsignedApprovalTx) {
        const approvalTxReq: ethers.TransactionRequest = {
          to: unsignedApprovalTx.to,
          data: unsignedApprovalTx.data,
          value: BigInt(unsignedApprovalTx.valueWei),
          chainId: unsignedApprovalTx.chainId,
          nonce,
        };
        const approvalResponse = await wallet.sendTransaction(approvalTxReq);
        approvalHash = approvalResponse.hash;
        // Wait for approval to be mined before submitting trade
        await approvalResponse.wait(1);
      }

      const tradeTxReq: ethers.TransactionRequest = {
        to: unsignedTx.to,
        data: unsignedTx.data,
        value: BigInt(unsignedTx.valueWei),
        chainId: unsignedTx.chainId,
        nonce: requiresApproval ? nonce + 1 : nonce,
      };

      const tradeTxResponse = await wallet.sendTransaction(tradeTxReq);
      const tradeNonce = requiresApproval ? nonce + 1 : nonce;

      const executionResult = {
        hash: tradeTxResponse.hash,
        nonce: tradeNonce,
        gasLimit: tradeTxResponse.gasLimit?.toString() ?? "0",
        valueWei: unsignedTx.valueWei,
        explorerUrl: `https://bscscan.com/tx/${tradeTxResponse.hash}`,
        blockNumber: null as number | null,
        status: "pending" as "pending" | "success",
        approvalHash,
      };

      // Record in ledger
      const source = body.source ?? "manual";
      try {
        recordWalletTradeLedgerEntry({
          hash: tradeTxResponse.hash,
          source,
          side: quote.side,
          tokenAddress: quote.tokenAddress,
          slippageBps: quote.slippageBps,
          route: quote.route,
          quoteIn: {
            symbol: quote.quoteIn.symbol,
            amount: quote.quoteIn.amount,
            amountWei: quote.quoteIn.amountWei,
          },
          quoteOut: {
            symbol: quote.quoteOut.symbol,
            amount: quote.quoteOut.amount,
            amountWei: quote.quoteOut.amountWei,
          },
          status: "pending",
          confirmations: 0,
          nonce: tradeNonce,
          blockNumber: null,
          gasUsed: null,
          effectiveGasPriceWei: null,
          explorerUrl: executionResult.explorerUrl,
        });
      } catch (ledgerErr) {
        logger.warn(
          `[api] Failed to record trade ledger entry: ${ledgerErr instanceof Error ? ledgerErr.message : ledgerErr}`,
        );
      }

      provider.destroy();

      json(res, {
        ok: true,
        side: quote.side,
        mode: "local-key",
        quote,
        executed: true,
        requiresUserSignature: false,
        unsignedTx,
        unsignedApprovalTx,
        requiresApproval,
        execution: executionResult,
      });
    } catch (err) {
      logger.error(
        `[api] BSC trade execute failed: ${err instanceof Error ? err.message : err}`,
      );
      error(
        res,
        `Trade execution failed: ${err instanceof Error ? err.message : "unknown error"}`,
        500,
      );
    }
    return;
  }

  // ── GET /api/wallet/trade/tx-status ────────────────────────────────────
  // Check the on-chain status of a BSC transaction by hash.
  if (method === "GET" && pathname === "/api/wallet/trade/tx-status") {
    const hash = url.searchParams.get("hash");
    if (!hash?.trim()) {
      error(res, "hash query parameter is required", 400);
      return;
    }

    const walletRpcReadiness = resolveWalletRpcReadiness(state.config);
    const rpcUrl = resolvePrimaryBscRpcUrl({
      rpcUrls: walletRpcReadiness.bscRpcUrls,
      cloudManagedAccess: walletRpcReadiness.cloudManagedAccess,
    });

    if (!rpcUrl) {
      error(res, "BSC RPC not configured.", 503);
      return;
    }

    try {
      const provider = new ethers.JsonRpcProvider(rpcUrl);
      const receipt = await provider.getTransactionReceipt(hash);

      let txStatus: "pending" | "success" | "reverted" | "not_found";
      let blockNumber: number | null = null;
      let gasUsed: string | null = null;
      let effectiveGasPriceWei: string | null = null;
      let confirmations = 0;
      let nonce: number | null = null;

      if (!receipt) {
        // Check if tx is in mempool
        const tx = await provider.getTransaction(hash);
        txStatus = tx ? "pending" : "not_found";
        if (tx) nonce = tx.nonce;
      } else {
        txStatus = receipt.status === 1 ? "success" : "reverted";
        blockNumber = receipt.blockNumber ?? null;
        gasUsed = receipt.gasUsed?.toString() ?? null;
        effectiveGasPriceWei = receipt.gasPrice?.toString() ?? null;
        const currentBlock = await provider.getBlockNumber();
        confirmations =
          blockNumber !== null ? Math.max(0, currentBlock - blockNumber) : 0;
        const tx = await provider.getTransaction(hash);
        if (tx) nonce = tx.nonce;
      }

      // Update ledger if we have a definitive status
      if (txStatus === "success" || txStatus === "reverted") {
        try {
          updateWalletTradeLedgerEntryStatus(hash, {
            status: txStatus,
            confirmations,
            nonce,
            blockNumber,
            gasUsed,
            effectiveGasPriceWei,
            explorerUrl: `https://bscscan.com/tx/${hash}`,
          });
        } catch (ledgerErr) {
          logger.warn(
            `[api] Failed to update trade ledger: ${ledgerErr instanceof Error ? ledgerErr.message : ledgerErr}`,
          );
        }
      }

      provider.destroy();

      json(res, {
        ok: true,
        hash,
        status: txStatus,
        explorerUrl: `https://bscscan.com/tx/${hash}`,
        chainId: 56,
        blockNumber,
        confirmations,
        nonce,
        gasUsed,
        effectiveGasPriceWei,
      });
    } catch (err) {
      logger.error(
        `[api] BSC tx-status failed: ${err instanceof Error ? err.message : err}`,
      );
      error(
        res,
        `TX status check failed: ${err instanceof Error ? err.message : "unknown error"}`,
        500,
      );
    }
    return;
  }

  // ── GET /api/wallet/trading/profile ────────────────────────────────────
  // Returns trading P&L profile from the local ledger.
  if (method === "GET" && pathname === "/api/wallet/trading/profile") {
    const windowParam = url.searchParams.get("window");
    const sourceParam = url.searchParams.get("source");

    const window =
      windowParam === "7d" || windowParam === "30d" || windowParam === "all"
        ? windowParam
        : "30d";
    const source =
      sourceParam === "agent" ||
      sourceParam === "manual" ||
      sourceParam === "all"
        ? sourceParam
        : "all";

    try {
      const profile = loadWalletTradingProfile({ window, source });
      json(res, profile);
    } catch (err) {
      logger.error(
        `[api] Wallet trading profile failed: ${err instanceof Error ? err.message : err}`,
      );
      error(
        res,
        `Trading profile fetch failed: ${err instanceof Error ? err.message : "unknown error"}`,
        500,
      );
    }
    return;
  }

  // ── POST /api/wallet/transfer/execute ──────────────────────────────────
  // Execute or prepare a BNB/ERC-20 token transfer.
  if (method === "POST" && pathname === "/api/wallet/transfer/execute") {
    const body = await readJsonBody<{
      toAddress?: string;
      amount?: string;
      assetSymbol?: string;
      tokenAddress?: string;
      confirm?: boolean;
    }>(req, res);
    if (!body) return;

    if (
      !body.toAddress?.trim() ||
      !body.amount?.trim() ||
      !body.assetSymbol?.trim()
    ) {
      error(res, "toAddress, amount, and assetSymbol are required", 400);
      return;
    }

    const tradePermissionMode = resolveTradePermissionMode(state.config);
    const isAgentRequest = isAgentAutomationRequest(req);
    const hasLocalKey = Boolean(process.env.EVM_PRIVATE_KEY?.trim());
    const canExecuteLocally = canUseLocalTradeExecution(
      tradePermissionMode,
      isAgentRequest,
    );
    const addrs = getWalletAddresses();
    const walletRpcReadiness = resolveWalletRpcReadiness(state.config);

    let toAddress: string;
    try {
      toAddress = ethers.getAddress(body.toAddress.trim());
    } catch {
      error(res, "Invalid toAddress — must be a valid EVM address", 400);
      return;
    }

    const isBnb = body.assetSymbol.toUpperCase() === "BNB";

    // Fetch actual token decimals to avoid wrong amounts for USDC (6), USDT (6), etc.
    let decimals = 18;
    if (body.tokenAddress) {
      try {
        const tokenContract = new ethers.Contract(
          body.tokenAddress,
          ["function decimals() view returns (uint8)"],
          new ethers.JsonRpcProvider(
            resolvePrimaryBscRpcUrl({
              rpcUrls: walletRpcReadiness.bscRpcUrls,
              cloudManagedAccess: walletRpcReadiness.cloudManagedAccess,
            }) ?? "https://bsc-dataseed1.binance.org/",
          ),
        );
        decimals = Number(await tokenContract.decimals());
      } catch {
        // Fallback to 18 if decimals call fails
      }
    }

    // Build unsigned transfer tx for user-sign mode
    const unsignedTx = {
      chainId: 56,
      from: addrs.evmAddress ?? null,
      to: isBnb ? toAddress : (body.tokenAddress ?? toAddress),
      data: isBnb
        ? "0x"
        : (() => {
            const iface = new ethers.Interface([
              "function transfer(address to, uint256 amount) returns (bool)",
            ]);
            return iface.encodeFunctionData("transfer", [
              toAddress,
              ethers.parseUnits(body.amount?.trim(), decimals),
            ]);
          })(),
      valueWei: isBnb ? ethers.parseEther(body.amount.trim()).toString() : "0",
      explorerUrl: "https://bscscan.com",
      assetSymbol: body.assetSymbol,
      amount: body.amount.trim(),
      tokenAddress: body.tokenAddress,
    };

    if (!hasLocalKey || !canExecuteLocally || body.confirm !== true) {
      json(res, {
        ok: true,
        mode: hasLocalKey && canExecuteLocally ? "local-key" : "user-sign",
        executed: false,
        requiresUserSignature: true,
        toAddress,
        amount: body.amount.trim(),
        assetSymbol: body.assetSymbol,
        tokenAddress: body.tokenAddress,
        unsignedTx,
      });
      return;
    }

    // Execute locally
    const rpcUrl = resolvePrimaryBscRpcUrl({
      rpcUrls: walletRpcReadiness.bscRpcUrls,
      cloudManagedAccess: walletRpcReadiness.cloudManagedAccess,
    });

    if (!rpcUrl) {
      error(res, "BSC RPC not configured for local execution.", 503);
      return;
    }

    try {
      const evmKey = process.env.EVM_PRIVATE_KEY ?? "";
      const provider = new ethers.JsonRpcProvider(rpcUrl);
      const wallet = new ethers.Wallet(
        evmKey.startsWith("0x") ? evmKey : `0x${evmKey}`,
        provider,
      );

      const txReq: ethers.TransactionRequest = {
        to: unsignedTx.to,
        data: unsignedTx.data,
        value: BigInt(unsignedTx.valueWei),
        chainId: unsignedTx.chainId,
      };

      const txResponse = await wallet.sendTransaction(txReq);
      const nonce = txResponse.nonce;

      provider.destroy();

      json(res, {
        ok: true,
        mode: "local-key",
        executed: true,
        requiresUserSignature: false,
        toAddress,
        amount: body.amount.trim(),
        assetSymbol: body.assetSymbol,
        tokenAddress: body.tokenAddress,
        unsignedTx,
        execution: {
          hash: txResponse.hash,
          nonce,
          gasLimit: txResponse.gasLimit?.toString() ?? "0",
          valueWei: unsignedTx.valueWei,
          explorerUrl: `https://bscscan.com/tx/${txResponse.hash}`,
          blockNumber: null,
          status: "pending",
        },
      });
    } catch (err) {
      logger.error(
        `[api] Transfer execute failed: ${err instanceof Error ? err.message : err}`,
      );
      error(
        res,
        `Transfer failed: ${err instanceof Error ? err.message : "unknown error"}`,
        500,
      );
    }
    return;
  }

  // ── POST /api/wallet/production-defaults ───────────────────────────────
  // Apply opinionated production wallet configuration defaults.
  // Sets sensible BSC RPC and trade permission defaults when not already
  // configured.
  if (method === "POST" && pathname === "/api/wallet/production-defaults") {
    const changed: string[] = [];

    if (!state.config.features) {
      state.config.features = {};
    }
    const features = state.config.features as Record<string, unknown>;

    // Default trade permission mode: user-sign-only (safe default)
    if (!features.tradePermissionMode) {
      features.tradePermissionMode = "user-sign-only";
      changed.push("tradePermissionMode=user-sign-only");
    }

    if (changed.length > 0) {
      try {
        saveElizaConfig(state.config);
      } catch (err) {
        logger.warn(
          `[api] production-defaults config save failed: ${err instanceof Error ? err.message : err}`,
        );
      }
    }

    json(res, {
      ok: true,
      applied: changed,
      tradePermissionMode: resolveTradePermissionMode(state.config),
    });
    return;
  }

  // ── Cloud routes (/api/cloud/*) ─────────────────────────────────────────
  if (pathname.startsWith("/api/cloud/")) {
    const billingHandled = await handleCloudBillingRoute(
      req,
      res,
      pathname,
      method,
      { config: state.config },
    );
    if (billingHandled) return;

    // Compat proxy routes — transparent proxy to Eliza Cloud v2 /api/compat/*
    const compatHandled = await handleCloudCompatRoute(
      req,
      res,
      pathname,
      method,
      { config: state.config },
    );
    if (compatHandled) return;

    const cloudState: CloudRouteState = {
      config: state.config,
      cloudManager: state.cloudManager,
      runtime: state.runtime,
      saveConfig: saveElizaConfig,
      createTelemetrySpan: createIntegrationTelemetrySpan,
    };
    const handled = await handleCloudRoute(
      req,
      res,
      pathname,
      method,
      cloudState,
    );
    if (handled) return;
  }

  // ── Sandbox routes (/api/sandbox/*) ────────────────────────────────────
  if (pathname.startsWith("/api/sandbox")) {
    const handled = await handleSandboxRoute(req, res, pathname, method, {
      sandboxManager: state.sandboxManager,
    });
    if (handled) return;
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Conversation routes (/api/conversations/*)
  // ═══════════════════════════════════════════════════════════════════════

  const ensureAdminEntityId = (): UUID => {
    if (state.adminEntityId) {
      return state.adminEntityId;
    }
    const configured = state.config.agents?.defaults?.adminEntityId?.trim();
    const nextAdminEntityId =
      configured && isUuidLike(configured)
        ? configured
        : (stringToUuid(`${state.agentName}-admin-entity`) as UUID);
    if (configured && !isUuidLike(configured)) {
      logger.warn(
        `[milady-api] Invalid agents.defaults.adminEntityId "${configured}", using deterministic fallback`,
      );
    }
    state.adminEntityId = nextAdminEntityId;
    state.chatUserId = state.adminEntityId;
    return nextAdminEntityId;
  };

  // Ensure ownership + admin role metadata contract on the world.
  const ensureWorldOwnershipAndRoles = async (
    runtime: AgentRuntime,
    worldId: UUID,
    ownerId: UUID,
  ): Promise<void> => {
    const world = await runtime.getWorld(worldId);
    if (!world) return;
    let needsUpdate = false;
    if (!world.metadata) {
      world.metadata = {};
      needsUpdate = true;
    }
    if (
      !world.metadata.ownership ||
      typeof world.metadata.ownership !== "object" ||
      (world.metadata.ownership as { ownerId?: string }).ownerId !== ownerId
    ) {
      world.metadata.ownership = { ownerId };
      needsUpdate = true;
    }
    const metadataWithRoles = world.metadata as {
      roles?: Record<string, string>;
    };
    const roles = metadataWithRoles.roles ?? {};
    if (roles[ownerId] !== "OWNER") {
      roles[ownerId] = "OWNER";
      metadataWithRoles.roles = roles;
      needsUpdate = true;
    }
    if (needsUpdate) {
      await runtime.updateWorld(world);
    }
  };

  const markConversationDeleted = (conversationId: string): void => {
    const normalizedId = conversationId.trim();
    if (!normalizedId) return;
    if (state.deletedConversationIds.has(normalizedId)) return;

    state.deletedConversationIds.add(normalizedId);
    while (state.deletedConversationIds.size > MAX_DELETED_CONVERSATION_IDS) {
      const oldest = state.deletedConversationIds.values().next().value;
      if (!oldest) break;
      state.deletedConversationIds.delete(oldest);
    }

    try {
      persistDeletedConversationIdsToState(state.deletedConversationIds);
    } catch (err) {
      logger.warn(
        `[conversations] Failed to persist deleted conversation tombstones: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  };

  const deleteConversationRoomData = async (
    runtime: AgentRuntime,
    roomId: UUID,
  ): Promise<void> => {
    const runtimeWithDelete = runtime as AgentRuntime & {
      deleteRoom?: (id: UUID) => Promise<unknown>;
      adapter?: {
        db?: {
          deleteRoom?: (id: UUID) => Promise<unknown>;
        };
      };
    };

    if (typeof runtimeWithDelete.deleteRoom === "function") {
      await runtimeWithDelete.deleteRoom(roomId);
      return;
    }

    const dbDeleteRoom = runtimeWithDelete.adapter?.db?.deleteRoom;
    if (typeof dbDeleteRoom === "function") {
      await dbDeleteRoom.call(runtimeWithDelete.adapter?.db, roomId);
    }
  };

  const deleteConversationMemories = async (
    runtime: AgentRuntime,
    memoryIds: UUID[],
  ): Promise<number> => {
    if (memoryIds.length === 0) return 0;

    const runtimeWithDelete = runtime as AgentRuntime & {
      deleteManyMemories?: (memoryIds: UUID[]) => Promise<unknown>;
      deleteMemory?: (memoryId: UUID) => Promise<unknown>;
      removeMemory?: (memoryId: UUID) => Promise<unknown>;
      adapter?: {
        db?: {
          deleteManyMemories?: (memoryIds: UUID[]) => Promise<unknown>;
          deleteMemory?: (memoryId: UUID) => Promise<unknown>;
          removeMemory?: (memoryId: UUID) => Promise<unknown>;
        };
      };
    };

    if (typeof runtimeWithDelete.deleteManyMemories === "function") {
      await runtimeWithDelete.deleteManyMemories(memoryIds);
      return memoryIds.length;
    }

    const dbDeleteMany = runtimeWithDelete.adapter?.db?.deleteManyMemories;
    if (typeof dbDeleteMany === "function") {
      await dbDeleteMany.call(runtimeWithDelete.adapter?.db, memoryIds);
      return memoryIds.length;
    }

    let deletedCount = 0;
    for (const memoryId of memoryIds) {
      if (typeof runtimeWithDelete.deleteMemory === "function") {
        await runtimeWithDelete.deleteMemory(memoryId);
      } else if (typeof runtimeWithDelete.removeMemory === "function") {
        await runtimeWithDelete.removeMemory(memoryId);
      } else if (
        typeof runtimeWithDelete.adapter?.db?.deleteMemory === "function"
      ) {
        await runtimeWithDelete.adapter.db.deleteMemory.call(
          runtimeWithDelete.adapter.db,
          memoryId,
        );
      } else if (
        typeof runtimeWithDelete.adapter?.db?.removeMemory === "function"
      ) {
        await runtimeWithDelete.adapter.db.removeMemory.call(
          runtimeWithDelete.adapter.db,
          memoryId,
        );
      } else {
        const unsupportedError = new Error(
          "Conversation message deletion is not supported by this runtime",
        ) as Error & { status?: number };
        unsupportedError.status = 501;
        throw unsupportedError;
      }
      deletedCount += 1;
    }

    return deletedCount;
  };

  // Helper: ensure the room for a conversation is set up.
  // Also ensures the world has ownership metadata so the settings provider
  // can find it via findWorldsForOwner during onboarding.
  const ensureConversationRoom = async (
    conv: ConversationMeta,
  ): Promise<void> => {
    if (!state.runtime) return;
    const runtime = state.runtime;
    const agentName = runtime.character.name ?? "Milady";
    const userId = ensureAdminEntityId();
    const worldId = stringToUuid(`${agentName}-web-chat-world`);
    const messageServerId = stringToUuid(`${agentName}-web-server`) as UUID;
    await runtime.ensureConnection({
      entityId: userId,
      roomId: conv.roomId,
      worldId,
      userName: "User",
      source: "client_chat",
      channelId: `web-conv-${conv.id}`,
      type: ChannelType.DM,
      messageServerId,
      metadata: { ownership: { ownerId: userId } },
    });
    await ensureWorldOwnershipAndRoles(runtime, worldId as UUID, userId);
  };

  const syncConversationRoomTitle = async (
    conv: ConversationMeta,
  ): Promise<void> => {
    try {
      await persistConversationRoomTitle(state.runtime, conv);
    } catch (err) {
      logger.debug(
        `[conversations] Failed to persist room title for ${conv.id}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  };

  const waitForConversationRestore = async (): Promise<void> => {
    const pending = state.conversationRestorePromise;
    if (!pending) return;
    try {
      const timeout = new Promise<void>((_, reject) =>
        setTimeout(
          () =>
            reject(new Error("Conversation restore timed out after 5000ms")),
          5000,
        ),
      );
      await Promise.race([pending, timeout]);
    } catch {
      // Restore failures (including timeout) are logged at the source.
      // Routes should continue with the best available in-memory state
      // instead of surfacing the restore implementation detail as an API error.
    }
  };

  const getConversationWithRestore = async (
    convId: string,
  ): Promise<ConversationMeta | undefined> => {
    const existing = state.conversations.get(convId);
    if (existing) return existing;
    await waitForConversationRestore();
    return state.conversations.get(convId);
  };

  const ensureConversationGreetingStored = async (
    conv: ConversationMeta,
    lang: string,
  ): Promise<{
    text: string;
    agentName: string;
    generated: boolean;
    persisted: boolean;
  }> => {
    const runtime = state.runtime;
    const agentName = runtime?.character.name ?? state.agentName ?? "Milady";
    if (!runtime) {
      return {
        text: "",
        agentName,
        generated: false,
        persisted: false,
      };
    }

    let memories: Awaited<ReturnType<AgentRuntime["getMemories"]>>;
    try {
      memories = await runtime.getMemories({
        roomId: conv.roomId,
        tableName: "messages",
        count: 12,
      });
    } catch (err) {
      throw new Error(
        `Failed to inspect existing conversation messages: ${getErrorMessage(err)}`,
      );
    }

    memories.sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0));
    const existingGreeting = memories.find((memory) => {
      const content = memory.content as Record<string, unknown> | undefined;
      return (
        memory.entityId === runtime.agentId &&
        content?.source === "agent_greeting" &&
        typeof content.text === "string" &&
        content.text.trim().length > 0
      );
    });
    if (existingGreeting) {
      return {
        text: String(
          (existingGreeting.content as Record<string, unknown> | undefined)
            ?.text ?? "",
        ),
        agentName,
        generated: true,
        persisted: false,
      };
    }

    if (memories.length > 0) {
      return {
        text: "",
        agentName,
        generated: false,
        persisted: false,
      };
    }

    const greeting = resolveConversationGreetingText(runtime, lang).trim();
    if (!greeting) {
      return {
        text: "",
        agentName,
        generated: false,
        persisted: false,
      };
    }

    try {
      await persistConversationMemory(
        runtime,
        createMessageMemory({
          id: crypto.randomUUID() as UUID,
          entityId: runtime.agentId,
          roomId: conv.roomId,
          content: {
            text: greeting,
            source: "agent_greeting",
            channelType: ChannelType.DM,
          },
        }),
      );
    } catch (err) {
      throw new Error(
        `Failed to store greeting message: ${getErrorMessage(err)}`,
      );
    }

    conv.updatedAt = new Date().toISOString();
    return {
      text: greeting,
      agentName,
      generated: true,
      persisted: true,
    };
  };

  const ensureLegacyChatConnection = async (
    runtime: AgentRuntime,
    agentName: string,
  ): Promise<void> => {
    const userId = ensureAdminEntityId();
    if (!state.chatRoomId) {
      state.chatRoomId = stringToUuid(`${agentName}-web-chat-room`);
    }
    state.chatUserId = userId;

    const roomId = state.chatRoomId;
    const worldId = stringToUuid(`${agentName}-web-chat-world`) as UUID;
    const messageServerId = stringToUuid(`${agentName}-web-server`) as UUID;
    const target = { userId, roomId, worldId };

    while (true) {
      const ready = state.chatConnectionReady;
      if (
        ready &&
        ready.userId === target.userId &&
        ready.roomId === target.roomId &&
        ready.worldId === target.worldId
      ) {
        return;
      }

      if (!state.chatConnectionPromise) {
        state.chatConnectionPromise = (async () => {
          await runtime.ensureConnection({
            entityId: target.userId,
            roomId: target.roomId,
            worldId: target.worldId,
            userName: "User",
            source: "client_chat",
            channelId: `${agentName}-web-chat`,
            type: ChannelType.DM,
            messageServerId,
            metadata: { ownership: { ownerId: target.userId } },
          });
          await ensureWorldOwnershipAndRoles(
            runtime,
            target.worldId,
            target.userId,
          );
          state.chatConnectionReady = target;
        })().finally(() => {
          state.chatConnectionPromise = null;
        });
      }

      await state.chatConnectionPromise;
    }
  };

  const truncateConversationMessages = async (
    runtime: AgentRuntime,
    conv: ConversationMeta,
    messageId: string,
    options?: { inclusive?: boolean },
  ): Promise<{ deletedCount: number }> => {
    const memories = await runtime.getMemories({
      roomId: conv.roomId,
      tableName: "messages",
      count: 1000,
    });

    memories.sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0));
    const targetIndex = memories.findIndex((memory) => memory.id === messageId);
    if (targetIndex < 0) {
      const notFoundError = new Error(
        "Conversation message not found",
      ) as Error & {
        status?: number;
      };
      notFoundError.status = 404;
      throw notFoundError;
    }

    const deleteStartIndex =
      options?.inclusive === true ? targetIndex : targetIndex + 1;
    const memoryIds = memories
      .slice(deleteStartIndex)
      .map((memory) => memory.id)
      .filter(
        (memoryId): memoryId is UUID =>
          typeof memoryId === "string" && memoryId.trim().length > 0,
      );

    const deletedCount = await deleteConversationMemories(runtime, memoryIds);
    return { deletedCount };
  };

  const ensureCompatChatConnection = async (
    runtime: AgentRuntime,
    agentName: string,
    channelIdPrefix: string,
    roomKey: string,
  ): Promise<{ userId: UUID; roomId: UUID; worldId: UUID }> => {
    const userId = ensureAdminEntityId();
    const roomId = stringToUuid(
      `${agentName}-${channelIdPrefix}-room-${roomKey}`,
    ) as UUID;
    const worldId = stringToUuid(`${agentName}-web-chat-world`) as UUID;
    const messageServerId = stringToUuid(`${agentName}-web-server`) as UUID;

    await runtime.ensureConnection({
      entityId: userId,
      roomId,
      worldId,
      userName: "User",
      source: "client_chat",
      channelId: `${channelIdPrefix}-${roomKey}`,
      type: ChannelType.DM,
      messageServerId,
      metadata: { ownership: { ownerId: userId } },
    });
    await ensureWorldOwnershipAndRoles(runtime, worldId, userId);

    return { userId, roomId, worldId };
  };

  // -------------------------------------------------------------------------
  // OpenAI / Anthropic compatibility endpoints
  // -------------------------------------------------------------------------

  // ── GET /v1/models (OpenAI compatible) ─────────────────────────────────
  if (method === "GET" && pathname === "/v1/models") {
    const created = Math.floor(Date.now() / 1000);
    const ids = new Set<string>();
    ids.add("milady");
    if (state.agentName?.trim()) ids.add(state.agentName.trim());
    if (state.runtime?.character.name?.trim())
      ids.add(state.runtime.character.name.trim());

    json(res, {
      object: "list",
      data: Array.from(ids).map((id) => ({
        id,
        object: "model",
        created,
        owned_by: "milady",
      })),
    });
    return;
  }

  // ── GET /v1/models/:id (OpenAI compatible) ─────────────────────────────
  if (method === "GET" && /^\/v1\/models\/[^/]+$/.test(pathname)) {
    const created = Math.floor(Date.now() / 1000);
    const raw = pathname.split("/")[3] ?? "";
    const decoded = decodePathComponent(raw, res, "model id");
    if (!decoded) return;
    const id = decoded.trim();
    if (!id) {
      json(
        res,
        {
          error: {
            message: "Model id is required",
            type: "invalid_request_error",
          },
        },
        400,
      );
      return;
    }
    json(res, { id, object: "model", created, owned_by: "milady" });
    return;
  }

  // ── POST /v1/chat/completions (OpenAI compatible) ──────────────────────
  if (method === "POST" && pathname === "/v1/chat/completions") {
    const body = await readJsonBody<Record<string, unknown>>(req, res);
    if (!body) return;
    if (hasBlockedObjectKeyDeep(body)) {
      json(
        res,
        {
          error: {
            message: "Request body contains a blocked object key",
            type: "invalid_request_error",
          },
        },
        400,
      );
      return;
    }
    const safeBody = cloneWithoutBlockedObjectKeys(body);

    const extracted = extractOpenAiSystemAndLastUser(safeBody.messages);
    if (!extracted) {
      json(
        res,
        {
          error: {
            message:
              "messages must be an array containing at least one user message",
            type: "invalid_request_error",
          },
        },
        400,
      );
      return;
    }

    const roomKey = resolveCompatRoomKey(safeBody).slice(0, 120);
    const wantsStream =
      safeBody.stream === true ||
      (req.headers.accept ?? "").includes("text/event-stream");
    const requestedModel =
      typeof safeBody.model === "string" && safeBody.model.trim()
        ? safeBody.model.trim()
        : null;

    const prompt = extracted.system
      ? `${extracted.system}\n\n${extracted.user}`.trim()
      : extracted.user;

    const created = Math.floor(Date.now() / 1000);
    const id = `chatcmpl-${crypto.randomUUID()}`;
    const model = requestedModel ?? state.agentName ?? "milady";

    if (wantsStream) {
      initSse(res);
      let aborted = false;
      req.on("close", () => {
        aborted = true;
      });

      const sendChunk = (
        delta: Record<string, unknown>,
        finishReason: string | null,
      ) => {
        writeSseData(
          res,
          JSON.stringify({
            id,
            object: "chat.completion.chunk",
            created,
            model,
            choices: [
              {
                index: 0,
                delta,
                finish_reason: finishReason,
              },
            ],
          }),
        );
      };

      try {
        if (!state.runtime) {
          writeSseData(
            res,
            JSON.stringify({
              error: {
                message: "Agent is not running",
                type: "service_unavailable",
              },
            }),
          );
          writeSseData(res, "[DONE]");
          return;
        }

        sendChunk({ role: "assistant" }, null);

        let fullText = "";

        {
          const runtime = state.runtime;
          if (!runtime) throw new Error("Agent is not running");
          const agentName = runtime.character.name ?? "Milady";
          const { userId, roomId } = await ensureCompatChatConnection(
            runtime,
            agentName,
            "openai-compat",
            roomKey,
          );

          const message = createMessageMemory({
            id: crypto.randomUUID() as UUID,
            entityId: userId,
            agentId: runtime.agentId,
            roomId,
            content: {
              text: prompt,
              source: "compat_openai",
              channelType: ChannelType.API,
            },
          });

          await generateChatResponse(runtime, message, state.agentName, {
            isAborted: () => aborted,
            onChunk: (chunk) => {
              fullText += chunk;
              if (chunk) sendChunk({ content: chunk }, null);
            },
            resolveNoResponseText: () =>
              resolveNoResponseFallback(state.logBuffer, runtime),
          });
        }

        const resolved = normalizeChatResponseText(
          fullText,
          state.logBuffer,
          state.runtime,
        );
        if (
          (fullText.trim().length === 0 || isNoResponsePlaceholder(fullText)) &&
          resolved.trim()
        ) {
          // Ensure clients receive a non-empty completion even if the model returned "(no response)".
          sendChunk({ content: resolved }, null);
        }

        sendChunk({}, "stop");
        writeSseData(res, "[DONE]");
      } catch (err) {
        if (!aborted) {
          writeSseData(
            res,
            JSON.stringify({
              error: {
                message: getErrorMessage(err),
                type: "server_error",
              },
            }),
          );
          writeSseData(res, "[DONE]");
        }
      } finally {
        res.end();
      }
      return;
    }

    // Non-streaming
    try {
      let responseText: string;

      {
        if (!state.runtime) {
          json(
            res,
            {
              error: {
                message: "Agent is not running",
                type: "service_unavailable",
              },
            },
            503,
          );
          return;
        }
        const runtime = state.runtime;
        const agentName = runtime.character.name ?? "Milady";
        const { userId, roomId } = await ensureCompatChatConnection(
          runtime,
          agentName,
          "openai-compat",
          roomKey,
        );
        const message = createMessageMemory({
          id: crypto.randomUUID() as UUID,
          entityId: userId,
          roomId,
          content: {
            text: prompt,
            source: "compat_openai",
            channelType: ChannelType.API,
          },
        });
        const result = await generateChatResponse(
          runtime,
          message,
          state.agentName,
          {
            resolveNoResponseText: () =>
              resolveNoResponseFallback(state.logBuffer, runtime),
          },
        );
        responseText = result.text;
      }

      const resolvedText = normalizeChatResponseText(
        responseText,
        state.logBuffer,
        state.runtime,
      );
      json(res, {
        id,
        object: "chat.completion",
        created,
        model,
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: resolvedText },
            finish_reason: "stop",
          },
        ],
      });
    } catch (err) {
      json(
        res,
        { error: { message: getErrorMessage(err), type: "server_error" } },
        500,
      );
    }
    return;
  }

  // ── POST /v1/messages (Anthropic compatible) ───────────────────────────
  if (method === "POST" && pathname === "/v1/messages") {
    const body = await readJsonBody<Record<string, unknown>>(req, res);
    if (!body) return;
    if (hasBlockedObjectKeyDeep(body)) {
      json(
        res,
        {
          error: {
            type: "invalid_request_error",
            message: "Request body contains a blocked object key",
          },
        },
        400,
      );
      return;
    }
    const safeBody = cloneWithoutBlockedObjectKeys(body);

    const extracted = extractAnthropicSystemAndLastUser({
      system: safeBody.system,
      messages: safeBody.messages,
    });
    if (!extracted) {
      json(
        res,
        {
          error: {
            type: "invalid_request_error",
            message:
              "messages must be an array containing at least one user message",
          },
        },
        400,
      );
      return;
    }

    const roomKey = resolveCompatRoomKey(safeBody).slice(0, 120);
    const wantsStream =
      safeBody.stream === true ||
      (req.headers.accept ?? "").includes("text/event-stream");
    const requestedModel =
      typeof safeBody.model === "string" && safeBody.model.trim()
        ? safeBody.model.trim()
        : null;

    const prompt = extracted.system
      ? `${extracted.system}\n\n${extracted.user}`.trim()
      : extracted.user;

    const id = `msg_${crypto.randomUUID().replace(/-/g, "")}`;
    const model = requestedModel ?? state.agentName ?? "milady";

    if (wantsStream) {
      initSse(res);
      let aborted = false;
      req.on("close", () => {
        aborted = true;
      });

      try {
        if (!state.runtime) {
          writeSseJson(
            res,
            {
              type: "error",
              error: {
                type: "service_unavailable",
                message: "Agent is not running",
              },
            },
            "error",
          );
          return;
        }

        writeSseJson(
          res,
          {
            type: "message_start",
            message: {
              id,
              type: "message",
              role: "assistant",
              model,
              content: [],
              stop_reason: null,
              stop_sequence: null,
              usage: { input_tokens: 0, output_tokens: 0 },
            },
          },
          "message_start",
        );
        writeSseJson(
          res,
          {
            type: "content_block_start",
            index: 0,
            content_block: { type: "text", text: "" },
          },
          "content_block_start",
        );

        let fullText = "";

        const onDelta = (chunk: string) => {
          if (!chunk) return;
          fullText += chunk;
          writeSseJson(
            res,
            {
              type: "content_block_delta",
              index: 0,
              delta: { type: "text_delta", text: chunk },
            },
            "content_block_delta",
          );
        };

        {
          const runtime = state.runtime;
          if (!runtime) throw new Error("Agent is not running");
          const agentName = runtime.character.name ?? "Milady";
          const { userId, roomId } = await ensureCompatChatConnection(
            runtime,
            agentName,
            "anthropic-compat",
            roomKey,
          );

          const message = createMessageMemory({
            id: crypto.randomUUID() as UUID,
            entityId: userId,
            roomId,
            content: {
              text: prompt,
              source: "compat_anthropic",
              channelType: ChannelType.API,
            },
          });

          await generateChatResponse(runtime, message, state.agentName, {
            isAborted: () => aborted,
            onChunk: onDelta,
            resolveNoResponseText: () =>
              resolveNoResponseFallback(state.logBuffer, runtime),
          });
        }

        const resolved = normalizeChatResponseText(
          fullText,
          state.logBuffer,
          state.runtime,
        );
        if (
          (fullText.trim().length === 0 || isNoResponsePlaceholder(fullText)) &&
          resolved.trim()
        ) {
          onDelta(resolved);
        }

        writeSseJson(
          res,
          { type: "content_block_stop", index: 0 },
          "content_block_stop",
        );
        writeSseJson(
          res,
          {
            type: "message_delta",
            delta: { stop_reason: "end_turn", stop_sequence: null },
            usage: { output_tokens: 0 },
          },
          "message_delta",
        );
        writeSseJson(res, { type: "message_stop" }, "message_stop");
      } catch (err) {
        if (!aborted) {
          writeSseJson(
            res,
            {
              type: "error",
              error: { type: "server_error", message: getErrorMessage(err) },
            },
            "error",
          );
        }
      } finally {
        res.end();
      }
      return;
    }

    // Non-streaming
    try {
      let responseText: string;

      {
        if (!state.runtime) {
          json(
            res,
            {
              error: {
                type: "service_unavailable",
                message: "Agent is not running",
              },
            },
            503,
          );
          return;
        }
        const runtime = state.runtime;
        const agentName = runtime.character.name ?? "Milady";
        const { userId, roomId } = await ensureCompatChatConnection(
          runtime,
          agentName,
          "anthropic-compat",
          roomKey,
        );
        const message = createMessageMemory({
          id: crypto.randomUUID() as UUID,
          entityId: userId,
          roomId,
          content: {
            text: prompt,
            source: "compat_anthropic",
            channelType: ChannelType.API,
          },
        });
        const result = await generateChatResponse(
          runtime,
          message,
          state.agentName,
          {
            resolveNoResponseText: () =>
              resolveNoResponseFallback(state.logBuffer, runtime),
          },
        );
        responseText = result.text;
      }

      const resolvedText = normalizeChatResponseText(
        responseText,
        state.logBuffer,
        state.runtime,
      );
      json(res, {
        id,
        type: "message",
        role: "assistant",
        model,
        content: [{ type: "text", text: resolvedText }],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      });
    } catch (err) {
      json(
        res,
        { error: { type: "server_error", message: getErrorMessage(err) } },
        500,
      );
    }
    return;
  }

  // ── GET /api/conversations ──────────────────────────────────────────
  if (method === "GET" && pathname === "/api/conversations") {
    await waitForConversationRestore();
    const convos = Array.from(state.conversations.values())
      .filter((c) => !state.deletedConversationIds.has(c.id))
      .sort(
        (a, b) =>
          new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
      );
    json(res, { conversations: convos });
    return;
  }

  // ── POST /api/conversations ─────────────────────────────────────────
  if (method === "POST" && pathname === "/api/conversations") {
    const body = await readJsonBody<{
      title?: string;
      bootstrapGreeting?: boolean;
      lang?: string;
    }>(req, res);
    if (!body) return;
    await waitForConversationRestore();
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const roomId = stringToUuid(`web-conv-${id}`);
    const conv: ConversationMeta = {
      id,
      title: body.title?.trim() || "New Chat",
      roomId,
      createdAt: now,
      updatedAt: now,
    };
    state.conversations.set(id, conv);
    let greeting:
      | {
          text: string;
          agentName: string;
          generated: boolean;
          persisted: boolean;
        }
      | undefined;

    // Soft cap: evict the oldest conversation when the map exceeds 500
    evictOldestConversation(state.conversations, 500);

    if (state.runtime) {
      try {
        await ensureConversationRoom(conv);
        await syncConversationRoomTitle(conv);
        if (body.bootstrapGreeting === true) {
          const storedGreeting = await ensureConversationGreetingStored(
            conv,
            typeof body.lang === "string" ? body.lang : "en",
          );
          if (storedGreeting.text.trim()) {
            greeting = {
              text: storedGreeting.text,
              agentName: storedGreeting.agentName,
              generated: storedGreeting.generated,
              persisted: storedGreeting.persisted,
            };
          }
        }
      } catch (err) {
        error(
          res,
          `Failed to initialize conversation: ${getErrorMessage(err)}`,
          500,
        );
        return;
      }
    }
    json(res, { conversation: conv, ...(greeting ? { greeting } : {}) });
    return;
  }

  // ── GET /api/conversations/:id/messages ─────────────────────────────
  if (
    method === "GET" &&
    /^\/api\/conversations\/[^/]+\/messages$/.test(pathname)
  ) {
    const convId = decodeURIComponent(pathname.split("/")[3]);
    const conv = await getConversationWithRestore(convId);
    if (!conv) {
      error(res, "Conversation not found", 404);
      return;
    }
    if (!state.runtime) {
      json(res, { messages: [] });
      return;
    }
    const runtime = state.runtime;
    try {
      const memories = await runtime.getMemories({
        roomId: conv.roomId,
        tableName: "messages",
        count: 200,
      });
      // Sort by createdAt ascending
      memories.sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0));
      const agentId = runtime.agentId;
      const messages = memories.map((m) => {
        const contentSource = (m.content as Record<string, unknown>)?.source;
        const meta = m.metadata as Record<string, unknown> | undefined;
        const entityName = meta?.entityName;
        return {
          id: m.id ?? "",
          role: m.entityId === agentId ? "assistant" : "user",
          text: (m.content as { text?: string })?.text ?? "",
          timestamp: m.createdAt ?? 0,
          source:
            typeof contentSource === "string" && contentSource !== "client_chat"
              ? contentSource
              : undefined,
          from:
            typeof entityName === "string" && entityName.length > 0
              ? entityName
              : undefined,
        };
      });
      json(res, { messages });
    } catch (err) {
      logger.warn(
        `[conversations] Failed to fetch messages: ${err instanceof Error ? err.message : String(err)}`,
      );
      json(res, { messages: [], error: "Failed to fetch messages" }, 500);
    }
    return;
  }

  // ── POST /api/conversations/:id/messages/truncate ──────────────────
  if (
    method === "POST" &&
    /^\/api\/conversations\/[^/]+\/messages\/truncate$/.test(pathname)
  ) {
    const convId = decodeURIComponent(pathname.split("/")[3]);
    const conv = await getConversationWithRestore(convId);
    if (!conv) {
      error(res, "Conversation not found", 404);
      return;
    }

    const body = await readJsonBody<{
      messageId?: string;
      inclusive?: boolean;
    }>(req, res);
    if (!body) return;

    const messageId =
      typeof body.messageId === "string" ? body.messageId.trim() : "";
    if (!messageId) {
      error(res, "messageId is required", 400);
      return;
    }

    const runtime = state.runtime;
    if (!runtime) {
      error(res, "Agent is not running", 503);
      return;
    }

    try {
      const result = await truncateConversationMessages(
        runtime,
        conv,
        messageId,
        {
          inclusive: body.inclusive === true,
        },
      );
      conv.updatedAt = new Date().toISOString();
      state.broadcastWs?.({
        type: "conversation-updated",
        conversation: conv,
      });
      json(res, { ok: true, deletedCount: result.deletedCount });
    } catch (err) {
      const status =
        typeof (err as { status?: number }).status === "number"
          ? (err as { status: number }).status
          : 500;
      error(res, getErrorMessage(err), status);
    }
    return;
  }

  // ── POST /api/conversations/:id/messages/stream ─────────────────────
  if (
    method === "POST" &&
    /^\/api\/conversations\/[^/]+\/messages\/stream$/.test(pathname)
  ) {
    const convId = decodeURIComponent(pathname.split("/")[3]);
    const conv = await getConversationWithRestore(convId);
    if (!conv) {
      error(res, "Conversation not found", 404);
      return;
    }

    const chatPayload = await readChatRequestPayload(req, res, {
      readJsonBody,
      error,
    });
    if (!chatPayload) return;
    const { prompt, channelType, images, conversationMode } = chatPayload;

    const runtime = state.runtime;
    if (!runtime) {
      error(res, "Agent is not running", 503);
      return;
    }

    const userId = ensureAdminEntityId();
    const turnStartedAt = Date.now();

    try {
      await ensureConversationRoom(conv);
    } catch (err) {
      error(
        res,
        `Failed to initialize conversation room: ${getErrorMessage(err)}`,
        500,
      );
      return;
    }

    const { userMessage, messageToStore } = buildUserMessages({
      images,
      prompt,
      userId,
      agentId: runtime.agentId,
      roomId: conv.roomId,
      channelType,
      conversationMode,
    });

    try {
      await persistConversationMemory(runtime, messageToStore);
    } catch (err) {
      error(res, `Failed to store user message: ${getErrorMessage(err)}`, 500);
      return;
    }

    // ── Local runtime path (existing code below) ───────────────────────

    initSse(res);
    let aborted = false;
    req.on("close", () => {
      aborted = true;
    });

    // SSE heartbeat: keep data flowing during long generation (LLM + action
    // execution can take 30-60s).  Without this, idle connections can be
    // dropped by proxies, browsers, or load-balancers.  SSE comments (lines
    // starting with ':') are ignored by the client parser.
    const heartbeatInterval = setInterval(() => {
      if (!aborted && !res.writableEnded) {
        res.write(": heartbeat\n\n");
      }
    }, 5000);

    let streamedText = "";

    try {
      const result = await generateChatResponse(
        runtime,
        userMessage,
        state.agentName,
        {
          isAborted: () => aborted,
          onChunk: (chunk) => {
            if (!chunk) return;
            streamedText += chunk;
            writeChatTokenSse(res, chunk, streamedText);
          },
          onSnapshot: (text) => {
            if (!text) return;
            streamedText = text;
            writeChatTokenSse(res, text, streamedText);
          },
          resolveNoResponseText: () =>
            resolveNoResponseFallback(state.logBuffer, runtime),
        },
      );

      if (!aborted) {
        await persistAssistantConversationMemory(
          runtime,
          conv.roomId,
          result.text,
          channelType,
          turnStartedAt,
        );
        conv.updatedAt = new Date().toISOString();
        writeSseJson(res, {
          type: "done",
          fullText: result.text,
          agentName: result.agentName,
          ...(result.usage ? { estimatedUsage: result.usage } : {}),
        });

        // Background chat renaming
        if (conv.title === "New Chat") {
          // Fire and forget (don't await) to not block the response stream close
          generateConversationTitle(runtime, prompt, state.agentName).then(
            (newTitle) => {
              if (newTitle && state.broadcastWs) {
                conv.title = newTitle;
                // Broadcast full conversations list update for simplicity
                // (or ideally a specific event, but the frontend listens for reloads)
                state.broadcastWs({
                  type: "conversation-updated",
                  conversation: conv,
                });
              }
            },
          );
        }
      }
    } catch (err) {
      if (!aborted) {
        const creditReply = getInsufficientCreditsReplyFromError(err);
        if (creditReply) {
          try {
            await persistAssistantConversationMemory(
              runtime,
              conv.roomId,
              creditReply,
              channelType,
            );
            conv.updatedAt = new Date().toISOString();
            writeSse(res, {
              type: "done",
              fullText: creditReply,
              agentName: state.agentName,
            });
          } catch (persistErr) {
            writeSse(res, {
              type: "error",
              message: getErrorMessage(persistErr),
            });
          }
        } else {
          writeSse(res, {
            type: "error",
            message: getErrorMessage(err),
          });
        }
      }
    } finally {
      clearInterval(heartbeatInterval);
      res.end();
    }
    return;
  }

  // ── POST /api/conversations/:id/messages ────────────────────────────
  if (
    method === "POST" &&
    /^\/api\/conversations\/[^/]+\/messages$/.test(pathname)
  ) {
    const convId = decodeURIComponent(pathname.split("/")[3]);
    const conv = await getConversationWithRestore(convId);
    if (!conv) {
      error(res, "Conversation not found", 404);
      return;
    }
    const chatPayload = await readChatRequestPayload(req, res, {
      readJsonBody,
      error,
    });
    if (!chatPayload) return;
    const { prompt, channelType, images, conversationMode } = chatPayload;
    const runtime = state.runtime;
    if (!runtime) {
      error(res, "Agent is not running", 503);
      return;
    }
    const userId = ensureAdminEntityId();
    const turnStartedAt = Date.now();

    try {
      await ensureConversationRoom(conv);
    } catch (err) {
      error(
        res,
        `Failed to initialize conversation room: ${getErrorMessage(err)}`,
        500,
      );
      return;
    }

    const { userMessage, messageToStore } = buildUserMessages({
      images,
      prompt,
      userId,
      agentId: runtime.agentId,
      roomId: conv.roomId,
      channelType,
      conversationMode,
    });

    try {
      await persistConversationMemory(runtime, messageToStore);
    } catch (err) {
      error(res, `Failed to store user message: ${getErrorMessage(err)}`, 500);
      return;
    }

    try {
      const result = await generateChatResponse(
        runtime,
        userMessage,
        state.agentName,
        {
          resolveNoResponseText: () =>
            resolveNoResponseFallback(state.logBuffer, runtime),
        },
      );

      await persistAssistantConversationMemory(
        runtime,
        conv.roomId,
        result.text,
        channelType,
        turnStartedAt,
      );
      conv.updatedAt = new Date().toISOString();
      json(res, {
        text: result.text,
        agentName: result.agentName,
      });
    } catch (err) {
      logger.warn(
        `[conversations] POST /messages failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      const creditReply = getInsufficientCreditsReplyFromError(err);
      if (creditReply) {
        try {
          await persistAssistantConversationMemory(
            runtime,
            conv.roomId,
            creditReply,
            channelType,
          );
          conv.updatedAt = new Date().toISOString();
          json(res, {
            text: creditReply,
            agentName: state.agentName,
          });
        } catch (persistErr) {
          error(res, getErrorMessage(persistErr), 500);
        }
      } else {
        error(res, getErrorMessage(err), 500);
      }
    }
    return;
  }

  // ── POST /api/conversations/:id/greeting ───────────────────────────
  // Pick a random postExample from the character as the opening message.
  // No model call, no latency, no cost — already in the agent's voice.
  // Stored as an agent message so it persists on refresh.
  if (
    method === "POST" &&
    /^\/api\/conversations\/[^/]+\/greeting$/.test(pathname)
  ) {
    const convId = decodeURIComponent(pathname.split("/")[3]);
    const conv = await getConversationWithRestore(convId);
    if (!conv) {
      error(res, "Conversation not found", 404);
      return;
    }

    const runtime = state.runtime;
    if (!runtime) {
      error(res, "Agent is not running", 503);
      return;
    }
    const url = new URL(req.url ?? "", `http://${req.headers.host}`);
    const lang = url.searchParams.get("lang") ?? "en";

    try {
      await ensureConversationRoom(conv);
    } catch (err) {
      error(
        res,
        `Failed to initialize conversation room: ${getErrorMessage(err)}`,
        500,
      );
      return;
    }

    try {
      const greeting = await ensureConversationGreetingStored(conv, lang);
      json(res, {
        text: greeting.text,
        agentName: greeting.agentName,
        generated: greeting.generated,
        persisted: greeting.persisted,
      });
    } catch (err) {
      error(res, getErrorMessage(err), 500);
    }
    return;
  }

  // ── PATCH /api/conversations/:id ────────────────────────────────────
  if (
    method === "PATCH" &&
    /^\/api\/conversations\/[^/]+$/.test(pathname) &&
    !pathname.endsWith("/messages")
  ) {
    const convId = decodeURIComponent(pathname.split("/")[3]);
    const conv = await getConversationWithRestore(convId);
    if (!conv) {
      error(res, "Conversation not found", 404);
      return;
    }
    const body = await readJsonBody<{ title?: string }>(req, res);
    if (!body) return;
    if (body.title?.trim()) {
      conv.title = body.title.trim();
      conv.updatedAt = new Date().toISOString();
      await syncConversationRoomTitle(conv);
    }
    json(res, { conversation: conv });
    return;
  }

  // ── DELETE /api/conversations/:id ───────────────────────────────────
  if (
    method === "DELETE" &&
    /^\/api\/conversations\/[^/]+$/.test(pathname) &&
    !pathname.endsWith("/messages")
  ) {
    const convId = decodeURIComponent(pathname.split("/")[3]);
    const conv = await getConversationWithRestore(convId);
    if (conv?.roomId && state.runtime) {
      try {
        await deleteConversationRoomData(state.runtime, conv.roomId);
      } catch (err) {
        logger.debug(
          `[conversations] Failed to delete room data for ${convId}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    state.conversations.delete(convId);
    markConversationDeleted(convId);
    json(res, { ok: true });
    return;
  }

  // ── POST /api/chat/stream ────────────────────────────────────────────
  if (method === "POST" && pathname === "/api/chat/stream") {
    // Legacy cloud-proxy path — forwards messages to a remote sandbox and
    // does not process image attachments. Retain the standard 1 MB body limit.
    const chatPayload = await readChatRequestPayload(
      req,
      res,
      { readJsonBody, error },
      MAX_BODY_BYTES,
    );
    if (!chatPayload) return;
    const { prompt, channelType, conversationMode } = chatPayload;

    // Cloud proxy path

    if (!state.runtime) {
      error(res, "Agent is not running", 503);
      return;
    }

    initSse(res);
    let aborted = false;
    req.on("close", () => {
      aborted = true;
    });

    // Pause coordinator LLM decisions while processing user message
    const streamCoordinator = state.runtime.getService("SWARM_COORDINATOR") as
      | { pause?: () => void; resume?: () => void; isPaused?: boolean }
      | undefined;
    const streamDidPause = streamCoordinator && !streamCoordinator.isPaused;
    if (streamDidPause) {
      streamCoordinator.pause?.();
    }

    let streamedText = "";

    try {
      const runtime = state.runtime;
      const agentName = runtime.character.name ?? "Milady";
      await ensureLegacyChatConnection(runtime, agentName);
      const chatUserId = state.chatUserId;
      const chatRoomId = state.chatRoomId;
      if (!chatUserId || !chatRoomId) {
        throw new Error("Legacy chat connection was not initialized");
      }

      const message = createMessageMemory({
        id: crypto.randomUUID() as UUID,
        entityId: chatUserId,
        agentId: runtime.agentId,
        roomId: chatRoomId,
        content: {
          text: prompt,
          source: "client_chat",
          channelType,
          ...(conversationMode ? { conversationMode } : {}),
        },
      });

      const result = await generateChatResponse(
        runtime,
        message,
        state.agentName,
        {
          isAborted: () => aborted,
          onChunk: (chunk) => {
            if (!chunk) return;
            streamedText += chunk;
            writeChatTokenSse(res, chunk, streamedText);
          },
          onSnapshot: (text) => {
            if (!text) return;
            streamedText = text;
            writeChatTokenSse(res, text, streamedText);
          },
          resolveNoResponseText: () =>
            resolveNoResponseFallback(state.logBuffer, runtime),
        },
      );

      if (!aborted) {
        writeSseJson(res, {
          type: "done",
          fullText: result.text,
          agentName: result.agentName,
          ...(result.usage ? { estimatedUsage: result.usage } : {}),
        });
      }
    } catch (err) {
      if (!aborted) {
        const creditReply = getInsufficientCreditsReplyFromError(err);
        if (creditReply) {
          writeSse(res, {
            type: "done",
            fullText: creditReply,
            agentName: state.agentName,
          });
        } else {
          writeSse(res, {
            type: "error",
            message: getErrorMessage(err),
          });
        }
      }
    } finally {
      // Resume coordinator after user message processed
      if (streamDidPause) {
        streamCoordinator.resume?.();
      }
      res.end();
    }
    return;
  }

  // ── POST /api/chat (legacy — routes to default conversation) ───────
  // Routes messages through the full elizaOS message pipeline so the agent
  // has conversation memory, context, and always responds (DM + client_chat
  // bypass the shouldRespond LLM evaluation).
  //
  // Cloud mode: when a cloud proxy is active, messages are forwarded to the
  // remote sandbox instead of the local runtime.  Supports SSE streaming
  // when the client sends Accept: text/event-stream.
  if (method === "POST" && pathname === "/api/chat") {
    // Legacy cloud-proxy path — forwards messages to a remote sandbox and
    // does not process image attachments. Retain the standard 1 MB body limit.
    const chatPayload = await readChatRequestPayload(
      req,
      res,
      { readJsonBody, error },
      MAX_BODY_BYTES,
    );
    if (!chatPayload) return;
    const { prompt, channelType, conversationMode } = chatPayload;

    if (!state.runtime) {
      error(res, "Agent is not running", 503);
      return;
    }

    // Pause coordinator LLM decisions while processing user message
    const chatCoordinator = state.runtime.getService("SWARM_COORDINATOR") as
      | { pause?: () => void; resume?: () => void; isPaused?: boolean }
      | undefined;
    const chatDidPause = chatCoordinator && !chatCoordinator.isPaused;
    if (chatDidPause) {
      chatCoordinator.pause?.();
    }

    try {
      const runtime = state.runtime;
      const agentName = runtime.character.name ?? "Milady";
      await ensureLegacyChatConnection(runtime, agentName);
      const chatUserId = state.chatUserId;
      const chatRoomId = state.chatRoomId;
      if (!chatUserId || !chatRoomId) {
        throw new Error("Legacy chat connection was not initialized");
      }

      const message = createMessageMemory({
        id: crypto.randomUUID() as UUID,
        entityId: chatUserId,
        agentId: runtime.agentId,
        roomId: chatRoomId,
        content: {
          text: prompt,
          source: "client_chat",
          channelType,
          ...(conversationMode ? { conversationMode } : {}),
        },
      });

      const result = await generateChatResponse(
        runtime,
        message,
        state.agentName,
        {
          resolveNoResponseText: () =>
            resolveNoResponseFallback(state.logBuffer, runtime),
        },
      );

      json(res, {
        text: result.text,
        agentName: result.agentName,
      });
    } catch (err) {
      const creditReply = getInsufficientCreditsReplyFromError(err);
      if (creditReply) {
        json(res, {
          text: creditReply,
          agentName: state.agentName,
        });
      } else {
        error(res, getErrorMessage(err), 500);
      }
    } finally {
      // Resume coordinator after user message processed
      if (chatDidPause) {
        chatCoordinator.resume?.();
      }
    }
    return;
  }

  // ── Database management API ─────────────────────────────────────────────
  if (pathname.startsWith("/api/database/")) {
    const handled = await handleDatabaseRoute(
      req,
      res,
      state.runtime,
      pathname,
    );
    if (handled) return;
  }

  // ── Trajectory management API ──────────────────────────────────────────
  if (pathname.startsWith("/api/trajectories")) {
    if (!state.runtime) {
      sendJsonError(res, "Agent runtime not started yet", 503);
      return;
    }
    const handled = await handleTrajectoryRoute(
      req,
      res,
      state.runtime,
      pathname,
      method,
    );
    if (handled) return;
  }

  // ── Coding Agent API (/api/coding-agents/*, /api/workspace/*, /api/issues/*) ──
  // Return graceful empty responses for read-only polling endpoints even
  // before the runtime is available — the frontend polls these on startup
  // and a 404/503 logs noisy console errors.
  if (
    !state.runtime &&
    method === "GET" &&
    pathname === "/api/coding-agents/coordinator/status"
  ) {
    json(res, {
      supervisionLevel: "autonomous",
      taskCount: 0,
      tasks: [],
      pendingConfirmations: 0,
    });
    return;
  }
  if (
    state.runtime &&
    (pathname.startsWith("/api/coding-agents") ||
      pathname.startsWith("/api/workspace") ||
      pathname.startsWith("/api/issues"))
  ) {
    // Try to dynamically load the route handler from the local plugin first
    let handled = false;

    // Try @elizaos/plugin-coding-agent first (local workspace plugin)
    try {
      const codingAgentPlugin = await import("@elizaos/plugin-coding-agent");
      if (codingAgentPlugin.createCodingAgentRouteHandler) {
        const coordinator = codingAgentPlugin.getCoordinator?.(state.runtime);
        const handler = codingAgentPlugin.createCodingAgentRouteHandler(
          state.runtime,
          coordinator,
        );
        handled = await handler(req, res, pathname);
      }
    } catch {
      // Local plugin not available, try npm plugin
    }

    // Fallback to @elizaos/plugin-agent-orchestrator (npm)
    if (!handled) {
      try {
        // biome-ignore lint/suspicious/noExplicitAny: legacy route handler may not exist in 2.x
        const orchestratorPlugin: any = await import(
          "@elizaos/plugin-agent-orchestrator"
        );
        if (orchestratorPlugin.createCodingAgentRouteHandler) {
          const coordinator = orchestratorPlugin.getCoordinator?.(
            state.runtime,
          );
          const handler = orchestratorPlugin.createCodingAgentRouteHandler(
            state.runtime,
            coordinator,
          );
          handled = await handler(req, res, pathname);
        }
      } catch {
        // Plugin doesn't export these functions - skip routing
      }
    }

    // Final fallback: Handle coding-agents routes using AgentOrchestratorService
    if (!handled && pathname.startsWith("/api/coding-agents")) {
      handled = await handleCodingAgentsFallback(
        state.runtime,
        pathname,
        method,
        req,
        res,
      );
    }

    if (handled) return;
  }

  if (
    await handleCloudStatusRoutes({
      req,
      res,
      method,
      pathname,
      config: state.config,
      runtime: state.runtime,
      json,
    })
  ) {
    return;
  }

  // ── App routes (/api/apps/*) ──────────────────────────────────────────
  if (
    await handleAppsRoutes({
      req,
      res,
      method,
      pathname,
      url,
      appManager: state.appManager as never,
      getPluginManager: () => requirePluginManager(state.runtime) as never,
      parseBoundedLimit,
      readJsonBody,
      json,
      error,
      runtime: state.runtime,
    })
  ) {
    return;
  }

  // ── Hyperscape control proxy routes (optional — package may not be installed) ──
  try {
    // @ts-ignore: Optional package may not be installed
    const { handleAppsHyperscapeRoutes } = await import("@elizaos/app-hyperscape/routes");
    if (
      await handleAppsHyperscapeRoutes({
        req,
        res,
        method,
        pathname,
        relayHyperscapeApi,
        readJsonBody,
        error,
      })
    ) {
      return;
    }
  } catch {
    // @elizaos/app-hyperscape not available — skip hyperscape routes
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Workbench routes
  // ═══════════════════════════════════════════════════════════════════════

  // ── GET /api/workbench/overview ──────────────────────────────────────
  if (method === "GET" && pathname === "/api/workbench/overview") {
    const tasks: WorkbenchTaskView[] = [];
    const triggers: Array<
      NonNullable<ReturnType<typeof taskToTriggerSummary>>
    > = [];
    const todos: WorkbenchTodoView[] = [];
    const summary = {
      totalTasks: 0,
      completedTasks: 0,
      totalTriggers: 0,
      activeTriggers: 0,
      totalTodos: 0,
      completedTodos: 0,
    };

    let tasksAvailable = false;
    let triggersAvailable = false;
    let todosAvailable = false;
    let runtimeTasks: Task[] = [];
    let todoData: TodoDataServiceLike | null = null;

    if (state.runtime) {
      try {
        runtimeTasks = await state.runtime.getTasks({});
        tasksAvailable = true;
        todosAvailable = true;

        for (const task of runtimeTasks) {
          const todo = toWorkbenchTodo(task);
          if (todo) {
            todos.push(todo);
            continue;
          }
          const mappedTask = toWorkbenchTask(task);
          if (mappedTask) {
            tasks.push(mappedTask);
          }
        }
      } catch {
        tasksAvailable = false;
        todosAvailable = false;
      }

      try {
        todoData = await getTodoDataService(state.runtime);
        if (todoData) {
          const dbTodos = await todoData.getTodos({
            agentId: state.runtime.agentId,
          });
          todosAvailable = true;
          for (const rawTodo of dbTodos) {
            const mapped = toWorkbenchTodoFromRecord(rawTodo);
            if (mapped) {
              todos.push(mapped);
            }
          }
        }
      } catch {
        // plugin todo unavailable or errored; keep fallback todos
      }

      try {
        const triggerTasks = await listTriggerTasks(state.runtime);
        triggersAvailable = true;
        for (const task of triggerTasks) {
          const summaryItem = taskToTriggerSummary(task);
          if (summaryItem) {
            triggers.push(summaryItem);
          }
        }
      } catch {
        if (tasksAvailable) {
          triggersAvailable = true;
          for (const task of runtimeTasks) {
            const summaryItem = taskToTriggerSummary(task);
            if (summaryItem) {
              triggers.push(summaryItem);
            }
          }
        }
      }
    }

    if (todos.length > 1) {
      const dedupedTodos = new Map<string, WorkbenchTodoView>();
      for (const todo of todos) {
        dedupedTodos.set(todo.id, todo);
      }
      todos.length = 0;
      todos.push(...dedupedTodos.values());
    }

    tasks.sort((a, b) => a.name.localeCompare(b.name));
    todos.sort((a, b) => a.name.localeCompare(b.name));
    triggers.sort((a, b) => a.displayName.localeCompare(b.displayName));
    summary.totalTasks = tasks.length;
    summary.completedTasks = tasks.filter((task) => task.isCompleted).length;
    summary.totalTriggers = triggers.length;
    summary.activeTriggers = triggers.filter(
      (trigger) => trigger.enabled,
    ).length;
    summary.totalTodos = todos.length;
    summary.completedTodos = todos.filter((todo) => todo.isCompleted).length;

    json(res, {
      tasks,
      triggers,
      todos,
      summary,
      tasksAvailable,
      triggersAvailable,
      todosAvailable,
    });
    return;
  }

  // ── GET /api/workbench/tasks ─────────────────────────────────────────
  if (method === "GET" && pathname === "/api/workbench/tasks") {
    if (!state.runtime) {
      error(res, "Agent runtime is not available", 503);
      return;
    }
    const runtimeTasks = await state.runtime.getTasks({});
    const tasks = runtimeTasks
      .map((task) => toWorkbenchTask(task))
      .filter((task): task is WorkbenchTaskView => task !== null)
      .sort((a, b) => a.name.localeCompare(b.name));
    json(res, { tasks });
    return;
  }

  // ── POST /api/workbench/tasks ────────────────────────────────────────
  if (method === "POST" && pathname === "/api/workbench/tasks") {
    if (!state.runtime) {
      error(res, "Agent runtime is not available", 503);
      return;
    }
    const body = await readJsonBody<{
      name?: string;
      description?: string;
      tags?: string[];
      isCompleted?: boolean;
    }>(req, res);
    if (!body) return;
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!name) {
      error(res, "name is required", 400);
      return;
    }
    const description =
      typeof body.description === "string" ? body.description : "";
    const isCompleted = body.isCompleted === true;
    const metadata = {
      isCompleted,
      workbench: { kind: "task" },
    };
    const taskId = await state.runtime.createTask({
      name,
      description,
      tags: normalizeTags(body.tags, [WORKBENCH_TASK_TAG]),
      metadata,
    });
    const created = await state.runtime.getTask(taskId);
    const task = created ? toWorkbenchTask(created) : null;
    if (!task) {
      error(res, "Task created but unavailable", 500);
      return;
    }
    json(res, { task }, 201);
    return;
  }

  const taskItemMatch = /^\/api\/workbench\/tasks\/([^/]+)$/.exec(pathname);
  if (taskItemMatch && ["GET", "PUT", "DELETE"].includes(method)) {
    if (!state.runtime) {
      error(res, "Agent runtime is not available", 503);
      return;
    }
    const decodedTaskId = decodePathComponent(taskItemMatch[1], res, "task id");
    if (!decodedTaskId) return;
    const task = await state.runtime.getTask(decodedTaskId as UUID);
    const taskView = task ? toWorkbenchTask(task) : null;
    if (!task || !taskView || !task.id) {
      error(res, "Task not found", 404);
      return;
    }

    if (method === "GET") {
      json(res, { task: taskView });
      return;
    }

    if (method === "DELETE") {
      await state.runtime.deleteTask(task.id);
      json(res, { ok: true });
      return;
    }

    const body = await readJsonBody<{
      name?: string;
      description?: string;
      tags?: string[];
      isCompleted?: boolean;
    }>(req, res);
    if (!body) return;

    const update: Partial<Task> = {};
    if (typeof body.name === "string") {
      const name = body.name.trim();
      if (!name) {
        error(res, "name cannot be empty", 400);
        return;
      }
      update.name = name;
    }
    if (typeof body.description === "string") {
      update.description = body.description;
    }
    if (body.tags !== undefined) {
      update.tags = normalizeTags(body.tags, [WORKBENCH_TASK_TAG]);
    }
    if (typeof body.isCompleted === "boolean") {
      update.metadata = {
        ...readTaskMetadata(task),
        isCompleted: body.isCompleted,
      };
    }
    await state.runtime.updateTask(task.id, update);
    const refreshed = await state.runtime.getTask(task.id);
    const refreshedView = refreshed ? toWorkbenchTask(refreshed) : null;
    if (!refreshedView) {
      error(res, "Task updated but unavailable", 500);
      return;
    }
    json(res, { task: refreshedView });
    return;
  }

  // ── GET /api/workbench/todos ─────────────────────────────────────────
  if (method === "GET" && pathname === "/api/workbench/todos") {
    if (!state.runtime) {
      error(res, "Agent runtime is not available", 503);
      return;
    }
    const runtimeTasks = await state.runtime.getTasks({});
    const todos = runtimeTasks
      .map((task) => toWorkbenchTodo(task))
      .filter((todo): todo is WorkbenchTodoView => todo !== null)
      .sort((a, b) => a.name.localeCompare(b.name));
    const todoData = await getTodoDataService(state.runtime);
    if (todoData) {
      try {
        const dbTodos = await todoData.getTodos({
          agentId: state.runtime.agentId,
        });
        for (const rawTodo of dbTodos) {
          const mapped = toWorkbenchTodoFromRecord(rawTodo);
          if (mapped) {
            const existingIndex = todos.findIndex(
              (todo) => todo.id === mapped.id,
            );
            if (existingIndex >= 0) {
              todos[existingIndex] = mapped;
            } else {
              todos.push(mapped);
            }
          }
        }
        todos.sort((a, b) => a.name.localeCompare(b.name));
      } catch {
        // fallback to task-backed todos only
      }
    }
    json(res, { todos });
    return;
  }

  // ── POST /api/workbench/todos ────────────────────────────────────────
  if (method === "POST" && pathname === "/api/workbench/todos") {
    if (!state.runtime) {
      error(res, "Agent runtime is not available", 503);
      return;
    }
    const body = await readJsonBody<{
      name?: string;
      description?: string;
      priority?: number | string | null;
      isUrgent?: boolean;
      type?: string;
      isCompleted?: boolean;
      tags?: string[];
    }>(req, res);
    if (!body) return;
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!name) {
      error(res, "name is required", 400);
      return;
    }
    const description =
      typeof body.description === "string" ? body.description : "";
    const isCompleted = body.isCompleted === true;
    const priority = parseNullableNumber(body.priority);
    const isUrgent = body.isUrgent === true;
    const type =
      typeof body.type === "string" && body.type.trim().length > 0
        ? body.type.trim()
        : "task";

    const todoData = await getTodoDataService(state.runtime);
    if (todoData) {
      try {
        const now = Date.now();
        const roomId =
          (
            state.runtime.getService("AUTONOMY") as {
              getAutonomousRoomId?: () => UUID;
            } | null
          )?.getAutonomousRoomId?.() ??
          stringToUuid(`workbench-todo-room-${state.runtime.agentId}`);
        const worldId = stringToUuid(
          `workbench-todo-world-${state.runtime.agentId}`,
        );
        const entityId =
          state.adminEntityId ?? stringToUuid(`workbench-todo-entity-${now}`);
        const createdTodoId = await todoData.createTodo({
          agentId: state.runtime.agentId,
          worldId,
          roomId,
          entityId,
          name,
          description: description || name,
          type,
          priority: priority ?? undefined,
          isUrgent,
          metadata: {
            createdAt: new Date(now).toISOString(),
            source: "workbench-api",
          },
          tags: normalizeTags(body.tags, ["TODO"]),
        });
        const createdDbTodo = await todoData.getTodo(createdTodoId);
        const mappedDbTodo = createdDbTodo
          ? toWorkbenchTodoFromRecord(createdDbTodo)
          : null;
        if (mappedDbTodo) {
          json(res, { todo: mappedDbTodo }, 201);
          return;
        }
      } catch {
        // fallback to task-backed todo creation
      }
    }

    const metadata = {
      isCompleted,
      workbenchTodo: {
        description,
        priority,
        isUrgent,
        isCompleted,
        type,
      },
    };
    const taskId = await state.runtime.createTask({
      name,
      description,
      tags: normalizeTags(body.tags, [WORKBENCH_TODO_TAG, "todo"]),
      metadata,
    });
    const created = await state.runtime.getTask(taskId);
    const todo = created ? toWorkbenchTodo(created) : null;
    if (!todo) {
      error(res, "Todo created but unavailable", 500);
      return;
    }
    json(res, { todo }, 201);
    return;
  }

  const todoCompleteMatch = /^\/api\/workbench\/todos\/([^/]+)\/complete$/.exec(
    pathname,
  );
  if (method === "POST" && todoCompleteMatch) {
    if (!state.runtime) {
      error(res, "Agent runtime is not available", 503);
      return;
    }
    const decodedTodoId = decodePathComponent(
      todoCompleteMatch[1],
      res,
      "todo id",
    );
    if (!decodedTodoId) return;
    const body = await readJsonBody<{ isCompleted?: boolean }>(req, res);
    if (!body) return;
    const isCompleted = body.isCompleted === true;
    const todoData = await getTodoDataService(state.runtime);
    if (todoData) {
      try {
        const updated = await todoData.updateTodo(decodedTodoId, {
          isCompleted,
          completedAt: isCompleted ? new Date() : null,
        });
        if (updated !== false) {
          json(res, { ok: true });
          return;
        }
        // updateTodo returned false — fall through to task-backed path
      } catch {
        // fallback to task-backed path
      }
    }
    const todoTask = await state.runtime.getTask(decodedTodoId as UUID);
    if (!todoTask || !todoTask.id || !toWorkbenchTodo(todoTask)) {
      error(res, "Todo not found", 404);
      return;
    }
    const metadata = readTaskMetadata(todoTask);
    const todoMeta =
      asObject(metadata.workbenchTodo) ?? asObject(metadata.todo) ?? {};
    await state.runtime.updateTask(todoTask.id, {
      metadata: {
        ...metadata,
        isCompleted,
        workbenchTodo: {
          ...todoMeta,
          isCompleted,
        },
      },
    });
    json(res, { ok: true });
    return;
  }

  const todoItemMatch = /^\/api\/workbench\/todos\/([^/]+)$/.exec(pathname);
  if (todoItemMatch && ["GET", "PUT", "DELETE"].includes(method)) {
    if (!state.runtime) {
      error(res, "Agent runtime is not available", 503);
      return;
    }
    const decodedTodoId = decodePathComponent(todoItemMatch[1], res, "todo id");
    if (!decodedTodoId) return;
    const todoData = await getTodoDataService(state.runtime);

    if (method === "GET" && todoData) {
      try {
        const dbTodo = await todoData.getTodo(decodedTodoId);
        const mapped = dbTodo ? toWorkbenchTodoFromRecord(dbTodo) : null;
        if (mapped) {
          json(res, { todo: mapped });
          return;
        }
      } catch {
        // fallback to task-backed path
      }
    }

    if (method === "GET") {
      const todoTask = await state.runtime.getTask(decodedTodoId as UUID);
      const todoView = todoTask ? toWorkbenchTodo(todoTask) : null;
      if (!todoTask || !todoTask.id || !todoView) {
        error(res, "Todo not found", 404);
        return;
      }
      json(res, { todo: todoView });
      return;
    }

    if (method === "DELETE" && todoData) {
      try {
        const deleted = await todoData.deleteTodo(decodedTodoId);
        if (deleted !== false) {
          json(res, { ok: true });
          return;
        }
      } catch {
        // fallback to task-backed path
      }
    }

    if (method === "DELETE") {
      const todoTask = await state.runtime.getTask(decodedTodoId as UUID);
      if (!todoTask?.id || !toWorkbenchTodo(todoTask)) {
        error(res, "Todo not found", 404);
        return;
      }
      await state.runtime.deleteTask(todoTask.id);
      json(res, { ok: true });
      return;
    }

    const body = await readJsonBody<{
      name?: string;
      description?: string;
      priority?: number | string | null;
      isUrgent?: boolean;
      type?: string;
      isCompleted?: boolean;
      tags?: string[];
    }>(req, res);
    if (!body) return;

    if (todoData) {
      try {
        const updates: Record<string, unknown> = {};
        if (typeof body.name === "string") {
          const name = body.name.trim();
          if (!name) {
            error(res, "name cannot be empty", 400);
            return;
          }
          updates.name = name;
        }
        if (typeof body.description === "string") {
          updates.description = body.description;
        }
        if (body.priority !== undefined) {
          updates.priority = parseNullableNumber(body.priority);
        }
        if (typeof body.isUrgent === "boolean") {
          updates.isUrgent = body.isUrgent;
        }
        if (typeof body.type === "string" && body.type.trim().length > 0) {
          updates.type = body.type.trim();
        }
        if (typeof body.isCompleted === "boolean") {
          updates.isCompleted = body.isCompleted;
          updates.completedAt = body.isCompleted ? new Date() : null;
        }
        const updated = await todoData.updateTodo(decodedTodoId, updates);
        if (updated === false) throw new Error("updateTodo returned false");
        const refreshedDbTodo = await todoData.getTodo(decodedTodoId);
        const refreshedMapped = refreshedDbTodo
          ? toWorkbenchTodoFromRecord(refreshedDbTodo)
          : null;
        if (refreshedMapped) {
          json(res, { todo: refreshedMapped });
          return;
        }
      } catch {
        // fallback to task-backed path
      }
    }

    const todoTask = await state.runtime.getTask(decodedTodoId as UUID);
    const todoView = todoTask ? toWorkbenchTodo(todoTask) : null;
    if (!todoTask || !todoTask.id || !todoView) {
      error(res, "Todo not found", 404);
      return;
    }

    const update: Partial<Task> = {};
    if (typeof body.name === "string") {
      const name = body.name.trim();
      if (!name) {
        error(res, "name cannot be empty", 400);
        return;
      }
      update.name = name;
    }
    if (typeof body.description === "string") {
      update.description = body.description;
    }
    if (body.tags !== undefined) {
      update.tags = normalizeTags(body.tags, [WORKBENCH_TODO_TAG, "todo"]);
    }

    const metadata = readTaskMetadata(todoTask);
    const existingTodoMeta =
      asObject(metadata.workbenchTodo) ?? asObject(metadata.todo) ?? {};
    const nextTodoMeta: Record<string, unknown> = {
      ...existingTodoMeta,
    };
    if (typeof body.description === "string") {
      nextTodoMeta.description = body.description;
    }
    if (body.priority !== undefined) {
      nextTodoMeta.priority = parseNullableNumber(body.priority);
    }
    if (typeof body.isUrgent === "boolean") {
      nextTodoMeta.isUrgent = body.isUrgent;
    }
    if (typeof body.type === "string" && body.type.trim().length > 0) {
      nextTodoMeta.type = body.type.trim();
    }

    let isCompleted = readTaskCompleted(todoTask);
    if (typeof body.isCompleted === "boolean") {
      isCompleted = body.isCompleted;
    }
    nextTodoMeta.isCompleted = isCompleted;
    update.metadata = {
      ...metadata,
      isCompleted,
      workbenchTodo: nextTodoMeta,
    };

    await state.runtime.updateTask(todoTask.id, update);
    const refreshed = await state.runtime.getTask(todoTask.id);
    const refreshedTodo = refreshed ? toWorkbenchTodo(refreshed) : null;
    if (!refreshedTodo) {
      error(res, "Todo updated but unavailable", 500);
      return;
    }
    json(res, { todo: refreshedTodo });
    return;
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Share ingest routes
  // ═══════════════════════════════════════════════════════════════════════

  // ── POST /api/ingest/share ───────────────────────────────────────────
  if (method === "POST" && pathname === "/api/ingest/share") {
    const body = await readJsonBody<{
      source?: string;
      title?: string;
      url?: string;
      text?: string;
    }>(req, res);
    if (!body) return;

    const item: ShareIngestItem = {
      id: crypto.randomUUID(),
      source: (body.source as string) ?? "unknown",
      title: body.title as string | undefined,
      url: body.url as string | undefined,
      text: body.text as string | undefined,
      suggestedPrompt: body.title
        ? `What do you think about "${body.title}"?`
        : body.url
          ? `Can you analyze this: ${body.url}`
          : body.text
            ? `What are your thoughts on: ${(body.text as string).slice(0, 100)}`
            : "What do you think about this shared content?",
      receivedAt: Date.now(),
    };
    state.shareIngestQueue.push(item);
    json(res, { ok: true, item });
    return;
  }

  // ── GET /api/ingest/share ────────────────────────────────────────────
  if (method === "GET" && pathname === "/api/ingest/share") {
    const consume = url.searchParams.get("consume") === "1";
    if (consume) {
      const items = [...state.shareIngestQueue];
      state.shareIngestQueue.length = 0;
      json(res, { items });
    } else {
      json(res, { items: state.shareIngestQueue });
    }
    return;
  }

  // ═══════════════════════════════════════════════════════════════════════
  // MCP marketplace routes
  // ═══════════════════════════════════════════════════════════════════════

  // ── GET /api/mcp/marketplace/search ──────────────────────────────────
  if (method === "GET" && pathname === "/api/mcp/marketplace/search") {
    const query = url.searchParams.get("q") ?? "";
    const limitStr = url.searchParams.get("limit");
    const limit = limitStr
      ? parseClampedInteger(limitStr, { min: 1, max: 50, fallback: 30 })
      : 30;
    try {
      const result = await searchMcpMarketplace(query || undefined, limit);
      json(res, { ok: true, results: result.results });
    } catch (err) {
      error(
        res,
        `MCP marketplace search failed: ${err instanceof Error ? err.message : err}`,
        502,
      );
    }
    return;
  }

  // ── GET /api/mcp/marketplace/details/:name ───────────────────────────
  if (
    method === "GET" &&
    pathname.startsWith("/api/mcp/marketplace/details/")
  ) {
    const serverName = decodePathComponent(
      pathname.slice("/api/mcp/marketplace/details/".length),
      res,
      "server name",
    );
    if (serverName === null) return;
    if (!serverName.trim()) {
      error(res, "Server name is required", 400);
      return;
    }
    try {
      const details = await getMcpServerDetails(serverName);
      if (!details) {
        error(res, `MCP server "${serverName}" not found`, 404);
        return;
      }
      json(res, { ok: true, server: details });
    } catch (err) {
      error(
        res,
        `Failed to fetch server details: ${err instanceof Error ? err.message : err}`,
        502,
      );
    }
    return;
  }

  // ═══════════════════════════════════════════════════════════════════════
  // MCP config routes
  // ═══════════════════════════════════════════════════════════════════════

  // ── GET /api/mcp/config ──────────────────────────────────────────────
  if (method === "GET" && pathname === "/api/mcp/config") {
    const servers = state.config.mcp?.servers ?? {};
    json(res, { ok: true, servers: redactDeep(servers) });
    return;
  }

  // ── POST /api/mcp/config/server ──────────────────────────────────────
  if (method === "POST" && pathname === "/api/mcp/config/server") {
    const body = await readJsonBody<{
      name?: string;
      config?: Record<string, unknown>;
      terminalToken?: string;
    }>(req, res);
    if (!body) return;

    const serverName = (body.name as string | undefined)?.trim();
    if (!serverName) {
      error(res, "Server name is required", 400);
      return;
    }
    if (isBlockedObjectKey(serverName)) {
      error(
        res,
        'Invalid server name: "__proto__", "constructor", and "prototype" are reserved',
        400,
      );
      return;
    }

    const config = body.config as Record<string, unknown> | undefined;
    if (!config || typeof config !== "object" || Array.isArray(config)) {
      error(res, "Server config object is required", 400);
      return;
    }

    const mcpRejection = await resolveMcpServersRejection({
      [serverName]: config,
    });
    if (mcpRejection) {
      error(res, mcpRejection, 400);
      return;
    }

    const mcpTerminalRejection = resolveMcpTerminalAuthorizationRejection(
      req,
      { [serverName]: config },
      body,
    );
    if (mcpTerminalRejection) {
      error(
        res,
        `Configuring stdio MCP servers requires terminal authorization. ${mcpTerminalRejection.reason}`,
        mcpTerminalRejection.status,
      );
      return;
    }

    if (!state.config.mcp) state.config.mcp = {};
    if (!state.config.mcp.servers) state.config.mcp.servers = {};
    const sanitized = cloneWithoutBlockedObjectKeys(config);
    state.config.mcp.servers[serverName] = sanitized as NonNullable<
      NonNullable<typeof state.config.mcp>["servers"]
    >[string];

    try {
      saveElizaConfig(state.config);
    } catch (err) {
      logger.warn(
        `[api] Config save failed: ${err instanceof Error ? err.message : err}`,
      );
    }

    json(res, { ok: true, name: serverName, requiresRestart: true });
    return;
  }

  // ── DELETE /api/mcp/config/server/:name ──────────────────────────────
  if (method === "DELETE" && pathname.startsWith("/api/mcp/config/server/")) {
    const serverName = decodePathComponent(
      pathname.slice("/api/mcp/config/server/".length),
      res,
      "server name",
    );
    if (serverName === null) return;
    if (isBlockedObjectKey(serverName)) {
      error(
        res,
        'Invalid server name: "__proto__", "constructor", and "prototype" are reserved',
        400,
      );
      return;
    }

    if (state.config.mcp?.servers?.[serverName]) {
      delete state.config.mcp.servers[serverName];
      try {
        saveElizaConfig(state.config);
      } catch (err) {
        logger.warn(
          `[api] Config save failed: ${err instanceof Error ? err.message : err}`,
        );
      }
    }

    json(res, { ok: true, requiresRestart: true });
    return;
  }

  // ── PUT /api/mcp/config ──────────────────────────────────────────────
  if (method === "PUT" && pathname === "/api/mcp/config") {
    const body = await readJsonBody<{
      servers?: Record<string, unknown>;
      terminalToken?: string;
    }>(req, res);
    if (!body) return;

    if (!state.config.mcp) state.config.mcp = {};
    if (body.servers !== undefined) {
      if (
        !body.servers ||
        typeof body.servers !== "object" ||
        Array.isArray(body.servers)
      ) {
        error(res, "servers must be a JSON object", 400);
        return;
      }
      const mcpRejection = await resolveMcpServersRejection(
        body.servers as Record<string, unknown>,
      );
      if (mcpRejection) {
        error(res, mcpRejection, 400);
        return;
      }
      const mcpTerminalRejection = resolveMcpTerminalAuthorizationRejection(
        req,
        body.servers as Record<string, unknown>,
        body,
      );
      if (mcpTerminalRejection) {
        error(
          res,
          `Configuring stdio MCP servers requires terminal authorization. ${mcpTerminalRejection.reason}`,
          mcpTerminalRejection.status,
        );
        return;
      }
      const sanitized = cloneWithoutBlockedObjectKeys(body.servers);
      state.config.mcp.servers = sanitized as NonNullable<
        NonNullable<typeof state.config.mcp>["servers"]
      >;
    }

    try {
      saveElizaConfig(state.config);
    } catch (err) {
      logger.warn(
        `[api] Config save failed: ${err instanceof Error ? err.message : err}`,
      );
    }

    json(res, { ok: true });
    return;
  }

  // ═══════════════════════════════════════════════════════════════════════
  // MCP status route
  // ═══════════════════════════════════════════════════════════════════════

  // ── GET /api/mcp/status ──────────────────────────────────────────────
  if (method === "GET" && pathname === "/api/mcp/status") {
    const servers: Array<{
      name: string;
      status: string;
      toolCount: number;
      resourceCount: number;
    }> = [];

    // If runtime has an MCP service, enumerate active servers
    if (state.runtime) {
      try {
        const mcpService = state.runtime.getService("MCP") as {
          getServers?: () => Array<{
            name: string;
            status: string;
            tools?: unknown[];
            resources?: unknown[];
          }>;
        } | null;
        if (mcpService && typeof mcpService.getServers === "function") {
          for (const s of mcpService.getServers()) {
            servers.push({
              name: s.name,
              status: s.status,
              toolCount: Array.isArray(s.tools) ? s.tools.length : 0,
              resourceCount: Array.isArray(s.resources)
                ? s.resources.length
                : 0,
            });
          }
        }
      } catch (err) {
        logger.debug(
          `[api] Service not available: ${err instanceof Error ? err.message : err}`,
        );
      }
    }

    json(res, { ok: true, servers });
    return;
  }

  // ── GET /api/emotes ──────────────────────────────────────────────────────
  if (method === "GET" && pathname === "/api/emotes") {
    json(res, { emotes: EMOTE_CATALOG });
    return;
  }

  // ── POST /api/emote ─────────────────────────────────────────────────────
  if (method === "POST" && pathname === "/api/emote") {
    const body = await readJsonBody<{ emoteId?: string }>(req, res);
    if (!body) return;
    const emote = body.emoteId ? EMOTE_BY_ID.get(body.emoteId) : undefined;
    if (!emote) {
      error(res, `Unknown emote: ${body.emoteId ?? "(none)"}`);
      return;
    }
    state.broadcastWs?.({
      type: "emote",
      emoteId: emote.id,
      path: emote.path,
      duration: emote.duration,
      // Emotes are always treated as one-shot performances in the app and
      // blend back to idle automatically after their catalog duration.
      loop: false,
    });
    json(res, { ok: true });
    return;
  }

  // ── POST /api/agent/event ──────────────────────────────────────────────
  // Push an event into the agent event stream (WebSocket + buffer).
  // Used by plugins (e.g. retake) to surface activity in the StreamView.
  // Auth: protected by the isAuthorized(req) gate at L5631.
  if (method === "POST" && pathname === "/api/agent/event") {
    const body = await readJsonBody<{
      stream?: string;
      data?: Record<string, unknown>;
      roomId?: string;
    }>(req, res);
    if (!body || !body.stream) {
      error(res, "Missing 'stream' field");
      return;
    }
    if (!AGENT_EVENT_ALLOWED_STREAMS.has(body.stream)) {
      error(
        res,
        `Invalid stream: ${body.stream}. Allowed: ${[...AGENT_EVENT_ALLOWED_STREAMS].join(", ")}`,
        400,
      );
      return;
    }
    const envelope: StreamEventEnvelope = {
      type: "agent_event",
      version: 1,
      eventId: `evt-${state.nextEventId}`,
      ts: Date.now(),
      stream: body.stream,
      agentId: state.runtime?.agentId
        ? String(state.runtime.agentId)
        : undefined,
      roomId: body.roomId,
      payload: body.data ?? {},
    };
    state.nextEventId += 1;
    state.eventBuffer.push(envelope);
    if (state.eventBuffer.length > 1500) {
      state.eventBuffer.splice(0, state.eventBuffer.length - 1500);
    }
    state.broadcastWs?.(envelope as unknown as Record<string, unknown>);
    json(res, { ok: true });
    return;
  }

  // ── POST /api/terminal/run ──────────────────────────────────────────────
  // Execute a shell command server-side and stream output via WebSocket.
  if (method === "POST" && pathname === "/api/terminal/run") {
    if (state.shellEnabled === false) {
      error(res, "Shell access is disabled", 403);
      return;
    }

    const body = await readJsonBody<{
      command?: string;
      clientId?: unknown;
      terminalToken?: string;
    }>(req, res);
    if (!body) return;

    const terminalRejection = resolveTerminalRunRejection(req, body);
    if (terminalRejection) {
      error(res, terminalRejection.reason, terminalRejection.status);
      return;
    }

    const command = typeof body.command === "string" ? body.command.trim() : "";
    if (!command) {
      error(res, "Missing or empty command");
      return;
    }

    // Guard against excessively long commands (likely injection or abuse)
    if (command.length > 4096) {
      error(res, "Command exceeds maximum length (4096 chars)", 400);
      return;
    }

    // Prevent multiline/control-character payloads that can smuggle
    // unintended command chains through a single request.
    if (
      command.includes("\n") ||
      command.includes("\r") ||
      command.includes("\0")
    ) {
      error(
        res,
        "Command must be a single line without control characters",
        400,
      );
      return;
    }

    const targetClientId = resolveTerminalRunClientId(req, body);
    if (!targetClientId) {
      error(
        res,
        "Missing client id. Provide X-Milady-Client-Id header or clientId in the request body.",
        400,
      );
      return;
    }

    const emitTerminalEvent = (payload: Record<string, unknown>) => {
      if (isSharedTerminalClientId(targetClientId)) {
        state.broadcastWs?.(payload);
        return;
      }
      if (typeof state.broadcastWsToClientId !== "function") return;
      state.broadcastWsToClientId(targetClientId, payload);
    };

    const { maxConcurrent, maxDurationMs } = resolveTerminalRunLimits();
    if (activeTerminalRunCount >= maxConcurrent) {
      error(
        res,
        `Too many active terminal runs (${maxConcurrent}). Wait for a command to finish.`,
        429,
      );
      return;
    }

    // Respond immediately — output streams via WebSocket
    json(res, { ok: true });

    // Spawn in background and broadcast output
    const { spawn } = await import("node:child_process");
    const runId = `run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    emitTerminalEvent({
      type: "terminal-output",
      runId,
      event: "start",
      command,
      maxDurationMs,
    });

    const proc = spawn(command, {
      shell: true,
      cwd: process.cwd(),
      env: { ...process.env, FORCE_COLOR: "0" },
    });

    activeTerminalRunCount += 1;
    let finalized = false;
    const finalize = () => {
      if (finalized) return;
      finalized = true;
      activeTerminalRunCount = Math.max(0, activeTerminalRunCount - 1);
      clearTimeout(timeoutHandle);
    };

    const timeoutHandle = setTimeout(() => {
      if (proc.killed) return;
      proc.kill("SIGTERM");
      emitTerminalEvent({
        type: "terminal-output",
        runId,
        event: "timeout",
        maxDurationMs,
      });

      setTimeout(() => {
        if (!proc.killed) proc.kill("SIGKILL");
      }, 3000);
    }, maxDurationMs);

    proc.stdout?.on("data", (chunk: Buffer) => {
      emitTerminalEvent({
        type: "terminal-output",
        runId,
        event: "stdout",
        data: chunk.toString("utf-8"),
      });
    });

    proc.stderr?.on("data", (chunk: Buffer) => {
      emitTerminalEvent({
        type: "terminal-output",
        runId,
        event: "stderr",
        data: chunk.toString("utf-8"),
      });
    });

    proc.on("close", (code: number | null) => {
      finalize();
      emitTerminalEvent({
        type: "terminal-output",
        runId,
        event: "exit",
        code: code ?? 1,
      });
    });

    proc.on("error", (err: Error) => {
      finalize();
      emitTerminalEvent({
        type: "terminal-output",
        runId,
        event: "error",
        data: err.message,
      });
    });

    return;
  }

  // ── Custom Actions CRUD ──────────────────────────────────────────────

  if (method === "GET" && pathname === "/api/custom-actions") {
    const config = loadElizaConfig();
    json(res, { actions: config.customActions ?? [] });
    return;
  }

  if (method === "POST" && pathname === "/api/custom-actions") {
    const body = await readJsonBody<Record<string, unknown>>(req, res);
    if (!body) return;

    const name = typeof body.name === "string" ? body.name.trim() : "";
    const description =
      typeof body.description === "string" ? body.description.trim() : "";

    if (!name || !description) {
      error(res, "name and description are required", 400);
      return;
    }

    const handler = body.handler as CustomActionDef["handler"] | undefined;
    const validHandlerTypes = new Set(["http", "shell", "code"]);
    if (!handler || !handler.type || !validHandlerTypes.has(handler.type)) {
      error(
        res,
        "handler with valid type (http, shell, code) is required",
        400,
      );
      return;
    }

    // Security gate: shell and code handlers execute arbitrary commands or
    // code on the host machine, and the resulting action persists in config
    // (survives restarts). Require the MILADY_TERMINAL_RUN_TOKEN to prove
    // the caller has explicit operator authority for code execution.
    if (handler.type === "shell" || handler.type === "code") {
      const terminalRejection = resolveTerminalRunRejection(
        req,
        body as TerminalRunRequestBody,
      );
      if (terminalRejection) {
        error(
          res,
          `Creating ${handler.type} actions requires terminal authorization. ${terminalRejection.reason}`,
          terminalRejection.status,
        );
        return;
      }
    }

    // Validate type-specific required fields
    if (
      handler.type === "http" &&
      (typeof handler.url !== "string" || !handler.url.trim())
    ) {
      error(res, "HTTP handler requires a url", 400);
      return;
    }
    if (
      handler.type === "shell" &&
      (typeof handler.command !== "string" || !handler.command.trim())
    ) {
      error(res, "Shell handler requires a command", 400);
      return;
    }
    if (
      handler.type === "code" &&
      (typeof handler.code !== "string" || !handler.code.trim())
    ) {
      error(res, "Code handler requires code", 400);
      return;
    }

    const now = new Date().toISOString();
    const actionDef: CustomActionDef = {
      id: crypto.randomUUID(),
      name: name.toUpperCase().replace(/\s+/g, "_"),
      description,
      similes: Array.isArray(body.similes)
        ? body.similes.filter((s): s is string => typeof s === "string")
        : [],
      parameters: Array.isArray(body.parameters)
        ? (body.parameters as Array<{
            name: string;
            description: string;
            required: boolean;
          }>)
        : [],
      handler,
      enabled: body.enabled !== false,
      createdAt: now,
      updatedAt: now,
    };

    const config = loadElizaConfig();
    if (!config.customActions) config.customActions = [];
    config.customActions.push(actionDef);
    saveElizaConfig(config);

    // Hot-register into the running agent so it's available immediately
    if (actionDef.enabled) {
      registerCustomActionLive(actionDef);
    }

    json(res, { ok: true, action: actionDef });
    return;
  }

  // Generate a custom action definition from a natural language prompt
  if (method === "POST" && pathname === "/api/custom-actions/generate") {
    const body = await readJsonBody<{ prompt?: string }>(req, res);
    if (!body) return;

    const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
    if (!prompt) {
      error(res, "prompt is required", 400);
      return;
    }

    const runtime = state.runtime;
    if (!runtime) {
      error(res, "Agent runtime not available", 503);
      return;
    }

    try {
      const systemPrompt = [
        "You are a helper that generates custom action definitions from natural language descriptions.",
        "Given a user's description of what they want an action to do, generate a JSON object with these fields:",
        "",
        "- name: string (UPPER_SNAKE_CASE action name)",
        "- description: string (clear description of what the action does)",
        "- similes: optional string[] of alternative action names and phrases",
        '- handlerType: "http" | "shell" | "code"',
        "- handler: object with type-specific fields:",
        '  For http: { type: "http", method: "GET"|"POST"|etc, url: string, headers?: object, bodyTemplate?: string }',
        '  For shell: { type: "shell", command: string }',
        '  For code: { type: "code", code: string }',
        "- parameters: array of { name: string, description: string, required: boolean }",
        "",
        "Use {{paramName}} placeholders in URLs, body templates, and shell commands.",
        "For code handlers, parameters are available via params.paramName and fetch() is available.",
        "",
        "Respond with ONLY the JSON object, no markdown fences or explanation.",
      ].join("\n");

      const llmResponse = await runtime.useModel(ModelType.TEXT_SMALL, {
        prompt: `${systemPrompt}\n\nUser request: ${prompt}`,
      });

      // Parse the JSON from the LLM response
      const text =
        typeof llmResponse === "string" ? llmResponse : String(llmResponse);
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        error(res, "Failed to generate action definition", 500);
        return;
      }

      const generated = JSON.parse(jsonMatch[0]) as Record<string, unknown>;
      json(res, { ok: true, generated });
    } catch (err) {
      error(
        res,
        `Generation failed: ${err instanceof Error ? err.message : String(err)}`,
        500,
      );
    }
    return;
  }

  const customActionMatch = pathname.match(/^\/api\/custom-actions\/([^/]+)$/);
  const customActionTestMatch = pathname.match(
    /^\/api\/custom-actions\/([^/]+)\/test$/,
  );

  if (method === "POST" && customActionTestMatch) {
    const actionId = decodeURIComponent(customActionTestMatch[1]);
    const body = await readJsonBody<{ params?: Record<string, string> }>(
      req,
      res,
    );
    if (!body) return;

    const config = loadElizaConfig();
    const def = (config.customActions ?? []).find((a) => a.id === actionId);
    if (!def) {
      error(res, "Action not found", 404);
      return;
    }

    // Security gate: shell/code handlers execute arbitrary commands on the host.
    if (def.handler.type === "shell" || def.handler.type === "code") {
      const terminalRejection = resolveTerminalRunRejection(
        req,
        body as TerminalRunRequestBody,
      );
      if (terminalRejection) {
        error(
          res,
          `Testing ${def.handler.type} actions requires terminal authorization. ${terminalRejection.reason}`,
          terminalRejection.status,
        );
        return;
      }
    }

    const testParams = body.params ?? {};
    const start = Date.now();
    try {
      const handler = buildTestHandler(def);
      const result = await handler(testParams);
      json(res, {
        ok: result.ok,
        output: result.output,
        durationMs: Date.now() - start,
      });
    } catch (err) {
      json(res, {
        ok: false,
        output: "",
        error: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - start,
      });
    }
    return;
  }

  if (method === "PUT" && customActionMatch) {
    const actionId = decodeURIComponent(customActionMatch[1]);
    const body = await readJsonBody<Record<string, unknown>>(req, res);
    if (!body) return;

    const config = loadElizaConfig();
    const actions = config.customActions ?? [];
    const idx = actions.findIndex((a) => a.id === actionId);
    if (idx === -1) {
      error(res, "Action not found", 404);
      return;
    }

    const existing = actions[idx];

    // Validate handler if provided in the update
    let newHandler = existing.handler;
    if (body.handler != null) {
      const h = body.handler as Record<string, unknown>;
      const hValidTypes = new Set(["http", "shell", "code"]);
      if (!h.type || !hValidTypes.has(h.type as string)) {
        error(res, "handler.type must be http, shell, or code", 400);
        return;
      }
      newHandler = h as unknown as CustomActionDef["handler"];
    }

    // Security gate: if the new/updated handler is shell or code, require
    // terminal authorization — same gate as POST creation.
    if (newHandler.type === "shell" || newHandler.type === "code") {
      const terminalRejection = resolveTerminalRunRejection(
        req,
        body as TerminalRunRequestBody,
      );
      if (terminalRejection) {
        error(
          res,
          `Updating to ${newHandler.type} handler requires terminal authorization. ${terminalRejection.reason}`,
          terminalRejection.status,
        );
        return;
      }
    }

    const updated: CustomActionDef = {
      ...existing,
      name:
        typeof body.name === "string"
          ? body.name.trim().toUpperCase().replace(/\s+/g, "_")
          : existing.name,
      description:
        typeof body.description === "string"
          ? body.description.trim()
          : existing.description,
      similes: Array.isArray(body.similes)
        ? body.similes.filter((s): s is string => typeof s === "string")
        : existing.similes,
      parameters: Array.isArray(body.parameters)
        ? (body.parameters as CustomActionDef["parameters"])
        : existing.parameters,
      handler: newHandler,
      enabled:
        typeof body.enabled === "boolean" ? body.enabled : existing.enabled,
      updatedAt: new Date().toISOString(),
    };

    actions[idx] = updated;
    config.customActions = actions;
    saveElizaConfig(config);

    json(res, { ok: true, action: updated });
    return;
  }

  if (method === "DELETE" && customActionMatch) {
    const actionId = decodeURIComponent(customActionMatch[1]);

    const config = loadElizaConfig();
    const actions = config.customActions ?? [];
    const idx = actions.findIndex((a) => a.id === actionId);
    if (idx === -1) {
      error(res, "Action not found", 404);
      return;
    }

    actions.splice(idx, 1);
    config.customActions = actions;
    saveElizaConfig(config);

    json(res, { ok: true });
    return;
  }

  // ── Stream Manager routes ──────────────────────────────────────────────
  // Handled by handleStreamRoute() in stream-routes.ts (registered via
  // connectorRouteHandlers below). Endpoints: /api/stream/*

  // ── LTCG Autonomy routes ─────────────────────────────────────────────
  // The LTCG plugin registers these as elizaOS plugin routes, but Milady's
  // server doesn't dispatch plugin routes. Wire them up directly here.
  if (pathname.startsWith("/api/ltcg/autonomy")) {
    try {
      const { getAutonomyController } = await import("@lunchtable/plugin-ltcg");
      const ctrl = getAutonomyController();

      if (method === "GET" && pathname === "/api/ltcg/autonomy/status") {
        json(res, ctrl.getStatus());
        return;
      }

      if (method === "POST" && pathname === "/api/ltcg/autonomy/start") {
        const body = (await readJsonBody(req, res)) ?? {};
        const bodyRecord = body as Record<string, unknown>;
        const mode = bodyRecord.mode === "pvp" ? "pvp" : "story";
        const continuousValue = bodyRecord.continuous;
        const continuous =
          typeof continuousValue === "boolean" ? continuousValue : true;
        await ctrl.start({ mode, continuous });
        json(res, { ok: true, mode, continuous });
        return;
      }

      if (method === "POST" && pathname === "/api/ltcg/autonomy/pause") {
        ctrl.pause();
        json(res, { ok: true, state: "paused" });
        return;
      }

      if (method === "POST" && pathname === "/api/ltcg/autonomy/resume") {
        ctrl.resume();
        json(res, { ok: true, state: "running" });
        return;
      }

      if (method === "POST" && pathname === "/api/ltcg/autonomy/stop") {
        await ctrl.stop();
        json(res, { ok: true, state: "idle" });
        return;
      }
    } catch (err) {
      logger.error(
        `[ltcg-autonomy] ${err instanceof Error ? err.message : err}`,
      );
      error(res, err instanceof Error ? err.message : "Autonomy error", 500);
      return;
    }
  }

  // ── Connector plugin routes (dynamically registered) ────────────────────
  for (const handler of state.connectorRouteHandlers) {
    const handled = await handler(req, res, pathname, method);
    if (handled) return;
  }

  // ── Fallback ────────────────────────────────────────────────────────────
  error(res, "Not found", 404);
}

// ---------------------------------------------------------------------------
// Early log capture — re-exported from the standalone module so existing
// callers that `import { captureEarlyLogs } from "../../../../src/api/server"` keep
// working.  The implementation lives in `./early-logs.ts` to avoid pulling
// the entire server dependency graph into lightweight consumers (e.g. the
// headless `startEliza()` path).
// ---------------------------------------------------------------------------
import { type captureEarlyLogs, flushEarlyLogs } from "./early-logs";

export type { captureEarlyLogs };

// ---------------------------------------------------------------------------
// Server start
// ---------------------------------------------------------------------------

export async function startApiServer(opts?: {
  port?: number;
  runtime?: AgentRuntime;
  /** Initial state when starting without a runtime (e.g. embedded bootstrapping). */
  initialAgentState?: "not_started" | "starting" | "stopped" | "error";
  /**
   * Called when the UI requests a restart via `POST /api/agent/restart`.
   * Should stop the current runtime, create a new one, and return it.
   * If omitted the endpoint returns 501 (not supported in this mode).
   */
  onRestart?: () => Promise<AgentRuntime | null>;
}): Promise<{
  port: number;
  close: () => Promise<void>;
  updateRuntime: (rt: AgentRuntime) => void;
  updateStartup: (
    update: Partial<AgentStartupDiagnostics> & {
      phase?: string;
      attempt?: number;
      state?: ServerState["agentState"];
    },
  ) => void;
}> {
  const apiStartTime = Date.now();
  console.log(`[milady-api] startApiServer called`);

  const port = opts?.port ?? 2138;
  const host =
    (process.env.ELIZA_API_BIND ?? process.env.MILADY_API_BIND ?? "127.0.0.1").trim() || "127.0.0.1";
  ensureApiTokenForBindHost(host);
  console.log(`[milady-api] Token check done (${Date.now() - apiStartTime}ms)`);

  let config: ElizaConfig;
  try {
    config = loadElizaConfig();
  } catch (err) {
    logger.warn(
      `[milady-api] Failed to load config, starting with defaults: ${err instanceof Error ? err.message : err}`,
    );
    config = {} as ElizaConfig;
  }
  console.log(`[milady-api] Config loaded (${Date.now() - apiStartTime}ms)`);

  // Wallet/inventory routes read from process.env at request-time.
  // Hydrate persisted config.env values so addresses remain visible after restarts.
  const persistedEnv = config.env as Record<string, string> | undefined;
  const envKeysToHydrate = [
    "EVM_PRIVATE_KEY",
    "SOLANA_PRIVATE_KEY",
    "ALCHEMY_API_KEY",
    "INFURA_API_KEY",
    "ANKR_API_KEY",
    "HELIUS_API_KEY",
    "BIRDEYE_API_KEY",
    "SOLANA_RPC_URL",
  ] as const;
  for (const key of envKeysToHydrate) {
    const value = persistedEnv?.[key];
    if (typeof value === "string" && value.trim() && !process.env[key]) {
      process.env[key] = value.trim();
    }
  }

  // Self-heal older configs where wallet keys were never provisioned
  // (e.g. RPC/cloud configured outside onboarding).
  if (ensureWalletKeysInEnvAndConfig(config)) {
    try {
      saveElizaConfig(config);
    } catch (err) {
      logger.warn(
        `[milady-api] Failed to persist generated wallet keys: ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  const plugins = discoverPluginsFromManifest();
  console.log(
    `[milady-api] Plugins discovered (${Date.now() - apiStartTime}ms)`,
  );
  const workspaceDir =
    config.agents?.defaults?.workspace ?? resolveDefaultAgentWorkspaceDir();

  const hasRuntime = opts?.runtime != null;
  const initialAgentState = hasRuntime
    ? "running"
    : (opts?.initialAgentState ?? "not_started");
  const initialStartup: AgentStartupDiagnostics =
    initialAgentState === "running"
      ? { phase: "running", attempt: 0 }
      : initialAgentState === "starting"
        ? { phase: "starting", attempt: 0 }
        : { phase: "idle", attempt: 0 };
  const agentName = hasRuntime
    ? (opts.runtime?.character.name ?? "Milady")
    : (config.agents?.list?.[0]?.name ??
      config.ui?.assistant?.name ??
      "Milady");

  const deletedConversationIds = readDeletedConversationIdsFromState();

  const state: ServerState = {
    runtime: opts?.runtime ?? null,
    config,
    agentState: initialAgentState,
    agentName,
    model: hasRuntime
      ? detectRuntimeModel(opts.runtime ?? null, config)
      : undefined,
    startedAt:
      hasRuntime || initialAgentState === "starting" ? Date.now() : undefined,
    startup: initialStartup,
    plugins,
    // Filled asynchronously after server start to keep startup latency low.
    skills: [],
    logBuffer: [],
    eventBuffer: [],
    nextEventId: 1,
    chatRoomId: null,
    chatUserId: null,
    chatConnectionReady: null,
    chatConnectionPromise: null,
    adminEntityId: null,
    conversations: new Map(),
    conversationRestorePromise: null,
    deletedConversationIds,
    cloudManager: null,
    sandboxManager: null,
    appManager: new AppManager(),
    trainingService: null,
    registryService: null,
    dropService: null,
    shareIngestQueue: [],
    broadcastStatus: null,
    broadcastWs: null,
    broadcastWsToClientId: null,
    activeConversationId: null,
    permissionStates: {},
    shellEnabled: config.features?.shellEnabled !== false,
    agentAutomationMode: resolveAgentAutomationModeFromConfig(config),
    tradePermissionMode: resolveTradePermissionMode(config),
    pendingRestartReasons: [],
    connectorRouteHandlers: [],
    connectorHealthMonitor: null,
  };

  // Closure-captured refs for auto-TTS triggering in the event pipeline.
  // Set when the streaming connector initializes its route state.
  let streamRouteStateRef:
    | import("./stream-routes.js").StreamRouteState
    | null = null;
  let onAgentMessageFn:
    | ((
        text: string,
        state: import("./stream-routes.js").StreamRouteState,
      ) => Promise<void>)
    | null = null;

  const trainingServiceCtor = await resolveTrainingServiceCtor();
  const trainingServiceOptions = {
    getRuntime: () => state.runtime,
    getConfig: () => state.config,
    setConfig: (nextConfig: ElizaConfig) => {
      state.config = nextConfig;
      saveElizaConfig(nextConfig);
    },
  };
  if (trainingServiceCtor) {
    state.trainingService = new trainingServiceCtor(trainingServiceOptions);
  } else {
    logger.warn(
      "[milady-api] Training service package unavailable; using fallback in-memory implementation",
    );
    state.trainingService = new FallbackTrainingService(trainingServiceOptions);
  }
  // Register immediately so /api/training routes are available without a startup race.
  const configuredAdminEntityId = config.agents?.defaults?.adminEntityId;
  if (configuredAdminEntityId && isUuidLike(configuredAdminEntityId)) {
    state.adminEntityId = configuredAdminEntityId;
    state.chatUserId = state.adminEntityId;
  } else if (configuredAdminEntityId) {
    logger.warn(
      `[milady-api] Ignoring invalid agents.defaults.adminEntityId "${configuredAdminEntityId}"`,
    );
  }

  // Wire the app manager to the runtime if already running
  if (state.runtime) {
    // AppManager doesn't need a runtime reference — it just installs plugins
  }

  const addLog = (
    level: string,
    message: string,
    source = "system",
    tags: string[] = [],
  ) => {
    let resolvedSource = source;
    if (source === "auto" || source === "system") {
      const bracketMatch = /^\[([^\]]+)\]\s*/.exec(message);
      if (bracketMatch) resolvedSource = bracketMatch[1];
    }
    // Auto-tag based on source when no explicit tags provided
    const resolvedTags =
      tags.length > 0
        ? tags
        : resolvedSource === "runtime" || resolvedSource === "autonomy"
          ? ["agent"]
          : resolvedSource === "api" || resolvedSource === "websocket"
            ? ["server"]
            : resolvedSource === "cloud"
              ? ["server", "cloud"]
              : ["system"];
    pushWithBatchEvict(
      state.logBuffer,
      {
        timestamp: Date.now(),
        level,
        message,
        source: resolvedSource,
        tags: resolvedTags,
      },
      1200,
      200,
    );
  };

  // ── Flush early-captured logs into the main buffer ────────────────────
  const earlyEntries = flushEarlyLogs();
  if (earlyEntries.length > 0) {
    for (const entry of earlyEntries) {
      state.logBuffer.push(entry);
    }
    if (state.logBuffer.length > 1000) {
      state.logBuffer.splice(0, state.logBuffer.length - 1000);
    }
    addLog(
      "info",
      `Flushed ${earlyEntries.length} early startup log entries`,
      "system",
      ["system"],
    );
  }

  addLog(
    "info",
    `Discovered ${plugins.length} plugins, loading skills in background`,
    "system",
    ["system", "plugins"],
  );

  // Warm per-provider model caches in background (non-blocking)
  void getOrFetchAllProviders().catch(() => {});

  // ── Intercept loggers so ALL agent/plugin/service logs appear in the UI ──
  // We patch both the global `logger` singleton from @elizaos/core (used by
  // eliza.ts, services, plugins, etc.) AND the runtime instance logger.
  // A marker prevents double-patching on hot-restart and avoids stacking
  // wrapper functions that would leak memory.
  const PATCHED_MARKER = "__miladyLogPatched";
  const LEVELS = ["debug", "info", "warn", "error"] as const;

  /**
   * Patch a logger object so every log call also feeds into the UI log buffer.
   * Returns true if patching was performed, false if already patched.
   */
  const patchLogger = (
    target: typeof logger,
    defaultSource: string,
    defaultTags: string[],
  ): boolean => {
    if ((target as unknown as Record<string, unknown>)[PATCHED_MARKER]) {
      return false;
    }

    for (const lvl of LEVELS) {
      const original = target[lvl].bind(target);
      // pino / adze signature: logger.info(obj, msg) or logger.info(msg)
      const patched: (typeof target)[typeof lvl] = (
        ...args: Parameters<typeof original>
      ) => {
        let msg = "";
        let source = defaultSource;
        let tags = [...defaultTags];
        if (typeof args[0] === "string") {
          msg = args[0];
        } else if (args[0] && typeof args[0] === "object") {
          const obj = args[0] as Record<string, unknown>;
          if (typeof obj.src === "string") source = obj.src;
          // Extract tags from structured log objects
          if (Array.isArray(obj.tags)) {
            tags = [...tags, ...(obj.tags as string[])];
          }
          msg = typeof args[1] === "string" ? args[1] : JSON.stringify(obj);
        }
        // Auto-extract source from [bracket] prefixes (e.g. "[milady] ...")
        const bracketMatch = /^\[([^\]]+)\]\s*/.exec(msg);
        if (bracketMatch && source === defaultSource) {
          source = bracketMatch[1];
        }
        // Auto-tag based on source context
        if (source !== defaultSource && !tags.includes(source)) {
          tags.push(source);
        }
        if (msg) addLog(lvl, msg, source, tags);
        return original(...args);
      };
      target[lvl] = patched;
    }

    (target as unknown as Record<string, unknown>)[PATCHED_MARKER] = true;
    return true;
  };

  // 1) Patch the global @elizaos/core logger — this captures ALL log calls
  //    from eliza.ts, services, plugins, cloud, hooks, etc.
  if (patchLogger(logger, "agent", ["agent"])) {
    addLog(
      "info",
      "Global logger connected — all agent logs will stream to the UI",
      "system",
      ["system", "agent"],
    );
  }

  // 2) Patch the runtime instance logger (if it's a different object)
  //    This catches logs from runtime internals that use their own logger child.
  if (opts?.runtime?.logger && opts.runtime.logger !== logger) {
    if (patchLogger(opts.runtime.logger, "runtime", ["agent", "runtime"])) {
      addLog(
        "info",
        "Runtime logger connected — runtime logs will stream to the UI",
        "system",
        ["system", "agent"],
      );
    }
  }

  // Store the restart callback on the state so the route handler can access it.
  const onRestart = opts?.onRestart ?? null;

  console.log(
    `[milady-api] Creating http server (${Date.now() - apiStartTime}ms)`,
  );
  const server = http.createServer(async (req, res) => {
    try {
      await handleRequest(req, res, state, {
        onRestart,
        onRuntimeSwapped: () => {
          bindRuntimeStreams(state.runtime);
          void wireCoordinatorBridgesWhenReady(state, {
            wireChatBridge: wireCodingAgentChatBridge,
            wireWsBridge: wireCodingAgentWsBridge,
            wireEventRouting: wireCoordinatorEventRouting,
            wireSwarmSynthesis: wireCodingAgentSwarmSynthesis,
            context: "restart",
            logger,
          });
        },
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "internal error";
      addLog("error", msg, "api", ["server", "api"]);
      error(res, msg, 500);
    }
  });
  console.log(`[milady-api] Server created (${Date.now() - apiStartTime}ms)`);

  const broadcastWs = (payload: object): void => {
    const message = JSON.stringify(payload);
    for (const client of wsClients) {
      if (client.readyState === 1) {
        try {
          client.send(message);
        } catch (err) {
          logger.error(
            `[milady-api] WebSocket broadcast error: ${err instanceof Error ? err.message : err}`,
          );
        }
      }
    }
  };

  const pushEvent = (
    event: Omit<StreamEventEnvelope, "eventId" | "version">,
  ) => {
    const envelope: StreamEventEnvelope = {
      ...event,
      eventId: `evt-${state.nextEventId}`,
      version: 1,
    };
    state.nextEventId += 1;
    state.eventBuffer.push(envelope);
    if (state.eventBuffer.length > 1500) {
      state.eventBuffer.splice(0, state.eventBuffer.length - 1500);
    }
    broadcastWs(envelope);
  };

  let detachRuntimeStreams: (() => void) | null = null;
  let detachTrainingStream: (() => void) | null = null;
  const bindRuntimeStreams = (runtime: AgentRuntime | null) => {
    if (detachRuntimeStreams) {
      detachRuntimeStreams();
      detachRuntimeStreams = null;
    }
    const svc = getAgentEventSvc(runtime);
    if (!svc) {
      if (runtime) {
        logger.warn(
          "[milady-api] AGENT_EVENT service not found on runtime — event streaming will be unavailable",
        );
      }
      return;
    }

    const unsubAgentEvents = svc.subscribe((event) => {
      pushEvent({
        type: "agent_event",
        ts: event.ts,
        runId: event.runId,
        seq: event.seq,
        stream: event.stream,
        sessionKey: event.sessionKey,
        agentId: event.agentId,
        roomId: event.roomId,
        payload: event.data,
      });

      void maybeRouteAutonomyEventToConversation(state, event).catch((err) => {
        logger.warn(
          `[autonomy-route] Failed to route proactive event: ${err instanceof Error ? err.message : String(err)}`,
        );
      });

      // Auto-trigger TTS for assistant messages on the stream
      const srs = streamRouteStateRef;
      const ttsHandler = onAgentMessageFn;
      if (event.stream === "assistant" && srs && ttsHandler) {
        const payload =
          event.data && typeof event.data === "object"
            ? (event.data as Record<string, unknown>)
            : null;
        const text =
          typeof payload?.text === "string" ? payload.text.trim() : "";
        if (text) {
          void ttsHandler(text, srs).catch((err) => {
            logger.warn(
              `[stream-voice] Auto-TTS trigger failed: ${err instanceof Error ? err.message : String(err)}`,
            );
          });
        }
      }
    });

    const unsubHeartbeat = svc.subscribeHeartbeat((event) => {
      pushEvent({
        type: "heartbeat_event",
        ts: event.ts,
        payload: event,
      });
    });

    detachRuntimeStreams = () => {
      unsubAgentEvents();
      unsubHeartbeat();
    };
  };

  const bindTrainingStream = () => {
    if (detachTrainingStream) {
      detachTrainingStream();
      detachTrainingStream = null;
    }
    if (!state.trainingService) return;
    detachTrainingStream = state.trainingService.subscribe((event: unknown) => {
      const payload =
        typeof event === "object" && event !== null ? event : { value: event };
      pushEvent({
        type: "training_event",
        ts: Date.now(),
        payload,
      });
    });
  };

  // ── Deferred startup work (non-blocking) ────────────────────────────────
  // Keep API startup fast: listen first, then warm optional subsystems.
  const startDeferredStartupWork = () => {
    void (async () => {
      try {
        const discoveredSkills = await discoverSkills(
          workspaceDir,
          state.config,
          state.runtime,
        );
        state.skills = discoveredSkills;
        addLog(
          "info",
          `Discovered ${discoveredSkills.length} skills`,
          "system",
          ["system", "plugins"],
        );
      } catch (err) {
        logger.warn(
          `[milady-api] Skill discovery failed during startup: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    })();

    void (async () => {
      const trainingService = state.trainingService;
      if (!trainingService) return;
      try {
        await trainingService.initialize();
        bindTrainingStream();
        addLog("info", "Training service initialised", "system", [
          "system",
          "training",
        ]);
      } catch (err) {
        logger.error(
          `[milady-api] Training service init failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    })();

    void (async () => {
      initializeOGCodeInState();

      // Get EVM private key from runtime secrets (preferred) or config.env (fallback)
      const runtime = state.runtime;
      const evmKey =
        (runtime?.getSetting?.("EVM_PRIVATE_KEY") as string | undefined) ??
        (state.config.env as Record<string, string> | undefined)
          ?.EVM_PRIVATE_KEY;
      const registryConfig = state.config.registry;
      if (
        !evmKey ||
        !registryConfig?.registryAddress ||
        !registryConfig.mainnetRpc
      ) {
        return;
      }

      try {
        const txService = new TxService(registryConfig.mainnetRpc, evmKey);
        state.registryService = new RegistryService(
          txService,
          registryConfig.registryAddress,
        );

        if (registryConfig.collectionAddress) {
          const dropEnabled = state.config.features?.dropEnabled === true;
          state.dropService = new DropService(
            txService,
            registryConfig.collectionAddress,
            dropEnabled,
          );
        }

        addLog(
          "info",
          `ERC-8004 registry service initialised (${registryConfig.registryAddress})`,
          "system",
          ["system"],
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        addLog("warn", `ERC-8004 registry service disabled: ${msg}`, "system", [
          "system",
        ]);
        logger.warn({ err }, "Failed to initialize ERC-8004 registry service");
      }
    })();

    // ── Connector health monitoring ──────────────────────────────────────────
    if (state.runtime && state.config.connectors) {
      state.connectorHealthMonitor = new ConnectorHealthMonitor({
        runtime: state.runtime,
        config: state.config,
        broadcastWs,
      });
      state.connectorHealthMonitor.start();
    }

    // ── Dynamic streaming + connector route loading ────────────────────────
    // Always register generic stream routes. If a streaming destination is
    // configured, inject it so /api/stream/live can fetch credentials.
    void (async () => {
      try {
        const { handleStreamRoute, onAgentMessage } = await import(
          "./stream-routes.js"
        );
        onAgentMessageFn = onAgentMessage;
        // Screen capture manager is injected by the desktop host via globalThis
        const screenCapture = (globalThis as Record<string, unknown>)
          .__miladyScreenCapture as
          | {
              isFrameCaptureActive(): boolean;
              startFrameCapture(opts: {
                fps?: number;
                quality?: number;
                endpoint?: string;
              }): Promise<void>;
            }
          | undefined;

        // Build destination registry — all configured destinations
        const connectors = state.config.connectors ?? {};
        const streaming = (state.config as Record<string, unknown>).streaming as
          | Record<string, unknown>
          | undefined;
        const destinations = new Map<
          string,
          import("./stream-routes.js").StreamingDestination
        >();

        // Retake (API-driven, full integration)
        if (isConnectorConfigured("retake", connectors.retake)) {
          try {
            const retakeMod = "@elizaos/plugin-retake";
            const { createRetakeDestination } = await import(retakeMod);
            destinations.set(
              "retake",
              createRetakeDestination(
                connectors.retake as
                  | { accessToken?: string; apiUrl?: string }
                  | undefined,
              ),
            );
          } catch (err) {
            logger.warn(
              `[milady-api] Failed to load retake destination: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        }

        // Custom RTMP
        if (
          isStreamingDestinationConfigured("customRtmp", streaming?.customRtmp)
        ) {
          try {
            const { createCustomRtmpDestination } = await import(
              "../plugins/custom-rtmp/index.js"
            );
            destinations.set(
              "custom-rtmp",
              createCustomRtmpDestination(
                streaming?.customRtmp as {
                  rtmpUrl?: string;
                  rtmpKey?: string;
                },
              ),
            );
          } catch (err) {
            logger.warn(
              `[milady-api] Failed to load custom-rtmp destination: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        }

        // Twitch
        if (isStreamingDestinationConfigured("twitch", streaming?.twitch)) {
          try {
            const twitchMod = "@elizaos/plugin-twitch-streaming";
            const { createTwitchDestination } = await import(twitchMod);
            destinations.set(
              "twitch",
              createTwitchDestination(
                streaming?.twitch as { streamKey?: string },
              ),
            );
          } catch (err) {
            logger.warn(
              `[milady-api] Failed to load twitch destination: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        }

        // YouTube
        if (isStreamingDestinationConfigured("youtube", streaming?.youtube)) {
          try {
            const youtubeMod = "@elizaos/plugin-youtube-streaming";
            const { createYoutubeDestination } = await import(youtubeMod);
            destinations.set(
              "youtube",
              createYoutubeDestination(
                streaming?.youtube as { streamKey?: string; rtmpUrl?: string },
              ),
            );
          } catch (err) {
            logger.warn(
              `[milady-api] Failed to load youtube destination: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        }

        // pump.fun
        if (isStreamingDestinationConfigured("pumpfun", streaming?.pumpfun)) {
          try {
            const pumpfunMod = "@elizaos/plugin-pumpfun-streaming";
            const { createPumpfunDestination } = await import(pumpfunMod);
            destinations.set(
              "pumpfun",
              createPumpfunDestination(
                streaming?.pumpfun as { streamKey?: string; rtmpUrl?: string },
              ),
            );
          } catch (err) {
            logger.warn(
              `[milady-api] Failed to load pumpfun destination: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        }

        // X (Twitter)
        if (isStreamingDestinationConfigured("x", streaming?.x)) {
          try {
            const xMod = "@elizaos/plugin-x-streaming";
            const { createXStreamDestination } = await import(xMod);
            destinations.set(
              "x",
              createXStreamDestination(
                streaming?.x as { streamKey?: string; rtmpUrl?: string },
              ),
            );
          } catch (err) {
            logger.warn(
              `[milady-api] Failed to load x destination: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        }

        // Active destination: config preference → first available
        const activeDestinationId =
          (streaming?.activeDestination as string | undefined) ??
          (destinations.size > 0
            ? destinations.keys().next().value
            : undefined);

        const streamState = {
          streamManager,
          port,
          screenCapture,
          captureUrl: (connectors.retake as Record<string, unknown> | undefined)
            ?.captureUrl as string | undefined,
          destinations,
          activeDestinationId,
          activeStreamSource: { type: "stream-tab" as const },
          get config() {
            const cfg = state.config as Record<string, unknown> | undefined;
            const msgs = cfg?.messages as Record<string, unknown> | undefined;
            return msgs
              ? {
                  messages: {
                    tts: msgs.tts as
                      | import("../config/types.messages").TtsConfig
                      | undefined,
                  },
                }
              : undefined;
          },
        };
        // Capture streamState in closure for auto-TTS triggering and route handling
        streamRouteStateRef = streamState;
        state.connectorRouteHandlers.push((req, res, pathname, method) =>
          handleStreamRoute(req, res, pathname, method, streamState),
        );

        const destNames = Array.from(destinations.values())
          .map((d) => d.name)
          .join(", ");
        const destLabel =
          destinations.size > 0
            ? `destinations: ${destNames}`
            : "no destinations";
        addLog("info", `Stream routes registered (${destLabel})`, "system", [
          "system",
          "streaming",
        ]);
      } catch (err) {
        logger.warn(
          `[milady-api] Failed to load stream routes: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    })();
  };

  // ── WebSocket Server ─────────────────────────────────────────────────────
  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
  const wsClients = new Set<WebSocket>();
  const wsClientIds = new WeakMap<WebSocket, string>();
  /** Per-WS-client PTY output subscriptions: sessionId → unsubscribe */
  const wsClientPtySubscriptions = new WeakMap<
    WebSocket,
    Map<string, () => void>
  >();
  bindRuntimeStreams(opts?.runtime ?? null);
  bindTrainingStream();

  // Wire coding-agent bridges at initial boot (event-driven via getServiceLoadPromise)
  if (opts?.runtime) {
    void wireCoordinatorBridgesWhenReady(state, {
      wireChatBridge: wireCodingAgentChatBridge,
      wireWsBridge: wireCodingAgentWsBridge,
      wireEventRouting: wireCoordinatorEventRouting,
      wireSwarmSynthesis: wireCodingAgentSwarmSynthesis,
      context: "boot",
      logger,
    });
  }

  // Handle upgrade requests for WebSocket
  server.on("upgrade", (request, socket, head) => {
    try {
      const wsUrl = new URL(
        request.url ?? "/",
        `http://${request.headers.host ?? "localhost"}`,
      );
      const rejection = resolveWebSocketUpgradeRejection(request, wsUrl);
      if (rejection) {
        rejectWebSocketUpgrade(socket, rejection.status, rejection.reason);
        return;
      }
      wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit("connection", ws, request);
      });
    } catch (err) {
      logger.error(
        `[milady-api] WebSocket upgrade error: ${err instanceof Error ? err.message : err}`,
      );
      rejectWebSocketUpgrade(socket, 404, "Not found");
    }
  });

  // Handle WebSocket connections
  wss.on("connection", (ws: WebSocket, request: http.IncomingMessage) => {
    try {
      const wsUrl = new URL(
        request.url ?? "/",
        `http://${request.headers.host ?? "localhost"}`,
      );
      const clientId = normalizeWsClientId(wsUrl.searchParams.get("clientId"));
      if (clientId) wsClientIds.set(ws, clientId);
    } catch {
      // Ignore malformed WS URL metadata; auth/path were already validated.
    }

    wsClients.add(ws);
    addLog("info", "WebSocket client connected", "websocket", [
      "server",
      "websocket",
    ]);

    // Send initial status and latest stream events.
    try {
      ws.send(
        JSON.stringify({
          type: "status",
          state: state.agentState,
          agentName: state.agentName,
          model: state.model,
          startedAt: state.startedAt,
          startup: state.startup,
          pendingRestart: state.pendingRestartReasons.length > 0,
          pendingRestartReasons: state.pendingRestartReasons,
        }),
      );
      const replay = state.eventBuffer.slice(-120);
      for (const event of replay) {
        ws.send(JSON.stringify(event));
      }
    } catch (err) {
      logger.error(
        `[milady-api] WebSocket send error: ${err instanceof Error ? err.message : err}`,
      );
    }

    ws.on("message", (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === "ping") {
          ws.send(JSON.stringify({ type: "pong" }));
        } else if (msg.type === "active-conversation") {
          state.activeConversationId =
            typeof msg.conversationId === "string" ? msg.conversationId : null;
        } else if (
          msg.type === "pty-subscribe" &&
          typeof msg.sessionId === "string"
        ) {
          const bridge = getPtyConsoleBridge(state);
          if (bridge) {
            let subs = wsClientPtySubscriptions.get(ws);
            if (!subs) {
              subs = new Map();
              wsClientPtySubscriptions.set(ws, subs);
            }
            // Don't double-subscribe
            if (!subs.has(msg.sessionId)) {
              const targetId = msg.sessionId;
              const listener = (evt: { sessionId: string; data: string }) => {
                if (evt.sessionId !== targetId) return;
                if (ws.readyState === 1) {
                  ws.send(
                    JSON.stringify({
                      type: "pty-output",
                      sessionId: targetId,
                      data: evt.data,
                    }),
                  );
                }
              };
              bridge.on("session_output", listener);
              subs.set(targetId, () => bridge.off("session_output", listener));
            }
          }
        } else if (
          msg.type === "pty-unsubscribe" &&
          typeof msg.sessionId === "string"
        ) {
          const subs = wsClientPtySubscriptions.get(ws);
          const unsub = subs?.get(msg.sessionId);
          if (unsub) {
            unsub();
            subs?.delete(msg.sessionId);
          }
        } else if (
          msg.type === "pty-input" &&
          typeof msg.sessionId === "string" &&
          typeof msg.data === "string"
        ) {
          // Only allow input to sessions this client has subscribed to
          const subs = wsClientPtySubscriptions.get(ws);
          if (!subs?.has(msg.sessionId)) {
            logger.warn(
              `[milady-api] pty-input rejected: client not subscribed to session ${msg.sessionId}`,
            );
          } else if (msg.data.length > 4096) {
            logger.warn(
              `[milady-api] pty-input rejected: payload too large (${msg.data.length} bytes) for session ${msg.sessionId}`,
            );
          } else {
            const bridge = getPtyConsoleBridge(state);
            if (bridge) {
              logger.debug(
                `[milady-api] pty-input: session=${msg.sessionId} len=${msg.data.length}`,
              );
              bridge.writeRaw(msg.sessionId, msg.data);
            }
          }
        } else if (
          msg.type === "pty-resize" &&
          typeof msg.sessionId === "string"
        ) {
          // Only allow resize for sessions this client has subscribed to
          const subs = wsClientPtySubscriptions.get(ws);
          if (!subs?.has(msg.sessionId)) {
            logger.warn(
              `[milady-api] pty-resize rejected: client not subscribed to session ${msg.sessionId}`,
            );
          } else {
            const bridge = getPtyConsoleBridge(state);
            if (
              bridge &&
              typeof msg.cols === "number" &&
              typeof msg.rows === "number" &&
              Number.isFinite(msg.cols) &&
              Number.isFinite(msg.rows) &&
              Number.isInteger(msg.cols) &&
              Number.isInteger(msg.rows) &&
              msg.cols >= 1 &&
              msg.cols <= 500 &&
              msg.rows >= 1 &&
              msg.rows <= 500
            ) {
              bridge.resize(msg.sessionId, msg.cols, msg.rows);
            } else {
              logger.warn(
                `[milady-api] pty-resize rejected: invalid dimensions cols=${msg.cols} rows=${msg.rows}`,
              );
            }
          }
        }
      } catch (err) {
        logger.error(
          `[milady-api] WebSocket message error: ${err instanceof Error ? err.message : err}`,
        );
      }
    });

    ws.on("close", () => {
      wsClients.delete(ws);
      // Clean up any PTY output subscriptions for this client
      const subs = wsClientPtySubscriptions.get(ws);
      if (subs) {
        for (const unsub of subs.values()) unsub();
        subs.clear();
      }
      addLog("info", "WebSocket client disconnected", "websocket", [
        "server",
        "websocket",
      ]);
    });

    ws.on("error", (err) => {
      logger.error(
        `[milady-api] WebSocket error: ${err instanceof Error ? err.message : err}`,
      );
      wsClients.delete(ws);
      // Clean up PTY subscriptions on error too
      const subs = wsClientPtySubscriptions.get(ws);
      if (subs) {
        for (const unsub of subs.values()) unsub();
        subs.clear();
      }
    });
  });

  // Broadcast status to all connected WebSocket clients (flattened — PR #36 fix)
  const broadcastStatus = () => {
    broadcastWs({
      type: "status",
      state: state.agentState,
      agentName: state.agentName,
      model: state.model,
      startedAt: state.startedAt,
      startup: state.startup,
      pendingRestart: state.pendingRestartReasons.length > 0,
      pendingRestartReasons: state.pendingRestartReasons,
    });
  };

  // Make broadcastStatus accessible to route handlers via state
  state.broadcastStatus = broadcastStatus;

  // Generic broadcast — sends an arbitrary JSON payload to all WS clients.
  state.broadcastWs = (data: Record<string, unknown>) => {
    const message = JSON.stringify(data);
    for (const client of wsClients) {
      if (client.readyState === 1) {
        try {
          client.send(message);
        } catch (err) {
          logger.error(
            `[milady-api] WebSocket broadcast error: ${err instanceof Error ? err.message : err}`,
          );
        }
      }
    }
  };

  state.broadcastWsToClientId = (
    clientId: string,
    data: Record<string, unknown>,
  ) => {
    const message = JSON.stringify(data);
    let delivered = 0;
    for (const client of wsClients) {
      if (client.readyState !== 1) continue;
      if (wsClientIds.get(client) !== clientId) continue;
      try {
        client.send(message);
        delivered += 1;
      } catch (err) {
        logger.error(
          `[milady-api] WebSocket targeted send error: ${err instanceof Error ? err.message : err}`,
        );
      }
    }
    return delivered;
  };

  // Broadcast status every 5 seconds
  const statusInterval = setInterval(broadcastStatus, 5000);

  /**
   * Restore the in-memory conversation list from the database.
   * Web-chat rooms live in a deterministic world; we scan it for rooms
   * whose channelId starts with "web-conv-" and reconstruct the metadata.
   */
  const restoreConversationsFromDb = async (
    rt: AgentRuntime,
  ): Promise<void> => {
    try {
      const agentName = rt.character.name ?? "Milady";
      const worldId = stringToUuid(`${agentName}-web-chat-world`);
      const rooms = await rt.getRoomsByWorld(worldId);
      if (!rooms?.length) return;

      let restored = 0;
      for (const room of rooms) {
        // channelId is "web-conv-{uuid}" — extract the conversation id
        const channelId =
          typeof room.channelId === "string" ? room.channelId : "";
        if (!channelId.startsWith("web-conv-")) continue;
        const convId = channelId.replace("web-conv-", "");
        if (!convId || state.conversations.has(convId)) continue;
        if (state.deletedConversationIds.has(convId)) continue;

        // Peek at the latest message to get a timestamp
        let updatedAt = new Date().toISOString();
        try {
          const msgs = await rt.getMemories({
            roomId: room.id as UUID,
            tableName: "messages",
            count: 1,
          });
          if (msgs.length > 0 && msgs[0].createdAt) {
            updatedAt = new Date(msgs[0].createdAt).toISOString();
          }
        } catch {
          // non-fatal — use current time
        }

        state.conversations.set(convId, {
          id: convId,
          title:
            ((room as unknown as Record<string, unknown>).name as string) ||
            "Chat",
          roomId: room.id as UUID,
          createdAt: updatedAt,
          updatedAt,
        });
        restored++;
      }
      if (restored > 0) {
        addLog(
          "info",
          `Restored ${restored} conversation(s) from database`,
          "system",
          ["system"],
        );
      }
    } catch (err) {
      logger.warn(
        `[milady-api] Failed to restore conversations from DB: ${err instanceof Error ? err.message : err}`,
      );
    }
  };

  const beginConversationRestore = (rt: AgentRuntime): Promise<void> => {
    const restorePromise = restoreConversationsFromDb(rt).finally(() => {
      if (state.conversationRestorePromise === restorePromise) {
        state.conversationRestorePromise = null;
      }
    });
    state.conversationRestorePromise = restorePromise;
    return restorePromise;
  };

  // Restore conversations from DB at initial boot (if runtime was passed in)
  if (opts?.runtime) {
    void beginConversationRestore(opts.runtime);
  }

  /** Hot-swap the runtime reference (used after an in-process restart). */
  const updateRuntime = (rt: AgentRuntime): void => {
    state.runtime = rt;
    state.chatConnectionReady = null;
    state.chatConnectionPromise = null;
    bindRuntimeStreams(rt);
    // AppManager doesn't need a runtime reference
    state.agentState = "running";
    state.agentName = rt.character.name ?? "Milady";
    state.model = detectRuntimeModel(rt, state.config);
    state.startedAt = Date.now();
    state.startup = {
      phase: "running",
      attempt: 0,
    };
    addLog("info", `Runtime restarted — agent: ${state.agentName}`, "system", [
      "system",
      "agent",
    ]);

    // Restore conversations from DB so they survive restarts
    void beginConversationRestore(rt);

    // Broadcast status update immediately after restart
    broadcastStatus();

    // Wire coding-agent bridges (event-driven via getServiceLoadPromise)
    void wireCoordinatorBridgesWhenReady(state, {
      wireChatBridge: wireCodingAgentChatBridge,
      wireWsBridge: wireCodingAgentWsBridge,
      wireEventRouting: wireCoordinatorEventRouting,
      wireSwarmSynthesis: wireCodingAgentSwarmSynthesis,
      context: "restart",
      logger,
    });
  };

  const updateStartup = (
    update: Partial<AgentStartupDiagnostics> & {
      phase?: string;
      attempt?: number;
      state?: ServerState["agentState"];
    },
  ): void => {
    const { state: nextState, ...startupUpdate } = update;
    state.startup = {
      ...state.startup,
      ...startupUpdate,
    };
    if (nextState) {
      state.agentState = nextState;
      if (nextState === "error") {
        state.startedAt = undefined;
      } else if (
        (nextState === "starting" || nextState === "running") &&
        !state.startedAt
      ) {
        state.startedAt = Date.now();
      }
    }
    broadcastStatus();
  };

  console.log(
    `[milady-api] Calling server.listen (${Date.now() - apiStartTime}ms)`,
  );
  return new Promise((resolve, reject) => {
    let currentPort = port;

    server.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") {
        console.warn(
          `[milady-api] Port ${currentPort} is already in use. Checking fallback...`,
        );
        if (currentPort !== 0) {
          console.warn(`[milady-api] Retrying with dynamic port (0)...`);
          currentPort = 0;
          server.listen(0, host);
          return;
        }
      } else {
        console.error(
          `[milady-api] Server error: ${err.message} (code: ${err.code})`,
        );
      }
      reject(err);
    });

    server.listen(port, host, () => {
      console.log(
        `[milady-api] server.listen callback fired (${Date.now() - apiStartTime}ms)`,
      );
      const addr = server.address();
      const actualPort =
        typeof addr === "object" && addr ? addr.port : currentPort;
      const displayHost =
        typeof addr === "object" && addr ? addr.address : host;
      addLog(
        "info",
        `API server listening on http://${displayHost}:${actualPort}`,
        "system",
        ["server", "system"],
      );
      // Log to both stdout (for agent.ts port detection) and the in-memory
      // logger. agent.ts watches stdout for "Listening on http://host:PORT"
      // to detect dynamic port reassignment when the default port is in use.
      console.log(
        `[milady-api] Listening on http://${displayHost}:${actualPort}`,
      );
      logger.info(
        `[milady-api] Listening on http://${displayHost}:${actualPort}`,
      );
      startDeferredStartupWork();
      resolve({
        port: actualPort,
        close: () =>
          new Promise<void>((r) => {
            const closeAllConnections = (
              server as { closeAllConnections?: () => void }
            ).closeAllConnections;
            const closeIdleConnections = (
              server as { closeIdleConnections?: () => void }
            ).closeIdleConnections;

            clearInterval(statusInterval);
            if (state.connectorHealthMonitor) {
              state.connectorHealthMonitor.stop();
              state.connectorHealthMonitor = null;
            }
            if (detachRuntimeStreams) {
              detachRuntimeStreams();
              detachRuntimeStreams = null;
            }
            if (detachTrainingStream) {
              detachTrainingStream();
              detachTrainingStream = null;
            }
            for (const ws of wsClients) {
              if (ws.readyState === 1 || ws.readyState === 0) {
                ws.terminate();
              }
            }
            wsClients.clear();
            // Clean up WhatsApp pairing sessions
            if (state.whatsappPairingSessions) {
              for (const s of state.whatsappPairingSessions.values()) {
                try {
                  s.stop();
                } catch {
                  /* non-fatal */
                }
              }
              state.whatsappPairingSessions.clear();
            }
            // Clean up Signal pairing sessions
            if (state.signalPairingSessions) {
              for (const s of state.signalPairingSessions.values()) {
                try {
                  s.stop();
                } catch {
                  /* non-fatal */
                }
              }
              state.signalPairingSessions.clear();
            }
            wss.close();
            const closeTimeout = setTimeout(() => r(), 5_000);
            const resolved = { done: false };
            const finalize = () => {
              if (!resolved.done) {
                resolved.done = true;
                clearTimeout(closeTimeout);
                r();
              }
            };
            if (typeof closeAllConnections === "function") {
              try {
                closeAllConnections();
              } catch {
                // Bun/Node server internals vary by runtime; non-fatal on shutdown.
              }
            }
            if (typeof closeIdleConnections === "function") {
              try {
                closeIdleConnections();
              } catch {
                // Bun/Node server internals vary by runtime; non-fatal on shutdown.
              }
            }
            server.close(finalize);
          }),
        updateRuntime,
        updateStartup,
      });
    });
  });
}
