/**
 * WORKFLOW — single umbrella action for workflow lifecycle ops.
 *
 * Action-based dispatch (provide `action` parameter):
 *   list          — list deployed workflows for the current user
 *   get           — fetch one deployed workflow definition by id
 *   create        — generate + deploy a new workflow from a seed prompt
 *   modify        — load a deployed workflow into the draft editor by id
 *   activate      — activate a workflow by id
 *   deactivate    — deactivate a workflow by id
 *   toggle_active — explicit active=true|false (preferred when scripting)
 *   delete        — permanently delete a workflow by id
 *   run           — run a workflow immediately
 *   executions    — fetch recent executions for a workflow id
 *   revisions     — fetch restorable workflow versions
 *   restore       — restore a workflow by version id
 *   diagnose      — inspect a failed/recent workflow execution
 *   eval_samples  — generate JSONL evaluation samples from recent executions
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
  WorkflowExecution,
} from '../types/index';
import {
  buildWorkflowExecutionDiagnostics,
  getWorkflowExecutionError,
  summarizeWorkflowExecution,
} from '../utils/execution-diagnostics';

const WORKFLOW_ACTION = 'WORKFLOW';

const WORKFLOW_OPS = [
  'list',
  'search',
  'get',
  'create',
  'modify',
  'activate',
  'deactivate',
  'toggle_active',
  'delete',
  'run',
  'executions',
  'revisions',
  'restore',
  'diagnose',
  'eval_samples',
] as const;
type WorkflowOp = (typeof WORKFLOW_OPS)[number];

// `general` (the active context a plain chat/Telegram turn actually seeds) is
// included so a message like "find my Slack workflow" routes to WORKFLOW search,
// not just automation/agent-internal turns (#8913). The gate matches active
// contexts literally; `chat` is only an alias of the `general` *definition* and is
// NOT expanded by normalizeContextList, so listing `chat` here would be inert.
const WORKFLOW_CONTEXTS = ['general', 'automation', 'tasks', 'agent_internal'] as const;

interface WorkflowActionParameters {
  action?: unknown;
  op?: unknown;
  seedPrompt?: unknown;
  name?: unknown;
  workflowId?: unknown;
  workflowName?: unknown;
  executionId?: unknown;
  active?: unknown;
  limit?: unknown;
  versionId?: unknown;
  query?: unknown;
  q?: unknown;
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
  return runtime.agentId;
}

function summarizeWorkflow(
  workflow: WorkflowDefinitionResponse | WorkflowDefinition | WorkflowCreationResult
): {
  id: string;
  name: string;
  active: boolean;
  nodeCount?: number;
} {
  const nodes = (workflow as { nodes?: unknown[]; nodeCount?: number }).nodes;
  const nodeCount =
    typeof (workflow as { nodeCount?: unknown }).nodeCount === 'number'
      ? (workflow as { nodeCount: number }).nodeCount
      : Array.isArray(nodes)
        ? nodes.length
        : undefined;
  return {
    id: String((workflow as { id?: string }).id ?? ''),
    name: String(workflow.name),
    active: Boolean((workflow as { active?: boolean }).active),
    ...(typeof nodeCount === 'number' ? { nodeCount } : {}),
  };
}

async function handleListWorkflows(
  service: WorkflowService,
  params: WorkflowActionParameters,
  message: Memory,
  callback: HandlerCallback | undefined
): Promise<ActionResult> {
  const limit = Math.min(Math.max(1, readNumber(params.limit) ?? 20), 50);
  try {
    const workflows = await service.listWorkflows(String(message.entityId));
    const summaries = workflows.slice(0, limit).map(summarizeWorkflow);
    const text =
      summaries.length === 0
        ? 'No workflows found.'
        : `Found ${summaries.length} workflow${summaries.length === 1 ? '' : 's'}.`;
    if (callback) {
      await callback({
        text,
        action: WORKFLOW_ACTION,
        metadata: { count: summaries.length },
      });
    }
    return {
      success: true,
      text,
      values: { count: summaries.length },
      data: { workflows: summaries, total: workflows.length },
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn({ src: 'plugin:workflow:action:list' }, message);
    return { success: false, text: message };
  }
}

async function handleSearchWorkflows(
  service: WorkflowService,
  params: WorkflowActionParameters,
  message: Memory,
  callback: HandlerCallback | undefined
): Promise<ActionResult> {
  const query = readString(params.query) ?? readString(params.q);
  if (!query) {
    return {
      success: false,
      text: 'A search `query` is required (free text to match workflow name / node type / description).',
    };
  }
  const limit = Math.min(Math.max(1, readNumber(params.limit) ?? 20), 50);
  try {
    const matches = await service.searchWorkflows(query, String(message.entityId));
    const summaries = matches.slice(0, limit).map(summarizeWorkflow);
    const text =
      summaries.length === 0
        ? `No workflows match "${query}".`
        : `Found ${summaries.length} workflow${summaries.length === 1 ? '' : 's'} matching "${query}".`;
    if (callback) {
      await callback({
        text,
        action: WORKFLOW_ACTION,
        metadata: { count: summaries.length, query },
      });
    }
    return {
      success: true,
      text,
      values: { count: summaries.length },
      data: { workflows: summaries, total: matches.length, query },
    };
  } catch (err) {
    const errMessage = err instanceof Error ? err.message : String(err);
    logger.warn({ src: 'plugin:workflow:action:search' }, errMessage);
    return { success: false, text: errMessage };
  }
}

async function handleGetWorkflow(
  service: WorkflowService,
  params: WorkflowActionParameters,
  callback: HandlerCallback | undefined
): Promise<ActionResult> {
  const workflowId = readString(params.workflowId);
  if (!workflowId) {
    return { success: false, text: 'workflowId is required to review a workflow.' };
  }
  try {
    const workflow = await service.getWorkflow(workflowId);
    const text = `Fetched workflow "${workflow.name}" for review.`;
    if (callback) {
      await callback({
        text,
        action: WORKFLOW_ACTION,
        metadata: { workflowId, workflowName: workflow.name },
      });
    }
    return {
      success: true,
      text,
      values: {
        workflowId,
        workflowName: workflow.name,
        active: Boolean(workflow.active),
        nodeCount: workflow.nodes.length,
      },
      data: { workflow },
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn({ src: 'plugin:workflow:action:get' }, message);
    return { success: false, text: message };
  }
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
      userId: String(message.entityId),
    });
    if (name) {
      draft.name = name;
    }
    const deployed = await service.deployWorkflow(draft, resolveAgentId(runtime));
    if (!deployed.id) {
      const missing = deployed.missingCredentials.map((c) => c.credType).join(', ');
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
    const executions = response.data;
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

async function handleRunWorkflow(
  service: WorkflowService,
  params: WorkflowActionParameters,
  callback: HandlerCallback | undefined
): Promise<ActionResult> {
  const workflowId = readString(params.workflowId);
  if (!workflowId) {
    return { success: false, text: 'workflowId is required to run a workflow.' };
  }
  try {
    const execution = await service.runWorkflow(workflowId, { throwOnError: false });
    const text = `Ran workflow ${workflowId}: ${execution.status}.`;
    if (callback) {
      await callback({
        text,
        action: WORKFLOW_ACTION,
        metadata: { workflowId, executionId: execution.id, status: execution.status },
      });
    }
    return {
      success: execution.status !== 'error' && execution.status !== 'crashed',
      text,
      values: { workflowId, executionId: execution.id, status: execution.status },
      data: { execution },
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn({ src: 'plugin:workflow:action:run' }, msg);
    return { success: false, text: msg };
  }
}

async function handleRevisions(
  service: WorkflowService,
  params: WorkflowActionParameters,
  callback: HandlerCallback | undefined
): Promise<ActionResult> {
  const workflowId = readString(params.workflowId);
  if (!workflowId) {
    return { success: false, text: 'workflowId is required to fetch workflow revisions.' };
  }
  const limit = readNumber(params.limit) ?? 10;
  try {
    const revisions = await service.listWorkflowRevisions(workflowId, limit);
    const text =
      revisions.length === 0
        ? `No revisions found for workflow ${workflowId}.`
        : `Fetched ${revisions.length} revisions for workflow ${workflowId}.`;
    if (callback) {
      await callback({
        text,
        action: WORKFLOW_ACTION,
        metadata: { workflowId, count: revisions.length },
      });
    }
    return {
      success: true,
      text,
      values: { workflowId, count: revisions.length },
      data: { revisions },
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn({ src: 'plugin:workflow:action:revisions' }, msg);
    return { success: false, text: msg };
  }
}

async function handleRestoreRevision(
  service: WorkflowService,
  params: WorkflowActionParameters,
  callback: HandlerCallback | undefined
): Promise<ActionResult> {
  const workflowId = readString(params.workflowId);
  const versionId = readString(params.versionId);
  if (!workflowId) {
    return { success: false, text: 'workflowId is required to restore a workflow revision.' };
  }
  if (!versionId) {
    return { success: false, text: 'versionId is required to restore a workflow revision.' };
  }
  try {
    const workflow = await service.restoreWorkflowRevision(workflowId, versionId);
    const text = `Restored workflow "${workflow.name}".`;
    if (callback) {
      await callback({
        text,
        action: WORKFLOW_ACTION,
        metadata: { workflowId, versionId, workflowName: workflow.name },
      });
    }
    return {
      success: true,
      text,
      values: { workflowId, workflowName: workflow.name, versionId },
      data: { workflow: summarizeWorkflow(workflow) },
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn({ src: 'plugin:workflow:action:restore' }, msg);
    return { success: false, text: msg };
  }
}

function isProblemExecution(execution: WorkflowExecution): boolean {
  return (
    execution.status === 'error' ||
    execution.status === 'crashed' ||
    execution.status === 'canceled' ||
    Boolean(getWorkflowExecutionError(execution))
  );
}

async function handleDiagnoseExecution(
  service: WorkflowService,
  params: WorkflowActionParameters,
  callback: HandlerCallback | undefined
): Promise<ActionResult> {
  const workflowId = readString(params.workflowId);
  const executionId = readString(params.executionId);
  const limit = Math.min(Math.max(1, readNumber(params.limit) ?? 10), 50);
  if (!executionId && !workflowId) {
    return {
      success: false,
      text: 'workflowId or executionId is required to diagnose a workflow run.',
    };
  }

  try {
    let execution: WorkflowExecution | undefined;
    if (executionId) {
      execution = await service.getExecutionDetail(executionId);
      if (workflowId && execution.workflowId !== workflowId) {
        return {
          success: false,
          text: `Execution ${executionId} belongs to workflow ${execution.workflowId}, not ${workflowId}.`,
        };
      }
    } else if (workflowId) {
      const response = await service.listExecutions({ workflowId, limit });
      execution = response.data.find(isProblemExecution) ?? response.data[0];
      if (!execution) {
        return {
          success: false,
          text: `No executions found for workflow ${workflowId}. Run it before diagnosing.`,
        };
      }
    }

    if (!execution) {
      return { success: false, text: 'No workflow execution was available to diagnose.' };
    }

    const summary = summarizeWorkflowExecution(execution);
    const diagnostics = buildWorkflowExecutionDiagnostics(execution);
    const text = summary.error
      ? `Diagnosed workflow ${execution.workflowId} execution ${execution.id}: ${summary.statusLabel} - ${summary.error}`
      : `Diagnosed workflow ${execution.workflowId} execution ${execution.id}: ${summary.statusLabel}.`;
    if (callback) {
      await callback({
        text,
        action: WORKFLOW_ACTION,
        metadata: {
          workflowId: execution.workflowId,
          executionId: execution.id,
          status: execution.status,
          ...(summary.error ? { error: summary.error } : {}),
        },
      });
    }
    return {
      success: true,
      text,
      values: {
        workflowId: execution.workflowId,
        executionId: execution.id,
        status: execution.status,
        ...(summary.error ? { error: summary.error } : {}),
      },
      data: { execution, summary, diagnostics },
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn({ src: 'plugin:workflow:action:diagnose' }, msg);
    return { success: false, text: msg };
  }
}

async function handleEvaluationSamples(
  service: WorkflowService,
  params: WorkflowActionParameters,
  callback: HandlerCallback | undefined
): Promise<ActionResult> {
  const workflowId = readString(params.workflowId);
  if (!workflowId) {
    return {
      success: false,
      text: 'workflowId is required to generate workflow evaluation samples.',
    };
  }
  const limit = readNumber(params.limit) ?? 10;
  try {
    const suite = await service.getWorkflowEvaluationSuite(workflowId, limit);
    const text =
      suite.sampleCount === 0
        ? `No executions found for workflow ${workflowId}; run it before generating eval samples.`
        : [
            `Generated ${suite.sampleCount} workflow eval sample${suite.sampleCount === 1 ? '' : 's'} for ${workflowId}.`,
            `Save cases to ${suite.optimizer.caseFile}.`,
            `Eval: ${suite.optimizer.recommendedEvalCommand}`,
            `Optimize: ${suite.optimizer.recommendedOptimizeCommand}`,
          ].join('\n');
    if (callback) {
      await callback({
        text,
        action: WORKFLOW_ACTION,
        metadata: {
          workflowId,
          count: suite.sampleCount,
          caseFile: suite.optimizer.caseFile,
          suiteName: suite.optimizer.suiteName,
        },
      });
    }
    return {
      success: true,
      text,
      values: {
        workflowId,
        count: suite.sampleCount,
        caseFile: suite.optimizer.caseFile,
        suiteName: suite.optimizer.suiteName,
      },
      data: { suite },
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn({ src: 'plugin:workflow:action:eval_samples' }, msg);
    return { success: false, text: msg };
  }
}

export const workflowAction: Action = {
  name: WORKFLOW_ACTION,
  contexts: [...WORKFLOW_CONTEXTS],
  contextGate: { anyOf: [...WORKFLOW_CONTEXTS] },
  roleGate: { minRole: 'OWNER' },
  similes: [
    'LIST_WORKFLOWS',
    'SHOW_WORKFLOWS',
    'GET_WORKFLOW',
    'REVIEW_WORKFLOW',
    'CREATE_WORKFLOW',
    'DELETE_WORKFLOW',
    'RUN_WORKFLOW',
    'RUN_WORKFLOW_NOW',
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
    'WORKFLOW_REVISIONS',
    'RESTORE_WORKFLOW',
    'ROLL_BACK_WORKFLOW',
    'ROLLBACK_WORKFLOW',
    'DIAGNOSE_WORKFLOW',
    'TROUBLESHOOT_WORKFLOW',
    'EXPLAIN_WORKFLOW_FAILURE',
    'GET_WORKFLOW_DIAGNOSTICS',
    'WORKFLOW_RUN_DIAGNOSTICS',
    'WORKFLOW_EVAL_SAMPLES',
    'GENERATE_WORKFLOW_TRAINING_SAMPLES',
    'GENERATE_WORKFLOW_EVAL_CASES',
    'GEPA_WORKFLOW_SAMPLES',
    'OPTIMIZE_WORKFLOW_SAMPLES',
  ],
  description:
    'Manage workflows. Action-based dispatch - provide an `action` parameter:\n' +
    '  list, get, create, modify, activate, deactivate, toggle_active, delete, run, executions, revisions, restore, diagnose, eval_samples.\n' +
    'For creating/updating scheduled triggers (including promoting a task to a workflow), use the TRIGGER action.',
  descriptionCompressed:
    'workflow list|get|create|modify|activate|deactivate|toggle_active|delete|run|executions|revisions|restore|diagnose|eval_samples',
  parameters: [
    {
      name: 'action',
      description:
        'Operation: list, get, search, create, modify, activate, deactivate, toggle_active, delete, run, executions, revisions, restore, diagnose, eval_samples.',
      required: true,
      schema: { type: 'string' as const, enum: [...WORKFLOW_OPS] },
    },
    {
      name: 'query',
      description: 'Free text to match a workflow by name / node type for action=search.',
      required: false,
      schema: { type: 'string' as const },
    },
    {
      name: 'workflowId',
      description: 'Workflow id.',
      required: false,
      schema: { type: 'string' as const },
    },
    {
      name: 'executionId',
      description: 'Workflow execution id for action=diagnose.',
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
      description: 'Max executions/revisions/evaluation samples to return (default 10).',
      required: false,
      schema: { type: 'number' as const },
    },
    {
      name: 'versionId',
      description: 'Workflow version id for action=restore.',
      required: false,
      schema: { type: 'string' as const },
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
      case 'list':
        return handleListWorkflows(service, params, message, callback);
      case 'search':
        return handleSearchWorkflows(service, params, message, callback);
      case 'get':
        return handleGetWorkflow(service, params, callback);
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
      case 'run':
        return handleRunWorkflow(service, params, callback);
      case 'executions':
        return handleExecutions(service, params, callback);
      case 'revisions':
        return handleRevisions(service, params, callback);
      case 'restore':
        return handleRestoreRevision(service, params, callback);
      case 'diagnose':
        return handleDiagnoseExecution(service, params, callback);
      case 'eval_samples':
        return handleEvaluationSamples(service, params, callback);
    }
  },
  examples: [
    [
      {
        name: '{{name1}}',
        content: { text: 'Show my workflows.', source: 'chat' },
      },
      {
        name: '{{agentName}}',
        content: {
          text: 'Fetching workflows.',
          actions: ['WORKFLOW'],
          thought: 'Workflow inventory maps to WORKFLOW op=list.',
        },
      },
    ],
    [
      {
        name: '{{name1}}',
        content: { text: 'Review workflow wf-123.', source: 'chat' },
      },
      {
        name: '{{agentName}}',
        content: {
          text: 'Fetching the workflow definition.',
          actions: ['WORKFLOW'],
          thought: 'Workflow review maps to WORKFLOW op=get with workflowId=wf-123.',
        },
      },
    ],
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
    [
      {
        name: '{{name1}}',
        content: { text: 'Roll back workflow wf-123 to version v-old.', source: 'chat' },
      },
      {
        name: '{{agentName}}',
        content: {
          text: 'Restoring the workflow version.',
          actions: ['WORKFLOW'],
          thought:
            'Rollback maps to WORKFLOW op=restore with workflowId=wf-123 and versionId=v-old.',
        },
      },
    ],
    [
      {
        name: '{{name1}}',
        content: {
          text: 'Create eval samples from the last 10 runs of workflow wf-123.',
          source: 'chat',
        },
      },
      {
        name: '{{agentName}}',
        content: {
          text: 'Generating workflow eval samples.',
          actions: ['WORKFLOW'],
          thought:
            'Eval sample generation maps to WORKFLOW op=eval_samples with workflowId=wf-123 and limit=10.',
        },
      },
    ],
  ],
};
