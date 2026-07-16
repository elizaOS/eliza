import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  deriveQueueItemRunState,
  deriveStewardRunState,
} from "../src/run-state.js";

describe("queue item run state", () => {
  it("derives terminal queue states", () => {
    assert.equal(
      deriveQueueItemRunState(item({ queueState: "merged" })).state,
      "succeeded",
    );
    assert.equal(
      deriveQueueItemRunState(item({ queueState: "failed" })).state,
      "failed",
    );
    assert.equal(
      deriveQueueItemRunState(item({ queueState: "cancelled" })).state,
      "cancelled",
    );
  });

  it("derives waiting blockers from queue states", () => {
    const review = deriveQueueItemRunState(
      item({ queueState: "waiting_for_review" }),
    );
    const checks = deriveQueueItemRunState(
      item({ queueState: "waiting_for_checks", headSha: "head-sha" }),
    );
    const queued = deriveQueueItemRunState(
      item({ queueState: "queued", targetBranch: "develop" }),
    );

    assert.equal(review.state, "waiting-approval");
    assert.equal(review.blocked.kind, "approval");
    assert.equal(checks.state, "waiting-event");
    assert.equal(checks.blocked.kind, "event");
    assert.equal(checks.blocked.correlationKey, "head-sha");
    assert.equal(queued.state, "waiting-event");
    assert.equal(queued.blocked.kind, "queue-lane");
  });

  it("marks stale claimed work from claim timestamps", () => {
    const state = deriveQueueItemRunState(
      item({
        queueState: "running",
        claimedAt: "2026-07-06T00:00:00.000Z",
      }),
      {
        now: Date.parse("2026-07-06T01:00:00.000Z"),
        staleAfterMs: 30 * 60 * 1000,
      },
    );

    assert.equal(state.state, "stale");
    assert.equal(state.unhealthy.kind, "engine-heartbeat-stale");
  });

  it("passes through attached agent run state and degraded child signals", () => {
    const waiting = deriveQueueItemRunState(
      item({
        agentRun: {
          runId: "run-waiting",
          state: "waiting_approval",
          blocked: { kind: "approval", nodeId: "review" },
        },
      }),
    );
    const degraded = deriveQueueItemRunState(
      item({
        agentRun: {
          runId: "run-degraded",
          state: "succeeded",
          failedChildren: 1,
          failedChildKeys: ["review::0"],
        },
      }),
    );

    assert.equal(waiting.runId, "run-waiting");
    assert.equal(waiting.state, "waiting-approval");
    assert.equal(waiting.blocked.nodeId, "review");
    assert.equal(degraded.state, "succeeded");
    assert.equal(degraded.unhealthy.kind, "failed-children");
    assert.deepEqual(degraded.unhealthy.failedChildKeys, ["review::0"]);
  });
});

describe("steward run state", () => {
  it("derives waiting approval blockers from run nodes", () => {
    const state = deriveStewardRunState(run({ status: "waiting_approval" }), {
      nodes: [
        {
          runId: "run-one",
          nodeId: "human_approval",
          status: "waiting_approval",
          updatedAt: "2026-07-06T00:00:00.000Z",
        },
      ],
      now: Date.parse("2026-07-06T00:01:00.000Z"),
    });

    assert.equal(state.state, "waiting-approval");
    assert.equal(state.blocked.kind, "approval");
    assert.equal(state.blocked.nodeId, "human_approval");
  });

  it("derives stale and orphaned running states from heartbeat", () => {
    const stale = deriveStewardRunState(
      run({
        status: "running",
        runtimeOwnerId: "worker-one",
        heartbeatAt: "2026-07-06T00:00:00.000Z",
      }),
      {
        now: Date.parse("2026-07-06T00:01:00.000Z"),
        staleAfterMs: 30_000,
      },
    );
    const orphaned = deriveStewardRunState(
      run({
        status: "running",
        runtimeOwnerId: "",
        heartbeatAt: "2026-07-06T00:00:00.000Z",
      }),
      {
        now: Date.parse("2026-07-06T00:01:00.000Z"),
        staleAfterMs: 30_000,
      },
    );

    assert.equal(stale.state, "stale");
    assert.equal(stale.unhealthy.kind, "engine-heartbeat-stale");
    assert.equal(orphaned.state, "orphaned");
  });

  it("derives terminal run states", () => {
    assert.equal(
      deriveStewardRunState(run({ status: "finished" })).state,
      "succeeded",
    );
    assert.equal(
      deriveStewardRunState(run({ status: "failed" })).state,
      "failed",
    );
    assert.equal(
      deriveStewardRunState(run({ status: "cancelled" })).state,
      "cancelled",
    );
  });
});

function item(overrides = {}) {
  return {
    id: "elizaos/eliza#12",
    repo: "elizaos/eliza",
    pullRequestId: 12,
    queueState: "observed",
    createdAt: "2026-07-06T00:00:00.000Z",
    ...overrides,
  };
}

function run(overrides = {}) {
  return {
    id: "run-one",
    queueItemId: "elizaos/eliza#12",
    repo: "elizaos/eliza",
    pullRequestId: 12,
    status: "running",
    createdAt: "2026-07-06T00:00:00.000Z",
    ...overrides,
  };
}
