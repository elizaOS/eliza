/**
 * Error-policy pins for the warm-pool manager's health-check reaper (#13415).
 *
 * Container-provisioning infra FAILS CLOSED: an internal failure inside a health
 * probe (its DB lookup throwing) must PROPAGATE, never be swallowed into
 * "unreachable" and used to destroy a live container — a DB blip would otherwise
 * drain the whole warm pool. This suite drives the real exported
 * `WarmPoolManager.healthCheck()` against a fake `PoolContainerCreator` and the
 * repository/env stubbed via `mock.module`, and proves three shapes stay
 * distinguishable:
 *   - a probe THROW propagates and destroys NOTHING (fail-closed);
 *   - a designed `false` (unreachable) reaps the row (destroy called);
 *   - a `true` probe keeps the row alive.
 * It also pins the J6 teardown branch: a destroy failure is recorded, not thrown.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { PoolContainerCreator } from "./agent-warm-pool";

const repo = {
  listUnclaimedPool: mock(async () => [] as Array<{ id: string }>),
  findStuckPoolProvisioning: mock(async () => [] as Array<{ id: string }>),
  countAllPoolEntries: mock(async () => ({ ready: 0, provisioning: 0 })),
  countUserProvisionsByHour: mock(async () => [] as number[]),
};

let warmPoolEnabled = true;

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
  destroy: ReturnType<typeof mock>;
  probe: ReturnType<typeof mock>;
} {
  const destroy = mock(async () => undefined);
  const probe = mock(async () => true);
  const creator: PoolContainerCreator = {
    createPoolContainer: mock(async () => ({ id: "new", nodeId: null })),
    destroyPoolContainer: overrides.destroyPoolContainer ?? destroy,
    healthProbe: overrides.healthProbe ?? probe,
  };
  return { creator, destroy, probe };
}

beforeEach(() => {
  warmPoolEnabled = true;
  repo.listUnclaimedPool.mockReset();
  repo.findStuckPoolProvisioning.mockReset();
  repo.findStuckPoolProvisioning.mockResolvedValue([]);
});

afterEach(() => {
  mock.restore();
});

describe("healthCheck fails closed on an internal probe failure", () => {
  test("a probe THROW propagates and destroys NOTHING", async () => {
    const { WarmPoolManager } = await load();
    repo.listUnclaimedPool.mockResolvedValue([{ id: "row-1" }, { id: "row-2" }]);

    const dbError = new Error("findById: connection reset");
    const destroy = mock(async () => undefined);
    const probe = mock(async () => {
      throw dbError;
    });
    const { creator } = fakeCreator({ destroyPoolContainer: destroy, healthProbe: probe });
    const manager = new WarmPoolManager(creator);

    // The internal failure must surface to the cron caller, not be swallowed.
    await expect(manager.healthCheck()).rejects.toBe(dbError);
    // Critically: no container was reaped on an INDETERMINATE probe result.
    expect(destroy).not.toHaveBeenCalled();
  });
});

describe("healthCheck designed paths stay distinct from the failure", () => {
  test("a designed `false` (unreachable) reaps the row — destroy IS called", async () => {
    const { WarmPoolManager } = await load();
    repo.listUnclaimedPool.mockResolvedValue([{ id: "dead-1" }]);

    const destroy = mock(async () => undefined);
    const probe = mock(async () => false);
    const { creator } = fakeCreator({ destroyPoolContainer: destroy, healthProbe: probe });
    const manager = new WarmPoolManager(creator);

    const result = await manager.healthCheck();
    expect(destroy).toHaveBeenCalledTimes(1);
    expect(destroy).toHaveBeenCalledWith("dead-1");
    expect(result.alive).toBe(0);
    expect(result.removed).toEqual([{ id: "dead-1", reason: "health probe failed" }]);
  });

  test("a `true` probe keeps the row alive — destroy NOT called", async () => {
    const { WarmPoolManager } = await load();
    repo.listUnclaimedPool.mockResolvedValue([{ id: "healthy-1" }]);

    const destroy = mock(async () => undefined);
    const probe = mock(async () => true);
    const { creator } = fakeCreator({ destroyPoolContainer: destroy, healthProbe: probe });
    const manager = new WarmPoolManager(creator);

    const result = await manager.healthCheck();
    expect(destroy).not.toHaveBeenCalled();
    expect(result.alive).toBe(1);
    expect(result.probed).toBe(1);
    expect(result.removed).toEqual([]);
  });

  test("J6 teardown: a destroy failure on a dead row is RECORDED, not thrown", async () => {
    const { WarmPoolManager } = await load();
    repo.listUnclaimedPool.mockResolvedValue([{ id: "dead-2" }]);

    const probe = mock(async () => false);
    const destroy = mock(async () => {
      throw new Error("ssh timeout");
    });
    const { creator } = fakeCreator({ destroyPoolContainer: destroy, healthProbe: probe });
    const manager = new WarmPoolManager(creator);

    // Teardown is best-effort: the pass completes and the failure is surfaced in
    // the reason (retried next pass), NOT swallowed into a clean removal.
    const result = await manager.healthCheck();
    expect(result.removed).toHaveLength(1);
    expect(result.removed[0]?.id).toBe("dead-2");
    expect(result.removed[0]?.reason).toContain("destroy errored: ssh timeout");
  });
});

describe("healthCheck honors the disabled no-op", () => {
  test("WARM_POOL_ENABLED=false short-circuits without touching the repo or creator", async () => {
    const { WarmPoolManager } = await load();
    warmPoolEnabled = false;

    const { creator, destroy } = fakeCreator();
    const manager = new WarmPoolManager(creator);

    const result = await manager.healthCheck();
    expect(result).toEqual({ probed: 0, alive: 0, removed: [] });
    expect(repo.listUnclaimedPool).not.toHaveBeenCalled();
    expect(destroy).not.toHaveBeenCalled();
  });
});
