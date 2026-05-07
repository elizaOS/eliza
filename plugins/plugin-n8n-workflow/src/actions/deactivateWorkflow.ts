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
import {
  N8N_WORKFLOW_SERVICE_TYPE,
  type N8nWorkflowService,
} from '../services/index';
import { buildConversationContext } from '../utils/context';
import { matchWorkflow } from '../utils/generation';
import { validateN8nWorkflowIntent } from './validation';

const examples: ActionExample[][] = [
  [
    {
      name: '{{user1}}',
      content: {
        text: 'Pause my Stripe workflow',
      },
    },
    {
      name: '{{agent}}',
      content: {
        text: "I'll deactivate that workflow for you.",
        actions: ['DEACTIVATE_N8N_WORKFLOW'],
      },
    },
  ],
  [
    {
      name: '{{user1}}',
      content: {
        text: 'Stop the email automation',
      },
    },
    {
      name: '{{agent}}',
      content: {
        text: 'Stopping email workflow.',
        actions: ['DEACTIVATE_N8N_WORKFLOW'],
      },
    },
  ],
  [
    {
      name: '{{user1}}',
      content: {
        text: 'Turn off workflow xyz789',
      },
    },
    {
      name: '{{agent}}',
      content: {
        text: 'Deactivating workflow xyz789.',
        actions: ['DEACTIVATE_N8N_WORKFLOW'],
      },
    },
  ],
];

export const deactivateWorkflowAction: Action = {
  name: 'DEACTIVATE_N8N_WORKFLOW',
  contexts: ['automation', 'connectors', 'tasks'],
  contextGate: { anyOf: ['automation', 'connectors', 'tasks'] },
  roleGate: { minRole: 'USER' },
  similes: [
    'DEACTIVATE_WORKFLOW',
    'DISABLE_WORKFLOW',
    'STOP_WORKFLOW',
    'PAUSE_WORKFLOW',
    'TURN_OFF_WORKFLOW',
  ],
  description:
    'Deactivate an n8n workflow to stop it from processing triggers and running automatically. Identifies workflows by ID, name, or semantic description in any language.',
  descriptionCompressed:
    'deactivate n8n workflow stop process trigger run automatically identify workflow ID, name, semantic description language',
  parameters: [
    {
      name: 'workflowId',
      description: 'Optional exact n8n workflow id to deactivate.',
      required: false,
      schema: { type: 'string' },
    },
    {
      name: 'workflowName',
      description: 'Optional workflow name to deactivate.',
      required: false,
      schema: { type: 'string' },
    },
    {
      name: 'query',
      description:
        'Optional natural-language description of the workflow to deactivate.',
      required: false,
      schema: { type: 'string' },
    },
  ],

  validate: async (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
  ): Promise<boolean> => validateN8nWorkflowIntent(runtime, message, state),

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state: State | undefined,
    _options?: unknown,
    callback?: HandlerCallback,
  ): Promise<ActionResult> => {
    const service = runtime.getService<N8nWorkflowService>(
      N8N_WORKFLOW_SERVICE_TYPE,
    );

    if (!service) {
      logger.error(
        { src: 'plugin:n8n-workflow:action:deactivate' },
        'N8n Workflow service not available',
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
            text: 'No workflows available to deactivate.',
            success: false,
          });
        }
        return { success: false };
      }

      const context = buildConversationContext(message, state);
      const matchResult = await matchWorkflow(runtime, context, workflows);

      if (!matchResult.matchedWorkflowId || matchResult.confidence === 'none') {
        const workflowList = matchResult.matches
          .map((m) => `- ${m.name} (ID: ${m.id})`)
          .join('\n');

        if (callback) {
          await callback({
            text: `Could not identify which workflow to deactivate. Available workflows:\n${workflowList}`,
            success: false,
          });
        }
        return { success: false };
      }

      await service.deactivateWorkflow(matchResult.matchedWorkflowId);

      logger.info(
        { src: 'plugin:n8n-workflow:action:deactivate' },
        `Deactivated workflow ${matchResult.matchedWorkflowId}`,
      );

      if (callback) {
        await callback({
          text: '⏸️  Workflow deactivated and will no longer run automatically.',
          success: true,
        });
      }

      return { success: true };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : 'Unknown error';
      logger.error(
        { src: 'plugin:n8n-workflow:action:deactivate' },
        `Failed to deactivate workflow: ${errorMessage}`,
      );

      if (callback) {
        await callback({
          text: `Failed to deactivate workflow: ${errorMessage}`,
          success: false,
        });
      }

      return { success: false };
    }
  },

  examples,
};
