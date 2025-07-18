import { getElizaCharacter } from '@/src/characters/eliza';
import { configureDatabaseSettings, findNextAvailablePort, resolvePgliteDir } from '@/src/utils';
import { getModuleLoader } from '@/src/utils/module-loader';
import { UserEnvironment } from '@/src/utils/user-environment';
import { logger, type Character, type ProjectAgent } from '@elizaos/core';
import { startAgent, stopAgent } from './agent-start';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, readFileSync } from 'node:fs';

/**
 * Server start options
 */
export interface ServerStartOptions {
  configure?: boolean;
  port?: number;
  characters?: Character[];
  projectAgents?: ProjectAgent[];
}

/**
 * Start the agents and server
 *
 * Initializes the database, creates the server instance, configures port settings, and starts the specified agents or default Eliza character.
 */
export async function startAgents(options: ServerStartOptions): Promise<void> {
  const postgresUrl = await configureDatabaseSettings(options.configure);
  if (postgresUrl) process.env.POSTGRES_URL = postgresUrl;

  const pgliteDataDir = postgresUrl ? undefined : await resolvePgliteDir();

  // Load @elizaos/server from the project's node_modules
  // Use monorepo root when available to ensure proper module resolution
  const moduleLoader = getModuleLoader();
  const serverModule = await moduleLoader.load('@elizaos/server');

  const { AgentServer, jsonToCharacter, loadCharacterTryPath } = serverModule;

  // Get the directory where the CLI is installed to find client files
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);

  // Calculate the CLI dist path more reliably
  // In development/monorepo: packages/cli/dist/commands/start/actions -> packages/cli/dist
  // In production/global: node_modules/@elizaos/cli/dist/commands/start/actions -> node_modules/@elizaos/cli/dist
  let cliDistPath = path.resolve(__dirname, '../../../');

  // Verify the path contains index.html, if not try alternative resolution
  const indexPath = path.join(cliDistPath, 'index.html');
  if (!existsSync(indexPath)) {
    // Try to find the dist directory by looking for package.json and then dist
    let currentDir = __dirname;
    while (currentDir !== path.dirname(currentDir)) {
      const packageJsonPath = path.join(currentDir, 'package.json');
      if (existsSync(packageJsonPath)) {
        try {
          const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf-8'));
          if (packageJson.name === '@elizaos/cli') {
            const distPath = path.join(currentDir, 'dist');
            if (existsSync(path.join(distPath, 'index.html'))) {
              cliDistPath = distPath;
              break;
            }
          }
        } catch {
          // Ignore parse errors
        }
      }
      currentDir = path.dirname(currentDir);
    }
  }

  const server = new AgentServer();
  await server.initialize({
    dataDir: pgliteDataDir,
    postgresUrl: postgresUrl || undefined,
  });

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
  try {
    await server.start(serverPort);
  } catch (error) {
    logger.error(`Failed to start server on port ${serverPort}:`, error);
    throw error;
  }

  // If we have project agents, start them with their init functions
  if (options.projectAgents && options.projectAgents.length > 0) {
    for (const projectAgent of options.projectAgents) {
      await startAgent(
        projectAgent.character,
        server,
        projectAgent.init,
        projectAgent.plugins || []
      );
    }
  }
  // If we have standalone characters, start them
  else if (options.characters && options.characters.length > 0) {
    for (const character of options.characters) {
      await startAgent(character, server);
    }
  }
  // Default fallback to Eliza character
  else {
    const elizaCharacter = getElizaCharacter();
    await startAgent(elizaCharacter, server);
  }
}
