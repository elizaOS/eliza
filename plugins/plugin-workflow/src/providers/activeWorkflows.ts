/**
 * Provides each administrator's persisted workflows to workflow-aware turns,
 * using message text to select either the full list or ranked search results.
 */
import {
  ElizaError,
  type IAgentRuntime,
  type Memory,
  type Provider,
  type State,
} from '@elizaos/core';
import { WORKFLOW_SERVICE_TYPE, type WorkflowService } from '../services/index';

function getWorkflowSearchQuery(message: Memory): string | null {
  const text = typeof message.content.text === 'string' ? message.content.text.trim() : '';
  if (!text) return null;

  return /\b(workflow|workflows|automation|automations)\b/i.test(text) ? text : null;
}

/**
 * Provider that enriches state with user's active workflows
 *
 * This provider runs for every message and adds workflow information to the state,
 * allowing the LLM to automatically extract workflow IDs and references from context.
 *
 * Example: User says "run my Stripe workflow" → LLM can see all workflows and extract the right ID
 */
export const activeWorkflowsProvider: Provider = {
  name: 'ACTIVE_WORKFLOWS',
  description: "User's active workflows with IDs and descriptions",
  contexts: ['general', 'automation', 'tasks', 'connectors'],
  contextGate: { anyOf: ['general', 'automation', 'tasks', 'connectors'] },
  cacheScope: 'turn',
  roleGate: { minRole: 'ADMIN' },

  get: async (runtime: IAgentRuntime, _message: Memory, _state: State) => {
    try {
      const service = runtime.getService<WorkflowService>(WORKFLOW_SERVICE_TYPE);

      if (!service) {
        return {
          text: '',
          data: {},
          values: {},
        };
      }

      const userId = _message.entityId;
      const searchQuery = getWorkflowSearchQuery(_message);
      const workflows = searchQuery
        ? await service.searchWorkflows(searchQuery, userId)
        : await service.listWorkflows(userId);

      if (workflows.length === 0) {
        return {
          text: searchQuery ? `# Matching Workflows\n\nNo workflows match "${searchQuery}".` : '',
          data: searchQuery ? { workflows: [], searchQuery } : { workflows: [] },
          values: searchQuery
            ? { hasWorkflows: false, workflowCount: 0, workflowSearchQuery: searchQuery }
            : { hasWorkflows: false },
        };
      }

      const workflowList = workflows
        .slice(0, 20)
        .map((wf) => {
          const status = wf.active ? 'ACTIVE' : 'INACTIVE';
          const nodeCount = wf.nodes.length || 0;
          return `- **${wf.name}** (ID: ${wf.id}, Status: ${status}, Nodes: ${nodeCount})`;
        })
        .join('\n');

      const text = `${searchQuery ? '# Matching Workflows' : '# Available Workflows'}\n\n${workflowList}`;

      return {
        text,
        data: {
          workflows: workflows.map((wf) => ({
            id: wf.id,
            name: wf.name,
            active: wf.active || false,
            nodeCount: wf.nodes.length || 0,
          })),
          ...(searchQuery ? { searchQuery } : {}),
        },
        values: {
          hasWorkflows: true,
          workflowCount: workflows.length,
          ...(searchQuery ? { workflowSearchQuery: searchQuery } : {}),
        },
      };
    } catch (error) {
      const wrapped = new ElizaError('Failed to load active workflows', {
        code: 'WORKFLOW_PROVIDER_ACTIVE_LOAD_FAILED',
        cause: error,
        context: { entityId: _message.entityId },
        severity: 'ephemeral',
      });
      await runtime.reportError('WorkflowProvider.active', wrapped);
      throw wrapped;
    }
  },
};
