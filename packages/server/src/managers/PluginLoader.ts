import { logger, type Plugin } from '@elizaos/core';

/**
 * Manages plugin loading and dependency resolution
 */
export class PluginLoader {
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
        const invalidServices = plugin.services.filter((s: any) => 
          typeof s !== 'function' && (typeof s !== 'object' || !s)
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
      errors
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
        logger.error(`Failed to load plugin ${pluginName}: ${error}`);
        return null;
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