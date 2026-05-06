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

const DELETE_CONFIRM_TTL_MS = 5 * 60 * 1000;

interface PendingDeletion {
  workflowId: string;
  workflowName: string;
  createdAt: number;
}

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
  descriptionCompressed:
    'delete n8n workflow permanently action cannot undone identify workflow ID, name, semantic description language',

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
      return sendDeleteWorkflowServiceMissing(callback);
    }

    try {
      return await runDeleteWorkflowHandler(runtime, service, message, state, callback);
    } catch (error) {
      return sendDeleteWorkflowError(error, callback);
    }
  },

  examples,
};

async function sendDeleteWorkflowServiceMissing(callback?: HandlerCallback): Promise<ActionResult> {
  logger.error({ src: 'plugin:n8n-workflow:action:delete' }, 'N8n Workflow service not available');
  if (callback) {
    await callback({
      text: 'N8n Workflow service is not available.',
      success: false,
    });
  }
  return { success: false };
}

async function handlePendingDeletion(
  runtime: IAgentRuntime,
  service: N8nWorkflowService,
  cacheKey: string,
  pending: PendingDeletion,
  userText: string,
  callback?: HandlerCallback
): Promise<ActionResult> {
  const isConfirm = /^(yes|confirm|ok|do it|go ahead|oui|y)$/i.test(userText);
  if (!isConfirm) {
    await runtime.deleteCache(cacheKey);
    if (callback) {
      await callback({ text: 'Deletion cancelled.', success: true });
    }
    return { success: true };
  }

  await service.deleteWorkflow(pending.workflowId);
  await runtime.deleteCache(cacheKey);
  logger.info(
    { src: 'plugin:n8n-workflow:action:delete' },
    `Deleted workflow ${pending.workflowId} after confirmation`
  );
  if (callback) {
    await callback({
      text: `Workflow "${pending.workflowName}" deleted permanently.`,
      success: true,
    });
  }
  return { success: true };
}

async function startDeletionFlow(
  runtime: IAgentRuntime,
  service: N8nWorkflowService,
  message: Memory,
  state: State | undefined,
  cacheKey: string,
  callback?: HandlerCallback
): Promise<ActionResult> {
  const workflows = await service.listWorkflows(message.entityId);
  if (workflows.length === 0) {
    if (callback) {
      await callback({
        text: 'No workflows available to delete.',
        success: false,
      });
    }
    return { success: false };
  }

  const matchResult = await matchWorkflow(
    runtime,
    buildConversationContext(message, state),
    workflows
  );
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

  const matchedWorkflow = workflows.find((w) => w.id === matchResult.matchedWorkflowId);
  const workflowName = matchedWorkflow?.name || matchResult.matchedWorkflowId;
  await runtime.setCache(cacheKey, {
    workflowId: matchResult.matchedWorkflowId,
    workflowName,
    createdAt: Date.now(),
  } satisfies PendingDeletion);
  if (callback) {
    await callback({
      text: `Are you sure you want to permanently delete "${workflowName}"? This cannot be undone. Reply "yes" to confirm.`,
      success: true,
      data: { awaitingUserInput: true },
    });
  }
  return { success: true, data: { awaitingUserInput: true } };
}

async function runDeleteWorkflowHandler(
  runtime: IAgentRuntime,
  service: N8nWorkflowService,
  message: Memory,
  state: State | undefined,
  callback?: HandlerCallback
): Promise<ActionResult> {
  const cacheKey = `workflow_delete_pending:${message.entityId}`;
  const pending = await runtime.getCache<PendingDeletion>(cacheKey);
  if (pending && Date.now() - pending.createdAt < DELETE_CONFIRM_TTL_MS) {
    const userText = (message.content?.text || '').toLowerCase().trim();
    return handlePendingDeletion(runtime, service, cacheKey, pending, userText, callback);
  }
  return startDeletionFlow(runtime, service, message, state, cacheKey, callback);
}

async function sendDeleteWorkflowError(
  error: unknown,
  callback?: HandlerCallback
): Promise<ActionResult> {
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
