import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildQueueSimulation } from "../src/queue-simulation.js";

describe("queue simulation", () => {
  it("predicts queue position plan impact and displaced current work for proposed items", () => {
    const simulation = buildQueueSimulation({
      now: "2026-07-07T00:00:00.000Z",
      repo: "elizaos/eliza",
      targetBranch: "develop",
      config: {
        enabled: true,
        dryRun: true,
        allowBatching: false,
      },
      currentItems: [
        queueItem({ id: "elizaos/eliza#1", pullRequestId: 1, priority: 5 }),
        queueItem({ id: "elizaos/eliza#2", pullRequestId: 2, priority: 4 }),
      ],
      proposedItem: queueItem({
        pullRequestId: 99,
        priority: 20,
        sourceBranch: "agent/agent-one/queue-sim",
        changedFiles: ["packages/core/src/sim.ts"],
      }),
    });

    assert.equal(simulation.readOnly, true);
    assert.equal(simulation.filters.repo, "elizaos/eliza");
    assert.equal(simulation.baseline.counts.scheduled, 2);
    assert.equal(simulation.baseline.selectedPlan.plans[0].pullRequestId, 1);
    assert.equal(simulation.simulated.counts.scheduled, 3);
    assert.equal(simulation.simulated.selectedPlan.plans[0].pullRequestId, 99);
    assert.equal(simulation.proposed[0].outcome, "selected_for_integration");
    assert.equal(simulation.proposed[0].queuePosition, 1);
    assert.equal(simulation.proposed[0].decision.allowed, true);
    assert.equal(simulation.impact.selectedPlanChanged, true);
    assert.deepEqual(
      simulation.impact.displacedItems.map((item) => ({
        id: item.id,
        beforeQueuePosition: item.beforeQueuePosition,
        afterQueuePosition: item.afterQueuePosition,
        reason: item.reason,
      })),
      [
        {
          id: "elizaos/eliza#1",
          beforeQueuePosition: 1,
          afterQueuePosition: 2,
          reason: "removed_from_selected_plan",
        },
        {
          id: "elizaos/eliza#2",
          beforeQueuePosition: 2,
          afterQueuePosition: 3,
          reason: "queue_position_increased",
        },
      ],
    );
    assert.equal(
      simulation.nextActions[0].id,
      "review_simulated_integration_plan",
    );
  });

  it("summarizes blocked proposals and empty simulation input", () => {
    const blocked = buildQueueSimulation({
      proposedItems: [
        queueItem({
          pullRequestId: 101,
          authorKind: "agent",
          ownerAgentId: "unknown-agent",
          agentKnown: false,
        }),
      ],
    });

    assert.equal(blocked.proposed[0].outcome, "blocked");
    assert.equal(blocked.proposed[0].scheduled, false);
    assert.ok(blocked.proposed[0].decision.blockers.includes("unknown_agent"));
    assert.equal(blocked.impact.proposed.blocked, 1);
    assert.equal(blocked.nextActions[0].id, "resolve_proposed_blockers");

    const empty = buildQueueSimulation();
    assert.equal(empty.proposedCount, 0);
    assert.equal(empty.nextActions[0].id, "provide_proposed_items");
  });

  it("predicts stacked PR dependencies introduced by proposed work", () => {
    const simulation = buildQueueSimulation({
      now: "2026-07-07T00:00:00.000Z",
      repo: "elizaos/eliza",
      currentItems: [
        queueItem({
          id: "elizaos/eliza#10",
          pullRequestId: 10,
          sourceBranch: "agent/runtime/root",
          targetBranch: "develop",
          priority: 10,
        }),
      ],
      proposedItem: queueItem({
        pullRequestId: 11,
        sourceBranch: "agent/runtime/followup",
        targetBranch: "agent/runtime/root",
        priority: 9,
      }),
    });

    assert.equal(simulation.baseline.dependencies.stackCount, 0);
    assert.equal(simulation.simulated.dependencies.stackCount, 1);
    assert.equal(simulation.impact.queue.stackDelta, 1);
    assert.equal(simulation.impact.queue.stackBlockedItemDelta, 1);
    assert.equal(simulation.proposed[0].outcome, "blocked");
    assert.equal(simulation.proposed[0].scheduled, false);
    assert.equal(simulation.proposed[0].stack.state, "waiting_on_stack");
    assert.equal(
      simulation.proposed[0].stack.dependencies[0].id,
      "elizaos/eliza#10",
    );
    assert.ok(
      simulation.proposed[0].decision.blockers.includes(
        "stack_dependency_pending",
      ),
    );
    assert.equal(simulation.nextActions[0].id, "resolve_proposed_blockers");
    assert.ok(
      simulation.nextActions.some(
        (action) => action.id === "review_stack_dependencies",
      ),
    );
  });
});

function queueItem(overrides = {}) {
  return {
    repo: "elizaos/eliza",
    pullRequestId: 1,
    sourceBranch: "agent/agent-one/change",
    targetBranch: "develop",
    headSha: "head-sha",
    authorKind: "agent",
    ownerAgentId: "agent-one",
    agentKnown: true,
    hasIssueLink: true,
    hasExecutionPlan: true,
    hasValidationPlan: true,
    targetProtected: true,
    reviewSatisfied: true,
    headShaMatches: true,
    changedLines: 20,
    changedFiles: ["README.md"],
    affectedPackages: ["docs"],
    requiredChecks: ["smoke"],
    checkResults: { smoke: "success" },
    ...overrides,
  };
}
