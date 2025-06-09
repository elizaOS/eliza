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
import { validatePort } from '@/src/utils/port-validation';
import { plugin as sqlPlugin } from '@elizaos/plugin-sql';
import dotenv from 'dotenv';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function isValidPluginShape(obj: any): obj is Plugin {
  if (!obj || typeof obj !== 'object' || !obj.name) {
    return false;
  }
  return !!(
    obj.init ||
    obj.services ||
    obj.providers ||
    obj.actions ||
    obj.evaluators ||
    obj.description
  );
}

async function loadAndPreparePlugin(pluginName: string): Promise<Plugin | null> {
  const version = getCliInstallTag();
  let pluginModule: any;
  const context = detectPluginContext(pluginName);

  if (context.isLocalDevelopment) {
    try {
      pluginModule = await loadPluginModule(pluginName);
      if (!pluginModule) {
        logger.error(`Failed to load local plugin ${pluginName}.`);
        provideLocalPluginGuidance(pluginName, context);
        return null;
      }
    } catch (error) {
      logger.error(`Error loading local plugin ${pluginName}: ${error}`);
      provideLocalPluginGuidance(pluginName, context);
      return null;
    }
  } else {
    try {
      pluginModule = await loadPluginModule(pluginName);
      if (!pluginModule) {
        logger.info(`Plugin ${pluginName} not available, installing...`);
        await installPlugin(pluginName, process.cwd(), version);
        pluginModule = await loadPluginModule(pluginName);
      }
    } catch (error) {
      logger.error(`Failed to process plugin ${pluginName}: ${error}`);
      return null;
    }
  }

  if (!pluginModule) {
    logger.error(`Failed to load module for plugin ${pluginName}.`);
    return null;
  }

  const expectedFunctionName = `${pluginName
    .replace(/^@elizaos\/plugin-/, '')
    .replace(/^@elizaos\//, '')
    .replace(/-./g, (match) => match[1].toUpperCase())}Plugin`;

  const exportsToCheck = [
    pluginModule[expectedFunctionName],
    pluginModule.default,
    ...Object.values(pluginModule),
  ];

  for (const potentialPlugin of exportsToCheck) {
    if (isValidPluginShape(potentialPlugin)) {
      return potentialPlugin as Plugin;
    }
  }

  logger.warn(`Could not find a valid plugin export in ${pluginName}.`);
  return null;
}

export async function startAgent(
  character: Character,
  server: AgentServer,
  init?: (runtime: IAgentRuntime) => Promise<void>,
  plugins: (Plugin | string)[] = [],
  options: { isTestMode?: boolean } = {}
): Promise<IAgentRuntime> {
  character.id ??= stringToUuid(character.name);

  const loadedPlugins = new Map<string, Plugin>();
  loadedPlugins.set(sqlPlugin.name, sqlPlugin); // Always include sqlPlugin

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

  const resolutionOrder: string[] = [];
  const visited = new Set<string>();
  const visiting = new Set<string>();

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

  function visit(pluginName: string) {
    if (!allAvailablePlugins.has(pluginName)) {
      logger.warn(`Plugin dependency "${pluginName}" not found and will be skipped.`);
      return;
    }
    if (visited.has(pluginName)) return;
    if (visiting.has(pluginName)) {
      logger.error(`Circular dependency detected involving plugin: ${pluginName}`);
      return;
    }

    visiting.add(pluginName);
    const plugin = allAvailablePlugins.get(pluginName);
    if (plugin) {
      const deps = [...(plugin.dependencies || [])];
      if (options.isTestMode) {
        deps.push(...(plugin.testDependencies || []));
      }
      for (const dep of deps) {
        visit(dep);
      }
    }
    visiting.delete(pluginName);
    visited.add(pluginName);
    resolutionOrder.push(pluginName);
  }

  for (const name of allAvailablePlugins.keys()) {
    if (!visited.has(name)) {
      visit(name);
    }
  }

  const finalPlugins = resolutionOrder
    .map((name) => allAvailablePlugins.get(name))
    .filter((p) => p) as Plugin[];

  logger.info(`Final plugins being loaded: ${finalPlugins.map((p) => p.name).join(', ')}`);

  const runtime = new AgentRuntime({
    character: encryptedCharacter(character),
    plugins: finalPlugins,
    settings: await loadEnvConfig(),
  });

  // Pass the server's database adapter to the runtime before plugin initialization
  const initWrapper = async (runtime: IAgentRuntime) => {
    // Register the server's database adapter with the runtime
    runtime.registerDatabaseAdapter(server.database);
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

async function stopAgent(runtime: IAgentRuntime, server: AgentServer) {
  await runtime.close();
  server.unregisterAgent(runtime.agentId);
  logger.success(`Agent ${runtime.character.name} stopped successfully!`);
}

async function startAgents(options: {
  configure?: boolean;
  port?: number;
  characters?: Character[];
}) {
  const postgresUrl = await configureDatabaseSettings(options.configure);
  if (postgresUrl) process.env.POSTGRES_URL = postgresUrl;
  const pgliteDataDir = postgresUrl ? undefined : await resolvePgliteDir();

  const server = new AgentServer();
  await server.initialize({ dataDir: pgliteDataDir, postgresUrl });

  server.startAgent = (character) => startAgent(character, server);
  server.stopAgent = (runtime) => stopAgent(runtime, server);
  server.loadCharacterTryPath = loadCharacterTryPath;
  server.jsonToCharacter = jsonToCharacter;

  const desiredPort = options.port || Number.parseInt(process.env.SERVER_PORT || '3000');
  const serverPort = await findNextAvailablePort(desiredPort);
  if (serverPort !== desiredPort) {
    logger.warn(`Port ${desiredPort} is in use, using port ${serverPort} instead`);
  }
  process.env.SERVER_PORT = serverPort.toString();
  server.start(serverPort);

  if (options.characters && options.characters.length > 0) {
    for (const character of options.characters) {
      await startAgent(character, server);
    }
  } else {
    const elizaCharacter = getElizaCharacter();
    await startAgent(elizaCharacter, server);
  }
}

async function loadEnvConfig(): Promise<RuntimeSettings> {
  const envInfo = await UserEnvironment.getInstanceInfo();
  if (envInfo.paths.envFilePath) {
    dotenv.config({ path: envInfo.paths.envFilePath });
  }
  return process.env as RuntimeSettings;
}

export const start = new Command()
  .name('start')
  .description('Start the Eliza agent server')
  .option('-c, --configure', 'Reconfigure services and AI models')
  .option('-p, --port <port>', 'Port to listen on', validatePort)
  .option('-char, --character [paths...]', 'Character file(s) to use')
  .hook('preAction', async () => {
    await displayBanner();
  })
  .action(async (options) => {
    try {
      let characters: Character[] = [];
      if (options.character) {
        for (const path of options.character) {
          try {
            characters.push(await loadCharacterTryPath(path));
          } catch (e) {
            logger.error(`Failed to load character from ${path}:`, e);
          }
        }
      }
      await startAgents({ ...options, characters });
    } catch (e: any) {
      handleError(e);
    }
  });
