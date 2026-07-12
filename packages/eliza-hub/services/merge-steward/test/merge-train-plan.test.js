import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildMergeTrainPlan } from "../src/merge-train-plan.js";

describe("merge train plan", () => {
  it("publishes a read-only execution contract for the next selected train", () => {
    const plan = buildMergeTrainPlan({
      now: "2026-07-07T00:00:00.000Z",
      repo: "elizaos/eliza",
      config: {
        enabled: true,
        dryRun: true,
        allowBatching: true,
        maxBatchSize: 2,
        branchPrefix: "eliza-queue",
        executor: "local-git",
      },
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
          changedFiles: ["packages/client/src/b.ts"],
          affectedPackages: ["client"],
        }),
        queueItem({
          id: "elizaos/eliza#3",
          pullRequestId: 3,
          priority: 8,
          changedFiles: ["packages/core/src/c.ts"],
          affectedPackages: ["core"],
        }),
        queueItem({
          id: "elizaos/eliza#4",
          pullRequestId: 4,
          priority: 7,
          reviewSatisfied: false,
          changedFiles: ["packages/runtime/src/d.ts"],
          affectedPackages: ["runtime"],
        }),
      ],
    });

    assert.equal(plan.readOnly, true);
    assert.equal(plan.status, "dry_run_ready");
    assert.equal(plan.integration.batching, true);
    assert.equal(plan.queue.health, "attention");
    assert.equal(plan.selectedTrain.mode, "batch");
    assert.equal(plan.selectedTrain.executionReady, false);
    assert.deepEqual(plan.selectedTrain.itemIds, [
      "elizaos/eliza#1",
      "elizaos/eliza#2",
    ]);
    assert.deepEqual(plan.selectedTrain.blockers, ["integration_dry_run"]);
    assert.equal(plan.selectedTrain.nextAction, "review_dry_run_train");
    assert.deepEqual(plan.selectedTrain.integrationBranches, [
      "eliza-queue/develop/elizaos-eliza-pr-1",
      "eliza-queue/develop/elizaos-eliza-pr-2",
    ]);
    assert.deepEqual(plan.selectedTrain.requiredChecks, ["smoke"]);
    assert.equal(plan.preflight.status, "dry_run_ready");
    assert.equal(plan.preflight.liveExecutionReady, false);
    assert.equal(plan.preflight.dryRunReviewReady, true);
    assert.deepEqual(plan.preflight.blockers, []);
    assert.ok(plan.preflight.warnings.includes("live_execution_enabled"));
    assert.ok(plan.preflight.warnings.includes("queue_blockers_clear"));
    assert.equal(
      plan.preflight.checks.find(
        (check) => check.name === "required_checks_declared",
      ).status,
      "pass",
    );
    assert.equal(plan.selectedTrain.actions.length, 8);
    assert.equal(plan.selectedTrain.skippedItems[0].reason, "max_batch_size");
    assert.deepEqual(plan.labels, [
      "merge-train:dry_run_ready",
      "merge-train:batch",
      "merge-train:needs-attention",
    ]);

    const lane = plan.lanes[0];
    assert.equal(lane.key, "elizaos/eliza:develop");
    assert.equal(lane.nextAction, "execute_or_review_lane_train");
    assert.deepEqual(lane.trainCandidateItemIds, [
      "elizaos/eliza#1",
      "elizaos/eliza#2",
    ]);
    assert.deepEqual(lane.blockedItems[0].requiredActions, [
      "maintainer_review",
    ]);
  });

  it("marks the selected train executable only when live integration is enabled", () => {
    const plan = buildMergeTrainPlan({
      now: "2026-07-07T00:00:00.000Z",
      config: {
        enabled: true,
        dryRun: false,
        allowBatching: false,
      },
      queueItems: [
        queueItem({
          id: "elizaos/eliza#1",
          pullRequestId: 1,
        }),
      ],
    });

    assert.equal(plan.status, "ready_to_execute");
    assert.equal(plan.selectedTrain.executionReady, true);
    assert.deepEqual(plan.selectedTrain.blockers, []);
    assert.equal(plan.selectedTrain.nextAction, "execute_queue_run_once");
    assert.equal(plan.preflight.status, "live_ready");
    assert.equal(plan.preflight.liveExecutionReady, true);
    assert.equal(plan.preflight.dryRunReviewReady, false);
    assert.ok(
      plan.safety.liveExecutionRequires.includes(
        "MERGE_STEWARD_WORKER_CONFIRM_LIVE_EXECUTION=true",
      ),
    );
  });

  it("keeps live execution blocked when selected PRs lack required checks", () => {
    const plan = buildMergeTrainPlan({
      now: "2026-07-07T00:00:00.000Z",
      config: {
        enabled: true,
        dryRun: false,
        allowBatching: false,
      },
      queueItems: [
        queueItem({
          id: "elizaos/eliza#7",
          pullRequestId: 7,
          requiredChecks: [],
        }),
      ],
    });

    assert.equal(plan.status, "plan_blocked");
    assert.equal(plan.selectedTrain.executionReady, false);
    assert.deepEqual(plan.selectedTrain.blockers, ["required_checks_missing"]);
    assert.equal(plan.selectedTrain.nextAction, "configure_required_checks");
    assert.equal(plan.preflight.status, "blocked");
    assert.equal(plan.preflight.liveExecutionReady, false);
    assert.deepEqual(plan.preflight.blockers, ["required_checks_declared"]);
    assert.deepEqual(plan.preflight.requiredActions, [
      "configure_required_checks",
    ]);
    assert.equal(
      plan.preflight.checks.find(
        (check) => check.name === "required_checks_declared",
      ).status,
      "fail",
    );
  });

  it("keeps empty queue preflight focused on observation instead of live merge setup", () => {
    const plan = buildMergeTrainPlan({
      now: "2026-07-07T00:00:00.000Z",
      config: {
        enabled: false,
        dryRun: true,
      },
      queueItems: [],
    });

    assert.equal(plan.status, "empty");
    assert.equal(plan.preflight.status, "empty");
    assert.equal(
      plan.preflight.checks.find((check) => check.name === "selected_train")
        .status,
      "skip",
    );
    assert.equal(
      plan.preflight.checks.find(
        (check) => check.name === "integration_enabled",
      ).status,
      "skip",
    );
    assert.equal(
      plan.preflight.checks.find(
        (check) => check.name === "live_execution_enabled",
      ).status,
      "skip",
    );
    assert.deepEqual(plan.preflight.blockers, []);
    assert.deepEqual(plan.preflight.requiredActions, ["observe_queue"]);
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
