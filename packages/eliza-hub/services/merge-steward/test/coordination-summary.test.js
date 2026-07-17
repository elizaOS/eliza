import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildCoordinationSummary } from "../src/coordination-summary.js";

describe("agent coordination summary", () => {
  it("summarizes queue lanes claims agents runs and hot paths", () => {
    const summary = buildCoordinationSummary({
      now: "2026-07-06T00:10:00.000Z",
      queueItems: [
        queueItem({
          id: "elizaos/eliza#1",
          queueState: "ready",
          ownerAgentId: "agent-one",
          affectedPaths: ["src/core.ts"],
          changedFiles: ["src/core.ts", "README.md"],
        }),
        queueItem({
          id: "elizaos/eliza#2",
          pullRequestId: 2,
          queueState: "running",
          ownerAgentId: "agent-two",
          claimedBy: "merge-worker-one",
          claimedAt: "2026-07-06T00:05:00.000Z",
          attemptCount: 2,
          affectedPaths: ["src/core.ts"],
          affectedPackages: ["core"],
        }),
        queueItem({
          id: "elizaos/eliza#3",
          pullRequestId: 3,
          queueState: "blocked_policy",
          targetBranch: "main",
          attemptCount: 1,
          lastError: "needs maintainer approval",
        }),
        queueItem({
          id: "elizaos/eliza#4",
          pullRequestId: 4,
          queueState: "building_integration",
          targetBranch: "develop",
          ownerAgentId: "agent-one",
          affectedPackages: ["core"],
        }),
        queueItem({
          id: "elizaos/eliza#5",
          pullRequestId: 5,
          queueState: "merged",
        }),
        queueItem({
          id: "elizaos/eliza#6",
          pullRequestId: 6,
          queueState: "integration_failed",
        }),
      ],
      claims: [
        claim({
          ownerAgentId: "agent-one",
          resourceId: "src/core.ts",
          expiresAt: "2026-07-06T00:30:00.000Z",
        }),
        claim({
          ownerAgentId: "agent-two",
          resourceId: "packages/core",
          resourceKind: "package",
          expiresAt: "2026-07-06T00:00:00.000Z",
        }),
        claim({
          ownerAgentId: "agent-one",
          resourceId: "core",
          resourceKind: "package",
          paths: [],
          expiresAt: "2026-07-06T00:30:00.000Z",
        }),
        claim({
          ownerAgentId: "agent-three",
          resourceId: "src/old.ts",
          status: "released",
        }),
      ],
      runs: [
        {
          id: "run-one",
          ownerKind: "agent",
          ownerId: "agent-one",
          status: "running",
        },
        {
          id: "run-two",
          ownerKind: "agent",
          ownerId: "agent-two",
          status: "waiting_event",
        },
        {
          id: "run-three",
          ownerKind: "human",
          ownerId: "operator-one",
          status: "failed",
        },
      ],
    });

    assert.equal(summary.queue.total, 6);
    assert.equal(summary.queue.live, 4);
    assert.equal(summary.queue.ready, 1);
    assert.equal(summary.queue.running, 2);
    assert.equal(summary.queue.blocked, 1);
    assert.equal(summary.queue.terminal, 2);
    assert.deepEqual(summary.queue.byState, {
      ready: 1,
      running: 1,
      building_integration: 1,
      blocked_policy: 1,
      merged: 1,
      integration_failed: 1,
    });
    assert.deepEqual(summary.queue.lanes, [
      {
        repo: "elizaos/eliza",
        targetBranch: "develop",
        total: 3,
        ready: 1,
        running: 2,
        blocked: 0,
        claimedBy: "merge-worker-one",
        claimedAt: "2026-07-06T00:05:00.000Z",
        maxAttemptCount: 2,
        currentBlocker: null,
        ownerAgentIds: ["agent-one", "agent-two"],
      },
      {
        repo: "elizaos/eliza",
        targetBranch: "main",
        total: 1,
        ready: 0,
        running: 0,
        blocked: 1,
        claimedBy: null,
        claimedAt: null,
        maxAttemptCount: 1,
        currentBlocker: {
          itemId: "elizaos/eliza#3",
          pullRequestId: 3,
          queueState: "blocked_policy",
          lastError: "needs maintainer approval",
        },
        ownerAgentIds: [],
      },
    ]);
    assert.equal(summary.claims.active, 2);
    assert.equal(summary.claims.stale, 1);
    assert.equal(summary.claims.released, 1);
    assert.deepEqual(summary.claims.byOwner, { "agent-one": 2 });
    assert.equal(summary.claims.staleClaims[0].resourceId, "packages/core");
    assert.equal(summary.runs.running, 1);
    assert.equal(summary.runs.waiting, 1);
    assert.equal(summary.runs.failed, 1);
    assert.deepEqual(
      summary.agents.find((agent) => agent.agentId === "agent-one"),
      {
        agentId: "agent-one",
        activeClaims: 2,
        staleClaims: 0,
        queueItems: 2,
        runningQueueItems: 1,
        runningRuns: 1,
        waitingRuns: 0,
      },
    );
    assert.equal(summary.hotPaths[0].path, "src/core.ts");
    assert.equal(summary.hotPaths[0].count, 3);
    assert.deepEqual(summary.hotPackages[0], { packageName: "core", count: 3 });
  });

  it("returns stable empty buckets", () => {
    const summary = buildCoordinationSummary({
      now: "2026-07-06T00:00:00.000Z",
    });

    assert.equal(summary.computedAt, "2026-07-06T00:00:00.000Z");
    assert.deepEqual(summary.queue.byState, {});
    assert.deepEqual(summary.queue.lanes, []);
    assert.deepEqual(summary.claims.byOwner, {});
    assert.deepEqual(summary.agents, []);
    assert.deepEqual(summary.hotPaths, []);
    assert.deepEqual(summary.hotPackages, []);
  });
});

function queueItem(overrides = {}) {
  return {
    id: "elizaos/eliza#1",
    repo: "elizaos/eliza",
    pullRequestId: 1,
    targetBranch: "develop",
    queueState: "ready",
    ...overrides,
  };
}

function claim(overrides = {}) {
  return {
    id: `claim:elizaos/eliza:path:${overrides.resourceId ?? "src/core.ts"}`,
    repo: "elizaos/eliza",
    resourceKind: "path",
    resourceId: "src/core.ts",
    ownerAgentId: "agent-one",
    status: "active",
    paths: [overrides.resourceId ?? "src/core.ts"],
    ...overrides,
  };
}
