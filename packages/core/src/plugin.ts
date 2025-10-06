import { logger, type Plugin } from './index';

/**
 * Handles on-demand plugin installation using Bun.
 * Provides environment guards and single-attempt tracking per process.
 */
class PluginInstaller {
  private attempted = new Set<string>();

  async tryInstall(pluginName: string): Promise<boolean> {
    try {
      if (!this.isAllowed()) {
        logger.debug(
          `Auto-install disabled or not allowed in this environment. Skipping install for ${pluginName}.`
        );
        return false;
      }

      if (this.attempted.has(pluginName)) {
        logger.debug(`Auto-install already attempted for ${pluginName}. Skipping.`);
        return false;
      }
      this.attempted.add(pluginName);

      // Verify Bun availability
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

  private isAllowed(): boolean {
    if (process.env.ELIZA_NO_AUTO_INSTALL === 'true') return false;
    if (process.env.ELIZA_NO_PLUGIN_AUTO_INSTALL === 'true') return false;
    if (process.env.CI === 'true') return false;
    if (process.env.ELIZA_TEST_MODE === 'true') return false;
    if (process.env.NODE_ENV === 'test') return false;
    return true;
  }
}

/**
 * Manages plugin loading and dependency resolution
 */
class PluginLoader {
  private installer = new PluginInstaller();

  /**
   * Check if an object has a valid plugin shape
   */
  isValidPluginShape(obj: any): obj is Plugin {
    if (!obj || typeof obj !== 'object' || !obj.name) {
      return false;
    }
    return !!(
      obj.init ||
      obj.services ||
      obj.providers ||
      obj.actions ||
      obj.evaluators ||
      obj.description
    );
  }

  /**
   * Validate a plugin's structure
   */
  validatePlugin(plugin: any): { isValid: boolean; errors: string[] } {
    const errors: string[] = [];

    if (!plugin) {
      errors.push('Plugin is null or undefined');
      return { isValid: false, errors };
    }

    if (!plugin.name) {
      errors.push('Plugin must have a name');
    }

    if (plugin.actions) {
      if (!Array.isArray(plugin.actions)) {
        errors.push('Plugin actions must be an array');
      } else {
        // Check if actions contain non-objects
        const invalidActions = plugin.actions.filter((a: any) => typeof a !== 'object' || !a);
        if (invalidActions.length > 0) {
          errors.push('Plugin actions must be an array of action objects');
        }
      }
    }

    if (plugin.services) {
      if (!Array.isArray(plugin.services)) {
        errors.push('Plugin services must be an array');
      } else {
        // Check if services contain non-objects/non-constructors
        const invalidServices = plugin.services.filter(
          (s: any) => typeof s !== 'function' && (typeof s !== 'object' || !s)
        );
        if (invalidServices.length > 0) {
          errors.push('Plugin services must be an array of service classes or objects');
        }
      }
    }

    if (plugin.providers && !Array.isArray(plugin.providers)) {
      errors.push('Plugin providers must be an array');
    }

    if (plugin.evaluators && !Array.isArray(plugin.evaluators)) {
      errors.push('Plugin evaluators must be an array');
    }

    return {
      isValid: errors.length === 0,
      errors,
    };
  }

  /**
   * Load and prepare a plugin for use
   */
  async loadAndPreparePlugin(pluginName: string): Promise<Plugin | null> {
    try {
      // Try to load the plugin module
      let pluginModule: any;

      try {
        // Attempt to dynamically import the plugin
        pluginModule = await import(pluginName);
      } catch (error) {
        logger.warn(`Failed to load plugin ${pluginName}: ${error}`);
        // Attempt auto-install if allowed and not already attempted
        const attempted = await this.installer.tryInstall(pluginName);
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

      const exportsToCheck = [
        pluginModule[expectedFunctionName],
        pluginModule.default,
        ...Object.values(pluginModule),
      ];

      for (const potentialPlugin of exportsToCheck) {
        if (this.isValidPluginShape(potentialPlugin)) {
          return potentialPlugin as Plugin;
        }
        // Try factory functions that return a Plugin
        if (typeof potentialPlugin === 'function' && potentialPlugin.length === 0) {
          try {
            const produced = potentialPlugin();
            if (this.isValidPluginShape(produced)) {
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

  /**
   * Resolve plugin dependencies with circular dependency detection
   *
   * Performs topological sorting of plugins to ensure dependencies are loaded in the correct order.
   */
  resolvePluginDependencies(
    availablePlugins: Map<string, Plugin>,
    isTestMode: boolean = false
  ): Plugin[] {
    const resolutionOrder: string[] = [];
    const visited = new Set<string>();
    const visiting = new Set<string>();

    function visit(pluginName: string) {
      if (!availablePlugins.has(pluginName)) {
        logger.warn(`Plugin dependency "${pluginName}" not found and will be skipped.`);
        return;
      }
      if (visited.has(pluginName)) return;
      if (visiting.has(pluginName)) {
        logger.error(`Circular dependency detected involving plugin: ${pluginName}`);
        return;
      }

      visiting.add(pluginName);
      const plugin = availablePlugins.get(pluginName);
      if (plugin) {
        const deps = [...(plugin.dependencies || [])];
        if (isTestMode) {
          deps.push(...(plugin.testDependencies || []));
        }
        for (const dep of deps) {
          visit(dep);
        }
      }
      visiting.delete(pluginName);
      visited.add(pluginName);
      resolutionOrder.push(pluginName);
    }

    for (const name of availablePlugins.keys()) {
      if (!visited.has(name)) {
        visit(name);
      }
    }

    const finalPlugins = resolutionOrder
      .map((name) => availablePlugins.get(name))
      .filter((p) => p) as Plugin[];

    logger.info({ plugins: finalPlugins.map((p) => p.name) }, `Final plugins being loaded:`);

    return finalPlugins;
  }
}

/**
 * Public API for plugin management in ElizaOS Core
 * Combines installation and loading capabilities
 */
export class PluginManager {
  private loader = new PluginLoader();

  /**
   * Load a plugin by name or use a provided plugin object
   * @param nameOrPlugin - Plugin name string or Plugin object
   * @returns Loaded Plugin or null if failed
   */
  async loadPlugin(nameOrPlugin: string | Plugin): Promise<Plugin | null> {
    if (typeof nameOrPlugin === 'string') {
      return this.loader.loadAndPreparePlugin(nameOrPlugin);
    }

    // Validate the provided plugin object
    const validation = this.loader.validatePlugin(nameOrPlugin);
    if (!validation.isValid) {
      logger.error(
        `Invalid plugin provided: ${validation.errors.join(', ')}`
      );
      return null;
    }

    return nameOrPlugin;
  }

  /**
   * Resolve multiple plugins with dependency ordering
   * @param plugins - Array of plugin names or Plugin objects
   * @param isTestMode - Whether to include test dependencies
   * @returns Ordered array of resolved plugins
   */
  async resolvePlugins(
    plugins: (string | Plugin)[],
    isTestMode: boolean = false
  ): Promise<Plugin[]> {
    const pluginMap = new Map<string, Plugin>();

    // Load all plugins
    for (const p of plugins) {
      const loaded = await this.loadPlugin(p);
      if (loaded) {
        pluginMap.set(loaded.name, loaded);

        // Also load dependencies
        const deps = loaded.dependencies || [];
        for (const depName of deps) {
          if (!pluginMap.has(depName)) {
            const depPlugin = await this.loader.loadAndPreparePlugin(depName);
            if (depPlugin) {
              pluginMap.set(depPlugin.name, depPlugin);
            }
          }
        }
      }
    }

    // Resolve dependencies and return ordered list
    return this.loader.resolvePluginDependencies(pluginMap, isTestMode);
  }

  /**
   * Check if an object is a valid plugin
   * @param obj - Object to check
   * @returns True if valid plugin shape
   */
  isValidPlugin(obj: any): obj is Plugin {
    return this.loader.isValidPluginShape(obj);
  }
}
