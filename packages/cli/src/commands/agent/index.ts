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
  .requiredOption('-c, --character <characters...>', 'agent character name(s), id(s), or index number(s) from list')
  .option('-j, --json', 'display agent configuration as JSON in the console')
  .option('-o, --output [file]', 'save agent config to JSON (defaults to {name}.json)')
  .option('-r, --remote-url <url>', 'URL of the remote agent runtime')
  .option('-p, --port <port>', 'Port to listen on', (val) => Number.parseInt(val))
  .action(getAgent);

agent
  .command('start')
  .alias('s')
  .description('Start agents with character profiles')
  .option('-c, --character <characters...>', 'Character name(s), file path(s), or existing agent name(s)')
  .option('--remote-character <url>', 'URL to remote character JSON file')
  .option('-r, --remote-url <url>', 'URL of the remote agent runtime')
  .option('-p, --port <port>', 'Port to listen on', (val) => Number.parseInt(val))
  .addHelpText(
    'after',
    `
Examples:
  $ elizaos agent start -c "Agent Name"              Start an existing agent by name
  $ elizaos agent start -c ./char.json               Start with a local character file
  $ elizaos agent start -c eliza                     Start with auto-resolved character file
  $ elizaos agent start -c bobby,billy               Start multiple agents
  $ elizaos agent start -c "bobby, billy"            Start multiple agents (comma-separated)
  $ elizaos agent start --remote-character https://example.com/char.json

Character file resolution:
  When using --character, the CLI will:
  1. Check if it's an absolute path or relative path that exists
  2. Search common directories: current dir, ./characters/, ./agents/, ./src/characters/, ./src/agents/
  3. If not found, recursively search the entire project directory for matching .json or .ts files
  The .json extension is optional and will be added automatically if not provided.

To create a new agent:
  $ elizaos create -t agent my-agent-name   Create a new agent using Eliza template

Required configuration:
  You must provide either --character or --remote-character
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
  .description('Stop agents')
  .option('-c, --character <characters...>', 'agent character name(s), id(s), or index number(s) from list')
  .option('--all', 'stop all running agents')
  .option('-r, --remote-url <url>', 'URL of the remote agent runtime')
  .option('-p, --port <port>', 'Port to listen on', (val) => Number.parseInt(val))
  .action(stopAgent);

agent
  .command('remove')
  .alias('rm')
  .description('Remove agents')
  .requiredOption('-c, --character <characters...>', 'agent character name(s), id(s), or index number(s) from list')
  .option('-r, --remote-url <url>', 'URL of the remote agent runtime')
  .option('-p, --port <port>', 'Port to listen on', (val) => Number.parseInt(val))
  .action(removeAgent);

agent
  .command('set')
  .description('Update agent configuration')
  .requiredOption('-c, --character <character>', 'agent character name, id, or index number from list')
  .option('--config <json>', 'agent configuration as JSON string')
  .option('-f, --file <path>', 'path to agent configuration JSON file')
  .option('-r, --remote-url <url>', 'URL of the remote agent runtime')
  .option('-p, --port <port>', 'Port to listen on', (val) => Number.parseInt(val))
  .action(setAgentConfig);

agent
  .command('clear-memories')
  .alias('clear')
  .description('Clear all memories for agents')
  .requiredOption('-c, --character <characters...>', 'agent character name(s), id(s), or index number(s) from list')
  .option('-r, --remote-url <url>', 'URL of the remote agent runtime')
  .option('-p, --port <port>', 'Port to listen on', (val) => Number.parseInt(val))
  .action(clearAgentMemories);
