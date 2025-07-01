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
import { AgentServer } from '@elizaos/server';
import { AgentStartOptions } from '../types';
import {
  loadEnvConfig,
  hasCharacterSecrets,
  setDefaultSecretsFromEnv,
} from '../utils/config-utils';
import { resolvePluginDependencies } from '../utils/dependency-resolver';
import { isValidPluginShape, loadAndPreparePlugin } from '../utils/plugin-utils';

/**
 * Start an agent with the given configuration
 *
 * Creates and initializes an agent runtime with plugins, handles dependency resolution, runs database migrations, and registers the agent with the server.
 */
export async function startAgent(
  character: Character,
  server: AgentServer,
  init?: (runtime: IAgentRuntime) => Promise<void>,
  plugins: (Plugin | string)[] = [],
  options: AgentStartOptions = {}
): Promise<IAgentRuntime> {
  character.id ??= stringToUuid(character.name);

  // Handle secrets for character configuration
  if (!hasCharacterSecrets(character)) {
    await setDefaultSecretsFromEnv(character);
  }

  const loadedPlugins = new Map<string, Plugin>();
  // Type-cast to ensure compatibility with local types
  loadedPlugins.set(sqlPlugin.name, sqlPlugin as unknown as Plugin); // Always include sqlPlugin

  const pluginsToLoad = new Set<string>(character.plugins || []);
  for (const p of plugins) {
    if (typeof p === 'string') {
      pluginsToLoad.add(p);
    } else if (isValidPluginShape(p) && !loadedPlugins.has(p.name)) {
      loadedPlugins.set(p.name, p);
      (p.dependencies || []).forEach((dep) => pluginsToLoad.add(dep));
      if (options.isTestMode) {
        (p.testDependencies || []).forEach((dep) => pluginsToLoad.add(dep));
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
      const loaded = await loadAndPreparePlugin(name);
      if (loaded) {
        allAvailablePlugins.set(loaded.name, loaded);
      }
    }
  }

  // Resolve dependencies and get final plugin list
  const finalPlugins = resolvePluginDependencies(allAvailablePlugins, options.isTestMode);

  const runtime = new AgentRuntime({
    character: encryptedCharacter(character),
    plugins: finalPlugins,
    settings: await loadEnvConfig(),
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
    logger.error('Failed to run plugin migrations:', error);
    throw error;
  }

  server.registerAgent(runtime);
  logger.log(`Started ${runtime.character.name} as ${runtime.agentId}`);
  return runtime;
}

/**
 * Stop an agent and unregister it from the server
 */
export async function stopAgent(runtime: IAgentRuntime, server: AgentServer): Promise<void> {
  await runtime.close();
  server.unregisterAgent(runtime.agentId);
  logger.success(`Agent ${runtime.character.name} stopped successfully!`);
}
