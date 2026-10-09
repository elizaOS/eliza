import { type EffectReceipt, normalizeEffectReceipt } from '@elizaos/core';
import type {
  WorkflowCancellationResult,
  WorkflowDefinitionResponse,
  WorkflowExecution,
} from '../types/index';

/** Build proof only from an authoritative persisted row returned by the service. */
function committed(
  operation: string,
  kind: string,
  id: string,
  version: string,
  committedAt: string,
  replayed = false
): EffectReceipt {
  const receiptId = `${operation}:${id}:${version}`;
  return normalizeEffectReceipt({
    receiptId,
    operation,
    resource: { kind, id, version },
    artifacts: [],
    idempotency: { key: replayed ? receiptId : null, replayed },
    observedAt: new Date().toISOString(),
    ...(replayed
      ? { outcome: 'noop', reason: 'The existing durable cancellation request was verified.' }
      : {
          outcome: 'applied',
          commit: { kind: 'durable', id: `${kind}:${id}:${version}`, committedAt },
        }),
  });
}

export function workflowDefinitionEffect(
  operation: 'create' | 'modify' | 'activate' | 'deactivate' | 'restore',
  workflow: WorkflowDefinitionResponse
): EffectReceipt {
  return committed(
    `workflow.${operation}`,
    'workflow.definition',
    workflow.id,
    workflow.versionId,
    workflow.updatedAt
  );
}

export function workflowSubmissionEffect(execution: WorkflowExecution): EffectReceipt {
  // Submission commits a queued execution, not a finished workflow or external effects.
  return committed(
    'workflow.run.submit',
    'workflow.execution',
    execution.id,
    execution.workflowVersionId,
    execution.startedAt
  );
}

export function workflowCancellationEffect(
  result: WorkflowCancellationResult
): EffectReceipt | undefined {
  const { execution, request } = result;
  if (!request) return undefined;
  if (execution.cancellationRequestedAt !== request.requestedAt) {
    throw new Error('Cancellation request proof differs from execution readback');
  }
  return committed(
    'workflow.run.cancel.request',
    'workflow.execution',
    execution.id,
    request.requestedAt,
    request.requestedAt,
    request.replayed
  );
}

/** A queued execution/request is not proof that the requested workflow outcome completed. */
export function workflowPendingEffect(
  operation: 'execute' | 'cancel',
  execution: WorkflowExecution
): EffectReceipt {
  return normalizeEffectReceipt({
    receiptId: `workflow.run.${operation}.pending:${execution.id}:${execution.workflowVersionId}`,
    operation: `workflow.run.${operation}`,
    resource: {
      kind: 'workflow.execution',
      id: execution.id,
      version: execution.workflowVersionId,
    },
    artifacts: [],
    idempotency: { key: null, replayed: false },
    observedAt: new Date().toISOString(),
    outcome: 'preview',
  });
}
