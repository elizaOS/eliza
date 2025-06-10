import { displayBanner, handleError } from '@/src/utils';
import { validatePort } from '@/src/utils/port-validation';
import { loadCharacterTryPath } from '@/src/server/loader';
import { logger, type Character } from '@elizaos/core';
import { Command } from 'commander';
import { startAgents } from './actions/server-start';
import { StartOptions } from './types';

export const start = new Command()
  .name('start')
  .description('Start the Eliza agent server')
  .option('-c, --configure', 'Reconfigure services and AI models')
  .option('-p, --port <port>', 'Port to listen on', validatePort)
  .option('-char, --character [paths...]', 'Character file(s) to use')
  .hook('preAction', async () => {
    await displayBanner();
  })
  .action(async (options: StartOptions & { character?: string[] }) => {
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

// Re-export for backward compatibility
export * from './actions/agent-start';
export * from './actions/server-start';
export * from './types';
export * from './utils/config-utils';
export * from './utils/dependency-resolver';
export * from './utils/plugin-utils';