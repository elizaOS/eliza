import fs from 'node:fs';
import path from 'node:path';
import { checkServer, handleError } from '@/src/utils/handle-error';
import { displayAgent } from '@/src/utils/helpers';
import { logger } from '@elizaos/core';
import type { Agent } from '@elizaos/core';
import { Command, OptionValues } from 'commander';

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
    return agents[Number(idOrNameOrIndex)].id;
  }

  // If no agent is found, throw an error
  console.error(`Agent not found: ${idOrNameOrIndex}`);
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

      process.exit(0);
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
  .option('-j, --json', 'output as JSON')
  .option('-o, --output <file>', 'output to file (default: {name}.json)')
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

      // The displayAgent function expects a character object
      displayAgent(agent, 'Agent Details');

      // check if json argument is provided
      if (opts.json) {
        const jsonPath = opts.output || path.join(process.cwd(), `${agent.name || 'agent'}.json`);
        // exclude id and status fields from the json
        const { id, createdAt, updatedAt, enabled, ...agentConfig } = agent;
        fs.writeFileSync(jsonPath, JSON.stringify(agentConfig, null, 2));
        console.log(`Saved agent configuration to ${jsonPath}`);
      }

      process.exit(0);
    } catch (error) {
      await checkServer(opts);
      handleError(error);
    }
  });

agent
  .command('start')
  .alias('s')
  .description('Start an agent')
  .option('-n, --name <n>', 'character name to start the agent with')
  .option('-j, --json <json>', 'character JSON string')
  .option('--path <path>', 'local path to character JSON file')
  .option('--remote-character <url>', 'remote URL to character JSON file')
  .action(async (options) => {
    try {
      console.debug('Starting agent start command action handler');
      console.debug('Options object:', JSON.stringify(options));
      console.debug('path option value:', options.path);
      console.debug('name option value:', options.name);
      console.debug('json option value:', options.json ? '[JSON string present]' : undefined);
      console.debug('remoteCharacter option value:', options.remoteCharacter);

      // API Endpoint: POST /agents
      const response: Response = await (async () => {
        const payload: AgentStartPayload = {};
        const headers = { 'Content-Type': 'application/json' };
        const baseUrl = getAgentsBaseUrl(options);
        console.debug(`Base URL determined: ${baseUrl}`);

        // Handle the path option first
        if (options.path) {
          console.debug('Using local path option:', options.path);
          try {
            const filePath = path.resolve(process.cwd(), options.path);
            console.debug(`Resolved file path: ${filePath}`);
            if (!fs.existsSync(filePath)) {
              throw new Error(`File not found at path: ${filePath}`);
            }
            const fileContent = fs.readFileSync(filePath, 'utf8');
            console.debug(`Read file content, size: ${fileContent.length} bytes`);
            payload.characterJson = JSON.parse(fileContent);
            console.debug('Parsed character JSON from file');
            return await fetch(baseUrl, {
              method: 'POST',
              headers,
              body: JSON.stringify(payload),
            });
          } catch (error) {
            console.error('Error reading or parsing local JSON file:', error);
            throw new Error(`Failed to read or parse local JSON file: ${error.message}`);
          }
        }

        // Then handle other options
        if (options.json) {
          console.debug('Using JSON string option');
          try {
            payload.characterJson = JSON.parse(options.json);
            console.debug('Parsed character JSON string');
            return await fetch(baseUrl, {
              method: 'POST',
              headers,
              body: JSON.stringify(payload),
            });
          } catch (error) {
            console.error('Error parsing JSON string:', error);
            throw new Error(`Failed to parse JSON string: ${error.message}`);
          }
        }

        if (options.remoteCharacter) {
          console.debug('Using remote character URL option');
          if (
            !options.remoteCharacter.startsWith('http://') &&
            !options.remoteCharacter.startsWith('https://')
          ) {
            console.error('Invalid remote URL:', options.remoteCharacter);
            throw new Error('Remote URL must start with http:// or https://');
          }
          payload.characterPath = options.remoteCharacter;
          console.debug('Using remote character URL:', payload.characterPath);
          return await fetch(baseUrl, {
            method: 'POST',
            headers,
            body: JSON.stringify(payload),
          });
        }

        if (options.name) {
          console.debug('Using name option:', options.name);
          const agentId = await resolveAgentId(options.name, options);
          console.debug(`Resolved agent ID: ${agentId} for name: ${options.name}`);
          return await fetch(`${baseUrl}/${agentId}`, {
            method: 'POST',
            headers,
          });
        }

        console.debug('No specific start option provided, starting default agent');
        // Default behavior: Start a default agent if no specific option is provided
        return await fetch(baseUrl, {
          method: 'POST',
          headers,
          body: JSON.stringify({}), // Empty body for default agent start
        });
      })();

      console.debug(`Response status: ${response.status} ${response.statusText}`);
      if (!response.ok) {
        let errorData: ApiResponse<unknown> | null = null;
        try {
          errorData = (await response.json()) as ApiResponse<unknown>;
          console.debug('Received error data from server:', errorData);
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
      console.debug('Received successful response data:', data);
      const result = data.data;

      if (!result) {
        console.error('Server responded OK, but no agent data was returned');
        throw new Error('Failed to start agent: No data returned from server');
      }
      console.debug('Agent start successful, result:', result);

      // Correctly access the agent name from the nested character object
      const agentName = result?.character?.name || 'unknown';
      console.debug(`Successfully started agent ${agentName}`);
      logger.success(`Agent ${agentName} started successfully!`);
      console.log(`\x1b[32m✓ Agent ${agentName} started successfully!\x1b[0m`);
    } catch (error) {
      console.error('Error in agent start command:', error);
      await checkServer(options);
      handleError(error);
    }
  });

agent
  .command('stop')
  .alias('st')
  .description('Stop an agent')
  .requiredOption('-n, --name <name>', 'agent id, name, or index number from list')
  .action(async (opts) => {
    try {
      const resolvedAgentId = await resolveAgentId(opts.name, opts);
      const baseUrl = getAgentsBaseUrl(opts);

      console.info(`Stopping agent ${resolvedAgentId}`);

      // API Endpoint: PUT /agents/:agentId (not /agents/:agentId/stop)
      const response = await fetch(`${baseUrl}/${resolvedAgentId}`, { method: 'PUT' });

      if (!response.ok) {
        const errorData = (await response.json()) as ApiResponse<unknown>;
        throw new Error(errorData.error?.message || `Failed to stop agent: ${response.statusText}`);
      }

      logger.success(`Successfully stopped agent ${opts.name}`);
      // Add direct console log for higher visibility
      console.log(`\x1b[32m✓ Agent ${opts.name} stopped successfully!\x1b[0m`);
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
      process.exit(0);
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
