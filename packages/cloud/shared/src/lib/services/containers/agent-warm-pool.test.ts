/**
 * Characterization tests for the warm-pool decision engine.
 *
 * The module docstring claims "Decision functions are pure and tested in
 * isolation" — but `decideReplenish` / `decideDrain` / `decideRollout` had no
 * tests. These functions decide how many agent containers get CREATED, which
 * get DRAINED, and which get REPLACED on an image rollout — the core of the
 * subsystem under active autoscaler tuning (#8348/#8353/#8357). This pins their
 * branch matrix so that tuning can't silently change the contract.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  decideDrain,
  decideReplenish,
  decideRollout,
  envWarmPoolPolicy,
  immutableImageReference,
  type PoolStateSnapshot,
  type TenantContentionSnapshot,
} from "./agent-warm-pool";
import {
  computeForecast,
  DEFAULT_WARM_POOL_POLICY,
  type WarmPoolPolicy,
} from "./agent-warm-pool-forecast";

function policy(overrides: Partial<WarmPoolPolicy> = {}): WarmPoolPolicy {
  return { ...DEFAULT_WARM_POOL_POLICY, ...overrides };
}

/** Abundant slack + no backlog: the starvation guard never binds. */
function uncontended(overrides: Partial<TenantContentionSnapshot> = {}): TenantContentionSnapshot {
  return { pendingTenantJobs: 0, clusterFreeCapacity: 1000, ...overrides };
}

function state(overrides: Partial<PoolStateSnapshot> = {}): PoolStateSnapshot {
  return {
    readyCount: 0,
    provisioningCount: 0,
    unclaimedRows: [],
    predictedRate: 0,
    targetPoolSize: 1,
    ...overrides,
  };
}

describe("immutableImageReference", () => {
  test("replaces a mutable tag while preserving a registry port", () => {
    const digest = `sha256:${"a".repeat(64)}`;
    expect(immutableImageReference("registry.example:5000/team/agent:stable", digest)).toBe(
      `registry.example:5000/team/agent@${digest}`,
    );
  });

  test("rebinds an already pinned reference to the sweep digest", () => {
    const digest = `sha256:${"b".repeat(64)}`;
    expect(immutableImageReference(`ghcr.io/elizaos/eliza@sha256:${"a".repeat(64)}`, digest)).toBe(
      `ghcr.io/elizaos/eliza@${digest}`,
    );
  });

  test("rejects a non-canonical registry digest", () => {
    expect(() => immutableImageReference("ghcr.io/elizaos/eliza:stable", "sha256:short")).toThrow(
      "canonical sha256",
    );
  });
});

describe("decideReplenish", () => {
  test("creates up to the deficit when under target with headroom + burst room", () => {
    const d = decideReplenish(
      state({ readyCount: 2, targetPoolSize: 5 }),
      policy({ maxPoolSize: 10, replenishBurstLimit: 3 }),
      uncontended(),
    );
    expect(d.toCreate).toBe(3);
    expect(d.reason).toContain("creating 3");
    expect(d.reason).not.toContain("burst limit");
  });

  test("caps a large deficit at the burst limit and says so", () => {
    const d = decideReplenish(
      state({ readyCount: 1, targetPoolSize: 8 }),
      policy({ maxPoolSize: 10, replenishBurstLimit: 3 }),
      uncontended(),
    );
    expect(d.toCreate).toBe(3);
    expect(d.reason).toContain("burst limit 3");
  });

  test("counts in-flight provisioning toward the total (won't over-create)", () => {
    const d = decideReplenish(
      state({ readyCount: 1, provisioningCount: 2, targetPoolSize: 3 }),
      policy({ maxPoolSize: 10, replenishBurstLimit: 5 }),
      uncontended(),
    );
    expect(d.toCreate).toBe(0);
    expect(d.reason).toMatch(/steady/);
  });

  test("limits creation by headroom to maxPoolSize", () => {
    const d = decideReplenish(
      state({ readyCount: 8, targetPoolSize: 10 }),
      policy({ maxPoolSize: 9, replenishBurstLimit: 3 }),
      uncontended(),
    );
    expect(d.toCreate).toBe(1); // headroom = 9 - 8
  });

  test("defers when already at maxPoolSize with an over-cap target", () => {
    const d = decideReplenish(
      state({ readyCount: 10, targetPoolSize: 12 }),
      policy({ maxPoolSize: 10, replenishBurstLimit: 3 }),
      uncontended(),
    );
    expect(d.toCreate).toBe(0);
    expect(d.reason).toContain("at maxPoolSize 10");
  });

  test("steady state creates nothing", () => {
    const d = decideReplenish(
      state({ readyCount: 3, targetPoolSize: 3 }),
      policy({ maxPoolSize: 10 }),
      uncontended(),
    );
    expect(d.toCreate).toBe(0);
    expect(d.reason).toMatch(/steady/);
  });

  test("never returns a negative toCreate when over target", () => {
    const d = decideReplenish(
      state({ readyCount: 6, targetPoolSize: 2 }),
      policy({ maxPoolSize: 10 }),
      uncontended(),
    );
    expect(d.toCreate).toBe(0);
  });
});

describe("decideReplenish tenant starvation guard", () => {
  test("a queued tenant backlog clips the fill burst to the leftover slack", () => {
    // Wants 3; cluster has 7 free, 3 queued tenants + reserve 2 leaves 2.
    const d = decideReplenish(
      state({ readyCount: 2, targetPoolSize: 5 }),
      policy({ maxPoolSize: 10, replenishBurstLimit: 3, tenantReserveSlots: 2 }),
      uncontended({ pendingTenantJobs: 3, clusterFreeCapacity: 7 }),
    );
    expect(d.toCreate).toBe(2);
    expect(d.reason).toContain("tenant starvation guard");
    expect(d.reason).toContain("creating 2 (wanted 3)");
  });

  test("the reserve alone binds on a nearly-full cluster with no backlog", () => {
    // Wants 3; 3 free minus reserve 2 grants 1 even with zero queued tenants.
    const d = decideReplenish(
      state({ readyCount: 2, targetPoolSize: 5 }),
      policy({ maxPoolSize: 10, replenishBurstLimit: 3, tenantReserveSlots: 2 }),
      uncontended({ pendingTenantJobs: 0, clusterFreeCapacity: 3 }),
    );
    expect(d.toCreate).toBe(1);
    expect(d.reason).toContain("tenant starvation guard");
  });

  test("clips to zero when the backlog consumes every free slot", () => {
    const d = decideReplenish(
      state({ readyCount: 0, targetPoolSize: 3 }),
      policy({ maxPoolSize: 10, replenishBurstLimit: 3, tenantReserveSlots: 2 }),
      uncontended({ pendingTenantJobs: 5, clusterFreeCapacity: 4 }),
    );
    expect(d.toCreate).toBe(0);
    expect(d.reason).toContain("tenant starvation guard");
    expect(d.reason).toContain("creating 0 (wanted 3)");
  });

  test("an empty cluster (no placeable slack) never warm-fills", () => {
    const d = decideReplenish(
      state({ readyCount: 0, targetPoolSize: 3 }),
      policy({ maxPoolSize: 10, replenishBurstLimit: 3, tenantReserveSlots: 2 }),
      uncontended({ pendingTenantJobs: 0, clusterFreeCapacity: 0 }),
    );
    expect(d.toCreate).toBe(0);
    expect(d.reason).toContain("tenant starvation guard");
  });

  test("abundant slack leaves the uncontended decision and reason untouched", () => {
    const d = decideReplenish(
      state({ readyCount: 2, targetPoolSize: 5 }),
      policy({ maxPoolSize: 10, replenishBurstLimit: 3, tenantReserveSlots: 2 }),
      uncontended({ pendingTenantJobs: 1, clusterFreeCapacity: 50 }),
    );
    expect(d.toCreate).toBe(3);
    expect(d.reason).not.toContain("starvation");
  });

  test("a negative pending-jobs reading is treated as zero, never extra slack", () => {
    const d = decideReplenish(
      state({ readyCount: 2, targetPoolSize: 5 }),
      policy({ maxPoolSize: 10, replenishBurstLimit: 3, tenantReserveSlots: 2 }),
      uncontended({ pendingTenantJobs: -10, clusterFreeCapacity: 4 }),
    );
    expect(d.toCreate).toBe(2); // 4 free - reserve 2
  });
});

describe("decideDrain", () => {
  const IDLE = 1000;

  test("never drains while demand keeps the target above the floor", () => {
    const d = decideDrain(
      state({ readyCount: 5, targetPoolSize: 4 }),
      policy({ minPoolSize: 1 }),
      10_000,
    );
    expect(d.toDrain).toEqual([]);
    expect(d.reason).toMatch(/above floor/);
  });

  test("never drains when at or below the floor", () => {
    const d = decideDrain(
      state({ readyCount: 1, targetPoolSize: 1 }),
      policy({ minPoolSize: 1, idleScaleDownMs: IDLE }),
      10_000,
    );
    expect(d.toDrain).toEqual([]);
    expect(d.reason).toMatch(/at or below floor/);
  });

  test("holds surplus rows that are still inside the idle window", () => {
    const now = 10_000;
    const d = decideDrain(
      state({
        readyCount: 3,
        targetPoolSize: 1,
        unclaimedRows: [
          {
            id: "fresh",
            pool_ready_at: new Date(now - 100),
            docker_image: null,
            image_digest: null,
            node_id: null,
            health_url: null,
          },
          {
            id: "fresh2",
            pool_ready_at: new Date(now - 200),
            docker_image: null,
            image_digest: null,
            node_id: null,
            health_url: null,
          },
        ],
      }),
      policy({ minPoolSize: 1, idleScaleDownMs: IDLE }),
      now,
    );
    expect(d.toDrain).toEqual([]);
    expect(d.reason).toMatch(/within idle window/);
  });

  test("drains the OLDEST surplus rows past the idle window, capped at the surplus", () => {
    const now = 100_000;
    const d = decideDrain(
      state({
        readyCount: 3, // surplus over floor 1 = 2
        targetPoolSize: 1,
        unclaimedRows: [
          {
            id: "newest",
            pool_ready_at: new Date(now - 2000),
            docker_image: null,
            image_digest: null,
            node_id: null,
            health_url: null,
          },
          {
            id: "oldest",
            pool_ready_at: new Date(now - 9000),
            docker_image: null,
            image_digest: null,
            node_id: null,
            health_url: null,
          },
          {
            id: "middle",
            pool_ready_at: new Date(now - 5000),
            docker_image: null,
            image_digest: null,
            node_id: null,
            health_url: null,
          },
        ],
      }),
      policy({ minPoolSize: 1, idleScaleDownMs: IDLE }),
      now,
    );
    // surplus = 2 ⇒ drain the two oldest, oldest first.
    expect(d.toDrain).toEqual(["oldest", "middle"]);
  });

  test("ignores rows with no pool_ready_at timestamp", () => {
    const now = 100_000;
    const d = decideDrain(
      state({
        readyCount: 3,
        targetPoolSize: 1,
        unclaimedRows: [
          {
            id: "noTs",
            pool_ready_at: null,
            docker_image: null,
            image_digest: null,
            node_id: null,
            health_url: null,
          },
          {
            id: "old",
            pool_ready_at: new Date(now - 9000),
            docker_image: null,
            image_digest: null,
            node_id: null,
            health_url: null,
          },
        ],
      }),
      policy({ minPoolSize: 1, idleScaleDownMs: IDLE }),
      now,
    );
    expect(d.toDrain).toEqual(["old"]);
  });
});

describe("decideRollout", () => {
  const TARGET = `sha256:${"a".repeat(64)}`;
  const STALE = `sha256:${"b".repeat(64)}`;

  test("fences every known-stale row but preserves physical ready rows until target capacity exists", () => {
    const d = decideRollout(
      [
        { id: "old-a", image_digest: STALE, claimable: true },
        { id: "old-b", image_digest: STALE, claimable: true },
      ],
      TARGET,
      policy({ minPoolSize: 1, replenishBurstLimit: 2 }),
    );
    expect(d.toFence).toEqual(["old-a", "old-b"]);
    expect(d.toReplace).toEqual([]);
    expect(d.counts).toMatchObject({ stale: 2, selected: 0, deferred: 2 });
    expect(d.reason).toContain("claim-fencing all 2");
    expect(d.reason).toContain("physical ready-container floor 1");
  });

  test("once target capacity exists, replacement is burst-bounded and preserves the ready floor", () => {
    const d = decideRollout(
      [
        { id: "target", image_digest: TARGET, claimable: true },
        { id: "old-a", image_digest: STALE, claimable: true },
        { id: "old-b", image_digest: STALE, claimable: true },
        { id: "old-c", image_digest: STALE, claimable: true },
      ],
      TARGET,
      policy({ minPoolSize: 2, replenishBurstLimit: 2 }),
    );
    expect(d.toFence).toEqual(["old-a", "old-b", "old-c"]);
    expect(d.toReplace).toEqual(["old-a", "old-b"]);
    expect(d.counts).toMatchObject({ targetReady: 1, selected: 2, deferred: 1 });
  });

  test("same persisted digest is a no-op even when the mutable tag moved", () => {
    const d = decideRollout(
      [
        { id: "a", image_digest: TARGET, claimable: true },
        { id: "b", image_digest: TARGET, claimable: false },
      ],
      TARGET,
      policy(),
    );
    expect(d.toFence).toEqual([]);
    expect(d.toReplace).toEqual([]);
    expect(d.reason).toMatch(/all 2 generations on target digest/);
  });

  test("null digest is stale, unclaimable, and consumes the bounded teardown budget", () => {
    const d = decideRollout(
      [
        { id: "unknown", image_digest: null, claimable: false },
        { id: "old", image_digest: STALE, claimable: false },
        { id: "old-deferred", image_digest: STALE, claimable: false },
      ],
      TARGET,
      policy({ replenishBurstLimit: 2 }),
    );
    expect(d.toFence).toEqual(["unknown", "old", "old-deferred"]);
    expect(d.toReplace).toEqual(["unknown", "old"]);
    expect(d.counts).toMatchObject({ unknownDigest: 1, selected: 2, deferred: 1 });
  });
});

describe("envWarmPoolPolicy", () => {
  const savedMin = process.env.WARM_POOL_MIN_SIZE;
  const savedMax = process.env.WARM_POOL_MAX_SIZE;

  beforeEach(() => {
    delete process.env.WARM_POOL_MIN_SIZE;
    delete process.env.WARM_POOL_MAX_SIZE;
  });

  afterEach(() => {
    if (savedMin === undefined) delete process.env.WARM_POOL_MIN_SIZE;
    else process.env.WARM_POOL_MIN_SIZE = savedMin;
    if (savedMax === undefined) delete process.env.WARM_POOL_MAX_SIZE;
    else process.env.WARM_POOL_MAX_SIZE = savedMax;
  });

  test("reads WARM_POOL_MIN_SIZE / WARM_POOL_MAX_SIZE, not the hardcoded 1/10", () => {
    process.env.WARM_POOL_MIN_SIZE = "4";
    process.env.WARM_POOL_MAX_SIZE = "20";
    const p = envWarmPoolPolicy();
    expect(p.minPoolSize).toBe(4);
    expect(p.maxPoolSize).toBe(20);
    // Every other knob stays on the default.
    expect(p.emaAlpha).toBe(DEFAULT_WARM_POOL_POLICY.emaAlpha);
    expect(p.replenishBurstLimit).toBe(DEFAULT_WARM_POOL_POLICY.replenishBurstLimit);
    expect(p.idleScaleDownMs).toBe(DEFAULT_WARM_POOL_POLICY.idleScaleDownMs);
  });

  test("falls back to the default 1/10 when the env vars are unset", () => {
    const p = envWarmPoolPolicy();
    expect(p.minPoolSize).toBe(DEFAULT_WARM_POOL_POLICY.minPoolSize);
    expect(p.maxPoolSize).toBe(DEFAULT_WARM_POOL_POLICY.maxPoolSize);
  });

  test("env floor raises the replenish target: idle pool with min=4 creates 3 (burst-limited)", () => {
    process.env.WARM_POOL_MIN_SIZE = "4";
    process.env.WARM_POOL_MAX_SIZE = "20";
    const p = envWarmPoolPolicy();
    // Zero demand history — target is exactly the floor.
    const forecast = computeForecast({
      bucketCounts: [0, 0, 0],
      emaAlpha: p.emaAlpha,
      leadTimeBuckets: p.leadTimeBuckets,
      minPoolSize: p.minPoolSize,
      maxPoolSize: p.maxPoolSize,
    });
    expect(forecast.targetPoolSize).toBe(4);
    const d = decideReplenish(
      state({ readyCount: 0, targetPoolSize: forecast.targetPoolSize }),
      p,
      uncontended(),
    );
    expect(d.toCreate).toBe(3); // deficit 4, capped by default burst limit 3
    expect(d.reason).toContain("burst limit 3");
  });

  test("clamps a floor above the ceiling down to the ceiling (cost cap wins)", () => {
    process.env.WARM_POOL_MIN_SIZE = "30";
    process.env.WARM_POOL_MAX_SIZE = "5";
    const p = envWarmPoolPolicy();
    expect(p.minPoolSize).toBe(5);
    expect(p.maxPoolSize).toBe(5);
    // Must not trip the computeForecast min<=max invariant.
    expect(() =>
      computeForecast({
        bucketCounts: [0],
        emaAlpha: p.emaAlpha,
        leadTimeBuckets: p.leadTimeBuckets,
        minPoolSize: p.minPoolSize,
        maxPoolSize: p.maxPoolSize,
      }),
    ).not.toThrow();
  });

  test("ignores garbage env values and keeps the defaults", () => {
    process.env.WARM_POOL_MIN_SIZE = "banana";
    process.env.WARM_POOL_MAX_SIZE = "-3";
    const p = envWarmPoolPolicy();
    expect(p.minPoolSize).toBe(1);
    expect(p.maxPoolSize).toBe(10);
  });
});
