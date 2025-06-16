import { displayBanner, handleError } from '@/src/utils';
import { validatePort } from '@/src/utils/port-validation';
import { loadCharacterTryPath } from '@elizaos/server';
import { loadProject } from '@/src/project';
import { logger, type Character, type ProjectAgent } from '@elizaos/core';
import { Command } from 'commander';
import { startAgents } from './actions/server-start';
import { StartOptions } from './types';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { loadEnvConfig } from './utils/config-utils';

export const start = new Command()
  .name('start')
  .description('Start the Eliza agent server')
  .option('-c, --configure', 'Reconfigure services and AI models')
  .option('-p, --port <port>', 'Port to listen on', validatePort)
  .option('--character <paths...>', 'Character file(s) to use')
  .hook('preAction', async () => {
    await displayBanner();
  })
  .action(async (options: StartOptions & { character?: string[] }) => {
    try {
      // Load env config first before any character loading
      await loadEnvConfig();

      let characters: Character[] = [];
      let projectAgents: ProjectAgent[] = [];

      if (options.character && options.character.length > 0) {
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
              logger.error(`Failed to load character from ${resolvedPath}: Invalid or empty character file`);
              throw new Error(`Invalid character file: ${resolvedPath}`);
            }
          } catch (e) {
            logger.error(`Failed to load character from ${resolvedPath}:`, e);
            throw new Error(`Invalid character file: ${resolvedPath}`);
          }
        }
      } else {
        // Try to load project agents if no character files specified
        try {
          const cwd = process.cwd();
          const packageJsonPath = path.join(cwd, 'package.json');

          // Check if we're in a project directory
          if (fs.existsSync(packageJsonPath)) {
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
          logger.debug('Failed to load project agents, will use default character:', e);
        }
      }

      await startAgents({ ...options, characters, projectAgents });
    } catch (e: any) {
      handleError(e);
      process.exit(1);
    }
  });

// Re-export for backward compatibility
export * from './actions/agent-start';
export * from './actions/server-start';
export * from './types';
export * from './utils/config-utils';
export * from './utils/dependency-resolver';
export * from './utils/plugin-utils';
