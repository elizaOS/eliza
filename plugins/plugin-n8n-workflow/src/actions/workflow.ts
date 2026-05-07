import {
  type Action,
  type ActionExample,
  type ActionResult,
  type HandlerCallback,
  type IAgentRuntime,
  type ProviderDataRecord,
  logger,
  type Memory,
  requireConfirmation,
  type State,
} from '@elizaos/core';
import { N8N_WORKFLOW_SERVICE_TYPE, type N8nWorkflowService } from '../services/index';
import { matchWorkflow } from '../utils/generation';
import { buildConversationContext } from '../utils/context';
import type { WorkflowDraft } from '../types/index';
import { DRAFT_TTL_MS } from '../utils/constants';

const VALID_OPS = ['activate', 'deactivate', 'delete'] as const;
const N8N_WORKFLOW_MATCH_LIMIT = 25;
const N8N_LIFECYCLE_TIMEOUT_MS = 30_000;
type LifecycleOp = (typeof VALID_OPS)[number];

type LifecycleOptions = {
  parameters?: {
    op?: unknown;
    workflowId?: unknown;
  };
};

const examples: ActionExample[][] = [
  [
    {
      name: '{{user1}}',
      content: { text: 'Enable my payment workflow' },
    },
    {
      name: '{{agent}}',
      content: {
        text: "I'll activate that workflow for you.",
        actions: ['WORKFLOW'],
      },
    },
  ],
  [
    {
      name: '{{user1}}',
      content: { text: 'Pause my Stripe workflow' },
    },
    {
      name: '{{agent}}',
      content: {
        text: "I'll deactivate that workflow for you.",
        actions: ['WORKFLOW'],
      },
    },
  ],
  [
    {
      name: '{{user1}}',
      content: { text: 'Delete the old payment workflow' },
    },
    {
      name: '{{agent}}',
      content: {
        text: "I'll delete that workflow for you.",
        actions: ['WORKFLOW'],
      },
    },
  ],
];

function parseOpFromText(text: string): LifecycleOp | null {
  const lower = text.toLowerCase();
  if (/\b(delete|remove|destroy|get rid of)\b/.test(lower)) {
    return 'delete';
  }
  if (/\b(deactivate|disable|stop|pause|turn off)\b/.test(lower)) {
    return 'deactivate';
  }
  if (/\b(activate|enable|start|turn on)\b/.test(lower)) {
    return 'activate';
  }
  return null;
}

function resolveOp(message: Memory, options?: unknown): LifecycleOp | null {
  const params = (options as LifecycleOptions | undefined)?.parameters ?? {};
  if (typeof params.op === 'string') {
    const trimmed = params.op.trim().toLowerCase();
    if ((VALID_OPS as readonly string[]).includes(trimmed)) {
      return trimmed as LifecycleOp;
    }
  }
  return parseOpFromText(message.content?.text || '');
}

async function handleActivateDraftRedirect(
  runtime: IAgentRuntime,
  service: N8nWorkflowService,
  message: Memory,
  callback?: HandlerCallback
): Promise<ActionResult | null> {
  const cacheKey = `workflow_draft:${message.entityId}`;
  let pendingDraft = await runtime.getCache<WorkflowDraft>(cacheKey);

  if (pendingDraft && Date.now() - pendingDraft.createdAt > DRAFT_TTL_MS) {
    await runtime.deleteCache(cacheKey);
    pendingDraft = undefined;
  }

  if (!pendingDraft) {
    return null;
  }

  if (pendingDraft.workflow._meta?.requiresClarification?.length) {
    logger.info(
      { src: 'plugin:n8n-workflow:action:lifecycle' },
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
    { src: 'plugin:n8n-workflow:action:lifecycle' },
    `Draft redirect: deploying pending draft "${pendingDraft.workflow.name}" (LLM misrouted to ACTIVATE)`
  );

  const result = await service.deployWorkflow(pendingDraft.workflow, message.entityId);

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

async function runActivate(
  runtime: IAgentRuntime,
  service: N8nWorkflowService,
  message: Memory,
  state: State | undefined,
  workflowIdParam: string | null,
  callback?: HandlerCallback
): Promise<ActionResult> {
  const draftRedirect = await handleActivateDraftRedirect(runtime, service, message, callback);
  if (draftRedirect) {
    return draftRedirect;
  }

  const workflowId = await resolveWorkflowId(
    runtime,
    service,
    message,
    state,
    workflowIdParam,
    'activate',
    callback
  );
  if (!workflowId) {
    return { success: false };
  }

  await service.activateWorkflow(workflowId);
  logger.info({ src: 'plugin:n8n-workflow:action:lifecycle' }, `Activated workflow ${workflowId}`);

  if (callback) {
    await callback({
      text: '✅ Workflow activated and is now running.',
      success: true,
    });
  }
  return { success: true };
}

async function runDeactivate(
  runtime: IAgentRuntime,
  service: N8nWorkflowService,
  message: Memory,
  state: State | undefined,
  workflowIdParam: string | null,
  callback?: HandlerCallback
): Promise<ActionResult> {
  const workflowId = await resolveWorkflowId(
    runtime,
    service,
    message,
    state,
    workflowIdParam,
    'deactivate',
    callback
  );
  if (!workflowId) {
    return { success: false };
  }

  await service.deactivateWorkflow(workflowId);
  logger.info(
    { src: 'plugin:n8n-workflow:action:lifecycle' },
    `Deactivated workflow ${workflowId}`
  );

  if (callback) {
    await callback({
      text: '⏸️  Workflow deactivated and will no longer run automatically.',
      success: true,
    });
  }
  return { success: true };
}

async function runDelete(
  runtime: IAgentRuntime,
  service: N8nWorkflowService,
  message: Memory,
  state: State | undefined,
  workflowIdParam: string | null,
  callback?: HandlerCallback
): Promise<ActionResult> {
  const userId = message.entityId;

  // Resolve which workflow we're talking about so we can cite it in the
  // confirmation prompt before stashing pending state.
  const workflows = (await service.listWorkflows(userId)).slice(0, N8N_WORKFLOW_MATCH_LIMIT);

  if (workflows.length === 0) {
    if (callback) {
      await callback({
        text: 'No workflows available to delete.',
        success: false,
      });
    }
    return { success: false };
  }

  let matchedId: string | null = workflowIdParam;
  let matchedName: string | null;
  if (matchedId) {
    matchedName = workflows.find((w) => w.id === matchedId)?.name ?? null;
  } else {
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
    matchedId = matchResult.matchedWorkflowId;
    matchedName = workflows.find((w) => w.id === matchedId)?.name ?? null;
  }

  const workflowName = matchedName || matchedId;

  const decision = await requireConfirmation({
    runtime,
    message,
    actionName: 'WORKFLOW',
    pendingKey: `delete:${matchedId}`,
    prompt: `Permanently delete workflow "${workflowName}"? This cannot be undone. Reply "yes" to confirm.`,
    callback,
    metadata: { workflowId: matchedId, workflowName },
  });

  if (decision.status === 'pending') {
    return { success: true, data: { awaitingUserInput: true } };
  }
  if (decision.status === 'cancelled') {
    if (callback) {
      await callback({ text: 'Deletion cancelled.', success: true });
    }
    return { success: true };
  }

  await service.deleteWorkflow(matchedId);
  logger.info(
    { src: 'plugin:n8n-workflow:action:lifecycle' },
    `Deleted workflow ${matchedId} after confirmation`
  );
  if (callback) {
    await callback({
      text: `Workflow "${workflowName}" deleted permanently.`,
      success: true,
    });
  }
  return { success: true };
}

async function resolveWorkflowId(
  runtime: IAgentRuntime,
  service: N8nWorkflowService,
  message: Memory,
  state: State | undefined,
  workflowIdParam: string | null,
  opLabel: string,
  callback?: HandlerCallback
): Promise<string | null> {
  const userId = message.entityId;
  const workflows = (await service.listWorkflows(userId)).slice(0, N8N_WORKFLOW_MATCH_LIMIT);

  if (workflows.length === 0) {
    if (callback) {
      await callback({
        text: `No workflows available to ${opLabel}.`,
        success: false,
      });
    }
    return null;
  }

  if (workflowIdParam) {
    const exists = workflows.some((w) => w.id === workflowIdParam);
    if (!exists) {
      if (callback) {
        await callback({
          text: `Workflow ${workflowIdParam} not found.`,
          success: false,
        });
      }
      return null;
    }
    return workflowIdParam;
  }

  const context = buildConversationContext(message, state);
  const matchResult = await matchWorkflow(runtime, context, workflows);

  if (!matchResult.matchedWorkflowId || matchResult.confidence === 'none') {
    const workflowList = matchResult.matches.map((m) => `- ${m.name} (ID: ${m.id})`).join('\n');
    if (callback) {
      await callback({
        text: `Could not identify which workflow to ${opLabel}. Available workflows:\n${workflowList}`,
        success: false,
      });
    }
    return null;
  }

  return matchResult.matchedWorkflowId;
}

export const workflowAction: Action = {
  name: 'WORKFLOW',
  contexts: ['automation', 'connectors', 'tasks'],
  contextGate: { anyOf: ['automation', 'connectors', 'tasks'] },
  roleGate: { minRole: 'USER' },
  similes: [
    'ACTIVATE_WORKFLOW',
    'DEACTIVATE_WORKFLOW',
    'DELETE_WORKFLOW',
    'ENABLE_WORKFLOW',
    'DISABLE_WORKFLOW',
    'STOP_WORKFLOW',
    'PAUSE_WORKFLOW',
    'TURN_ON_WORKFLOW',
    'TURN_OFF_WORKFLOW',
    'START_WORKFLOW',
    'REMOVE_WORKFLOW',
    'DESTROY_WORKFLOW',
    // Back-compat for callers that still reference the old action names
    'ACTIVATE_N8N_WORKFLOW',
    'DEACTIVATE_N8N_WORKFLOW',
    'DELETE_N8N_WORKFLOW',
  ],
  description:
    'n8n workflow lifecycle operation. Pass `op` ("activate", "deactivate", or "delete") and optionally `workflowId`. Identifies workflows by ID, name, or semantic description.',
  descriptionCompressed: 'n8n workflow lifecycle: activate, deactivate, delete.',

  parameters: [
    {
      name: 'op',
      description: 'Lifecycle operation to perform. One of: activate, deactivate, delete.',
      required: false,
      schema: {
        type: 'string' as const,
        enum: [...VALID_OPS],
      },
    },
    {
      name: 'workflowId',
      description: 'Exact n8n workflow id. When omitted, the workflow is matched semantically.',
      required: false,
      schema: { type: 'string' as const },
    },
  ],

  validate: async (runtime: IAgentRuntime): Promise<boolean> => {
    return !!runtime.getService(N8N_WORKFLOW_SERVICE_TYPE);
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state: State | undefined,
    options?: unknown,
    callback?: HandlerCallback
  ): Promise<ActionResult> => {
    const service = runtime.getService<N8nWorkflowService>(N8N_WORKFLOW_SERVICE_TYPE);

    if (!service) {
      logger.error(
        { src: 'plugin:n8n-workflow:action:lifecycle' },
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

    const op = resolveOp(message, options);
    if (!op) {
      if (callback) {
        await callback({
          text: 'Could not determine which lifecycle operation to perform. Please specify activate, deactivate, or delete.',
          success: false,
        });
      }
      return { success: false };
    }

    const params = (options as LifecycleOptions | undefined)?.parameters ?? {};
    const workflowIdParam =
      typeof params.workflowId === 'string' && params.workflowId.trim().length > 0
        ? params.workflowId.trim()
        : null;

    try {
      const timeout = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('n8n workflow lifecycle timeout')), N8N_LIFECYCLE_TIMEOUT_MS)
      );
      switch (op) {
        case 'activate':
          return await Promise.race([
            runActivate(runtime, service, message, state, workflowIdParam, callback),
            timeout,
          ]);
        case 'deactivate':
          return await Promise.race([
            runDeactivate(runtime, service, message, state, workflowIdParam, callback),
            timeout,
          ]);
        case 'delete':
          return await Promise.race([
            runDelete(runtime, service, message, state, workflowIdParam, callback),
            timeout,
          ]);
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      logger.error(
        { src: 'plugin:n8n-workflow:action:lifecycle', op },
        `Failed to ${op} workflow: ${errorMessage}`
      );

      if (callback) {
        await callback({
          text: `Failed to ${op} workflow: ${errorMessage}`,
          success: false,
        });
      }
      return { success: false };
    }
  },

  examples,
};
