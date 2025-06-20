import { Command } from 'commander';
import {
  clearAgentMemories,
  getAgent,
  removeAgent,
  setAgentConfig,
  startAgent,
  stopAgent,
} from './actions';
import { listAgents, getAgents, resolveAgentId } from './utils';

// Export utilities for backward compatibility
export { getAgents, resolveAgentId };
export { getAgentRuntimeUrl, getAgentsBaseUrl } from '../shared';

export const agent = new Command().name('agent').description('Manage ElizaOS agents');

agent
  .command('list')
  .alias('ls')
  .description('List available agents')
  .option('-j, --json', 'output as JSON')
  .option('-r, --remote-url <url>', 'URL of the remote agent runtime')
  .option('-p, --port <port>', 'Port to listen on', (val) => Number.parseInt(val))
  .action(listAgents);

agent
  .command('get')
  .alias('g')
  .description('Get agent details')
  .requiredOption('-n, --name <name>', 'agent id, name, or index number from list')
  .option('-j, --json', 'display agent configuration as JSON in the console')
  .option('-o, --output [file]', 'save agent config to JSON (defaults to {name}.json)')
  .option('-r, --remote-url <url>', 'URL of the remote agent runtime')
  .option('-p, --port <port>', 'Port to listen on', (val) => Number.parseInt(val))
  .action(getAgent);

agent
  .command('start')
  .alias('s')
  .description('Start an agent with a character profile')
  .option('-n, --name <name>', 'Name of an existing agent to start')
  .option('--path <path>', 'Path to local character JSON file')
  .option('--remote-character <url>', 'URL to remote character JSON file')
  .option('-r, --remote-url <url>', 'URL of the remote agent runtime')
  .option('-p, --port <port>', 'Port to listen on', (val) => Number.parseInt(val))
  .addHelpText(
    'after',
    `
Examples:
  $ elizaos agent start -n "Agent Name"     Start an existing agent by name
  $ elizaos agent start --path ./char.json  Start with a local character file
  $ elizaos agent start --remote-character https://example.com/char.json

To create a new agent:
  $ elizaos create -t agent my-agent-name   Create a new agent using Eliza template

Required configuration:
  You must provide one of these options: --name, --path, or --remote-character
`
  )
  .action(async (options) => {
    try {
      await startAgent(options);
    } catch (error) {
      if (error instanceof Error) {
        const errorMsg = error.message;

        if (errorMsg === 'MISSING_CHARACTER_CONFIG') {
          // Use commander's built-in help
          const cmd = agent.commands.find((cmd) => cmd.name() === 'start');
          cmd?.help();
          process.exit(1);
        } else if (errorMsg === 'AGENT_NOT_FOUND_WITH_HELP') {
          // Use commander's built-in help
          const cmd = agent.commands.find((cmd) => cmd.name() === 'start');
          cmd?.help();
          process.exit(1);
        }
      }
      // Let other errors bubble up
      throw error;
    }
  });

agent
  .command('stop')
  .alias('st')
  .description('Stop an agent')
  .option('-n, --name <name>', 'agent id, name, or index number from list')
  .option('--all', 'stop all running agents')
  .option('-r, --remote-url <url>', 'URL of the remote agent runtime')
  .option('-p, --port <port>', 'Port to listen on', (val) => Number.parseInt(val))
  .action(stopAgent);

agent
  .command('remove')
  .alias('rm')
  .description('Remove an agent')
  .requiredOption('-n, --name <name>', 'agent id, name, or index number from list')
  .option('-r, --remote-url <url>', 'URL of the remote agent runtime')
  .option('-p, --port <port>', 'Port to listen on', (val) => Number.parseInt(val))
  .action(removeAgent);

agent
  .command('set')
  .description('Update agent configuration')
  .requiredOption('-n, --name <name>', 'agent id, name, or index number from list')
  .option('-c, --config <json>', 'agent configuration as JSON string')
  .option('-f, --file <path>', 'path to agent configuration JSON file')
  .option('-r, --remote-url <url>', 'URL of the remote agent runtime')
  .option('-p, --port <port>', 'Port to listen on', (val) => Number.parseInt(val))
  .action(setAgentConfig);

agent
  .command('clear-memories')
  .alias('clear')
  .description('Clear all memories for an agent')
  .requiredOption('-n, --name <name>', 'agent id, name, or index number from list')
  .option('-r, --remote-url <url>', 'URL of the remote agent runtime')
  .option('-p, --port <port>', 'Port to listen on', (val) => Number.parseInt(val))
  .action(clearAgentMemories);
