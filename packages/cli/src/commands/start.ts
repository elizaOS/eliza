import { getElizaCharacter } from '@/src/characters/eliza';
import { AgentServer } from '@/src/server/index';
import { jsonToCharacter, loadCharacterTryPath } from '@/src/server/loader';
import {
  buildProject,
  configureDatabaseSettings,
  displayBanner,
  findNextAvailablePort,
  getCliInstallTag,
  handleError,
  installPlugin,
  loadConfig,
  loadPluginModule,
  promptForEnvVars,
  resolvePgliteDir,
  saveConfig,
  UserEnvironment,
} from '@/src/utils';
import { detectPluginContext, provideLocalPluginGuidance } from '@/src/utils/plugin-context';
import {
  AgentRuntime,
  encryptedCharacter,
  logger,
  RuntimeSettings,
  stringToUuid,
  type Character,
  type IAgentRuntime,
  type Plugin,
} from '@elizaos/core';
import { Command } from 'commander';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { detectDirectoryType, getDirectoryTypeDescription } from '@/src/utils/directory-detection';
import { isValidPluginShape, loadAndPreparePlugin } from '@/src/utils/plugin-loader';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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

  // Ensure character has a plugins array
  if (!character.plugins) {
    character.plugins = [];
  }

  const encryptedChar = encryptedCharacter(character);

  // Determine the appropriate installation tag based on the CLI version
  const installTag = getCliInstallTag();

  const loadedPluginsMap = new Map<string, Plugin>();

  // Pre-load plugins passed directly to the function (these can be Plugin objects)
  for (const plugin of plugins) {
    if (isValidPluginShape(plugin)) {
      // Use isValidPluginShape for broader validation
      if (!loadedPluginsMap.has(plugin.name)) {
        logger.debug(`Using pre-provided plugin object: ${plugin.name}`);
        loadedPluginsMap.set(plugin.name, plugin);
      } else {
        logger.debug(`Plugin ${plugin.name} was already pre-loaded, skipping duplicate.`);
      }
    } else {
      logger.warn(
        `Invalid or non-object plugin skipped in pre-load: ${plugin ? JSON.stringify(plugin) : plugin}`
      ); // Stringify only if not null/undefined
    }
  }

  // Initialize encryptedChar.plugins if it's undefined
  encryptedChar.plugins = encryptedChar.plugins ?? [];

  const characterPlugins: Plugin[] = [];

  // Process and load plugins specified by name in the character definition
  // encryptedChar.plugins is guaranteed to be string[] according to Character type
  for (const pluginName of encryptedChar.plugins) {
    if (typeof pluginName !== 'string') {
      logger.warn(
        `Skipping non-string plugin specifier found in character.plugins: ${JSON.stringify(pluginName)}`
      );
      continue; // Should not happen based on type, but good safety check
    }

    if (!loadedPluginsMap.has(pluginName)) {
      //logger.debug(`Attempting to load plugin by name from character definition: ${pluginName}`);
      const loadedPlugin = await loadAndPreparePlugin(pluginName);
      if (loadedPlugin) {
        characterPlugins.push(loadedPlugin);
        // Double-check name consistency and avoid duplicates
        if (!loadedPluginsMap.has(loadedPlugin.name)) {
          loadedPluginsMap.set(loadedPlugin.name, loadedPlugin);
        } else {
          logger.debug(
            `Plugin ${loadedPlugin.name} (loaded as ${pluginName}) was already present in map, skipping.`
          );
        }
      } else {
        logger.warn(`Failed to load or prepare plugin specified by name: ${pluginName}`);
      }
    } else {
      logger.debug(
        `Plugin ${pluginName} (specified by name) was already loaded/provided, skipping.`
      );
    }
  }

  // Get the final array of loaded plugins
  logger.debug(
    `Final loaded plugins (${loadedPluginsMap.size}): ${[...characterPlugins, ...plugins].map((p) => p.name).join(', ')}`
  );

  async function loadEnvConfig(): Promise<RuntimeSettings> {
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

    // Node.js environment: load from .env file
    const envInfo = await UserEnvironment.getInstanceInfo();
    const envPath = envInfo.paths.envFilePath;
    if (envPath) {
      console.log(`[elizaos] Resolved .env file from: ${envPath}`);
    } else {
      console.log('[elizaos] No .env file found in any parent directory.');
    }

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
    // order matters here: make sure plugins are loaded after so they can interact with tasks (degen-intel)
    plugins: [...characterPlugins, ...plugins], // Use the deduplicated list
    settings: await loadEnvConfig(),
  });
  if (init) {
    init(runtime);
  }

  // start services/plugins/process knowledge
  await runtime.initialize();

  // add to container
  server.registerAgent(runtime);

  // report to console
  logger.log(`Started ${runtime.character.name} as ${runtime.agentId}`);

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
  logger.success(`Agent ${runtime.character.name} stopped successfully!`);
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
  // Load existing configuration
  const existingConfig = await loadConfig();

  // Configure database settings - pass reconfigure option to potentially force reconfiguration
  const postgresUrl = await configureDatabaseSettings(options.configure);

  // Ensure POSTGRES_URL is set in environment for runtime to access
  if (postgresUrl) {
    process.env.POSTGRES_URL = postgresUrl;
  }

  // Conditionally resolve PGLite directory only if PostgreSQL URL is not provided
  const pgliteDataDir = postgresUrl ? undefined : await resolvePgliteDir();

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

  // Create server instance
  const server = new AgentServer();
  // Initialize server with appropriate database settings
  await server.initialize({
    dataDir: pgliteDataDir,
    postgresUrl,
  });

  // Set up server properties
  server.startAgent = async (character) => {
    logger.debug(`Starting agent for character ${character.name}`);
    const runtime = await startAgent(character, server);
    logger.success(`Agent ${character.name} has been successfully started!`);
    // Add direct console log for higher visibility
    console.log(`\x1b[32m[√] Agent ${character.name} started successfully!\x1b[0m`);
    return runtime;
  };
  server.stopAgent = (runtime: IAgentRuntime) => {
    logger.debug(`Stopping agent ${runtime.character.name}`);
    stopAgent(runtime, server);
    // Add direct console log for higher visibility
    console.log(`\x1b[32m[√] Agent ${runtime.character.name} stopped successfully!\x1b[0m`);
  };
  server.loadCharacterTryPath = loadCharacterTryPath;
  server.jsonToCharacter = jsonToCharacter;

  // Inside your startAgents function
  const desiredPort = options.port || Number.parseInt(process.env.SERVER_PORT || '3000');
  logger.debug(`Attempting to start server on port: ${desiredPort}`);
  const serverPort = await findNextAvailablePort(desiredPort);

  if (serverPort !== desiredPort) {
    logger.warn(`Port ${desiredPort} is in use, using port ${serverPort} instead`);
  }

  process.env.SERVER_PORT = serverPort.toString();

  // Try to find a project or plugin in the current directory
  let isProject = false;
  let isPlugin = false;
  let pluginModule: Plugin | null = null;
  let projectModule: any = null;

  const currentDir = process.cwd();
  try {
    // Use standardized directory detection
    const directoryInfo = detectDirectoryType(currentDir);

    // Determine if this is a project or plugin
    isProject = directoryInfo.type === 'elizaos-project';
    isPlugin = directoryInfo.type === 'elizaos-plugin';

    if (isProject) {
      logger.debug('Found ElizaOS project using standardized directory detection');
    } else if (isPlugin) {
      logger.debug('Found ElizaOS plugin using standardized directory detection');
    }

    // If we found a plugin or project, try to load it
    if ((isProject || isPlugin) && directoryInfo.hasPackageJson) {
      const packageJsonPath = path.join(currentDir, 'package.json');
      const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));

      // If we found a main entry in package.json, try to load it
      const mainEntry = packageJson.main;
      if (mainEntry) {
        const mainPath = path.resolve(currentDir, mainEntry);

        if (fs.existsSync(mainPath)) {
          try {
            // Try to import the module
            const importedModule = await import(mainPath);

            if (isPlugin) {
              // Look for plugin object
              if (
                importedModule.default &&
                typeof importedModule.default === 'object' &&
                importedModule.default.name &&
                typeof importedModule.default.init === 'function'
              ) {
                pluginModule = importedModule.default;
                logger.debug(`Loaded plugin: ${pluginModule?.name || 'unnamed'}`);
              } else {
                logger.warn(
                  'Plugin detected but no valid plugin export found, looking for other exports'
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
                    logger.debug(`Found plugin export under key: ${key}`);
                    break;
                  }
                }
              }
            } else if (isProject) {
              // Look for project object
              if (
                importedModule.default &&
                typeof importedModule.default === 'object' &&
                importedModule.default.agents
              ) {
                projectModule = importedModule;
                logger.debug('Loaded project module');
              }
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

  server.start(serverPort);

  // If characters are provided, start the agents with the characters
  if (options.characters && options.characters.length > 0) {
    for (const character of options.characters) {
      // Initialize plugins as an empty array if undefined
      character.plugins = character.plugins || [];

      // make sure character has sql plugin
      const hasSqlPlugin = character.plugins.some(
        (plugin) => plugin.includes('plugin-sql') || plugin.includes('plugin-mysql')
      );
      if (!hasSqlPlugin) {
        character.plugins.push('@elizaos/plugin-sql');
      }

      // make sure character has at least one ai provider
      if (process.env.OPENAI_API_KEY) {
        const hasOpenAiPlugin = character.plugins.some((plugin) =>
          plugin.includes('plugin-openai')
        );
        if (!hasOpenAiPlugin) {
          character.plugins.push('@elizaos/plugin-openai');
        }
      } else if (process.env.ANTHROPIC_API_KEY) {
        const hasAnthropicPlugin = character.plugins.some((plugin) =>
          plugin.includes('plugin-anthropic')
        );
        if (!hasAnthropicPlugin) {
          character.plugins.push('@elizaos/plugin-anthropic');
        }
      } else {
        const hasLocalAiPlugin = character.plugins.some((plugin) =>
          plugin.includes('plugin-local-ai')
        );
        if (!hasLocalAiPlugin) {
          character.plugins.push('@elizaos/plugin-local-ai');
        }
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
        const results = await Promise.allSettled(
          agents.map(async (agent) => {
            logger.debug(`Starting agent: ${agent.character.name}`);
            const runtime = await startAgent(
              agent.character,
              server,
              agent.init,
              agent.plugins || []
            );
            return runtime;
          })
        );

        startedAgents.push(...results.filter(Boolean));

        if (startedAgents.length === 0) {
          logger.info('No project agents started - falling back to default Eliza character');
          const elizaCharacter = getElizaCharacter();
          await startAgent(elizaCharacter, server);
        } else {
          logger.info(`Successfully started ${startedAgents.length} agents from project`);
        }
      } else {
        logger.info('Project found but no agents defined, falling back to default Eliza character');
        const elizaCharacter = getElizaCharacter();
        await startAgent(elizaCharacter, server);
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
      logger.debug(
        `Starting default Eliza character with plugin: ${pluginModule.name || 'unnamed plugin'}`
      );

      // Get the default character with environment-aware plugins
      const defaultElizaCharacter = getElizaCharacter();

      // Clone the character and add the plugin to its plugins array for GUI display
      const characterWithPlugin = {
        ...defaultElizaCharacter,
        plugins: [...defaultElizaCharacter.plugins, `@elizaos/${pluginModule.name}`],
      };

      logger.debug(
        `Using default character with plugins: ${characterWithPlugin.plugins.join(', ')}`
      );
      logger.debug(
        `Plugin test mode: Loading local plugin (${pluginModule.name}) as pre-provided plugin object and in character plugins array`
      );

      // Start the agent with the modified character that includes the plugin in its plugins array
      // AND pass the actual plugin object so it loads from the local source instead of trying to download
      const runtime = await startAgent(characterWithPlugin, server, undefined, [pluginModule], {
        isPluginTestMode: true,
      });

      // Save the modified character to the database so the API returns the correct plugin list
      // Do this AFTER starting the agent so the runtime and database are properly initialized
      try {
        await runtime.updateAgent(runtime.agentId, { plugins: characterWithPlugin.plugins });
        logger.debug(`Updated agent plugins in database: ${pluginModule.name}`);
      } catch (error) {
        logger.warn(`Failed to update agent plugins in database: ${error.message}`);
      }
    } else {
      // When not in a project or plugin, use the environment-aware character
      const elizaCharacter = getElizaCharacter();
      logger.debug(
        `Using default Eliza character with plugins: ${elizaCharacter.plugins.join(', ')}`
      );
      await startAgent(elizaCharacter, server);
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
  .option(
    '-c, --configure',
    'Force reconfiguration of services and AI models (bypasses saved configuration)'
  )
  .option('-char, --character [paths...]', 'Character file(s) to use - accepts paths or URLs')
  .option('-b, --build', 'Build the project before starting')
  .option('-p, --port <port>', 'Port to listen on (default: 3000)', (v) => {
    const n = Number.parseInt(v, 10);
    if (Number.isNaN(n) || n <= 0 || n > 65535) {
      throw new Error('Port must be a number between 1 and 65535');
    }
    return n;
  })
  .hook('preAction', async () => {
    await displayBanner();
  })
  .action(async (options) => {
    try {
      // Build the project first unless skip-build is specified
      if (options.build) {
        await buildProject(process.cwd());
      }

      // Store characters in a new array to avoid issues with commander
      let loadedCharacters: Character[] = [];
      let failedCharacters: string[] = [];

      // Process character(s) from options.character
      if (options.character) {
        const characterPaths: string[] = [];

        // Handle both array and single string inputs
        if (Array.isArray(options.character)) {
          for (const item of options.character) {
            // Split by commas in case user provided comma-separated list
            // Strip quotes if present (handles both single and double quotes)
            const parts = item
              .trim()
              .split(',')
              .map((part) => part.trim())
              .map((part) => part.replace(/^['"](.*)['"]$/, '$1'))
              .filter(Boolean);
            characterPaths.push(...parts);
          }
        } else if (typeof options.character === 'string') {
          // Split by commas in case user provided comma-separated list
          // Strip quotes if present (handles both single and double quotes)
          const parts = options.character
            .trim()
            .split(',')
            .map((part) => part.trim())
            .map((part) => part.replace(/^['"](.*)['"]$/, '$1'))
            .filter(Boolean);
          characterPaths.push(...parts);
        } else if (options.character === true) {
          // Handle the case where flag is provided without arguments
          logger.warn('--character flag provided without any paths. No characters will be loaded.');
        }

        // Load each character path
        for (const path of characterPaths) {
          try {
            logger.debug(`Loading character from ${path}`);
            // Try with the exact path first
            let characterData;
            try {
              characterData = await loadCharacterTryPath(path);
            } catch (error) {
              // If that fails and there's no extension, try adding .json
              if (!path.includes('.')) {
                logger.debug(`Trying with .json extension: ${path}.json`);
                characterData = await loadCharacterTryPath(`${path}.json`);
              } else {
                throw error;
              }
            }
            loadedCharacters.push(characterData);
          } catch (error) {
            failedCharacters.push(path);
            logger.error(`Failed to load character from ${path}: ${error}`);
          }
        }

        // If we have both successes and failures, log a message
        if (loadedCharacters.length > 0 && failedCharacters.length > 0) {
          logger.warn(
            `${failedCharacters.length} character(s) failed to load, but ${loadedCharacters.length} succeeded. Starting server with valid characters.`
          );
        }
        // If all characters failed, log error and handle gracefully
        else if (loadedCharacters.length === 0 && characterPaths.length > 0) {
          logger.error(
            `All ${failedCharacters.length} character(s) failed to load. Starting server with default character...`
          );
        }
      }

      // Start the agents with loaded characters
      await startAgents({
        configure: options.configure,
        port: options.port,
        characters: loadedCharacters,
      });
    } catch (error) {
      handleError(error);
    }
  });
