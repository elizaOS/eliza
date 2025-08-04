import type { OptionValues } from 'commander';
import { z } from 'zod';
import type { AgentBasic } from '../../shared';
import { createApiClientConfig } from '../../shared';
import { AgentsService } from '@elizaos/api-client';

// Zod schemas for validation
export const AgentBasicSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    status: z.string().optional(),
  })
  .passthrough(); // Allow additional properties

export const AgentsListResponseSchema = z.object({
  agents: z.array(AgentBasicSchema),
});

/**
 * Asynchronously fetches a list of basic agent information from the server.
 */
export async function getAgents(opts: OptionValues): Promise<AgentBasic[]> {
  const config = createApiClientConfig(opts);
  const agentsService = new AgentsService(config);
  const result = await agentsService.listAgents();

  // The AgentsService returns { agents: Agent[] } directly after BaseApiClient unwraps the server response
  const validatedData = AgentsListResponseSchema.parse(result);
  return validatedData.agents as AgentBasic[];
}

/**
 * Resolves the ID of an agent based on the provided name, ID, or index.
 */
export async function resolveAgentId(idOrNameOrIndex: string, opts: OptionValues): Promise<string> {
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
