import { loadProject } from '@/src/project';
import { displayBanner, handleError } from '@/src/utils';
import { buildProject } from '@/src/utils/build-project';
import { ensureElizaOSCli } from '@/src/utils/dependency-manager';
import { detectDirectoryType } from '@/src/utils/directory-detection';
import {
  scanPluginsForEnvDeclarations,
  warnAboutMissingDeclarations,
} from '@/src/utils/plugin-env-filter';
import {
  logger,
  type Character,
  type ProjectAgent,
  loadEnvFilesWithPrecedence,
  setAllowedEnvVars,
} from '@elizaos/core';
import { AgentServer, loadCharacterTryPath } from '@elizaos/server';
import { Command, InvalidOptionArgumentError } from 'commander';
import * as path from 'node:path';
import { StartOptions } from './types';
import { UserEnvironment } from '@/src/utils/user-environment';

export const start = new Command()
  .name('start')
  .description('Build and start the Eliza agent server')
  .option('-c, --configure', 'Reconfigure services and AI models')
  .option('-p, --port <port>', 'Port to listen on', (value: string) => {
    const n = Number.parseInt(value, 10);
    if (!Number.isInteger(n) || n < 1 || n > 65535) {
      throw new InvalidOptionArgumentError('Port must be an integer between 1 and 65535');
    }
    return n;
  })
  .option('--character <paths...>', 'Character file(s) to use')
  .hook('preAction', async () => {
    await displayBanner();
  })
  .action(async (options: StartOptions & { character?: string[] }) => {
    try {
      const cwd = process.cwd();

      // Scan plugins for env var declarations and set filter to prevent shell leakage
      const pluginScanResult = scanPluginsForEnvDeclarations(cwd);
      setAllowedEnvVars(pluginScanResult.allowedVars);

      logger.debug(
        {
          src: 'cli',
          command: 'start',
          allowedVars: pluginScanResult.allowedVars.size,
          pluginsWithDeclarations: pluginScanResult.pluginsWithDeclarations.length,
        },
        'Plugin env var scan complete'
      );

      warnAboutMissingDeclarations(pluginScanResult.pluginsWithoutDeclarations, {
        logLevel: 'debug',
      });

      // Load .env files with precedence (closest wins)
      try {
        const userEnv = UserEnvironment.getInstance();
        const { monorepoRoot } = await userEnv.getPathInfo();

        const loadedEnvFiles = loadEnvFilesWithPrecedence(cwd, {
          boundaryDir: monorepoRoot || undefined,
        });

        if (loadedEnvFiles.length > 0) {
          logger.debug(
            { src: 'cli', command: 'start', files: loadedEnvFiles },
            `Loaded ${loadedEnvFiles.length} .env file(s) with precedence`
          );
        }
      } catch {
        loadEnvFilesWithPrecedence(cwd);
      }

      await ensureElizaOSCli();

      // Setup module resolution paths - reuse cwd instead of calling process.cwd() again
      const localModulesPath = path.join(cwd, 'node_modules');
      process.env.NODE_PATH = process.env.NODE_PATH
        ? `${localModulesPath}${path.delimiter}${process.env.NODE_PATH}`
        : localModulesPath;

      const localBinPath = path.join(cwd, 'node_modules', '.bin');
      process.env.PATH = process.env.PATH
        ? `${localBinPath}${path.delimiter}${process.env.PATH}`
        : localBinPath;

      if (!process.env.PGLITE_WASM_MODE) {
        process.env.PGLITE_WASM_MODE = 'node';
      }

      const dirInfo = detectDirectoryType(cwd);
      const isMonorepo = dirInfo.type === 'elizaos-monorepo';

      if (!isMonorepo && !process.env.ELIZA_TEST_MODE) {
        try {
          // Use buildProject function with proper UI feedback and error handling
          await buildProject(cwd, false);
        } catch (error) {
          logger.error(
            {
              src: 'cli',
              command: 'start',
              error: error instanceof Error ? error.message : String(error),
            },
            'Build failed'
          );
          logger.warn({ src: 'cli', command: 'start' }, 'Build failed, continuing with start');
        }
      }

      const characters: Character[] = [];
      let projectAgents: ProjectAgent[] = [];

      if (options.character?.length) {
        for (const charPath of options.character) {
          const resolvedPath = path.resolve(charPath);

          // loadCharacterTryPath handles missing files - no need for separate existsSync check
          try {
            const character = await loadCharacterTryPath(resolvedPath);
            if (!character) {
              logger.error(
                { src: 'cli', command: 'start', path: resolvedPath },
                'Invalid or empty character file'
              );
              throw new Error(`Invalid character file: ${resolvedPath}`);
            }
            characters.push(character);
            logger.info(
              { src: 'cli', command: 'start', characterName: character.name },
              'Character loaded'
            );
          } catch (e) {
            logger.error(
              { src: 'cli', command: 'start', error: e, path: resolvedPath },
              'Failed to load character'
            );
            throw new Error(`Invalid character file: ${resolvedPath}`);
          }
        }
      } else if (dirInfo.hasPackageJson && dirInfo.type !== 'non-elizaos-dir') {
        try {
          logger.info({ src: 'cli', command: 'start' }, 'Loading project agents');
          const project = await loadProject(cwd);

          if (project.agents?.length) {
            logger.info(
              { src: 'cli', command: 'start', agentCount: project.agents.length },
              'Found project agents'
            );
            projectAgents = project.agents;

            for (const agent of project.agents) {
              if (agent.character) {
                logger.info(
                  { src: 'cli', command: 'start', characterName: agent.character.name },
                  'Character loaded'
                );
              }
            }
          }
        } catch (e) {
          logger.debug(
            { src: 'cli', command: 'start', error: e },
            'Failed to load project agents, using default'
          );
        }
      }

      const agentConfigs = projectAgents.length
        ? projectAgents.map((pa) => ({
            character: pa.character,
            plugins: Array.isArray(pa.plugins) ? pa.plugins : [],
            init: pa.init,
          }))
        : characters.map((character) => ({ character }));

      const server = new AgentServer();
      await server.start({
        port: options.port,
        dataDir: process.env.PGLITE_DATA_DIR,
        postgresUrl: process.env.POSTGRES_URL,
        agents: agentConfigs,
      });

      logger.success(
        { src: 'cli', command: 'start', agentCount: agentConfigs.length },
        'Server started'
      );
    } catch (e: unknown) {
      handleError(e);
      process.exit(1);
    }
  });

// Export types only
export * from './types';
