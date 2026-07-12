import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  AGENT_COCKPIT_SCHEMA,
  AGENT_COCKPIT_VERSION,
  buildAgentCockpit,
} from "../src/agent-cockpit.js";

describe("agent cockpit model", () => {
  it("joins workflow and work-context snapshots into one agent resume surface", () => {
    const cockpit = buildAgentCockpit({
      agentId: "agent-one",
      repo: "elizaos/eliza",
      targetBranch: "develop",
      now: "2026-07-07T01:00:00.000Z",
      workflow: {
        filters: {
          repo: "elizaos/eliza",
          targetBranch: "develop",
          ownerAgentId: "agent-one",
        },
        counts: { cards: 2, queueItems: 1 },
        operations: {
          status: "dry_run_ready",
          runner: { status: "dry_run_only" },
          nextActions: ["review_dry_run_train"],
        },
        cards: [
          {
            id: "queue:elizaos/eliza#42",
            kind: "queue-item",
            status: "needs-human",
            title: "elizaos/eliza#42",
            repo: "elizaos/eliza",
            ownerAgentId: "agent-one",
            priority: 10,
            nextActions: ["decide_approval"],
            links: {
              queueItemActionPlan:
                "/api/queue/item/action-plan?id=elizaos%2Feliza%2342&ownerAgentId=agent-one",
            },
          },
        ],
      },
      workContext: {
        status: "needs_attention",
        filters: {
          repo: "elizaos/eliza",
          targetBranch: "develop",
          ownerAgentId: "agent-one",
        },
        summary: {
          cards: 2,
          ready: 1,
          running: 0,
          blocked: 0,
          needsHuman: 1,
          activeClaims: 1,
          staleClaims: 0,
          openApprovals: 1,
          openHumanRequests: 0,
          workItems: 1,
          mergeQueueHealth: "needs-attention",
          mergeTrainStatus: "dry_run_ready",
          workflowOperationsStatus: "dry_run_ready",
          runnerStatus: "dry_run_only",
        },
        links: {
          claimAssignment: "/api/agents/agent-one/claim-assignment",
        },
        snapshots: {
          inbox: {
            cards: [
              {
                id: "work-item:task-one",
                kind: "work-item",
                state: "ready",
                title: "Implement task one",
                repo: "elizaos/eliza",
                ownerAgentId: "agent-one",
                priority: 4,
              },
            ],
          },
        },
        nextActions: [
          {
            id: "decide_approval",
            priority: 95,
            blocking: true,
            method: "GET",
            href: "/api/agents/agent-one/inbox",
            reason: "One card needs approval.",
          },
        ],
      },
      submissionGate: {
        decision: {
          allowed: true,
          state: "allowed",
          requiredActions: [],
        },
      },
    });

    assert.equal(cockpit.version, AGENT_COCKPIT_VERSION);
    assert.equal(cockpit.schema, AGENT_COCKPIT_SCHEMA);
    assert.equal(cockpit.readOnly, true);
    assert.equal(cockpit.status, "needs_attention");
    assert.deepEqual(cockpit.filters, {
      repo: "elizaos/eliza",
      targetBranch: "develop",
      ownerAgentId: "agent-one",
    });
    assert.equal(cockpit.summary.workflowCards, 2);
    assert.equal(cockpit.summary.ownedCards, 2);
    assert.equal(cockpit.summary.needsHuman, 1);
    assert.equal(cockpit.summary.submissionAllowed, true);
    assert.equal(cockpit.summary.preflightAllowed, null);
    assert.equal(cockpit.focusCards[0].id, "queue:elizaos/eliza#42");
    assert.equal(
      cockpit.focusCards[0].links.queueItemActionPlan,
      "/api/queue/item/action-plan?id=elizaos%2Feliza%2342&ownerAgentId=agent-one",
    );
    assert.equal(cockpit.focusCards[1].id, "work-item:task-one");
    assert.equal(cockpit.nextActions[0].id, "decide_approval");
    const cardAction = cockpit.nextActions.find(
      (action) => action.id === "inspect_queue_item_action_plan",
    );
    assert.equal(
      cardAction.href,
      "/api/queue/item/action-plan?id=elizaos%2Feliza%2342&ownerAgentId=agent-one",
    );
    assert.deepEqual(cardAction.cardIds, ["queue:elizaos/eliza#42"]);
    assert.deepEqual(cardAction.requiredActions, ["decide_approval"]);
    assert.equal(
      cockpit.links.self,
      "/api/agents/agent-one/cockpit?repo=elizaos%2Feliza&targetBranch=develop",
    );
    assert.equal(
      cockpit.links.workflows,
      "/api/workflows?repo=elizaos%2Feliza&targetBranch=develop&ownerAgentId=agent-one",
    );
    assert.equal(cockpit.snapshots.workflow.operations.status, "dry_run_ready");
  });

  it("raises blocking preflight and submission actions when proposed work is unsafe", () => {
    const cockpit = buildAgentCockpit({
      agentId: "agent-two",
      preflight: {
        decision: {
          allowed: false,
          state: "blocked",
          reason: "Active claim conflict.",
          requiredActions: ["coordinate_with_claim_owner"],
        },
      },
      submissionGate: {
        decision: {
          allowed: false,
          state: "needs_verification",
          reason: "Work reservation is missing.",
          requiredActions: ["reserve_work"],
        },
      },
    });

    assert.equal(cockpit.status, "submission_blocked");
    assert.equal(cockpit.summary.preflightAllowed, false);
    assert.equal(cockpit.summary.preflightState, "blocked");
    assert.equal(cockpit.summary.submissionAllowed, false);
    assert.equal(cockpit.summary.submissionState, "needs_verification");
    assert.deepEqual(
      cockpit.nextActions.slice(0, 2).map((action) => action.id),
      ["resolve_submission_gate", "resolve_work_preflight"],
    );
    assert.equal(cockpit.nextActions[0].blocking, true);
  });
});
