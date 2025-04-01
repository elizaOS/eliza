import { buildProject } from '@/src/utils/build-project';
import {
  AgentRuntime,
  type Character,
  type IAgentRuntime,
  type Plugin,
  logger,
  stringToUuid,
  encryptedCharacter,
  RuntimeSettings,
} from '@elizaos/core';
import { Command } from 'commander';
import fs from 'node:fs';
import path, { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { character, character as defaultCharacter } from '../characters/eliza';
import { AgentServer } from '../server/index';
import { jsonToCharacter, loadCharacterTryPath } from '../server/loader';
import { loadConfig, saveConfig } from '../utils/config-manager.js';
import { promptForEnvVars } from '../utils/env-prompt.js';
import { configureDatabaseSettings, loadEnvironment } from '../utils/get-config';
import { handleError } from '../utils/handle-error';
import { installPlugin } from '../utils/install-plugin';
import { displayBanner } from '../displayBanner';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const wait = (minTime = 1000, maxTime = 3000) => {
  const waitTime = Math.floor(Math.random() * (maxTime - minTime + 1)) + minTime;
  return new Promise((resolve) => setTimeout(resolve, waitTime));
};

/**
 * Analyzes project agents and their plugins to determine which environment variables to prompt for
 */
export async function promptForProjectPlugins(
  project: any,
  pluginToLoad?: { name: string }
): Promise<void> {
  // Set to track unique plugin names to avoid duplicate prompts
  const pluginsToPrompt = new Set<string>();

  // If we have a specific plugin to load, add it
  if (pluginToLoad?.name) {
    pluginsToPrompt.add(pluginToLoad.name.toLowerCase());
  }

  // If we have a project, scan all its agents for plugins
  if (project) {
    // Handle both formats: project with agents array and project with single agent
    const agents = Array.isArray(project.agents)
      ? project.agents
      : project.agent
        ? [project.agent]
        : [];

    // Check each agent's plugins
    for (const agent of agents) {
      if (agent.plugins?.length) {
        for (const plugin of agent.plugins) {
          const pluginName = typeof plugin === 'string' ? plugin : plugin.name;

          if (pluginName) {
            // Extract just the plugin name from the package name if needed
            const simpleName = pluginName.split('/').pop()?.replace('plugin-', '') || pluginName;
            pluginsToPrompt.add(simpleName.toLowerCase());
          }
        }
      }
    }
  }

  // Prompt for each identified plugin
  for (const pluginName of pluginsToPrompt) {
    try {
      await promptForEnvVars(pluginName);
    } catch (error) {
      logger.warn(`Failed to prompt for ${pluginName} environment variables: ${error}`);
    }
  }
}

/**
 * Starts an agent with the given character, agent server, initialization function, plugins, and options.
 *
 * @param character The character object representing the agent.
 * @param server The agent server where the agent will be registered.
 * @param init Optional initialization function to be called with the agent runtime.
 * @param plugins An array of plugins to be used by the agent.
 * @param options Additional options for starting the agent, such as data directory and postgres URL.
 * @returns A promise that resolves to the agent runtime object.
 */
export async function startAgent(
  character: Character,
  server: AgentServer,
  init?: (runtime: IAgentRuntime) => void,
  plugins: Plugin[] = [],
  options: {
    dataDir?: string;
    postgresUrl?: string;
    isPluginTestMode?: boolean;
  } = {}
): Promise<IAgentRuntime> {
  character.id ??= stringToUuid(character.name);

  const encryptedChar = encryptedCharacter(character);

  // For ESM modules we need to use import.meta.url instead of __dirname
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = dirname(__filename);

  // Find package.json relative to the current file
  const packageJsonPath = path.resolve(__dirname, '../package.json');

  // Add a simple check in case the path is incorrect
  let version = '0.0.0'; // Fallback version
  if (!fs.existsSync(packageJsonPath)) {
  } else {
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));
    version = packageJson.version;
  }

  const characterPlugins: Plugin[] = [];

  // for each plugin, check if it installed, and install if it is not
  for (const plugin of encryptedChar.plugins) {
    logger.debug('Checking if plugin is installed: ', plugin);
    let pluginModule: any;

    // Try to load the plugin
    try {
      // For local plugins, use regular import
      pluginModule = await import(plugin);
      logger.debug(`Successfully loaded plugin ${plugin}`);
    } catch (error) {
      logger.info(`Plugin ${plugin} not installed, installing into ${process.cwd()}...`);
      await installPlugin(plugin, process.cwd(), version);

      try {
        // For local plugins, use regular import
        pluginModule = await import(plugin);
        logger.debug(`Successfully loaded plugin ${plugin} after installation`);
      } catch (importError) {
        // Try to import from the project's node_modules directory
        try {
          const projectNodeModulesPath = path.join(process.cwd(), 'node_modules', plugin);
          logger.debug(`Attempting to import from project path: ${projectNodeModulesPath}`);

          // Read the package.json to find the entry point
          const packageJsonPath = path.join(projectNodeModulesPath, 'package.json');
          if (fs.existsSync(packageJsonPath)) {
            const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));
            const entryPoint = packageJson.module || packageJson.main || 'dist/index.js';
            const fullEntryPath = path.join(projectNodeModulesPath, entryPoint);

            logger.debug(`Found entry point in package.json: ${entryPoint}`);
            logger.debug(`Importing from: ${fullEntryPath}`);

            pluginModule = await import(fullEntryPath);
            logger.debug(`Successfully loaded plugin from project node_modules: ${plugin}`);
          } else {
            // Fallback to a common pattern if package.json doesn't exist
            const commonEntryPath = path.join(projectNodeModulesPath, 'dist/index.js');
            logger.debug(`No package.json found, trying common entry point: ${commonEntryPath}`);
            pluginModule = await import(commonEntryPath);
            logger.debug(`Successfully loaded plugin from common entry point: ${plugin}`);
          }
        } catch (projectImportError) {
          logger.error(`Failed to install plugin ${plugin}: ${importError}`);
          logger.error(
            `Also failed to import from project node_modules: ${projectImportError.message}`
          );
        }
      }
    }

    // Process the plugin to get the actual plugin object
    const functionName = `${plugin
      .replace('@elizaos/plugin-', '')
      .replace('@elizaos-plugins/', '')
      .replace(/-./g, (x) => x[1].toUpperCase())}Plugin`; // Assumes plugin function is camelCased with Plugin suffix

    // Add detailed logging to debug plugin loading
    logger.debug(`Looking for plugin export: ${functionName}`);
    logger.debug(`Available exports: ${Object.keys(pluginModule).join(', ')}`);
    logger.debug(`Has default export: ${!!pluginModule.default}`);

    // Check if the plugin is available as a default export or named export
    const importedPlugin = pluginModule.default || pluginModule[functionName];

    if (importedPlugin) {
      logger.debug(`Found plugin: ${importedPlugin.name}`);
      characterPlugins.push(importedPlugin);
    } else {
      // Try more aggressively to find a suitable plugin export
      let foundPlugin = null;

      // Look for any object with a name and init function
      for (const key of Object.keys(pluginModule)) {
        const potentialPlugin = pluginModule[key];
        if (
          potentialPlugin &&
          typeof potentialPlugin === 'object' &&
          potentialPlugin.name &&
          typeof potentialPlugin.init === 'function'
        ) {
          logger.debug(`Found alternative plugin export under key: ${key}`);
          foundPlugin = potentialPlugin;
          break;
        }
      }

      if (foundPlugin) {
        logger.debug(`Using alternative plugin: ${foundPlugin.name}`);
        characterPlugins.push(foundPlugin);
      } else {
        logger.warn(
          `Could not find plugin export in ${plugin}. Available exports: ${Object.keys(pluginModule).join(', ')}`
        );
      }
    }
  }

  function loadEnvConfig(): RuntimeSettings {
    // Only import dotenv in Node.js environment
    let dotenv = null;
    try {
      // This code block will only execute in Node.js environments
      if (typeof process !== 'undefined' && process.versions && process.versions.node) {
        dotenv = require('dotenv');
      }
    } catch (err) {
      // Silently fail if require is not available (e.g., in browser environments)
      logger.debug('dotenv module not available');
    }

    function findNearestEnvFile(startDir = process.cwd()) {
      let currentDir = startDir;

      // Continue searching until we reach the root directory
      while (currentDir !== path.parse(currentDir).root) {
        const envPath = path.join(currentDir, '.env');

        if (fs.existsSync(envPath)) {
          return envPath;
        }

        // Move up to parent directory
        currentDir = path.dirname(currentDir);
      }

      // Check root directory as well
      const rootEnvPath = path.join(path.parse(currentDir).root, '.env');
      return fs.existsSync(rootEnvPath) ? rootEnvPath : null;
    }

    // Node.js environment: load from .env file
    const envPath = findNearestEnvFile();

    // Load the .env file into process.env synchronously
    try {
      if (dotenv) {
        const result = dotenv.config(envPath ? { path: envPath } : {});
        if (!result.error && envPath) {
          logger.log(`Loaded .env file from: ${envPath}`);
        }
      }
    } catch (err) {
      logger.warn('Failed to load .env file:', err);
    }

    // Parse namespaced settings
    const env = typeof process !== 'undefined' ? process.env : (import.meta as any).env;
    const namespacedSettings = parseNamespacedSettings(env as RuntimeSettings);

    // Attach to process.env for backward compatibility if available
    if (typeof process !== 'undefined') {
      for (const [namespace, settings] of Object.entries(namespacedSettings)) {
        process.env[`__namespaced_${namespace}`] = JSON.stringify(settings);
      }
    }

    return env as RuntimeSettings;
  }

  interface NamespacedSettings {
    [namespace: string]: RuntimeSettings;
  }

  // Add this function to parse namespaced settings
  function parseNamespacedSettings(env: RuntimeSettings): NamespacedSettings {
    const namespaced: NamespacedSettings = {};

    for (const [key, value] of Object.entries(env)) {
      if (!value) continue;

      const [namespace, ...rest] = key.split('.');
      if (!namespace || rest.length === 0) continue;

      const settingKey = rest.join('.');
      namespaced[namespace] = namespaced[namespace] || {};
      namespaced[namespace][settingKey] = value;
    }

    return namespaced;
  }

  const runtime = new AgentRuntime({
    character: encryptedChar,
    plugins: [...plugins, ...characterPlugins],
    settings: loadEnvConfig(),
  });
  if (init) {
    await init(runtime);
  }

  // start services/plugins/process knowledge
  await runtime.initialize();

  // add to container
  server.registerAgent(runtime);

  // report to console
  logger.debug(`Started ${runtime.character.name} as ${runtime.agentId}`);

  return runtime;
}

/**
 * Stops the agent by closing the database adapter and unregistering the agent from the server.
 *
 * @param {IAgentRuntime} runtime - The runtime of the agent.
 * @param {AgentServer} server - The server that the agent is registered with.
 * @returns {Promise<void>} - A promise that resolves once the agent is stopped.
 */
async function stopAgent(runtime: IAgentRuntime, server: AgentServer) {
  await runtime.close();
  server.unregisterAgent(runtime.agentId);
}

/**
 * Function that starts the agents.
 *
 * @param {Object} options - Command options
 * @returns {Promise<void>} A promise that resolves when the agents are successfully started.
 */
const startAgents = async (options: {
  configure?: boolean;
  port?: number;
  characters?: Character[];
}) => {
  // Load environment variables from project .env or .eliza/.env
  await loadEnvironment();

  // Configure database settings - pass reconfigure option to potentially force reconfiguration
  const postgresUrl = await configureDatabaseSettings(options.configure);

  // Get PGLite data directory from environment (may have been set during configuration)
  const pgliteDataDir = process.env.PGLITE_DATA_DIR;

  // Load existing configuration
  const existingConfig = loadConfig();

  // Check if we should reconfigure based on command-line option or if using default config
  const shouldConfigure = options.configure || existingConfig.isDefault;

  // Handle service and model selection
  if (shouldConfigure) {
    // First-time setup or reconfiguration requested
    if (existingConfig.isDefault) {
      logger.info("First time setup. Let's configure your Eliza agent.");
    } else {
      logger.info('Reconfiguration requested.');
    }

    // Save the configuration AFTER user has made selections
    saveConfig({
      lastUpdated: new Date().toISOString(),
    });
  }

  // Create server instance with appropriate database settings
  const server = new AgentServer({
    dataDir: pgliteDataDir,
    postgresUrl,
  });

  // Set up server properties
  server.startAgent = async (character) => {
    logger.info(`Starting agent for character ${character.name}`);
    return startAgent(character, server);
  };
  server.stopAgent = (runtime: IAgentRuntime) => {
    stopAgent(runtime, server);
  };
  server.loadCharacterTryPath = loadCharacterTryPath;
  server.jsonToCharacter = jsonToCharacter;

  const serverPort = options.port || Number.parseInt(process.env.SERVER_PORT || '3000');

  // Try to find a project or plugin in the current directory
  let isProject = false;
  let isPlugin = false;
  let pluginModule: Plugin | null = null;
  let projectModule: any = null;

  const currentDir = process.cwd();
  try {
    // Check if we're in a project with a package.json
    const packageJsonPath = path.join(process.cwd(), 'package.json');
    logger.debug(`Checking for package.json at: ${packageJsonPath}`);

    if (fs.existsSync(packageJsonPath)) {
      // Read and parse package.json to check if it's a project or plugin
      const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));
      logger.debug(`Found package.json with name: ${packageJson.name || 'unnamed'}`);

      // Check if this is a plugin (package.json contains 'eliza' section with type='plugin')
      if (packageJson.eliza?.type && packageJson.eliza.type === 'plugin') {
        isPlugin = true;
        logger.info('Found Eliza plugin in current directory');
      }

      // Check if this is a project (package.json contains 'eliza' section with type='project')
      if (packageJson.eliza?.type && packageJson.eliza.type === 'project') {
        isProject = true;
        logger.info('Found Eliza project in current directory');
      }

      // Also check for project indicators like a Project type export
      // or if the description mentions "project"
      if (!isProject && !isPlugin) {
        if (packageJson.description?.toLowerCase().includes('project')) {
          isProject = true;
          logger.info('Found project by description in package.json');
        }
      }

      // If we found a main entry in package.json, try to load it
      const mainEntry = packageJson.main;
      if (mainEntry) {
        const mainPath = path.resolve(process.cwd(), mainEntry);

        if (fs.existsSync(mainPath)) {
          try {
            // Try to import the module
            const importedModule = await import(mainPath);

            // First check if it's a plugin
            if (
              isPlugin ||
              (importedModule.default &&
                typeof importedModule.default === 'object' &&
                importedModule.default.name &&
                typeof importedModule.default.init === 'function')
            ) {
              isPlugin = true;
              pluginModule = importedModule.default;
              logger.info(`Loaded plugin: ${pluginModule?.name || 'unnamed'}`);

              if (!pluginModule) {
                logger.warn('Plugin loaded but no default export found, looking for other exports');

                // Try to find any exported plugin object
                for (const key in importedModule) {
                  if (
                    importedModule[key] &&
                    typeof importedModule[key] === 'object' &&
                    importedModule[key].name &&
                    typeof importedModule[key].init === 'function'
                  ) {
                    pluginModule = importedModule[key];
                    logger.info(`Found plugin export under key: ${key}`);
                    break;
                  }
                }
              }
            }
            // Then check if it's a project
            else if (
              isProject ||
              (importedModule.default &&
                typeof importedModule.default === 'object' &&
                importedModule.default.agents)
            ) {
              isProject = true;
              projectModule = importedModule;
              logger.debug(
                `Loaded project with ${projectModule.default?.agents?.length || 0} agents`
              );
            }
          } catch (importError) {
            logger.error(`Error importing module: ${importError}`);
          }
        } else {
          logger.error(`Main entry point ${mainPath} does not exist`);
        }
      }
    }
  } catch (error) {
    logger.error(`Error checking for project/plugin: ${error}`);
  }

  // Log what was found
  logger.debug(`Classification results - isProject: ${isProject}, isPlugin: ${isPlugin}`);

  if (isProject) {
    if (projectModule?.default) {
      const project = projectModule.default;
      const agents = Array.isArray(project.agents)
        ? project.agents
        : project.agent
          ? [project.agent]
          : [];
      logger.debug(`Project contains ${agents.length} agent(s)`);

      // Log agent names
      if (agents.length > 0) {
        logger.debug(`Agents: ${agents.map((a) => a.character?.name || 'unnamed').join(', ')}`);
      }
    } else {
      logger.warn("Project module doesn't contain a valid default export");
    }
  } else if (isPlugin) {
    logger.debug(`Found plugin: ${pluginModule?.name || 'unnamed'}`);
  } else {
    // Change the log message to be clearer about what we're doing
    logger.debug(
      'Running in standalone mode - using default Eliza character from ../characters/eliza'
    );
  }

  await server.initialize();

  server.start(serverPort);

  // if characters are provided, start the agents with the characters
  if (options.characters) {
    for (const character of options.characters) {
      // make sure character has sql plugin
      if (!character.plugins.includes('@elizaos/plugin-sql')) {
        character.plugins.push('@elizaos/plugin-sql');
      }

      // make sure character has at least one ai provider
      if (process.env.OPENAI_API_KEY) {
        character.plugins.push('@elizaos/plugin-openai');
      } else if (process.env.ANTHROPIC_API_KEY) {
        character.plugins.push('@elizaos/plugin-anthropic');
      } else {
        character.plugins.push('@elizaos/plugin-local-ai');
      }

      await startAgent(character, server);
    }
  } else {
    // Start agents based on project, plugin, or custom configuration
    if (isProject && projectModule?.default) {
      // Load all project agents, call their init and register their plugins
      const project = projectModule.default;

      // Handle both formats: project with agents array and project with single agent
      const agents = Array.isArray(project.agents)
        ? project.agents
        : project.agent
          ? [project.agent]
          : [];

      if (agents.length > 0) {
        logger.debug(`Found ${agents.length} agents in project`);

        // Prompt for environment variables for all plugins in the project
        try {
          await promptForProjectPlugins(project);
        } catch (error) {
          logger.warn(`Failed to prompt for project environment variables: ${error}`);
        }

        const startedAgents = [];
        for (const agent of agents) {
          try {
            logger.debug(`Starting agent: ${agent.character.name}`);
            const runtime = await startAgent(
              agent.character,
              server,
              agent.init,
              agent.plugins || []
            );
            startedAgents.push(runtime);
            // wait .5 seconds
            await new Promise((resolve) => setTimeout(resolve, 500));
          } catch (agentError) {
            logger.error(`Error starting agent ${agent.character.name}: ${agentError}`);
          }
        }

        if (startedAgents.length === 0) {
          logger.warn('Failed to start any agents from project, falling back to custom character');
          await startAgent(defaultCharacter, server);
        } else {
          logger.debug(`Successfully started ${startedAgents.length} agents from project`);
        }
      } else {
        logger.debug('Project found but no agents defined, falling back to custom character');
        await startAgent(defaultCharacter, server);
      }
    } else if (isPlugin && pluginModule) {
      // Before starting with the plugin, prompt for any environment variables it needs
      if (pluginModule.name) {
        try {
          await promptForEnvVars(pluginModule.name);
        } catch (error) {
          logger.warn(`Failed to prompt for plugin environment variables: ${error}`);
        }
      }

      // Load the default character with all its default plugins, then add the test plugin
      logger.info(
        `Starting default Eliza character with plugin: ${pluginModule.name || 'unnamed plugin'}`
      );

      // Import the default character with all its plugins
      const { character: defaultElizaCharacter } = await import('../characters/eliza');

      // Create an array of plugins, including the explicitly loaded one
      // We're using our test plugin plus all the plugins from the default character
      const pluginsToLoad = [pluginModule];

      logger.debug(
        `Using default character with plugins: ${defaultElizaCharacter.plugins.join(', ')}`
      );
      logger.info(
        "Plugin test mode: Using default character's plugins plus the plugin being tested"
      );

      // Start the agent with the default character and our test plugin
      // We're in plugin test mode, so we should skip auto-loading embedding models
      await startAgent(defaultElizaCharacter, server, undefined, pluginsToLoad, {
        isPluginTestMode: true,
      });
      logger.info('Character started with plugin successfully');
    } else {
      // When not in a project or plugin, load the default character with all plugins
      const { character: defaultElizaCharacter } = await import('../characters/eliza');
      logger.info('Using default Eliza character with all plugins');
      await startAgent(defaultElizaCharacter, server);
    }

    // Display link to the client UI
    // First try to find it in the CLI package dist/client directory
    let clientPath = path.join(__dirname, '../../client');

    // If not found, fall back to the old relative path for development
    if (!fs.existsSync(clientPath)) {
      clientPath = path.join(__dirname, '../../../..', 'client/dist');
    }
  }
};
// Create command that can be imported directly
export const start = new Command()
  .name('start')
  .description('Start the Eliza agent with configurable plugins and services')
  .option('-p, --port <port>', 'Port to listen on', (val) => Number.parseInt(val))
  .option('-c, --configure', 'Reconfigure services and AI models (skips using saved configuration)')
  .option('--character <character>', 'Path or URL to character file to use instead of default')
  .option('--build', 'Build the project before starting')
  .option('--characters <paths>', 'multiple character configuration files separated by commas')
  .action(async (options) => {
    displayBanner();

    try {
      // Build the project first unless skip-build is specified
      if (options.build) {
        await buildProject(process.cwd());
      }

      // Collect server options
      const characterPath = options.character;

      if (characterPath) {
        options.characters = [];
        try {
          // if character path is a comma separated list, load all characters
          // can be remote path also
          if (characterPath.includes(',')) {
            const characterPaths = characterPath.split(',');
            for (const characterPath of characterPaths) {
              logger.info(`Loading character from ${characterPath}`);
              const characterData = await loadCharacterTryPath(characterPath);
              options.characters.push(characterData);
            }
          } else {
            // Single character
            logger.info(`Loading character from ${characterPath}`);
            const characterData = await loadCharacterTryPath(characterPath);
            options.characters.push(characterData);
          }
          await startAgents(options);
        } catch (error) {
          logger.error(`Failed to load character: ${error}`);
          process.exit(1);
        }
      } else if (options.characters) {
        // Handle --characters option
        options.characters = [];
        try {
          const characterPaths = options.characters.split(',').map((path) => path.trim());
          for (const charPath of characterPaths) {
            if (charPath) {
              logger.info(`Loading character from ${charPath}`);
              const characterData = await loadCharacterTryPath(charPath);
              options.characters.push(characterData);
            }
          }
          await startAgents(options);
        } catch (error) {
          logger.error(`Failed to load multiple characters: ${error}`);
          process.exit(1);
        }
      } else {
        await startAgents(options);
      }
    } catch (error) {
      handleError(error);
    }
  });

// This is the function that registers the command with the CLI
export default function registerCommand(cli: Command) {
  return cli.addCommand(start);
}
