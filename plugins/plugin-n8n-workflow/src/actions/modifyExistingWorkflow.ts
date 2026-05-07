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
import type { WorkflowDraft } from '../types/index';
import { DRAFT_TTL_MS } from '../utils/constants';
import { buildConversationContext } from '../utils/context';
import { formatActionResponse, matchWorkflow } from '../utils/generation';
import { validateN8nWorkflowIntent } from './validation';

const examples: ActionExample[][] = [
  [
    {
      name: '{{user1}}',
      content: {
        text: 'Modify my email notification workflow',
      },
    },
    {
      name: '{{agent}}',
      content: {
        text: "I'll load that workflow so we can modify it.",
        actions: ['MODIFY_EXISTING_N8N_WORKFLOW'],
      },
    },
  ],
  [
    {
      name: '{{user1}}',
      content: {
        text: 'Can you update the Slack alert automation?',
      },
    },
    {
      name: '{{agent}}',
      content: {
        text: 'Loading the Slack alert workflow for modification.',
        actions: ['MODIFY_EXISTING_N8N_WORKFLOW'],
      },
    },
  ],
  [
    {
      name: '{{user1}}',
      content: {
        text: 'Edit the workflow that sends reports to Proton',
      },
    },
    {
      name: '{{agent}}',
      content: {
        text: "I'll find and load that workflow so you can modify it.",
        actions: ['MODIFY_EXISTING_N8N_WORKFLOW'],
      },
    },
  ],
  [
    {
      name: '{{user1}}',
      content: {
        text: 'I want to change the payment processing workflow',
      },
    },
    {
      name: '{{agent}}',
      content: {
        text: 'Loading the payment workflow for editing.',
        actions: ['MODIFY_EXISTING_N8N_WORKFLOW'],
      },
    },
  ],
];

export const modifyExistingWorkflowAction: Action = {
  name: 'MODIFY_EXISTING_N8N_WORKFLOW',
  contexts: ['automation', 'connectors', 'tasks'],
  contextGate: { anyOf: ['automation', 'connectors', 'tasks'] },
  roleGate: { minRole: 'USER' },
  similes: [
    'EDIT_EXISTING_WORKFLOW',
    'UPDATE_EXISTING_WORKFLOW',
    'CHANGE_EXISTING_WORKFLOW',
    'LOAD_WORKFLOW_FOR_EDIT',
  ],
  description:
    'Load an existing deployed n8n workflow for modification. ' +
    'Identifies workflows by name or semantic description and loads them into the draft editor. ' +
    'After loading, use CREATE_N8N_WORKFLOW to make changes, preview, and redeploy. ' +
    'Use this when the user wants to modify a workflow that is already deployed.',
  descriptionCompressed:
    'Load deployed n8n workflow into draft editor; then use CREATE_N8N_WORKFLOW to change, preview, redeploy.',
  parameters: [
    {
      name: 'workflowId',
      description:
        'Optional exact n8n workflow id to load into the draft editor.',
      required: false,
      schema: { type: 'string' },
    },
    {
      name: 'workflowName',
      description: 'Optional workflow name to load into the draft editor.',
      required: false,
      schema: { type: 'string' },
    },
    {
      name: 'query',
      description:
        'Optional natural-language description of the workflow to modify.',
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
        { src: 'plugin:n8n-workflow:action:modify-existing' },
        'N8n Workflow service not available',
      );
      if (callback) {
        const text = await formatActionResponse(runtime, 'ERROR', {
          error:
            'N8n Workflow service is not available. Check N8N_API_KEY and N8N_HOST.',
        });
        await callback({ text, success: false });
      }
      return { success: false };
    }

    try {
      const userId = message.entityId;
      const cacheKey = `workflow_draft:${userId}`;

      // Check for existing draft — if one exists, user should use CREATE_N8N_WORKFLOW
      const existingDraft = await runtime.getCache<WorkflowDraft>(cacheKey);
      if (
        existingDraft &&
        Date.now() - existingDraft.createdAt < DRAFT_TTL_MS
      ) {
        if (callback) {
          await callback({
            text:
              'You already have a workflow draft in progress. ' +
              'Please confirm, modify, or cancel that draft first before loading another workflow.',
            success: false,
          });
        }
        return { success: false };
      }

      // List user's workflows
      const workflows = await service.listWorkflows(userId);

      if (workflows.length === 0) {
        if (callback) {
          await callback({
            text: 'No deployed workflows found. Would you like to create a new one?',
            success: false,
          });
        }
        return { success: false };
      }

      // Match user's description to a workflow
      const context = buildConversationContext(message, state);
      const matchResult = await matchWorkflow(runtime, context, workflows);

      logger.info(
        { src: 'plugin:n8n-workflow:action:modify-existing' },
        `Workflow match: ${matchResult.matchedWorkflowId || 'none'} (confidence: ${matchResult.confidence})`,
      );

      // No match or low confidence — show available workflows
      if (!matchResult.matchedWorkflowId || matchResult.confidence === 'none') {
        const workflowList = workflows
          .map((wf) => `- "${wf.name}" (${wf.active ? 'active' : 'inactive'})`)
          .join('\n');

        if (callback) {
          await callback({
            text: `I couldn't identify which workflow you want to modify. Here are your workflows:\n\n${workflowList}\n\nPlease specify which one you'd like to edit.`,
            success: false,
          });
        }
        return { success: false };
      }

      // Low confidence — ask for confirmation
      if (matchResult.confidence === 'low') {
        const matchedWorkflow = workflows.find(
          (wf) => wf.id === matchResult.matchedWorkflowId,
        );
        if (callback) {
          await callback({
            text: `Did you mean the workflow "${matchedWorkflow?.name}"? Please confirm or be more specific.`,
            success: false,
          });
        }
        return { success: false };
      }

      // Medium/High confidence — load the workflow
      const workflowId = matchResult.matchedWorkflowId;
      const fullWorkflow = await service.getWorkflow(workflowId);

      logger.info(
        { src: 'plugin:n8n-workflow:action:modify-existing' },
        `Loading workflow "${fullWorkflow.name}" (${fullWorkflow.id}) with ${fullWorkflow.nodes?.length || 0} nodes`,
      );

      // Create draft from the existing workflow
      const draft: WorkflowDraft = {
        workflow: fullWorkflow,
        prompt: `Modify existing workflow: ${fullWorkflow.name}`,
        userId,
        createdAt: Date.now(),
      };
      await runtime.setCache(cacheKey, draft);

      // Build preview data
      const nodes = (fullWorkflow.nodes || []).map((n) => ({
        name: n.name,
        type: n.type.replace('n8n-nodes-base.', ''),
      }));

      const creds = new Set<string>();
      for (const node of fullWorkflow.nodes || []) {
        if (node.credentials) {
          for (const c of Object.keys(node.credentials)) {
            creds.add(c);
          }
        }
      }

      const text = await formatActionResponse(runtime, 'WORKFLOW_LOADED', {
        workflowName: fullWorkflow.name,
        workflowId: fullWorkflow.id,
        active: fullWorkflow.active,
        nodes,
        credentials: [...creds],
        message:
          'Workflow loaded for editing. Tell me what changes you want to make.',
      });

      if (callback) {
        await callback({
          text,
          success: true,
          data: { awaitingUserInput: true },
        });
      }

      return { success: true, data: { workflowId, awaitingUserInput: true } };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : 'Unknown error';
      logger.error(
        { src: 'plugin:n8n-workflow:action:modify-existing' },
        `Failed to load workflow for modification: ${errorMessage}`,
      );

      const text = await formatActionResponse(runtime, 'ERROR', {
        error: errorMessage,
      });
      if (callback) {
        await callback({ text, success: false });
      }
      return { success: false };
    }
  },

  examples,
};
