import {
  AgentRuntime,
  Character,
  Plugin,
  logger,
  type ProjectAgent,
  type UUID,
} from '@elizaos/core';
import { stringToUuid } from '@elizaos/core';
import * as fs from 'node:fs';
import path from 'node:path';
import { getElizaCharacter } from '@/src/characters/eliza';
import { detectDirectoryType } from '@/src/utils/directory-detection';

/**
 * Interface for a project module that can be loaded.
 */
interface ProjectModule {
  agents?: ProjectAgent[];
  character?: Character;
  init?: (runtime: any) => Promise<void>;
  [key: string]: any;
}

/**
 * Interface for a loaded project.
 */
export interface Project {
  agents: ProjectAgent[];
  dir: string;
  isPlugin?: boolean;
  pluginModule?: Plugin;
}

export interface LoadedProject {
  runtimes: AgentRuntime[];
  path: string;
  agents: ProjectAgent[];
}

/**
 * Determine if a loaded module is a plugin
 * @param module The loaded module to check
 * @returns true if this appears to be a plugin
 */
function isPlugin(module: any): boolean {
  // Check for direct export of a plugin
  if (
    module &&
    typeof module === 'object' &&
    typeof module.name === 'string' &&
    typeof module.description === 'string'
  ) {
    return true;
  }

  // Check for default export of a plugin
  if (
    module &&
    typeof module === 'object' &&
    module.default &&
    typeof module.default === 'object' &&
    typeof module.default.name === 'string' &&
    typeof module.default.description === 'string'
  ) {
    return true;
  }

  // Check for named export of a plugin
  for (const key in module) {
    if (
      key !== 'default' &&
      module[key] &&
      typeof module[key] === 'object' &&
      typeof module[key].name === 'string' &&
      typeof module[key].description === 'string'
    ) {
      return true;
    }
  }

  return false;
}

/**
 * Extract a Plugin object from a module
 * @param module The module to extract from
 * @returns The plugin object
 */
function extractPlugin(module: any): Plugin {
  // Direct export
  if (
    module &&
    typeof module === 'object' &&
    typeof module.name === 'string' &&
    typeof module.description === 'string'
  ) {
    return module as Plugin;
  }

  // Default export
  if (
    module &&
    typeof module === 'object' &&
    module.default &&
    typeof module.default === 'object' &&
    typeof module.default.name === 'string' &&
    typeof module.default.description === 'string'
  ) {
    return module.default as Plugin;
  }

  // Named export
  for (const key in module) {
    if (
      key !== 'default' &&
      module[key] &&
      typeof module[key] === 'object' &&
      typeof module[key].name === 'string' &&
      typeof module[key].description === 'string'
    ) {
      return module[key] as Plugin;
    }
  }

  throw new Error('Could not extract plugin from module');
}

/**
 * Loads a project from the specified directory.
 * @param {string} dir - The directory to load the project from.
 * @returns {Promise<Project>} A promise that resolves to the loaded project.
 */
export async function loadProject(dir: string): Promise<Project> {
  try {
    // Validate directory structure using centralized detection
    const dirInfo = detectDirectoryType(dir);
    if (!dirInfo.hasPackageJson) {
      throw new Error(`No package.json found in ${dir}`);
    }

    // TODO: Get the package.json and get the main field
    const packageJson = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    const main = packageJson.main;
    if (!main) {
      logger.warn('No main field found in package.json, using default character');

      // Create a fallback project with the default Eliza character
      // Use deterministic UUID based on character name to match runtime behavior
      const defaultCharacterName = 'Eliza (Default)';
      const elizaCharacter = getElizaCharacter(); // Get the filtered character based on env vars
      const defaultAgent: ProjectAgent = {
        character: {
          ...elizaCharacter,
          id: stringToUuid(defaultCharacterName) as UUID,
          name: defaultCharacterName,
        },
        init: async () => {
          logger.info('Initializing default Eliza character');
        },
      };

      return {
        agents: [defaultAgent],
        dir,
      };
    }

    // Try to find the project's entry point
    const entryPoints = [
      path.join(dir, main),
      path.join(dir, 'dist/index.js'),
      path.join(dir, 'src/index.ts'),
      path.join(dir, 'src/index.js'),
      path.join(dir, 'index.ts'),
      path.join(dir, 'index.js'),
    ];

    let projectModule: ProjectModule | null = null;
    for (const entryPoint of entryPoints) {
      if (fs.existsSync(entryPoint)) {
        try {
          const importPath = path.resolve(entryPoint);
          // Convert to file URL for ESM import
          const importUrl =
            process.platform === 'win32'
              ? 'file:///' + importPath.replace(/\\/g, '/')
              : 'file://' + importPath;
          projectModule = (await import(importUrl)) as ProjectModule;
          logger.info(`Loaded project from ${entryPoint}`);

          // Debug the module structure
          const exportKeys = Object.keys(projectModule);
          logger.debug(`Module exports: ${exportKeys.join(', ')}`);

          if (exportKeys.includes('default')) {
            logger.debug(`Default export type: ${typeof projectModule.default}`);
            if (typeof projectModule.default === 'object' && projectModule.default !== null) {
              logger.debug(`Default export keys: ${Object.keys(projectModule.default).join(', ')}`);
            }
          }

          break;
        } catch (error) {
          logger.warn(`Failed to import project from ${entryPoint}:`, error);
        }
      }
    }

    if (!projectModule) {
      throw new Error('Could not find project entry point');
    }

    // Check if it's a plugin using our improved detection
    const moduleIsPlugin = isPlugin(projectModule);
    logger.debug(`Is this a plugin? ${moduleIsPlugin}`);

    if (moduleIsPlugin) {
      logger.info('Detected plugin module instead of project');

      try {
        // Extract the plugin object
        const plugin = extractPlugin(projectModule);
        logger.debug(`Found plugin: ${plugin.name} - ${plugin.description}`);

        // Log plugin structure for debugging
        logger.debug(`Plugin has the following properties: ${Object.keys(plugin).join(', ')}`);

        // Create a more complete plugin object with all required properties
        const completePlugin: Plugin = {
          // Copy all other properties from the original plugin first
          ...plugin,
          // Then override with defaults if needed
          name: plugin.name || 'unknown-plugin',
          description: plugin.description || 'No description',
          init:
            plugin.init ||
            (async () => {
              logger.info(`Dummy init for plugin: ${plugin.name}`);
            }),
        };

        // Use the Eliza character as our test agent
        // Use deterministic UUID based on character name to match runtime behavior
        const characterName = 'Eliza (Test Mode)';
        const elizaCharacter = getElizaCharacter(); // Get the filtered character based on env vars
        const testCharacter: Character = {
          ...elizaCharacter,
          id: stringToUuid(characterName) as UUID,
          name: characterName,
          system: `${elizaCharacter.system} Testing the plugin: ${completePlugin.name}.`,
        };

        logger.info(`Using Eliza character as test agent for plugin: ${completePlugin.name}`);

        // Create a test agent with the plugin included
        const testAgent: ProjectAgent = {
          character: testCharacter,
          plugins: [completePlugin], // Only include the plugin being tested
          init: async () => {
            logger.info(`Initializing Eliza test agent for plugin: ${completePlugin.name}`);
            // The plugin will be registered automatically in runtime.initialize()
          },
        };

        // Since we're in test mode, Eliza (our test agent) needs to already exist in the database
        // before any entity is created, but we can't do this in the init function because
        // the adapter might not be ready. Let's ensure this is handled properly in the runtime's
        // initialize method or by initializing the agent in the database separately.

        return {
          agents: [testAgent],
          dir,
          isPlugin: true,
          pluginModule: completePlugin,
        };
      } catch (error) {
        logger.error('Error extracting plugin from module:', error);
        throw error;
      }
    }

    // Extract agents from the project module
    const agents: ProjectAgent[] = [];

    // First check if the default export has an agents array
    if (
      projectModule.default &&
      typeof projectModule.default === 'object' &&
      Array.isArray(projectModule.default.agents)
    ) {
      // Use the agents from the default export
      agents.push(...(projectModule.default.agents as ProjectAgent[]));
      logger.debug(`Found ${agents.length} agents in default export's agents array`);
    }
    // Only if we didn't find agents in the default export, look for other exports
    else {
      // Look for exported agents
      for (const [key, value] of Object.entries(projectModule)) {
        if (key === 'default' && value && typeof value === 'object') {
          // If it's a default export but doesn't have agents array, check if it's a single agent
          if ((value as ProjectModule).character && (value as ProjectModule).init) {
            // If it's a single agent, add it
            agents.push(value as ProjectAgent);
            logger.debug(`Found agent in default export (single agent)`);
          }
        } else if (
          value &&
          typeof value === 'object' &&
          (value as ProjectModule).character &&
          (value as ProjectModule).init
        ) {
          // If it's a named export that looks like an agent, add it
          agents.push(value as ProjectAgent);
          logger.debug(`Found agent in named export: ${key}`);
        }
      }
    }

    if (agents.length === 0) {
      throw new Error('No agents found in project');
    }

    // Create and return the project object
    const project: Project = {
      agents,
      dir,
    };

    return project;
  } catch (error) {
    logger.error('Error loading project:', error);
    throw error;
  }
}
