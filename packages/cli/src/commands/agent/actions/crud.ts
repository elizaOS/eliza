import type { Agent } from '@elizaos/core';
import { logger } from '@elizaos/core';
import type { OptionValues } from 'commander';
import { writeFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { checkServer, displayAgent, handleError } from '@/src/utils';
import type { ApiResponse } from '../../shared';
import { createApiClientConfig } from '../../shared';
import { AgentsService, MemoryService } from '@elizaos/api-client';
import { resolveAgentId } from '../utils';

/**
 * Safely parse JSON response with error handling
 * @param response - The fetch Response object
 * @returns Parsed JSON data or null if parsing fails
 */
async function safeJsonParse<T>(response: Response): Promise<T | null> {
  try {
    return await response.json();
  } catch (error) {
    console.error('Failed to parse response as JSON:', error);
    return null;
  }
}

/**
 * Parse error response and throw appropriate error
 * @param response - The fetch Response object
 * @param defaultMessage - Default error message if JSON parsing fails
 */
async function handleErrorResponse(response: Response, defaultMessage: string): Promise<never> {
  const errorData = await safeJsonParse<ApiResponse<unknown>>(response);
  throw new Error(errorData?.error?.message || defaultMessage);
}

/**
 * Get command implementation - retrieves and displays agent details
 */
export async function getAgent(opts: OptionValues): Promise<void> {
  try {
    const resolvedAgentId = await resolveAgentId(opts.name, opts);
    const config = createApiClientConfig(opts);
    const agentsService = new AgentsService(config);

    console.info(`Getting agent ${resolvedAgentId}`);

    // API Endpoint: GET /agents/:agentId
    const agent = await agentsService.getAgent(resolvedAgentId);

    if (!agent) {
      throw new Error('No agent data received from server');
    }

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
      writeFileSync(jsonPath, JSON.stringify(agentConfig, null, 2));
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
    const config = createApiClientConfig(opts);
    const agentsService = new AgentsService(config);

    console.info(`Removing agent ${resolvedAgentId}`);

    // API Endpoint: DELETE /agents/:agentId
    await agentsService.deleteAgent(resolvedAgentId);

    console.log(`Successfully removed agent ${opts.name}`);
    return;
  } catch (error) {
    await checkServer(opts);
    handleError(error);
  }
}

/**
 * Clear memories command implementation - clears all memories for an agent
 */
export async function clearAgentMemories(opts: OptionValues): Promise<void> {
  try {
    const resolvedAgentId = await resolveAgentId(opts.name, opts);
    const config = createApiClientConfig(opts);
    const memoryService = new MemoryService(config);

    console.info(`Clearing all memories for agent ${resolvedAgentId}`);

    // API Endpoint: DELETE /api/memory/:agentId/memories
    const result = await memoryService.clearAgentMemories(resolvedAgentId);

    console.log(
      `Successfully cleared ${result?.deleted || 0} memories for agent ${opts.name}`
    );
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
    const httpClient = createAgentHttpClient(opts);
    const response = await httpClient.patch(resolvedAgentId, config);

    if (!response.ok) {
      await handleErrorResponse(
        response,
        `Failed to update agent configuration: ${response.statusText}`
      );
    }

    const data = await safeJsonParse<ApiResponse<{ id: string }>>(response);
    const result = data?.data || null;

    console.log(`Successfully updated configuration for agent ${result?.id || resolvedAgentId}`);
  } catch (error) {
    await checkServer(opts);
    handleError(error);
  }
}
