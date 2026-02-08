import { logger } from "./logger";

import type { Plugin } from "./types";
import { detectEnvironment } from "./utils/environment";

const attemptedInstalls = new Set<string>();

function isAutoInstallAllowed(): boolean {
  if (process.env.ELIZA_NO_AUTO_INSTALL === "true") return false;
  if (process.env.ELIZA_NO_PLUGIN_AUTO_INSTALL === "true") return false;
  if (process.env.CI === "true") return false;
  if (process.env.ELIZA_TEST_MODE === "true") return false;
  if (process.env.NODE_ENV === "test") return false;
  return true;
}

export async function tryInstallPlugin(pluginName: string): Promise<boolean> {
  try {
    if (!isAutoInstallAllowed()) {
      logger.debug(
        { src: "core:plugin", pluginName },
        "Auto-install disabled, skipping",
      );
      return false;
    }

    if (attemptedInstalls.has(pluginName)) {
      logger.debug(
        { src: "core:plugin", pluginName },
        "Auto-install already attempted, skipping",
      );
      return false;
    }
    attemptedInstalls.add(pluginName);

    if (typeof Bun === "undefined" || typeof Bun.spawn !== "function") {
      logger.warn(
        { src: "core:plugin", pluginName },
        "Bun runtime not available, cannot auto-install",
      );
      return false;
    }

    try {
      const check = Bun.spawn(["bun", "--version"], {
        stdout: "pipe",
        stderr: "pipe",
      });
      const code = await check.exited;
      if (code !== 0) {
        logger.warn(
          { src: "core:plugin", pluginName },
          "Bun not available on PATH, cannot auto-install",
        );
        return false;
      }
    } catch {
      logger.warn(
        { src: "core:plugin", pluginName },
        "Bun not available on PATH, cannot auto-install",
      );
      return false;
    }

    logger.info(
      { src: "core:plugin", pluginName },
      "Auto-installing missing plugin",
    );
    const install = Bun.spawn(["bun", "add", pluginName], {
      cwd: process.cwd(),
      env: process.env as Record<string, string>,
      stdout: "inherit",
      stderr: "inherit",
    });
    const exit = await install.exited;

    if (exit === 0) {
      logger.info(
        { src: "core:plugin", pluginName },
        "Plugin installed, retrying import",
      );
      return true;
    }

    logger.error(
      { src: "core:plugin", pluginName, exitCode: exit },
      "Plugin installation failed",
    );
    return false;
  } catch (error) {
    logger.error(
      { src: "core:plugin", pluginName, error },
      "Error during plugin installation",
    );
    return false;
  }
}

export function isValidPluginShape(obj: unknown): obj is Plugin {
  if (!obj || typeof obj !== "object") {
    return false;
  }

  const plugin = obj as Record<string, unknown>;
  if (!plugin.name) {
    return false;
  }

  return !!(
    plugin.init ||
    plugin.services ||
    plugin.providers ||
    plugin.actions ||
    plugin.evaluators ||
    plugin.description
  );
}

export function validatePlugin(plugin: unknown): {
  isValid: boolean;
  errors: string[];
} {
  const errors: string[] = [];

  if (!plugin) {
    errors.push("Plugin is null or undefined");
    return { isValid: false, errors };
  }

  const pluginObj = plugin as Record<string, unknown>;

  if (!pluginObj.name) {
    errors.push("Plugin must have a name");
  }

  if (pluginObj.actions) {
    if (!Array.isArray(pluginObj.actions)) {
      errors.push("Plugin actions must be an array");
    } else {
      const invalidActions = pluginObj.actions.filter(
        (a) => typeof a !== "object" || !a,
      );
      if (invalidActions.length > 0) {
        errors.push("Plugin actions must be an array of action objects");
      }
    }
  }

  if (pluginObj.services) {
    if (!Array.isArray(pluginObj.services)) {
      errors.push("Plugin services must be an array");
    } else {
      const invalidServices = pluginObj.services.filter(
        (s) => typeof s !== "function" && (typeof s !== "object" || !s),
      );
      if (invalidServices.length > 0) {
        errors.push(
          "Plugin services must be an array of service classes or objects",
        );
      }
    }
  }

  if (pluginObj.providers && !Array.isArray(pluginObj.providers)) {
    errors.push("Plugin providers must be an array");
  }

  if (pluginObj.evaluators && !Array.isArray(pluginObj.evaluators)) {
    errors.push("Plugin evaluators must be an array");
  }

  return {
    isValid: errors.length === 0,
    errors,
  };
}

export async function loadAndPreparePlugin(
  pluginName: string,
): Promise<Plugin | null> {
  let pluginModule: unknown;

  try {
    pluginModule = await import(pluginName);
  } catch (error: unknown) {
    logger.warn(
      { src: "core:plugin", pluginName, error },
      "Failed to load plugin",
    );
    const attempted = await tryInstallPlugin(pluginName);
    if (!attempted) {
      return null;
    }
    try {
      pluginModule = await import(pluginName);
    } catch (secondError: unknown) {
      logger.error(
        { src: "core:plugin", pluginName, error: secondError },
        "Import failed after auto-install",
      );
      return null;
    }
  }

  if (!pluginModule) {
    logger.error(
      { src: "core:plugin", pluginName },
      "Failed to load plugin module",
    );
    return null;
  }
  const expectedFunctionName = `${pluginName
    .replace(/^@elizaos\/plugin-/, "")
    .replace(/^@elizaos\//, "")
    .replace(/-./g, (match) => match[1].toUpperCase())}Plugin`;

  const moduleObj = pluginModule as Record<string, unknown>;
  const exportsToCheck = [
    moduleObj[expectedFunctionName],
    moduleObj.default,
    ...Object.values(moduleObj),
  ];

  for (const potentialPlugin of exportsToCheck) {
    if (isValidPluginShape(potentialPlugin)) {
      return potentialPlugin as Plugin;
    }
    if (typeof potentialPlugin === "function" && potentialPlugin.length === 0) {
      const produced = potentialPlugin();
      if (isValidPluginShape(produced)) {
        return produced as Plugin;
      }
    }
  }

  logger.warn(
    { src: "core:plugin", pluginName },
    "No valid plugin export found",
  );
  return null;
}

export function normalizePluginName(pluginName: string): string {
  const scopedMatch = pluginName.match(/^@[^/]+\/plugin-(.+)$/);
  if (scopedMatch) {
    return scopedMatch[1];
  }
  return pluginName;
}

export function resolvePluginDependencies(
  availablePlugins: Map<string, Plugin>,
  isTestMode: boolean = false,
): Plugin[] {
  const resolutionOrder: string[] = [];
  const visited = new Set<string>();
  const visiting = new Set<string>();

  const lookupMap = new Map<string, Plugin>();
  for (const [key, plugin] of availablePlugins.entries()) {
    lookupMap.set(key, plugin);
    if (plugin.name !== key) {
      lookupMap.set(plugin.name, plugin);
    }
    if (!plugin.name.startsWith("@")) {
      lookupMap.set(`@elizaos/plugin-${plugin.name}`, plugin);
    }
    const normalizedKey = normalizePluginName(key);
    if (normalizedKey !== key) {
      lookupMap.set(normalizedKey, plugin);
    }
  }

  function visit(pluginName: string) {
    const plugin = lookupMap.get(pluginName);

    if (!plugin) {
      const normalizedName = normalizePluginName(pluginName);
      const pluginByNormalized = lookupMap.get(normalizedName);

      if (!pluginByNormalized) {
        logger.warn(
          { src: "core:plugin", pluginName },
          "Plugin dependency not found, skipping",
        );
        return;
      }

      return visit(pluginByNormalized.name);
    }

    const canonicalName = plugin.name;

    if (visited.has(canonicalName)) return;
    if (visiting.has(canonicalName)) {
      logger.error(
        { src: "core:plugin", pluginName: canonicalName },
        "Circular dependency detected",
      );
      return;
    }

    visiting.add(canonicalName);

    const deps = [...(plugin.dependencies || [])];
    if (isTestMode) {
      deps.push(...(plugin.testDependencies || []));
    }
    for (const dep of deps) {
      visit(dep);
    }

    visiting.delete(canonicalName);
    visited.add(canonicalName);
    resolutionOrder.push(canonicalName);
  }

  for (const plugin of availablePlugins.values()) {
    if (!visited.has(plugin.name)) {
      visit(plugin.name);
    }
  }

  const finalPlugins = resolutionOrder
    .map((name) => {
      for (const plugin of availablePlugins.values()) {
        if (plugin.name === name) {
          return plugin;
        }
      }
      return null;
    })
    .filter((p): p is Plugin => Boolean(p));

  logger.debug(
    { src: "core:plugin", plugins: finalPlugins.map((p) => p.name) },
    "Plugins resolved",
  );

  return finalPlugins;
}

export async function loadPlugin(
  nameOrPlugin: string | Plugin,
): Promise<Plugin | null> {
  if (typeof nameOrPlugin === "string") {
    return loadAndPreparePlugin(nameOrPlugin);
  }

  const validation = validatePlugin(nameOrPlugin);
  if (!validation.isValid) {
    logger.error(
      { src: "core:plugin", errors: validation.errors },
      "Invalid plugin provided",
    );
    return null;
  }

  return nameOrPlugin;
}

function queueDependency(
  depName: string,
  seenDependencies: Set<string>,
  pluginMap: Map<string, Plugin>,
  queue: (string | Plugin)[],
): void {
  const normalizedDepName = normalizePluginName(depName);

  const alreadyQueued =
    seenDependencies.has(depName) ||
    seenDependencies.has(normalizedDepName) ||
    Array.from(pluginMap.keys()).some(
      (key) => normalizePluginName(key) === normalizedDepName,
    ) ||
    Array.from(pluginMap.values()).some(
      (p) =>
        normalizePluginName(p.name) === normalizedDepName ||
        p.name === depName ||
        p.name === normalizedDepName,
    );

  if (!alreadyQueued) {
    seenDependencies.add(depName);
    seenDependencies.add(normalizedDepName);
    queue.push(depName);
  }
}

async function resolvePluginsImpl(
  plugins: (string | Plugin)[],
  isTestMode: boolean = false,
): Promise<Plugin[]> {
  const pluginMap = new Map<string, Plugin>();
  const seenDependencies = new Set<string>();

  // First pass: add all Plugin objects to the map before processing dependencies
  // This ensures dependency resolution can find already-provided plugins
  for (const p of plugins) {
    if (typeof p !== "string") {
      const validation = validatePlugin(p);
      if (validation.isValid) {
        pluginMap.set(p.name, p);
        seenDependencies.add(p.name);
        seenDependencies.add(normalizePluginName(p.name));
      }
    }
  }

  // Second pass: process all plugins and their dependencies
  const queue: (string | Plugin)[] = [...plugins];
  let queueIndex = 0;

  while (queueIndex < queue.length) {
    const next = queue[queueIndex];
    queueIndex += 1;
    if (!next) continue;
    const loaded = await loadPlugin(next);
    if (!loaded) continue;

    const canonicalName = loaded.name;

    if (!pluginMap.has(canonicalName)) {
      pluginMap.set(canonicalName, loaded);

      for (const depName of loaded.dependencies ?? []) {
        queueDependency(depName, seenDependencies, pluginMap, queue);
      }

      if (isTestMode) {
        for (const depName of loaded.testDependencies ?? []) {
          queueDependency(depName, seenDependencies, pluginMap, queue);
        }
      }
    }
  }

  return resolvePluginDependencies(pluginMap, isTestMode);
}

export async function resolvePlugins(
  plugins: (string | Plugin)[],
  isTestMode: boolean = false,
): Promise<Plugin[]> {
  const env = detectEnvironment();

  if (env === "node") {
    return resolvePluginsImpl(plugins, isTestMode);
  }

  const pluginObjects = plugins.filter(
    (p): p is Plugin => typeof p !== "string",
  );

  if (plugins.some((p) => typeof p === "string")) {
    const skippedPlugins = plugins.filter((p) => typeof p === "string");
    logger.warn(
      { src: "core:plugin", skippedPlugins },
      "Browser environment: String plugin references not supported",
    );
  }

  const pluginMap = new Map<string, Plugin>();
  for (const plugin of pluginObjects) {
    pluginMap.set(plugin.name, plugin);
  }

  return resolvePluginDependencies(pluginMap, isTestMode);
}
