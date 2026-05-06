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
        text: 'Show me the execution history for the Stripe workflow',
      },
    },
    {
      name: '{{agent}}',
      content: {
        text: "I'll fetch the execution history for that workflow.",
        actions: ['GET_N8N_EXECUTIONS'],
      },
    },
  ],
  [
    {
      name: '{{user1}}',
      content: {
        text: 'How did the email automation run last time?',
      },
    },
    {
      name: '{{agent}}',
      content: {
        text: 'Let me check the recent runs for that workflow.',
        actions: ['GET_N8N_EXECUTIONS'],
      },
    },
  ],
];

type GetExecutionsOptions = {
  parameters?: {
    workflowId?: unknown;
    workflowName?: unknown;
    limit?: unknown;
  };
};

export const getExecutionsAction: Action = {
  name: 'GET_N8N_EXECUTIONS',
  similes: [
    'GET_EXECUTIONS',
    'SHOW_EXECUTIONS',
    'EXECUTION_HISTORY',
    'WORKFLOW_RUNS',
    'WORKFLOW_EXECUTIONS',
  ],
  description:
    'Get execution history for an n8n workflow. Shows status, start time, and error messages if any. Identifies workflows by ID, name, or semantic description in any language.',
  descriptionCompressed:
    'get execution history n8n workflow show status, start time, error message identify workflow ID, name, semantic description language',

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
      return sendGetExecutionsServiceMissing(callback);
    }

    try {
      return await runGetExecutionsHandler(runtime, service, message, state, options, callback);
    } catch (error) {
      return sendGetExecutionsError(error, callback);
    }
  },

  parameters: [
    {
      name: 'workflowId',
      description: 'Exact n8n workflow id to inspect.',
      required: false,
      schema: { type: 'string' as const },
    },
    {
      name: 'workflowName',
      description: 'Workflow name or partial name when id is unknown.',
      required: false,
      schema: { type: 'string' as const },
    },
    {
      name: 'limit',
      description: 'Maximum number of executions to return.',
      required: false,
      schema: { type: 'number' as const },
    },
  ],

  examples,
};

async function sendGetExecutionsServiceMissing(callback?: HandlerCallback): Promise<ActionResult> {
  logger.error(
    { src: 'plugin:n8n-workflow:action:get-executions' },
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

function parseGetExecutionsParams(options: unknown): {
  limit: number;
  workflowIdParam: string | null;
  workflowNameParam: string | null;
} {
  const params = (options as GetExecutionsOptions | undefined)?.parameters ?? {};
  return {
    limit:
      typeof params.limit === 'number' && Number.isFinite(params.limit)
        ? Math.max(1, Math.floor(params.limit))
        : 10,
    workflowIdParam:
      typeof params.workflowId === 'string' && params.workflowId.trim().length > 0
        ? params.workflowId.trim()
        : null,
    workflowNameParam:
      typeof params.workflowName === 'string' && params.workflowName.trim().length > 0
        ? params.workflowName.trim().toLowerCase()
        : null,
  };
}

async function resolveExecutionWorkflowMatch(
  runtime: IAgentRuntime,
  message: Memory,
  state: State | undefined,
  workflows: Awaited<ReturnType<N8nWorkflowService['listWorkflows']>>,
  options: unknown
): Promise<Awaited<ReturnType<typeof matchWorkflow>>> {
  const { workflowIdParam, workflowNameParam } = parseGetExecutionsParams(options);
  if (workflowIdParam) {
    return {
      matchedWorkflowId: workflowIdParam,
      confidence: 'high' as const,
      matches: workflows.map((workflow) => ({
        id: workflow.id,
        name: workflow.name,
        score: workflow.id === workflowIdParam ? 1 : 0,
      })),
      reason: 'workflowId parameter',
    };
  }
  if (!workflowNameParam) {
    return matchWorkflow(runtime, buildConversationContext(message, state), workflows);
  }
  return {
    matchedWorkflowId:
      workflows.find((workflow) => workflow.name.toLowerCase().includes(workflowNameParam))?.id ??
      null,
    confidence: 'high' as const,
    matches: workflows.map((workflow) => ({
      id: workflow.id,
      name: workflow.name,
      score: workflow.name.toLowerCase().includes(workflowNameParam) ? 1 : 0,
    })),
    reason: 'workflowName parameter',
  };
}

function formatExecutionHistory(
  executions: Awaited<ReturnType<N8nWorkflowService['getWorkflowExecutions']>>
): string {
  return executions.map(formatExecutionHistoryEntry).join('');
}

function formatExecutionHistoryEntry(
  execution: Awaited<ReturnType<N8nWorkflowService['getWorkflowExecutions']>>[number]
): string {
  const statusEmoji =
    execution.status === 'success'
      ? '✅'
      : execution.status === 'error'
        ? '❌'
        : execution.status === 'running'
          ? '⏳'
          : '⏸️';
  const lines = [
    `${statusEmoji} ${execution.status.toUpperCase()}`,
    `   Execution ID: ${execution.id}`,
    `   Started: ${new Date(execution.startedAt).toLocaleString()}`,
  ];
  if (execution.stoppedAt) {
    lines.push(`   Finished: ${new Date(execution.stoppedAt).toLocaleString()}`);
  }
  if (execution.data?.resultData?.error) {
    lines.push(`   Error: ${execution.data.resultData.error.message}`);
  }
  return `${lines.join('\n')}\n\n`;
}

async function runGetExecutionsHandler(
  runtime: IAgentRuntime,
  service: N8nWorkflowService,
  message: Memory,
  state: State | undefined,
  options: unknown,
  callback?: HandlerCallback
): Promise<ActionResult> {
  const userId = message.entityId;
  const workflows = await service.listWorkflows(userId);
  if (workflows.length === 0) {
    if (callback) {
      await callback({
        text: 'No workflows available to check executions for.',
        success: false,
      });
    }
    return { success: false };
  }

  const matchResult = await resolveExecutionWorkflowMatch(
    runtime,
    message,
    state,
    workflows,
    options
  );
  if (!matchResult.matchedWorkflowId || matchResult.confidence === 'none') {
    const workflowList = matchResult.matches.map((m) => `- ${m.name} (ID: ${m.id})`).join('\n');
    if (callback) {
      await callback({
        text: `Could not identify which workflow to check. Available workflows:\n${workflowList}`,
        success: false,
      });
    }
    return { success: false };
  }

  const { limit } = parseGetExecutionsParams(options);
  const executions = await service.getWorkflowExecutions(matchResult.matchedWorkflowId, limit);
  logger.info(
    { src: 'plugin:n8n-workflow:action:get-executions' },
    `Retrieved ${executions.length} executions for workflow ${matchResult.matchedWorkflowId}`
  );
  if (executions.length === 0) {
    if (callback) {
      await callback({
        text: `No executions found for workflow ${matchResult.matchedWorkflowId}. The workflow may not have run yet.`,
        success: true,
      });
    }
    return { success: true, data: { executions: [] } };
  }

  const responseText = `📊 **Execution History** (Last ${executions.length} runs)\n\n${formatExecutionHistory(executions)}`;
  if (callback) await callback({ text: responseText, success: true });
  return { success: true, data: { executions } };
}

async function sendGetExecutionsError(
  error: unknown,
  callback?: HandlerCallback
): Promise<ActionResult> {
  const errorMessage = error instanceof Error ? error.message : 'Unknown error';
  logger.error(
    { src: 'plugin:n8n-workflow:action:get-executions' },
    `Failed to get executions: ${errorMessage}`
  );
  if (callback) {
    await callback({
      text: `Failed to get executions: ${errorMessage}`,
      success: false,
    });
  }
  return { success: false };
}
