/**
 * Exercises the real in-memory navigation outbox state machine, including
 * ordering, capacity, exact retries, and acknowledgement races.
 */

import { describe, expect, it } from "vitest";
import {
  ACKNOWLEDGED_VIEW_OPERATION_RETENTION_MS,
  acknowledgeViewOperation,
  appendViewOperation,
  createViewNavigationOutboxState,
  listPendingViewOperations,
  MAX_ACKNOWLEDGED_VIEW_OPERATIONS,
  MAX_PENDING_VIEW_OPERATIONS,
  MAX_RETAINED_VIEW_OPERATION_BYTES,
  MAX_VIEW_OPERATION_BYTES,
  prepareViewOperation,
} from "./view-navigation-outbox.ts";

function append(
  state: ReturnType<typeof createViewNavigationOutboxState>,
  operationId: string,
  fingerprint = operationId,
) {
  return appendViewOperation(state, {
    operationId,
    fingerprint,
    serializedBytes: 128,
    revision: state.operationRevision + 10,
    payload: { viewId: operationId, action: "open-window" },
  });
}

describe("view navigation outbox", () => {
  it("orders operations by a monotonic operation revision", () => {
    const first = append(createViewNavigationOutboxState(), "op-a");
    const second = append(first.state, "op-b");
    expect(listPendingViewOperations(second.state)).toMatchObject([
      { operationId: "op-a", operationRevision: 1 },
      { operationId: "op-b", operationRevision: 2 },
    ]);
  });

  it("returns an exact pending retry and rejects an id with another payload", () => {
    const first = append(createViewNavigationOutboxState(), "op-a", "same");
    expect(
      prepareViewOperation(first.state, "op-a", "same", 128),
    ).toMatchObject({
      kind: "retry",
      operation: { operationId: "op-a", operationRevision: 1 },
    });
    expect(prepareViewOperation(first.state, "op-a", "different", 128)).toEqual(
      {
        kind: "conflict",
        reason: "payload-mismatch",
      },
    );
  });

  it("fails closed at capacity without evicting an unacknowledged operation", () => {
    let state = createViewNavigationOutboxState();
    for (let index = 0; index < MAX_PENDING_VIEW_OPERATIONS; index++) {
      state = append(state, `op-${index}`).state;
    }
    expect(prepareViewOperation(state, "overflow", "overflow", 128)).toEqual({
      kind: "full",
    });
    expect(listPendingViewOperations(state)).toHaveLength(
      MAX_PENDING_VIEW_OPERATIONS,
    );
  });

  it("reserves one retained acknowledgement slot for every accepted pending operation", () => {
    let state = createViewNavigationOutboxState();
    const acknowledgedCount = MAX_ACKNOWLEDGED_VIEW_OPERATIONS - 1;
    for (let index = 0; index < acknowledgedCount; index++) {
      const appended = append(state, `acked-${index}`);
      const acknowledged = acknowledgeViewOperation(
        appended.state,
        `acked-${index}`,
        appended.operation.operationRevision,
        100,
      );
      if (acknowledged.kind !== "acked") {
        throw new Error("expected acknowledged operation");
      }
      state = acknowledged.state;
    }

    const reserved = append(state, "pending");
    expect(
      prepareViewOperation(reserved.state, "overflow", "overflow", 128, 100),
    ).toEqual({ kind: "full" });
    expect(listPendingViewOperations(reserved.state)).toMatchObject([
      { operationId: "pending" },
    ]);
  });

  it("bounds each operation and the total retained payload bytes", () => {
    const empty = createViewNavigationOutboxState();
    expect(
      prepareViewOperation(
        empty,
        "too-large",
        "too-large",
        MAX_VIEW_OPERATION_BYTES + 1,
      ),
    ).toEqual({ kind: "too-large" });

    let state = empty;
    const operationBytes = MAX_VIEW_OPERATION_BYTES;
    const acceptedCount = MAX_RETAINED_VIEW_OPERATION_BYTES / operationBytes;
    for (let index = 0; index < acceptedCount; index++) {
      state = appendViewOperation(state, {
        operationId: `bytes-${index}`,
        fingerprint: `bytes-${index}`,
        serializedBytes: operationBytes,
        revision: index + 1,
        payload: { viewId: `bytes-${index}` },
      }).state;
    }
    expect(
      prepareViewOperation(state, "byte-overflow", "byte-overflow", 1),
    ).toEqual({ kind: "full" });
  });

  it("acks an older operation after a later global and operation revision", () => {
    const first = append(createViewNavigationOutboxState(), "op-a");
    const second = append(first.state, "op-b");
    const acked = acknowledgeViewOperation(second.state, "op-a", 1);
    expect(acked.kind).toBe("acked");
    if (acked.kind !== "acked") throw new Error("expected acked result");
    expect(listPendingViewOperations(acked.state)).toMatchObject([
      { operationId: "op-b", operationRevision: 2 },
    ]);
  });

  it("rejects an out-of-order ack until the head operation is acknowledged", () => {
    const first = append(createViewNavigationOutboxState(), "op-a");
    const second = append(first.state, "op-b");
    expect(acknowledgeViewOperation(second.state, "op-b", 2).kind).toBe(
      "conflict",
    );
    const ackedFirst = acknowledgeViewOperation(second.state, "op-a", 1);
    if (ackedFirst.kind !== "acked") throw new Error("expected acked result");
    expect(acknowledgeViewOperation(ackedFirst.state, "op-b", 2).kind).toBe(
      "acked",
    );
  });

  it("makes repeated exact ack idempotent while rejecting mismatch and unknown", () => {
    const first = append(createViewNavigationOutboxState(), "op-a");
    const acked = acknowledgeViewOperation(first.state, "op-a", 1);
    if (acked.kind !== "acked") throw new Error("expected acked result");
    expect(acknowledgeViewOperation(acked.state, "op-a", 1).kind).toBe(
      "already-acked",
    );
    expect(acknowledgeViewOperation(acked.state, "op-a", 2).kind).toBe(
      "conflict",
    );
    expect(acknowledgeViewOperation(acked.state, "missing", 1).kind).toBe(
      "unknown",
    );
    expect(
      prepareViewOperation(acked.state, "op-a", "op-a", 128, 1),
    ).toMatchObject({
      kind: "acknowledged-retry",
      operation: { operationId: "op-a", operationRevision: 1 },
    });
    expect(
      prepareViewOperation(acked.state, "op-a", "different", 128, 1),
    ).toEqual({
      kind: "conflict",
      reason: "already-acknowledged",
    });
  });

  it("retains acknowledged retry identity for the settled-turn window", () => {
    const first = append(createViewNavigationOutboxState(), "op-a");
    const acked = acknowledgeViewOperation(first.state, "op-a", 1, 100);
    if (acked.kind !== "acked") throw new Error("expected acked result");
    expect(
      prepareViewOperation(
        acked.state,
        "op-a",
        "op-a",
        128,
        100 + ACKNOWLEDGED_VIEW_OPERATION_RETENTION_MS,
      ).kind,
    ).toBe("acknowledged-retry");
    expect(
      prepareViewOperation(
        acked.state,
        "op-a",
        "op-a",
        128,
        101 + ACKNOWLEDGED_VIEW_OPERATION_RETENTION_MS,
      ).kind,
    ).toBe("new");
  });
});
