import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildAgentPerformance } from "../src/agent-performance.js";

describe("agent performance model", () => {
  it("summarizes agent load, recent activity, runs, and handoffs", () => {
    const performance = buildAgentPerformance({
      now: "2026-07-06T00:10:00.000Z",
      repo: "elizaos/eliza",
      targetBranch: "develop",
      since: "2026-07-06T00:00:00.000Z",
      queueItems: [
        queueItem({
          id: "elizaos/eliza#901",
          pullRequestId: 901,
          ownerAgentId: "agent-core",
          queueState: "ready",
          priority: 10,
          decision: { allowed: true },
          updatedAt: "2026-07-06T00:06:00.000Z",
        }),
        queueItem({
          id: "elizaos/eliza#902",
          pullRequestId: 902,
          ownerAgentId: "agent-core",
          queueState: "blocked_policy",
          priority: 8,
          decision: { allowed: false },
          updatedAt: "2026-07-06T00:07:00.000Z",
        }),
        queueItem({
          id: "elizaos/eliza#903",
          pullRequestId: 903,
          ownerAgentId: "agent-ui",
          queueState: "running",
          priority: 9,
          updatedAt: "2026-07-06T00:05:00.000Z",
        }),
        queueItem({
          id: "elizaos/eliza#904",
          pullRequestId: 904,
          ownerAgentId: "agent-core",
          targetBranch: "main",
        }),
        queueItem({
          id: "other/repo#905",
          repo: "other/repo",
          pullRequestId: 905,
          ownerAgentId: "agent-other",
        }),
      ],
      claims: [
        claim({
          id: "claim-core-active",
          ownerAgentId: "agent-core",
          resourceId: "src/core.ts",
          claimedAt: "2026-07-06T00:01:00.000Z",
          expiresAt: "2026-07-06T00:30:00.000Z",
          updatedAt: "2026-07-06T00:01:00.000Z",
        }),
        claim({
          id: "claim-core-stale",
          ownerAgentId: "agent-core",
          resourceId: "src/stale.ts",
          claimedAt: "2026-07-06T00:02:00.000Z",
          expiresAt: "2026-07-06T00:00:00.000Z",
          updatedAt: "2026-07-06T00:02:00.000Z",
        }),
        claim({
          id: "claim-ui-released",
          ownerAgentId: "agent-ui",
          resourceId: "src/released.ts",
          status: "released",
          claimedAt: "2026-07-05T23:59:00.000Z",
          releasedAt: "2026-07-06T00:05:00.000Z",
          updatedAt: "2026-07-06T00:05:00.000Z",
        }),
        claim({
          id: "claim-ui-transfer",
          ownerAgentId: "agent-ui",
          resourceId: "src/handoff.ts",
          claimedAt: "2026-07-06T00:04:00.000Z",
          expiresAt: "2026-07-06T00:30:00.000Z",
          updatedAt: "2026-07-06T00:04:00.000Z",
          metadata: {
            handoffs: [
              {
                fromAgentId: "agent-core",
                toAgentId: "agent-ui",
                reason: "handoff",
                transferredAt: "2026-07-06T00:04:00.000Z",
              },
            ],
          },
        }),
        claim({
          id: "claim-old-released",
          ownerAgentId: "agent-old",
          resourceId: "src/old.ts",
          status: "released",
          claimedAt: "2026-07-05T22:00:00.000Z",
          releasedAt: "2026-07-05T22:30:00.000Z",
          updatedAt: "2026-07-05T22:30:00.000Z",
        }),
      ],
      runs: [
        run({
          id: "run-core-success",
          ownerId: "agent-core",
          status: "finished",
          finishedAt: "2026-07-06T00:03:00.000Z",
          updatedAt: "2026-07-06T00:03:00.000Z",
        }),
        run({
          id: "run-core-failed",
          ownerId: "agent-core",
          status: "failed",
          finishedAt: "2026-07-06T00:04:00.000Z",
          updatedAt: "2026-07-06T00:04:00.000Z",
        }),
        run({
          id: "run-core-old-failed",
          ownerId: "agent-core",
          status: "failed",
          finishedAt: "2026-07-05T23:30:00.000Z",
          updatedAt: "2026-07-05T23:30:00.000Z",
        }),
        run({
          id: "run-ui-waiting",
          ownerId: "agent-ui",
          status: "waiting_approval",
          updatedAt: "2026-07-06T00:05:00.000Z",
        }),
        run({
          id: "run-ui-running",
          ownerId: "agent-ui",
          status: "running",
          updatedAt: "2026-07-06T00:06:00.000Z",
        }),
        run({
          id: "run-human",
          ownerKind: "human",
          ownerId: "agent-core",
          status: "failed",
          updatedAt: "2026-07-06T00:07:00.000Z",
        }),
        run({
          id: "run-main",
          ownerId: "agent-core",
          targetBranch: "main",
          status: "failed",
          updatedAt: "2026-07-06T00:07:00.000Z",
        }),
      ],
    });

    const core = performance.agents.find(
      (agent) => agent.agentId === "agent-core",
    );
    const ui = performance.agents.find((agent) => agent.agentId === "agent-ui");

    assert.equal(performance.filters.repo, "elizaos/eliza");
    assert.equal(performance.filters.targetBranch, "develop");
    assert.equal(performance.filters.since, "2026-07-06T00:00:00.000Z");
    assert.equal(performance.counts.agents, 2);
    assert.equal(performance.counts.handoffs, 1);
    assert.equal(performance.counts.failedRuns, 1);
    assert.equal(performance.counts.succeededRuns, 1);
    assert.equal(
      performance.agents.some((agent) => agent.agentId === "agent-old"),
      false,
    );

    assert.equal(core.health, "needs-triage");
    assert.equal(core.counts.ownedQueueItems, 2);
    assert.equal(core.counts.readyQueueItems, 1);
    assert.equal(core.counts.blockedQueueItems, 1);
    assert.equal(core.counts.activeClaims, 1);
    assert.equal(core.counts.staleClaims, 1);
    assert.equal(core.counts.claimed, 2);
    assert.equal(core.counts.transferredOut, 1);
    assert.equal(core.counts.failedRuns, 1);
    assert.equal(core.counts.succeededRuns, 1);
    assert.equal(core.rates.successRate, 0.5);
    assert.equal(core.rates.failureRate, 0.5);
    assert.equal(core.rates.staleClaimRatio, 0.5);
    assert.deepEqual(core.riskSignals, [
      "failed_runs",
      "stale_claims",
      "blocked_queue",
    ]);
    assert.equal(core.lastActivityAt, "2026-07-06T00:07:00.000Z");

    assert.equal(ui.health, "watch");
    assert.equal(ui.counts.ownedQueueItems, 1);
    assert.equal(ui.counts.runningQueueItems, 1);
    assert.equal(ui.counts.activeClaims, 1);
    assert.equal(ui.counts.releasedClaims, 1);
    assert.equal(ui.counts.transferredIn, 1);
    assert.equal(ui.counts.activeRuns, 1);
    assert.equal(ui.counts.waitingRuns, 1);
    assert.equal(ui.rates.successRate, null);
    assert.deepEqual(ui.riskSignals, ["waiting_runs"]);
    assert.equal(ui.handoffs[0].direction, "in");

    assert.equal(
      performance.leaders.highestSuccessRate[0].agentId,
      "agent-core",
    );
    assert.equal(performance.leaders.mostHandoffs.length, 2);
    assert.equal(performance.leaders.staleClaimOwners[0].agentId, "agent-core");
  });

  it("filters telemetry to one owner when requested", () => {
    const performance = buildAgentPerformance({
      now: "2026-07-06T00:10:00.000Z",
      ownerAgentId: "agent-ui",
      queueItems: [queueItem({ ownerAgentId: "agent-core" })],
      claims: [
        claim({
          ownerAgentId: "agent-ui",
          metadata: {
            handoffs: [
              {
                fromAgentId: "agent-core",
                toAgentId: "agent-ui",
                transferredAt: "2026-07-06T00:04:00.000Z",
              },
            ],
          },
        }),
      ],
    });

    assert.equal(performance.counts.agents, 1);
    assert.equal(performance.agents[0].agentId, "agent-ui");
    assert.equal(performance.agents[0].counts.transferredIn, 1);
    assert.equal(performance.agents[0].counts.transferredOut, 0);
  });
});

function queueItem(overrides = {}) {
  return {
    id: "elizaos/eliza#901",
    repo: "elizaos/eliza",
    pullRequestId: 901,
    targetBranch: "develop",
    queueState: "ready",
    ownerAgentId: "agent-core",
    priority: 1,
    createdAt: "2026-07-06T00:00:00.000Z",
    updatedAt: "2026-07-06T00:00:00.000Z",
    ...overrides,
  };
}

function claim(overrides = {}) {
  return {
    id: "claim-core",
    repo: "elizaos/eliza",
    resourceKind: "path",
    resourceId: "src/core.ts",
    ownerAgentId: "agent-core",
    status: "active",
    paths: ["src/core.ts"],
    claimedAt: "2026-07-06T00:00:00.000Z",
    expiresAt: "2026-07-06T00:30:00.000Z",
    createdAt: "2026-07-06T00:00:00.000Z",
    updatedAt: "2026-07-06T00:00:00.000Z",
    ...overrides,
  };
}

function run(overrides = {}) {
  return {
    id: "run-core",
    repo: "elizaos/eliza",
    queueItemId: "elizaos/eliza#901",
    pullRequestId: 901,
    targetBranch: "develop",
    ownerKind: "agent",
    ownerId: "agent-core",
    status: "running",
    createdAt: "2026-07-06T00:00:00.000Z",
    updatedAt: "2026-07-06T00:00:00.000Z",
    ...overrides,
  };
}
