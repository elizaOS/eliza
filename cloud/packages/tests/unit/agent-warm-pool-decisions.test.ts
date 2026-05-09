import { describe, expect, test } from "bun:test";
import {
  decideDrain,
  decideReplenish,
  decideRollout,
  type PoolStateSnapshot,
} from "@/lib/services/containers/agent-warm-pool";
import { DEFAULT_WARM_POOL_POLICY } from "@/lib/services/containers/agent-warm-pool-forecast";

const NOW = Date.parse("2026-05-06T12:00:00.000Z");

function row(overrides: Partial<PoolStateSnapshot["unclaimedRows"][number]> = {}) {
  return {
    id: overrides.id ?? "pool-1",
    pool_ready_at: overrides.pool_ready_at ?? new Date(NOW - 60_000),
    docker_image: overrides.docker_image ?? "ghcr.io/elizaos/eliza:latest",
    node_id: overrides.node_id ?? "node-1",
    health_url: overrides.health_url ?? "http://node-1.test/health",
  };
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
  test("creates up to deficit when below target", () => {
    const decision = decideReplenish(
      state({ readyCount: 0, provisioningCount: 0, targetPoolSize: 3 }),
      DEFAULT_WARM_POOL_POLICY,
    );
    expect(decision.toCreate).toBe(3);
    expect(decision.reason).toContain("creating 3");
  });

  test("respects burst limit", () => {
    const decision = decideReplenish(
      state({ readyCount: 0, provisioningCount: 0, targetPoolSize: 10 }),
      { ...DEFAULT_WARM_POOL_POLICY, replenishBurstLimit: 2 },
    );
    expect(decision.toCreate).toBe(2);
    expect(decision.reason).toContain("burst limit");
  });

  test("respects max pool size", () => {
    const decision = decideReplenish(
      state({ readyCount: 5, provisioningCount: 5, targetPoolSize: 12 }),
      { ...DEFAULT_WARM_POOL_POLICY, maxPoolSize: 10 },
    );
    expect(decision.toCreate).toBe(0);
    expect(decision.reason).toContain("at maxPoolSize");
  });

  test("counts provisioning rows toward the total (avoids over-creating)", () => {
    const decision = decideReplenish(
      state({ readyCount: 1, provisioningCount: 2, targetPoolSize: 3 }),
      DEFAULT_WARM_POOL_POLICY,
    );
    expect(decision.toCreate).toBe(0);
  });

  test("steady when at target", () => {
    const decision = decideReplenish(
      state({ readyCount: 3, targetPoolSize: 3 }),
      DEFAULT_WARM_POOL_POLICY,
    );
    expect(decision.toCreate).toBe(0);
    expect(decision.reason).toContain("steady");
  });
});

describe("decideDrain", () => {
  test("does not drain when target is above floor (demand pressure)", () => {
    const decision = decideDrain(
      state({ readyCount: 5, targetPoolSize: 4 }),
      DEFAULT_WARM_POOL_POLICY,
      NOW,
    );
    expect(decision.toDrain).toEqual([]);
    expect(decision.reason).toContain("demand");
  });

  test("does not drain when within idle window", () => {
    const recent = new Date(NOW - 60_000);
    const decision = decideDrain(
      state({
        readyCount: 3,
        targetPoolSize: 1,
        unclaimedRows: [
          row({ id: "a", pool_ready_at: recent }),
          row({ id: "b", pool_ready_at: recent }),
          row({ id: "c", pool_ready_at: recent }),
        ],
      }),
      DEFAULT_WARM_POOL_POLICY,
      NOW,
    );
    expect(decision.toDrain).toEqual([]);
    expect(decision.reason).toContain("idle window");
  });

  test("drains oldest first past idle window, leaving floor", () => {
    const old = new Date(NOW - 90 * 60 * 1000);
    const older = new Date(NOW - 120 * 60 * 1000);
    const oldest = new Date(NOW - 180 * 60 * 1000);
    const decision = decideDrain(
      state({
        readyCount: 3,
        targetPoolSize: 1,
        unclaimedRows: [
          row({ id: "a", pool_ready_at: old }),
          row({ id: "b", pool_ready_at: older }),
          row({ id: "c", pool_ready_at: oldest }),
        ],
      }),
      DEFAULT_WARM_POOL_POLICY,
      NOW,
    );
    expect(decision.toDrain).toEqual(["c", "b"]);
  });

  test("never drains below the configured floor", () => {
    const old = new Date(NOW - 90 * 60 * 1000);
    const decision = decideDrain(
      state({
        readyCount: 1,
        targetPoolSize: 1,
        unclaimedRows: [row({ id: "a", pool_ready_at: old })],
      }),
      DEFAULT_WARM_POOL_POLICY,
      NOW,
    );
    expect(decision.toDrain).toEqual([]);
  });

  test("respects custom floor (e.g. min=0 for full drain)", () => {
    const old = new Date(NOW - 90 * 60 * 1000);
    const decision = decideDrain(
      state({
        readyCount: 1,
        targetPoolSize: 0,
        unclaimedRows: [row({ id: "only", pool_ready_at: old })],
      }),
      { ...DEFAULT_WARM_POOL_POLICY, minPoolSize: 0 },
      NOW,
    );
    expect(decision.toDrain).toEqual(["only"]);
  });
});

describe("decideRollout", () => {
  test("flags rows whose image doesn't match current", () => {
    const decision = decideRollout(
      [
        { id: "a", docker_image: "ghcr.io/elizaos/eliza:v1" },
        { id: "b", docker_image: "ghcr.io/elizaos/eliza:v2" },
        { id: "c", docker_image: "ghcr.io/elizaos/eliza:v2" },
      ],
      "ghcr.io/elizaos/eliza:v2",
    );
    expect(decision.toReplace).toEqual(["a"]);
  });

  test("returns empty when all rows on current image", () => {
    const decision = decideRollout(
      [
        { id: "a", docker_image: "img:v1" },
        { id: "b", docker_image: "img:v1" },
      ],
      "img:v1",
    );
    expect(decision.toReplace).toEqual([]);
    expect(decision.reason).toContain("current image");
  });

  test("ignores rows with null image (not yet ready)", () => {
    const decision = decideRollout(
      [
        { id: "pending", docker_image: null },
        { id: "stale", docker_image: "img:v1" },
      ],
      "img:v2",
    );
    expect(decision.toReplace).toEqual(["stale"]);
  });
});
