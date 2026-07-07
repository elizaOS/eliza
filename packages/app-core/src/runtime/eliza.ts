/**
 * App-core Eliza runtime loader: the single boot chokepoint every app-core agent
 * process funnels through. Wraps `@elizaos/agent`'s startEliza / bootElizaRuntime
 * with app-shell concerns — installs the agent host bridge (vault, account pool,
 * wallet-key hydration, cloud-pair route), syncs brand env aliases, binds the
 * API server (bind-first, then background runtime boot), and runs the post-ready
 * boot tail: local-inference + TTS handler registration, autonomy service +
 * bootstrap context, app-route plugins and registry runtime-hooks (drained
 * concurrently with per-loader failure isolation), sensitive-request + sub-agent
 * credential adapters, the trigger event bridge, connector-target catalog, and
 * background embedding + voice model warmup.
 *
 * Also owns PGlite startup-error normalization + auto-reset (quarantine a
 * corrupt `.elizadb` and retry once), the ELIZA_SKIP_APP_ROUTE_PLUGINS /
 * ELIZA_DEFER_APP_ROUTES boot knobs (the tail defers by default;
 * ELIZA_DEFER_APP_ROUTES=0 opts back into the inline pre-ready tail), the
 * local-agent IPC port gate (#12180), and a direct-run CLI (help/version) when
 * executed as a script. Mobile platforms take a trimmed boot path. Several seams
 * (PostReadyBootSteps, __setLatestBootTailRuntimeForTest) exist only for focused
 * unit tests.
 */
import "@elizaos/shared";
import { existsSync } from "node:fs";
import { rename } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import {
  type BootElizaRuntimeOptions,
  CUSTOM_PLUGINS_DIRNAME,
  getLastFailedPluginNames,
  loadElizaConfig,
  resolveDefaultAgentWorkspaceDir,
  resolvePackageEntry,
  resolveUserPath,
  type StartElizaOptions,
  scanDropInPlugins,
  applyCloudConfigToEnv as upstreamApplyCloudConfigToEnv,
  bootElizaRuntime as upstreamBootElizaRuntime,
  collectPluginNames as upstreamCollectPluginNames,
  configureLocalEmbeddingPlugin as upstreamConfigureLocalEmbeddingPlugin,
  shutdownRuntime as upstreamShutdownRuntime,
  startEliza as upstreamStartEliza,
} from "@elizaos/agent";
import { markDeferredBootPhase } from "@elizaos/agent/runtime/deferred-boot-status";
import { installAgentHostBridge } from "./install-agent-host-bridge.js";

export { CHANNEL_PLUGIN_MAP } from "./channel-plugin-map.js";

export { CUSTOM_PLUGINS_DIRNAME, resolvePackageEntry, scanDropInPlugins };

import {
  type AgentRuntime,
  AUTONOMY_SERVICE_TYPE,
  AutonomyService,
  ChannelType,
  CONNECTOR_TARGET_SOURCE_REGISTRY_SERVICE,
  isOptionalAppRoutePluginUnavailableError,
  isTruthyEnvValue,
  logger,
  ModelType,
  OptionalAppRoutePluginUnavailableError,
  type Plugin,
  stringToUuid,
  type TargetSource,
} from "@elizaos/core";
import { PGLITE_ERROR_CODES } from "@elizaos/plugin-sql";
import {
  ensureRuntimeSqlCompatibility,
  formatError,
  formatErrorWithStack,
  isMobilePlatform,
  readAliasedEnv,
  resolveApiExposePort,
  resolveDesktopApiPort,
  resolveServerOnlyPort,
  syncResolvedApiPort,
} from "@elizaos/shared";
import { getApps, getPlugins, loadRegistry } from "../registry";
import { registerSubAgentCredentialBridgeAdapter } from "../services/credential-tunnel-service";
import { registerCoreSensitiveRequestAdapters } from "../services/sensitive-requests/index.js";
import {
  type AppRoutePluginRegistryEntry,
  drainAppRoutePluginLoaders,
  listAppRoutePluginLoaders,
} from "./app-route-plugin-registry.js";
import { ensureBundledFusedLibDir } from "./bundled-fused-lib.js";
import { resetPluginSqlPgliteSingleton } from "./pglite-auto-reset.js";
import { registerSubAgentCredentialBridge } from "./sub-agent-credential-bridge-wiring.js";
import { shouldWarmupVoice, warmVoiceModels } from "./voice-warmup";

type EmbeddingProgressCallback = (
  phase: EmbeddingWarmupPhase,
  detail?: string,
) => void;

// plugin-local-inference loaded lazily to avoid static plugin boundary violations.
let _localInferenceRuntime:
  | typeof import("@elizaos/plugin-local-inference/runtime")
  | undefined;
async function _localInference() {
  if (!_localInferenceRuntime) {
    _localInferenceRuntime = await import(
      "@elizaos/plugin-local-inference/runtime"
    );
  }
  return _localInferenceRuntime;
}

import {
  getSharedCompatRuntimeState,
  patchHttpCreateServerForCompat,
  startApiServer,
} from "../api/server.js";

const _require = createRequire(import.meta.url);

import {
  isRuntimeBootDeferred,
  registerDeferredRuntimeBoot,
  shouldDeferRuntimeBootUntilOnboarding,
  triggerDeferredRuntimeBoot,
} from "../api/deferred-runtime-boot.js";
import { invalidateCorsAllowedPorts } from "../api/server-cors.js";
import { bootLap } from "../boot-profile.js";
import { isRuntimeAutonomyEnabled } from "./autonomy-policy.js";
import { ensureTextToSpeechHandler } from "./ensure-text-to-speech-handler.js";
import {
  type EmbeddingWarmupPhase,
  updateStartupEmbeddingProgress,
} from "./startup-overlay.js";

const AUTONOMY_WORLD_ID = stringToUuid("00000000-0000-0000-0000-000000000001");
const AUTONOMY_ENTITY_ID = stringToUuid("00000000-0000-0000-0000-000000000002");
const AUTONOMY_MESSAGE_SERVER_ID = stringToUuid("autonomy-message-server");

const require = createRequire(import.meta.url);
const DIRECT_HELP_FLAGS = new Set(["-h", "--help", "help"]);
const DIRECT_VERSION_FLAGS = new Set(["-v", "-V", "--version", "version"]);

export const shutdownRuntime = upstreamShutdownRuntime;

type ErrorWithCause = Error & {
  cause?: unknown;
  code?: unknown;
  dataDir?: unknown;
};

type AutonomyServiceLike = {
  enableAutonomy(): Promise<void>;
};

function isAutonomyService(value: unknown): value is AutonomyServiceLike {
  return (
    typeof value === "object" &&
    value !== null &&
    "enableAutonomy" in value &&
    typeof value.enableAutonomy === "function"
  );
}

/** Guards against registering signal handlers more than once. */
let signalHandlersRegistered = false;

interface EntityLike {
  id: string;
  agentId?: string;
  names?: string[];
  metadata?: Record<string, unknown>;
}

interface RuntimeAutonomyCompat {
  getEntityById?: (id: string) => Promise<EntityLike | null>;
  createEntity?: (entity: {
    id: string;
    names: string[];
    agentId: string;
    metadata?: Record<string, unknown>;
  }) => Promise<boolean>;
  updateEntity?: (entity: EntityLike & { agentId: string }) => Promise<boolean>;
  ensureWorldExists?: (world: {
    id: string;
    name: string;
    agentId: string;
    messageServerId?: string;
    metadata?: Record<string, unknown>;
  }) => Promise<unknown>;
  ensureRoomExists?: (room: {
    id: string;
    name: string;
    worldId: string;
    source: string;
    type: ChannelType;
    metadata?: Record<string, unknown>;
  }) => Promise<unknown>;
  ensureParticipantInRoom?: (
    entityId: string,
    roomId: string,
  ) => Promise<unknown>;
  addParticipant?: (entityId: string, roomId: string) => Promise<unknown>;
}

interface RuntimeAdapterAutonomyCompat {
  upsertEntities?: (
    entities: Array<{
      id: string;
      names: string[];
      agentId: string;
      metadata?: Record<string, unknown>;
    }>,
  ) => Promise<unknown>;
}

function getAutonomyService(runtime: AgentRuntime): AutonomyServiceLike | null {
  const svc =
    runtime.getService(AUTONOMY_SERVICE_TYPE) ?? runtime.getService("autonomy"); // Legacy lowercase serviceType fallback.
  if (isAutonomyService(svc)) {
    return svc;
  }
  return null;
}

async function startAndRegisterAutonomyService(
  runtime: AgentRuntime,
): Promise<AutonomyServiceLike> {
  const service = await AutonomyService.start(runtime);
  runtime.services.set(AUTONOMY_SERVICE_TYPE as never, [service as never]);
  return service;
}

export function collectPluginNames(
  ...args: Parameters<typeof upstreamCollectPluginNames>
): ReturnType<typeof upstreamCollectPluginNames> {
  return upstreamCollectPluginNames(...args);
}

export function applyCloudConfigToEnv(
  ...args: Parameters<typeof upstreamApplyCloudConfigToEnv>
): ReturnType<typeof upstreamApplyCloudConfigToEnv> {
  return upstreamApplyCloudConfigToEnv(...args);
}

async function ensureAutonomyBootstrapContext(
  runtime: AgentRuntime,
): Promise<void> {
  const runtimeWithCompat = runtime as AgentRuntime & RuntimeAutonomyCompat;
  const adapter = runtime.adapter as RuntimeAdapterAutonomyCompat | undefined;
  const autonomousRoomId = stringToUuid(`autonomy-room-${runtime.agentId}`);

  await runtimeWithCompat.ensureWorldExists({
    id: AUTONOMY_WORLD_ID,
    name: "Autonomy World",
    agentId: runtime.agentId,
    messageServerId: AUTONOMY_MESSAGE_SERVER_ID,
    metadata: {
      type: "autonomy",
      description: "World for autonomous agent thinking",
    },
  });

  await runtimeWithCompat.ensureRoomExists({
    id: autonomousRoomId,
    name: "Autonomous Thoughts",
    worldId: AUTONOMY_WORLD_ID,
    source: "autonomy-service",
    type: ChannelType.SELF,
    metadata: {
      source: "autonomy-service",
      description: "Room for autonomous agent thinking",
    },
  });

  const autonomyEntity = {
    id: AUTONOMY_ENTITY_ID,
    names: ["Autonomy"],
    agentId: runtime.agentId,
    metadata: {
      type: "autonomy",
      description: "Dedicated entity for autonomy service prompts",
    },
  };
  const existingEntity =
    (await runtimeWithCompat.getEntityById(AUTONOMY_ENTITY_ID)) ?? null;

  if (!existingEntity) {
    const created = await runtimeWithCompat.createEntity(autonomyEntity);
    if (!created && adapter?.upsertEntities) {
      await adapter.upsertEntities([autonomyEntity]);
    }
  } else if (existingEntity.agentId !== runtime.agentId) {
    if (runtimeWithCompat.updateEntity) {
      await runtimeWithCompat.updateEntity({
        ...existingEntity,
        agentId: runtime.agentId,
      });
    } else if (adapter?.upsertEntities) {
      await adapter.upsertEntities([
        {
          id: existingEntity.id ?? AUTONOMY_ENTITY_ID,
          names:
            existingEntity.names && existingEntity.names.length > 0
              ? existingEntity.names
              : autonomyEntity.names,
          agentId: runtime.agentId,
          metadata: {
            ...autonomyEntity.metadata,
            ...(existingEntity.metadata ?? {}),
          },
        },
      ]);
    }
  }

  if (runtimeWithCompat.ensureParticipantInRoom) {
    await runtimeWithCompat.ensureParticipantInRoom(
      runtime.agentId,
      autonomousRoomId,
    );
    await runtimeWithCompat.ensureParticipantInRoom(
      AUTONOMY_ENTITY_ID,
      autonomousRoomId,
    );
  } else if (runtimeWithCompat.addParticipant) {
    await runtimeWithCompat.addParticipant(runtime.agentId, autonomousRoomId);
    await runtimeWithCompat.addParticipant(
      AUTONOMY_ENTITY_ID,
      autonomousRoomId,
    );
  }
}

// ---------------------------------------------------------------------------
// App route plugins
// ---------------------------------------------------------------------------

type AppRoutePluginModule = Record<string, unknown>;

function splitPackageSpecifier(specifier: string): {
  packageName: string;
  exportSubpath: string;
} | null {
  const parts = specifier.split("/");
  if (specifier.startsWith("@")) {
    if (parts.length < 2) return null;
    return {
      packageName: `${parts[0]}/${parts[1]}`,
      exportSubpath: parts.length > 2 ? `./${parts.slice(2).join("/")}` : ".",
    };
  }
  if (!parts[0]) return null;
  return {
    packageName: parts[0],
    exportSubpath: parts.length > 1 ? `./${parts.slice(1).join("/")}` : ".",
  };
}

async function resolveLocalAppRoutePluginEntry(
  specifier: string,
): Promise<string | null> {
  const parsed = splitPackageSpecifier(specifier);
  if (!parsed) return null;

  let packageJsonPath: string;
  try {
    packageJsonPath = _require.resolve(`${parsed.packageName}/package.json`);
  } catch {
    return null;
  }

  const entry = await resolvePackageEntry(
    path.dirname(packageJsonPath),
    parsed.exportSubpath,
  );
  return existsSync(entry) ? entry : null;
}

function isPlugin(value: unknown): value is Plugin {
  return (
    typeof value === "object" &&
    value !== null &&
    "name" in value &&
    typeof (value as { name?: unknown }).name === "string"
  );
}

function resolvePluginExport(
  module: AppRoutePluginModule,
  exportName: string | undefined,
): Plugin {
  if (exportName) {
    const plugin = module[exportName];
    if (isPlugin(plugin)) return plugin;
    throw new Error(`Missing plugin export "${exportName}"`);
  }

  const defaultExport = module.default;
  if (isPlugin(defaultExport)) return defaultExport;

  for (const value of Object.values(module)) {
    if (isPlugin(value)) return value;
  }

  throw new Error("No plugin export found");
}

/**
 * Import an app module by package specifier, with a workspace-source fallback
 * for local/source mode. Throws {@link OptionalAppRoutePluginUnavailableError}
 * when the package is genuinely absent (an optional plugin not installed in this
 * deployment); rethrows any real load failure (syntax error, init throw, broken
 * transitive dependency) so it is never misreported as "not installed". Shared
 * by the route-plugin loader and the runtime-hook loader.
 */
async function importAppModuleFromSpecifier(
  specifier: string,
): Promise<AppRoutePluginModule> {
  try {
    return (await import(
      /* webpackIgnore: true */ specifier
    )) as AppRoutePluginModule;
  } catch (err) {
    if (!isModuleNotFoundError(err)) throw err;
    const sourceEntry = await resolveLocalAppRoutePluginEntry(specifier);
    if (!sourceEntry) {
      throw new OptionalAppRoutePluginUnavailableError(specifier, err);
    }
    logger.debug(
      `[eliza] Loading app module ${specifier} from workspace source at ${sourceEntry}`,
    );
    return (await import(
      pathToFileURL(sourceEntry).href
    )) as AppRoutePluginModule;
  }
}

async function loadAppRoutePluginFromSpecifier(
  specifier: string,
  exportName: string | undefined,
): Promise<Plugin> {
  const module = await importAppModuleFromSpecifier(specifier);
  return resolvePluginExport(module, exportName);
}

/** @internal Exported for focused loader regression tests. */
export const __loadAppRoutePluginFromSpecifierForTest =
  loadAppRoutePluginFromSpecifier;

function getRegistryAppRoutePluginLoaders(): AppRoutePluginRegistryEntry[] {
  return getApps(loadRegistry()).flatMap((app) => {
    const routePlugin = app.launch.routePlugin;
    if (!routePlugin) return [];
    return [
      {
        id: app.npmName ?? app.id,
        load: () =>
          loadAppRoutePluginFromSpecifier(
            routePlugin.specifier,
            routePlugin.exportName,
          ),
      },
    ];
  });
}

/**
 * Opt-in dev knob: comma-separated app-route-plugin ids to skip on boot.
 * Empty / unset => no filtering (default behavior unchanged: every app-route
 * plugin loads). This trims time-to-ready for core/runtime work by not
 * transpiling + registering hundreds of feature routes a core dev does not
 * exercise.
 *
 * A loader's id is its full package name (e.g. `@elizaos/plugin-personal-assistant`,
 * `@elizaos/plugin-elizacloud:routes`). Tokens
 * are matched against BOTH the full id and a normalized short alias
 * (see {@link normalizeAppRoutePluginId}), so the ergonomic short forms work
 * too: `ELIZA_SKIP_APP_ROUTE_PLUGINS=lifeops,training,shopify`.
 */
export function getSkippedAppRoutePluginIds(): Set<string> {
  return new Set(
    (process.env.ELIZA_SKIP_APP_ROUTE_PLUGINS ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
  );
}

/**
 * Whether the post-ready boot tail (app-route plugins, training hooks,
 * sensitive-request adapters, telegram polling, trigger bridge, connector
 * catalog, voice warmup) runs in the background instead of blocking the
 * readiness gate. Deferred by DEFAULT: `/api/health` flips `ready:true` and
 * "Agent ready" prints before the tail's ~11 app-route dynamic imports
 * (lifeops alone registers 188 routes) finish, so feature routes can 404 for
 * a sub-second-to-few-second window right after ready. Consumers that need
 * those routes poll `/api/health` for `deferredBoot.settled` (this tail
 * reports as phase `app-route-tail`) instead of sleeping.
 *
 * Opt out with `ELIZA_DEFER_APP_ROUTES=0|false|no|off` to await the tail
 * inline before ready — the pre-deferral boot shape, for callers that must
 * have every feature route mounted at ready and accept the slower
 * time-to-ready. Any other value (unset, `""`, `"1"`, `"true"`) defers.
 * Composes with {@link getSkippedAppRoutePluginIds}:
 * `ELIZA_SKIP_APP_ROUTE_PLUGINS` filters WHICH route plugins load; this
 * controls WHETHER the tail blocks ready.
 */
export function getDeferAppRoutesEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const raw = env.ELIZA_DEFER_APP_ROUTES?.trim().toLowerCase();
  return !(raw === "0" || raw === "false" || raw === "no" || raw === "off");
}

/**
 * Normalize an app-route-plugin id (or a user-supplied skip token) to a short
 * alias for forgiving matching: lowercase, drop the `@elizaos/plugin-` prefix
 * and the `:routes` / `-app` / `-ui` / `-routes` suffixes. So
 * `@elizaos/plugin-wallet-ui` and `wallet` both normalize to `wallet`.
 */
export function normalizeAppRoutePluginId(id: string): string {
  return id
    .trim()
    .toLowerCase()
    .replace(/^@elizaos\/plugin-/, "")
    .replace(/:routes$/, "")
    .replace(/-(app|ui|routes)$/, "");
}

function getAppRoutePluginLoaders(): AppRoutePluginRegistryEntry[] {
  const byId = new Map<string, AppRoutePluginRegistryEntry>();
  for (const entry of getRegistryAppRoutePluginLoaders()) {
    byId.set(entry.id, entry);
  }
  for (const entry of listAppRoutePluginLoaders()) {
    byId.set(entry.id, entry);
  }

  const skip = getSkippedAppRoutePluginIds();
  if (skip.size === 0) {
    return [...byId.values()];
  }

  // Match a loader against the skip tokens by full id OR normalized short alias
  // (so both `@elizaos/plugin-wallet-ui` and `wallet` skip the same loader).
  const skipNormalized = new Set(
    [...skip].map((token) => normalizeAppRoutePluginId(token)),
  );
  const kept: AppRoutePluginRegistryEntry[] = [];
  const skipped: string[] = [];
  for (const entry of byId.values()) {
    if (
      skip.has(entry.id) ||
      skipNormalized.has(normalizeAppRoutePluginId(entry.id))
    ) {
      skipped.push(entry.id);
    } else {
      kept.push(entry);
    }
  }
  if (skipped.length > 0) {
    logger.info(
      `[eliza] Skipping ${skipped.length} app route plugin(s) via ELIZA_SKIP_APP_ROUTE_PLUGINS: ${skipped.join(", ")}`,
    );
  }
  return kept;
}

async function registerAppRoutePlugins(runtime: AgentRuntime): Promise<void> {
  // App-route plugins register a loader on a global registry (so they survive
  // bundler tree-shaking) rather than exposing routes through Plugin.routes.
  // getAppRoutePluginLoaders() resolves the curated registry-app loaders plus
  // the globally-registered ones, minus any skipped via
  // ELIZA_SKIP_APP_ROUTE_PLUGINS. The shared core drain loads them concurrently
  // — overlapping ~11 independent dynamic imports (lifeops alone registers 188
  // routes) on the gated ready-path instead of serializing them — applies them
  // in loader order with per-loader failure isolation, and pushes their rawPath
  // routes onto runtime.routes with a type:path dedup. That dedup is what lets
  // the headless @elizaos/agent boot (which also drains this registry) and this
  // app-core boot run against the same runtime.routes without double-mounting.
  await drainAppRoutePluginLoaders(runtime, getAppRoutePluginLoaders());
}

/**
 * Returns true only for genuine "module is not installed" import failures.
 * Bun raises `ResolveMessage` with `code === "ERR_MODULE_NOT_FOUND"` when a
 * specifier cannot be resolved; Node uses the same `code`. Anything else
 * (syntax error, runtime error during module init, tsconfig path hijack,
 * missing transitive dependency) is a real load failure and must NOT be
 * misreported as "not installed".
 */
function isModuleNotFoundError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const errObj = err as { code?: unknown; constructor?: { name?: string } };
  if (errObj.code === "ERR_MODULE_NOT_FOUND") return true;
  if (errObj.constructor?.name === "ResolveMessage") return true;
  return false;
}

/**
 * A runtime-hook contributor: an app's optional post-ready wiring step. `invoke`
 * loads the app's declared hook module and calls it with the runtime. Resolved
 * from the registry ({@link getRuntimeHookContributors}) — no feature plugin is
 * hard-wired by name here; the host drains whatever apps declare a `runtimeHook`.
 */
interface RuntimeHookContributor {
  id: string;
  invoke: (runtime: AgentRuntime) => Promise<void>;
}

type RuntimeHookFn = (runtime: AgentRuntime) => void | Promise<void>;

/**
 * Load an app's runtime-hook export by specifier and invoke it. Uses the shared
 * {@link importAppModuleFromSpecifier}, so an absent optional plugin surfaces as
 * {@link OptionalAppRoutePluginUnavailableError} (a graceful skip in the drain)
 * while a real load failure or a missing/wrong-typed export throws.
 */
async function loadAndInvokeRuntimeHook(
  specifier: string,
  exportName: string,
  runtime: AgentRuntime,
): Promise<void> {
  const module = await importAppModuleFromSpecifier(specifier);
  const hook = module[exportName];
  if (typeof hook !== "function") {
    throw new Error(
      `[eliza] ${specifier} did not export a runtime-hook function "${exportName}"`,
    );
  }
  await (hook as RuntimeHookFn)(runtime);
}

/**
 * Resolve every app that declares a `runtimeHook` in the registry into a
 * contributor. Data-driven and generic: the registry owns the package bindings
 * (each plugin self-declares its hook in its own `registry-entry.json`), so the
 * boot tail names no plugin.
 */
function getRuntimeHookContributors(): RuntimeHookContributor[] {
  return getApps(loadRegistry()).flatMap((app) => {
    const runtimeHook = app.launch.runtimeHook;
    if (!runtimeHook) return [];
    return [
      {
        id: app.npmName ?? app.id,
        invoke: (runtime: AgentRuntime) =>
          loadAndInvokeRuntimeHook(
            runtimeHook.specifier,
            runtimeHook.exportName,
            runtime,
          ),
      },
    ];
  });
}

/**
 * Drain runtime-hook contributors in order, invoking each against the runtime.
 * An optional plugin that is not installed is skipped gracefully (debug-logged);
 * any real failure is logged and rethrown so a broken hook is never mistaken for
 * a benign absence. Exported for a focused unit test of the generic channel.
 */
export async function drainRuntimeHookContributors(
  runtime: AgentRuntime,
  contributors: RuntimeHookContributor[],
): Promise<void> {
  for (const { id, invoke } of contributors) {
    try {
      await invoke(runtime);
    } catch (err) {
      if (isOptionalAppRoutePluginUnavailableError(err)) {
        logger.debug(
          `[eliza] Runtime-hook contributor ${id} unavailable, skipping`,
        );
        continue;
      }
      logger.error(
        `[eliza] Runtime-hook contributor ${id} failed: ${formatErrorWithStack(err)}`,
      );
      throw err;
    }
  }
}

async function registerRuntimeHooks(runtime: AgentRuntime): Promise<void> {
  await drainRuntimeHookContributors(runtime, getRuntimeHookContributors());
}

/**
 * A PRE-READY boot-hook contributor: an app/plugin's optional init step run at a
 * fixed point in {@link repairRuntimeAfterBoot}, BEFORE the runtime is marked
 * ready, to install handlers / warm subsystems that must exist before the first
 * turn (e.g. the local model handler). `invoke` loads the declared hook module
 * and calls it with the runtime. Resolved from the registry ({@link
 * getBootHookContributors}) — no feature plugin is hard-wired by name here; the
 * host drains whatever entries declare a `bootHook`. Parallel to {@link
 * RuntimeHookContributor}, but pre-ready instead of post-ready.
 */
interface BootHookContributor {
  id: string;
  invoke: (runtime: AgentRuntime) => Promise<void>;
}

/**
 * LEGACY host-owned fallback for plugin-local-inference's pre-ready boot hook.
 *
 * The canonical source of this binding is the plugin's own `registry-entry.json`
 * (`launch.bootHook`), resolved data-driven by {@link getBootHookContributors}.
 * But a packaged build can ship WITHOUT the aggregated
 * `@elizaos/registry/first-party/generated.json`; in that case `loadRegistry()`
 * intentionally returns an EMPTY registry (it logs and continues rather than
 * crashing the agent — see `readEntriesFromDisk`). Without this fallback the
 * resolver would then yield no contributors and the local model handlers would
 * never install — a regression from the previous hard-wired path, which always
 * installed them regardless of registry presence. So when the registry does not
 * supply the local-inference boot hook, we fall back to this explicitly-marked
 * legacy host-owned binding. `importAppModuleFromSpecifier` still treats an
 * actually-absent optional plugin as a graceful skip, so this is safe on
 * deployments that ship no local-inference at all.
 */
const LEGACY_LOCAL_INFERENCE_BOOT_HOOK = {
  id: "@elizaos/plugin-local-inference",
  specifier: "@elizaos/plugin-local-inference/runtime",
  exportName: "registerLocalInferenceBoot",
} as const;

/**
 * Resolve every registry entry (app OR plugin) that declares a `bootHook` into a
 * contributor. Data-driven and generic: the registry owns the package bindings
 * (each plugin self-declares its hook in its own `registry-entry.json`), so the
 * boot path names no plugin. Scans both apps and plugins because a pre-ready
 * boot hook typically belongs to a provider plugin (e.g. plugin-local-inference)
 * rather than a launchable app.
 *
 * When the registry does not supply the local-inference boot hook (e.g. a
 * packaged build shipped without `generated.json`, so `loadRegistry()` is
 * empty), the {@link LEGACY_LOCAL_INFERENCE_BOOT_HOOK} fallback is appended so
 * the local model handlers still install — preserving the pre-migration
 * guarantee. The registry entry, when present, takes precedence (deduped by id).
 */
function getBootHookContributors(): BootHookContributor[] {
  const registry = loadRegistry();
  // Extract just the boot-hook shape from each entry at the call site (an
  // explicit projection off the wide AppEntry/PluginEntry union) so the pure
  // resolver takes a narrow, test-friendly declaration type — no wide-union
  // assignability coupling.
  const declarations: BootHookDeclaration[] = [];
  for (const entry of [...getApps(registry), ...getPlugins(registry)]) {
    const bootHook = entry.launch?.bootHook;
    if (!bootHook) continue;
    declarations.push({
      id: entry.npmName ?? entry.id,
      specifier: bootHook.specifier,
      exportName: bootHook.exportName,
    });
  }
  return resolveBootHookContributors(declarations);
}

/**
 * A registry entry's projected boot-hook declaration: the resolved contributor
 * id plus the module specifier/export the host loads and invokes. Projected off
 * the wide registry entry union by {@link getBootHookContributors} so the
 * resolver stays decoupled from the full entry type.
 */
interface BootHookDeclaration {
  id: string;
  specifier: string;
  exportName: string;
}

/**
 * Pure resolver for the boot-hook contributors, split out so a focused unit test
 * can drive it with hand-built declarations (empty registry, registry-declared
 * entry, both) without loading the real registry. Registry-declared boot hooks
 * win by id; the {@link LEGACY_LOCAL_INFERENCE_BOOT_HOOK} fallback is appended
 * only when the registry did not already supply the local-inference boot hook.
 */
export function resolveBootHookContributors(
  declarations: BootHookDeclaration[],
): BootHookContributor[] {
  const byId = new Map<string, BootHookContributor>();
  for (const { id, specifier, exportName } of declarations) {
    byId.set(id, {
      id,
      invoke: (runtime: AgentRuntime) =>
        loadAndInvokeRuntimeHook(specifier, exportName, runtime),
    });
  }

  // Legacy host-owned fallback: only when the registry did not already declare
  // the local-inference boot hook (registry entry wins when present).
  if (!byId.has(LEGACY_LOCAL_INFERENCE_BOOT_HOOK.id)) {
    byId.set(LEGACY_LOCAL_INFERENCE_BOOT_HOOK.id, {
      id: LEGACY_LOCAL_INFERENCE_BOOT_HOOK.id,
      invoke: (runtime: AgentRuntime) =>
        loadAndInvokeRuntimeHook(
          LEGACY_LOCAL_INFERENCE_BOOT_HOOK.specifier,
          LEGACY_LOCAL_INFERENCE_BOOT_HOOK.exportName,
          runtime,
        ),
    });
  }

  return [...byId.values()];
}

/**
 * Drain pre-ready boot-hook contributors in order, invoking each against the
 * runtime. An optional plugin that is not installed is skipped gracefully
 * (debug-logged); any real failure is logged and rethrown so a broken hook is
 * never mistaken for a benign absence — matching the fixed if-chain it replaces,
 * which would have thrown at that step. Exported for a focused unit test of the
 * generic channel.
 */
export async function drainBootHookContributors(
  runtime: AgentRuntime,
  contributors: BootHookContributor[],
): Promise<void> {
  for (const { id, invoke } of contributors) {
    try {
      await invoke(runtime);
    } catch (err) {
      if (isOptionalAppRoutePluginUnavailableError(err)) {
        logger.debug(
          `[eliza] Boot-hook contributor ${id} unavailable, skipping`,
        );
        continue;
      }
      logger.error(
        `[eliza] Boot-hook contributor ${id} failed: ${formatErrorWithStack(err)}`,
      );
      throw err;
    }
  }
}

/**
 * Run the registry-declared pre-ready boot hooks. Replaces the hard-wired
 * `@elizaos/plugin-local-inference/runtime` internals that used to be called at
 * fixed init points in {@link repairRuntimeAfterBoot} (arch-audit #12089 item
 * 18): the local-inference boot (mobile-gate warning + platform-appropriate
 * model-handler registration) is now owned by the plugin's `registerLocalInferenceBoot`
 * hook, declared in its `registry-entry.json` and drained here by data.
 */
async function runBootHooks(runtime: AgentRuntime): Promise<void> {
  await drainBootHookContributors(runtime, getBootHookContributors());
}

// The most recent runtime handed to the post-ready boot tail. A backgrounded
// (deferred) tail compares against this so a hot-restart that boots a newer
// runtime supersedes the old one's still-running tail, preventing route/service
// registration onto a torn-down runtime. In the default inline-await path the
// tail completes before the next repair call reassigns this, so the guard never
// trips and default behavior stays byte-identical.
let latestBootTailRuntime: AgentRuntime | null = null;

async function repairRuntimeAfterBoot(
  runtime: AgentRuntime,
): Promise<AgentRuntime> {
  await ensureRuntimeSqlCompatibility(runtime);

  // Make the app-bundled fused libelizainference (staged into the desktop
  // package) discoverable before any local-inference handler probes
  // `supported()`. No-op in dev / on mobile and when an explicit override is
  // set. Must run before the boot hooks (which install the local-inference
  // handler) below.
  ensureBundledFusedLibDir();

  // Pre-ready boot hooks: registry-declared init steps that must run before the
  // runtime is marked ready (e.g. installing the local model handler so it's
  // present for the first turn). This is where plugin-local-inference's boot
  // now lives — the mobile-voice-invariant warning + the platform-appropriate
  // model-handler registration are owned by its `registerLocalInferenceBoot`
  // hook (declared in registry-entry.json), NOT hard-wired here by name
  // (arch-audit #12089 item 18). The hook owns its platform gating, so it runs
  // identically on mobile (gated handler-ensure) and desktop (unconditional
  // handler-ensure), and emits the mobile-gate warning regardless of platform —
  // matching the previous fixed-point ordering exactly.
  await runBootHooks(runtime);

  // Mobile (Android / iOS) shortcut: the runtime is already serving from
  // PGlite + the AI provider plugin. The remaining boot steps either spawn
  // subprocesses (workflow runtime, telegram polling), shell
  // out to platform-specific binaries (text-to-speech, local inference), or
  // dynamic-import optional packages that are not in the mobile bundle
  // (registered app route plugins and app runtime hooks). Skipping
  // them here is what the mobile bundle has to do to avoid crashing on first
  // turn — feature parity comes from cloud-side services, not on-device state.
  // (The local model handler, when a mobile-safe backend is wired, was already
  // installed by the boot hooks above.)
  if (isMobilePlatform()) {
    logger.info(
      "[eliza] Mobile platform detected — skipping desktop-only boot helpers",
    );
    return runtime;
  }

  const autonomyLoopEnabled = isRuntimeAutonomyEnabled(process.env);
  if (autonomyLoopEnabled) {
    await ensureAutonomyBootstrapContext(runtime);
  } else {
    logger.info(
      "[eliza] Autonomy bootstrap deferred — autonomous loop disabled",
    );
  }

  if (!runtime.getService(AUTONOMY_SERVICE_TYPE)) {
    try {
      await startAndRegisterAutonomyService(runtime);
      logger.info("[eliza] AutonomyService started and waiting");
    } catch (error) {
      throw new Error(
        `[eliza] AutonomyService start failed: ${formatError(error)}`,
      );
    }
  }

  // Enable the continuous autonomy loop only when explicitly requested.
  if (autonomyLoopEnabled) {
    const autonomySvc = getAutonomyService(runtime);
    if (autonomySvc) {
      try {
        await autonomySvc.enableAutonomy();
        logger.info(
          "[eliza] AutonomyService enabled — trigger instructions will be processed",
        );
      } catch (err) {
        throw new Error(
          `[eliza] Failed to enable autonomy loop: ${formatError(err)}`,
        );
      }
    }
  } else {
    logger.info(
      "[eliza] AutonomyService waiting — set ENABLE_AUTONOMY=true to start autonomous loop",
    );
  }

  // Post-ready tail: feature-route plugins, training hooks, sensitive-request
  // adapters, telegram polling, the trigger bridge, the connector catalog, and
  // voice warmup. None of these gate correctness of the first turn, so by
  // default they run in the background and ready flips before the tail
  // completes (feature routes may 404 for a brief window — poll /api/health
  // `deferredBoot.settled` before hitting them). ELIZA_DEFER_APP_ROUTES=0
  // opts back into awaiting the tail inline, identical in steps and order to
  // the pre-split path. The phase is marked pending before ready can flip so
  // a health probe never reads a not-yet-announced tail as settled.
  latestBootTailRuntime = runtime;
  markDeferredBootPhase("app-route-tail", "pending");
  if (getDeferAppRoutesEnabled()) {
    void runPostReadyBootTail(runtime).catch((err: unknown) => {
      // error-policy:J1 boundary translation — the deferred tail has no caller
      // left to throw to; a TTS-handler or runtime-hook failure here would
      // otherwise vanish into an unhandled rejection. Mark the phase failed
      // (so health-pollers stop waiting) and surface it agent-visibly.
      markDeferredBootPhase("app-route-tail", "failed");
      logger.error(
        `[eliza] post-ready boot tail failed: ${formatErrorWithStack(err)}`,
      );
      runtime.reportError("eliza.postReadyBootTail", err, {
        phase: "app-route-tail",
      });
    });
    return runtime;
  }
  try {
    await runPostReadyBootTail(runtime);
  } catch (err) {
    // error-policy:J2 context-preserving rethrow — inline mode keeps the
    // pre-split contract (a tail failure fails the boot); only the phase
    // marker is updated so health never reports a failed tail as pending.
    markDeferredBootPhase("app-route-tail", "failed");
    throw err;
  }
  return runtime;
}

/**
 * The post-ready boot steps, named so a focused unit test can inject stubs and
 * assert ordering / deferral / liveness / error-isolation without loading the
 * full runtime. Production passes {@link DEFAULT_POST_READY_BOOT_STEPS}.
 */
export interface PostReadyBootSteps {
  ensureTextToSpeechHandler: (runtime: AgentRuntime) => Promise<void>;
  registerAppRoutePlugins: (runtime: AgentRuntime) => Promise<void>;
  registerRuntimeHooks: (runtime: AgentRuntime) => Promise<void>;
  registerCoreSensitiveRequestAdapters: (runtime: AgentRuntime) => void;
  registerSubAgentCredentialBridge: (runtime: AgentRuntime) => Promise<void>;
  registerSubAgentCredentialBridgeAdapter: (runtime: AgentRuntime) => boolean;
  ensureTriggerEventBridge: (runtime: AgentRuntime) => Promise<void>;
  ensureConnectorTargetCatalog: (runtime: AgentRuntime) => Promise<void>;
  startDeferredVoiceWarmup: (runtime: AgentRuntime) => void;
}

const DEFAULT_POST_READY_BOOT_STEPS: PostReadyBootSteps = {
  ensureTextToSpeechHandler,
  registerAppRoutePlugins,
  registerRuntimeHooks,
  registerCoreSensitiveRequestAdapters,
  registerSubAgentCredentialBridge,
  registerSubAgentCredentialBridgeAdapter,
  ensureTriggerEventBridge,
  ensureConnectorTargetCatalog,
  startDeferredVoiceWarmup,
};

/**
 * Post-ready boot steps split out of {@link repairRuntimeAfterBoot}. Each step
 * keeps its original error behavior verbatim — there is no wrapping try/catch:
 * registerAppRoutePlugins isolates per-loader failures internally,
 * ensureTriggerEventBridge / ensureConnectorTargetCatalog swallow into
 * logger.warn internally, and ensureTextToSpeechHandler / registerRuntimeHooks
 * throw (preserved in the default inline-await dispatch above).
 *
 * `steps` defaults to the real bound functions, so production behavior is
 * unchanged; the seam exists only so the phase split is unit-testable.
 */
export async function runPostReadyBootTail(
  runtime: AgentRuntime,
  steps: PostReadyBootSteps = DEFAULT_POST_READY_BOOT_STEPS,
): Promise<void> {
  // Liveness guard: a hot-restart can swap runtimes mid-tail. If a newer boot
  // has already claimed the tail slot, this runtime is superseded — bail before
  // the first mutation so we never register routes/services onto a torn-down
  // runtime. (In the default inline-await path the tail completes before the
  // next repair call reassigns the slot, so this never trips.)
  if (latestBootTailRuntime !== runtime) {
    logger.info("[eliza] post-ready boot tail skipped — runtime superseded");
    return;
  }

  await steps.ensureTextToSpeechHandler(runtime);

  // ── Register app-specific route plugins ─────────────────────────────
  // The registry and explicit registration API own the package bindings; the
  // runtime only consumes app route plugin loaders.
  await steps.registerAppRoutePlugins(runtime);

  // Drain runtime-hook contributors: apps that declare a `runtimeHook` in the
  // registry wire runtime-only concerns (services, crons, background bootstraps)
  // that never reach the route table. Generic + data-driven — no feature plugin
  // is named here. An uninstalled optional plugin is skipped gracefully.
  await steps.registerRuntimeHooks(runtime);

  // Register first-party sensitive-request delivery adapters with the
  // dispatch registry (no-op when the registry service isn't present).
  steps.registerCoreSensitiveRequestAdapters(runtime);
  steps.registerSubAgentCredentialBridgeAdapter(runtime);

  // Wire the sub-agent credential bridge (#10317) onto parent runtimes that can
  // host coding sub-agents. No-op on child/sandboxed runtimes.
  await steps.registerSubAgentCredentialBridge(runtime);

  // Subscribe the trigger event bridge to the runtime event bus so
  // event-kind triggers fire on real MESSAGE_RECEIVED / REACTION_RECEIVED /
  // etc. emissions. plugin-workflow registers WORKFLOW_DISPATCH in its `init`
  // so by the time the bridge starts, workflow-kind event triggers already
  // have a dispatcher to call.
  await steps.ensureTriggerEventBridge(runtime);

  await steps.ensureConnectorTargetCatalog(runtime);

  // Warm local voice models (Whisper STT + Kokoro TTS) in the background now
  // that the runtime is ready. repairRuntimeAfterBoot is the single chokepoint
  // every boot path funnels through (bootElizaRuntime AND startEliza's
  // server-only + restart paths), so the warmup fires regardless of entry
  // point. Fire-and-forget; gated + non-fatal inside startDeferredVoiceWarmup.
  void steps.startDeferredVoiceWarmup(runtime);

  // Marked here — not at the dispatch site — so a superseded tail (early
  // return above) never stamps `complete` over the newer boot's `pending`.
  markDeferredBootPhase("app-route-tail", "complete");
}

/**
 * Test seam: set the runtime that owns the post-ready tail slot. Mirrors what
 * {@link repairRuntimeAfterBoot} does just before dispatching the tail, so a
 * unit test can drive the liveness guard without a full boot.
 */
export function __setLatestBootTailRuntimeForTest(
  runtime: AgentRuntime | null,
): void {
  latestBootTailRuntime = runtime;
}

// Module-level handle for the trigger event bridge. Reset across
// hot-reloads so we never leave two handler sets racing the runtime's
// event bus.
let _triggerEventBridge: { stop: () => void } | null = null;

// Module-level handle for the connector-target-catalog service.
let _connectorTargetCatalog: { stop: () => void } | null = null;

const CONNECTOR_TARGET_CATALOG_SERVICE_TYPE = "connector_target_catalog";

async function ensureTriggerEventBridge(runtime: AgentRuntime): Promise<void> {
  if (_triggerEventBridge) {
    try {
      _triggerEventBridge.stop();
    } catch {
      /* ignore */
    }
    _triggerEventBridge = null;
  }
  try {
    const { startTriggerEventBridge } = await import(
      "../services/trigger-event-bridge.js"
    );
    _triggerEventBridge = startTriggerEventBridge(runtime);
    logger.info("[eliza] trigger event bridge armed");
  } catch (err) {
    logger.warn(
      `[eliza] Failed to start trigger event bridge: ${formatError(err)}`,
    );
  }
}

async function ensureConnectorTargetCatalog(
  runtime: AgentRuntime,
): Promise<void> {
  if (_connectorTargetCatalog) {
    try {
      _connectorTargetCatalog.stop();
    } catch {
      /* ignore */
    }
    _connectorTargetCatalog = null;
  }
  try {
    const { createElizaConnectorTargetCatalog } = await import(
      "../services/connector-target-catalog.js"
    );
    const catalog = createElizaConnectorTargetCatalog({
      getConfig: () => loadElizaConfig(),
      listSources: () => {
        const registry = runtime.getService(
          CONNECTOR_TARGET_SOURCE_REGISTRY_SERVICE,
        ) as { list(): TargetSource[] } | null;
        return registry?.list() ?? [];
      },
      logger: { warn: runtime.logger.warn.bind(runtime.logger) },
    });
    runtime.services.set(CONNECTOR_TARGET_CATALOG_SERVICE_TYPE as never, [
      catalog as never,
    ]);
    _connectorTargetCatalog = {
      stop: () => {
        try {
          runtime.services.delete(
            CONNECTOR_TARGET_CATALOG_SERVICE_TYPE as never,
          );
        } catch {
          /* ignore */
        }
      },
    };
    logger.info("[eliza] connector-target-catalog registered");
  } catch (err) {
    logger.warn(
      `[eliza] Failed to register connector-target-catalog: ${formatError(
        err,
      )}`,
    );
  }
}

/**
 * Eagerly download the embedding model file if not already present.
 * This ensures the GGUF is on disk before the runtime's first
 * generateEmbedding() call, avoiding a silent stall on first use.
 *
 * Uses the same env resolution as `configureLocalEmbeddingPlugin` (eliza.json
 * `embedding` + hardware tier). Warmup previously always used tier-only presets,
 * so a custom `embedding.model` caused a first download here and a *second*
 * download when the plugin looked for a different filename — nothing deleted
 * the first file; it was simply the wrong path/name.
 *
 * If the configured GGUF is **not** on disk but another known embedding file
 * already exists in `MODELS_DIR`, we align `LOCAL_EMBEDDING_*` with that file
 * so we do not re-download multi‑GB models. Opt out:
 * `ELIZA_EMBEDDING_WARMUP_NO_REUSE=1`.
 */
// In-flight promise cache so concurrent callers (bootElizaRuntime +
// startEliza both run on agent boot) share a single download. Without this,
// two `fs.createWriteStream(dest)` open the same GGUF target concurrently,
// and the first to fail calls `safeUnlink(dest)` — which deletes the file
// out from under the second's pending write. Downstream `llama.loadModel`
// then opens the now-missing file and throws ENOENT, which surfaces as an
// uncaughtException and kills the agent.
let warmupInFlight: Promise<void> | null = null;

// Deferred by DEFAULT: the process-entry warmup fired a GGUF download +
// hardware probe before the readiness gate on every CLI/server boot, while
// the agent's deferred wave (startEmbeddingWarmup in @elizaos/agent) and the
// dev-server ready hook already warm the same model after ready — and the
// warmup self-skips when cloud embeddings are active. Only an explicit
// falsy ELIZA_DEFER_LOCAL_EMBEDDING_WARMUP (0/false/no/off) restores the
// eager process-entry fire (benchmarks that want the download on the boot
// path). ELIZA_SKIP_LOCAL_EMBEDDING_WARMUP still skips warmup entirely
// (checked inside the warmup policy).
function isLocalEmbeddingWarmupDeferredByEnv(): boolean {
  const raw =
    process.env.ELIZA_DEFER_LOCAL_EMBEDDING_WARMUP?.trim().toLowerCase();
  return !(raw === "0" || raw === "false" || raw === "no" || raw === "off");
}

function startLocalEmbeddingWarmup(
  onProgress?: EmbeddingProgressCallback,
): void {
  void warmupEmbeddingModel(onProgress);
}

export function startDeferredLocalEmbeddingWarmup(
  onProgress?: EmbeddingProgressCallback,
): boolean {
  if (!isLocalEmbeddingWarmupDeferredByEnv()) return false;
  logger.info("[eliza] Starting deferred local embedding warmup");
  startLocalEmbeddingWarmup(onProgress);
  return true;
}

async function warmupEmbeddingModel(
  onProgress?: EmbeddingProgressCallback,
): Promise<void> {
  if (warmupInFlight) return warmupInFlight;
  warmupInFlight = warmupEmbeddingModelImpl(onProgress).finally(() => {
    warmupInFlight = null;
  });
  return warmupInFlight;
}

async function warmupEmbeddingModelImpl(
  onProgress?: EmbeddingProgressCallback,
): Promise<void> {
  // Mobile bundle does not ship `node-llama-cpp` (no Android prebuild) and
  // pulling a multi-GB GGUF over a phone's data plan is not acceptable. The
  // mobile path uses `@elizaos/plugin-elizacloud` or a remote provider for
  // embeddings until `llama-cpp-capacitor` is wired in (separate task).
  if (isMobilePlatform()) {
    logger.info(
      "[eliza] Skipping local embedding warmup — running on mobile (ELIZA_PLATFORM=android|ios)",
    );
    return;
  }

  const li = await _localInference();
  if (!li.shouldWarmupLocalEmbeddingModel()) {
    logger.info(
      "[eliza] Skipping local embedding (GGUF) warmup — not needed for this configuration (e.g. Eliza Cloud embeddings, or local embeddings disabled).",
    );
    return;
  }

  const config = loadElizaConfig();
  await upstreamConfigureLocalEmbeddingPlugin({} as Plugin, config);

  const preset = li.detectEmbeddingPreset();
  const modelsDir = process.env.MODELS_DIR ?? li.DEFAULT_MODELS_DIR;
  let model = process.env.LOCAL_EMBEDDING_MODEL?.trim() || preset.model;
  let modelRepo =
    process.env.LOCAL_EMBEDDING_MODEL_REPO?.trim() || preset.modelRepo;

  if (
    !li.isEmbeddingWarmupReuseDisabled() &&
    !li.embeddingGgufFilePresent(modelsDir, model)
  ) {
    const reuse = li.findExistingEmbeddingModelForWarmupReuse(modelsDir);
    if (reuse) {
      logger.info(
        `[eliza] Embedding warmup: configured file "${model}" not found in MODELS_DIR — reusing existing ${reuse.model} to avoid a large re-download. ` +
          "Set LOCAL_EMBEDDING_MODEL or ELIZA_EMBEDDING_WARMUP_NO_REUSE=1 to force the configured model.",
      );
      process.env.LOCAL_EMBEDDING_MODEL = reuse.model;
      process.env.LOCAL_EMBEDDING_MODEL_REPO = reuse.modelRepo;
      process.env.LOCAL_EMBEDDING_DIMENSIONS = String(reuse.dimensions);
      process.env.LOCAL_EMBEDDING_CONTEXT_SIZE = String(reuse.contextSize);
      process.env.LOCAL_EMBEDDING_GPU_LAYERS = reuse.gpuLayers;
      process.env.LOCAL_EMBEDDING_USE_MMAP =
        reuse.gpuLayers === "auto" ? "false" : "true";
      model = reuse.model;
      modelRepo = reuse.modelRepo;
    }
  }

  logger.info(
    `[eliza] Local embedding warmup: ${model} (hardware tier preset: ${preset.label}). ` +
      "This file is for TEXT_EMBEDDING / memory only (not your conversation model).",
  );

  const progressCb: EmbeddingProgressCallback = (phase, detail) => {
    updateStartupEmbeddingProgress(
      phase as Parameters<typeof updateStartupEmbeddingProgress>[0],
      typeof detail === "string" ? detail : undefined,
    );
    // Always log to stdout for server/container monitoring
    if (phase === "downloading") {
      logger.info(`[eliza] Embedding model: ${detail ?? "downloading..."}`);
    } else if (phase === "loading") {
      logger.info(`[eliza] Embedding model: loading ${detail ?? ""}`);
    } else if (phase === "ready") {
      logger.info(`[eliza] Embedding model: ready (${detail ?? ""})`);
    }
    // Forward to caller's callback (e.g. for TUI loading screen)
    onProgress?.(phase, detail);
  };

  try {
    await li.ensureModel(modelsDir, modelRepo, model, false, progressCb);
  } catch (err) {
    // Non-fatal: the plugin will attempt its own download on first use
    logger.warn(
      `[eliza] Embedding model warmup failed (will retry on first use): ${formatError(err)}`,
    );
  }
}

function isExplicitDesktopCloudOnlyRuntime(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const runtimeMode = env.ELIZA_DESKTOP_RUNTIME_MODE?.trim().toLowerCase();
  return (
    runtimeMode === "cloud" ||
    runtimeMode === "elizacloud" ||
    isTruthyEnvValue(env.ELIZA_DESKTOP_CLOUD_ONLY)
  );
}

/**
 * Warm local voice models (Whisper STT + Kokoro TTS) in the background AFTER
 * the runtime is ready, by firing one tiny useModel request at each. Voice
 * models only load through the live runtime (the Kokoro bridge auto-starts on
 * the first TEXT_TO_SPEECH call), so unlike embedding — which warms pre-boot
 * via a runtime-free facade — this runs post-ready. Fire-and-forget; gated to
 * the local-inference path so cloud-only setups never make a paid TTS/STT call.
 */
async function startDeferredVoiceWarmup(runtime: AgentRuntime): Promise<void> {
  if (
    !shouldWarmupVoice({
      mobile: isMobilePlatform(),
      skipEnv: isTruthyEnvValue(process.env.ELIZA_SKIP_LOCAL_VOICE_WARMUP),
      cloudOnly: isExplicitDesktopCloudOnlyRuntime(),
      hotReload: isTruthyEnvValue(process.env.ELIZA_DEV_IS_HOT_RELOAD),
    })
  ) {
    return;
  }
  logger.info("[eliza] Starting deferred voice warmup");
  await warmVoiceModels(
    runtime as Parameters<typeof warmVoiceModels>[0],
    {
      ttsType: ModelType.TEXT_TO_SPEECH,
      transcriptionType: ModelType.TRANSCRIPTION,
    },
    {
      info: (m: string) => logger.info(m),
      warn: (m: string) => logger.warn(m),
    },
  );
}

export interface BootElizaRuntimeOptionsExt extends BootElizaRuntimeOptions {
  /** Optional callback for embedding model download/init progress. */
  onEmbeddingProgress?: EmbeddingProgressCallback;
}

export async function bootElizaRuntime(
  opts: BootElizaRuntimeOptionsExt = {},
): Promise<Awaited<ReturnType<typeof upstreamBootElizaRuntime>>> {
  // Eagerly download the embedding model before the full runtime boot.
  // This way the TUI loading screen (or server logs) can show download
  // progress instead of the app silently stalling on first embedding call.
  // Fire-and-forget: warmupEmbeddingModelImpl declares "non-fatal: will
  // retry on first use" semantics, and self-serializes via the module-level
  // warmupInFlight singleton. Awaiting it here parked bootstrap on sticky
  // HF 401 → multi-URL fallback chains with no overall deadline; the API
  // port never bound and dev-ui.mjs's 300s watchdog tore the stack down
  // (W-016). Voiding lets bootstrap proceed; the renderer's startup overlay
  // still surfaces progress via updateStartupEmbeddingProgress.
  if (isLocalEmbeddingWarmupDeferredByEnv()) {
    logger.info("[eliza] Deferring local embedding warmup until runtime ready");
  } else {
    startLocalEmbeddingWarmup(opts.onEmbeddingProgress);
  }

  // Default the embedding-vector dimension plugin-sql provisions to 384 when
  // unset: that is the compact SQL-safe column and the native width of the
  // standalone gte-small embedding model. Setting it here lets plugin-sql
  // provision the column without a boot-time model probe (see core
  // provisioning). An explicit EMBEDDING_DIMENSION — a different local model,
  // the desktop Eliza-1 sidecar's Matryoshka width, or cloud embeddings —
  // still wins.
  if (!process.env.EMBEDDING_DIMENSION) {
    process.env.EMBEDDING_DIMENSION = "384";
  }

  const runtime = await upstreamBootElizaRuntime(opts);
  // Voice warmup fires inside repairRuntimeAfterBoot (the shared ready-point).
  return runtime ? await repairRuntimeAfterBoot(runtime) : runtime;
}

export interface StartElizaOptionsExt extends StartElizaOptions {
  /** Optional callback for embedding model download/init progress. */
  onEmbeddingProgress?: EmbeddingProgressCallback;
  /**
   * Local-agent IPC mode: the frontend reaches the runtime over native IPC
   * (Capacitor / Electrobun RPC / stdio bridge), not an HTTP port. When set,
   * `startEliza` skips binding the API TCP listener unless the operator opts
   * back in via `ELIZA_API_EXPOSE_PORT`. The in-process route kernel is still
   * initialized so the IPC bridge can drive `dispatchRoute`. Default
   * false/unset — the desktop Electrobun launcher, `eliza start`, and the plain
   * server-only path leave this unset and keep binding the port exactly as
   * today. (#12180)
   */
  localAgentMode?: boolean;
}

function collectErrorObjects(err: unknown): ErrorWithCause[] {
  const chain: ErrorWithCause[] = [];
  const seen = new Set<unknown>();
  let current: unknown = err;

  while (current && !seen.has(current)) {
    seen.add(current);
    if (current instanceof Error) {
      chain.push(current as ErrorWithCause);
      current = (current as ErrorWithCause).cause;
      continue;
    }
    if (typeof current === "object" && current !== null) {
      const candidate = current as ErrorWithCause;
      chain.push(candidate);
      current = candidate.cause;
      continue;
    }
    break;
  }

  return chain;
}

function getPgliteErrorCode(err: unknown): string | null {
  for (const current of collectErrorObjects(err)) {
    if (typeof current.code === "string" && current.code) {
      return current.code;
    }
  }
  return null;
}

function collectErrorMessages(err: unknown): string[] {
  const messages: string[] = [];

  for (const current of collectErrorObjects(err)) {
    if (typeof current.message === "string" && current.message) {
      messages.push(current.message);
    }
  }

  return messages;
}

function hasLegacyManualResetPgliteMessage(err: unknown): boolean {
  // Legacy fallback for pre-contract plugin-sql errors and raw WASM aborts that
  // do not carry PGLITE_ERROR_CODES yet. The structured code path above owns
  // current plugin-sql recovery.
  return collectErrorMessages(err).some((message) => {
    const normalized = message.toLowerCase();
    if (
      normalized.includes(
        "rename or delete only this directory before retrying",
      )
    ) {
      return true;
    }

    if (
      normalized.includes("@elizaos/plugin-sql") &&
      normalized.includes("migrations._migrations")
    ) {
      return true;
    }

    // PGlite is an Emscripten/WASM build of Postgres. When the embedded
    // postmaster hits an unrecoverable internal state — most commonly a
    // corrupt on-disk pgdata directory from a previous crash, an
    // unsupported syscall, or pg_logical/WAL replay failure — Emscripten
    // calls `abort()` and surfaces it as an Error whose message starts
    // with `Aborted(). Build with -sASSERTIONS for more info.` That bare
    // string carries no PGlite-specific marker, so the older heuristics
    // above never matched and the dev-server retried forever against the
    // same poisoned data dir. Treat it as a recoverable corruption signal:
    // the auto-reset path quarantines the .elizadb dir and retries once.
    if (normalized.includes("aborted()")) {
      return true;
    }

    return false;
  });
}

function isManualResetPgliteError(err: unknown): boolean {
  const code = getPgliteErrorCode(err);
  if (
    code === PGLITE_ERROR_CODES.MANUAL_RESET_REQUIRED ||
    code === PGLITE_ERROR_CODES.CORRUPT_DATA
  ) {
    return true;
  }

  return hasLegacyManualResetPgliteMessage(err);
}

function getPgliteDataDirFromError(err: unknown): string | null {
  for (const current of collectErrorObjects(err)) {
    if (typeof current.dataDir === "string" && current.dataDir.trim()) {
      return current.dataDir;
    }
  }

  for (const rawMessage of collectErrorMessages(err)) {
    const message =
      rawMessage.length > 4096 ? rawMessage.slice(0, 4096) : rawMessage;
    const retryPathMatch = message.match(
      /before retrying:[ \t]{0,16}([^\n]{1,1024}?)(?:[ \t]*$|\.)/,
    );
    if (retryPathMatch?.[1]) {
      return retryPathMatch[1].trim();
    }

    const initPathMatch = message.match(
      /PGlite initialization failed for ([^:\n]{1,1024}):/i,
    );
    if (initPathMatch?.[1]) {
      return initPathMatch[1].trim();
    }
  }

  return null;
}

function resolveManagedPgliteDataDir(): string | null {
  const envDataDir = process.env.PGLITE_DATA_DIR?.trim();
  if (envDataDir) {
    return resolveUserPath(envDataDir);
  }

  const config = loadElizaConfig();
  if ((config.database?.provider ?? "pglite") === "postgres") {
    return null;
  }

  const configuredDataDir = config.database?.pglite?.dataDir?.trim();
  if (configuredDataDir) {
    return resolveUserPath(configuredDataDir);
  }

  const workspaceDir =
    config.agents?.defaults?.workspace ?? resolveDefaultAgentWorkspaceDir();
  return path.join(resolveUserPath(workspaceDir), ".elizadb");
}

function isAutoResettablePgliteDir(dataDir: string | null): dataDir is string {
  return typeof dataDir === "string" && path.basename(dataDir) === ".elizadb";
}

async function quarantinePgliteDataDir(
  dataDir: string,
): Promise<string | null> {
  if (!existsSync(dataDir)) {
    return null;
  }

  const parentDir = path.dirname(dataDir);
  const baseName = path.basename(dataDir);
  let attempt = 0;

  while (attempt < 1000) {
    const suffix = attempt === 0 ? `${Date.now()}` : `${Date.now()}-${attempt}`;
    const backupDir = path.join(parentDir, `${baseName}.corrupt-${suffix}`);
    if (existsSync(backupDir)) {
      attempt += 1;
      continue;
    }
    await rename(dataDir, backupDir);
    return backupDir;
  }

  throw new Error(`Could not allocate a backup path for ${dataDir}`);
}

function normalizePgliteStartupError(err: unknown): unknown {
  if (!isManualResetPgliteError(err)) {
    return err;
  }

  if (
    err instanceof Error &&
    getPgliteErrorCode(err) === PGLITE_ERROR_CODES.MANUAL_RESET_REQUIRED
  ) {
    return err;
  }

  const dataDir =
    getPgliteDataDirFromError(err) ?? resolveManagedPgliteDataDir();
  const detail = collectErrorMessages(err)[0] ?? formatError(err);
  const wrapped = new Error(
    dataDir
      ? `PGlite initialization failed for ${dataDir}: ${detail}. Stop the app, then rename or delete only this directory before retrying: ${dataDir}`
      : `PGlite initialization failed: ${detail}. Stop the app, then rename or delete only the managed PGlite data directory before retrying.`,
    { cause: err },
  ) as ErrorWithCause;
  wrapped.code = PGLITE_ERROR_CODES.MANUAL_RESET_REQUIRED;
  if (dataDir) {
    wrapped.dataDir = dataDir;
  }
  return wrapped;
}

async function upstreamStartElizaWithPgliteCompat(
  options?: StartElizaOptions,
): Promise<Awaited<ReturnType<typeof upstreamStartEliza>>> {
  // Inject the app-core host capabilities (vault, account pool, wallet-key
  // hydration, build variant, cloud-pair route) into the agent runtime before
  // it boots. Every app-core agent boot funnels through here, and this is the
  // sole caller of `upstreamStartEliza`, so the bridge is always installed
  // before agent code that reads it runs. See install-agent-host-bridge.ts.
  installAgentHostBridge();
  try {
    return await upstreamStartEliza(options);
  } catch (err) {
    throw normalizePgliteStartupError(err);
  }
}

export async function attemptPgliteAutoReset(
  err: unknown,
): Promise<string | null> {
  if (!isManualResetPgliteError(err)) {
    return null;
  }

  const dataDir =
    getPgliteDataDirFromError(err) ?? resolveManagedPgliteDataDir();
  if (!isAutoResettablePgliteDir(dataDir)) {
    return null;
  }

  logger.warn(
    `[eliza] PGlite startup failed for ${dataDir}. Quarantining the local database before retrying.`,
  );

  await resetPluginSqlPgliteSingleton("PGlite auto-reset");
  const backupDir = await quarantinePgliteDataDir(dataDir);

  if (backupDir) {
    logger.warn(`[eliza] Moved the previous PGlite data dir to ${backupDir}`);
  }

  await resetPluginSqlPgliteSingleton("PGlite auto-reset retry");
  return backupDir;
}

export function getPgliteRecoveryRetrySkipPlugins(): string[] {
  return getLastFailedPluginNames();
}

export async function startEliza(
  options?: StartElizaOptionsExt,
): Promise<Awaited<ReturnType<typeof upstreamStartEliza>>> {
  // Eliza app: load PTY / coding-swarm orchestration unless explicitly opted out.
  const orchRaw = readAliasedEnv("ELIZA_AGENT_ORCHESTRATOR")?.toLowerCase();
  if (orchRaw !== "0" && orchRaw !== "false" && orchRaw !== "no") {
    process.env.ELIZA_AGENT_ORCHESTRATOR = "1";
  }

  // Install the compat-route http.createServer wrapper BEFORE the upstream
  // agent's bootElizaRuntime path (which calls upstream startApiServer →
  // http.createServer at packages/agent/src/runtime/eliza.ts ~3984). The
  // upstream call binds the port and creates the listener that will receive
  // every request from the renderer; if our patch isn't already in place,
  // /api/tts/local-inference, /api/database, /api/runtime/mode, and every
  // other compat-dispatcher path 404 because the wrapper never runs on the
  // active listener. The app-core `startApiServer` wrapper (line ~1188 of
  // ../api/server.ts) ALSO installs the patch, but that's too late — the
  // upstream listener is already bound by then.
  //
  // The patch falls back to a module-scoped singleton state when called
  // without an explicit one; `startApiServer` later seeds that same
  // singleton with the live runtime via its `server.updateRuntime` wrapper,
  // so the early listener picks up the runtime as soon as it's available.
  patchHttpCreateServerForCompat();
  const earlyCompatState = getSharedCompatRuntimeState();

  // Eagerly download the embedding model with progress reporting.
  // Fire-and-forget — see comment at the matching call in bootElizaRuntime
  // (W-016): awaiting parks bootstrap; voiding lets the API port bind on
  // time while the warmup runs alongside.
  if (isLocalEmbeddingWarmupDeferredByEnv()) {
    logger.info("[eliza] Deferring local embedding warmup until runtime ready");
  } else {
    startLocalEmbeddingWarmup(options?.onEmbeddingProgress);
  }

  // Cap embedding dimension to 384 — see comment in bootElizaRuntime.
  if (!process.env.EMBEDDING_DIMENSION) {
    process.env.EMBEDDING_DIMENSION = "384";
  }

  if (options?.serverOnly) {
    bootLap("startEliza:serverOnly entry");
    let currentRuntime: AgentRuntime | undefined;

    // Boot (or re-boot) the runtime headless + repair, and hand the live
    // runtime to the early-installed compat wrapper so `/api/tts/*`,
    // `/api/database`, `/api/runtime/mode`, and every other compat-dispatcher
    // path can resolve. Without the latter, `state.current` stays null and
    // `handleCompatRoute` short-circuits. Used for the initial async boot AND
    // the `/api/agent/restart` handler.
    const bootServerOnlyRuntime = async (): Promise<
      AgentRuntime | undefined
    > => {
      const booted =
        (await upstreamStartElizaWithPgliteCompat({
          ...options,
          headless: true,
          serverOnly: false,
        })) ?? undefined;
      const repaired = booted ? await repairRuntimeAfterBoot(booted) : booted;
      earlyCompatState.current = repaired ?? null;
      return repaired;
    };

    // Fresh-install gate, decided BEFORE the API binds so the onRestart
    // closure below can never race an in-flight deferral decision: on a
    // genuinely-fresh install (the GUI will run onboarding; no provider env
    // keys, not cloud-provisioned) the runtime a server-only boot would build
    // is pure waste — onboarding discards it. Defer it and boot on the
    // first-run commit instead (see ../api/deferred-runtime-boot.ts).
    const deferRuntimeBootUntilOnboarding =
      shouldDeferRuntimeBootUntilOnboarding();

    // Desktop launcher sets ELIZA_API_PORT (default 31337) to match the
    // renderer's hardcoded API base; honor it when present. CLI/server-only
    // mode (no ELIZA_API_PORT) keeps the legacy `resolveServerOnlyPort`
    // default (2138) so this change is transparent for non-desktop users.
    // The presence check is alias-aware so a branded `MILADY_API_PORT` also
    // selects the desktop port without relying on the process.env mirror.
    const apiPort = readAliasedEnv("ELIZA_API_PORT")
      ? resolveDesktopApiPort(process.env)
      : resolveServerOnlyPort(process.env);
    let actualApiPort: number;
    let updateRuntime:
      | Awaited<ReturnType<typeof startApiServer>>["updateRuntime"]
      | undefined;
    let updateStartup:
      | Awaited<ReturnType<typeof startApiServer>>["updateStartup"]
      | undefined;
    // Local-agent IPC mode binds NO TCP listener (frontend reaches the
    // runtime over native IPC), unless the operator opts back in with
    // ELIZA_API_EXPOSE_PORT for dev tooling / LAN access / e2e harnesses.
    // Every other caller (desktop launcher, `eliza start`, plain server-only)
    // leaves `localAgentMode` unset, so `skipApiListen` is false and the bind
    // path is byte-for-byte identical to today. (#12180)
    const skipApiListen =
      options?.localAgentMode === true &&
      resolveApiExposePort(process.env) !== true;
    if (skipApiListen) {
      bootLap("startEliza:local-agent IPC mode — skipping API TCP bind");
      logger.info(
        "[eliza] Local-agent IPC mode: initializing route kernel without a TCP listener (set ELIZA_API_EXPOSE_PORT=1 to re-open the port)",
      );
    }
    // The deferred fresh-install boot: exactly the post-bind boot sequence
    // below (boot → updateRuntime → "running"), reachable from the first-run
    // commit handler and the agent start/restart endpoints. Registered BEFORE
    // the API binds so every HTTP trigger finds it; `updateRuntime` /
    // `updateStartup` are assigned by the bind below, before any request can
    // arrive. A failed boot flips the reported state to "error" (the client's
    // designed error state) and rethrows — the registration is kept so an
    // explicit start/restart can retry.
    if (deferRuntimeBootUntilOnboarding) {
      registerDeferredRuntimeBoot(async () => {
        updateStartup?.({ phase: "starting", state: "starting" });
        try {
          currentRuntime = await bootServerOnlyRuntime();
        } catch (err) {
          // error-policy:J2 context-adding rethrow — flip the reported agent
          // state to "error" first so /api/status never reads healthy.
          updateStartup?.({ phase: "error", state: "error" });
          throw new Error("Runtime boot after onboarding failed", {
            cause: err,
          });
        }
        if (!currentRuntime) {
          updateStartup?.({ phase: "error", state: "error" });
          throw new Error("Runtime boot after onboarding returned no runtime");
        }
        updateRuntime?.(currentRuntime);
        updateStartup?.({ phase: "running", attempt: 0, state: "running" });
        bootLap("startEliza:deferred runtime booted + ready:true");
      });
    }

    bootLap(
      "startEliza:before startApiServer (config/registry/embedding setup done)",
    );
    try {
      // Bind the API server FIRST with no runtime yet (state "starting", or
      // "not_started" when the fresh-install gate deferred the boot), so the
      // desktop webview connects + hydrates in PARALLEL with the heavier
      // agent boot instead of waiting the full boot. The runtime is wired in
      // via updateRuntime once it finishes booting below. Mirrors the
      // dev-server's bind-first orchestration. In local-agent IPC mode
      // (skipApiListen) the same route kernel is initialized in-process but no
      // socket is opened; the IPC bridge drives dispatchRoute directly.
      const startedApiServer = await startApiServer({
        port: apiPort,
        skipListen: skipApiListen,
        initialAgentState: deferRuntimeBootUntilOnboarding
          ? "not_started"
          : "starting",
        onRestart: async () => {
          // Before the deferred first boot has succeeded, a restart request
          // IS the boot request — funnel it into the single-flight trigger so
          // it can never race the first-run commit into a second concurrent
          // PGlite open.
          if (isRuntimeBootDeferred()) {
            await triggerDeferredRuntimeBoot("agent start requested via API");
            return currentRuntime ?? null;
          }
          if (currentRuntime) {
            await upstreamShutdownRuntime(
              currentRuntime,
              "server-only restart",
            );
          }
          currentRuntime = await bootServerOnlyRuntime();
          return currentRuntime ?? null;
        },
      });
      actualApiPort = startedApiServer.port;
      updateRuntime = startedApiServer.updateRuntime;
      updateStartup = startedApiServer.updateStartup;
    } catch (apiErr) {
      const apiErrMsg =
        apiErr instanceof Error
          ? (apiErr.stack ?? apiErr.message)
          : String(apiErr);
      logger.error(`[eliza] API server failed to start: ${apiErrMsg}`);
      console.error(apiErrMsg);
      if (options?.serverOnly) {
        process.exit(1);
      }
      throw apiErr;
    }

    if (!skipApiListen) {
      // WHY: `startApiServer` may bind a different port than requested (busy
      // socket, upstream policy). Shells, scripts, and follow-up code reading
      // env must match the real listener or health checks and user-facing URLs
      // disagree with `GET /api/health`. In local-agent IPC mode no port is
      // bound, so syncing env to `actualApiPort` (a never-bound port) or
      // emitting a "listening on http://…" URL would be a lie.
      syncResolvedApiPort(process.env, actualApiPort, {
        overwriteUiPort: true,
      });
      // Invalidate cached CORS port set so the new port is allowed.
      // server-cors is statically imported at the top of this module — the
      // previous dynamic import was INEFFECTIVE_DYNAMIC_IMPORT.
      invalidateCorsAllowedPorts();

      logger.info(
        `[eliza] API server listening on http://localhost:${actualApiPort} (agent booting…)`,
      );
      console.log(`[eliza] Control UI: http://localhost:${actualApiPort}`);
      bootLap("startEliza:API bound (webview can connect, ready:false)");
    } else {
      logger.info(
        "[eliza] Local-agent IPC mode: route kernel ready (no TCP listener bound)",
      );
      bootLap("startEliza:route kernel ready (IPC mode, no TCP bind)");
    }

    if (deferRuntimeBootUntilOnboarding) {
      // Fresh install: no runtime until onboarding commits. The API server
      // already serves everything onboarding needs (first-run status/options,
      // auth, config); /api/status reports the designed awaiting state
      // (state "not_started", startup.phase "awaiting-onboarding") — never a
      // fake "running". The boot fires from POST /api/first-run (local-target
      // commit) or POST /api/agent/start|restart, whichever comes first; a
      // cloud/remote-target commit leaves this process runtime-less on
      // purpose (#13377 — the client binds the cloud agent instead).
      updateStartup?.({ phase: "awaiting-onboarding", state: "not_started" });
      logger.info(
        "[eliza] Fresh install — agent runtime boot deferred until onboarding commits (onboarding API routes are live)",
      );
      bootLap("startEliza:runtime boot deferred (awaiting onboarding)");
    } else {
      // Now boot the runtime; the API is already reachable (state "starting"),
      // so the UI is connecting + hydrating while this runs, then flips to
      // "running" once the agent is ready.
      currentRuntime = await bootServerOnlyRuntime();
      if (!currentRuntime) {
        updateStartup?.({ phase: "error", state: "error" });
        return currentRuntime;
      }
      updateRuntime?.(currentRuntime);
      updateStartup?.({ phase: "running", attempt: 0, state: "running" });
      bootLap("startEliza:runtime booted + ready:true");
    }

    console.log("[eliza] Server running. Press Ctrl+C to stop.");

    const { buildSandboxRegistryFromEnv } = await import(
      "@elizaos/shared/sandbox-registry"
    );
    const sandboxRegistry = buildSandboxRegistryFromEnv();
    if (sandboxRegistry) {
      try {
        await sandboxRegistry.register();
      } catch (err) {
        logger.error(
          `[eliza] Failed to register sandbox in Redis (gateways will not route inbound platform messages here until the next heartbeat succeeds): ${formatError(err)}`,
        );
      }
      sandboxRegistry.startHeartbeat(30_000);
    }

    const keepAlive = setInterval(() => {}, 1 << 30);
    let isCleaningUp = false;
    const cleanup = async () => {
      if (isCleaningUp) {
        return;
      }
      isCleaningUp = true;
      clearInterval(keepAlive);
      // Force exit if graceful shutdown hangs for more than 10 seconds.
      const forceExitTimer = setTimeout(() => {
        logger.warn("[eliza] Shutdown timed out after 10s — forcing exit");
        process.exit(1);
      }, 10_000);
      forceExitTimer.unref();
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
      if (currentRuntime) {
        await upstreamShutdownRuntime(currentRuntime, "server-only shutdown");
      }
      // Stop the trigger event bridge so its event handlers do not
      // fire against the runtime after shutdown begins.
      if (_triggerEventBridge) {
        try {
          _triggerEventBridge.stop();
        } catch {
          /* ignore */
        }
        _triggerEventBridge = null;
      }
      process.exit(0);
    };

    if (!signalHandlersRegistered) {
      signalHandlersRegistered = true;
      process.on("SIGINT", () => void cleanup());
      process.on("SIGTERM", () => void cleanup());
    }
    return currentRuntime;
  }

  const runtime = await upstreamStartElizaWithPgliteCompat(options);
  const repaired = runtime ? await repairRuntimeAfterBoot(runtime) : runtime;
  // Same wiring as the serverOnly branch above — hand the live runtime to
  // the early-installed compat wrapper so its dispatcher engages.
  if (repaired) {
    earlyCompatState.current = repaired;
  }
  return repaired;
}

function isDirectRuntimeRun(): boolean {
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
  if (!scriptArg) {
    return false;
  }
  return import.meta.url === pathToFileURL(path.resolve(scriptArg)).href;
}

function printDirectRuntimeHelp(): void {
  console.log(`eliza runtime

Usage:
  bun packages/app-core/src/runtime/eliza.ts
  bun run start:eliza

Flags:
  --help, -h       Show this help
  --version, -v    Show the app-core package version

For full CLI help, run:
  bun run eliza --help`);
}

function printDirectRuntimeVersion(): void {
  const pkg = require("../../package.json") as { version?: string };
  console.log(pkg.version ?? "unknown");
}

if (isDirectRuntimeRun()) {
  const command = process.argv[2];
  if (DIRECT_HELP_FLAGS.has(command ?? "")) {
    printDirectRuntimeHelp();
  } else if (DIRECT_VERSION_FLAGS.has(command ?? "")) {
    printDirectRuntimeVersion();
  } else {
    startEliza().catch((err) => {
      console.error("[eliza] Fatal error:", formatErrorWithStack(err));
      process.exit(1);
    });
  }
}
