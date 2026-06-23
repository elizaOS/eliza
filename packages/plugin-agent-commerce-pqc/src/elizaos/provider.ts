import type { IAgentRuntime, Memory, State, ProviderResult } from '@elizaos/core';
import { AgentCommerceService, AGENT_COMMERCE_SERVICE_TYPE } from '../service';

export const commerceProvider = {
  name: 'COMMERCE_CONTEXT',
  description: 'Provides active ERC-8183 job context to the agent',
  get: async (runtime: IAgentRuntime, _message: Memory, _state: State): Promise<ProviderResult> => {
    const service = runtime.getService<AgentCommerceService>(AGENT_COMMERCE_SERVICE_TYPE);

    if (!service) {
      return {
        text: '[Commerce] Plugin not initialised — no AgentCommerceService found.',
        data: { jobs: [], error: 'service_not_found' },
      };
    }

    const agentId = String(runtime.agentId);
    const jobs = await service.jobStore.listByAgent(agentId);

    if (jobs.length === 0) {
      return {
        text: '[Commerce] No active jobs. You can create one with "Create a job for <provider> to <task>, budget <amount>"',
        data: { jobs: [] },
      };
    }

    const recent = jobs.slice(-5);
    const summary = recent
      .map(
        (j) =>
          `• ${j.jobId} | ${j.state} | provider: ${j.providerAgent} | "${(j.taskDescription ?? '').slice(0, 40)}..."`,
      )
      .join('\n');

    return {
      text: `[Commerce — ERC-8183 Jobs]\n${summary}\n[Policy layer: prompt-injection heuristics + SHA-256 payload attestation]`,
      data: {
        jobs: recent.map((j) => ({
          jobId: j.jobId,
          state: j.state,
          clientAgent: j.clientAgent,
          providerAgent: j.providerAgent,
          taskDescription: j.taskDescription,
          createdAt: j.createdAt,
        })),
      },
      values: {
        activeJobCount: jobs.length,
      },
    };
  },
};
