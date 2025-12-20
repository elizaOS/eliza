import {
  AgentRuntime,
  Character,
  Plugin,
  logger,
  type ProjectAgent,
  type UUID,
  type IAgentRuntime,
} from '@elizaos/core';
import { getDefaultCharacter } from '@/src/characters/eliza';
import { stringToUuid } from '@elizaos/core';
import * as fs from 'node:fs';
import path from 'node:path';
import { detectDirectoryType } from '@/src/utils/directory-detection';

/**
 * Interface for a project module that can be loaded.
 */
interface ProjectModule {
  agents?: ProjectAgent[];
  character?: Character;
  init?: (runtime: IAgentRuntime) => Promise<void>;
  default?: ProjectModule | ProjectAgent | { agents?: ProjectAgent[] };
  [key: string]:
    | ProjectAgent
    | ProjectModule
    | ProjectAgent[]
    | Character
    | Plugin
    | ((runtime: IAgentRuntime) => Promise<void>)
    | undefined;
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
function isPlugin(module: ProjectModule | Plugin | Record<string, unknown>): boolean {
  // Check for direct export of a plugin
  if (
    module &&
    typeof module === 'object' &&
    typeof (module as Record<string, unknown>).name === 'string' &&
    typeof (module as Record<string, unknown>).description === 'string'
  ) {
    return true;
  }

  // Check for default export of a plugin
  const moduleObj = module as Record<string, unknown>;
  if (
    module &&
    typeof module === 'object' &&
    moduleObj.default &&
    typeof moduleObj.default === 'object' &&
    typeof (moduleObj.default as Record<string, unknown>).name === 'string' &&
    typeof (moduleObj.default as Record<string, unknown>).description === 'string'
  ) {
    return true;
  }

  // Check for named export of a plugin
  for (const key in module) {
    const value = moduleObj[key];
    if (
      key !== 'default' &&
      value &&
      typeof value === 'object' &&
      typeof (value as Record<string, unknown>).name === 'string' &&
      typeof (value as Record<string, unknown>).description === 'string'
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
function extractPlugin(module: ProjectModule | Plugin | Record<string, unknown>): Plugin {
  const moduleObj = module as Record<string, unknown>;

  // Direct export
  if (
    module &&
    typeof module === 'object' &&
    typeof moduleObj.name === 'string' &&
    typeof moduleObj.description === 'string'
  ) {
    return module as Plugin;
  }

  // Default export
  if (
    module &&
    typeof module === 'object' &&
    moduleObj.default &&
    typeof moduleObj.default === 'object' &&
    typeof (moduleObj.default as Record<string, unknown>).name === 'string' &&
    typeof (moduleObj.default as Record<string, unknown>).description === 'string'
  ) {
    return moduleObj.default as Plugin;
  }

  // Named export
  for (const key in module) {
    const value = moduleObj[key];
    if (
      key !== 'default' &&
      value &&
      typeof value === 'object' &&
      typeof (value as Record<string, unknown>).name === 'string' &&
      typeof (value as Record<string, unknown>).description === 'string'
    ) {
      return value as Plugin;
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
  // Validate directory structure using centralized detection
  const dirInfo = detectDirectoryType(dir);
  if (!dirInfo.hasPackageJson) {
    throw new Error(`No package.json found in ${dir}`);
  }

  // Get the package.json and get the main field
  const packageJson = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
  const main = packageJson.main;
  if (!main) {
    logger.warn(
      { src: 'cli', util: 'project' },
      'No main field found in package.json, using default character'
    );

    // Create a fallback project with the default Eliza character
    // Use deterministic UUID based on character name to match runtime behavior
    const defaultCharacterName = 'Eliza (Default)';
    const elizaCharacter = getDefaultCharacter(); // Get the filtered character based on env vars
    const defaultAgent: ProjectAgent = {
      character: {
        ...elizaCharacter,
        id: stringToUuid(defaultCharacterName) as UUID,
        name: defaultCharacterName,
      },
      init: async () => {
        logger.info({ src: 'cli', util: 'project' }, 'Initializing default Eliza character');
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
        logger.info({ src: 'cli', util: 'project', entryPoint }, 'Loaded project');

        // Debug the module structure
        const exportKeys = Object.keys(projectModule);
        logger.debug({ src: 'cli', util: 'project', exportKeys }, 'Module exports');

        if (exportKeys.includes('default')) {
          logger.debug(
            { src: 'cli', util: 'project', type: typeof projectModule.default },
            'Default export type'
          );
          if (typeof projectModule.default === 'object' && projectModule.default !== null) {
            logger.debug(
              { src: 'cli', util: 'project', keys: Object.keys(projectModule.default) },
              'Default export keys'
            );
          }
        }

        break;
      } catch (error) {
        logger.warn(
          {
            src: 'cli',
            util: 'project',
            error: error instanceof Error ? error.message : String(error),
            entryPoint,
          },
          'Failed to import project'
        );
      }
    }
  }

  if (!projectModule) {
    throw new Error('Could not find project entry point');
  }

  // Check if it's a plugin using our improved detection
  const moduleIsPlugin = isPlugin(projectModule);
  logger.debug({ src: 'cli', util: 'project', moduleIsPlugin }, 'Is this a plugin?');

  if (moduleIsPlugin) {
    logger.info({ src: 'cli', util: 'project' }, 'Detected plugin module instead of project');

    // Extract the plugin object
    const plugin = extractPlugin(projectModule);
    logger.debug(
      { src: 'cli', util: 'project', name: plugin.name, description: plugin.description },
      'Found plugin'
    );

    // Log plugin structure for debugging
    logger.debug(
      { src: 'cli', util: 'project', keys: Object.keys(plugin) },
      'Plugin has the following properties'
    );

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
          logger.info(
            { src: 'cli', util: 'project', pluginName: plugin.name },
            'Dummy init for plugin'
          );
        }),
    };

    // Use the Eliza character as our test agent
    // Use deterministic UUID based on character name to match runtime behavior
    const characterName = 'Eliza (Test Mode)';
    const elizaCharacter = getDefaultCharacter(); // Get the filtered character based on env vars
    const testCharacter: Character = {
      ...elizaCharacter,
      id: stringToUuid(characterName) as UUID,
      name: characterName,
      system: `${elizaCharacter.system} Testing the plugin: ${completePlugin.name}.`,
    };

    logger.info(
      { src: 'cli', util: 'project', pluginName: completePlugin.name },
      'Using Eliza character as test agent for plugin'
    );

    // Create a test agent with the plugin included
    const testAgent: ProjectAgent = {
      character: testCharacter,
      plugins: [completePlugin], // Only include the plugin being tested
      init: async () => {
        logger.info(
          { src: 'cli', util: 'project', pluginName: completePlugin.name },
          'Initializing Eliza test agent for plugin'
        );
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
  }

  // Extract agents from the project module
  const agents: ProjectAgent[] = [];

  // First check if the default export has an agents array
  const defaultExport = projectModule.default as Record<string, unknown> | undefined;
  if (defaultExport && typeof defaultExport === 'object' && Array.isArray(defaultExport.agents)) {
    // Use the agents from the default export
    agents.push(...(defaultExport.agents as ProjectAgent[]));
    logger.debug(
      { src: 'cli', util: 'project', count: agents.length },
      'Found agents in default export agents array'
    );
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
          logger.debug(
            { src: 'cli', util: 'project' },
            'Found agent in default export (single agent)'
          );
        }
      } else if (
        value &&
        typeof value === 'object' &&
        (value as ProjectModule).character &&
        (value as ProjectModule).init
      ) {
        // If it's a named export that looks like an agent, add it
        agents.push(value as ProjectAgent);
        logger.debug({ src: 'cli', util: 'project', key }, 'Found agent in named export');
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
}
