/**
 * Bounded per-renderer outbox for shell navigation operations. The view route
 * commits an exact command here before transport delivery; WebSocket, chat
 * terminal, and reconnect consumers share the same operation identity, while
 * acknowledgements remove only the operation the renderer actually applied.
 */

import type { ShellNavigateViewPayload } from "@elizaos/shared";

export const MAX_PENDING_VIEW_OPERATIONS = 32;
export const MAX_ACKNOWLEDGED_VIEW_OPERATIONS = 64;
export const ACKNOWLEDGED_VIEW_OPERATION_RETENTION_MS = 5 * 60_000;
export const MAX_VIEW_OPERATION_BYTES = 16 * 1024;
export const MAX_RETAINED_VIEW_OPERATION_BYTES = 256 * 1024;

export interface PendingViewOperation extends ShellNavigateViewPayload {
  operationId: string;
  operationRevision: number;
  /** Current-view CAS revision committed by this operation. */
  revision: number;
}

interface StoredPendingViewOperation {
  operation: PendingViewOperation;
  fingerprint: string;
  serializedBytes: number;
}

interface AcknowledgedViewOperation {
  operation: PendingViewOperation;
  fingerprint: string;
  serializedBytes: number;
  acknowledgedAt: number;
}

export interface ViewNavigationOutboxState {
  operationRevision: number;
  pending: StoredPendingViewOperation[];
  acknowledged: AcknowledgedViewOperation[];
}

export type PrepareViewOperationResult =
  | { kind: "new"; state: ViewNavigationOutboxState }
  | {
      kind: "retry" | "acknowledged-retry";
      operation: PendingViewOperation;
      state: ViewNavigationOutboxState;
    }
  | { kind: "conflict"; reason: "payload-mismatch" | "already-acknowledged" }
  | { kind: "too-large" }
  | { kind: "full" };

export type AcknowledgeViewOperationResult =
  | {
      kind: "acked" | "already-acked";
      operationId: string;
      operationRevision: number;
      state: ViewNavigationOutboxState;
    }
  | { kind: "conflict" }
  | { kind: "full" }
  | { kind: "unknown" };

export function createViewNavigationOutboxState(): ViewNavigationOutboxState {
  return { operationRevision: 0, pending: [], acknowledged: [] };
}

export function listPendingViewOperations(
  state: ViewNavigationOutboxState,
): PendingViewOperation[] {
  return state.pending.map(({ operation }) => operation);
}

function pruneAcknowledgedViewOperations(
  state: ViewNavigationOutboxState,
  now: number,
): ViewNavigationOutboxState {
  const acknowledged = state.acknowledged.filter(
    (operation) =>
      now - operation.acknowledgedAt <=
      ACKNOWLEDGED_VIEW_OPERATION_RETENTION_MS,
  );
  return acknowledged.length === state.acknowledged.length
    ? state
    : { ...state, acknowledged };
}

function retainedViewOperationBytes(state: ViewNavigationOutboxState): number {
  return [...state.pending, ...state.acknowledged].reduce(
    (total, operation) => total + operation.serializedBytes,
    0,
  );
}

export function hasRetainedViewOperations(
  state: ViewNavigationOutboxState,
  now: number = Date.now(),
): boolean {
  return (
    state.pending.length > 0 ||
    state.acknowledged.some(
      (operation) =>
        now - operation.acknowledgedAt <=
        ACKNOWLEDGED_VIEW_OPERATION_RETENTION_MS,
    )
  );
}

/** Preflight an operation before any current-view state is mutated. */
export function prepareViewOperation(
  state: ViewNavigationOutboxState,
  operationId: string,
  fingerprint: string,
  serializedBytes: number,
  now: number = Date.now(),
): PrepareViewOperationResult {
  const activeState = pruneAcknowledgedViewOperations(state, now);
  const pending = activeState.pending.find(
    ({ operation }) => operation.operationId === operationId,
  );
  if (pending) {
    return pending.fingerprint === fingerprint
      ? { kind: "retry", operation: pending.operation, state: activeState }
      : { kind: "conflict", reason: "payload-mismatch" };
  }
  const acknowledged = activeState.acknowledged.find(
    ({ operation }) => operation.operationId === operationId,
  );
  if (acknowledged) {
    return acknowledged.fingerprint === fingerprint
      ? {
          kind: "acknowledged-retry",
          operation: acknowledged.operation,
          state: activeState,
        }
      : { kind: "conflict", reason: "already-acknowledged" };
  }
  if (serializedBytes > MAX_VIEW_OPERATION_BYTES) {
    return { kind: "too-large" };
  }
  return activeState.pending.length >= MAX_PENDING_VIEW_OPERATIONS ||
    activeState.acknowledged.length + activeState.pending.length >=
      MAX_ACKNOWLEDGED_VIEW_OPERATIONS ||
    retainedViewOperationBytes(activeState) + serializedBytes >
      MAX_RETAINED_VIEW_OPERATION_BYTES
    ? { kind: "full" }
    : { kind: "new", state: activeState };
}

/** Append after preflight and the matching current-view commit complete. */
export function appendViewOperation(
  state: ViewNavigationOutboxState,
  input: {
    operationId: string;
    fingerprint: string;
    serializedBytes: number;
    revision: number;
    payload: ShellNavigateViewPayload;
  },
): { operation: PendingViewOperation; state: ViewNavigationOutboxState } {
  const operationRevision = state.operationRevision + 1;
  const operation: PendingViewOperation = {
    ...input.payload,
    operationId: input.operationId,
    operationRevision,
    revision: input.revision,
  };
  return {
    operation,
    state: {
      ...state,
      operationRevision,
      pending: [
        ...state.pending,
        {
          operation,
          fingerprint: input.fingerprint,
          serializedBytes: input.serializedBytes,
        },
      ],
    },
  };
}

/** Remove exactly one applied operation without coupling to global view state. */
export function acknowledgeViewOperation(
  state: ViewNavigationOutboxState,
  operationId: string,
  expectedOperationRevision: number,
  now: number = Date.now(),
): AcknowledgeViewOperationResult {
  const activeState = pruneAcknowledgedViewOperations(state, now);
  const pendingIndex = activeState.pending.findIndex(
    ({ operation }) => operation.operationId === operationId,
  );
  if (pendingIndex >= 0) {
    if (pendingIndex !== 0) return { kind: "conflict" };
    const storedPending = activeState.pending[pendingIndex];
    const pending = storedPending?.operation;
    if (!pending || pending.operationRevision !== expectedOperationRevision) {
      return { kind: "conflict" };
    }
    if (activeState.acknowledged.length >= MAX_ACKNOWLEDGED_VIEW_OPERATIONS) {
      return { kind: "full" };
    }
    const acknowledged = [
      ...activeState.acknowledged,
      {
        operation: pending,
        fingerprint: storedPending.fingerprint,
        serializedBytes: storedPending.serializedBytes,
        acknowledgedAt: now,
      },
    ];
    return {
      kind: "acked",
      operationId,
      operationRevision: expectedOperationRevision,
      state: {
        ...activeState,
        pending: activeState.pending.filter(
          (_, index) => index !== pendingIndex,
        ),
        acknowledged,
      },
    };
  }

  const acknowledged = activeState.acknowledged.find(
    ({ operation }) => operation.operationId === operationId,
  );
  if (!acknowledged) return { kind: "unknown" };
  if (acknowledged.operation.operationRevision !== expectedOperationRevision) {
    return { kind: "conflict" };
  }
  return {
    kind: "already-acked",
    operationId,
    operationRevision: expectedOperationRevision,
    state: activeState,
  };
}
