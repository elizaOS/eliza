import {
  type Action,
  type ActionExample,
  type ActionResult,
  type HandlerCallback,
  type IAgentRuntime,
  logger,
  type Memory,
  type State,
} from '@elizaos/core';
import { N8N_WORKFLOW_SERVICE_TYPE, type N8nWorkflowService } from '../services/index';
import { matchWorkflow } from '../utils/generation';
import { buildConversationContext } from '../utils/context';

const examples: ActionExample[][] = [
  [
    {
      name: '{{user1}}',
      content: {
        text: 'Delete the old payment workflow',
      },
    },
    {
      name: '{{agent}}',
      content: {
        text: "I'll delete that workflow for you.",
        actions: ['DELETE_N8N_WORKFLOW'],
      },
    },
  ],
  [
    {
      name: '{{user1}}',
      content: {
        text: 'Remove workflow abc123',
      },
    },
    {
      name: '{{agent}}',
      content: {
        text: 'Deleting workflow abc123.',
        actions: ['DELETE_N8N_WORKFLOW'],
      },
    },
  ],
  [
    {
      name: '{{user1}}',
      content: {
        text: 'Get rid of the broken email automation',
      },
    },
    {
      name: '{{agent}}',
      content: {
        text: 'Removing that workflow.',
        actions: ['DELETE_N8N_WORKFLOW'],
      },
    },
  ],
];

export const deleteWorkflowAction: Action = {
  name: 'DELETE_N8N_WORKFLOW',
  similes: ['DELETE_WORKFLOW', 'REMOVE_WORKFLOW', 'DESTROY_WORKFLOW'],
  description:
    'Delete an n8n workflow permanently. This action cannot be undone. Identifies workflows by ID, name, or semantic description in any language.',

  validate: async (runtime: IAgentRuntime): Promise<boolean> => {
    const service = runtime.getService(N8N_WORKFLOW_SERVICE_TYPE);
    return !!service;
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state: State | undefined,
    _options?: unknown,
    callback?: HandlerCallback
  ): Promise<ActionResult> => {
    const service = runtime.getService<N8nWorkflowService>(N8N_WORKFLOW_SERVICE_TYPE);

    if (!service) {
      logger.error(
        { src: 'plugin:n8n-workflow:action:delete' },
        'N8n Workflow service not available'
      );
      if (callback) {
        await callback({
          text: 'N8n Workflow service is not available.',
          success: false,
        });
      }
      return { success: false };
    }

    try {
      const userId = message.entityId;
      const workflows = await service.listWorkflows(userId);

      if (workflows.length === 0) {
        if (callback) {
          await callback({
            text: 'No workflows available to delete.',
            success: false,
          });
        }
        return { success: false };
      }

      const context = buildConversationContext(message, state);
      const matchResult = await matchWorkflow(runtime, context, workflows);

      if (!matchResult.matchedWorkflowId || matchResult.confidence === 'none') {
        const workflowList = matchResult.matches.map((m) => `- ${m.name} (ID: ${m.id})`).join('\n');

        if (callback) {
          await callback({
            text: `Could not identify which workflow to delete. Available workflows:\n${workflowList}`,
            success: false,
          });
        }
        return { success: false };
      }

      await service.deleteWorkflow(matchResult.matchedWorkflowId);

      logger.info(
        { src: 'plugin:n8n-workflow:action:delete' },
        `Deleted workflow ${matchResult.matchedWorkflowId}`
      );

      if (callback) {
        await callback({
          text: '🗑️  Workflow deleted permanently.',
          success: true,
        });
      }

      return { success: true };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      logger.error(
        { src: 'plugin:n8n-workflow:action:delete' },
        `Failed to delete workflow: ${errorMessage}`
      );

      if (callback) {
        await callback({
          text: `Failed to delete workflow: ${errorMessage}`,
          success: false,
        });
      }

      return { success: false };
    }
  },

  examples,
};
