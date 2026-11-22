/**
 * WORKFLOW chat action for creating, editing, administering, and running native
 * Smithers workflows through the same elizaOS service used by the Workflows UI.
 */
import { randomUUID } from 'node:crypto';
import {
  type Action,
  type ActionResult,
  type HandlerCallback,
  type HandlerOptions,
  type IAgentRuntime,
  incomingMessagePersistenceSnapshot,
  type Memory,
  resolveCanonicalOwnerIdForMessage,
  type State,
  unwrapUserMessageText,
} from '@elizaos/core';
import { HOSTED_SPEC } from '../services/hosted-digest';
import { PHONE_SPEC_KEY, storedPhoneTimeTrigger } from '../services/phone-workflow-spec';
import {
  WORKFLOW_DRAFT_NOT_APPLIED,
  WORKFLOW_SERVICE_TYPE,
  type WorkflowService,
} from '../services/workflow-service';
import { WORKFLOW_DEFINITION_NOT_APPLIED, WorkflowApiError } from '../types/index';
import {
  workflowCancellationEffect,
  workflowDefinitionEffect,
  workflowPendingEffect,
  workflowSubmissionEffect,
} from './workflow-effects';
import { normalizeName, notApplied, resolveWorkflowRef } from './workflow-reference';
import { authoredWorkflowRequest } from './workflow-request';

const WORKFLOW_OPS = [
  'list',
  'search',
  'get',
  'create',
  'modify',
  'rename',
  'activate',
  'deactivate',
  'remove',
  'restore_removed',
  'run',
  'dossier',
  'cancel_run',
  'executions',
  'revisions',
  'restore',
  'eval_samples',
] as const;
type WorkflowOp = (typeof WORKFLOW_OPS)[number];
/** These only read, so a failure in one never leaves a change to reconcile. */
const READ_OPS: readonly WorkflowOp[] = [
  'list',
  'search',
  'get',
  'executions',
  'revisions',
  'eval_samples',
];

interface WorkflowActionParameters {
  action?: unknown;
  workflowId?: unknown;
  workflowName?: unknown;
  name?: unknown;
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

function validTimeZone(value: unknown): string | undefined {
  const zone = text(value);
  if (!zone) return undefined;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return zone;
  } catch {
    return undefined;
  }
}

/** The order TRIGGER uses: the owner's device, then the agent setting, then the host. */
function ownerTimeZone(runtime: IAgentRuntime, message: Memory): string {
  return (
    validTimeZone(record(message.content.metadata).uiTimeZone) ??
    validTimeZone(runtime.getSetting('TIMEZONE')) ??
    validTimeZone(Intl.DateTimeFormat().resolvedOptions().timeZone) ??
    'UTC'
  );
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

/**
 * Generated workflow modules get only the agent adapter, not the device
 * notification bridge, so a chat-created "reminder" never reaches the owner.
 * The create and modify results say so whenever the request asked to be told,
 * in any of the ways owners say it ("texts me", "lets me know", "reminding me",
 * "sends me a push").
 */
const NOTIFY_REQUEST =
  /\b(?:remind\w*|notif\w*|alert\w*|(?:ping|tell|text|message|messag|email|e-mail|nudge|warn|buzz|call|sms|dm)(?:s|es|ed|ing)?\s+me|(?:let|lets|letting)\s+me\s+know|(?:send|sends|sending|sent)\s+me|push\s+(?:notification|alert|message)s?|wake\s+me)\b/i;
function asksToNotify(...texts: Array<string | undefined>): boolean {
  return texts.some((value) => typeof value === 'string' && NOTIFY_REQUEST.test(value));
}
const NO_NOTIFICATION =
  ' It can’t send you a notification: when it is on, each run’s output appears only in its run history. For a reminder that notifies you, use a phone reminder instead.';

/** A refusal of the call itself: nothing was read or written. */
const badCall = (code: string, text: string) => notApplied(code, text, text);

/** A model-written name that is already taken gets a number, so names stay distinct. */
function unusedName(name: string, taken: ReadonlySet<string>): string {
  if (!taken.has(normalizeName(name))) return name;
  for (let n = 2; ; n++) if (!taken.has(normalizeName(`${name} ${n}`))) return `${name} ${n}`;
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
    'RUN_AUTOMATION',
    'CREATE_WORKFLOW',
    // Live planner output has used the noun-first form for the same supported
    // create operation. Keep it on WORKFLOW only so exact parent resolution is
    // unambiguous and the user is not refused over vocabulary ordering.
    'WORKFLOW_CREATE',
    'EDIT_WORKFLOW',
    'UPDATE_WORKFLOW',
    'RUN_WORKFLOW',
    'LIST_WORKFLOWS',
    'ACTIVATE_WORKFLOW',
    'DEACTIVATE_WORKFLOW',
    'WORKFLOW_EXECUTIONS',
  ],
  description:
    'Create, edit, rename, inspect, activate, run, cancel, remove and restore workflows. modify changes what a workflow does and turns it off until the owner reviews the change. rename changes only the name. remove takes a workflow out of the list and stops its schedule; restore_removed brings a removed workflow back, turned off. restore returns a workflow to an earlier revision. A workflow built in the Workflows view is edited there, and its schedule is turned on there. For an explicit on-demand current-day dossier or briefing from the owner’s reviewed phone Calendar and due/overdue reminders, use dossier. This reads only already reviewed native sources, creates no schedule and uses one existing summary pass. If no source has been reviewed, ask the owner to select it in digest settings; do not invent other sources. A chat-created workflow cannot message, notify or remind the owner: its output appears only in its run history, so never say it will remind or notify them; for "remind me at <time>" use the phone reminder (reminders.create) when it is available. ' +
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
      description:
        'Workflow id. Give this or workflowName for every action except list, search, create, dossier and cancel_run.',
      schema: { type: 'string' },
    },
    {
      name: 'workflowName',
      required: false,
      description: 'Workflow name, or part of it, when the id is not known.',
      schema: { type: 'string' },
    },
    {
      name: 'name',
      required: false,
      description:
        'Workflow name. For create, the name the owner gave the workflow, if any. For rename, the new name (required).',
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
      description: 'Run input object. Its keys are defined by the workflow.',
      schema: { type: 'object', additionalProperties: true },
    },
    { name: 'limit', required: false, description: 'Result limit.', schema: { type: 'number' } },
    {
      name: 'versionId',
      required: false,
      description:
        'Revision version id. Required for restore. For activate and deactivate, the change applies only if this is still the current version.',
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
    let params = (options?.parameters ?? {}) as WorkflowActionParameters;
    let ownerWords = false;
    const op = text(params.action)?.toLowerCase() as WorkflowOp | undefined;
    if (!op || !WORKFLOW_OPS.includes(op)) {
      return badCall('WORKFLOW_ACTION_REQUIRED', `action is required (${WORKFLOW_OPS.join(', ')})`);
    }
    if (!READ_OPS.includes(op)) {
      const userText = unwrapUserMessageText(
        incomingMessagePersistenceSnapshot(message) ?? message
      );
      const authored = authoredWorkflowRequest(userText);
      if (authored) {
        if (authored.op !== op)
          return notApplied(
            'WORKFLOW_REQUEST_CONFLICT',
            'The proposed workflow operation differs from the owner’s request.',
            'I left your workflows unchanged.'
          );
        // The owner's words name the workflow. The planner's id is kept only to
        // pick among same-named workflows or to confirm a name given in part.
        params = { ...authored, instruction: userText, workflowId: params.workflowId };
        ownerWords = true;
      }
    }
    const service = serviceFor(runtime);
    if (!service)
      return badCall('WORKFLOW_SERVICE_UNAVAILABLE', 'Workflow service is unavailable.');
    const ownerId = (await resolveCanonicalOwnerIdForMessage(runtime, message)) ?? message.entityId;
    const timeZone = ownerTimeZone(runtime, message);
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
            // A cut list says so, so neither the owner nor the planner reads it as all of them.
            text: workflows.length
              ? `Found ${workflows.length} workflow${workflows.length === 1 ? '' : 's'}${
                  workflows.length > limit ? `. Showing the first ${limit}` : ''
                }: ${workflows
                  .slice(0, limit)
                  .map((workflow) => `“${workflow.name}” (${workflow.active ? 'on' : 'off'})`)
                  .join(', ')}.`
              : 'No workflows found.',
            data: {
              workflows: workflows.slice(0, limit),
              total: workflows.length,
              truncated: workflows.length > limit,
            },
          },
          { count: workflows.length }
        );
      }
      if (op === 'create') {
        const instruction =
          text(params.seedPrompt) ?? text(params.instruction) ?? message.content.text;
        if (!instruction)
          return badCall('WORKFLOW_DESCRIPTION_REQUIRED', 'A workflow description is required.');
        // The owner's name for the workflow is how chat finds it again later.
        const requestedName = text(params.name);
        if (requestedName && requestedName.length > 200)
          return badCall('WORKFLOW_NAME_INVALID', 'name must be 1 to 200 characters.');
        // A second "create a workflow called Alpha" (say, after a lost reply)
        // would leave two workflows chat cannot tell apart by name.
        const taken = new Set(
          (await service.listWorkflows(ownerId)).map((workflow) => normalizeName(workflow.name))
        );
        if (requestedName && taken.has(normalizeName(requestedName)))
          return notApplied(
            'WORKFLOW_NAME_TAKEN',
            `A workflow named “${requestedName}” already exists. Nothing was created. Ask the owner for another name or whether they mean the existing one.`,
            `You already have a workflow called “${requestedName}”, so I didn’t create another. Give me a different name, or tell me what to do with that one.`,
            false
          );
        const authored = await service.generateWorkflowDraft(instruction, {
          userId: ownerId,
          timeZone,
        });
        const draft = requestedName
          ? { ...authored, name: requestedName }
          : { ...authored, name: unusedName(authored.name, taken) };
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
            text: `Created “${workflow.name}”. It is off until you turn it on.${asksToNotify(instruction, message.content.text) ? NO_NOTIFICATION : ''}`,
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
      if (op === 'cancel_run') {
        const executionId = text(params.executionId);
        if (!executionId) return badCall('WORKFLOW_EXECUTION_REQUIRED', 'executionId is required.');
        const cancellation = await service.cancelExecutionWithReceipt(executionId, ownerId);
        const execution = cancellation.execution;
        const receipt = workflowCancellationEffect(cancellation);
        return respond(callback, {
          success: true,
          text: receipt
            ? `Asked the run to stop. Its status is ${execution.status}.`
            : `The run is already ${execution.status}. Nothing was cancelled.`,
          effectReceipts: receipt ? [workflowPendingEffect('cancel', execution)] : [],
          data: { execution, ...(receipt ? { cancellationRequestReceipt: receipt } : {}) },
        });
      }
      const current = await resolveWorkflowRef(
        service,
        ownerId,
        { workflowId: text(params.workflowId), workflowName: text(params.workflowName) },
        {
          removed: op === 'restore_removed',
          strict: op === 'remove' || op === 'rename',
          ownerWords,
          timeZone,
        }
      );
      if ('success' in current) return current;
      const workflowId = current.id;
      const label = `“${current.name}”`;
      // A typed workflow carries the steps and schedule the owner reviewed in the Workflows view.
      const typed = typeof current.metadata?.[PHONE_SPEC_KEY] === 'string';
      if (op === 'restore_removed' && !current.removed)
        return notApplied(
          'WORKFLOW_NOT_REMOVED',
          `${label} is not removed. Nothing was changed.`,
          `${label} is not removed.`,
          false
        );
      if (current.removed && !READ_OPS.includes(op) && op !== 'restore_removed')
        return notApplied(
          'WORKFLOW_REMOVED',
          `${label} was removed. Nothing was changed. Use action=restore_removed first.`,
          op === 'remove'
            ? `${label} is already removed.`
            : `${label} was removed. Restore it before you change or run it.`,
          false
        );
      if (op === 'get') {
        return respond(callback, {
          success: true,
          text: `Loaded ${label}.`,
          data: { workflow: current },
        });
      }
      if (op === 'modify') {
        const instruction = text(params.instruction) ?? text(params.seedPrompt);
        if (!instruction)
          return badCall('WORKFLOW_INSTRUCTION_REQUIRED', 'An edit instruction is required.');
        // The typed draft path never lets a model set the schedule or phone target, and
        // its steps use sources the owner selects, so a chat edit cannot be a reviewed one.
        if (typed)
          return notApplied(
            'WORKFLOW_EDIT_IN_VIEW',
            `${label} was built in the Workflows view and is edited only there. Nothing was changed. Chat can rename, pause, run or remove it.`,
            `${label} was built in the Workflows view. Open it there to change its steps or schedule. From chat you can rename, pause, run or remove it.`,
            false
          );
        const draft = await service.modifyWorkflowDraft(current, instruction, {
          userId: ownerId,
          timeZone,
        });
        // An edited workflow never runs on a schedule before the owner reviews it.
        const workflow = await service.updateWorkflow(
          workflowId,
          { ...draft, active: false },
          ownerId
        );
        if (workflow.active) throw new Error('Inactive workflow update was not verified');
        return respond(callback, {
          success: true,
          text: `Updated “${workflow.name}”.${current.active ? ' It was on, so it is now off. Review the change, then turn it on again.' : ''}${asksToNotify(instruction, message.content.text) ? NO_NOTIFICATION : ''}`,
          effectReceipts: [workflowDefinitionEffect('modify', workflow)],
          data: { workflow },
        });
      }
      if (op === 'rename') {
        const name = text(params.name);
        if (!name || name.length > 200)
          return badCall(
            'WORKFLOW_NAME_INVALID',
            'name is required for rename (1 to 200 characters).'
          );
        if (name === current.name)
          return notApplied(
            'WORKFLOW_NAME_UNCHANGED',
            `${label} already has that name. Nothing was changed.`,
            `${label} already has that name.`,
            false
          );
        const clash = (await service.listWorkflows(ownerId)).find(
          (workflow) =>
            workflow.id !== workflowId && normalizeName(workflow.name) === normalizeName(name)
        );
        if (clash)
          return notApplied(
            'WORKFLOW_NAME_TAKEN',
            `Another workflow is already named “${clash.name}”. Nothing was changed. Ask the owner for another name.`,
            `You already have a workflow called “${clash.name}”, so I left ${label} as it is. What else should I call it?`,
            false
          );
        const workflow = await service.renameWorkflow(workflowId, name, ownerId);
        return respond(callback, {
          success: true,
          text: `Renamed ${label} to “${workflow.name}”.${current.active && !workflow.active ? ' Its schedule is now paused. Turn it on again in Workflows.' : ''}`,
          effectReceipts: [workflowDefinitionEffect('rename', workflow)],
          data: { workflow },
        });
      }
      if (op === 'activate' || op === 'deactivate') {
        // Turning on a typed workflow needs the owner's confirmation on the phone.
        // A version id the model read back is not that confirmation.
        if (op === 'activate' && typed) {
          const sentence = current.metadata?.[HOSTED_SPEC]
            ? `${label} is a digest. Turn it on in the digest settings.`
            : storedPhoneTimeTrigger(current.metadata)
              ? `${label} runs on a schedule that you confirm on the phone. Open Workflows and turn it on there.`
              : `${label} has no schedule to turn on. It runs only when you start it.`;
          return notApplied(
            'WORKFLOW_ACTIVATE_IN_VIEW',
            `${sentence} Nothing was changed.`,
            sentence,
            false
          );
        }
        // A supplied version binds the change to the exact version that was reviewed.
        const expectedVersionId = text(params.versionId);
        if (params.versionId !== undefined && !expectedVersionId) {
          throw new WorkflowApiError(
            'Select a valid workflow version before changing activation.',
            400
          );
        }
        const workflow =
          op === 'activate'
            ? await service.activateWorkflow(workflowId, ownerId, expectedVersionId)
            : await service.deactivateWorkflow(workflowId, ownerId, expectedVersionId);
        return respond(callback, {
          success: true,
          text: `${workflow.name} is now ${workflow.active ? 'active' : 'inactive'}.`,
          effectReceipts: [workflowDefinitionEffect(op, workflow)],
          data: { workflow },
        });
      }
      if (op === 'remove' || op === 'restore_removed') {
        const { receipt } = await service.changeLifecycle(
          workflowId,
          randomUUID(),
          current.versionId,
          op === 'remove' ? 'remove' : 'restore',
          ownerId
        );
        const workflow = {
          id: workflowId,
          name: current.name,
          removed: op === 'remove',
          active: false,
          versionId: receipt.versionId,
          updatedAt: receipt.appliedAt,
        };
        return respond(callback, {
          success: true,
          text:
            op === 'remove'
              ? `Removed ${label}. It no longer runs. You can restore it later.`
              : `Restored ${label}. It is off until you turn it on.`,
          effectReceipts: [workflowDefinitionEffect(op, workflow)],
          data: { workflow },
        });
      }
      if (op === 'run') {
        const execution = await service.startWorkflow(
          workflowId,
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
          title: current.name,
          steps: (current.steps ?? []).map((step) => ({
            label: step.label,
            nodeId: step.id,
            status: 'pending',
          })),
          widgets: current.widgets ?? [],
        });
        return respond(
          callback,
          {
            success: true,
            text: `Submitted a run of ${label}.\n\n[WORKFLOW]\n${marker}\n[/WORKFLOW]`,
            effectReceipts: [workflowPendingEffect('execute', execution)],
            data: {
              execution,
              submissionReceipt: workflowSubmissionEffect(execution),
              widget: { type: 'workflow-run', workflowId, runId: execution.id },
            },
          },
          { workflowId, runId: execution.id }
        );
      }
      if (op === 'executions') {
        const executions = await service.getWorkflowExecutions(workflowId, limit, ownerId);
        return respond(callback, {
          success: true,
          text: `Found ${executions.length} run${executions.length === 1 ? '' : 's'}.`,
          data: { executions },
        });
      }
      if (op === 'revisions') {
        const revisions = await service.getWorkflowRevisions(workflowId, limit, ownerId);
        return respond(callback, {
          success: true,
          text: `Found ${revisions.length} revision${revisions.length === 1 ? '' : 's'}.`,
          data: { revisions },
        });
      }
      if (op === 'restore') {
        const versionId = text(params.versionId);
        if (!versionId) return badCall('WORKFLOW_VERSION_REQUIRED', 'versionId is required.');
        const workflow = await service.restoreWorkflowRevision(workflowId, versionId, ownerId);
        return respond(callback, {
          success: true,
          text: `Restored “${workflow.name}”.`,
          effectReceipts: [workflowDefinitionEffect('restore', workflow)],
          data: { workflow },
        });
      }
      const suite = await service.getWorkflowEvaluationSuite(workflowId, limit, ownerId);
      return respond(callback, {
        success: true,
        text: 'Generated evaluation samples.',
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
      // A read, a missing record, and a refusal the service marks as not applied
      // committed nothing, so the planner may correct the call and try again.
      const status = error instanceof WorkflowApiError ? error.statusCode : undefined;
      const refusal =
        error instanceof WorkflowApiError ? text(record(error.response).code) : undefined;
      const notAppliedCode = READ_OPS.includes(op)
        ? 'WORKFLOW_READ_FAILED'
        : status === 404
          ? 'WORKFLOW_NOT_FOUND'
          : (status === 409 && refusal?.endsWith('_NOT_APPLIED')) ||
              refusal === WORKFLOW_DRAFT_NOT_APPLIED ||
              // Refused while checking the definition, before any row was written.
              (status === 400 && refusal === WORKFLOW_DEFINITION_NOT_APPLIED)
            ? refusal
            : undefined;
      // error-policy:J1 action boundary returns the failure to the planner.
      return {
        success: false,
        text: error instanceof Error ? error.message : String(error),
        effectReceipts: [],
        failureProvenance: notAppliedCode
          ? { kind: 'handler_error', boundary: 'handler', code: notAppliedCode, retryable: true }
          : {
              // A service may commit before a later readback or schedule sync fails.
              // Do not replay an unqualified mutation after an ambiguous outcome.
              kind: 'handler_error',
              boundary: 'handler',
              code: 'WORKFLOW_OPERATION_FAILED_RECONCILE_BEFORE_RETRY',
              retryable: false,
            },
      };
    }
  },
};
