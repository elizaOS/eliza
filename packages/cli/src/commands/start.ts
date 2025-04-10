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
import { findNextAvailablePort } from '../utils/port-handling';
import { loadPluginModule } from '../utils/load-plugin';

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
      console.warn(`Failed to prompt for ${pluginName} environment variables: ${error}`);
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

  // if encryptedChar.plugins does not include @elizaos/plugin-bootstrap, add it
  if (!encryptedChar.plugins.includes('@elizaos/plugin-bootstrap')) {
    encryptedChar.plugins.push('@elizaos/plugin-bootstrap');
  }

  // for each plugin, check if it installed, and install if it is not
  for (const plugin of encryptedChar.plugins) {
    console.debug('Checking if plugin is installed: ', plugin);
    let pluginModule: any;

    // Try to load the plugin using multiple strategies
    try {
      // Use the new centralized loader
      pluginModule = await loadPluginModule(plugin);

      if (!pluginModule) {
        // If loading failed, try installing and then loading again
        console.info(`Plugin ${plugin} not available, installing into ${process.cwd()}...`);
        try {
          await installPlugin(plugin, process.cwd(), version);
          // Try loading again after installation using the centralized loader
          pluginModule = await loadPluginModule(plugin);
        } catch (installError) {
          console.error(`Failed to install plugin ${plugin}: ${installError}`);
          // Continue to next plugin if installation fails
          continue;
        }

        if (!pluginModule) {
          console.error(`Failed to load plugin ${plugin} even after installation.`);
          // Continue to next plugin if loading fails post-installation
          continue;
        }
      }
    } catch (error) {
      // Catch any unexpected error during the combined load/install/load process
      console.error(`An unexpected error occurred while processing plugin ${plugin}: ${error}`);
      continue;
    }

    if (!pluginModule) {
      // This check might be redundant now, but kept for safety.
      // Should theoretically not be reached if the logic above is correct.
      console.error(`Failed to process plugin ${plugin} (module is null/undefined unexpectedly)`);
      continue;
    }

    // Process the plugin to get the actual plugin object
    const functionName = `${plugin
      .replace('@elizaos/plugin-', '')
      .replace('@elizaos-plugins/', '')
      .replace(/-./g, (x) => x[1].toUpperCase())}Plugin`; // Assumes plugin function is camelCased with Plugin suffix

    // Add detailed logging to debug plugin loading
    console.debug(`Looking for plugin export: ${functionName}`);
    console.debug(`Available exports: ${Object.keys(pluginModule).join(', ')}`);
    console.debug(`Has default export: ${!!pluginModule.default}`);

    // Check if the plugin is available as a default export or named export
    const importedPlugin = pluginModule.default || pluginModule[functionName];

    if (importedPlugin) {
      console.debug(`Found plugin: ${importedPlugin.name}`);
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
          console.debug(`Found alternative plugin export under key: ${key}`);
          foundPlugin = potentialPlugin;
          break;
        }
      }

      if (foundPlugin) {
        console.debug(`Using alternative plugin: ${foundPlugin.name}`);
        characterPlugins.push(foundPlugin);
      } else {
        console.warn(
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
      console.debug('dotenv module not available');
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
          console.log(`Loaded .env file from: ${envPath}`);
        }
      }
    } catch (err) {
      console.warn('Failed to load .env file:', err);
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
    plugins: [...characterPlugins, ...plugins],
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
  console.debug(`Started ${runtime.character.name} as ${runtime.agentId}`);

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
      console.info("First time setup. Let's configure your Eliza agent.");
    } else {
      console.info('Reconfiguration requested.');
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
    console.info(`Starting agent for character ${character.name}`);
    return startAgent(character, server);
  };
  server.stopAgent = (runtime: IAgentRuntime) => {
    stopAgent(runtime, server);
  };
  server.loadCharacterTryPath = loadCharacterTryPath;
  server.jsonToCharacter = jsonToCharacter;

  // Inside your startAgents function
  const desiredPort = options.port || Number.parseInt(process.env.SERVER_PORT || '3000');
  const serverPort = await findNextAvailablePort(desiredPort);

  process.env.SERVER_PORT = serverPort.toString();

  // Try to find a project or plugin in the current directory
  let isProject = false;
  let isPlugin = false;
  let pluginModule: Plugin | null = null;
  let projectModule: any = null;

  const currentDir = process.cwd();
  try {
    // Check if we're in a project with a package.json
    const packageJsonPath = path.join(process.cwd(), 'package.json');
    console.debug(`Checking for package.json at: ${packageJsonPath}`);

    if (fs.existsSync(packageJsonPath)) {
      // Read and parse package.json to check if it's a project or plugin
      const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));
      console.debug(`Found package.json with name: ${packageJson.name || 'unnamed'}`);

      // Check if this is a plugin (package.json contains 'eliza' section with type='plugin')
      if (packageJson.eliza?.type && packageJson.eliza.type === 'plugin') {
        isPlugin = true;
        console.info('Found Eliza plugin in current directory');
      }

      // Check if this is a project (package.json contains 'eliza' section with type='project')
      if (packageJson.eliza?.type && packageJson.eliza.type === 'project') {
        isProject = true;
        console.info('Found Eliza project in current directory');
      }

      // Also check for project indicators like a Project type export
      // or if the description mentions "project"
      if (!isProject && !isPlugin) {
        if (packageJson.description?.toLowerCase().includes('project')) {
          isProject = true;
          console.info('Found project by description in package.json');
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
              console.info(`Loaded plugin: ${pluginModule?.name || 'unnamed'}`);

              if (!pluginModule) {
                console.warn(
                  'Plugin loaded but no default export found, looking for other exports'
                );

                // Try to find any exported plugin object
                for (const key in importedModule) {
                  if (
                    importedModule[key] &&
                    typeof importedModule[key] === 'object' &&
                    importedModule[key].name &&
                    typeof importedModule[key].init === 'function'
                  ) {
                    pluginModule = importedModule[key];
                    console.info(`Found plugin export under key: ${key}`);
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
              console.debug(
                `Loaded project with ${projectModule.default?.agents?.length || 0} agents`
              );
            }
          } catch (importError) {
            console.error(`Error importing module: ${importError}`);
          }
        } else {
          console.error(`Main entry point ${mainPath} does not exist`);
        }
      }
    }
  } catch (error) {
    console.error(`Error checking for project/plugin: ${error}`);
  }

  // Log what was found
  console.debug(`Classification results - isProject: ${isProject}, isPlugin: ${isPlugin}`);

  if (isProject) {
    if (projectModule?.default) {
      const project = projectModule.default;
      const agents = Array.isArray(project.agents)
        ? project.agents
        : project.agent
          ? [project.agent]
          : [];
      console.debug(`Project contains ${agents.length} agent(s)`);

      // Log agent names
      if (agents.length > 0) {
        console.debug(`Agents: ${agents.map((a) => a.character?.name || 'unnamed').join(', ')}`);
      }
    } else {
      console.warn("Project module doesn't contain a valid default export");
    }
  } else if (isPlugin) {
    console.debug(`Found plugin: ${pluginModule?.name || 'unnamed'}`);
  } else {
    // Change the log message to be clearer about what we're doing
    console.debug(
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
        console.debug(`Found ${agents.length} agents in project`);

        // Prompt for environment variables for all plugins in the project
        try {
          await promptForProjectPlugins(project);
        } catch (error) {
          console.warn(`Failed to prompt for project environment variables: ${error}`);
        }

        const startedAgents = [];
        for (const agent of agents) {
          try {
            console.debug(`Starting agent: ${agent.character.name}`);
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
            console.error(`Error starting agent ${agent.character.name}: ${agentError}`);
          }
        }

        if (startedAgents.length === 0) {
          console.info('No project agents started - falling back to default Eliza character');
          await startAgent(defaultCharacter, server);
        } else {
          console.debug(`Successfully started ${startedAgents.length} agents from project`);
        }
      } else {
        console.debug(
          'Project found but no agents defined, falling back to default Eliza character'
        );
        await startAgent(defaultCharacter, server);
      }
    } else if (isPlugin && pluginModule) {
      // Before starting with the plugin, prompt for any environment variables it needs
      if (pluginModule.name) {
        try {
          await promptForEnvVars(pluginModule.name);
        } catch (error) {
          console.warn(`Failed to prompt for plugin environment variables: ${error}`);
        }
      }

      // Load the default character with all its default plugins, then add the test plugin
      console.info(
        `Starting default Eliza character with plugin: ${pluginModule.name || 'unnamed plugin'}`
      );

      // Import the default character with all its plugins
      const { character: defaultElizaCharacter } = await import('../characters/eliza');

      // Create an array of plugins, including the explicitly loaded one
      // We're using our test plugin plus all the plugins from the default character
      const pluginsToLoad = [pluginModule];

      console.debug(
        `Using default character with plugins: ${defaultElizaCharacter.plugins.join(', ')}`
      );
      console.info(
        "Plugin test mode: Using default character's plugins plus the plugin being tested"
      );

      // Start the agent with the default character and our test plugin
      // We're in plugin test mode, so we should skip auto-loading embedding models
      await startAgent(defaultElizaCharacter, server, undefined, pluginsToLoad, {
        isPluginTestMode: true,
      });
      console.info('Character started with plugin successfully');
    } else {
      // When not in a project or plugin, load the default character with all plugins
      const { character: defaultElizaCharacter } = await import('../characters/eliza');
      console.info('Using default Eliza character with all plugins');
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
  .option(
    '-char, --character <character>',
    'Path or URL to character file to use instead of default'
  )
  .option('-b, --build', 'Build the project before starting')
  .option(
    '-chars, --characters <paths>',
    'multiple character configuration files separated by commas'
  )
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
              console.info(`Loading character from ${characterPath}`);
              const characterData = await loadCharacterTryPath(characterPath);
              options.characters.push(characterData);
            }
          } else {
            // Single character
            console.info(`Loading character from ${characterPath}`);
            const characterData = await loadCharacterTryPath(characterPath);
            options.characters.push(characterData);
          }
        } catch (error) {
          console.error(`Error loading character: ${error}`);
          return;
        }
      }

      await startAgents(options);
    } catch (error) {
      handleError(error);
    }
  });
