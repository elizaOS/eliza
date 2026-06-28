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

import { describe, expect, test } from "bun:test";
import {
  decideDrain,
  decideReplenish,
  decideRollout,
  type PoolStateSnapshot,
} from "./agent-warm-pool";
import { DEFAULT_WARM_POOL_POLICY, type WarmPoolPolicy } from "./agent-warm-pool-forecast";

function policy(overrides: Partial<WarmPoolPolicy> = {}): WarmPoolPolicy {
  return { ...DEFAULT_WARM_POOL_POLICY, ...overrides };
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

describe("decideReplenish", () => {
  test("creates up to the deficit when under target with headroom + burst room", () => {
    const d = decideReplenish(
      state({ readyCount: 2, targetPoolSize: 5 }),
      policy({ maxPoolSize: 10, replenishBurstLimit: 3 }),
    );
    expect(d.toCreate).toBe(3);
    expect(d.reason).toContain("creating 3");
    expect(d.reason).not.toContain("burst limit");
  });

  test("caps a large deficit at the burst limit and says so", () => {
    const d = decideReplenish(
      state({ readyCount: 1, targetPoolSize: 8 }),
      policy({ maxPoolSize: 10, replenishBurstLimit: 3 }),
    );
    expect(d.toCreate).toBe(3);
    expect(d.reason).toContain("burst limit 3");
  });

  test("counts in-flight provisioning toward the total (won't over-create)", () => {
    const d = decideReplenish(
      state({ readyCount: 1, provisioningCount: 2, targetPoolSize: 3 }),
      policy({ maxPoolSize: 10, replenishBurstLimit: 5 }),
    );
    expect(d.toCreate).toBe(0);
    expect(d.reason).toMatch(/steady/);
  });

  test("limits creation by headroom to maxPoolSize", () => {
    const d = decideReplenish(
      state({ readyCount: 8, targetPoolSize: 10 }),
      policy({ maxPoolSize: 9, replenishBurstLimit: 3 }),
    );
    expect(d.toCreate).toBe(1); // headroom = 9 - 8
  });

  test("defers when already at maxPoolSize with an over-cap target", () => {
    const d = decideReplenish(
      state({ readyCount: 10, targetPoolSize: 12 }),
      policy({ maxPoolSize: 10, replenishBurstLimit: 3 }),
    );
    expect(d.toCreate).toBe(0);
    expect(d.reason).toContain("at maxPoolSize 10");
  });

  test("steady state creates nothing", () => {
    const d = decideReplenish(
      state({ readyCount: 3, targetPoolSize: 3 }),
      policy({ maxPoolSize: 10 }),
    );
    expect(d.toCreate).toBe(0);
    expect(d.reason).toMatch(/steady/);
  });

  test("never returns a negative toCreate when over target", () => {
    const d = decideReplenish(
      state({ readyCount: 6, targetPoolSize: 2 }),
      policy({ maxPoolSize: 10 }),
    );
    expect(d.toCreate).toBe(0);
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
            node_id: null,
            health_url: null,
          },
          {
            id: "fresh2",
            pool_ready_at: new Date(now - 200),
            docker_image: null,
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
            node_id: null,
            health_url: null,
          },
          {
            id: "oldest",
            pool_ready_at: new Date(now - 9000),
            docker_image: null,
            node_id: null,
            health_url: null,
          },
          {
            id: "middle",
            pool_ready_at: new Date(now - 5000),
            docker_image: null,
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
          { id: "noTs", pool_ready_at: null, docker_image: null, node_id: null, health_url: null },
          {
            id: "old",
            pool_ready_at: new Date(now - 9000),
            docker_image: null,
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
  test("replaces rows whose image differs from the current image", () => {
    const d = decideRollout(
      [
        { id: "ok", docker_image: "img:v2" },
        { id: "stale", docker_image: "img:v1" },
      ],
      "img:v2",
    );
    expect(d.toReplace).toEqual(["stale"]);
    expect(d.reason).toContain("replacing 1");
  });

  test("treats every row as current when all images match", () => {
    const d = decideRollout(
      [
        { id: "a", docker_image: "img:v2" },
        { id: "b", docker_image: "img:v2" },
      ],
      "img:v2",
    );
    expect(d.toReplace).toEqual([]);
    expect(d.reason).toMatch(/all rows on current image/);
  });

  test("does NOT replace rows with an unknown (null) image", () => {
    const d = decideRollout(
      [
        { id: "nullimg", docker_image: null },
        { id: "stale", docker_image: "img:v1" },
      ],
      "img:v2",
    );
    expect(d.toReplace).toEqual(["stale"]);
  });
});
