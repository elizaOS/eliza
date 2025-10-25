/**
 * Containers Command - Manage cloud container deployments
 */

import { Command } from 'commander';
import { listContainersAction } from './actions/list';
import { deleteContainerAction } from './actions/delete';
import { getContainerLogsAction } from './actions/logs';

export const containers = new Command()
  .name('containers')
  .description('Manage ElizaOS cloud container deployments')
  .action(() => {
    // Show help automatically if no subcommand is specified
    containers.help();
  });

// List containers
containers
  .command('list')
  .alias('ls')
  .description('List all container deployments')
  .option('-u, --api-url <url>', 'ElizaOS Cloud API URL', 'https://www.elizacloud.ai')
  .option('-k, --api-key <key>', 'ElizaOS Cloud API key')
  .option('--json', 'Output as JSON')
  .action(listContainersAction);

// Delete container
containers
  .command('delete [container-id]')
  .alias('rm')
  .description('Delete a container deployment (auto-detects project if container-id omitted)')
  .option('-u, --api-url <url>', 'ElizaOS Cloud API URL', 'https://www.elizacloud.ai')
  .option('-k, --api-key <key>', 'ElizaOS Cloud API key')
  .option('-p, --project-name <name>', 'Project name to find container (overrides auto-detection)')
  .option('--force', 'Skip confirmation prompt')
  .action(deleteContainerAction);

// Get container logs
containers
  .command('logs [container-id]')
  .description(
    'Get logs from a container deployment (auto-detects project if container-id omitted)'
  )
  .option('-u, --api-url <url>', 'ElizaOS Cloud API URL', 'https://www.elizacloud.ai')
  .option('-k, --api-key <key>', 'ElizaOS Cloud API key')
  .option('-p, --project-name <name>', 'Project name to find container (overrides auto-detection)')
  .option('--follow', 'Follow log output')
  .option('--tail <lines>', 'Number of lines to show from end', '100')
  .action(getContainerLogsAction);

export * from './types';
