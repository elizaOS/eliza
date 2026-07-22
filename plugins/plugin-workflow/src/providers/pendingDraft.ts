/**
 * Restores a conversation's pending workflow draft so confirmations,
 * cancellations, and edits remain routed through the workflow action.
 */
import {
  ElizaError,
  type IAgentRuntime,
  type Memory,
  type Provider,
  resolveCanonicalOwnerIdForMessage,
  type State,
} from '@elizaos/core';
import {
  getPendingWorkflowDraftScope,
  readPendingWorkflowDraft,
} from '../lib/pending-workflow-draft';
import { coerceClarifications } from '../lib/workflow-clarification';
import { getLocalOwnerEntityId } from '../utils/context';

const MAX_DRAFT_NODES = 12;

/**
 * Provider that tells the LLM when a workflow draft is pending confirmation.
 *
 * Without this, the LLM has no context about pending drafts and will route
 * confirmation messages (e.g. "yes, deploy it") to REPLY instead of WORKFLOW.
 */
export const pendingDraftProvider: Provider = {
  name: 'PENDING_WORKFLOW_DRAFT',
  description: 'Pending workflow draft awaiting user confirmation, modification, or cancellation',
  contexts: ['general', 'automation', 'tasks', 'connectors'],
  contextGate: { anyOf: ['general', 'automation', 'tasks', 'connectors'] },
  cacheScope: 'conversation',
  roleGate: { minRole: 'ADMIN' },

  get: async (runtime: IAgentRuntime, message: Memory, _state: State) => {
    try {
      const ownerEntityId =
        (await resolveCanonicalOwnerIdForMessage(runtime, message)) ??
        getLocalOwnerEntityId(runtime);
      const scope = getPendingWorkflowDraftScope(message, ownerEntityId);
      const draft = await readPendingWorkflowDraft(runtime, scope);

      if (!draft) {
        return { text: '', data: {}, values: {} };
      }

      const clarifications = coerceClarifications(draft.workflow._meta?.requiresClarification);
      const nodeNames = draft.workflow.nodes
        .slice(0, MAX_DRAFT_NODES)
        .map((n) => n.name)
        .join(' → ');
      const questions = clarifications
        .map((clarification, index) => {
          const destination = clarification.paramPath
            ? ` (resolution paramPath: \`${clarification.paramPath}\`)`
            : ' (resolution paramPath: empty string)';
          return `${index + 1}. ${clarification.question}${destination}`;
        })
        .join('\n');

      return {
        text:
          '# Pending Workflow Draft\n\n' +
          `A workflow draft "${draft.workflow.name}" is pending.\n` +
          `Nodes: ${nodeNames}\n\n` +
          (questions ? `Clarifications still required:\n${questions}\n\n` : '') +
          '**REQUIRED**: Any user message about this draft MUST trigger the WORKFLOW action.\n' +
          'Answer clarifications with action=create and a resolutions array of { paramPath, value }.\n' +
          'Cancel with action=cancel. Send modifications back through action=create as resolutions.\n' +
          'The action reloads the draft from this conversation — do not send a draft parameter.\n' +
          'You MUST include WORKFLOW in your actions.',
        data: {
          hasPendingDraft: true,
          workflowName: draft.workflow.name,
          clarifications,
          truncated: draft.workflow.nodes.length > MAX_DRAFT_NODES,
        },
        values: { hasPendingDraft: true },
      };
    } catch (error) {
      const wrapped = new ElizaError('Failed to load pending workflow draft', {
        code: 'WORKFLOW_PROVIDER_DRAFT_LOAD_FAILED',
        cause: error,
        context: { entityId: message.entityId, roomId: message.roomId },
        severity: 'ephemeral',
      });
      await runtime.reportError('WorkflowProvider.pendingDraft', wrapped);
      throw wrapped;
    }
  },
};
