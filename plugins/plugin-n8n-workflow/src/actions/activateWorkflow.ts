import {
  type Action,
  type ActionExample,
  type ActionResult,
  type HandlerCallback,
  type IAgentRuntime,
  type ProviderDataRecord,
  logger,
  type Memory,
  type State,
} from '@elizaos/core';
import { N8N_WORKFLOW_SERVICE_TYPE, type N8nWorkflowService } from '../services/index';
import { matchWorkflow } from '../utils/generation';
import { buildConversationContext } from '../utils/context';
import type { WorkflowDraft } from '../types/index';

const DRAFT_TTL_MS = 30 * 60 * 1000;

const examples: ActionExample[][] = [
  [
    {
      name: '{{user1}}',
      content: {
        text: 'Enable my payment workflow',
      },
    },
    {
      name: '{{agent}}',
      content: {
        text: "I'll activate that workflow for you.",
        actions: ['ACTIVATE_N8N_WORKFLOW'],
      },
    },
  ],
  [
    {
      name: '{{user1}}',
      content: {
        text: 'Turn on the Gmail automation',
      },
    },
    {
      name: '{{agent}}',
      content: {
        text: 'Activating Gmail workflow now.',
        actions: ['ACTIVATE_N8N_WORKFLOW'],
      },
    },
  ],
  [
    {
      name: '{{user1}}',
      content: {
        text: 'Start the Stripe workflow abc123',
      },
    },
    {
      name: '{{agent}}',
      content: {
        text: 'Starting workflow abc123.',
        actions: ['ACTIVATE_N8N_WORKFLOW'],
      },
    },
  ],
];

export const activateWorkflowAction: Action = {
  name: 'ACTIVATE_N8N_WORKFLOW',
  similes: ['ACTIVATE_WORKFLOW', 'ENABLE_WORKFLOW', 'START_WORKFLOW', 'TURN_ON_WORKFLOW'],
  description:
    'Activate an n8n workflow to start processing triggers and running automatically. Identifies workflows by ID, name, or semantic description in any language.',
  descriptionCompressed:
    'activate n8n workflow start process trigger run automatically identify workflow ID, name, semantic description language',

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
        { src: 'plugin:n8n-workflow:action:activate' },
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
      // Draft redirect: if a pending draft exists, the LLM likely misrouted a confirmation.
      // Deploy the draft instead of running the normal activate flow.
      const cacheKey = `workflow_draft:${message.entityId}`;
      let pendingDraft = await runtime.getCache<WorkflowDraft>(cacheKey);

      if (pendingDraft && Date.now() - pendingDraft.createdAt > DRAFT_TTL_MS) {
        await runtime.deleteCache(cacheKey);
        pendingDraft = undefined;
      }

      if (pendingDraft) {
        // Don't deploy drafts that still need clarification
        if (pendingDraft.workflow._meta?.requiresClarification?.length) {
          logger.info(
            { src: 'plugin:n8n-workflow:action:activate' },
            'Draft redirect: draft needs clarification, prompting user'
          );
          if (callback) {
            await callback({
              text: 'I still need a bit more information before I can create this workflow. Could you answer the questions above?',
              success: false,
            });
          }
          return { success: false };
        }

        logger.info(
          { src: 'plugin:n8n-workflow:action:activate' },
          `Draft redirect: deploying pending draft "${pendingDraft.workflow.name}" (LLM misrouted to ACTIVATE)`
        );

        const result = await service.deployWorkflow(pendingDraft.workflow, message.entityId);

        // Deploy blocked — unresolved credentials
        if (result.missingCredentials.length > 0) {
          const connList = result.missingCredentials
            .map((m) =>
              m.authUrl ? `- **${m.credType}**: [Connect](${m.authUrl})` : `- **${m.credType}**`
            )
            .join('\n');
          if (callback) {
            await callback({
              text: `The following services need to be connected before deploying:\n\n${connList}\n\nPlease connect them and try again.`,
              success: true,
            });
          }
          return { success: true };
        }

        await runtime.deleteCache(cacheKey);

        let responseText = `Workflow "${result.name}" deployed successfully!\n\n`;
        responseText += `**Workflow ID:** ${result.id}\n`;
        responseText += `**Nodes:** ${result.nodeCount}\n`;
        responseText += `**Status:** ${result.active ? 'Active' : 'Inactive'}\n`;
        responseText += '\nAll credentials configured — workflow is ready to run!';

        if (callback) {
          await callback({ text: responseText, success: true });
        }

        return { success: true, data: result as unknown as ProviderDataRecord };
      }

      // Fetch workflows directly from service
      const userId = message.entityId;
      const workflows = await service.listWorkflows(userId);

      if (workflows.length === 0) {
        if (callback) {
          await callback({
            text: 'No workflows available to activate.',
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
            text: `Could not identify which workflow to activate. Available workflows:\n${workflowList}`,
            success: false,
          });
        }
        return { success: false };
      }

      await service.activateWorkflow(matchResult.matchedWorkflowId);

      logger.info(
        { src: 'plugin:n8n-workflow:action:activate' },
        `Activated workflow ${matchResult.matchedWorkflowId}`
      );

      if (callback) {
        await callback({
          text: '✅ Workflow activated and is now running.',
          success: true,
        });
      }

      return { success: true };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      logger.error(
        { src: 'plugin:n8n-workflow:action:activate' },
        `Failed to activate workflow: ${errorMessage}`
      );

      if (callback) {
        await callback({
          text: `Failed to activate workflow: ${errorMessage}`,
          success: false,
        });
      }

      return { success: false };
    }
  },

  examples,
};
