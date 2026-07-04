// Exercises LifeOps owner workflows, connector boundaries, and scheduled-task behavior.
import { describe, expect, it } from "vitest";
import {
  evaluateLifeOpsPolicyMemory,
  type LifeOpsPolicyEvaluationRequest,
} from "../src/lifeops/policy-memory.js";

/**
 * The LifeOps policy engine authorizes sensitive operations (#8833). Its most
 * important property is failing CLOSED: with no matching rule, a high-risk op
 * (delete) must deny and a sensitive op (send/read_aloud) must require approval
 * — never silently allow. A malformed request must also deny.
 */

const req = (
  o: Partial<LifeOpsPolicyEvaluationRequest>,
): LifeOpsPolicyEvaluationRequest =>
  ({
    requestId: "r1",
    requestedBy: "agent-1",
    operation: "delete",
    subject: { kind: "owner", id: "owner-1", sensitivity: "routine" },
    scope: { surface: "chat" },
    sensitivity: "routine",
    now: new Date("2026-06-23T12:00:00Z"),
    ...o,
  }) as LifeOpsPolicyEvaluationRequest;

const codes = (d: { reasons: ReadonlyArray<{ code: string }> }) =>
  d.reasons.map((r) => r.code);

describe("evaluateLifeOpsPolicyMemory — fail-closed defaults (no rules)", () => {
  it("denies a high-risk delete by default", () => {
    const d = evaluateLifeOpsPolicyMemory(req({ operation: "delete" }), []);
    expect(d.outcome).toBe("deny");
    expect(codes(d)).toContain("default_denies_high_risk_operation");
  });

  it("requires approval for send / read_aloud by default", () => {
    const send = evaluateLifeOpsPolicyMemory(req({ operation: "send" }), []);
    expect(send.outcome).toBe("require_approval");
    expect(codes(send)).toContain("default_requires_approval");

    const read = evaluateLifeOpsPolicyMemory(
      req({ operation: "read_aloud" }),
      [],
    );
    expect(read.outcome).toBe("require_approval");
  });
});

describe("evaluateLifeOpsPolicyMemory — malformed requests deny", () => {
  it("denies when `now` is invalid", () => {
    const d = evaluateLifeOpsPolicyMemory(req({ now: "not-a-date" }), []);
    expect(d.outcome).toBe("deny");
    expect(codes(d)).toContain("malformed_request");
  });

  it("denies when a required field is missing", () => {
    const d = evaluateLifeOpsPolicyMemory(req({ requestId: "" }), []);
    expect(d.outcome).toBe("deny");
    expect(codes(d)).toContain("malformed_request");
  });
});
