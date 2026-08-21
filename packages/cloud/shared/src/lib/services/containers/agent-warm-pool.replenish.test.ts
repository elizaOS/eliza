/**
 * I/O tests for `WarmPoolManager.replenish()` — the pool-refill path that had
 * NO live caller until it was wired into the provisioning-worker daemon's
 * `runInfraMaintenanceCycle` ("warm pool replenish cycle" phase). Before that
 * fix the pool got claimed + idle-drained but never refilled, so every create
 * after depletion silently fell to the 30-120s cold path (Nubs' "warm pool ->
 * provision taking long"). See PROVISIONING-E2E-AUDIT §C4.
 *
 * The pure `decideReplenish` branch matrix is pinned in agent-warm-pool.test.ts;
 * this suite pins the MANAGER's I/O contract:
 *   - creates up to the deficit when ENABLED and below target;
 *   - a no-op (creates NOTHING, touches neither repo nor creator) when DISABLED;
 *   - a per-container create failure is captured in `failed[]` and STOPS the
 *     burst — it never throws to the caller and never reads as a create, so the
 *     daemon phase (and the rest of the maintenance cycle) is never killed.
 *
 * [sol-cloud]
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { PoolContainerCreator } from "./agent-warm-pool";

const repo = {
  listClaimablePool: mock(async () => [] as Array<{ id: string }>),
  listWarmPoolReconciliationCandidates: mock(async () => []),
  promoteStrandedPoolEntryReady: mock(async () => undefined),
  reserveUnclaimablePoolEntryForReap: mock(async () => undefined),
  findStuckPoolProvisioning: mock(async () => [] as Array<{ id: string }>),
  countAllPoolEntries: mock(async () => ({ ready: 0, provisioning: 0 })),
  countUserProvisionsByHour: mock(async () => [] as number[]),
};

const jobsRepo = {
  countInFlightByType: mock(async () => 0),
};

const nodesRepo = {
  findPlaceable: mock(async () => [{ capacity: 100, allocated_count: 0 }]),
};

let warmPoolEnabled = true;

mock.module("../../../db/repositories/jobs", () => ({
  jobsRepository: jobsRepo,
}));
mock.module("../../../db/repositories/docker-nodes", () => ({
  dockerNodesRepository: nodesRepo,
}));
mock.module("../../utils/logger", () => ({
  logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
}));
mock.module("../../config/containers-env", () => ({
  containersEnv: { warmPoolEnabled: () => warmPoolEnabled },
}));
mock.module("../../../db/repositories/agent-sandboxes", () => ({
  agentSandboxesRepository: repo,
  WARM_POOL_ORG_ID: "pool-org",
}));

type ManagerModule = typeof import("./agent-warm-pool");

async function load(): Promise<ManagerModule> {
  return import("./agent-warm-pool");
}

function fakeCreator(overrides: Partial<PoolContainerCreator> = {}): {
  creator: PoolContainerCreator;
  create: ReturnType<typeof mock>;
} {
  const create =
    (overrides.createPoolContainer as ReturnType<typeof mock>) ??
    mock(async () => ({ id: "new", nodeId: "node-1" }));
  const creator: PoolContainerCreator = {
    createPoolContainer: create,
    destroyPoolContainer: mock(async () => undefined),
    healthProbe: mock(async () => true),
  };
  return { creator, create };
}

beforeEach(() => {
  warmPoolEnabled = true;
  repo.listClaimablePool.mockReset();
  repo.listClaimablePool.mockResolvedValue([]);
  repo.listWarmPoolReconciliationCandidates.mockReset();
  repo.listWarmPoolReconciliationCandidates.mockResolvedValue([]);
  repo.findStuckPoolProvisioning.mockReset();
  repo.findStuckPoolProvisioning.mockResolvedValue([]);
  repo.countAllPoolEntries.mockReset();
  repo.countAllPoolEntries.mockResolvedValue({ ready: 0, provisioning: 0 });
  repo.countUserProvisionsByHour.mockReset();
  repo.countUserProvisionsByHour.mockResolvedValue([]);
  jobsRepo.countInFlightByType.mockReset();
  jobsRepo.countInFlightByType.mockResolvedValue(0);
  nodesRepo.findPlaceable.mockReset();
  nodesRepo.findPlaceable.mockResolvedValue([{ capacity: 100, allocated_count: 0 }]);
});

afterEach(() => {
  mock.restore();
});

describe("replenish creates when ENABLED and below target", () => {
  test("an empty pool below target (default minPoolSize=1) creates one entry", async () => {
    const { WarmPoolManager } = await load();
    // ready:0/provisioning:0, empty demand buckets => forecast target clamps to
    // minPoolSize (1); deficit 1 => create 1.
    const { creator, create } = fakeCreator();
    const manager = new WarmPoolManager(creator);

    const result = await manager.replenish("img:tag");

    expect(create).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledWith("img:tag");
    expect(result.created).toEqual([{ id: "new", nodeId: "node-1" }]);
    expect(result.failed).toEqual([]);
    expect(result.decision.toCreate).toBe(1);
  });

  test("binds an exact target digest without changing the configured claim image", async () => {
    const { WarmPoolManager } = await load();
    const { creator, create } = fakeCreator();
    const manager = new WarmPoolManager(creator);
    const targetDigest = `sha256:${"a".repeat(64)}`;

    const result = await manager.replenish("img:stable", targetDigest);

    expect(create).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledWith("img:stable", targetDigest);
    expect(repo.countAllPoolEntries).toHaveBeenCalledWith({ digest: targetDigest });
    expect(result.created).toHaveLength(1);
  });

  test("does NOT over-create when the pool already meets target", async () => {
    const { WarmPoolManager } = await load();
    // ready:1 meets the minPoolSize=1 target => deficit 0 => no creates.
    repo.countAllPoolEntries.mockResolvedValue({ ready: 1, provisioning: 0 });
    const { creator, create } = fakeCreator();
    const manager = new WarmPoolManager(creator);

    const result = await manager.replenish("img:tag");

    expect(create).not.toHaveBeenCalled();
    expect(result.created).toEqual([]);
    expect(result.decision.toCreate).toBe(0);
    expect(result.decision.reason).toMatch(/steady/);
  });
});

describe("replenish honors the disabled no-op", () => {
  test("WARM_POOL_ENABLED=false creates NOTHING and never reads the repo or creator", async () => {
    const { WarmPoolManager } = await load();
    warmPoolEnabled = false;

    const { creator, create } = fakeCreator();
    const manager = new WarmPoolManager(creator);

    const result = await manager.replenish("img:tag");

    expect(create).not.toHaveBeenCalled();
    expect(repo.countAllPoolEntries).not.toHaveBeenCalled();
    expect(repo.listClaimablePool).not.toHaveBeenCalled();
    expect(repo.listWarmPoolReconciliationCandidates).not.toHaveBeenCalled();
    expect(jobsRepo.countInFlightByType).not.toHaveBeenCalled();
    expect(nodesRepo.findPlaceable).not.toHaveBeenCalled();
    expect(result.created).toEqual([]);
    expect(result.decision.toCreate).toBe(0);
    expect(result.decision.reason).toContain("WARM_POOL_ENABLED=false");
  });
});

describe("replenish yields to live tenant demand (starvation guard)", () => {
  test("a queued tenant backlog on a tight cluster clips the fill burst", async () => {
    const { WarmPoolManager } = await load();
    // Demand history pushes the target well above the burst limit.
    repo.countUserProvisionsByHour.mockResolvedValue([10, 10, 10, 10, 10, 10]);
    // 4 free slots, 3 queued tenant jobs + default reserve 2 => grant 0.
    nodesRepo.findPlaceable.mockResolvedValue([{ capacity: 8, allocated_count: 4 }]);
    jobsRepo.countInFlightByType.mockResolvedValue(3);

    const { creator, create } = fakeCreator();
    const manager = new WarmPoolManager(creator);

    const result = await manager.replenish("img:tag");

    expect(jobsRepo.countInFlightByType).toHaveBeenCalledWith("agent_provision");
    expect(create).not.toHaveBeenCalled();
    expect(result.created).toEqual([]);
    expect(result.decision.reason).toContain("tenant starvation guard");
    expect(result.contention).toEqual({ pendingTenantJobs: 3, clusterFreeCapacity: 4 });
  });

  test("an over-allocated node contributes zero slack, never negative", async () => {
    const { WarmPoolManager } = await load();
    // One node over-allocated (frees -2 must clamp to 0), one with 5 free.
    nodesRepo.findPlaceable.mockResolvedValue([
      { capacity: 8, allocated_count: 10 },
      { capacity: 8, allocated_count: 3 },
    ]);

    const { creator, create } = fakeCreator();
    const manager = new WarmPoolManager(creator);

    const result = await manager.replenish("img:tag");

    expect(result.contention.clusterFreeCapacity).toBe(5);
    // deficit 1 (min floor), 5 free - reserve 2 grants it.
    expect(create).toHaveBeenCalledTimes(1);
  });

  test("a tenant queued mid-burst aborts the remaining creates", async () => {
    const { WarmPoolManager } = await load();
    // Deficit 3 with abundant slack: the initial decision grants all three.
    repo.countUserProvisionsByHour.mockResolvedValue([10, 10, 10, 10, 10, 10]);
    nodesRepo.findPlaceable.mockResolvedValue([{ capacity: 8, allocated_count: 4 }]);
    jobsRepo.countInFlightByType.mockResolvedValue(0);

    // The first create "runs long"; while it is in flight the cluster fills up
    // with tenant demand, exactly the arrival the one-shot snapshot missed.
    const create = mock(async () => {
      jobsRepo.countInFlightByType.mockResolvedValue(4);
      return { id: "new", nodeId: "node-1" };
    });
    const { creator } = fakeCreator({ createPoolContainer: create });
    const manager = new WarmPoolManager(creator);

    const result = await manager.replenish("img:tag");

    expect(result.decision.toCreate).toBe(2); // 4 free - reserve 2
    // Without revalidation both planned creates would land; the guard stops
    // after the first because the refreshed reading grants nothing.
    expect(create).toHaveBeenCalledTimes(1);
    expect(result.created).toHaveLength(1);
    expect(result.contention.pendingTenantJobs).toBe(4);
    // Revalidation re-read the live contention inputs for the second create.
    expect(jobsRepo.countInFlightByType).toHaveBeenCalledTimes(2);
  });
});

describe("replenish never throws — a create failure is captured, not propagated", () => {
  test("a per-container provision failure is recorded in failed[] and stops the burst", async () => {
    const { WarmPoolManager } = await load();
    // Big deficit so the burst limit (3) would otherwise create multiple.
    repo.countAllPoolEntries.mockResolvedValue({ ready: 0, provisioning: 0 });
    repo.countUserProvisionsByHour.mockResolvedValue([10, 10, 10, 10, 10, 10]);

    const create = mock(async () => {
      throw new Error("node full: no space left on device");
    });
    const { creator } = fakeCreator({
      createPoolContainer: create as unknown as PoolContainerCreator["createPoolContainer"],
    });
    const manager = new WarmPoolManager(creator);

    // Critically: does NOT reject. The daemon phase wraps this in runBoundedPhase
    // but replenish already fails-soft, so the rest of the maintenance cycle is
    // never killed by a bad node.
    const result = await manager.replenish("img:tag");

    expect(result.created).toEqual([]);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]?.error).toContain("no space left on device");
    // Burst STOPS on the first failure — it does not hammer a broken node.
    expect(create).toHaveBeenCalledTimes(1);
  });
});
