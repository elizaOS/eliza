/**
 * Unit tests for the approval-queue transport contract's runtime surface: the
 * capability / protocol-version constants that implementations advertise, and
 * the three typed errors callers catch on — `ApprovalIdempotencyConflictError`,
 * `ApprovalStateTransitionError`, and `ApprovalNotFoundError`. Real-module
 * harness: every case constructs or throws/catches the actual classes and
 * asserts observed messages, names, and carried fields; no mocks.
 */

import { describe, expect, it } from "vitest";
import {
  APPROVAL_EXECUTION_CAPABILITY,
  APPROVAL_EXECUTION_PROTOCOL_VERSION,
  ApprovalIdempotencyConflictError,
  ApprovalNotFoundError,
  ApprovalStateTransitionError,
} from "./types.ts";

describe("approval queue transport contract", () => {
  it("advertises the cross-package approval-execution capability id", () => {
    // Implementations must advertise exactly this id for capability routing
    // to resolve an ApprovalQueue service; it is a wire contract, not copy.
    expect(APPROVAL_EXECUTION_CAPABILITY).toBe("eliza.approval-execution");
    expect(typeof APPROVAL_EXECUTION_CAPABILITY).toBe("string");
    expect(APPROVAL_EXECUTION_CAPABILITY.length).toBeGreaterThan(0);
  });

  it("declares protocol version 2", () => {
    expect(APPROVAL_EXECUTION_PROTOCOL_VERSION).toBe(2);
    expect(Number.isInteger(APPROVAL_EXECUTION_PROTOCOL_VERSION)).toBe(true);
  });
});

describe("ApprovalIdempotencyConflictError", () => {
  it("carries the conflicting key, its own name, and an Error base", () => {
    const error = new ApprovalIdempotencyConflictError("order-42");
    expect(error.idempotencyKey).toBe("order-42");
    expect(error.name).toBe("ApprovalIdempotencyConflictError");
    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(ApprovalIdempotencyConflictError);
  });

  it("formats a message naming the key and the conflict", () => {
    const error = new ApprovalIdempotencyConflictError("order-42");
    expect(error.message).toBe(
      "[ApprovalQueue] idempotency key order-42 already identifies a different approval request",
    );
  });

  it("survives a throw/catch boundary with the key intact", () => {
    expect(() => {
      throw new ApprovalIdempotencyConflictError("intent-key-7");
    }).toThrow(ApprovalIdempotencyConflictError);

    try {
      throw new ApprovalIdempotencyConflictError("intent-key-7");
    } catch (caught) {
      expect(caught).toBeInstanceOf(ApprovalIdempotencyConflictError);
      expect((caught as ApprovalIdempotencyConflictError).idempotencyKey).toBe(
        "intent-key-7",
      );
    }
  });

  it("keeps a well-formed error when the key is the empty string", () => {
    const error = new ApprovalIdempotencyConflictError("");
    expect(error.idempotencyKey).toBe("");
    expect(error.name).toBe("ApprovalIdempotencyConflictError");
    expect(error.message).toContain(
      "already identifies a different approval request",
    );
  });
});

describe("ApprovalStateTransitionError", () => {
  it("carries requestId, from, and to alongside an Error base", () => {
    const error = new ApprovalStateTransitionError(
      "req-9",
      "pending",
      "approved",
    );
    expect(error.requestId).toBe("req-9");
    expect(error.from).toBe("pending");
    expect(error.to).toBe("approved");
    expect(error.name).toBe("ApprovalStateTransitionError");
    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(ApprovalStateTransitionError);
  });

  it("formats both states into the message with the arrow separator", () => {
    const error = new ApprovalStateTransitionError(
      "req-9",
      "pending",
      "approved",
    );
    expect(error.message).toBe(
      "[ApprovalQueue] invalid transition for request req-9: pending -> approved",
    );
  });

  it("passes terminal-state names through unchanged", () => {
    const error = new ApprovalStateTransitionError("req-x", "expired", "done");
    expect(error.from).toBe("expired");
    expect(error.to).toBe("done");
    expect(error.message).toBe(
      "[ApprovalQueue] invalid transition for request req-x: expired -> done",
    );
  });

  it("is catchable by type across a throw boundary", () => {
    expect(() => {
      throw new ApprovalStateTransitionError("req-y", "done", "approved");
    }).toThrow(ApprovalStateTransitionError);
  });

  it("keeps a well-formed error for an empty request id", () => {
    const error = new ApprovalStateTransitionError("", "pending", "approved");
    expect(error.requestId).toBe("");
    expect(error.from).toBe("pending");
    expect(error.to).toBe("approved");
    expect(error.name).toBe("ApprovalStateTransitionError");
    expect(error.message).toContain("[ApprovalQueue] invalid transition");
  });
});

describe("ApprovalNotFoundError", () => {
  it("carries the missing requestId, its own name, and an Error base", () => {
    const error = new ApprovalNotFoundError("req-77");
    expect(error.requestId).toBe("req-77");
    expect(error.name).toBe("ApprovalNotFoundError");
    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(ApprovalNotFoundError);
  });

  it("formats a message naming the unknown request", () => {
    const error = new ApprovalNotFoundError("req-77");
    expect(error.message).toBe("[ApprovalQueue] request not found: req-77");
  });

  it("is catchable by type across a throw boundary", () => {
    expect(() => {
      throw new ApprovalNotFoundError("ghost-id");
    }).toThrow(ApprovalNotFoundError);
  });

  it("keeps a well-formed error for an empty id", () => {
    const error = new ApprovalNotFoundError("");
    expect(error.requestId).toBe("");
    expect(error.message).toContain("request not found");
  });
});
