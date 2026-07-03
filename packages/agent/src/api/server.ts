/**
 * REST API server for the Eliza Control UI.
 *
 * Exposes HTTP endpoints that the UI frontend expects, backed by the
 * elizaOS AgentRuntime. Default port: 2138. In dev mode, the Vite UI
 * dev server proxies /api and /ws here (see eliza/packages/app-core/scripts/dev-ui.mjs).
 */

import crypto from "node:crypto";
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
const MAX_BACKUP_BODY_BYTES = 128 * 1024 * 1024; // 128 MB

import path from "node:path";
import {
  type AgentRuntime,
  type IAgentRuntime,
  isStreamingDestinationConfigured,
  logger,
  NotificationService,
  readJsonBody as parseJsonBody,
  type ReadJsonBodyOptions,
  type Route,
  readRequestBody,
  ServiceType,
  sendJson,
  sendJsonError,
  stringToUuid,
  tryHandleTrajectoryReadRoutes,
  type UUID,
} from "@elizaos/core";
import type {
  AppManagerLike,
  AppsRouteActorRole,
  FavoriteAppsStore,
} from "@elizaos/plugin-app-manager";
import type { WalletRouteDependencies } from "@elizaos/plugin-wallet";
import {
  getStylePresets,
  normalizeCharacterLanguage,
} from "@elizaos/shared/character-presets";
import {
  isMobilePlatform,
  resolveApiBindHost,
  resolveDesktopApiPort,
  resolveServerOnlyPort,
} from "@elizaos/shared/runtime-env";
import { parseClampedInteger } from "@elizaos/shared/utils/number-parsing";
import { type WebSocket, WebSocketServer } from "ws";
import { installPlugin as installPluginDirect } from "../services/plugin-installer.ts";
import { handlePluginDirectoryRoutes } from "./plugin-directory-routes.ts";

// `@elizaos/plugin-browser` and `@elizaos/plugin-x402` were previously
// imported via module-scope top-level await, which forced both plugins to
// load (and pulled their transitive native deps) whenever anything imported
// `@elizaos/agent`. That blocked container boot in cloud sandboxes. They are
// now lazily loaded. X402 is loaded only when runtime routes need validation;
// browser is loaded on first browser route hit so neither gates API bind.
type BrowserPluginModule = typeof import("@elizaos/plugin-browser");
type X402PluginModule = typeof import("@elizaos/plugin-x402");

let browserPluginModule: BrowserPluginModule | null = null;
let x402PluginModule: X402PluginModule | null = null;
let browserPluginModulePromise: Promise<BrowserPluginModule> | null = null;
let x402PluginModulePromise: Promise<X402PluginModule | null> | null = null;

// Vite 7's import-analysis eagerly resolves string-literal dynamic imports even
// when a `@vite-ignore` comment is present, throwing "Failed to resolve entry"
// for the optional plugins below whose dist isn't built in the unit Plugin
// Tests lane (any spec that transitively transforms this file then fails to
// collect). Funnel optional plugin loads through a variable specifier so the
// analyzer leaves them as pure runtime imports — the host resolves them from
// node_modules on demand. Mirrors the variable-specifier bundle loader further
// down this file.
function importOptionalPlugin<T = unknown>(specifier: string): Promise<T> {
  return import(/* @vite-ignore */ specifier) as Promise<T>;
}

async function getBrowserPlugin(): Promise<BrowserPluginModule> {
  if (browserPluginModule) return browserPluginModule;
  browserPluginModulePromise ??= importOptionalPlugin<BrowserPluginModule>(
    "@elizaos/plugin-browser",
  ).then((browser) => {
    browserPluginModule = browser;
    return browser;
  });
  return browserPluginModulePromise;
}

// On mobile the agent bundle aliases `@elizaos/plugin-browser` to a null-stub
// (scripts/mobile-stubs/null-plugin.cjs): the module imports fine but its
// workspace functions are absent, so calling one throws an uncaught TypeError
// that surfaces as a 500 (and a raw "X is not a function" in the /browser view).
// The browser workspace is desktop-only, so resolve the plugin only when it
// really implements the requested method and let callers serve an empty payload
// otherwise.
async function resolveDesktopBrowserPlugin(
  method: keyof BrowserPluginModule,
): Promise<BrowserPluginModule | null> {
  if (isMobilePlatform()) return null;
  const browserPlugin = await getBrowserPlugin();
  if ((browserPlugin as { __mobileStub?: boolean }).__mobileStub) return null;
  return typeof browserPlugin[method] === "function" ? browserPlugin : null;
}

function getBrowserWorkspacePlugin(): Promise<BrowserPluginModule | null> {
  return resolveDesktopBrowserPlugin("getBrowserWorkspaceSnapshot");
}

function getBrowserBridgePlugin(): Promise<BrowserPluginModule | null> {
  return resolveDesktopBrowserPlugin("getBrowserBridgeCompanionPackageStatus");
}

const EMPTY_BROWSER_BRIDGE_PACKAGE_STATUS = {
  extensionPath: null,
  chromeBuildPath: null,
  chromePackagePath: null,
  safariWebExtensionPath: null,
  safariAppPath: null,
  safariPackagePath: null,
  releaseManifest: null,
} satisfies ReturnType<
  BrowserPluginModule["getBrowserBridgeCompanionPackageStatus"]
>;

async function getX402Plugin(): Promise<X402PluginModule | null> {
  if (x402PluginModule) return x402PluginModule;
  // x402 is desktop/cloud-only; on mobile it is not in the agent bundle, so the
  // "optional" dynamic import REJECTS (no node_modules). Treat a missing module
  // as "no x402" instead of letting the rejection crash API-server startup —
  // `importOptionalPlugin` is named optional but does not itself swallow.
  x402PluginModulePromise ??= importOptionalPlugin<X402PluginModule>(
    "@elizaos/plugin-x402",
  )
    .then((x402) => {
      x402PluginModule = x402;
      return x402;
    })
    .catch(() => null);
  return x402PluginModulePromise;
}

const optionalPluginImports = {
  capacitor: () => importOptionalPlugin("@elizaos/plugin-capacitor-bridge"),
  computerUse: () => importOptionalPlugin("@elizaos/plugin-computeruse"),
  cloud: () => importOptionalPlugin("@elizaos/plugin-elizacloud"),
  imessage: () => importOptionalPlugin("@elizaos/plugin-imessage"),
  mcp: () => importOptionalPlugin("@elizaos/plugin-mcp"),
  signal: () => importOptionalPlugin("@elizaos/plugin-signal"),
  streaming: () => importOptionalPlugin("@elizaos/plugin-streaming"),
  whatsapp: () => importOptionalPlugin("@elizaos/plugin-whatsapp"),
  workflow: () => importOptionalPlugin("@elizaos/plugin-workflow"),
};

type LocalInferenceServerApi = {
  getLocalInferenceActiveModelId: () => string | undefined;
  handleLocalInferenceRoutes: (
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ) => Promise<boolean>;
  handleLocalInferenceTtsRoute?: (
    req: http.IncomingMessage,
    res: http.ServerResponse,
    state: { current: AgentRuntime | null },
  ) => Promise<boolean>;
  handleLocalInferenceAsrRoute?: (
    req: http.IncomingMessage,
    res: http.ServerResponse,
    state: { current: AgentRuntime | null },
  ) => Promise<boolean>;
  handleLiveDiarizationRoute?: (
    req: http.IncomingMessage,
    res: http.ServerResponse,
    state: { current: AgentRuntime | null },
  ) => Promise<boolean>;
};

let localInferenceServerApiPromise: Promise<LocalInferenceServerApi> | null =
  null;

function getLocalInferenceServerApi(): Promise<LocalInferenceServerApi> {
  // Import the route modules directly, NOT the package's bare entry: the mobile
  // agent bundle stubs `@elizaos/plugin-local-inference` (the heavy Plugin entry)
  // to a null module, so a bare import yields undefined handlers and every
  // /api/local-inference/* route 404s on-device. The deep subpaths (the `./*`
  // wildcard + `./routes` exports) aren't stubbed and carry the real impls on
  // every platform.
  localInferenceServerApiPromise ??=
    (async (): Promise<LocalInferenceServerApi> => {
      const [routes, ttsRoutes] = await Promise.all([
        import(
          /* @vite-ignore */ "@elizaos/plugin-local-inference/local-inference-routes"
        ) as Promise<
          Pick<
            LocalInferenceServerApi,
            "getLocalInferenceActiveModelId" | "handleLocalInferenceRoutes"
          >
        >,
        import(
          /* @vite-ignore */ "@elizaos/plugin-local-inference/routes"
        ) as Promise<
          Pick<
            LocalInferenceServerApi,
            | "handleLocalInferenceTtsRoute"
            | "handleLocalInferenceAsrRoute"
            | "handleLiveDiarizationRoute"
          >
        >,
      ]);
      return {
        getLocalInferenceActiveModelId: routes.getLocalInferenceActiveModelId,
        handleLocalInferenceRoutes: routes.handleLocalInferenceRoutes,
        handleLocalInferenceTtsRoute: ttsRoutes.handleLocalInferenceTtsRoute,
        handleLocalInferenceAsrRoute: ttsRoutes.handleLocalInferenceAsrRoute,
        handleLiveDiarizationRoute: ttsRoutes.handleLiveDiarizationRoute,
      };
    })().catch((err: unknown) => {
      // A cold-boot import failure must not poison the memoized promise: `??=`
      // would otherwise cache the rejection and 404 EVERY /api/local-inference/*
      // route for the lifetime of the process. Clear the memo so the next request
      // retries once the deferred plugin closure is resolvable.
      localInferenceServerApiPromise = null;
      throw err;
    });
  return localInferenceServerApiPromise;
}

async function getOptionalPluginApi<T>(
  key: keyof typeof optionalPluginImports,
): Promise<T> {
  try {
    return (await optionalPluginImports[key]()) as T;
  } catch (err) {
    // The plugin is optional and not in this bundle (on mobile, many
    // desktop/cloud plugins — cloud, whatsapp, wallet-adjacent, mcp,
    // streaming, … — are excluded). Its dynamic import REJECTS with a
    // ResolveMessage; without this catch that rejection propagates to the
    // top-level request handler as a 500 on EVERY renderer poll of the
    // plugin's routes. Return a Proxy of no-op handlers so route-dispatch
    // blocks (`if (await handleX(...)) return;`) fall through to the normal
    // 404/fallback instead of erroring. On desktop/server the import succeeds,
    // so this branch never runs there.
    logger.debug(
      `[eliza-api] optional plugin '${key}' unavailable in this bundle: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return new Proxy(
      {},
      {
        get: () => () => false,
      },
    ) as T;
  }
}
type BrowserBridgeKind = BrowserPluginModule["BROWSER_BRIDGE_KINDS"][number];
type BrowserBridgePackagePathTarget =
  BrowserPluginModule["BROWSER_BRIDGE_PACKAGE_PATH_TARGETS"][number];
type BrowserWorkspaceCommand = Parameters<
  BrowserPluginModule["executeBrowserWorkspaceCommand"]
>[0];
type BrowserWorkspaceTabKind = NonNullable<
  Parameters<BrowserPluginModule["openBrowserWorkspaceTab"]>[0]["kind"]
>;

let agentSkillsApiPromise:
  | Promise<typeof import("@elizaos/plugin-agent-skills")>
  | undefined;
function getAgentSkillsApi(): Promise<
  typeof import("@elizaos/plugin-agent-skills")
> {
  agentSkillsApiPromise ??= import(
    /* @vite-ignore */ "@elizaos/plugin-agent-skills"
  );
  return agentSkillsApiPromise;
}

let appManagerApiPromise:
  | Promise<typeof import("@elizaos/plugin-app-manager")>
  | undefined;
function getAppManagerApi(): Promise<
  typeof import("@elizaos/plugin-app-manager")
> {
  appManagerApiPromise ??= import(
    /* @vite-ignore */ "@elizaos/plugin-app-manager"
  );
  return appManagerApiPromise;
}

let walletApiPromise:
  | Promise<typeof import("@elizaos/plugin-wallet")>
  | undefined;
function getWalletApi(): Promise<typeof import("@elizaos/plugin-wallet")> {
  walletApiPromise ??= importOptionalPlugin<
    typeof import("@elizaos/plugin-wallet")
  >("@elizaos/plugin-wallet").catch((err) => {
    // plugin-wallet is desktop/cloud-only; on mobile it is not in the bundle so
    // this import REJECTS. Cache a no-op proxy so /api/wallet/* falls through to
    // 404 instead of 500ing on every renderer poll. Desktop imports succeed, so
    // this never runs there.
    logger.debug(
      `[eliza-api] plugin-wallet unavailable in this bundle: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return new Proxy(
      {},
      { get: () => () => false },
    ) as typeof import("@elizaos/plugin-wallet");
  });
  return walletApiPromise;
}

let coreWalletApiPromise: Promise<typeof import("./wallet.ts")> | undefined;
function getCoreWalletApi(): Promise<typeof import("./wallet.ts")> {
  coreWalletApiPromise ??= import("./wallet.ts");
  return coreWalletApiPromise;
}

let pluginRegistryApiPromise:
  | Promise<typeof import("@elizaos/plugin-registry/api/plugin-routes")>
  | undefined;

function getPluginRegistryApi(): Promise<
  typeof import("@elizaos/plugin-registry/api/plugin-routes")
> {
  pluginRegistryApiPromise ??= import(
    /* @vite-ignore */ "@elizaos/plugin-registry/api/plugin-routes"
  );
  return pluginRegistryApiPromise;
}

import { walletDiagnosticDescriptor } from "@elizaos/plugin-wallet/diagnostic";
import {
  type ElizaConfig,
  loadElizaConfig,
  saveElizaConfig,
} from "../config/config.ts";
import { isCloudWalletEnabled } from "../config/feature-flags.ts";
import { resolveModelsCacheDir, resolveStateDir } from "../config/paths.ts";
import { CharacterSchema } from "../config/zod-schema.ts";
import { createIntegrationTelemetrySpan } from "../diagnostics/integration-observability.ts";
import {
  type AgentEventServiceLike,
  getAgentEventService,
} from "../runtime/agent-event-service.ts";
import { getAgentHostBridge } from "../runtime/host-bridge.ts";
import {
  resolvePreferredProviderId,
  resolvePrimaryModel,
} from "../runtime/model-resolution.ts";
import {
  type ClassifyContext,
  createColdStrategy,
  createHotStrategy,
  DefaultRuntimeOperationManager,
  defaultClassifier,
  getDefaultHealthChecker,
  getDefaultRepository,
  type RuntimeOperationManager,
} from "../runtime/operations/index.ts";
import { classifyRegistryPluginRelease } from "../runtime/release-plugin-policy.ts";
import {
  AUDIT_EVENT_TYPES,
  AUDIT_SEVERITIES,
  getAuditFeedSize,
  queryAuditFeed,
  subscribeAuditFeed,
} from "../security/audit-log.ts";
import {
  type AgentBackupStateData,
  createAgentSnapshot,
  createLocalAgentBackup,
  listLocalAgentBackups,
  restoreAgentSnapshot,
  restoreLocalAgentBackup,
} from "../services/agent-backup.ts";
import {
  AgentExportError,
  estimateExportSize,
  exportAgent,
  importAgent,
} from "../services/agent-export.ts";
import { registerClientChatSendHandler } from "../services/client-chat-sender.ts";
import { createConfigPluginManager } from "../services/config-plugin-manager.ts";
import {
  type CoreManagerLike,
  isCoreManagerLike,
  isPluginManagerLike,
  type PluginManagerLike,
} from "../services/plugin-manager-types.ts";
import {
  PROACTIVE_INTERACTION_SOURCE,
  type ProactiveOffer,
  registerProactiveInteractionDecider,
} from "../services/proactive-interaction-decider.ts";
import { ProactiveInteractionGate } from "../services/proactive-interaction-gate.ts";
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
} from "../triggers/runtime.ts";
import {
  buildTriggerConfig,
  buildTriggerMetadata,
  DISABLED_TRIGGER_INTERVAL_MS,
  normalizeTriggerDraft,
} from "../triggers/scheduling.ts";
import { detectRuntimeModel, resolveProviderFromModel } from "./agent-model.ts";
import { persistConfigEnv } from "./config-env.ts";
import { wireCoordinatorBridgesWhenReady } from "./coordinator-wiring.ts";
import { createDeliveryDedupeState } from "./delivery-dedupe.ts";
import { computeCanRespond } from "./health-routes.ts";
import { pushWithBatchEvict } from "./memory-bounds.ts";
import {
  buildPluginDiagnosticEntry,
  resolveWalletDiagnosticStatus,
} from "./plugin-diagnostic.ts";
import { createRuntimeReadyGate } from "./runtime-ready-gate.ts";
import {
  cloneWithoutBlockedObjectKeys,
  decodePathComponent,
  hasPersistedFirstRunState,
  isUuidLike,
  patchTouchesProviderSelection,
  resolveMirroredAvatarPresetId,
} from "./server-helpers.ts";
import { routeAutonomyTextToUser as routeProactiveText } from "./server-helpers-swarm.ts";
import {
  createConnectorHealthMonitor,
  extractConversationMetadataFromRoom,
  handleAccountsRoutes,
  handleAgentAdminRoutes,
  handleAgentLifecycleRoutes,
  handleAgentStatusRoutes,
  handleAgentTransferRoutes,
  handleAppPackageRoutes,
  handleAuthRoutes,
  handleAvatarRoutes,
  handleBackgroundTasksRoute,
  handleBugReportRoutes,
  handleCharacterRoutes,
  handleCloudAndCoreRouteGroup,
  handleCommandsRoutes,
  handleConfigRoutes,
  handleConnectorRoutes,
  handleConversationRouteGroup,
  handleDatabaseRouteGroup,
  handleDiagnosticsRoutes,
  handleFirstRunRoutes,
  handleHealthRoutes,
  handleInboxAndCloudRelayRouteGroup,
  handleInteractionsRoutes,
  handleLifeOpsRuntimePluginRoute,
  handleMemoryRoutes,
  handleMiscRoutes,
  handleMobileOptionalRoutes,
  handleModelsRoutes,
  handlePermissionRoutes,
  handlePermissionsExtraRoutes,
  handleProviderSwitchRoutes,
  handleRegistryRoutes,
  handleRelationshipsRoutes,
  handleRemoteCapabilityRoutes,
  handleSandboxRouteGroup,
  handleSubscriptionRoutes,
  handleSuggestionsRoutes,
  handleUpdateRoutes,
  handleViewsRoutes,
  handleWorkbenchRoutes,
  isPublicRuntimePluginRoute,
  registerBuiltinViews,
  tryHandleHonoRuntimeRoute,
  tryHandleLifeOpsInboxFallbackLazy,
  tryHandleMusicPlayerStatusFallbackLazy,
  tryHandleRuntimePluginRoute,
} from "./server-lazy-routes.ts";
import {
  EVM_PLUGIN_PACKAGE,
  resolveWalletAutomationMode as resolveAgentAutomationModeFromConfig,
  resolveWalletCapabilityStatus,
} from "./wallet-capability.ts";
import {
  applyWalletRpcConfigUpdate,
  getStoredWalletRpcSelections,
  resolveWalletNetworkMode,
  resolveWalletRpcReadiness,
} from "./wallet-rpc.ts";
import {
  DEFAULT_REPLAY_LIMIT,
  parseEventCursor,
  selectReplayEvents,
} from "./ws-event-replay.ts";
import { runtimeRoutesNeedX402Validation } from "./x402-route-validation.ts";

export {
  executeFallbackParsedActions,
  type FallbackParsedAction,
  maybeHandleDirectBinanceSkillRequest,
  parseFallbackActionBlocks,
} from "./binance-skill-helpers.ts";

type FirstRunRouteArg = Parameters<typeof handleFirstRunRoutes>[0];
type AgentStatusRouteArg = Parameters<typeof handleAgentStatusRoutes>[0];
type TtsRouteArg = {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  method: string;
  pathname: string;
  state: ServerState;
  json: (res: http.ServerResponse, data: unknown, status?: number) => void;
  error: (res: http.ServerResponse, message: string, status?: number) => void;
  readJsonBody: typeof readJsonBody;
  isRedactedSecretValue: (value: unknown) => boolean;
  fetchWithTimeoutGuard: typeof fetchWithTimeoutGuard;
  streamResponseBodyWithByteLimit: typeof streamResponseBodyWithByteLimit;
  responseContentLength: typeof responseContentLength;
  isAbortError: typeof isAbortError;
  ELEVENLABS_FETCH_TIMEOUT_MS: number;
  ELEVENLABS_AUDIO_MAX_BYTES: number;
};
type PermissionsExtraRouteArg = Parameters<
  typeof handlePermissionsExtraRoutes
>[0];
type WorkbenchRouteArg = Parameters<typeof handleWorkbenchRoutes>[0];
type MiscRouteArg = Parameters<typeof handleMiscRoutes>[0];

export {
  isClientVisibleNoResponse,
  isNoResponsePlaceholder,
  stripAssistantStageDirections,
} from "./chat-text-helpers.ts";

export {
  cloneWithoutBlockedObjectKeys,
  decodePathComponent,
  findOwnPackageRoot,
  getErrorMessage,
  isUuidLike,
  persistConversationRoomTitle,
} from "./server-helpers.ts";

import {
  getInventoryProviderOptions,
  getModelOptions,
  getOrFetchAllProviders,
  getOrFetchProvider,
  paramKeyToCategory,
  providerCachePath,
  readProviderCache,
} from "./model-provider-helpers.ts";
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
} from "./plugin-discovery-helpers.ts";

const _nodeRequire = createRequire(import.meta.url);

// Re-export for downstream consumers (e.g. @elizaos/app-core)
export {
  AGENT_EVENT_ALLOWED_STREAMS,
  CONFIG_WRITE_ALLOWED_TOP_KEYS,
  discoverInstalledPlugins,
  discoverPluginsFromManifest,
  findPrimaryEnvKey,
  readBundledPluginPackageMetadata,
} from "./plugin-discovery-helpers.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

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
 * The runtime plugin manager's registry client only fetches from GitHub and
 * scans a `plugins/` dir for `elizaos.plugin.json`. Workspace-vendored plugins
 * (under `packages/plugin-*`) are invisible to it. Wrap `installPlugin` so that
 * when it returns "not found in the registry" we retry using our own
 * registry-client (which discovers workspace packages and node_modules symlinks).
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
    const { getPluginInfo } = await import("../services/registry-client.ts");
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

export type {
  AgentStartupDiagnostics,
  ConversationMeta,
  LogEntry,
  ServerState,
  ShareIngestItem,
  SkillEntry,
  StreamEventEnvelope,
  StreamEventType,
} from "./server-types.ts";

import {
  fetchWithTimeoutGuard as _fetchWithTimeoutGuard,
  streamResponseBodyWithByteLimit as _streamResponseBodyWithByteLimit,
  isAbortError,
  responseContentLength,
} from "./server-helpers-fetch.ts";
import type {
  AgentStartupDiagnostics,
  ServerState,
  StreamEventEnvelope,
} from "./server-types.ts";

export {
  fetchWithTimeoutGuard,
  streamResponseBodyWithByteLimit,
} from "./server-helpers-fetch.ts";

const fetchWithTimeoutGuard = _fetchWithTimeoutGuard;
const streamResponseBodyWithByteLimit = _streamResponseBodyWithByteLimit;

interface StreamRouteDestination {
  name?: string;
  [key: string]: unknown;
}

interface StreamingPluginDestinationFactories {
  createCustomRtmpDestination(config?: {
    rtmpUrl?: string;
    rtmpKey?: string;
  }): StreamRouteDestination;
  createNamedRtmpDestination(params: {
    id: string;
    name?: string;
    rtmpUrl: string;
    rtmpKey: string;
  }): StreamRouteDestination;
  createTwitchDestination(
    runtime?: IAgentRuntime,
    config?: { streamKey?: string },
  ): StreamRouteDestination;
  createYoutubeDestination(
    runtime?: IAgentRuntime,
    config?: { streamKey?: string; rtmpUrl?: string },
  ): StreamRouteDestination;
  createPumpfunDestination(
    runtime?: IAgentRuntime,
    config?: { streamKey?: string; rtmpUrl?: string },
  ): StreamRouteDestination;
  createXStreamDestination(
    runtime?: IAgentRuntime,
    config?: { streamKey?: string; rtmpUrl?: string },
  ): StreamRouteDestination;
}

const STREAMING_PLUGIN_MODULE_ID = ["@elizaos", "plugin-streaming"].join("/");

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStreamingPluginDestinationFactories(
  value: unknown,
): value is StreamingPluginDestinationFactories {
  return (
    isObjectRecord(value) &&
    typeof value.createCustomRtmpDestination === "function" &&
    typeof value.createNamedRtmpDestination === "function" &&
    typeof value.createTwitchDestination === "function" &&
    typeof value.createYoutubeDestination === "function" &&
    typeof value.createPumpfunDestination === "function" &&
    typeof value.createXStreamDestination === "function"
  );
}

async function loadStreamingPluginDestinationFactories(): Promise<StreamingPluginDestinationFactories> {
  const moduleValue: unknown = await import(STREAMING_PLUGIN_MODULE_ID);
  if (!isStreamingPluginDestinationFactories(moduleValue)) {
    throw new Error("missing destination factory exports");
  }
  return moduleValue;
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

function isJsonRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAgentBackupStateData(value: unknown): value is AgentBackupStateData {
  if (!isJsonRecord(value)) return false;
  return (
    Array.isArray(value.memories) &&
    isJsonRecord(value.config) &&
    isJsonRecord(value.workspaceFiles) &&
    isJsonRecord(value.manifest)
  );
}

async function readBackupJsonBody(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<unknown | null> {
  try {
    const raw = await readRequestBody(req, {
      maxBytes: MAX_BACKUP_BODY_BYTES,
    });
    if (!raw) {
      error(res, "Request body is required", 400);
      return null;
    }
    return JSON.parse(raw);
  } catch (err) {
    error(
      res,
      err instanceof Error ? err.message : "Invalid backup request body",
      400,
    );
    return null;
  }
}

let activeTerminalRunCount = 0;

function json(res: http.ServerResponse, data: unknown, status = 200): void {
  sendJson(res, data, status);
}

function error(res: http.ServerResponse, message: string, status = 400): void {
  sendJsonError(res, message, status);
}

function emptyTrainingTaskCounters(): Record<string, number> {
  return {
    should_respond: 0,
    context_routing: 0,
    action_planner: 0,
    response: 0,
    media_description: 0,
  };
}

type OptionalTrainingConfig = {
  autoTrain: boolean;
  triggerThreshold: number;
  triggerCooldownHours: number;
  backends: string[];
};

type OptionalTrainingConfigApi = {
  loadTrainingConfig: () => OptionalTrainingConfig;
  normalizeTrainingConfig: (input: unknown) => OptionalTrainingConfig;
  saveTrainingConfig: (config: OptionalTrainingConfig) => void;
};

const TRAINING_CONFIG_MODULE = "@elizaos/plugin-training";

function defaultTrainingConfig(): OptionalTrainingConfig {
  return {
    autoTrain: true,
    triggerThreshold: 100,
    triggerCooldownHours: 12,
    backends: ["native"],
  };
}

async function loadOptionalTrainingConfigApi(): Promise<OptionalTrainingConfigApi | null> {
  try {
    const loaded = (await import(
      /* @vite-ignore */ TRAINING_CONFIG_MODULE
    )) as Partial<OptionalTrainingConfigApi>;
    if (
      typeof loaded.loadTrainingConfig === "function" &&
      typeof loaded.normalizeTrainingConfig === "function" &&
      typeof loaded.saveTrainingConfig === "function"
    ) {
      return loaded as OptionalTrainingConfigApi;
    }
  } catch {
    // app-training is optional in this server path.
  }
  return null;
}

async function readOptionalTrainingConfig(): Promise<OptionalTrainingConfig> {
  const api = await loadOptionalTrainingConfigApi();
  return api?.loadTrainingConfig() ?? defaultTrainingConfig();
}

function parseBrowserBridgeKind(
  browserPlugin: BrowserPluginModule,
  value: string | undefined,
): BrowserBridgeKind | null {
  if (!value) return null;
  const decoded = decodeURIComponent(value);
  return (browserPlugin.BROWSER_BRIDGE_KINDS as readonly string[]).includes(
    decoded,
  )
    ? (decoded as BrowserBridgeKind)
    : null;
}

function parseBrowserBridgePackageTarget(
  browserPlugin: BrowserPluginModule,
  value: unknown,
): BrowserBridgePackagePathTarget | null {
  return typeof value === "string" &&
    (
      browserPlugin.BROWSER_BRIDGE_PACKAGE_PATH_TARGETS as readonly string[]
    ).includes(value)
    ? (value as BrowserBridgePackagePathTarget)
    : null;
}

async function handleBuiltinOptionalRoutes(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pathname: string,
  method: string,
): Promise<boolean> {
  if (method === "GET" && pathname === "/api/wallet/steward-status") {
    const { getWalletAddresses } = await getCoreWalletApi();
    const addresses = getWalletAddresses();
    json(res, {
      configured: false,
      available: false,
      connected: false,
      error: "Steward wallet service is not loaded.",
      walletAddresses: {
        evm: addresses.evmAddress ?? null,
        solana: addresses.solanaAddress ?? null,
      },
      evmAddress: addresses.evmAddress ?? undefined,
      vaultHealth: "degraded",
    });
    return true;
  }

  if (method === "GET" && pathname === "/api/training/auto/config") {
    json(res, { config: await readOptionalTrainingConfig() });
    return true;
  }

  if (method === "POST" && pathname === "/api/training/auto/config") {
    const body =
      (await readJsonBody<Record<string, unknown>>(req, res)) ?? null;
    if (!body) return true;
    const api = await loadOptionalTrainingConfigApi();
    const currentConfig = api?.loadTrainingConfig() ?? defaultTrainingConfig();
    const config = api
      ? api.normalizeTrainingConfig({
          ...currentConfig,
          ...body,
        })
      : currentConfig;
    api?.saveTrainingConfig(config);
    json(res, { config });
    return true;
  }

  if (method === "GET" && pathname === "/api/training/auto/status") {
    const config = await readOptionalTrainingConfig();
    json(res, {
      autoTrainEnabled: config.autoTrain,
      triggerThreshold: config.triggerThreshold,
      cooldownHours: config.triggerCooldownHours,
      counters: emptyTrainingTaskCounters(),
      lastTrain: {},
      perTaskThresholds: emptyTrainingTaskCounters(),
      perTaskCooldownMs: emptyTrainingTaskCounters(),
      serviceRegistered: false,
    });
    return true;
  }

  if (pathname === "/api/lifeops/activity-signals") {
    if (method === "GET") {
      json(res, { signals: [] });
      return true;
    }
    if (method === "POST") {
      await readBody(req).catch(() => undefined);
      json(res, {
        ok: true,
        stored: false,
        reason: "lifeops_route_unavailable",
      });
      return true;
    }
  }

  if (method === "GET" && pathname === "/api/voice/profiles") {
    json(res, { profiles: [] });
    return true;
  }

  if (method === "GET" && pathname === "/api/discord-local/status") {
    json(res, {
      available: false,
      connected: false,
      authenticated: false,
      currentUser: null,
      subscribedChannelIds: [],
      configuredChannelIds: [],
      scopes: [],
      lastError: null,
      ipcPath: null,
    });
    return true;
  }

  if (
    method === "GET" &&
    pathname === "/api/lifeops/connectors/imessage/status"
  ) {
    json(res, {
      available: false,
      connected: false,
      bridgeType: "none",
      hostPlatform: process.platform,
      diagnostics: [],
      error: null,
      chatDbAvailable: false,
      sendOnly: false,
      reason: "lifeops_route_unavailable",
      permissionAction: null,
    });
    return true;
  }

  if (method === "GET" && pathname === "/api/signal/status") {
    const requestUrl = new URL(req.url ?? pathname, "http://localhost");
    const accountId = requestUrl.searchParams.get("accountId") || "default";
    json(res, {
      accountId,
      status: "idle",
      authExists: false,
      serviceConnected: false,
      qrDataUrl: null,
      phoneNumber: null,
      error: null,
    });
    return true;
  }

  if (method === "GET" && pathname === "/api/setup/telegram-account/status") {
    json(res, {
      connector: "telegram-account",
      state: "idle",
      detail: {
        status: "idle",
        configured: false,
        sessionExists: false,
        serviceConnected: false,
        restartRequired: false,
        hasAppCredentials: false,
        phone: null,
        isCodeViaApp: false,
        account: null,
        error: null,
      },
    });
    return true;
  }

  if (method === "GET" && pathname === "/api/whatsapp/status") {
    const requestUrl = new URL(req.url ?? pathname, "http://localhost");
    const accountId = requestUrl.searchParams.get("accountId") || "default";
    const authScope = requestUrl.searchParams.get("authScope");
    json(res, {
      accountId,
      ...(authScope === "platform" || authScope === "lifeops"
        ? { authScope }
        : {}),
      status: "idle",
      authExists: false,
      serviceConnected: false,
      servicePhone: null,
    });
    return true;
  }

  if (method === "GET" && pathname === "/api/coding-agents/preflight") {
    json(res, { installed: [], available: false });
    return true;
  }

  if (
    method === "GET" &&
    pathname === "/api/coding-agents/coordinator/status"
  ) {
    json(res, {
      supervisionLevel: "unavailable",
      taskCount: 0,
      tasks: [],
      pendingConfirmations: 0,
      taskThreadCount: 0,
      taskThreads: [],
      frameworks: [],
    });
    return true;
  }

  if (method === "GET" && pathname === "/api/browser-bridge/companions") {
    json(res, { companions: [] });
    return true;
  }

  if (method === "GET" && pathname === "/api/browser-bridge/packages") {
    const browserPlugin = await getBrowserBridgePlugin();
    json(res, {
      status: browserPlugin
        ? browserPlugin.getBrowserBridgeCompanionPackageStatus()
        : EMPTY_BROWSER_BRIDGE_PACKAGE_STATUS,
    });
    return true;
  }

  if (
    method === "POST" &&
    pathname === "/api/browser-bridge/packages/open-path"
  ) {
    const body =
      (await readJsonBody<{ target?: unknown; revealOnly?: unknown }>(
        req,
        res,
      )) ?? null;
    if (!body) return true;
    const browserPlugin = await getBrowserBridgePlugin();
    if (!browserPlugin) {
      error(res, "Browser bridge is not available on this platform", 503);
      return true;
    }
    const target = parseBrowserBridgePackageTarget(browserPlugin, body.target);
    if (!target) {
      error(res, "Invalid browser bridge package target", 400);
      return true;
    }
    json(
      res,
      await browserPlugin.openBrowserBridgeCompanionPackagePath(target, {
        revealOnly: body.revealOnly === true,
      }),
    );
    return true;
  }

  const packageBuildMatch = pathname.match(
    /^\/api\/browser-bridge\/packages\/([^/]+)\/build$/,
  );
  if (method === "POST" && packageBuildMatch) {
    const browserPlugin = await getBrowserBridgePlugin();
    if (!browserPlugin) {
      error(res, "Browser bridge is not available on this platform", 503);
      return true;
    }
    const browser = parseBrowserBridgeKind(browserPlugin, packageBuildMatch[1]);
    if (!browser) {
      error(res, "Invalid browser bridge package browser", 400);
      return true;
    }
    json(res, {
      status: await browserPlugin.buildBrowserBridgeCompanionPackage(browser),
    });
    return true;
  }

  const packageManagerMatch = pathname.match(
    /^\/api\/browser-bridge\/packages\/([^/]+)\/open-manager$/,
  );
  if (method === "POST" && packageManagerMatch) {
    const browserPlugin = await getBrowserBridgePlugin();
    if (!browserPlugin) {
      error(res, "Browser bridge is not available on this platform", 503);
      return true;
    }
    const browser = parseBrowserBridgeKind(
      browserPlugin,
      packageManagerMatch[1],
    );
    if (!browser) {
      error(res, "Invalid browser bridge package browser", 400);
      return true;
    }
    json(res, await browserPlugin.openBrowserBridgeCompanionManager(browser));
    return true;
  }

  if (pathname === "/api/browser-workspace" && method === "GET") {
    const browserPlugin = await getBrowserWorkspacePlugin();
    if (!browserPlugin) {
      json(res, { mode: "web", tabs: [] });
      return true;
    }
    json(res, await browserPlugin.getBrowserWorkspaceSnapshot());
    return true;
  }

  if (pathname === "/api/browser-workspace/command" && method === "POST") {
    const browserPlugin = await getBrowserWorkspacePlugin();
    const body =
      (await readJsonBody<BrowserWorkspaceCommand>(req, res)) ?? null;
    if (!body?.subaction) {
      error(res, "subaction is required", 400);
      return true;
    }
    if (!browserPlugin) {
      error(res, "Browser workspace is not available on this platform", 503);
      return true;
    }
    json(res, await browserPlugin.executeBrowserWorkspaceCommand(body));
    return true;
  }

  if (pathname === "/api/browser-workspace/tabs" && method === "GET") {
    const browserPlugin = await getBrowserWorkspacePlugin();
    if (!browserPlugin) {
      json(res, { tabs: [] });
      return true;
    }
    json(res, { tabs: await browserPlugin.listBrowserWorkspaceTabs() });
    return true;
  }

  if (pathname === "/api/browser-workspace/tabs" && method === "POST") {
    const browserPlugin = await getBrowserWorkspacePlugin();
    if (!browserPlugin) {
      error(res, "Browser workspace is not available on this platform", 503);
      return true;
    }
    const body =
      (await readJsonBody<{
        url?: string;
        title?: string;
        show?: boolean;
        partition?: string;
        kind?: BrowserWorkspaceTabKind;
      }>(req, res)) ?? {};
    json(res, { tab: await browserPlugin.openBrowserWorkspaceTab(body) });
    return true;
  }

  const tabMatch = pathname.match(
    /^\/api\/browser-workspace\/tabs\/([^/]+)(?:\/(navigate|eval|show|hide|snapshot))?$/,
  );
  if (!tabMatch) {
    return false;
  }

  const tabId = decodeURIComponent(tabMatch[1]).trim();
  const action = tabMatch[2] ?? null;

  const browserPlugin = await getBrowserWorkspacePlugin();
  if (!browserPlugin) {
    error(res, "Browser workspace is not available on this platform", 503);
    return true;
  }

  if (!action && method === "DELETE") {
    const closed = await browserPlugin.closeBrowserWorkspaceTab(tabId);
    json(res, { closed }, closed ? 200 : 404);
    return true;
  }

  if (action === "show" && method === "POST") {
    json(res, { tab: await browserPlugin.showBrowserWorkspaceTab(tabId) });
    return true;
  }

  if (action === "hide" && method === "POST") {
    json(res, { tab: await browserPlugin.hideBrowserWorkspaceTab(tabId) });
    return true;
  }

  if (action === "snapshot" && method === "GET") {
    json(res, await browserPlugin.snapshotBrowserWorkspaceTab(tabId));
    return true;
  }

  if (action === "navigate" && method === "POST") {
    const body =
      (await readJsonBody<{ url?: string; partition?: string }>(req, res)) ??
      null;
    if (!body?.url) {
      error(res, "url is required", 400);
      return true;
    }
    json(res, {
      tab: await browserPlugin.navigateBrowserWorkspaceTab({
        id: tabId,
        url: body.url,
      }),
    });
    return true;
  }

  if (action === "eval" && method === "POST") {
    const body =
      (await readJsonBody<{ script?: string; partition?: string }>(req, res)) ??
      null;
    if (!body?.script) {
      error(res, "script is required", 400);
      return true;
    }
    json(res, {
      value: await browserPlugin.evaluateBrowserWorkspaceTab({
        id: tabId,
        script: body.script,
      }),
    });
    return true;
  }

  return false;
}

// ---------------------------------------------------------------------------
import { serveMediaFile } from "./media-store.ts";
import {
  injectApiBaseIntoHtml,
  isAuthProtectedRoute,
  serveStaticUi,
} from "./static-file-server.ts";

export { injectApiBaseIntoHtml };

function coerce<T>(value: unknown): T {
  return value as T;
}

export type { ChatAttachmentWithData } from "./server-types.ts";

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

const isBlockedObjectKey = isBlockedObjectKeyFromConfig;

import {
  resolveMcpServersRejection as _resolveMcpServersRejection,
  resolveMcpTerminalAuthorizationRejection as _resolveMcpTerminalAuthorizationRejection,
} from "./server-helpers-mcp.ts";

export {
  resolveMcpServersRejection,
  resolveMcpTerminalAuthorizationRejection,
  validateMcpServerConfig,
} from "./server-helpers-mcp.ts";

const resolveMcpServersRejection = _resolveMcpServersRejection;

import { pickRandomNames } from "../runtime/first-run-names.ts";
import { resolveDefaultAgentWorkspaceDir } from "../shared/workspace-resolution.ts";
import {
  applyFirstRunVoicePreset,
  ensureWalletKeysInEnvAndConfig,
  getCloudProviderOptions,
  getProviderOptions,
  isBlockedObjectKey as isBlockedObjectKeyFromConfig,
  isRedactedSecretValue,
  readUiLanguageHeader,
  redactConfigSecrets,
  redactDeep,
  resolveConfiguredCharacterLanguage,
  resolveDefaultAgentName,
  stripRedactedPlaceholderValuesDeep,
} from "./server-helpers-config.ts";

export { isSafeResetStateDir } from "./server-helpers-config.ts";

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
} from "./trade-safety.ts";

export {
  AGENT_AUTO_MAX_DAILY_TRADES,
  agentAutoDailyTrades,
  assertQuoteFresh,
  canUseLocalTradeExecution,
  getAgentAutoTradeDate,
  QUOTE_MAX_AGE_MS,
  recordAgentAutoTrade,
  type TradePermissionMode,
} from "./trade-safety.ts";

// ---------------------------------------------------------------------------
// Automation & agent permission helpers
// ---------------------------------------------------------------------------

import type { AgentAutomationMode } from "./server-types.ts";

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

/**
 * Build the EVM wallet diagnostic card from the plugin-owned static descriptor
 * (identity, config keys, tags, prerequisite labels) merged with the
 * host-resolved runtime status. No plugin-specific literals live in the host.
 */
function buildPluginEvmDiagnosticEntry(
  state: Pick<ServerState, "config" | "runtime">,
): PluginEntry {
  return buildPluginDiagnosticEntry(
    walletDiagnosticDescriptor,
    resolveWalletDiagnosticStatus(walletDiagnosticDescriptor, state),
  );
}

import { resolveWalletExportRejection as _resolveWalletExportRejection } from "./server-helpers-wallet.ts";

export {
  resolveWalletExportRejection,
  type WalletExportRejection,
} from "./server-helpers-wallet.ts";

const resolveWalletExportRejection = _resolveWalletExportRejection;

import { resolvePluginConfigMutationRejections as _resolvePluginConfigMutationRejections } from "./server-helpers-plugin.ts";

export {
  type PluginConfigMutationRejection,
  resolvePluginConfigMutationRejections,
  resolvePluginConfigReply,
} from "./server-helpers-plugin.ts";

const resolvePluginConfigMutationRejections =
  _resolvePluginConfigMutationRejections;

// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------

interface RequestContext {
  onRestart: (() => Promise<AgentRuntime | null>) | null;
  onRuntimeSwapped?: () => void;
  getAppManager?: () => Promise<AppManagerLike>;
}

import type { TrainingServiceWithRuntime } from "./server-types.ts";

type TrainingServiceCtor = new (options: {
  getRuntime: () => AgentRuntime | null;
  getConfig: () => ElizaConfig;
  setConfig: (nextConfig: ElizaConfig) => void;
}) => TrainingServiceWithRuntime;

const TRAINING_SERVICE_REGISTRY_MODULE: string = "@elizaos/plugin-training";

async function resolveTrainingServiceCtor(): Promise<TrainingServiceCtor | null> {
  if (isMobilePlatform()) {
    logger.info("[eliza-api] Training service disabled on mobile platform");
    return null;
  }

  const candidates = [
    "../services/training-service",
    "@elizaos/plugin-training",
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

async function setActiveTrainingServiceIfAvailable(
  service: TrainingServiceWithRuntime,
): Promise<void> {
  try {
    const loaded = (await import(
      /* @vite-ignore */ TRAINING_SERVICE_REGISTRY_MODULE
    )) as {
      setActiveTrainingService?: (
        activeService: TrainingServiceWithRuntime,
      ) => void;
    };
    loaded.setActiveTrainingService?.(service);
  } catch (err) {
    logger.debug(
      `[eliza-api] Training service registry unavailable: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

const resolveMcpTerminalAuthorizationRejection =
  _resolveMcpTerminalAuthorizationRejection;

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
  isTrustedLocalRequest as _isTrustedLocalRequest,
  isWaifuChatAuthorized as _isWaifuChatAuthorized,
  isWebSocketAuthorized as _isWebSocketAuthorized,
  normalizePairingCode as _normalizePairingCode,
  normalizeWsClientId as _normalizeWsClientId,
  pairingEnabled as _pairingEnabled,
  rateLimitPairing as _rateLimitPairing,
  rejectWebSocketUpgrade as _rejectWebSocketUpgrade,
  resolveTerminalRunClientId as _resolveTerminalRunClientId,
  resolveTerminalRunRejection as _resolveTerminalRunRejection,
  resolveWebSocketUpgradeRejection as _resolveWebSocketUpgradeRejection,
} from "./server-helpers-auth.ts";

export {
  ensureApiTokenForBindHost,
  extractAuthToken,
  isAllowedHost,
  isAuthorized,
  isWaifuChatAuthorized,
  normalizeWsClientId,
  resolveCorsOrigin,
  resolveTerminalRunClientId,
  resolveTerminalRunRejection,
  resolveWebSocketUpgradeRejection,
  type TerminalRunRejection,
  type WebSocketUpgradeRejection,
} from "./server-helpers-auth.ts";

const isAllowedHost = _isAllowedHost;
const applyCors = _applyCors;
const isAuthorized = _isAuthorized;
const isTrustedLocalRequest = _isTrustedLocalRequest;
const isWaifuChatAuthorized = _isWaifuChatAuthorized;
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

/**
 * Lazy per-process runtime operation manager. Constructed on first
 * request because it needs the per-server `state` reference + the
 * `onRestart` closure. Cached so subsequent requests see the same
 * active-op slot and execution chain.
 */
let cachedRuntimeOperationManager: RuntimeOperationManager | null = null;

function getOrCreateRuntimeOperationManager(
  state: ServerState,
  restartRuntime: (reason: string) => Promise<boolean>,
): RuntimeOperationManager {
  if (cachedRuntimeOperationManager) {
    return cachedRuntimeOperationManager;
  }
  const repository = getDefaultRepository();
  const healthChecker = getDefaultHealthChecker();
  const coldStrategy = createColdStrategy({
    restartRuntime: async (reason) => {
      const ok = await restartRuntime(reason);
      if (!ok) return null;
      return state.runtime;
    },
  });
  const hotStrategy = createHotStrategy({});
  const classifyContext = (): ClassifyContext => ({
    currentProvider: resolvePreferredProviderId(state.config),
    currentPrimaryModel: resolvePrimaryModel(state.config),
  });
  cachedRuntimeOperationManager = new DefaultRuntimeOperationManager({
    repository,
    runtime: () => state.runtime,
    classifyContext,
    classifier: defaultClassifier,
    healthChecker,
    strategies: { cold: coldStrategy, hot: hotStrategy },
  });
  return cachedRuntimeOperationManager;
}

import {
  attachPtySessionWsBridge,
  cancelPendingPtySessionStop,
  MAX_PTY_INPUT_MESSAGE_LENGTH,
  resolvePtyDisconnectGraceMs,
  schedulePtySessionStopAfterGrace,
} from "./pty-ws-bridge.ts";
import {
  isLifeOpsCloudPluginRoute,
  maybeRouteAutonomyEventToConversation,
} from "./server-autonomy-helpers.ts";
import {
  getPtyConsoleBridge,
  getPtyService,
  wireCodingAgentChatBridge,
  wireCodingAgentSwarmSynthesis,
  wireCodingAgentWsBridge,
  wireCoordinatorEventRouting,
} from "./server-helpers-swarm.ts";

import {
  asObject,
  normalizeTags,
  parseNullableNumber,
  readTaskCompleted,
  readTaskMetadata,
  toWorkbenchTodo,
} from "./workbench-helpers.ts";

export {
  handleSwarmSynthesis,
  routeAutonomyTextToUser,
} from "./server-helpers-swarm.ts";

// One process-wide governance gate shared across runtime (re)registrations, so a
// restart doesn't reset the proactive-comment cooldowns/caps (#8792).
const proactiveInteractionGate = new ProactiveInteractionGate();

function proactiveNotificationGroupKey(offer: ProactiveOffer): string {
  if (offer.groupKey) return offer.groupKey;
  const basis = (offer.deepLink || offer.title || offer.text)
    .toLowerCase()
    .replace(/[^a-z0-9:/._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 72);
  return `proactive-interaction:${basis || "general"}`;
}

async function notifyProactiveInteraction(
  rt: IAgentRuntime,
  offer: ProactiveOffer,
): Promise<void> {
  const service = rt.getService(ServiceType.NOTIFICATION);
  if (!(service instanceof NotificationService)) {
    logger.debug(
      "[proactive-interaction] notification service unavailable; suppressing notify-lane offer",
    );
    return;
  }

  const title = offer.title?.trim() || offer.text;
  await service.notify({
    title,
    body: title === offer.text ? undefined : offer.text,
    category: "agent",
    priority: "low",
    source: PROACTIVE_INTERACTION_SOURCE,
    deepLink: offer.deepLink,
    groupKey: proactiveNotificationGroupKey(offer),
    data: { kind: "proactive-interaction" },
  });
}

/**
 * Wire the proactive-interaction decider (#8792): subscribe to VIEW_SWITCHED and
 * route an admitted, model-judged offer into chat suggestions or low-priority
 * notifications. No-ops when disabled by config/kill-switch.
 */
function wireProactiveInteractionDecider(
  rt: IAgentRuntime,
  state: ServerState,
): void {
  registerProactiveInteractionDecider(rt, {
    gate: proactiveInteractionGate,
    route: (text) =>
      routeProactiveText(state, text, PROACTIVE_INTERACTION_SOURCE),
    notify: (offer) => notifyProactiveInteraction(rt, offer),
    shouldSuppress: () => state.activeChatTurnCount > 0,
  });
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
  let isCloudProvisionedContainer = (): boolean => false;
  let handleCloudStatusRoutes = async (_args: unknown): Promise<boolean> =>
    false;
  if (
    // plugin-elizacloud is desktop/cloud-only; on mobile its dynamic import
    // does not resolve and the resulting await stalls the whole request (the
    // /api/cloud, /api/coding-agents, and cloud-first-run paths then hang).
    // Skip the import on mobile — the default no-op cloud helpers above keep
    // isCloudProvisioned=false (correct for a local mobile agent) and let the
    // request fall through to its normal handler/404.
    !isMobilePlatform() &&
    (pathname === "/api/first-run/status" ||
      pathname.startsWith("/api/cloud") ||
      pathname.startsWith("/api/coding-agents"))
  ) {
    const cloudApi = await getOptionalPluginApi<{
      isCloudProvisionedContainer: () => boolean;
      handleCloudStatusRoutes: (args: unknown) => Promise<boolean>;
    }>("cloud");
    isCloudProvisionedContainer = cloudApi.isCloudProvisionedContainer;
    handleCloudStatusRoutes = cloudApi.handleCloudStatusRoutes;
  }
  const isCloudProvisioned = isCloudProvisionedContainer();
  const isCloudFirstRunStatusEndpoint =
    method === "GET" &&
    pathname === "/api/first-run/status" &&
    isCloudProvisioned;
  const isAuthProtectedPath = isAuthProtectedRoute(pathname);

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
        hint: `To allow this host, set ELIZA_ALLOWED_HOSTS=${incomingHost} in your environment, or access via http://localhost`,
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

  // Cloud SSO popup handoff: GET /pair?token=X must short-circuit BEFORE the
  // static-UI catch-all, otherwise the SPA index.html is served and the user
  // ends up on the password screen.
  //
  // The cloud-SSO handoff route is owned by the app-core host and injected
  // downward through the agent host bridge (see ../runtime/host-bridge.ts) so
  // agent never imports `@elizaos/app-core`. A local on-device agent never
  // legitimately serves it, so the bridge omits the handler and the request
  // falls through to the normal pipeline.
  const handleCloudPairRoute = getAgentHostBridge().handleCloudPairRoute;
  if (
    typeof handleCloudPairRoute === "function" &&
    (await handleCloudPairRoute(req, res))
  ) {
    return;
  }

  // Serve dashboard static assets before the auth gates. serveStaticUi already
  // refuses /api/, /v1/, and /ws paths, so API endpoints remain protected
  // while steward-managed containers can still reach the built-in dashboard.
  if (method === "GET" || method === "HEAD") {
    if (serveStaticUi(req, res, pathname)) return;
    // Chat media (uploaded + generated). Content-addressed sha256 filenames act
    // as unguessable capabilities, so media loads from <img>/<audio> without an
    // auth header — same rationale as static assets above.
    if (serveMediaFile(req, res, pathname)) return;
  }

  if (
    method !== "OPTIONS" &&
    isAuthProtectedPath &&
    !isAuthEndpoint &&
    !isHealthEndpoint &&
    !isCloudFirstRunStatusEndpoint &&
    !isPublicRuntimePluginRoute({
      runtime: state.runtime,
      method,
      pathname,
    }) &&
    !isAuthorized(req) &&
    !isWaifuChatAuthorized(req, method, pathname)
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

  if (method === "GET" && pathname === "/api/backups") {
    if (!state.runtime) {
      error(res, "Runtime not ready", 503);
      return;
    }
    try {
      const backups = await listLocalAgentBackups(state.runtime.agentId);
      json(res, { backups });
    } catch (err) {
      logger.error(
        {
          err: err instanceof Error ? err.message : String(err),
        },
        "[agent-backup] Local backup list failed",
      );
      error(
        res,
        err instanceof Error ? err.message : "Backup list failed",
        500,
      );
    }
    return;
  }

  if (method === "POST" && pathname === "/api/backups") {
    if (!state.runtime) {
      error(res, "Runtime not ready", 503);
      return;
    }
    try {
      const backup = await createLocalAgentBackup(state.runtime, state.config);
      json(res, { backup });
    } catch (err) {
      logger.error(
        {
          err: err instanceof Error ? err.message : String(err),
        },
        "[agent-backup] Local backup failed",
      );
      error(res, err instanceof Error ? err.message : "Backup failed", 500);
    }
    return;
  }

  if (method === "POST" && pathname === "/api/backups/restore") {
    if (!state.runtime) {
      error(res, "Runtime not ready", 503);
      return;
    }
    const body = await readBackupJsonBody(req, res);
    if (!body) return;
    const bodyRecord = isJsonRecord(body) ? body : null;
    const fileName =
      typeof bodyRecord?.fileName === "string" ? bodyRecord.fileName : null;
    if (!fileName) {
      error(res, "fileName is required", 400);
      return;
    }
    try {
      const result = await restoreLocalAgentBackup(state.runtime, fileName);
      json(res, result);
    } catch (err) {
      logger.error(
        {
          err: err instanceof Error ? err.message : String(err),
        },
        "[agent-backup] Local backup restore failed",
      );
      error(
        res,
        err instanceof Error ? err.message : "Backup restore failed",
        500,
      );
    }
    return;
  }

  if (method === "POST" && pathname === "/api/snapshot") {
    if (!state.runtime) {
      error(res, "Runtime not ready", 503);
      return;
    }
    try {
      const snapshot = await createAgentSnapshot(state.runtime, state.config);
      json(res, snapshot);
    } catch (err) {
      logger.error(
        {
          err: err instanceof Error ? err.message : String(err),
        },
        "[agent-backup] Snapshot failed",
      );
      error(res, err instanceof Error ? err.message : "Snapshot failed", 500);
    }
    return;
  }

  if (method === "POST" && pathname === "/api/restore") {
    if (!state.runtime) {
      error(res, "Runtime not ready", 503);
      return;
    }
    const body = await readBackupJsonBody(req, res);
    if (!body) return;
    if (!isAgentBackupStateData(body)) {
      error(res, "Invalid backup snapshot payload", 400);
      return;
    }
    try {
      const result = await restoreAgentSnapshot(state.runtime, body);
      json(res, result);
    } catch (err) {
      logger.error(
        {
          err: err instanceof Error ? err.message : String(err),
        },
        "[agent-backup] Restore failed",
      );
      error(res, err instanceof Error ? err.message : "Restore failed", 500);
    }
    return;
  }

  if (
    (pathname.startsWith("/api/local-inference") ||
      pathname === "/api/tts/local-inference" ||
      pathname.startsWith("/api/asr/local-inference") ||
      pathname.startsWith("/api/voice/audio-frames") ||
      pathname === "/api/voice/playback-frames" ||
      pathname === "/api/voice/aec-capture") &&
    (await (async () => {
      const localInferenceServerApi = await getLocalInferenceServerApi();
      if (
        typeof localInferenceServerApi.handleLocalInferenceRoutes ===
          "function" &&
        (await localInferenceServerApi.handleLocalInferenceRoutes(req, res))
      ) {
        return true;
      }
      // WebView → agent PCM transport for live on-device speaker diarization.
      if (
        localInferenceServerApi.handleLiveDiarizationRoute &&
        (await localInferenceServerApi.handleLiveDiarizationRoute(req, res, {
          current: state.runtime,
        }))
      ) {
        return true;
      }
      if (
        localInferenceServerApi.handleLocalInferenceAsrRoute &&
        (await localInferenceServerApi.handleLocalInferenceAsrRoute(req, res, {
          current: state.runtime,
        }))
      ) {
        return true;
      }
      return Boolean(
        localInferenceServerApi.handleLocalInferenceTtsRoute &&
          (await localInferenceServerApi.handleLocalInferenceTtsRoute(
            req,
            res,
            {
              current: state.runtime,
            },
          )),
      );
    })())
  ) {
    return;
  }

  if (
    await handleBackgroundTasksRoute({
      req,
      res,
      method,
      pathname,
      state,
      json,
    })
  ) {
    return;
  }
  // Computer-use is a desktop/cloud-only plugin; on mobile it is not in the
  // agent bundle, so importing it here would REJECT (`Cannot find module
  // '@elizaos/plugin-computeruse'`) and surface as a 500 on every renderer poll
  // of /api/computer-use/approvals. Skip the import path on mobile and let the
  // request fall through to handleMobileOptionalRoutes, which serves the inert
  // {mode:"off",…} approval snapshot.
  if (!isMobilePlatform() && pathname.startsWith("/api/computer-use/")) {
    const { handleComputerUseRoutes } = await getOptionalPluginApi<{
      handleComputerUseRoutes: (
        req: http.IncomingMessage,
        res: http.ServerResponse,
        pathname: string,
        method: string,
      ) => Promise<boolean>;
    }>("computerUse");
    if (await handleComputerUseRoutes(req, res, pathname, method)) return;
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

  if (method === "POST" && pathname === "/api/provider/switch") {
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
        runtimeOperationManager: getOrCreateRuntimeOperationManager(
          state,
          restartRuntime,
        ),
      })
    ) {
      return;
    }
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
        (await import("../auth/index.ts")) as never,
    } as never)
  ) {
    return;
  }

  if (
    await handleAccountsRoutes({
      req,
      res,
      method,
      pathname,
      readJsonBody,
      json,
      error,
      state: { config: state.config },
      saveConfig: saveElizaConfig,
    })
  ) {
    return;
  }

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

  if (
    await handleFirstRunRoutes({
      req,
      res,
      method,
      pathname,
      url,
      state: coerce<FirstRunRouteArg["state"]>(state),
      json,
      error,
      readJsonBody,
      isCloudProvisionedContainer,
      hasPersistedFirstRunState,
      ensureWalletKeysInEnvAndConfig,
      getWalletAddresses:
        pathname === "/api/wallet/keys"
          ? coerce<FirstRunRouteArg["getWalletAddresses"]>(
              (await getCoreWalletApi()).getWalletAddresses,
            )
          : coerce<FirstRunRouteArg["getWalletAddresses"]>(() => ({
              evmAddress: null,
              solanaAddress: null,
            })),
      pickRandomNames,
      getStylePresets:
        coerce<FirstRunRouteArg["getStylePresets"]>(getStylePresets),
      getProviderOptions:
        coerce<FirstRunRouteArg["getProviderOptions"]>(getProviderOptions),
      getCloudProviderOptions: coerce<
        FirstRunRouteArg["getCloudProviderOptions"]
      >(getCloudProviderOptions),
      getModelOptions:
        coerce<FirstRunRouteArg["getModelOptions"]>(getModelOptions),
      getInventoryProviderOptions: coerce<
        FirstRunRouteArg["getInventoryProviderOptions"]
      >(getInventoryProviderOptions),
      resolveConfiguredCharacterLanguage: coerce<
        FirstRunRouteArg["resolveConfiguredCharacterLanguage"]
      >(resolveConfiguredCharacterLanguage),
      normalizeCharacterLanguage: coerce<
        FirstRunRouteArg["normalizeCharacterLanguage"]
      >(normalizeCharacterLanguage),
      readUiLanguageHeader:
        coerce<FirstRunRouteArg["readUiLanguageHeader"]>(readUiLanguageHeader),
      applyFirstRunVoicePreset: coerce<
        FirstRunRouteArg["applyFirstRunVoicePreset"]
      >(applyFirstRunVoicePreset),
      saveElizaConfig,
    })
  ) {
    return;
  }

  // POST /api/first-run is now handled by first-run-routes.ts above.

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

  if (
    pathname.startsWith("/api/triggers") ||
    pathname.startsWith("/api/heartbeats")
  ) {
    const { handleTriggerRoutes } = await getOptionalPluginApi<{
      handleTriggerRoutes: (args: unknown) => Promise<boolean>;
    }>("workflow");
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
  }

  // Training routes (/api/training/*) and trajectory routes
  // (/api/trajectories/*) are now provided by the @elizaos/plugin-training
  // plugin via the runtime route registry.

  // Knowledge routes (/api/knowledge/*) are now provided by the
  // @elizaos/app-knowledge plugin via the runtime route registry.

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

  // Experience routes (/api/experiences/*, /api/character/experiences/*) are
  // served by the @elizaos/plugin-training plugin via Plugin.routes.

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
      state.agentName.trim() ||
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

  if (
    await handleRemoteCapabilityRoutes({
      req,
      res,
      method,
      pathname,
      runtime: state.runtime,
      config: state.config,
      readJsonBody,
      saveConfig: (config) => saveElizaConfig(config as ElizaConfig),
      persistConfigEnv,
      json,
      error,
    })
  ) {
    return;
  }

  // Live-load a plugin from an on-disk directory into the running runtime. This
  // is what makes a freshly scaffolded/edited local plugin (VIEWS/APP create)
  // actually appear without an agent restart — its views register via
  // runtime.registerPlugin. Must run BEFORE the generic /api/plugins/* handler.
  if (
    await handlePluginDirectoryRoutes({
      req,
      res,
      method,
      pathname,
      state,
      readJsonBody,
      json,
      error,
    })
  ) {
    return;
  }

  // Unload a plugin previously live-loaded from a directory (the symmetric
  // counterpart to load-from-directory). Directly-registered plugins are not
  // known to the plugin-manager, so /api/plugins/uninstall can't remove them —
  // this delegates to runtime.unloadPlugin, which also deregisters its views.
  if (method === "POST" && pathname === "/api/plugins/unload-from-directory") {
    if (!state.runtime) {
      error(res, "Agent runtime is not available", 503);
      return;
    }
    const body = await readJsonBody<{ pluginName?: unknown }>(req, res);
    if (body === null) return;
    const pluginName =
      typeof body.pluginName === "string" ? body.pluginName.trim() : "";
    if (!pluginName) {
      error(res, "'pluginName' is required", 400);
      return;
    }
    try {
      const { unloadPluginFromDirectory } = await import(
        "../runtime/load-plugin-from-directory.ts"
      );
      const result = await unloadPluginFromDirectory({
        runtime: state.runtime as Parameters<
          typeof unloadPluginFromDirectory
        >[0]["runtime"],
        pluginName,
      });
      json(res, { ok: result.unloaded, ...result });
    } catch (err) {
      json(
        res,
        { ok: false, error: err instanceof Error ? err.message : String(err) },
        422,
      );
    }
    return;
  }

  if (
    pathname === "/api/plugins" ||
    pathname.startsWith("/api/plugins/") ||
    pathname === "/api/secrets" ||
    pathname === "/api/core/status"
  ) {
    const { handlePluginRoutes } = await getPluginRegistryApi();
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
        applyWhatsAppQrOverride: (
          await getOptionalPluginApi<{
            applyWhatsAppQrOverride: (...args: unknown[]) => void;
          }>("whatsapp")
        ).applyWhatsAppQrOverride,
        applySignalQrOverride: (
          await getOptionalPluginApi<{
            applySignalQrOverride: (...args: unknown[]) => void;
          }>("signal")
        ).applySignalQrOverride,
        resolvePluginConfigMutationRejections,
        requirePluginManager,
        requireCoreManager,
      })
    ) {
      return;
    }
  }

  // Curated-skills routes must be dispatched before generic skills routes
  // (which reject "/" in skill IDs).
  if (pathname.startsWith("/api/skills/curated")) {
    const { handleCuratedSkillsRoutes } = await getAgentSkillsApi();
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
    const { discoverSkills, handleSkillsRoutes } = await getAgentSkillsApi();
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
  // Prefer the local wallet implementation during desktop startup. The
  // wallet route owner must not pull browser/UI-only dependencies into the
  // agent process or block local assistant boot.
  // ═══════════════════════════════════════════════════════════════════════
  // plugin-wallet is desktop/cloud-only; on mobile its import does not resolve
  // and the await stalls /api/wallet/* requests. Skip on mobile → fall through
  // to 404 (the mobile agent has no EVM/Solana wallet surface anyway).
  if (!isMobilePlatform() && pathname.startsWith("/api/wallet/")) {
    const { handleWalletRoutes } = await getWalletApi();
    const {
      deriveSolanaAddress,
      fetchEvmBalances,
      fetchSolanaBalances,
      fetchSolanaNativeBalanceViaRpc,
      generateWalletForChain,
      getWalletAddresses,
      importWallet,
      setSolanaWalletEnv,
      validatePrivateKey,
    } = await getCoreWalletApi();
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
        deps: {
          fetchEvmBalances,
          fetchSolanaBalances,
          fetchSolanaNativeBalanceViaRpc,
          getWalletAddresses,
          validatePrivateKey,
          importWallet,
          generateWalletForChain,
          deriveSolanaAddress,
          setSolanaWalletEnv,
          resolveWalletRpcReadiness: coerce<
            WalletRouteDependencies["resolveWalletRpcReadiness"]
          >(resolveWalletRpcReadiness),
          resolveWalletNetworkMode: coerce<
            WalletRouteDependencies["resolveWalletNetworkMode"]
          >(resolveWalletNetworkMode),
          getStoredWalletRpcSelections: coerce<
            WalletRouteDependencies["getStoredWalletRpcSelections"]
          >(getStoredWalletRpcSelections),
          applyWalletRpcConfigUpdate: coerce<
            WalletRouteDependencies["applyWalletRpcConfigUpdate"]
          >(applyWalletRpcConfigUpdate),
          resolveWalletCapabilityStatus: coerce<
            WalletRouteDependencies["resolveWalletCapabilityStatus"]
          >((args: { config: ElizaConfig; runtime: AgentRuntime | null }) =>
            resolveWalletCapabilityStatus({
              config: args.config,
              runtime: args.runtime,
            }),
          ),
          isCloudWalletEnabled,
          persistConfigEnv,
          createIntegrationTelemetrySpan: coerce<
            WalletRouteDependencies["createIntegrationTelemetrySpan"]
          >(createIntegrationTelemetrySpan),
        },
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
    (pathname === "/api/agent/self-status" ||
      pathname.startsWith("/api/registry")) &&
    (await (async () => {
      const { RegistryService } = await import("./registry-service.ts");
      return handleAgentStatusRoutes({
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
          getWalletAddresses:
            pathname === "/api/agent/self-status"
              ? (await getCoreWalletApi()).getWalletAddresses
              : () => ({ evmAddress: null, solanaAddress: null }),
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
          getAwarenessRegistry: coerce<
            AgentStatusRouteArg["deps"]["getAwarenessRegistry"]
          >(() => state.runtime?.getService("AWARENESS_REGISTRY") ?? null),
          RegistryService,
        },
      });
    })())
  ) {
    return;
  }

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
      // Disconnect cascade is event-driven: connector-routes
      // emits `connector_disconnected` and WorkflowCredentialStore subscribes
      // to invalidate its own cache. No direct service lookup needed here.
      onConnectorDisconnect: async () => {},
    })
  ) {
    return;
  }

  // ── WhatsApp routes (/api/whatsapp/*) ────────────────────────────────────
  // Moved to @elizaos/plugin-whatsapp setup-routes.ts (registered via Plugin.routes).

  // ── BlueBubbles routes ──────────────────────────────────────────────────
  // Extracted to @elizaos/plugin-bluebubbles setup-routes.ts (Plugin.routes).

  // ── Notification + inbox routes (/api/notifications/*, /api/inbox/*) ──
  // Notifications: the unified notification center backed by the runtime
  // NotificationService (see api/notification-routes.ts). Inbox: a
  // cross-channel read-only feed that merges connector messages (imessage,
  // telegram, discord, whatsapp, etc.) into a single time-ordered view.
  if (
    await handleInboxAndCloudRelayRouteGroup({
      req,
      res,
      method,
      pathname,
      url,
      state,
      json,
      error,
      readJsonBody,
    })
  ) {
    return;
  }

  // ── Restart ──────────────────────────────────────────────────────────
  if (method === "POST" && pathname === "/api/restart") {
    state.agentState = "restarting";
    state.startup = { ...state.startup, phase: "restarting" };
    state.broadcastStatus?.();
    json(res, { ok: true, message: "Restarting...", restarting: true });
    setTimeout(() => process.exit(0), 1000);
    return;
  }

  if (
    pathname.startsWith("/api/tts/") &&
    (await (async () => {
      const { handleTtsRoutes } = await getOptionalPluginApi<{
        handleTtsRoutes: (args: TtsRouteArg) => Promise<boolean>;
      }>("streaming");
      return handleTtsRoutes({
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
      });
    })())
  ) {
    return;
  }

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

  // Browser workspace routes (/api/browser-workspace/*) are served by the
  // @elizaos/app-browser plugin via Plugin.routes.

  // Agent self-status, Privy, and ERC-8004 registry routes are now handled
  // by handleAgentStatusRoutes above.

  // ═══════════════════════════════════════════════════════════════════════
  // BSC trade routes and wallet trade execute are handled by registered wallet
  // plugin routes when the relevant backend is installed.
  // ═══════════════════════════════════════════════════════════════════════

  if (
    isLifeOpsCloudPluginRoute(pathname) &&
    (await handleLifeOpsRuntimePluginRoute({
      req,
      res,
      method,
      pathname,
      url,
      state,
      isAuthorizedRequest: isAuthorized,
    }))
  ) {
    return;
  }

  if (
    await handleCloudAndCoreRouteGroup({
      req,
      res,
      method,
      pathname,
      state,
      restartRuntime,
      saveConfig: saveElizaConfig,
    })
  ) {
    return;
  }

  if (await handleSandboxRouteGroup({ req, res, method, pathname, state })) {
    return;
  }

  if (
    await handleConversationRouteGroup({
      req,
      res,
      method,
      pathname,
      url,
      state,
      json,
      error,
      readJsonBody,
    })
  ) {
    return;
  }

  if (await handleDatabaseRouteGroup({ req, res, pathname, state })) {
    return;
  }

  // Trajectory routes (/api/trajectories/*) are now provided by the
  // @elizaos/plugin-training plugin via the runtime route registry.

  // Coding Agent API routes (/api/coding-agents/*, /api/workspace/*,
  // /api/issues/*) are now provided by the @elizaos/plugin-agent-orchestrator
  // plugin via the runtime route registry. Most of those paths genuinely need
  // the runtime, so a pre-runtime 503 is correct. The GET capability probes
  // below are the exception: they have graceful builtin probe handlers
  // (handleBuiltinOptionalRoutes → { available: false } / "unavailable"). The
  // dashboard polls /preflight the instant agentStatus flips to "running", which
  // can race ahead of state.runtime being assigned during a restart; serve those
  // from the builtin probe handler instead of a 503 the browser logs as a red console error.
  const isCodingAgentBuiltinProbe =
    pathname === "/api/coding-agents/preflight" ||
    pathname === "/api/coding-agents/coordinator/status";
  if (
    !state.runtime &&
    method === "GET" &&
    pathname.startsWith("/api/coding-agents") &&
    !isCodingAgentBuiltinProbe
  ) {
    error(res, "Coding agent runtime unavailable", 503);
    return;
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
  if (pathname.startsWith("/api/apps")) {
    const { handleAppsRoutes } = await getAppManagerApi();
    const appManager = ctx?.getAppManager
      ? await ctx.getAppManager()
      : (state.appManager as AppManagerLike);
    const appActorRole: AppsRouteActorRole = isAuthorized(req)
      ? "OWNER"
      : "GUEST";
    if (
      await handleAppsRoutes({
        req,
        res,
        method,
        pathname,
        url,
        appManager: {
          listAvailable: (pluginManager) =>
            appManager.listAvailable(pluginManager),
          search: (pluginManager, query, limit) =>
            appManager.search(pluginManager, query, limit),
          listInstalled: (pluginManager) =>
            appManager.listInstalled(pluginManager),
          listRuns: (runtime) =>
            appManager.listRuns(
              runtime && typeof runtime === "object"
                ? (runtime as IAgentRuntime)
                : null,
            ),
          getRun: (runId, runtime) =>
            appManager.getRun(
              runId,
              runtime && typeof runtime === "object"
                ? (runtime as IAgentRuntime)
                : null,
            ),
          attachRun: (runId, runtime) =>
            appManager.attachRun(
              runId,
              runtime && typeof runtime === "object"
                ? (runtime as IAgentRuntime)
                : null,
            ),
          detachRun: (runId) => appManager.detachRun(runId),
          launch: (pluginManager, name, onProgress, runtime) =>
            appManager.launch(
              pluginManager,
              name,
              onProgress,
              runtime && typeof runtime === "object"
                ? (runtime as IAgentRuntime)
                : null,
              installPluginDirect,
            ),
          stop: (pluginManager, name, runId, runtime) =>
            appManager.stop(
              pluginManager,
              name,
              runId,
              runtime && typeof runtime === "object"
                ? (runtime as IAgentRuntime)
                : null,
            ),
          recordHeartbeat: (runId) => appManager.recordHeartbeat(runId),
          startStaleRunSweeper: (getRuntime) =>
            appManager.startStaleRunSweeper(getRuntime),
          getInfo: (pluginManager, name) =>
            appManager.getInfo(pluginManager, name),
        } satisfies AppManagerLike,
        getPluginManager: () => getPluginManagerForState(state),
        parseBoundedLimit,
        readJsonBody,
        json,
        error,
        runtime: state.runtime,
        actorRole: appActorRole,
        favoriteApps: {
          read: () => readFavoriteAppsFromConfig(state.config),
          write: (apps) => writeFavoriteAppsToConfig(state.config, apps),
        } satisfies FavoriteAppsStore,
        installPluginDirect,
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
  }

  // ── Slash-command catalog (/api/commands) ─────────────────────────────────
  if (
    await handleCommandsRoutes({
      req,
      res,
      method,
      pathname,
      url,
      json,
      error,
      runtime: state.runtime,
    })
  ) {
    return;
  }

  // ── Prompt suggestions (/api/suggestions) ─────────────────────────────────
  if (
    await handleSuggestionsRoutes({
      req,
      res,
      method,
      pathname,
      json,
      error,
      runtime: state.runtime,
    })
  ) {
    return;
  }

  // ── Interaction reporting (/api/interactions/shortcut) ────────────────────
  if (
    await handleInteractionsRoutes({
      req,
      res,
      method,
      pathname,
      json,
      error,
      runtime: state.runtime,
    })
  ) {
    return;
  }

  // ── View routes (/api/views/*) ────────────────────────────────────────────
  if (
    await handleViewsRoutes({
      req,
      res,
      method,
      pathname,
      url,
      json,
      error,
      broadcastWs: state.broadcastWs ?? undefined,
      runtime: state.runtime,
    })
  ) {
    return;
  }

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

  if (pathname.startsWith("/api/mcp")) {
    const { handleMcpRoutes } = await getOptionalPluginApi<{
      handleMcpRoutes: (args: unknown) => Promise<boolean>;
    }>("mcp");
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

  // ── WhatsApp routes (/api/whatsapp/*) ────────────────────────────────────
  // Extracted to @elizaos/plugin-whatsapp setup-routes.ts (Plugin.routes).

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
      hostContext: {
        config: state.config as Record<string, unknown>,
        saveConfig: (nextConfig) => {
          state.config = nextConfig as ElizaConfig;
          saveElizaConfig(state.config);
        },
        restartRuntime,
      },
    })
  ) {
    return;
  }

  if (await handleBuiltinOptionalRoutes(req, res, pathname, method)) {
    return;
  }

  // ── Connector plugin routes (dynamically registered) ────────────────────
  for (const handler of state.connectorRouteHandlers) {
    const handled = await handler(req, res, pathname, method);
    if (handled) return;
  }

  if (await handleMobileOptionalRoutes(req, res, pathname, method)) {
    return;
  }

  // ── Music player compatibility fallback ─────────────────────────────────
  if (
    await tryHandleMusicPlayerStatusFallbackLazy({
      pathname,
      method,
      runtime: state.runtime,
      res,
    })
  ) {
    return;
  }

  // ── LifeOps inbox compatibility fallback ────────────────────────────────
  // The inbox view is bundled independently from the PA-owned inbox cache
  // route. When PA is absent, serve an empty wire payload instead of a 404 loop.
  if (
    await tryHandleLifeOpsInboxFallbackLazy({
      pathname,
      method,
      url,
      res,
    })
  ) {
    return;
  }

  // ── Trajectory read routes (owned by core TrajectoriesService) ──────────
  // Serves GET /api/trajectories[/:id|/stats] from the core TrajectoriesService
  // when no plugin owns the route (mobile / training disabled), so the realtime
  // trajectory viewer works without @elizaos/plugin-training. Runs AFTER the
  // plugin routes above, so plugin-training's richer route wins when present.
  if (
    await tryHandleTrajectoryReadRoutes({
      pathname,
      method,
      url,
      runtime: state.runtime,
      res,
    })
  ) {
    return;
  }

  // ── Hono adapter for runtime.routes with `routeHandler` (new shape) ─────
  // Covers any plugin route registered via the new return-shape RouteHandler
  // contract. Legacy Express-shaped `handler` routes are still served by
  // `tryHandleRuntimePluginRoute` above.
  if (
    await tryHandleHonoRuntimeRoute({
      req,
      res,
      runtime: state.runtime,
      isAuthorized: () => isAuthorized(req),
      isTrustedLocal: () => isTrustedLocalRequest(req),
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
import { type captureEarlyLogs, flushEarlyLogs } from "./early-logs.ts";

export type { captureEarlyLogs };

// ---------------------------------------------------------------------------
// Server start
// ---------------------------------------------------------------------------

function strictPortBindingEnabled(): boolean {
  const value = process.env.ELIZA_API_STRICT_PORT?.trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes";
}

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
  // Gated boot profiler (off unless ELIZA_BOOT_PROFILE=1) to time the API-bind
  // critical path. Stderr, since the structured logger level may suppress it.
  const apiLap = (label: string): void => {
    if (process.env.ELIZA_BOOT_PROFILE === "1") {
      process.stderr.write(
        `[boot-profile] api:${label} +${Date.now() - apiStartTime}ms\n`,
      );
    }
  };
  logger.debug(`[eliza-api] startApiServer called`);

  // Honor ELIZA_API_PORT first (set by the desktop launcher → 31337) so
  // the renderer's hardcoded API base reaches this server. CLI-mode
  // (no ELIZA_API_PORT) keeps the legacy `resolveServerOnlyPort` default
  // of 2138, so this change is transparent for non-desktop users.
  const port =
    opts?.port ??
    (process.env.ELIZA_API_PORT
      ? resolveDesktopApiPort(process.env)
      : resolveServerOnlyPort(process.env));
  const host = resolveApiBindHost(process.env);
  ensureApiTokenForBindHost(host);
  logger.debug(`[eliza-api] Token check done (${Date.now() - apiStartTime}ms)`);

  let config: ElizaConfig;
  try {
    config = loadElizaConfig();
  } catch (err) {
    logger.warn(
      `[eliza-api] Failed to load config, starting with defaults: ${err instanceof Error ? err.message : err}`,
    );
    config = {} as ElizaConfig;
  }
  logger.debug(`[eliza-api] Config loaded (${Date.now() - apiStartTime}ms)`);

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

  const blockOnStewardWalletCache =
    process.env.ELIZA_STEWARD_WALLET_CACHE_BLOCKING?.trim() === "1";
  if (blockOnStewardWalletCache) {
    // Cloud/provisioned environments can opt into strict startup semantics
    // when wallet addresses must be available before the first request.
    const { initStewardWalletCache } = await getCoreWalletApi();
    await initStewardWalletCache();
  }

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
  logger.debug(
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
    activeChatTurnCount: 0,
    conversationRestorePromise: null,
    deletedConversationIds,
    cloudManager: null,
    sandboxManager: null,
    appManager: null,
    trainingService: null,
    shareIngestQueue: [],
    broadcastStatus: null,
    awaitRuntimeReady: null,
    broadcastWs: null,
    broadcastWsToClientId: null,
    broadcastWsToConversation: null,
    activeConversationId: null,
    deliveryDedupe: createDeliveryDedupeState(),
    permissionStates: {},
    shellEnabled: config.features?.shellEnabled !== false,
    agentAutomationMode: resolveAgentAutomationModeFromConfig(config),
    tradePermissionMode: resolveTradePermissionMode(config),
    pendingRestartReasons: [],
    connectorRouteHandlers: [],
    connectorHealthMonitor: null,
    whatsappPairingSessions: new Map(),
  };
  // Lets chat handlers HOLD a turn through the warming window (early API bind →
  // runtime ready) instead of 503-dropping it — woken in updateRuntime when
  // first-turn capability comes online (see runtime-ready-gate.ts).
  const runtimeReadyGate = createRuntimeReadyGate<AgentRuntime>(
    () => state.runtime,
  );
  state.awaitRuntimeReady = (timeoutMs: number) =>
    runtimeReadyGate.await(timeoutMs);
  const ensureAppManager = async (): Promise<AppManagerLike> => {
    if (state.appManager) {
      return state.appManager as AppManagerLike;
    }
    const { AppManager } = await getAppManagerApi();
    const appManager = new AppManager();
    state.appManager = appManager;
    return appManager as AppManagerLike;
  };
  const trainingServiceOptions = {
    getRuntime: () => state.runtime,
    getConfig: () => state.config,
    setConfig: (nextConfig: ElizaConfig) => {
      state.config = nextConfig;
      saveElizaConfig(nextConfig);
    },
  };
  const blockOnTrainingService =
    process.env.ELIZA_API_TRAINING_BLOCKING?.trim() === "1";
  const attachTrainingService = async (): Promise<void> => {
    if (state.trainingService) return;
    const trainingServiceCtor = await resolveTrainingServiceCtor();
    if (trainingServiceCtor) {
      state.trainingService = new trainingServiceCtor(trainingServiceOptions);
      await setActiveTrainingServiceIfAvailable(state.trainingService);
    } else {
      logger.info(
        "[eliza-api] Training service package unavailable; training routes will be disabled",
      );
    }
  };
  if (blockOnTrainingService) {
    await attachTrainingService();
  }
  const configuredAdminEntityId = config.agents?.defaults?.adminEntityId;
  if (configuredAdminEntityId && isUuidLike(configuredAdminEntityId)) {
    state.adminEntityId = configuredAdminEntityId;
    state.chatUserId = state.adminEntityId;
  } else if (configuredAdminEntityId) {
    logger.warn(
      `[eliza-api] Ignoring invalid agents.defaults.adminEntityId "${configuredAdminEntityId}"`,
    );
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

  logger.debug(
    `[eliza-api] Creating http server (${Date.now() - apiStartTime}ms)`,
  );
  apiLap("pre-createServer (route imports + middleware setup done)");
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
        getAppManager: ensureAppManager,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "internal error";
      logger.error({ err }, `[eliza-api] Request handler failed: ${msg}`);
      addLog("error", msg, "api", ["server", "api"]);
      error(res, msg, 500);
    }
  });
  if (
    isMobilePlatform() ||
    process.env.ELIZA_DEVICE_BRIDGE_ENABLED?.trim() === "1"
  ) {
    // Defer to a macrotask: resolving @elizaos/plugin-capacitor-bridge (and its
    // device-bridge attach) measured ~15s of blocking on the mobile bundle and
    // — because it sat on the synchronous pre-`server.listen` path — held the
    // whole API bind (and the boot screen) hostage for that entire time (#11903).
    // The bridge only needs to attach a WS upgrade handler to the server object,
    // which works fine once the server is already listening.
    setImmediate(() => {
      void getOptionalPluginApi<{
        attachMobileDeviceBridgeToServer: (
          server: http.Server,
        ) => Promise<void>;
      }>("capacitor")
        .then(({ attachMobileDeviceBridgeToServer }) =>
          attachMobileDeviceBridgeToServer(server),
        )
        .catch((err: unknown) => {
          logger.warn(
            "[eliza-api] Failed to attach mobile device bridge:",
            err instanceof Error ? err.message : String(err),
          );
        });
    });
  }
  logger.debug(`[eliza-api] Server created (${Date.now() - apiStartTime}ms)`);

  // Node's `http.createServer` defaults are tuned for snappy web traffic:
  //   - requestTimeout: 300_000 ms (5 min) — closes the socket if the
  //     full request hasn't completed in 5 minutes.
  //   - headersTimeout: 60_000 ms — closes the socket if headers
  //     haven't arrived in 60 s.
  //   - keepAliveTimeout: 5_000 ms — closes idle connections after 5 s.
  //
  // Local-inference chat completions on AOSP cuttlefish CPU routinely
  // run 5–25 minutes per turn (planner + action evaluator + reply,
  // each with a 9k-token prompt prefilled at ~20 tok/s). The 300 s
  // requestTimeout aborts the response mid-generation and the client
  // sees `fetch failed` while the agent's chat-routes timeout
  // (ELIZA_CHAT_GENERATION_TIMEOUT_MS, default 180 s, AOSP override
  // 1_800_000 ms = 30 min) is still ticking. The result: the device
  // does the work, the model produces a reply, but the HTTP socket
  // is already closed by the time the reply is ready.
  //
  // Read overrides from env so non-AOSP deploys keep tighter defaults,
  // and AOSP can pass a generous bound that matches the chat-routes
  // generation budget. ELIZA_HTTP_REQUEST_TIMEOUT_MS is the canonical
  // override; falls back to ELIZA_CHAT_GENERATION_TIMEOUT_MS + 60 s
  // slack so a single env var can drive the whole pipeline.
  const requestTimeoutEnvRaw =
    process.env.ELIZA_HTTP_REQUEST_TIMEOUT_MS?.trim() ?? "";
  const chatTimeoutEnvRaw =
    process.env.ELIZA_CHAT_GENERATION_TIMEOUT_MS?.trim() ?? "";
  const requestTimeoutMs = (() => {
    const explicit = Number.parseInt(requestTimeoutEnvRaw, 10);
    if (Number.isFinite(explicit) && explicit > 0) return explicit;
    const chatTimeout = Number.parseInt(chatTimeoutEnvRaw, 10);
    if (Number.isFinite(chatTimeout) && chatTimeout > 0) {
      // 60 s slack covers the round-trip overhead between chat-routes
      // resolving the generation promise and the response actually
      // landing on the wire.
      return chatTimeout + 60_000;
    }
    // No override and no chat-timeout hint — keep Node's default
    // (300_000 ms / 5 min) which matches the upstream behavior.
    return 300_000;
  })();
  // headersTimeout MUST be ≤ requestTimeout per Node docs. We give it
  // a 60 s lower bound so a slow client header upload doesn't cap the
  // long-tail decode budget.
  const headersTimeoutMs = Math.min(60_000, requestTimeoutMs);
  // keepAliveTimeout is for IDLE connections after a response. Bumping
  // it doesn't help long-running requests but keeps connections warm
  // for chat-completion clients that fire repeated turns.
  const keepAliveTimeoutMs = 60_000;
  server.requestTimeout = requestTimeoutMs;
  server.headersTimeout = headersTimeoutMs;
  server.keepAliveTimeout = keepAliveTimeoutMs;
  // server.timeout is the IDLE socket timeout (legacy). Setting to 0
  // disables it; we want long-running requests to ride on the
  // requestTimeout above instead. Default in Node 22 is 0 already, but
  // pin explicitly for clarity.
  server.timeout = 0;
  logger.debug(
    `[eliza-api] Server timeouts: requestTimeout=${requestTimeoutMs}ms, headersTimeout=${headersTimeoutMs}ms, keepAliveTimeout=${keepAliveTimeoutMs}ms`,
  );

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
    event: Omit<StreamEventEnvelope, "eventId" | "version" | "bufferSeq">,
  ) => {
    const seq = state.nextEventId;
    const envelope: StreamEventEnvelope = {
      ...event,
      eventId: `evt-${seq}`,
      bufferSeq: seq,
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
  const startDeferredStartupWork = async (): Promise<void> => {
    void registerBuiltinViews().catch((err) => {
      logger.warn(
        `[eliza-api] Built-in view registration failed after listen: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    });

    void ensureAppManager()
      .then((appManager) => {
        // Stop app runs whose UI heartbeat has gone silent.
        appManager.startStaleRunSweeper(() => state.runtime);
      })
      .catch((err) => {
        logger.warn(
          `[eliza-api] App manager startup work failed after listen: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      });

    if (!blockOnStewardWalletCache) {
      void getCoreWalletApi()
        .then(({ initStewardWalletCache }) => initStewardWalletCache())
        .catch((err) => {
          logger.debug(
            `[eliza-api] Steward wallet cache init failed after listen: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        });
    }

    void (async () => {
      try {
        const { discoverSkills } = await getAgentSkillsApi();
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
      await attachTrainingService();
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

    // ── Connector health monitoring ──────────────────────────────────────────
    if (state.runtime && state.config.connectors) {
      try {
        state.connectorHealthMonitor = await createConnectorHealthMonitor({
          runtime: state.runtime,
          config: state.config,
          broadcastWs,
        });
        state.connectorHealthMonitor.start();
      } catch (err) {
        logger.warn(
          `[eliza-api] Connector health monitor failed after listen: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }

    // ── Dynamic streaming + connector route loading ────────────────────────
    // Always register generic stream routes. If a streaming destination is
    // configured, inject it so /api/stream/live can fetch credentials.
    void (async () => {
      if (
        isMobilePlatform() &&
        process.env.ELIZA_MOBILE_ENABLE_STREAMING_ROUTES !== "1"
      ) {
        logger.debug(
          "[eliza-api] Desktop streaming routes disabled on mobile platform.",
        );
        return;
      }
      try {
        const streamRoutes = await import(
          /* @vite-ignore */ "@elizaos/plugin-streaming"
        );
        const handleStreamRoute =
          typeof streamRoutes.handleStreamRoute === "function"
            ? streamRoutes.handleStreamRoute
            : null;
        if (!handleStreamRoute) {
          logger.debug(
            "[eliza-api] @elizaos/plugin-streaming did not export handleStreamRoute; skipping streaming route registration.",
          );
        }
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
        const destinations = new Map<string, StreamRouteDestination>();

        try {
          const streamMod = await loadStreamingPluginDestinationFactories();

          if (
            isStreamingDestinationConfigured(
              "customRtmp",
              streaming?.customRtmp,
            )
          ) {
            destinations.set(
              "custom-rtmp",
              streamMod.createCustomRtmpDestination(
                streaming?.customRtmp as {
                  rtmpUrl?: string;
                  rtmpKey?: string;
                },
              ),
            );
          }

          const rawSources = streaming?.rtmpSources;
          if (Array.isArray(rawSources)) {
            for (const row of rawSources) {
              if (!row || typeof row !== "object") continue;
              const rec = row as Record<string, string | undefined>;
              const id = String(rec.id ?? "").trim();
              const name = String(rec.name ?? id).trim();
              const rtmpUrl = String(rec.rtmpUrl ?? "").trim();
              const rtmpKey = String(rec.rtmpKey ?? "").trim();
              if (!id || !rtmpUrl || !rtmpKey) continue;
              destinations.set(
                id,
                streamMod.createNamedRtmpDestination({
                  id,
                  name,
                  rtmpUrl,
                  rtmpKey,
                }),
              );
            }
          }

          if (isStreamingDestinationConfigured("twitch", streaming?.twitch)) {
            destinations.set(
              "twitch",
              streamMod.createTwitchDestination(
                undefined,
                streaming?.twitch as { streamKey?: string },
              ),
            );
          }

          if (isStreamingDestinationConfigured("youtube", streaming?.youtube)) {
            destinations.set(
              "youtube",
              streamMod.createYoutubeDestination(
                undefined,
                streaming?.youtube as { streamKey?: string; rtmpUrl?: string },
              ),
            );
          }

          if (isStreamingDestinationConfigured("pumpfun", streaming?.pumpfun)) {
            destinations.set(
              "pumpfun",
              streamMod.createPumpfunDestination(
                undefined,
                streaming?.pumpfun as { streamKey?: string; rtmpUrl?: string },
              ),
            );
          }

          if (isStreamingDestinationConfigured("x", streaming?.x)) {
            destinations.set(
              "x",
              streamMod.createXStreamDestination(
                undefined,
                streaming?.x as { streamKey?: string; rtmpUrl?: string },
              ),
            );
          }
        } catch (err) {
          logger.warn(
            `[eliza-api] Failed to load @elizaos/plugin-streaming destinations: ${err instanceof Error ? err.message : String(err)}`,
          );
        }

        // Active destination: config preference → first available
        const activeDestinationId =
          (streaming?.activeDestination as string | undefined) ??
          (destinations.size > 0
            ? destinations.keys().next().value
            : undefined);
        const { streamManager } = await getOptionalPluginApi<{
          streamManager: unknown;
        }>("streaming");

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
              // Keep an already-consistent presetId: avatarIndex is a VRM
              // art-asset index shared by several personas, so re-deriving the
              // preset from the index would overwrite the user's persona (e.g.
              // persisting presetId "chen" over an Eliza selection).
              const presetId = resolveMirroredAvatarPresetId(
                state.config.ui?.presetId ?? diskCfg.ui?.presetId,
                avatarIndex,
                lang,
              );
              const nextUi: ElizaConfig["ui"] = {
                ...(state.config.ui ?? {}),
                avatarIndex,
                ...(presetId ? { presetId } : {}),
              };
              state.config = {
                ...state.config,
                ui: nextUi,
              };
              // Merge disk + live server config so we never persist a minimal
              // snapshot (e.g. ENOENT default) and clobber eliza.json during
              // first-run while state.config still holds the full boot payload.
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
                      | import("../config/types.messages.ts").TtsConfig
                      | undefined,
                  },
                }
              : undefined;
          },
        };
        // `handleStreamRoute` is exported by `@elizaos/plugin-streaming`,
        // which the mobile bundle replaces with a null-plugin proxy (see
        // `packages/agent/scripts/build-mobile-bundle.mjs` —
        // `@elizaos/plugin-streaming` is in the mobile replacement allowlist because the
        // TTS / SSE worker pool has zero mobile use). On mobile the
        // dynamic import resolves successfully but `handleStreamRoute` is
        // `undefined`, and the closure here gets pushed into
        // `connectorRouteHandlers` anyway — so every inbound HTTP request
        // (including `/api/local-inference/device-bridge/status`) errors
        // with `handleStreamRoute is not a function`. Skip the push when
        // the import returned a null-plugin proxy.
        if (typeof handleStreamRoute === "function") {
          state.connectorRouteHandlers.push((req, res, pathname, method) =>
            handleStreamRoute(req, res, pathname, method, streamState as never),
          );
        }

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
  // A server-level 'error' with no listener crashes the process. Abrupt client
  // disconnects (RST during/after the upgrade handshake) surface here.
  wss.on("error", (err: unknown) => {
    logger.warn(
      `[eliza-api] WebSocketServer error: ${err instanceof Error ? err.message : err}`,
    );
  });
  const wsClients = new Set<WebSocket>();
  const wsClientIds = new WeakMap<WebSocket, string>();
  /**
   * Per-connection active conversation. Each browser window/client owns its own
   * active conversation, so two windows no longer fight over a single global.
   * `state.activeConversationId` is kept as the "most recent active conversation"
   * default for code paths that legitimately need *any* active conversation
   * (autonomy routing, swarm synthesis) and don't target a specific client.
   */
  const wsActiveConversations = new WeakMap<WebSocket, string>();
  /** Per-WS-client PTY output subscriptions: sessionId → unsubscribe */
  const wsClientPtySubscriptions = new WeakMap<
    WebSocket,
    Map<string, () => void>
  >();
  /**
   * Grace-window reap timers for disconnected PTY owners, keyed by clientId.
   * A WS close/error no longer kills the client's PTY sessions instantly —
   * phone lock, app switch, or a network blip would otherwise nuke a live
   * interactive terminal. The stop is delayed by the grace window and
   * canceled when the same clientId re-authenticates (ownership survives
   * reconnects because sessions are owned by clientId, not by socket).
   */
  const wsPtyPendingStops = new Map<string, ReturnType<typeof setTimeout>>();
  const wsPtyDisconnectGraceMs = resolvePtyDisconnectGraceMs(
    process.env.ELIZA_PTY_WS_DISCONNECT_GRACE_MS,
  );
  /**
   * Short-window idempotency cache for client-tagged WS messages, keyed by
   * `${clientId}:${msgId}`. A message resent after a reconnect (same id) is
   * dropped if seen within the TTL. Entries expire so the map stays bounded.
   */
  const wsSeenMessageIds = new Map<string, number>();
  const WS_DEDUPE_TTL_MS = 30_000;
  let wsSeenLastSweepAt = 0;
  const isDuplicateWsMessage = (
    clientId: string | undefined,
    msgId: unknown,
  ): boolean => {
    if (typeof msgId !== "string" || msgId.length === 0) return false;
    const key = `${clientId ?? "anon"}:${msgId}`;
    const now = Date.now();
    // O(1) TTL-aware dedupe: a still-fresh entry means this id was already seen
    // within the window. Correctness no longer depends on first scanning the
    // whole map — the previous full-scan-on-every-message was O(n) per message
    // (O(n^2) under a burst).
    const seenAt = wsSeenMessageIds.get(key);
    if (seenAt !== undefined && now - seenAt <= WS_DEDUPE_TTL_MS) return true;
    wsSeenMessageIds.set(key, now);
    // Amortized eviction: sweep expired entries at most once per TTL window
    // instead of on every message; keeps the map bounded without the per-
    // message scan.
    if (now - wsSeenLastSweepAt > WS_DEDUPE_TTL_MS) {
      wsSeenLastSweepAt = now;
      for (const [seenKey, ts] of wsSeenMessageIds) {
        if (now - ts > WS_DEDUPE_TTL_MS) wsSeenMessageIds.delete(seenKey);
      }
    }
    return false;
  };
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
    // The raw upgrade socket can emit 'error' (client RST mid-handshake) before
    // a WebSocket — and its error handler — exists. Unhandled, it crashes the
    // process. Attach a no-op-ish guard for the whole upgrade window.
    socket.on("error", (err: unknown) => {
      logger.warn(
        `[eliza-api] WS upgrade socket error: ${err instanceof Error ? err.message : err}`,
      );
      try {
        socket.destroy();
      } catch {}
    });
    try {
      const wsUrl = new URL(
        request.url ?? "/",
        `http://${request.headers.host ?? "localhost"}`,
      );
      if (wsUrl.pathname === "/api/local-inference/device-bridge") {
        return;
      }
      const rejection = resolveWebSocketUpgradeRejection(request, wsUrl);
      if (rejection) {
        rejectWebSocketUpgrade(socket, rejection.status, rejection.reason);
        return;
      }
      wss.handleUpgrade(request, socket, head, (ws: WebSocket) => {
        // Attach an 'error' listener IMMEDIATELY — before emit('connection')
        // runs the (long) connection handler that only attaches its own error
        // listener near the end. A client that RSTs in that window otherwise
        // emits an unhandled 'error' on the ws and crashes the process.
        ws.on("error", (err: unknown) => {
          logger.warn(
            `[eliza-api] WebSocket error: ${err instanceof Error ? err.message : err}`,
          );
        });
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
    let wsClientId: string | null = null;
    let wsUrl: URL;
    try {
      wsUrl = new URL(
        request.url ?? "/",
        `http://${request.headers.host ?? "localhost"}`,
      );
      const clientId = normalizeWsClientId(wsUrl.searchParams.get("clientId"));
      if (clientId) {
        wsClientId = clientId;
        wsClientIds.set(ws, clientId);
      }
    } catch {
      // Ignore malformed WS URL metadata; auth/path were already validated.
      wsUrl = new URL("ws://localhost/ws");
    }

    let isAuthenticated = isWebSocketAuthorized(request, wsUrl);

    // Optional reconnect cursor: a client that tracks the highest buffered
    // event sequence it has applied can pass it back as `?lastEventId=` so the
    // server replays only the envelopes it is missing instead of re-flooding
    // the full tail on every (re)connect (loadperf research 05, Finding 4).
    // Absent/invalid => null => the historical slice(-DEFAULT_REPLAY_LIMIT)
    // behavior, so existing clients are unaffected.
    const replayCursor = parseEventCursor(
      wsUrl.searchParams.get("lastEventId") ?? wsUrl.searchParams.get("since"),
    );

    const activateAuthenticatedConnection = () => {
      wsClients.add(ws);
      if (
        wsClientId &&
        cancelPendingPtySessionStop(wsClientId, wsPtyPendingStops)
      ) {
        logger.info(
          `[eliza-api] client ${wsClientId} reconnected within the PTY grace window; keeping its PTY sessions alive`,
        );
      }
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
            // Same server-authoritative readiness signal as broadcastStatus and
            // /api/status. Without it on the initial-connect status, every WS
            // (re)connect delivers canRespond: undefined and re-gates the chat
            // composer back to "waking up" until the next 5s broadcast.
            canRespond: computeCanRespond(state.runtime, state.agentState),
            startedAt: state.startedAt,
            startup: state.startup,
            pendingRestart: state.pendingRestartReasons.length > 0,
            pendingRestartReasons: state.pendingRestartReasons,
          }),
        );
        const replay = selectReplayEvents(
          state.eventBuffer,
          replayCursor,
          DEFAULT_REPLAY_LIMIT,
        );
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

    const currentClientOwnsPtySession = (sessionId: string): boolean => {
      const service = getPtyService(state);
      const session = service
        ?.listSessions?.()
        .find((candidate) => candidate.sessionId === sessionId);
      if (!session?.ownerClientId) return true;
      return Boolean(wsClientId && session.ownerClientId === wsClientId);
    };

    const stopOwnedPtySessions = (reason: string): void => {
      if (!wsClientId) return;
      const service = getPtyService(state);
      if (!service?.listSessions || !service.stopSession) return;
      const owned = service
        .listSessions()
        .filter((session) => session.ownerClientId === wsClientId);
      for (const session of owned) {
        void service.stopSession(session.sessionId).catch((err) => {
          logger.warn(
            `[eliza-api] failed to stop PTY session ${session.sessionId} on ${reason}: ${err instanceof Error ? err.message : err}`,
          );
        });
      }
    };

    /**
     * Reap this client's PTY sessions only after the disconnect grace window,
     * and only if no other live authenticated socket carries the same
     * clientId (multi-tab) and the client hasn't reconnected in the interim.
     */
    const scheduleStopOwnedPtySessions = (reason: string): void => {
      if (!wsClientId) return;
      const clientId = wsClientId;
      const clientHasLiveConnection = (): boolean => {
        for (const other of wsClients) {
          if (
            other !== ws &&
            other.readyState === 1 &&
            wsClientIds.get(other) === clientId
          ) {
            return true;
          }
        }
        return false;
      };
      schedulePtySessionStopAfterGrace({
        clientId,
        graceMs: wsPtyDisconnectGraceMs,
        pendingStops: wsPtyPendingStops,
        clientHasLiveConnection,
        stopOwnedSessions: () => stopOwnedPtySessions(reason),
      });
    };

    ws.on("message", async (data: unknown) => {
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
        if (isDuplicateWsMessage(wsClientIds.get(ws), msg.msgId)) {
          return;
        }
        if (msg.type === "ping") {
          ws.send(JSON.stringify({ type: "pong" }));
        } else if (msg.type === "active-conversation") {
          // Per-connection: only this client's active conversation changes.
          const conversationId =
            typeof msg.conversationId === "string" ? msg.conversationId : null;
          if (conversationId) {
            wsActiveConversations.set(ws, conversationId);
          } else {
            wsActiveConversations.delete(ws);
          }
          // Keep the global as a sensible "any/most-recent active conversation"
          // default for non-client-targeted routing (autonomy, swarm synthesis).
          state.activeConversationId = conversationId;
        } else if (
          msg.type === "pty-subscribe" &&
          typeof msg.sessionId === "string"
        ) {
          const bridge = getPtyConsoleBridge(state);
          if (bridge) {
            if (!currentClientOwnsPtySession(msg.sessionId)) {
              logger.warn(
                `[eliza-api] pty-subscribe rejected: client ${wsClientId ?? "unknown"} does not own session ${msg.sessionId}`,
              );
              return;
            }
            let subs = wsClientPtySubscriptions.get(ws);
            if (!subs) {
              subs = new Map();
              wsClientPtySubscriptions.set(ws, subs);
            }
            // Don't double-subscribe
            if (!subs.has(msg.sessionId)) {
              const targetId = msg.sessionId;
              // Bridges BOTH `session_output` (→ pty-output) and
              // `session_exit` (→ pty-exit) so the client can surface a dead
              // session instead of showing a "ready" pane forever.
              const detach = attachPtySessionWsBridge({
                bridge,
                sessionId: targetId,
                send: (frame) => {
                  if (ws.readyState === 1) {
                    ws.send(JSON.stringify(frame));
                  }
                },
              });
              subs.set(targetId, detach);
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
          } else if (!currentClientOwnsPtySession(msg.sessionId)) {
            logger.warn(
              `[eliza-api] pty-input rejected: client ${wsClientId ?? "unknown"} does not own session ${msg.sessionId}`,
            );
          } else if (msg.data.length > MAX_PTY_INPUT_MESSAGE_LENGTH) {
            // Per-message DoS cap only — the client chunks large pastes into
            // <=cap messages (sendPtyInput), so hitting this means a
            // misbehaving client. Echo a pty-error so the drop isn't silent.
            logger.warn(
              `[eliza-api] pty-input rejected: payload too large (${msg.data.length} chars) for session ${msg.sessionId}`,
            );
            if (ws.readyState === 1) {
              ws.send(
                JSON.stringify({
                  type: "pty-error",
                  sessionId: msg.sessionId,
                  code: "input-too-large",
                  message: `pty-input exceeds ${MAX_PTY_INPUT_MESSAGE_LENGTH} chars; send large input in chunks`,
                }),
              );
            }
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
          } else if (!currentClientOwnsPtySession(msg.sessionId)) {
            logger.warn(
              `[eliza-api] pty-resize rejected: client ${wsClientId ?? "unknown"} does not own session ${msg.sessionId}`,
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
        } else if (
          msg.type === "view:interact:result" &&
          typeof msg.requestId === "string"
        ) {
          void import("./views-routes.ts")
            .then(({ resolveViewInteractResult }) => {
              resolveViewInteractResult({
                requestId: msg.requestId,
                success: msg.success === true,
                result: msg.result,
                error: typeof msg.error === "string" ? msg.error : undefined,
              });
            })
            .catch((err) => {
              logger.error(
                `[eliza-api] view interaction result error: ${err instanceof Error ? err.message : err}`,
              );
            });
        }
      } catch (err) {
        logger.error(
          `[eliza-api] WebSocket message error: ${err instanceof Error ? err.message : err}`,
        );
      }
    });

    ws.on("close", () => {
      wsClients.delete(ws);
      wsActiveConversations.delete(ws);
      // Clean up any PTY output subscriptions for this client
      const subs = wsClientPtySubscriptions.get(ws);
      if (subs) {
        for (const unsub of subs.values()) unsub();
        subs.clear();
      }
      scheduleStopOwnedPtySessions("websocket close");
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
      wsActiveConversations.delete(ws);
      // Clean up PTY subscriptions on error too
      const subs = wsClientPtySubscriptions.get(ws);
      if (subs) {
        for (const unsub of subs.values()) unsub();
        subs.clear();
      }
      scheduleStopOwnedPtySessions("websocket error");
    });
  });

  // Broadcast status to all connected WebSocket clients (flattened — PR #36 fix)
  const broadcastStatus = () => {
    // Skip the payload build + computeCanRespond() when no dashboard is
    // connected. This fires every 5s (statusInterval) plus on every state
    // change for the whole process lifetime; a headless / background agent
    // commonly has zero WS clients, so this was pure idle-CPU waste. A newly
    // connected client gets its authoritative status on connect (see
    // activateAuthenticatedConnection), so nothing depends on this running
    // while the client set is empty.
    if (wsClients.size === 0) {
      return;
    }
    broadcastWs({
      type: "status",
      state: state.agentState,
      agentName: state.agentName,
      model: state.model,
      // Carry the same server-authoritative readiness signal `/api/status`
      // returns. Without it, every 5s WS status broadcast resets the client's
      // `agentStatus.canRespond` to undefined, re-gating the chat composer back
      // to "waking up" even though the agent is fully ready and replying.
      canRespond: computeCanRespond(state.runtime, state.agentState),
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

  // Conversation-scoped push: only clients with this conversation active.
  state.broadcastWsToConversation = (conversationId: string, data: object) => {
    const message = JSON.stringify(data);
    let delivered = 0;
    for (const client of wsClients) {
      if (client.readyState !== 1) continue;
      if (wsActiveConversations.get(client) !== conversationId) continue;
      try {
        client.send(message);
        delivered += 1;
      } catch (err) {
        logger.error(
          `[eliza-api] WebSocket conversation send error: ${err instanceof Error ? err.message : err}`,
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
      if (!rooms.length) return;

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

        const conversationMetadata = await extractConversationMetadataFromRoom(
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
    wireProactiveInteractionDecider(opts.runtime, state);
  }

  const assertX402RoutesValid = async (
    rt: AgentRuntime | null | undefined,
  ): Promise<void> => {
    if (!rt || !runtimeRoutesNeedX402Validation(rt.routes)) return;
    const agentId =
      rt.agentId != null && String(rt.agentId).length > 0
        ? String(rt.agentId)
        : undefined;
    const x402 = await getX402Plugin();
    if (!x402) return; // x402 module unavailable (e.g. mobile bundle) — nothing to validate
    const { validateX402Startup } = x402;
    const result = validateX402Startup(rt.routes as Route[], rt.character, {
      agentId,
    });
    if (!result || typeof result !== "object") {
      logger.warn(
        "[x402] startup validator returned no result; skipping x402 route validation",
      );
      return;
    }
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
    void assertX402RoutesValid(rt).catch((err) => {
      logger.error(
        `[x402] runtime route validation failed after update: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    });
    state.runtime = rt;
    state.chatConnectionReady = null;
    state.chatConnectionPromise = null;
    bindRuntimeStreams(rt);
    // Wake any chat turns held through the warming window — first-turn
    // capability is now online, so they stream their response instead of 503.
    runtimeReadyGate.markReady(rt);
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
    wireProactiveInteractionDecider(rt, state);

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

  logger.debug(
    `[eliza-api] Calling server.listen (${Date.now() - apiStartTime}ms)`,
  );
  await assertX402RoutesValid(state.runtime);
  return new Promise((resolve, reject) => {
    let currentPort = port;
    const strictPortBinding = strictPortBindingEnabled();

    server.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") {
        logger.warn(
          `[eliza-api] Port ${currentPort} is already in use. Checking fallback...`,
        );
        if (currentPort !== 0 && !strictPortBinding) {
          logger.warn(`[eliza-api] Retrying with dynamic port (0)...`);
          currentPort = 0;
          server.listen(0, host);
          return;
        }
        if (strictPortBinding) {
          logger.error(
            `[eliza-api] Strict port binding is enabled; refusing dynamic fallback from ${currentPort}.`,
          );
        }
      } else {
        logger.error(
          `[eliza-api] Server error: ${err.message} (code: ${err.code})`,
        );
      }
      reject(err);
    });

    apiLap("before server.listen");
    server.listen(port, host, () => {
      apiLap("LISTENING (API bound)");
      logger.debug(
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
        void startDeferredStartupWork();
      }
      resolve({
        port: actualPort,
        close: () =>
          new Promise<void>((r) => {
            void Promise.resolve().then(() => {
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
                  if ("terminate" in ws && typeof ws.terminate === "function") {
                    ws.terminate();
                  } else {
                    ws.close();
                  }
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
                void Promise.resolve(
                  state.telegramAccountAuthSession.stop(),
                ).catch(() => {
                  /* non-fatal */
                });
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
            });
          }),
        updateRuntime,
        updateStartup,
      });
    });
  });
}
