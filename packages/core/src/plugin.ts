import { logger } from './logger';
import { detectEnvironment } from './utils/environment';
import type { Plugin } from './types';

// ============================================================================
// Plugin Installation Utilities
// ============================================================================

/**
 * Track attempted plugin installations per process
 */
const attemptedInstalls = new Set<string>();

/**
 * Check if auto-install is allowed in current environment
 */
function isAutoInstallAllowed(): boolean {
  if (process.env.ELIZA_NO_AUTO_INSTALL === 'true') return false;
  if (process.env.ELIZA_NO_PLUGIN_AUTO_INSTALL === 'true') return false;
  if (process.env.CI === 'true') return false;
  if (process.env.ELIZA_TEST_MODE === 'true') return false;
  if (process.env.NODE_ENV === 'test') return false;
  return true;
}

/**
 * Attempt to install a plugin using Bun
 * Returns true if installation succeeded, false otherwise
 */
export async function tryInstallPlugin(pluginName: string): Promise<boolean> {
  try {
    if (!isAutoInstallAllowed()) {
      logger.debug(
        `Auto-install disabled or not allowed in this environment. Skipping install for ${pluginName}.`
      );
      return false;
    }

    if (attemptedInstalls.has(pluginName)) {
      logger.debug(`Auto-install already attempted for ${pluginName}. Skipping.`);
      return false;
    }
    attemptedInstalls.add(pluginName);

    // Check if Bun is available before trying to use it
    if (typeof Bun === 'undefined' || typeof Bun.spawn !== 'function') {
      logger.warn(
        `Bun runtime not available. Cannot auto-install ${pluginName}. Please run: bun add ${pluginName}`
      );
      return false;
    }

    // Verify Bun availability on PATH
    try {
      const check = Bun.spawn(['bun', '--version'], { stdout: 'pipe', stderr: 'pipe' });
      const code = await check.exited;
      if (code !== 0) {
        logger.warn(
          `Bun not available on PATH. Cannot auto-install ${pluginName}. Please run: bun add ${pluginName}`
        );
        return false;
      }
    } catch {
      logger.warn(
        `Bun not available on PATH. Cannot auto-install ${pluginName}. Please run: bun add ${pluginName}`
      );
      return false;
    }

    logger.info(`Attempting to auto-install missing plugin: ${pluginName}`);
    const install = Bun.spawn(['bun', 'add', pluginName], {
      cwd: process.cwd(),
      env: process.env as Record<string, string>,
      stdout: 'inherit',
      stderr: 'inherit',
    });
    const exit = await install.exited;

    if (exit === 0) {
      logger.info(`Successfully installed ${pluginName}. Retrying import...`);
      return true;
    }

    logger.error(`bun add ${pluginName} failed with exit code ${exit}. Please install manually.`);
    return false;
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    logger.error(`Unexpected error during auto-install of ${pluginName}: ${message}`);
    return false;
  }
}

// ============================================================================
// Plugin Validation Utilities
// ============================================================================

/**
 * Check if an object has a valid plugin shape
 */
export function isValidPluginShape(obj: unknown): obj is Plugin {
  if (!obj || typeof obj !== 'object') {
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

/**
 * Validate a plugin's structure
 */
export function validatePlugin(plugin: unknown): { isValid: boolean; errors: string[] } {
  const errors: string[] = [];

  if (!plugin) {
    errors.push('Plugin is null or undefined');
    return { isValid: false, errors };
  }

  const pluginObj = plugin as Record<string, unknown>;

  if (!pluginObj.name) {
    errors.push('Plugin must have a name');
  }

  if (pluginObj.actions) {
    if (!Array.isArray(pluginObj.actions)) {
      errors.push('Plugin actions must be an array');
    } else {
      const invalidActions = pluginObj.actions.filter((a) => typeof a !== 'object' || !a);
      if (invalidActions.length > 0) {
        errors.push('Plugin actions must be an array of action objects');
      }
    }
  }

  if (pluginObj.services) {
    if (!Array.isArray(pluginObj.services)) {
      errors.push('Plugin services must be an array');
    } else {
      const invalidServices = pluginObj.services.filter(
        (s) => typeof s !== 'function' && (typeof s !== 'object' || !s)
      );
      if (invalidServices.length > 0) {
        errors.push('Plugin services must be an array of service classes or objects');
      }
    }
  }

  if (pluginObj.providers && !Array.isArray(pluginObj.providers)) {
    errors.push('Plugin providers must be an array');
  }

  if (pluginObj.evaluators && !Array.isArray(pluginObj.evaluators)) {
    errors.push('Plugin evaluators must be an array');
  }

  return {
    isValid: errors.length === 0,
    errors,
  };
}

// ============================================================================
// Plugin Loading Utilities
// ============================================================================

/**
 * Load and prepare a plugin for use
 */
export async function loadAndPreparePlugin(pluginName: string): Promise<Plugin | null> {
  try {
    // Try to load the plugin module
    let pluginModule: unknown;

    try {
      // Attempt to dynamically import the plugin
      pluginModule = await import(pluginName);
    } catch (error) {
      logger.warn(`Failed to load plugin ${pluginName}: ${error}`);
      // Attempt auto-install if allowed and not already attempted
      const attempted = await tryInstallPlugin(pluginName);
      if (!attempted) {
        return null;
      }
      // Retry import once after successful installation attempt
      try {
        pluginModule = await import(pluginName);
      } catch (secondError) {
        logger.error(
          `Auto-install attempted for ${pluginName} but import still failed: ${secondError}`
        );
        return null;
      }
    }

    if (!pluginModule) {
      logger.error(`Failed to load module for plugin ${pluginName}.`);
      return null;
    }

    // Try to find the plugin export in various locations
    const expectedFunctionName = `${pluginName
      .replace(/^@elizaos\/plugin-/, '')
      .replace(/^@elizaos\//, '')
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
      // Try factory functions that return a Plugin
      if (typeof potentialPlugin === 'function' && potentialPlugin.length === 0) {
        try {
          const produced = potentialPlugin();
          if (isValidPluginShape(produced)) {
            return produced as Plugin;
          }
        } catch (err) {
          logger.debug(`Factory export threw for ${pluginName}: ${err}`);
        }
      }
    }

    logger.warn(`Could not find a valid plugin export in ${pluginName}.`);
    return null;
  } catch (error) {
    logger.error(`Error loading plugin ${pluginName}: ${error}`);
    return null;
  }
}

// ============================================================================
// Plugin Name Mapping Utilities
// ============================================================================

/**
 * Normalizes a plugin name by extracting the short name from scoped packages
 * Examples:
 *  - '@elizaos/plugin-discord' -> 'discord'
 *  - '@elizaos/plugin-sql' -> 'sql'
 *  - 'bootstrap' -> 'bootstrap'
 *  - 'plugin-custom' -> 'plugin-custom'
 */
export function normalizePluginName(pluginName: string): string {
  // Match patterns like @elizaos/plugin-{name} or @{scope}/plugin-{name}
  const scopedMatch = pluginName.match(/^@[^/]+\/plugin-(.+)$/);
  if (scopedMatch) {
    return scopedMatch[1];
  }
  return pluginName;
}

// ============================================================================
// Plugin Dependency Resolution
// ============================================================================

/**
 * Resolve plugin dependencies with circular dependency detection
 * Performs topological sorting of plugins to ensure dependencies are loaded in the correct order
 * 
 * Supports both scoped package names (@elizaos/plugin-discord) and short names (discord)
 */
export function resolvePluginDependencies(
  availablePlugins: Map<string, Plugin>,
  isTestMode: boolean = false
): Plugin[] {
  const resolutionOrder: string[] = [];
  const visited = new Set<string>();
  const visiting = new Set<string>();

  // Create enhanced lookup map supporting both naming conventions
  // Allows finding plugins by short name ('discord') or scoped name ('@elizaos/plugin-discord')
  const lookupMap = new Map<string, Plugin>();
  for (const [key, plugin] of availablePlugins.entries()) {
    lookupMap.set(key, plugin);
    if (plugin.name !== key) {
      lookupMap.set(plugin.name, plugin);
    }
    lookupMap.set(`@elizaos/plugin-${plugin.name}`, plugin);
    const normalizedKey = normalizePluginName(key);
    if (normalizedKey !== key) {
      lookupMap.set(normalizedKey, plugin);
    }
  }

  function visit(pluginName: string) {
    // Try to find the plugin using the lookup map
    const plugin = lookupMap.get(pluginName);

    if (!plugin) {
      // Try normalized name as fallback
      const normalizedName = normalizePluginName(pluginName);
      const pluginByNormalized = lookupMap.get(normalizedName);

      if (!pluginByNormalized) {
        logger.warn(`Plugin dependency "${pluginName}" not found and will be skipped.`);
        return;
      }

      // Use the normalized name for the rest of the resolution
      return visit(pluginByNormalized.name);
    }

    // Use the actual plugin.name for tracking to ensure consistency
    const canonicalName = plugin.name;

    if (visited.has(canonicalName)) return;
    if (visiting.has(canonicalName)) {
      logger.error(`Circular dependency detected involving plugin: ${canonicalName}`);
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

  // Visit all plugins using their canonical names
  for (const plugin of availablePlugins.values()) {
    if (!visited.has(plugin.name)) {
      visit(plugin.name);
    }
  }

  // Map back to actual plugin objects using the original availablePlugins map
  const finalPlugins = resolutionOrder
    .map((name) => {
      // Find by name in the original map
      for (const plugin of availablePlugins.values()) {
        if (plugin.name === name) {
          return plugin;
        }
      }
      return null;
    })
    .filter((p): p is Plugin => Boolean(p));

  logger.info({ plugins: finalPlugins.map((p) => p.name) }, `Final plugins being loaded:`);

  return finalPlugins;
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Load a plugin by name or validate a provided plugin object
 * @param nameOrPlugin - Plugin name string or Plugin object
 * @returns Loaded Plugin or null if failed
 */
export async function loadPlugin(nameOrPlugin: string | Plugin): Promise<Plugin | null> {
  if (typeof nameOrPlugin === 'string') {
    return loadAndPreparePlugin(nameOrPlugin);
  }

  // Validate the provided plugin object
  const validation = validatePlugin(nameOrPlugin);
  if (!validation.isValid) {
    logger.error(`Invalid plugin provided: ${validation.errors.join(', ')}`);
    return null;
  }

  return nameOrPlugin;
}

/**
 * Helper to queue a dependency if not already queued or loaded
 */
function queueDependency(
  depName: string,
  seenDependencies: Set<string>,
  pluginMap: Map<string, Plugin>,
  queue: (string | Plugin)[]
): void {
  const normalizedDepName = normalizePluginName(depName);

  // Check if already queued or loaded (by any name variant)
  const alreadyQueued =
    seenDependencies.has(depName) ||
    seenDependencies.has(normalizedDepName) ||
    pluginMap.has(normalizedDepName) ||
    Array.from(pluginMap.values()).some(
      (p) => p.name === depName || p.name === normalizedDepName
    );

  if (!alreadyQueued) {
    seenDependencies.add(depName);
    seenDependencies.add(normalizedDepName);
    queue.push(depName);
  }
}

/**
 * Internal implementation of plugin resolution
 * @param plugins - Array of plugin names or Plugin objects
 * @param isTestMode - Whether to include test dependencies
 * @returns Ordered array of resolved plugins
 */
async function resolvePluginsImpl(
  plugins: (string | Plugin)[],
  isTestMode: boolean = false
): Promise<Plugin[]> {
  const pluginMap = new Map<string, Plugin>();
  const queue: (string | Plugin)[] = [...plugins];
  const seenDependencies = new Set<string>();

  while (queue.length > 0) {
    const next = queue.shift()!;
    const loaded = await loadPlugin(next);
    if (!loaded) continue;

    const canonicalName = loaded.name;

    if (!pluginMap.has(canonicalName)) {
      pluginMap.set(canonicalName, loaded);

      // Queue regular dependencies
      for (const depName of loaded.dependencies ?? []) {
        queueDependency(depName, seenDependencies, pluginMap, queue);
      }

      // Queue test dependencies if in test mode
      if (isTestMode) {
        for (const depName of loaded.testDependencies ?? []) {
          queueDependency(depName, seenDependencies, pluginMap, queue);
        }
      }
    }
  }

  return resolvePluginDependencies(pluginMap, isTestMode);
}

/**
 * Resolve multiple plugins with dependency ordering
 * Browser-compatible wrapper that handles Node.js-only plugin loading
 *
 * @param plugins - Array of plugin names or Plugin objects
 * @param isTestMode - Whether to include test dependencies
 * @returns Ordered array of resolved plugins
 *
 * Note: In browser environments, string plugin names are not supported.
 * Only pre-resolved Plugin objects can be used.
 */
export async function resolvePlugins(
  plugins: (string | Plugin)[],
  isTestMode: boolean = false
): Promise<Plugin[]> {
  const env = detectEnvironment();

  // In Node.js, use full implementation
  if (env === 'node') {
    return resolvePluginsImpl(plugins, isTestMode);
  }

  // In browser, only Plugin objects are supported
  const pluginObjects = plugins.filter((p): p is Plugin => typeof p !== 'string');

  if (plugins.some((p) => typeof p === 'string')) {
    logger.warn(
      'Browser environment: String plugin references are not supported. ' +
      'Only Plugin objects will be used. Skipped plugins: ' +
      plugins.filter((p) => typeof p === 'string').join(', ')
    );
  }

  // Still resolve dependencies for Plugin objects
  const pluginMap = new Map<string, Plugin>();
  for (const plugin of pluginObjects) {
    pluginMap.set(plugin.name, plugin);
  }

  return resolvePluginDependencies(pluginMap, isTestMode);
}
