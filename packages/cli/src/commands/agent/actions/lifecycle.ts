import { logger } from '@elizaos/core';
import type { OptionValues } from 'commander';
import { readFileSync } from 'node:fs';
import { checkServer, handleError } from '@/src/utils';
import { resolveCharacterPath, isValidCharacterFile } from '@/src/utils/character-finder';
import { parseCharacterPaths } from '@/src/utils/character-parser';
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
    // First check if we have enough info to start agents
    const hasValidInput = options.character || options.remoteCharacter;

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

    const headers = { 'Content-Type': 'application/json' };
    const baseUrl = getAgentsBaseUrl(options);

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

    // Handle the character option for multiple characters
    if (options.character) {
      try {
        // Use character-parser to handle various path formats
        const parsedPaths = parseCharacterPaths(options.character);

        if (parsedPaths.length === 0) {
          throw new Error(`Invalid character specification: ${options.character}`);
        }

        const startedAgents: string[] = [];
        const failedAgents: string[] = [];

        for (const characterPath of parsedPaths) {
          try {
            let currentCharacterName = null;

            // Try to resolve as a character file first
            const resolvedPath = resolveCharacterPath(characterPath);

            if (resolvedPath) {
              // Validate the character file
              const isValid = await isValidCharacterFile(resolvedPath);
              if (!isValid) {
                throw new Error(`Invalid character file: ${characterPath}`);
              }

              const fileContent = readFileSync(resolvedPath, 'utf8');
              const characterPayload = { characterJson: JSON.parse(fileContent) };
              currentCharacterName = await createCharacter(characterPayload);
            } else {
              // Treat as existing agent name
              currentCharacterName = characterPath;
            }

            if (currentCharacterName) {
              // Start the agent
              const agentId = await resolveAgentId(currentCharacterName, options);
              const startResponse = await fetch(`${baseUrl}/${agentId}/start`, {
                method: 'POST',
                headers,
              });

              if (startResponse.ok) {
                startedAgents.push(currentCharacterName);
              } else {
                const errorData = await startResponse.json().catch(() => ({}));
                throw new Error(
                  errorData?.error?.message || `Failed to start agent: ${startResponse.statusText}`
                );
              }
            } else {
              throw new Error(`Failed to create/find character: ${characterPath}`);
            }
          } catch (error) {
            failedAgents.push(
              `${characterPath}: ${error instanceof Error ? error.message : String(error)}`
            );
          }
        }

        // Report results
        if (startedAgents.length > 0) {
          console.log(
            `\x1b[32m[✓] Successfully started ${startedAgents.length} agent(s): ${startedAgents.join(', ')}\x1b[0m`
          );
        }

        if (failedAgents.length > 0) {
          console.error(`\x1b[31m[✗] Failed to start ${failedAgents.length} agent(s):\x1b[0m`);
          failedAgents.forEach((error) => console.error(`  ${error}`));
        }

        // Exit early since we handled multiple characters
        return;
      } catch (error) {
        console.error('Error processing character specifications:', error);
        throw new Error(
          `Failed to process character specifications: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }

    // API Endpoint: POST /agents - Single character/remote character handling
    const response: Response = await (async () => {
      const payload: AgentStartPayload = {};
      let characterName = null;

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
    // Validate that either --character or --all is provided
    const hasValidCharacter = opts.character && opts.character.length > 0;
    if (!hasValidCharacter && !opts.all) {
      console.error('\nError: Must provide either --character <characters...> or --all flag');
      console.error('Examples:');
      console.error('  elizaos agent stop --character eliza');
      console.error('  elizaos agent stop --character bobby,billy');
      console.error('  elizaos agent stop --all');
      process.exit(1);
    }

    // If --all flag is provided, stop all local ElizaOS processes
    if (opts.all) {
      logger.info('Stopping all ElizaOS agents...');

      // Check platform compatibility
      if (process.platform === 'win32') {
        logger.error('The --all flag requires Unix-like commands (pgrep, kill).');
        logger.error('On Windows, please use WSL 2 or stop agents individually with --name.');
        logger.error('See: https://learn.microsoft.com/en-us/windows/wsl/install-manual');
        process.exit(1);
      }

      try {
        const { exec } = await import('node:child_process');
        const { promisify } = await import('node:util');
        const execAsync = promisify(exec);

        // Unix-like: Use pgrep/xargs, excluding current CLI process to prevent self-termination
        // Support both node and bun executables, and look for common ElizaOS patterns
        const patterns = [
          '(node|bun).*elizaos',
          '(node|bun).*eliza.*start',
          '(node|bun).*dist/index.js.*start',
        ];

        for (const pattern of patterns) {
          try {
            const { stdout } = await execAsync(`pgrep -f "${pattern}"`);
            const pids = stdout
              .trim()
              .split('\n')
              .filter((pid) => pid && pid !== process.pid.toString());

            if (pids.length > 0) {
              await execAsync(`echo "${pids.join(' ')}" | xargs -r kill`);
            }
          } catch (pgrepError) {
            // pgrep returns exit code 1 when no processes match, which is expected
            // Only log actual errors, not "no processes found"
          }
        }

        logger.success('All ElizaOS agents stopped successfully!');
      } catch (error) {
        logger.error(
          `Error stopping processes: ${error instanceof Error ? error.message : String(error)}`
        );
        process.exit(1);
      }
      return;
    }

    // Stop individual agents by character names/IDs
    const parsedPaths = parseCharacterPaths(opts.character);
    const baseUrl = getAgentsBaseUrl(opts);

    if (parsedPaths.length === 0) {
      throw new Error(`Invalid character specification: ${opts.character}`);
    }

    const stoppedAgents: string[] = [];
    const failedAgents: string[] = [];

    for (const characterName of parsedPaths) {
      try {
        console.info(`Stopping agent ${characterName}...`);

        const resolvedAgentId = await resolveAgentId(characterName, opts);

        // API Endpoint: POST /agents/:agentId/stop
        const response = await fetch(`${baseUrl}/${resolvedAgentId}/stop`, { method: 'POST' });

        if (!response.ok) {
          const errorData = (await response.json().catch(() => ({}))) as ApiResponse<unknown>;
          throw new Error(
            errorData.error?.message || `Failed to stop agent: ${response.statusText}`
          );
        }

        stoppedAgents.push(characterName);
      } catch (error) {
        failedAgents.push(
          `${characterName}: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }

    // Report results
    if (stoppedAgents.length > 0) {
      console.log(
        `\x1b[32m[✓] Successfully stopped ${stoppedAgents.length} agent(s): ${stoppedAgents.join(', ')}\x1b[0m`
      );
    }

    if (failedAgents.length > 0) {
      console.error(`\x1b[31m[✗] Failed to stop ${failedAgents.length} agent(s):\x1b[0m`);
      failedAgents.forEach((error) => console.error(`  ${error}`));
    }
  } catch (error) {
    await checkServer(opts);
    handleError(error);
  }
}
