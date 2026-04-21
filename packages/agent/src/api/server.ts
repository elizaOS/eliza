/**
 * REST API server for the Eliza Control UI.
 *
 * Exposes HTTP endpoints that the UI frontend expects, backed by the
 * elizaOS AgentRuntime. Default port: 2138. In dev mode, the Vite UI
 * dev server proxies /api and /ws here (see eliza/packages/app-core/scripts/dev-ui.mjs).
 */

import crypto from "node:crypto";
import { lookup as dnsLookup } from "node:dns/promises";
import fs from "node:fs";
import http from "node:http";
import { createRequire } from "node:module";

type StreamableServerResponse = Pick<
  http.ServerResponse,
  "write" | "once" | "off" | "removeListener" | "writableEnded" | "destroyed"
>;

function tokenMatches(expected: string, provided: string): boolean {
  const expectedBuf = Buffer.from(expected);
  const providedBuf = Buffer.from(provided);
  return (
    expectedBuf.length === providedBuf.length &&
    crypto.timingSafeEqual(expectedBuf, providedBuf)
  );
}

const MAX_BODY_BYTES = 1024 * 1024; // 1 MB

import net from "node:net";
import os from "node:os";
import path from "node:path";
// Discord local routes extracted to @elizaos/plugin-discord (setup-routes.ts)
import { DropService, handleDropRoutes } from "@elizaos/app-elizamaker";
import { handleKnowledgeRoutes } from "@elizaos/app-knowledge/routes";
import { TxService } from "@elizaos/app-steward/api/tx-service";
import type {
  SwarmEvent,
  TaskCompletionSummary,
  TaskContext,
} from "@elizaos/app-task-coordinator/api/coordinator-types";
import { wireCoordinatorBridgesWhenReady } from "@elizaos/app-task-coordinator/api/coordinator-wiring";
import { routeTaskAgentTextToConnector } from "@elizaos/app-task-coordinator/api/task-agent-message-routing";
// Phase 2 extraction: LifeOps routes → app-lifeops/src/routes/plugin.ts (lifeopsPlugin)
// import { handleWalletTradeExecuteRoute } from "./wallet-trade-routes.js";
// import {
//   loadWalletTradingProfile,
//   recordWalletTradeLedgerEntry,
//   updateWalletTradeLedgerEntryStatus,
// } from "./wallet-trading-profile.js";
// Phase 2 extraction: Website-blocker routes → app-lifeops/src/routes/plugin.ts (lifeopsPlugin)
import { handleTrainingRoutes } from "@elizaos/app-training/routes/training";
import { handleTrajectoryRoute } from "@elizaos/app-training/routes/trajectory";
import {
  type AgentRuntime,
  ChannelType,
  createMessageMemory,
  type IAgentRuntime,
  logger,
  stringToUuid,
  type UUID,
} from "@elizaos/core";
import {
  isNullOriginAllowed,
  resolveAllowedHosts,
  resolveAllowedOrigins,
  resolveApiBindHost,
  resolveApiSecurityConfig,
  resolveApiToken,
  resolveServerOnlyPort,
  setApiToken,
  stripOptionalHostPort,
} from "@elizaos/shared/runtime-env";
import { type WebSocket, WebSocketServer } from "ws";
import { getGlobalAwarenessRegistry } from "../awareness/registry.js";
import { CharacterSchema } from "../config/character-schema.js";
import {
  type ElizaConfig,
  loadElizaConfig,
  saveElizaConfig,
} from "../config/config.js";
import { resolveModelsCacheDir, resolveStateDir } from "../config/paths.js";
import { isStreamingDestinationConfigured } from "../config/plugin-auto-enable.js";
import {
  ONBOARDING_CLOUD_PROVIDER_OPTIONS,
  ONBOARDING_PROVIDER_CATALOG,
} from "../contracts/onboarding.js";
import { createIntegrationTelemetrySpan } from "../diagnostics/integration-observability.js";
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
import {
  isBlockedPrivateOrLinkLocalIp,
  isLoopbackHost,
  normalizeHostLike,
} from "../security/network-policy.js";
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
import {
  ensurePrivyWalletsForCustomUser,
  isPrivyWalletProvisioningEnabled,
} from "../services/privy-wallets.js";
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
// BSC trade helpers moved to @elizaos/app-steward. Kept for re-export only.
// import { buildBscApproveUnsignedTx, ... } from "./bsc-trade.js";
import { handleBugReportRoutes } from "./bug-report-routes.js";
import { handleCharacterRoutes } from "./character-routes.js";
import {
  generateChatResponse as generateChatResponseFromChatRoutes,
  handleChatRoutes,
  initSse as initSseFromChatRoutes,
  writeSseJson as writeSseJsonFromChatRoutes,
} from "./chat-routes.js";
import { resolveClientChatAdminEntityId } from "./client-chat-admin.js";
import { handleCloudBillingRoute } from "./cloud-billing-routes.js";
import { handleCloudCompatRoute } from "./cloud-compat-routes.js";
import { isCloudProvisionedContainer } from "./cloud-provisioning.js";
import { handleCloudRelayRoute } from "./cloud-relay-routes.js";
import { type CloudRouteState, handleCloudRoute } from "./cloud-routes.js";
import { handleCloudFeaturesRoute } from "./cloud-features-routes.js";
import { handleCloudStatusRoutes } from "./cloud-status-routes.js";
import { handleDuffelRelayRoute } from "./duffel-relay-routes.js";
import { handleConfigRoutes } from "./config-routes.js";
import { ConnectorHealthMonitor } from "./connector-health.js";
import { handleConnectorRoutes } from "./connector-routes.js";
import { extractConversationMetadataFromRoom } from "./conversation-metadata.js";
import { handleConversationRoutes } from "./conversation-routes.js";
import { handleCuratedSkillsRoutes } from "./curated-skills-routes.js";
import { handleDatabaseRoute } from "./database.js";
import { handleDiagnosticsRoutes } from "./diagnostics-routes.js";
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
import { pushWithBatchEvict, sweepExpiredEntries } from "./memory-bounds.js";
import { handleMemoryRoutes } from "./memory-routes.js";
import { handleMiscRoutes } from "./misc-routes.js";
import { handleModelsRoutes } from "./models-routes.js";
import { tryHandleMusicPlayerStatusFallback } from "./music-player-route-fallback.js";
import { handleOnboardingRoutes } from "./onboarding-routes.js";
import type {
  CoordinationLLMResponse,
  PTYService,
} from "./parse-action-block.js";
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
  hasBlockedObjectKeyDeep,
  hasPersistedOnboardingState,
  isUuidLike,
  patchTouchesProviderSelection,
  resolveAppUserName,
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
  // fetchEvmBalances, fetchSolanaBalances, fetchSolanaNativeBalanceViaRpc,
  // generateWalletForChain, importWallet, validatePrivateKey,
  generateWalletKeys,
  getWalletAddresses,
  initStewardWalletCache,
  setSolanaWalletEnv,
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
// handleWhatsAppRoute moved to @elizaos/plugin-whatsapp setup-routes.
// applyWhatsAppQrOverride is still used by plugin-status routes.
import { applyWhatsAppQrOverride } from "./whatsapp-routes.js";
import { handleWorkbenchRoutes } from "./workbench-routes.js";

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
type DropRouteArg = Parameters<typeof handleDropRoutes>[0];
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

import type { FallbackParsedAction } from "./binance-skill-helpers.js";
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

const nodeRequire = createRequire(import.meta.url);
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

// Canonical server surface types (single source in server-types.ts).
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
  ConversationMeta,
  ServerState,
  StreamEventEnvelope,
} from "./server-types.js";

// ---------------------------------------------------------------------------
// Package root resolution (for reading bundled plugins.json)
// ---------------------------------------------------------------------------

// findOwnPackageRoot moved to server-helpers.ts; re-exported in the batch above

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

// Config redaction, skill validation extracted to server-helpers-config.ts
// isBlockedObjectKey, redactDeep, redactConfigSecrets, isRedactedSecretValue,
// stripRedactedPlaceholderValuesDeep imported from server-helpers-config.ts above.
// isBlockedObjectKey alias for local usage:
const isBlockedObjectKey = isBlockedObjectKeyFromConfig;

// MCP validation helpers extracted to server-helpers-mcp.ts
import {
  resolveMcpServersRejection as _resolveMcpServersRejection,
  validateMcpServerConfig as _validateMcpServerConfig,
} from "./server-helpers-mcp.js";

export {
  resolveMcpServersRejection,
  validateMcpServerConfig,
} from "./server-helpers-mcp.js";

const validateMcpServerConfig = _validateMcpServerConfig;
const resolveMcpServersRejection = _resolveMcpServersRejection;

// ---------------------------------------------------------------------------
// Onboarding / config helpers — extracted to server-helpers-config.ts
// ---------------------------------------------------------------------------

import {
  getStylePresets,
  normalizeCharacterLanguage,
  resolveStylePresetByAvatarIndex,
} from "@elizaos/shared/onboarding-presets";
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
import {
  hasUsableWalletFallbackParams as _hasUsableWalletFallbackParams,
  inferWalletExecutionFallback as _inferWalletExecutionFallback,
  resolveWalletExportRejection as _resolveWalletExportRejection,
} from "./server-helpers-wallet.js";

export {
  hasUsableWalletFallbackParams,
  inferWalletExecutionFallback,
  resolveWalletExportRejection,
  type WalletExportRejection,
} from "./server-helpers-wallet.js";

const inferWalletExecutionFallback = _inferWalletExecutionFallback;
const hasUsableWalletFallbackParams = _hasUsableWalletFallbackParams;
const resolveWalletExportRejection = _resolveWalletExportRejection;

// Plugin config helpers extracted to server-helpers-plugin.ts
import {
  type PluginConfigMutationRejection as _PluginConfigMutationRejection,
  resolvePluginConfigMutationRejections as _resolvePluginConfigMutationRejections,
  resolvePluginConfigReply as _resolvePluginConfigReply,
} from "./server-helpers-plugin.js";

export {
  type PluginConfigMutationRejection,
  resolvePluginConfigMutationRejections,
  resolvePluginConfigReply,
} from "./server-helpers-plugin.js";

const resolvePluginConfigReply = _resolvePluginConfigReply;
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

// Auth, CORS, pairing, terminal, WebSocket auth helpers extracted to server-helpers-auth.ts
import {
  applyCors as _applyCors,
  clearPairing as _clearPairing,
  ensureApiTokenForBindHost as _ensureApiTokenForBindHost,
  ensurePairingCode as _ensurePairingCode,
  extractAuthToken as _extractAuthToken,
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
  resolveCorsOrigin as _resolveCorsOrigin,
  resolveTerminalRunClientId as _resolveTerminalRunClientId,
  resolveTerminalRunRejection as _resolveTerminalRunRejection,
  resolveWebSocketUpgradeRejection as _resolveWebSocketUpgradeRejection,
  type WebSocketUpgradeRejection as _WebSocketUpgradeRejection,
  type TerminalRunRejection,
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
const resolveCorsOrigin = _resolveCorsOrigin;
const applyCors = _applyCors;
const extractAuthToken = _extractAuthToken;
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

import { routeAutonomyTextToUser as _routeAutonomyTextToUser } from "./server-helpers-swarm.js";

export { routeAutonomyTextToUser } from "./server-helpers-swarm.js";

const routeAutonomyTextToUser = _routeAutonomyTextToUser;

// The full autonomy/swarm/coordinator/PTY bridge implementations are now in
// server-helpers-swarm.ts. Only a compat stub remains for type checking.
const CHAT_SUPPRESSED_AUTONOMY_SOURCES = new Set([
  "lifeops-reminder",
  "lifeops-workflow",
  "proactive-gm",
  "proactive-gn",
  "proactive-nudge",
]);

async function _routeAutonomyTextToUserCompat(
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

  if (CHAT_SUPPRESSED_AUTONOMY_SOURCES.has(source)) {
    return;
  }

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
    cb: (
      text: string,
      source?: string,
      routing?: {
        sessionId?: string;
        threadId?: string;
        roomId?: string | null;
      },
    ) => Promise<void>,
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
  getTaskThread?: (
    threadId: string,
  ) => Promise<{ roomId?: string | null } | null>;
} | null {
  const coordinator = runtime.getService("SWARM_COORDINATOR");
  if (coordinator) {
    return coordinator as ReturnType<typeof getCoordinatorFromRuntime>;
  }
  const ptyService = runtime.getService("PTY_SERVICE") as
    | (PTYService & { coordinator?: unknown })
    | null;
  if (ptyService?.coordinator) {
    return ptyService.coordinator as ReturnType<
      typeof getCoordinatorFromRuntime
    >;
  }
  return null;
}

function wireCodingAgentBridgesNow(st: ServerState): void {
  wireCodingAgentChatBridge(st);
  wireCodingAgentWsBridge(st);
  wireCoordinatorEventRouting(st);
  wireCodingAgentSwarmSynthesis(st);
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
  const hasPtyService = Boolean(st.runtime.getService("PTY_SERVICE"));
  if (hasPtyService) {
    // In the real task-agent stack the PTY progress streamer + jsonl watcher
    // already deliver the success path. Keep generic coordinator chatter
    // suppressed, but still route task-specific issue messages when the
    // coordinator includes per-task routing metadata or when the text itself
    // identifies a unique task thread.
    coordinator.setChatCallback(async (text, source, routing) => {
      const delivered = await routeTaskAgentTextToConnector(
        st.runtime,
        text,
        source ?? "coding-agent",
        routing,
      );
      if (!delivered) {
        await routeAutonomyTextToUser(st, text, source ?? "coding-agent");
      }
    });
    return true;
  }

  // Minimal runtimes used by tests and lightweight embeddings do not install
  // the PTY progress bridge, so the coordinator callback is the only path
  // that can surface coding-agent updates back into chat.
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
  // The task-progress-streamer was removed from this tree but the callback
  // was left as a no-op, so subagent completions never reached the user.
  // Invoke handleSwarmSynthesis directly so the synthesis LLM routes the
  // final answer back to the conversation. The task jsonl is already the
  // source of truth for per-task completionSummary.
  if (!st.runtime) return false;
  const coordinator = getCoordinatorFromRuntime(st.runtime);
  if (!coordinator?.setSwarmCompleteCallback) return false;
  coordinator.setSwarmCompleteCallback(async (payload) => {
    await handleSwarmSynthesis(st, payload);
  });
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
      workdir?: string;
      roomId?: string;
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

  const resultText = await buildSynthesisResultText(payload, runtime);
  logger.info(
    `[swarm-synthesis] Synthesis generated (${resultText.length} chars), routing to user — preview: ${resultText.slice(0, 200).replace(/\n/g, " | ")}`,
  );
  // Route back to the originating chat channel via the roomId captured on
  // the incoming user message (propagated through the task payload).
  const roomId = payload.tasks.find((t) => t.roomId)?.roomId ?? null;
  // Discord's per-message limit is 2000 chars. Deliver long answers as
  // sequential chunks so the subagent's full output reaches the user.
  for (const chunk of chunkForDiscord(resultText, 1900)) {
    await routeMessage(chunk, "swarm_synthesis");
    await routeSynthesisToConnector(runtime, chunk, roomId);
  }
}

/**
 * Build the user-facing result message from swarm task data.
 * For port-bound tasks, verifies the server is actually listening.
 * No LLM call required — task data already has what we need.
 */
type SynthesisTask = {
  sessionId: string;
  originalTask: string;
  completionSummary: string;
  status: string;
  workdir?: string;
  /**
   * The subagent framework that produced this task's output. `shell` sessions
   * have no `~/.claude/projects/*.jsonl` of their own, so buildTaskLine must
   * skip the jsonl read for them — otherwise the jsonl lookup falls through
   * to whatever claude-code session happens to live under the encoded workdir
   * path (e.g. a shell agent with cwd=/home/milady would end up reading the
   * operator's own claude-code session at ~/.claude/projects/-home-milady/*).
   */
  agentType?: string;
};

async function buildSynthesisResultText(
  payload: { tasks: SynthesisTask[]; total: number },
  runtime: AgentRuntime,
): Promise<string> {
  const parts = await Promise.all(
    payload.tasks.map((task) => buildTaskLine(task, runtime)),
  );
  if (parts.length === 1) return parts[0];
  return `done — ${parts.length} tasks:\n${parts.map((p) => `• ${p}`).join("\n")}`;
}

/**
 * Deliver the subagent's actual final answer — the last end_turn assistant
 * text from its session jsonl. Trust the agent to already have produced
 * a coherent response; synthesis does not rewrite or trim it.
 *
 * Falls back only to a port-status check (for `port NNNN`-style tasks) and
 * finally to an honest placeholder — never to `task.completionSummary`
 * (the validator LLM's analysis paragraph, e.g. "The agent wrote the
 * files, verified with curl, and reported the URL") or `task.originalTask`
 * (echoes the user's original prompt). Both of those were the source of
 * the "why doesn't the bot paste the actual URL" complaint.
 */
async function buildTaskLine(
  task: SynthesisTask,
  runtime: AgentRuntime,
): Promise<string> {
  const workdir =
    task.workdir ?? resolveSessionWorkdir(runtime, task.sessionId);
  // Shell subagents are raw /bin/bash sessions — they don't write a
  // `~/.claude/projects/*.jsonl`. Reading one via the encoded workdir
  // path can cross-contaminate with the operator's own claude-code
  // session (e.g. a shell agent with cwd=/home/milady matches the
  // operator's project dir at ~/.claude/projects/-home-milady/), so
  // for shell agents we skip the jsonl lookup entirely and go
  // straight to the completionSummary fallback below, which is
  // populated from the coordinator's SharedDecision ledger.
  const isShellAgent = task.agentType === "shell" || task.agentType === "pi";
  if (workdir && !isShellAgent) {
    // The PTY task_complete hook fires as soon as claude-code stops, but
    // the session's jsonl flush can lag by a few hundred milliseconds,
    // which races against synthesis. Retry briefly so we deliver the
    // agent's actual end_turn text instead of the honest-fallback.
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const assistantText = await readLastAssistantTextFromJsonl(workdir);
      if (assistantText) return assistantText;
      if (attempt < 3) {
        await new Promise((r) => setTimeout(r, 500));
      }
    }
  }
  const port = task.originalTask.match(/port\s+(\d+)/i)?.[1];
  if (port) {
    if (await isPortServing(port)) {
      const host = process.env.ELIZA_PUBLIC_HOST ?? "localhost";
      return `built and serving at http://${host}:${port}`;
    }
    return `built the files but server isn't running on port ${port} yet`;
  }
  // Last resort: if we have a completionSummary, use it. For reasoning
  // subagents (claude/gemini/codex/etc) the jsonl path above normally
  // fires first, so this doesn't revive the validator-narrative-leaks
  // that motivated removing the completionSummary fallback — reasoning
  // agents have already delivered their real `end_turn` text by the
  // time we get here. For `shell` agents there's no jsonl at all
  // (shell output goes straight to the PTY buffer, not
  // ~/.claude/projects/*.jsonl); the coordinator's per-turn
  // SharedDecision ledger, which feeds completionSummary, is the only
  // recorded output. Without this fallback shell prompts like
  // "what's the vps uptime" would silently return the honest
  // placeholder even when the agent successfully ran the command.
  if (task.completionSummary?.trim()) {
    return task.completionSummary.trim();
  }
  return "task finished but no output was captured — try again.";
}

function resolveSessionWorkdir(
  runtime: AgentRuntime,
  sessionId: string,
): string | null {
  const ptyService = runtime.getService("PTY_SERVICE") as {
    getSession?: (id: string) => { workdir?: string } | undefined;
  } | null;
  return ptyService?.getSession?.(sessionId)?.workdir ?? null;
}

async function isPortServing(port: string): Promise<boolean> {
  try {
    const res = await fetch(`http://localhost:${port}/`, {
      signal: AbortSignal.timeout(2000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Route the synthesis text to the user's platform (Discord, Telegram, etc.)
 * via the runtime's registered send handler. Uses the source room ID stored
 * on the coordinator when the task was created.
 */
async function routeSynthesisToConnector(
  runtime: AgentRuntime,
  resultText: string,
  roomId: string | null,
): Promise<void> {
  if (!roomId) {
    logger.debug(
      "[swarm-synthesis] No roomId available — cannot route to connector",
    );
    return;
  }
  try {
    const room = await runtime.getRoom(roomId as UUID);
    if (!room?.source) {
      logger.debug(
        `[swarm-synthesis] Room ${roomId} has no source connector — cannot route`,
      );
      return;
    }
    await runtime.sendMessageToTarget(
      {
        source: room.source,
        roomId: room.id,
        channelId: room.channelId ?? room.id,
        serverId: room.serverId,
      } as Parameters<typeof runtime.sendMessageToTarget>[0],
      { text: resultText, source: "swarm_synthesis" },
    );
    logger.info(
      `[swarm-synthesis] Routed result to ${room.source} room ${room.id}`,
    );
  } catch (err) {
    logger.warn(`[swarm-synthesis] Connector routing failed: ${err}`);
  }
}

import {
  chunkForDiscord,
  readLastAssistantTextFromJsonl,
} from "../runtime/subagent-output.js";
// ── Parse Action Block from Eliza's Response ─────────────────────────
import {
  parseActionBlock,
  stripActionBlockFromDisplay,
} from "./parse-action-block.js";

// ── Coordinator Event Routing ───────────────────────────────────────────

/**
 * Wire the SwarmCoordinator's agentDecisionCallback so coordinator events
 * (blocked prompts, turn completions) route through Eliza's full
 * elizaOS pipeline (memory, personality, actions) so she has conversation
 * context to make informed decisions. The pipeline's model size is
 * The pipeline's model size is temporarily overridden to TEXT_SMALL
 * via the private `runtime.llmModeOption` (no public setter exists).
 * This is intentional — coordinator decisions must be fast to avoid
 * stalling CLI agents waiting for input.
 *
 * Events are serialized (one at a time) to prevent context confusion.
 * Eliza's response appears in chat via WS broadcast, and the embedded
 * JSON action block is parsed and returned to the coordinator for execution.
 *
 * If the callback fails or Eliza's response has no action block,
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
          const agentName = runtime.character.name ?? "Eliza";
          const existingLegacyChatRoom = st.chatRoomId
            ? await runtime.getRoom(st.chatRoomId).catch(() => null)
            : null;
          if (!st.chatUserId || !st.chatRoomId || !existingLegacyChatRoom) {
            const adminId = resolveClientChatAdminEntityId(st);
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
              userName: resolveAppUserName(st.config),
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

          // Create a message memory so the event enters Eliza's conversation history.
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
            result = await generateChatResponseFromChatRoutes(
              runtime,
              message,
              agentName,
              {
                resolveNoResponseText: () => "I'll look into that.",
              },
            );
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
 * Uses the orchestrator plugin's CODE_TASK compatibility service to
 * provide task data.
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
    auth?: import("@elizaos/app-task-coordinator/api/coding-agents-preflight-normalize").NormalizedPreflightAuth;
  };
  /** CLI login hook on adapter instances — union `.d.ts` omits it even when runtime provides it. */
  type CodingAgentAdapterAuthHook = {
    triggerAuth?: () => Promise<
      | boolean
      | null
      | undefined
      | {
          launched?: boolean;
          url?: string;
          deviceCode?: string;
          instructions?: string;
        }
    >;
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

  const buildEmptyCoordinatorStatus = () => ({
    supervisionLevel: "autonomous",
    taskCount: 0,
    tasks: [] as Array<Record<string, unknown>>,
    recentTasks: [] as Array<Record<string, unknown>>,
    taskThreadCount: 0,
    taskThreads: [] as Array<Record<string, unknown>>,
    pendingConfirmations: 0,
    frameworks: [] as Array<Record<string, unknown>>,
  });

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
  const parseTaskId = (raw: string): string | null => {
    let taskId = "";
    try {
      taskId = decodeURIComponent(raw);
    } catch {
      return null;
    }
    if (!taskId || taskId.includes("/") || taskId.includes("..")) {
      return null;
    }
    return taskId;
  };
  const ptyListService = runtime.getService("PTY_SERVICE") as
    | (PTYService & {
        listSessions?: () => Promise<unknown[]>;
      })
    | null;

  // GET /api/coding-agents/tasks
  if (method === "GET" && pathname === "/api/coding-agents/tasks") {
    if (!codeTaskService?.getTasks) {
      error(res, "Coding agent task service unavailable", 503);
      return true;
    }
    try {
      const url = new URL(req.url ?? pathname, "http://localhost");
      const requestedStatus = url.searchParams.get("status");
      const requestedLimit = Number(url.searchParams.get("limit"));
      let tasks = (await codeTaskService.getTasks()) ?? [];
      if (!Array.isArray(tasks)) {
        tasks = [];
      }
      if (requestedStatus) {
        tasks = tasks.filter(
          (task) => task.metadata?.status === requestedStatus,
        );
      }
      if (Number.isFinite(requestedLimit) && requestedLimit > 0) {
        tasks = tasks.slice(0, requestedLimit);
      }
      json(res, { tasks });
      return true;
    } catch (e) {
      error(res, `Failed to list coding agent tasks: ${e}`, 500);
      return true;
    }
  }

  const taskMatch = pathname.match(/^\/api\/coding-agents\/tasks\/([^/]+)$/);
  if (method === "GET" && taskMatch) {
    const taskId = parseTaskId(taskMatch[1]);
    if (!taskId) {
      error(res, "Invalid task ID", 400);
      return true;
    }
    if (!codeTaskService?.getTasks) {
      error(res, "Coding agent task service unavailable", 503);
      return true;
    }
    try {
      const tasks = (await codeTaskService.getTasks()) ?? [];
      const task = Array.isArray(tasks)
        ? tasks.find((entry) => entry.id === taskId)
        : undefined;
      if (!task) {
        error(res, "Task not found", 404);
        return true;
      }
      json(res, { task });
      return true;
    } catch (e) {
      error(res, `Failed to get coding agent task: ${e}`, 500);
      return true;
    }
  }

  // GET /api/coding-agents/sessions
  if (method === "GET" && pathname === "/api/coding-agents/sessions") {
    if (!ptyListService?.listSessions) {
      error(res, "Coding agent session service unavailable", 503);
      return true;
    }
    try {
      const sessions = (await ptyListService.listSessions()) ?? [];
      json(res, { sessions: Array.isArray(sessions) ? sessions : [] });
      return true;
    } catch (e) {
      error(res, `Failed to list coding agent sessions: ${e}`, 500);
      return true;
    }
  }

  const sessionMatch = pathname.match(
    /^\/api\/coding-agents\/sessions\/([^/]+)$/,
  );
  if (method === "GET" && sessionMatch) {
    const sessionId = parseSessionId(sessionMatch[1]);
    if (!sessionId) {
      error(res, "Invalid session ID", 400);
      return true;
    }
    if (!ptyListService?.listSessions) {
      error(res, "Coding agent session service unavailable", 503);
      return true;
    }
    try {
      const sessions = (await ptyListService.listSessions()) ?? [];
      const session = Array.isArray(sessions)
        ? sessions.find((entry) => {
            if (!entry || typeof entry !== "object") return false;
            const raw = entry as Record<string, unknown>;
            return (
              raw.id === sessionId ||
              raw.sessionId === sessionId ||
              raw.roomId === sessionId
            );
          })
        : undefined;
      if (!session) {
        error(res, "Session not found", 404);
        return true;
      }
      json(res, { session });
      return true;
    } catch (e) {
      error(res, `Failed to get coding agent session: ${e}`, 500);
      return true;
    }
  }

  // GET /api/coding-agents/preflight
  if (method === "GET" && pathname === "/api/coding-agents/preflight") {
    const loaders: Array<(() => Promise<unknown>) | undefined> = [
      codeTaskService?.getAgentPreflight,
      codeTaskService?.listAgentPreflight,
      codeTaskService?.preflightCodingAgents,
      codeTaskService?.preflight,
    ];
    if (!loaders.some(Boolean)) {
      error(res, "Coding agent preflight unavailable", 503);
      return true;
    }
    try {
      let rows: unknown[] = [];
      for (const loader of loaders) {
        if (!loader) continue;
        const maybeRows = await loader.call(codeTaskService);
        if (Array.isArray(maybeRows)) {
          rows = maybeRows;
          break;
        }
      }
      const { normalizePreflightAuth } = await import(
        "@elizaos/app-task-coordinator/api/coding-agents-preflight-normalize"
      );
      const normalized = rows.flatMap((item): AgentPreflightRecord[] => {
        if (!item || typeof item !== "object") return [];
        const raw = item as Record<string, unknown>;
        const adapter =
          typeof raw.adapter === "string" ? raw.adapter.trim() : "";
        if (!adapter) return [];
        const auth = normalizePreflightAuth(raw.auth);
        return [
          {
            adapter,
            installed: Boolean(raw.installed),
            installCommand:
              typeof raw.installCommand === "string"
                ? raw.installCommand
                : undefined,
            docsUrl: typeof raw.docsUrl === "string" ? raw.docsUrl : undefined,
            ...(auth ? { auth } : {}),
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
      error(res, "Coding agent coordinator unavailable", 503);
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
        ...buildEmptyCoordinatorStatus(),
        taskCount: mappedTasks.length,
        tasks: mappedTasks,
        recentTasks: mappedTasks,
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
    const loaders: Array<(() => Promise<unknown>) | undefined> = [
      codeTaskService?.listScratchWorkspaces,
      codeTaskService?.getScratchWorkspaces,
      codeTaskService?.listScratch,
    ];
    if (!loaders.some(Boolean)) {
      error(res, "Coding agent scratch workspace service unavailable", 503);
      return true;
    }
    try {
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

  // GET /api/coding-agents — list active PTY sessions (used by getCodingAgentStatus fallback)
  if (method === "GET" && pathname === "/api/coding-agents") {
    if (!codeTaskService?.getTasks) {
      error(res, "Coding agent task service unavailable", 503);
      return true;
    }
    try {
      const tasks = await codeTaskService.getTasks();
      json(res, Array.isArray(tasks) ? tasks : []);
      return true;
    } catch (e) {
      error(res, `Failed to list coding agents: ${e}`, 500);
      return true;
    }
  }

  // POST /api/coding-agents/auth/:agent — trigger CLI auth flow
  const authMatch = pathname.match(/^\/api\/coding-agents\/auth\/(\w+)$/);
  if (method === "POST" && authMatch) {
    const agentType = authMatch[1];
    // Allowlist the adapter type. The `\w+` regex on the route pattern
    // stops path traversal but still accepts arbitrary identifiers
    // like `__proto__`, `constructor`, or any future adapter name the
    // package happens to export. `createAdapter` takes an unvalidated
    // string and we don't want it to resolve a prototype-pollution
    // sentinel or an adapter we haven't audited, so gate on the four
    // shapes the UI actually ships today.
    const ALLOWED_AGENT_TYPES = new Set(["claude", "codex", "gemini", "aider"]);
    if (!ALLOWED_AGENT_TYPES.has(agentType)) {
      error(res, `Unsupported agent type: ${agentType}`, 400);
      return true;
    }
    try {
      const ptyService = runtime.getService("PTY_SERVICE") as {
        triggerAgentAuth?: (
          agent: import("coding-agent-adapters").AdapterType,
        ) => Promise<unknown>;
      } | null;
      const triggerAuthFn =
        typeof ptyService?.triggerAgentAuth === "function"
          ? () =>
              ptyService.triggerAgentAuth?.(
                agentType as import("coding-agent-adapters").AdapterType,
              )
          : null;
      if (!triggerAuthFn) {
        const { createAdapter } = await import("coding-agent-adapters");
        const adapter = createAdapter(
          agentType as import("coding-agent-adapters").AdapterType,
        );
        const authAdapter = adapter as unknown as CodingAgentAdapterAuthHook;
        if (typeof authAdapter.triggerAuth !== "function") {
          error(res, `Auth trigger is unavailable for ${agentType}`, 501);
          return true;
        }
      }
      // Server-side timeout: some CLI auth flows spawn an interactive
      // subprocess that can hang indefinitely in headless / Docker
      // environments. Cap the wait so we don't pin an async for
      // longer than the client is willing to poll.
      const AUTH_TIMEOUT_MS = 15_000;
      const timeoutError = new Error("auth trigger timeout");
      const triggered = await Promise.race([
        triggerAuthFn
          ? triggerAuthFn()
          : (
              (await import("coding-agent-adapters")).createAdapter(
                agentType as import("coding-agent-adapters").AdapterType,
              ) as unknown as CodingAgentAdapterAuthHook
            ).triggerAuth?.(),
        new Promise((_, reject) =>
          setTimeout(() => reject(timeoutError), AUTH_TIMEOUT_MS),
        ),
      ]).catch((e) => {
        if (e === timeoutError) return "__timeout__" as const;
        throw e;
      });
      if (triggered === "__timeout__") {
        error(res, `Auth trigger timed out for ${agentType}`, 504);
      } else if (!triggered) {
        // 4xx — otherwise the client's `res.ok` check passes and it
        // kicks off a 2-minute spurious polling loop even though no
        // auth flow was ever initiated.
        error(res, `No auth flow available for ${agentType}`, 400);
      } else {
        // Whitelist + URL-scheme-validate before forwarding to the
        // browser. See `coding-agents-auth-sanitize.ts` for rationale.
        const { sanitizeAuthResult } = await import(
          "@elizaos/app-task-coordinator/api/coding-agents-auth-sanitize"
        );
        json(res, sanitizeAuthResult(triggered));
      }
    } catch (e) {
      // Log the full error server-side for debugging (including stack
      // trace) but return a generic message to the client so we don't
      // leak internal adapter error strings through the HTTP surface.
      logger.error(
        `[coding-agents/auth] triggerAuth failed for ${agentType}: ${
          e instanceof Error ? (e.stack ?? e.message) : String(e)
        }`,
      );
      error(res, `Auth trigger failed for ${agentType}`, 500);
    }
    return true;
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
  const ptyService = st.runtime.getService("PTY_SERVICE") as PTYService | null;
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
  const dropService = state.dropService;

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

  if (
    isCloudProvisioned &&
    method !== "OPTIONS" &&
    isAuthProtectedPath &&
    !isAuthEndpoint &&
    !isHealthEndpoint &&
    !isCloudOnboardingStatusEndpoint &&
    !isWhatsAppWebhookEndpoint &&
    !isBlueBubblesWebhookEndpoint &&
    !pathname.startsWith("/api/lifeops/browser/companions/") &&
    !isAuthorized(req)
  ) {
    json(res, { error: "Unauthorized" }, 401);
    return;
  }

  if (
    method !== "OPTIONS" &&
    isAuthProtectedPath &&
    !isAuthEndpoint &&
    !isHealthEndpoint &&
    !isCloudOnboardingStatusEndpoint &&
    !isWhatsAppWebhookEndpoint &&
    !isBlueBubblesWebhookEndpoint &&
    !pathname.startsWith("/api/lifeops/browser/companions/") &&
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
        if (await stewardWalletCoreRoutes(req, res, state)) {
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

  // ═══════════════════════════════════════════════════════════════════════
  //  Drop / Mint / Whitelist Routes (extracted to drop-routes.ts)
  // ═══════════════════════════════════════════════════════════════════════
  if (
    await handleDropRoutes({
      req,
      res,
      method,
      pathname,
      url,
      json,
      error,
      readJsonBody,
      dropService,
      agentName: state.agentName,
      getWalletAddresses:
        coerce<DropRouteArg["getWalletAddresses"]>(getWalletAddresses),
      readOGCodeFromState,
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

  // ── Unified inbox routes (/api/inbox/*) ───────────────────────────────
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
  if (pathname === "/api/config" || pathname === "/api/config/schema") {
    if (
      await handleConfigRoutes({
        req,
        res,
        method,
        pathname,
        url,
        config: state.config,
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

  // ── Cloud routes (/api/cloud/*) ─────────────────────────────────────────
  if (pathname.startsWith("/api/cloud/")) {
    // Cloud-managed feature flag sync — must run before the generic
    // cloud passthrough so /api/cloud/features hits the local upserter.
    const featuresHandled = await handleCloudFeaturesRoute(
      req,
      res,
      pathname,
      method,
      { config: state.config, runtime: state.runtime },
    );
    if (featuresHandled) return;

    // Duffel travel relay — must run before the generic cloud passthrough
    // so the upstream Duffel + billing path is hit, not the bare cloud
    // proxy that would land on /api/v1/duffel/* with no markup logic.
    const duffelHandled = await handleDuffelRelayRoute(
      req,
      res,
      pathname,
      method,
      { config: state.config, runtime: state.runtime },
    );
    if (duffelHandled) return;

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

  const broadcastWs = (payload: object): void => {
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

  /** Hot-swap the runtime reference (used after an in-process restart). */
  const updateRuntime = (rt: AgentRuntime): void => {
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
