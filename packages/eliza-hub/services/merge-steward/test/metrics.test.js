import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { loadConfig } from "../src/config.js";
import { renderMergeStewardMetrics } from "../src/metrics.js";
import { MergeSteward } from "../src/steward.js";
import { InMemoryQueueStore } from "../src/store.js";

describe("merge steward metrics", () => {
  it("renders low-cardinality Prometheus metrics for queue and worker state", async () => {
    const config = loadConfig({
      MERGE_STEWARD_WORKER_ENABLED: "true",
    });
    const store = new InMemoryQueueStore();
    await store.upsertQueueItem({
      repo: "elizaos/eliza",
      pullRequestId: 12,
      queueState: "ready",
      targetBranch: "develop",
      ownerAgentId: "agent-one",
    });
    await store.upsertRun({
      id: "run:elizaos/eliza#12",
      status: "running",
      queueItemId: "elizaos/eliza#12",
      repo: "elizaos/eliza",
      ownerKind: "agent",
      ownerId: "agent-one",
    });
    await store.startAttempt({
      runId: "run:elizaos/eliza#12",
      nodeId: "integration",
      ownerId: "worker-a",
    });
    await store.claimAgentWork(
      {
        repo: "elizaos/eliza",
        resourceKind: "path",
        resourceId: "src/index.ts",
        ownerAgentId: "agent-one",
      },
      {
        now: "2026-07-06T00:00:00.000Z",
        ttlMs: 30000,
      },
    );
    await store.claimWorkerLease(
      {
        id: "merge-queue",
        ownerId: "worker-a",
      },
      {
        now: "2026-07-06T00:00:00.000Z",
        ttlMs: 30000,
      },
    );

    const metrics = await renderMergeStewardMetrics({
      config,
      steward: new MergeSteward({ config, store }),
      readiness: {
        ok: true,
        checks: [{ name: "queue_store", ok: true }],
      },
      now: "2026-07-06T00:00:10.000Z",
    });

    assert.match(metrics, /^# HELP eliza_merge_steward_info/m);
    assert.match(metrics, /eliza_merge_steward_ready 1/);
    assert.match(
      metrics,
      /eliza_merge_steward_check_ok\{name="queue_store"\} 1/,
    );
    assert.match(metrics, /eliza_merge_steward_work_reservation_required 0/);
    assert.match(metrics, /eliza_merge_steward_work_item_required 0/);
    assert.match(
      metrics,
      /eliza_merge_steward_agent_branch_namespace_required 0/,
    );
    assert.match(
      metrics,
      /eliza_merge_steward_verified_agent_run_receipt_required 0/,
    );
    assert.match(metrics, /eliza_merge_steward_queue_items\{state="ready"\} 1/);
    assert.match(metrics, /eliza_merge_steward_runs\{status="running"\} 1/);
    assert.match(metrics, /eliza_merge_steward_attempts\{status="running"\} 1/);
    assert.match(
      metrics,
      /eliza_merge_steward_agent_claims\{status="active"\} 1/,
    );
    assert.match(
      metrics,
      /eliza_merge_steward_agent_performance_agents\{health="all"\} 1/,
    );
    assert.match(
      metrics,
      /eliza_merge_steward_agent_performance_active_runs 1/,
    );
    assert.match(
      metrics,
      /eliza_merge_steward_agent_routing_recommendations 0/,
    );
    assert.match(
      metrics,
      /eliza_merge_steward_agent_routing_agents\{state="routable"\}/,
    );
    assert.match(
      metrics,
      /eliza_merge_steward_worker_lease_active\{lease_id="merge-queue",owner_id="worker-a",status="active"\} 1/,
    );
    assert.match(
      metrics,
      /eliza_merge_steward_worker_lease_expires_at_seconds\{lease_id="merge-queue",owner_id="worker-a",status="active"\} 1783296030/,
    );
    assert.match(
      metrics,
      /eliza_merge_steward_scrape_errors\{source="none"\} 0/,
    );
  });

  it("exports strict work-reservation policy for live integration alerts", async () => {
    const config = loadConfig({
      MERGE_STEWARD_INTEGRATION_ENABLED: "true",
      MERGE_STEWARD_INTEGRATION_DRY_RUN: "false",
      MERGE_STEWARD_REQUIRE_WORK_RESERVATION_FOR_AGENT_PRS: "true",
      MERGE_STEWARD_REQUIRE_WORK_ITEM_FOR_AGENT_PRS: "true",
      MERGE_STEWARD_REQUIRE_AGENT_BRANCH_NAMESPACE: "true",
      MERGE_STEWARD_REQUIRE_VERIFIED_AGENT_RUN_RECEIPT: "true",
      MERGE_STEWARD_REQUIRE_AGENT_IDENTITY_REGISTRY: "true",
      MERGE_STEWARD_AGENT_IDENTITY_REGISTRY: "agent-one,agent-two",
    });
    const store = new InMemoryQueueStore();
    const metrics = await renderMergeStewardMetrics({
      config,
      steward: new MergeSteward({ config, store }),
      readiness: { ok: true, checks: [] },
    });

    assert.match(metrics, /eliza_merge_steward_integration_live_enabled 1/);
    assert.match(metrics, /eliza_merge_steward_work_reservation_required 1/);
    assert.match(metrics, /eliza_merge_steward_work_item_required 1/);
    assert.match(
      metrics,
      /eliza_merge_steward_agent_branch_namespace_required 1/,
    );
    assert.match(
      metrics,
      /eliza_merge_steward_verified_agent_run_receipt_required 1/,
    );
    assert.match(
      metrics,
      /eliza_merge_steward_agent_identity_registry_required 1/,
    );
    assert.match(metrics, /eliza_merge_steward_known_agent_id_count 2/);
  });

  it("records scrape errors without failing the whole metrics render", async () => {
    const config = loadConfig();
    const metrics = await renderMergeStewardMetrics({
      config,
      steward: {
        async listQueue() {
          throw new Error("database unavailable");
        },
        async listRuns() {
          return [];
        },
        async listAttempts() {
          return [];
        },
        async listAgentClaims() {
          return [];
        },
        async listRepoPolicies() {
          return [];
        },
        async getAgentPerformance() {
          throw new Error("performance unavailable");
        },
        async getAgentRouting() {
          return {
            counts: {
              recommendations: 0,
              unassignedItems: 0,
              routableAgents: 0,
              blockedAgents: 0,
            },
          };
        },
        store: {
          async listWorkerLeases() {
            return [];
          },
        },
      },
      readiness: { ok: false, checks: [] },
    });

    assert.match(metrics, /eliza_merge_steward_ready 0/);
    assert.match(
      metrics,
      /eliza_merge_steward_scrape_errors\{source="queue"\} 1/,
    );
    assert.match(
      metrics,
      /eliza_merge_steward_scrape_errors\{source="agent_performance"\} 1/,
    );
  });
});
