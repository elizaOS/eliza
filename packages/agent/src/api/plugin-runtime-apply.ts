import { type AgentRuntime, logger } from "@elizaos/core";
import type { ElizaConfig } from "../config/config.ts";
import { supportsRuntimePluginLifecycle } from "../runtime/plugin-lifecycle.ts";
import type { ResolvedPlugin } from "../runtime/plugin-types.ts";

export type PluginRuntimeApplyMode =
  | "none"
  | "config_apply"
  | "plugin_reload"
  | "runtime_reload"
  | "restart_required";

export interface PluginRuntimeApplyResult {
  mode: PluginRuntimeApplyMode;
  requiresRestart: boolean;
  restartedRuntime: boolean;
  loadedPackages: string[];
  unloadedPackages: string[];
  reloadedPackages: string[];
  appliedConfigPackage: string | null;
  reason: string;
}

interface ApplyPluginRuntimeMutationOptions {
  runtime: AgentRuntime | null;
  previousConfig: ElizaConfig;
  nextConfig: ElizaConfig;
  previousResolvedPlugins?: ResolvedPlugin[];
  nextResolvedPlugins?: ResolvedPlugin[];
  changedPluginId?: string;
  changedPluginPackage?: string;
  config?: Record<string, string>;
  forceReloadPackages?: string[];
  expectRuntimeGraphChange?: boolean;
  reason: string;
  restartRuntime?: (reason: string) => Promise<boolean>;
}

function normalizePluginIdentity(value: string): string {
  return value
    .replace(/^@[^/]+\//, "")
    .replace(/^plugin-/, "")
    .trim()
    .toLowerCase();
}

function buildResolvedPluginMap(
  plugins: ResolvedPlugin[],
): Map<string, ResolvedPlugin> {
  return new Map(plugins.map((plugin) => [plugin.name, plugin]));
}

function resolveTargetPackageName(
  runtime: AgentRuntime,
  previousResolvedMap: Map<string, ResolvedPlugin>,
  nextResolvedMap: Map<string, ResolvedPlugin>,
  changedPluginId?: string,
  changedPluginPackage?: string,
): string | null {
  if (
    changedPluginPackage &&
    (previousResolvedMap.has(changedPluginPackage) ||
      nextResolvedMap.has(changedPluginPackage))
  ) {
    return changedPluginPackage;
  }

  const targetId = changedPluginId
    ? normalizePluginIdentity(changedPluginId)
    : null;
  if (!targetId) return null;

  for (const packageName of [
    ...previousResolvedMap.keys(),
    ...nextResolvedMap.keys(),
  ]) {
    if (normalizePluginIdentity(packageName) === targetId) {
      return packageName;
    }
  }

  const runtimePlugins = Array.isArray(
    (runtime as { plugins?: unknown }).plugins,
  )
    ? (runtime as { plugins: Array<{ name: string }> }).plugins
    : [];

  for (const plugin of runtimePlugins) {
    if (normalizePluginIdentity(plugin.name) !== targetId) continue;
    for (const [packageName, resolvedPlugin] of nextResolvedMap) {
      if (resolvedPlugin.plugin.name === plugin.name) {
        return packageName;
      }
    }
    for (const [packageName, resolvedPlugin] of previousResolvedMap) {
      if (resolvedPlugin.plugin.name === plugin.name) {
        return packageName;
      }
    }
  }

  return null;
}

async function resolvePluginsForConfig(
  config: ElizaConfig,
): Promise<ResolvedPlugin[]> {
  const { resolvePlugins } = await import("../runtime/plugin-resolver.ts");
  return await resolvePlugins(config, { quiet: true });
}

function packageRequiresRuntimeReload(
  packageName: string,
  previousResolvedMap: Map<string, ResolvedPlugin>,
  nextResolvedMap: Map<string, ResolvedPlugin>,
): boolean {
  const previousPlugin = previousResolvedMap.get(packageName)?.plugin;
  const nextPlugin = nextResolvedMap.get(packageName)?.plugin;
  return Boolean(previousPlugin?.adapter || nextPlugin?.adapter);
}

export async function applyPluginRuntimeMutation(
  options: ApplyPluginRuntimeMutationOptions,
): Promise<PluginRuntimeApplyResult> {
  const {
    runtime,
    previousConfig,
    nextConfig,
    changedPluginId,
    changedPluginPackage,
    config,
    forceReloadPackages = [],
    expectRuntimeGraphChange = false,
    reason,
    restartRuntime,
  } = options;

  if (!runtime) {
    return {
      mode: "none",
      requiresRestart: false,
      restartedRuntime: false,
      loadedPackages: [],
      unloadedPackages: [],
      reloadedPackages: [],
      appliedConfigPackage: null,
      reason,
    };
  }

  const tryRuntimeRestart = async (): Promise<PluginRuntimeApplyResult> => {
    if (!restartRuntime) {
      return {
        mode: "restart_required",
        requiresRestart: true,
        restartedRuntime: false,
        loadedPackages: [],
        unloadedPackages: [],
        reloadedPackages: [],
        appliedConfigPackage: null,
        reason,
      };
    }

    const restartedRuntime = await restartRuntime(reason);
    return {
      mode: restartedRuntime ? "runtime_reload" : "restart_required",
      requiresRestart: !restartedRuntime,
      restartedRuntime,
      loadedPackages: [],
      unloadedPackages: [],
      reloadedPackages: [],
      appliedConfigPackage: null,
      reason,
    };
  };

  let previousResolvedPlugins: ResolvedPlugin[];
  let nextResolvedPlugins: ResolvedPlugin[];
  try {
    previousResolvedPlugins =
      options.previousResolvedPlugins ??
      (await resolvePluginsForConfig(previousConfig));
    nextResolvedPlugins =
      options.nextResolvedPlugins ??
      (await resolvePluginsForConfig(nextConfig));
  } catch (error) {
    logger.warn(
      `[plugin-runtime-apply] Failed to resolve plugin graph for "${reason}": ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return await tryRuntimeRestart();
  }
  const previousResolvedMap = buildResolvedPluginMap(previousResolvedPlugins);
  const nextResolvedMap = buildResolvedPluginMap(nextResolvedPlugins);

  const previousPackages = new Set(previousResolvedMap.keys());
  const nextPackages = new Set(nextResolvedMap.keys());
  const removedPackages = [...previousPackages].filter(
    (packageName) => !nextPackages.has(packageName),
  );
  const addedPackages = [...nextPackages].filter(
    (packageName) => !previousPackages.has(packageName),
  );
  const targetPackageName = resolveTargetPackageName(
    runtime,
    previousResolvedMap,
    nextResolvedMap,
    changedPluginId,
    changedPluginPackage,
  );

  let appliedConfigPackage: string | null = null;
  const reloadPackages = new Set(forceReloadPackages);
  if (
    config &&
    targetPackageName &&
    nextResolvedMap.has(targetPackageName) &&
    !removedPackages.includes(targetPackageName)
  ) {
    const runtimePluginName =
      nextResolvedMap.get(targetPackageName)?.plugin.name;
    let appliedConfig = false;
    try {
      if (
        runtimePluginName &&
        supportsRuntimePluginLifecycle(runtime) &&
        (await runtime.applyPluginConfig?.(runtimePluginName, config))
      ) {
        appliedConfig = true;
      }
    } catch (error) {
      logger.warn(
        `[plugin-runtime-apply] In-place config apply failed for ${targetPackageName}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      appliedConfig = false;
    }
    if (appliedConfig) {
      appliedConfigPackage = targetPackageName;
    } else {
      reloadPackages.add(targetPackageName);
    }
  }

  if (
    removedPackages.length === 0 &&
    addedPackages.length === 0 &&
    reloadPackages.size === 0
  ) {
    if (expectRuntimeGraphChange && !appliedConfigPackage) {
      return await tryRuntimeRestart();
    }
    return {
      mode: appliedConfigPackage ? "config_apply" : "none",
      requiresRestart: false,
      restartedRuntime: false,
      loadedPackages: [],
      unloadedPackages: [],
      reloadedPackages: [],
      appliedConfigPackage,
      reason,
    };
  }

  const allChangedPackages = new Set([
    ...removedPackages,
    ...addedPackages,
    ...reloadPackages,
  ]);
  const needsRuntimeReload = [...allChangedPackages].some((packageName) =>
    packageRequiresRuntimeReload(
      packageName,
      previousResolvedMap,
      nextResolvedMap,
    ),
  );

  if (!supportsRuntimePluginLifecycle(runtime) || needsRuntimeReload) {
    const restartResult = await tryRuntimeRestart();
    return { ...restartResult, appliedConfigPackage };
  }

  const unloadedPackages: string[] = [];
  const loadedPackages: string[] = [];
  const reloadedPackages: string[] = [];

  try {
    for (const packageName of [
      ...removedPackages,
      ...[...reloadPackages].filter((name) => previousResolvedMap.has(name)),
    ]) {
      const runtimePluginName =
        previousResolvedMap.get(packageName)?.plugin.name;
      if (!runtimePluginName) continue;
      await runtime.unloadPlugin?.(runtimePluginName);
      unloadedPackages.push(packageName);
    }

    for (const packageName of reloadPackages) {
      const nextResolved = nextResolvedMap.get(packageName);
      if (!nextResolved) continue;
      await runtime.registerPlugin(nextResolved.plugin);
      reloadedPackages.push(packageName);
    }

    for (const packageName of addedPackages) {
      const nextResolved = nextResolvedMap.get(packageName);
      if (!nextResolved) continue;
      await runtime.registerPlugin(nextResolved.plugin);
      loadedPackages.push(packageName);
    }

    return {
      mode: "plugin_reload",
      requiresRestart: false,
      restartedRuntime: false,
      loadedPackages,
      unloadedPackages,
      reloadedPackages,
      appliedConfigPackage,
      reason,
    };
  } catch (error) {
    logger.warn(
      `[plugin-runtime-apply] Plugin reload failed for "${reason}": ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    const restartResult = await tryRuntimeRestart();
    return { ...restartResult, appliedConfigPackage };
  }
}
