import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildAgentInsights } from "../src/agent-insights.js";

describe("agent insights model", () => {
  it("routes failed checks stale branches overlap risks and human decisions", () => {
    const insights = buildAgentInsights({
      now: "2026-07-06T00:10:00.000Z",
      repo: "elizaos/eliza",
      queueItems: [
        queueItem({
          id: "elizaos/eliza#410",
          pullRequestId: 410,
          priority: 10,
          ownerAgentId: "agent-one",
          changedFiles: ["packages/core/src/runtime.ts"],
          affectedPackages: ["core"],
          requiredChecks: ["unit", "lint"],
          checkResults: { unit: "failure", lint: "success" },
        }),
        queueItem({
          id: "elizaos/eliza#411",
          pullRequestId: 411,
          priority: 9,
          ownerAgentId: "agent-two",
          changedFiles: [
            "packages/core/src/runtime.ts",
            "packages/core/src/index.ts",
          ],
          affectedPackages: ["core"],
          targetCommitsBehind: 31,
        }),
        queueItem({
          id: "elizaos/eliza#412",
          pullRequestId: 412,
          priority: 8,
          queueState: "waiting_for_review",
          reviewSatisfied: false,
          ownerAgentId: "agent-three",
          changedFiles: ["packages/client/src/chat.ts"],
          affectedPackages: ["client"],
        }),
        queueItem({
          id: "elizaos/docs#1",
          repo: "elizaos/docs",
          pullRequestId: 1,
          ownerAgentId: "agent-docs",
          changedFiles: ["README.md"],
        }),
      ],
      claims: [
        claim({
          id: "claim-stale-core",
          ownerAgentId: "agent-one",
          resourceId: "packages/core/src/runtime.ts",
          paths: ["packages/core/src/runtime.ts"],
          expiresAt: "2026-07-06T00:00:00.000Z",
        }),
      ],
      runs: [
        {
          id: "run-review-412",
          queueItemId: "elizaos/eliza#412",
          ownerKind: "agent",
          ownerId: "agent-three",
          status: "waiting_approval",
        },
      ],
      approvals: [
        {
          id: "approval-412",
          runId: "run-review-412",
          queueItemId: "elizaos/eliza#412",
          status: "requested",
        },
      ],
      humanRequests: [
        {
          id: "human-412",
          runId: "run-review-412",
          queueItemId: "elizaos/eliza#412",
          status: "waiting_input",
        },
      ],
    });

    assert.equal(insights.filters.repo, "elizaos/eliza");
    assert.equal(insights.counts.items, 3);
    assert.equal(insights.counts.failedChecks, 1);
    assert.equal(insights.counts.staleBranches, 1);
    assert.equal(insights.counts.duplicateRiskItems, 2);
    assert.equal(insights.counts.needsHuman, 1);
    assert.equal(insights.counts.staleClaims, 2);

    const failing = insights.items.find(
      (item) => item.id === "elizaos/eliza#410",
    );
    assert.equal(failing.checks.failed[0].name, "unit");
    assert.deepEqual(failing.impact.paths, ["packages/core/src/runtime.ts"]);
    assert.deepEqual(failing.impact.packages, ["core"]);
    assert.equal(failing.claims.stale[0].id, "claim-stale-core");
    assert.deepEqual(failing.duplicateRisk.relatedItemIds, [
      "elizaos/eliza#411",
    ]);
    assert.ok(failing.nextActions.includes("route_failed_checks"));
    assert.ok(failing.nextActions.includes("coordinate_overlapping_prs"));

    const stale = insights.items.find(
      (item) => item.id === "elizaos/eliza#411",
    );
    assert.equal(stale.staleBranch.stale, true);
    assert.equal(stale.staleBranch.commitsBehind, 31);
    assert.ok(stale.nextActions.includes("rebase_or_update_branch"));

    const human = insights.items.find(
      (item) => item.id === "elizaos/eliza#412",
    );
    assert.equal(human.human.openApprovals, 1);
    assert.equal(human.human.openRequests, 1);
    assert.equal(human.recommendations[0].action, "resolve_human_decision");

    assert.equal(insights.duplicateRisks[0].kind, "package");
    assert.equal(insights.duplicateRisks[0].key, "core");
    assert.deepEqual(
      insights.staleBranches.map((branch) => branch.itemId),
      ["elizaos/eliza#411"],
    );
    assert.deepEqual(
      insights.ciFailureRoutes.map((route) => route.check),
      ["unit"],
    );
    assert.equal(insights.recommendations[0].action, "resolve_human_decision");
  });
});

function queueItem(overrides = {}) {
  return {
    id: "elizaos/eliza#410",
    repo: "elizaos/eliza",
    pullRequestId: 410,
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
    targetCommitsBehind: 0,
    changedLines: 10,
    changedFiles: ["packages/core/src/runtime.ts"],
    affectedPackages: ["core"],
    requiredChecks: ["unit"],
    checkResults: { unit: "success" },
    queueState: "ready",
    priority: 1,
    ...overrides,
  };
}

function claim(overrides = {}) {
  return {
    id: "claim-core",
    repo: "elizaos/eliza",
    resourceKind: "path",
    resourceId: "packages/core/src/runtime.ts",
    ownerAgentId: "agent-one",
    status: "active",
    paths: ["packages/core/src/runtime.ts"],
    expiresAt: "2026-07-06T00:30:00.000Z",
    ...overrides,
  };
}
