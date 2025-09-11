import {
  AgentRuntime,
  ElizaOS,
  encryptedCharacter,
  logger,
  stringToUuid,
  type Character,
  type IAgentRuntime,
  type Plugin,
} from '@elizaos/core';
import { plugin as sqlPlugin } from '@elizaos/plugin-sql';
import { messageBusConnectorPlugin } from '../services/message';
import { PluginLoader } from './PluginLoader';
import { ConfigManager } from './ConfigManager';

export interface AgentStartOptions {
  isTestMode?: boolean;
}

/**
 * Manages agent lifecycle operations
 */
export class AgentManager {
  private elizaOS: ElizaOS;
  private pluginLoader: PluginLoader;
  private configManager: ConfigManager;

  constructor(elizaOS: ElizaOS) {
    this.elizaOS = elizaOS;
    this.pluginLoader = new PluginLoader();
    this.configManager = new ConfigManager();
  }

  /**
   * Start an agent with the given configuration
   *
   * Creates and initializes an agent runtime with plugins, handles dependency resolution, runs database migrations, and registers the agent with the server.
   */
  async startAgent(
    character: Character,
    init?: (runtime: IAgentRuntime) => Promise<void>,
    plugins: (Plugin | string)[] = [],
    options: AgentStartOptions = {}
  ): Promise<IAgentRuntime> {
    character.id ??= stringToUuid(character.name);

    // Handle secrets for character configuration
    if (!this.configManager.hasCharacterSecrets(character)) {
      await this.configManager.setDefaultSecretsFromEnv(character);
    }

    const loadedPlugins = new Map<string, Plugin>();

    const pluginsToLoad = new Set<string>(character.plugins || []);
    for (const p of plugins) {
      if (typeof p === 'string') {
        pluginsToLoad.add(p);
      } else if (this.pluginLoader.isValidPluginShape(p) && !loadedPlugins.has(p.name)) {
        loadedPlugins.set(p.name, p);
        (p.dependencies || []).forEach((dep) => { pluginsToLoad.add(dep); });
        if (options.isTestMode) {
          (p.testDependencies || []).forEach((dep) => { pluginsToLoad.add(dep); });
        }
      }
    }

    // Load all requested plugins
    const allAvailablePlugins = new Map<string, Plugin>();
    for (const p of loadedPlugins.values()) {
      allAvailablePlugins.set(p.name, p);
    }
    for (const name of pluginsToLoad) {
      if (!allAvailablePlugins.has(name)) {
        const loaded = await this.pluginLoader.loadAndPreparePlugin(name);
        if (loaded) {
          allAvailablePlugins.set(loaded.name, loaded);
        }
      }
    }

    // Check if we have a SQL plugin
    let haveSql = false;
    for (const n of allAvailablePlugins.keys()) {
      // we need a better way to detect adapters
      if (n === sqlPlugin.name || n === 'mysql') {
        haveSql = true;
        break;
      }
    }

    // Ensure an adapter
    if (!haveSql) {
      // Type-cast to ensure compatibility with local types
      allAvailablePlugins.set(sqlPlugin.name, sqlPlugin as unknown as Plugin);
    }

    // Resolve dependencies and get final plugin list
    const finalPlugins = this.pluginLoader.resolvePluginDependencies(
      allAvailablePlugins,
      options.isTestMode
    );

    // Prepare the character with encrypted data
    const preparedCharacter = encryptedCharacter(character);
    
    // Store plugins and settings for later use
    const settings = await this.configManager.loadEnvConfig();
    
    // Step 1: Add agent (create it)
    const agentId = await this.elizaOS.addAgent(preparedCharacter);
    
    // Step 2: Start agent (initialize it)
    await this.elizaOS.startAgent(agentId);
    
    // Step 3: Get the runtime that was created
    const runtime = this.elizaOS.getAgent(agentId);
    if (!runtime) {
      throw new Error(`Failed to create agent ${character.name}`);
    }
    
    // Register plugins with the runtime
    for (const plugin of finalPlugins) {
      await runtime.registerPlugin(plugin);
    }
    
    // Apply settings
    Object.assign(runtime, { settings });
    
    // Run init callback if provided
    if (init) {
      await init(runtime);
    }

    // Discover and run plugin schema migrations
    try {
      const migrationService = runtime.getService('database_migration');
      if (migrationService) {
        logger.info('Discovering plugin schemas for dynamic migration...');
        (migrationService as any).discoverAndRegisterPluginSchemas(finalPlugins);

        logger.info('Running all plugin migrations...');
        await (migrationService as any).runAllPluginMigrations();
        logger.info('All plugin migrations completed successfully');
      } else {
        logger.warn('DatabaseMigrationService not found - plugin schema migrations skipped');
      }
    } catch (error) {
      logger.error({ error }, 'Failed to run plugin migrations:');
      throw error;
    }

    // No need to register with server anymore - ElizaOS manages it
    logger.log(`Started ${runtime.character.name} as ${runtime.agentId}`);
    return runtime;
  }

  /**
   * Start multiple agents in batch (true parallel)
   * @param characters - Array of character configurations
   * @param init - Optional init function for each agent
   * @param plugins - Plugins to load
   * @param options - Start options
   * @returns Array of started agent runtimes
   */
  async startAgents(
    characters: Character[],
    init?: (runtime: IAgentRuntime) => Promise<void>,
    plugins: (Plugin | string)[] = [],
    options: AgentStartOptions = {}
  ): Promise<IAgentRuntime[]> {
    // Prepare all characters in parallel
    const preparations = await Promise.all(
      characters.map(async (character) => {
        character.id ??= stringToUuid(character.name);
        
        // Handle secrets for character configuration
        if (!this.configManager.hasCharacterSecrets(character)) {
          await this.configManager.setDefaultSecretsFromEnv(character);
        }
        
        // Load and resolve plugins
        const loadedPlugins = new Map<string, Plugin>();
        const pluginsToLoad = new Set<string>(character.plugins || []);
        
        for (const p of plugins) {
          if (typeof p === 'string') {
            pluginsToLoad.add(p);
          } else if (this.pluginLoader.isValidPluginShape(p) && !loadedPlugins.has(p.name)) {
            loadedPlugins.set(p.name, p);
            (p.dependencies || []).forEach((dep) => { pluginsToLoad.add(dep); });
            if (options.isTestMode) {
              (p.testDependencies || []).forEach((dep) => { pluginsToLoad.add(dep); });
            }
          }
        }
        
        // Load all requested plugins
        const allAvailablePlugins = new Map<string, Plugin>();
        for (const p of loadedPlugins.values()) {
          allAvailablePlugins.set(p.name, p);
        }
        for (const name of pluginsToLoad) {
          if (!allAvailablePlugins.has(name)) {
            const loaded = await this.pluginLoader.loadAndPreparePlugin(name);
            if (loaded) {
              allAvailablePlugins.set(loaded.name, loaded);
            }
          }
        }
        
        // Check if we have a SQL plugin
        let haveSql = false;
        for (const n of allAvailablePlugins.keys()) {
          if (n === sqlPlugin.name || n === 'mysql') {
            haveSql = true;
            break;
          }
        }
        
        // Ensure an adapter
        if (!haveSql) {
          allAvailablePlugins.set(sqlPlugin.name, sqlPlugin as unknown as Plugin);
        }
        
        // Always include the message bus connector plugin for server agents
        allAvailablePlugins.set(messageBusConnectorPlugin.name, messageBusConnectorPlugin as unknown as Plugin);
        
        // Resolve dependencies and get final plugin list
        const finalPlugins = this.pluginLoader.resolvePluginDependencies(
          allAvailablePlugins,
          options.isTestMode
        );
        
        // Prepare the character with encrypted data
        const preparedCharacter = encryptedCharacter(character);
        
        return { character: preparedCharacter, plugins: finalPlugins };
      })
    );
    
    // Step 1: Add all agents (create them with their plugins)
    const agentIds = await this.elizaOS.addAgents(preparations.map(p => ({
      character: p.character,
      plugins: p.plugins
    })));
    
    // Step 2: Start all agents (initialize them)
    await this.elizaOS.startAgents(agentIds);
    
    // Step 3: Post-process all agents
    const runtimes: IAgentRuntime[] = [];
    for (let i = 0; i < agentIds.length; i++) {
      const runtime = this.elizaOS.getAgent(agentIds[i]);
      if (!runtime) {
        logger.error(`Failed to get runtime for agent ${preparations[i].character.name}`);
        continue;
      }
      
      // Apply settings
      const settings = await this.configManager.loadEnvConfig();
      Object.assign(runtime, { settings });
      
      // Run init callback if provided
      if (init) {
        await init(runtime);
      }
      
      // Run plugin migrations
      try {
        const migrationService = runtime.getService('database_migration');
        if (migrationService) {
          logger.info(`Running plugin migrations for ${runtime.character.name}...`);
          (migrationService as any).discoverAndRegisterPluginSchemas(preparations[i].plugins);
          await (migrationService as any).runAllPluginMigrations();
        }
      } catch (error) {
        logger.error({ error }, `Failed to run migrations for ${runtime.character.name}:`);
      }
      
      logger.log(`Started ${runtime.character.name} as ${runtime.agentId}`);
      runtimes.push(runtime);
    }
    
    return runtimes;
  }

  /**
   * Stop an agent and unregister it from the server
   */
  async stopAgent(runtime: IAgentRuntime): Promise<void> {
    // Delegate to ElizaOS
    await this.elizaOS.stopAgent(runtime.agentId);
    await runtime.close();
    logger.success(`Agent ${runtime.character.name} stopped successfully!`);
  }

  /**
   * Create an agent runtime without starting it
   */
  async createAgent(
    character: Character,
    plugins: Plugin[]
  ): Promise<IAgentRuntime> {
    character.id ??= stringToUuid(character.name);

    // Handle secrets for character configuration
    if (!this.configManager.hasCharacterSecrets(character)) {
      await this.configManager.setDefaultSecretsFromEnv(character);
    }

    const runtime = new AgentRuntime({
      character: encryptedCharacter(character),
      plugins,
      settings: await this.configManager.loadEnvConfig(),
    });

    return runtime;
  }
}