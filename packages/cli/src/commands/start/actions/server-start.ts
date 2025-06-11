import { getElizaCharacter } from '@/src/characters/eliza';
import { AgentServer } from '@/src/server/index';
import { jsonToCharacter, loadCharacterTryPath } from '@/src/server/loader';
import { configureDatabaseSettings, findNextAvailablePort, resolvePgliteDir } from '@/src/utils';
import { logger, type Character, type ProjectAgent } from '@elizaos/core';
import { startAgent, stopAgent } from './agent-start';

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
