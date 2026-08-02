/**
 * App-core Eliza runtime loader: the single boot chokepoint every app-core agent
 * process funnels through. Wraps `@elizaos/agent`'s startEliza / bootElizaRuntime
 * with app-shell concerns — installs the agent host bridge (vault, account pool,
 * wallet-key hydration, cloud-pair route), syncs brand env aliases, binds the
 * API server (bind-first, then background runtime boot), repairs the runtime,
 * and composes the focused startup modules that own autonomy, PGlite recovery,
 * local-model warmup, and post-ready contributor ordering.
 *
 * It retains contributor discovery, the ELIZA_SKIP_APP_ROUTE_PLUGINS /
 * ELIZA_DEFER_APP_ROUTES policy (the tail defers by default;
 * ELIZA_DEFER_APP_ROUTES=0 opts back into the inline pre-ready tail), the
 * local-agent IPC port gate (#12180). Mobile platforms take a trimmed boot
 * path. Boot resources are scoped to one runtime so embedded hosts cannot
 * supersede or tear down each other's services.
 */
import "@elizaos/shared";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import {
  type BootElizaRuntimeOptions,
  CUSTOM_PLUGINS_DIRNAME,
  loadElizaConfig,
  resolvePackageEntry,
  type StartElizaOptions,
  scanDropInPlugins,
  applyCloudConfigToEnv as upstreamApplyCloudConfigToEnv,
  bootElizaRuntime as upstreamBootElizaRuntime,
  collectPluginNames as upstreamCollectPluginNames,
  shutdownRuntime as upstreamShutdownRuntime,
  startEliza as upstreamStartEliza,
} from "@elizaos/agent";
import { markDeferredBootPhase } from "@elizaos/agent/runtime/deferred-boot-status";
import { installAgentHostBridge } from "./install-agent-host-bridge.js";

export { CHANNEL_PLUGIN_MAP } from "./channel-plugin-map.js";

export { CUSTOM_PLUGINS_DIRNAME, resolvePackageEntry, scanDropInPlugins };

import {
  type AgentRuntime,
  CONNECTOR_TARGET_SOURCE_REGISTRY_SERVICE,
  ElizaError,
  isOptionalAppRoutePluginUnavailableError,
  logger,
  OptionalAppRoutePluginUnavailableError,
  type Plugin,
  type TargetSource,
} from "@elizaos/core";
import {
  getApps,
  getPlugins,
  loadRegistry,
} from "@elizaos/registry/first-party";
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
import { startApiServer } from "../api/server.js";
import { registerSubAgentCredentialBridgeAdapter } from "../services/credential-tunnel-service";
import { registerCoreSensitiveRequestAdapters } from "../services/sensitive-requests/index.js";
import {
  type AppRoutePluginRegistryEntry,
  drainAppRoutePluginLoaders,
  listAppRoutePluginLoaders,
} from "./app-route-plugin-registry.js";
import { ensureBundledFusedLibDir } from "./bundled-fused-lib.js";
import { configureAutonomy } from "./startup/autonomy.js";
import {
  attemptPgliteAutoReset,
  getPgliteRecoveryRetrySkipPlugins,
  normalizePgliteStartupError,
} from "./startup/pglite-recovery.js";
import { registerSubAgentCredentialBridge } from "./sub-agent-credential-bridge-wiring.js";

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
import {
  type EmbeddingProgressCallback,
  ensureDefaultEmbeddingDimension,
  prepareLocalEmbeddingWarmup,
  startDeferredLocalEmbeddingWarmup,
  startDeferredVoiceWarmup,
} from "./startup/local-model-warmup.js";
import {
  createRuntimeBootResources,
  type PostReadyBootSteps,
  type RuntimeBootResources,
  runPostReadyBootTail,
} from "./startup/post-ready.js";
import {
  type AppStartupPhase,
  AppStartupStateMachine,
} from "./startup-state.js";

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
    // error-policy:J4 optional plugin resolution — a missing local package is
    // represented as unavailable and handled distinctly by the plugin loader.
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
    // error-policy:J4 optional plugin resolution — only a genuine missing
    // package degrades to unavailable; all module execution failures rethrow.
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
 * and the `:routes` / `:ui` / `-app` / `-ui` / `-routes` suffixes. So
 * `@elizaos/plugin-wallet:ui` and `wallet` both normalize to `wallet`.
 */
export function normalizeAppRoutePluginId(id: string): string {
  return id
    .trim()
    .toLowerCase()
    .replace(/^@elizaos\/plugin-/, "")
    .replace(/:(routes|ui)$/, "")
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
  // (so both `@elizaos/plugin-wallet:ui` and `wallet` skip the same loader).
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
      // error-policy:J4 registry-declared optional integrations may be absent;
      // real contributor failures still propagate and fail the boot tail.
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
      // error-policy:J4 registry-declared optional integrations may be absent;
      // real contributor failures still propagate and fail pre-ready boot.
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

const runtimeBootResources = new WeakMap<AgentRuntime, RuntimeBootResources>();

async function repairRuntimeAfterBoot(
  runtime: AgentRuntime,
  resources: RuntimeBootResources,
  onPostReadyPhase?: (phase: "pending" | "complete" | "failed") => void,
): Promise<AgentRuntime> {
  runtimeBootResources.set(runtime, resources);
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
    markDeferredBootPhase("app-route-tail", "complete");
    onPostReadyPhase?.("complete");
    return runtime;
  }

  await configureAutonomy(runtime, isRuntimeAutonomyEnabled(process.env));

  // Post-ready tail: feature-route plugins, training hooks, sensitive-request
  // adapters, telegram polling, the trigger bridge, the connector catalog, and
  // voice warmup. None of these gate correctness of the first turn, so by
  // default they run in the background and ready flips before the tail
  // completes (feature routes may 404 for a brief window — poll /api/health
  // `deferredBoot.settled` before hitting them). ELIZA_DEFER_APP_ROUTES=0
  // opts back into awaiting the tail inline, identical in steps and order to
  // the pre-split path. The phase is marked pending before ready can flip so
  // a health probe never reads a not-yet-announced tail as settled.
  resources.tailRuntime = runtime;
  markDeferredBootPhase("app-route-tail", "pending");
  onPostReadyPhase?.("pending");
  if (getDeferAppRoutesEnabled()) {
    void runPostReadyBootTail(
      runtime,
      createPostReadyBootSteps(resources),
      resources,
    ).then(
      () => onPostReadyPhase?.("complete"),
      (err: unknown) => {
        // error-policy:J1 boundary translation — the deferred tail has no caller
        // left to throw to; a contributor or runtime-hook failure here would
        // otherwise vanish into an unhandled rejection. Mark the phase failed
        // (so health-pollers stop waiting) and surface it agent-visibly.
        markDeferredBootPhase("app-route-tail", "failed");
        logger.error(
          `[eliza] post-ready boot tail failed: ${formatErrorWithStack(err)}`,
        );
        runtime.reportError("eliza.postReadyBootTail", err, {
          phase: "app-route-tail",
        });
        onPostReadyPhase?.("failed");
      },
    );
    return runtime;
  }
  try {
    await runPostReadyBootTail(
      runtime,
      createPostReadyBootSteps(resources),
      resources,
    );
    onPostReadyPhase?.("complete");
  } catch (err) {
    // error-policy:J2 context-preserving rethrow — inline mode keeps the
    // pre-split contract (a tail failure fails the boot); only the phase
    // marker is updated so health never reports a failed tail as pending.
    markDeferredBootPhase("app-route-tail", "failed");
    onPostReadyPhase?.("failed");
    throw err;
  }
  return runtime;
}

/**
 * The post-ready boot steps, named so a focused unit test can inject stubs and
 * assert ordering / deferral / liveness / error-isolation without loading the
 * full runtime. Production passes {@link DEFAULT_POST_READY_BOOT_STEPS}.
 */
function createPostReadyBootSteps(
  resources: RuntimeBootResources,
): PostReadyBootSteps {
  return {
    registerAppRoutePlugins,
    registerRuntimeHooks,
    registerCoreSensitiveRequestAdapters,
    registerSubAgentCredentialBridge,
    registerSubAgentCredentialBridgeAdapter,
    ensureTriggerEventBridge: (runtime) =>
      ensureTriggerEventBridge(runtime, resources),
    ensureConnectorTargetCatalog: (runtime) =>
      ensureConnectorTargetCatalog(runtime, resources),
    startDeferredVoiceWarmup,
  };
}

export {
  createRuntimeBootResources,
  type PostReadyBootSteps,
  type RuntimeBootResources,
  runPostReadyBootTail,
};

const CONNECTOR_TARGET_CATALOG_SERVICE_TYPE = "connector_target_catalog";

async function ensureTriggerEventBridge(
  runtime: AgentRuntime,
  resources: RuntimeBootResources,
): Promise<void> {
  if (resources.triggerEventBridge) {
    resources.triggerEventBridge.stop();
    resources.triggerEventBridge = null;
  }
  const { startTriggerEventBridge } = await import(
    "../services/trigger-event-bridge.js"
  );
  resources.triggerEventBridge = startTriggerEventBridge(runtime);
  logger.info("[eliza] trigger event bridge armed");
}

async function ensureConnectorTargetCatalog(
  runtime: AgentRuntime,
  resources: RuntimeBootResources,
): Promise<void> {
  if (resources.connectorTargetCatalog) {
    resources.connectorTargetCatalog.stop();
    resources.connectorTargetCatalog = null;
  }
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
  resources.connectorTargetCatalog = {
    stop: () => {
      runtime.services.delete(CONNECTOR_TARGET_CATALOG_SERVICE_TYPE as never);
    },
  };
  logger.info("[eliza] connector-target-catalog registered");
}

function stopRuntimeBootResources(resources: RuntimeBootResources): void {
  resources.tailRuntime = null;
  if (resources.triggerEventBridge) {
    try {
      resources.triggerEventBridge.stop();
    } catch (error) {
      // error-policy:J6 bridge teardown must not prevent the remaining host
      // resources from being released.
      logger.warn(
        `[eliza] Trigger event bridge stop failed during shutdown: ${formatError(error)}`,
      );
    }
    resources.triggerEventBridge = null;
  }
  if (resources.connectorTargetCatalog) {
    try {
      resources.connectorTargetCatalog.stop();
    } catch (error) {
      // error-policy:J6 catalog teardown must not prevent runtime shutdown.
      logger.warn(
        `[eliza] Connector target catalog stop failed during shutdown: ${formatError(error)}`,
      );
    }
    resources.connectorTargetCatalog = null;
  }
}

export async function shutdownRuntime(
  ...args: Parameters<typeof upstreamShutdownRuntime>
): Promise<Awaited<ReturnType<typeof upstreamShutdownRuntime>>> {
  const runtime = args[0];
  if (runtime) {
    const resources = runtimeBootResources.get(runtime);
    if (resources) {
      stopRuntimeBootResources(resources);
      runtimeBootResources.delete(runtime);
    }
  }
  return await upstreamShutdownRuntime(...args);
}

async function failRuntimeRepair(
  runtime: AgentRuntime,
  scope: "boot" | "server-only-boot" | "start",
  repairError: unknown,
): Promise<never> {
  try {
    await shutdownRuntime(runtime, `${scope} repair failed`);
  } catch (shutdownError) {
    // error-policy:J2 preserve both the repair and cleanup failures so neither
    // root cause is hidden at the startup boundary.
    throw new ElizaError("Runtime repair and cleanup failed", {
      code: "APP_RUNTIME_REPAIR_CLEANUP_FAILED",
      cause: new AggregateError([repairError, shutdownError]),
      context: { scope },
      severity: "fatal",
    });
  }
  throw new ElizaError("App-core runtime repair failed", {
    code: "APP_RUNTIME_REPAIR_FAILED",
    cause: repairError,
    context: { scope },
    severity: "fatal",
  });
}

export { startDeferredLocalEmbeddingWarmup };

export interface BootElizaRuntimeOptionsExt extends BootElizaRuntimeOptions {
  /** Optional callback for embedding model download/init progress. */
  onEmbeddingProgress?: EmbeddingProgressCallback;
}

export async function bootElizaRuntime(
  opts: BootElizaRuntimeOptionsExt = {},
): Promise<Awaited<ReturnType<typeof upstreamBootElizaRuntime>>> {
  const bootResources = createRuntimeBootResources();
  // Eagerly download the embedding model before the full runtime boot.
  // This way the TUI loading screen (or server logs) can show download
  // progress instead of the app silently stalling on first embedding call.
  // Fire-and-forget: warmupEmbeddingModelImpl declares "non-fatal: will
  // retry on first use" semantics, and self-serializes via the module-level
  // warmupInFlight singleton. Awaiting it here parked bootstrap on sticky
  // HF 401 → multi-URL fallback chains with no overall deadline; the API
  // port never bound and dev-ui.mjs's 300s watchdog tore the stack down
  // (W-016). Voiding lets bootstrap proceed; the renderer's startup overlay
  // still surfaces progress through the startup overlay.
  prepareLocalEmbeddingWarmup(opts.onEmbeddingProgress);

  // Default the embedding-vector dimension plugin-sql provisions to 384 when
  // unset: that is the compact SQL-safe column and the native width of the
  // standalone gte-small embedding model. Setting it here lets plugin-sql
  // provision the column without a boot-time model probe (see core
  // provisioning). An explicit EMBEDDING_DIMENSION — a different local model,
  // the desktop Eliza-1 sidecar's Matryoshka width, or cloud embeddings —
  // still wins.
  ensureDefaultEmbeddingDimension();

  const runtime = await upstreamBootElizaRuntime(opts);
  // Voice warmup fires inside repairRuntimeAfterBoot (the shared ready-point).
  if (!runtime) return runtime;
  try {
    return await repairRuntimeAfterBoot(runtime, bootResources);
  } catch (error) {
    // error-policy:J2 a failed app-core repair cannot leave the upstream
    // runtime alive after bootElizaRuntime rejects.
    return await failRuntimeRepair(runtime, "boot", error);
  }
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
  /** Receives the closeable server host without giving bootstrap process ownership. */
  onServerOnlyHostReady?: (
    host: import("./server-only-process").ServerOnlyHost,
  ) => void;
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
    // error-policy:J2 startup compatibility translation — preserve the
    // upstream database error as the normalized startup error's cause.
    throw normalizePgliteStartupError(err);
  }
}

export { attemptPgliteAutoReset, getPgliteRecoveryRetrySkipPlugins };

export async function startEliza(
  options?: StartElizaOptionsExt,
): Promise<Awaited<ReturnType<typeof upstreamStartEliza>>> {
  const bootResources = createRuntimeBootResources();
  // Eliza app: load PTY / coding-swarm orchestration unless explicitly opted out.
  const orchRaw = readAliasedEnv("ELIZA_AGENT_ORCHESTRATOR")?.toLowerCase();
  if (orchRaw !== "0" && orchRaw !== "false" && orchRaw !== "no") {
    process.env.ELIZA_AGENT_ORCHESTRATOR = "1";
  }

  // Eagerly download the embedding model with progress reporting.
  // Fire-and-forget — see comment at the matching call in bootElizaRuntime
  // (W-016): awaiting parks bootstrap; voiding lets the API port bind on
  // time while the warmup runs alongside.
  prepareLocalEmbeddingWarmup(options?.onEmbeddingProgress);

  // Cap embedding dimension to 384 — see comment in bootElizaRuntime.
  ensureDefaultEmbeddingDimension();

  if (options?.serverOnly) {
    bootLap("startEliza:serverOnly entry");
    let currentRuntime: AgentRuntime | undefined;
    let runtimePublished = false;
    let postReadyPhase: "pending" | "complete" | "failed" = "pending";
    const startup = new AppStartupStateMachine();
    const publishStartup = (phase: AppStartupPhase): void => {
      const snapshot = startup.transition(phase);
      updateStartup?.({
        phase: snapshot.phase,
        attempt: snapshot.attempt,
        state: snapshot.agentState,
      });
    };
    const publishPostReadyPhase = (
      phase: "pending" | "complete" | "failed",
    ): void => {
      postReadyPhase = phase;
      if (!runtimePublished) return;
      publishStartup(
        phase === "pending"
          ? "features-starting"
          : phase === "complete"
            ? "ready"
            : "degraded",
      );
    };

    // Boot (or re-boot) the runtime headless and run app-core repair before it
    // is published to the API server. Used for both initial asynchronous boot
    // and the `/api/agent/restart` handler.
    const bootServerOnlyRuntime = async (): Promise<
      AgentRuntime | undefined
    > => {
      const booted =
        (await upstreamStartElizaWithPgliteCompat({
          ...options,
          headless: true,
          serverOnly: false,
        })) ?? undefined;
      if (!booted) return booted;
      try {
        return await repairRuntimeAfterBoot(
          booted,
          bootResources,
          publishPostReadyPhase,
        );
      } catch (error) {
        // error-policy:J2 a failed repair must release the runtime that the API
        // has not published yet.
        return await failRuntimeRepair(booted, "server-only-boot", error);
      }
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
    let closeApiServer: (() => Promise<void>) | undefined;
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
        runtimePublished = false;
        postReadyPhase = "pending";
        publishStartup("runtime-starting");
        try {
          currentRuntime = await bootServerOnlyRuntime();
        } catch (err) {
          // error-policy:J2 context-adding rethrow — flip the reported agent
          // state to "error" first so /api/status never reads healthy.
          publishStartup("failed");
          throw new Error("Runtime boot after onboarding failed", {
            cause: err,
          });
        }
        if (!currentRuntime) {
          publishStartup("failed");
          throw new Error("Runtime boot after onboarding returned no runtime");
        }
        updateRuntime?.(currentRuntime);
        runtimePublished = true;
        publishPostReadyPhase(postReadyPhase);
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
            await shutdownRuntime(currentRuntime, "server-only restart");
          }
          runtimePublished = false;
          postReadyPhase = "pending";
          publishStartup("runtime-starting");
          try {
            currentRuntime = await bootServerOnlyRuntime();
          } catch (error) {
            // error-policy:J1 restart orchestration boundary — publish a failed
            // lifecycle state before propagating the boot failure to the route.
            publishStartup("failed");
            throw error;
          }
          if (!currentRuntime) {
            publishStartup("failed");
            return null;
          }
          runtimePublished = true;
          publishPostReadyPhase(postReadyPhase);
          return currentRuntime ?? null;
        },
      });
      actualApiPort = startedApiServer.port;
      updateRuntime = startedApiServer.updateRuntime;
      updateStartup = startedApiServer.updateStartup;
      closeApiServer = startedApiServer.close;
      publishStartup("api-bound");
    } catch (apiErr) {
      // error-policy:J1 API-bind boundary — publish terminal startup state and
      // propagate the bind failure to the CLI/process owner.
      const apiErrMsg =
        apiErr instanceof Error
          ? (apiErr.stack ?? apiErr.message)
          : String(apiErr);
      logger.error(`[eliza] API server failed to start: ${apiErrMsg}`);
      publishStartup("failed");
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
      logger.info(`[eliza] Control UI: http://localhost:${actualApiPort}`);
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
      publishStartup("awaiting-onboarding");
      logger.info(
        "[eliza] Fresh install — agent runtime boot deferred until onboarding commits (onboarding API routes are live)",
      );
      bootLap("startEliza:runtime boot deferred (awaiting onboarding)");
    } else {
      // Now boot the runtime; the API is already reachable (state "starting"),
      // so the UI is connecting + hydrating while this runs, then flips to
      // "running" once the agent is ready.
      publishStartup("runtime-starting");
      try {
        currentRuntime = await bootServerOnlyRuntime();
      } catch (error) {
        // error-policy:J1 initial-boot boundary — close the already-bound API
        // server and propagate failure after publishing terminal startup state.
        publishStartup("failed");
        await closeApiServer?.();
        throw error;
      }
      if (!currentRuntime) {
        publishStartup("failed");
        await closeApiServer?.();
        return currentRuntime;
      }
      updateRuntime?.(currentRuntime);
      runtimePublished = true;
      publishPostReadyPhase(postReadyPhase);
      bootLap("startEliza:runtime booted + ready:true");
    }

    logger.info("[eliza] Server running. Press Ctrl+C to stop.");

    const { buildSandboxRegistryFromEnv } = await import(
      "@elizaos/shared/sandbox-registry"
    );
    const sandboxRegistry = buildSandboxRegistryFromEnv();
    if (sandboxRegistry) {
      try {
        await sandboxRegistry.register();
      } catch (err) {
        // error-policy:J7 registry heartbeat can recover after an initial
        // registration failure; surface the degraded routing path to the agent.
        logger.error(
          `[eliza] Failed to register sandbox in Redis (gateways will not route inbound platform messages here until the next heartbeat succeeds): ${formatError(err)}`,
        );
        currentRuntime?.reportError("eliza.sandboxRegistry", err, {
          phase: "register",
        });
      }
      sandboxRegistry.startHeartbeat(30_000);
    }

    let isClosed = false;
    const close = async (): Promise<void> => {
      if (isClosed) return;
      isClosed = true;
      runtimePublished = false;
      publishStartup("stopping");
      await closeApiServer?.();
      if (sandboxRegistry) {
        sandboxRegistry.stopHeartbeat();
        try {
          await sandboxRegistry.unregister();
        } catch (err) {
          // error-policy:J6 best-effort teardown — Redis keys expire by TTL and
          // the shutdown path remains observable through this warning.
          logger.warn(
            `[eliza] Sandbox unregister failed (keys will expire via TTL): ${formatError(err)}`,
          );
        }
      }
      if (currentRuntime) {
        await shutdownRuntime(currentRuntime, "server-only shutdown");
      } else {
        stopRuntimeBootResources(bootResources);
      }
    };
    options.onServerOnlyHostReady?.({
      port: actualApiPort,
      getRuntime: () => currentRuntime,
      close,
    });
    return currentRuntime;
  }

  const runtime = await upstreamStartElizaWithPgliteCompat(options);
  if (!runtime) return runtime;
  try {
    return await repairRuntimeAfterBoot(runtime, bootResources);
  } catch (error) {
    // error-policy:J2 startEliza owns the unpublished runtime until repair
    // succeeds, so rejection includes teardown and preserves the cause.
    return await failRuntimeRepair(runtime, "start", error);
  }
}
