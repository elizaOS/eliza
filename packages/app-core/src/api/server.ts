/**
 * app-core wrapper around `@elizaos/agent`'s dashboard HTTP API. Monkey-patches
 * `http.createServer` so every request first runs the compat pipeline — CORS for
 * local renderers (Vite/WKWebView), env-alias and config-file sync, header
 * mirroring, and `/api/status` body rewriting — then dispatches app-core compat
 * routes (auth/session/pairing, cloud proxy + billing, secrets, sensitive
 * requests, first-run, plugins, catalog, local-inference, agent reset) before
 * delegating to the upstream listener. `startApiServer` wraps upstream start,
 * seeds the module-scoped shared compat runtime state so the early and late
 * patch sites share one reference, hydrates wallet keys, and installs the
 * hardened wallet-export guard. Route helpers are re-exported here so tests can
 * import them from `./server`.
 */
import fs from "node:fs";
import http from "node:http";
import { createRequire } from "node:module";
import path from "node:path";
import {
  AGENT_EVENT_ALLOWED_STREAMS,
  CONFIG_WRITE_ALLOWED_TOP_KEYS,
  type ConversationMeta,
  clearPersistedFirstRunConfig,
  cloneWithoutBlockedObjectKeys,
  discoverInstalledPlugins,
  discoverPluginsFromManifest,
  type ElizaConfig,
  extractAuthToken,
  fetchWithTimeoutGuard,
  handleCloudBillingRoute,
  handleCloudCompatRoute,
  handleRuntimeModePreDispatch,
  handleRuntimeModeRemoteForward,
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
import { resolveLinkedAccountsInConfig } from "@elizaos/shared/contracts/first-run-options";
import {
  ensureCompatSensitiveRouteAuthorized,
  ensureRouteAuthorized,
} from "./auth.ts";
import { handleAutomationsCompatRoutes } from "./automations-compat-routes";
import {
  type CompatRouteChainEntry,
  type CompatRouteContext,
  type CompatRuntimeState,
  clearCompatRuntimeRestart,
  getConfiguredCompatAgentName,
  runCompatRouteChain,
} from "./compat-route-shared";
import { sendJson as sendJsonResponse } from "./response";
import { enforceCompatRouteAuthPolicy } from "./route-auth-policy";
import { handleRuntimeModeRoute } from "./runtime-mode-routes";

export {
  __resetCloudBaseUrlCache,
  ensureCloudTtsApiKeyAlias,
  resolveCloudTtsBaseUrl,
  resolveElevenLabsApiKeyForCloudMode,
} from "@elizaos/shared/elizacloud/server-cloud-tts";
export {
  type CompatRuntimeState,
  DATABASE_UNAVAILABLE_MESSAGE,
  getConfiguredCompatAgentName,
  hasCompatPersistedFirstRunState,
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

// Lazy reference to @elizaos/plugin-local-inference/routes — avoids a static
// boundary violation. The module is memoized by the JS engine after the first
// await so per-request cost is a single Map lookup after warm-up.
let _localInferenceRoutes:
  | typeof import("@elizaos/plugin-local-inference/routes")
  | undefined;
async function getLocalInferenceRoutes() {
  if (!_localInferenceRoutes) {
    _localInferenceRoutes = await import(
      "@elizaos/plugin-local-inference/routes"
    );
  }
  return _localInferenceRoutes;
}

import {
  isElizaSettingsDebugEnabled,
  settingsDebugCloudSummary,
} from "@elizaos/shared/settings-debug";
import {
  ensureRuntimeSqlCompatibility,
  executeRawSql,
  sanitizeIdentifier,
  sqlLiteral,
} from "@elizaos/shared/utils/sql-compat";
import { buildCharacterFromConfig } from "../runtime/build-character-from-config";
import { handleAuthBootstrapRoutes } from "./auth-bootstrap-routes";
import { handleAuthPairingCompatRoutes } from "./auth-pairing-routes";
import { handleAuthSessionRoutes } from "./auth-session-routes";
import { handleBackgroundTasksRoute } from "./background-tasks-routes";
import { handleCatalogRoutes } from "./catalog-routes";
import { handleCloudPairRoute } from "./cloud-pair-route";
import { handleCredentialTunnelRoute } from "./credential-tunnel-routes";
import { handleDatabaseRowsCompatRoute } from "./database-rows-compat-routes";
import { handleDevCompatRoutes } from "./dev-compat-routes";
import { handleDropStatusCompatRoute } from "./drop-status-compat-route";
import { handleEmbedAuthRoutes } from "./embed-auth-routes";
import { handleFirstRunRoute } from "./first-run-routes";
import { handleI18nLocaleRoute } from "./i18n-locale-routes";
import { handleInternalWakeRoute } from "./internal-routes";
import {
  isPerfInstrumentEnabled,
  normalizeRouteKey,
  recordRouteTiming,
} from "./perf-instrument";
import {
  PLUGIN_REGISTRY_LOAD_DEADLINE_MS,
  resolveWithinDeadline,
} from "./plugin-registry-load-deadline";
import { handleSecretsInventoryRoute } from "./secrets-inventory-routes";
import { handleSecretsManagerRoute } from "./secrets-manager-routes";
import { handleSensitiveRequestRoutes } from "./sensitive-request-routes";
import { getCorsAllowedPorts, isAllowedOrigin } from "./server-cors";

const _require = createRequire(import.meta.url);

import {
  readAliasedEnv,
  syncAppEnvToEliza,
  syncElizaEnvAliases,
} from "@elizaos/shared/utils/env";

// Lazy-imported to avoid circular dependency with runtime/eliza.ts
const lazyEnsureTTS = () =>
  import("../runtime/ensure-text-to-speech-handler.js").then(
    (m) => m.ensureTextToSpeechHandler,
  );

const _LOCAL_TTS_PROVIDER_IDS = [
  "eliza-local-inference",
  "capacitor-llama",
  "eliza-device-bridge",
  "eliza-aosp-llama",
] as const;

let pluginRegistryApiPromise:
  | Promise<typeof import("@elizaos/plugin-registry")>
  | undefined;
function getPluginRegistryApi(): Promise<
  typeof import("@elizaos/plugin-registry")
> {
  pluginRegistryApiPromise ??= import("@elizaos/plugin-registry");
  return pluginRegistryApiPromise;
}

import {
  clearCloudSecrets,
  getCloudSecret,
} from "@elizaos/shared/elizacloud/cloud-secrets";
import { getStartupEmbeddingAugmentation } from "../runtime/startup-overlay.js";
import { hydrateWalletKeysFromNodePlatformSecureStore } from "../security/hydrate-wallet-keys-from-platform-store";
import { isNodePlatformSecureStoreDefaultAvailable } from "../security/platform-secure-store-node";
import { deleteWalletSecretsFromOsStore } from "../security/wallet-os-store-actions";

// ---------------------------------------------------------------------------
// Import from extracted modules for use within this file
// ---------------------------------------------------------------------------

import {
  ensureCloudTtsApiKeyAlias,
  mirrorCompatHeaders,
} from "@elizaos/shared/elizacloud/server-cloud-tts";
import { filterConfigEnvForResponse as _filterConfigEnvForResponse } from "./server-config-filter";

// ---------------------------------------------------------------------------
// Module-level constants and types that stay in server.ts
// ---------------------------------------------------------------------------

const _PACKAGE_ROOT_NAMES = new Set(["eliza", "elizaai", "elizaos"]);

// ---------------------------------------------------------------------------
// Internal helpers used by the monkey-patch handler (stay in server.ts)
// ---------------------------------------------------------------------------

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
  const explicitConfig = readAliasedEnv("ELIZA_CONFIG_PATH");
  const hasStateOverride = Boolean(readAliasedEnv("ELIZA_STATE_DIR"));
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

const RUNTIME_STOP_RESET_TIMEOUT_MS = 20_000;

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
  return path.join(resolveUserPath(workspaceDir), ".elizadb");
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
    // `runtime.stop()` releases plugins/services to drop the PGlite write lock
    // before we delete the data dir. On mobile CPU with many plugins loaded it
    // can take a while, and a hung plugin shutdown must not wedge reset forever.
    // POSIX `rm` succeeds with open file handles, so if stop overruns we log and
    // proceed to delete anyway; the lingering runtime is torn down by the
    // first-run restart that follows on the client.
    let stopTimedOut = false;
    let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
    try {
      await Promise.race([
        Promise.resolve(runtime.stop({ fast: true })),
        new Promise<void>((resolve) => {
          timeoutHandle = setTimeout(() => {
            stopTimedOut = true;
            resolve();
          }, RUNTIME_STOP_RESET_TIMEOUT_MS);
        }),
      ]);
    } catch (err) {
      logger.warn(
        `[eliza][reset] runtime.stop() failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
    }
    if (stopTimedOut) {
      logger.warn(
        `[eliza][reset] runtime.stop() exceeded ${RUNTIME_STOP_RESET_TIMEOUT_MS}ms; deleting PGlite data dir anyway`,
      );
    }
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
      // Persist the backfilled key so later reads find it on disk.
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
  if (!isPerfInstrumentEnabled()) {
    return handleCompatRouteInner(req, res, state);
  }
  const start = performance.now();
  const url = new URL(req.url ?? "/", "http://localhost");
  const routeKey = normalizeRouteKey(
    (req.method ?? "GET").toUpperCase(),
    url.pathname,
  );
  const handled = await handleCompatRouteInner(req, res, state);
  if (handled) {
    recordRouteTiming(routeKey, performance.now() - start);
  }
  return handled;
}

async function handleCompatRouteInner(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  state: CompatRuntimeState,
): Promise<boolean> {
  const method = (req.method ?? "GET").toUpperCase();
  const url = new URL(req.url ?? "/", "http://localhost");

  // ── Mode visibility gate ───────────────────────────────────────────────
  // Shared hook from @elizaos/agent (also enforced in the bare agent
  // server's own dispatch): cloud mode hides /api/local-inference/*,
  // local-only hides /api/cloud/* (hidden = 404, not 403, so callers cannot
  // probe mode state). It must run here because the compat chain below handles
  // some routes before the request ever reaches the upstream agent listener.
  if (await handleRuntimeModePreDispatch(req, res, state.current)) return true;

  const authPolicyDecision = await enforceCompatRouteAuthPolicy(
    req,
    res,
    state,
    method,
    url.pathname,
  );
  if (authPolicyDecision === "denied") return true;
  if (authPolicyDecision === "unmanaged") return false;

  // Remote-mode cloud mutations forward only after compat auth allows the
  // request; the forwarder attaches the controller's target token, so it must
  // not run as a pre-auth bypass.
  if (await handleRuntimeModeRemoteForward(req, res)) return true;

  // #12089 item 5: the compat route surface below used to be a ~30-branch
  // order-dependent if-chain (each branch `if (await handleX(...)) return true`)
  // with the plugin-local-inference handlers hardwired inline. It is now an
  // ORDERED registry (see `COMPAT_ROUTE_CHAIN`) that route modules/plugins
  // register entries into; `runCompatRouteChain` walks it in array order,
  // short-circuiting on the first entry that reports it handled the request.
  // Ordering is data (array order), not source line order, and the
  // local-inference coupling is a single registered entry that loads via the
  // lazy boundary getter instead of an inline special-case block.
  const ctx: CompatRouteContext = { req, res, state, method, url };
  if (await runCompatRouteChain(COMPAT_ROUTE_CHAIN, ctx)) {
    return true;
  }

  // Terminal fallthrough: database-rows compat surface owns any request the
  // ordered chain declined. Kept as the explicit chain terminator (not a
  // registry entry) because it never falls through: it always resolves the
  // request (200/404/503), so it must run last and unconditionally.
  return handleDatabaseRowsCompatRoute(req, res, state);
}

// Ordered compat-route registry (#12089 item 5). Replaces the former fixed
// if-chain in `handleCompatRouteInner`. Entries run in ARRAY ORDER
// (data-driven), first `true` wins. Preserves the exact legacy ordering and
// per-route auth gating; the only behavioral change is that order is now an
// explicit, testable list instead of source-line ordering, and the
// plugin-local-inference handlers are one lazily-loaded entry rather than an
// inline hardwired block. Route modules and plugins that need to mount ahead of
// or behind a given surface splice into this array instead of editing the
// dispatcher body.
const COMPAT_ROUTE_CHAIN: readonly CompatRouteChainEntry[] = [
  {
    // Runtime mode introspection: UI shells hit this on boot for the
    // useRuntimeMode() hook.
    id: "runtime-mode",
    handler: ({ req, res, state }) => handleRuntimeModeRoute(req, res, state),
  },
  {
    // First-paint UI language suggestion. Public/advisory only; the client
    // falls back to English when it is absent, but serving it avoids noisy 404s.
    id: "i18n-locale",
    handler: ({ req, res }) => handleI18nLocaleRoute(req, res),
  },
  {
    // Eliza Cloud thin-client proxy (compat agents, jobs, OAuth). Keep this
    // before the local /api/cloud handler so /api/cloud/v1/* forwards to Cloud.
    id: "cloud-compat-proxy",
    handler: async ({ req, res, state, method, url }) => {
      if (
        !(
          url.pathname.startsWith("/api/cloud/compat/") ||
          url.pathname.startsWith("/api/cloud/v1/")
        )
      ) {
        return false;
      }
      if (!(await ensureRouteAuthorized(req, res, state))) {
        return true;
      }
      return handleCloudCompatRoute(req, res, url.pathname, method, {
        config: resolveCloudConfig(state.current),
        runtime: state.current,
      });
    },
  },
  {
    // Cloud billing routes: handle with fresh config from disk so a cloud
    // API key persisted during login is always available, even if the
    // upstream's in-memory state.config hasn't been refreshed.
    id: "cloud-billing",
    handler: async ({ req, res, state, method, url }) => {
      if (!url.pathname.startsWith("/api/cloud/billing/")) {
        return false;
      }
      if (!(await ensureRouteAuthorized(req, res, state))) {
        return true;
      }
      return handleCloudBillingRoute(req, res, url.pathname, method, {
        config: resolveCloudConfig(state.current),
        runtime: state.current,
      });
    },
  },
  {
    // Dev observability routes.
    id: "dev-compat",
    handler: ({ req, res, state }) => handleDevCompatRoutes(req, res, state),
  },
  {
    // Cloud SSO popup landing: `/pair?token=X` calls cloud-api server-side,
    // serves HTML that pins the API token on the SPA's window global. Mounted
    // before any other auth handler so it owns the root `/pair` URL.
    id: "cloud-pair",
    handler: ({ req, res }) => handleCloudPairRoute(req, res),
  },
  {
    // Must precede the auth-pairing handler so the rate-limited route owns
    // /api/auth/bootstrap/exchange.
    id: "auth-bootstrap",
    handler: ({ req, res, state }) =>
      handleAuthBootstrapRoutes(req, res, state),
  },
  {
    // Cookie + CSRF session lifecycle (setup, login, logout, me, sessions).
    id: "auth-session",
    handler: ({ req, res, state }) => handleAuthSessionRoutes(req, res, state),
  },
  {
    // Auth / pairing / first-run status.
    id: "auth-pairing",
    handler: ({ req, res, state }) =>
      handleAuthPairingCompatRoutes(req, res, state),
  },
  {
    // Embedded-app launch verification (Discord Activity / Telegram Mini App).
    id: "embed-auth",
    handler: ({ req, res, state }) => handleEmbedAuthRoutes(req, res, state),
  },
  {
    // Sensitive-request REST surface (create/get/submit/cancel) for owner
    // secret collection: e.g. orchestrator provider keys land in the shared
    // vault instead of plain config. Each branch self-authorizes via
    // ensureCallerAuthorized (trusted-local, API token, or session), matching
    // the sibling compat handlers, so mounting it does not widen the unauth
    // surface.
    id: "sensitive-request",
    handler: ({ req, res, state }) =>
      handleSensitiveRequestRoutes(req, res, state),
  },
  {
    id: "credential-tunnel",
    handler: ({ req, res, state }) =>
      handleCredentialTunnelRoute(req, res, state),
  },
  {
    id: "background-tasks",
    handler: ({ req, res, state }) =>
      handleBackgroundTasksRoute(req, res, state),
  },
  {
    // Internal wake route called by Capacitor BackgroundRunner JSContexts on
    // iOS/Android. Bearer-authed via the device secret; not part of the
    // cookie session pipeline.
    id: "internal-wake",
    handler: ({ req, res, state }) => handleInternalWakeRoute(req, res, state),
  },
  {
    // Local-inference compat routes. Single ordered entry that loads the plugin
    // route handlers via the lazy getter to avoid a static boundary violation
    // (app-core must not statically import plugin packages). This replaces the
    // former inline hardwired block that enumerated the four plugin handlers
    // directly in the dispatcher body (#12089 item 5).
    id: "local-inference",
    handler: async ({ req, res, state }) => {
      const {
        handleLiveDiarizationRoute,
        handleLocalInferenceAsrRoute,
        handleLocalInferenceCompatRoutes,
        handleLocalInferenceTtsRoute,
      } = await getLocalInferenceRoutes();
      if (await handleLocalInferenceCompatRoutes(req, res, state)) return true;
      if (await handleLocalInferenceAsrRoute(req, res, state)) return true;
      if (await handleLocalInferenceTtsRoute(req, res, state)) return true;
      // WebView -> agent PCM transport for live on-device speaker diarization.
      return handleLiveDiarizationRoute(req, res, state);
    },
  },
  {
    id: "automations",
    handler: ({ req, res, state }) =>
      handleAutomationsCompatRoutes(req, res, state),
  },
  {
    // Workbench todos CRUD is owned by @elizaos/plugin-workflow and served on
    // the runtime plugin route system (`/api/workbench/todos*`).
    //
    // Secrets inventory/manager. #12087 Item 4: each secrets handler self-gates
    // at OWNER (ensureRouteMinRole in the handler), so the auth no longer lives
    // only in this dispatch prefix.
    id: "secrets",
    handler: async ({ req, res, state, method, url }) => {
      if (!url.pathname.startsWith("/api/secrets/")) {
        return false;
      }
      if (
        await handleSecretsInventoryRoute(req, res, url.pathname, method, state)
      ) {
        return true;
      }
      return handleSecretsManagerRoute(req, res, url.pathname, method, state);
    },
  },
  {
    // `/api/cloud/compat/*` and `/api/cloud/billing/*` dispatch through the
    // cloud entries above: thin proxies to Eliza Cloud, not local
    // cloud-connection management. `/api/cloud/*` connection management is
    // served by elizaCloudRoutePlugin.routes on the runtime plugin route system.
    id: "drop-status",
    handler: ({ req, res, method, url }) =>
      handleDropStatusCompatRoute(req, res, method, url.pathname),
  },
  {
    id: "agent-reset",
    handler: async ({ req, res, state, method, url }) => {
      if (!(method === "POST" && url.pathname === "/api/agent/reset")) {
        return false;
      }
      if (!ensureCompatSensitiveRouteAuthorized(req, res)) {
        logger.warn(
          "[eliza][reset] POST /api/agent/reset rejected (sensitive route not authorized)",
        );
        return true;
      }

      try {
        logger.info(
          "[eliza][reset] POST /api/agent/reset: loading config, will clear first-run state, persisted provider config, and cloud keys (GGUF / MODELS_DIR untouched)",
        );
        const config = loadElizaConfig();
        logger.info(
          "[eliza][reset] Skipping loopback API cleanup; runtime stop plus PGlite data-dir removal clears conversations, knowledge, and trajectories without re-entering the HTTP server.",
        );
        await clearCompatPgliteDataDir(state.current, config);
        state.current = null;
        clearPersistedFirstRunConfig(config);
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
          "[eliza][reset] POST /api/agent/reset: eliza.json saved; renderer should restart API process if embedded/third-party dev",
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
    },
  },
  {
    // Plugin routes load @elizaos/plugin-registry lazily: that package pulls in
    // heavyweight registry/install code, so keep it out of the startup path and
    // only load it for plugin-management requests.
    id: "plugins",
    handler: async ({ req, res, state, url }) => {
      if (!url.pathname.startsWith("/api/plugins")) {
        return false;
      }
      // error-policy:J4 explicit user-facing degrade — while the heavyweight
      // registry module is cold-loading (boot window), holding the socket open
      // starves every /api/plugins poller into proxy "socket hang up" loops
      // (#13859). Answer 503 + Retry-After instead; the memoized import keeps
      // loading and the client's next poll lands 200 once warm.
      const registryApi = await resolveWithinDeadline(
        getPluginRegistryApi(),
        PLUGIN_REGISTRY_LOAD_DEADLINE_MS,
      );
      if (registryApi === null) {
        res.setHeader("Retry-After", "2");
        sendJsonResponse(res, 503, {
          error: "Plugin registry is still loading",
        });
        return true;
      }
      return registryApi.handlePluginsCompatRoutes(req, res, state);
    },
  },
  {
    // Catalog routes: registry SoT projections (apps, plugins, connectors).
    id: "catalog",
    handler: ({ req, res, state }) => handleCatalogRoutes(req, res, state),
  },
  {
    id: "first-run",
    handler: ({ req, res, state }) => handleFirstRunRoute(req, res, state),
  },
  {
    // GET /api/plugins/:id/ui-spec: generate a UiSpec for plugin configuration.
    // Used by the agent to spawn interactive config forms in chat. Registered
    // AFTER the `/api/plugins` handler; the generic handler declines the
    // ui-spec path (its matcher does not claim it), so this more specific
    // entry still resolves it, matching the legacy line ordering.
    id: "plugin-ui-spec",
    handler: async ({ req, res, state, method, url }) => {
      const uiSpecMatch =
        method === "GET" &&
        url.pathname.match(/^\/api\/plugins\/([^/]+)\/ui-spec$/);
      if (!uiSpecMatch) {
        return false;
      }
      if (!(await ensureRouteAuthorized(req, res, state))) return true;
      const pluginId = decodeURIComponent(uiSpecMatch[1]);
      const { buildPluginConfigUiSpec } = await import(
        "@elizaos/shared/config/plugin-ui-spec"
      );
      const { buildPluginListResponse } = await getPluginRegistryApi();
      const pluginList = buildPluginListResponse(state.current);
      const plugin = pluginList.plugins.find(
        (p: { id: string }) => p.id === pluginId,
      );
      if (!plugin) {
        sendJsonResponse(res, 404, { error: `Plugin "${pluginId}" not found` });
        return true;
      }
      const spec = buildPluginConfigUiSpec(
        plugin as Parameters<typeof buildPluginConfigUiSpec>[0],
      );
      sendJsonResponse(res, 200, { spec });
      return true;
    },
  },
  {
    // GET /api/agents: return the running agent's info. The app runs a single
    // agent; expose it under an `agents` array so older health probes and
    // desktop callers can use the same response shape.
    id: "agents",
    handler: async ({ req, res, state, method, url }) => {
      if (!(method === "GET" && url.pathname === "/api/agents")) {
        return false;
      }
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
    },
  },
  {
    id: "config",
    handler: async ({ req, res, state, method, url }) => {
      if (!(method === "GET" && url.pathname === "/api/config")) {
        return false;
      }
      if (!(await ensureRouteAuthorized(req, res, state))) {
        return true;
      }
      sendJsonResponse(
        res,
        200,
        _filterConfigEnvForResponse(
          loadElizaConfig() as Record<string, unknown>,
        ),
      );
      return true;
    },
  },
];

export async function handleElizaCompatRoute(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  state: CompatRuntimeState,
): Promise<boolean> {
  return handleCompatRoute(req, res, state);
}

/**
 * Module-scoped singleton compat-state. Both the early
 * `patchHttpCreateServerForCompat()` call (from `startEliza` before upstream's
 * boot binds the listener) AND the later `startApiServer` wrapper need to
 * share the SAME state object — otherwise the early-bound listener captures
 * an empty state by closure and never sees the runtime that `startApiServer`
 * assigns to its own local state. `getSharedCompatRuntimeState()` returns
 * this singleton so both call sites can read/mutate the same reference.
 */
const sharedCompatRuntimeState: CompatRuntimeState = {
  current: null,
  pendingAgentName: null,
  pendingRestartReasons: [],
};

export function getSharedCompatRuntimeState(): CompatRuntimeState {
  return sharedCompatRuntimeState;
}

export function patchHttpCreateServerForCompat(): () => void {
  // Always capture the shared singleton. A caller-local CompatRuntimeState
  // would split early and late patch sites back into different state objects.
  const effectiveState = sharedCompatRuntimeState;
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
      patchCompatStatusResponse(req, res, effectiveState);

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
          // error-policy:J3 untrusted Referer header — an unparseable URL is
          // treated as "no allowed origin" (request is denied below).
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
          "Content-Type, Authorization, X-API-Token, X-Api-Key, X-ElizaOS-Client-Id, X-ElizaOS-UI-Language, X-ElizaOS-Token, X-Eliza-Export-Token, X-Eliza-Terminal-Token, X-Eliza-Platform, X-Eliza-CSRF",
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

      {
        const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
        if (
          pathname.startsWith("/api/database") ||
          pathname.startsWith("/api/trajectories")
        ) {
          await ensureRuntimeSqlCompatibility(effectiveState.current);
        }

        try {
          if (await handleCompatRoute(req, res, effectiveState)) {
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
    // the upgrade listener once. Imported dynamically to avoid static boundary violation.
    void import("@elizaos/plugin-local-inference/services")
      .then(({ deviceBridge }) => deviceBridge.attachToHttpServer(created))
      .catch((err: unknown) => {
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

  // Use the module-scoped shared state instead of a fresh local object so
  // any earlier patch installation (e.g. the `startEliza` boot-time install
  // that ensures upstream's listener engages the compat dispatcher) sees the
  // runtime once we receive it here. The shared state is created at module
  // load with `current: null`; we seed it now from the caller's optional
  // runtime arg, then upstream's `server.updateRuntime` wrapper continues to
  // mutate the same reference per hot-swap.
  const compatState = sharedCompatRuntimeState;
  clearCompatRuntimeRestart(compatState);
  if (args[0]?.runtime) {
    compatState.current = args[0].runtime as AgentRuntime;
    compatState.pendingAgentName = null;
  }
  const restoreCreateServer = patchHttpCreateServerForCompat();

  try {
    if (compatState.current) {
      await ensureRuntimeSqlCompatibility(compatState.current);
      await (await lazyEnsureTTS())(compatState.current);
    }

    const upstreamStart = Date.now();
    const server = await upstreamStartApiServer(...args);
    logger.info(
      `[eliza-api] upstreamStartApiServer took ${Date.now() - upstreamStart}ms`,
    );

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
