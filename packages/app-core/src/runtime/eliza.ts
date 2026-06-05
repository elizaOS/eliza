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

export { CHANNEL_PLUGIN_MAP } from "./channel-plugin-map.js";

export { CUSTOM_PLUGINS_DIRNAME, resolvePackageEntry, scanDropInPlugins };

import {
  type AgentRuntime,
  AutonomyService,
  ChannelType,
  logger,
  ModelType,
  type Plugin,
  stringToUuid,
} from "@elizaos/core";
import {
  ensureRuntimeSqlCompatibility,
  formatError,
  formatErrorWithStack,
  isMobilePlatform,
  resolveDesktopApiPort,
  resolveServerOnlyPort,
  syncAppEnvToEliza,
  syncElizaEnvAliases,
  syncResolvedApiPort,
} from "@elizaos/shared";
import { getApps, loadRegistry } from "../registry";
import { registerCoreSensitiveRequestAdapters } from "../services/sensitive-requests/index.js";
import {
  type AppRoutePluginRegistryEntry,
  listAppRoutePluginLoaders,
} from "./app-route-plugin-registry.js";
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
import { invalidateCorsAllowedPorts } from "../api/server-cors.js";
import { isRuntimeAutonomyEnabled } from "./autonomy-policy.js";
import {
  ensureTextToSpeechHandler,
  isEdgeTtsDisabled as isTextToSpeechEdgeTtsDisabled,
} from "./ensure-text-to-speech-handler.js";
import {
  type EmbeddingWarmupPhase,
  updateStartupEmbeddingProgress,
} from "./startup-overlay.js";
import { handleTelegramStandaloneMessage } from "./telegram-standalone-handler.js";
import { shouldStartTelegramStandaloneBot } from "./telegram-standalone-policy.js";

const AUTONOMY_WORLD_ID = stringToUuid("00000000-0000-0000-0000-000000000001");
const AUTONOMY_ENTITY_ID = stringToUuid("00000000-0000-0000-0000-000000000002");
const AUTONOMY_MESSAGE_SERVER_ID = stringToUuid("autonomy-message-server");

/** Swarm / PTY paths call TEXT_TO_SPEECH; Edge TTS supplies that model with no API key. */
const AGENT_ORCHESTRATOR_PLUGIN = "agent-orchestrator";
const EDGE_TTS_PLUGIN = "@elizaos/plugin-edge-tts";
const require = createRequire(import.meta.url);
const DIRECT_HELP_FLAGS = new Set(["-h", "--help", "help"]);
const DIRECT_VERSION_FLAGS = new Set(["-v", "-V", "--version", "version"]);
const PLUGIN_SQL_GLOBAL_SINGLETONS = Symbol.for(
  "elizaos.plugin-sql.global-singletons",
);
const ELIZA_AUTO_RESET_PGLITE_ERROR_CODE = "ELIZA_PGLITE_MANUAL_RESET_REQUIRED";

export const shutdownRuntime = upstreamShutdownRuntime;

interface PluginSqlGlobalSingletons {
  pgLiteClientManager?: {
    close?: () => Promise<unknown> | unknown;
  };
}

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
  const svc = runtime.getService("AUTONOMY") ?? runtime.getService("autonomy");
  if (isAutonomyService(svc)) {
    return svc;
  }
  return null;
}

async function startAndRegisterAutonomyService(
  runtime: AgentRuntime,
): Promise<AutonomyServiceLike> {
  const service = await AutonomyService.start(runtime);
  runtime.services.set("AUTONOMY" as never, [service as never]);
  return service;
}

function syncBrandEnvAliases(): void {
  syncElizaEnvAliases();
  syncAppEnvToEliza();
}

export function collectPluginNames(
  ...args: Parameters<typeof upstreamCollectPluginNames>
): ReturnType<typeof upstreamCollectPluginNames> {
  syncBrandEnvAliases();
  const [config] = args;
  const result = upstreamCollectPluginNames(...args);
  if (
    result.has(AGENT_ORCHESTRATOR_PLUGIN) &&
    !isTextToSpeechEdgeTtsDisabled(config) &&
    !result.has(EDGE_TTS_PLUGIN)
  ) {
    result.add(EDGE_TTS_PLUGIN);
  }
  syncBrandEnvAliases();
  return result;
}

export function applyCloudConfigToEnv(
  ...args: Parameters<typeof upstreamApplyCloudConfigToEnv>
): ReturnType<typeof upstreamApplyCloudConfigToEnv> {
  syncBrandEnvAliases();
  const result = upstreamApplyCloudConfigToEnv(...args);
  syncBrandEnvAliases();
  return result;
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

async function loadAppRoutePluginFromSpecifier(
  specifier: string,
  exportName: string | undefined,
): Promise<Plugin> {
  const module = (await import(
    /* webpackIgnore: true */ specifier
  )) as AppRoutePluginModule;
  return resolvePluginExport(module, exportName);
}

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
 * A loader's id is its full package name (e.g. `@elizaos/plugin-lifeops`,
 * `@elizaos/plugin-steward-app`, `@elizaos/plugin-elizacloud:routes`). Tokens
 * are matched against BOTH the full id and a normalized short alias
 * (see {@link normalizeAppRoutePluginId}), so the ergonomic short forms work
 * too: `ELIZA_SKIP_APP_ROUTE_PLUGINS=lifeops,steward,training,shopify`.
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
 * Opt-in dev knob: when set to the literal token `"1"`, the post-ready boot
 * tail (app-route plugins, training hooks, sensitive-request adapters, telegram
 * polling, trigger bridge, connector catalog, voice warmup) runs in the
 * background instead of blocking the readiness gate, so `/api/health` flips
 * `ready:true` and "Agent ready" prints sooner. Composes with
 * {@link getSkippedAppRoutePluginIds}: `ELIZA_SKIP_APP_ROUTE_PLUGINS` filters
 * WHICH route plugins load; this controls WHETHER that tail blocks ready.
 *
 * Returns true ONLY for `"1"` (undefined / `""` / `"0"` / `"false"` / `"true"`
 * all return false) so the default boot is byte-identical: the tail is awaited
 * inline exactly as before.
 */
export function getDeferAppRoutesEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return env.ELIZA_DEFER_APP_ROUTES?.trim() === "1";
}

/**
 * Normalize an app-route-plugin id (or a user-supplied skip token) to a short
 * alias for forgiving matching: lowercase, drop the `@elizaos/plugin-` prefix
 * and the `:routes` / `-app` / `-ui` / `-routes` suffixes. So
 * `@elizaos/plugin-steward-app` and `steward` both normalize to `steward`.
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
  logger.info(
    `[eliza][DEBUG-WF] app-route loader ids: ${[...byId.keys()].join(", ")}`,
  );

  const skip = getSkippedAppRoutePluginIds();
  if (skip.size === 0) {
    return [...byId.values()];
  }

  // Match a loader against the skip tokens by full id OR normalized short alias
  // (so both `@elizaos/plugin-steward-app` and `steward` skip the same loader).
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
  // Load all app-route plugin modules concurrently. This runs on the gated
  // ready-path (repairRuntimeAfterBoot is awaited before the runtime is handed
  // back and /api/health flips ready), so the previous sequential await-loop
  // serialized ~11 independent dynamic imports (lifeops alone registers 188
  // routes) and dominated time-to-ready. Imports are independent; loading them
  // together overlaps their I/O and module resolution. Route registration is
  // still applied in loader order after all settle, so dispatch order is
  // unchanged, and per-plugin failures stay isolated (a rejected load logs and
  // contributes no routes rather than aborting the rest).
  const loaded = await Promise.all(
    getAppRoutePluginLoaders().map(async ({ id, load }) => {
      try {
        return await load();
      } catch (err) {
        logger.warn(
          `[eliza] Failed to register app route plugin ${id}: ${formatError(err)}`,
        );
        return null;
      }
    }),
  );

  for (const plugin of loaded) {
    if (!plugin) continue;
    // Push rawPath routes directly onto runtime.routes to avoid the core's
    // registerPlugin() path mangling (which prepends /<pluginName>/ to every
    // route path). The rawPath flag means these routes already have their
    // final absolute paths (e.g. /api/lifeops/app-state).
    if (plugin.routes?.length) {
      for (const route of plugin.routes) {
        const routePath = route.path.startsWith("/")
          ? route.path
          : `/${route.path}`;
        runtime.routes.push({ ...route, path: routePath });
      }
    }
    logger.info(
      `[eliza] Registered app route plugin: ${plugin.name} (${plugin.routes?.length ?? 0} routes)`,
    );
  }
}

interface RuntimeHookModule {
  registerTrainingRuntimeHooks?: (runtime: AgentRuntime) => Promise<void>;
}

const TRAINING_RUNTIME_HOOKS_SPECIFIER = "@elizaos/plugin-training";

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

async function registerTrainingRuntimeHooks(
  runtime: AgentRuntime,
): Promise<void> {
  let hookMod: RuntimeHookModule;
  try {
    hookMod = (await import(
      TRAINING_RUNTIME_HOOKS_SPECIFIER
    )) as RuntimeHookModule;
  } catch (err) {
    if (isModuleNotFoundError(err)) {
      logger.warn(
        `[eliza] @elizaos/plugin-training not installed, skipping runtime hooks`,
      );
      return;
    }
    // Real load failure (syntax error, broken transitive, init throw, etc.) —
    // surface it loudly so it is not mistaken for "not installed".
    logger.error(
      `[eliza] @elizaos/plugin-training failed to load (not 'not installed'): ${formatErrorWithStack(err)}`,
    );
    throw err;
  }

  if (!hookMod.registerTrainingRuntimeHooks) {
    throw new Error(
      `[eliza] ${TRAINING_RUNTIME_HOOKS_SPECIFIER} did not export registerTrainingRuntimeHooks`,
    );
  }

  await hookMod.registerTrainingRuntimeHooks(runtime);
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

  // Mobile (Android / iOS) shortcut: the runtime is already serving from
  // PGlite + the AI provider plugin. The remaining boot steps either spawn
  // subprocesses (workflow runtime, telegram polling), shell
  // out to platform-specific binaries (text-to-speech, local inference), or
  // dynamic-import optional packages that are not in the mobile bundle
  // (registered app route plugins and app runtime hooks). Skipping
  // them here is what the mobile bundle has to do to avoid crashing on first
  // turn — feature parity comes from cloud-side services, not on-device state.
  if (isMobilePlatform()) {
    if ((await _localInference()).shouldEnableMobileLocalInference()) {
      await (await _localInference()).ensureLocalInferenceHandler(runtime);
    }
    logger.info(
      "[eliza] Mobile platform detected — skipping desktop-only boot helpers",
    );
    return runtime;
  }

  await (await _localInference()).ensureLocalInferenceHandler(runtime);
  const autonomyLoopEnabled = isRuntimeAutonomyEnabled(process.env);
  if (autonomyLoopEnabled) {
    await ensureAutonomyBootstrapContext(runtime);
  } else {
    logger.info(
      "[eliza] Autonomy bootstrap deferred — autonomous loop disabled",
    );
  }

  if (!runtime.getService("AUTONOMY")) {
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
  // voice warmup. None of these gate correctness of the first turn, so when
  // ELIZA_DEFER_APP_ROUTES=1 they run in the background and ready flips before
  // the tail completes (feature routes may 404 for a brief window — same
  // audience as ELIZA_SKIP_APP_ROUTE_PLUGINS). When the knob is unset the tail
  // is awaited inline, identical in steps and order to the pre-split path.
  latestBootTailRuntime = runtime;
  if (getDeferAppRoutesEnabled()) {
    void runPostReadyBootTail(runtime);
    return runtime;
  }
  await runPostReadyBootTail(runtime);
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
  registerTrainingRuntimeHooks: (runtime: AgentRuntime) => Promise<void>;
  registerCoreSensitiveRequestAdapters: (runtime: AgentRuntime) => void;
  shouldStartTelegramStandaloneBot: () => boolean;
  ensureTelegramBotPolling: (runtime: AgentRuntime) => Promise<void>;
  stopTelegramBotPolling: (reason: string) => void;
  ensureTriggerEventBridge: (runtime: AgentRuntime) => Promise<void>;
  ensureConnectorTargetCatalog: (runtime: AgentRuntime) => Promise<void>;
  startDeferredVoiceWarmup: (runtime: AgentRuntime) => void;
}

const DEFAULT_POST_READY_BOOT_STEPS: PostReadyBootSteps = {
  ensureTextToSpeechHandler,
  registerAppRoutePlugins,
  registerTrainingRuntimeHooks,
  registerCoreSensitiveRequestAdapters,
  shouldStartTelegramStandaloneBot,
  ensureTelegramBotPolling,
  stopTelegramBotPolling,
  ensureTriggerEventBridge,
  ensureConnectorTargetCatalog,
  startDeferredVoiceWarmup,
};

/**
 * Post-ready boot steps split out of {@link repairRuntimeAfterBoot}. Each step
 * keeps its original error behavior verbatim — there is no wrapping try/catch:
 * registerAppRoutePlugins isolates per-loader failures internally,
 * ensureTriggerEventBridge / ensureConnectorTargetCatalog swallow into
 * logger.warn internally, and ensureTextToSpeechHandler /
 * registerTrainingRuntimeHooks throw (preserved in the default inline-await
 * dispatch above).
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

  await steps.registerTrainingRuntimeHooks(runtime);

  // Register first-party sensitive-request delivery adapters with the
  // dispatch registry (no-op when the registry service isn't present).
  steps.registerCoreSensitiveRequestAdapters(runtime);

  if (steps.shouldStartTelegramStandaloneBot()) {
    await steps.ensureTelegramBotPolling(runtime);
  } else {
    steps.stopTelegramBotPolling("passive-lifeops-connectors");
  }

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

// Discord enumeration cache shared with the connector-target-catalog so the
// catalog service hits one 5-minute REST window instead of one per call.
// Reset whenever the catalog service is re-created so a hot-reload cannot
// leak stale guild/channel state into the fresh runtime.
let _discordEnumerationCache:
  | import("../services/discord-target-source").DiscordSourceCache
  | null = null;

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
    const { createDiscordSourceCache } = await import(
      "../services/discord-target-source.js"
    );
    _discordEnumerationCache = createDiscordSourceCache();
    const { createElizaConnectorTargetCatalog } = await import(
      "../services/connector-target-catalog.js"
    );
    const catalog = createElizaConnectorTargetCatalog({
      getConfig: () => loadElizaConfig(),
      discordCache: _discordEnumerationCache,
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

// Module-level Telegraf bot reference for lifecycle management across restarts.
let _telegramBot: { stop: (reason?: string) => void } | null = null;

function stopTelegramBotPolling(reason: string): void {
  if (!_telegramBot) {
    return;
  }
  try {
    _telegramBot.stop(reason);
  } catch {
    /* ignore */
  }
  _telegramBot = null;
}

async function ensureTelegramBotPolling(runtime: AgentRuntime): Promise<void> {
  // Stop any previous bot instance
  if (_telegramBot) {
    stopTelegramBotPolling("restart");
    await new Promise((r) => setTimeout(r, 1000));
  }

  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  if (!botToken) return;

  try {
    const { Telegraf } = await import("telegraf");
    const apiRoot = process.env.TELEGRAM_API_ROOT || "https://api.telegram.org";
    const bot = new Telegraf(botToken, { telegram: { apiRoot } });

    bot.on("message", async (ctx) => {
      await handleTelegramStandaloneMessage(runtime, ctx);
    });

    bot.catch((err: unknown) =>
      logger.warn(`[eliza] Telegram bot error: ${formatError(err)}`),
    );

    // Fire-and-forget — bot.launch() only resolves on stop()
    bot
      .launch({
        dropPendingUpdates: true,
        allowedUpdates: ["message", "message_reaction"],
      })
      .catch((err: unknown) =>
        logger.warn(`[eliza] Telegram bot launch error: ${formatError(err)}`),
      );

    _telegramBot = bot;
    // Telegram bot cleanup is handled by the central signal handler in
    // startEliza() via _telegramBot — no separate registration needed.

    await new Promise((r) => setTimeout(r, 500));
    logger.info("[eliza] Telegram bot polling started");
  } catch (err) {
    logger.warn(`[eliza] Telegram bot setup failed: ${formatError(err)}`);
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

function isTruthyEnvValue(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  return (
    normalized === "1" ||
    normalized === "true" ||
    normalized === "yes" ||
    normalized === "on"
  );
}

function isLocalEmbeddingWarmupDeferredByEnv(): boolean {
  return isTruthyEnvValue(process.env.ELIZA_DEFER_LOCAL_EMBEDDING_WARMUP);
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
  upstreamConfigureLocalEmbeddingPlugin({} as Plugin, config);

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
      hotReload: isTruthyEnvValue(process.env.ELIZA_DEV_IS_HOT_RELOAD),
    })
  ) {
    return;
  }
  logger.info("[eliza] Starting deferred voice warmup");
  await warmVoiceModels(
    runtime as unknown as Parameters<typeof warmVoiceModels>[0],
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
  syncAppEnvToEliza();

  try {
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
      logger.info(
        "[eliza] Deferring local embedding warmup until runtime ready",
      );
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
  } finally {
    syncElizaEnvAliases();
  }
}

export interface StartElizaOptionsExt extends StartElizaOptions {
  /** Optional callback for embedding model download/init progress. */
  onEmbeddingProgress?: EmbeddingProgressCallback;
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

function isManualResetPgliteError(err: unknown): boolean {
  if (getPgliteErrorCode(err) === ELIZA_AUTO_RESET_PGLITE_ERROR_CODE) {
    return true;
  }

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

async function resetPluginSqlPgliteSingleton(context: string): Promise<void> {
  const globalSymbols = globalThis as typeof globalThis &
    Record<symbol, PluginSqlGlobalSingletons | undefined>;
  const singletons = globalSymbols[PLUGIN_SQL_GLOBAL_SINGLETONS];
  const manager = singletons?.pgLiteClientManager;

  if (manager && typeof manager.close === "function") {
    let closeTimedOut = false;
    let timeoutHandle: ReturnType<typeof setTimeout> | null = null;

    try {
      await Promise.race([
        Promise.resolve(manager.close()),
        new Promise<void>((resolve) => {
          timeoutHandle = setTimeout(() => {
            closeTimedOut = true;
            resolve();
          }, 1_000);
        }),
      ]);
    } catch (err) {
      logger.warn(
        `[eliza] ${context}: failed to close plugin-sql PGlite singleton: ${formatError(err)}`,
      );
    } finally {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
    }

    if (closeTimedOut) {
      logger.warn(
        `[eliza] ${context}: plugin-sql PGlite singleton close timed out; continuing with a forced reset`,
      );
    }
  }

  if (singletons?.pgLiteClientManager) {
    delete singletons.pgLiteClientManager;
  }
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
    getPgliteErrorCode(err) === ELIZA_AUTO_RESET_PGLITE_ERROR_CODE
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
  wrapped.code = ELIZA_AUTO_RESET_PGLITE_ERROR_CODE;
  if (dataDir) {
    wrapped.dataDir = dataDir;
  }
  return wrapped;
}

async function upstreamStartElizaWithPgliteCompat(
  options?: StartElizaOptions,
): Promise<Awaited<ReturnType<typeof upstreamStartEliza>>> {
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
  syncAppEnvToEliza();
  // Eliza app: load PTY / coding-swarm orchestration unless explicitly opted out.
  const orchRaw = process.env.ELIZA_AGENT_ORCHESTRATOR?.trim().toLowerCase();
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
  try {
    patchHttpCreateServerForCompat();
    const earlyCompatState = getSharedCompatRuntimeState();

    // Eagerly download the embedding model with progress reporting.
    // Fire-and-forget — see comment at the matching call in bootElizaRuntime
    // (W-016): awaiting parks bootstrap; voiding lets the API port bind on
    // time while the warmup runs alongside.
    if (isLocalEmbeddingWarmupDeferredByEnv()) {
      logger.info(
        "[eliza] Deferring local embedding warmup until runtime ready",
      );
    } else {
      startLocalEmbeddingWarmup(options?.onEmbeddingProgress);
    }

    // Cap embedding dimension to 384 — see comment in bootElizaRuntime.
    if (!process.env.EMBEDDING_DIMENSION) {
      process.env.EMBEDDING_DIMENSION = "384";
    }

    if (options?.serverOnly) {
      let currentRuntime =
        (await upstreamStartElizaWithPgliteCompat({
          ...options,
          headless: true,
          serverOnly: false,
        })) ?? undefined;

      currentRuntime = currentRuntime
        ? await repairRuntimeAfterBoot(currentRuntime)
        : currentRuntime;

      if (!currentRuntime) {
        return currentRuntime;
      }

      // Hand the live runtime to the early-installed compat wrapper so
      // `/api/tts/*`, `/api/database`, `/api/runtime/mode`, and every other
      // compat-dispatcher path can resolve. Without this, `state.current`
      // stays null and `handleCompatRoute` is never invoked even though the
      // patch is in place — the wrapper short-circuits on null state.
      earlyCompatState.current = currentRuntime;

      // Desktop launcher sets ELIZA_API_PORT (default 31337) to match the
      // renderer's hardcoded API base; honor it when present. CLI/server-only
      // mode (no ELIZA_API_PORT) keeps the legacy `resolveServerOnlyPort`
      // default (2138) so this change is transparent for non-desktop users.
      const apiPort = process.env.ELIZA_API_PORT
        ? resolveDesktopApiPort(process.env)
        : resolveServerOnlyPort(process.env);
      let actualApiPort: number;
      try {
        const startedApiServer = await startApiServer({
          port: apiPort,
          runtime: currentRuntime,
          onRestart: async () => {
            if (!currentRuntime) {
              return null;
            }

            await upstreamShutdownRuntime(
              currentRuntime,
              "server-only restart",
            );

            const restarted =
              (await upstreamStartElizaWithPgliteCompat({
                ...options,
                headless: true,
                serverOnly: false,
              })) ?? undefined;

            currentRuntime = restarted
              ? await repairRuntimeAfterBoot(restarted)
              : undefined;
            earlyCompatState.current = currentRuntime ?? null;

            return currentRuntime ?? null;
          },
        });
        actualApiPort = startedApiServer.port;
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

      // WHY: `startApiServer` may bind a different port than requested (busy
      // socket, upstream policy). Shells, scripts, and follow-up code reading
      // env must match the real listener or health checks and user-facing URLs
      // disagree with `GET /api/health`.
      syncResolvedApiPort(process.env, actualApiPort, {
        overwriteUiPort: true,
      });
      // Invalidate cached CORS port set so the new port is allowed.
      // server-cors is statically imported at the top of this module — the
      // previous dynamic import was INEFFECTIVE_DYNAMIC_IMPORT.
      invalidateCorsAllowedPorts();

      logger.info(
        `[eliza] API server listening on http://localhost:${actualApiPort}`,
      );
      console.log(`[eliza] Control UI: http://localhost:${actualApiPort}`);
      console.log("[eliza] Server running. Press Ctrl+C to stop.");

      const { buildSandboxRegistryFromEnv } = await import(
        "../services/sandbox-registry.js"
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
        stopTelegramBotPolling("SIGINT");
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
  } finally {
    syncElizaEnvAliases();
  }
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
