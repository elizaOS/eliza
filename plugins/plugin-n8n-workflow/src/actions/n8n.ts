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
import { N8N_WORKFLOW_SERVICE_TYPE } from '../services/index';
import { createWorkflowAction } from './createWorkflow';
import { modifyExistingWorkflowAction } from './modifyExistingWorkflow';
import { getExecutionsAction } from './getExecutions';
import { workflowLifecycleOpAction } from './workflowLifecycleOp';

const VALID_OPS = [
  'create',
  'modify',
  'activate',
  'deactivate',
  'delete',
  'executions',
] as const;
type N8nOp = (typeof VALID_OPS)[number];

const LIFECYCLE_OPS = new Set<N8nOp>(['activate', 'deactivate', 'delete']);

const N8N_TIMEOUT_MS = 60_000;

interface N8nOptions {
  parameters?: {
    op?: unknown;
    workflowId?: unknown;
    workflowName?: unknown;
    limit?: unknown;
    description?: unknown;
  };
}

function parseOpFromText(text: string): N8nOp | null {
  const lower = text.toLowerCase();
  if (/\b(modify|update|edit|change|adjust|tweak)\b/.test(lower)) return 'modify';
  if (/\b(execution|run|history|ran|executed)\b/.test(lower)) return 'executions';
  if (/\b(delete|remove|destroy|get rid of)\b/.test(lower)) return 'delete';
  if (/\b(deactivate|disable|stop|pause|turn off)\b/.test(lower)) return 'deactivate';
  if (/\b(activate|enable|start|turn on)\b/.test(lower)) return 'activate';
  if (/\b(create|build|make|generate|new workflow)\b/.test(lower)) return 'create';
  return null;
}

function resolveOp(message: Memory, options: unknown): N8nOp | null {
  const params = (options as N8nOptions | undefined)?.parameters ?? {};
  if (typeof params.op === 'string') {
    const trimmed = params.op.trim().toLowerCase();
    if ((VALID_OPS as readonly string[]).includes(trimmed)) {
      return trimmed as N8nOp;
    }
  }
  return parseOpFromText(message.content?.text ?? '');
}

const examples: ActionExample[][] = [
  [
    { name: '{{user1}}', content: { text: 'Build a workflow that sends new Stripe payments to Slack' } },
    { name: '{{agent}}', content: { text: "I'll generate that workflow.", actions: ['N8N'] } },
  ],
  [
    { name: '{{user1}}', content: { text: 'Modify my Stripe-to-Slack workflow to also email me' } },
    { name: '{{agent}}', content: { text: "I'll update that workflow.", actions: ['N8N'] } },
  ],
  [
    { name: '{{user1}}', content: { text: 'Show me the last 5 runs of my payment workflow' } },
    { name: '{{agent}}', content: { text: 'Pulling execution history.', actions: ['N8N'] } },
  ],
  [
    { name: '{{user1}}', content: { text: 'Enable the Stripe workflow' } },
    { name: '{{agent}}', content: { text: 'Activating that workflow.', actions: ['N8N'] } },
  ],
  [
    { name: '{{user1}}', content: { text: 'Pause my payment workflow' } },
    { name: '{{agent}}', content: { text: 'Deactivating that workflow.', actions: ['N8N'] } },
  ],
  [
    { name: '{{user1}}', content: { text: 'Delete the old payment workflow' } },
    { name: '{{agent}}', content: { text: "I'll delete that workflow.", actions: ['N8N'] } },
  ],
];

export const n8nAction: Action = {
  name: 'N8N',
  contexts: ['automation', 'connectors', 'tasks'],
  contextGate: { anyOf: ['automation', 'connectors', 'tasks'] },
  roleGate: { minRole: 'USER' },
  similes: [
    // Generic
    'WORKFLOW',
    'N8N_WORKFLOW',
    // Create
    'CREATE_WORKFLOW',
    'BUILD_WORKFLOW',
    'GENERATE_WORKFLOW',
    'CREATE_N8N_WORKFLOW',
    // Modify
    'MODIFY_WORKFLOW',
    'UPDATE_WORKFLOW',
    'EDIT_WORKFLOW',
    'MODIFY_EXISTING_N8N_WORKFLOW',
    // Lifecycle
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
    'ACTIVATE_N8N_WORKFLOW',
    'DEACTIVATE_N8N_WORKFLOW',
    'DELETE_N8N_WORKFLOW',
    // Executions
    'GET_EXECUTIONS',
    'SHOW_EXECUTIONS',
    'EXECUTION_HISTORY',
    'WORKFLOW_RUNS',
    'WORKFLOW_EXECUTIONS',
    'GET_N8N_EXECUTIONS',
  ],
  description:
    'Manage n8n workflows. Operations: create (build new), modify (edit existing), activate (enable), deactivate (disable), delete (with confirmation), executions (get run history).',
  descriptionCompressed: 'n8n workflow: create, modify, activate, deactivate, delete, executions.',
  parameters: [
    {
      name: 'op',
      description:
        'Operation: create, modify, activate, deactivate, delete, or executions. If omitted, inferred from message text.',
      required: false,
      schema: { type: 'string' as const, enum: [...VALID_OPS] },
    },
    {
      name: 'workflowId',
      description: 'Exact n8n workflow id. When omitted, the workflow is matched semantically.',
      required: false,
      schema: { type: 'string' as const },
    },
    {
      name: 'workflowName',
      description: 'Workflow name fragment for fuzzy matching (executions only).',
      required: false,
      schema: { type: 'string' as const },
    },
    {
      name: 'limit',
      description: 'Max executions to return (executions only). Default 10.',
      required: false,
      schema: { type: 'number' as const },
    },
    {
      name: 'description',
      description: 'Natural-language description (create/modify only). If omitted, derived from message.',
      required: false,
      schema: { type: 'string' as const },
    },
  ],
  validate: async (runtime: IAgentRuntime): Promise<boolean> =>
    Boolean(runtime.getService(N8N_WORKFLOW_SERVICE_TYPE)),
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state: State | undefined,
    options?: unknown,
    callback?: HandlerCallback,
  ): Promise<ActionResult> => {
    const service = runtime.getService(N8N_WORKFLOW_SERVICE_TYPE);
    if (!service) {
      logger.error({ src: 'plugin:n8n-workflow:action:n8n' }, 'N8n Workflow service not available');
      if (callback) {
        await callback({ text: 'N8n Workflow service is not available.', success: false });
      }
      return { success: false };
    }

    const op = resolveOp(message, options);
    if (!op) {
      if (callback) {
        await callback({
          text: 'Could not determine which n8n operation to perform. Please specify create, modify, activate, deactivate, delete, or executions.',
          success: false,
        });
      }
      return { success: false };
    }

    const childOptions = LIFECYCLE_OPS.has(op)
      ? {
        ...((options as Record<string, unknown> | undefined) ?? {}),
        parameters: {
          ...((options as N8nOptions | undefined)?.parameters ?? {}),
          op,
        },
      }
      : options;

    const child =
      op === 'create' ? createWorkflowAction
        : op === 'modify' ? modifyExistingWorkflowAction
          : op === 'executions' ? getExecutionsAction
            : workflowLifecycleOpAction;

    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('n8n action timeout')), N8N_TIMEOUT_MS),
    );

    try {
      const result = await Promise.race([
        child.handler(
          runtime,
          message,
          state,
          childOptions as Parameters<typeof child.handler>[3],
          callback,
        ),
        timeoutPromise,
      ]);
      return result ?? { success: false };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      logger.error({ src: 'plugin:n8n-workflow:action:n8n', op }, `Failed to ${op}: ${errorMessage}`);
      if (callback) {
        await callback({ text: `Failed to ${op}: ${errorMessage}`, success: false });
      }
      return { success: false };
    }
  },
  examples,
};
