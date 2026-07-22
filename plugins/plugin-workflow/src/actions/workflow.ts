/**
 * WORKFLOW — single umbrella action for workflow lifecycle ops.
 *
 * Action-based dispatch (provide `action` parameter):
 *   list          — list deployed workflows for the current user
 *   get           — fetch one deployed workflow definition by id
 *   create        — generate + deploy a new workflow from a seed prompt
 *   cancel        — discard the pending workflow draft in this conversation
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
  resolveCanonicalOwnerIdForMessage,
  type State,
} from '@elizaos/core';
import { invalidateAutomationExecutionCache } from '../lib/automations-builder';
import {
  clearPendingWorkflowDraft,
  getPendingWorkflowDraftScope,
  persistPendingWorkflowDraft,
  readPendingWorkflowDraft,
} from '../lib/pending-workflow-draft';
import {
  applyResolutions,
  coerceClarifications,
  pruneResolvedClarifications,
  type WorkflowClarificationResolution,
} from '../lib/workflow-clarification';
import { WORKFLOW_SERVICE_TYPE, type WorkflowService } from '../services/workflow-service';
import type {
  WorkflowCreationResult,
  WorkflowDefinition,
  WorkflowDefinitionResponse,
  WorkflowDraft,
  WorkflowExecution,
} from '../types/index';
import { getLocalOwnerEntityId } from '../utils/context';
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
  'cancel',
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
  draft?: unknown;
  resolutions?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isWorkflowDefinition(value: unknown): value is WorkflowDefinition {
  return (
    isRecord(value) &&
    typeof value.name === 'string' &&
    Array.isArray(value.nodes) &&
    value.nodes.every(isRecord) &&
    isRecord(value.connections)
  );
}

function readWorkflowDraft(value: unknown): WorkflowDefinition | undefined {
  return isWorkflowDefinition(value) ? value : undefined;
}

function readClarificationResolutions(
  value: unknown
): WorkflowClarificationResolution[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const resolutions: WorkflowClarificationResolution[] = [];
  for (const item of value) {
    if (!isRecord(item) || typeof item.paramPath !== 'string' || typeof item.value !== 'string') {
      return undefined;
    }
    resolutions.push({ paramPath: item.paramPath, value: item.value });
  }
  return resolutions;
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
  ownerEntityId: string,
  callback: HandlerCallback | undefined
): Promise<ActionResult> {
  const limit = Math.min(Math.max(1, readNumber(params.limit) ?? 20), 50);
  try {
    const workflows = await service.listWorkflows(ownerEntityId);
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
  ownerEntityId: string,
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
    const matches = await service.searchWorkflows(query, ownerEntityId);
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
  ownerEntityId: string,
  callback: HandlerCallback | undefined
): Promise<ActionResult> {
  const workflowId = readString(params.workflowId);
  if (!workflowId) {
    return { success: false, text: 'workflowId is required to review a workflow.' };
  }
  try {
    const workflow = await service.getWorkflow(workflowId, ownerEntityId);
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
  message: Memory,
  service: WorkflowService,
  params: WorkflowActionParameters,
  ownerEntityId: string,
  callback: HandlerCallback | undefined
): Promise<ActionResult> {
  const seedPrompt = readString(params.seedPrompt);
  const name = readString(params.name);
  const explicitDraft = readWorkflowDraft(params.draft);
  if (params.draft !== undefined && !explicitDraft) {
    return {
      success: false,
      text: 'A valid workflow draft is required to continue clarification.',
    };
  }
  try {
    const scope = getPendingWorkflowDraftScope(message, ownerEntityId);
    const pendingDraft = await readPendingWorkflowDraft(runtime, scope);
    const cachedContinuation =
      !explicitDraft && pendingDraft && (params.resolutions !== undefined || !seedPrompt)
        ? pendingDraft
        : null;
    const continuedWorkflow = explicitDraft ?? cachedContinuation?.workflow;
    if (!seedPrompt && !continuedWorkflow) {
      return {
        success: false,
        text: 'seedPrompt or a pending draft is required to create a workflow.',
      };
    }
    if (params.resolutions !== undefined && !continuedWorkflow) {
      return {
        success: false,
        text: 'No pending workflow draft exists in this conversation for those resolutions.',
      };
    }

    // Clarification application mutates the workflow. A detached copy keeps a
    // rejected answer from corrupting the last valid cache entry.
    const draft = continuedWorkflow
      ? structuredClone(continuedWorkflow)
      : await service.generateWorkflowDraft(seedPrompt as string, {
          userId: ownerEntityId,
        });
    if (continuedWorkflow && params.resolutions !== undefined) {
      const resolutions = readClarificationResolutions(params.resolutions);
      if (!resolutions) {
        return {
          success: false,
          text: 'Clarification resolutions must be an array of { paramPath, value } entries.',
        };
      }
      const resolutionResult = applyResolutions(draft, resolutions);
      if (!resolutionResult.ok) {
        return {
          success: false,
          text: resolutionResult.error,
          data: { status: 'invalid_clarification', paramPath: resolutionResult.paramPath },
        };
      }
      const resolvedPaths = new Set(
        resolutions.map((resolution) => resolution.paramPath).filter((path) => path.length > 0)
      );
      const freeFormCount = resolutions.filter(
        (resolution) => resolution.paramPath.length === 0
      ).length;
      pruneResolvedClarifications(draft, resolvedPaths, freeFormCount);
    }
    if (name) {
      draft.name = name;
    }
    const clarifications = coerceClarifications(draft._meta?.requiresClarification);
    if (clarifications.length > 0) {
      const storedDraft: WorkflowDraft = {
        workflow: draft,
        prompt:
          cachedContinuation?.prompt ??
          seedPrompt ??
          pendingDraft?.prompt ??
          `Continue workflow "${draft.name}"`,
        userId: ownerEntityId,
        createdAt: Date.now(),
        originMessageId:
          cachedContinuation?.originMessageId ??
          pendingDraft?.originMessageId ??
          (typeof message.id === 'string' ? message.id : undefined),
      };
      await persistPendingWorkflowDraft(runtime, scope, storedDraft);
      const text = `I need ${clarifications.length} clarification${clarifications.length === 1 ? '' : 's'} before I can create this workflow: ${clarifications
        .map((clarification, index) => `${index + 1}. ${clarification.question}`)
        .join(' ')}`;
      const data = { status: 'needs_clarification', draft, clarifications } as const;
      if (callback) {
        await callback({
          text,
          action: WORKFLOW_ACTION,
          metadata: {
            status: data.status,
            clarificationCount: clarifications.length,
            clarificationQuestions: clarifications.map((clarification) => clarification.question),
          },
        });
      }
      return {
        success: false,
        text,
        values: { status: data.status, clarificationCount: clarifications.length },
        data,
      };
    }
    const deployed = await service.deployWorkflow(draft, ownerEntityId, {
      activate: readBoolean(params.active),
    });
    if (deployed.id) {
      invalidateAutomationExecutionCache(service, ownerEntityId, deployed.id);
    }
    if (!deployed.id) {
      const missing = deployed.missingCredentials.map((c) => c.credType).join(', ');
      const text = missing
        ? `Workflow generated but missing credentials: ${missing}.`
        : 'Workflow generation produced no deployable result.';
      return { success: false, text, data: { missingCredentials: deployed.missingCredentials } };
    }
    let pendingDraftWarning: { code: string; message: string } | undefined;
    if (pendingDraft) {
      try {
        await clearPendingWorkflowDraft(runtime, scope);
      } catch (err) {
        // error-policy:J6 post-commit cache cleanup cannot roll back a deployed workflow.
        const detail = err instanceof Error ? err.message : String(err);
        const code =
          isRecord(err) && typeof err.code === 'string'
            ? err.code
            : 'WORKFLOW_PENDING_DRAFT_CLEAR_FAILED';
        pendingDraftWarning = {
          code,
          message:
            'The workflow was created, but its pending chat draft could not be cleared. Do not retry creation.',
        };
        logger.warn(
          { src: 'plugin:workflow:action:create', workflowId: deployed.id, detail },
          pendingDraftWarning.message
        );
        runtime.reportError('WorkflowAction.pendingDraftClearAfterDeploy', err, {
          workflowId: deployed.id,
          ownerEntityId,
          roomId: scope.roomId,
        });
      }
    }
    const deployedText = deployed.active
      ? `Created and activated workflow "${deployed.name}".`
      : `Created draft workflow "${deployed.name}".`;
    const text = pendingDraftWarning
      ? `${deployedText} ${pendingDraftWarning.message}`
      : deployedText;
    if (callback) {
      await callback({
        text,
        action: WORKFLOW_ACTION,
        metadata: {
          workflowId: deployed.id,
          workflowName: deployed.name,
          ...(pendingDraftWarning ? { warningCode: pendingDraftWarning.code } : {}),
        },
      });
    }
    return {
      success: true,
      text,
      values: {
        workflowId: deployed.id,
        workflowName: deployed.name,
        active: deployed.active,
        ...(pendingDraftWarning ? { warning: true } : {}),
      },
      data: {
        workflow: summarizeWorkflow(deployed),
        ...(pendingDraftWarning ? { warning: pendingDraftWarning } : {}),
      },
    };
  } catch (err) {
    // error-policy:J1 action-boundary translation returns cache failures as a failed tool result.
    const message = err instanceof Error ? err.message : String(err);
    logger.warn({ src: 'plugin:workflow:action:create' }, message);
    return { success: false, text: message };
  }
}

async function handleCancelPendingDraft(
  runtime: IAgentRuntime,
  message: Memory,
  ownerEntityId: string,
  callback: HandlerCallback | undefined
): Promise<ActionResult> {
  try {
    const scope = getPendingWorkflowDraftScope(message, ownerEntityId);
    const pendingDraft = await readPendingWorkflowDraft(runtime, scope);
    if (!pendingDraft) {
      const text = 'No pending workflow draft exists in this conversation.';
      if (callback) {
        await callback({ text, action: WORKFLOW_ACTION, metadata: { status: 'no_pending_draft' } });
      }
      return { success: true, text, data: { status: 'no_pending_draft' } };
    }

    await clearPendingWorkflowDraft(runtime, scope);
    const text = `Canceled pending workflow "${pendingDraft.workflow.name}".`;
    if (callback) {
      await callback({
        text,
        action: WORKFLOW_ACTION,
        metadata: { status: 'canceled', workflowName: pendingDraft.workflow.name },
      });
    }
    return {
      success: true,
      text,
      data: { status: 'canceled', workflowName: pendingDraft.workflow.name },
    };
  } catch (err) {
    // error-policy:J1 action-boundary translation returns cache failures as a failed tool result.
    const message = err instanceof Error ? err.message : String(err);
    logger.warn({ src: 'plugin:workflow:action:cancel' }, message);
    return { success: false, text: message };
  }
}

async function handleModify(
  service: WorkflowService,
  params: WorkflowActionParameters,
  ownerEntityId: string,
  callback: HandlerCallback | undefined
): Promise<ActionResult> {
  const workflowId = readString(params.workflowId);
  if (!workflowId) {
    return { success: false, text: 'workflowId is required to modify a workflow.' };
  }
  try {
    const existing = await service.getWorkflow(workflowId, ownerEntityId);
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
  ownerEntityId: string,
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
    existing = await service.getWorkflow(workflowId, ownerEntityId);
  } catch {
    return { success: false, text: `Workflow not found: ${workflowId}` };
  }
  try {
    if (explicitActive) {
      await service.activateWorkflow(workflowId, ownerEntityId);
    } else {
      await service.deactivateWorkflow(workflowId, ownerEntityId);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn({ src: 'plugin:workflow:action:toggle_active' }, msg);
    return { success: false, text: msg };
  }
  const refreshed = await service.getWorkflow(workflowId, ownerEntityId);
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
  ownerEntityId: string,
  callback: HandlerCallback | undefined
): Promise<ActionResult> {
  const workflowId = readString(params.workflowId);
  if (!workflowId) {
    return { success: false, text: 'workflowId parameter is required.' };
  }
  let existing: WorkflowDefinitionResponse;
  try {
    existing = await service.getWorkflow(workflowId, ownerEntityId);
  } catch {
    return { success: false, text: `Workflow not found: ${workflowId}` };
  }
  try {
    await service.deleteWorkflow(workflowId, ownerEntityId);
    invalidateAutomationExecutionCache(service, ownerEntityId, workflowId);
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
  ownerEntityId: string,
  callback: HandlerCallback | undefined
): Promise<ActionResult> {
  const workflowId = readString(params.workflowId);
  if (!workflowId) {
    return { success: false, text: 'workflowId is required to fetch executions.' };
  }
  const limit = readNumber(params.limit) ?? 10;
  try {
    const response = await service.listExecutions({ workflowId, limit }, ownerEntityId);
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
  ownerEntityId: string,
  callback: HandlerCallback | undefined
): Promise<ActionResult> {
  const workflowId = readString(params.workflowId);
  if (!workflowId) {
    return { success: false, text: 'workflowId is required to run a workflow.' };
  }
  try {
    const execution = await service.runWorkflow(workflowId, { throwOnError: false }, ownerEntityId);
    invalidateAutomationExecutionCache(service, ownerEntityId, workflowId);
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
  ownerEntityId: string,
  callback: HandlerCallback | undefined
): Promise<ActionResult> {
  const workflowId = readString(params.workflowId);
  if (!workflowId) {
    return { success: false, text: 'workflowId is required to fetch workflow revisions.' };
  }
  const limit = readNumber(params.limit) ?? 10;
  try {
    const revisions = await service.listWorkflowRevisions(workflowId, limit, ownerEntityId);
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
  ownerEntityId: string,
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
    const workflow = await service.restoreWorkflowRevision(workflowId, versionId, ownerEntityId);
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
  ownerEntityId: string,
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
      execution = await service.getExecutionDetail(executionId, ownerEntityId);
      if (workflowId && execution.workflowId !== workflowId) {
        return {
          success: false,
          text: `Execution ${executionId} belongs to workflow ${execution.workflowId}, not ${workflowId}.`,
        };
      }
    } else if (workflowId) {
      const response = await service.listExecutions({ workflowId, limit }, ownerEntityId);
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
  ownerEntityId: string,
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
    const suite = await service.getWorkflowEvaluationSuite(workflowId, limit, ownerEntityId);
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
    // Automation vocabulary (#16570): the product UI calls these
    // "automations", and a live agent guessed AUTOMATION_DELETE /
    // AUTOMATION_CANCEL when asked to remove a broken one — none of the
    // WORKFLOW_* names below matched, so the planner had to refuse despite
    // the delete op existing. Kept ONLY on this action (not TRIGGER): a
    // simile claimed by two parents is dropped as ambiguous by the resolver
    // (#16561), which would kill the routing this family exists to provide.
    'AUTOMATION',
    'AUTOMATIONS',
    'LIST_AUTOMATIONS',
    'CREATE_AUTOMATION',
    'DELETE_AUTOMATION',
    'AUTOMATION_DELETE',
    'CANCEL_AUTOMATION',
    'AUTOMATION_CANCEL',
    'REMOVE_AUTOMATION',
    'ENABLE_AUTOMATION',
    'DISABLE_AUTOMATION',
    'MANAGE_AUTOMATIONS',
    'LIST_WORKFLOWS',
    'SHOW_WORKFLOWS',
    'GET_WORKFLOW',
    'REVIEW_WORKFLOW',
    'CREATE_WORKFLOW',
    'WORKFLOW_CREATE',
    'CANCEL_WORKFLOW_DRAFT',
    'DISCARD_WORKFLOW_DRAFT',
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
    'Manage workflows (automations). Action-based dispatch - provide an `action` parameter:\n' +
    '  list, get, create, cancel, modify, activate, deactivate, toggle_active, delete, run, executions, revisions, restore, diagnose, eval_samples.\n' +
    'For creating/updating scheduled triggers (including promoting a task to a workflow), use the TRIGGER action.',
  descriptionCompressed:
    'workflow/automation list|get|create|cancel|modify|activate|deactivate|toggle_active|delete|run|executions|revisions|restore|diagnose|eval_samples',
  routingHint:
    'workflow lifecycle create/list/get/modify/activate/deactivate/run/delete/history -> call WORKFLOW directly with action=<operation>. Never wrap WORKFLOW in PAGE_DELEGATE and never invent WORKFLOW_CREATE or CREATE_WORKFLOW.',
  parameters: [
    {
      name: 'action',
      description:
        'Operation: list, get, search, create, cancel, modify, activate, deactivate, toggle_active, delete, run, executions, revisions, restore, diagnose, eval_samples.',
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
      description: 'Natural-language description for a new action=create request.',
      required: false,
      schema: { type: 'string' as const },
    },
    {
      name: 'draft',
      description:
        'Optional explicit workflow draft for compatibility. Normal chat continuation reloads the pending draft from the current conversation.',
      required: false,
      schema: { type: 'object' as const },
    },
    {
      name: 'resolutions',
      description:
        'Clarification answers for a pending create draft, as { paramPath, value } entries.',
      required: false,
      schema: { type: 'array' as const },
    },
    {
      name: 'name',
      description: 'Optional explicit name for created workflow.',
      required: false,
      schema: { type: 'string' as const },
    },
    {
      name: 'active',
      description:
        'Target state for action=toggle_active, or true to explicitly activate a newly-created workflow. New workflows otherwise remain drafts.',
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
    const ownerEntityId =
      (await resolveCanonicalOwnerIdForMessage(runtime, message)) ?? getLocalOwnerEntityId(runtime);
    switch (op) {
      case 'list':
        return handleListWorkflows(service, params, ownerEntityId, callback);
      case 'search':
        return handleSearchWorkflows(service, params, ownerEntityId, callback);
      case 'get':
        return handleGetWorkflow(service, params, ownerEntityId, callback);
      case 'create':
        return handleCreate(runtime, message, service, params, ownerEntityId, callback);
      case 'cancel':
        return handleCancelPendingDraft(runtime, message, ownerEntityId, callback);
      case 'modify':
        return handleModify(service, params, ownerEntityId, callback);
      case 'activate':
        return handleToggleActive(service, params, true, ownerEntityId, callback);
      case 'deactivate':
        return handleToggleActive(service, params, false, ownerEntityId, callback);
      case 'toggle_active':
        return handleToggleActive(service, params, undefined, ownerEntityId, callback);
      case 'delete':
        return handleDeleteWorkflow(service, params, ownerEntityId, callback);
      case 'run':
        return handleRunWorkflow(service, params, ownerEntityId, callback);
      case 'executions':
        return handleExecutions(service, params, ownerEntityId, callback);
      case 'revisions':
        return handleRevisions(service, params, ownerEntityId, callback);
      case 'restore':
        return handleRestoreRevision(service, params, ownerEntityId, callback);
      case 'diagnose':
        return handleDiagnoseExecution(service, params, ownerEntityId, callback);
      case 'eval_samples':
        return handleEvaluationSamples(service, params, ownerEntityId, callback);
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
