import type { IAgentRuntime, Memory, Provider, State } from '@elizaos/core';
import type { WorkflowDraft } from '../types/index';

const DRAFT_TTL_MS = 30 * 60 * 1000;
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
  contexts: ['automation', 'connectors'],
  contextGate: { anyOf: ['automation', 'connectors'] },
  cacheScope: 'conversation',
  roleGate: { minRole: 'ADMIN' },

  get: async (runtime: IAgentRuntime, message: Memory, _state: State) => {
    try {
      const cacheKey = `workflow_draft:${message.entityId}`;
      const draft = await runtime.getCache<WorkflowDraft>(cacheKey);

      if (!draft || Date.now() - draft.createdAt > DRAFT_TTL_MS) {
        return { text: '', data: {}, values: {} };
      }

      const nodeNames = draft.workflow.nodes
        .slice(0, MAX_DRAFT_NODES)
        .map((n) => n.name)
        .join(' → ');

      return {
        text:
          '# Pending Workflow Draft\n\n' +
          `A workflow draft "${draft.workflow.name}" is pending.\n` +
          `Nodes: ${nodeNames}\n\n` +
          '**REQUIRED**: Any user message about this draft MUST trigger the WORKFLOW action.\n' +
          'This includes confirmations ("yes", "ok", "deploy it", "create it", "go ahead"),\n' +
          'cancellations ("cancel", "nevermind"), and modifications ("change X", "use Y instead").\n' +
          'The action handler manages all draft operations — do NOT handle them via text reply.\n' +
          'You MUST include WORKFLOW in your actions.',
        data: {
          hasPendingDraft: true,
          truncated: draft.workflow.nodes.length > MAX_DRAFT_NODES,
        },
        values: { hasPendingDraft: true },
      };
    } catch {
      return { text: '', data: {}, values: {} };
    }
  },
};
