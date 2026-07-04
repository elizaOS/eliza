/**
 * elizaOS runtime entry point for Eliza.
 *
 * Starts the elizaOS agent runtime with Eliza's plugin configuration.
 * Can be run directly via: node --import tsx src/runtime/eliza.ts
 * Or via the CLI: eliza start
 *
 * @module eliza
 */
import crypto from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import process from "node:process";
import * as readline from "node:readline";
import { fileURLToPath, pathToFileURL } from "node:url";

// ---------------------------------------------------------------------------
// Extracted modules — re-exported for backward compatibility
// ---------------------------------------------------------------------------
import {
  recordBootEvent,
  recordBootTelemetry,
  startMemorySampler,
} from "./boot-telemetry.ts";
import { BootTimer } from "./boot-timer.ts";
// Dev/test-only crash/hang injection (#10203). No-op unless ELIZA_CRASH_INJECT
// is armed, and it refuses to arm in production — see crash-injection.ts.
import { maybeInjectFault } from "./crash-injection.ts";
import { runFirstTimeSetup } from "./first-time-setup.ts";
import { startMemoryWatchdog } from "./memory-watchdog.ts";
import { resolveConfigEnvForProcess } from "./operations/vault-bridge.ts";
import { OPTIONAL_PLUGIN_IMPORTERS } from "./optional-plugin-imports.generated.ts";
import {
  isWorkspacePluginSourceFallbackAllowed,
  type PluginResolutionPhase,
  resolvePlugins,
} from "./plugin-resolver.ts";
import {
  CUSTOM_PLUGINS_DIRNAME as CUSTOM_RUNTIME_PLUGINS_DIRNAME,
  type ResolvedPlugin as RuntimeResolvedPlugin,
  STATIC_ELIZA_PLUGINS,
} from "./plugin-types.ts";
import { shouldLoadRemoteCodingRunnerForBoot } from "./remote-coding-runner-gate.ts";

export {
  CHANNEL_PLUGIN_MAP,
  collectPluginNames,
  OPTIONAL_PLUGIN_MAP,
  PROVIDER_PLUGIN_MAP,
} from "./plugin-collector.ts";

export {
  CUSTOM_PLUGINS_DIRNAME,
  EJECTED_PLUGINS_DIRNAME,
  ensureBrowserServerLink,
  findPluginBrowserStagehandDir,
  findRuntimePluginExport,
  mergeDropInPlugins,
  type PluginModuleShape,
  type ResolvedPlugin,
  repairBrokenInstallRecord,
  resolveElizaPluginImportSpecifier,
  resolvePackageEntry,
  STATIC_ELIZA_PLUGINS,
  scanDropInPlugins,
} from "./plugin-types.ts";

// resolvePlugins is re-exported via index.ts from ./plugin-resolver

// `@elizaos/plugin-personal-assistant` is NOT eagerly imported here. It
// transitively imports from `@elizaos/agent` (e.g. `hasOwnerAccess` from this
// package's barrel) — a top-level static import would form a module-init cycle
// that leaves named exports (like a plugin's actions array) as `undefined`,
// crashing `runtime.registerPlugin` when it iterates `plugin.actions`.
//
// It still resolves at plugin-load time via a headless dynamic-import
// entrypoint in `plugin-resolver.ts`, after the static module graph has fully
// evaluated, so the cycle never forms and browser-only UI exports stay out of
// the agent process.
// Keep this here as a single sentinel: if we ever need a static reference,
// add `as const` data only — never an `import * as` of these packages.
import {
  AgentRuntime,
  AUTONOMY_SERVICE_TYPE,
  AutonomyService,
  addLogListener,
  ChannelType,
  type Component,
  createBasicCapabilitiesPlugin,
  createMessageMemory,
  drainAppRoutePluginLoaders,
  E2B_SANDBOX_FACTORY_SERVICE_TYPE,
  EmbeddingDimensionProbeError,
  type Entity,
  type IAgentRuntime,
  type LogEntry,
  logger,
  MESSAGE_SOURCE_CLIENT_CHAT,
  type Plugin,
  type Provider,
  type ServiceClass,
  stringToUuid,
  subAgentCredentialsPlugin,
  type TargetInfo,
  type UUID,
  warnOnUnmatchedActionRolePolicyKeys,
} from "@elizaos/core";
import {
  DEFAULT_CEREBRAS_TEXT_MODEL,
  DEFAULT_ELIZA_CLOUD_TEXT_MODEL,
  formatError,
  isElizaSettingsDebugEnabled,
  isMobilePlatform,
  migrateLegacyRuntimeConfig,
  resolveDeploymentTargetInConfig,
  resolveDesktopApiPort,
  resolveElizaCloudTopology,
  resolveServerOnlyPort,
  resolveServiceRoutingInConfig,
  settingsDebugCloudSummary,
} from "@elizaos/shared";
import { buildDefaultElizaCloudServiceRouting } from "@elizaos/shared/contracts/service-routing";
import { registerDesktopScreenCaptureBridgeService } from "./desktop-screen-capture-bridge-service.ts";
import { type AgentHostBridge, getAgentHostBridge } from "./host-bridge.ts";

// Host capabilities (wallet-key hydration, vault bootstrap/access, account
// pool, build variant) are INJECTED downward by the app-core host via
// `setAgentHostBridge` before boot — agent never imports `@elizaos/app-core`.
// When no host installs a bridge (mobile bundle / standalone agent), the leaf
// default in `./host-bridge.ts` supplies the same no-op behavior the mobile
// `app-core-runtime.cjs` stub used to. `await`-compatible (returns the bridge
// synchronously) so existing `await importAppCoreRuntime()` call sites are
// unchanged.
function importAppCoreRuntime(): AgentHostBridge {
  return getAgentHostBridge();
}

function isBundledMobileRuntime(): boolean {
  return (
    (globalThis as { __ELIZA_MOBILE_BUNDLE__?: unknown })
      .__ELIZA_MOBILE_BUNDLE__ === true
  );
}

import { buildCharacterFromConfig } from "./build-character-config.ts";
import {
  resolvePreferredProviderId,
  resolvePreferredProviderPluginName,
  resolvePrimaryModel,
} from "./model-resolution.ts";

type E2BCapabilityRouterModule =
  typeof import("../services/e2b-capability-router.ts");

async function loadE2BCapabilityRouterModule(): Promise<E2BCapabilityRouterModule> {
  const moduleId = "../services/e2b-capability-router.ts";
  return (await import(
    /* @vite-ignore */ moduleId
  )) as E2BCapabilityRouterModule;
}

// The e2b (`e2b.dev`) SDK backend for the remote capability router lives in the
// optional `@elizaos/plugin-e2b-sandbox` package — not in `@elizaos/agent`, so
// the `e2b` dependency stays out of the trunk. When the router selects the
// `e2b` provider we register the plugin's factory service so the router can
// route filesystem / terminal / git into an e2b sandbox; if the plugin is not
// installed we log and leave E2B unavailable rather than failing boot.
async function registerE2BSandboxFactoryService(
  runtime: IAgentRuntime,
): Promise<boolean> {
  if (runtime.getService(E2B_SANDBOX_FACTORY_SERVICE_TYPE)) return true;
  const moduleId = "@elizaos/plugin-e2b-sandbox";
  const mod = (await import(/* @vite-ignore */ moduleId)) as {
    E2BSandboxFactoryService?: ServiceClass;
  };
  const ServiceClassRef = mod.E2BSandboxFactoryService;
  if (!ServiceClassRef) return false;
  await runtime.registerService(ServiceClassRef);
  return true;
}

import {
  debugLogResolvedContext,
  validateRuntimeContext,
} from "../api/plugin-validation.ts";
import { listViews } from "../api/views-registry.ts";
import { getWalletAddresses, syncSolanaPublicKeyEnv } from "../api/wallet.ts";
import {
  configFileExists,
  type ElizaConfig,
  loadElizaConfig,
} from "../config/config.ts";
import {
  CONNECTOR_ENV_MAP,
  collectConfigEnvVars,
  collectConnectorEnvVars,
} from "../config/env-vars.ts";
import { resolveStateDir, resolveUserPath } from "../config/paths.ts";
import {
  createHookEvent,
  type LoadHooksOptions,
  loadHooks,
  triggerHook,
} from "../hooks/index.ts";
import { ensureAgentWorkspace } from "../providers/workspace.ts";
import { SandboxAuditLog } from "../security/audit-log.ts";
import { bootstrapRemoteCapabilityPlugins } from "../services/remote-plugin-adapter.ts";
import {
  SandboxManager,
  type SandboxMode,
} from "../services/sandbox-manager.ts";
import {
  evaluateTeeBootGate,
  type TeeBootGate,
} from "../services/tee-boot-gate.ts";
import {
  setTeeBootGateState,
  teeBootGateBlocksSecrets,
} from "../services/tee-boot-gate-state.ts";
import { resolveTeeEvidenceProvider } from "../services/tee-evidence-provider.ts";
import {
  resolveDefaultAgentWorkspaceDir,
  shouldBootstrapWorkspaceInitFiles,
} from "../shared/workspace-resolution.ts";
import {
  BLOCKING_CORE_PLUGINS,
  CORE_PLUGINS,
  DEFERRED_CORE_PLUGINS,
  LEAN_CHAT_PLUGINS,
  OPTIONAL_CORE_PLUGINS,
} from "./core-plugins.ts";
import { seedBundledDocuments } from "./default-documents.ts";
import { createElizaPlugin } from "./eliza-plugin.ts";
import {
  runtimeDocumentsEnabled,
  runtimeTrajectoriesEnabled,
} from "./native-runtime-features.ts";
import {
  createPgliteInitError,
  getPgliteErrorCode,
  PGLITE_ERROR_CODES,
} from "./pglite-error-compat.ts";
import { installRuntimePluginLifecycle } from "./plugin-lifecycle.ts";
import {
  applyPluginRoleGating,
  installProviderRoleGatingChokepoint,
} from "./plugin-role-gating.ts";
import { validateIntentActionMap } from "./prompt-compaction.ts";
import rolesPlugin from "./roles.ts";
import { shouldRegisterSubAgentCredentialsPlugin } from "./sub-agent-credentials-runtime-policy.ts";
import {
  installDatabaseTrajectoryLogger,
  shouldEnableTrajectoryLoggingByDefault,
} from "./trajectory-persistence.ts";
import {
  validateViewActionMap,
  validateViewCoverage,
} from "./view-action-affinity.ts";

function isPluginSqlResolutionError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return (
    message.includes("Cannot find module '@elizaos/plugin-sql'") ||
    message.includes('Cannot find module "@elizaos/plugin-sql"') ||
    (message.includes("@elizaos/plugin-sql") &&
      (message.includes("ResolveMessage") ||
        message.includes("Module not found") ||
        message.includes("could not resolve") ||
        message.includes("Could not resolve")))
  );
}

async function loadRequiredPluginSql(): Promise<
  typeof import("@elizaos/plugin-sql")
> {
  try {
    return await import(/* @vite-ignore */ "@elizaos/plugin-sql");
  } catch (err) {
    const sourceEntry = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "../../../../plugins/plugin-sql/src/index.node.ts",
    );
    if (
      !isWorkspacePluginSourceFallbackAllowed() ||
      !isPluginSqlResolutionError(err) ||
      !existsSync(sourceEntry)
    ) {
      throw err;
    }
    logger.debug(
      `[eliza] Loading @elizaos/plugin-sql from workspace source at ${sourceEntry}`,
    );
    return (await import(
      pathToFileURL(sourceEntry).href
    )) as typeof import("@elizaos/plugin-sql");
  }
}

function resolveWorkspacePluginSourceEntry(packageName: string): string | null {
  if (!packageName.startsWith("@elizaos/plugin-")) return null;
  const shortName = packageName.slice("@elizaos/".length);
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 14; depth += 1) {
    const candidate = path.join(dir, "plugins", shortName, "src", "index.ts");
    if (existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

// Literal-specifier importers so Bun.build inlines each optional plugin into
// the mobile bundle live in optional-plugin-imports.generated.ts, code-generated
// from OPTIONAL_STATIC_PLUGIN_PACKAGES (optional-plugins.ts). Adding a plugin to
// the descriptor table is enough; optional-plugins.test.ts fails if it lacks a
// generated importer. Plugins not in the map (e.g. desktop-only gitpathologist)
// load through a bare dynamic import from a node_modules/desktop install.
const loadOptionalPlugin = async (packageName: string): Promise<unknown> => {
  try {
    const importer = OPTIONAL_PLUGIN_IMPORTERS[packageName];
    if (importer) return await importer();
    return await import(packageName);
  } catch {
    if (isWorkspacePluginSourceFallbackAllowed()) {
      const sourceEntry = resolveWorkspacePluginSourceEntry(packageName);
      if (sourceEntry) {
        try {
          logger.debug(
            `[eliza] Loading ${packageName} from workspace source at ${sourceEntry}`,
          );
          return await import(pathToFileURL(sourceEntry).href);
        } catch {
          // Missing or unbuildable optional plugins are omitted from
          // STATIC_ELIZA_PLUGINS.
        }
      }
    }
    return null;
  }
};

// IMPORTANT: Do NOT pull plugin modules in via top-level `await` at module scope.
//
// Bun.build (and any cross-module top-level-await scheduling that follows the
// ESM spec naively) can emit an `init_eliza()` call that is NOT awaited inside
// a downstream `init_runtime*` function. When that happens, the
// `Object.assign(STATIC_ELIZA_PLUGINS, ...)` below has not run yet by the time
// `loadSinglePlugin("@elizaos/plugin-sql")` is dispatched, and the resolver
// falls through to a dynamic import that throws
// "Cannot find module '@elizaos/plugin-sql'" from the bundle path.
//
// Solution: lazy-load and memoize each module, and register the static map
// inside `ensureCoreStaticPluginsRegistered()` which is awaited from every
// runtime entry point (`startEliza`, `startInCloudMode`).
let _pluginSqlPromise: Promise<typeof import("@elizaos/plugin-sql")> | null =
  null;
async function getPluginSql(): Promise<typeof import("@elizaos/plugin-sql")> {
  if (!_pluginSqlPromise) {
    _pluginSqlPromise = loadRequiredPluginSql();
  }
  return _pluginSqlPromise;
}

let _pluginLocalEmbeddingPromise: Promise<
  typeof import("@elizaos/plugin-local-inference") | null
> | null = null;
async function getPluginLocalEmbedding(): Promise<
  typeof import("@elizaos/plugin-local-inference") | null
> {
  if (!_pluginLocalEmbeddingPromise) {
    _pluginLocalEmbeddingPromise = (async () => {
      try {
        return await import(
          /* @vite-ignore */ "@elizaos/plugin-local-inference"
        );
      } catch {
        return null;
      }
    })();
  }
  return _pluginLocalEmbeddingPromise;
}

let _optionalPluginCache: Map<string, Promise<unknown>> | null = null;
function getOptionalPlugin(packageName: string): Promise<unknown> {
  if (_optionalPluginCache === null) {
    _optionalPluginCache = new Map();
  }
  const cache = _optionalPluginCache;
  const cached = cache.get(packageName);
  if (cached) return cached;
  const promise = loadOptionalPlugin(packageName);
  cache.set(packageName, promise);
  return promise;
}
// Personality is bundled in @elizaos/core advanced capabilities (advancedCapabilities).

type CoreStaticPluginPhase = "blocking" | "deferred";

type CoreStaticPluginRegistration = {
  packageName: string;
  registryName?: string;
  phase: CoreStaticPluginPhase;
  required: boolean;
  load: () => Promise<unknown>;
};

const CORE_STATIC_PLUGIN_REGISTRATIONS: readonly CoreStaticPluginRegistration[] =
  [
    {
      packageName: "@elizaos/plugin-sql",
      phase: "blocking",
      required: true,
      load: () => getPluginSql(),
    },
    {
      packageName: "@elizaos/plugin-local-inference",
      phase: "blocking",
      required: false,
      load: () => getPluginLocalEmbedding(),
    },
    {
      packageName: "@elizaos/plugin-agent-orchestrator",
      registryName: "agent-orchestrator",
      phase: "deferred",
      required: false,
      load: () => getOptionalPlugin("@elizaos/plugin-agent-orchestrator"),
    },
    {
      packageName: "@elizaos/plugin-task-coordinator",
      phase: "deferred",
      required: false,
      load: () => getOptionalPlugin("@elizaos/plugin-task-coordinator"),
    },
    {
      packageName: "@elizaos/plugin-shell",
      phase: "deferred",
      required: false,
      load: () => getOptionalPlugin("@elizaos/plugin-shell"),
    },
    {
      packageName: "@elizaos/plugin-coding-tools",
      phase: "deferred",
      required: false,
      load: () => getOptionalPlugin("@elizaos/plugin-coding-tools"),
    },
    {
      // Opt-in only: dormant unless a character lists @elizaos/plugin-pty (no
      // autoEnable). Registers PTY_SERVICE so the web terminal can drive a real
      // interactive CLI (eliza-code on Eliza Cloud/cerebras).
      packageName: "@elizaos/plugin-pty",
      phase: "deferred",
      required: false,
      load: () => getOptionalPlugin("@elizaos/plugin-pty"),
    },
    {
      // Auto-on only when the host has the birdclaw CLI or an existing
      // ~/.birdclaw data root (see birdclawRequested in plugin-collector.ts).
      // Registers BIRDCLAW_SERVICE + the local Twitter/X archive view/action.
      packageName: "@elizaos/plugin-birdclaw",
      phase: "deferred",
      required: false,
      load: () => getOptionalPlugin("@elizaos/plugin-birdclaw"),
    },
    {
      packageName: "@elizaos/plugin-commands",
      phase: "deferred",
      required: false,
      load: () => getOptionalPlugin("@elizaos/plugin-commands"),
    },
    {
      packageName: "@elizaos/plugin-video",
      phase: "deferred",
      required: false,
      load: () => getOptionalPlugin("@elizaos/plugin-video"),
    },
    {
      // MOBILE_CORE_PLUGINS lists plugin-vision (screen understanding on
      // mobile — GET_SCREEN, the renderer-pulled screen-capture bridge, and
      // the #11111 ML Kit OCR bridge routes), but without a static
      // registration the mobile agent bundle could never resolve it: the
      // renderer OCR poller polled /api/vision/ocr-requests into a 404
      // forever (verified live on emulator-5554).
      packageName: "@elizaos/plugin-vision",
      phase: "deferred",
      required: false,
      load: () => getOptionalPlugin("@elizaos/plugin-vision"),
    },
    {
      packageName: "@elizaos/plugin-background-runner",
      phase: "deferred",
      required: false,
      load: () => getOptionalPlugin("@elizaos/plugin-background-runner"),
    },
    {
      packageName: "@elizaos/plugin-elizacloud",
      phase: "deferred",
      required: false,
      load: () => getOptionalPlugin("@elizaos/plugin-elizacloud"),
    },
    {
      packageName: "@elizaos/plugin-ollama",
      phase: "deferred",
      required: false,
      load: () => getOptionalPlugin("@elizaos/plugin-ollama"),
    },
    {
      packageName: "@elizaos/plugin-anthropic",
      phase: "deferred",
      required: false,
      load: () => getOptionalPlugin("@elizaos/plugin-anthropic"),
    },
    {
      packageName: "@elizaos/plugin-openai",
      phase: "deferred",
      required: false,
      load: () => getOptionalPlugin("@elizaos/plugin-openai"),
    },
    {
      packageName: "@elizaos/plugin-gitpathologist",
      phase: "deferred",
      required: false,
      // Not in the mobile bundle — attempting the import there hangs the full
      // 30s deferred-plugin timeout before being skipped. Skip it up front on
      // android/ios (it's a desktop dev tool, already gated in plugin-collector).
      load: () =>
        isMobilePlatform()
          ? Promise.resolve(null)
          : getOptionalPlugin("@elizaos/plugin-gitpathologist"),
    },
  ];

let _blockingStaticPluginsRegistered = false;
let _deferredStaticPluginsRegistered = false;
let _blockingStaticPluginsRegistrationPromise: Promise<void> | null = null;
let _deferredStaticPluginsRegistrationPromise: Promise<void> | null = null;

function isTruthyEnvFlag(value: string | undefined): boolean {
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
}

function shouldBlockDeferredPluginImports(): boolean {
  return isTruthyEnvFlag(process.env.ELIZA_BLOCK_DEFERRED_PLUGIN_IMPORTS);
}

async function registerStaticPluginPhase(
  phase: CoreStaticPluginPhase,
): Promise<void> {
  const bootTimeoutMs = Number(
    process.env.ELIZA_PLUGIN_BOOT_TIMEOUT_MS ?? 30_000,
  );
  const registrations = CORE_STATIC_PLUGIN_REGISTRATIONS.filter(
    (registration) => registration.phase === phase,
  );
  logger.info(
    `[boot] resolving ${phase} plugins (${registrations.length}, timeout=${bootTimeoutMs}ms)`,
  );

  const trackImport = async (
    registration: CoreStaticPluginRegistration,
  ): Promise<void> => {
    const startedAt = Date.now();
    let timer: ReturnType<typeof setTimeout> | null = null;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(
          new Error(
            `plugin ${registration.packageName} timed out after ${bootTimeoutMs}ms`,
          ),
        );
      }, bootTimeoutMs);
      if (typeof timer.unref === "function") timer.unref();
    });

    try {
      const mod = await Promise.race([registration.load(), timeout]);
      if (!mod) {
        if (registration.required) {
          throw new Error(`${registration.packageName} resolved to null`);
        }
        logger.warn(
          `[boot] ${registration.packageName} skipped after ${Date.now() - startedAt}ms: module unavailable`,
        );
        return;
      }
      STATIC_ELIZA_PLUGINS[
        registration.registryName ?? registration.packageName
      ] = mod;
      logger.info(
        `[boot] ${registration.packageName} loaded in ${Date.now() - startedAt}ms`,
      );
    } catch (err) {
      const elapsed = Date.now() - startedAt;
      if (registration.required) {
        logger.error(
          `[boot] ${registration.packageName} FAILED after ${elapsed}ms: ${formatError(err)}`,
        );
        throw err;
      }
      logger.warn(
        `[boot] ${registration.packageName} skipped after ${elapsed}ms: ${formatError(err)}`,
      );
    } finally {
      if (timer) clearTimeout(timer);
    }
  };

  if (phase === "deferred") {
    // Deferred plugins run in the background after the API server is already
    // listening; they must not hold the ready gate. Importing them one at a
    // time and yielding to the event loop (setImmediate) between each lets the
    // bound HTTP server serve /api/health (and other I/O) between the CPU-bound
    // module evaluations, instead of starving it until the whole batch finishes
    // (observed ready was dominated by this on contended hosts). All plugins
    // still register — only the scheduling changes.
    for (const registration of registrations) {
      await trackImport(registration);
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
    }
    _deferredStaticPluginsRegistered = true;
  } else {
    await Promise.all(registrations.map(trackImport));
    _blockingStaticPluginsRegistered = true;
  }
}

async function ensureStaticPluginsRegisteredByName(
  packageNames: readonly string[],
): Promise<void> {
  const requested = new Set(packageNames);
  if (requested.size === 0) return;

  const registrations = CORE_STATIC_PLUGIN_REGISTRATIONS.filter(
    (registration) =>
      requested.has(registration.packageName) ||
      (registration.registryName
        ? requested.has(registration.registryName)
        : false),
  );
  const missing = [...requested].filter(
    (packageName) =>
      !registrations.some(
        (registration) =>
          registration.packageName === packageName ||
          registration.registryName === packageName,
      ),
  );
  if (missing.length > 0) {
    logger.debug(
      `[boot] no static registration for preferred provider plugin(s): ${missing.join(", ")}`,
    );
  }

  await Promise.all(
    registrations.map(async (registration) => {
      const registryName =
        registration.registryName ?? registration.packageName;
      if (STATIC_ELIZA_PLUGINS[registryName]) {
        return;
      }
      try {
        const mod = await registration.load();
        if (mod) {
          STATIC_ELIZA_PLUGINS[registryName] = mod;
          logger.info(
            `[boot] preferred provider plugin ${registration.packageName} loaded before runtime initialization`,
          );
        }
      } catch (err) {
        logger.warn(
          `[boot] preferred provider plugin ${registration.packageName} unavailable before runtime initialization: ${formatError(err)}`,
        );
      }
    }),
  );
}

async function ensureBlockingCoreStaticPluginsRegistered(): Promise<void> {
  if (_blockingStaticPluginsRegistered) return;
  if (!_blockingStaticPluginsRegistrationPromise) {
    _blockingStaticPluginsRegistrationPromise =
      registerStaticPluginPhase("blocking");
  }
  await _blockingStaticPluginsRegistrationPromise;
}

export async function ensureDeferredCoreStaticPluginsRegistered(): Promise<void> {
  if (_deferredStaticPluginsRegistered) return;
  if (!_deferredStaticPluginsRegistrationPromise) {
    _deferredStaticPluginsRegistrationPromise =
      registerStaticPluginPhase("deferred");
  }
  await _deferredStaticPluginsRegistrationPromise;
}

/**
 * Static-plugin registration for the CLOUD-HOSTED topology only (the agent runs
 * inside the cloud container and the device connects directly to its API base).
 * No local AgentRuntime boots, so the heavy on-device inference stack
 * (`@elizaos/plugin-local-inference`: catalog, model/embedding/voice warmup,
 * the bun:ffi desktop dylib path) is never used and must not be loaded — it
 * only adds first-paint latency.
 *
 * Register only the registry entry a code path may touch while the cloud proxy
 * is active: `@elizaos/plugin-sql`, so `STATIC_ELIZA_PLUGINS` is populated for
 * any consumer that reaches for it.
 *
 * The two local topologies (local agent → cloud inference, and all-local) keep
 * calling `ensureCoreStaticPluginsRegistered()` and load local-inference
 * exactly as before.
 */
export async function ensureCloudCoreStaticPluginsRegistered(): Promise<void> {
  await ensureStaticPluginsRegisteredByName(["@elizaos/plugin-sql"]);
}

/**
 * Resolve and register the baseline `@elizaos/plugin-*` modules into the
 * shared `STATIC_ELIZA_PLUGINS` map. Called from every runtime entry point
 * (`startEliza`, `startInCloudMode`, `bootElizaRuntime`) before any caller
 * touches `loadSinglePlugin`. Memoized so repeated calls are free.
 *
 * Startup is intentionally two-phase:
 * - blocking: only the database and local-inference pre-init hooks needed for
 *   runtime readiness;
 * - deferred: provider/feature modules that should not hold the API ready gate.
 *
 * Set ELIZA_BLOCK_DEFERRED_PLUGIN_IMPORTS=1 to restore the legacy behavior and
 * await both phases before plugin resolution. This is useful when debugging
 * import-order or bundling issues.
 *
 * Why this isn't done at module init:
 * - Top-level `await` for these modules at module scope creates a
 *   cross-module TLA dependency that `Bun.build` does not always honor in
 *   the bundled output (it emits the init call without awaiting it).
 * - Deferring to an explicit awaited call inside an entry function makes the
 *   ordering explicit and bundler-independent.
 */
export async function ensureCoreStaticPluginsRegistered(): Promise<void> {
  await ensureBlockingCoreStaticPluginsRegistered();
  if (shouldBlockDeferredPluginImports()) {
    logger.info(
      "[boot] ELIZA_BLOCK_DEFERRED_PLUGIN_IMPORTS=1 — awaiting deferred plugin imports before readiness",
    );
    await ensureDeferredCoreStaticPluginsRegistered();
  } else {
    logger.info("[boot] deferred plugin imports scheduled after readiness");
  }
}

type SignalShutdownContext = {
  getRuntime: () => AgentRuntime;
  getSandboxManager: () => SandboxManager | null;
  beforeShutdown?: () => void | Promise<void>;
};

let activeSignalShutdownContext: SignalShutdownContext | null = null;
let signalHandlersRegistered = false;
let signalShutdownPromise: Promise<void> | null = null;

function registerSignalShutdownHandlers(context: SignalShutdownContext): void {
  activeSignalShutdownContext = context;
  if (signalHandlersRegistered) {
    return;
  }

  const shutdown = async (): Promise<void> => {
    if (signalShutdownPromise) {
      await signalShutdownPromise;
      return;
    }

    signalShutdownPromise = (async () => {
      const current = activeSignalShutdownContext;
      if (!current) {
        process.exit(0);
      }

      try {
        await current?.beforeShutdown?.();
      } catch (err) {
        logger.warn(`[eliza] Pre-shutdown cleanup error: ${formatError(err)}`);
      }

      try {
        const sandboxManager = current?.getSandboxManager();
        if (sandboxManager) {
          try {
            await sandboxManager.stop();
            logger.info("[eliza] Sandbox manager stopped");
          } catch (err) {
            logger.warn(
              `[eliza] Sandbox stop error: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        }
      } catch (err) {
        logger.warn(`[eliza] Sandbox shutdown error: ${formatError(err)}`);
      }

      try {
        const runtime = current?.getRuntime();
        if (runtime) {
          // SIGINT/SIGTERM is an interactive/dev teardown — use the capped fast
          // path so the process exits promptly instead of waiting on in-flight
          // deferred service starts or an embedding-queue flush (#9605).
          await shutdownRuntime(runtime, "signal shutdown", { fast: true });
        }
      } catch (err) {
        logger.warn(`[eliza] Error during shutdown: ${formatError(err)}`);
      }

      process.exit(0);
    })();

    await signalShutdownPromise;
  };

  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
  signalHandlersRegistered = true;
}

/**
 * Map of baseline bundled @elizaos plugin names to their statically imported
 * modules.
 *
 * Post-release plugins are intentionally excluded so the packaged runtime can
 * ship a smaller baseline bundle. Those plugins fall through to dynamic
 * import() and can be installed later via the plugin installer.
 *
 * The actual `Object.assign(STATIC_ELIZA_PLUGINS, ...)` registration runs
 * inside `ensureCoreStaticPluginsRegistered()` (defined above), which is
 * called at the top of every runtime entry point. Doing it there instead of
 * at module init avoids a `Bun.build` cross-module top-level-await scheduling
 * bug that strands `@elizaos/plugin-sql` undefined in the bundled runtime.
 */

// NODE_PATH so dynamic plugin imports (e.g. @elizaos/plugin-*) resolve.
// WHY: When eliza is loaded from dist/ or by a test runner, Node's resolution does not
// search repo root node_modules; import("@elizaos/plugin-*") then fails. We prepend
// repo root node_modules only if not already in NODE_PATH (run-node.mjs may have set it)
// to avoid duplicate entries; _initPaths() makes Node re-read NODE_PATH. See docs/plugin-resolution-and-node-path.md.
// We walk up from this file to find node_modules — we do not assume a fixed depth
// (e.g. two levels for src/runtime/ or dist/runtime/) so we still work if build
// output structure changes (e.g. flat dist). First directory with node_modules wins.
const _elizaDir = path.dirname(fileURLToPath(import.meta.url));
let _dir = _elizaDir;
let _rootModules: string | null = null;
while (_dir !== path.dirname(_dir)) {
  const candidate = path.join(_dir, "node_modules");
  if (existsSync(candidate)) {
    _rootModules = candidate;
    break;
  }
  _dir = path.dirname(_dir);
}
if (_rootModules) {
  const prev = process.env.NODE_PATH ?? "";
  const entries = prev ? prev.split(path.delimiter) : [];
  const normalizedRoot = path.resolve(_rootModules);
  if (!entries.some((e) => path.resolve(e) === normalizedRoot)) {
    process.env.NODE_PATH = prev
      ? `${_rootModules}${path.delimiter}${prev}`
      : _rootModules;
    createRequire(import.meta.url)("node:module").Module._initPaths();
  }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Temporary local compatibility shim for `@elizaos/core` not exporting
 * `SandboxFetchAuditEvent` on the current dependency line in this repo.
 * It preserves the runtime shape used by `sandboxAuditHandler`:
 * - `direction` and `url` are required
 * - `tokenIds` tracks tokens associated with the audit payload
 * Remove this local shim once the dependency line used here re-exports it.
 */
type SandboxFetchAuditEvent = {
  direction: "inbound" | "outbound";
  url: string;
  tokenIds: string[];
};

export async function configureLocalEmbeddingPlugin(
  _plugin: Plugin,
  config?: ElizaConfig,
): Promise<void> {
  const { detectEmbeddingPreset, selectEmbeddingPresetFromHardware } =
    await import("@elizaos/plugin-local-inference/runtime/embedding-presets");
  let detectedPreset = detectEmbeddingPreset();
  let detectedGpuBackend: "cuda" | "metal" | "vulkan" | null = null;
  try {
    const { probeHardware } = await import(
      "@elizaos/plugin-local-inference/services"
    );
    const hardware = await probeHardware();
    detectedPreset = selectEmbeddingPresetFromHardware(hardware);
    detectedGpuBackend = hardware.gpu?.backend ?? null;
  } catch (err) {
    logger.warn(
      `[eliza] Local embedding hardware probe failed; using sync preset fallback: ${formatError(err)}`,
    );
  }
  const SQL_COMPATIBLE_EMBEDDING_DIMENSIONS = new Set([
    384, 512, 768, 1024, 1536, 2048, 3072,
  ]);

  const normalizeEmbeddingDimensions = (
    rawValue: string | undefined,
  ): string | undefined => {
    if (!rawValue) return undefined;
    const parsed = Number.parseInt(rawValue, 10);
    if (!Number.isInteger(parsed) || parsed <= 0) return undefined;
    return SQL_COMPATIBLE_EMBEDDING_DIMENSIONS.has(parsed)
      ? String(parsed)
      : "384";
  };

  const embeddingConfig = config?.embedding;
  const configuredModel = embeddingConfig?.model?.trim();
  const configuredRepo = embeddingConfig?.modelRepo?.trim();
  const configuredDimensions = normalizeEmbeddingDimensions(
    typeof embeddingConfig?.dimensions === "number" &&
      Number.isInteger(embeddingConfig.dimensions) &&
      embeddingConfig.dimensions > 0
      ? String(embeddingConfig.dimensions)
      : undefined,
  );
  const detectedDimensions = normalizeEmbeddingDimensions(
    String(detectedPreset.dimensions),
  );
  const configuredContextSize =
    typeof embeddingConfig?.contextSize === "number" &&
    Number.isInteger(embeddingConfig.contextSize) &&
    embeddingConfig.contextSize > 0
      ? String(embeddingConfig.contextSize)
      : undefined;

  const configuredGpuLayers = (() => {
    const value = embeddingConfig?.gpuLayers;
    if (typeof value === "number" && Number.isInteger(value) && value >= 0) {
      return String(value);
    }
    if (value === "auto" || value === "max") {
      return "auto";
    }
    return undefined;
  })();

  const setEnvIfMissing = (key: string, value: string | undefined): void => {
    if (!value || process.env[key]) return;
    process.env[key] = value;
  };
  const setEnvFromConfig = (key: string, value: string | undefined): void => {
    if (!value) return;
    process.env[key] = value;
  };

  // Apply Eliza's hardware-adaptive preset selection. Hard-coding the standard
  // preset here forces slower first-run downloads on Windows and low-spec
  // machines.
  setEnvIfMissing(
    "LOCAL_EMBEDDING_MODEL",
    configuredModel || detectedPreset.model,
  );
  if (configuredRepo) {
    setEnvFromConfig("LOCAL_EMBEDDING_MODEL_REPO", configuredRepo);
  } else if (!configuredModel) {
    setEnvIfMissing("LOCAL_EMBEDDING_MODEL_REPO", detectedPreset.modelRepo);
  }
  if (configuredDimensions) {
    setEnvFromConfig("LOCAL_EMBEDDING_DIMENSIONS", configuredDimensions);
  } else if (!configuredModel) {
    setEnvIfMissing("LOCAL_EMBEDDING_DIMENSIONS", detectedDimensions);
  }
  if (configuredContextSize) {
    setEnvFromConfig("LOCAL_EMBEDDING_CONTEXT_SIZE", configuredContextSize);
  } else if (!configuredModel) {
    setEnvIfMissing(
      "LOCAL_EMBEDDING_CONTEXT_SIZE",
      String(detectedPreset.contextSize),
    );
  }

  if (configuredGpuLayers) {
    process.env.LOCAL_EMBEDDING_GPU_LAYERS = configuredGpuLayers;
  } else if (!process.env.LOCAL_EMBEDDING_GPU_LAYERS) {
    process.env.LOCAL_EMBEDDING_GPU_LAYERS = String(detectedPreset.gpuLayers);
  }

  // Performance tuning
  // Disable mmap on Metal to prevent "different text" errors with some models.
  // CUDA/Vulkan keep mmap enabled; the model is tiny and the file-backed load is
  // the safer default there.
  const resolvedGpuLayers =
    configuredGpuLayers ?? process.env.LOCAL_EMBEDDING_GPU_LAYERS;
  const shouldDisableMmap =
    resolvedGpuLayers === "auto" &&
    (detectedGpuBackend === "metal" ||
      (detectedGpuBackend === null && process.platform === "darwin"));
  setEnvIfMissing(
    "LOCAL_EMBEDDING_USE_MMAP",
    shouldDisableMmap ? "false" : "true",
  );

  setEnvIfMissing("MODELS_DIR", path.join(resolveStateDir(), "models"));
  const documentEmbeddingProvider = process.env.EMBEDDING_PROVIDER?.trim();
  if (
    !documentEmbeddingProvider ||
    !["local", "openai", "google"].includes(
      documentEmbeddingProvider.toLowerCase(),
    )
  ) {
    process.env.EMBEDDING_PROVIDER = "local";
  }

  // Normalize Google AI API key aliases — the elizaOS plugin and @google/genai
  // SDK expect different env var names. Canonicalize to the long form that
  // @elizaos/plugin-google-genai reads via runtime.getSetting(). Users can set
  // any of: GEMINI_API_KEY, GOOGLE_API_KEY, GOOGLE_GENERATIVE_AI_API_KEY.
  setEnvIfMissing(
    "GOOGLE_GENERATIVE_AI_API_KEY",
    process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY,
  );

  // Default Google model names — the Google GenAI plugin's getSetting() returns
  // null (not undefined) for missing keys, but the plugin checks !== undefined
  // causing String(null) = "null" to be sent as the model name. Set sensible
  // defaults so the plugin always has valid model names.
  setEnvIfMissing("GOOGLE_SMALL_MODEL", "gemini-3-flash-preview");
  setEnvIfMissing("GOOGLE_LARGE_MODEL", "gemini-3.1-pro-preview");

  // Default Groq model names — plugin-groq still ships a deprecated large-model
  // fallback. Seed runtime defaults before plugin init so direct Groq provider
  // sessions use the approved GPT-OSS default.
  const currentSharedSmallModel =
    process.env.OPENAI_SMALL_MODEL ?? process.env.SMALL_MODEL;
  const currentSharedLargeModel =
    process.env.OPENAI_LARGE_MODEL ?? process.env.LARGE_MODEL;
  setEnvIfMissing(
    "GROQ_SMALL_MODEL",
    currentSharedSmallModel && !isLikelyOpenAiTextModel(currentSharedSmallModel)
      ? currentSharedSmallModel
      : "openai/gpt-oss-120b",
  );
  setEnvIfMissing(
    "GROQ_LARGE_MODEL",
    currentSharedLargeModel && !isLikelyOpenAiTextModel(currentSharedLargeModel)
      ? currentSharedLargeModel
      : "openai/gpt-oss-120b",
  );

  // Default Cerebras model — plugin-openai's Cerebras mode otherwise falls
  // back to OpenAI-only ids when CEREBRAS_MODEL is unset. Seed the approved
  // Gemma default before plugin init while preserving explicit shared model
  // overrides from OPENAI_LARGE_MODEL / LARGE_MODEL.
  setEnvIfMissing(
    "CEREBRAS_MODEL",
    currentSharedLargeModel && !isLikelyOpenAiTextModel(currentSharedLargeModel)
      ? currentSharedLargeModel
      : DEFAULT_CEREBRAS_TEXT_MODEL,
  );

  logger.info(
    `[eliza] Configured local embedding env: ${process.env.LOCAL_EMBEDDING_MODEL} (repo: ${process.env.LOCAL_EMBEDDING_MODEL_REPO ?? "auto"}, dims: ${process.env.LOCAL_EMBEDDING_DIMENSIONS ?? "auto"}, ctx: ${process.env.LOCAL_EMBEDDING_CONTEXT_SIZE ?? "auto"}, GPU: ${process.env.LOCAL_EMBEDDING_GPU_LAYERS}, mmap: ${process.env.LOCAL_EMBEDDING_USE_MMAP})`,
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function trimEnvString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function trimCloudCredential(value: unknown): string | undefined {
  const trimmed = trimEnvString(value);
  if (!trimmed || trimmed.toUpperCase() === "[REDACTED]") return undefined;
  return trimmed;
}

type MutableConfigEnv = Record<string, unknown> & {
  vars?: Record<string, unknown>;
};

function getMutableConfigEnv(config: ElizaConfig): MutableConfigEnv | null {
  if (
    !config.env ||
    typeof config.env !== "object" ||
    Array.isArray(config.env)
  ) {
    return null;
  }
  return config.env as MutableConfigEnv;
}

function getMutableConfigEnvVars(
  configEnv: MutableConfigEnv,
): Record<string, unknown> | null {
  if (
    !configEnv.vars ||
    typeof configEnv.vars !== "object" ||
    Array.isArray(configEnv.vars)
  ) {
    return null;
  }
  return configEnv.vars as Record<string, unknown>;
}

function readConfigEnvValue(
  config: ElizaConfig,
  key: string,
): string | undefined {
  const configEnv = getMutableConfigEnv(config);
  if (!configEnv) return undefined;
  const vars = getMutableConfigEnvVars(configEnv);
  return trimEnvString(vars?.[key]) ?? trimEnvString(configEnv[key]);
}

function readEffectiveEnvValue(
  config: ElizaConfig,
  key: string,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  return trimEnvString(env[key]) ?? readConfigEnvValue(config, key);
}

function readEffectiveCloudCredential(
  config: ElizaConfig,
  key: string,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  return (
    trimCloudCredential(env[key]) ??
    trimCloudCredential(readConfigEnvValue(config, key))
  );
}

function isProvisionedCloudContainer(env: NodeJS.ProcessEnv = process.env) {
  return env.ELIZA_CLOUD_PROVISIONED === "1";
}

function isExplicitFalseEnvValue(value: string | undefined): boolean {
  return value?.trim().toLowerCase() === "false";
}

function hasExplicitEmbeddingProviderConfig(
  config: ElizaConfig,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return Boolean(
    readEffectiveEnvValue(config, "EMBEDDING_BASE_URL", env) ||
      readEffectiveEnvValue(config, "EMBEDDING_API_KEY", env),
  );
}

const CLOUD_ROUTING_MODEL_ENV: ReadonlyArray<[string, string]> = [
  ["ELIZAOS_CLOUD_NANO_MODEL", "nanoModel"],
  ["ELIZAOS_CLOUD_SMALL_MODEL", "smallModel"],
  ["ELIZAOS_CLOUD_MEDIUM_MODEL", "mediumModel"],
  ["ELIZAOS_CLOUD_LARGE_MODEL", "largeModel"],
  ["ELIZAOS_CLOUD_MEGA_MODEL", "megaModel"],
  ["ELIZAOS_CLOUD_RESPONSE_HANDLER_MODEL", "responseHandlerModel"],
  ["ELIZAOS_CLOUD_SHOULD_RESPOND_MODEL", "shouldRespondModel"],
  ["ELIZAOS_CLOUD_ACTION_PLANNER_MODEL", "actionPlannerModel"],
  ["ELIZAOS_CLOUD_PLANNER_MODEL", "plannerModel"],
  ["ELIZAOS_CLOUD_RESPONSE_MODEL", "responseModel"],
  ["ELIZAOS_CLOUD_MEDIA_DESCRIPTION_MODEL", "mediaDescriptionModel"],
];

function mergeMissingCloudRoutingModelPins(
  config: ElizaConfig,
  env: NodeJS.ProcessEnv,
): boolean {
  const existingRouting = resolveServiceRoutingInConfig(
    config as Record<string, unknown>,
  );
  const llmText = existingRouting?.llmText as
    | Record<string, unknown>
    | undefined;
  if (!llmText) return false;

  const patch: Record<string, string> = {};
  for (const [envKey, routingField] of CLOUD_ROUTING_MODEL_ENV) {
    if (trimEnvString(llmText[routingField])) continue;
    const value = readEffectiveEnvValue(config, envKey, env);
    if (value) patch[routingField] = value;
  }
  if (Object.keys(patch).length === 0) return false;

  config.serviceRouting = {
    ...(existingRouting ?? {}),
    llmText: {
      ...llmText,
      ...patch,
    },
  };
  return true;
}

/** @internal Exported for regression coverage. */
export function ensureProvisionedCloudContainerConfig(
  config: ElizaConfig,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (!isProvisionedCloudContainer(env)) {
    return false;
  }

  const apiKey =
    trimCloudCredential(config.cloud?.apiKey) ??
    readEffectiveCloudCredential(config, "ELIZAOS_CLOUD_API_KEY", env);
  if (!apiKey) {
    return false;
  }

  let changed = false;
  const cloud = config.cloud ?? {};
  const baseUrl =
    trimEnvString(config.cloud?.baseUrl) ??
    readEffectiveEnvValue(config, "ELIZAOS_CLOUD_BASE_URL", env);
  const agentId =
    trimEnvString(config.cloud?.agentId) ??
    readEffectiveEnvValue(config, "ELIZA_CLOUD_AGENT_ID", env) ??
    readEffectiveEnvValue(config, "WAIFU_ELIZA_CLOUD_AGENT_ID", env);

  if (
    config.cloud?.enabled !== true ||
    config.cloud?.apiKey !== apiKey ||
    (baseUrl && config.cloud?.baseUrl !== baseUrl) ||
    (agentId && config.cloud?.agentId !== agentId)
  ) {
    config.cloud = {
      ...cloud,
      enabled: true,
      apiKey,
      ...(baseUrl ? { baseUrl } : {}),
      ...(agentId ? { agentId } : {}),
    };
    changed = true;
  }

  const deploymentTarget = resolveDeploymentTargetInConfig(
    config as Record<string, unknown>,
  );
  if (
    deploymentTarget.runtime !== "cloud" ||
    deploymentTarget.provider !== "elizacloud"
  ) {
    config.deploymentTarget = {
      runtime: "cloud",
      provider: "elizacloud",
    };
    changed = true;
  }

  const topology = resolveElizaCloudTopology(config as Record<string, unknown>);
  if (!topology.services.inference) {
    const existingRouting = resolveServiceRoutingInConfig(
      config as Record<string, unknown>,
    );
    const cloudRouting = buildDefaultElizaCloudServiceRouting({
      includeInference: true,
      excludeServices:
        isExplicitFalseEnvValue(
          readEffectiveEnvValue(config, "ELIZAOS_CLOUD_USE_EMBEDDINGS", env),
        ) && hasExplicitEmbeddingProviderConfig(config, env)
          ? ["embeddings"]
          : undefined,
      nanoModel: readEffectiveEnvValue(config, "ELIZAOS_CLOUD_NANO_MODEL", env),
      smallModel: readEffectiveEnvValue(
        config,
        "ELIZAOS_CLOUD_SMALL_MODEL",
        env,
      ),
      mediumModel: readEffectiveEnvValue(
        config,
        "ELIZAOS_CLOUD_MEDIUM_MODEL",
        env,
      ),
      largeModel: readEffectiveEnvValue(
        config,
        "ELIZAOS_CLOUD_LARGE_MODEL",
        env,
      ),
      megaModel: readEffectiveEnvValue(config, "ELIZAOS_CLOUD_MEGA_MODEL", env),
      responseHandlerModel: readEffectiveEnvValue(
        config,
        "ELIZAOS_CLOUD_RESPONSE_HANDLER_MODEL",
        env,
      ),
      shouldRespondModel: readEffectiveEnvValue(
        config,
        "ELIZAOS_CLOUD_SHOULD_RESPOND_MODEL",
        env,
      ),
      actionPlannerModel: readEffectiveEnvValue(
        config,
        "ELIZAOS_CLOUD_ACTION_PLANNER_MODEL",
        env,
      ),
      plannerModel: readEffectiveEnvValue(
        config,
        "ELIZAOS_CLOUD_PLANNER_MODEL",
        env,
      ),
      responseModel: readEffectiveEnvValue(
        config,
        "ELIZAOS_CLOUD_RESPONSE_MODEL",
        env,
      ),
      mediaDescriptionModel: readEffectiveEnvValue(
        config,
        "ELIZAOS_CLOUD_MEDIA_DESCRIPTION_MODEL",
        env,
      ),
    });
    config.serviceRouting = {
      ...(existingRouting ?? {}),
      ...cloudRouting,
    };
    changed = true;
  } else if (mergeMissingCloudRoutingModelPins(config, env)) {
    changed = true;
  }

  if (changed) {
    logger.info(
      "[eliza] Provisioned cloud container missing managed runtime topology; forcing Eliza Cloud routing in memory",
    );
  }

  const finalTopology = resolveElizaCloudTopology(
    config as Record<string, unknown>,
  );
  logger.info(
    `[eliza][cloud-topology] provisioned=true changed=${changed} -> runtime=${finalTopology.runtime} inference=${finalTopology.services.inference}`,
  );

  return changed;
}

/** @internal Exported for regression coverage. */
export function shouldStartElizaCloudThinClient(
  config: ElizaConfig,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (isProvisionedCloudContainer(env)) {
    return false;
  }

  const deploymentTarget = resolveDeploymentTargetInConfig(
    config as Record<string, unknown>,
  );
  return Boolean(
    deploymentTarget.runtime === "cloud" &&
      deploymentTarget.provider === "elizacloud" &&
      config.cloud?.apiKey &&
      config.cloud?.agentId?.trim(),
  );
}

function setConfigEnvValue(
  config: ElizaConfig,
  key: string,
  value: string,
): void {
  if (
    !config.env ||
    typeof config.env !== "object" ||
    Array.isArray(config.env)
  ) {
    config.env = {};
  }
  const configEnv = config.env as MutableConfigEnv;
  const vars = getMutableConfigEnvVars(configEnv);
  if (vars) {
    vars[key] = value;
    delete configEnv[key];
    return;
  }
  configEnv[key] = value;
}

function deleteConfigEnvValue(config: ElizaConfig, key: string): void {
  const configEnv = getMutableConfigEnv(config);
  if (!configEnv) return;

  const vars = getMutableConfigEnvVars(configEnv);
  if (vars) {
    delete vars[key];
    if (Object.keys(vars).length === 0) {
      delete configEnv.vars;
    }
  }

  delete configEnv[key];
}

function detectOpenAiBaseUrlProvider(baseUrl: string): "groq" | null {
  try {
    const hostname = new URL(baseUrl).hostname.trim().toLowerCase();
    if (hostname === "api.groq.com" || hostname.endsWith(".groq.com")) {
      return "groq";
    }
  } catch {
    return null;
  }

  return null;
}

function looksLikeGroqApiKey(value: string | undefined): boolean {
  return Boolean(value && /^gsk[-_]/i.test(value));
}

function isLikelyOpenAiTextModel(value: string | undefined): boolean {
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  return normalized.startsWith("gpt-") || normalized.startsWith("openai/");
}

/**
 * Normalize known-bad provider compatibility shims before plugin resolution.
 *
 * A common failure mode is routing the OpenAI plugin through Groq's
 * OpenAI-compatible base URL while leaving OpenAI defaults (`gpt-5.5`,
 * `gpt-5-mini`) in place. Structured output generation then fails during
 * message handling because Groq does not serve those model IDs.
 *
 * When we can confidently detect that state, rewrite the effective runtime
 * config to use the Groq plugin directly.
 */
/** @internal Exported for testing. */
export function normalizeOpenAiCompatibleProviderConfig(
  config: ElizaConfig,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const cloudInferenceEnabled = resolveElizaCloudTopology(
    config as Record<string, unknown>,
  ).services.inference;
  if (cloudInferenceEnabled) {
    return false;
  }

  const openaiBaseUrl = readEffectiveEnvValue(config, "OPENAI_BASE_URL", env);
  if (!openaiBaseUrl) {
    return false;
  }

  if (detectOpenAiBaseUrlProvider(openaiBaseUrl) !== "groq") {
    return false;
  }

  const openaiApiKey = readEffectiveEnvValue(config, "OPENAI_API_KEY", env);
  const groqApiKey = readEffectiveEnvValue(config, "GROQ_API_KEY", env);
  const inheritedGroqApiKey =
    groqApiKey ??
    (looksLikeGroqApiKey(openaiApiKey) ? openaiApiKey : undefined);
  if (!inheritedGroqApiKey) {
    return false;
  }

  const currentGroqSmallModel = readEffectiveEnvValue(
    config,
    "GROQ_SMALL_MODEL",
    env,
  );
  const currentGroqLargeModel = readEffectiveEnvValue(
    config,
    "GROQ_LARGE_MODEL",
    env,
  );
  const currentSharedSmallModel =
    readEffectiveEnvValue(config, "OPENAI_SMALL_MODEL", env) ??
    readEffectiveEnvValue(config, "SMALL_MODEL", env);
  const currentSharedLargeModel =
    readEffectiveEnvValue(config, "OPENAI_LARGE_MODEL", env) ??
    readEffectiveEnvValue(config, "LARGE_MODEL", env);

  const normalizedGroqSmallModel =
    currentGroqSmallModel ??
    (currentSharedSmallModel &&
    !isLikelyOpenAiTextModel(currentSharedSmallModel)
      ? currentSharedSmallModel
      : "openai/gpt-oss-120b");
  const normalizedGroqLargeModel =
    currentGroqLargeModel ??
    (currentSharedLargeModel &&
    !isLikelyOpenAiTextModel(currentSharedLargeModel)
      ? currentSharedLargeModel
      : "openai/gpt-oss-120b");

  env.GROQ_API_KEY = inheritedGroqApiKey;
  env.GROQ_SMALL_MODEL = normalizedGroqSmallModel;
  env.GROQ_LARGE_MODEL = normalizedGroqLargeModel;
  setConfigEnvValue(config, "GROQ_API_KEY", inheritedGroqApiKey);
  setConfigEnvValue(config, "GROQ_SMALL_MODEL", normalizedGroqSmallModel);
  setConfigEnvValue(config, "GROQ_LARGE_MODEL", normalizedGroqLargeModel);

  delete env.OPENAI_BASE_URL;
  deleteConfigEnvValue(config, "OPENAI_BASE_URL");

  const shouldDisableOpenAiKey =
    !openaiApiKey ||
    openaiApiKey === groqApiKey ||
    looksLikeGroqApiKey(openaiApiKey);
  if (shouldDisableOpenAiKey) {
    delete env.OPENAI_API_KEY;
    deleteConfigEnvValue(config, "OPENAI_API_KEY");
  }

  const primaryModel = trimEnvString(config.agents?.defaults?.model?.primary);
  if (
    shouldDisableOpenAiKey &&
    primaryModel &&
    (primaryModel.toLowerCase() === "openai" ||
      isLikelyOpenAiTextModel(primaryModel))
  ) {
    config.agents ??= {};
    config.agents.defaults ??= {};
    config.agents.defaults.model = {
      ...config.agents.defaults.model,
      primary: "groq",
    };
  }

  logger.warn(
    "[eliza] Detected Groq routed through OPENAI_BASE_URL; normalizing runtime settings to use @elizaos/plugin-groq",
  );

  return true;
}

/** Redact username segments from filesystem paths to avoid leaking user info in logs. */
function _redactUserSegments(filepath: string): string {
  // Replace /Users/<name>/ or /home/<name>/ with /Users/<redacted>/ etc.
  return filepath.replace(/\/(Users|home)\/[^/]+\//g, "/$1/<redacted>/");
}

type RuntimeAdapterWithClose = {
  close?: () => Promise<void> | void;
};

/**
 * Best-effort runtime shutdown that also closes the database adapter.
 *
 * AgentRuntime.stop() only stops services. plugin-sql keeps a process-global
 * PGlite manager, so restarts must close the adapter or the next runtime can
 * silently reuse the same broken manager instance.
 */
export async function shutdownRuntime(
  runtime: AgentRuntime | null | undefined,
  context: string,
  options: { fast?: boolean } = {},
): Promise<void> {
  if (!runtime) return;

  const adapter = runtime.adapter as RuntimeAdapterWithClose | undefined;
  let firstError: unknown = null;

  try {
    // Interactive/signal teardown asks for the capped fast path so Ctrl-C does
    // not block on a slow deferred service start or a long embedding drain.
    await runtime.stop(options.fast ? { fast: true } : undefined);
  } catch (err) {
    firstError = err;
    logger.warn(`[eliza] ${context}: runtime stop failed: ${formatError(err)}`);
  }

  if (adapter && typeof adapter.close === "function") {
    try {
      await adapter.close();
    } catch (err) {
      if (!firstError) {
        firstError = err;
      }
      logger.warn(
        `[eliza] ${context}: database adapter close failed: ${formatError(err)}`,
      );
    }
  }

  if (firstError) {
    throw firstError;
  }
}

/**
 * Remove duplicate actions across an ordered list of plugins.
 *
 * When multiple plugins define an action with the same `name`, only the first
 * occurrence is kept.  This prevents "Action already registered" warnings from
 * elizaOS core.  The function mutates each plugin's `actions` array in-place.
 */
export function deduplicatePluginActions(plugins: Plugin[]): void {
  const seen = new Set<string>();
  for (const plugin of plugins) {
    if (plugin.actions) {
      plugin.actions = plugin.actions.filter((action) => {
        if (seen.has(action.name)) {
          logger.debug(
            `[eliza] Skipping duplicate action "${action.name}" from plugin "${plugin.name}"`,
          );
          return false;
        }
        seen.add(action.name);
        return true;
      });
    }
  }
}

interface TrajectoryLoggerControl {
  isEnabled?: () => boolean;
  setEnabled?: (enabled: boolean) => void;
}

type TrajectoryLoggerRegistrationStatus =
  | "pending"
  | "registering"
  | "registered"
  | "failed"
  | "unknown";

/** Subset of AutonomyService used to enable the autonomy loop. */
interface AutonomyServiceLike {
  enableAutonomy(): Promise<void>;
}

/**
 * Retrieve the AutonomyService from the runtime, returning null if unavailable.
 * Uses a runtime property check to safely narrow the opaque Service return.
 */
function getAutonomyService(runtime: AgentRuntime): AutonomyServiceLike | null {
  const svc = runtime.getService(AUTONOMY_SERVICE_TYPE);
  if (
    svc &&
    "enableAutonomy" in svc &&
    typeof svc.enableAutonomy === "function"
  ) {
    return svc as AutonomyServiceLike;
  }
  return null;
}

async function startAndRegisterAutonomyService(
  runtime: AgentRuntime,
): Promise<AutonomyServiceLike> {
  const service = await AutonomyService.start(runtime);
  runtime.services.set(AUTONOMY_SERVICE_TYPE as never, [service as never]);
  return service as AutonomyServiceLike;
}

type TrajectoryLoggerRuntimeLike = {
  getServicesByType?: (serviceType: string) => unknown;
  getService?: (serviceType: string) => unknown;
  getServiceLoadPromise?: (serviceType: string) => Promise<unknown>;
  getServiceRegistrationStatus?: (
    serviceType: string,
  ) => TrajectoryLoggerRegistrationStatus;
};

async function waitForTrajectoriesService(
  runtime: AgentRuntime,
  context: string,
  timeoutMs = 3000,
): Promise<void> {
  if (!runtimeTrajectoriesEnabled(runtime)) {
    return;
  }

  const runtimeLike = runtime as TrajectoryLoggerRuntimeLike;

  // Check if already available
  if (typeof runtimeLike.getService === "function") {
    const existing = runtimeLike.getService("trajectories");
    if (existing) return;
  }

  const registrationStatus =
    typeof runtimeLike.getServiceRegistrationStatus === "function"
      ? runtimeLike.getServiceRegistrationStatus("trajectories")
      : "unknown";

  if (
    registrationStatus !== "pending" &&
    registrationStatus !== "registering"
  ) {
    return;
  }

  if (typeof runtimeLike.getServiceLoadPromise !== "function") return;

  let timedOut = false;
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<void>((resolve) => {
    timeoutHandle = setTimeout(() => {
      timedOut = true;
      resolve();
    }, timeoutMs);
  });

  try {
    await Promise.race([
      runtimeLike.getServiceLoadPromise("trajectories").then(() => {}),
      timeoutPromise,
    ]);
    if (timedOut) {
      logger.debug(
        `[eliza] trajectories still ${registrationStatus} after ${timeoutMs}ms (${context})`,
      );
    }
  } catch (err) {
    logger.debug(
      `[eliza] trajectories registration failed while waiting (${context}): ${formatError(err)}`,
    );
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
  }
}

function ensureTrajectoryLoggerEnabled(
  runtime: AgentRuntime,
  context: string,
): void {
  if (!runtimeTrajectoriesEnabled(runtime)) {
    logger.info(`[eliza] Native trajectories disabled (${context})`);
    return;
  }

  const trajectoryLogger = runtime.getService("trajectories") as
    | TrajectoryLoggerControl
    | null
    | undefined;

  if (!trajectoryLogger) {
    logger.warn(
      `[eliza] trajectories service unavailable (${context}); trajectory capture disabled`,
    );
    return;
  }

  const isEnabled =
    typeof trajectoryLogger.isEnabled === "function"
      ? trajectoryLogger.isEnabled()
      : shouldEnableTrajectoryLoggingByDefault();
  const shouldEnable = shouldEnableTrajectoryLoggingByDefault();
  if (
    isEnabled !== shouldEnable &&
    typeof trajectoryLogger.setEnabled === "function"
  ) {
    trajectoryLogger.setEnabled(shouldEnable);
    logger.info(
      `[eliza] trajectories defaulted ${shouldEnable ? "on" : "off"} (${context})`,
    );
  }
}

async function installPromptOptimizationLayer(
  runtime: AgentRuntime,
  context: string,
  config?: ElizaConfig,
): Promise<void> {
  try {
    const { installPromptOptimizations } = await import(
      "./prompt-optimization.ts"
    );
    installPromptOptimizations(runtime, config);
  } catch (err) {
    logger.warn(
      `[eliza] Failed to install prompt optimizations (${context}): ${err instanceof Error ? err.message : err}`,
    );
  }
}

async function prepareRuntimeForTrajectoryCapture(
  runtime: AgentRuntime,
  context: string,
  config?: ElizaConfig,
): Promise<void> {
  await waitForTrajectoriesService(runtime, context);
  ensureTrajectoryLoggerEnabled(runtime, context);
  // Bridge the in-memory "trajectories" service to the SQL trajectory_steps
  // tables that the viewer + collection read. Without this the core service
  // captures LLM calls only into its own trajectory_step_index store, so every
  // platform without the plugin-training log-backfill (mobile, cloud) shows a
  // trajectory with zero recorded LLM calls. Patching here makes capture land
  // in trajectory_steps universally (local + cloud + mobile).
  try {
    await installDatabaseTrajectoryLogger(runtime);
  } catch (err) {
    logger.warn(
      `[eliza] Failed to install database trajectory logger (${context}): ${err instanceof Error ? err.message : err}`,
    );
  }
  await installPromptOptimizationLayer(runtime, context, config);
}

// ---------------------------------------------------------------------------
// Channel secret mapping
// ---------------------------------------------------------------------------

/**
 * Maps Eliza channel config fields to the environment variable names
 * that elizaOS plugins expect.
 *
 * Eliza stores channel credentials under `config.channels.<name>.<field>`,
 * while elizaOS plugins read them from process.env.
 */
const CHANNEL_ENV_MAP = CONNECTOR_ENV_MAP;

// ---------------------------------------------------------------------------
// Plugin resolution
// ---------------------------------------------------------------------------

export {
  BLOCKING_CORE_PLUGINS,
  CORE_PLUGINS,
  DEFERRED_CORE_PLUGINS,
  LEAN_CHAT_PLUGINS,
  OPTIONAL_CORE_PLUGINS,
};

// CHANNEL_PLUGIN_MAP, PROVIDER_PLUGIN_MAP, and OPTIONAL_PLUGIN_MAP live in
// ./plugin-collector.ts and are re-exported from this module for backward compatibility.

// ---------------------------------------------------------------------------
// Browser server pre-flight
// ---------------------------------------------------------------------------

/**
 * Returns true if the given env var key is safe to forward to runtime.settings.
 * Blocks blockchain private keys, secrets, passwords, tokens, credentials,
 * mnemonics, and seed phrases while allowing API keys that plugins need.
 */
export function isEnvKeyAllowedForForwarding(key: string): boolean {
  const upper = key.toUpperCase();
  if (upper === "ALLOW_NO_DATABASE") return false;
  // Block blockchain private keys
  if (upper.includes("PRIVATE_KEY")) return false;
  if (upper.startsWith("EVM_") || upper.startsWith("SOLANA_")) return false;
  // Block secrets, passwords, tokens, and seed phrases (but not API_KEY which plugins need)
  if (/(SECRET|PASSWORD|CREDENTIAL|MNEMONIC|SEED_PHRASE)/i.test(key))
    return false;
  if (/(ACCESS_TOKEN|REFRESH_TOKEN|SESSION_TOKEN|AUTH_TOKEN)$/i.test(key))
    return false;
  // Block elizaCloud connection keys — these must only come from config.cloud
  // via applyCloudConfigToEnv(). Forwarding them from config.env.vars into
  // runtime.settings would let a stale env-var shadow the live cloud key that
  // the app sets when the user connects through the UI.
  if (
    upper === "ELIZAOS_CLOUD_API_KEY" ||
    upper === "ELIZAOS_CLOUD_ENABLED" ||
    upper === "ELIZAOS_CLOUD_BASE_URL" ||
    upper === "ELIZAOS_CLOUD_NANO_MODEL" ||
    upper === "ELIZAOS_CLOUD_MEDIUM_MODEL" ||
    upper === "ELIZAOS_CLOUD_SMALL_MODEL" ||
    upper === "ELIZAOS_CLOUD_LARGE_MODEL" ||
    upper === "ELIZAOS_CLOUD_MEGA_MODEL" ||
    upper === "ELIZAOS_CLOUD_RESPONSE_HANDLER_MODEL" ||
    upper === "ELIZAOS_CLOUD_SHOULD_RESPOND_MODEL" ||
    upper === "ELIZAOS_CLOUD_ACTION_PLANNER_MODEL" ||
    upper === "ELIZAOS_CLOUD_PLANNER_MODEL"
  )
    return false;
  return true;
}

function assertPersistentDatabaseRequired(
  runtime: Pick<AgentRuntime, "getSetting" | "agentId">,
): void {
  const raw =
    runtime.getSetting("ALLOW_NO_DATABASE") ?? process.env.ALLOW_NO_DATABASE;
  const normalized = String(raw ?? "")
    .trim()
    .toLowerCase();
  if (
    normalized === "true" ||
    normalized === "1" ||
    normalized === "yes" ||
    normalized === "on"
  ) {
    throw new Error(
      `Eliza requires persistent database storage and does not permit ALLOW_NO_DATABASE (agent ${runtime.agentId}). Remove ALLOW_NO_DATABASE from config/env and use @elizaos/plugin-sql.`,
    );
  }
}

function isElizaCloudManagedProcessEnvKey(key: string): boolean {
  const upper = key.toUpperCase();
  return (
    upper === "ELIZAOS_CLOUD_API_KEY" ||
    upper === "ELIZAOS_CLOUD_ENABLED" ||
    upper === "ELIZAOS_CLOUD_BASE_URL" ||
    upper === "ELIZAOS_CLOUD_NANO_MODEL" ||
    upper === "ELIZAOS_CLOUD_MEDIUM_MODEL" ||
    upper === "ELIZAOS_CLOUD_SMALL_MODEL" ||
    upper === "ELIZAOS_CLOUD_LARGE_MODEL" ||
    upper === "ELIZAOS_CLOUD_MEGA_MODEL" ||
    upper === "ELIZAOS_CLOUD_RESPONSE_HANDLER_MODEL" ||
    upper === "ELIZAOS_CLOUD_SHOULD_RESPOND_MODEL" ||
    upper === "ELIZAOS_CLOUD_ACTION_PLANNER_MODEL" ||
    upper === "ELIZAOS_CLOUD_PLANNER_MODEL"
  );
}

// ---------------------------------------------------------------------------
// Config → Character mapping
// ---------------------------------------------------------------------------

/**
 * Propagate channel credentials from Eliza config into process.env so
 * that elizaOS plugins can find them.
 */
/** @internal Exported for testing. */
export function applyConnectorSecretsToEnv(config: ElizaConfig): void {
  // Prefer config.connectors, fall back to config.channels for backward compatibility
  const connectors =
    config.connectors ?? (config as Record<string, unknown>).channels ?? {};

  for (const [channelName, channelConfig] of Object.entries(connectors)) {
    if (!channelConfig || typeof channelConfig !== "object") continue;
    const configObj = channelConfig as Record<string, unknown>;

    // Discord plugins in the ecosystem use both DISCORD_API_TOKEN and
    // DISCORD_BOT_TOKEN across versions. Mirror to both when available.
    if (channelName === "discord") {
      const tokenValue =
        (typeof configObj.token === "string" && configObj.token.trim()) ||
        (typeof configObj.botToken === "string" && configObj.botToken.trim()) ||
        "";
      if (tokenValue) {
        process.env.DISCORD_API_TOKEN = tokenValue;
        process.env.DISCORD_BOT_TOKEN = tokenValue;
      }
    }

    const envMap = CHANNEL_ENV_MAP[channelName];
    if (!envMap) continue;

    for (const [configField, envKey] of Object.entries(envMap)) {
      const value = configObj[configField];
      if (typeof value === "boolean" || typeof value === "number") {
        process.env[envKey] = String(value);
      } else if (typeof value === "string" && value.trim()) {
        process.env[envKey] = value;
      }
    }

    if (channelName === "whatsapp") {
      const allowFrom = configObj.allowFrom;
      if (Array.isArray(allowFrom) && allowFrom.length > 0) {
        const normalized = allowFrom
          .map((value) => String(value).trim())
          .filter(Boolean);
        if (normalized.length > 0) {
          process.env.WHATSAPP_ALLOW_FROM = normalized.join(",");
        }
      }

      const groupAllowFrom = configObj.groupAllowFrom;
      if (Array.isArray(groupAllowFrom) && groupAllowFrom.length > 0) {
        const normalized = groupAllowFrom
          .map((value) => String(value).trim())
          .filter(Boolean);
        if (normalized.length > 0) {
          process.env.WHATSAPP_GROUP_ALLOW_FROM = normalized.join(",");
        }
      }

      const accounts = configObj.accounts;
      if (
        accounts &&
        typeof accounts === "object" &&
        !Array.isArray(accounts)
      ) {
        const firstEnabledAccount = Object.values(
          accounts as Record<string, unknown>,
        ).find((account) => {
          if (
            !account ||
            typeof account !== "object" ||
            Array.isArray(account)
          ) {
            return false;
          }
          const candidate = account as Record<string, unknown>;
          return (
            candidate.enabled !== false && typeof candidate.authDir === "string"
          );
        }) as Record<string, unknown> | undefined;

        if (
          firstEnabledAccount &&
          typeof firstEnabledAccount.authDir === "string" &&
          firstEnabledAccount.authDir.trim()
        ) {
          process.env.WHATSAPP_AUTH_DIR = firstEnabledAccount.authDir.trim();
        }
      }
    }
  }
}

/**
 * Auto-resolve Discord Application ID from the bot token via Discord API.
 * Called during async runtime init so that users only need a bot token.
 */
/** @internal Exported for testing. */
export async function autoResolveDiscordAppId(): Promise<void> {
  if (process.env.DISCORD_APPLICATION_ID) return;

  const discordToken =
    process.env.DISCORD_API_TOKEN || process.env.DISCORD_BOT_TOKEN;
  if (!discordToken) return;

  try {
    const res = await fetch(
      "https://discord.com/api/v10/oauth2/applications/@me",
      {
        headers: { Authorization: `Bot ${discordToken}` },
        signal: AbortSignal.timeout(3_000),
      },
    );

    if (!res.ok) {
      logger.warn(
        `[eliza] Failed to auto-resolve Discord Application ID: ${res.status}`,
      );
      return;
    }

    const app = (await res.json()) as { id?: string };
    if (!app.id) return;

    process.env.DISCORD_APPLICATION_ID = app.id;
    logger.info(`[eliza] Auto-resolved Discord Application ID: ${app.id}`);
  } catch (err) {
    logger.warn(
      `[eliza] Could not auto-resolve Discord Application ID: ${err}`,
    );
  }
}

/**
 * Fetch GitHub OAuth token from cloud if available and no local token is set.
 * Called during async runtime init after cloud config is applied.
 *
 * Flow: If the agent has a managed GitHub connection in the cloud, and no
 * local GITHUB_TOKEN is set, fetch the OAuth token from the cloud API and
 * inject it into process.env so plugins (plugin-github, git-workspace-service)
 * can use it for API calls and git credential helpers.
 */
/** @internal Exported for testing. */
export async function autoFetchCloudGithubToken(
  agentId?: string,
): Promise<void> {
  // Skip if a local token is already configured
  if (process.env.GITHUB_TOKEN || process.env.GITHUB_PAT) return;

  // Need cloud credentials and an agent ID
  const cloudApiKey = process.env.ELIZAOS_CLOUD_API_KEY?.trim();
  const cloudBaseUrl =
    process.env.ELIZAOS_CLOUD_BASE_URL?.trim() || "https://api.elizacloud.ai";
  if (!cloudApiKey || !agentId) return;

  const managedNs = process.env.ELIZA_CLOUD_MANAGED_AGENTS_API_SEGMENT?.trim();
  if (!managedNs) return;

  try {
    const url = `${cloudBaseUrl}/api/v1/${managedNs}/agents/${encodeURIComponent(agentId)}/github/token`;
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${cloudApiKey}`,
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(3_000),
    });

    if (!res.ok) {
      // 404 = no GitHub connection for this agent, which is fine
      if (res.status !== 404) {
        logger.debug(
          `[eliza] Failed to fetch cloud GitHub token: ${res.status}`,
        );
      }
      return;
    }

    const body = (await res.json()) as {
      success?: boolean;
      data?: { accessToken?: string; githubUsername?: string };
    };
    if (!body.success || !body.data?.accessToken) return;

    process.env.GITHUB_TOKEN = body.data.accessToken;
    logger.info(
      `[eliza] Fetched GitHub token from cloud for @${body.data.githubUsername || "unknown"}`,
    );
  } catch (err) {
    logger.info(`[eliza] Could not fetch cloud GitHub token: ${err}`);
  }
}

/**
 * Non-secret fingerprint of a cloud API key for boot logs and mismatch
 * warnings (#11038): first 6 chars + length, so `hasApiKey=true` can never
 * mean "yes, a 31-char placeholder" without the log showing it.
 */
export function cloudApiKeyFingerprint(value: string | undefined): string {
  const v = value?.trim();
  if (!v) return "(none)";
  return `${v.slice(0, 6)}…(len ${v.length})`;
}

/**
 * Propagate cloud config from Eliza config into process.env so the
 * ElizaCloud plugin can discover settings at startup.
 */
export function applyCloudConfigToEnv(config: ElizaConfig): void {
  migrateLegacyRuntimeConfig(config as Record<string, unknown>);
  ensureProvisionedCloudContainerConfig(config);
  const cloud = config.cloud;

  const isCloudContainer = isProvisionedCloudContainer();
  if (!cloud && !isCloudContainer) return;
  const topology = resolveElizaCloudTopology(config as Record<string, unknown>);

  // Cloud inference is selected from the canonical first-run connection, not
  // just from raw cloud flags. This keeps linked cloud auth from re-enabling
  // Eliza Cloud after the user has switched to a local or remote provider.
  const effectivelyEnabled = topology.services.inference || isCloudContainer;
  const shouldLoadCloudPlugin = topology.shouldLoadPlugin || isCloudContainer;

  const setCloudUsageEnv = (key: string, enabled: boolean): void => {
    if (enabled) {
      process.env[key] = "true";
    } else {
      delete process.env[key];
    }
  };

  if (isElizaSettingsDebugEnabled()) {
    const c = (cloud ?? {}) as Record<string, unknown>;
    logger.debug(
      `[eliza][settings][runtime] applyCloudConfigToEnv inference=${effectivelyEnabled} shouldLoadPlugin=${shouldLoadCloudPlugin} isCloudContainer=${isCloudContainer} cloud=${JSON.stringify(settingsDebugCloudSummary(c))}`,
    );
  }

  // USE_INFERENCE is a TRI-state contract with plugin-elizacloud's chat-brain
  // registration (registerTextInferenceModels): "true" → Cloud serves the text
  // slots; explicit "false" → the plugin is loaded for its capabilities only
  // (image/media/TTS/embeddings/research) and must NOT register the chat-brain
  // handlers another provider owns; unset → no host policy (standalone plugin
  // use keeps its historical register-everything behavior). Deleting the var
  // when inference is off (the old behavior) was indistinguishable from "no
  // policy", so the plugin could never load capability-only — the host nuked
  // the API key instead and lost image generation as collateral (#10819).
  if (effectivelyEnabled) {
    process.env.ELIZAOS_CLOUD_USE_INFERENCE = "true";
  } else if (shouldLoadCloudPlugin) {
    process.env.ELIZAOS_CLOUD_USE_INFERENCE = "false";
  } else {
    delete process.env.ELIZAOS_CLOUD_USE_INFERENCE;
  }
  setCloudUsageEnv(
    "ELIZAOS_CLOUD_USE_TTS",
    topology.services.tts || isCloudContainer,
  );
  setCloudUsageEnv("ELIZAOS_CLOUD_USE_MEDIA", topology.services.media);
  // Cloud containers normally use cloud embeddings: the cloud TEXT_EMBEDDING
  // handler (1536-dim) must win over plugin-local-inference's gte-small
  // (384-dim CPU GGUF). Without this, a dedicated cloud agent warms up and
  // serves local 384-dim embeddings while the SQL column is provisioned for the
  // cloud dimension → every memory insert is dropped on a dimension mismatch,
  // and the CPU embedding warmup wastes boot time. The exception is an explicit
  // BYO embedding endpoint plus ELIZAOS_CLOUD_USE_EMBEDDINGS=false: that is an
  // operator-owned override, so preserve it instead of forcing cloud back on.
  const hasByoEmbeddingProvider = hasExplicitEmbeddingProviderConfig(config);
  const cloudEmbeddingsExplicitlyDisabled = isExplicitFalseEnvValue(
    readEffectiveEnvValue(config, "ELIZAOS_CLOUD_USE_EMBEDDINGS"),
  );
  const byoEmbeddingProviderOverridesCloud =
    isCloudContainer &&
    cloudEmbeddingsExplicitlyDisabled &&
    hasByoEmbeddingProvider;
  if (byoEmbeddingProviderOverridesCloud) {
    process.env.ELIZAOS_CLOUD_USE_EMBEDDINGS = "false";
  } else {
    setCloudUsageEnv(
      "ELIZAOS_CLOUD_USE_EMBEDDINGS",
      topology.services.embeddings || isCloudContainer,
    );
  }
  setCloudUsageEnv("ELIZAOS_CLOUD_USE_RPC", topology.services.rpc);

  if (effectivelyEnabled) {
    process.env.ELIZAOS_CLOUD_ENABLED = "true";
  } else {
    delete process.env.ELIZAOS_CLOUD_ENABLED;
  }

  if (shouldLoadCloudPlugin) {
    logger.info(
      `[eliza] Cloud config: inference=${topology.services.inference}, runtime=${topology.runtime}, hasApiKey=${Boolean(cloud?.apiKey || process.env.ELIZAOS_CLOUD_API_KEY)}, apiKey=${cloudApiKeyFingerprint(cloud?.apiKey ?? process.env.ELIZAOS_CLOUD_API_KEY)}, baseUrl=${cloud?.baseUrl ?? "(default)"}, isCloudContainer=${isCloudContainer}`,
    );
    // Only propagate the API key from config when it is a real credential —
    // never set the literal "[REDACTED]" placeholder (which can leak into the
    // config via UI round-trips through the redacted GET → PUT cycle). When
    // config carries no key, an env-provided key is KEPT: this branch means at
    // least one cloud service is selected, and the selected capabilities need
    // the credential. The historical wholesale delete here existed to stop the
    // key from auto-loading @elizaos/plugin-elizacloud and stealing TEXT_LARGE;
    // that is now prevented structurally by ELIZAOS_CLOUD_USE_INFERENCE=false
    // (the plugin skips chat-brain registration), so deleting the key — and
    // losing image/media/TTS with it — is no longer necessary (#10819). Only a
    // leaked placeholder is still scrubbed.
    const isRealApiKey =
      cloud?.apiKey && cloud.apiKey.trim().toUpperCase() !== "[REDACTED]";
    if (isRealApiKey) {
      // #11038: a stale/placeholder vault entry resolved into config here
      // silently CLOBBERS a valid key already in the service env, and the
      // resulting 401s are indistinguishable from a server-side auth outage
      // (env inspection lies — /proc shows the spawn-time value). The config
      // key still wins (by design), but a mismatch against a non-empty env
      // value is loudly fingerprinted so the operator can see which credential
      // is actually on the wire.
      const configKey = (cloud?.apiKey ?? "").trim();
      const envKey = process.env.ELIZAOS_CLOUD_API_KEY?.trim();
      if (envKey && configKey && envKey !== configKey) {
        logger.warn(
          `[eliza] Cloud API key from config (${cloudApiKeyFingerprint(configKey)}) differs from process.env.ELIZAOS_CLOUD_API_KEY (${cloudApiKeyFingerprint(envKey)}) — the config/vault value wins and will OVERRIDE the env key. If cloud calls start returning 401 "Invalid or expired API key", the vault likely holds a stale/placeholder entry (#11038).`,
        );
      }
      process.env.ELIZAOS_CLOUD_API_KEY = cloud.apiKey;
    } else if (
      !isCloudContainer &&
      process.env.ELIZAOS_CLOUD_API_KEY?.trim().toUpperCase() === "[REDACTED]"
    ) {
      delete process.env.ELIZAOS_CLOUD_API_KEY;
    }
    if (cloud?.baseUrl) {
      process.env.ELIZAOS_CLOUD_BASE_URL = cloud.baseUrl;
    } else if (!isCloudContainer) {
      delete process.env.ELIZAOS_CLOUD_BASE_URL;
    }
  } else {
    delete process.env.ELIZAOS_CLOUD_NANO_MODEL;
    delete process.env.ELIZAOS_CLOUD_MEDIUM_MODEL;
    delete process.env.ELIZAOS_CLOUD_SMALL_MODEL;
    delete process.env.ELIZAOS_CLOUD_LARGE_MODEL;
    delete process.env.ELIZAOS_CLOUD_MEGA_MODEL;
    delete process.env.ELIZAOS_CLOUD_RESPONSE_HANDLER_MODEL;
    delete process.env.ELIZAOS_CLOUD_SHOULD_RESPOND_MODEL;
    delete process.env.ELIZAOS_CLOUD_ACTION_PLANNER_MODEL;
    delete process.env.ELIZAOS_CLOUD_PLANNER_MODEL;
    delete process.env.ELIZAOS_CLOUD_API_KEY;
    delete process.env.ELIZAOS_CLOUD_BASE_URL;
  }

  // Propagate model names so the cloud plugin picks them up. Falls back to
  // sensible defaults when cloud is enabled but no explicit selection exists.
  // Skip when inferenceMode is "byok"/"local" or services.inference is off —
  // user's own keys handle models.
  // If the user chose a subscription provider, treat that as "byok" unless
  // they explicitly set inferenceMode to "cloud".
  const llmText = resolveServiceRoutingInConfig(
    config as Record<string, unknown>,
  )?.llmText;
  const models = (config as Record<string, unknown>).models as
    | {
        nano?: string;
        small?: string;
        medium?: string;
        large?: string;
        mega?: string;
      }
    | undefined;
  if (effectivelyEnabled) {
    const nano =
      llmText?.nanoModel ||
      models?.nano ||
      readEffectiveEnvValue(config, "ELIZAOS_CLOUD_NANO_MODEL") ||
      DEFAULT_ELIZA_CLOUD_TEXT_MODEL;
    const small =
      llmText?.smallModel ||
      models?.small ||
      readEffectiveEnvValue(config, "ELIZAOS_CLOUD_SMALL_MODEL") ||
      DEFAULT_ELIZA_CLOUD_TEXT_MODEL;
    const medium =
      llmText?.mediumModel ||
      models?.medium ||
      readEffectiveEnvValue(config, "ELIZAOS_CLOUD_MEDIUM_MODEL") ||
      small;
    const large =
      llmText?.largeModel ||
      models?.large ||
      readEffectiveEnvValue(config, "ELIZAOS_CLOUD_LARGE_MODEL") ||
      DEFAULT_ELIZA_CLOUD_TEXT_MODEL;
    const mega =
      llmText?.megaModel ||
      models?.mega ||
      readEffectiveEnvValue(config, "ELIZAOS_CLOUD_MEGA_MODEL") ||
      large;
    const responseHandlerModel =
      llmText?.responseHandlerModel ||
      llmText?.shouldRespondModel ||
      readEffectiveEnvValue(config, "ELIZAOS_CLOUD_RESPONSE_HANDLER_MODEL") ||
      readEffectiveEnvValue(config, "ELIZAOS_CLOUD_SHOULD_RESPOND_MODEL");
    const actionPlannerModel =
      llmText?.actionPlannerModel ||
      llmText?.plannerModel ||
      readEffectiveEnvValue(config, "ELIZAOS_CLOUD_ACTION_PLANNER_MODEL") ||
      readEffectiveEnvValue(config, "ELIZAOS_CLOUD_PLANNER_MODEL");
    process.env.SMALL_MODEL = small;
    process.env.NANO_MODEL = nano;
    process.env.MEDIUM_MODEL = medium;
    process.env.LARGE_MODEL = large;
    process.env.MEGA_MODEL = mega;
    if (responseHandlerModel) {
      process.env.ELIZAOS_CLOUD_RESPONSE_HANDLER_MODEL = responseHandlerModel;
      process.env.ELIZAOS_CLOUD_SHOULD_RESPOND_MODEL = responseHandlerModel;
    } else {
      delete process.env.ELIZAOS_CLOUD_RESPONSE_HANDLER_MODEL;
      delete process.env.ELIZAOS_CLOUD_SHOULD_RESPOND_MODEL;
    }
    if (actionPlannerModel) {
      process.env.ELIZAOS_CLOUD_ACTION_PLANNER_MODEL = actionPlannerModel;
      process.env.ELIZAOS_CLOUD_PLANNER_MODEL = actionPlannerModel;
    } else {
      delete process.env.ELIZAOS_CLOUD_ACTION_PLANNER_MODEL;
      delete process.env.ELIZAOS_CLOUD_PLANNER_MODEL;
    }
    process.env.ELIZAOS_CLOUD_NANO_MODEL = nano;
    process.env.ELIZAOS_CLOUD_MEDIUM_MODEL = medium;
    process.env.ELIZAOS_CLOUD_SMALL_MODEL = small;
    process.env.ELIZAOS_CLOUD_LARGE_MODEL = large;
    process.env.ELIZAOS_CLOUD_MEGA_MODEL = mega;
  } else if (shouldLoadCloudPlugin) {
    // Cloud plugin may still be active for non-inference services; keep model
    // routing local by clearing the cloud model aliases.
    delete process.env.ELIZAOS_CLOUD_NANO_MODEL;
    delete process.env.ELIZAOS_CLOUD_MEDIUM_MODEL;
    delete process.env.ELIZAOS_CLOUD_SMALL_MODEL;
    delete process.env.ELIZAOS_CLOUD_LARGE_MODEL;
    delete process.env.ELIZAOS_CLOUD_MEGA_MODEL;
    delete process.env.ELIZAOS_CLOUD_RESPONSE_HANDLER_MODEL;
    delete process.env.ELIZAOS_CLOUD_SHOULD_RESPOND_MODEL;
    delete process.env.ELIZAOS_CLOUD_ACTION_PLANNER_MODEL;
    delete process.env.ELIZAOS_CLOUD_PLANNER_MODEL;
    delete process.env.NANO_MODEL;
    delete process.env.MEDIUM_MODEL;
    delete process.env.SMALL_MODEL;
    delete process.env.LARGE_MODEL;
    delete process.env.MEGA_MODEL;
  }

  // Propagate per-service disable flags so downstream code can check them
  // without needing direct access to the ElizaConfig object.
  if (!topology.services.tts) {
    process.env.ELIZA_CLOUD_TTS_DISABLED = "true";
  } else {
    delete process.env.ELIZA_CLOUD_TTS_DISABLED;
  }
  if (!topology.services.media) {
    process.env.ELIZA_CLOUD_MEDIA_DISABLED = "true";
  } else {
    delete process.env.ELIZA_CLOUD_MEDIA_DISABLED;
  }
  if (!topology.services.embeddings && !isCloudContainer) {
    process.env.ELIZA_CLOUD_EMBEDDINGS_DISABLED = "true";
  } else {
    delete process.env.ELIZA_CLOUD_EMBEDDINGS_DISABLED;
  }
  if (!topology.services.rpc) {
    process.env.ELIZA_CLOUD_RPC_DISABLED = "true";
  } else {
    delete process.env.ELIZA_CLOUD_RPC_DISABLED;
  }
}

/**
 * Translate `config.database` into the environment variables that
 * `@elizaos/plugin-sql` reads at init time (`POSTGRES_URL`, `PGLITE_DATA_DIR`).
 *
 * When the provider is "postgres", we build a connection string from the
 * credentials (or use the explicit `connectionString` field) and set
 * `POSTGRES_URL`. When the provider is "pglite" (the default), we set
 * `PGLITE_DATA_DIR` to either the configured value or the resolved default
 * workspace (`<workspace>/.elizadb`) and remove any stale
 * `POSTGRES_URL`.
 */
/** @internal Exported for testing. */
export function applyX402ConfigToEnv(config: ElizaConfig): void {
  const x402 = (config as Record<string, unknown>).x402 as
    | { enabled?: boolean; apiKey?: string; baseUrl?: string }
    | undefined;
  if (!x402?.enabled) return;
  if (!process.env.X402_ENABLED) process.env.X402_ENABLED = "true";
  if (x402.apiKey && !process.env.X402_API_KEY)
    process.env.X402_API_KEY = x402.apiKey;
  if (x402.baseUrl && !process.env.X402_BASE_URL)
    process.env.X402_BASE_URL = x402.baseUrl;
}

function resolveDefaultPgliteDataDir(config: ElizaConfig): string {
  const workspaceDir =
    config.agents?.defaults?.workspace ?? resolveDefaultAgentWorkspaceDir();
  return path.join(resolveUserPath(workspaceDir), ".elizadb");
}

/**
 * The effective database provider. An explicit `config.database.provider` wins;
 * otherwise a POSTGRES_URL/DATABASE_URL present in the environment means
 * Postgres. Without this, the provider defaulted to "pglite" whenever the
 * loaded config lacked an explicit provider — even when Postgres was wired via
 * env — so the WebAssembly PGlite build was attempted and aborted on runtimes
 * that have no WASM (e.g. the riscv64 image, which provisions native Postgres).
 * Keeping env authoritative makes the env-only Postgres path consistent across
 * applyDatabaseConfigToEnv, resolveActivePgliteDataDir, and the provider log.
 */
function resolveEffectiveDbProvider(
  config: ElizaConfig,
): "postgres" | "pglite" {
  if (config.database?.provider) {
    return config.database.provider === "postgres" ? "postgres" : "pglite";
  }
  if (process.env.POSTGRES_URL?.trim() || process.env.DATABASE_URL?.trim()) {
    return "postgres";
  }
  return "pglite";
}

/** @internal Exported for testing. */
export function applyDatabaseConfigToEnv(config: ElizaConfig): void {
  const db = config.database;
  const provider = resolveEffectiveDbProvider(config);
  const databaseUrl = process.env.DATABASE_URL?.trim();
  const postgresUrl = process.env.POSTGRES_URL?.trim();

  if (provider === "postgres") {
    const pg = db?.postgres;
    let url = pg?.connectionString ?? postgresUrl ?? databaseUrl;
    if (!url && pg) {
      const host = pg.host ?? "localhost";
      const port = pg.port ?? 5432;
      const user = encodeURIComponent(pg.user ?? "postgres");
      const password = pg.password ? encodeURIComponent(pg.password) : "";
      const database = pg.database ?? "postgres";
      const auth = password ? `${user}:${password}` : user;
      const sslParam = pg.ssl ? "?sslmode=verify-full" : "";
      url = `postgresql://${auth}@${host}:${port}/${database}${sslParam}`;
    }
    process.env.POSTGRES_URL = url;
    // Clear PGLite dir so plugin-sql does not fall back to PGLite
    delete process.env.PGLITE_DATA_DIR;
    if (
      !db?.provider &&
      databaseUrl &&
      (!postgresUrl || postgresUrl === databaseUrl)
    ) {
      logger.info("[eliza] DATABASE_URL detected: using Postgres database");
    }
  } else {
    // PGLite mode (default): ensure no leftover POSTGRES_URL and pin
    // PGLite to the workspace path unless overridden by config/env.
    delete process.env.POSTGRES_URL;

    const configuredDataDir = db?.pglite?.dataDir?.trim();
    if (configuredDataDir) {
      process.env.PGLITE_DATA_DIR = resolveUserPath(configuredDataDir);
      // Fall through to directory creation below instead of returning early
    }

    const envDataDir = process.env.PGLITE_DATA_DIR?.trim();
    if (!envDataDir) {
      process.env.PGLITE_DATA_DIR = resolveDefaultPgliteDataDir(config);
    }

    // Ensure the PGlite data directory exists before init so PGlite does
    // not silently fall back to in-memory mode on first run.
    const dataDir = process.env.PGLITE_DATA_DIR;
    if (dataDir) {
      const alreadyExisted = existsSync(dataDir);
      mkdirSync(dataDir, { recursive: true });
      logger.info(
        `[eliza] PGlite data dir: ${dataDir} (${alreadyExisted ? "existed" : "created"})`,
      );

      // Remove stale postmaster.pid left by a crashed process. Without this,
      // PGlite sees the lock and either fails or, with explicit destructive
      // recovery enabled, triggers the resetPgliteDataDir path.
      cleanStalePglitePid(dataDir);
    }
  }
}

type PglitePidFileStatus =
  | "missing"
  | "active"
  | "active-unconfirmed"
  | "cleared-stale"
  | "cleared-malformed"
  | "check-failed";

type PgliteRecoveryAction =
  | "none"
  | "retry-without-reset"
  | "fail-active-lock"
  | "fail-manual-reset";

function reconcilePglitePidFile(dataDir: string): PglitePidFileStatus {
  const pidPath = path.join(dataDir, "postmaster.pid");
  if (!existsSync(pidPath)) return "missing";

  try {
    const content = readFileSync(pidPath, "utf-8");
    const firstLine = content.split("\n")[0]?.trim();
    const pid = parseInt(firstLine, 10);

    if (Number.isNaN(pid) || pid <= 0) {
      // Malformed pid file — remove it
      unlinkSync(pidPath);
      logger.debug(`[eliza] Removed malformed PGlite postmaster.pid`);
      return "cleared-malformed";
    }

    // Check if the process is still alive
    try {
      process.kill(pid, 0); // signal 0 = existence check, doesn't kill
      // Process exists — pid file is NOT stale, leave it alone
      logger.info(
        `[eliza] PGlite postmaster.pid references running process ${pid} — leaving intact`,
      );
      return "active";
    } catch (killErr: unknown) {
      const code = (killErr as NodeJS.ErrnoException).code;
      if (code === "ESRCH") {
        // Process doesn't exist — stale pid file, safe to remove
        unlinkSync(pidPath);
        logger.debug(
          `[eliza] Removed stale PGlite postmaster.pid (process ${pid} not running)`,
        );
        return "cleared-stale";
      } else {
        // EPERM or other — process may be alive under a different user,
        // leave the file alone to avoid data directory corruption
        logger.warn(
          `[eliza] Cannot confirm postmaster.pid staleness (${code}) — leaving intact`,
        );
        return "active-unconfirmed";
      }
    }
  } catch (err) {
    logger.warn(
      `[eliza] Failed to check PGlite postmaster.pid: ${formatError(err)}`,
    );
    return "check-failed";
  }
}

/**
 * Check for and remove a stale postmaster.pid in the PGlite data directory.
 * The pid file is stale if the recorded process is no longer running.
 */
export function cleanStalePglitePid(dataDir: string): void {
  try {
    reconcilePglitePidFile(dataDir);
  } catch (err) {
    logger.warn(`[eliza] PGlite PID reconciliation failed: ${err}`);
  }
}

function collectErrorMessages(err: unknown): string[] {
  const messages: string[] = [];
  const seen = new Set<unknown>();
  let current: unknown = err;

  while (current && !seen.has(current)) {
    seen.add(current);

    if (typeof current === "string") {
      messages.push(current);
      break;
    }

    if (current instanceof Error) {
      if (current.message) messages.push(current.message);
      if (current.stack) messages.push(current.stack);
      current = (current as Error & { cause?: unknown }).cause;
      continue;
    }

    if (typeof current === "object") {
      const maybeErr = current as { message?: unknown; cause?: unknown };
      if (typeof maybeErr.message === "string" && maybeErr.message) {
        messages.push(maybeErr.message);
      }
      if (maybeErr.cause !== undefined) {
        current = maybeErr.cause;
        continue;
      }
    }

    break;
  }

  return messages;
}

function isPgliteLockError(err: unknown): boolean {
  const haystack = collectErrorMessages(err).join("\n").toLowerCase();
  if (!haystack) return false;

  const hasPglite = haystack.includes("pglite");
  const hasSqlite = haystack.includes("sqlite");
  const hasLockSignal =
    haystack.includes("database is locked") ||
    haystack.includes("lock file already exists");

  return hasLockSignal && (hasPglite || hasSqlite);
}

/** @internal Exported for testing. */
export function isRecoverablePgliteInitError(err: unknown): boolean {
  const code = getPgliteErrorCode(err);
  if (
    code === PGLITE_ERROR_CODES.ACTIVE_LOCK ||
    code === PGLITE_ERROR_CODES.CORRUPT_DATA ||
    code === PGLITE_ERROR_CODES.MANUAL_RESET_REQUIRED
  ) {
    return true;
  }

  const haystack = collectErrorMessages(err).join("\n").toLowerCase();
  if (!haystack) return false;

  const hasAbort = haystack.includes("aborted(). build with -sassertions");
  const hasPglite = haystack.includes("pglite");
  const _hasSqlite = haystack.includes("sqlite");
  const hasMigrationsSchema =
    haystack.includes("create schema if not exists migrations") ||
    haystack.includes("failed query: create schema if not exists migrations");
  const hasRecoverableStorageSignal = [
    "database disk image is malformed",
    "file is not a database",
    "malformed database schema",
    "database is locked",
    "lock file already exists",
    "wal file",
    "checkpoint failed",
    "checksum mismatch",
    "corrupt",
    "could not read blocks",
    "read only ",
    "unreachable code should not be executed",
    "_pgl_backend",
  ].some((needle) => haystack.includes(needle));

  if (hasMigrationsSchema) return true;
  if (hasAbort && hasPglite) return true;
  if (hasRecoverableStorageSignal) return true;
  return false;
}

/** @internal Exported for testing. */
export function getPgliteRecoveryAction(
  err: unknown,
  dataDir: string,
): PgliteRecoveryAction {
  const code = getPgliteErrorCode(err);
  if (code === PGLITE_ERROR_CODES.ACTIVE_LOCK) {
    return "fail-active-lock";
  }
  if (
    code === PGLITE_ERROR_CODES.CORRUPT_DATA ||
    code === PGLITE_ERROR_CODES.MANUAL_RESET_REQUIRED
  ) {
    return "fail-manual-reset";
  }

  if (!isRecoverablePgliteInitError(err)) return "none";

  const pidStatus = reconcilePglitePidFile(dataDir);
  const treatPidAsActiveLock =
    code === PGLITE_ERROR_CODES.ACTIVE_LOCK || isPgliteLockError(err);
  if (
    (treatPidAsActiveLock && pidStatus === "active") ||
    (treatPidAsActiveLock && pidStatus === "active-unconfirmed") ||
    (treatPidAsActiveLock && pidStatus === "check-failed")
  ) {
    return "fail-active-lock";
  }
  if (pidStatus === "cleared-stale" || pidStatus === "cleared-malformed") {
    return "retry-without-reset";
  }
  return "fail-manual-reset";
}

function createActivePgliteLockError(dataDir: string, err: unknown): Error {
  if (
    getPgliteErrorCode(err) === PGLITE_ERROR_CODES.ACTIVE_LOCK &&
    err instanceof Error
  ) {
    return err;
  }
  return createPgliteInitError(
    PGLITE_ERROR_CODES.ACTIVE_LOCK,
    `PGLite data dir is already in use at ${dataDir}. Close the other Eliza or Eliza process, or set a different PGLITE_DATA_DIR before retrying.`,
    { cause: err, dataDir },
  );
}

function formatPgliteFailure(err: unknown): string {
  return collectErrorMessages(err)[0] ?? formatError(err);
}

function createManualResetRequiredPgliteError(
  dataDir: string,
  err: unknown,
): Error {
  if (
    getPgliteErrorCode(err) === PGLITE_ERROR_CODES.MANUAL_RESET_REQUIRED &&
    err instanceof Error
  ) {
    return err;
  }

  const errorText = formatPgliteFailure(err);
  const cause =
    getPgliteErrorCode(err) === PGLITE_ERROR_CODES.CORRUPT_DATA
      ? err
      : createPgliteInitError(
          PGLITE_ERROR_CODES.CORRUPT_DATA,
          `PGlite data dir at ${dataDir} appears corrupt or unreadable: ${errorText}`,
          { cause: err, dataDir },
        );

  return createPgliteInitError(
    PGLITE_ERROR_CODES.MANUAL_RESET_REQUIRED,
    `PGlite initialization failed for ${dataDir}: ${errorText}. Stop Eliza, then rename or delete only this directory before retrying: ${dataDir}`,
    { cause, dataDir },
  );
}

export function isFatalPgliteStartupError(err: unknown): boolean {
  const code = getPgliteErrorCode(err);
  return (
    code === PGLITE_ERROR_CODES.ACTIVE_LOCK ||
    code === PGLITE_ERROR_CODES.CORRUPT_DATA ||
    code === PGLITE_ERROR_CODES.MANUAL_RESET_REQUIRED
  );
}

function resolveActivePgliteDataDir(config: ElizaConfig): string | null {
  const provider = resolveEffectiveDbProvider(config);
  if (provider === "postgres") return null;

  const configured = process.env.PGLITE_DATA_DIR?.trim();
  const dataDir = configured || resolveDefaultPgliteDataDir(config);
  return resolveUserPath(dataDir);
}

/** Call whichever init method the adapter exposes (.init or .initialize). */
async function callAdapterInit(
  adapter: AgentRuntime["adapter"],
): Promise<void> {
  const fn =
    "init" in adapter &&
    typeof (adapter as Record<string, unknown>).init === "function"
      ? ((adapter as Record<string, unknown>).init as () => Promise<void>)
      : adapter.initialize;
  if (typeof fn === "function") await fn.call(adapter);
}

async function initializeDatabaseAdapter(
  runtime: AgentRuntime,
  config: ElizaConfig,
): Promise<void> {
  if (!runtime.adapter || (await runtime.adapter.isReady())) return;

  try {
    await callAdapterInit(runtime.adapter);
    logger.info(
      "[eliza] Database adapter initialized early (before plugin inits)",
    );
  } catch (err) {
    const pgliteDataDir = resolveActivePgliteDataDir(config);
    if (!pgliteDataDir) {
      throw err;
    }

    const recoveryAction = getPgliteRecoveryAction(err, pgliteDataDir);
    if (recoveryAction === "none") {
      throw err;
    }
    if (recoveryAction === "fail-active-lock") {
      throw createActivePgliteLockError(pgliteDataDir, err);
    }
    if (recoveryAction === "fail-manual-reset") {
      throw createManualResetRequiredPgliteError(pgliteDataDir, err);
    }

    logger.warn(
      `[eliza] PGLite init failed (${formatError(err)}). Cleared a stale PGLite lock in ${pgliteDataDir} and retrying without resetting data.`,
    );

    await callAdapterInit(runtime.adapter);
    logger.info(
      "[eliza] Database adapter recovered after clearing a stale PGLite lock",
    );
  }

  // Health check: verify PGlite data directory has files after init.
  // Runs on BOTH the happy path and the recovery path.
  await verifyPgliteDataDir(config);
}

/**
 * Verify PGlite data directory contains files after init.
 * Warns if the directory is empty (suggests ephemeral/in-memory fallback).
 */
async function verifyPgliteDataDir(config: ElizaConfig): Promise<void> {
  const pgliteDataDir = resolveActivePgliteDataDir(config);
  if (!pgliteDataDir || !existsSync(pgliteDataDir)) return;

  try {
    const files = await fs.readdir(pgliteDataDir);
    logger.info(
      `[eliza] PGlite health check: ${files.length} file(s) in ${pgliteDataDir}`,
    );
    if (files.length === 0) {
      logger.warn(
        `[eliza] PGlite data directory is empty after init — data may not persist across restarts`,
      );
    }
  } catch (err) {
    logger.warn(`[eliza] PGlite health check failed: ${formatError(err)}`);
  }
}

function isPluginAlreadyRegisteredError(err: unknown): boolean {
  return formatError(err).toLowerCase().includes("already registered");
}

interface RuntimeWithMethodBindings extends AgentRuntime {
  __elizaMethodBindingsInstalled?: boolean;
  __elizaComponentWriteDiagnosticsInstalled?: boolean;
  __elizaEntityWriteDiagnosticsInstalled?: boolean;
  __elizaProviderRoleGatingInstalled?: boolean;
  __elizaEntityCreateMutex?: Promise<void>;
}

type CreateEntitiesFn = (entities: Entity[]) => Promise<UUID[] | boolean>;
type GetEntitiesByIdsFn = (entityIds: UUID[]) => Promise<Entity[]>;
type EnsureEntityExistsFn = (entity: Entity) => Promise<boolean>;
type RuntimeWithEntityWrites = AgentRuntime & {
  createEntities?: CreateEntitiesFn;
  getEntitiesByIds?: GetEntitiesByIdsFn;
  ensureEntityExists?: EnsureEntityExistsFn;
};

type DbErrorLike = {
  name?: unknown;
  message?: unknown;
  code?: unknown;
  detail?: unknown;
  hint?: unknown;
  constraint?: unknown;
  schema?: unknown;
  table?: unknown;
  column?: unknown;
  where?: unknown;
  cause?: unknown;
};

function getConstraintName(error: unknown): string | null {
  if (!error || typeof error !== "object") return null;
  const err = error as DbErrorLike;
  if (typeof err.constraint === "string" && err.constraint.length > 0) {
    return err.constraint;
  }
  if (err.cause) return getConstraintName(err.cause);
  return null;
}

function isComponentsWorldFkViolation(error: unknown): boolean {
  return getConstraintName(error) === "components_world_id_worlds_id_fk";
}

function toErrorDetails(error: unknown, depth = 0): Record<string, unknown> {
  if (!error || typeof error !== "object") {
    return { value: String(error) };
  }
  const err = error as DbErrorLike;
  const details: Record<string, unknown> = {};
  for (const key of [
    "name",
    "message",
    "code",
    "detail",
    "hint",
    "constraint",
    "schema",
    "table",
    "column",
    "where",
  ] as const) {
    const value = err[key];
    if (typeof value === "string" || typeof value === "number") {
      details[key] = value;
    }
  }
  if (depth < 2 && err.cause) {
    details.cause = toErrorDetails(err.cause, depth + 1);
  }
  return details;
}

async function withEntityCreateMutex<T>(
  runtimeWithBindings: RuntimeWithMethodBindings,
  fn: () => Promise<T>,
): Promise<T> {
  const previous = runtimeWithBindings.__elizaEntityCreateMutex;
  let release: () => void = () => {};
  runtimeWithBindings.__elizaEntityCreateMutex = new Promise<void>(
    (resolve) => {
      release = resolve;
    },
  );
  if (previous) {
    await previous;
  }
  try {
    return await fn();
  } finally {
    release();
  }
}

function uniqueEntitiesById(entities: Entity[]): Entity[] {
  const uniqueById = new Map<UUID, Entity>();
  for (const entity of entities) {
    if (entity?.id) uniqueById.set(entity.id as UUID, entity);
  }
  return Array.from(uniqueById.values());
}

async function findMissingEntities(
  runtimeWithEntityWrites: RuntimeWithEntityWrites,
  deduped: Entity[],
): Promise<Entity[]> {
  if (typeof runtimeWithEntityWrites.getEntitiesByIds !== "function") {
    return deduped;
  }
  try {
    const existing =
      (await runtimeWithEntityWrites.getEntitiesByIds(
        deduped.map((entity) => entity.id as UUID),
      )) ?? [];
    const existingIds = new Set<UUID>();
    for (const entity of existing) {
      if (entity?.id) existingIds.add(entity.id as UUID);
    }
    return deduped.filter((entity) => !existingIds.has(entity.id as UUID));
  } catch (err) {
    logger.warn(
      `[eliza] createEntities precheck failed; proceeding with guarded insert: ${formatError(err)}`,
    );
    return deduped;
  }
}

async function recoverMissingEntities(
  runtimeWithEntityWrites: RuntimeWithEntityWrites,
  missing: Entity[],
): Promise<boolean> {
  if (typeof runtimeWithEntityWrites.ensureEntityExists !== "function") {
    return false;
  }
  let allRecovered = true;
  for (const entity of missing) {
    try {
      const ensured = await runtimeWithEntityWrites.ensureEntityExists(entity);
      allRecovered = allRecovered && ensured;
    } catch (err) {
      allRecovered = false;
      logger.warn(
        `[eliza] ensureEntityExists recovery failed for ${String(entity.id)}: ${formatError(err)}`,
      );
    }
  }
  return allRecovered;
}

async function createEntitiesWithGuard(args: {
  entities: Entity[];
  runtimeWithEntityWrites: RuntimeWithEntityWrites;
  originalCreateEntities: CreateEntitiesFn;
}): Promise<UUID[]> {
  const deduped = uniqueEntitiesById(args.entities);
  const dedupedIds = deduped.map((entity) => entity.id as UUID);
  if (deduped.length === 0) return dedupedIds;

  const missing = await findMissingEntities(
    args.runtimeWithEntityWrites,
    deduped,
  );
  if (missing.length === 0) return dedupedIds;

  const result = await args.originalCreateEntities(missing);
  if (Array.isArray(result) ? result.length > 0 : result) return dedupedIds;

  if (await recoverMissingEntities(args.runtimeWithEntityWrites, missing)) {
    return dedupedIds;
  }

  logger.warn(
    `[eliza] createEntities unresolved after guarded retries (requested=${args.entities.length}, deduped=${deduped.length}, missing=${missing.length})`,
  );
  return [];
}

function summarizeComponentWrite(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { inputType: typeof input };
  }
  const record = input as Record<string, unknown>;
  const data = record.data;
  const dataKeys =
    data && typeof data === "object" && !Array.isArray(data)
      ? Object.keys(data as Record<string, unknown>).slice(0, 20)
      : [];

  return {
    id: record.id,
    type: record.type,
    entityId: record.entityId ?? record.entity_id,
    sourceEntityId: record.sourceEntityId ?? record.source_entity_id,
    roomId: record.roomId ?? record.room_id,
    worldId: record.worldId ?? record.world_id,
    agentId: record.agentId ?? record.agent_id,
    dataKeys,
  };
}

export function installRuntimeMethodBindings(runtime: AgentRuntime): void {
  const runtimeWithBindings = runtime as RuntimeWithMethodBindings;
  if (runtimeWithBindings.__elizaMethodBindingsInstalled) {
    return;
  }

  installRuntimePluginLifecycle(runtime);

  // Some plugin builds store this method and invoke it later without the
  // runtime receiver, which breaks private-field access in AgentRuntime.
  runtime.getConversationLength = runtime.getConversationLength.bind(runtime);

  // Wrap getSetting() to fall back to process.env for known keys when the
  // core returns null. elizaOS core returns null for missing keys, but some
  // plugins (e.g. @elizaos/plugin-google-genai) check `!== undefined` and
  // convert null to the string "null", causing API calls like `models/null`.
  // Scoped to an allowlist to avoid leaking arbitrary env vars to plugins.
  const GETSETTING_ENV_ALLOWLIST = new Set([
    // Model provider API keys
    "ANTHROPIC_API_KEY",
    "OPENAI_API_KEY",
    "GOOGLE_GENERATIVE_AI_API_KEY",
    "GOOGLE_API_KEY",
    "GEMINI_API_KEY",
    "GROQ_API_KEY",
    "XAI_API_KEY",
    "DEEPSEEK_API_KEY",
    "ZAI_API_KEY",
    "Z_AI_API_KEY",
    "MOONSHOT_API_KEY",
    "KIMI_API_KEY",
    "OPENAI_BASE_URL",
    "OPENROUTER_API_KEY",
    // Database adapter settings. plugin-sql reads these through
    // runtime.getSetting(), while appliance images may provide them only as
    // systemd environment variables.
    "POSTGRES_URL",
    "DATABASE_URL",
    "PGLITE_DATA_DIR",
    // Google model defaults
    "GOOGLE_SMALL_MODEL",
    "GOOGLE_LARGE_MODEL",
    // GitHub
    "GITHUB_TOKEN",
    "GITHUB_OAUTH_CLIENT_ID",
    // Coding agent model preferences
    "ELIZA_CLAUDE_MODEL_POWERFUL",
    "ELIZA_CLAUDE_MODEL_FAST",
    "ELIZA_GEMINI_MODEL_POWERFUL",
    "ELIZA_GEMINI_MODEL_FAST",
    "ELIZA_CODEX_MODEL_POWERFUL",
    "ELIZA_CODEX_MODEL_FAST",
    "ELIZA_AIDER_PROVIDER",
    "ELIZA_AIDER_MODEL_POWERFUL",
    "ELIZA_AIDER_MODEL_FAST",
    // AOSP/local coding-tool policy and shell runtime controls.
    "CODING_TOOLS_WORKSPACE_ROOTS",
    "CODING_TOOLS_BLOCKED_PATHS",
    "CODING_TOOLS_BLOCKED_PATHS_ADD",
    "CODING_TOOLS_SHELL",
    "SHELL_ALLOWED_DIRECTORY",
    "ELIZA_RUNTIME_MODE",
    // Custom credential forwarding — intentionally broad: users configure which env vars
    // to forward to coding agents via this comma-separated key list (e.g. MCP server tokens).
    "CUSTOM_CREDENTIAL_KEYS",
  ]);
  const originalGetSetting = runtime.getSetting.bind(runtime);
  runtime.getSetting = (key: string) => {
    const result = originalGetSetting(key);
    if (result !== null && result !== undefined) return result;
    if (GETSETTING_ENV_ALLOWLIST.has(key)) {
      const envVal = process.env[key];
      if (envVal !== undefined && envVal.trim() !== "") return envVal;
    }
    return result;
  };

  // Add targeted diagnostics around component writes. Relationships reflection and
  // relationship extraction rely heavily on components; when inserts fail,
  // upstream logs often hide the concrete DB cause/constraint.
  if (!runtimeWithBindings.__elizaComponentWriteDiagnosticsInstalled) {
    type CreateComponentFn = (component: Component) => Promise<boolean>;
    type UpdateComponentFn = (component: Component) => Promise<void>;
    const runtimeWithComponentWrites = runtime as AgentRuntime & {
      createComponent?: CreateComponentFn;
      updateComponent?: UpdateComponentFn;
    };

    if (typeof runtimeWithComponentWrites.createComponent === "function") {
      const originalCreate =
        runtimeWithComponentWrites.createComponent.bind(runtime);
      runtimeWithComponentWrites.createComponent = async (input: Component) => {
        try {
          return await originalCreate(input);
        } catch (error) {
          // Recovery path: some evaluators (e.g. relationship extraction)
          // compute a synthetic worldId that may not exist yet. If we hit the
          // components->worlds FK, retry once with the room's canonical worldId.
          if (
            isComponentsWorldFkViolation(error) &&
            input.roomId &&
            typeof runtime.getRoom === "function"
          ) {
            try {
              const room = await runtime.getRoom(input.roomId);
              const fallbackWorldId = room?.worldId ?? null;
              if (fallbackWorldId !== input.worldId) {
                logger.warn(
                  `[eliza] createComponent retry with ${fallbackWorldId ? `room worldId (${fallbackWorldId})` : "null worldId"} after FK violation`,
                );
                const recovered: Component = {
                  ...input,
                  worldId: fallbackWorldId,
                } as Component;
                return await originalCreate(recovered);
              }
            } catch (retryLookupError) {
              logger.warn(
                `[eliza] createComponent recovery lookup failed: ${formatError(retryLookupError)}`,
              );
            }
          }

          const component = summarizeComponentWrite(input);
          logger.error(
            `[eliza] createComponent failed: ${formatError(error)} | component=${JSON.stringify(component)}`,
          );
          logger.error(
            `[eliza] createComponent db details: ${JSON.stringify(toErrorDetails(error))}`,
          );
          throw error;
        }
      };
    }

    if (typeof runtimeWithComponentWrites.updateComponent === "function") {
      const originalUpdate =
        runtimeWithComponentWrites.updateComponent.bind(runtime);
      runtimeWithComponentWrites.updateComponent = async (input: Component) => {
        try {
          return await originalUpdate(input);
        } catch (error) {
          const component = summarizeComponentWrite(input);
          logger.error(
            `[eliza] updateComponent failed: ${formatError(error)} | component=${JSON.stringify(component)}`,
          );
          logger.error(
            `[eliza] updateComponent db details: ${JSON.stringify(toErrorDetails(error))}`,
          );
          throw error;
        }
      };
    }

    runtimeWithBindings.__elizaComponentWriteDiagnosticsInstalled = true;
  }

  // Proactive guard for plugin-sql entity creation. Some evaluators may attempt
  // to create the same entity in rapid succession; plugin-sql's batch insert is
  // non-idempotent and can fail entire writes on duplicate/conflicting rows.
  if (!runtimeWithBindings.__elizaEntityWriteDiagnosticsInstalled) {
    const runtimeWithEntityWrites = runtime as RuntimeWithEntityWrites;

    if (typeof runtimeWithEntityWrites.createEntities === "function") {
      const originalCreateEntities =
        runtimeWithEntityWrites.createEntities.bind(runtime);
      runtimeWithEntityWrites.createEntities = async (entities: Entity[]) => {
        return withEntityCreateMutex(runtimeWithBindings, () =>
          createEntitiesWithGuard({
            entities,
            runtimeWithEntityWrites,
            originalCreateEntities,
          }),
        );
      };
    }

    runtimeWithBindings.__elizaEntityWriteDiagnosticsInstalled = true;
  }

  // Provider role-gating chokepoint. EVERY plugin registration flows through
  // runtime.registerPlugin — boot constructor plugins (core calls
  // this.registerPlugin for each during initialize()), the deferred core-plugin
  // waves, and post-boot hot-installs via the runtime API
  // (packages/agent/src/api/plugin-runtime-apply.ts). Gating previously ran only
  // as a one-shot boot pass, so hot-installed wallet/secrets plugins escaped
  // redaction and leaked owner/admin-tier context to any sender. Wrapping
  // registerPlugin gates sensitive providers at registration time, identically
  // on every path, on both the boot and hot-reload runtimes. Installed here
  // (before runtime.initialize()) so constructor plugins pass through it too.
  installProviderRoleGatingChokepoint(runtimeWithBindings);

  runtimeWithBindings.__elizaMethodBindingsInstalled = true;
}

async function registerSqlPluginWithRecovery(
  runtime: AgentRuntime,
  sqlPlugin: RuntimeResolvedPlugin,
  config: ElizaConfig,
): Promise<void> {
  let registerError: unknown = null;

  try {
    await runtime.registerPlugin(sqlPlugin.plugin);
  } catch (err) {
    registerError = err;
  }

  if (registerError) {
    const pgliteDataDir = resolveActivePgliteDataDir(config);
    if (!pgliteDataDir) {
      throw registerError;
    }

    const recoveryAction = getPgliteRecoveryAction(
      registerError,
      pgliteDataDir,
    );
    if (recoveryAction === "none") {
      throw registerError;
    }
    if (recoveryAction === "fail-active-lock") {
      throw createActivePgliteLockError(pgliteDataDir, registerError);
    }
    if (recoveryAction === "fail-manual-reset") {
      throw createManualResetRequiredPgliteError(pgliteDataDir, registerError);
    }

    logger.warn(
      `[eliza] SQL plugin registration failed (${formatError(registerError)}). Cleared a stale PGLite lock in ${pgliteDataDir} and retrying without resetting data.`,
    );

    try {
      await runtime.registerPlugin(sqlPlugin.plugin);
    } catch (retryErr) {
      if (!isPluginAlreadyRegisteredError(retryErr)) {
        throw retryErr;
      }
    }
  }

  await initializeDatabaseAdapter(runtime, config);
}

const CORE_PLUGIN_BOOT_DEPENDENCIES = new Map<string, readonly string[]>([
  ["@elizaos/plugin-coding-tools", ["@elizaos/plugin-shell"]],
  ["@elizaos/plugin-agent-skills", ["@elizaos/plugin-shell"]],
]);

async function preregisterCorePluginsInDependencyWaves(args: {
  runtime: AgentRuntime;
  resolvedPlugins: RuntimeResolvedPlugin[];
  alreadyPreRegistered: Set<string>;
  label?: string;
}): Promise<void> {
  const pending = new Map<string, RuntimeResolvedPlugin>();
  for (const name of CORE_PLUGINS) {
    if (args.alreadyPreRegistered.has(name)) continue;
    const resolved = args.resolvedPlugins.find((p) => p.name === name);
    if (!resolved) {
      logger.debug(
        `[eliza] Core plugin ${name} not resolved — skipping pre-registration`,
      );
      continue;
    }
    pending.set(name, resolved);
  }

  const registered = new Set(args.alreadyPreRegistered);
  const timeoutMs = 30_000;
  const context = args.label ? `${args.label}: ` : "";

  const registerOne = async (
    name: string,
    resolved: RuntimeResolvedPlugin,
  ): Promise<void> => {
    try {
      const regStart = Date.now();
      logger.info(`[eliza] ${context}Pre-registering core plugin: ${name}...`);
      await Promise.race([
        args.runtime.registerPlugin(resolved.plugin),
        new Promise<never>((_resolve, reject) =>
          setTimeout(
            () => reject(new Error(`Timed out after ${timeoutMs / 1000}s`)),
            timeoutMs,
          ),
        ),
      ]);
      registered.add(name);
      logger.info(
        `[eliza] ${context}✓ ${name} pre-registered (${Date.now() - regStart}ms)`,
      );
    } catch (err) {
      registered.add(name);
      logger.warn(
        `[eliza] ${context}Core plugin ${name} pre-registration failed: ${formatError(err)}`,
      );
    } finally {
      pending.delete(name);
    }
  };

  while (pending.size > 0) {
    const ready: Array<[string, RuntimeResolvedPlugin]> = [];
    for (const [name, resolved] of pending) {
      const declaredDependencies = resolved.plugin.dependencies ?? [];
      const bootDependencies = CORE_PLUGIN_BOOT_DEPENDENCIES.get(name) ?? [];
      const dependencies = [...declaredDependencies, ...bootDependencies];
      const hasPendingDependency = dependencies.some(
        (dependency) => pending.has(dependency) && !registered.has(dependency),
      );
      if (!hasPendingDependency) {
        ready.push([name, resolved]);
      }
    }

    const wave = ready.length > 0 ? ready : Array.from(pending);
    await Promise.all(
      wave.map(([name, resolved]) => registerOne(name, resolved)),
    );
    // Yield to the event loop between waves so the bound HTTP server can serve
    // /api/health and other I/O between CPU-bound wave registrations, instead
    // of starving it until every wave finishes. Mirrors the deferred
    // static-import yield above; pure scheduling, every plugin still registers
    // in the same wave order.
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
  }
}

export {
  buildCharacterFromConfig,
  resolvePreferredProviderId,
  resolvePreferredProviderPluginName,
  resolvePrimaryModel,
};

/**
 * Vision is a heavy optional plugin. When Eliza enables it, keep the service
 * loaded but idle until the user explicitly selects CAMERA, SCREEN, or BOTH.
 * This avoids background capture loops during normal app startup.
 */
export function resolveVisionModeSetting(
  config: ElizaConfig,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const explicitMode = env.VISION_MODE?.trim();
  if (explicitMode) return explicitMode;
  if (config.features?.vision === true) return "OFF";
  return undefined;
}

/** @internal Exported for testing. */
export function resolveWalletRuntimeSettings(
  config?: Partial<ElizaConfig>,
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const directRpcUrl = trimEnvString(env.SOLANA_RPC_URL);
  const solanaNoActions = trimEnvString(env.SOLANA_NO_ACTIONS);
  const configEnv = config?.env as
    | (Record<string, unknown> & { vars?: Record<string, unknown> })
    | undefined;
  const configVars =
    configEnv?.vars &&
    typeof configEnv.vars === "object" &&
    !Array.isArray(configEnv.vars)
      ? (configEnv.vars as Record<string, unknown>)
      : undefined;
  const getConfigEnvString = (key: string): string | undefined => {
    const value = configVars?.[key] ?? configEnv?.[key];
    return typeof value === "string" && value.trim() ? value.trim() : undefined;
  };
  const explicitSolanaPublicKey =
    trimEnvString(env.SOLANA_PUBLIC_KEY) ??
    trimEnvString(env.WALLET_PUBLIC_KEY) ??
    getConfigEnvString("SOLANA_PUBLIC_KEY") ??
    getConfigEnvString("WALLET_PUBLIC_KEY");
  const derivedSolanaPublicKey =
    trimEnvString(getWalletAddresses().solanaAddress) ??
    trimEnvString(
      syncSolanaPublicKeyEnv(getConfigEnvString("SOLANA_PRIVATE_KEY")),
    );
  const solanaPublicKey = explicitSolanaPublicKey ?? derivedSolanaPublicKey;

  const settings: Record<string, string> = {};

  if (directRpcUrl) {
    settings.SOLANA_RPC_URL = directRpcUrl;
  }

  if (solanaNoActions) {
    settings.SOLANA_NO_ACTIONS = solanaNoActions;
  }

  if (!solanaPublicKey) {
    return settings;
  }

  settings.SOLANA_PUBLIC_KEY = solanaPublicKey;
  settings.WALLET_PUBLIC_KEY = solanaPublicKey;

  return settings;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/** Options accepted by {@link startEliza}. */
export interface StartElizaOptions {
  /**
   * When true, skip the interactive CLI chat loop and return the
   * initialised {@link AgentRuntime} so it can be wired into the API
   * server (used by `dev-server.ts`).
   */
  headless?: boolean;
  /**
   * When true, start the API server and keep running without entering
   * the interactive chat loop. Used by `bun run start` for production
   * server mode (like dev but without watch).
   */
  serverOnly?: boolean;
  /**
   * Internal guard to prevent infinite retry loops when recovering from
   * corrupt PGLite state.
   */
  pgliteRecoveryAttempted?: boolean;
}

export interface BootElizaRuntimeOptions {
  /**
   * When true, require an existing state-dir config file.
   * This is used by non-CLI UIs (like the @elizaos/tui interface) where interactive
   * first-run prompts would break the alternate screen.
   */
  requireConfig?: boolean;
}

/**
 * Boot the elizaOS runtime without starting the readline chat loop.
 *
 * This is a convenience wrapper around {@link startEliza} in headless mode,
 * with optional config guards.
 */
export async function bootElizaRuntime(
  opts: BootElizaRuntimeOptions = {},
): Promise<AgentRuntime> {
  if (opts.requireConfig && !configFileExists()) {
    throw new Error(
      "No config found. Run `eliza start` once to complete setup.",
    );
  }

  const runtime = await startEliza({ headless: true });
  if (!runtime) {
    throw new Error("Failed to boot runtime");
  }
  return runtime;
}

const LEVEL_TO_NAME: Record<number, string> = {
  10: "trace",
  20: "debug",
  27: "success",
  28: "progress",
  29: "log",
  30: "info",
  40: "warn",
  50: "error",
  60: "fatal",
};

type ChatLogEntry = LogEntry & {
  roomId?: string;
  runtime?: AgentRuntime & {
    logLevelOverrides?: Map<string, string>;
  };
};

export const logToChatListener = (entry: LogEntry) => {
  const chatEntry = entry as ChatLogEntry;
  if (chatEntry.roomId && chatEntry.runtime) {
    const runtime = chatEntry.runtime;
    // access dynamic property
    const overrides = runtime.logLevelOverrides;
    const overrideLevel = overrides?.get(String(chatEntry.roomId));

    if (overrideLevel) {
      const levelKey = entry.level as number;
      const levelName = (
        levelKey && LEVEL_TO_NAME[levelKey] ? LEVEL_TO_NAME[levelKey] : "log"
      ).toUpperCase();

      const prefix = `[${levelName}]`;
      const content = `${prefix} ${entry.msg}`;

      // Prevent infinite loops by suppressing logs from this action
      runtime
        .sendMessageToTarget({ roomId: entry.roomId as UUID } as TargetInfo, {
          text: `\`\`\`\n${content}\n\`\`\``,
          source: "system",

          isLog: "true",
        })
        .catch((err: unknown) => {
          logger.debug(
            `[runtime] failed to send log message to target: ${err}`,
          );
        });
    }
  }
};

/**
 * Start the elizaOS runtime with Eliza's configuration.
 *
 * In headless mode the runtime is returned instead of entering the
 * interactive readline loop.
 */
export async function startEliza(
  opts?: StartElizaOptions,
): Promise<AgentRuntime | undefined> {
  const bootTimer = new BootTimer("[eliza-boot]");
  // Record the (re)start at the START of boot so a restart storm — where boots
  // never complete — is still countable via /api/dev/boot-history. void: never
  // delay readiness. recordBootTelemetry below captures the completed-boot case.
  void recordBootEvent("[eliza-boot]");
  // #10203 crash/restart stability: a `boot`-point fault fires here, the
  // earliest awaited seam, so the supervisor restart path can be exercised.
  await maybeInjectFault("boot");

  // Resolve and register baseline `@elizaos/plugin-*` modules into the
  // STATIC_ELIZA_PLUGINS blocking map BEFORE any plugin resolution happens. See the
  // comment on `ensureCoreStaticPluginsRegistered()` for why this isn't a
  // module-init top-level await.
  await ensureCoreStaticPluginsRegistered();
  bootTimer.lap("static-plugins-blocking-import");

  // Start buffering logs early so startup messages appear in the UI log viewer
  const { captureEarlyLogs } = await import("../api/early-logs.ts");
  captureEarlyLogs();

  // Register log listener for chat mirroring
  addLogListener(logToChatListener);

  // 1. Load Eliza config from the resolved state dir.
  let config: ElizaConfig;
  try {
    config = loadElizaConfig();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      logger.warn("[eliza] No config found, using defaults");
      // All ElizaConfig fields are optional, so an empty object is
      // structurally valid. The `as` cast is safe here.
      config = {} as ElizaConfig;
    } else {
      throw err;
    }
  }

  // 1b. First-run setup — ask for agent name if not configured.
  //     In headless mode (GUI) the first-run setup is handled by the web UI,
  //     so we skip the interactive CLI prompt and let the runtime start
  //     with defaults.  The GUI will restart the agent after first-run setup.
  if (!opts?.headless) {
    config = await runFirstTimeSetup(config);
  }

  // 1c. Apply logging level from config to process.env so the global
  //     @elizaos/core logger (used by plugins) respects it.
  //     config.logging.level is guaranteed to be set (defaults to "error").
  //     Users can still opt into noisy logs via config.logging.level or
  //     an explicit LOG_LEVEL environment variable.
  if (!process.env.LOG_LEVEL) {
    process.env.LOG_LEVEL = config.logging?.level ?? "error";
  }

  // 2. Push channel secrets into process.env for plugin discovery
  applyConnectorSecretsToEnv(config);
  // Cloud sandbox (Path A / double-connect): in a provisioned container that
  // does NOT own its connectors, strip the connector bot tokens so the
  // container does not also connect to Discord/Telegram while the gateway
  // holds the connection. MUST run AFTER applyConnectorSecretsToEnv (which can
  // repopulate the tokens from config.connectors) and BEFORE plugin
  // auto-enable / resolvePlugins below. Also clears the matching config
  // connector blocks so nothing downstream re-derives the token. Skipped
  // outside a provisioned container or when ELIZA_SANDBOX_OWNS_CONNECTORS=1.
  {
    const { applySandboxConnectorOwnership } = await import(
      "./sandbox-character.ts"
    );
    applySandboxConnectorOwnership(process.env, config);
  }
  ensureProvisionedCloudContainerConfig(config);
  // 2b. Propagate cloud config into process.env before boot prefetches. A
  // provisioned container may start with only ELIZA_CLOUD_PROVISIONED in the
  // real env and cloud credentials in config.env.
  applyCloudConfigToEnv(config);

  // Kick off the Discord App ID lookup and the cloud GitHub token fetch (both
  // network, up to a 3s timeout each) without blocking. They only write
  // DISCORD_APPLICATION_ID and GITHUB_TOKEN respectively — env vars that no
  // BLOCKING_CORE_PLUGIN reads. The Discord connector and GitHub/git plugins
  // both live in the DEFERRED set, so these joins are awaited inside
  // runDeferredBoot() (before the deferred plugin waves register), not on the
  // gated blocking path. Firing them here lets the round-trips overlap the
  // vault hydration + setup work below and the entire blocking resolve.
  //
  // autoFetchCloudGithubToken needs the cloud agent id. config.cloud?.agentId
  // is available now; the function falls back to its own skip guards (no cloud
  // key / no managed namespace) when the id is absent this early.
  const discordAppIdPromise = autoResolveDiscordAppId();
  const cloudGithubTokenPromise = autoFetchCloudGithubToken(
    config.cloud?.agentId?.trim(),
  );

  // 2c. Propagate x402 config into process.env
  applyX402ConfigToEnv(config);

  // 2d. Propagate database config into process.env for plugin-sql
  applyDatabaseConfigToEnv(config);

  // Boot-time vault hydration: migrate plaintext sensitive values into the
  // OS-keychain vault and resolve vault://KEY sentinels in config.env.
  //
  // Skipped on mobile AND in cloud-provisioned containers. The vault flow
  // (`hydrateWalletKeysFromNodePlatformSecureStore` + `runVaultBootstrap`)
  // reaches for the OS keychain through `defaultMasterKey().load()`
  // (packages/vault/src/master-key.ts:217) and opens a second PGlite worker
  // at `<stateDir>/.vault-pglite/`. Both target environments where it's
  // pointless or actively harmful:
  //   - Android: no D-Bus for libsecret (vault falls back to an
  //     ELIZA_VAULT_PASSPHRASE-derived key, which `ElizaAgentService` already
  //     sets per-install from ANDROID_ID), the spawned bun process has no
  //     plaintext secrets to migrate (env arrives from the service), and the
  //     second PGlite worker doubles disk + RAM pressure on a 4 GB device.
  //   - Cloud sandbox (Docker, ELIZA_CLOUD_PROVISIONED=1): the daemon already
  //     injects every secret as a real env var (ELIZA_API_TOKEN,
  //     ELIZAOS_CLOUD_API_KEY, OPENAI_API_KEY, …), libsecret isn't installed
  //     in the slim image, and the second PGlite worker has been observed to
  //     hang vault-pglite init silently — blocking the HTTP listen and
  //     tripping the 180s health check on every fresh provision.
  const isCloudProvisioned = process.env.ELIZA_CLOUD_PROVISIONED === "1";
  if (!isMobilePlatform() && !isCloudProvisioned) {
    // pre-resolve-setup's two serial cost centers: the OS-keychain hydrate and
    // the vault PGlite cold-start. Timed separately and surfaced below so the
    // boot-history telemetry shows which is the long pole. NOTE: the order is
    // load-bearing: hydrateWalletKeysFromNodePlatformSecureStore writes wallet
    // keys into process.env that runVaultBootstrap then mirrors into the vault,
    // so these must stay sequential unless that mirror is decoupled. Measure
    // here before attempting to overlap them.
    const keychainStartMs = Date.now();
    try {
      const { hydrateWalletKeysFromNodePlatformSecureStore } =
        await importAppCoreRuntime();
      await hydrateWalletKeysFromNodePlatformSecureStore();
    } catch (err) {
      logger.warn(
        `[wallet][os-store] boot hydrate skipped: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    const keychainMs = Date.now() - keychainStartMs;

    const { runVaultBootstrap } = await importAppCoreRuntime();
    const { sharedVault } = await importAppCoreRuntime();
    const vaultStartMs = Date.now();
    const bootResult = await runVaultBootstrap();
    logger.info(
      `[vault-bootstrap] migrated=${bootResult.migrated} failed=${bootResult.failed.length} (keychain=${keychainMs}ms vault-pglite=${Date.now() - vaultStartMs}ms)`,
    );

    const { resolved, missing } = await resolveConfigEnvForProcess(
      config.env as Record<string, unknown> | undefined,
      sharedVault(),
    );
    if (missing.length > 0) {
      logger.warn(
        `[vault-bootstrap] sentinel(s) without vault entry: ${missing.join(", ")}`,
      );
    }
    if (
      config.env &&
      typeof config.env === "object" &&
      !Array.isArray(config.env)
    ) {
      for (const [key, value] of Object.entries(resolved)) {
        (config.env as Record<string, unknown>)[key] = value;
      }
    }
    const varsBag = (config.env as Record<string, unknown> | undefined)?.vars;
    if (varsBag && typeof varsBag === "object" && !Array.isArray(varsBag)) {
      const varsResult = await resolveConfigEnvForProcess(
        varsBag as Record<string, unknown>,
        sharedVault(),
      );
      for (const [key, value] of Object.entries(varsResult.resolved)) {
        (varsBag as Record<string, unknown>)[key] = value;
      }
    }
  }

  // 2f. Propagate arbitrary env vars from config.env into process.env.
  // Eliza stores user-defined env vars (plugin settings, API URLs, etc.)
  // in config.env; elizaOS plugins read them via process.env / getSetting.
  // Skip ELIZAOS_CLOUD_* — applyCloudConfigToEnv() owns those; otherwise a
  // stale key in config.env refills process.env after disconnect cleared it.
  if (
    config.env &&
    typeof config.env === "object" &&
    !Array.isArray(config.env)
  ) {
    for (const [key, value] of Object.entries(config.env)) {
      if (isElizaCloudManagedProcessEnvKey(key)) continue;
      if (typeof value === "string" && !process.env[key]) {
        process.env[key] = value;
      }
    }
    // Also hydrate from config.env.vars — setEnvValue writes API keys to
    // both config.env["KEY"] and config.env.vars["KEY"]. If the top-level
    // key was lost (e.g. pruneEnv, config migration), the nested form is
    // the authoritative source.
    const vars = (config.env as Record<string, unknown>).vars;
    if (vars && typeof vars === "object" && !Array.isArray(vars)) {
      for (const [key, value] of Object.entries(
        vars as Record<string, unknown>,
      )) {
        if (isElizaCloudManagedProcessEnvKey(key)) continue;
        if (typeof value === "string" && !process.env[key]) {
          process.env[key] = value;
        }
      }
    }
  }

  // Keep the canonical public key env in sync for Solana plugins that still
  // read process.env directly instead of runtime settings.
  syncSolanaPublicKeyEnv();

  normalizeOpenAiCompatibleProviderConfig(config);

  // Log active database configuration for debugging persistence issues
  {
    const dbProvider = resolveEffectiveDbProvider(config);
    const pgliteDir = process.env.PGLITE_DATA_DIR;
    const postgresUrl = process.env.POSTGRES_URL;
    logger.info(
      `[eliza] Database provider: ${dbProvider}` +
        (dbProvider === "pglite" && pgliteDir
          ? ` | data dir: ${pgliteDir}`
          : "") +
        (dbProvider === "postgres" && postgresUrl
          ? ` | connection: ${(postgresUrl.length > 4096 ? postgresUrl.slice(0, 4096) : postgresUrl).replace(/:\/\/([^:@]{1,1024}):([^@]{1,1024})@/, "://$1:***@")}`
          : ""),
    );
  }

  // 2d-ii. Allow destructive migrations (e.g. dropping tables removed between
  //        plugin versions) so the runtime doesn't silently stall.  Without this
  //        the migration system throws an error that gets swallowed, leaving the
  //        app hanging indefinitely with no output.
  if (!process.env.ELIZA_ALLOW_DESTRUCTIVE_MIGRATIONS) {
    process.env.ELIZA_ALLOW_DESTRUCTIVE_MIGRATIONS = "true";
  }

  // 2e-ii. SECRET_SALT must be stable across boots — multiple consumers key
  //        durable encryption off it (core/settings.ts encryptStringValue,
  //        encryptedCharacter for character.secrets, runtime.ts decryptSecret,
  //        advanced-capabilities settings). Previously we generated a random
  //        value per process, which silently invalidated every persisted
  //        ciphertext on restart (decryptStringValue returns the encrypted
  //        string on failure, so connector logins just stopped working
  //        without an error). Persist to <stateDir>/secret-salt instead.
  if (!process.env.SECRET_SALT) {
    const secretSaltPath = path.join(resolveStateDir(), "secret-salt");
    let salt: string | null = null;
    try {
      const cached = readFileSync(secretSaltPath, "utf8").trim();
      if (/^[0-9a-f]{64}$/.test(cached)) {
        salt = cached;
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        throw err;
      }
    }
    if (!salt) {
      salt = crypto.randomBytes(32).toString("hex");
      mkdirSync(path.dirname(secretSaltPath), { recursive: true });
      // 0o600: only the user account that wrote it can read it. The salt
      // is a key-derivation input — anyone who reads it plus the
      // ciphertext can decrypt persisted secrets.
      writeFileSync(secretSaltPath, salt, { encoding: "utf8", mode: 0o600 });
      logger.info(
        `[eliza] Generated SECRET_SALT and persisted to ${secretSaltPath}`,
      );
    }
    process.env.SECRET_SALT = salt;
  }

  // 2e-iii. Pre-flight validation for Google AI API keys.  If the key looks
  //         obviously invalid (too short, placeholder, wrong prefix), clear it
  //         to prevent plugin-google-genai from making a failing API call.
  for (const gkey of [
    "GEMINI_API_KEY",
    "GOOGLE_API_KEY",
    "GOOGLE_GENERATIVE_AI_API_KEY",
  ] as const) {
    const val = process.env[gkey]?.trim();
    if (
      val &&
      (val.length < 20 || val === "your-key-here" || val.startsWith("sk-"))
    ) {
      logger.warn(
        `[eliza] ${gkey} appears invalid (length/format), clearing to skip Google AI plugin`,
      );
      delete process.env[gkey];
    }
  }

  // 2f. Install the multi-account pool shims and apply selected direct API
  //     accounts before plugin resolution snapshots process.env.
  //
  // Skipped in cloud containers (ELIZA_CLOUD_PROVISIONED=1): the multi-account
  // pool is a desktop feature for users juggling several accounts per provider
  // (work / personal / throwaway). Cloud sandboxes get one set of credentials
  // injected by the daemon as env vars, so there's nothing to multiplex. The
  // pool implementation is supplied by the host through the injected agent host
  // bridge (see ./host-bridge.ts) — no app-core import, no boot-time cycle.
  if (process.env.ELIZA_CLOUD_PROVISIONED !== "1")
    try {
      const accountPool = await importAppCoreRuntime();
      accountPool.getDefaultAccountPool();
      await accountPool.applyAccountPoolApiCredentials({
        activeBackend: resolveServiceRoutingInConfig(
          config as Record<string, unknown>,
        )?.llmText?.backend,
        accountStrategies: (
          config as Record<string, unknown> & {
            accountStrategies?: Record<string, unknown>;
          }
        ).accountStrategies,
        serviceRouting: resolveServiceRoutingInConfig(
          config as Record<string, unknown>,
        ),
      });
      accountPool.startAccountPoolKeepAlive();
    } catch (err) {
      logger.debug(
        `[eliza] Account pool bootstrap skipped: ${formatError(err)}`,
      );
    }

  // 2g. Apply subscription-based credentials (Claude Max, Codex Max).
  //     Failure is non-fatal — the agent can still start with other providers.
  //     Config is NOT rolled back on failure; partial mutations may persist in
  //     the in-memory config but are not saved to disk until explicit save.
  //
  //     Split into the local-only model.primary derivation (synchronous, needed
  //     before resolvePlugins()) and the network-touching Claude Code OAuth
  //     probe (deferred, awaited in runDeferredBoot so it never blocks plugin
  //     resolution). The OAuth probe mutates neither config nor process.env —
  //     it only logs availability — so deferring it changes no resolve input.
  let subscriptionCredentialsDeferredPromise: Promise<void> = Promise.resolve();
  try {
    const { applySubscriptionCredentialsLocal } = await import("@elizaos/auth");
    applySubscriptionCredentialsLocal(config);
  } catch (err) {
    logger.warn(
      `[eliza] Failed to apply local subscription credentials (agent will continue without them): ${formatError(err)}`,
    );
  }
  subscriptionCredentialsDeferredPromise = (async () => {
    const { applySubscriptionCredentialsDeferred } = await import(
      "@elizaos/auth"
    );
    await applySubscriptionCredentialsDeferred();
  })().catch((err) => {
    logger.warn(
      `[eliza] Failed to probe Claude Code subscription credentials (agent will continue without them): ${formatError(err)}`,
    );
  });

  // 2h. Cloud mode — if the user chose cloud during first-run setup (or on a
  //     subsequent start with cloud config), skip local runtime setup and
  //     connect via the thin client instead.
  const deploymentTarget = resolveDeploymentTargetInConfig(
    config as Record<string, unknown>,
  );

  // 2h-pre. Store-variant build: macOS App Sandbox / MAS / MS Store / Flathub
  // policy is incompatible with running an embedded local AgentRuntime, so
  // store builds must route to Eliza Cloud. If the cloud config is missing,
  // fail loudly and route the user to first-run setup.
  const { isStoreBuild, getBuildVariant } = await importAppCoreRuntime();

  // Boot-time observability: print the resolved (buildVariant, deploymentTarget,
  // stateDir, workspaceDir) tuple so support has it for sandbox issues.
  logger.info(
    `[eliza] boot tuple: buildVariant=${getBuildVariant()} ` +
      `deploymentRuntime=${deploymentTarget.runtime} ` +
      `provider=${deploymentTarget.provider ?? "n/a"} ` +
      `stateDir=${resolveStateDir()} ` +
      `workspaceDir=${process.env.ELIZA_WORKSPACE_DIR ?? "(default)"} ` +
      `platform=${process.platform}`,
  );

  if (isStoreBuild()) {
    if (deploymentTarget.runtime === "local") {
      throw new Error(
        "[eliza] Store-variant builds cannot run a local agent. " +
          "Pair an Eliza Cloud account in first-run setup, or switch to the direct download build.",
      );
    }
    if (!config.cloud?.apiKey?.trim() || !config.cloud?.agentId?.trim()) {
      throw new Error(
        "[eliza] Store-variant build requires a paired Eliza Cloud account. " +
          "Run first-run setup to link Eliza Cloud, or switch to the direct download build.",
      );
    }
    return startInCloudMode(config, config.cloud.agentId, opts);
  }

  const thinClientCloudAgentId = shouldStartElizaCloudThinClient(config)
    ? config.cloud?.agentId?.trim()
    : undefined;
  if (thinClientCloudAgentId) {
    return startInCloudMode(config, thinClientCloudAgentId, opts);
  }

  // 3. Build elizaOS Character from Eliza config
  // Cloud sandbox (Path A): if the provisioner injected the assigned
  // character via ELIZA_AGENT_CHARACTER_JSON, merge it onto the config so the
  // container boots AS that character (e.g. "Nyx") instead of the bundled
  // default preset. Skipped when the env var is absent.
  let sandboxRouteAgentId: string | null = null;
  {
    const { applySandboxCharacterFromEnv, resolveSandboxRouteAgentId } =
      await import("./sandbox-character.ts");
    applySandboxCharacterFromEnv(config);
    sandboxRouteAgentId = resolveSandboxRouteAgentId();
  }
  const character = buildCharacterFromConfig(config);

  // Pin the runtime agent id to the platform character_id so the gateways can
  // resolve `agent:<id>:server` and address `/agents/<id>/message` against
  // this container. Without this the runtime would derive an id from the
  // character name (stringToUuid(name)) which the gateway does not know.
  // Scoped to provisioned containers via the route-id env var.
  if (sandboxRouteAgentId) {
    character.id = sandboxRouteAgentId as UUID;
  }

  const primaryModel = resolvePrimaryModel(config);
  const preferredProviderId = resolvePreferredProviderId(config);
  const preferredProviderPluginName =
    resolvePreferredProviderPluginName(config);

  // 4. Ensure workspace exists with required files
  const workspaceDir =
    config.agents?.defaults?.workspace ?? resolveDefaultAgentWorkspaceDir();
  await ensureAgentWorkspace({
    dir: workspaceDir,
    ensureInitFiles: shouldBootstrapWorkspaceInitFiles(workspaceDir),
  });

  // 4b. Ensure custom plugins directory exists for drop-in plugins
  await fs.mkdir(path.join(resolveStateDir(), CUSTOM_RUNTIME_PLUGINS_DIRNAME), {
    recursive: true,
  });

  // 5. Create the Eliza bridge plugin (workspace context + session keys + compaction)
  const agentId = character.name?.toLowerCase().replace(/\s+/g, "-") ?? "main";

  // 5-pre0. Apply per-agent vault profile overrides to process.env.
  //
  // Vault keys with multiple named profiles (work / personal / throwaway)
  // resolve the active profile for THIS agent through the vault's
  // routing layer, then write the resolved value into process.env so
  // the synchronous runtime.getSetting fast path picks it up. Idempotent;
  // safe to run multiple times. Opt-out via
  // ELIZA_DISABLE_VAULT_PROFILE_RESOLVER=1. Auto-disabled in cloud containers
  // (ELIZA_CLOUD_PROVISIONED=1) — vault PGlite init hangs in the slim Docker
  // image; see the boot-time vault hydration block earlier in this function.
  if (
    process.env.ELIZA_DISABLE_VAULT_PROFILE_RESOLVER !== "1" &&
    process.env.ELIZA_CLOUD_PROVISIONED !== "1"
  ) {
    try {
      const { sharedVault } = await importAppCoreRuntime();
      const { applyVaultProfilesForAgent } = await import(
        "./vault-profile-resolver.ts"
      );
      await applyVaultProfilesForAgent(sharedVault(), agentId);
    } catch (err) {
      logger.warn(
        `[vault-profile-resolver] boot-time apply failed agent="${agentId}": ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // 5-pre. Per-agent EVM + Solana wallet bootstrap is DEFERRED off the boot
  // critical path: it runs after the runtime is reachable (fired fire-and-forget
  // from the deferred boot phase via ensureAgentWalletsLazy()), not during
  // essential boot. This keeps the ~50s EVM/Solana crypto import + vault-write
  // cost out of the time-to-reachable window. The opt-out
  // (ELIZA_DISABLE_AGENT_WALLET_BOOTSTRAP) and cloud-container skip
  // (ELIZA_CLOUD_PROVISIONED) are checked inside ensureAgentWalletsLazy();
  // the TEE-gate suppression lives inside bridgeAgentWalletsToProcessEnv
  // (agent-wallets.ts:359, opt-in via ELIZA_AGENT_WALLET_AS_USER=1) and
  // revealAgentWalletPrivateKey (agent-wallets.ts:155).

  bootTimer.lap("pre-resolve-setup");

  const elizaPlugin = createElizaPlugin({
    workspaceDir,

    agentId,
  });

  // 6. Resolve and load plugins
  // In headless (GUI) mode before first-run setup, the user hasn't configured a
  // provider yet.  Downgrade diagnostics so the expected "no AI provider"
  // state doesn't appear as a scary Error in the terminal.
  const preOnboarding = opts?.headless && !config.agents;
  const blockDeferredPluginImports = shouldBlockDeferredPluginImports();
  const initialPluginResolutionPhase: PluginResolutionPhase =
    blockDeferredPluginImports ? "all" : "blocking";
  const initialForceIncludePluginNames =
    !blockDeferredPluginImports && preferredProviderPluginName
      ? [preferredProviderPluginName]
      : [];
  await ensureStaticPluginsRegisteredByName(initialForceIncludePluginNames);
  const resolvedPlugins = await resolvePlugins(config, {
    quiet: preOnboarding,
    phase: initialPluginResolutionPhase,
    forceIncludePluginNames: initialForceIncludePluginNames,
  });
  bootTimer.lap(`resolve-plugins-${initialPluginResolutionPhase}-import`);
  // #10203: exercise a fault right after the blocking plugin set resolves.
  await maybeInjectFault("plugin-load");

  if (resolvedPlugins.length === 0) {
    if (preOnboarding) {
      logger.info(
        "[eliza] No plugins loaded yet — the first-run setup will configure a model provider",
      );
    } else {
      logger.error(
        "[eliza] No plugins loaded — at least one model provider plugin is required",
      );
      logger.error(
        "[eliza] Set an API key (e.g. ANTHROPIC_API_KEY, OPENAI_API_KEY) in your environment",
      );
      throw new Error("No plugins loaded");
    }
  }

  // 6b. Debug logging — print full context after provider + plugin resolution
  {
    const pluginNames = resolvedPlugins.map((p) => p.name);
    const providerNames = resolvedPlugins
      .flatMap((p) => p.plugin.providers ?? [])
      .map((prov: Provider) => prov.name);
    // Build a context summary for validation
    const contextSummary: Record<string, unknown> = {
      agentName: character.name,
      pluginCount: resolvedPlugins.length,
      providerCount: providerNames.length,
      primaryModel: primaryModel ?? "(auto-detect)",
      preferredProvider: preferredProviderId ?? "(auto-detect)",
      workspaceDir,
    };
    debugLogResolvedContext(pluginNames, providerNames, contextSummary, (msg) =>
      logger.debug(msg),
    );

    // Validate the context and surface issues early
    const contextValidation = validateRuntimeContext(contextSummary);
    if (!contextValidation.valid) {
      const issues: string[] = [];
      if (contextValidation.nullFields.length > 0) {
        issues.push(`null: ${contextValidation.nullFields.join(", ")}`);
      }
      if (contextValidation.undefinedFields.length > 0) {
        issues.push(
          `undefined: ${contextValidation.undefinedFields.join(", ")}`,
        );
      }
      if (contextValidation.emptyFields.length > 0) {
        issues.push(`empty: ${contextValidation.emptyFields.join(", ")}`);
      }
      logger.warn(
        `[eliza] Context validation issues detected: ${issues.join("; ")}`,
      );
    }
  }

  // 7. Create the AgentRuntime with Eliza plugin + resolved plugins
  //    All CORE_PLUGINS are pre-registered sequentially (in CORE_PLUGINS
  //    order) before runtime.initialize() so that cross-plugin getService()
  //    calls always resolve.  runtime.initialize() registers remaining
  //    characterPlugins (connectors, providers, custom) in parallel — those
  //    are NOT core and don't have ordering dependencies.
  const PREREGISTER_PLUGINS = new Set(CORE_PLUGINS);
  const sqlPlugin = resolvedPlugins.find(
    (p) => p.name === "@elizaos/plugin-sql",
  );
  const otherPlugins = resolvedPlugins.filter(
    (p) => !PREREGISTER_PLUGINS.has(p.name),
  );

  // Resolve the runtime log level from config (AgentRuntime doesn't support
  // "silent", so we map it to "fatal" as the quietest supported level).
  const runtimeLogLevel = (() => {
    // process.env.LOG_LEVEL is already resolved (set explicitly or from
    // config.logging.level above), so prefer it to honour the dev-mode
    // LOG_LEVEL=error override set by eliza/packages/app-core/scripts/dev-ui.mjs.
    const lvl = process.env.LOG_LEVEL ?? config.logging?.level ?? "error";
    if (lvl === "silent") return "fatal" as const;
    return lvl as "trace" | "debug" | "info" | "warn" | "error" | "fatal";
  })();

  // 7a. Resolve bundled skills directory from @elizaos/skills so
  //     plugin-agent-skills auto-loads them on startup.
  let bundledSkillsDir: string | null = null;
  try {
    const { getSkillsDir } = (await import("@elizaos/skills")) as {
      getSkillsDir: () => string;
    };
    bundledSkillsDir = getSkillsDir();
    logger.info(`[eliza] Bundled skills dir: ${bundledSkillsDir}`);
  } catch {
    logger.debug(
      "[eliza] @elizaos/skills not available — bundled skills will not be loaded",
    );
  }

  // Workspace skills directory (highest precedence for overrides)
  const workspaceSkillsDir = workspaceDir ? `${workspaceDir}/skills` : null;
  const managedSkillsDir = path.join(resolveStateDir(), "skills");

  // ── Sandbox mode setup ──────────────────────────────────────────────────
  const sandboxConfig = config.agents?.defaults?.sandbox;
  const sandboxModeStr = (sandboxConfig as Record<string, unknown> | undefined)
    ?.mode as string | undefined;
  const sandboxMode: SandboxMode =
    sandboxModeStr === "light" ||
    sandboxModeStr === "standard" ||
    sandboxModeStr === "max"
      ? sandboxModeStr
      : "off";
  const isSandboxActive = sandboxMode !== "off";

  let sandboxManager: SandboxManager | null = null;
  let sandboxAuditLog: SandboxAuditLog | null = null;

  if (isSandboxActive) {
    logger.info(`[eliza] Sandbox mode: ${sandboxMode}`);
    sandboxAuditLog = new SandboxAuditLog({ console: true });

    // Standard/max modes also start the container sandbox manager
    if (sandboxMode === "standard" || sandboxMode === "max") {
      const dockerSettings = (
        sandboxConfig as Record<string, unknown> | undefined
      )?.docker as Record<string, unknown> | undefined;
      const browserSettings = (
        sandboxConfig as Record<string, unknown> | undefined
      )?.browser as Record<string, unknown> | undefined;

      sandboxManager = new SandboxManager({
        mode: sandboxMode,
        image: (dockerSettings?.image as string) ?? undefined,
        containerPrefix:
          (dockerSettings?.containerPrefix as string) ?? undefined,
        network: (dockerSettings?.network as string) ?? undefined,
        memory: (dockerSettings?.memory as string) ?? undefined,
        cpus: (dockerSettings?.cpus as number) ?? undefined,
        workspaceRoot: workspaceDir ?? undefined,
        browser: browserSettings
          ? {
              enabled: (browserSettings.enabled as boolean) ?? false,
              image: (browserSettings.image as string) ?? undefined,
              cdpPort: (browserSettings.cdpPort as number) ?? undefined,
              vncPort: (browserSettings.vncPort as number) ?? undefined,
              noVncPort: (browserSettings.noVncPort as number) ?? undefined,
              headless: (browserSettings.headless as boolean) ?? undefined,
              enableNoVnc:
                (browserSettings.enableNoVnc as boolean) ?? undefined,
              autoStart: (browserSettings.autoStart as boolean) ?? true,
              autoStartTimeoutMs:
                (browserSettings.autoStartTimeoutMs as number) ?? undefined,
            }
          : undefined,
      });

      try {
        await sandboxManager.start();
        logger.info("[eliza] Sandbox manager started");
      } catch (err) {
        logger.error(
          `[eliza] Sandbox manager failed to start: ${err instanceof Error ? err.message : String(err)}`,
        );
        // Non-fatal: light mode fallback
      }
    }

    sandboxAuditLog.record({
      type: "sandbox_lifecycle",
      summary: `Sandbox initialized: mode=${sandboxMode}`,
      severity: "info",
    });
  }
  // ── End sandbox setup ───────────────────────────────────────────────────

  // ── Boost preferred provider plugin priority ──────────────────────────
  // elizaOS selects the model handler with the highest `priority` for each
  // ModelType.  All provider plugins default to priority 0, so whichever
  // registers first wins — essentially random when using Promise.all.
  // When the user has explicitly selected a provider or model, prefer that
  // provider's plugin so its handlers are selected over registration order.
  const pluginsForRuntime = otherPlugins.map((p) => p.plugin);
  const visionModeSetting = resolveVisionModeSetting(config);
  if (preferredProviderPluginName) {
    for (const plugin of pluginsForRuntime) {
      if (plugin.name === preferredProviderPluginName) {
        plugin.priority = (plugin.priority ?? 0) + 10;
        logger.info(
          `[eliza] Boosted plugin "${plugin.name}" priority to ${plugin.priority} (preferred provider: ${preferredProviderId ?? "unknown"})`,
        );
        break;
      }
    }
  }

  // Deduplicate actions across all plugins to avoid "Action already registered"
  // warnings from elizaOS core. basic-capabilities is registered first by the
  // runtime, so include it in deduplication so its actions take precedence.
  const subAgentCredentialPlugins = shouldRegisterSubAgentCredentialsPlugin()
    ? [subAgentCredentialsPlugin]
    : [];
  const settings = character.settings ?? {};
  const basicCapabilitiesPlugin = createBasicCapabilitiesPlugin({
    disableBasic:
      settings.DISABLE_BASIC_CAPABILITIES === true ||
      settings.DISABLE_BASIC_CAPABILITIES === "true",
    enableExtended:
      settings.ENABLE_EXTENDED_CAPABILITIES === true ||
      settings.ENABLE_EXTENDED_CAPABILITIES === "true" ||
      settings.ADVANCED_CAPABILITIES === true ||
      settings.ADVANCED_CAPABILITIES === "true",
    skipCharacterProvider: false,
    enableAutonomy:
      settings.ENABLE_AUTONOMY === true || settings.ENABLE_AUTONOMY === "true",
  });
  deduplicatePluginActions([
    basicCapabilitiesPlugin,
    ...subAgentCredentialPlugins,
    elizaPlugin,
    ...pluginsForRuntime,
  ]);

  let runtime = new AgentRuntime({
    character,
    // advancedCapabilities: true,
    actionPlanning: true,
    // advancedMemory is enabled via character.advancedMemory
    plugins: [...subAgentCredentialPlugins, elizaPlugin, ...pluginsForRuntime],
    ...(runtimeLogLevel ? { logLevel: runtimeLogLevel } : {}),
    // Sandbox options — only active when mode != "off"
    ...(isSandboxActive
      ? {
          sandboxMode: true,
          sandboxAuditHandler: sandboxAuditLog
            ? (event: SandboxFetchAuditEvent) => {
                sandboxAuditLog.recordTokenReplacement(
                  event.direction,
                  event.url,
                  event.tokenIds,
                );
              }
            : undefined,
        }
      : {}),
    settings: {
      VALIDATION_LEVEL: "fast",
      // Forward non-sensitive Eliza config.env vars as runtime settings so
      // plugins can access them via runtime.getSetting(). This fixes a bug where
      // plugins (e.g. @elizaos/plugin-google-genai) call runtime.getSetting()
      // which returns null for keys not in settings, but the plugin checks
      // !== undefined causing it to use "null" as the model name.
      //
      // Security: Filter out blockchain private keys and secrets. API keys are
      // allowed since plugins need them via runtime.getSetting(). Private keys
      // should only be accessed via process.env by signing services.
      ...Object.fromEntries(
        Object.entries(collectConfigEnvVars(config)).filter(([key]) =>
          isEnvKeyAllowedForForwarding(key),
        ),
      ),
      // Forward connector config vars as-is. The connector env map is curated
      // and plugins need access to secrets like passwords and tokens via
      // runtime.getSetting() for real transports to boot.
      ...collectConnectorEnvVars(config),
      // Forward Eliza config env vars as runtime settings
      ...(preferredProviderId ? { MODEL_PROVIDER: preferredProviderId } : {}),
      ...(visionModeSetting ? { VISION_MODE: visionModeSetting } : {}),
      ...resolveWalletRuntimeSettings(config),
      ...(typeof config.agents?.defaults?.adminEntityId === "string" &&
      config.agents.defaults.adminEntityId.trim().length > 0
        ? {
            ELIZA_ADMIN_ENTITY_ID: config.agents.defaults.adminEntityId.trim(),
          }
        : {}),
      ...(config.agents?.defaults?.ownerContacts
        ? {
            ELIZA_OWNER_CONTACTS_JSON: JSON.stringify(
              config.agents.defaults.ownerContacts,
            ),
          }
        : {}),
      ...(config.roles?.connectorAdmins
        ? {
            ELIZA_ROLES_CONNECTOR_ADMINS_JSON: JSON.stringify(
              config.roles.connectorAdmins,
            ),
          }
        : {}),
      // Forward skills config so plugin-agent-skills can apply allow/deny filtering
      ...(config.skills?.allowBundled
        ? { SKILLS_ALLOWLIST: config.skills.allowBundled.join(",") }
        : {}),
      ...(config.skills?.denyBundled
        ? { SKILLS_DENYLIST: config.skills.denyBundled.join(",") }
        : {}),
      // Managed skills are stored in the Eliza state dir.
      SKILLS_DIR: managedSkillsDir,
      // Tell plugin-agent-skills where to find bundled + workspace skills
      ...(bundledSkillsDir ? { BUNDLED_SKILLS_DIRS: bundledSkillsDir } : {}),
      ...(workspaceSkillsDir
        ? { WORKSPACE_SKILLS_DIR: workspaceSkillsDir }
        : {}),
      // Also forward extra dirs from config
      ...(config.skills?.load?.extraDirs?.length
        ? { EXTRA_SKILLS_DIRS: config.skills.load.extraDirs.join(",") }
        : {}),
      // Disable image description when vision is explicitly toggled off.
      // The cloud plugin always registers IMAGE_DESCRIPTION, so we need a
      // runtime setting to prevent the message service from calling it.
      ...(config.features?.vision === false
        ? { DISABLE_IMAGE_DESCRIPTION: "true" }
        : {}),
    },
  });
  installRuntimeMethodBindings(runtime);

  // 7a. Mobile local inference must be registered before runtime.initialize().
  // Runtime services probe TEXT_EMBEDDING during init; registering the local
  // handler only after startEliza() returns leaves mobile local mode booting
  // with "no provider" diagnostics and disabled embedding services.
  if (process.env.ELIZA_LOCAL_LLAMA?.trim() === "1") {
    try {
      const { ensureAospLocalInferenceHandlers } = await import(
        "@elizaos/plugin-aosp-local-inference"
      );
      await ensureAospLocalInferenceHandlers(runtime);
    } catch (err) {
      logger.warn(
        `[eliza] AOSP local inference pre-registration skipped: ${formatError(err)}`,
      );
    }
  } else if (process.env.ELIZA_DEVICE_BRIDGE_ENABLED?.trim() === "1") {
    try {
      const { ensureMobileDeviceBridgeInferenceHandlers } = await import(
        "@elizaos/plugin-capacitor-bridge/mobile-device-bridge-bootstrap"
      );
      await ensureMobileDeviceBridgeInferenceHandlers(runtime);
    } catch (err) {
      logger.warn(
        `[eliza] Mobile device bridge pre-registration skipped: ${formatError(err)}`,
      );
    }
  }

  // 7b. Pre-register plugin-sql so the adapter is ready before other plugins init.
  //     This is OPTIONAL — without it, some features (memory, todos) won't work.
  //     runtime.db is a getter that returns this.adapter.db and throws when
  //     this.adapter is undefined, so plugins that use runtime.db will fail.
  if (sqlPlugin) {
    // 7c. Eagerly initialize the database adapter so it's fully ready
    //     BEFORE other plugins run their init(). When legacy/corrupt PGLite
    //     state causes startup aborts, reset the local DB dir and retry once.
    await registerSqlPluginWithRecovery(runtime, sqlPlugin, config);
    bootTimer.lap("register-sql");
  } else {
    const loadedNames = resolvedPlugins.map((p) => p.name).join(", ");
    logger.error(
      `[eliza] @elizaos/plugin-sql was NOT found among resolved plugins. ` +
        `Loaded: [${loadedNames}]`,
    );
    throw new Error(
      "@elizaos/plugin-sql is required but was not loaded. " +
        "Ensure the package is installed and built (check for import errors above).",
    );
  }

  // 7d. Register the roles capability (cheap, gates provider/action visibility).
  //     The remaining core plugins (app-control, device-filesystem,
  //     shell, coding-tools, agent-skills, commands, google, lifeops, browser,
  //     video) are NOT essential to the chat path and are loaded in the
  //     background after the runtime is ready — see runDeferredBoot below.
  try {
    logger.info("[eliza] Pre-registering roles capability...");
    await runtime.registerPlugin(rolesPlugin);
    logger.info("[eliza] ✓ roles capability pre-registered");
  } catch (err) {
    logger.warn(
      `[eliza] Roles capability pre-registration failed: ${formatError(err)}`,
    );
  }
  bootTimer.lap("svc:roles-register");

  const warmAgentSkillsService = async (): Promise<void> => {
    // Let runtime startup complete first; this warm-up runs asynchronously
    // so API + agent come online immediately.
    try {
      const skillServicePromise = runtime.getServiceLoadPromise(
        "AGENT_SKILLS_SERVICE",
      );
      const timeout = new Promise<never>((_resolve, reject) => {
        setTimeout(() => {
          reject(
            new Error(
              "AgentSkillsService warm-up timed out (10s) — non-blocking, agent will function without skills",
            ),
          );
        }, 10_000);
      });
      await Promise.race([skillServicePromise, timeout]);

      const svc = runtime.getService("AGENT_SKILLS_SERVICE") as
        | {
            getCatalogStats?: () => {
              loaded: number;
              total: number;
              storageType: string;
            };
          }
        | null
        | undefined;
      if (svc?.getCatalogStats) {
        const stats = svc.getCatalogStats();
        logger.info(
          `[eliza] AgentSkills ready — ${stats.loaded} skills loaded, ` +
            `${stats.total} in catalog (storage: ${stats.storageType})`,
        );
      }

      // Guard against non-string skill.description values.
      // The bundled YAML parser produces {} for multi-line descriptions, which
      // crashes findBestLocalMatch / scoreSkillMatch (call .toLowerCase() on it).
      // Instead of a one-shot sanitize (which misses skills loaded later by
      // syncCatalog / autoRefresh), we monkey-patch getLoadedSkills to always
      // return sanitized values.
      const svcAny = svc as Record<string, unknown> | null | undefined;
      const origGetLoaded = svcAny?.getLoadedSkills as
        | ((...args: unknown[]) => Array<Record<string, unknown>>)
        | undefined;
      if (origGetLoaded && svcAny) {
        (svcAny as Record<string, unknown>).getLoadedSkills = function (
          ...args: unknown[]
        ) {
          const skills = origGetLoaded.apply(this, args);
          for (const skill of skills) {
            if (typeof skill.description !== "string") {
              skill.description =
                skill.description == null
                  ? ""
                  : JSON.stringify(skill.description);
            }
          }
          return skills;
        };
        logger.debug("[eliza] Patched getLoadedSkills to guard descriptions");
      }
    } catch (err) {
      // Non-fatal — the agent can operate without skills. This warm-up runs
      // async so it doesn't block startup.
      logger.debug(`[eliza] AgentSkillsService warm-up: ${formatError(err)}`);
    }
  };

  const registerConnectorSetupService = async (): Promise<void> => {
    try {
      const { ConnectorSetupService } = await import(
        "../services/connector-setup-service.ts"
      );
      await runtime.registerService(ConnectorSetupService);
    } catch (err) {
      logger.debug(
        `[eliza] ConnectorSetupService registration skipped: ${formatError(err)}`,
      );
    }
  };

  // Register the hosted-app run reader as a runtime service so the session gate
  // can query it via getService instead of statically importing the plugin
  // (which inverted the host→plugin dependency direction). Dynamic import keeps
  // the plugin out of the agent's static module graph; absence is non-fatal and
  // the gate treats it as "no active runs".
  const registerAppSessionService = async (): Promise<void> => {
    try {
      const { AppSessionService } = await import(
        /* @vite-ignore */ "@elizaos/plugin-app-manager"
      );
      await runtime.registerService(AppSessionService);
    } catch (err) {
      logger.debug(
        `[eliza] AppSessionService registration skipped: ${formatError(err)}`,
      );
    }
  };

  const registerRemoteCodingRunner = async (): Promise<void> => {
    if (isBundledMobileRuntime()) return;
    if (!shouldLoadRemoteCodingRunnerForBoot(runtime)) return;
    try {
      const { registerE2BRemoteCapabilityRouterIfEnabled } =
        await loadE2BCapabilityRouterModule();
      const result = await registerE2BRemoteCapabilityRouterIfEnabled(runtime);
      if (result.registered) {
        if (result.provider === "e2b") {
          const loaded = await registerE2BSandboxFactoryService(runtime);
          if (!loaded) {
            logger.warn(
              "[eliza] E2B remote runner selected but @elizaos/plugin-e2b-sandbox is not installed; E2B filesystem/terminal/git will be unavailable until it is added.",
            );
          }
        }
        logger.info("[eliza] Remote coding runner registered");
      }
    } catch (err) {
      logger.warn(
        `[eliza] Remote coding runner registration failed: ${formatError(err)}`,
      );
    }
  };

  const initializeCoreRuntime = async (): Promise<void> => {
    assertPersistentDatabaseRequired(runtime);
    await runtime.initialize();
    // runtime.initialize() survives a total TEXT_EMBEDDING dimension-probe
    // failure (EmbeddingDimensionProbeError is caught in core, which flips the
    // runtime into embedding-disabled mode instead of writing vectors the SQL
    // adapter would silently drop). Surface the degraded state at the boot
    // layer too — the deferred re-probe below re-enables embeddings if a
    // provider recovers once late plugins register.
    if (runtime.isEmbeddingGenerationDisabled()) {
      logger.warn(
        "[eliza] boot continuing with embedding generation disabled: every registered TEXT_EMBEDDING provider failed the dimension probe; memory writes persist without vectors until the deferred re-probe finds a working provider",
      );
    }
    await prepareRuntimeForTrajectoryCapture(
      runtime,
      "runtime.initialize()",
      config,
    );
  };

  // One-time TEE boot gate (plan §4.1 / agent A4). Inert when no TEE policy is
  // configured: `evaluateTeeBootGate` returns secretsEnabled:true and normal/
  // local-only boots are unaffected. When ELIZA_TEE_REQUIRED (or a production
  // profile) resolves a required policy and the evidence is not trusted, the
  // gate fails closed and high-value capabilities (remote plugin sync plus
  // model-key/signing consumers) are withheld. Boot still proceeds in a
  // degraded, secret-less mode — it never silently continues with secrets.
  let teeBootGateResult: TeeBootGate | undefined;
  const runTeeBootGate = async (): Promise<void> => {
    let teeBootGate: TeeBootGate;
    try {
      // The concrete evidence provider (dstack/CoVE) is registered by the TEE
      // deployment plugin through the host seam; absent that plugin this is
      // undefined and a required policy fails closed (secrets disabled).
      const evidenceProvider = resolveTeeEvidenceProvider({ env: process.env });
      teeBootGate = await evaluateTeeBootGate({
        env: process.env,
        ...(evidenceProvider ? { evidenceProvider } : {}),
      });
    } catch (err) {
      // A TEE policy was configured but evidence could not be collected or
      // evaluated. Fail closed rather than crash the boot.
      teeBootGate = {
        policy: undefined,
        teeConfigured: true,
        required: true,
        productionProfile: process.env.ELIZA_TEE_PRODUCTION_PROFILE === "true",
        secretsEnabled: false,
      };
      logger.error(
        `[TeeBootGate] TEE evidence evaluation failed; secrets disabled (fail-closed): ${formatError(err)}`,
      );
    }
    // Publish the one-time decision so secret-path modules (agent-wallet key
    // reveal/bridge, remote plugin sync) can consult it via the shared
    // singleton. Inert when no TEE: the gate's `required` is false.
    setTeeBootGateState(teeBootGate);
    teeBootGateResult = teeBootGate;
  };

  // TEE-gated remote signing (plan §4.3). Inert unless explicitly enabled:
  // the host↔guest bridge can request a signature, but the key stays in the
  // vault and every sign re-attests when the boot-gate policy requires TEE
  // evidence. Fail-closed: when the boot gate blocks secrets, the service is
  // not constructed at all.
  const registerRemoteSigningIfEnabled = async (): Promise<void> => {
    if (process.env.ELIZA_REMOTE_SIGNING_ENABLED !== "true") return;
    if (teeBootGateBlocksSecrets()) {
      logger.warn(
        "[RemoteSigning] Skipping remote signing activation: TEE evidence is not trusted.",
      );
      return;
    }
    try {
      const { sharedVault } = await importAppCoreRuntime();
      const { VaultSignerBackend } = await import(
        "../services/vault-signer-backend.ts"
      );
      const {
        createTeeGatedRemoteSigningService,
        RemoteSigningRuntimeService,
      } = await import("../services/remote-signing-service.ts");

      const signer = new VaultSignerBackend({
        vault: sharedVault(),
        agentId,
        caller: "remote-signing:boot",
      });
      const teePolicy = teeBootGateResult?.policy;
      // Re-attest each sign through the same registered provider the boot gate
      // used. This path only runs once the gate has already enabled secrets, so
      // a required policy implies a registered provider; if none is registered
      // the re-attesting provider is simply absent (the gate would not have
      // reached here under a required policy).
      const signingEvidenceProvider = teePolicy?.required
        ? resolveTeeEvidenceProvider({ env: process.env })
        : undefined;
      const signing = createTeeGatedRemoteSigningService({
        signer,
        ...(teePolicy ? { teePolicy } : {}),
        ...(signingEvidenceProvider
          ? { evidenceProvider: signingEvidenceProvider }
          : {}),
      });

      await runtime.registerService(RemoteSigningRuntimeService);
      const svc = runtime.getService(
        RemoteSigningRuntimeService.serviceType,
      ) as InstanceType<typeof RemoteSigningRuntimeService> | null;
      if (!svc) {
        throw new Error("RemoteSigningRuntimeService did not register");
      }
      svc.attach(signing);
      logger.info(
        { attesting: teePolicy?.required === true },
        "[RemoteSigning] TEE-gated remote signing service registered.",
      );
    } catch (err) {
      logger.warn(
        `[RemoteSigning] Remote signing activation failed: ${formatError(err)}`,
      );
    }
  };

  const syncRemoteCapabilityPluginsIfAvailable = async (): Promise<void> => {
    if (teeBootGateBlocksSecrets()) {
      logger.warn(
        "[TeeBootGate] Skipping remote capability plugin sync: TEE evidence is not trusted.",
      );
      return;
    }
    try {
      const result = await bootstrapRemoteCapabilityPlugins(runtime, {
        unloadMissing: true,
      });
      if (
        result.registered.length > 0 ||
        result.unloaded.length > 0 ||
        result.skipped.length > 0
      ) {
        logger.info(
          `[eliza] Remote capability plugins synced — registered=${result.registered.length}, ` +
            `unloaded=${result.unloaded.length}, skipped=${result.skipped.length}`,
        );
      }
    } catch (err) {
      logger.warn(
        `[eliza] Remote capability plugin sync failed: ${formatError(err)}`,
      );
    }
  };

  const applyPluginRoleGatingIfAvailable = async (): Promise<void> => {
    try {
      // Belt-and-suspenders full-graph sweep. The durable enforcement point is
      // the registerPlugin wrapper in installRuntimeMethodBindings, which gates
      // each plugin at registration time; this re-gates the whole graph and is
      // idempotent (already-gated providers are skipped). applyPluginRoleGating
      // is fail-closed per provider.
      applyPluginRoleGating(runtime.plugins ?? []);
    } catch (err) {
      // #12087 Item 1: this was logged at debug — an import/apply failure here
      // silently disabled ALL sensitive-provider redaction (SECRETS_STATUS,
      // walletPortfolio, …). Surface it loudly. Registration-time gating in the
      // plugin-lifecycle wrapper is the primary enforcement; this boot pass is a
      // defense-in-depth backstop for plugins registered before that wrapper.
      logger.error(
        `[eliza] Plugin provider role gating FAILED — sensitive providers may be ungated: ${formatError(err)}`,
      );
    }
  };

  const registerConversationProximityProvider = async (): Promise<void> => {
    try {
      const { conversationProximityProvider } = await import(
        "../providers/conversation-proximity.ts"
      );
      await runtime.registerPlugin({
        name: "eliza-conversation-proximity",
        description:
          "Read-only co-participant context for post-turn evaluators",
        providers: [conversationProximityProvider],
      });
      logger.info("[eliza] ✓ conversation-proximity provider registered");
    } catch (err) {
      logger.debug(
        `[eliza] Conversation-proximity provider skipped: ${formatError(err)}`,
      );
    }
  };

  const seedBundledDocumentsIfEnabled = async (): Promise<void> => {
    try {
      if (runtimeDocumentsEnabled(runtime)) {
        await seedBundledDocuments(runtime);
      } else {
        logger.info(
          "[eliza] Native documents disabled; skipping bundled document seeding",
        );
      }
    } catch (err) {
      logger.warn(
        `[eliza] Failed to seed bundled documents: ${formatError(err)}`,
      );
    }
  };

  const installServerSideWebSearchIfAvailable = async (): Promise<void> => {
    try {
      const { installServerSideWebSearch } = await import(
        "./web-search-tools.ts"
      );
      installServerSideWebSearch();
    } catch (err) {
      logger.debug(
        `[eliza] Server-side web search setup skipped: ${formatError(err)}`,
      );
    }
  };

  // Keyless inline live-info fetch for every runtime (not just Anthropic).
  // Opt out with ELIZA_WEB_FETCH=0|false|off, mirroring ELIZA_WEB_SEARCH.
  const registerWebFetchActionIfEnabled = async (): Promise<void> => {
    try {
      const { webFetch, isWebFetchEnabled } = await import(
        "./actions/web-fetch.ts"
      );
      if (!isWebFetchEnabled()) {
        logger.info(
          "[eliza] WEB_FETCH action disabled via ELIZA_WEB_FETCH=0|false|off",
        );
        return;
      }
      runtime.registerAction(webFetch);
      logger.info("[eliza] Registered keyless WEB_FETCH action");
    } catch (err) {
      logger.debug(
        `[eliza] WEB_FETCH action registration skipped: ${formatError(err)}`,
      );
    }
  };

  const registerWebSearchActionIfEnabled = async (): Promise<void> => {
    try {
      const { webSearch, isWebSearchEnabled } = await import(
        "./actions/web-search.ts"
      );
      if (!isWebSearchEnabled()) {
        logger.info(
          "[eliza] WEB_SEARCH action disabled; set ELIZA_INLINE_WEB_SEARCH=1 to force inline search, or unset ELIZA_SERVER_WEB_SEARCH when using the default inline surface",
        );
        return;
      }
      runtime.registerAction(webSearch);
      logger.info("[eliza] Registered keyless WEB_SEARCH action");
    } catch (err) {
      logger.debug(
        `[eliza] WEB_SEARCH action registration skipped: ${formatError(err)}`,
      );
    }
  };

  const isAutonomyEnabled = (): boolean =>
    ["true", "1"].includes((process.env.ENABLE_AUTONOMY ?? "").toLowerCase());

  const startAutonomyServiceIfEnabled = async (
    autonomyEnabled: boolean,
  ): Promise<void> => {
    if (autonomyEnabled && !runtime.getService(AUTONOMY_SERVICE_TYPE)) {
      try {
        await startAndRegisterAutonomyService(runtime);
        logger.info("[eliza] AutonomyService started for trigger dispatch");
      } catch (err) {
        logger.warn(
          `[eliza] AutonomyService failed to start: ${formatError(err)}`,
        );
      }
    } else if (!autonomyEnabled) {
      logger.info("[eliza] AutonomyService skipped — ENABLE_AUTONOMY=false");
    }
  };

  const enableAutonomyLoopIfAvailable = async (
    autonomyEnabled: boolean,
  ): Promise<void> => {
    if (!autonomyEnabled) return;
    const autonomySvc = getAutonomyService(runtime);
    if (!autonomySvc) return;
    try {
      await autonomySvc.enableAutonomy();
      logger.info(
        "[eliza] AutonomyService enabled — trigger instructions will be processed",
      );
    } catch (err) {
      logger.warn(
        `[eliza] Failed to enable autonomy loop: ${formatError(err)}`,
      );
    }
  };

  const startAgentSkillsWarmup = (): void => {
    void warmAgentSkillsService().catch((err) => {
      logger.warn(`[eliza] Skills warm-up failed: ${formatError(err)}`);
    });
  };

  // Prefetch the local TEXT_EMBEDDING GGUF in the background so the first
  // chat/memory request doesn't stall on a multi-second model download. The
  // chat/inference provider is separate from embeddings (vector memory / RAG):
  // API-based model plugins do not implement TEXT_EMBEDDING, so the local model
  // is the default embedding backend unless Eliza Cloud embeddings are active.
  // This only ensures the file is present on disk — the GGUF is loaded into
  // memory lazily on first use — and runs entirely after the readiness gate so
  // it can never block or crash boot.
  const warmEmbeddingModel = async (): Promise<void> => {
    if (process.env.NODE_ENV === "test") return;
    // Mobile bundles do not ship node-llama-cpp and must not pull a multi-GB
    // GGUF over a data plan; they embed via cloud/device-bridge instead.
    if (isMobilePlatform() || isBundledMobileRuntime()) return;

    const li = await getPluginLocalEmbedding();
    if (!li) return;

    const {
      shouldWarmupLocalEmbeddingModel,
      detectEmbeddingPreset,
      embeddingGgufFilePresent,
      findExistingEmbeddingModelForWarmupReuse,
      isEmbeddingWarmupReuseDisabled,
      ensureModel,
      DEFAULT_MODELS_DIR,
    } = await import(
      /* @vite-ignore */ "@elizaos/plugin-local-inference/runtime"
    );

    if (!shouldWarmupLocalEmbeddingModel()) {
      logger.info(
        "[eliza] Skipping local embedding (GGUF) warmup — not needed for this configuration (Eliza Cloud embeddings or local embeddings disabled).",
      );
      return;
    }

    // Populate the LOCAL_EMBEDDING_* env from config + hardware preset so the
    // warmup and the lazy first-use load resolve the same model.
    await configureLocalEmbeddingPlugin({} as Plugin, config);

    const preset = detectEmbeddingPreset();
    const modelsDir = process.env.MODELS_DIR?.trim() || DEFAULT_MODELS_DIR;
    let model = process.env.LOCAL_EMBEDDING_MODEL?.trim() || preset.model;
    let modelRepo =
      process.env.LOCAL_EMBEDDING_MODEL_REPO?.trim() || preset.modelRepo;

    if (
      !isEmbeddingWarmupReuseDisabled() &&
      !embeddingGgufFilePresent(modelsDir, model)
    ) {
      const reuse = findExistingEmbeddingModelForWarmupReuse(modelsDir);
      if (reuse) {
        logger.info(
          `[eliza] Embedding warmup: configured file "${model}" not found in MODELS_DIR — reusing existing ${reuse.model} to avoid a large re-download.`,
        );
        process.env.LOCAL_EMBEDDING_MODEL = reuse.model;
        process.env.LOCAL_EMBEDDING_MODEL_REPO = reuse.modelRepo;
        process.env.LOCAL_EMBEDDING_DIMENSIONS = String(reuse.dimensions);
        process.env.LOCAL_EMBEDDING_CONTEXT_SIZE = String(reuse.contextSize);
        process.env.LOCAL_EMBEDDING_GPU_LAYERS = reuse.gpuLayers;
        model = reuse.model;
        modelRepo = reuse.modelRepo;
      }
    }

    if (embeddingGgufFilePresent(modelsDir, model)) {
      return;
    }

    logger.info(
      `[eliza] Local embedding warmup: prefetching ${model} (preset: ${preset.label}). ` +
        "This GGUF serves TEXT_EMBEDDING / memory only — not your conversation model.",
    );
    await ensureModel(modelsDir, modelRepo, model, false);
  };

  const startEmbeddingWarmup = (): void => {
    void warmEmbeddingModel().catch((err) => {
      // Non-fatal: the embedding plugin downloads on first use if this fails.
      logger.warn(
        `[eliza] Embedding model warmup failed (will retry on first use): ${formatError(err)}`,
      );
    });
  };

  // Per-agent EVM + Solana wallet bootstrap is DEFERRED off the boot critical
  // path: it runs after the runtime is reachable (fired fire-and-forget from
  // the deferred boot phase below), not synchronously during essential boot.
  // This keeps the ~50s crypto import cost (EVM + Solana keypair generation +
  // encrypted vault writes) out of the time-to-reachable window.
  //
  // The opt-out (ELIZA_DISABLE_AGENT_WALLET_BOOTSTRAP), cloud-container skip
  // (ELIZA_CLOUD_PROVISIONED), and TEE-gate suppression (inside
  // bridgeAgentWalletsToProcessEnv and revealAgentWalletPrivateKey in
  // agent-wallets.ts) all still apply.
  //
  // The init is a singleton: once the first call resolves, subsequent calls
  // return the cached descriptors; a failure clears the singleton so the next
  // call retries. This closure is local to startEliza — it is not attached to
  // the runtime object. If a wallet route or signer needs true on-demand
  // generation, wire it onto the runtime and call it from that path.
  let walletInitPromise: Promise<
    readonly import("./agent-wallets.ts").AgentWalletDescriptor[]
  > | null = null;
  const ensureAgentWalletsLazy = (): Promise<
    readonly import("./agent-wallets.ts").AgentWalletDescriptor[]
  > => {
    if (
      process.env.ELIZA_DISABLE_AGENT_WALLET_BOOTSTRAP === "1" ||
      process.env.ELIZA_CLOUD_PROVISIONED === "1"
    ) {
      return Promise.resolve([]);
    }
    if (walletInitPromise) return walletInitPromise;
    walletInitPromise = (async () => {
      try {
        const { sharedVault } = await importAppCoreRuntime();
        const { ensureAgentWallets } = await import("./agent-wallets.ts");
        const descriptors = await ensureAgentWallets(
          sharedVault(),
          agentId,
          "agent-bootstrap",
        );
        const summary = descriptors
          .map((d) => `${d.chain}:${d.address}`)
          .join(" ");
        logger.info(
          `[agent-wallets] agent="${agentId}" wallets ready (${summary})`,
        );
        return descriptors;
      } catch (err) {
        // Clear the singleton so the next access retries.
        walletInitPromise = null;
        logger.warn(
          `[agent-wallets] failed to ensure wallets for agent="${agentId}": ${err instanceof Error ? err.message : String(err)}`,
        );
        return [];
      }
    })();
    return walletInitPromise;
  };

  // Essential boot: only what the runtime needs to become reachable (sql +
  // local-inference are already registered above; deferred provider/connector
  // plugins continue after the ready gate unless legacy blocking mode is
  // requested). The runtime is reported ready as soon as this resolves.
  const initializeRuntimeServices = async (): Promise<void> => {
    await registerConnectorSetupService();
    bootTimer.lap("svc:connector-setup");
    await registerAppSessionService();
    bootTimer.lap("svc:app-session");
    await registerRemoteCodingRunner();
    bootTimer.lap("svc:pre-init");

    if (blockDeferredPluginImports) {
      // In block-deferred mode the Discord/GitHub plugins register here (not in
      // runDeferredBoot), so join the env-var lookups before this wave.
      await Promise.all([discordAppIdPromise, cloudGithubTokenPromise]);
      await preregisterCorePluginsInDependencyWaves({
        runtime,
        resolvedPlugins,
        alreadyPreRegistered: new Set<string>([
          "@elizaos/plugin-sql",
          "@elizaos/plugin-local-inference",
        ]),
        label: "blocking",
      });
      bootTimer.lap("register-core-plugin-waves");
    }

    await initializeCoreRuntime();
    bootTimer.lap("svc:runtime.initialize");
    await registerDesktopScreenCaptureBridgeService(runtime);
    bootTimer.lap("svc:desktop-screen-capture");
  };

  const registerDeferredRuntimePlugins = async (
    deferredResolvedPlugins: RuntimeResolvedPlugin[],
  ): Promise<void> => {
    if (blockDeferredPluginImports) {
      return;
    }

    const alreadyRegisteredPluginNames = new Set(
      (runtime.plugins ?? [])
        .map((plugin) => plugin.name)
        .filter((name): name is string => typeof name === "string"),
    );
    const deferredPluginsForRuntime = deferredResolvedPlugins
      .filter((p) => !PREREGISTER_PLUGINS.has(p.name))
      .filter((p) => !alreadyRegisteredPluginNames.has(p.plugin.name ?? p.name))
      .map((p) => p.plugin);
    if (deferredPluginsForRuntime.length === 0) {
      return;
    }

    if (preferredProviderPluginName) {
      for (const plugin of deferredPluginsForRuntime) {
        if (plugin.name === preferredProviderPluginName) {
          plugin.priority = (plugin.priority ?? 0) + 10;
          logger.info(
            `[eliza] Boosted deferred plugin "${plugin.name}" priority to ${plugin.priority} (preferred provider: ${preferredProviderId ?? "unknown"})`,
          );
          break;
        }
      }
    }

    deduplicatePluginActions([
      basicCapabilitiesPlugin,
      ...subAgentCredentialPlugins,
      elizaPlugin,
      ...(runtime.plugins ?? []),
      ...deferredPluginsForRuntime,
    ]);

    const timeoutMs = 30_000;
    await Promise.all(
      deferredPluginsForRuntime.map(async (plugin) => {
        const startedAt = Date.now();
        try {
          logger.info(
            `[eliza] deferred: Registering plugin: ${plugin.name}...`,
          );
          await Promise.race([
            runtime.registerPlugin(plugin),
            new Promise<never>((_resolve, reject) =>
              setTimeout(
                () => reject(new Error(`Timed out after ${timeoutMs / 1000}s`)),
                timeoutMs,
              ),
            ),
          ]);
          logger.info(
            `[eliza] deferred: ✓ ${plugin.name} registered (${Date.now() - startedAt}ms)`,
          );
        } catch (err) {
          logger.warn(
            `[eliza] deferred: Plugin ${plugin.name} registration failed: ${formatError(err)}`,
          );
        }
      }),
    );
  };

  const resolveDeferredPluginsForBoot = async (): Promise<
    RuntimeResolvedPlugin[]
  > => {
    if (blockDeferredPluginImports) {
      return resolvedPlugins;
    }
    await ensureDeferredCoreStaticPluginsRegistered();
    const deferredResolvedPlugins = await resolvePlugins(config, {
      quiet: preOnboarding,
      phase: "deferred",
    });
    bootTimer.lap("deferred:resolve-plugins-import");
    return deferredResolvedPlugins;
  };

  // Deferred boot: non-essential core plugins (app-control,
  // device-filesystem, shell, coding-tools, agent-skills, commands, google,
  // lifeops, browser, video), auto-enabled providers/connectors, custom
  // plugins, plus the post-init tail. Runs in the background after the runtime
  // is ready so the API can bind immediately; deferred capabilities light up as
  // each plugin registers. The 3 intra-core dependency edges
  // (coding-tools/agent-skills → shell, lifeops → google) live entirely within
  // this group, so the existing wave algorithm preserves ordering.
  const runDeferredBoot = async (): Promise<void> => {
    // Join the boot-time network lookups (Discord App ID, cloud GitHub token)
    // before resolving the deferred plugin set — the Discord connector and the
    // GitHub/git plugins live in this deferred wave and read the env vars these
    // promises write. Also join the Claude Code OAuth probe (informational
    // logging only). All self-handle their errors, so this only waits.
    await Promise.all([
      discordAppIdPromise,
      cloudGithubTokenPromise,
      subscriptionCredentialsDeferredPromise,
    ]);
    bootTimer.lap("deferred:env-lookups");

    if (!blockDeferredPluginImports) {
      const deferredResolvedPlugins = await resolveDeferredPluginsForBoot();
      await registerDeferredRuntimePlugins(deferredResolvedPlugins);
      bootTimer.lap("deferred:runtime-plugins");

      await preregisterCorePluginsInDependencyWaves({
        runtime,
        resolvedPlugins: deferredResolvedPlugins,
        alreadyPreRegistered: new Set<string>([
          "@elizaos/plugin-sql",
          "@elizaos/plugin-local-inference",
        ]),
        label: "deferred",
      });
      bootTimer.lap("deferred:core-plugin-waves");
    }

    // Drain app-route plugin loaders into runtime.routes. App-route plugins
    // (e.g. @elizaos/plugin-agent-orchestrator:routes) register a loader on a
    // global registry via registerAppRoutePluginLoader rather than exposing
    // their HTTP routes through Plugin.routes directly. packages/app-core's
    // boot path drains this registry, but the headless agent-server boot did
    // not, so /api/coding-agents/* and /api/orchestrator/* 404ed even though
    // the orchestrator plugin's services were registered. This MUST run after
    // the deferred plugin wave (the orchestrator loads deferred, ~5s after
    // runtime.initialize), otherwise the registry is still empty. Mirror
    // app-core's registerAppRoutePlugins: load each loader and push its rawPath
    // routes onto runtime.routes so tryHandleRuntimePluginRoute can dispatch.
    // The drain is idempotent (dedups by type:path), so in a combined app-core
    // deployment where app-core also drains the registry, neither double-mounts.
    await drainAppRoutePluginLoaders(runtime);
    bootTimer.lap("deferred:app-route-plugins");

    await runTeeBootGate();
    bootTimer.lap("deferred:tee-gate");

    await registerRemoteSigningIfEnabled();
    await syncRemoteCapabilityPluginsIfAvailable();
    await applyPluginRoleGatingIfAvailable();
    // #12087 Item 19: now that every plugin's actions are registered, warn about
    // ACTION_ROLE_POLICY keys that match no action name/simile (a silently-inert
    // policy, usually from an action rename after the operator wrote the policy).
    warnOnUnmatchedActionRolePolicyKeys(runtime.actions ?? []);
    await registerConversationProximityProvider();
    // Probe the embedding dimension BEFORE seeding bundled documents (#8769).
    // The deferred plugin waves above register the cloud TEXT_EMBEDDING handler
    // (plugin-elizacloud, 1536-dim); the probe in runtime.initialize() ran ~38s
    // earlier, before that handler existed, so the SQL adapter kept its
    // hardcoded dim384 default. seedBundledDocumentsIfEnabled() embeds its docs
    // at 1536 via the cloud handler, so if the column is still dim384 every
    // bundled-doc vector is dropped on a "dimension mismatch with configured
    // column (dim384)" and the agent boots with no recall memory. Snapping the
    // column to dim1536 here — after the handler is registered, before the seed
    // writes — lets those embeddings (and all later memory) persist.
    // ensureEmbeddingDimension() is public, idempotent, and self-guarding (it
    // no-ops when no TEXT_EMBEDDING handler is registered, e.g. cloud-proxied
    // agents), so this is safe on every boot path.
    try {
      await runtime.ensureEmbeddingDimension();
    } catch (err) {
      if (err instanceof EmbeddingDimensionProbeError) {
        // Non-fatal: core already disabled embedding generation for this
        // runtime, so memory writes skip vectors instead of being silently
        // dropped on dimension mismatch. Log the per-provider failures so the
        // degraded state is diagnosable from boot logs.
        logger.warn(
          { attempts: err.attempts },
          "[eliza] deferred embedding-dimension re-probe: every registered TEXT_EMBEDDING provider failed; embedding generation stays disabled (memory writes persist without vectors)",
        );
      } else {
        logger.warn(
          `[eliza] deferred embedding-dimension re-probe failed: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
    await seedBundledDocumentsIfEnabled();
    // First-boot onboarding notifications (tour / help / connect calendar) —
    // once per agent; dismissals are permanent (guard flag, not the rows).
    try {
      const { seedOnboardingNotifications } = await import(
        "./onboarding-notifications.ts"
      );
      await seedOnboardingNotifications(runtime);
    } catch (err) {
      logger.warn(
        `[eliza] Failed to seed onboarding notifications: ${formatError(err)}`,
      );
    }
    await installServerSideWebSearchIfAvailable();
    await registerWebFetchActionIfEnabled();
    await registerWebSearchActionIfEnabled();
    bootTimer.lap("deferred:post-init");

    const autonomyLoopEnabled = isAutonomyEnabled();
    await startAutonomyServiceIfEnabled(true);
    await enableAutonomyLoopIfAvailable(autonomyLoopEnabled);
    startAgentSkillsWarmup();
    startEmbeddingWarmup();
    // Trigger the lazy wallet singleton fire-and-forget. This is a safety net
    // — if no wallet route or signing flow triggers it earlier, wallets are
    // still generated here. The singleton keeps this harmless if already
    // resolved by an earlier caller.
    void ensureAgentWalletsLazy();
    bootTimer.lap("deferred:autonomy+warmup");

    // Same timing reason: validate the intent→action map only once the deferred
    // plugins have registered. Run during blocking init it would warn about
    // actions like TASKS (agent-orchestrator) that simply hadn't loaded yet.
    validateIntentActionMap(
      runtime.actions.map((a) => a.name),
      runtime.logger,
    );
    // Same timing: turn the (previously dead-but-tested) view-coverage validators
    // into a live drift guard now that all plugins/views are registered (#8798).
    // Warns when a view affinity entry names an unregistered action, or a
    // registered view has neither relatedActions nor a declared ViewCapability.
    const developerViews = listViews({ developerMode: true });
    validateViewActionMap(
      runtime.actions.map((a) => a.name),
      runtime.logger,
    );
    validateViewCoverage(
      developerViews.map((v) => v.id),
      developerViews.filter((v) => v.capabilities?.length).map((v) => v.id),
      runtime.logger,
    );
    bootTimer.lap("deferred:complete");
  };

  try {
    // Time from the register-sql lap up to entering service init (roles
    // capability registration + any blocking pre-init work). Split out so a
    // device boot can attribute the dominant cost instead of lumping it into
    // svc:pre-init (issue #9565): on a bundled mobile runtime the three hooks
    // below are each fast/no-op, yet svc:pre-init was ~15s of a 16s cold boot.
    bootTimer.lap("svc:boot-prep");
    await initializeRuntimeServices();
  } catch (err) {
    const pgliteDataDir = resolveActivePgliteDataDir(config);
    const recoveryAction =
      !opts?.pgliteRecoveryAttempted && pgliteDataDir
        ? getPgliteRecoveryAction(err, pgliteDataDir)
        : "none";

    if (!pgliteDataDir || recoveryAction === "none") {
      throw err;
    }
    if (recoveryAction === "fail-active-lock") {
      throw createActivePgliteLockError(pgliteDataDir, err);
    }
    if (recoveryAction === "fail-manual-reset") {
      throw createManualResetRequiredPgliteError(pgliteDataDir, err);
    }

    logger.warn(
      `[eliza] Runtime migrations failed (${formatError(err)}). Cleared a stale PGLite lock in ${pgliteDataDir} and retrying startup once without resetting data.`,
    );
    try {
      await shutdownRuntime(runtime, "PGLite recovery");
    } catch {
      // Ignore cleanup errors — retry creates a fresh runtime anyway.
    }

    return await startEliza({
      ...opts,
      pgliteRecoveryAttempted: true,
    });
  }

  bootTimer.summary();
  void recordBootTelemetry(bootTimer.getSummary());
  startMemorySampler({ intervalMs: 30_000 });
  // Proactively bounce the runtime before an OOM kill when RSS climbs past the
  // configured threshold (opt-in via ELIZA_MEMORY_WATCHDOG). Restarts cleanly
  // through requestRestart()/the supervisor — never a silent process.exit.
  startMemoryWatchdog();
  // #10203: a `ready`-point fault fires once the agent has reached steady boot.
  await maybeInjectFault("ready");

  // Kick off non-essential plugin loading in the background. The runtime is
  // already usable for chat; deferred capabilities register as they complete.
  // Fired AFTER the API server is listening (see below) so the deferred
  // wave's awaited work cannot starve the API bind off the event loop.
  const kickoffDeferredBoot = (): void => {
    void runDeferredBoot().catch((err) => {
      logger.warn(`[eliza] Deferred boot failed: ${formatError(err)}`);
    });
  };

  // 9. Graceful shutdown handler
  //
  // In headless mode the caller (dev-server / desktop shell) owns the process
  // lifecycle, so we must NOT register signal handlers here — they would
  // stack on every hot-restart, close over stale runtime references, and
  // race with bun --watch's own process teardown.
  if (!opts?.headless) {
    registerSignalShutdownHandlers({
      getRuntime: () => runtime,
      getSandboxManager: () => sandboxManager,
    });
  }

  const loadHooksSystem = async (): Promise<void> => {
    try {
      const internalHooksConfig = config.hooks
        ?.internal as LoadHooksOptions["internalConfig"];

      await loadHooks({
        workspacePath: workspaceDir,
        internalConfig: internalHooksConfig,
        elizaConfig: config as Record<string, unknown>,
      });

      const startupEvent = createHookEvent("gateway", "startup", "system", {
        cfg: config,
      });
      await triggerHook(startupEvent);
    } catch (err) {
      logger.warn(`[eliza] Hooks system could not load: ${formatError(err)}`);
    }
  };

  // ── Headless mode — return runtime for API server wiring ──────────────
  if (opts?.headless) {
    void loadHooksSystem().catch((err) => {
      logger.warn(`[eliza] Hooks system load failed: ${formatError(err)}`);
    });
    // Defer the deferred-boot kickoff to a macrotask so this function's caller
    // (dev-server / desktop shell) gets to run its `await startEliza()`
    // continuation FIRST — that continuation flips agentState to "running" and
    // broadcasts `ready:true`. Firing kickoffDeferredBoot() synchronously here
    // started the deferred plugin import storm (CPU-bound module evaluation)
    // before the readiness continuation could get a turn, so `ready:true`
    // landed ~13s late even though the blocking boot finished at ~2s
    // (loadperf research/03 F2). setImmediate yields to the macrotask queue
    // after the microtask continuation, so readiness flips promptly and the
    // deferred connectors/feature plugins still register right after.
    setImmediate(kickoffDeferredBoot);
    logger.info(
      "[eliza] Runtime initialised in headless mode (autonomy enabled)",
    );
    return runtime;
  }

  // 10. Load hooks system
  await loadHooksSystem();

  // ── Start API server for GUI access ──────────────────────────────────────
  // In CLI mode (non-headless), start the API server in the background so
  // the GUI can connect to the running agent.  This ensures full feature
  // parity: whether started via `npx elizaos`, `bun run dev`, or the
  // desktop app, the API server is always available for the GUI admin
  // surface.
  try {
    const { startApiServer } = await import("../api/server.ts");
    // When the desktop launcher embeds this agent it sets ELIZA_API_PORT
    // (default 31337) to match the renderer's hardcoded API base. The old
    // `resolveServerOnlyPort` call only reads ELIZA_PORT/ELIZA_UI_PORT,
    // ignoring ELIZA_API_PORT, so the desktop API ended up on 2138 and
    // the renderer hit "Failed to fetch". Prefer the desktop API port
    // resolver when ELIZA_API_PORT is set; otherwise fall back to the
    // server-only resolver so CLI-mode defaults (2138) stay untouched.
    const apiPort = process.env.ELIZA_API_PORT
      ? resolveDesktopApiPort(process.env)
      : resolveServerOnlyPort(process.env);
    const { port: actualApiPort } = await startApiServer({
      port: apiPort,
      runtime,
      onRestart: async () => {
        logger.info("[eliza] Hot-reload: Restarting runtime...");
        try {
          // Stop the old runtime to release resources (DB connections, timers, etc.)
          //
          // WHY the 2s timeout: some services — notably PTYService —
          // shut down gracefully by awaiting each active session with a
          // per-session timeout (up to ~5s). runtime.stop() awaits every
          // service.stop() sequentially, so a single idle PTY session
          // turns a provider switch into a multi-second block. During
          // that window the runtime-operations active-op slot +
          // agentState === "restarting" guard reject further clicks,
          // which is why flipping through providers rapidly feels stuck.
          //
          // Cap the shutdown window at 2s; if it doesn't finish, log and
          // bring the new runtime up anyway. Services that miss the
          // window get GC'd when the process unwinds. This is fine for a
          // user-initiated restart — the user asked for a new runtime;
          // in-flight work on the old one is already obsolete.
          try {
            const SHUTDOWN_TIMEOUT_MS = 2000;
            let shutdownTimedOut = false;
            await Promise.race([
              shutdownRuntime(runtime, "hot-reload cleanup"),
              new Promise<void>((resolve) =>
                setTimeout(() => {
                  shutdownTimedOut = true;
                  resolve();
                }, SHUTDOWN_TIMEOUT_MS),
              ),
            ]);
            if (shutdownTimedOut) {
              logger.warn(
                `[eliza] Hot-reload: old runtime shutdown exceeded ${SHUTDOWN_TIMEOUT_MS}ms; proceeding with new runtime`,
              );
            }
          } catch (stopErr) {
            logger.warn(
              `[eliza] Hot-reload: old runtime stop failed: ${formatError(stopErr)}`,
            );
          }

          // Reload config from disk (updated by API)
          const freshConfig = loadElizaConfig();

          // Propagate secrets & cloud config into process.env so plugins
          // (especially plugin-elizacloud) can discover them.  The initial
          // startup does this in startEliza(); the hot-reload must repeat it
          // because the config may have changed (e.g. cloud enabled during
          // first-run setup).
          applyConnectorSecretsToEnv(freshConfig);
          await autoResolveDiscordAppId();
          applyCloudConfigToEnv(freshConfig);
          applyX402ConfigToEnv(freshConfig);
          applyDatabaseConfigToEnv(freshConfig);
          await autoFetchCloudGithubToken(
            freshConfig.cloud?.agentId?.trim() || agentId,
          );

          try {
            const accountPool = await importAppCoreRuntime();
            accountPool.getDefaultAccountPool();
            await accountPool.applyAccountPoolApiCredentials({
              activeBackend: resolveServiceRoutingInConfig(
                freshConfig as Record<string, unknown>,
              )?.llmText?.backend,
              accountStrategies: (
                freshConfig as Record<string, unknown> & {
                  accountStrategies?: Record<string, unknown>;
                }
              ).accountStrategies,
              serviceRouting: resolveServiceRoutingInConfig(
                freshConfig as Record<string, unknown>,
              ),
            });
            accountPool.startAccountPoolKeepAlive();
          } catch (poolErr) {
            logger.debug(
              `[eliza] Hot-reload: account pool bootstrap skipped: ${formatError(poolErr)}`,
            );
          }

          // Apply subscription-based credentials (Claude Max, Codex Max)
          // that may have been set up during first-run setup.
          try {
            const { applySubscriptionCredentials } = await import(
              "@elizaos/auth"
            );
            await applySubscriptionCredentials(freshConfig);
          } catch (subErr) {
            logger.warn(
              `[eliza] Hot-reload: subscription credentials: ${formatError(subErr)}`,
            );
          }

          // Resolve plugins using same function as startup
          const resolvedPlugins = await resolvePlugins(freshConfig);

          // Rebuild character from the fresh config so first-run changes
          // (name, bio, style, etc.) are picked up on restart.
          const freshCharacter = buildCharacterFromConfig(freshConfig);

          // Recreate Eliza plugin with fresh workspace
          const freshElizaPlugin = createElizaPlugin({
            workspaceDir:
              freshConfig.agents?.defaults?.workspace ?? workspaceDir,

            agentId:
              freshCharacter.name?.toLowerCase().replace(/\s+/g, "-") ?? "main",
          });

          // Create new runtime with updated plugins.
          // Filter out pre-registered plugins so they aren't double-loaded
          // inside initialize()'s Promise.all — same pattern as the initial
          // startup to avoid the TEXT_EMBEDDING race condition.
          const freshPreferredProviderId =
            resolvePreferredProviderId(freshConfig);
          const freshPreferredProviderPluginName =
            resolvePreferredProviderPluginName(freshConfig);
          const freshOtherPlugins = resolvedPlugins.filter(
            (p) => !PREREGISTER_PLUGINS.has(p.name),
          );
          // Boost the preferred provider plugin priority (same as initial startup)
          const freshPluginsForRuntime = freshOtherPlugins.map((p) => p.plugin);
          const freshVisionModeSetting = resolveVisionModeSetting(freshConfig);
          if (freshPreferredProviderPluginName) {
            for (const plugin of freshPluginsForRuntime) {
              if (plugin.name === freshPreferredProviderPluginName) {
                plugin.priority = (plugin.priority ?? 0) + 10;
                break;
              }
            }
          }
          deduplicatePluginActions([
            ...subAgentCredentialPlugins,
            freshElizaPlugin,
            ...freshPluginsForRuntime,
          ]);
          const newRuntime = new AgentRuntime({
            character: freshCharacter,
            plugins: [
              ...subAgentCredentialPlugins,
              freshElizaPlugin,
              ...freshPluginsForRuntime,
            ],
            ...(runtimeLogLevel ? { logLevel: runtimeLogLevel } : {}),
            settings: {
              ...(freshPreferredProviderId
                ? { MODEL_PROVIDER: freshPreferredProviderId }
                : {}),
              ...(freshVisionModeSetting
                ? { VISION_MODE: freshVisionModeSetting }
                : {}),
              // Disable image description when vision is explicitly toggled off.
              ...(freshConfig.features?.vision === false
                ? { DISABLE_IMAGE_DESCRIPTION: "true" }
                : {}),
            },
          });
          installRuntimeMethodBindings(newRuntime);

          // Pre-register plugin-sql before initialize() so the adapter is ready,
          // matching initial startup. local-inference wires its handlers via the
          // runtime hooks like every other plugin.
          // Re-derive from freshly resolved plugins (not outer closure) so
          // hot-reload picks up any plugin updates.
          const freshSqlPlugin = resolvedPlugins.find(
            (p) => p.name === "@elizaos/plugin-sql",
          );
          if (freshSqlPlugin) {
            await registerSqlPluginWithRecovery(
              newRuntime,
              freshSqlPlugin,
              freshConfig,
            );
          }

          // Pre-register remaining core plugins sequentially (same as startup)
          {
            try {
              await newRuntime.registerPlugin(rolesPlugin);
            } catch (err) {
              logger.warn(
                `[eliza] Hot-reload: roles capability pre-registration failed: ${formatError(err)}`,
              );
            }

            const alreadyPreRegistered = new Set<string>([
              "@elizaos/plugin-sql",
              "@elizaos/plugin-local-inference",
            ]);
            await preregisterCorePluginsInDependencyWaves({
              runtime: newRuntime,
              resolvedPlugins,
              alreadyPreRegistered,
              label: "Hot-reload",
            });
          }

          assertPersistentDatabaseRequired(newRuntime);
          try {
            const { ConnectorSetupService: CSSReload } = await import(
              "../services/connector-setup-service.ts"
            );
            await newRuntime.registerService(CSSReload);
          } catch {
            // non-fatal
          }
          if (
            !isBundledMobileRuntime() &&
            shouldLoadRemoteCodingRunnerForBoot(newRuntime)
          ) {
            try {
              const { registerE2BRemoteCapabilityRouterIfEnabled } =
                await loadE2BCapabilityRouterModule();
              const result =
                await registerE2BRemoteCapabilityRouterIfEnabled(newRuntime);
              if (result.registered && result.provider === "e2b") {
                await registerE2BSandboxFactoryService(newRuntime);
              }
            } catch {
              // non-fatal
            }
          }
          assertPersistentDatabaseRequired(newRuntime);
          await newRuntime.initialize();
          await prepareRuntimeForTrajectoryCapture(
            newRuntime,
            "hot-reload runtime.initialize()",
            config,
          );

          try {
            // Belt-and-suspenders full-graph sweep; the registerPlugin wrapper
            // (installed on newRuntime via installRuntimeMethodBindings above)
            // is the durable enforcement point and already gated each plugin at
            // registration time. This re-gate is idempotent.
            applyPluginRoleGating(newRuntime.plugins ?? []);
          } catch (err) {
            // Never silently disable redaction — report loudly at ERROR.
            logger.error(
              `[eliza] Hot-reload plugin provider role gating sweep failed: ${formatError(err)}`,
            );
          }

          // Ensure AutonomyService survives hot-reload; the loop remains opt-in.
          const hotReloadAutonomyLoopEnabled = isAutonomyEnabled();

          if (!newRuntime.getService(AUTONOMY_SERVICE_TYPE)) {
            try {
              await startAndRegisterAutonomyService(newRuntime);
            } catch (err) {
              logger.warn(
                `[eliza] AutonomyService failed to start after hot-reload: ${formatError(err)}`,
              );
            }
          }

          // Enable the autonomy loop after hot-reload only when explicitly requested.
          if (hotReloadAutonomyLoopEnabled) {
            const svc = getAutonomyService(newRuntime);
            if (svc) {
              try {
                await svc.enableAutonomy();
              } catch (err) {
                logger.warn(
                  `[eliza] Failed to enable autonomy after hot-reload: ${formatError(err)}`,
                );
              }
            }
          }

          runtime = newRuntime;
          logger.info("[eliza] Hot-reload: Runtime restarted successfully");
          return newRuntime;
        } catch (err) {
          logger.error(`[eliza] Hot-reload failed: ${formatError(err)}`);
          return null;
        }
      },
    });
    const dashboardUrl = `http://localhost:${actualApiPort}`;
    logger.info(`[eliza] Control UI: ${dashboardUrl}`);
    // API is now listening — safe to begin the deferred plugin waves.
    kickoffDeferredBoot();
  } catch (apiErr) {
    // Log to both stderr (visible to Electrobun agent.ts) and the in-memory
    // logger so the error is never silently swallowed in packaged builds.
    const apiErrMsg = `[eliza] Could not start API server: ${formatError(apiErr)}`;
    console.error(apiErrMsg);
    logger.error(apiErrMsg);

    // In server-only mode (Electrobun desktop), a missing API server is fatal
    // — nothing else can serve requests. Exit so the parent process sees a
    // non-zero exit code instead of the misleading "Server running" message.
    if (opts?.serverOnly) {
      logger.error(
        "[eliza] Exiting: API server is required in server-only mode.",
      );
      process.exit(1);
    }
    // Non-fatal in CLI mode — the interactive chat loop still works.
    // Still load deferred capabilities even though the API failed.
    kickoffDeferredBoot();
  }

  // ── Server-only mode — keep running without chat loop ────────────────────
  if (opts?.serverOnly) {
    logger.info("[eliza] Running in server-only mode (no interactive chat)");

    // Cloud sandbox self-registration (Path A). When this runtime is the
    // entrypoint of a Hetzner-provisioned container, the provisioner injects
    // the SANDBOX_REGISTRY_* env vars. Writing the `agent:<id>:server` +
    // `server:<name>:url` keys to the shared Upstash Redis lets the
    // multi-tenant gateways resolve this container as the inference target
    // and forward inbound platform messages here. Returns null for every
    // non-provisioned runtime, so this is inert outside the cloud
    // container. See packages/shared/src/sandbox-registry.ts.
    const { buildSandboxRegistryFromEnv } = await import(
      "@elizaos/shared/sandbox-registry"
    );
    const sandboxRegistry = buildSandboxRegistryFromEnv();
    if (sandboxRegistry) {
      try {
        await sandboxRegistry.register();
      } catch (err) {
        logger.error(
          `[eliza] Failed to register sandbox in Redis (gateways will not route inbound platform messages here until the next hb_signal succeeds): ${formatError(err)}`,
        );
      }
      sandboxRegistry.startHeartbeat(30_000);
    }

    // Keep process alive — the API server handles all interaction
    const keepAlive = setInterval(() => {}, 1 << 30); // ~12 days

    registerSignalShutdownHandlers({
      getRuntime: () => runtime,
      getSandboxManager: () => sandboxManager,
      beforeShutdown: async () => {
        clearInterval(keepAlive);
        if (sandboxRegistry) {
          sandboxRegistry.stopHeartbeat();
          try {
            await sandboxRegistry.unregister();
          } catch (err) {
            logger.warn(
              `[eliza] Sandbox unregister failed (keys will expire via TTL): ${formatError(err)}`,
            );
          }
        }
      },
    });

    return runtime;
  }

  // ── Interactive chat loop ────────────────────────────────────────────────
  const agentName = character.name ?? "Eliza";
  const userId = crypto.randomUUID() as UUID;
  // Use `let` so the fallback path can reassign to fresh IDs.
  let roomId = stringToUuid(`${agentName}-chat-room`);

  try {
    const worldId = stringToUuid(`${agentName}-chat-world`);
    // Use a deterministic messageServerId so the settings provider
    // can reference the world by serverId after it is found.
    const messageServerId = stringToUuid(`${agentName}-cli-server`) as UUID;
    await runtime.ensureConnection({
      entityId: userId,
      roomId,
      worldId,
      userName: "User",
      source: "cli",
      channelId: `${agentName}-chat`,
      type: ChannelType.DM,
      messageServerId,
      metadata: { ownership: { ownerId: userId } },
    });
    // Ensure the world has ownership metadata so the settings
    // provider can locate it via findWorldsForOwner during first-run setup.
    // This also handles worlds that already exist from a prior session
    // but were created without ownership metadata.
    const world = await runtime.getWorld(worldId);
    if (world) {
      let needsUpdate = false;
      if (!world.metadata) {
        world.metadata = {};
        needsUpdate = true;
      }
      if (
        !world.metadata.ownership ||
        typeof world.metadata.ownership !== "object" ||
        (world.metadata.ownership as { ownerId: string }).ownerId !== userId
      ) {
        world.metadata.ownership = { ownerId: userId };
        needsUpdate = true;
      }
      if (needsUpdate) {
        await runtime.updateWorld(world);
      }
    }
  } catch (err) {
    logger.warn(
      `[eliza] Could not establish chat room, retrying with fresh IDs: ${formatError(err)}`,
    );

    // Fall back to unique IDs if deterministic ones conflict with stale data.
    // IMPORTANT: reassign roomId so the message loop below uses the same room.
    roomId = crypto.randomUUID() as UUID;
    const freshWorldId = crypto.randomUUID() as UUID;
    const freshServerId = crypto.randomUUID() as UUID;
    try {
      await runtime.ensureConnection({
        entityId: userId,
        roomId,
        worldId: freshWorldId,
        userName: "User",
        source: "cli",
        channelId: `${agentName}-chat`,
        type: ChannelType.DM,
        messageServerId: freshServerId,
        metadata: { ownership: { ownerId: userId } },
      });
      // Same ownership metadata fix for the fallback world.
      const fallbackWorld = await runtime.getWorld(freshWorldId);
      if (fallbackWorld) {
        let needsUpdate = false;
        if (!fallbackWorld.metadata) {
          fallbackWorld.metadata = {};
          needsUpdate = true;
        }
        if (
          !fallbackWorld.metadata.ownership ||
          typeof fallbackWorld.metadata.ownership !== "object" ||
          (fallbackWorld.metadata.ownership as { ownerId: string }).ownerId !==
            userId
        ) {
          fallbackWorld.metadata.ownership = { ownerId: userId };
          needsUpdate = true;
        }
        if (needsUpdate) {
          await runtime.updateWorld(fallbackWorld);
        }
      }
    } catch (retryErr) {
      logger.error(
        `[eliza] Chat room setup failed after retry: ${formatError(retryErr)}`,
      );
      throw retryErr;
    }
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  console.log(`\n💬 Chat with ${agentName} (type 'exit' to quit)\n`);

  const prompt = () => {
    rl.question("You: ", async (input) => {
      const text = input.trim();

      if (text.toLowerCase() === "exit" || text.toLowerCase() === "quit") {
        console.log("\nGoodbye!");
        rl.close();
        try {
          await shutdownRuntime(runtime, "cli shutdown");
        } catch (err) {
          logger.warn(`[eliza] Error stopping runtime: ${formatError(err)}`);
        }
        process.exit(0);
      }

      if (!text) {
        prompt();
        return;
      }

      try {
        const message = createMessageMemory({
          id: crypto.randomUUID() as UUID,
          entityId: userId,
          roomId,
          content: {
            text,
            source: MESSAGE_SOURCE_CLIENT_CHAT,
            channelType: ChannelType.DM,
          },
        });

        process.stdout.write(`${agentName}: `);

        if (!runtime.messageService) {
          logger.error(
            "[eliza] runtime.messageService is not available — cannot process messages",
          );
          process.stdout.write("[Error: message service unavailable]\n\n");
          prompt();
          return;
        }

        await runtime.messageService.handleMessage(
          runtime,
          message,
          async (content) => {
            if (content?.text) {
              process.stdout.write(content.text);
            }
            return [];
          },
        );

        process.stdout.write("\n\n");
      } catch (err) {
        // Log the error and continue the prompt loop — don't let a single
        // failed message kill the interactive session.
        logger.error(
          `[eliza] Chat message handling failed: ${formatError(err)}`,
        );
        process.stdout.write(`\n[Error: ${formatError(err)}]\n\n`);
      }
      prompt();
    });
  };

  prompt();
}

// When run directly (not imported), start immediately.
// Use path.resolve to normalise both sides before comparing so that
// symlinks, trailing slashes, and relative paths don't cause false negatives.
// ---------------------------------------------------------------------------
// Cloud thin-client mode
// ---------------------------------------------------------------------------

/**
 * Start in cloud mode — connect to a remote cloud agent via the thin client.
 * Skips all local runtime construction (plugins, database, etc.).
 */
type CloudRuntimeProxyLike = {
  agentName: string;
  handleChatMessageStream: (text: string) => AsyncIterable<string>;
  handleChatMessage: (text: string) => Promise<string>;
};

export async function startInCloudMode(
  config: ElizaConfig,
  agentId: string,
  opts?: StartElizaOptions,
): Promise<AgentRuntime | undefined> {
  // Cloud mode does not run a local AgentRuntime, but the registry must still
  // be populated for any code path that touches `STATIC_ELIZA_PLUGINS` while
  // the cloud proxy is active. A cloud-hosted agent never uses the on-device
  // inference stack, so register only the SQL registry entry and skip
  // `@elizaos/plugin-local-inference` (model/embedding/voice warmup, bun:ffi
  // dylib) — it would only add first-paint latency for a remote agent.
  await ensureCloudCoreStaticPluginsRegistered();
  const { CloudManager } = await import(
    /* @vite-ignore */ "@elizaos/plugin-elizacloud"
  );

  const cloudConfig = config.cloud;
  if (!cloudConfig) {
    throw new Error(
      "Cloud mode requires a cloud configuration block in the config",
    );
  }
  logger.info(
    `[eliza] Starting in cloud mode (agentId=${agentId}, baseUrl=${cloudConfig.baseUrl ?? "(default)"})`,
  );

  const manager = new CloudManager(cloudConfig, {
    onStatusChange: (status: string) => {
      logger.info(`[eliza] Cloud connection: ${status}`);
    },
  });

  try {
    await manager.init();
    const proxy = (await manager.connect(agentId)) as CloudRuntimeProxyLike;

    if (opts?.headless || opts?.serverOnly) {
      // In headless/server mode, start the API server with the cloud proxy.
      // The proxy exposes the same interface the API server needs.
      logger.info(
        `[eliza] Cloud agent connected (headless). Agent: ${proxy.agentName}`,
      );
      // Return undefined here; GUI cloud mode is handled through the
      // dedicated cloud proxy routes instead of a local AgentRuntime.
      return undefined;
    }

    // Interactive CLI mode — simple chat loop against the cloud agent
    console.log(
      `\n☁️  Connected to cloud agent "${proxy.agentName}" (${agentId})\n`,
    );
    console.log("Type a message to chat, or Ctrl+C to quit.\n");

    const rl = (await import("node:readline")).createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    const prompt = () => {
      rl.question("You: ", async (input) => {
        const text = input.trim();
        if (!text) {
          prompt();
          return;
        }

        try {
          // Use streaming if available
          let response = "";
          process.stdout.write(`${proxy.agentName}: `);
          for await (const chunk of proxy.handleChatMessageStream(text)) {
            process.stdout.write(chunk);
            response += chunk;
          }
          if (!response) {
            // Fallback to non-streaming
            response = await proxy.handleChatMessage(text);
            process.stdout.write(response);
          }
          process.stdout.write("\n\n");
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          process.stdout.write(`\n[error] ${msg}\n\n`);
        }

        prompt();
      });
    };

    rl.on("close", async () => {
      process.stdout.write("\nDisconnecting from cloud agent...\n");
      await manager.disconnect();
      process.exit(0);
    });

    prompt();

    // Keep the process alive
    return undefined;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error(`[eliza] Failed to connect to cloud agent: ${msg}`);
    throw new Error(
      `Failed to connect to cloud agent: ${msg}\n` +
        "You can retry with `eliza start`, or switch to local mode by setting `deploymentTarget.runtime` to `local`",
    );
  }
}

const isDirectRun = (() => {
  // Mobile (bundled) builds set ELIZA_DISABLE_DIRECT_RUN=1 via Bun's
  // `--define`. After bundling, `import.meta.url` and `process.argv[1]`
  // collapse to the same bundle path, so this check spuriously matches and
  // the runtime self-invokes a SECOND `startEliza()` alongside the CLI's
  // primary one. The second invocation lacks `{ serverOnly: true }` and
  // drops into the readline chat loop, which closes on stdin EOF and tears
  // the whole process down.
  if (
    (globalThis as { __ELIZA_MOBILE_BUNDLE__?: unknown })
      .__ELIZA_MOBILE_BUNDLE__ === true ||
    (globalThis as { __ELIZA_DISABLE_DIRECT_RUN?: unknown })
      .__ELIZA_DISABLE_DIRECT_RUN === true ||
    process.argv.includes("ios-bridge") ||
    process.env.ELIZA_DISABLE_DIRECT_RUN === "1"
  ) {
    return false;
  }
  const scriptArg = process.argv[1];
  if (!scriptArg) return false;
  const normalised = path.resolve(scriptArg);
  return import.meta.url === pathToFileURL(normalised).href;
})();

if (isDirectRun) {
  startEliza().catch((err) => {
    console.error(
      "[eliza] Fatal error:",
      err instanceof Error ? (err.stack ?? err.message) : err,
    );
    process.exit(1);
  });
}
