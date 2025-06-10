import type { Agent } from '@elizaos/core';
import { logger } from '@elizaos/core';
import type { OptionValues } from 'commander';
import fs from 'node:fs';
import path from 'node:path';
import { checkServer, displayAgent, handleError } from '@/src/utils';
import type { ApiResponse } from '../../shared';
import { getAgentsBaseUrl } from '../../shared';
import { resolveAgentId } from '../manage';

/**
 * Get command implementation - retrieves and displays agent details
 */
export async function getAgent(opts: OptionValues): Promise<void> {
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
}

/**
 * Remove command implementation - deletes an agent
 */
export async function removeAgent(opts: OptionValues): Promise<void> {
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
      throw new Error(errorData.error?.message || `Failed to remove agent: ${response.statusText}`);
    }

    // Server returns 204 No Content for successful deletion, no need to parse response
    console.log(`Successfully removed agent ${opts.name}`);
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
