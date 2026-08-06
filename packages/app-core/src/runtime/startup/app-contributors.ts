/**
 * Registry-driven app-route, runtime-hook, and pre-ready boot contributors for
 * app-core startup. This module owns optional package resolution and contributor
 * ordering; the runtime host only invokes the three lifecycle drains.
 */
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { resolvePackageEntry } from "@elizaos/agent/runtime/plugin-types";
import {
  type AgentRuntime,
  isOptionalAppRoutePluginUnavailableError,
  logger,
  OptionalAppRoutePluginUnavailableError,
  type Plugin,
} from "@elizaos/core";
import {
  getApps,
  getPlugins,
  loadRegistry,
} from "@elizaos/registry/first-party";
import { formatErrorWithStack } from "@elizaos/shared";
import {
  type AppRoutePluginRegistryEntry,
  drainAppRoutePluginLoaders,
  listAppRoutePluginLoaders,
} from "../app-route-plugin-registry.js";

const _require = createRequire(import.meta.url);

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
 * too: `ELIZA_SKIP_APP_ROUTE_PLUGINS=lifeops,github,workflow`.
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

export async function registerAppRoutePlugins(
  runtime: AgentRuntime,
): Promise<void> {
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

export async function registerRuntimeHooks(
  runtime: AgentRuntime,
): Promise<void> {
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
export async function runBootHooks(runtime: AgentRuntime): Promise<void> {
  await drainBootHookContributors(runtime, getBootHookContributors());
}
