import { loadProject } from '@/src/project';
import { displayBanner, handleError } from '@/src/utils';
import { buildProject } from '@/src/utils/build-project';
import { ensureElizaOSCli } from '@/src/utils/dependency-manager';
import { detectDirectoryType } from '@/src/utils/directory-detection';
import { getModuleLoader } from '@/src/utils/module-loader';
import { validatePort } from '@/src/utils/port-validation';
import { logger, type Character, type ProjectAgent, type IAgentRuntime } from '@elizaos/core';
import { Command } from 'commander';
import dotenv from 'dotenv';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { StartOptions } from './types';
import { UserEnvironment } from '@/src/utils/user-environment';

export const start = new Command()
  .name('start')
  .description('Build and start the Eliza agent server')
  .option('-c, --configure', 'Reconfigure services and AI models')
  .option('-p, --port <port>', 'Port to listen on', validatePort)
  .option('--character <paths...>', 'Character file(s) to use')
  .hook('preAction', async () => {
    await displayBanner();
  })
  .action(async (options: StartOptions & { character?: string[] }) => {
    try {
      // Load env config first before any character loading
      // Use monorepo-aware resolver so root .env is found when running via turbo
      try {
        const userEnv = UserEnvironment.getInstance();
        const { envFilePath } = await userEnv.getPathInfo();
        const candidateEnv = envFilePath || path.join(process.cwd(), '.env');
        if (fs.existsSync(candidateEnv)) {
          dotenv.config({ path: candidateEnv });
        }
      } catch {
        // Fallback to CWD-based .env if resolution fails
        const envPath = path.join(process.cwd(), '.env');
        if (fs.existsSync(envPath)) {
          dotenv.config({ path: envPath });
        }
      }

      // Auto-install @elizaos/cli as dev dependency using bun (for non-monorepo projects)
      await ensureElizaOSCli();

      // Setup proper module resolution environment variables
      // This ensures consistent plugin loading between dev and start commands
      const localModulesPath = path.join(process.cwd(), 'node_modules');
      if (process.env.NODE_PATH) {
        process.env.NODE_PATH = `${localModulesPath}${path.delimiter}${process.env.NODE_PATH}`;
      } else {
        process.env.NODE_PATH = localModulesPath;
      }

      // Add local .bin to PATH to prioritize local executables
      const localBinPath = path.join(process.cwd(), 'node_modules', '.bin');
      if (process.env.PATH) {
        process.env.PATH = `${localBinPath}${path.delimiter}${process.env.PATH}`;
      } else {
        process.env.PATH = localBinPath;
      }

      // Force Node runtime for PGlite when running the server via CLI
      if (!process.env.PGLITE_WASM_MODE) {
        process.env.PGLITE_WASM_MODE = 'node';
      }

      // Build the project first (unless it's a monorepo)
      const cwd = process.cwd();
      const dirInfo = detectDirectoryType(cwd);
      const isMonorepo = dirInfo.type === 'elizaos-monorepo';

      if (!isMonorepo && !process.env.ELIZA_TEST_MODE) {
        try {
          // Use buildProject function with proper UI feedback and error handling
          await buildProject(cwd, false);
        } catch (error) {
          logger.error('Build error:', error instanceof Error ? error.message : String(error));
          logger.warn(
            'Build failed, but continuing with start. Some features may not work correctly.'
          );
        }
      }

      let characters: Character[] = [];
      let projectAgents: ProjectAgent[] = [];

      if (options.character && options.character.length > 0) {
        // Load @elizaos/server module for character loading
        const moduleLoader = getModuleLoader();
        const serverModule = await moduleLoader.load('@elizaos/server');
        const { loadCharacterTryPath } = serverModule;

        // Validate and load characters from provided paths
        for (const charPath of options.character) {
          const resolvedPath = path.resolve(charPath);

          if (!fs.existsSync(resolvedPath)) {
            logger.error(`Character file not found: ${resolvedPath}`);
            throw new Error(`Character file not found: ${resolvedPath}`);
          }

          try {
            const character = await loadCharacterTryPath(resolvedPath);
            if (character) {
              characters.push(character);
              logger.info(`Successfully loaded character: ${character.name}`);
            } else {
              logger.error(
                `Failed to load character from ${resolvedPath}: Invalid or empty character file`
              );
              throw new Error(`Invalid character file: ${resolvedPath}`);
            }
          } catch (e) {
            logger.error({ error: e, resolvedPath }, `Failed to load character from path:`);
            throw new Error(`Invalid character file: ${resolvedPath}`);
          }
        }
      } else {
        // Try to load project agents if no character files specified
        try {
          const cwd = process.cwd();
          const dirInfo = detectDirectoryType(cwd);

          // Check if we're in a directory that might contain agents - allow any directory with package.json
          // except those explicitly detected as non-ElizaOS (covers projects, plugins, monorepos, etc.)
          if (dirInfo.hasPackageJson && dirInfo.type !== 'non-elizaos-dir') {
            logger.info('No character files specified, attempting to load project agents...');
            const project = await loadProject(cwd);

            if (project.agents && project.agents.length > 0) {
              logger.info(`Found ${project.agents.length} agent(s) in project configuration`);
              projectAgents = project.agents;

              // Log loaded agent names
              for (const agent of project.agents) {
                if (agent.character) {
                  logger.info(`Loaded character: ${agent.character.name}`);
                }
              }
            }
          }
        } catch (e) {
          logger.debug({ error: e }, 'Failed to load project agents, will use default character:');
        }
      }

      // Use AgentServer from server package
      const moduleLoader = getModuleLoader();
      const { AgentServer } = await moduleLoader.load('@elizaos/server');

      const server = new AgentServer();

      // Initialize server with database configuration
      await server.initialize({
        dataDir: process.env.PGLITE_DATA_DIR,
        postgresUrl: process.env.POSTGRES_URL,
      });

      // Start HTTP server with robust port resolution
      let port: number;
      if (options.port !== undefined) {
        // Already validated by Commander using validatePort
        port = options.port;
      } else {
        const envPort = process.env.SERVER_PORT;
        if (envPort) {
          try {
            port = validatePort(envPort);
          } catch {
            logger.warn(`Invalid SERVER_PORT "${envPort}", falling back to 3000`);
            port = 3000;
          }
        } else {
          port = 3000;
        }
      }
      await server.start(port);

      // Handle project agents with their init functions
      if (projectAgents && projectAgents.length > 0) {
        // Phase 1: Start all agents first (collect runtimes)
        const runtimes: IAgentRuntime[] = [];
        const agentRuntimeMap = new Map<ProjectAgent, IAgentRuntime>();

        for (const projectAgent of projectAgents) {
          try {
            // Validate and safely access the agent's plugins array
            const agentPlugins = Array.isArray(projectAgent.plugins) ? projectAgent.plugins : [];

            const [runtime] = await server.startAgents([projectAgent.character], agentPlugins);

            if (runtime) {
              runtimes.push(runtime);
              agentRuntimeMap.set(projectAgent, runtime);
              logger.info(
                `Started agent: ${projectAgent.character.name || 'Unnamed'} (${runtime.agentId})`
              );
            } else {
              logger.error(
                `Failed to start agent: ${projectAgent.character.name || 'Unnamed'} - runtime is undefined`
              );
            }
          } catch (error) {
            logger.error(
              {
                error,
                characterName: projectAgent.character.name || 'Unnamed',
              },
              'Failed to start project agent'
            );
            // Continue with other agents even if one fails
          }
        }

        logger.info(`Started ${runtimes.length}/${projectAgents.length} project agents`);

        // Phase 2: Run all init functions after all agents have started
        // This ensures init functions can discover/communicate with all other agents
        for (const projectAgent of projectAgents) {
          const runtime = agentRuntimeMap.get(projectAgent);
          if (runtime && typeof projectAgent.init === 'function') {
            try {
              logger.info(
                `Running init function for agent: ${projectAgent.character.name || 'Unnamed'}`
              );
              await projectAgent.init(runtime);
            } catch (error) {
              logger.error(
                {
                  error,
                  characterName: projectAgent.character.name || 'Unnamed',
                  agentId: runtime.agentId,
                },
                'Agent init function failed'
              );
              // Continue with other init functions even if one fails
            }
          }
        }

        logger.info('All agent init functions completed');
      }
      // Handle standalone characters from CLI
      else if (characters && characters.length > 0) {
        // Batch start all characters
        const runtimes = await server.startAgents(characters);
        logger.info(`Started ${runtimes.length} agents`);
      }
      // If no characters or agents specified, server is ready but no agents started
    } catch (e: any) {
      handleError(e);
      process.exit(1);
    }
  });

// Export types only
export * from './types';
