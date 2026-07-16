import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildQueueItemActionPlan,
  QUEUE_ITEM_ACTION_PLAN_SCHEMA,
  QUEUE_ITEM_ACTION_PLAN_VERSION,
} from "../src/queue-item-action-plan.js";

describe("queue item action plan", () => {
  it("turns one existing PR queue item into ranked next steps", () => {
    const plan = buildQueueItemActionPlan({
      now: "2026-07-07T02:00:00.000Z",
      ownerAgentId: "agent-one",
      queueItem: queueItem(),
      runState: {
        queueItemId: "elizaos/eliza#42",
        repo: "elizaos/eliza",
        pullRequestId: 42,
        state: "waiting-approval",
      },
      queueSummary: {
        diagnostics: {
          health: "attention",
          nextAction: "review_dry_run_plan",
        },
        items: [
          {
            id: "elizaos/eliza#42",
            repo: "elizaos/eliza",
            pullRequestId: 42,
            laneKey: "elizaos/eliza:develop",
            scheduled: true,
            planned: true,
            queuePosition: 1,
            decision: {
              allowed: true,
              state: "ready",
              blockers: [],
              requiredActions: [],
            },
            batchEligibility: {
              selected: true,
              reason: "selected",
            },
          },
        ],
      },
      mergeTrain: {
        status: "dry_run_ready",
        selectedTrain: {
          id: "train:elizaos-eliza:develop:42",
          nextAction: "review_dry_run_train",
          itemIds: ["elizaos/eliza#42"],
          blockers: ["integration_dry_run"],
        },
        lanes: [
          {
            key: "elizaos/eliza:develop",
            state: "planned",
            nextAction: "execute_or_review_lane_train",
            plannedItemIds: ["elizaos/eliza#42"],
          },
        ],
      },
      workflow: {
        cards: [
          {
            id: "queue:elizaos/eliza#42",
            status: "needs-human",
            nextActions: ["decide_approval"],
            approvals: [{ id: "approval-one" }],
          },
        ],
      },
    });

    assert.equal(plan.version, QUEUE_ITEM_ACTION_PLAN_VERSION);
    assert.equal(plan.schema, QUEUE_ITEM_ACTION_PLAN_SCHEMA);
    assert.equal(plan.readOnly, true);
    assert.equal(plan.status, "needs_attention");
    assert.equal(plan.item.id, "elizaos/eliza#42");
    assert.equal(plan.queue.scheduled, true);
    assert.equal(plan.queue.planned, true);
    assert.equal(plan.mergeTrain.inSelectedTrain, true);
    assert.equal(plan.workflow.cardId, "queue:elizaos/eliza#42");
    assert.deepEqual(
      plan.nextSteps.slice(0, 2).map((step) => step.id),
      ["decide_approval", "review_dry_run_train"],
    );
    assert.equal(plan.nextSteps[0].blocking, true);
    assert.equal(
      plan.links.agentCockpit,
      "/api/agents/agent-one/cockpit?repo=elizaos%2Feliza&targetBranch=develop",
    );
    assert.equal(
      plan.links.runState,
      "/api/queue/item/run-state?id=elizaos%2Feliza%2342",
    );
  });

  it("raises queue policy and stack blockers before passive queue watching", () => {
    const plan = buildQueueItemActionPlan({
      queueItem: queueItem({
        pullRequestId: 43,
        id: "elizaos/eliza#43",
        queueState: "ready",
      }),
      queueSummary: {
        items: [
          {
            id: "elizaos/eliza#43",
            laneKey: "elizaos/eliza:develop",
            scheduled: false,
            planned: false,
            decision: {
              allowed: false,
              state: "blocked",
              blockers: ["review_required"],
              requiredActions: ["maintainer_review"],
            },
            stack: {
              state: "waiting_on_stack",
              stackBlocked: true,
              blockingDependencies: ["elizaos/eliza#42"],
              requiredActions: ["merge_stack_parents_first"],
            },
          },
        ],
      },
    });

    assert.equal(plan.status, "needs_attention");
    assert.equal(plan.queue.decision.allowed, false);
    assert.deepEqual(
      plan.nextSteps.slice(0, 2).map((step) => step.id),
      ["resolve_queue_policy", "merge_stack_parents_first"],
    );
    assert.deepEqual(plan.nextSteps[0].requiredActions, ["maintainer_review"]);
    assert.deepEqual(plan.nextSteps[1].blockingDependencies, [
      "elizaos/eliza#42",
    ]);
  });
});

function queueItem(overrides = {}) {
  return {
    id: "elizaos/eliza#42",
    repo: "elizaos/eliza",
    pullRequestId: 42,
    sourceBranch: "agent/agent-one/cockpit",
    targetBranch: "develop",
    headSha: "head-sha",
    authorKind: "agent",
    ownerAgentId: "agent-one",
    queueState: "waiting_for_review",
    priority: 10,
    ...overrides,
  };
}
