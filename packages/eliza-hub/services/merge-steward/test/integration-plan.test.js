import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildBatchEligibilityIndex,
  buildIntegrationPlan,
  integrationBranchName,
} from "../src/integration-plan.js";

describe("integration branch planner", () => {
  it("plans a single allowed PR by default", () => {
    const plan = buildIntegrationPlan({
      items: [
        queueItem({ pullRequestId: 8, priority: 0 }),
        queueItem({ pullRequestId: 7, priority: 10 }),
        {
          ...queueItem({ pullRequestId: 9 }),
          agentKnown: false,
        },
      ],
      config: {
        enabled: true,
        dryRun: true,
        branchPrefix: "eliza-queue",
      },
    });

    assert.equal(plan.enabled, true);
    assert.equal(plan.dryRun, true);
    assert.equal(plan.strategy, "single-pr");
    assert.equal(plan.queuedCount, 2);
    assert.equal(plan.planCount, 1);
    assert.equal(plan.plans[0].pullRequestId, 7);
    assert.equal(
      plan.plans[0].integrationBranch,
      "eliza-queue/develop/elizaos-eliza-pr-7",
    );
    assert.deepEqual(
      plan.plans[0].actions.map((action) => action.type),
      [
        "ensure_integration_branch",
        "merge_pr_head_into_integration",
        "wait_for_checks",
        "merge_original_pull_request",
      ],
    );
  });

  it("plans batches when batching is enabled", () => {
    const plan = buildIntegrationPlan({
      items: [
        queueItem({
          pullRequestId: 1,
          changedFiles: ["packages/core/src/a.ts"],
          affectedPackages: ["core"],
        }),
        queueItem({
          pullRequestId: 2,
          changedFiles: ["packages/runtime/src/b.ts"],
          affectedPackages: ["runtime"],
        }),
      ],
      config: {
        allowBatching: true,
      },
    });

    assert.equal(plan.strategy, "batch");
    assert.equal(plan.planCount, 2);
    assert.equal(plan.batch.enabled, true);
    assert.equal(plan.batch.mode, "safe-disjoint");
    assert.equal(plan.batch.selectedCount, 2);
    assert.deepEqual(plan.skippedItems, []);
  });

  it("uses repository batched policy and max batch size without global batching", () => {
    const plan = buildIntegrationPlan({
      items: [
        queueItem({
          pullRequestId: 1,
          priority: 10,
          changedFiles: ["packages/core/src/a.ts"],
          affectedPackages: ["core"],
          policySnapshot: {
            queueMode: "batched",
            policy: { maxBatchSize: 2 },
          },
        }),
        queueItem({
          pullRequestId: 2,
          priority: 9,
          changedFiles: ["packages/runtime/src/b.ts"],
          affectedPackages: ["runtime"],
          policySnapshot: {
            queueMode: "batched",
            policy: { maxBatchSize: 2 },
          },
        }),
        queueItem({
          pullRequestId: 3,
          priority: 8,
          changedFiles: ["packages/client/src/c.ts"],
          affectedPackages: ["client"],
          policySnapshot: {
            queueMode: "batched",
            policy: { maxBatchSize: 2 },
          },
        }),
      ],
    });

    assert.equal(plan.strategy, "batch");
    assert.equal(plan.planCount, 2);
    assert.equal(plan.batch.maxBatchSize, 2);
    assert.equal(plan.batch.policyQueueMode, "batched");
    assert.equal(plan.skippedItems.length, 1);
    assert.equal(plan.skippedItems[0].pullRequestId, 3);
    assert.equal(plan.skippedItems[0].reason, "max_batch_size");
  });

  it("skips unsafe batch candidates while keeping the lead item", () => {
    const plan = buildIntegrationPlan({
      items: [
        queueItem({
          pullRequestId: 1,
          priority: 10,
          changedFiles: ["packages/core/src/a.ts"],
          affectedPackages: ["core"],
        }),
        queueItem({
          pullRequestId: 2,
          priority: 9,
          changedFiles: ["packages/core/src/a.ts"],
          affectedPackages: ["runtime"],
        }),
        queueItem({
          repo: "elizaos/runtime",
          pullRequestId: 3,
          priority: 8,
          changedFiles: ["packages/runtime/src/b.ts"],
          affectedPackages: ["runtime"],
        }),
        queueItem({
          pullRequestId: 4,
          priority: 7,
          changedLines: 1000,
          changedFiles: ["packages/client/src/c.ts"],
          affectedPackages: ["client"],
        }),
      ],
      config: {
        allowBatching: true,
      },
    });

    assert.equal(plan.strategy, "batch");
    assert.equal(plan.planCount, 1);
    assert.equal(plan.plans[0].pullRequestId, 1);
    assert.deepEqual(
      plan.skippedItems.map((item) => item.reason),
      ["batch_impact_overlap", "different_queue_lane", "item_not_batch_safe"],
    );
  });

  it("builds an explainable batch eligibility index", () => {
    const scheduled = [
      queueItem({
        id: "elizaos/eliza#1",
        pullRequestId: 1,
        risk: { level: "low" },
        conflict: { level: "low" },
        changedFiles: ["packages/core/src/a.ts"],
        affectedPackages: ["core"],
      }),
      queueItem({
        id: "elizaos/eliza#2",
        pullRequestId: 2,
        risk: { level: "low" },
        conflict: { level: "low" },
        changedFiles: ["packages/runtime/src/b.ts"],
        affectedPackages: ["runtime"],
      }),
      queueItem({
        id: "elizaos/eliza#3",
        pullRequestId: 3,
        risk: { level: "low" },
        conflict: { level: "low" },
        changedFiles: ["packages/core/src/a.ts"],
        affectedPackages: ["client"],
      }),
    ];

    const eligibility = buildBatchEligibilityIndex({
      scheduled,
      config: {
        allowBatching: true,
        maxBatchSize: 2,
      },
    });

    assert.deepEqual(eligibility.selectedItemIds, [
      "elizaos/eliza#1",
      "elizaos/eliza#2",
    ]);
    assert.deepEqual(eligibility.skippedItems, [
      {
        id: "elizaos/eliza#3",
        repo: "elizaos/eliza",
        pullRequestId: 3,
        targetBranch: "develop",
        reason: "max_batch_size",
      },
    ]);
    assert.equal(eligibility.index.get("elizaos/eliza#1").selected, true);
    assert.equal(eligibility.index.get("elizaos/eliza#1").reason, "selected");
    assert.equal(eligibility.index.get("elizaos/eliza#3").selected, false);
    assert.equal(
      eligibility.index.get("elizaos/eliza#3").reason,
      "max_batch_size",
    );
  });

  it("does not let later items jump ahead when the lead item is not batch safe", () => {
    const plan = buildIntegrationPlan({
      items: [
        queueItem({
          pullRequestId: 1,
          priority: 10,
          changedLines: 1000,
          changedFiles: ["packages/core/src/a.ts"],
          affectedPackages: ["core"],
        }),
        queueItem({
          pullRequestId: 2,
          priority: 9,
          changedFiles: ["packages/runtime/src/b.ts"],
          affectedPackages: ["runtime"],
        }),
      ],
      config: {
        allowBatching: true,
      },
    });

    assert.equal(plan.planCount, 1);
    assert.equal(plan.plans[0].pullRequestId, 1);
    assert.deepEqual(plan.skippedItems, [
      {
        id: 2,
        repo: "elizaos/eliza",
        pullRequestId: 2,
        targetBranch: "develop",
        reason: "lead_item_not_batch_safe",
      },
    ]);
  });

  it("reports empty plans when no queue items are ready", () => {
    const plan = buildIntegrationPlan({
      items: [
        {
          ...queueItem({ pullRequestId: 1 }),
          reviewSatisfied: false,
        },
      ],
    });

    assert.equal(plan.skipped, true);
    assert.equal(plan.reason, "no_ready_items");
    assert.deepEqual(plan.plans, []);
  });

  it("sanitizes integration branch names", () => {
    assert.equal(
      integrationBranchName({
        branchPrefix: "/queue/",
        item: {
          repo: "ElizaOS/Eliza Cloud",
          targetBranch: "feature/Agent Queue",
          pullRequestId: "#12",
        },
      }),
      "queue/feature-agent-queue/elizaos-eliza-cloud-pr-12",
    );
  });
});

function queueItem(overrides = {}) {
  return {
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
    changedFiles: ["README.md"],
    requiredChecks: ["smoke"],
    checkResults: { smoke: "success" },
    ...overrides,
  };
}
