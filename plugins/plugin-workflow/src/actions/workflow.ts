/**
 * WORKFLOW — single umbrella action for workflow lifecycle ops.
 *
 * Action-based dispatch (provide `action` parameter):
 *   create        — generate + deploy a new workflow from a seed prompt
 *   modify        — load a deployed workflow into the draft editor by id
 *   activate      — activate a workflow by id
 *   deactivate    — deactivate a workflow by id
 *   toggle_active — explicit active=true|false (preferred when scripting)
 *   delete        — permanently delete a workflow by id
 *   executions    — fetch recent executions for a workflow id
 *
 * All actions talk to the in-process `WorkflowService` via
 * `runtime.getService(WORKFLOW_SERVICE_TYPE)`. There is no HTTP boundary.
 *
 * Trigger CRUD (create/update/delete/run a scheduled trigger, including
 * promoting a task into a workflow) lives in the agent-side `TRIGGER` action,
 * which uses agent-internal trigger helpers that this plugin cannot import
 * without a dependency cycle.
 */

import {
  type Action,
  type ActionResult,
  type HandlerCallback,
  type HandlerOptions,
  type IAgentRuntime,
  logger,
  type Memory,
  type State,
} from '@elizaos/core';
import { WORKFLOW_SERVICE_TYPE, type WorkflowService } from '../services/workflow-service';
import type {
  WorkflowCreationResult,
  WorkflowDefinition,
  WorkflowDefinitionResponse,
} from '../types/index';

const WORKFLOW_ACTION = 'WORKFLOW';

const WORKFLOW_OPS = [
  'create',
  'modify',
  'activate',
  'deactivate',
  'toggle_active',
  'delete',
  'executions',
] as const;
type WorkflowOp = (typeof WORKFLOW_OPS)[number];

const WORKFLOW_CONTEXTS = ['automation', 'tasks', 'agent_internal'] as const;

interface WorkflowActionParameters {
  action?: unknown;
  op?: unknown;
  seedPrompt?: unknown;
  name?: unknown;
  workflowId?: unknown;
  workflowName?: unknown;
  active?: unknown;
  limit?: unknown;
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function readNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function readBoolean(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const v = value.trim().toLowerCase();
    if (v === 'true' || v === '1' || v === 'yes' || v === 'on') return true;
    if (v === 'false' || v === '0' || v === 'no' || v === 'off') return false;
  }
  return undefined;
}

function readOp(value: unknown): WorkflowOp | undefined {
  const s = readString(value)?.toLowerCase();
  if (!s) return undefined;
  if ((WORKFLOW_OPS as readonly string[]).includes(s)) return s as WorkflowOp;
  return undefined;
}

function getWorkflowService(runtime: IAgentRuntime): WorkflowService | null {
  return (runtime.getService(WORKFLOW_SERVICE_TYPE) as WorkflowService | null) ?? null;
}

function resolveAgentId(runtime: IAgentRuntime): string {
  return runtime.agentId ?? runtime.character?.id ?? '00000000-0000-0000-0000-000000000000';
}

function summarizeWorkflow(
  workflow: WorkflowDefinitionResponse | WorkflowDefinition | WorkflowCreationResult
): {
  id: string;
  name: string;
  active: boolean;
} {
  return {
    id: String((workflow as { id?: string }).id ?? ''),
    name: String(workflow.name ?? ''),
    active: Boolean((workflow as { active?: boolean }).active),
  };
}

async function handleCreate(
  runtime: IAgentRuntime,
  service: WorkflowService,
  params: WorkflowActionParameters,
  message: Memory,
  callback: HandlerCallback | undefined
): Promise<ActionResult> {
  const seedPrompt = readString(params.seedPrompt);
  const name = readString(params.name);
  if (!seedPrompt) {
    return {
      success: false,
      text: 'seedPrompt parameter is required to generate a workflow.',
    };
  }
  try {
    const draft = await service.generateWorkflowDraft(seedPrompt, {
      userId: String(message.entityId ?? resolveAgentId(runtime)),
    });
    if (name) {
      draft.name = name;
    }
    const deployed = await service.deployWorkflow(draft, resolveAgentId(runtime));
    if (!deployed.id) {
      const missing = (deployed.missingCredentials ?? []).map((c) => c.credType).join(', ');
      const text = missing
        ? `Workflow generated but missing credentials: ${missing}.`
        : 'Workflow generation produced no deployable result.';
      return { success: false, text, data: { missingCredentials: deployed.missingCredentials } };
    }
    const text = `Created workflow "${deployed.name}".`;
    if (callback) {
      await callback({
        text,
        action: WORKFLOW_ACTION,
        metadata: { workflowId: deployed.id, workflowName: deployed.name },
      });
    }
    return {
      success: true,
      text,
      values: { workflowId: deployed.id, workflowName: deployed.name },
      data: { workflow: summarizeWorkflow(deployed) },
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn({ src: 'plugin:workflow:action:create' }, message);
    return { success: false, text: message };
  }
}

async function handleModify(
  service: WorkflowService,
  params: WorkflowActionParameters,
  callback: HandlerCallback | undefined
): Promise<ActionResult> {
  const workflowId = readString(params.workflowId);
  if (!workflowId) {
    return { success: false, text: 'workflowId is required to modify a workflow.' };
  }
  try {
    const existing = await service.getWorkflow(workflowId);
    const text = `Loaded workflow "${existing.name}" for editing.`;
    if (callback) {
      await callback({
        text,
        action: WORKFLOW_ACTION,
        metadata: { workflowId, workflowName: existing.name },
      });
    }
    return {
      success: true,
      text,
      values: { workflowId, workflowName: existing.name },
      data: { workflow: existing, awaitingUserInput: true },
    };
  } catch {
    return { success: false, text: `Workflow not found: ${workflowId}` };
  }
}

async function handleToggleActive(
  service: WorkflowService,
  params: WorkflowActionParameters,
  desiredActive: boolean | undefined,
  callback: HandlerCallback | undefined
): Promise<ActionResult> {
  const workflowId = readString(params.workflowId);
  if (!workflowId) {
    return { success: false, text: 'workflowId parameter is required.' };
  }
  const explicitActive = desiredActive ?? readBoolean(params.active);
  if (explicitActive === undefined) {
    return {
      success: false,
      text: 'active parameter is required (true or false).',
    };
  }
  let existing: WorkflowDefinitionResponse;
  try {
    existing = await service.getWorkflow(workflowId);
  } catch {
    return { success: false, text: `Workflow not found: ${workflowId}` };
  }
  try {
    if (explicitActive) {
      await service.activateWorkflow(workflowId);
    } else {
      await service.deactivateWorkflow(workflowId);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn({ src: 'plugin:workflow:action:toggle_active' }, msg);
    return { success: false, text: msg };
  }
  const refreshed = await service.getWorkflow(workflowId);
  const text = explicitActive
    ? `Activated workflow "${existing.name}".`
    : `Deactivated workflow "${existing.name}".`;
  if (callback) {
    await callback({
      text,
      action: WORKFLOW_ACTION,
      metadata: { workflowId, active: explicitActive },
    });
  }
  return {
    success: true,
    text,
    values: { workflowId, active: explicitActive },
    data: { workflow: summarizeWorkflow(refreshed) },
  };
}

async function handleDeleteWorkflow(
  service: WorkflowService,
  params: WorkflowActionParameters,
  callback: HandlerCallback | undefined
): Promise<ActionResult> {
  const workflowId = readString(params.workflowId);
  if (!workflowId) {
    return { success: false, text: 'workflowId parameter is required.' };
  }
  let existing: WorkflowDefinitionResponse;
  try {
    existing = await service.getWorkflow(workflowId);
  } catch {
    return { success: false, text: `Workflow not found: ${workflowId}` };
  }
  try {
    await service.deleteWorkflow(workflowId);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn({ src: 'plugin:workflow:action:delete' }, msg);
    return { success: false, text: msg };
  }
  const text = `Deleted workflow "${existing.name}".`;
  if (callback) {
    await callback({
      text,
      action: WORKFLOW_ACTION,
      metadata: { workflowId, workflowName: existing.name },
    });
  }
  return {
    success: true,
    text,
    data: { workflowId, workflowName: existing.name },
  };
}

async function handleExecutions(
  service: WorkflowService,
  params: WorkflowActionParameters,
  callback: HandlerCallback | undefined
): Promise<ActionResult> {
  const workflowId = readString(params.workflowId);
  if (!workflowId) {
    return { success: false, text: 'workflowId is required to fetch executions.' };
  }
  const limit = readNumber(params.limit) ?? 10;
  try {
    const response = await service.listExecutions({ workflowId, limit });
    const executions = response.data ?? [];
    const text =
      executions.length === 0
        ? `No executions found for workflow ${workflowId}.`
        : `Fetched ${executions.length} executions for workflow ${workflowId}.`;
    if (callback) {
      await callback({
        text,
        action: WORKFLOW_ACTION,
        metadata: { workflowId, count: executions.length },
      });
    }
    return {
      success: true,
      text,
      values: { workflowId, count: executions.length },
      data: { executions },
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn({ src: 'plugin:workflow:action:executions' }, msg);
    return { success: false, text: msg };
  }
}

export const workflowAction: Action = {
  name: WORKFLOW_ACTION,
  contexts: [...WORKFLOW_CONTEXTS],
  contextGate: { anyOf: [...WORKFLOW_CONTEXTS] },
  roleGate: { minRole: 'OWNER' },
  similes: [
    'CREATE_WORKFLOW',
    'DELETE_WORKFLOW',
    'TOGGLE_WORKFLOW_ACTIVE',
    'ACTIVATE_WORKFLOW',
    'DEACTIVATE_WORKFLOW',
    'ENABLE_WORKFLOW',
    'DISABLE_WORKFLOW',
    'PAUSE_WORKFLOW',
    'RESUME_WORKFLOW',
    'MODIFY_WORKFLOW',
    'UPDATE_WORKFLOW',
    'EDIT_WORKFLOW',
    'EDIT_EXISTING_WORKFLOW',
    'UPDATE_EXISTING_WORKFLOW',
    'CHANGE_EXISTING_WORKFLOW',
    'LOAD_WORKFLOW_FOR_EDIT',
    'GET_WORKFLOW_EXECUTIONS',
    'GET_EXECUTIONS',
    'SHOW_EXECUTIONS',
    'EXECUTION_HISTORY',
    'WORKFLOW_RUNS',
    'WORKFLOW_EXECUTIONS',
  ],
  description:
    'Manage workflows. Action-based dispatch - provide an `action` parameter:\n' +
    '  create, modify, activate, deactivate, toggle_active, delete, executions.\n' +
    'For creating/updating scheduled triggers (including promoting a task to a workflow), use the TRIGGER action.',
  descriptionCompressed:
    'manage workflows; action-based dispatch (create modify activate deactivate toggle_active delete executions)',
  parameters: [
    {
      name: 'action',
      description:
        'Operation: create, modify, activate, deactivate, toggle_active, delete, executions.',
      required: true,
      schema: { type: 'string' as const, enum: [...WORKFLOW_OPS] },
    },
    {
      name: 'workflowId',
      description: 'Workflow id.',
      required: false,
      schema: { type: 'string' as const },
    },
    {
      name: 'workflowName',
      description: 'Workflow name fragment for fuzzy matching.',
      required: false,
      schema: { type: 'string' as const },
    },
    {
      name: 'seedPrompt',
      description: 'Natural-language description for action=create.',
      required: false,
      schema: { type: 'string' as const },
    },
    {
      name: 'name',
      description: 'Optional explicit name for created workflow.',
      required: false,
      schema: { type: 'string' as const },
    },
    {
      name: 'active',
      description: 'Target state for action=toggle_active (true to activate).',
      required: false,
      schema: { type: 'boolean' as const },
    },
    {
      name: 'limit',
      description: 'Max executions to return for action=executions (default 10).',
      required: false,
      schema: { type: 'number' as const },
    },
  ],
  validate: async (runtime: IAgentRuntime, _message: Memory, _state?: State): Promise<boolean> => {
    return getWorkflowService(runtime) !== null;
  },
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
    options?: HandlerOptions,
    callback?: HandlerCallback
  ): Promise<ActionResult> => {
    const params = (options?.parameters ?? {}) as WorkflowActionParameters;
    const op = readOp(params.action ?? params.op);
    if (!op) {
      return {
        success: false,
        text: `action parameter is required (one of: ${WORKFLOW_OPS.join(', ')}).`,
      };
    }
    const service = getWorkflowService(runtime);
    if (!service) {
      return { success: false, text: 'Workflow service is not registered.' };
    }
    switch (op) {
      case 'create':
        return handleCreate(runtime, service, params, message, callback);
      case 'modify':
        return handleModify(service, params, callback);
      case 'activate':
        return handleToggleActive(service, params, true, callback);
      case 'deactivate':
        return handleToggleActive(service, params, false, callback);
      case 'toggle_active':
        return handleToggleActive(service, params, undefined, callback);
      case 'delete':
        return handleDeleteWorkflow(service, params, callback);
      case 'executions':
        return handleExecutions(service, params, callback);
    }
  },
  examples: [
    [
      {
        name: '{{name1}}',
        content: {
          text: 'Create a workflow that posts daily summaries to Slack at 5pm.',
          source: 'chat',
        },
      },
      {
        name: '{{agentName}}',
        content: {
          text: 'Generating the workflow.',
          actions: ['WORKFLOW'],
          thought:
            'New workflow from a natural-language seed maps to WORKFLOW op=create with seedPrompt set.',
        },
      },
    ],
    [
      {
        name: '{{name1}}',
        content: { text: 'Pause the daily summary workflow.', source: 'chat' },
      },
      {
        name: '{{agentName}}',
        content: {
          text: 'Deactivating the workflow.',
          actions: ['WORKFLOW'],
          thought:
            'Pause/disable maps to WORKFLOW op=deactivate (or toggle_active with active=false) on the matching workflowId.',
        },
      },
    ],
    [
      {
        name: '{{name1}}',
        content: { text: 'Show me the last 5 executions of workflow wf-123.', source: 'chat' },
      },
      {
        name: '{{agentName}}',
        content: {
          text: 'Fetching recent executions.',
          actions: ['WORKFLOW'],
          thought:
            'Execution history maps to WORKFLOW op=executions with workflowId=wf-123 and limit=5.',
        },
      },
    ],
  ],
};
