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
