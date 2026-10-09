/**
 * WORKFLOW chat action for creating, editing, administering, and running native
 * Smithers workflows through the same elizaOS service used by the Workflows UI.
 */
import {
  type Action,
  type ActionResult,
  type HandlerCallback,
  type HandlerOptions,
  type IAgentRuntime,
  type Memory,
  resolveCanonicalOwnerIdForMessage,
  type State,
} from '@elizaos/core';
import { WORKFLOW_SERVICE_TYPE, type WorkflowService } from '../services/workflow-service';
import { WorkflowApiError } from '../types/index';
import {
  workflowCancellationEffect,
  workflowDefinitionEffect,
  workflowPendingEffect,
  workflowSubmissionEffect,
} from './workflow-effects';

const WORKFLOW_OPS = [
  'list',
  'search',
  'get',
  'create',
  'modify',
  'activate',
  'deactivate',
  'delete',
  'run',
  'dossier',
  'cancel_run',
  'executions',
  'revisions',
  'restore',
  'eval_samples',
] as const;
type WorkflowOp = (typeof WORKFLOW_OPS)[number];

interface WorkflowActionParameters {
  action?: unknown;
  workflowId?: unknown;
  executionId?: unknown;
  sourceId?: unknown;
  seedPrompt?: unknown;
  instruction?: unknown;
  query?: unknown;
  limit?: unknown;
  versionId?: unknown;
  input?: unknown;
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function number(value: unknown, fallback: number): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function serviceFor(runtime: IAgentRuntime): WorkflowService | null {
  return runtime.getService<WorkflowService>(WORKFLOW_SERVICE_TYPE);
}

async function respond(
  callback: HandlerCallback | undefined,
  result: ActionResult,
  metadata?: Record<string, string | number | boolean>
): Promise<ActionResult> {
  // Preview confirmations remain bound to non-applied receipts: the core
  // delivers their exact pending text/widget but cannot treat them as application proof.
  // Read-only observations have no effect contract. Empty receipt IDs would
  // suppress their callbacks at the settlement boundary, not prove a mutation.
  const settled: ActionResult = result.effectReceipts?.length
    ? {
        ...result,
        userFacingText: result.text ?? '',
        verifiedUserFacing: true,
        userFacingEffectReceiptIds: result.effectReceipts.map((receipt) => receipt.receiptId),
      }
    : { ...result };
  if (!result.effectReceipts?.length) delete settled.effectReceipts;
  if (callback) await callback({ text: settled.text ?? '', action: 'WORKFLOW', metadata });
  return settled;
}

export const workflowAction: Action = {
  name: 'WORKFLOW',
  contexts: ['general', 'automation', 'tasks', 'agent_internal'],
  contextGate: { anyOf: ['general', 'automation', 'tasks', 'agent_internal'] },
  roleGate: { minRole: 'OWNER' },
  similes: [
    'AUTOMATION',
    'AUTOMATIONS',
    'CREATE_AUTOMATION',
    'EDIT_AUTOMATION',
    'DELETE_AUTOMATION',
    'RUN_AUTOMATION',
    'CREATE_WORKFLOW',
    // Live planner output has used the noun-first form for the same supported
    // create operation. Keep it on WORKFLOW only so exact parent resolution is
    // unambiguous and the user is not refused over vocabulary ordering.
    'WORKFLOW_CREATE',
    'EDIT_WORKFLOW',
    'UPDATE_WORKFLOW',
    'DELETE_WORKFLOW',
    'RUN_WORKFLOW',
    'LIST_WORKFLOWS',
    'ACTIVATE_WORKFLOW',
    'DEACTIVATE_WORKFLOW',
    'WORKFLOW_EXECUTIONS',
  ],
  description:
    'Create, edit, inspect, activate, run, cancel, and delete native Smithers workflows. For an explicit on-demand current-day dossier or briefing from the owner’s reviewed phone Calendar and due/overdue reminders, use dossier. This reads only already reviewed native sources, creates no schedule and uses one existing summary pass. If no source has been reviewed, ask the owner to select it in digest settings; do not invent other sources. ' +
    `Provide action=${WORKFLOW_OPS.join('|')}.`,
  parameters: [
    {
      name: 'action',
      required: true,
      description: 'Workflow operation.',
      schema: { type: 'string', enum: [...WORKFLOW_OPS] },
    },
    {
      name: 'workflowId',
      required: false,
      description: 'Workflow id.',
      schema: { type: 'string' },
    },
    {
      name: 'sourceId',
      required: false,
      description:
        'Reviewed native source id for an explicit dossier; omit only when exactly one current source is configured.',
      schema: { type: 'string' },
    },
    { name: 'executionId', required: false, description: 'Run id.', schema: { type: 'string' } },
    {
      name: 'seedPrompt',
      required: false,
      description: 'Natural-language workflow request.',
      schema: { type: 'string' },
    },
    {
      name: 'instruction',
      required: false,
      description: 'Edit instruction.',
      schema: { type: 'string' },
    },
    {
      name: 'query',
      required: false,
      description: 'Workflow search query.',
      schema: { type: 'string' },
    },
    {
      name: 'input',
      required: false,
      description: 'Run input object.',
      schema: { type: 'object' },
    },
    { name: 'limit', required: false, description: 'Result limit.', schema: { type: 'number' } },
    {
      name: 'versionId',
      required: false,
      description: 'Revision version id.',
      schema: { type: 'string' },
    },
  ],
  validate: async (runtime: IAgentRuntime): Promise<boolean> => serviceFor(runtime) !== null,
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
    options?: HandlerOptions,
    callback?: HandlerCallback
  ): Promise<ActionResult> => {
    const params = (options?.parameters ?? {}) as WorkflowActionParameters;
    const op = text(params.action)?.toLowerCase() as WorkflowOp | undefined;
    if (!op || !WORKFLOW_OPS.includes(op)) {
      return { success: false, text: `action is required (${WORKFLOW_OPS.join(', ')})` };
    }
    const service = serviceFor(runtime);
    if (!service) return { success: false, text: 'Workflow service is unavailable.' };
    const ownerId = (await resolveCanonicalOwnerIdForMessage(runtime, message)) ?? message.entityId;
    const workflowId = text(params.workflowId);
    const limit = Math.min(50, Math.max(1, number(params.limit, 20)));

    try {
      if (op === 'list' || op === 'search') {
        const workflows =
          op === 'search'
            ? await service.searchWorkflows(text(params.query) ?? '', ownerId)
            : await service.listWorkflows(ownerId);
        return respond(
          callback,
          {
            success: true,
            text: workflows.length
              ? `Found ${workflows.length} workflow${workflows.length === 1 ? '' : 's'}.`
              : 'No workflows found.',
            data: { workflows: workflows.slice(0, limit) },
          },
          { count: workflows.length }
        );
      }
      if (op === 'create') {
        const instruction =
          text(params.seedPrompt) ?? text(params.instruction) ?? message.content.text;
        if (!instruction) return { success: false, text: 'A workflow description is required.' };
        const draft = await service.generateWorkflowDraft(instruction, { userId: ownerId });
        if (draft.id !== undefined)
          throw new Error('Create requires a new definition without an existing workflow id');
        const workflow = await service.deployWorkflowDefinition(draft, ownerId, {
          activate: false,
        });
        if (workflow.active) throw new Error('Inactive workflow creation was not verified');
        return respond(
          callback,
          {
            success: true,
            text: `Created “${workflow.name}” as an inactive Smithers workflow (${workflow.id}, version ${workflow.versionId}).`,
            effectReceipts: [workflowDefinitionEffect('create', workflow)],
            data: { workflow, widget: { type: 'workflow', workflowId: workflow.id } },
          },
          { workflowId: workflow.id }
        );
      }
      if (op === 'dossier') {
        const execution = await service.prepareDossier(
          ownerId,
          String(message.id || ''),
          text(params.sourceId)
        );
        if (execution.status !== 'finished')
          return {
            success: false,
            text:
              execution.error?.message ||
              'The selected phone sources could not be read. No dossier was completed.',
          };
        const output = execution.output;
        if (
          !Array.isArray(output) ||
          output.length !== 1 ||
          output[0]?.nodeId !== 'typed-steps' ||
          output[0]?.runId !== execution.id ||
          typeof output[0]?.text !== 'string'
        )
          throw new Error('Completed dossier summary is unavailable');
        return respond(
          callback,
          {
            success: true,
            text: output[0].text,
            effectReceipts: [workflowSubmissionEffect(execution)],
            data: { summary: output[0].text, manualOnly: true },
          },
          { workflowId: execution.workflowId, runId: execution.id }
        );
      }
      if (!workflowId && op !== 'cancel_run')
        return { success: false, text: 'workflowId is required.' };
      if (op === 'get') {
        const workflow = await service.getWorkflow(workflowId as string, ownerId);
        return respond(callback, {
          success: true,
          text: `Loaded “${workflow.name}”.`,
          data: { workflow },
        });
      }
      if (op === 'modify') {
        const instruction = text(params.instruction) ?? text(params.seedPrompt);
        if (!instruction) return { success: false, text: 'An edit instruction is required.' };
        const current = await service.getWorkflow(workflowId as string, ownerId);
        const draft = await service.modifyWorkflowDraft(current, instruction, { userId: ownerId });
        const workflow = await service.updateWorkflow(
          workflowId as string,
          { ...draft, active: current.active },
          ownerId
        );
        return respond(callback, {
          success: true,
          text: `Updated “${workflow.name}”.`,
          effectReceipts: [workflowDefinitionEffect('modify', workflow)],
          data: { workflow },
        });
      }
      if (op === 'activate' || op === 'deactivate') {
        const workflow =
          op === 'activate'
            ? await service.activateWorkflow(workflowId as string, ownerId)
            : await service.deactivateWorkflow(workflowId as string, ownerId);
        return respond(callback, {
          success: true,
          text: `${workflow.name} is now ${workflow.active ? 'active' : 'inactive'}.`,
          effectReceipts: [workflowDefinitionEffect(op, workflow)],
          data: { workflow },
        });
      }
      if (op === 'delete') {
        // Legacy deletion is deliberately denied by the service: removal requires
        // a reviewed version and receipt-preserving lifecycle mutation.
        return {
          success: false,
          text: 'Use reviewed receipt-preserving removal.',
          effectReceipts: [],
          failureProvenance: {
            kind: 'handler_error',
            boundary: 'handler',
            code: 'WORKFLOW_REVIEWED_REMOVAL_REQUIRED',
            retryable: false,
          },
        };
      }
      if (op === 'run') {
        const workflow = await service.getWorkflow(workflowId as string, ownerId);
        const execution = await service.startWorkflow(
          workflowId as string,
          {
            mode: 'chat',
            input: record(params.input),
          },
          ownerId
        );
        const marker = JSON.stringify({
          id: execution.id,
          workflowId,
          runId: execution.id,
          title: workflow.name,
          steps: (workflow.steps ?? []).map((step) => ({
            label: step.label,
            nodeId: step.id,
            status: 'pending',
          })),
          widgets: workflow.widgets ?? [],
        });
        return respond(
          callback,
          {
            success: true,
            text: `Submitted workflow run ${execution.id}.\n\n[WORKFLOW]\n${marker}\n[/WORKFLOW]`,
            effectReceipts: [workflowPendingEffect('execute', execution)],
            data: {
              execution,
              submissionReceipt: workflowSubmissionEffect(execution),
              widget: { type: 'workflow-run', workflowId, runId: execution.id },
            },
          },
          { workflowId: workflowId as string, runId: execution.id }
        );
      }
      if (op === 'cancel_run') {
        const executionId = text(params.executionId);
        if (!executionId) return { success: false, text: 'executionId is required.' };
        const cancellation = await service.cancelExecutionWithReceipt(executionId, ownerId);
        const execution = cancellation.execution;
        const receipt = workflowCancellationEffect(cancellation);
        return respond(callback, {
          success: true,
          text: receipt
            ? `Cancellation request recorded for ${executionId}; current status: ${execution.status}.`
            : `Run ${executionId} is ${execution.status}; no cancellation request was recorded.`,
          effectReceipts: receipt ? [workflowPendingEffect('cancel', execution)] : [],
          data: { execution, ...(receipt ? { cancellationRequestReceipt: receipt } : {}) },
        });
      }
      if (op === 'executions') {
        const executions = await service.getWorkflowExecutions(
          workflowId as string,
          limit,
          ownerId
        );
        return respond(callback, {
          success: true,
          text: `Found ${executions.length} run${executions.length === 1 ? '' : 's'}.`,
          data: { executions },
        });
      }
      if (op === 'revisions') {
        const revisions = await service.getWorkflowRevisions(workflowId as string, limit, ownerId);
        return respond(callback, {
          success: true,
          text: `Found ${revisions.length} revision${revisions.length === 1 ? '' : 's'}.`,
          data: { revisions },
        });
      }
      if (op === 'restore') {
        const versionId = text(params.versionId);
        if (!versionId) return { success: false, text: 'versionId is required.' };
        const workflow = await service.restoreWorkflowRevision(
          workflowId as string,
          versionId,
          ownerId
        );
        return respond(callback, {
          success: true,
          text: `Restored “${workflow.name}”.`,
          effectReceipts: [workflowDefinitionEffect('restore', workflow)],
          data: { workflow },
        });
      }
      const suite = await service.getWorkflowEvaluationSuite(workflowId as string, limit, ownerId);
      return respond(callback, {
        success: true,
        text: 'Generated Smithers evaluation samples.',
        data: { suite },
      });
    } catch (error) {
      if (
        error instanceof WorkflowApiError &&
        record(error.response).code === 'NATIVE_DOSSIER_SOURCE_REVIEW_REQUIRED'
      )
        return {
          success: false,
          text: error.message,
          data: {
            sources: Array.isArray(record(error.response).sources)
              ? (record(error.response).sources as unknown[]).map((value) => {
                  const source = record(value);
                  return {
                    id: text(source.id),
                    label: text(source.label),
                    reviewedAt: text(source.reviewedAt),
                    expiresAt: text(source.expiresAt),
                  };
                })
              : [],
          },
          effectReceipts: [],
          failureProvenance: {
            kind: 'handler_error',
            boundary: 'handler',
            code: 'NATIVE_DOSSIER_SOURCE_REVIEW_REQUIRED',
            retryable: false,
          },
        };
      // error-policy:J1 action boundary returns the failure to the planner.
      return {
        success: false,
        text: error instanceof Error ? error.message : String(error),
        effectReceipts: [],
        // A service may commit before a later readback or schedule sync fails.
        // Do not replay an unqualified mutation after an ambiguous outcome.
        failureProvenance: {
          kind: 'handler_error',
          boundary: 'handler',
          code: 'WORKFLOW_OPERATION_FAILED_RECONCILE_BEFORE_RETRY',
          retryable: false,
        },
      };
    }
  },
};
