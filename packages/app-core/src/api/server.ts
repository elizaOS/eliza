import "../utils/namespace-defaults.js";
import fs from "node:fs";
import http from "node:http";
import { createRequire } from "node:module";
import path from "node:path";
import { handleCloudBillingRoute } from "@elizaos/agent/api/cloud-billing-routes";
import { handleCloudCompatRoute } from "@elizaos/agent/api/cloud-compat-routes";
import { clearPersistedOnboardingConfig } from "@elizaos/agent/api/provider-switch-config";
// Override the wallet export rejection function with the hardened version
// that adds rate limiting, audit logging, and a forced confirmation delay.
import {
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
  startApiServer as upstreamStartApiServer,
  validateMcpServerConfig,
} from "@elizaos/agent/api/server";
import { initStewardWalletCache } from "@elizaos/agent/api/wallet";
import {
  type ElizaConfig,
  loadElizaConfig,
  saveElizaConfig,
} from "@elizaos/agent/config/config";
import { resolveUserPath } from "@elizaos/agent/config/paths";
import { resolveDefaultAgentWorkspaceDir } from "@elizaos/agent/providers/workspace";
import { type AgentRuntime, logger } from "@elizaos/core";
import { resolveLinkedAccountsInConfig } from "@elizaos/shared/contracts/onboarding";
import {
  ensureCompatApiAuthorized,
  ensureCompatSensitiveRouteAuthorized,
  getCompatApiToken,
} from "./auth";
import {
  type CompatRuntimeState,
  clearCompatRuntimeRestart,
  getConfiguredCompatAgentName,
} from "./compat-route-shared";
import { sendJson as sendJsonResponse } from "./response";

export { resolveWalletExportRejection } from "@elizaos/app-steward/routes/server-wallet-trade";
export {
  type CompatRuntimeState,
  DATABASE_UNAVAILABLE_MESSAGE,
  getConfiguredCompatAgentName,
  hasCompatPersistedOnboardingState,
  isLoopbackRemoteAddress,
  readCompatJsonBody,
} from "./compat-route-shared";
export {
  __resetCloudBaseUrlCache,
  ensureCloudTtsApiKeyAlias,
  resolveCloudTtsBaseUrl,
  resolveElevenLabsApiKeyForCloudMode,
} from "./server-cloud-tts";
export {
  filterConfigEnvForResponse,
  SENSITIVE_ENV_RESPONSE_KEYS,
} from "./server-config-filter";
export {
  buildCorsAllowedPorts,
  invalidateCorsAllowedPorts,
  isAllowedLocalOrigin,
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
  isElizaSettingsDebugEnabled,
  sanitizeForSettingsDebug,
  settingsDebugCloudSummary,
} from "@elizaos/shared";
import { buildCharacterFromConfig } from "../runtime/build-character-from-config";
import {
  ensureRuntimeSqlCompatibility,
  executeRawSql,
  sanitizeIdentifier,
  sqlLiteral,
} from "../utils/sql-compat";
import { handleAuthPairingCompatRoutes } from "./auth-pairing-compat-routes";
import { handleCloudRoute } from "./cloud-routes";
import { handleCloudStatusRoutes } from "./cloud-status-routes";
import { handleComputerUseCompatRoutes } from "./computer-use-compat-routes";
import { handleDatabaseRowsCompatRoute } from "./database-rows-compat-routes";
import { handleDevCompatRoutes } from "./dev-compat-routes";
import { handleLocalInferenceCompatRoutes } from "./local-inference-compat-routes";
import { handleN8nRoutes } from "./n8n-routes";
import { handleOnboardingCompatRoute } from "./onboarding-compat-routes";
import { handlePluginsCompatRoutes } from "./plugins-compat-routes";
import { getCorsAllowedPorts, isAllowedLocalOrigin } from "./server-cors";
import { isCloudProvisioned as _isCloudProvisioned } from "./server-onboarding-compat";
// Phase 2 extraction: Steward compat routes → app-steward/src/plugin.ts (stewardPlugin)
// Includes: handleWalletBrowserCompatRoutes, handleWalletTradeCompatRoutes,
//           handleStewardCompatRoutes, handleWalletCompatRoutes
import { handleWorkbenchCompatRoutes } from "./workbench-compat-routes";

const _require = createRequire(import.meta.url);

import { syncAppEnvToEliza, syncElizaEnvAliases } from "../utils/env.js";

// Lazy-imported to avoid circular dependency with runtime/eliza.ts
const lazyEnsureTTS = () =>
  import("../runtime/ensure-text-to-speech-handler.js").then(
    (m) => m.ensureTextToSpeechHandler,
  );

import { hydrateWalletKeysFromNodePlatformSecureStore } from "@elizaos/app-steward/security/hydrate-wallet-keys-from-platform-store";
import { deleteWalletSecretsFromOsStore } from "@elizaos/app-steward/security/wallet-os-store-actions";
import { getStartupEmbeddingAugmentation } from "../runtime/startup-overlay.js";
import { clearCloudSecrets, getCloudSecret } from "./cloud-secrets";

// ---------------------------------------------------------------------------
// Import from extracted modules for use within this file
// ---------------------------------------------------------------------------

import {
  handleCloudTtsPreviewRoute as _handleCloudTtsPreviewRoute,
  ensureCloudTtsApiKeyAlias,
  mirrorCompatHeaders,
} from "./server-cloud-tts";
import { filterConfigEnvForResponse as _filterConfigEnvForResponse } from "./server-config-filter";

// ---------------------------------------------------------------------------
// Module-level constants and types that stay in server.ts
// ---------------------------------------------------------------------------

const _PACKAGE_ROOT_NAMES = new Set(["eliza", "elizaai", "elizaos"]);

// ---------------------------------------------------------------------------
// Internal helpers used by the monkey-patch handler (stay in server.ts)
// ---------------------------------------------------------------------------

// extractHeaderValue, getCompatApiToken — now imported from ./auth
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
    }
  } catch {
    // Best effort only; upstream startup will still load config normally.
  }
}

function resolveCompatConfigPaths(): {
  elizaConfigPath?: string;
  appConfigPath?: string;
} {
  const sharedStateDir =
    process.env.ELIZA_STATE_DIR?.trim() || process.env.ELIZA_STATE_DIR?.trim();
  const appConfigPath =
    process.env.ELIZA_CONFIG_PATH?.trim() ||
    (sharedStateDir ? path.join(sharedStateDir, "eliza.json") : undefined);
  const elizaConfigPath =
    process.env.ELIZA_CONFIG_PATH?.trim() ||
    (sharedStateDir ? path.join(sharedStateDir, "eliza.json") : undefined);

  return { elizaConfigPath, appConfigPath };
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
 * Actual port the API server is listening on, set after server.listen()
 * resolves. Used by loopback calls to target the correct endpoint even
 * when the server binds to a dynamic port (port: 0 or EADDRINUSE fallback).
 */
let _resolvedLoopbackPort: number | null = null;

/** Called from startApiServer after the upstream server resolves. */
export function setResolvedLoopbackPort(port: number): void {
  _resolvedLoopbackPort = port;
}

/**
 * Build the loopback base URL for internal server-to-self API calls.
 * Always targets 127.0.0.1 — never trusts the incoming Host header,
 * which would allow an attacker to redirect loopback fetches (and the
 * attached API token) to an external server.
 *
 * Priority: actual listener port > env vars > default 31337.
 */
function resolveCompatLoopbackApiBase(
  _req: Pick<http.IncomingMessage, "headers">,
): string {
  const port =
    _resolvedLoopbackPort ??
    (Number(
      process.env.ELIZA_API_PORT?.trim() ||
        process.env.ELIZA_PORT?.trim() ||
        "31337",
    ) ||
      31337);
  return `http://127.0.0.1:${port}`;
}

function buildCompatLoopbackHeaders(
  _req: Pick<http.IncomingMessage, "headers">,
  init?: RequestInit,
): Headers {
  const headers = new Headers(init?.headers ?? {});
  if (!headers.has("Accept")) {
    headers.set("Accept", "application/json");
  }
  if (!headers.has("Content-Type") && init?.body) {
    headers.set("Content-Type", "application/json");
  }
  const apiToken = getCompatApiToken();
  if (apiToken && !headers.has("Authorization")) {
    headers.set("Authorization", `Bearer ${apiToken}`);
  }
  return headers;
}

async function compatLoopbackFetchJson<T>(
  req: Pick<http.IncomingMessage, "headers">,
  pathname: string,
  init?: RequestInit,
): Promise<T> {
  const response = await fetch(
    new URL(pathname, resolveCompatLoopbackApiBase(req)),
    {
      ...init,
      headers: buildCompatLoopbackHeaders(req, init),
    },
  );
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}: ${pathname}`);
  }
  return (await response.json()) as T;
}

async function compatLoopbackRequest(
  req: Pick<http.IncomingMessage, "headers">,
  pathname: string,
  init?: RequestInit,
): Promise<void> {
  const response = await fetch(
    new URL(pathname, resolveCompatLoopbackApiBase(req)),
    {
      ...init,
      headers: buildCompatLoopbackHeaders(req, init),
    },
  );
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}: ${pathname}`);
  }
}

async function clearCompatRuntimeStateViaApi(
  req: Pick<http.IncomingMessage, "headers">,
): Promise<void> {
  try {
    const conversations = await compatLoopbackFetchJson<{
      conversations?: Array<{ id: string }>;
    }>(req, "/api/conversations");
    for (const conversation of conversations.conversations ?? []) {
      if (!conversation?.id) continue;
      await compatLoopbackRequest(
        req,
        `/api/conversations/${encodeURIComponent(conversation.id)}`,
        { method: "DELETE" },
      );
    }
  } catch (err) {
    logger.warn(
      `[eliza][reset] Failed to clear conversations before reset: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  try {
    const knowledge = await compatLoopbackFetchJson<{
      documents?: Array<{ id: string }>;
    }>(req, "/api/knowledge/documents");
    for (const document of knowledge.documents ?? []) {
      if (!document?.id) continue;
      await compatLoopbackRequest(
        req,
        `/api/knowledge/documents/${encodeURIComponent(document.id)}`,
        { method: "DELETE" },
      );
    }
  } catch (err) {
    logger.warn(
      `[eliza][reset] Failed to clear knowledge documents before reset: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  try {
    await compatLoopbackRequest(req, "/api/trajectories", {
      method: "DELETE",
      body: JSON.stringify({ all: true }),
    });
  } catch (err) {
    logger.warn(
      `[eliza][reset] Failed to clear trajectories before reset: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

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

async function handleCompatRoute(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  state: CompatRuntimeState,
): Promise<boolean> {
  const method = (req.method ?? "GET").toUpperCase();
  const url = new URL(req.url ?? "/", "http://localhost");

  // Eliza Cloud thin-client proxy (compat agents, jobs, …) — was missing from the
  // compat wrapper, so the dashboard saw 404 on `/api/cloud/compat/agents`.
  if (url.pathname.startsWith("/api/cloud/compat/")) {
    if (!ensureCompatApiAuthorized(req, res)) {
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
    if (!ensureCompatApiAuthorized(req, res)) {
      return true;
    }
    return handleCloudBillingRoute(req, res, url.pathname, method, {
      config: resolveCloudConfig(state.current),
      runtime: state.current,
    });
  }

  // Dev observability routes — extracted to dev-compat-routes.ts
  if (await handleDevCompatRoutes(req, res, state)) return true;

  // Auth / pairing / onboarding status — extracted to auth-pairing-compat-routes.ts
  if (await handleAuthPairingCompatRoutes(req, res, state)) return true;
  if (await handleComputerUseCompatRoutes(req, res, state)) return true;
  if (await handleLocalInferenceCompatRoutes(req, res, state)) return true;

  // n8n routes — status surface (read-only), sidecar start (fire-and-forget),
  // and workflow CRUD proxy. Auth sits in front of every n8n route. The
  // handler reads the sidecar singleton from services/n8n-sidecar via
  // peekN8nSidecar(), so no construction happens just from a status probe.
  if (url.pathname.startsWith("/api/n8n/")) {
    if (!ensureCompatApiAuthorized(req, res)) return true;
    return handleN8nRoutes({
      req,
      res,
      method,
      pathname: url.pathname,
      config: loadElizaConfig(),
      runtime: state.current,
      json: (_res, body, status = 200) => {
        sendJsonResponse(res, status, body);
      },
    });
  }

  if (method === "POST" && url.pathname === "/api/tts/cloud") {
    if (!ensureCompatApiAuthorized(req, res)) return true;
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

  // Handle all /api/cloud/* routes (except compat and billing which have
  // their own handlers above) through handleCloudRoute. This is
  // critical for cloud login — persistCloudLoginStatus saves the API key
  // to disk and scrubs it from env. Without this, login/status falls
  // through to the upstream handler whose config save can be clobbered.
  const isCloudRoute =
    url.pathname.startsWith("/api/cloud/") &&
    !url.pathname.startsWith("/api/cloud/compat/") &&
    !url.pathname.startsWith("/api/cloud/billing/");

  if (isCloudRoute) {
    // Cloud-provisioned containers exempt /api/cloud/status from auth so the
    // SPA can discover cloud connection state without a token.
    const isCloudStatusExempt =
      _isCloudProvisioned() &&
      method === "GET" &&
      url.pathname === "/api/cloud/status";

    if (!isCloudStatusExempt && !ensureCompatApiAuthorized(req, res)) {
      return true;
    }

    const config = resolveCloudConfig(state.current);

    if (
      url.pathname === "/api/cloud/status" ||
      url.pathname === "/api/cloud/credits"
    ) {
      return handleCloudStatusRoutes({
        req,
        res,
        method,
        pathname: url.pathname,
        config,
        runtime: state.current,
        json: (_res, body, status = 200) => {
          sendJsonResponse(res, status, body);
        },
      });
    }

    const handled = await handleCloudRoute(req, res, url.pathname, method, {
      config,
      runtime: state.current,
      cloudManager: null,
    });

    // After disconnect, sync the cloud disable into the upstream's in-memory
    // state.config via a loopback PUT /api/config. Without this, the next
    // upstream saveElizaConfig(state.config) (e.g. saving OpenRouter) reverts
    // the disconnect because state.config still has cloud.enabled=true + apiKey.
    if (
      handled &&
      method === "POST" &&
      url.pathname === "/api/cloud/disconnect"
    ) {
      // Include apiKey: null so the upstream state.config does not restore the
      // just-cleared key when it merges and re-saves during the loopback.
      // Include serviceRouting: { llmText: null } so the upstream's in-memory
      // serviceRouting (derived from legacy cloud.enabled=true at load time) is
      // cleared — without it, the loopback save re-persists the cloud-proxy route.
      // Also include linkedAccounts.elizacloud.status="unlinked" so the
      // upstream's in-memory state.config (which still has the old "linked"
      // status from load time) does not overwrite the canonical unlinked
      // state on the next saveElizaConfig — that overwrite was the source
      // of the auto-reconnect bug after restart.
      const disconnectPatch = {
        cloud: { enabled: false, apiKey: null },
        serviceRouting: { llmText: null },
        linkedAccounts: {
          elizacloud: { status: "unlinked", source: "api-key" },
        },
      };
      if (isElizaSettingsDebugEnabled()) {
        logger.debug(
          `[eliza][settings][compat] POST /api/cloud/disconnect → loopback PUT /api/config patch=${JSON.stringify(sanitizeForSettingsDebug(disconnectPatch))}`,
        );
      }
      try {
        await compatLoopbackRequest(req, "/api/config", {
          method: "PUT",
          body: JSON.stringify(disconnectPatch),
        });
        if (isElizaSettingsDebugEnabled()) {
          logger.debug(
            "[eliza][settings][compat] POST /api/cloud/disconnect loopback sync OK",
          );
        }
      } catch (err) {
        logger.warn(
          `[eliza][cloud/disconnect] Failed to sync cloud disable to upstream state: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }

    return handled;
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
      await clearCompatRuntimeStateViaApi(req);
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

  if (await handleOnboardingCompatRoute(req, res, state)) return true;

  // GET /api/plugins/:id/ui-spec — generate a UiSpec for plugin configuration.
  // Used by the agent to spawn interactive config forms in chat.
  const uiSpecMatch =
    method === "GET" &&
    url.pathname.match(/^\/api\/plugins\/([^/]+)\/ui-spec$/);
  if (uiSpecMatch) {
    if (!ensureCompatApiAuthorized(req, res)) return true;
    const pluginId = decodeURIComponent(uiSpecMatch[1]);
    const { buildPluginConfigUiSpec } = await import(
      "../config/plugin-ui-spec"
    );
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
    if (!ensureCompatApiAuthorized(req, res)) {
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
    if (!ensureCompatApiAuthorized(req, res)) {
      return true;
    }

    sendJsonResponse(
      res,
      200,
      _filterConfigEnvForResponse(loadElizaConfig() as Record<string, unknown>),
    );
    return true;
  }

  if (!ensureCompatApiAuthorized(req, res)) return true;
  return handleDatabaseRowsCompatRoute(req, res, state.current);
}

export async function handleMiladyCompatRoute(
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
      const corsAllowedPorts = getCorsAllowedPorts();
      const allowOrigin = (() => {
        if (originHeader !== "") {
          return isAllowedLocalOrigin(originHeader, corsAllowedPorts)
            ? originHeader
            : null;
        }
        const ref = req.headers.referer;
        if (!ref) return null;
        try {
          const u = new URL(ref);
          return isAllowedLocalOrigin(ref, corsAllowedPorts) ? u.origin : null;
        } catch {
          return null;
        }
      })();

      if (allowOrigin) {
        res.setHeader("Access-Control-Allow-Origin", allowOrigin);
        res.setHeader(
          "Access-Control-Allow-Methods",
          "GET, POST, PUT, PATCH, DELETE, OPTIONS",
        );
        res.setHeader(
          "Access-Control-Allow-Headers",
          "Content-Type, Authorization, X-API-Token, X-Api-Key, X-ElizaOS-Client-Id, X-ElizaOS-UI-Language, X-ElizaOS-Token, X-Eliza-Export-Token, X-Eliza-Terminal-Token",
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
          console.error("[compat] unhandled error in route handler", err);
          if (!res.headersSent) {
            res.statusCode = 500;
            res.setHeader("content-type", "application/json; charset=utf-8");
            res.end(JSON.stringify({ error: "Internal server error" }));
          }
          return;
        }
      }

      Promise.resolve(listener(req, res)).catch((err) => {
        console.error("[compat] upstream listener error", err);
        if (!res.headersSent) {
          res.statusCode = 500;
          res.setHeader("content-type", "application/json; charset=utf-8");
          res.end(JSON.stringify({ error: "Internal server error" }));
        }
      });
    };

    if (typeof firstArg === "function") {
      return originalCreateServer(wrappedListener);
    }

    return originalCreateServer(firstArg, wrappedListener);
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

    // Record the actual listener port so loopback calls target the right
    // endpoint even when the server bound to a dynamic port (port: 0 or
    // EADDRINUSE fallback).
    if (typeof server.port === "number" && server.port > 0) {
      setResolvedLoopbackPort(server.port);
    }

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
