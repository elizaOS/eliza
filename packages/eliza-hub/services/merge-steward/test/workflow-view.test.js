import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildWorkflowView } from "../src/workflow-view.js";

describe("workflow view model", () => {
  it("joins queue items claims runs approvals human requests and readiness into cockpit cards", () => {
    const workflow = buildWorkflowView({
      now: "2026-07-06T00:10:00.000Z",
      readiness: {
        ok: true,
        checkedAt: "2026-07-06T00:10:00.000Z",
        configuration: {
          deploymentMode: "production",
          worker: { enabled: true },
        },
        checks: [
          {
            name: "worker_lease",
            ok: true,
            ownerId: "worker-one",
            status: "active",
            expiresAt: "2026-07-06T00:11:00.000Z",
          },
        ],
      },
      queueItems: [
        queueItem({
          queueState: "waiting_for_review",
          priority: 10,
          changedFiles: ["src/core.ts"],
          affectedPackages: ["core"],
        }),
        queueItem({
          id: "elizaos/eliza#302",
          pullRequestId: 302,
          queueState: "ready",
          ownerAgentId: "agent-two",
          priority: 5,
          changedFiles: ["packages/ui/index.ts"],
          affectedPackages: ["ui"],
        }),
        queueItem({
          id: "elizaos/eliza#303",
          pullRequestId: 303,
          queueState: "ready",
          ownerAgentId: "agent-owner-only",
          priority: 1,
        }),
      ],
      claims: [
        claim({
          resourceId: "src/core.ts",
          expiresAt: "2026-07-06T00:09:00.000Z",
        }),
        claim({
          id: "claim:elizaos/eliza:package:ui",
          ownerAgentId: "agent-two",
          resourceKind: "package",
          resourceId: "ui",
          expiresAt: "2026-07-06T00:30:00.000Z",
        }),
        claim({
          id: "claim:elizaos/eliza:path:owner-only",
          ownerAgentId: "agent-owner-only",
          resourceId: "unclassified-work",
          paths: ["unclassified-work"],
          expiresAt: "2026-07-06T00:30:00.000Z",
        }),
      ],
      runs: [
        {
          id: "run-one",
          queueItemId: "elizaos/eliza#301",
          repo: "elizaos/eliza",
          pullRequestId: 301,
          ownerKind: "agent",
          ownerId: "agent-one",
          status: "waiting_approval",
        },
        {
          id: "run-orphan",
          queueItemId: "elizaos/eliza#999",
          repo: "elizaos/eliza",
          pullRequestId: 999,
          ownerKind: "agent",
          ownerId: "agent-three",
          status: "failed",
          lastError: "merge conflict",
        },
      ],
      approvals: [
        {
          id: "approval-one",
          runId: "run-one",
          queueItemId: "elizaos/eliza#301",
          nodeId: "security_review",
          status: "requested",
          requestedBy: "steward",
          requestedAt: "2026-07-06T00:02:00.000Z",
        },
      ],
      humanRequests: [
        {
          id: "human-one",
          runId: "run-one",
          status: "waiting_input",
          prompt: "Confirm migration risk.",
          requestedAt: "2026-07-06T00:03:00.000Z",
        },
      ],
    });

    assert.equal(workflow.readiness.ok, true);
    assert.equal(workflow.readiness.deploymentMode, "production");
    assert.equal(workflow.readiness.workerLease.ownerId, "worker-one");
    assert.equal(workflow.filters.repo, null);
    assert.equal(workflow.counts.cards, 4);
    assert.equal(workflow.counts.openApprovals, 1);
    assert.equal(workflow.counts.openHumanRequests, 1);
    assert.equal(workflow.counts.staleClaims, 1);
    assert.equal(workflow.inbox.approvals[0].id, "approval-one");
    assert.equal(
      workflow.inbox.humanRequests[0].prompt,
      "Confirm migration risk.",
    );
    assert.equal(workflow.inbox.failedRuns[0].id, "run-orphan");

    const reviewCard = workflow.cards.find(
      (card) => card.id === "queue:elizaos/eliza#301",
    );
    assert.equal(reviewCard.status, "needs-human");
    assert.equal(reviewCard.approvals.length, 1);
    assert.deepEqual(reviewCard.nextActions.slice(0, 3), [
      "decide_approval",
      "answer_human_request",
      "recover_or_release_stale_work",
    ]);
    assert.equal(reviewCard.claims[0].status, "stale");
    assert.equal(reviewCard.approvals[0].nodeId, "security_review");
    assert.equal(reviewCard.humanRequests[0].id, "human-one");
    assert.equal(
      reviewCard.links.queueItemActionPlan,
      "/api/queue/item/action-plan?id=elizaos%2Feliza%23301&ownerAgentId=agent-one",
    );
    assert.equal(
      reviewCard.links.agentCockpit,
      "/api/agents/agent-one/cockpit?repo=elizaos%2Feliza&targetBranch=develop",
    );
    assert.equal(
      reviewCard.links.runState,
      "/api/queue/item/run-state?id=elizaos%2Feliza%23301",
    );

    const readyCard = workflow.cards.find(
      (card) => card.id === "queue:elizaos/eliza#302",
    );
    assert.equal(readyCard.status, "ready");
    assert.deepEqual(readyCard.nextActions, ["claim_or_merge_queue_lane"]);
    assert.equal(readyCard.claims[0].resourceKind, "package");
    assert.equal(
      readyCard.links.queueItemActionPlan,
      "/api/queue/item/action-plan?id=elizaos%2Feliza%23302&ownerAgentId=agent-two",
    );

    const ownerOnlyCard = workflow.cards.find(
      (card) => card.id === "queue:elizaos/eliza#303",
    );
    assert.equal(ownerOnlyCard.status, "ready");
    assert.equal(ownerOnlyCard.claims[0].ownerAgentId, "agent-owner-only");

    const orphanRunCard = workflow.cards.find(
      (card) => card.id === "run:run-orphan",
    );
    assert.equal(orphanRunCard.status, "failed");
    assert.equal(orphanRunCard.nextActions[0], "inspect");
  });

  it("marks stacked PR children as waiting on parent branches", () => {
    const workflow = buildWorkflowView({
      now: "2026-07-06T00:10:00.000Z",
      queueItems: [
        queueItem({
          id: "elizaos/eliza#410",
          pullRequestId: 410,
          sourceBranch: "agent/runtime/root",
          targetBranch: "develop",
          queueState: "ready",
          priority: 10,
        }),
        queueItem({
          id: "elizaos/eliza#411",
          pullRequestId: 411,
          sourceBranch: "agent/runtime/followup",
          targetBranch: "agent/runtime/root",
          queueState: "ready",
          priority: 9,
        }),
      ],
    });

    const root = workflow.cards.find(
      (card) => card.id === "queue:elizaos/eliza#410",
    );
    const followup = workflow.cards.find(
      (card) => card.id === "queue:elizaos/eliza#411",
    );

    assert.equal(root.status, "ready");
    assert.equal(root.stack.state, "stack_root");
    assert.ok(root.nextActions.includes("merge_stack_root"));
    assert.ok(root.nextActions.includes("claim_or_merge_queue_lane"));
    assert.equal(followup.status, "waiting");
    assert.equal(followup.stack.state, "waiting_on_stack");
    assert.equal(
      followup.stack.blockingDependencies[0].id,
      "elizaos/eliza#410",
    );
    assert.deepEqual(followup.nextActions, ["wait_for_stack_parent"]);
  });

  it("surfaces merge train and runner operations for agent cockpit clients", () => {
    const workflow = buildWorkflowView({
      now: "2026-07-06T00:10:00.000Z",
      repo: "elizaos/eliza",
      targetBranch: "develop",
      readiness: {
        ok: true,
        checkedAt: "2026-07-06T00:10:00.000Z",
        configuration: {
          deploymentMode: "staging",
          worker: { enabled: false },
        },
        checks: [],
      },
      queueItems: [
        queueItem({
          id: "elizaos/eliza#501",
          pullRequestId: 501,
          queueState: "ready",
          priority: 5,
        }),
      ],
      mergeTrain: {
        status: "dry_run_ready",
        filters: {
          repo: "elizaos/eliza",
          targetBranch: "develop",
        },
        selectedTrain: {
          id: "train:elizaos/eliza:develop:501",
          laneKey: "elizaos/eliza:develop",
          repo: "elizaos/eliza",
          targetBranch: "develop",
          mode: "single-pr",
          executionReady: false,
          itemIds: ["elizaos/eliza#501"],
          pullRequests: [
            {
              repo: "elizaos/eliza",
              pullRequestId: 501,
              ownerAgentId: "agent-one",
              integrationBranch: "eliza-queue/develop/501",
              requiredChecks: ["smoke"],
            },
          ],
          blockers: ["integration_dry_run"],
          nextAction: "review_dry_run_train",
        },
        preflight: {
          status: "dry_run_ready",
          liveExecutionReady: false,
          dryRunReviewReady: true,
          blockers: [],
          warnings: ["live_execution_enabled"],
          requiredActions: [
            "review_dry_run_train",
            "confirm_live_merge_before_cutover",
          ],
        },
      },
    });

    assert.equal(workflow.operations.status, "dry_run_ready");
    assert.equal(workflow.operations.actions.provider, "forgejo_actions");
    assert.equal(workflow.operations.actions.status, "dry_run_ready");
    assert.equal(workflow.operations.runner.status, "dry_run_only");
    assert.equal(workflow.operations.runner.privateEvidenceRequired, true);
    assert.equal(workflow.operations.mergeQueue.status, "dry_run_ready");
    assert.equal(workflow.operations.mergeQueue.dryRunReviewReady, true);
    assert.deepEqual(workflow.operations.mergeQueue.selectedItemIds, [
      "elizaos/eliza#501",
    ]);
    assert.ok(
      workflow.operations.nextActions.includes(
        "confirm_live_merge_before_cutover",
      ),
    );
  });

  it("scopes cards inbox and operation filters by repo target branch and agent", () => {
    const workflow = buildWorkflowView({
      now: "2026-07-06T00:10:00.000Z",
      repo: "elizaos/eliza",
      targetBranch: "develop",
      ownerAgentId: "agent-one",
      queueItems: [
        queueItem({
          id: "elizaos/eliza#601",
          pullRequestId: 601,
          targetBranch: "develop",
          ownerAgentId: "agent-one",
          queueState: "ready",
        }),
        queueItem({
          id: "elizaos/eliza#602",
          pullRequestId: 602,
          targetBranch: "main",
          ownerAgentId: "agent-one",
          queueState: "ready",
        }),
        queueItem({
          id: "other/repo#603",
          repo: "other/repo",
          pullRequestId: 603,
          targetBranch: "develop",
          ownerAgentId: "agent-one",
          queueState: "ready",
        }),
      ],
      claims: [
        claim({
          ownerAgentId: "agent-one",
          resourceId: "README.md",
          paths: ["README.md"],
        }),
        claim({
          ownerAgentId: "agent-two",
          resourceId: "src/other.ts",
          paths: ["src/other.ts"],
        }),
      ],
      runs: [
        {
          id: "run-601",
          queueItemId: "elizaos/eliza#601",
          repo: "elizaos/eliza",
          pullRequestId: 601,
          ownerKind: "agent",
          ownerId: "agent-one",
          targetBranch: "develop",
          status: "failed",
        },
      ],
      approvals: [
        {
          id: "approval-601",
          runId: "run-601",
          queueItemId: "elizaos/eliza#601",
          status: "requested",
        },
      ],
    });

    assert.deepEqual(workflow.filters, {
      repo: "elizaos/eliza",
      targetBranch: "develop",
      ownerAgentId: "agent-one",
    });
    assert.equal(workflow.counts.queueItems, 1);
    assert.equal(workflow.counts.cards, 1);
    assert.equal(workflow.counts.openApprovals, 1);
    assert.equal(workflow.inbox.approvals[0].id, "approval-601");
    assert.deepEqual(
      workflow.cards.map((card) => card.id),
      ["queue:elizaos/eliza#601"],
    );
  });
});

function queueItem(overrides = {}) {
  return {
    id: "elizaos/eliza#301",
    repo: "elizaos/eliza",
    pullRequestId: 301,
    targetBranch: "develop",
    queueState: "ready",
    ownerAgentId: "agent-one",
    hasExecutionPlan: true,
    changedFiles: [],
    affectedPackages: [],
    ...overrides,
  };
}

function claim(overrides = {}) {
  return {
    id: "claim:elizaos/eliza:path:src/core.ts",
    repo: "elizaos/eliza",
    resourceKind: "path",
    resourceId: "src/core.ts",
    ownerAgentId: "agent-one",
    status: "active",
    paths: ["src/core.ts"],
    expiresAt: "2026-07-06T00:30:00.000Z",
    ...overrides,
  };
}
