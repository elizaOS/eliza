import "@elizaos/shared";
import fs from "node:fs";
import http from "node:http";
import { createRequire } from "node:module";
import path from "node:path";
import {
  AGENT_EVENT_ALLOWED_STREAMS,
  CONFIG_WRITE_ALLOWED_TOP_KEYS,
  type ConversationMeta,
  clearPersistedOnboardingConfig,
  cloneWithoutBlockedObjectKeys,
  discoverInstalledPlugins,
  discoverPluginsFromManifest,
  type ElizaConfig,
  extractAuthToken,
  fetchWithTimeoutGuard,
  handleCloudBillingRoute,
  handleCloudCompatRoute,
  initStewardWalletCache,
  isAllowedHost,
  isAuthorized,
  loadElizaConfig,
  normalizeWsClientId,
  persistConversationRoomTitle,
  resolveDefaultAgentWorkspaceDir,
  resolveMcpServersRejection,
  resolvePluginConfigMutationRejections,
  resolveUserPath,
  routeAutonomyTextToUser,
  saveElizaConfig,
  streamResponseBodyWithByteLimit,
  startApiServer as upstreamStartApiServer,
  validateMcpServerConfig,
} from "@elizaos/agent";
// Override the wallet export rejection function with the hardened version
// that adds rate limiting, audit logging, and a forced confirmation delay.
import { type AgentRuntime, logger, resolveStateDir } from "@elizaos/core";
import { resolveLinkedAccountsInConfig } from "@elizaos/shared";
import {
  ensureCompatSensitiveRouteAuthorized,
  ensureRouteAuthorized,
} from "./auth.ts";
import { handleAutomationsCompatRoutes } from "./automations-compat-routes";
import {
  type CompatRuntimeState,
  clearCompatRuntimeRestart,
  getConfiguredCompatAgentName,
} from "./compat-route-shared";
import { sendJson as sendJsonResponse } from "./response";

export {
  __resetCloudBaseUrlCache,
  ensureCloudTtsApiKeyAlias,
  resolveCloudTtsBaseUrl,
  resolveElevenLabsApiKeyForCloudMode,
} from "@elizaos/plugin-elizacloud";
export {
  type CompatRuntimeState,
  DATABASE_UNAVAILABLE_MESSAGE,
  getConfiguredCompatAgentName,
  hasCompatPersistedOnboardingState,
  isLoopbackRemoteAddress,
  readCompatJsonBody,
} from "./compat-route-shared";
export {
  filterConfigEnvForResponse,
  SENSITIVE_ENV_RESPONSE_KEYS,
} from "./server-config-filter";
export {
  buildCorsAllowedPorts,
  invalidateCorsAllowedPorts,
} from "./server-cors";
export { injectApiBaseIntoHtml } from "./server-html";
// Re-export helpers from split-out modules so tests can import from "./server"
export {
  ensureApiTokenForBindHost,
  resolveMcpTerminalAuthorizationRejection,
  resolveTerminalRunClientId,
  resolveTerminalRunRejection,
  resolveWebSocketUpgradeRejection,
} from "./server-security";
export {
  findOwnPackageRoot,
  isSafeResetStateDir,
  resolveCorsOrigin,
} from "./server-startup";
export { resolveWalletExportRejection } from "./server-wallet-trade";
export {
  AGENT_EVENT_ALLOWED_STREAMS,
  CONFIG_WRITE_ALLOWED_TOP_KEYS,
  type ConversationMeta,
  cloneWithoutBlockedObjectKeys,
  discoverInstalledPlugins,
  discoverPluginsFromManifest,
  extractAuthToken,
  fetchWithTimeoutGuard,
  isAllowedHost,
  isAuthorized,
  normalizeWsClientId,
  persistConversationRoomTitle,
  resolveMcpServersRejection,
  resolvePluginConfigMutationRejections,
  routeAutonomyTextToUser,
  streamResponseBodyWithByteLimit,
  validateMcpServerConfig,
};

import {
  ensureRuntimeSqlCompatibility,
  executeRawSql,
  isElizaSettingsDebugEnabled,
  sanitizeIdentifier,
  settingsDebugCloudSummary,
  sqlLiteral,
} from "@elizaos/shared";
import { buildCharacterFromConfig } from "../runtime/build-character-from-config";
import { deviceBridge } from "../services/local-inference/device-bridge";
import { handleAuthBootstrapRoutes } from "./auth-bootstrap-routes";
import { handleAuthPairingCompatRoutes } from "./auth-pairing-compat-routes";
import { handleAuthSessionRoutes } from "./auth-session-routes";
import { handleCatalogRoutes } from "./catalog-routes";
import { handleDatabaseRowsCompatRoute } from "./database-rows-compat-routes";
import { handleDevCompatRoutes } from "./dev-compat-routes";
// Local-inference routes intentionally remain in app-core (no plugin-local-inference exists).
import { handleLocalInferenceCompatRoutes } from "./local-inference-compat-routes";
import { handleOnboardingCompatRoute } from "./onboarding-compat-routes";
import { handlePluginsCompatRoutes } from "./plugins-compat-routes";
import { handleSecretsInventoryRoute } from "./secrets-inventory-routes";
import { handleSecretsManagerRoute } from "./secrets-manager-routes";
import { getCorsAllowedPorts, isAllowedOrigin } from "./server-cors";

// Wallet market overview route extracted to @elizaos/plugin-wallet/routes/wallet-market-overview-route.
// Now served via walletRoutePlugin.routes (rawPath) on the runtime plugin route system.

// Phase 2 extraction: Steward compat routes → app-steward/src/plugin.ts (stewardPlugin)
// Includes: handleWalletBrowserCompatRoutes, handleWalletTradeCompatRoutes,
//           handleStewardCompatRoutes, handleWalletCompatRoutes
import { handleWorkbenchCompatRoutes } from "./workbench-compat-routes";

const _require = createRequire(import.meta.url);

import { syncAppEnvToEliza, syncElizaEnvAliases } from "@elizaos/shared";

// Lazy-imported to avoid circular dependency with runtime/eliza.ts
const lazyEnsureTTS = () =>
  import("../runtime/ensure-text-to-speech-handler.js").then(
    (m) => m.ensureTextToSpeechHandler,
  );

import { clearCloudSecrets, getCloudSecret } from "@elizaos/plugin-elizacloud";
import { getStartupEmbeddingAugmentation } from "../runtime/startup-overlay.js";
import { hydrateWalletKeysFromNodePlatformSecureStore } from "../security/hydrate-wallet-keys-from-platform-store";
import { isNodePlatformSecureStoreDefaultAvailable } from "../security/platform-secure-store-node";
import { deleteWalletSecretsFromOsStore } from "../security/wallet-os-store-actions";

// ---------------------------------------------------------------------------
// Import from extracted modules for use within this file
// ---------------------------------------------------------------------------

import {
  handleCloudTtsPreviewRoute as _handleCloudTtsPreviewRoute,
  ensureCloudTtsApiKeyAlias,
  mirrorCompatHeaders,
} from "@elizaos/plugin-elizacloud";
import { filterConfigEnvForResponse as _filterConfigEnvForResponse } from "./server-config-filter";

// ---------------------------------------------------------------------------
// Module-level constants and types that stay in server.ts
// ---------------------------------------------------------------------------

const _PACKAGE_ROOT_NAMES = new Set(["eliza", "elizaai", "elizaos"]);

// ---------------------------------------------------------------------------
// Internal helpers used by the monkey-patch handler (stay in server.ts)
// ---------------------------------------------------------------------------

// extractHeaderValue — now imported from ./auth
// tokenMatches — now imported from ./auth
// Pairing infrastructure — now in ./auth-pairing-compat-routes
// getProvidedApiToken, ensureCompatApiAuthorized, isDevEnvironment,
// ensureCompatSensitiveRouteAuthorized — now imported from ./auth

function hydrateWalletOsStoreFlagFromConfig(): void {
  if (process.env.ELIZA_WALLET_OS_STORE?.trim()) {
    return;
  }

  try {
    const config = loadElizaConfig();
    const persistedEnv =
      config.env && typeof config.env === "object" && !Array.isArray(config.env)
        ? (config.env as Record<string, unknown>)
        : undefined;
    const raw = persistedEnv?.ELIZA_WALLET_OS_STORE;
    if (typeof raw === "string" && raw.trim()) {
      process.env.ELIZA_WALLET_OS_STORE = raw.trim();
      return;
    }
  } catch {
    // Best effort only; upstream startup will still load config normally.
  }

  if (isNodePlatformSecureStoreDefaultAvailable()) {
    process.env.ELIZA_WALLET_OS_STORE = "1";
  }
}

function resolveCompatConfigPaths(): {
  elizaConfigPath?: string;
  appConfigPath?: string;
} {
  const explicitConfig = process.env.ELIZA_CONFIG_PATH?.trim();
  const hasStateOverride =
    Boolean(process.env.MILADY_STATE_DIR?.trim()) ||
    Boolean(process.env.ELIZA_STATE_DIR?.trim());
  const configPath =
    explicitConfig ||
    (hasStateOverride ? path.join(resolveStateDir(), "eliza.json") : undefined);

  return { elizaConfigPath: configPath, appConfigPath: configPath };
}

export function syncCompatConfigFiles(): void {
  const { elizaConfigPath, appConfigPath } = resolveCompatConfigPaths();
  if (!elizaConfigPath || !appConfigPath || elizaConfigPath === appConfigPath) {
    return;
  }

  const elizaExists = fs.existsSync(elizaConfigPath);
  const appExists = fs.existsSync(appConfigPath);
  if (!elizaExists && !appExists) {
    return;
  }

  let sourcePath: string;
  let targetPath: string;

  if (elizaExists && !appExists) {
    sourcePath = elizaConfigPath;
    targetPath = appConfigPath;
  } else if (!elizaExists && appExists) {
    sourcePath = appConfigPath;
    targetPath = elizaConfigPath;
  } else {
    const elizaStat = fs.statSync(elizaConfigPath);
    const appStat = fs.statSync(appConfigPath);

    if (appStat.mtimeMs > elizaStat.mtimeMs) {
      sourcePath = appConfigPath;
      targetPath = elizaConfigPath;
    } else if (elizaStat.mtimeMs > appStat.mtimeMs) {
      sourcePath = elizaConfigPath;
      targetPath = appConfigPath;
    } else {
      return;
    }
  }

  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.copyFileSync(sourcePath, targetPath);
}

function resolveCompatPgliteDataDir(config: ElizaConfig): string {
  const explicitDataDir = process.env.PGLITE_DATA_DIR?.trim();
  if (explicitDataDir) {
    return resolveUserPath(explicitDataDir);
  }

  const configuredDataDir = config.database?.pglite?.dataDir?.trim();
  if (configuredDataDir) {
    return resolveUserPath(configuredDataDir);
  }

  const workspaceDir =
    config.agents?.defaults?.workspace ?? resolveDefaultAgentWorkspaceDir();
  return path.join(resolveUserPath(workspaceDir), ".eliza", ".elizadb");
}

/**
 * Reset hop for `POST /api/agent/reset`. Deliberately operates entirely
 * in-process: stops the runtime then removes the PGlite data dir.
 *
 * Must NOT issue loopback HTTP requests back to this same server — the
 * single Node listener can't service the outer request and a re-entrant
 * call simultaneously and the request hangs (issue #7409).
 *
 * Exported via `_clearCompatPgliteDataDirForTests` for the regression
 * test that asserts no `fetch()` is invoked during reset.
 */
async function clearCompatPgliteDataDir(
  runtime: AgentRuntime | null,
  config: ElizaConfig,
): Promise<void> {
  if (typeof runtime?.stop === "function") {
    await runtime.stop();
  }

  const dataDir = resolveCompatPgliteDataDir(config);
  if (path.basename(dataDir) !== ".elizadb") {
    logger.warn(
      `[eliza][reset] Refusing to delete unexpected PGlite dir: ${dataDir}`,
    );
    return;
  }

  try {
    if (fs.existsSync(dataDir)) {
      fs.rmSync(dataDir, { recursive: true, force: true });
      logger.info(
        `[eliza][reset] Deleted PGlite data dir (GGUF models preserved): ${dataDir}`,
      );
    }
  } catch (err) {
    logger.warn(
      `[eliza][reset] Failed to delete PGlite data dir: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

export const _clearCompatPgliteDataDirForTests = clearCompatPgliteDataDir;

// sendJsonResponse, sendJsonErrorResponse — now imported from ./response

function resolveCompatStatusAgentName(
  state: CompatRuntimeState,
): string | null {
  if (state.pendingAgentName) {
    return state.pendingAgentName;
  }

  if (state.current) {
    return null;
  }

  return getConfiguredCompatAgentName();
}

function mergeEmbeddingIntoStatusPayload(
  payload: Record<string, unknown>,
): void {
  const aug = getStartupEmbeddingAugmentation();
  if (!aug) return;

  const existing = payload.startup;
  const base =
    existing && typeof existing === "object" && !Array.isArray(existing)
      ? { ...(existing as Record<string, unknown>) }
      : { phase: "embedding-warmup", attempt: 0 };

  payload.startup = { ...base, ...aug };
}

function rewriteCompatStatusBody(
  bodyText: string,
  state: CompatRuntimeState,
): string {
  const agentName = resolveCompatStatusAgentName(state);

  try {
    const parsed = JSON.parse(bodyText) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return bodyText;
    }

    const payload = parsed as Record<string, unknown>;
    mergeEmbeddingIntoStatusPayload(payload);

    const upstreamPendingRestartReasons = Array.isArray(
      payload.pendingRestartReasons,
    )
      ? payload.pendingRestartReasons.filter(
          (value): value is string => typeof value === "string",
        )
      : [];
    const pendingRestartReasons = Array.from(
      new Set([
        ...upstreamPendingRestartReasons,
        ...state.pendingRestartReasons,
      ]),
    );
    if (
      pendingRestartReasons.length > 0 ||
      typeof payload.pendingRestart === "boolean"
    ) {
      payload.pendingRestart = pendingRestartReasons.length > 0;
      payload.pendingRestartReasons = pendingRestartReasons;
    }

    if (!agentName) {
      return JSON.stringify(payload);
    }

    if (payload.agentName === agentName) {
      return JSON.stringify(payload);
    }

    return JSON.stringify({
      ...payload,
      agentName,
    });
  } catch {
    return bodyText;
  }
}

function patchCompatStatusResponse(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  state: CompatRuntimeState,
): void {
  const method = (req.method ?? "GET").toUpperCase();
  const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
  if (method !== "GET" || pathname !== "/api/status") {
    return;
  }

  const originalEnd = res.end.bind(res);

  res.end = ((
    chunk?: string | Uint8Array,
    encoding?: unknown,
    cb?: unknown,
  ) => {
    let resolvedEncoding: BufferEncoding | undefined;
    let resolvedCallback: (() => void) | undefined;

    if (typeof encoding === "function") {
      resolvedCallback = encoding as () => void;
    } else {
      resolvedEncoding = encoding as BufferEncoding | undefined;
      resolvedCallback = cb as (() => void) | undefined;
    }

    if (chunk == null) {
      return resolvedCallback ? originalEnd(resolvedCallback) : originalEnd();
    }

    const bodyText =
      typeof chunk === "string"
        ? chunk
        : Buffer.from(chunk).toString(resolvedEncoding ?? "utf8");

    return originalEnd(
      rewriteCompatStatusBody(bodyText, state),
      "utf8",
      resolvedCallback,
    );
  }) as typeof res.end;
}

async function _getTableColumnNames(
  runtime: AgentRuntime,
  tableName: string,
  schemaName = "public",
): Promise<Set<string>> {
  const columns = new Set<string>();

  try {
    const { rows } = await executeRawSql(
      runtime,
      `SELECT column_name
         FROM information_schema.columns
        WHERE table_schema = ${sqlLiteral(schemaName)}
          AND table_name = ${sqlLiteral(tableName)}
        ORDER BY ordinal_position`,
    );

    for (const row of rows) {
      const value = row.column_name;
      if (typeof value === "string" && value.length > 0) {
        columns.add(value);
      }
    }
  } catch {
    // Fall through to PRAGMA for PGlite/SQLite compatibility.
  }

  if (columns.size > 0) {
    return columns;
  }

  try {
    const { rows } = await executeRawSql(
      runtime,
      `PRAGMA table_info(${sanitizeIdentifier(tableName)})`,
    );
    for (const row of rows) {
      const value = row.name;
      if (typeof value === "string" && value.length > 0) {
        columns.add(value);
      }
    }
  } catch {
    // Ignore missing-table/missing-pragma support.
  }

  return columns;
}

// normalizePluginCategory, normalizePluginId, titleCasePluginId,
// buildPluginParamDefs, findNearestFile, resolvePluginManifestPath,
// resolveInstalledPackageVersion, resolveLoadedPluginNames, isPluginLoaded,
// buildPluginListResponse, validateCompatPluginConfig, persistCompatPluginMutation
// — extracted to ./plugins-compat-routes

/**
 * Load config from disk and backfill `cloud.apiKey` from sealed secrets when the
 * user is still linked to Eliza Cloud but a stale write dropped the key.
 */
function resolveCloudConfig(runtime?: unknown): ElizaConfig {
  const config = loadElizaConfig();
  const cloudRec =
    config.cloud && typeof config.cloud === "object"
      ? (config.cloud as Record<string, unknown>)
      : undefined;
  if (isElizaSettingsDebugEnabled()) {
    logger.debug(
      `[eliza][settings][compat] resolveCloudConfig disk cloud=${JSON.stringify(settingsDebugCloudSummary(cloudRec))} topKeys=${Object.keys(
        config as object,
      )
        .sort()
        .join(",")}`,
    );
  }
  const linkedAccounts = resolveLinkedAccountsInConfig(
    config as Record<string, unknown>,
  );
  if (linkedAccounts?.elizacloud?.status === "unlinked") {
    // Respect explicit disconnect: never backfill a cloud key into config once
    // the canonical linked-account state says the account is disconnected.
    if (isElizaSettingsDebugEnabled()) {
      logger.debug(
        "[eliza][settings][compat] resolveCloudConfig skip backfill (linkedAccounts.elizacloud.status===unlinked)",
      );
    }
    return config;
  }
  if (!config.cloud?.apiKey) {
    // Try multiple sources: sealed secrets → process.env → runtime character secrets
    const backfillKey =
      getCloudSecret("ELIZAOS_CLOUD_API_KEY") ||
      process.env.ELIZAOS_CLOUD_API_KEY ||
      (runtime as { character?: { secrets?: Record<string, string> } } | null)
        ?.character?.secrets?.ELIZAOS_CLOUD_API_KEY;
    if (backfillKey) {
      if (isElizaSettingsDebugEnabled()) {
        logger.debug(
          "[eliza][settings][compat] resolveCloudConfig backfilling cloud.apiKey from env/secrets/runtime",
        );
      }
      if (!config.cloud) {
        (config as Record<string, unknown>).cloud = {};
      }
      (config.cloud as Record<string, unknown>).apiKey = backfillKey;
      // Persist the backfilled key so future reads find it on disk
      try {
        saveElizaConfig(config);
        logger.info("[cloud] Backfilled missing cloud.apiKey to config file");
      } catch {
        // Non-fatal: the key is still available for this request
      }
    }
  }
  if (isElizaSettingsDebugEnabled()) {
    const outCloud = config.cloud as Record<string, unknown> | undefined;
    logger.debug(
      `[eliza][settings][compat] resolveCloudConfig → return cloud=${JSON.stringify(settingsDebugCloudSummary(outCloud))}`,
    );
  }
  return config;
}

// Cloud login / disconnect loopback sync helpers were moved alongside the
// cloud route handlers into plugin-elizacloud (see plugins/plugin-elizacloud/
// plugin.ts → compatLoopbackConfigPut + makeCloudRouteHandler).

async function handleCompatRoute(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  state: CompatRuntimeState,
): Promise<boolean> {
  const method = (req.method ?? "GET").toUpperCase();
  const url = new URL(req.url ?? "/", "http://localhost");

  // Eliza Cloud thin-client proxy (compat agents, jobs, OAuth, …). Keep this
  // before the local /api/cloud handler so /api/cloud/v1/* forwards to Cloud.
  if (
    url.pathname.startsWith("/api/cloud/compat/") ||
    url.pathname.startsWith("/api/cloud/v1/")
  ) {
    if (!(await ensureRouteAuthorized(req, res, state))) {
      return true;
    }
    return handleCloudCompatRoute(req, res, url.pathname, method, {
      config: resolveCloudConfig(state.current),
      runtime: state.current,
    });
  }

  // Cloud billing routes — handle with fresh config from disk so a cloud
  // API key persisted during login is always available, even if the
  // upstream's in-memory state.config hasn't been refreshed.
  if (url.pathname.startsWith("/api/cloud/billing/")) {
    if (!(await ensureRouteAuthorized(req, res, state))) {
      return true;
    }
    return handleCloudBillingRoute(req, res, url.pathname, method, {
      config: resolveCloudConfig(state.current),
      runtime: state.current,
    });
  }

  // Dev observability routes — extracted to dev-compat-routes.ts
  if (await handleDevCompatRoutes(req, res, state)) return true;

  // Bootstrap-token exchange (P0 cloud-provisioned auth) — must precede the
  // legacy auth-pairing handler so the dedicated rate-limited route owns
  // `/api/auth/bootstrap/exchange`.
  if (await handleAuthBootstrapRoutes(req, res, state)) return true;

  // P1 session routes: setup, login/password, logout, me, sessions list/revoke.
  // These own cookie + CSRF lifecycle for the dashboard.
  if (await handleAuthSessionRoutes(req, res, state)) return true;

  // Auth / pairing / onboarding status — extracted to auth-pairing-compat-routes.ts
  if (await handleAuthPairingCompatRoutes(req, res, state)) return true;
  // Computer-use compat routes — extracted to plugin-computeruse via Plugin.routes (rawPath).
  if (await handleLocalInferenceCompatRoutes(req, res, state)) return true;
  if (await handleAutomationsCompatRoutes(req, res, state)) return true;

  // workflow routes — extracted to plugins/plugin-workflow/src/plugin-routes.ts.
  // Now served via workflowRoutePlugin.routes (rawPath) on the runtime
  // plugin route system.

  // GitHub PAT routes — extracted to plugins/plugin-github/src/routes/github-routes.ts.
  // Now served via githubPlugin.routes (rawPath) on the runtime plugin route system.

  if (method === "POST" && url.pathname === "/api/tts/cloud") {
    if (!(await ensureRouteAuthorized(req, res, state))) return true;
    return await _handleCloudTtsPreviewRoute(req, res);
  }

  if (method === "POST" && url.pathname === "/api/tts/elevenlabs") {
    // Intentional passthrough: ElevenLabs TTS is handled by the upstream
    // Eliza server handler, not by the app API layer. Returning false
    // lets the request fall through to the next handler in the chain.
    return false;
  }

  // Workbench / todos routes — extracted to workbench-compat-routes.ts
  if (await handleWorkbenchCompatRoutes(req, res, state)) return true;

  // Public cached market overview for wallet empty states and cloud feeds —
  // now served via @elizaos/plugin-wallet:routes Plugin.routes (rawPath).
  if (url.pathname.startsWith("/api/secrets/")) {
    if (!(await ensureRouteAuthorized(req, res, state))) return true;
    if (await handleSecretsInventoryRoute(req, res, url.pathname, method)) {
      return true;
    }
    if (await handleSecretsManagerRoute(req, res, url.pathname, method)) {
      return true;
    }
  }

  // ── /api/cloud/* routes — extracted to plugins/plugin-elizacloud ──────
  // (cloud-routes, cloud-status-routes). Now served via
  // elizaCloudRoutePlugin.routes (rawPath) on the runtime plugin route
  // system. The plugin handlers carry the cloud-provisioned auth exemption
  // for `/api/cloud/status` and the post-dispatch loopback sync that keeps
  // the upstream state.config in agreement with disk on login / disconnect.
  // Note: /api/cloud/compat/* and /api/cloud/billing/* still dispatch
  // above this point through @elizaos/agent (intentional — those are thin
  // proxies to Eliza Cloud, not local cloud-connection management).

  if (method === "GET" && url.pathname === "/api/drop/status") {
    const config = loadElizaConfig() as ElizaConfig & {
      features?: { dropEnabled?: boolean };
    };
    if (config.features?.dropEnabled === true) {
      return false;
    }
    sendJsonResponse(res, 200, {
      dropEnabled: false,
      publicMintOpen: false,
      whitelistMintOpen: false,
      mintedOut: false,
      currentSupply: 0,
      maxSupply: 2138,
      shinyPrice: "0.1",
      userHasMinted: false,
    });
    return true;
  }

  // ── Vincent OAuth routes — extracted to app-vincent/src/plugin.ts ──
  // Now served via vincentPlugin.routes (rawPath) on the runtime plugin
  // route system.  /callback/vincent is marked public: true.

  // ── Shopify routes — extracted to app-shopify/src/plugin.ts ───────
  // Now served via shopifyPlugin.routes (rawPath) on the runtime plugin
  // route system.

  if (method === "POST" && url.pathname === "/api/agent/reset") {
    if (!ensureCompatSensitiveRouteAuthorized(req, res)) {
      logger.warn(
        "[eliza][reset] POST /api/agent/reset rejected (sensitive route not authorized)",
      );
      return true;
    }

    try {
      logger.info(
        "[eliza][reset] POST /api/agent/reset: loading config, will clear onboarding state, persisted provider config, and cloud keys (GGUF / MODELS_DIR untouched)",
      );
      const config = loadElizaConfig();
      logger.info(
        "[eliza][reset] Skipping loopback API cleanup; runtime stop plus PGlite data-dir removal clears conversations, knowledge, and trajectories without re-entering the HTTP server.",
      );
      await clearCompatPgliteDataDir(state.current, config);
      state.current = null;
      clearPersistedOnboardingConfig(config);
      saveElizaConfig(config);
      clearCloudSecrets();
      try {
        await deleteWalletSecretsFromOsStore();
      } catch (osErr) {
        logger.warn(
          `[eliza][reset] OS wallet store cleanup: ${osErr instanceof Error ? osErr.message : String(osErr)}`,
        );
      }
      logger.info(
        "[eliza][reset] POST /api/agent/reset: eliza.json saved — renderer should restart API process if embedded/external dev",
      );
      sendJsonResponse(res, 200, { ok: true });
    } catch (err) {
      logger.warn(
        `[eliza][reset] POST /api/agent/reset failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      sendJsonResponse(res, 500, {
        error: err instanceof Error ? err.message : "Reset failed",
      });
    }
    return true;
  }

  // ── Steward wallet compat routes — extracted to app-steward/src/plugin.ts ──
  // All four handler groups (wallet-compat, wallet-browser-compat,
  // steward-compat, wallet-trade-compat) are now served via
  // stewardPlugin.routes (rawPath) on the runtime plugin route system.

  // Plugin routes — extracted to plugins-compat-routes.ts
  if (await handlePluginsCompatRoutes(req, res, state)) return true;

  // Catalog routes — registry SoT projections (apps, plugins, connectors)
  if (await handleCatalogRoutes(req, res, state)) return true;

  if (await handleOnboardingCompatRoute(req, res, state)) return true;

  // GET /api/plugins/:id/ui-spec — generate a UiSpec for plugin configuration.
  // Used by the agent to spawn interactive config forms in chat.
  const uiSpecMatch =
    method === "GET" &&
    url.pathname.match(/^\/api\/plugins\/([^/]+)\/ui-spec$/);
  if (uiSpecMatch) {
    if (!(await ensureRouteAuthorized(req, res, state))) return true;
    const pluginId = decodeURIComponent(uiSpecMatch[1]);
    const { buildPluginConfigUiSpec } = await import("@elizaos/shared");
    const { buildPluginListResponse } = await import("./plugins-compat-routes");
    const pluginList = buildPluginListResponse(state.current);
    const plugin = pluginList.plugins.find((p) => p.id === pluginId);
    if (!plugin) {
      sendJsonResponse(res, 404, { error: `Plugin "${pluginId}" not found` });
      return true;
    }
    const spec = buildPluginConfigUiSpec(
      plugin as Parameters<typeof buildPluginConfigUiSpec>[0],
    );
    sendJsonResponse(res, 200, { spec });
    return true;
  }

  // GET /api/agents — return the running agent's info.
  // The app runs a single agent; expose it under an `agents` array so older
  // health probes and desktop callers can use the same response shape.
  if (method === "GET" && url.pathname === "/api/agents") {
    if (!(await ensureRouteAuthorized(req, res, state))) {
      return true;
    }
    const config = loadElizaConfig();
    const character = buildCharacterFromConfig(config);
    const agentId =
      state.current?.agentId ??
      character.id ??
      "00000000-0000-0000-0000-000000000000";
    sendJsonResponse(res, 200, {
      agents: [
        {
          id: agentId,
          name: character.name,
          status: state.current ? "running" : "stopped",
        },
      ],
    });
    return true;
  }

  if (method === "GET" && url.pathname === "/api/config") {
    if (!(await ensureRouteAuthorized(req, res, state))) {
      return true;
    }

    sendJsonResponse(
      res,
      200,
      _filterConfigEnvForResponse(loadElizaConfig() as Record<string, unknown>),
    );
    return true;
  }

  return handleDatabaseRowsCompatRoute(req, res, state);
}

export async function handleElizaCompatRoute(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  state: CompatRuntimeState,
): Promise<boolean> {
  return await handleCompatRoute(req, res, state);
}

export function patchHttpCreateServerForCompat(
  state?: CompatRuntimeState,
): () => void {
  const originalCreateServer = http.createServer.bind(http);

  http.createServer = ((...args: Parameters<typeof originalCreateServer>) => {
    const [firstArg, secondArg] = args;
    const listener =
      typeof firstArg === "function"
        ? firstArg
        : typeof secondArg === "function"
          ? secondArg
          : undefined;

    if (!listener) {
      return originalCreateServer(...args);
    }

    const wrappedListener: http.RequestListener = async (req, res) => {
      syncAppEnvToEliza();
      syncElizaEnvAliases();
      // Re-check cloud TTS key alias on each request so sign-in mid-session
      // is picked up without a restart.
      ensureCloudTtsApiKeyAlias();
      mirrorCompatHeaders(req);
      if (state) {
        patchCompatStatusResponse(req, res, state);
      }

      // CORS: allow local renderer servers (Vite, static loopback, WKWebView).
      // WKWebView sometimes omits `Origin` on cross-port fetches; allow Referer
      // only when Origin is absent so we never reflect an arbitrary Origin.
      const originHeader = req.headers.origin ?? "";
      // Build allowed origins from configured ports (API, UI, gateway, home)
      const corsAllowedPorts = new Set(getCorsAllowedPorts());
      const localPort = req.socket.localPort;
      if (typeof localPort === "number") {
        corsAllowedPorts.add(String(localPort));
      }
      const allowOrigin = (() => {
        if (originHeader !== "") {
          return isAllowedOrigin(originHeader, corsAllowedPorts)
            ? originHeader
            : null;
        }
        const ref = req.headers.referer;
        if (!ref) return null;
        try {
          const u = new URL(ref);
          return isAllowedOrigin(ref, corsAllowedPorts) ? u.origin : null;
        } catch {
          return null;
        }
      })();

      if (originHeader !== "" && !allowOrigin) {
        res.writeHead(403, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "cors_origin_denied" }));
        return;
      }

      if (allowOrigin) {
        res.setHeader("Access-Control-Allow-Origin", allowOrigin);
        res.setHeader(
          "Access-Control-Allow-Methods",
          "GET, POST, PUT, PATCH, DELETE, OPTIONS",
        );
        res.setHeader(
          "Access-Control-Allow-Headers",
          "Content-Type, Authorization, X-API-Token, X-Api-Key, X-ElizaOS-Client-Id, X-ElizaOS-UI-Language, X-ElizaOS-Token, X-Eliza-Export-Token, X-Eliza-Terminal-Token, X-Eliza-CSRF",
        );
        res.setHeader("Access-Control-Allow-Credentials", "true");
      }

      if (req.method === "OPTIONS") {
        res.statusCode = 204;
        res.end();
        return;
      }

      res.on("finish", () => {
        syncElizaEnvAliases();
        syncCompatConfigFiles();
      });

      if (state) {
        const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
        if (
          pathname.startsWith("/api/database") ||
          pathname.startsWith("/api/trajectories")
        ) {
          await ensureRuntimeSqlCompatibility(state.current);
        }

        try {
          if (await handleCompatRoute(req, res, state)) {
            return;
          }
        } catch (err) {
          logger.error(
            {
              error: err instanceof Error ? err.message : String(err),
              stack: err instanceof Error ? err.stack : undefined,
            },
            "[CompatApiServer] Unhandled compat route error",
          );
          if (!res.headersSent) {
            res.statusCode = 500;
            res.setHeader("content-type", "application/json; charset=utf-8");
            res.end(JSON.stringify({ error: "Internal server error" }));
          }
          return;
        }
      }

      Promise.resolve(listener(req, res)).catch((err) => {
        logger.error(
          {
            error: err instanceof Error ? err.message : String(err),
            stack: err instanceof Error ? err.stack : undefined,
          },
          "[CompatApiServer] Upstream listener error",
        );
        if (!res.headersSent) {
          res.statusCode = 500;
          res.setHeader("content-type", "application/json; charset=utf-8");
          res.end(JSON.stringify({ error: "Internal server error" }));
        }
      });
    };

    const created =
      typeof firstArg === "function"
        ? originalCreateServer(wrappedListener)
        : originalCreateServer(firstArg, wrappedListener);

    // Attach the local-inference device-bridge WS upgrade handler to every
    // HTTP server created through this patched factory. Safe to call on
    // every server — `attachToHttpServer` is idempotent and only installs
    // the upgrade listener once.
    void deviceBridge.attachToHttpServer(created).catch((err) => {
      logger.warn(
        "[compat] Failed to attach device-bridge WS handler:",
        err instanceof Error ? err.message : String(err),
      );
    });

    return created;
  }) as typeof http.createServer;

  return () => {
    http.createServer = originalCreateServer as typeof http.createServer;
  };
}

export async function startApiServer(
  ...args: Parameters<typeof upstreamStartApiServer>
): Promise<Awaited<ReturnType<typeof upstreamStartApiServer>>> {
  syncAppEnvToEliza();
  syncElizaEnvAliases();
  // Ensure cloud-backed ElevenLabs key is available as ELEVENLABS_API_KEY so
  // the upstream Eliza TTS handler can use it (the `/api/tts/elevenlabs` route
  // passes through to upstream which checks this env var).
  ensureCloudTtsApiKeyAlias();
  hydrateWalletOsStoreFlagFromConfig();
  await hydrateWalletKeysFromNodePlatformSecureStore();

  // Pre-load steward wallet addresses so getWalletAddresses() has them
  // available synchronously from the start.
  await initStewardWalletCache();
  const compatState: CompatRuntimeState = {
    current: (args[0]?.runtime as AgentRuntime | null) ?? null,
    pendingAgentName: null,
    pendingRestartReasons: [],
  };
  const restoreCreateServer = patchHttpCreateServerForCompat(compatState);

  try {
    if (compatState.current) {
      await ensureRuntimeSqlCompatibility(compatState.current);
      await (await lazyEnsureTTS())(compatState.current);
    }

    const server = await upstreamStartApiServer(...args);

    const originalUpdateRuntime = server.updateRuntime as (
      runtime: AgentRuntime,
    ) => void;

    server.updateRuntime = (runtime: AgentRuntime) => {
      compatState.current = runtime;
      clearCompatRuntimeRestart(compatState);
      // Make the runtime immediately visible to upstream routes so hot swaps do
      // not briefly return 503s while compat setup finishes in the background.
      originalUpdateRuntime(runtime);

      // Continue repairing SQL compatibility + Edge TTS registration
      // asynchronously. These are important, but they should not block the
      // runtime from becoming available to non-TTS routes.
      void (async () => {
        try {
          await ensureRuntimeSqlCompatibility(runtime);
        } catch (err) {
          logger.error(
            `[eliza][runtime] SQL compatibility init failed: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }

        try {
          await (await lazyEnsureTTS())(runtime);
        } catch (err) {
          logger.warn(
            `[eliza][runtime] TTS init failed (non-critical): ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
      })();
    };

    syncElizaEnvAliases();
    syncCompatConfigFiles();
    return server;
  } finally {
    restoreCreateServer();
  }
}
