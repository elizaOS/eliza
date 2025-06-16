import { logger } from '@elizaos/core';
import type { OptionValues } from 'commander';
import fs from 'node:fs';
import path from 'node:path';
import { checkServer, handleError } from '@/src/utils';
import type { ApiResponse } from '../../shared';
import { getAgentsBaseUrl } from '../../shared';
import type { AgentStartPayload } from '../types';
import { getAgents, resolveAgentId } from '../utils';

/**
 * Start command implementation - starts an agent with character configuration
 */
export async function startAgent(options: OptionValues): Promise<void> {
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

      throw new Error('MISSING_CHARACTER_CONFIG');
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
          throw new Error(
            `Failed to read or parse local JSON file: ${error instanceof Error ? error.message : String(error)}`
          );
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

      throw new Error(errorData?.error?.message || `Failed to start agent: ${response.statusText}`);
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

        throw new Error('AGENT_NOT_FOUND_WITH_HELP');
      } else if (errorMsg === 'MISSING_CHARACTER_CONFIG') {
        throw new Error('MISSING_CHARACTER_CONFIG');
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
}

/**
 * Stop command implementation - stops a running agent
 */
export async function stopAgent(opts: OptionValues): Promise<void> {
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
}
