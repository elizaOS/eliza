import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildAgentCapacity,
  buildClaimFromAssignmentSuggestion,
} from "../src/agent-capacity.js";
import { buildAgentInsights } from "../src/agent-insights.js";

describe("agent capacity model", () => {
  it("summarizes agent load and suggests owners for unassigned work", () => {
    const insights = buildAgentInsights({
      now: "2026-07-06T00:10:00.000Z",
      repo: "elizaos/eliza",
      queueItems: [
        queueItem({
          id: "elizaos/eliza#501",
          pullRequestId: 501,
          ownerAgentId: "agent-core",
          createdAt: "2026-07-06T00:01:00.000Z",
          updatedAt: "2026-07-06T00:04:00.000Z",
          changedFiles: ["packages/core/src/runtime.ts"],
          affectedPackages: ["core"],
          requiredChecks: ["unit"],
          checkResults: { unit: "failure" },
        }),
        queueItem({
          id: "elizaos/eliza#502",
          pullRequestId: 502,
          ownerAgentId: "agent-ui",
          changedFiles: ["packages/client/src/chat.ts"],
          affectedPackages: ["client"],
        }),
        queueItem({
          id: "elizaos/eliza#503",
          pullRequestId: 503,
          ownerAgentId: null,
          priority: 20,
          changedFiles: ["packages/core/src/memory.ts"],
          affectedPackages: ["core"],
        }),
      ],
      claims: [
        claim({
          id: "claim-core-active",
          ownerAgentId: "agent-core",
          resourceKind: "path",
          resourceId: "packages/core/src/runtime.ts",
          paths: ["packages/core/src/runtime.ts"],
          expiresAt: "2026-07-06T00:30:00.000Z",
        }),
        claim({
          id: "claim-ui-stale",
          ownerAgentId: "agent-repair",
          resourceId: "packages/client/src/old.ts",
          paths: ["packages/client/src/old.ts"],
          expiresAt: "2026-07-06T00:00:00.000Z",
        }),
      ],
      runs: [
        {
          id: "run-ui",
          queueItemId: "elizaos/eliza#502",
          repo: "elizaos/eliza",
          ownerKind: "agent",
          ownerId: "agent-ui",
          status: "succeeded",
        },
      ],
    });

    const capacity = buildAgentCapacity({
      insights,
      claims: [
        claim({
          id: "claim-core-active",
          ownerAgentId: "agent-core",
          resourceKind: "path",
          resourceId: "packages/core/src/runtime.ts",
          paths: ["packages/core/src/runtime.ts"],
          expiresAt: "2026-07-06T00:30:00.000Z",
        }),
        claim({
          id: "claim-ui-stale",
          ownerAgentId: "agent-repair",
          resourceId: "packages/client/src/old.ts",
          paths: ["packages/client/src/old.ts"],
          expiresAt: "2026-07-06T00:00:00.000Z",
        }),
      ],
      runs: [
        {
          id: "run-ui",
          queueItemId: "elizaos/eliza#502",
          repo: "elizaos/eliza",
          ownerKind: "agent",
          ownerId: "agent-ui",
          status: "succeeded",
        },
      ],
      now: "2026-07-06T00:10:00.000Z",
      repo: "elizaos/eliza",
    });

    const core = capacity.agents.find(
      (agent) => agent.agentId === "agent-core",
    );
    const ui = capacity.agents.find((agent) => agent.agentId === "agent-ui");
    const repair = capacity.agents.find(
      (agent) => agent.agentId === "agent-repair",
    );

    assert.equal(capacity.filters.repo, "elizaos/eliza");
    assert.equal(capacity.counts.agents, 3);
    assert.equal(capacity.counts.unassignedItems, 1);
    assert.equal(capacity.counts.assignmentSuggestions, 1);
    assert.equal(core.health, "needs-triage");
    assert.equal(core.counts.failedChecks, 1);
    assert.equal(core.counts.activeClaims, 1);
    assert.equal(core.currentWork[0].createdAt, "2026-07-06T00:01:00.000Z");
    assert.equal(core.currentWork[0].updatedAt, "2026-07-06T00:04:00.000Z");
    assert.equal(ui.health, "available");
    assert.equal(repair.health, "needs-triage");
    assert.equal(repair.counts.staleClaims, 1);
    assert.equal(capacity.assignmentSuggestions[0].agentId, "agent-ui");
    assert.equal(capacity.assignmentSuggestions[0].itemId, "elizaos/eliza#503");
    assert.equal(
      capacity.assignmentSuggestions[0].resource.kind,
      "pull_request",
    );
    assert.match(capacity.assignmentSuggestions[0].reason, /open slot/);
  });

  it("builds durable claims from assignment suggestions", () => {
    const claim = buildClaimFromAssignmentSuggestion(
      {
        id: "assign:elizaos/eliza#503:agent-ui",
        agentId: "agent-ui",
        itemId: "elizaos/eliza#503",
        repo: "elizaos/eliza",
        pullRequestId: 503,
        targetBranch: "develop",
        action: "enter_merge_queue",
        reason: "1 open slot; workload score 2",
        resource: {
          kind: "pull_request",
          id: "503",
          paths: ["packages/core/src/memory.ts"],
        },
      },
      {
        ownerAgentId: "agent-ui",
        now: "2026-07-06T00:10:00.000Z",
      },
    );

    assert.equal(claim.repo, "elizaos/eliza");
    assert.equal(claim.resourceKind, "pull_request");
    assert.equal(claim.resourceId, "503");
    assert.equal(claim.ownerAgentId, "agent-ui");
    assert.deepEqual(claim.paths, ["packages/core/src/memory.ts"]);
    assert.equal(claim.metadata.source, "agent-capacity-assignment");
    assert.equal(
      claim.metadata.suggestionId,
      "assign:elizaos/eliza#503:agent-ui",
    );
    assert.equal(claim.metadata.selectedAt, "2026-07-06T00:10:00.000Z");
  });

  it("uses performance health to avoid routing new work to triage agents", () => {
    const insights = buildAgentInsights({
      now: "2026-07-06T00:10:00.000Z",
      repo: "elizaos/eliza",
      queueItems: [
        queueItem({
          id: "elizaos/eliza#511",
          pullRequestId: 511,
          ownerAgentId: "agent-steady",
          changedFiles: ["packages/core/src/runtime.ts"],
          affectedPackages: ["core"],
        }),
        queueItem({
          id: "elizaos/eliza#512",
          pullRequestId: 512,
          ownerAgentId: "agent-flaky",
          changedFiles: ["packages/core/src/memory.ts"],
          affectedPackages: ["core"],
        }),
        queueItem({
          id: "elizaos/eliza#513",
          pullRequestId: 513,
          ownerAgentId: null,
          priority: 30,
          changedFiles: ["packages/core/src/bootstrap.ts"],
          affectedPackages: ["core"],
        }),
      ],
    });

    const capacity = buildAgentCapacity({
      insights,
      now: "2026-07-06T00:10:00.000Z",
      repo: "elizaos/eliza",
      performance: {
        agents: [
          performanceAgent({
            agentId: "agent-steady",
            health: "healthy",
            counts: { succeededRuns: 3 },
            rates: {
              successRate: 1,
              failureRate: 0,
              staleClaimRatio: 0,
              handoffRatio: 0,
            },
          }),
          performanceAgent({
            agentId: "agent-flaky",
            health: "needs-triage",
            riskScore: 8,
            counts: { failedRuns: 2 },
            rates: {
              successRate: 0,
              failureRate: 1,
              staleClaimRatio: 0,
              handoffRatio: 0,
            },
            riskSignals: ["failed_runs"],
          }),
        ],
      },
    });

    const steady = capacity.agents.find(
      (agent) => agent.agentId === "agent-steady",
    );
    const flaky = capacity.agents.find(
      (agent) => agent.agentId === "agent-flaky",
    );

    assert.equal(steady.canTakeNewWork, true);
    assert.equal(steady.performance.health, "healthy");
    assert.equal(flaky.canTakeNewWork, false);
    assert.equal(flaky.performance.health, "needs-triage");
    assert.equal(capacity.assignmentSuggestions[0].agentId, "agent-steady");
    assert.match(
      capacity.assignmentSuggestions[0].reason,
      /performance healthy/,
    );
  });
});

function queueItem(overrides = {}) {
  return {
    id: "elizaos/eliza#501",
    repo: "elizaos/eliza",
    pullRequestId: 501,
    sourceBranch: "agent/change",
    targetBranch: "develop",
    headSha: "head-sha",
    authorKind: "agent",
    ownerAgentId: "agent-core",
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
    ownerAgentId: "agent-core",
    status: "active",
    paths: ["packages/core/src/runtime.ts"],
    expiresAt: "2026-07-06T00:30:00.000Z",
    ...overrides,
  };
}

function performanceAgent(overrides = {}) {
  const counts = overrides.counts ?? {};
  const rates = overrides.rates ?? {};
  return {
    agentId: "agent-steady",
    health: "healthy",
    loadScore: 0,
    riskScore: 0,
    activityScore: 0,
    riskSignals: [],
    ...overrides,
    counts: {
      activeClaims: 0,
      staleClaims: 0,
      activeRuns: 0,
      waitingRuns: 0,
      succeededRuns: 0,
      failedRuns: 0,
      transferredIn: 0,
      transferredOut: 0,
      handoffs: 0,
      ...counts,
    },
    rates: {
      successRate: null,
      failureRate: null,
      staleClaimRatio: 0,
      handoffRatio: 0,
      ...rates,
    },
  };
}
