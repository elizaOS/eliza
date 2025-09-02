import {
  AgentRuntime,
  encryptedCharacter,
  logger,
  stringToUuid,
  type Character,
  type IAgentRuntime,
  type Plugin,
} from '@elizaos/core';
import { plugin as sqlPlugin } from '@elizaos/plugin-sql';
import type { AgentServer } from '../index';
import { PluginLoader } from './PluginLoader';
import { ConfigManager } from './ConfigManager';

export interface AgentStartOptions {
  isTestMode?: boolean;
}

/**
 * Manages agent lifecycle operations
 */
export class AgentManager {
  private server: AgentServer;
  private pluginLoader: PluginLoader;
  private configManager: ConfigManager;

  constructor(server: AgentServer) {
    this.server = server;
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

    const runtime = new AgentRuntime({
      character: encryptedCharacter(character),
      plugins: finalPlugins,
      settings: await this.configManager.loadEnvConfig(),
    });

    const initWrapper = async (runtime: IAgentRuntime) => {
      if (init) {
        await init(runtime);
      }
    };

    await initWrapper(runtime);
    await runtime.initialize();

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

    this.server.registerAgent(runtime);
    logger.log(`Started ${runtime.character.name} as ${runtime.agentId}`);
    return runtime;
  }

  /**
   * Stop an agent and unregister it from the server
   */
  async stopAgent(runtime: IAgentRuntime): Promise<void> {
    await runtime.close();
    this.server.unregisterAgent(runtime.agentId);
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