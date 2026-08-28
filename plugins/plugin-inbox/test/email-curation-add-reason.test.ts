import { describe, expect, it } from "vitest";

import {
  curateEmailCandidates,
  type EmailCurationCandidate,
  type EmailCurationCitation,
} from "../src/inbox/email-curation.ts";

const candidate: EmailCurationCandidate = {
  id: "probe-add-reason",
  subject: "Hello",
  snippet: "hi",
  body: { text: "Hello world", contentType: "text/plain" },
  from: "Alice Example <alice@example.com>",
  fromEmail: "alice@example.com",
  to: [],
  cc: [],
  labels: [],
  headers: {},
};

const citation: EmailCurationCitation = {
  id: "policy-cite-1",
  candidateId: "probe-add-reason",
  span: {
    source: "policy",
    field: "retention",
    start: 0,
    end: 5,
    quote: "Hello",
  },
};

describe("email curation add_reason policy projection", () => {
  it("projects an add_reason policy effect into standardized decision reasons", () => {
    const decision = curateEmailCandidates({
      candidates: [candidate],
      now: "2026-08-27T00:00:00.000Z",
      policyHook: () => [
        {
          kind: "add_reason",
          code: "retention_hold",
          message: "Customer is on legal hold.",
        },
      ],
    }).decisions[0];

    expect(decision.policyEffects).toHaveLength(1);
    expect(decision.policyEffects[0].kind).toBe("add_reason");
    expect(decision.reasons).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "policy",
          reviewText: "Customer is on legal hold.",
          citations: [],
        }),
      ]),
    );
  });

  it("includes the policy reason in the bulk rationale instead of insufficient signal", () => {
    const decision = curateEmailCandidates({
      candidates: [candidate],
      now: "2026-08-27T00:00:00.000Z",
      policyHook: () => [
        {
          kind: "add_reason",
          code: "retention_hold",
          message: "Customer is on legal hold.",
        },
      ],
    }).decisions[0];

    expect(decision.bulkReview.rationale).not.toContain("insufficient signal");
    expect(decision.bulkReview.rationale).toContain("policy reason");
  });

  it("carries the optional policy citation on the projected reason", () => {
    const decision = curateEmailCandidates({
      candidates: [candidate],
      now: "2026-08-27T00:00:00.000Z",
      policyHook: () => [
        {
          kind: "add_reason",
          code: "retention_hold",
          message: "Customer is on legal hold.",
          citation,
        },
      ],
    }).decisions[0];

    const policyReason = decision.reasons.find(
      (reason) => reason.code === "policy",
    );
    expect(policyReason?.citations).toEqual([citation]);
  });

  it("does not project non-add_reason policy effects into reasons", () => {
    const decision = curateEmailCandidates({
      candidates: [candidate],
      now: "2026-08-27T00:00:00.000Z",
      policyHook: () => [
        {
          kind: "lower_confidence",
          amount: 0.1,
          code: "bulk_penalty",
          message: "Penalize bulk sender.",
        },
        {
          kind: "block_action",
          action: "delete",
          code: "retention_hold",
          message: "Customer is on legal hold.",
        },
      ],
    }).decisions[0];

    expect(
      decision.reasons.filter((reason) => reason.code === "policy"),
    ).toEqual([]);
    expect(decision.policyEffects).toHaveLength(2);
  });

  it("retains current behavior when no add_reason effect is supplied", () => {
    const decision = curateEmailCandidates({
      candidates: [candidate],
      now: "2026-08-27T00:00:00.000Z",
    }).decisions[0];

    expect(decision.reasons).toEqual([]);
    expect(decision.bulkReview.rationale).toContain("insufficient signal");
  });
});
