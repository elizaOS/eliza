import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { loadConfig } from "../src/config.js";
import { InMemoryQueueStore } from "../src/store.js";
import { runQueueWorker } from "../src/worker.js";

describe("merge steward worker", () => {
  it("does not start when disabled", async () => {
    const result = await runQueueWorker({
      config: loadConfig(),
      steward: stewardFromResults([]),
      logger: silentLogger,
      maxIterations: 1,
    });

    assert.equal(result.started, false);
    assert.equal(result.stopReason, "worker_disabled");
    assert.equal(result.iterations, 0);
  });

  it("polls runQueueOnce and summarizes claimed and idle iterations", async () => {
    const calls = [];
    const config = workerConfig();
    const sleeps = [];
    const result = await runQueueWorker({
      config,
      steward: stewardFromResults(
        [
          {
            claimed: true,
            item: { id: "elizaos/eliza#12", queueState: "merged" },
            run: { id: "run:elizaos/eliza#12:attempt:1", status: "succeeded" },
            attempt: {
              id: "attempt:run:elizaos/eliza#12:attempt:1:integration:1",
              status: "succeeded",
            },
          },
          { claimed: false, reason: "no_ready_items" },
        ],
        calls,
      ),
      logger: silentLogger,
      sleep: async (ms) => sleeps.push(ms),
      maxIterations: 2,
    });

    assert.equal(result.started, true);
    assert.equal(result.stopReason, "max_iterations");
    assert.equal(result.iterations, 2);
    assert.equal(result.claimed, 1);
    assert.equal(result.processedItems, 1);
    assert.equal(result.succeeded, 1);
    assert.equal(result.idle, 1);
    assert.equal(result.leaseAcquired, 2);
    assert.equal(result.leaseMisses, 0);
    assert.equal(calls.length, 2);
    assert.equal(typeof calls[0].beforeIntegrationAction, "function");
    assert.deepEqual(
      { ...calls[0], beforeIntegrationAction: "function" },
      {
        workerId: "worker-one",
        confirmed: true,
        beforeIntegrationAction: "function",
      },
    );
    assert.deepEqual(sleeps, [1000]);
  });

  it("recovers stale queue items before claiming new work", async () => {
    const calls = [];
    const config = workerConfig({
      MERGE_STEWARD_WORKER_STALE_QUEUE_ITEM_MS: "60000",
    });
    const result = await runQueueWorker({
      config,
      steward: {
        store: new InMemoryQueueStore(),
        async recoverStaleQueueItems(input) {
          calls.push(["recover", input]);
          return {
            count: 1,
            recovered: [{ item: { id: "elizaos/eliza#88" } }],
          };
        },
        async runQueueOnce(input) {
          calls.push(["run", input]);
          return { claimed: false, reason: "no_ready_items" };
        },
      },
      logger: silentLogger,
      sleep: async () => {},
      maxIterations: 1,
    });

    assert.equal(result.started, true);
    assert.equal(result.recovered, 1);
    assert.deepEqual(result.lastRecovery, {
      count: 1,
      recoveredItemIds: ["elizaos/eliza#88"],
    });
    assert.equal(calls[0][0], "recover");
    assert.equal(calls[0][1].workerId, "worker-one");
    assert.equal(calls[0][1].staleAfterMs, 60000);
    assert.equal(calls[1][0], "run");
  });

  it("summarizes merge train requeues separately from failed items", async () => {
    const config = workerConfig();
    const result = await runQueueWorker({
      config,
      steward: stewardFromResults([
        {
          claimed: true,
          items: [
            { id: "elizaos/eliza#64", queueState: "failed" },
            { id: "elizaos/eliza#65", queueState: "queued" },
          ],
          runs: [
            { id: "run:elizaos/eliza#64:attempt:1", status: "failed" },
            { id: "run:elizaos/eliza#65:attempt:1", status: "failed" },
          ],
        },
      ]),
      logger: silentLogger,
      sleep: async () => {},
      maxIterations: 1,
    });

    assert.equal(result.claimed, 1);
    assert.equal(result.processedItems, 2);
    assert.equal(result.failed, 1);
    assert.equal(result.requeued, 1);
    assert.equal(result.succeeded, 0);
    assert.equal(result.lastResult.failedCount, 1);
    assert.equal(result.lastResult.requeuedCount, 1);
  });

  it("does not claim queue work when another worker holds the lease", async () => {
    const config = workerConfig();
    const store = new InMemoryQueueStore();
    await store.claimWorkerLease(
      { id: "merge-queue", ownerId: "worker-two" },
      { now: new Date().toISOString(), ttlMs: 30000 },
    );
    const calls = [];

    const result = await runQueueWorker({
      config,
      steward: stewardFromResults([{ claimed: true }], calls, store),
      logger: silentLogger,
      sleep: async () => {},
      maxIterations: 1,
    });

    assert.equal(result.started, true);
    assert.equal(result.stopReason, "max_iterations");
    assert.equal(result.leaseAcquired, 0);
    assert.equal(result.leaseMisses, 1);
    assert.equal(result.claimed, 0);
    assert.equal(calls.length, 0);
    assert.equal(result.lastLease.reason, "lease_held");
    assert.equal(result.lastLease.lease.ownerId, "worker-two");
  });

  it("passes a durable lease guard that blocks work after ownership is lost", async () => {
    const config = workerConfig();
    const store = new InMemoryQueueStore();
    const calls = [];

    const result = await runQueueWorker({
      config,
      steward: {
        store,
        async runQueueOnce(input) {
          calls.push(input);
          assert.equal(typeof input.beforeIntegrationAction, "function");
          await store.releaseWorkerLease("merge-queue", {
            ownerId: "worker-one",
            reason: "superseded",
          });
          await store.claimWorkerLease(
            { id: "merge-queue", ownerId: "worker-two" },
            { ttlMs: 30000 },
          );
          const guard = await input.beforeIntegrationAction({
            action: { type: "merge_original_pull_request" },
            itemPlan: { pullRequestId: 12 },
          });

          return {
            claimed: true,
            item: { id: "elizaos/eliza#12", queueState: "failed" },
            run: { id: "run:elizaos/eliza#12:attempt:1", status: "failed" },
            attempt: {
              id: "attempt:run:elizaos/eliza#12:attempt:1:integration:1",
              status: "failed",
            },
            guard,
          };
        },
      },
      logger: silentLogger,
      sleep: async () => {},
      maxIterations: 1,
    });

    assert.equal(calls.length, 1);
    assert.equal(result.claimed, 1);
    assert.equal(result.failed, 1);
    assert.equal(result.lastResult.runStatus, "failed");
    assert.equal(result.lastLease.released, false);
    assert.equal(result.lastLease.lostReason, "worker_lease_lost");
    assert.equal(result.lastLease.lastError.message, "worker_lease_lost");
  });

  it("stops after too many consecutive errors", async () => {
    const config = workerConfig({
      MERGE_STEWARD_WORKER_MAX_CONSECUTIVE_ERRORS: "2",
    });
    const result = await runQueueWorker({
      config,
      steward: {
        store: new InMemoryQueueStore(),
        async runQueueOnce() {
          throw new Error("database unavailable");
        },
      },
      logger: silentLogger,
      sleep: async () => {},
      maxIterations: 10,
    });

    assert.equal(result.started, true);
    assert.equal(result.stopReason, "too_many_consecutive_errors");
    assert.equal(result.iterations, 2);
    assert.equal(result.errors, 2);
    assert.equal(result.lastError.message, "database unavailable");
  });
});

function workerConfig(overrides = {}) {
  return loadConfig({
    MERGE_STEWARD_INTEGRATION_ENABLED: "true",
    MERGE_STEWARD_INTEGRATION_DRY_RUN: "false",
    MERGE_STEWARD_INTEGRATION_EXECUTOR: "local-git",
    MERGE_STEWARD_INTEGRATION_REMOTE_URL:
      "ssh://git@example.invalid/elizaos/eliza.git",
    MERGE_STEWARD_WORKER_ENABLED: "true",
    MERGE_STEWARD_WORKER_ID: "worker-one",
    MERGE_STEWARD_WORKER_POLL_INTERVAL_MS: "1000",
    MERGE_STEWARD_WORKER_CONFIRM_LIVE_EXECUTION: "true",
    ...overrides,
  });
}

function stewardFromResults(
  results,
  calls = [],
  store = new InMemoryQueueStore(),
) {
  const queue = [...results];
  return {
    store,
    async runQueueOnce(input) {
      calls.push(input);
      return queue.shift() ?? { claimed: false, reason: "no_ready_items" };
    },
  };
}

const silentLogger = Object.freeze({
  error() {},
  info() {},
});
