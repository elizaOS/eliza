import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildAgentActionPlan } from "../src/agent-action-plan.js";

describe("agent action plan", () => {
  it("blocks proposed work when validation budget is unsafe but still allows local start", () => {
    const plan = buildAgentActionPlan({
      agentId: "agent-one",
      repo: "elizaos/eliza",
      targetBranch: "develop",
      proposedItem: {
        repo: "elizaos/eliza",
        targetBranch: "develop",
        sourceBranch: "agent/agent-one/capacitor-fix",
        ownerAgentId: "agent-one",
        authorKind: "agent",
        changedFiles: ["packages/plugin-capacitor-bridge/src/index.ts"],
        affectedPackages: ["@elizaos/plugin-capacitor-bridge"],
      },
      bootstrap: {
        identity: {
          state: "known",
          known: true,
          registrySummary: { knownAgentIdCount: 1 },
        },
      },
      preflight: {
        decision: {
          allowed: true,
          state: "ready",
          reason: "Work can be reserved.",
          blockers: [],
          warnings: [],
          requiredActions: [],
        },
        labels: ["work-preflight:ready"],
      },
      validationPlan: {
        decision: {
          allowed: false,
          state: "blocked",
          reason: "Validation plan includes broad commands.",
          blockers: ["broad_validation_commands"],
          warnings: [],
          requiredActions: ["use_recommended_scoped_commands"],
          recommendedCommands: [
            {
              command:
                "turbo run typecheck --filter=@elizaos/plugin-capacitor-bridge",
              reason: "Scope validation to the touched package.",
            },
          ],
        },
        recommendedCommands: [],
        labels: ["validation:blocked"],
      },
      conflictPrediction: {
        prediction: {
          safeToStart: true,
          state: "clear",
          reason: "No conflict risk found.",
          blockers: [],
          warnings: [],
          requiredActions: [],
        },
        overlaps: { files: [], packages: [] },
      },
      submissionGate: {
        decision: {
          allowed: false,
          state: "needs_verification",
          reason: "Validation budget is blocked.",
          blockers: ["validation_budget"],
          warnings: [],
          requiredActions: ["replace_broad_validation_commands"],
        },
      },
      reviewAssignment: {
        decision: {
          assignmentReady: true,
          reviewRequired: false,
          state: "ready",
          reason: "Reviewer is available.",
          blockers: [],
          warnings: [],
          requiredActions: ["assign_suggested_reviewers"],
          suggestedReviewerCount: 1,
          minimumReviewers: 1,
        },
        suggestedReviewers: [
          { agentId: "agent-reviewer", reasons: ["package_owner"] },
        ],
      },
      now: "2026-07-07T00:00:00.000Z",
    });

    assert.equal(plan.readOnly, true);
    assert.equal(plan.mode, "proposed_work");
    assert.equal(plan.decision.state, "blocked");
    assert.equal(plan.decision.canStart, true);
    assert.equal(plan.decision.canSubmit, false);
    assert.ok(plan.decision.blockers.includes("broad_validation_commands"));
    assert.equal(
      plan.checks.find((check) => check.id === "validation_budget").status,
      "fail",
    );
    assert.equal(plan.nextSteps[0].action, "use_recommended_scoped_commands");
    assert.equal(plan.nextSteps[0].priority, "blocking");
    assert.ok(plan.labels.includes("agent-action-plan:validation_budget:fail"));
  });

  it("uses bootstrap and routing context when no proposed work is supplied", () => {
    const plan = buildAgentActionPlan({
      agentId: "agent-two",
      repo: "elizaos/eliza",
      bootstrap: {
        identity: {
          state: "known",
          known: true,
        },
        nextActions: [
          {
            id: "inspect_agent_inbox",
            title: "Inspect inbox",
            action: "inspect_agent_inbox",
            blocking: false,
            reason: "Check owned work first.",
          },
        ],
      },
      inbox: {
        counts: { cards: 1 },
        cards: [{ id: "card-one", title: "Fix flaky check", lane: "Ready" }],
      },
      routing: {
        counts: { recommendations: 1 },
        recommendations: [
          {
            id: "route-one",
            itemId: "elizaos/eliza#42",
            reason: "Capacity is available.",
          },
        ],
      },
      now: "2026-07-07T00:00:00.000Z",
    });

    assert.equal(plan.mode, "situational_awareness");
    assert.equal(plan.decision.state, "ready");
    assert.equal(plan.decision.canStart, true);
    assert.equal(plan.decision.canSubmit, false);
    assert.equal(plan.nextSteps[0].action, "inspect_agent_inbox");
    assert.equal(plan.context.inbox.counts.cards, 1);
    assert.equal(
      plan.context.routing.recommendations[0].itemId,
      "elizaos/eliza#42",
    );
    assert.ok(plan.labels.includes("agent-action-plan:situational"));
  });
});
