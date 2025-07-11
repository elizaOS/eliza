import { displayBanner, handleError } from '@/src/utils';
import { Command } from 'commander';
import { stopAgents } from './actions/stop-agents';
import { StopOptions } from './types';

export const stop = new Command()
    .name('stop')
    .description('Stop running ElizaOS agents and services')
    .option('--all', 'Stop all running ElizaOS processes')
    .option('--agent <name>', 'Stop a specific agent by name')
    .option('--force', 'Force stop without graceful shutdown')
    .option('--quiet', 'Suppress confirmation messages')
    .hook('preAction', async () => {
        await displayBanner();
    })
    .action(async (options: StopOptions) => {
        try {
            await stopAgents(options);
        } catch (e: any) {
            handleError(e);
            process.exit(1);
        }
    });

// Re-export types and actions
export * from './actions/stop-agents';
export * from './types';
