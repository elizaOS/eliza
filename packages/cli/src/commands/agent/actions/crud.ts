import { checkServer, displayAgent, handleError } from '@/src/utils';
import { AgentsService, MemoryService } from '@elizaos/api-client';
import { asUUID, UUID } from '@elizaos/core';
import type { OptionValues } from 'commander';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createApiClientConfig } from '../../shared';
import { resolveAgentId } from '../utils';

/**
 * Parse error response and throw appropriate error
 * @param response - The fetch Response object
 * @param defaultMessage - Default error message if JSON parsing fails
 */

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
    let agentId: UUID;
    try {
      agentId = asUUID(resolvedAgentId);
    } catch (error) {
      throw new Error(
        `Invalid agent ID format: ${resolvedAgentId}. Please provide a valid UUID, agent name, or index.`
      );
    }
    const agent = await agentsService.getAgent(agentId);

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
    displayAgent(agent as any, 'Agent Details');

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
    let agentId: UUID;
    try {
      agentId = asUUID(resolvedAgentId);
    } catch (error) {
      throw new Error(
        `Invalid agent ID format: ${resolvedAgentId}. Please provide a valid UUID, agent name, or index.`
      );
    }
    await agentsService.deleteAgent(agentId);

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
    let agentId: UUID;
    try {
      agentId = asUUID(resolvedAgentId);
    } catch (error) {
      throw new Error(
        `Invalid agent ID format: ${resolvedAgentId}. Please provide a valid UUID, agent name, or index.`
      );
    }
    const result = await memoryService.clearAgentMemories(agentId);

    console.log(`Successfully cleared ${result?.deleted || 0} memories for agent ${opts.name}`);
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
    const clientConfig = createApiClientConfig(opts);
    const agentsService = new AgentsService(clientConfig);

    let agentId: UUID;
    try {
      agentId = asUUID(resolvedAgentId);
    } catch (error) {
      throw new Error(
        `Invalid agent ID format: ${resolvedAgentId}. Please provide a valid UUID, agent name, or index.`
      );
    }
    const updatedAgent = await agentsService.updateAgent(agentId, config);

    console.log(
      `Successfully updated configuration for agent ${updatedAgent?.id || resolvedAgentId}`
    );
  } catch (error) {
    await checkServer(opts);
    handleError(error);
  }
}
