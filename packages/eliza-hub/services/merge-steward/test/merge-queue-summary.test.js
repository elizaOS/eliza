import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildMergeQueueSummary } from "../src/merge-queue-summary.js";

describe("merge queue summary", () => {
  it("summarizes selected batches skipped candidates blockers and busy lanes", () => {
    const summary = buildMergeQueueSummary({
      now: "2026-07-06T00:10:00.000Z",
      config: {
        enabled: true,
        dryRun: true,
        allowBatching: true,
        maxBatchSize: 2,
        branchPrefix: "eliza-queue",
        executor: "local-git",
      },
      repo: "elizaos/eliza",
      queueItems: [
        queueItem({
          id: "elizaos/eliza#1",
          pullRequestId: 1,
          priority: 10,
          changedFiles: ["packages/core/src/a.ts"],
          affectedPackages: ["core"],
        }),
        queueItem({
          id: "elizaos/eliza#2",
          pullRequestId: 2,
          priority: 9,
          changedFiles: ["packages/runtime/src/b.ts"],
          affectedPackages: ["runtime"],
        }),
        queueItem({
          id: "elizaos/eliza#3",
          pullRequestId: 3,
          priority: 8,
          changedFiles: ["packages/core/src/a.ts"],
          affectedPackages: ["client"],
        }),
        queueItem({
          id: "elizaos/eliza#4",
          pullRequestId: 4,
          priority: 7,
          reviewSatisfied: false,
          changedFiles: ["packages/client/src/c.ts"],
          affectedPackages: ["client"],
        }),
        queueItem({
          id: "elizaos/eliza#5",
          pullRequestId: 5,
          targetBranch: "release",
          queueState: "running",
          changedFiles: ["packages/runtime/src/release.ts"],
          affectedPackages: ["runtime"],
        }),
        queueItem({
          id: "elizaos/docs#1",
          repo: "elizaos/docs",
          pullRequestId: 1,
          changedFiles: ["README.md"],
        }),
      ],
    });

    assert.equal(summary.filters.repo, "elizaos/eliza");
    assert.equal(summary.integration.enabled, true);
    assert.equal(summary.integration.executor, "local-git");
    assert.equal(summary.counts.items, 5);
    assert.equal(summary.counts.scheduled, 3);
    assert.equal(summary.counts.planned, 2);
    assert.equal(summary.counts.blocked, 1);
    assert.equal(summary.counts.running, 1);
    assert.equal(summary.selectedPlan.strategy, "batch");
    assert.equal(summary.selectedPlan.planCount, 2);
    assert.deepEqual(
      summary.selectedPlan.plans.map((plan) => plan.pullRequestId),
      [1, 2],
    );
    assert.equal(summary.selectedPlan.skippedItems[0].pullRequestId, 3);
    assert.equal(summary.selectedPlan.skippedItems[0].reason, "max_batch_size");
    assert.deepEqual(summary.batchEligibility.selectedItemIds, [
      "elizaos/eliza#1",
      "elizaos/eliza#2",
    ]);
    assert.deepEqual(
      summary.batchEligibility.skippedItems.map((item) => ({
        id: item.id,
        reason: item.reason,
      })),
      [{ id: "elizaos/eliza#3", reason: "max_batch_size" }],
    );
    assert.equal(summary.diagnostics.health, "attention");
    assert.equal(summary.diagnostics.nextAction, "review_dry_run_plan");
    assert.equal(summary.diagnostics.nextMergeTarget.pullRequestId, 1);
    assert.equal(summary.diagnostics.pressure.blockedReasonCount, 1);
    assert.equal(summary.diagnostics.pressure.batchSkipReasonCount, 1);
    assert.equal(summary.diagnostics.pressure.stuckLaneCount, 1);
    assert.deepEqual(
      summary.diagnostics.blockers.map((group) => ({
        reason: group.reason,
        count: group.count,
        requiredActions: group.requiredActions,
      })),
      [
        {
          reason: "review_required",
          count: 1,
          requiredActions: ["maintainer_review"],
        },
      ],
    );
    assert.deepEqual(
      summary.diagnostics.batchSkips.map((group) => ({
        reason: group.reason,
        count: group.count,
      })),
      [{ reason: "max_batch_size", count: 1 }],
    );
    assert.equal(summary.diagnostics.agentActions[0].ownerAgentId, "agent-one");
    assert.ok(
      summary.diagnostics.agentActions[0].requiredActions.includes(
        "maintainer_review",
      ),
    );

    const developLane = summary.lanes.find(
      (lane) => lane.key === "elizaos/eliza:develop",
    );
    assert.equal(developLane.state, "planned");
    assert.equal(developLane.scheduled, 3);
    assert.equal(developLane.planned, 2);
    assert.equal(developLane.blocked, 1);
    assert.deepEqual(developLane.batchCandidateItemIds, [
      "elizaos/eliza#1",
      "elizaos/eliza#2",
    ]);
    assert.deepEqual(developLane.batchSkippedItemIds, ["elizaos/eliza#3"]);
    assert.equal(developLane.batchSkippedItems[0].reason, "max_batch_size");
    assert.deepEqual(developLane.blockedItemIds, ["elizaos/eliza#4"]);

    const releaseLane = summary.lanes.find(
      (lane) => lane.key === "elizaos/eliza:release",
    );
    assert.equal(releaseLane.state, "busy");
    assert.deepEqual(releaseLane.runningItemIds, ["elizaos/eliza#5"]);

    const blockedItem = summary.items.find(
      (item) => item.id === "elizaos/eliza#4",
    );
    assert.equal(blockedItem.scheduled, false);
    assert.equal(blockedItem.decision.allowed, false);
    assert.ok(blockedItem.decision.blockers.includes("review_required"));

    const plannedItem = summary.items.find(
      (item) => item.id === "elizaos/eliza#1",
    );
    assert.equal(plannedItem.scheduled, true);
    assert.equal(plannedItem.planned, true);
    assert.equal(plannedItem.batchEligibility.selected, true);
    assert.equal(plannedItem.batchEligibility.reason, "selected");
    assert.equal(plannedItem.queuePosition, 1);

    const skippedItem = summary.items.find(
      (item) => item.id === "elizaos/eliza#3",
    );
    assert.equal(skippedItem.scheduled, true);
    assert.equal(skippedItem.planned, false);
    assert.equal(skippedItem.batchEligibility.selected, false);
    assert.equal(skippedItem.batchEligibility.reason, "max_batch_size");
  });

  it("surfaces stacked PR dependencies and blocks children until parents merge", () => {
    const summary = buildMergeQueueSummary({
      now: "2026-07-06T00:10:00.000Z",
      repo: "elizaos/eliza",
      queueItems: [
        queueItem({
          id: "elizaos/eliza#10",
          pullRequestId: 10,
          sourceBranch: "agent/runtime/root",
          targetBranch: "develop",
          priority: 10,
        }),
        queueItem({
          id: "elizaos/eliza#11",
          pullRequestId: 11,
          sourceBranch: "agent/runtime/followup",
          targetBranch: "agent/runtime/root",
          priority: 9,
        }),
        queueItem({
          id: "elizaos/eliza#12",
          pullRequestId: 12,
          dependsOnPullRequestIds: [11],
          priority: 8,
        }),
      ],
    });

    assert.equal(summary.dependencies.stackCount, 1);
    assert.equal(summary.dependencies.stackedItemCount, 3);
    assert.equal(summary.dependencies.blockedItemCount, 2);
    assert.equal(
      summary.dependencies.stacks[0].nextMergeItemId,
      "elizaos/eliza#10",
    );
    assert.equal(summary.diagnostics.pressure.stackCount, 1);
    assert.equal(summary.diagnostics.pressure.stackBlockedItemCount, 2);
    assert.deepEqual(
      summary.diagnostics.stacks.blockedItems.map((item) => item.id),
      ["elizaos/eliza#11", "elizaos/eliza#12"],
    );

    const root = summary.items.find((item) => item.id === "elizaos/eliza#10");
    const followup = summary.items.find(
      (item) => item.id === "elizaos/eliza#11",
    );
    const explicit = summary.items.find(
      (item) => item.id === "elizaos/eliza#12",
    );

    assert.equal(root.stack.state, "stack_root");
    assert.equal(root.decision.allowed, true);
    assert.equal(followup.stack.state, "waiting_on_stack");
    assert.equal(followup.stack.stackBlocked, true);
    assert.equal(followup.stack.dependencies[0].source, "target_branch");
    assert.equal(followup.decision.allowed, false);
    assert.ok(followup.decision.blockers.includes("stack_dependency_pending"));
    assert.ok(
      followup.decision.requiredActions.includes("merge_stack_parents_first"),
    );
    assert.equal(followup.scheduled, false);
    assert.equal(explicit.stack.dependencies[0].source, "explicit");
    assert.equal(explicit.decision.allowed, false);
    assert.ok(explicit.decision.blockers.includes("stack_dependency_pending"));
    assert.ok(
      explicit.stack.requiredActions.includes("merge_stack_parents_first"),
    );
  });
});

function queueItem(overrides = {}) {
  return {
    id: "elizaos/eliza#1",
    repo: "elizaos/eliza",
    pullRequestId: 1,
    sourceBranch: "agent/change",
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
    changedLines: 10,
    changedFiles: ["packages/core/src/a.ts"],
    affectedPackages: ["core"],
    requiredChecks: ["smoke"],
    checkResults: { smoke: "success" },
    queueState: "ready",
    ...overrides,
  };
}
