import type { Agent } from '@elizaos/core';
import type { OptionValues } from 'commander';
import { writeFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { checkServer, displayAgent, handleError } from '@/src/utils';
import { parseCharacterPaths } from '@/src/utils/character-parser';
import type { ApiResponse } from '../../shared';
import { getAgentsBaseUrl } from '../../shared';
import { resolveAgentId } from '../utils';

/**
 * Get command implementation - retrieves and displays agent details
 */
export async function getAgent(opts: OptionValues): Promise<void> {
  try {
    const parsedPaths = parseCharacterPaths(opts.character);
    const baseUrl = getAgentsBaseUrl(opts);

    if (parsedPaths.length === 0) {
      throw new Error(`Invalid character specification: ${opts.character}`);
    }

    const retrievedAgents: Agent[] = [];
    const failedAgents: string[] = [];

    for (const characterName of parsedPaths) {
      try {
        console.info(`Getting agent ${characterName}...`);

        const resolvedAgentId = await resolveAgentId(characterName, opts);

        // API Endpoint: GET /agents/:agentId
        const response = await fetch(`${baseUrl}/${resolvedAgentId}`);
        if (!response.ok) {
          throw new Error(`Failed to get agent: ${response.statusText}`);
        }

        const { data: agent } = (await response.json()) as ApiResponse<Agent>;

        if (!agent) {
          throw new Error('No agent data received from server');
        }

        retrievedAgents.push(agent);
      } catch (error) {
        failedAgents.push(
          `${characterName}: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }

    // Handle output file option for multiple agents
    if (opts.output !== undefined) {
      if (retrievedAgents.length === 1) {
        // Single agent - save as before
        const agent = retrievedAgents[0];
        const { id, createdAt, updatedAt, enabled, ...agentConfig } = agent;
        const filename =
          opts.output === true
            ? `${agent.name || 'agent'}.json`
            : `${String(opts.output)}${String(opts.output).endsWith('.json') ? '' : '.json'}`;
        const jsonPath = path.resolve(process.cwd(), filename);
        writeFileSync(jsonPath, JSON.stringify(agentConfig, null, 2));
        console.log(`Saved agent configuration to ${jsonPath}`);
      } else if (retrievedAgents.length > 1) {
        // Multiple agents - save each with agent name
        for (const agent of retrievedAgents) {
          const { id, createdAt, updatedAt, enabled, ...agentConfig } = agent;
          const filename = `${agent.name || agent.id || 'agent'}.json`;
          const jsonPath = path.resolve(process.cwd(), filename);
          writeFileSync(jsonPath, JSON.stringify(agentConfig, null, 2));
          console.log(`Saved agent configuration to ${jsonPath}`);
        }
      }
      return;
    }

    // Display agent details
    for (const agent of retrievedAgents) {
      console.log(''); // Add spacing between agents
      displayAgent(agent, `Agent Details: ${agent.name || agent.id}`);

      // Display JSON if requested
      if (opts.json) {
        const { id, createdAt, updatedAt, enabled, ...agentConfig } = agent;
        console.log(JSON.stringify(agentConfig, null, 2));
      }
    }

    // Report any failures
    if (failedAgents.length > 0) {
      console.error(`\x1b[31m[✗] Failed to get ${failedAgents.length} agent(s):\x1b[0m`);
      failedAgents.forEach((error) => console.error(`  ${error}`));
    }

    if (retrievedAgents.length > 0) {
      console.log(`\x1b[32m[✓] Successfully retrieved ${retrievedAgents.length} agent(s)\x1b[0m`);
    }

    return;
  } catch (error) {
    await checkServer(opts);
    handleError(error);
  }
}

/**
 * Remove command implementation - deletes agents
 */
export async function removeAgent(opts: OptionValues): Promise<void> {
  try {
    const parsedPaths = parseCharacterPaths(opts.character);
    const baseUrl = getAgentsBaseUrl(opts);

    if (parsedPaths.length === 0) {
      throw new Error(`Invalid character specification: ${opts.character}`);
    }

    const removedAgents: string[] = [];
    const failedAgents: string[] = [];

    for (const characterName of parsedPaths) {
      try {
        console.info(`Removing agent ${characterName}...`);

        const resolvedAgentId = await resolveAgentId(characterName, opts);

        // API Endpoint: DELETE /agents/:agentId
        const response = await fetch(`${baseUrl}/${resolvedAgentId}`, {
          method: 'DELETE',
        });

        if (!response.ok) {
          const errorData = (await response.json().catch(() => ({}))) as ApiResponse<unknown>;
          throw new Error(
            errorData.error?.message || `Failed to remove agent: ${response.statusText}`
          );
        }

        // Server returns 204 No Content for successful deletion, no need to parse response
        removedAgents.push(characterName);
      } catch (error) {
        failedAgents.push(
          `${characterName}: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }

    // Report results
    if (removedAgents.length > 0) {
      console.log(
        `\x1b[32m[✓] Successfully removed ${removedAgents.length} agent(s): ${removedAgents.join(', ')}\x1b[0m`
      );
    }

    if (failedAgents.length > 0) {
      console.error(`\x1b[31m[✗] Failed to remove ${failedAgents.length} agent(s):\x1b[0m`);
      failedAgents.forEach((error) => console.error(`  ${error}`));
    }

    return;
  } catch (error) {
    await checkServer(opts);
    handleError(error);
  }
}

/**
 * Clear memories command implementation - clears all memories for agents
 */
export async function clearAgentMemories(opts: OptionValues): Promise<void> {
  try {
    const parsedPaths = parseCharacterPaths(opts.character);
    const baseUrl = getAgentsBaseUrl(opts);

    if (parsedPaths.length === 0) {
      throw new Error(`Invalid character specification: ${opts.character}`);
    }

    const clearedAgents: Array<{ name: string; deletedCount: number }> = [];
    const failedAgents: string[] = [];

    for (const characterName of parsedPaths) {
      try {
        console.info(`Clearing all memories for agent ${characterName}...`);

        const resolvedAgentId = await resolveAgentId(characterName, opts);

        // API Endpoint: DELETE /agents/:agentId/memories
        const response = await fetch(`${baseUrl}/${resolvedAgentId}/memories`, {
          method: 'DELETE',
        });

        if (!response.ok) {
          const errorData = (await response.json().catch(() => ({}))) as ApiResponse<unknown>;
          throw new Error(
            errorData.error?.message || `Failed to clear agent memories: ${response.statusText}`
          );
        }

        const data = (await response.json()) as ApiResponse<{ deletedCount: number }>;
        const result = data.data;

        clearedAgents.push({
          name: characterName,
          deletedCount: result?.deletedCount || 0,
        });
      } catch (error) {
        failedAgents.push(
          `${characterName}: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }

    // Report results
    if (clearedAgents.length > 0) {
      console.log(
        `\x1b[32m[✓] Successfully cleared memories for ${clearedAgents.length} agent(s):\x1b[0m`
      );
      clearedAgents.forEach(({ name, deletedCount }) => {
        console.log(`  ${name}: ${deletedCount} memories cleared`);
      });
    }

    if (failedAgents.length > 0) {
      console.error(
        `\x1b[31m[✗] Failed to clear memories for ${failedAgents.length} agent(s):\x1b[0m`
      );
      failedAgents.forEach((error) => console.error(`  ${error}`));
    }

    return;
  } catch (error) {
    await checkServer(opts);
    handleError(error);
  }
}

/**
 * Set command implementation - updates agent configuration
 */
export async function setAgentConfig(opts: OptionValues): Promise<void> {
  try {
    const resolvedAgentId = await resolveAgentId(opts.character, opts);

    console.info(`Updating configuration for agent ${resolvedAgentId}`);

    let config: Record<string, unknown>;
    if (opts.config) {
      try {
        config = JSON.parse(opts.config);
      } catch (error) {
        throw new Error(
          `Failed to parse config JSON string: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    } else if (opts.file) {
      try {
        config = JSON.parse(readFileSync(opts.file, 'utf8'));
      } catch (error) {
        throw new Error(
          `Failed to read or parse config file: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    } else {
      throw new Error('Please provide either a config JSON string (-c) or a config file path (-f)');
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
}
