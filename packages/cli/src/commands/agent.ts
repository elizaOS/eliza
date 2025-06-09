import { checkServer, displayAgent, handleError } from '@/src/utils';
import type { Agent } from '@elizaos/core';
import { logger } from '@elizaos/core';
import { Command, OptionValues, Option } from 'commander';
import fs from 'node:fs';
import path from 'node:path';

// Helper function to determine the agent runtime URL
export function getAgentRuntimeUrl(opts: OptionValues): string {
  return (
    opts.remoteUrl?.replace(/\/$/, '') || // Use the flag if provided
    process.env.AGENT_RUNTIME_URL?.replace(/\/$/, '') || // Fallback to env var
    `http://localhost:${opts.port || process.env.SERVER_PORT || '3000'}` // Use port flag or env var, default to 3000
  );
}

// Helper function to get the agents base API URL
export function getAgentsBaseUrl(opts: OptionValues): string {
  return `${getAgentRuntimeUrl(opts)}/api/agents`;
}

// Define basic agent interface for type safety
/**
 * Defines the structure of AgentBasic interface.
 * @property {string} id - The unique identifier of the agent.
 * @property {string} name - The name of the agent.
 * @property {string} [status] - The status of the agent (optional).
 * @property {unknown} [key] - Additional properties can be added dynamically using any key.
 */
interface AgentBasic {
  id: string;
  name: string;
  status?: string;
  [key: string]: unknown;
}

/**
 * Asynchronously fetches a list of basic agent information from the server.
 * @param {OptionValues} opts - The command options potentially containing the remote URL.
 * @returns {Promise<AgentBasic[]>} A promise that resolves to an array of AgentBasic objects.
 * @throws {Error} If the fetch request fails.
 */
export async function getAgents(opts: OptionValues): Promise<AgentBasic[]> {
  const baseUrl = getAgentsBaseUrl(opts);
  const response = await fetch(baseUrl);
  if (!response.ok) {
    throw new Error(`Failed to fetch agents list: ${response.statusText}`);
  }
  return ((await response.json()) as ApiResponse<{ agents: AgentBasic[] }>).data?.agents || [];
}

// Utility function to resolve agent ID from name, index, or direct ID
/**
 * Resolves the ID of an agent based on the provided name, ID, or index.
 *
 * @param {string} idOrNameOrIndex - The name, ID, or index of the agent to resolve.
 * @param {OptionValues} opts - The command options potentially containing the remote URL.
 * @returns {Promise<string>} The resolved ID of the agent.
 * @throws {Error} If the agent is not found.
 */
async function resolveAgentId(idOrNameOrIndex: string, opts: OptionValues): Promise<string> {
  // First try to get all agents to find by name
  const agents = await getAgents(opts);

  // Try to find agent by name
  const agentByName = agents.find(
    (agent) => agent.name.toLowerCase() === idOrNameOrIndex.toLowerCase()
  );

  if (agentByName) {
    return agentByName.id;
  }

  // Try to find agent by ID
  const agentById = agents.find((agent) => agent.id === idOrNameOrIndex);

  if (agentById) {
    return agentById.id;
  }

  // Try to find agent by index
  if (!Number.isNaN(Number(idOrNameOrIndex))) {
    const indexAgent = agents[Number(idOrNameOrIndex)];
    if (indexAgent) {
      return indexAgent.id;
    }
  }

  // If no agent is found, throw a specific error type that we can catch
  throw new Error(`AGENT_NOT_FOUND:${idOrNameOrIndex}`);
}

export const agent = new Command().name('agent').description('Manage ElizaOS agents');

/**
 * Interface representing the payload sent when starting an agent.
 * @typedef {Object} AgentStartPayload
 * @property {string} [characterPath] - The path to the character.
 * @property {Record<string, unknown>} [characterJson] - The JSON representation of the character.
 */
interface AgentStartPayload {
  characterPath?: string;
  characterJson?: Record<string, unknown>;
}

/**
 * Interface for defining the structure of an API response.
 * @template T - The type of data included in the response.
 * @property {boolean} success - Flag indicating if the response was successful.
 * @property {T | undefined} data - The data returned in the response.
 * @property {Object | undefined} error - Information about any errors that occurred.
 * @property {string} error.code - The error code.
 * @property {string} error.message - A message describing the error.
 * @property {unknown | undefined} error.details - Additional details about the error.
 */
interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: {
    code: string;
    message: string;
    details?: unknown;
  };
}

agent
  .command('list')
  .alias('ls')
  .description('List available agents')
  .option('-j, --json', 'output as JSON')
  .option('-r, --remote-url <url>', 'URL of the remote agent runtime')
  .option('-p, --port <port>', 'Port to listen on', (val) => Number.parseInt(val))
  .action(async (opts) => {
    try {
      // API Endpoint: GET /agents
      const agents = await getAgents(opts);

      // Format data for table
      const agentData = agents.map((agent) => ({
        Name: agent.name,
        ID: agent.id,
        Status: agent.status || 'unknown',
      }));

      if (opts.json) {
        console.info(JSON.stringify(agentData, null, 2));
      } else {
        console.info('\nAvailable agents:');
        if (agentData.length === 0) {
          console.info('No agents found');
        } else {
          console.table(agentData);
        }
      }

      return;
    } catch (error) {
      await checkServer(opts);
      handleError(error);
    }
  });

agent
  .command('get')
  .alias('g')
  .description('Get agent details')
  .requiredOption('-n, --name <name>', 'agent id, name, or index number from list')
  .option('-j, --json', 'display agent configuration as JSON in the console')
  .option('-o, --output [file]', 'save agent config to JSON (defaults to {name}.json)')
  .option('-r, --remote-url <url>', 'URL of the remote agent runtime')
  .option('-p, --port <port>', 'Port to listen on', (val) => Number.parseInt(val))
  .action(async (opts) => {
    try {
      const resolvedAgentId = await resolveAgentId(opts.name, opts);
      const baseUrl = getAgentsBaseUrl(opts);

      console.info(`Getting agent ${resolvedAgentId}`);

      // API Endpoint: GET /agents/:agentId
      const response = await fetch(`${baseUrl}/${resolvedAgentId}`);
      if (!response.ok) {
        const errorData = (await response.json()) as ApiResponse<unknown>;
        logger.error(`Failed to get agent`);
        process.exit(1);
      }

      const { data: agent } = (await response.json()) as ApiResponse<Agent>;

      // Save to file if output option is specified - exit early
      if (opts.output !== undefined) {
        // Extract config without metadata fields
        const { id, createdAt, updatedAt, enabled, ...agentConfig } = agent;

        // Create filename with appropriate .json extension
        const filename =
          opts.output === true
            ? `${agent.name || 'agent'}.json`
            : `${String(opts.output)}${String(opts.output).endsWith('.json') ? '' : '.json'}`;

        // Save file and exit
        const jsonPath = path.resolve(process.cwd(), filename);
        fs.writeFileSync(jsonPath, JSON.stringify(agentConfig, null, 2));
        console.log(`Saved agent configuration to ${jsonPath}`);
        return;
      }

      // Display agent details if not using output option
      displayAgent(agent, 'Agent Details');

      // Display JSON if requested
      if (opts.json) {
        const { id, createdAt, updatedAt, enabled, ...agentConfig } = agent;
        console.log(JSON.stringify(agentConfig, null, 2));
      }

      return;
    } catch (error) {
      await checkServer(opts);
      handleError(error);
    }
  });

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
      // Consolidated error handling for missing/invalid inputs
      // First check if we have enough info to start an agent
      const hasValidInput =
        options.path ||
        options.remoteCharacter ||
        (options.name && options.name !== true && options.name !== '');

      if (!hasValidInput) {
        // Show error and use commander's built-in help
        console.error('\nError: No character configuration provided.');

        // Try to show available agents
        try {
          const agents = await getAgents(options);
          if (agents.length > 0) {
            console.error('\nAvailable agents in your project:');
            agents.forEach((agent, index) => {
              console.error(`  ${index}. ${agent.name}`);
            });
          }
        } catch (error) {
          await checkServer(options);
          handleError(error);
        }

        // Use commander's built-in help
        const cmd = agent.commands.find((cmd) => cmd.name() === 'start');
        cmd?.help();
        process.exit(1);
      }

      // API Endpoint: POST /agents
      const response: Response = await (async () => {
        const payload: AgentStartPayload = {};
        const headers = { 'Content-Type': 'application/json' };
        const baseUrl = getAgentsBaseUrl(options);

        let characterName = null;

        async function createCharacter(payload: any) {
          const response = await fetch(baseUrl, {
            method: 'POST',
            headers,
            body: JSON.stringify(payload),
          });

          if (!response.ok) {
            const errorText = await response.text();
            logger.error(`Server returned ${response.status}: ${errorText}`);
            return null;
          }

          const data = await response.json();

          if (!data?.data?.character?.name) {
            logger.error(`Unexpected response format:`, data);
            return null;
          }

          return data.data.character.name;
        }

        // Handle the path option first
        if (options.path) {
          try {
            const filePath = path.resolve(process.cwd(), options.path);
            if (!fs.existsSync(filePath)) {
              throw new Error(`File not found at path: ${filePath}`);
            }
            const fileContent = fs.readFileSync(filePath, 'utf8');
            payload.characterJson = JSON.parse(fileContent);
            characterName = await createCharacter(payload);
            if (!characterName) {
              logger.error('Failed to create character from file. Check server logs for details.');
            }
          } catch (error) {
            console.error('Error reading or parsing local JSON file:', error);
            throw new Error(`Failed to read or parse local JSON file: ${error.message}`);
          }
        }

        if (options.remoteCharacter) {
          if (
            !options.remoteCharacter.startsWith('http://') &&
            !options.remoteCharacter.startsWith('https://')
          ) {
            console.error('Invalid remote URL:', options.remoteCharacter);
            throw new Error('Remote URL must start with http:// or https://');
          }
          payload.characterPath = options.remoteCharacter;
          characterName = await createCharacter(payload);
          if (!characterName) {
            logger.error(
              'Failed to create character from remote URL. Check server logs for details.'
            );
          }
        }

        if (options.name) {
          characterName = options.name;
        }

        if (characterName) {
          try {
            const agentId = await resolveAgentId(characterName, options);
            return await fetch(`${baseUrl}/${agentId}/start`, {
              method: 'POST',
              headers,
            });
          } catch (error) {
            // If agent resolution fails, throw to the outer error handler
            throw error;
          }
        }

        // Default behavior: Start a default agent if no specific option is provided
        return await fetch(baseUrl, {
          method: 'POST',
          headers,
          body: JSON.stringify({}), // Empty body for default agent start
        });
      })();

      if (!response.ok) {
        let errorData: ApiResponse<unknown> | null = null;
        try {
          errorData = (await response.json()) as ApiResponse<unknown>;
        } catch (jsonError) {
          console.error('Failed to parse error response as JSON:', jsonError);
          // Use status text if JSON parsing fails
          throw new Error(`Failed to start agent: ${response.statusText}`);
        }

        throw new Error(
          errorData?.error?.message || `Failed to start agent: ${response.statusText}`
        );
      }

      // Type assertion to handle the specific structure returned by the start endpoint
      const data = (await response.json()) as ApiResponse<any>;
      const result = data.data;

      if (!result) {
        console.error('Server responded OK, but no agent data was returned');
        throw new Error('Failed to start agent: No data returned from server');
      }

      // Get agent name from the response (either directly or from nested character)
      const agentName = result.name || result?.character?.name || 'unknown';

      // Only display one success message (no need for duplicates)
      console.log(`\x1b[32m[✓] Agent ${agentName} started successfully!\x1b[0m`);
    } catch (error) {
      // Check for agent not found error or any other error
      if (error instanceof Error) {
        const errorMsg = error.message;

        // If it's an agent not found error, show helpful error message
        if (errorMsg.startsWith('AGENT_NOT_FOUND:')) {
          const agentName = errorMsg.split(':')[1];
          console.error(`\nError: No agent found with name "${agentName}"`);

          // Show available agents if possible
          try {
            const agents = await getAgents(options);
            if (agents.length > 0) {
              console.error('\nAvailable agents in your project:');
              agents.forEach((agent, index) => {
                console.error(`  ${index}. ${agent.name}`);
              });
              console.error(
                `\nYou can create a new agent with: elizaos create -t agent ${agentName.toLowerCase()}`
              );
            }
          } catch (error) {
            // Ignore errors when showing agents
          }

          // Use commander's built-in help
          const cmd = agent.commands.find((cmd) => cmd.name() === 'start');
          cmd?.help();
        } else {
          // Handle other errors
          await checkServer(options);
          handleError(error);
        }
      } else {
        await checkServer(options);
        handleError(error);
      }
      process.exit(1);
    }
  });

agent
  .command('stop')
  .alias('st')
  .description('Stop an agent')
  .requiredOption('-n, --name <name>', 'agent id, name, or index number from list')
  .option('-r, --remote-url <url>', 'URL of the remote agent runtime')
  .option('-p, --port <port>', 'Port to listen on', (val) => Number.parseInt(val))
  .action(async (opts) => {
    try {
      const resolvedAgentId = await resolveAgentId(opts.name, opts);
      const baseUrl = getAgentsBaseUrl(opts);

      console.info(`Stopping agent ${resolvedAgentId}`);

      // API Endpoint: POST /agents/:agentId/stop
      const response = await fetch(`${baseUrl}/${resolvedAgentId}/stop`, { method: 'POST' });

      if (!response.ok) {
        const errorData = (await response.json()) as ApiResponse<unknown>;
        throw new Error(errorData.error?.message || `Failed to stop agent: ${response.statusText}`);
      }

      logger.success(`Successfully stopped agent ${opts.name}`);
      // Add direct console log for higher visibility
      console.log(`Agent ${opts.name} stopped successfully!`);
    } catch (error) {
      await checkServer(opts);
      handleError(error);
    }
  });

agent
  .command('remove')
  .alias('rm')
  .description('Remove an agent')
  .requiredOption('-n, --name <name>', 'agent id, name, or index number from list')
  .option('-r, --remote-url <url>', 'URL of the remote agent runtime')
  .option('-p, --port <port>', 'Port to listen on', (val) => Number.parseInt(val))
  .action(async (opts) => {
    try {
      const resolvedAgentId = await resolveAgentId(opts.name, opts);
      const baseUrl = getAgentsBaseUrl(opts);

      console.info(`Removing agent ${resolvedAgentId}`);

      // API Endpoint: DELETE /agents/:agentId
      const response = await fetch(`${baseUrl}/${resolvedAgentId}`, {
        method: 'DELETE',
      });

      if (!response.ok) {
        const errorData = (await response.json()) as ApiResponse<unknown>;
        throw new Error(
          errorData.error?.message || `Failed to remove agent: ${response.statusText}`
        );
      }

      // Server returns 204 No Content for successful deletion, no need to parse response
      console.log(`Successfully removed agent ${opts.name}`);
      return;
    } catch (error) {
      await checkServer(opts);
      handleError(error);
    }
  });

agent
  .command('set')
  .description('Update agent configuration')
  .requiredOption('-n, --name <name>', 'agent id, name, or index number from list')
  .option('-c, --config <json>', 'agent configuration as JSON string')
  .option('-f, --file <path>', 'path to agent configuration JSON file')
  .option('-r, --remote-url <url>', 'URL of the remote agent runtime')
  .option('-p, --port <port>', 'Port to listen on', (val) => Number.parseInt(val))
  .action(async (opts) => {
    try {
      const resolvedAgentId = await resolveAgentId(opts.name, opts);

      console.info(`Updating configuration for agent ${resolvedAgentId}`);

      let config: Record<string, unknown>;
      if (opts.config) {
        try {
          config = JSON.parse(opts.config);
        } catch (error) {
          throw new Error(`Failed to parse config JSON string: ${error.message}`);
        }
      } else if (opts.file) {
        try {
          config = JSON.parse(fs.readFileSync(opts.file, 'utf8'));
        } catch (error) {
          throw new Error(`Failed to read or parse config file: ${error.message}`);
        }
      } else {
        throw new Error(
          'Please provide either a config JSON string (-c) or a config file path (-f)'
        );
      }

      // API Endpoint: PATCH /agents/:agentId
      const response = await fetch(`${getAgentsBaseUrl(opts)}/${resolvedAgentId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(config),
      });

      if (!response.ok) {
        const errorData = (await response.json()) as ApiResponse<unknown>;
        throw new Error(
          errorData.error?.message || `Failed to update agent configuration: ${response.statusText}`
        );
      }

      const data = (await response.json()) as ApiResponse<{ id: string }>;
      const result = data.data;

      console.log(`Successfully updated configuration for agent ${result?.id || resolvedAgentId}`);
    } catch (error) {
      await checkServer(opts);
      handleError(error);
    }
  });
