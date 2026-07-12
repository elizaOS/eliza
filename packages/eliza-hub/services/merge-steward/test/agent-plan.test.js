import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  detectAgentPlanSignals,
  detectAgentRunReceipt,
} from "../src/agent-plan.js";
import { signAgentRunReceipt } from "../src/agent-run-receipt.js";

describe("agent plan signals", () => {
  it("detects plan and validation sections in PR text", () => {
    assert.deepEqual(
      detectAgentPlanSignals(`
## Plan
- Update the steward policy.

## Validation
- npm test --prefix services/merge-steward

## Agent Run
runId: run_123
state: succeeded
failedChildren: 0
url: https://cloud.eliza.example/runs/run_123
`),
      {
        hasExecutionPlan: true,
        hasValidationPlan: true,
        agentRun: {
          runId: "run_123",
          state: "succeeded",
          failedChildren: 0,
          url: "https://cloud.eliza.example/runs/run_123",
          verified: false,
          verification: {
            method: "hmac-sha256",
            signaturePresent: false,
            secretEnv: "MERGE_STEWARD_AGENT_RUN_RECEIPT_SECRET",
            status: "unsigned",
          },
        },
      },
    );
  });

  it("does not treat incidental words as reviewable plan sections", () => {
    assert.deepEqual(
      detectAgentPlanSignals("This change plans to add tests later."),
      {
        hasExecutionPlan: false,
        hasValidationPlan: false,
      },
    );
  });

  it("extracts a standalone agent run receipt from PR text", () => {
    assert.deepEqual(
      detectAgentRunReceipt(`
## Eliza Run
- Run ID: eliza_456
- Status: waiting_approval
- Failed child keys: review::0, validate::0

## Validation
- blocked until approval clears
`),
      {
        runId: "eliza_456",
        state: "waiting-approval",
        failedChildKeys: ["review::0", "validate::0"],
        verified: false,
        verification: {
          method: "hmac-sha256",
          signaturePresent: false,
          secretEnv: "MERGE_STEWARD_AGENT_RUN_RECEIPT_SECRET",
          status: "unsigned",
        },
      },
    );
  });

  it("verifies signed agent run receipts", () => {
    const receipt = {
      runId: "eliza_789",
      state: "succeeded",
      failedChildren: 0,
      url: "https://cloud.eliza.example/runs/eliza_789",
      updatedAt: "2026-07-06T00:00:00.000Z",
    };
    const signature = signAgentRunReceipt(receipt, "receipt-secret");

    const detected = detectAgentRunReceipt(
      `
## Agent Run
runId: ${receipt.runId}
state: ${receipt.state}
failedChildren: ${receipt.failedChildren}
url: ${receipt.url}
updatedAt: ${receipt.updatedAt}
signature: ${signature}
`,
      { signatureSecret: "receipt-secret" },
    );

    assert.equal(detected.verified, true);
    assert.equal(detected.verification.status, "verified");
  });

  it("marks signed agent run receipts unverified when the secret is unavailable", () => {
    const detected = detectAgentRunReceipt(`
## Agent Run
runId: eliza_999
state: succeeded
signature: sha256=abc123
`);

    assert.equal(detected.verified, false);
    assert.equal(detected.verification.status, "secret_unconfigured");
  });
});
