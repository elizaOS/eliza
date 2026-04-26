/**
 * REST API server for the Eliza Control UI.
 *
 * Exposes HTTP endpoints that the UI frontend expects, backed by the
 * elizaOS AgentRuntime. Default port: 2138. In dev mode, the Vite UI
 * dev server proxies /api and /ws here (see eliza/packages/app-core/scripts/dev-ui.mjs).
 */

import crypto from "node:crypto";
// dns/promises moved to server-helpers-mcp.ts
import fs from "node:fs";
import http from "node:http";
import { createRequire } from "node:module";

function tokenMatches(expected: string, provided: string): boolean {
  const expectedBuf = Buffer.from(expected);
  const providedBuf = Buffer.from(provided);
  return (
    expectedBuf.length === providedBuf.length &&
    crypto.timingSafeEqual(expectedBuf, providedBuf)
  );
}

const MAX_BODY_BYTES = 1024 * 1024; // 1 MB

import os from "node:os";
import path from "node:path";
// Discord local routes extracted to @elizaos/plugin-discord (setup-routes.ts)
import { DropService } from "@elizaos/app-elizamaker/drop-service";
import { setElizaMakerDropService } from "@elizaos/app-elizamaker/drop-service-registry";
import { handleKnowledgeRoutes } from "@elizaos/app-knowledge";
import {
  normalizeJsonRpcUrl,
  probeJsonRpcEndpoint,
  TxService,
} from "@elizaos/app-steward/api/tx-service";
import {
  ensurePrivyWalletsForCustomUser,
  isPrivyWalletProvisioningEnabled,
} from "@elizaos/app-steward/services/privy-wallets";
import { wireCoordinatorBridgesWhenReady } from "@elizaos/app-task-coordinator/api/coordinator-wiring";
// Phase 2 extraction: LifeOps routes → app-lifeops/src/routes/plugin.ts (lifeopsPlugin)
// import { handleWalletTradeExecuteRoute } from "./wallet-trade-routes.js";
// import {
//   loadWalletTradingProfile,
//   recordWalletTradeLedgerEntry,
//   updateWalletTradeLedgerEntryStatus,
// } from "./wallet-trading-profile.js";
// Phase 2 extraction: Website-blocker routes → app-lifeops/src/routes/plugin.ts (lifeopsPlugin)
import {
  handleTrainingRoutes,
  handleTrajectoryRoute,
} from "@elizaos/app-training";
import {
  type AgentRuntime,
  type IAgentRuntime,
  logger,
  type Route,
  stringToUuid,
  type UUID,
} from "@elizaos/core";
import {
  getStylePresets,
  normalizeCharacterLanguage,
  resolveApiBindHost,
  resolveServerOnlyPort,
  resolveStylePresetByAvatarIndex,
} from "@elizaos/shared";
import { type WebSocket, WebSocketServer } from "ws";
import { getGlobalAwarenessRegistry } from "../awareness/registry.js";
import {
  type ElizaConfig,
  loadElizaConfig,
  saveElizaConfig,
} from "../config/config.js";
import { resolveModelsCacheDir, resolveStateDir } from "../config/paths.js";
import { isStreamingDestinationConfigured } from "../config/plugin-auto-enable.js";
import { CharacterSchema } from "../config/zod-schema.js";
// ONBOARDING_CLOUD_PROVIDER_OPTIONS, ONBOARDING_PROVIDER_CATALOG moved to server-helpers-config.ts
import { createIntegrationTelemetrySpan } from "../diagnostics/integration-observability.js";
import { validateX402Startup } from "../middleware/x402/startup-validator.ts";
import { resolveDefaultAgentWorkspaceDir } from "../providers/workspace.js";
import {
  type AgentEventPayloadLike,
  type AgentEventServiceLike,
  getAgentEventService,
} from "../runtime/agent-event-service.js";
import { classifyRegistryPluginRelease } from "../runtime/release-plugin-policy.js";
import {
  AUDIT_EVENT_TYPES,
  AUDIT_SEVERITIES,
  getAuditFeedSize,
  queryAuditFeed,
  subscribeAuditFeed,
} from "../security/audit-log.js";
import { isLoopbackHost } from "../security/network-policy.js";
import {
  AgentExportError,
  estimateExportSize,
  exportAgent,
  importAgent,
} from "../services/agent-export.js";
import { AppManager } from "../services/app-manager.js";
import { registerClientChatSendHandler } from "../services/client-chat-sender.js";
import { createConfigPluginManager } from "../services/config-plugin-manager.js";
import {
  type CoreManagerLike,
  isCoreManagerLike,
  isPluginManagerLike,
  type PluginManagerLike,
} from "../services/plugin-manager-types.js";
// signal-pairing: SignalPairingSession, sanitizeAccountId, signalLogout extracted to @elizaos/plugin-signal
import { signalAuthExists } from "../services/signal-pairing.js";
import { streamManager } from "../services/stream-manager.js";
import {
  clearTelegramAccountAuthState,
  clearTelegramAccountSession,
  TelegramAccountAuthSession,
  telegramAccountAuthStateExists,
  telegramAccountSessionExists,
} from "../services/telegram-account-auth.js";
import {
  sanitizeAccountId as sanitizeWhatsAppAccountId,
  WhatsAppPairingSession,
  whatsappAuthExists,
  whatsappLogout,
} from "../services/whatsapp-pairing.js";
// Telegram account auth: moved to @elizaos/plugin-telegram (account-setup-routes + account-auth-service).
// WhatsApp pairing: route handlers moved to @elizaos/plugin-whatsapp.
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
} from "../triggers/runtime.js";
import {
  buildTriggerConfig,
  buildTriggerMetadata,
  DISABLED_TRIGGER_INTERVAL_MS,
  normalizeTriggerDraft,
} from "../triggers/scheduling.js";
import { parseClampedInteger } from "../utils/number-parsing.js";
import { handleAgentAdminRoutes } from "./agent-admin-routes.js";
import { handleAgentLifecycleRoutes } from "./agent-lifecycle-routes.js";
import { detectRuntimeModel, resolveProviderFromModel } from "./agent-model.js";
import { handleAgentStatusRoutes } from "./agent-status-routes.js";
import { handleAgentTransferRoutes } from "./agent-transfer-routes.js";
import { handleAppPackageRoutes } from "./app-package-routes.js";
import { handleAppsRoutes } from "./apps-routes.js";
import { handleAuthRoutes } from "./auth-routes.js";
import { handleAvatarRoutes } from "./avatar-routes.js";
import {
  handleBlueBubblesRoute,
  resolveBlueBubblesWebhookPath,
} from "./bluebubbles-routes.js";
import { handleBrowserWorkspaceRoutes } from "./browser-workspace-routes.js";
import { handleBugReportRoutes } from "./bug-report-routes.js";
import { handleCharacterRoutes } from "./character-routes.js";
import {
  handleChatRoutes,
  initSse as initSseFromChatRoutes,
  writeSseJson as writeSseJsonFromChatRoutes,
} from "./chat-routes.js";
import { handleCloudBillingRoute } from "./cloud-billing-routes.js";
import { handleCloudCompatRoute } from "./cloud-compat-routes.js";
import { isCloudProvisionedContainer } from "./cloud-provisioning.js";
import { handleCloudRelayRoute } from "./cloud-relay-routes.js";
import { type CloudRouteState, handleCloudRoute } from "./cloud-routes.js";
import { handleCloudStatusRoutes } from "./cloud-status-routes.js";
import { handleCodingAgentsFallback } from "./coding-agents-fallback-routes.js";
import { handleConfigRoutes } from "./config-routes.js";
import { ConnectorHealthMonitor } from "./connector-health.js";
import { handleConnectorRoutes } from "./connector-routes.js";
import { extractConversationMetadataFromRoom } from "./conversation-metadata.js";
import { handleConversationRoutes } from "./conversation-routes.js";
import { handleCuratedSkillsRoutes } from "./curated-skills-routes.js";
import { handleDatabaseRoute } from "./database.js";
import { handleDiagnosticsRoutes } from "./diagnostics-routes.js";
import { handleExperienceRoutes } from "./experience-routes.js";
import { handleHealthRoutes } from "./health-routes.js";
import {
  readJsonBody as parseJsonBody,
  type ReadJsonBodyOptions,
  readRequestBody,
  sendJson,
  sendJsonError,
} from "./http-helpers.js";
// iMessage routes extracted to @elizaos/plugin-imessage setup-routes.ts (Plugin.routes)
// import { handleIMessageRoute } from "./imessage-routes.js";
import { handleInboxRoute } from "./inbox-routes.js";
import { handleMcpRoutes } from "./mcp-routes.js";
import { pushWithBatchEvict } from "./memory-bounds.js";
import { handleMemoryRoutes } from "./memory-routes.js";
import { handleMiscRoutes } from "./misc-routes.js";
import { handleModelsRoutes } from "./models-routes.js";
import { tryHandleMusicPlayerStatusFallback } from "./music-player-route-fallback.js";
import { handleOnboardingRoutes } from "./onboarding-routes.js";
import type { PTYService } from "./parse-action-block.js";
import { handlePermissionRoutes } from "./permissions-routes.js";
import { handlePermissionsExtraRoutes } from "./permissions-routes-extra.js";
import { handlePluginRoutes } from "./plugin-routes.js";
import { handleProviderSwitchRoutes } from "./provider-switch-routes.js";
import { handleRegistryRoutes } from "./registry-routes.js";
import { RegistryService } from "./registry-service.js";
import { handleRelationshipsRoutes } from "./relationships-routes.js";
import { tryHandleRuntimePluginRoute } from "./runtime-plugin-routes.js";
import { handleSandboxRoute } from "./sandbox-routes.js";
import {
  cloneWithoutBlockedObjectKeys,
  decodePathComponent,
  getErrorMessage,
  hasPersistedOnboardingState,
  isUuidLike,
  patchTouchesProviderSelection,
} from "./server-helpers.js";
// signal-routes: handleSignalRoute dispatch extracted to @elizaos/plugin-signal (setup-routes.ts)
import { applySignalQrOverride } from "./signal-routes.js";
import { discoverSkills } from "./skill-discovery-helpers.js";
import { handleSkillsRoutes } from "./skills-routes.js";
import { handleSubscriptionRoutes } from "./subscription-routes.js";
import { handleTelegramAccountRoute } from "./telegram-account-routes.js";
import { handleTriggerRoutes } from "./trigger-routes.js";
import { handleTtsRoutes } from "./tts-routes.js";
import { handleUpdateRoutes } from "./update-routes.js";
import {
  // Balance/import/generate helpers moved to @elizaos/app-steward plugin routes.
  // generateWalletKeys, setSolanaWalletEnv moved to server-helpers-config.ts
  getWalletAddresses,
  initStewardWalletCache,
} from "./wallet.js";
// Wallet dispatch moved to @elizaos/app-steward plugin routes.
// import { handleWalletBscRoutes } from "./wallet-bsc-routes.js";
import {
  EVM_PLUGIN_PACKAGE,
  resolveWalletAutomationMode as resolveAgentAutomationModeFromConfig,
  resolveWalletCapabilityStatus,
} from "./wallet-capability.js";
import { handleWalletRoutes } from "./wallet-routes.js";
import { resolveWalletRpcReadiness } from "./wallet-rpc.js";
import {
  applyWhatsAppQrOverride,
  handleWhatsAppRoute,
} from "./whatsapp-routes.js";
import { handleWorkbenchRoutes } from "./workbench-routes.js";
import { handleXRelayRoute } from "./x-relay-routes.js";

export {
  executeFallbackParsedActions,
  extractXmlParams,
  type FallbackParsedAction,
  inferBalanceChainFromText,
  isBalanceIntent,
  maybeHandleDirectBinanceSkillRequest,
  parseFallbackActionBlocks,
  shouldForceCheckBalanceFallback,
} from "./binance-skill-helpers.js";

type OnboardingRouteArg = Parameters<typeof handleOnboardingRoutes>[0];
type AgentStatusRouteArg = Parameters<typeof handleAgentStatusRoutes>[0];
type TtsRouteArg = Parameters<typeof handleTtsRoutes>[0];
type PermissionsExtraRouteArg = Parameters<
  typeof handlePermissionsExtraRoutes
>[0];
type ConversationRouteArg = Parameters<typeof handleConversationRoutes>[0];
type ChatRouteArg = Parameters<typeof handleChatRoutes>[0];
type WorkbenchRouteArg = Parameters<typeof handleWorkbenchRoutes>[0];
// LifeOpsRouteArg removed — routes extracted to lifeopsPlugin
type MiscRouteArg = Parameters<typeof handleMiscRoutes>[0];

export {
  isClientVisibleNoResponse,
  isNoResponsePlaceholder,
  stripAssistantStageDirections,
} from "./chat-text-helpers.js";

// Re-export helper functions from server-helpers.ts for backwards compatibility
export {
  buildChatAttachments,
  buildUserMessages,
  buildWalletActionNotExecutedReply,
  cloneWithoutBlockedObjectKeys,
  decodePathComponent,
  findOwnPackageRoot,
  getErrorMessage,
  hasBlockedObjectKeyDeep,
  IMAGE_ONLY_CHAT_FALLBACK_PROMPT,
  isUuidLike,
  isWalletActionRequiredIntent,
  maybeAugmentChatMessageWithKnowledge,
  maybeAugmentChatMessageWithLanguage,
  maybeAugmentChatMessageWithWalletContext,
  normalizeIncomingChatPrompt,
  persistConversationRoomTitle,
  resolveAppUserName,
  resolveConversationGreetingText,
  resolveWalletModeGuidanceReply,
  trimWalletProgressPrefix,
  validateChatImages,
  WALLET_EXECUTION_INTENT_RE,
  WALLET_PROGRESS_ONLY_RE,
} from "./server-helpers.js";

// NOTE: Internal usage of these functions is handled by individual `import`
// statements placed where each function was originally defined (see below).
// The `export { ... } from` above re-exports them for external consumers.

import {
  getInventoryProviderOptions,
  getModelOptions,
  getOrFetchAllProviders,
  getOrFetchProvider,
  paramKeyToCategory,
  providerCachePath,
  readProviderCache,
} from "./model-provider-helpers.js";
import {
  AGENT_EVENT_ALLOWED_STREAMS,
  aggregateSecrets,
  BLOCKED_ENV_KEYS,
  CONFIG_WRITE_ALLOWED_TOP_KEYS,
  discoverInstalledPlugins,
  discoverPluginsFromManifest,
  getReleaseBundledPluginIds,
  maskValue,
  type PluginEntry,
} from "./plugin-discovery-helpers.js";

const _nodeRequire = createRequire(import.meta.url);
// Dynamic import (not require) because the plugin is ESM-only and bun's
// createRequire cannot load ESM packages. Top-level await is settled before
// any consumer reads the binding.
let agentOrchestratorCompat: unknown = null;
try {
  agentOrchestratorCompat = await import("@elizaos/plugin-agent-orchestrator");
} catch {
  agentOrchestratorCompat = null;
}

// Re-export for downstream consumers (e.g. @elizaos/app-core)
export {
  AGENT_EVENT_ALLOWED_STREAMS,
  CONFIG_WRITE_ALLOWED_TOP_KEYS,
  discoverInstalledPlugins,
  discoverPluginsFromManifest,
  findPrimaryEnvKey,
  readBundledPluginPackageMetadata,
} from "./plugin-discovery-helpers.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

// ConnectorRouteHandler imported from server-types.ts
import type { ConnectorRouteHandler } from "./server-types.js";

type OrchestratorFallbackRouteHandler = (
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pathname: string,
  method?: string,
) => Promise<boolean>;

interface OrchestratorPluginFallbackModule {
  createCodingAgentRouteHandler?: (
    runtime: AgentRuntime,
    coordinator?: unknown,
  ) => OrchestratorFallbackRouteHandler;
  getCoordinator?: (runtime: AgentRuntime) => unknown;
}

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
  return wrapPluginManagerWithLocalFallback(service);
}

/**
 * The upstream plugin-plugin-manager has its own registry client that only
 * fetches from GitHub and scans a `plugins/` dir for `elizaos.plugin.json`.
 * Workspace-vendored plugins (under `packages/plugin-*`) are invisible to it.
 * Wrap `installPlugin` so that when the upstream returns "not found in the
 * registry" we retry using our own registry-client (which discovers workspace
 * packages and node_modules symlinks).
 */
function wrapPluginManagerWithLocalFallback(
  pm: PluginManagerLike,
): PluginManagerLike {
  const originalInstall = pm.installPlugin.bind(pm);
  const wrapped: PluginManagerLike = Object.create(pm);

  wrapped.installPlugin = async (pluginName, onProgress) => {
    const result = await originalInstall(pluginName, onProgress);
    if (
      result.success ||
      !result.error?.includes("not found in the registry")
    ) {
      return result;
    }

    // Upstream registry missed it — check Eliza's own local discovery.
    const { getPluginInfo } = await import("../services/registry-client.js");
    const localInfo = await getPluginInfo(pluginName);
    if (!localInfo?.localPath) {
      return result;
    }

    // The plugin is a workspace package — just return success pointing at it.
    // The runtime already resolves it via NODE_PATH / bun workspace links so
    // there is nothing to download; the caller only needs to enable it in
    // config and restart.
    return {
      success: true,
      pluginName: localInfo.name,
      version:
        localInfo.npm.v2Version ?? localInfo.npm.v1Version ?? "workspace",
      installPath: localInfo.localPath,
      requiresRestart: true,
    };
  };

  return wrapped;
}

function getPluginManagerForState(state: ServerState): PluginManagerLike {
  const service = state.runtime?.getService("plugin_manager");
  if (isPluginManagerLike(service)) {
    return service;
  }
  return createConfigPluginManager(() => state.config);
}

function requireCoreManager(runtime: AgentRuntime | null): CoreManagerLike {
  const service = runtime?.getService("core_manager");
  if (!isCoreManagerLike(service)) {
    throw new Error("Core manager service not found");
  }
  return service;
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
      `[eliza-api] Failed to read deleted conversations state: ${err instanceof Error ? err.message : String(err)}`,
    );
    return new Set();
  }
}

function _persistDeletedConversationIdsToState(ids: Set<string>): void {
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

// resolveAppUserName, patchTouchesProviderSelection, resolveConversationGreetingText
// moved to server-helpers.ts; imported in the consolidated import at the top

// AgentStartupDiagnostics, ConversationMeta, ServerState, ShareIngestItem,
// SkillEntry, LogEntry, StreamEventType, StreamEventEnvelope re-exported from
// server-types.ts
export type {
  AgentStartupDiagnostics,
  ConversationMeta,
  LogEntry,
  ServerState,
  ShareIngestItem,
  SkillEntry,
  StreamEventEnvelope,
  StreamEventType,
} from "./server-types.js";

import type {
  AgentStartupDiagnostics,
  ServerState,
  StreamEventEnvelope,
} from "./server-types.js";

// ---------------------------------------------------------------------------
// Package root resolution (for reading bundled plugins.json)
// ---------------------------------------------------------------------------

// findOwnPackageRoot moved to server-helpers.ts; re-exported in the batch above

// Fetch/streaming helpers extracted to server-helpers-fetch.ts
import {
  fetchWithTimeoutGuard as _fetchWithTimeoutGuard,
  streamResponseBodyWithByteLimit as _streamResponseBodyWithByteLimit,
  isAbortError,
  responseContentLength,
} from "./server-helpers-fetch.js";

export {
  fetchWithTimeoutGuard,
  streamResponseBodyWithByteLimit,
} from "./server-helpers-fetch.js";

const fetchWithTimeoutGuard = _fetchWithTimeoutGuard;
const streamResponseBodyWithByteLimit = _streamResponseBodyWithByteLimit;

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

function isModuleResolutionFailure(err: unknown): boolean {
  if (typeof err !== "object" || err === null) {
    return false;
  }
  const code = "code" in err ? (err as NodeJS.ErrnoException).code : undefined;
  if (
    code === "MODULE_NOT_FOUND" ||
    code === "ERR_MODULE_NOT_FOUND" ||
    code === "ERR_PACKAGE_PATH_NOT_EXPORTED"
  ) {
    return true;
  }
  if (!("message" in err) || typeof err.message !== "string") {
    return false;
  }
  return (
    err.message.includes("Cannot find module") ||
    err.message.includes("Cannot find package") ||
    err.message.includes("ERR_MODULE_NOT_FOUND") ||
    err.message.includes('is not defined by "exports"')
  );
}

function isWalletBridgeImportFailure(err: unknown): boolean {
  if (isModuleResolutionFailure(err)) {
    return true;
  }
  if (typeof err !== "object" || err === null) {
    return false;
  }
  const code = "code" in err ? (err as NodeJS.ErrnoException).code : undefined;
  if (code === "ERR_UNKNOWN_FILE_EXTENSION") {
    return true;
  }
  if (!("message" in err) || typeof err.message !== "string") {
    return false;
  }
  return err.message.includes('Unknown file extension ".css"');
}

// ---------------------------------------------------------------------------
// Static UI serving — extracted to static-file-server.ts
// ---------------------------------------------------------------------------
import {
  injectApiBaseIntoHtml,
  isAuthProtectedRoute,
  serveStaticUi,
} from "./static-file-server.js";

export { injectApiBaseIntoHtml };

// Preserved for backward-compat — unused locally after extraction.
const _STATIC_MIME: Record<string, string> = {};

// (static file serving functions moved to static-file-server.ts)

function coerce<T>(value: unknown): T {
  return value as T;
}

// maybeAugmentChatMessageWithLanguage and getErrorMessage moved to server-helpers.ts;
// imported in the consolidated import at the top

// Knowledge + wallet context augmentation moved to server-helpers.ts;
// imported in the consolidated import at the top

// ChatImageAttachment, image validation, chat attachments, normalizeIncomingChatPrompt,
// and buildUserMessages moved to server-helpers.ts; re-exported in the top-level block
// ChatAttachmentWithData re-exported from server-types.ts
export type { ChatAttachmentWithData } from "./server-types.js";

// buildChatAttachments, buildUserMessages, etc. imported in the consolidated import at the top

function parseBoundedLimit(rawLimit: string | null, fallback = 15): number {
  return parseClampedInteger(rawLimit, {
    min: 1,
    max: 50,
    fallback,
  });
}

function sanitizeFavoriteAppList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const apps: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") continue;
    const trimmed = item.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    apps.push(trimmed);
  }
  return apps;
}

function readFavoriteAppsFromConfig(config: ElizaConfig): string[] {
  const ui = (config.ui ?? {}) as Record<string, unknown>;
  return sanitizeFavoriteAppList(ui.favoriteApps);
}

function writeFavoriteAppsToConfig(
  config: ElizaConfig,
  apps: string[],
): string[] {
  const sanitized = sanitizeFavoriteAppList(apps);
  const ui = (config.ui ?? {}) as Record<string, unknown>;
  ui.favoriteApps = sanitized;
  config.ui = ui as ElizaConfig["ui"];
  saveElizaConfig(config);
  return sanitized;
}

// Config redaction, skill validation extracted to server-helpers-config.ts
// isBlockedObjectKey, redactDeep, redactConfigSecrets, isRedactedSecretValue,
// stripRedactedPlaceholderValuesDeep imported from server-helpers-config.ts above.
// isBlockedObjectKey alias for local usage:
const isBlockedObjectKey = isBlockedObjectKeyFromConfig;

// MCP validation helpers extracted to server-helpers-mcp.ts
import {
  resolveMcpServersRejection as _resolveMcpServersRejection,
  resolveMcpTerminalAuthorizationRejection as _resolveMcpTerminalAuthorizationRejection,
} from "./server-helpers-mcp.js";

export {
  resolveMcpServersRejection,
  resolveMcpTerminalAuthorizationRejection,
  validateMcpServerConfig,
} from "./server-helpers-mcp.js";

const resolveMcpServersRejection = _resolveMcpServersRejection;

// ---------------------------------------------------------------------------
// Onboarding / config helpers — extracted to server-helpers-config.ts
// ---------------------------------------------------------------------------

import { pickRandomNames } from "../runtime/onboarding-names.js";

import {
  applyOnboardingVoicePreset,
  ensureWalletKeysInEnvAndConfig,
  getCloudProviderOptions,
  getProviderOptions,
  isBlockedObjectKey as isBlockedObjectKeyFromConfig,
  isRedactedSecretValue,
  isSafeResetStateDir,
  readUiLanguageHeader,
  redactConfigSecrets,
  redactDeep,
  resolveConfiguredCharacterLanguage,
  resolveDefaultAgentName,
  stripRedactedPlaceholderValuesDeep,
} from "./server-helpers-config.js";

export { isSafeResetStateDir } from "./server-helpers-config.js";

// ---------------------------------------------------------------------------
// Trade permission helpers (exported for use by awareness contributors)
// ---------------------------------------------------------------------------

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
 * Maximum number of autonomous agent trades allowed per calendar day.
 * Acts as a safety rail when `agent-auto` mode is enabled.
 */
// Trade safety utilities (defined in trade-safety.ts for testability)
import {
  canUseLocalTradeExecution,
  type TradePermissionMode,
} from "./trade-safety.js";

export {
  AGENT_AUTO_MAX_DAILY_TRADES,
  agentAutoDailyTrades,
  assertQuoteFresh,
  canUseLocalTradeExecution,
  getAgentAutoTradeDate,
  QUOTE_MAX_AGE_MS,
  recordAgentAutoTrade,
  type TradePermissionMode,
} from "./trade-safety.js";

// ---------------------------------------------------------------------------
// Automation & agent permission helpers
// ---------------------------------------------------------------------------

import type { AgentAutomationMode } from "./server-types.js";

const AGENT_AUTOMATION_HEADER = "x-eliza-agent-action";
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

function _isAgentAutomationRequest(req: http.IncomingMessage): boolean {
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

function buildPluginEvmDiagnosticEntry(
  state: Pick<ServerState, "config" | "runtime">,
): PluginEntry {
  const capability = resolveWalletCapabilityStatus(state);
  const enabled =
    capability.pluginEvmLoaded ||
    capability.pluginEvmRequired ||
    (state.config.plugins?.allow ?? []).some((entry) => {
      return entry === EVM_PLUGIN_PACKAGE || entry === "evm";
    });

  const capabilityStatus = capability.pluginEvmLoaded
    ? capability.pluginEvmRequired
      ? "loaded"
      : "auto-enabled"
    : enabled
      ? capability.evmAddress || capability.localSignerAvailable
        ? "blocked"
        : "missing-prerequisites"
      : "disabled";

  return {
    id: "evm",
    name: "Plugin EVM",
    description:
      "EVM wallet runtime for balance, transfer, and trade actions. Required for wallet execution in chat.",
    tags: ["wallet", "evm", "bsc", "onchain"],
    enabled,
    configured: capability.pluginEvmRequired,
    envKey: "EVM_PRIVATE_KEY",
    category: "feature",
    source: "bundled",
    configKeys: [
      "EVM_PRIVATE_KEY",
      "BSC_RPC_URL",
      "BSC_TESTNET_RPC_URL",
      "ELIZA_WALLET_NETWORK",
    ],
    parameters: [],
    validationErrors: [],
    validationWarnings: [],
    npmName: EVM_PLUGIN_PACKAGE,
    isActive: capability.pluginEvmLoaded,
    autoEnabled: capability.pluginEvmRequired && !capability.pluginEvmLoaded,
    managementMode: "core-optional",
    capabilityStatus,
    capabilityReason: capability.executionReady
      ? "Wallet execution is ready."
      : capability.executionBlockedReason,
    prerequisites: [
      { label: "wallet present", met: Boolean(capability.evmAddress) },
      { label: "rpc ready", met: capability.rpcReady },
      { label: "plugin loaded", met: capability.pluginEvmLoaded },
    ],
  };
}

// Wallet intent/export helpers extracted to server-helpers-wallet.ts
import { resolveWalletExportRejection as _resolveWalletExportRejection } from "./server-helpers-wallet.js";

export {
  hasUsableWalletFallbackParams,
  inferWalletExecutionFallback,
  resolveWalletExportRejection,
  type WalletExportRejection,
} from "./server-helpers-wallet.js";

const resolveWalletExportRejection = _resolveWalletExportRejection;

// Plugin config helpers extracted to server-helpers-plugin.ts
import { resolvePluginConfigMutationRejections as _resolvePluginConfigMutationRejections } from "./server-helpers-plugin.js";

export {
  type PluginConfigMutationRejection,
  resolvePluginConfigMutationRejections,
  resolvePluginConfigReply,
} from "./server-helpers-plugin.js";

const resolvePluginConfigMutationRejections =
  _resolvePluginConfigMutationRejections;

// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------

interface RequestContext {
  onRestart: (() => Promise<AgentRuntime | null>) | null;
  onRuntimeSwapped?: () => void;
}

import type { TrainingServiceWithRuntime } from "./server-types.js";

type TrainingServiceCtor = new (options: {
  getRuntime: () => AgentRuntime | null;
  getConfig: () => ElizaConfig;
  setConfig: (nextConfig: ElizaConfig) => void;
}) => TrainingServiceWithRuntime;

async function resolveTrainingServiceCtor(): Promise<TrainingServiceCtor | null> {
  const candidates = [
    "../services/training-service",
    "@elizaos/app-training",
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

// mcpServersIncludeStdio, resolveMcpTerminalAuthorizationRejection extracted to server-helpers-mcp.ts
const resolveMcpTerminalAuthorizationRejection =
  _resolveMcpTerminalAuthorizationRejection;

// Auth, CORS, pairing, terminal, WebSocket auth helpers extracted to server-helpers-auth.ts
import {
  applyCors as _applyCors,
  clearPairing as _clearPairing,
  ensureApiTokenForBindHost as _ensureApiTokenForBindHost,
  ensurePairingCode as _ensurePairingCode,
  getConfiguredApiToken as _getConfiguredApiToken,
  getPairingExpiresAt as _getPairingExpiresAt,
  isAllowedHost as _isAllowedHost,
  isAuthorized as _isAuthorized,
  isSharedTerminalClientId as _isSharedTerminalClientId,
  isWebSocketAuthorized as _isWebSocketAuthorized,
  normalizePairingCode as _normalizePairingCode,
  normalizeWsClientId as _normalizeWsClientId,
  pairingEnabled as _pairingEnabled,
  rateLimitPairing as _rateLimitPairing,
  rejectWebSocketUpgrade as _rejectWebSocketUpgrade,
  resolveTerminalRunClientId as _resolveTerminalRunClientId,
  resolveTerminalRunRejection as _resolveTerminalRunRejection,
  resolveWebSocketUpgradeRejection as _resolveWebSocketUpgradeRejection,
} from "./server-helpers-auth.js";

export {
  ensureApiTokenForBindHost,
  extractAuthToken,
  isAllowedHost,
  isAuthorized,
  normalizeWsClientId,
  resolveCorsOrigin,
  resolveTerminalRunClientId,
  resolveTerminalRunRejection,
  resolveWebSocketUpgradeRejection,
  type TerminalRunRejection,
  type WebSocketUpgradeRejection,
} from "./server-helpers-auth.js";

const isAllowedHost = _isAllowedHost;
const applyCors = _applyCors;
const isAuthorized = _isAuthorized;
const ensureApiTokenForBindHost = _ensureApiTokenForBindHost;
const normalizeWsClientId = _normalizeWsClientId;
const resolveTerminalRunClientId = _resolveTerminalRunClientId;
const isSharedTerminalClientId = _isSharedTerminalClientId;
const resolveTerminalRunRejection = _resolveTerminalRunRejection;
const resolveWebSocketUpgradeRejection = _resolveWebSocketUpgradeRejection;
const rejectWebSocketUpgrade = _rejectWebSocketUpgrade;
const isWebSocketAuthorized = _isWebSocketAuthorized;
const getConfiguredApiToken = _getConfiguredApiToken;
const pairingEnabled = _pairingEnabled;

function isLifeOpsCloudPluginRoute(pathname: string): boolean {
  return (
    pathname === "/api/cloud/features" ||
    pathname === "/api/cloud/features/sync" ||
    pathname.startsWith("/api/cloud/travel-providers/")
  );
}
const ensurePairingCode = _ensurePairingCode;
const normalizePairingCode = _normalizePairingCode;
const rateLimitPairing = _rateLimitPairing;
const getPairingExpiresAt = _getPairingExpiresAt;
const clearPairing = _clearPairing;

/** Guard against concurrent provider switch requests (P0 §3). */
let providerSwitchInProgress = false;

// PluginConfigMutationRejection, resolvePluginConfigMutationRejections,
// WalletExportRejection, resolveWalletExportRejection
// extracted to server-helpers-plugin.ts and server-helpers-wallet.ts respectively.
// Re-exported above.

// Terminal/WS/state-dir helpers extracted to server-helpers-auth.ts; re-exported above.

// decodePathComponent imported in the consolidated import at the top

// Workbench task/todo helpers — extracted to workbench-helpers.ts
import {
  asObject,
  normalizeTags,
  parseNullableNumber,
  readTaskCompleted,
  readTaskMetadata,
  toWorkbenchTask,
  toWorkbenchTodo,
  WORKBENCH_TASK_TAG,
  WORKBENCH_TODO_TAG,
} from "./workbench-helpers.js";

const _WORKBENCH_TASK_TAG = WORKBENCH_TASK_TAG;
const _WORKBENCH_TODO_TAG = WORKBENCH_TODO_TAG;

// (workbench helpers moved to workbench-helpers.ts)

// ── Autonomy / swarm / coding-agent helpers — extracted to server-helpers-swarm.ts ──
import {
  getCoordinatorFromRuntime,
  getPtyConsoleBridge,
  routeAutonomyTextToUser,
  wireCodingAgentBridgesNow,
  wireCodingAgentChatBridge,
  wireCodingAgentSwarmSynthesis,
  wireCodingAgentWsBridge,
  wireCoordinatorEventRouting,
} from "./server-helpers-swarm.js";

export {
  handleSwarmSynthesis,
  routeAutonomyTextToUser,
} from "./server-helpers-swarm.js";

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

  const explicitSource =
    typeof payload?.source === "string" ? payload.source : null;
  const hasExplicitSource =
    explicitSource !== null && explicitSource.trim().length > 0;
  const source = hasExplicitSource ? explicitSource.trim() : "autonomy";

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
  const isHealthEndpoint = method === "GET" && pathname === "/api/health";
  const isCloudProvisioned = isCloudProvisionedContainer();
  const isCloudOnboardingStatusEndpoint =
    method === "GET" &&
    pathname === "/api/onboarding/status" &&
    isCloudProvisioned;
  const isWhatsAppWebhookEndpoint = pathname === "/api/whatsapp/webhook";
  const isBlueBubblesWebhookEndpoint =
    pathname ===
    resolveBlueBubblesWebhookPath({
      runtime: state.runtime
        ? {
            getService: (type: string) =>
              (
                state.runtime as { getService: (t: string) => unknown }
              ).getService(type),
          }
        : undefined,
    });
  const isAuthProtectedPath = isAuthProtectedRoute(pathname);
  const _registryService = state.registryService;

  const canonicalizeRestartReason = (reason: string): string => {
    if (
      reason === "primary-changed" ||
      reason === "cloud-refreshed" ||
      reason === "Wallet configuration updated"
    ) {
      return "Wallet configuration updated";
    }
    return reason;
  };

  const scheduleRuntimeRestart = (reason: string): void => {
    const canonicalReason = canonicalizeRestartReason(reason);
    if (state.pendingRestartReasons.length >= 50) {
      // Prevent unbounded growth — keep only first entry + latest
      state.pendingRestartReasons.splice(
        1,
        state.pendingRestartReasons.length - 1,
      );
    }
    if (!state.pendingRestartReasons.includes(canonicalReason)) {
      state.pendingRestartReasons.push(canonicalReason);
    }
    logger.info(
      `[eliza-api] Restart required: ${canonicalReason} (${state.pendingRestartReasons.length} pending)`,
    );
    state.broadcastWs?.({
      type: "restart-required",
      reasons: [...state.pendingRestartReasons],
    });
  };

  const restartRuntime = async (reason: string): Promise<boolean> => {
    if (!ctx?.onRestart) {
      return false;
    }
    if (state.agentState === "restarting") {
      return false;
    }

    const previousState = state.agentState;
    logger.info(`[eliza-api] Applying runtime reload: ${reason}`);
    state.agentState = "restarting";
    state.startup = { ...state.startup, phase: "restarting" };
    state.broadcastStatus?.();

    try {
      const newRuntime = await ctx.onRestart();
      if (!newRuntime) {
        state.agentState = previousState;
        state.broadcastStatus?.();
        return false;
      }

      state.runtime = newRuntime;
      state.chatConnectionReady = null;
      state.chatConnectionPromise = null;
      state.agentState = "running";
      state.agentName =
        newRuntime.character.name ?? resolveDefaultAgentName(state.config);
      state.model = detectRuntimeModel(newRuntime, state.config);
      state.startedAt = Date.now();
      state.pendingRestartReasons = [];
      ctx.onRuntimeSwapped?.();
      state.broadcastStatus?.();
      return true;
    } catch (err) {
      logger.warn(
        `[eliza-api] Runtime reload failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      state.agentState = previousState;
      state.broadcastStatus?.();
      return false;
    }
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
        hint: `To allow this host, set ELIZA_ALLOWED_HOSTS=${incomingHost} (or ELIZA_ALLOWED_HOSTS) in your environment, or access via http://localhost`,
        docs: "https://docs.eliza.ai/configuration#allowed-hosts",
      },
      403,
    );
    return;
  }

  if (!applyCors(req, res, pathname)) {
    json(res, { error: "Origin not allowed" }, 403);
    return;
  }

  // Serve dashboard static assets before the auth gates. serveStaticUi already
  // refuses /api/, /v1/, and /ws paths, so API endpoints remain protected
  // while steward-managed containers can still reach the built-in dashboard.
  if (method === "GET" || method === "HEAD") {
    if (serveStaticUi(req, res, pathname)) return;
  }

  // Single auth gate. The previous two-block arrangement (a cloud-provisioned
  // copy followed by an unconditional copy) was redundant: the unconditional
  // block already applied to cloud-provisioned requests because
  // `isAuthorized` consults `isCloudProvisionedContainer()` when no token is
  // configured.
  if (
    method !== "OPTIONS" &&
    isAuthProtectedPath &&
    !isAuthEndpoint &&
    !isHealthEndpoint &&
    !isCloudOnboardingStatusEndpoint &&
    !isWhatsAppWebhookEndpoint &&
    !isBlueBubblesWebhookEndpoint &&
    !pathname.startsWith("/api/browser-bridge/companions/") &&
    !isAuthorized(req)
  ) {
    json(res, { error: "Unauthorized" }, 401);
    return;
  }

  // CORS preflight
  if (method === "OPTIONS") {
    res.statusCode = 204;
    res.end();
    return;
  }

  // ── Provider inference helpers ────────────────────────────────────────
  const _disableCloudInference = (): void => {
    delete process.env.ANTHROPIC_BASE_URL;
    delete process.env.OPENAI_BASE_URL;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENAI_API_KEY;
  };

  const _enableCloudInference = (
    cloudApiKey: string,
    baseUrl: string,
  ): void => {
    // Configure coding agent CLIs to proxy through ElizaCloud /api/v1
    process.env.ANTHROPIC_BASE_URL = `${baseUrl}/api/v1`;
    process.env.ANTHROPIC_API_KEY = cloudApiKey;
    process.env.OPENAI_BASE_URL = `${baseUrl}/api/v1`;
    process.env.OPENAI_API_KEY = cloudApiKey;
    // Gemini CLI and Aider — no proxy support via ElizaCloud inference
  };

  // ── POST /api/provider/switch (extracted to provider-switch-routes.ts) ──
  if (
    await handleProviderSwitchRoutes({
      req,
      res,
      method,
      pathname,
      state,
      json,
      error,
      readJsonBody,
      saveElizaConfig,
      scheduleRuntimeRestart,
      providerSwitchInProgress,
      setProviderSwitchInProgress: (v: boolean) => {
        providerSwitchInProgress = v;
      },
      restartRuntime,
    })
  ) {
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
      getPairingExpiresAt,
      clearPairing,
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
        (await import("../auth/index.js")) as never,
    } as never)
  ) {
    return;
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Health / status / runtime routes (extracted to health-routes.ts)
  // ═══════════════════════════════════════════════════════════════════════
  if (
    await handleHealthRoutes({
      req,
      res,
      method,
      pathname,
      url,
      state,
      json,
      error,
    })
  ) {
    return;
  }

  // ── Onboarding GET routes (extracted to onboarding-routes.ts) ─────────
  if (
    await handleOnboardingRoutes({
      req,
      res,
      method,
      pathname,
      url,
      state: coerce<OnboardingRouteArg["state"]>(state),
      json,
      error,
      readJsonBody,
      isCloudProvisionedContainer,
      hasPersistedOnboardingState,
      ensureWalletKeysInEnvAndConfig,
      getWalletAddresses:
        coerce<OnboardingRouteArg["getWalletAddresses"]>(getWalletAddresses),
      pickRandomNames,
      getStylePresets:
        coerce<OnboardingRouteArg["getStylePresets"]>(getStylePresets),
      getProviderOptions:
        coerce<OnboardingRouteArg["getProviderOptions"]>(getProviderOptions),
      getCloudProviderOptions: coerce<
        OnboardingRouteArg["getCloudProviderOptions"]
      >(getCloudProviderOptions),
      getModelOptions:
        coerce<OnboardingRouteArg["getModelOptions"]>(getModelOptions),
      getInventoryProviderOptions: coerce<
        OnboardingRouteArg["getInventoryProviderOptions"]
      >(getInventoryProviderOptions),
      resolveConfiguredCharacterLanguage: coerce<
        OnboardingRouteArg["resolveConfiguredCharacterLanguage"]
      >(resolveConfiguredCharacterLanguage),
      normalizeCharacterLanguage: coerce<
        OnboardingRouteArg["normalizeCharacterLanguage"]
      >(normalizeCharacterLanguage),
      readUiLanguageHeader:
        coerce<OnboardingRouteArg["readUiLanguageHeader"]>(
          readUiLanguageHeader,
        ),
      applyOnboardingVoicePreset: coerce<
        OnboardingRouteArg["applyOnboardingVoicePreset"]
      >(applyOnboardingVoicePreset),
      saveElizaConfig,
    })
  ) {
    return;
  }

  // POST /api/onboarding is now handled by onboarding-routes.ts above.

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
    executeTriggerTask,
    getTriggerHealthSnapshot,
    getTriggerLimit,
    listTriggerTasks,
    readTriggerConfig,
    readTriggerRuns,
    taskToTriggerSummary,
    triggersFeatureEnabled,
    buildTriggerConfig,
    buildTriggerMetadata,
    normalizeTriggerDraft,
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

  if (
    pathname.startsWith("/api/memory") ||
    pathname.startsWith("/api/memories") ||
    pathname === "/api/context/quick"
  ) {
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
    await handleExperienceRoutes({
      req,
      res,
      method,
      pathname,
      runtime: state.runtime,
      url,
      readJsonBody,
      json,
      error,
    })
  ) {
    return;
  }

  // Compatibility route used by legacy health probes and desktop name lookup.
  if (method === "GET" && pathname === "/api/agents") {
    const runtimeAgentId =
      typeof state.runtime?.agentId === "string" &&
      state.runtime.agentId.trim().length > 0
        ? state.runtime.agentId.trim()
        : null;
    const configuredAgentId =
      typeof state.config.agents?.list?.[0]?.id === "string" &&
      state.config.agents.list[0].id.trim().length > 0
        ? state.config.agents.list[0].id.trim()
        : null;
    const agentName =
      state.runtime?.character.name?.trim() ||
      state.agentName?.trim() ||
      "Eliza";

    json(res, {
      agents: [
        {
          id:
            runtimeAgentId ??
            configuredAgentId ??
            "00000000-0000-0000-0000-000000000000",
          name: agentName,
          status: state.agentState,
        },
      ],
    });
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

  // ── NFA routes (/api/nfa/*) ─────────────────────────────────────────
  // Extracted — will move to @elizaos/plugin-bnb-identity (Plugin.routes)
  // when the plugin directory is created. Until then, NFA routes are
  // served inline from nfa-routes.ts if needed, or disabled.

  if (
    await handleRegistryRoutes({
      req,
      res,
      method,
      pathname,
      url,
      json,
      error,
      getPluginManager: () => getPluginManagerForState(state) as never,
      getLoadedPluginNames: () =>
        state.runtime?.plugins.map((plugin) => plugin.name) ?? [],
      getBundledPluginIds: () => getReleaseBundledPluginIds(),
      classifyRegistryPluginRelease,
    })
  ) {
    return;
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Plugin routes (extracted to plugin-routes.ts)
  // ═══════════════════════════════════════════════════════════════════════
  if (
    pathname === "/api/plugins" ||
    pathname.startsWith("/api/plugins/") ||
    pathname === "/api/secrets" ||
    pathname === "/api/core/status"
  ) {
    if (
      await handlePluginRoutes({
        req,
        res,
        method,
        pathname,
        url,
        state,
        json,
        error,
        readJsonBody,
        scheduleRuntimeRestart,
        restartRuntime,
        BLOCKED_ENV_KEYS,
        discoverInstalledPlugins,
        maskValue,
        aggregateSecrets,
        readProviderCache,
        paramKeyToCategory,
        buildPluginEvmDiagnosticEntry,
        EVM_PLUGIN_PACKAGE,
        applyWhatsAppQrOverride,
        applySignalQrOverride,
        signalAuthExists,
        resolvePluginConfigMutationRejections,
        requirePluginManager,
        requireCoreManager,
      })
    ) {
      return;
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Skills routes (extracted to skills-routes.ts)
  // Curated-skills routes live at /api/skills/curated/* and must be dispatched
  // before the generic skills routes (which reject "/" in skill IDs).
  // ═══════════════════════════════════════════════════════════════════════
  if (pathname.startsWith("/api/skills/curated")) {
    if (
      await handleCuratedSkillsRoutes({
        req,
        res,
        method,
        pathname,
        url,
        json,
        error,
        readJsonBody,
      })
    ) {
      return;
    }
  }
  if (pathname.startsWith("/api/skills")) {
    if (
      await handleSkillsRoutes({
        req,
        res,
        method,
        pathname,
        url,
        state,
        json,
        error,
        readJsonBody,
        readBody,
        discoverSkills,
        saveElizaConfig,
      })
    ) {
      return;
    }
  }

  if (
    await handleDiagnosticsRoutes({
      req,
      res,
      method,
      pathname,
      url,
      logBuffer: state.logBuffer,
      clearLogBuffer: () => {
        const previous = state.logBuffer.length;
        state.logBuffer.length = 0;
        return previous;
      },
      readJsonBody,
      error,
      eventBuffer: state.eventBuffer,
      initSse: initSseFromChatRoutes,
      writeSseJson: writeSseJsonFromChatRoutes,
      json,
      auditEventTypes: AUDIT_EVENT_TYPES,
      auditSeverities: AUDIT_SEVERITIES,
      getAuditFeedSize,
      queryAuditFeed: (query) =>
        queryAuditFeed({
          type: (AUDIT_EVENT_TYPES as readonly string[]).includes(
            query.type ?? "",
          )
            ? (query.type as (typeof AUDIT_EVENT_TYPES)[number])
            : undefined,
          severity: (AUDIT_SEVERITIES as readonly string[]).includes(
            query.severity ?? "",
          )
            ? (query.severity as (typeof AUDIT_SEVERITIES)[number])
            : undefined,
          sinceMs: query.sinceMs,
          limit: query.limit,
        }).map((entry) => ({
          timestamp: entry.timestamp,
          type: entry.type,
          summary: entry.summary,
          severity: entry.severity,
          metadata: entry.metadata,
        })),
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
  // Wallet core routes (addresses, balances, generate, config, export)
  // Canonical implementation lives in @elizaos/app-steward; wired here
  // so the API server exposes them without requiring plugin registration.
  // ═══════════════════════════════════════════════════════════════════════
  if (pathname.startsWith("/api/wallet/")) {
    let stewardWalletCoreRoutes:
      | ((
          req: http.IncomingMessage,
          res: http.ServerResponse,
          state: unknown,
        ) => Promise<boolean>)
      | null = null;
    try {
      const { handleWalletCoreRoutes } = await import(
        "@elizaos/app-steward/routes/wallet-core-routes"
      );
      stewardWalletCoreRoutes = handleWalletCoreRoutes;
    } catch (err) {
      if (isWalletBridgeImportFailure(err)) {
        logger.debug(
          { err },
          "[eliza-api] Wallet core routes unavailable from @elizaos/app-steward; falling back to local bridge",
        );
      } else {
        logger.error({ err }, "[eliza-api] Wallet core route bridge failed");
        error(res, getErrorMessage(err), 500);
        return;
      }
    }
    if (stewardWalletCoreRoutes) {
      try {
        if (
          await stewardWalletCoreRoutes(req, res, {
            runtime: state.runtime ?? null,
            restartRuntime,
            scheduleRuntimeRestart,
          })
        ) {
          return;
        }
      } catch (err) {
        logger.error({ err }, "[eliza-api] Wallet core route bridge failed");
        error(res, getErrorMessage(err), 500);
        return;
      }
    }
    if (
      await handleWalletRoutes({
        req,
        res,
        method,
        pathname,
        config: loadElizaConfig(),
        saveConfig: saveElizaConfig,
        ensureWalletKeysInEnvAndConfig,
        resolveWalletExportRejection,
        restartRuntime,
        scheduleRuntimeRestart,
        readJsonBody,
        json,
        error,
        runtime: state.runtime ?? null,
      })
    ) {
      return;
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  //  ERC-8004 Registry, Agent self-status, Privy — delegated to agent-status-routes.ts
  // ═══════════════════════════════════════════════════════════════════════
  if (
    await handleAgentStatusRoutes({
      req,
      res,
      method,
      pathname,
      url,
      state: coerce<AgentStatusRouteArg["state"]>(state),
      json,
      error,
      readJsonBody,
      deps: {
        getWalletAddresses,
        resolveWalletCapabilityStatus: coerce<
          AgentStatusRouteArg["deps"]["resolveWalletCapabilityStatus"]
        >(resolveWalletCapabilityStatus),
        resolveWalletRpcReadiness: coerce<
          AgentStatusRouteArg["deps"]["resolveWalletRpcReadiness"]
        >(resolveWalletRpcReadiness),
        resolveTradePermissionMode,
        canUseLocalTradeExecution: coerce<
          AgentStatusRouteArg["deps"]["canUseLocalTradeExecution"]
        >(canUseLocalTradeExecution),
        detectRuntimeModel:
          coerce<AgentStatusRouteArg["deps"]["detectRuntimeModel"]>(
            detectRuntimeModel,
          ),
        resolveProviderFromModel,
        getGlobalAwarenessRegistry: coerce<
          AgentStatusRouteArg["deps"]["getGlobalAwarenessRegistry"]
        >(getGlobalAwarenessRegistry),
        isPrivyWalletProvisioningEnabled,
        ensurePrivyWalletsForCustomUser: coerce<
          AgentStatusRouteArg["deps"]["ensurePrivyWalletsForCustomUser"]
        >(ensurePrivyWalletsForCustomUser),
        RegistryService,
      },
    })
  ) {
    return;
  }

  // ── Update routes (extracted to update-routes.ts) ─────────────────────
  if (
    await handleUpdateRoutes({
      req,
      res,
      method,
      pathname,
      url,
      state,
      json,
      error,
      readJsonBody,
      saveElizaConfig,
    })
  ) {
    return;
  }

  // ── Connector routes (extracted to connector-routes.ts) ──────────────
  if (
    await handleConnectorRoutes({
      req,
      res,
      method,
      pathname,
      state,
      json,
      error,
      readJsonBody,
      saveElizaConfig,
      redactConfigSecrets,
      isBlockedObjectKey,
      cloneWithoutBlockedObjectKeys,
    })
  ) {
    return;
  }

  // ── WhatsApp routes (/api/whatsapp/*) ────────────────────────────────────
  // Moved to @elizaos/plugin-whatsapp setup-routes.ts (registered via Plugin.routes).

  // ── Inbox routes (/api/inbox/*) ───────────────────────────────
  // Cross-channel read-only feed that merges connector messages
  // (imessage, telegram, discord, whatsapp, etc.) into a single
  // time-ordered view. See api/inbox-routes.ts for details.
  const blueBubblesHandled = await handleBlueBubblesRoute(
    req,
    res,
    pathname,
    method,
    {
      runtime: state.runtime
        ? {
            getService: (type: string) =>
              (
                state.runtime as { getService: (t: string) => unknown }
              ).getService(type),
          }
        : undefined,
    },
    { json, error, readJsonBody },
  );
  if (blueBubblesHandled) return;

  if (pathname.startsWith("/api/inbox")) {
    const handled = await handleInboxRoute(
      req,
      res,
      pathname,
      method,
      { runtime: state.runtime ?? null },
      { json, error, readJsonBody },
    );
    if (handled) return;
  }

  // ── iMessage routes (/api/imessage/*) ─────────────────────────────────
  // Extracted to @elizaos/plugin-imessage setup-routes.ts (Plugin.routes).
  // The plugin registers rawPath routes that serve the same legacy paths.

  // ── Cloud relay status (/api/cloud/relay-status) ──────────────────────
  if (pathname === "/api/cloud/relay-status") {
    const handled = await handleCloudRelayRoute(
      req,
      res,
      pathname,
      method,
      {
        runtime: state.runtime
          ? {
              getService: (type: string) =>
                (
                  state.runtime as { getService: (t: string) => unknown }
                ).getService(type),
            }
          : undefined,
      },
      { json, error, readJsonBody },
    );
    if (handled) return;
  }

  // Telegram setup routes: now handled by @elizaos/plugin-telegram via
  // runtime plugin routes (rawPath: true). See plugin-telegram/src/setup-routes.ts.

  // ── Telegram account routes (/api/telegram-account/*) ────────────────
  if (pathname.startsWith("/api/telegram-account")) {
    const routeState = {
      config: state.config,
      saveConfig: () => saveElizaConfig(state.config),
      runtime: state.runtime
        ? {
            getService: (type: string) =>
              (
                state.runtime as { getService: (t: string) => unknown }
              ).getService(type),
            getSetting: (key: string) =>
              (
                state.runtime as {
                  getSetting: (k: string) => string | undefined;
                }
              ).getSetting(key),
          }
        : undefined,
      telegramAccountAuthSession: state.telegramAccountAuthSession,
    };
    const handled = await handleTelegramAccountRoute(
      req,
      res,
      pathname,
      method,
      routeState,
      { json, error, readJsonBody },
      {
        createAuthSession: (options) => new TelegramAccountAuthSession(options),
        authStateExists: telegramAccountAuthStateExists,
        sessionExists: telegramAccountSessionExists,
        clearAuthState: clearTelegramAccountAuthState,
        clearSession: clearTelegramAccountSession,
      },
    );
    state.telegramAccountAuthSession =
      routeState.telegramAccountAuthSession ?? null;
    if (handled) return;
  }

  // ── Discord Local routes (/api/discord-local/*) — extracted to @elizaos/plugin-discord (setup-routes.ts) ──

  // ── Signal routes (/api/signal/*) — extracted to @elizaos/plugin-signal (setup-routes.ts) ──

  // ── Restart ──────────────────────────────────────────────────────────
  if (method === "POST" && pathname === "/api/restart") {
    state.agentState = "restarting";
    state.startup = { ...state.startup, phase: "restarting" };
    state.broadcastStatus?.();
    json(res, { ok: true, message: "Restarting...", restarting: true });
    setTimeout(() => process.exit(0), 1000);
    return;
  }

  // ── TTS routes (extracted to tts-routes.ts) ──────────────────────────
  if (
    await handleTtsRoutes({
      req,
      res,
      method,
      pathname,
      state,
      json,
      error,
      readJsonBody,
      isRedactedSecretValue,
      fetchWithTimeoutGuard,
      streamResponseBodyWithByteLimit: coerce<
        TtsRouteArg["streamResponseBodyWithByteLimit"]
      >(streamResponseBodyWithByteLimit),
      responseContentLength,
      isAbortError,
      ELEVENLABS_FETCH_TIMEOUT_MS: 30_000,
      ELEVENLABS_AUDIO_MAX_BYTES: 20 * 1_048_576,
    })
  ) {
    return;
  }

  // ── Avatar routes (extracted to avatar-routes.ts) ───────────────────
  if (
    await handleAvatarRoutes({
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

  // ═══════════════════════════════════════════════════════════════════════
  // Config routes (extracted to config-routes.ts)
  // ═══════════════════════════════════════════════════════════════════════
  if (
    pathname === "/api/config" ||
    pathname === "/api/config/schema" ||
    pathname === "/api/config/reload"
  ) {
    if (
      await handleConfigRoutes({
        req,
        res,
        method,
        pathname,
        url,
        config: state.config,
        runtime: state.runtime,
        json,
        error,
        readJsonBody,
        redactConfigSecrets,
        isBlockedObjectKey,
        stripRedactedPlaceholderValuesDeep,
        patchTouchesProviderSelection,
        BLOCKED_ENV_KEYS,
        CONFIG_WRITE_ALLOWED_TOP_KEYS,
        resolveMcpServersRejection,
        resolveMcpTerminalAuthorizationRejection,
      })
    ) {
      return;
    }
  }

  // ── Permissions extra routes (extracted to permissions-routes-extra.ts) ──
  if (
    await handlePermissionsExtraRoutes({
      req,
      res,
      method,
      pathname,
      state: coerce<PermissionsExtraRouteArg["state"]>(state),
      json,
      error,
      readJsonBody,
      saveElizaConfig,
      resolveTradePermissionMode: coerce<
        PermissionsExtraRouteArg["resolveTradePermissionMode"]
      >(resolveTradePermissionMode),
      canUseLocalTradeExecution: coerce<
        PermissionsExtraRouteArg["canUseLocalTradeExecution"]
      >(canUseLocalTradeExecution),
      parseAgentAutomationMode,
      persistAgentAutomationMode: coerce<
        PermissionsExtraRouteArg["persistAgentAutomationMode"]
      >(persistAgentAutomationMode),
    })
  ) {
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
      saveConfig: (config) => {
        saveElizaConfig(config as ElizaConfig);
      },
      scheduleRuntimeRestart,
    })
  ) {
    return;
  }

  if (
    await handleRelationshipsRoutes({
      req,
      res,
      method,
      pathname,
      runtime: state.runtime ?? undefined,
      readJsonBody,
      json,
      error,
    })
  ) {
    return;
  }

  if (
    await handleBrowserWorkspaceRoutes({
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

  // Agent self-status, Privy, and ERC-8004 registry routes are now handled
  // by handleAgentStatusRoutes above.

  // ═══════════════════════════════════════════════════════════════════════
  // Subscription status route
  // ═══════════════════════════════════════════════════════════════════════

  // ── GET /api/subscription/status (direct handler fallback) ─────────────
  // Note: subscription-routes.ts handles /api/subscription/* but this is
  // kept here in case the prefix routing is not active.
  // (handleSubscriptionRoutes already covers this, so no duplicate needed.)

  // ═══════════════════════════════════════════════════════════════════════
  // BSC trade routes and wallet trade execute — now handled by
  // @elizaos/app-steward plugin routes. See apps/app-steward/src/plugin.ts.
  // ═══════════════════════════════════════════════════════════════════════

  if (
    isLifeOpsCloudPluginRoute(pathname) &&
    (await tryHandleRuntimePluginRoute({
      req,
      res,
      method,
      pathname,
      url,
      runtime: state.runtime,
      isAuthorized: () => isAuthorized(req),
    }))
  ) {
    return;
  }

  // ── Cloud routes (/api/cloud/*) ─────────────────────────────────────────
  if (pathname.startsWith("/api/cloud/")) {
    const xRelayHandled = await handleXRelayRoute(req, res, pathname, method, {
      config: state.config,
      runtime: state.runtime,
    });
    if (xRelayHandled) return;

    const billingHandled = await handleCloudBillingRoute(
      req,
      res,
      pathname,
      method,
      { config: state.config, runtime: state.runtime },
    );
    if (billingHandled) return;

    // Compat proxy routes — transparent proxy to Eliza Cloud v2 /api/compat/*
    const compatHandled = await handleCloudCompatRoute(
      req,
      res,
      pathname,
      method,
      { config: state.config, runtime: state.runtime },
    );
    if (compatHandled) return;

    const cloudState: CloudRouteState = {
      config: state.config,
      cloudManager: state.cloudManager,
      runtime: state.runtime,
      saveConfig: saveElizaConfig,
      createTelemetrySpan: createIntegrationTelemetrySpan,
      restartRuntime,
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
  // Conversation routes (/api/conversations/*) — delegated to conversation-routes.ts
  // ═══════════════════════════════════════════════════════════════════════

  if (pathname.startsWith("/api/conversations")) {
    // Cast state — ConversationRouteState is a compatible subset of ServerState
    const handled = await handleConversationRoutes({
      req,
      res,
      method,
      pathname,
      readJsonBody,
      json,
      error,
      state: coerce<ConversationRouteArg["state"]>(state),
    });
    if (handled) return;
  }

  // ═══════════════════════════════════════════════════════════════════════
  // OpenAI-compatible routes (/v1/*) — delegated to chat-routes.ts
  // ═══════════════════════════════════════════════════════════════════════

  if (pathname.startsWith("/v1/")) {
    // Cast state — ChatRouteState is a compatible subset of ServerState
    const handled = await handleChatRoutes({
      req,
      res,
      method,
      pathname,
      readJsonBody,
      json,
      error,
      state: coerce<ChatRouteArg["state"]>(state),
    });
    if (handled) return;
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
  if (
    !state.runtime &&
    method === "GET" &&
    pathname === "/api/coding-agents/coordinator/status"
  ) {
    error(res, "Coding agent runtime unavailable", 503);
    return;
  }
  if (
    !state.runtime &&
    method === "GET" &&
    pathname === "/api/coding-agents/preflight"
  ) {
    error(res, "Coding agent runtime unavailable", 503);
    return;
  }
  if (
    !state.runtime &&
    method === "GET" &&
    pathname.startsWith("/api/coding-agents")
  ) {
    error(res, "Coding agent runtime unavailable", 503);
    return;
  }
  if (
    state.runtime &&
    (pathname.startsWith("/api/coding-agents") ||
      pathname.startsWith("/api/workspace") ||
      pathname.startsWith("/api/issues"))
  ) {
    const isCoordinatorStatusRoute =
      method === "GET" && pathname === "/api/coding-agents/coordinator/status";
    const isPreflightRoute =
      method === "GET" && pathname === "/api/coding-agents/preflight";

    // Try to dynamically load the route handler from the local plugin first
    let handled = false;

    // Lazily start PTY_SERVICE if it was registered but not yet started.
    // The core runtime only starts services on-demand via getServiceLoadPromise,
    // but the orchestrator plugin's route handler checks getService() (which
    // only returns already-started instances). Without this kick, the plugin
    // sees null and returns 503 for every route.
    if (
      !state.runtime.getService("PTY_SERVICE") &&
      state.runtime.hasService("PTY_SERVICE")
    ) {
      try {
        await state.runtime.getServiceLoadPromise("PTY_SERVICE");
        wireCodingAgentBridgesNow(state);
      } catch {
        // Service start failed — the fallback handler will surface 503 unavailability.
      }
    }

    const ptyService = state.runtime.getService(
      "PTY_SERVICE",
    ) as PTYService | null;
    const coordinator = getCoordinatorFromRuntime(state.runtime);
    const codeTaskService = state.runtime.getService("CODE_TASK");
    const isTaskRoute =
      method === "GET" && pathname === "/api/coding-agents/tasks";
    const isTaskDetailRoute =
      method === "GET" && /^\/api\/coding-agents\/tasks\/[^/]+$/.test(pathname);
    const isSessionsRoute =
      method === "GET" && pathname === "/api/coding-agents/sessions";
    const isSessionDetailRoute =
      method === "GET" &&
      /^\/api\/coding-agents\/sessions\/[^/]+$/.test(pathname);
    const isScratchRoute =
      method === "GET" && pathname === "/api/coding-agents/scratch";
    const isAgentListRoute =
      method === "GET" && pathname === "/api/coding-agents";

    // The settings UI and startup hydration poll these routes early. When the
    // PTY/coordinator services are not ready yet, surface explicit 503
    // unavailability rather than synthesizing success-shaped empty payloads.
    if (
      (isCoordinatorStatusRoute && !coordinator) ||
      (isPreflightRoute && !ptyService) ||
      ((isTaskRoute ||
        isTaskDetailRoute ||
        isScratchRoute ||
        isAgentListRoute) &&
        !codeTaskService) ||
      ((isSessionsRoute || isSessionDetailRoute) && !ptyService)
    ) {
      handled = await handleCodingAgentsFallback(
        state.runtime,
        pathname,
        method,
        req,
        res,
      );
    }

    // Prefer @elizaos/plugin-agent-orchestrator route handler so the full coordinator
    // contract is served from the embedded runtime (replaces the old plugin).
    if (!handled)
      try {
        const orchestratorPlugin =
          agentOrchestratorCompat as OrchestratorPluginFallbackModule | null;
        if (orchestratorPlugin?.createCodingAgentRouteHandler) {
          const coordinator = orchestratorPlugin.getCoordinator?.(
            state.runtime,
          );
          const handler = orchestratorPlugin.createCodingAgentRouteHandler(
            state.runtime,
            coordinator,
          );
          handled = await (handler as ConnectorRouteHandler)(
            req,
            res,
            pathname,
            req.method ?? "GET",
          );
        }
      } catch {
        // Compat layer unavailable — final fallback below handles coding-agents routes.
      }

    // Final fallback: handle coding-agents routes using the plugin's CODE_TASK compatibility service.
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
      appManager: {
        listAvailable: (pluginManager) =>
          state.appManager.listAvailable(pluginManager),
        search: (pluginManager, query, limit) =>
          state.appManager.search(pluginManager, query, limit),
        listInstalled: (pluginManager) =>
          state.appManager.listInstalled(pluginManager),
        listRuns: (runtime) =>
          state.appManager.listRuns(
            runtime && typeof runtime === "object"
              ? (runtime as IAgentRuntime)
              : null,
          ),
        getRun: (runId, runtime) =>
          state.appManager.getRun(
            runId,
            runtime && typeof runtime === "object"
              ? (runtime as IAgentRuntime)
              : null,
          ),
        attachRun: (runId, runtime) =>
          state.appManager.attachRun(
            runId,
            runtime && typeof runtime === "object"
              ? (runtime as IAgentRuntime)
              : null,
          ),
        detachRun: (runId) => state.appManager.detachRun(runId),
        launch: (pluginManager, name, onProgress, runtime) =>
          state.appManager.launch(
            pluginManager,
            name,
            onProgress,
            runtime && typeof runtime === "object"
              ? (runtime as IAgentRuntime)
              : null,
          ),
        stop: (pluginManager, name, runId, runtime) =>
          state.appManager.stop(
            pluginManager,
            name,
            runId,
            runtime && typeof runtime === "object"
              ? (runtime as IAgentRuntime)
              : null,
          ),
        recordHeartbeat: (runId) => state.appManager.recordHeartbeat(runId),
        getInfo: (pluginManager, name) =>
          state.appManager.getInfo(pluginManager, name),
      },
      getPluginManager: () => getPluginManagerForState(state),
      parseBoundedLimit,
      readJsonBody,
      json,
      error,
      runtime: state.runtime,
      favoriteApps: {
        read: () => readFavoriteAppsFromConfig(state.config),
        write: (apps) => writeFavoriteAppsToConfig(state.config, apps),
      },
    })
  ) {
    return;
  }

  if (
    await handleAppPackageRoutes({
      req,
      res,
      method,
      pathname,
      url,
      readJsonBody,
      json,
      error,
      runtime: state.runtime,
    })
  ) {
    return;
  }

  // ═══════════════════════════════════════════════════════════════════════
  // ═══════════════════════════════════════════════════════════════════════
  // Workbench routes (extracted to workbench-routes.ts)
  // ═══════════════════════════════════════════════════════════════════════
  if (pathname.startsWith("/api/workbench")) {
    if (
      await handleWorkbenchRoutes({
        req,
        res,
        method,
        pathname,
        url,
        state: coerce<WorkbenchRouteArg["state"]>(state),
        json,
        error,
        readJsonBody,
        toWorkbenchTask:
          coerce<WorkbenchRouteArg["toWorkbenchTask"]>(toWorkbenchTask),
        toWorkbenchTodo:
          coerce<WorkbenchRouteArg["toWorkbenchTodo"]>(toWorkbenchTodo),
        normalizeTags,
        readTaskMetadata,
        readTaskCompleted,
        parseNullableNumber,
        asObject,
        decodePathComponent,
        taskToTriggerSummary:
          coerce<WorkbenchRouteArg["taskToTriggerSummary"]>(
            taskToTriggerSummary,
          ),
        listTriggerTasks:
          coerce<WorkbenchRouteArg["listTriggerTasks"]>(listTriggerTasks),
      })
    ) {
      return;
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Life-ops routes: now served via lifeopsPlugin.routes (rawPath) on the
  // runtime plugin route system. See app-lifeops/src/routes/plugin.ts.
  // ═══════════════════════════════════════════════════════════════════════

  // ═══════════════════════════════════════════════════════════════════════
  // MCP routes (extracted to mcp-routes.ts)
  // ═══════════════════════════════════════════════════════════════════════
  if (pathname.startsWith("/api/mcp")) {
    if (
      await handleMcpRoutes({
        req,
        res,
        method,
        pathname,
        url,
        state,
        json,
        error,
        readJsonBody,
        saveElizaConfig,
        redactDeep,
        isBlockedObjectKey,
        cloneWithoutBlockedObjectKeys,
        resolveMcpServersRejection,
        resolveMcpTerminalAuthorizationRejection,
        decodePathComponent,
      })
    ) {
      return;
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Misc routes (extracted to misc-routes.ts)
  // ═══════════════════════════════════════════════════════════════════════
  if (
    await handleMiscRoutes({
      req,
      res,
      method,
      pathname,
      url,
      state: coerce<MiscRouteArg["state"]>(state),
      json,
      error,
      readJsonBody,
      AGENT_EVENT_ALLOWED_STREAMS,
      resolveTerminalRunRejection,
      resolveTerminalRunClientId,
      isSharedTerminalClientId,
      activeTerminalRunCount,
      setActiveTerminalRunCount: (delta: number) => {
        activeTerminalRunCount = Math.max(0, activeTerminalRunCount + delta);
      },
    })
  ) {
    return;
  }

  if (
    await handleWhatsAppRoute(
      req,
      res,
      pathname,
      method,
      {
        whatsappPairingSessions: state.whatsappPairingSessions ?? new Map(),
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
          new WhatsAppPairingSession(options),
      },
    )
  ) {
    return;
  }

  // ── elizaOS plugin HTTP routes (runtime.routes, e.g. /music-player/*) ───
  if (
    await tryHandleRuntimePluginRoute({
      req,
      res,
      method,
      pathname,
      url,
      runtime: state.runtime,
      isAuthorized: () => isAuthorized(req),
    })
  ) {
    return;
  }

  // ── Connector plugin routes (dynamically registered) ────────────────────
  for (const handler of state.connectorRouteHandlers) {
    const handled = await handler(req, res, pathname, method);
    if (handled) return;
  }

  // ── Music player compatibility fallback ─────────────────────────────────
  if (
    tryHandleMusicPlayerStatusFallback({
      pathname,
      method,
      runtime: state.runtime,
      res,
    })
  ) {
    return;
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
import { type captureEarlyLogs, flushEarlyLogs } from "./early-logs.js";

export type { captureEarlyLogs };

// ---------------------------------------------------------------------------
// Server start
// ---------------------------------------------------------------------------

export async function startApiServer(opts?: {
  port?: number;
  runtime?: AgentRuntime;
  skipDeferredStartupWork?: boolean;
  /** Initial state when starting without a runtime (e.g. embedded startup flow). */
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
  console.log(`[eliza-api] startApiServer called`);

  const port = opts?.port ?? resolveServerOnlyPort(process.env);
  const host = resolveApiBindHost(process.env);
  ensureApiTokenForBindHost(host);
  console.log(`[eliza-api] Token check done (${Date.now() - apiStartTime}ms)`);

  let config: ElizaConfig;
  try {
    config = loadElizaConfig();
  } catch (err) {
    logger.warn(
      `[eliza-api] Failed to load config, starting with defaults: ${err instanceof Error ? err.message : err}`,
    );
    config = {} as ElizaConfig;
  }
  console.log(`[eliza-api] Config loaded (${Date.now() - apiStartTime}ms)`);

  // Wallet/inventory routes read from process.env at request-time.
  // Hydrate persisted config.env values so addresses remain visible after restarts.
  const persistedEnv = config.env as Record<string, string> | undefined;
  const envKeysToHydrate = [
    "ELIZA_WALLET_OS_STORE",
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

  // Optional auto-provision mode for legacy environments. Disabled by default
  // so startup does not silently create new wallets when keys are missing.
  const walletAutoProvisionRaw =
    process.env.ELIZA_WALLET_AUTO_PROVISION?.trim().toLowerCase();
  const walletAutoProvisionEnabled =
    walletAutoProvisionRaw === "1" ||
    walletAutoProvisionRaw === "true" ||
    walletAutoProvisionRaw === "on" ||
    walletAutoProvisionRaw === "yes";
  if (walletAutoProvisionEnabled && ensureWalletKeysInEnvAndConfig(config)) {
    try {
      saveElizaConfig(config);
    } catch (err) {
      logger.warn(
        `[eliza-api] Failed to persist generated wallet keys: ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  // Pre-load steward wallet addresses so getWalletAddresses() has them
  // available synchronously from the start (cloud-provisioned containers).
  await initStewardWalletCache();

  // Warn when wallet private keys live in plaintext config and the OS secure
  // store is not enabled.  This nudges operators toward ELIZA_WALLET_OS_STORE=1.
  {
    const hasPlaintextKeys =
      (typeof persistedEnv?.EVM_PRIVATE_KEY === "string" &&
        persistedEnv.EVM_PRIVATE_KEY.trim()) ||
      (typeof persistedEnv?.SOLANA_PRIVATE_KEY === "string" &&
        persistedEnv.SOLANA_PRIVATE_KEY.trim());
    const osStoreRaw = process.env.ELIZA_WALLET_OS_STORE?.trim().toLowerCase();
    const osStoreEnabled =
      osStoreRaw === "1" ||
      osStoreRaw === "true" ||
      osStoreRaw === "on" ||
      osStoreRaw === "yes";
    if (hasPlaintextKeys && !osStoreEnabled) {
      logger.warn(
        "[wallet] Private keys are stored in plaintext config. " +
          "Set ELIZA_WALLET_OS_STORE=1 to use the OS secure store instead.",
      );
    }
  }

  const plugins = discoverPluginsFromManifest();
  console.log(
    `[eliza-api] Plugins discovered (${Date.now() - apiStartTime}ms)`,
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
    ? (opts.runtime?.character.name ?? resolveDefaultAgentName(config))
    : resolveDefaultAgentName(config);

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
    whatsappPairingSessions: new Map(),
  };
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
    logger.info(
      "[eliza-api] Training service package unavailable; training routes will be disabled",
    );
  }
  // Register immediately so /api/training routes are available without a startup race.
  const configuredAdminEntityId = config.agents?.defaults?.adminEntityId;
  if (configuredAdminEntityId && isUuidLike(configuredAdminEntityId)) {
    state.adminEntityId = configuredAdminEntityId;
    state.chatUserId = state.adminEntityId;
  } else if (configuredAdminEntityId) {
    logger.warn(
      `[eliza-api] Ignoring invalid agents.defaults.adminEntityId "${configuredAdminEntityId}"`,
    );
  }

  // Wire the app manager to the runtime if already running
  if (state.runtime) {
    // AppManager doesn't need a runtime reference — it just installs plugins
  }

  // Start the periodic stale-run sweeper that stops app runs whose UI
  // heartbeat has gone silent (e.g. the user closed the tab without
  // pressing Stop). Without this, plugins that own a setInterval — like
  // the Defense-of-the-Agents game loop — would tick forever after the
  // browser disappeared. The sweeper invokes the same `stopRun` route
  // hook the Stop button uses so plugins have one shutdown path.
  state.appManager.startStaleRunSweeper(() => state.runtime);

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
  void getOrFetchAllProviders().catch((err) => {
    logger.warn("[api] Provider cache warm-up failed:", err);
  });

  // ── Intercept loggers so ALL agent/plugin/service logs appear in the UI ──
  // We patch both the global `logger` singleton from @elizaos/core (used by
  // eliza.ts, services, plugins, etc.) AND the runtime instance logger.
  // A marker prevents double-patching on hot-restart and avoids stacking
  // wrapper functions that would leak memory.
  const PATCHED_MARKER = "__elizaLogPatched";
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
    const patchedTarget = target as typeof logger & {
      [PATCHED_MARKER]?: boolean;
    };
    if (patchedTarget[PATCHED_MARKER]) {
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
        // Auto-extract source from [bracket] prefixes (e.g. "[eliza] ...")
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

    patchedTarget[PATCHED_MARKER] = true;
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
    `[eliza-api] Creating http server (${Date.now() - apiStartTime}ms)`,
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
  console.log(`[eliza-api] Server created (${Date.now() - apiStartTime}ms)`);

  const broadcastWs = (payload: unknown): void => {
    const message = JSON.stringify(payload);
    for (const client of wsClients) {
      if (client.readyState === 1) {
        try {
          client.send(message);
        } catch (err) {
          logger.error(
            `[eliza-api] WebSocket broadcast error: ${err instanceof Error ? err.message : err}`,
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
          "[eliza-api] AGENT_EVENT service not found on runtime — event streaming will be unavailable",
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
          `[eliza-api] Skill discovery failed during startup: ${err instanceof Error ? err.message : String(err)}`,
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
          `[eliza-api] Training service init failed: ${err instanceof Error ? err.message : String(err)}`,
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
        const registryRpcUrl = normalizeJsonRpcUrl(registryConfig.mainnetRpc);
        const registryRpcProbe = await probeJsonRpcEndpoint(registryRpcUrl);
        if (!registryRpcProbe.ok) {
          addLog(
            "warn",
            `ERC-8004 registry service disabled: RPC unavailable (${registryRpcProbe.reason ?? "unknown error"})`,
            "system",
            ["system"],
          );
          logger.warn(
            {
              reason: registryRpcProbe.reason,
            },
            "ERC-8004 registry service disabled because mainnetRpc is unavailable",
          );
          return;
        }

        const txService = new TxService(registryRpcUrl, evmKey);
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
          setElizaMakerDropService(state.dropService);
        } else {
          state.dropService = null;
          setElizaMakerDropService(null);
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
        const { handleStreamRoute } = await import("./stream-routes.js");
        // Screen capture manager is injected by the desktop host via globalThis
        const screenCapture = (globalThis as Record<string, unknown>)
          .__elizaScreenCapture as
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
        const _connectors = state.config.connectors ?? {};
        const streaming = (state.config as Record<string, unknown>).streaming as
          | Record<string, unknown>
          | undefined;
        const destinations = new Map<
          string,
          import("./stream-routes.js").StreamingDestination
        >();

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
              `[eliza-api] Failed to load custom-rtmp destination: ${err instanceof Error ? err.message : String(err)}`,
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
              `[eliza-api] Failed to load twitch destination: ${err instanceof Error ? err.message : String(err)}`,
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
              `[eliza-api] Failed to load youtube destination: ${err instanceof Error ? err.message : String(err)}`,
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
              `[eliza-api] Failed to load pumpfun destination: ${err instanceof Error ? err.message : String(err)}`,
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
              `[eliza-api] Failed to load x destination: ${err instanceof Error ? err.message : String(err)}`,
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
          captureUrl: undefined as string | undefined,
          destinations,
          activeDestinationId,
          activeStreamSource: { type: "stream-tab" as const },
          mirrorStreamAvatarToElizaConfig: (avatarIndex: number) => {
            try {
              if (!Number.isFinite(avatarIndex)) {
                return;
              }
              const diskCfg = loadElizaConfig();
              const lang = state.config.ui?.language ?? diskCfg.ui?.language;
              const preset = resolveStylePresetByAvatarIndex(avatarIndex, lang);
              const nextUi: ElizaConfig["ui"] = {
                ...(state.config.ui ?? {}),
                avatarIndex,
                ...(preset?.id ? { presetId: preset.id } : {}),
              };
              state.config = {
                ...state.config,
                ui: nextUi,
              };
              // Merge disk + live server config so we never persist a minimal
              // snapshot (e.g. ENOENT default) and clobber eliza.json during
              // onboarding while state.config still holds the full boot payload.
              const toSave: ElizaConfig = {
                ...diskCfg,
                ...state.config,
                ui: {
                  ...(diskCfg.ui ?? {}),
                  ...(state.config.ui ?? {}),
                  ...nextUi,
                },
              };
              saveElizaConfig(toSave);
              state.config = {
                ...state.config,
                ui: toSave.ui,
              };
            } catch (err) {
              logger.warn(
                `[eliza-api] mirrorStreamAvatarToElizaConfig failed: ${
                  err instanceof Error ? err.message : String(err)
                }`,
              );
            }
          },
          get config() {
            const cfg = state.config as Record<string, unknown> | undefined;
            const msgs = cfg?.messages as Record<string, unknown> | undefined;
            return msgs
              ? {
                  messages: {
                    tts: msgs.tts as
                      | import("../config/types.messages.js").TtsConfig
                      | undefined,
                  },
                }
              : undefined;
          },
        };
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
          `[eliza-api] Failed to load stream routes: ${err instanceof Error ? err.message : String(err)}`,
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
      wss.handleUpgrade(request, socket, head, (ws: WebSocket) => {
        wss.emit("connection", ws, request);
      });
    } catch (err) {
      logger.error(
        `[eliza-api] WebSocket upgrade error: ${err instanceof Error ? err.message : err}`,
      );
      rejectWebSocketUpgrade(socket, 404, "Not found");
    }
  });

  // Handle WebSocket connections
  wss.on("connection", (ws: WebSocket, request: http.IncomingMessage) => {
    let wsUrl: URL;
    try {
      wsUrl = new URL(
        request.url ?? "/",
        `http://${request.headers.host ?? "localhost"}`,
      );
      const clientId = normalizeWsClientId(wsUrl.searchParams.get("clientId"));
      if (clientId) wsClientIds.set(ws, clientId);
    } catch {
      // Ignore malformed WS URL metadata; auth/path were already validated.
      wsUrl = new URL("ws://localhost/ws");
    }

    let isAuthenticated = isWebSocketAuthorized(request, wsUrl);

    const activateAuthenticatedConnection = () => {
      wsClients.add(ws);
      addLog("info", "WebSocket client connected", "websocket", [
        "server",
        "websocket",
      ]);

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
          `[eliza-api] WebSocket send error: ${err instanceof Error ? err.message : err}`,
        );
      }
    };

    if (isAuthenticated) {
      activateAuthenticatedConnection();
    }

    ws.on("message", (data: unknown) => {
      try {
        const msg = JSON.parse(String(data));
        if (!isAuthenticated) {
          const expected = getConfiguredApiToken();
          if (
            expected &&
            msg.type === "auth" &&
            typeof msg.token === "string" &&
            tokenMatches(expected, msg.token.trim())
          ) {
            isAuthenticated = true;
            ws.send(JSON.stringify({ type: "auth-ok" }));
            activateAuthenticatedConnection();
          } else {
            logger.warn("[eliza-api] WebSocket message rejected before auth");
            ws.close(1008, "Unauthorized");
          }
          return;
        }
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
              bridge.on(
                "session_output",
                listener as (...args: unknown[]) => void,
              );
              subs.set(targetId, () =>
                bridge.off(
                  "session_output",
                  listener as (...args: unknown[]) => void,
                ),
              );
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
              `[eliza-api] pty-input rejected: client not subscribed to session ${msg.sessionId}`,
            );
          } else if (msg.data.length > 4096) {
            logger.warn(
              `[eliza-api] pty-input rejected: payload too large (${msg.data.length} bytes) for session ${msg.sessionId}`,
            );
          } else {
            const bridge = getPtyConsoleBridge(state);
            if (bridge) {
              logger.debug(
                `[eliza-api] pty-input: session=${msg.sessionId} len=${msg.data.length}`,
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
              `[eliza-api] pty-resize rejected: client not subscribed to session ${msg.sessionId}`,
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
                `[eliza-api] pty-resize rejected: invalid dimensions cols=${msg.cols} rows=${msg.rows}`,
              );
            }
          }
        }
      } catch (err) {
        logger.error(
          `[eliza-api] WebSocket message error: ${err instanceof Error ? err.message : err}`,
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

    ws.on("error", (err: unknown) => {
      logger.error(
        `[eliza-api] WebSocket error: ${err instanceof Error ? err.message : err}`,
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
  state.broadcastWs = (data: object) => {
    const message = JSON.stringify(data);
    for (const client of wsClients) {
      if (client.readyState === 1) {
        try {
          client.send(message);
        } catch (err) {
          logger.error(
            `[eliza-api] WebSocket broadcast error: ${err instanceof Error ? err.message : err}`,
          );
        }
      }
    }
  };

  state.broadcastWsToClientId = (clientId: string, data: object) => {
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
          `[eliza-api] WebSocket targeted send error: ${err instanceof Error ? err.message : err}`,
        );
      }
    }
    return delivered;
  };

  // Wire up ConnectorSetupService broadcastWs so connector plugins
  // (Signal, WhatsApp) can broadcast pairing events via the service.
  if (state.runtime) {
    try {
      const setupSvc = state.runtime.getService("connector-setup") as {
        setBroadcastWs?: (
          fn: ((data: Record<string, unknown>) => void) | null,
        ) => void;
      } | null;
      setupSvc?.setBroadcastWs?.(state.broadcastWs);
    } catch {
      // non-fatal — service may not be registered yet
    }
  }

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
      const agentName = rt.character.name ?? "Eliza";
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
            limit: 1,
          });
          if (msgs.length > 0 && msgs[0].createdAt) {
            updatedAt = new Date(msgs[0].createdAt).toISOString();
          }
        } catch {
          // non-fatal — use current time
        }

        const conversationMetadata = extractConversationMetadataFromRoom(
          room,
          convId,
        );

        state.conversations.set(convId, {
          id: convId,
          title: room.name || "Chat",
          roomId: room.id as UUID,
          ...(conversationMetadata ? { metadata: conversationMetadata } : {}),
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
        `[eliza-api] Failed to restore conversations from DB: ${err instanceof Error ? err.message : err}`,
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

  /**
   * Load the agent's DB-persisted character data and overlay onto the
   * in-memory runtime.character.  This ensures Character Editor edits
   * survive server restarts without depending on eliza.json persistence.
   */
  const overlayDbCharacter = async (
    rt: AgentRuntime,
    st: typeof state,
  ): Promise<void> => {
    try {
      const dbAgent = await rt.getAgent(rt.agentId);
      const agentRecord =
        dbAgent && typeof dbAgent === "object" && !Array.isArray(dbAgent)
          ? Object.fromEntries(Object.entries(dbAgent))
          : null;
      const saved = agentRecord?.character as
        | Record<string, unknown>
        | undefined;
      if (!saved || typeof saved !== "object") return;

      const c = rt.character;
      // Only overlay fields that were explicitly saved (non-empty)
      if (typeof saved.name === "string" && saved.name) c.name = saved.name;
      if (Array.isArray(saved.bio) && saved.bio.length > 0) {
        c.bio = saved.bio as string[];
      }
      if (typeof saved.system === "string" && saved.system) {
        c.system = saved.system;
      }
      if (Array.isArray(saved.adjectives)) {
        c.adjectives = saved.adjectives as string[];
      }
      if (Array.isArray(saved.topics)) {
        (c as { topics?: string[] }).topics = saved.topics as string[];
      }
      if (saved.style && typeof saved.style === "object") {
        c.style = saved.style as NonNullable<typeof c.style>;
      }
      if (Array.isArray(saved.messageExamples)) {
        c.messageExamples = saved.messageExamples as NonNullable<
          typeof c.messageExamples
        >;
      }
      if (Array.isArray(saved.postExamples) && saved.postExamples.length > 0) {
        c.postExamples = saved.postExamples as string[];
      }
      // Update agent name on state
      st.agentName = c.name ?? st.agentName;
      logger.info(
        `[character-db] Overlaid DB-persisted character "${c.name}" onto runtime`,
      );
    } catch (err) {
      logger.warn(
        `[character-db] Failed to load character from DB: ${err instanceof Error ? err.message : err}`,
      );
    }
  };

  // Restore conversations from DB at initial boot (if runtime was passed in)
  if (opts?.runtime) {
    void beginConversationRestore(opts.runtime).catch((err) => {
      logger.warn("[api] Conversation restore failed:", err);
    });
    void overlayDbCharacter(opts.runtime, state).catch((err) => {
      logger.warn("[api] Character overlay restore failed:", err);
    });
    registerClientChatSendHandler(opts.runtime, state);
  }

  const assertX402RoutesValid = (rt: AgentRuntime | null | undefined): void => {
    if (!rt?.routes?.length) return;
    const agentId =
      rt.agentId != null && String(rt.agentId).length > 0
        ? String(rt.agentId)
        : undefined;
    const result = validateX402Startup(rt.routes as Route[], rt.character, {
      agentId,
    });
    if (!result.valid) {
      throw new Error(
        `x402 configuration invalid:\n${result.errors.map((e) => `  • ${e}`).join("\n")}`,
      );
    }
    for (const w of result.warnings) {
      logger.warn(`[x402] ${w}`);
    }
  };

  /** Hot-swap the runtime reference (used after an in-process restart). */
  const updateRuntime = (rt: AgentRuntime): void => {
    assertX402RoutesValid(rt);
    state.runtime = rt;
    state.chatConnectionReady = null;
    state.chatConnectionPromise = null;
    bindRuntimeStreams(rt);
    // AppManager doesn't need a runtime reference
    state.agentState = "running";
    state.agentName =
      rt.character.name ?? resolveDefaultAgentName(state.config);
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
    void beginConversationRestore(rt).catch((err) => {
      logger.warn("[api] Conversation restore failed on restart:", err);
    });

    // Overlay DB-persisted character data (from Character Editor saves)
    void overlayDbCharacter(rt, state).catch((err) => {
      logger.warn("[api] Character overlay restore failed on restart:", err);
    });

    // Broadcast status update immediately after restart
    broadcastStatus();

    // Re-register client_chat send handler on the new runtime
    registerClientChatSendHandler(rt, state);

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
    `[eliza-api] Calling server.listen (${Date.now() - apiStartTime}ms)`,
  );
  try {
    assertX402RoutesValid(state.runtime);
  } catch (err) {
    return Promise.reject(err);
  }
  return new Promise((resolve, reject) => {
    let currentPort = port;

    server.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") {
        console.warn(
          `[eliza-api] Port ${currentPort} is already in use. Checking fallback...`,
        );
        if (currentPort !== 0) {
          console.warn(`[eliza-api] Retrying with dynamic port (0)...`);
          currentPort = 0;
          server.listen(0, host);
          return;
        }
      } else {
        console.error(
          `[eliza-api] Server error: ${err.message} (code: ${err.code})`,
        );
      }
      reject(err);
    });

    server.listen(port, host, () => {
      console.log(
        `[eliza-api] server.listen callback fired (${Date.now() - apiStartTime}ms)`,
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
        `[eliza-api] Listening on http://${displayHost}:${actualPort}`,
      );
      logger.info(
        `[eliza-api] Listening on http://${displayHost}:${actualPort}`,
      );
      if (!opts?.skipDeferredStartupWork) {
        startDeferredStartupWork();
      }
      resolve({
        port: actualPort,
        close: async () =>
          await new Promise<void>((r) => {
            void (async () => {
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
                  (ws as unknown as { terminate(): void }).terminate();
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
              if (state.telegramAccountAuthSession) {
                try {
                  await state.telegramAccountAuthSession.stop();
                } catch {
                  /* non-fatal */
                }
                state.telegramAccountAuthSession = null;
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
            })();
          }),
        updateRuntime,
        updateStartup,
      });
    });
  });
}
