/**
 * Approval barrel unit tests pin public export identity, protocol constants,
 * and typed error construction without standing in for persistence behavior.
 */

import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import * as approvalBarrel from "./index.ts";
import {
  APPROVAL_SERVICE,
  ApprovalService,
  resolveApprovalService,
} from "./service.ts";
import { createApprovalQueue, PgApprovalQueue } from "./store.ts";
import {
  APPROVAL_EXECUTION_CAPABILITY,
  APPROVAL_EXECUTION_PROTOCOL_VERSION,
  ApprovalIdempotencyConflictError,
  ApprovalNotFoundError,
  ApprovalStateTransitionError,
} from "./types.ts";

describe("approval barrel surface", () => {
  it("re-exports the canonical service and queue implementations", () => {
    expect(approvalBarrel.ApprovalService).toBe(ApprovalService);
    expect(approvalBarrel.resolveApprovalService).toBe(resolveApprovalService);
    expect(approvalBarrel.createApprovalQueue).toBe(createApprovalQueue);
    expect(approvalBarrel.PgApprovalQueue).toBe(PgApprovalQueue);
  });

  it("pins the public service and execution protocol constants", () => {
    expect(approvalBarrel.APPROVAL_SERVICE).toBe(APPROVAL_SERVICE);
    expect(APPROVAL_SERVICE).toBe("eliza_approval");
    expect(approvalBarrel.APPROVAL_EXECUTION_CAPABILITY).toBe(
      APPROVAL_EXECUTION_CAPABILITY,
    );
    expect(APPROVAL_EXECUTION_CAPABILITY).toBe("eliza.approval-execution");
    expect(approvalBarrel.APPROVAL_EXECUTION_PROTOCOL_VERSION).toBe(
      APPROVAL_EXECUTION_PROTOCOL_VERSION,
    );
    expect(APPROVAL_EXECUTION_PROTOCOL_VERSION).toBe(2);
  });
});

describe("exported approval errors", () => {
  it("constructs an idempotency conflict with the conflicting key", () => {
    const error = new approvalBarrel.ApprovalIdempotencyConflictError("key-x");
    expect(error).toBeInstanceOf(ApprovalIdempotencyConflictError);
    expect(error.name).toBe("ApprovalIdempotencyConflictError");
    expect(error.idempotencyKey).toBe("key-x");
    expect(error.message).toContain("key-x");
  });

  it("constructs a transition error with the request and both states", () => {
    const error = new approvalBarrel.ApprovalStateTransitionError(
      "req-1",
      "pending",
      "done",
    );
    expect(error).toBeInstanceOf(ApprovalStateTransitionError);
    expect(error.name).toBe("ApprovalStateTransitionError");
    expect(error.requestId).toBe("req-1");
    expect(error.from).toBe("pending");
    expect(error.to).toBe("done");
    expect(error.message).toContain("pending -> done");
  });

  it("constructs a not-found error with the missing request id", () => {
    const requestId = `missing-${randomUUID()}`;
    const error = new approvalBarrel.ApprovalNotFoundError(requestId);
    expect(error).toBeInstanceOf(ApprovalNotFoundError);
    expect(error.name).toBe("ApprovalNotFoundError");
    expect(error.requestId).toBe(requestId);
    expect(error.message).toBe(
      `[ApprovalQueue] request not found: ${requestId}`,
    );
  });
});
