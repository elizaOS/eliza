import type { IAgentRuntime, Memory, State } from '@elizaos/core';
import { MemoryType } from '@elizaos/core';
import type { UUID } from '@elizaos/core';
import { AgentCommerceService, AGENT_COMMERCE_SERVICE_TYPE } from '../service';
import { getPluginLogger } from '../lib/logger';

export { SecurityGuard } from '../lib/security';

export const securityEvaluator = {
  name: 'SECURITY_GUARD',
  description: 'Policy enforcement: payload safety, rate limiting, and prompt-injection heuristics',
  similes: ['secure message', 'check policy', 'validate payload', 'security guard'],
  alwaysRun: true,
  examples: [],
  validate: async (_runtime: IAgentRuntime, _message: Memory): Promise<boolean> => true,
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
  ): Promise<void> => {
    const logger = getPluginLogger(runtime);
    const sender = message.entityId ? String(message.entityId) : null;

    const service = runtime.getService<AgentCommerceService>(AGENT_COMMERCE_SERVICE_TYPE);
    const guard = service?.securityGuard;

    const strictMode =
      runtime.getSetting('STVOR_STRICT_MODE') === true ||
      runtime.getSetting('STVOR_STRICT_MODE') === 'true';

    if (guard) {
      if (sender !== null) {
        try {
          guard.checkRateLimit(sender);
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          if (strictMode) throw new Error(`[SECURITY-GUARD] ${reason}`);
          logger.warn(`Rate limit warning for ${sender}: ${reason}`);
        }
      }

      try {
        guard.assertPayloadSafe(message.content);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        if (strictMode) throw new Error(`[SECURITY-GUARD] Message blocked: ${reason}`);
        logger.warn(`Policy violation from ${sender}: ${reason}`);
      }
    } else {
      logger.warn(
        '[SECURITY-GUARD] AgentCommerceService not found — payload check skipped. ' +
          'Register the plugin with services: [AgentCommerceService] to enable per-runtime isolation.',
      );
    }
  },
};

export const commerceEvaluator = {
  name: 'COMMERCE_TRACKER',
  description: 'Extracts job IDs from conversation and stores them in agent memory',
  similes: ['track job', 'remember job'],
  alwaysRun: false,
  examples: [],
  validate: async (_runtime: IAgentRuntime, message: Memory): Promise<boolean> => {
    return /job-[\w-]+/i.test(message.content.text ?? '');
  },
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
  ): Promise<void> => {
    if (!message.entityId) return;

    const text = message.content.text ?? '';
    const jobIds = text.match(/job-[\w-]+/gi);
    if (!jobIds || jobIds.length === 0) return;

    await runtime.createMemory(
      {
        entityId: message.entityId as UUID,
        roomId: message.roomId as UUID,
        agentId: runtime.agentId as UUID,
        content: {
          text: `Commerce job referenced: ${jobIds.join(', ')}`,
          jobIds,
        },
        metadata: {
          type: MemoryType.CUSTOM,
          tags: ['agent-commerce'],
        },
      },
      'memories',
    );
  },
};
