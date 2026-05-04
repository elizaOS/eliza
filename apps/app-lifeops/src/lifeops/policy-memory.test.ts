import { describe, expect, it } from "vitest";
import {
  evaluateLifeOpsPolicyMemory,
  type LifeOpsPolicyEvaluationRequest,
  type LifeOpsPolicyEvidence,
  type LifeOpsPolicyRule,
} from "./policy-memory.js";

const NOW = "2026-01-15T18:00:00.000Z";

function evidence(sourceId: string): readonly LifeOpsPolicyEvidence[] {
  return [
    {
      source: "user_instruction",
      sourceId,
      actorId: "owner",
      recordedAt: "2026-01-01T00:00:00.000Z",
    },
  ];
}

function rule(overrides: Partial<LifeOpsPolicyRule>): LifeOpsPolicyRule {
  const id = overrides.id ?? "policy-rule";
  return {
    kind: "lifeops_policy_rule",
    id,
    version: 1,
    operations: ["send"],
    effect: "allow",
    subject: { kind: "any" },
    precedence: 0,
    evidence: evidence(id),
    reviewState: "active",
    ...overrides,
  };
}

function request(
  overrides: Partial<LifeOpsPolicyEvaluationRequest> = {},
): LifeOpsPolicyEvaluationRequest {
  return {
    requestId: "request-1",
    operation: "send",
    requestedBy: "agent-runtime",
    subject: {
      kind: "contact",
      id: "contact-1",
      labels: ["known"],
      sensitivity: "personal",
    },
    scope: {
      surface: "chat",
      region: "US",
      channel: "imessage",
      contactId: "contact-1",
      resource: { kind: "message", id: "message-1" },
    },
    sensitivity: "personal",
    contactSensitivity: "personal",
    recipientCount: 1,
    now: NOW,
    ...overrides,
  };
}

describe("LifeOps durable policy memory evaluator", () => {
  it("resolves same-rank allow/deny conflicts by denying", () => {
    const decision = evaluateLifeOpsPolicyMemory(request(), [
      rule({ id: "allow-send", effect: "allow" }),
      rule({ id: "deny-send", effect: "deny" }),
    ]);

    expect(decision.outcome).toBe("deny");
    expect(decision.reasons.map((reason) => reason.code)).toEqual([
      "denied_by_rule",
      "conflicting_top_rank_rules_resolved_conservatively",
    ]);
    expect(
      decision.record.selectedRules.map((selected) => selected.ruleId),
    ).toEqual(["deny-send"]);
    expect(
      decision.record.matchedRules.map((matched) => matched.ruleId).sort(),
    ).toEqual(["allow-send", "deny-send"]);
  });

  it("lets a more specific rule beat a broad same-precedence policy", () => {
    const decision = evaluateLifeOpsPolicyMemory(request(), [
      rule({
        id: "broad-send-approval",
        effect: "require_approval",
        scopes: { surfaces: ["chat"] },
      }),
      rule({
        id: "specific-contact-allow",
        effect: "allow",
        scopes: { surfaces: ["chat"], contactIds: ["contact-1"] },
      }),
    ]);

    expect(decision.outcome).toBe("allow");
    expect(decision.reasons.map((reason) => reason.code)).toEqual([
      "allowed_by_rule",
    ]);
    expect(
      decision.record.selectedRules.map((selected) => selected.ruleId),
    ).toEqual(["specific-contact-allow"]);
  });

  it("ignores expired rules and records the audit reason", () => {
    const decision = evaluateLifeOpsPolicyMemory(
      request({
        operation: "proofread_apply",
        scope: {
          surface: "desktop",
          region: "US",
          resource: { kind: "file", id: "doc-1" },
        },
      }),
      [
        rule({
          id: "old-proofread-allow",
          operations: ["proofread_apply"],
          effect: "allow",
          expiresAt: "2026-01-14T00:00:00.000Z",
        }),
      ],
    );

    expect(decision.outcome).toBe("require_approval");
    expect(decision.reasons.map((reason) => reason.code)).toEqual([
      "default_requires_approval",
    ]);
    expect(decision.record.ignoredRules).toEqual([
      { ruleId: "old-proofread-allow", reason: "expired" },
    ]);
  });

  it("treats threshold boundaries as inclusive at the exact value", () => {
    const allowFifty = rule({
      id: "allow-small-spend",
      operations: ["spend_money"],
      effect: "allow",
      thresholds: { maxAmountUsd: 50 },
      conditions: [{ kind: "currency_is", value: "USD" }],
    });

    const atBoundary = evaluateLifeOpsPolicyMemory(
      request({
        operation: "spend_money",
        amountUsd: 50,
        currency: "USD",
        scope: {
          surface: "chat",
          region: "US",
          resource: { kind: "payment", id: "payment-1" },
        },
      }),
      [allowFifty],
    );
    const aboveBoundary = evaluateLifeOpsPolicyMemory(
      request({
        requestId: "request-2",
        operation: "spend_money",
        amountUsd: 50.01,
        currency: "USD",
        scope: {
          surface: "chat",
          region: "US",
          resource: { kind: "payment", id: "payment-2" },
        },
      }),
      [allowFifty],
    );

    expect(atBoundary.outcome).toBe("allow");
    expect(
      atBoundary.record.selectedRules.map((selected) => selected.ruleId),
    ).toEqual(["allow-small-spend"]);
    expect(aboveBoundary.outcome).toBe("deny");
    expect(aboveBoundary.record.ignoredRules).toEqual([
      { ruleId: "allow-small-spend", reason: "threshold_not_satisfied" },
    ]);
  });

  it("requires approval for sensitive contacts even when routine contacts are allowed", () => {
    const decision = evaluateLifeOpsPolicyMemory(
      request({
        subject: {
          kind: "contact",
          id: "contact-2",
          labels: ["vip"],
          sensitivity: "confidential",
        },
        scope: {
          surface: "chat",
          region: "US",
          channel: "signal",
          contactId: "contact-2",
          resource: { kind: "message", id: "message-2" },
        },
        contactSensitivity: "confidential",
        sensitivity: "confidential",
      }),
      [
        rule({
          id: "routine-contact-send",
          effect: "allow",
          thresholds: { maxContactSensitivity: "personal" },
        }),
        rule({
          id: "sensitive-contact-prompt",
          effect: "require_approval",
          conditions: [
            { kind: "contact_sensitivity_at_least", value: "confidential" },
          ],
        }),
      ],
    );

    expect(decision.outcome).toBe("require_approval");
    expect(decision.approvalMode).toBe("approval_queue");
    expect(
      decision.record.selectedRules.map((selected) => selected.ruleId),
    ).toEqual(["sensitive-contact-prompt"]);
    expect(decision.record.ignoredRules).toEqual([
      { ruleId: "routine-contact-send", reason: "threshold_not_satisfied" },
    ]);
  });

  it("defaults unmatched moderate-risk operations to approval and high-risk operations to denial", () => {
    const readDecision = evaluateLifeOpsPolicyMemory(
      request({
        operation: "read_aloud",
        scope: {
          surface: "voice",
          region: "US",
          resource: { kind: "email", id: "email-1" },
        },
      }),
      [],
    );
    const deleteDecision = evaluateLifeOpsPolicyMemory(
      request({
        requestId: "request-delete",
        operation: "delete",
        scope: {
          surface: "desktop",
          region: "US",
          resource: { kind: "file", id: "file-1" },
        },
      }),
      [],
    );

    expect(readDecision.outcome).toBe("require_approval");
    expect(readDecision.reasons[0]?.code).toBe("default_requires_approval");
    expect(deleteDecision.outcome).toBe("deny");
    expect(deleteDecision.reasons[0]?.code).toBe(
      "default_denies_high_risk_operation",
    );
  });

  it("fails closed when a durable rule has a malformed condition", () => {
    const malformed = {
      ...rule({ id: "bad-condition", operations: ["spend_money"] }),
      conditions: [{ kind: "amount_usd", operator: "around", value: 20 }],
    } as unknown as LifeOpsPolicyRule;

    const decision = evaluateLifeOpsPolicyMemory(
      request({
        operation: "spend_money",
        amountUsd: 10,
        scope: {
          surface: "chat",
          region: "US",
          resource: { kind: "payment", id: "payment-3" },
        },
      }),
      [malformed],
    );

    expect(decision.outcome).toBe("deny");
    expect(decision.reasons[0]?.code).toBe("malformed_rule");
    expect(decision.record.invalidRules[0]?.errors).toContain(
      "conditions[0].operator is unsupported",
    );
  });

  it("maps prompt_user_first rules to approval decisions with prompt mode", () => {
    const decision = evaluateLifeOpsPolicyMemory(
      request({
        operation: "spend_money",
        amountUsd: 20,
        currency: "USD",
        scope: {
          surface: "chat",
          region: "US",
          resource: { kind: "payment", id: "payment-4" },
        },
      }),
      [
        rule({
          id: "prompt-before-spend",
          operations: ["spend_money"],
          effect: "prompt_user_first",
          thresholds: { maxAmountUsd: 50 },
        }),
      ],
    );

    expect(decision.outcome).toBe("require_approval");
    expect(decision.approvalMode).toBe("prompt_user_first");
    expect(decision.reasons.map((reason) => reason.code)).toEqual([
      "prompt_user_first",
    ]);
  });

  it("does not match rules when region or surface scope differs", () => {
    const scopedAllow = rule({
      id: "us-chat-send",
      effect: "allow",
      scopes: { regions: ["US"], surfaces: ["chat"] },
    });

    const regionMismatch = evaluateLifeOpsPolicyMemory(
      request({ scope: { surface: "chat", region: "CA" } }),
      [scopedAllow],
    );
    const surfaceMismatch = evaluateLifeOpsPolicyMemory(
      request({
        requestId: "request-surface",
        scope: { surface: "voice", region: "US" },
      }),
      [scopedAllow],
    );

    expect(regionMismatch.outcome).toBe("require_approval");
    expect(regionMismatch.record.ignoredRules).toEqual([
      { ruleId: "us-chat-send", reason: "scope_mismatch" },
    ]);
    expect(surfaceMismatch.outcome).toBe("require_approval");
    expect(surfaceMismatch.record.ignoredRules).toEqual([
      { ruleId: "us-chat-send", reason: "scope_mismatch" },
    ]);
  });

  it("fails closed when an active durable rule lacks evidence", () => {
    const withoutEvidence = {
      ...rule({ id: "unevidenced-allow", effect: "allow" }),
      evidence: [],
    } as unknown as LifeOpsPolicyRule;

    const decision = evaluateLifeOpsPolicyMemory(request(), [withoutEvidence]);

    expect(decision.outcome).toBe("deny");
    expect(decision.reasons[0]?.code).toBe("malformed_rule");
    expect(decision.record.invalidRules).toEqual([
      {
        ruleId: "unevidenced-allow",
        errors: ["evidence is required for durable policy rules"],
      },
    ]);
  });
});
