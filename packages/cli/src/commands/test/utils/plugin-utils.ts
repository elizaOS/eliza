import { loadProject } from '@/src/project';
import { type DirectoryInfo } from '@/src/utils/directory-detection';
import { logger, type Plugin } from '@elizaos/core';
import * as fs from 'node:fs';
import path from 'node:path';

/**
 * Loads the plugin modules for a plugin's dependencies.
 * Assumes dependencies have already been installed by `installPluginDependencies`.
 * @param projectInfo Information about the current directory
 * @returns An array of loaded plugin modules.
 */
export async function loadPluginDependencies(projectInfo: DirectoryInfo): Promise<Plugin[]> {
  if (projectInfo.type !== 'elizaos-plugin') {
    return [];
  }
  const project = await loadProject(process.cwd());
  const dependencyPlugins: Plugin[] = [];

  if (
    project.isPlugin &&
    project.pluginModule?.dependencies &&
    project.pluginModule.dependencies.length > 0
  ) {
    const projectPluginsPath = path.join(process.cwd(), '.eliza', 'plugins');
    for (const dependency of project.pluginModule.dependencies) {
      const pluginPath = path.join(projectPluginsPath, 'node_modules', dependency);
      if (fs.existsSync(pluginPath)) {
        try {
          // Dependencies from node_modules are pre-built. We just need to load them.
          const pluginProject = await loadProject(pluginPath);
          if (pluginProject.pluginModule) {
            dependencyPlugins.push(pluginProject.pluginModule);
          }
        } catch (error) {
          logger.error(`Failed to load or build dependency ${dependency}:`, error);
        }
      }
    }
  }
  return dependencyPlugins;
}

/**
 * Loads plugins from a project, including those with scenarios
 * @param projectPath Path to the project or plugin directory
 * @param projectInfo Information about the project type
 * @returns Array of loaded plugins with scenarios
 */
export async function loadPluginsFromProject(
  projectPath: string, 
  projectInfo: any
): Promise<Plugin[]> {
  const plugins: Plugin[] = [];

  try {
    const project = await loadProject(projectPath);

    // If this is a plugin itself, include it
    if (project.isPlugin && project.pluginModule) {
      plugins.push(project.pluginModule);
      logger.debug(`Loaded plugin: ${project.pluginModule.name}`);
    }

    // If this is a project with agents, load their plugins
    if (project.agents && project.agents.length > 0) {
      for (const agent of project.agents) {
        if (agent.plugins) {
          for (const pluginRef of agent.plugins) {
            try {
              let plugin: Plugin;
              
              if (typeof pluginRef === 'string') {
                // Plugin reference by name - try to resolve and load
                plugin = await resolvePluginByName(pluginRef, projectPath);
              } else {
                // Plugin object directly
                plugin = pluginRef;
              }

              if (plugin && !plugins.find(p => p.name === plugin.name)) {
                plugins.push(plugin);
                logger.debug(`Loaded plugin from agent: ${plugin.name}`);
              }
            } catch (error) {
              logger.warn(`Failed to load plugin ${pluginRef}: ${error instanceof Error ? error.message : String(error)}`);
            }
          }
        }
      }
    }

    // Load dependency plugins
    const dependencyPlugins = await loadPluginDependencies(projectInfo);
    for (const depPlugin of dependencyPlugins) {
      if (!plugins.find(p => p.name === depPlugin.name)) {
        plugins.push(depPlugin);
        logger.debug(`Loaded dependency plugin: ${depPlugin.name}`);
      }
    }

  } catch (error) {
    logger.error(`Failed to load plugins from project ${projectPath}: ${error instanceof Error ? error.message : String(error)}`);
  }

  // Filter to only plugins that have scenarios
  const pluginsWithScenarios = plugins.filter(plugin => 
    plugin.scenarios && plugin.scenarios.length > 0
  );

  logger.info(`Found ${pluginsWithScenarios.length} plugins with scenarios out of ${plugins.length} total plugins`);

  return plugins; // Return all plugins, not just those with scenarios, as they may be dependencies
}

/**
 * Resolves a plugin by name from node_modules or other sources
 */
async function resolvePluginByName(pluginName: string, projectPath: string): Promise<Plugin> {
  // Try to load from node_modules
  const nodeModulesPath = path.join(projectPath, 'node_modules', pluginName);
  
  if (fs.existsSync(nodeModulesPath)) {
    try {
      const pluginProject = await loadProject(nodeModulesPath);
      if (pluginProject.pluginModule) {
        return pluginProject.pluginModule;
      }
    } catch (error) {
      logger.debug(`Failed to load plugin ${pluginName} from node_modules: ${error}`);
    }
  }

  // Try to require directly (for built-in or globally installed plugins)
  try {
    const pluginModule = require(pluginName);
    
    // Handle different export patterns
    if (pluginModule.default) {
      return pluginModule.default;
    } else if (pluginModule.plugin) {
      return pluginModule.plugin;
    } else if (typeof pluginModule === 'object' && pluginModule.name) {
      return pluginModule;
    }
  } catch (error) {
    logger.debug(`Failed to require plugin ${pluginName}: ${error}`);
  }

  throw new Error(`Could not resolve plugin: ${pluginName}`);
}
