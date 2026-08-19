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
 * It also pins the J6 teardown branch (a destroy failure is recorded, not
 * thrown) and the retry round: the probe crosses the headscale mesh, whose
 * transient >5s hiccups made one-strike reaping destroy every ready entry, so
 * a row is reaped only after `healthProbeAttempts` consecutive misses, retried
 * concurrently with the fixed policy spacing and nothing else.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { PoolContainerCreator } from "./agent-warm-pool";
import { DEFAULT_WARM_POOL_POLICY } from "./agent-warm-pool-forecast";

const repo = {
  listClaimablePool: mock(async () => [] as Array<{ id: string }>),
  listWarmPoolReconciliationCandidates: mock(async () => []),
  promoteStrandedPoolEntryReady: mock(async () => undefined),
  reserveUnclaimablePoolEntryForReap: mock(async () => undefined),
  reserveStuckPoolEntryForReap: mock(async () => undefined),
  listPoolEntriesForRollout: mock(async () => [] as Array<Record<string, unknown>>),
  reserveStalePoolEntryForRollout: mock(async () => undefined),
  findById: mock(async () => undefined),
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

/** Instant sleep spy — records requested delays, never waits real time. */
function instantSleep(): { sleepFn: (ms: number) => Promise<void>; delays: number[] } {
  const delays: number[] = [];
  return {
    delays,
    sleepFn: async (ms: number) => {
      delays.push(ms);
    },
  };
}

const now = () => Date.now();

/** Bounded poll for an async condition — the suite never waits unboundedly. */
async function waitFor(cond: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 500 && !cond(); i++) {
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  if (!cond()) throw new Error(`timed out waiting for ${label}`);
}

beforeEach(() => {
  warmPoolEnabled = true;
  repo.listClaimablePool.mockReset();
  repo.listWarmPoolReconciliationCandidates.mockReset();
  repo.listWarmPoolReconciliationCandidates.mockResolvedValue([]);
  repo.findStuckPoolProvisioning.mockReset();
  repo.findStuckPoolProvisioning.mockResolvedValue([]);
  repo.listPoolEntriesForRollout.mockReset();
  repo.listPoolEntriesForRollout.mockResolvedValue([]);
  repo.reserveStalePoolEntryForRollout.mockReset();
  repo.reserveStalePoolEntryForRollout.mockResolvedValue(undefined);
  repo.findById.mockReset();
  repo.findById.mockResolvedValue(undefined);
});

afterEach(() => {
  mock.restore();
});

describe("healthCheck fails closed on an internal probe failure", () => {
  test("a probe THROW propagates and destroys NOTHING", async () => {
    const { WarmPoolManager } = await load();
    repo.listClaimablePool.mockResolvedValue([{ id: "row-1" }, { id: "row-2" }]);

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
  test("a designed `false` on EVERY attempt reaps the row — destroy IS called", async () => {
    const { WarmPoolManager } = await load();
    repo.listClaimablePool.mockResolvedValue([{ id: "dead-1" }]);

    const destroy = mock(async () => undefined);
    const probe = mock(async () => false);
    const { creator } = fakeCreator({ destroyPoolContainer: destroy, healthProbe: probe });
    const { sleepFn } = instantSleep();
    const manager = new WarmPoolManager(creator, DEFAULT_WARM_POOL_POLICY, now, sleepFn);

    const result = await manager.healthCheck();
    expect(probe).toHaveBeenCalledTimes(DEFAULT_WARM_POOL_POLICY.healthProbeAttempts);
    expect(destroy).toHaveBeenCalledTimes(1);
    expect(destroy).toHaveBeenCalledWith("dead-1");
    expect(result.alive).toBe(0);
    expect(result.removed).toEqual([
      { id: "dead-1", reason: "health probe failed after 3 attempts" },
    ]);
  });

  test("a `true` probe keeps the row alive — destroy NOT called", async () => {
    const { WarmPoolManager } = await load();
    repo.listClaimablePool.mockResolvedValue([{ id: "healthy-1" }]);

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
    repo.listClaimablePool.mockResolvedValue([{ id: "dead-2" }]);

    const probe = mock(async () => false);
    const destroy = mock(async () => {
      throw new Error("ssh timeout");
    });
    const { creator } = fakeCreator({ destroyPoolContainer: destroy, healthProbe: probe });
    const { sleepFn } = instantSleep();
    const manager = new WarmPoolManager(creator, DEFAULT_WARM_POOL_POLICY, now, sleepFn);

    // Teardown is best-effort: the pass completes and the failure is surfaced in
    // the reason (retried next pass), NOT swallowed into a clean removal.
    const result = await manager.healthCheck();
    expect(result.removed).toHaveLength(1);
    expect(result.removed[0]?.id).toBe("dead-2");
    expect(result.removed[0]?.reason).toContain("destroy errored: ssh timeout");
  });
});

describe("healthCheck retry round tolerates transient mesh hiccups", () => {
  test("a transient miss (fail, fail, pass) RETAINS the entry — destroy NOT called", async () => {
    const { WarmPoolManager } = await load();
    repo.listClaimablePool.mockResolvedValue([{ id: "flaky-1" }]);

    let calls = 0;
    const probe = mock(async () => {
      calls++;
      return calls >= 3; // first probe + first retry miss, second retry answers
    });
    const destroy = mock(async () => undefined);
    const { creator } = fakeCreator({ destroyPoolContainer: destroy, healthProbe: probe });
    const { sleepFn, delays } = instantSleep();
    const manager = new WarmPoolManager(creator, DEFAULT_WARM_POOL_POLICY, now, sleepFn);

    const result = await manager.healthCheck();
    expect(probe).toHaveBeenCalledTimes(3);
    expect(destroy).not.toHaveBeenCalled();
    expect(result.alive).toBe(1);
    expect(result.removed).toEqual([]);
    // Each retry waited exactly the fixed policy spacing.
    expect(delays).toEqual([
      DEFAULT_WARM_POOL_POLICY.healthProbeRetryDelayMs,
      DEFAULT_WARM_POOL_POLICY.healthProbeRetryDelayMs,
    ]);
  });

  test("retry waits are BOUNDED: exactly attempts-1 spaced probes per failing row, never more", async () => {
    const { WarmPoolManager } = await load();
    repo.listClaimablePool.mockResolvedValue([{ id: "dead-3" }]);

    const probe = mock(async () => false);
    const destroy = mock(async () => undefined);
    const { creator } = fakeCreator({ destroyPoolContainer: destroy, healthProbe: probe });
    const { sleepFn, delays } = instantSleep();
    const manager = new WarmPoolManager(creator, DEFAULT_WARM_POOL_POLICY, now, sleepFn);

    const result = await manager.healthCheck();
    // 3 attempts total: 1 first-pass probe + 2 retries, each behind one wait.
    expect(probe).toHaveBeenCalledTimes(DEFAULT_WARM_POOL_POLICY.healthProbeAttempts);
    expect(delays).toEqual([
      DEFAULT_WARM_POOL_POLICY.healthProbeRetryDelayMs,
      DEFAULT_WARM_POOL_POLICY.healthProbeRetryDelayMs,
    ]);
    expect(result.removed).toEqual([
      { id: "dead-3", reason: "health probe failed after 3 attempts" },
    ]);
  });

  test("suspect rows retry CONCURRENTLY — both waits open before either resolves", async () => {
    const { WarmPoolManager } = await load();
    repo.listClaimablePool.mockResolvedValue([{ id: "s-1" }, { id: "s-2" }]);

    const pending: Array<() => void> = [];
    const delays: number[] = [];
    const sleepFn = (ms: number) =>
      new Promise<void>((resolve) => {
        delays.push(ms);
        pending.push(resolve);
      });

    // The sequential first pass misses both rows; every retry probe answers.
    let firstPass = 0;
    const probe = mock(async () => {
      if (firstPass < 2) {
        firstPass++;
        return false;
      }
      return true;
    });
    const destroy = mock(async () => undefined);
    const { creator } = fakeCreator({ destroyPoolContainer: destroy, healthProbe: probe });
    const manager = new WarmPoolManager(creator, DEFAULT_WARM_POOL_POLICY, now, sleepFn);

    const resultPromise = manager.healthCheck();
    // Sequential retries would open one wait at a time; the sweep's bounded
    // worst case relies on all suspects waiting simultaneously.
    await waitFor(() => pending.length === 2, "both suspects' retry waits to open");
    expect(delays).toEqual([
      DEFAULT_WARM_POOL_POLICY.healthProbeRetryDelayMs,
      DEFAULT_WARM_POOL_POLICY.healthProbeRetryDelayMs,
    ]);
    for (const release of pending.splice(0)) release();

    const result = await resultPromise;
    expect(result.alive).toBe(2);
    expect(destroy).not.toHaveBeenCalled();
    expect(result.removed).toEqual([]);
  });

  test("an internal throw during a RETRY propagates and destroys NOTHING — even a confirmed-dead sibling", async () => {
    const { WarmPoolManager } = await load();
    repo.listClaimablePool.mockResolvedValue([{ id: "flaky-2" }, { id: "dead-4" }]);

    const dbError = new Error("findById: connection reset");
    let flakyCalls = 0;
    const probe = mock(async (id: string) => {
      if (id === "dead-4") return false; // misses every attempt
      flakyCalls++;
      if (flakyCalls === 1) return false; // first pass misses…
      throw dbError; // …then its retry hits an internal failure
    });
    const destroy = mock(async () => undefined);
    const { creator } = fakeCreator({ destroyPoolContainer: destroy, healthProbe: probe });
    const { sleepFn } = instantSleep();
    const manager = new WarmPoolManager(creator, DEFAULT_WARM_POOL_POLICY, now, sleepFn);

    // Indeterminate sweep ⇒ fail closed: the error surfaces and NO row is
    // reaped, including the sibling whose probes all designed-failed.
    await expect(manager.healthCheck()).rejects.toBe(dbError);
    expect(destroy).not.toHaveBeenCalled();
  });

  test("zero claimable rows ⇒ no probes and no retry waits", async () => {
    const { WarmPoolManager } = await load();
    repo.listClaimablePool.mockResolvedValue([]);

    const destroy = mock(async () => undefined);
    const probe = mock(async () => true);
    const { creator } = fakeCreator({ destroyPoolContainer: destroy, healthProbe: probe });
    const { sleepFn, delays } = instantSleep();
    const manager = new WarmPoolManager(creator, DEFAULT_WARM_POOL_POLICY, now, sleepFn);

    const result = await manager.healthCheck();
    expect(probe).not.toHaveBeenCalled();
    expect(delays).toEqual([]);
    expect(destroy).not.toHaveBeenCalled();
    expect(result.probed).toBe(0);
    expect(result.removed).toEqual([]);
  });
});

describe("healthCheck honors the disabled no-op", () => {
  test("WARM_POOL_ENABLED=false short-circuits without touching the repo or creator", async () => {
    const { WarmPoolManager } = await load();
    warmPoolEnabled = false;

    const { creator, destroy } = fakeCreator();
    const manager = new WarmPoolManager(creator);

    const result = await manager.healthCheck();
    expect(result).toEqual({
      probed: 0,
      alive: 0,
      reconciliation: {
        scanned: 0,
        probed: 0,
        promoted: [],
        reaped: [],
        deferred: [],
        failed: [],
      },
      removed: [],
    });
    expect(repo.listClaimablePool).not.toHaveBeenCalled();
    expect(destroy).not.toHaveBeenCalled();
  });
});

const TARGET_DIGEST = `sha256:${"a".repeat(64)}`;
const STALE_DIGEST = `sha256:${"b".repeat(64)}`;

function rolloutRow(
  id: string,
  digest: string | null,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id,
    organization_id: "pool-org",
    status: "running",
    environment_revision: 1,
    sandbox_id: `sandbox-${id}`,
    node_id: "node-1",
    container_name: `agent-${id}`,
    bridge_url: "http://100.64.0.10:3000",
    health_url: "http://100.64.0.10:3000/health",
    docker_image: "ghcr.io/elizaos/eliza:stable",
    image_digest: digest,
    pool_ready_at: new Date("2026-08-19T00:00:00.000Z"),
    replacement_cleanup_sandbox_id: null,
    ...overrides,
  };
}

describe("rollout exact-generation claim fencing", () => {
  test("fences every stale generation even with no target-ready row, but destroys none yet", async () => {
    const { WarmPoolManager } = await load();
    const oldA = rolloutRow("old-a", STALE_DIGEST);
    const oldB = rolloutRow("old-b", STALE_DIGEST);
    repo.listPoolEntriesForRollout.mockResolvedValue([oldA, oldB]);
    repo.reserveStalePoolEntryForRollout.mockImplementation(async (row) => row);
    const { creator, destroy } = fakeCreator();
    const manager = new WarmPoolManager(creator, {
      ...DEFAULT_WARM_POOL_POLICY,
      minPoolSize: 1,
      replenishBurstLimit: 2,
    });

    const result = await manager.rollout("ghcr.io/elizaos/eliza:stable", TARGET_DIGEST);

    expect(repo.reserveStalePoolEntryForRollout).toHaveBeenCalledTimes(2);
    expect(result.reserved).toEqual(["old-a", "old-b"]);
    expect(result.decision.toReplace).toEqual([]);
    expect(destroy).not.toHaveBeenCalled();
  });

  test("a concurrent claim that wins the generation CAS is never destroyed", async () => {
    const { WarmPoolManager } = await load();
    repo.listPoolEntriesForRollout.mockResolvedValue([
      rolloutRow("claim-winner", STALE_DIGEST, {
        status: "provisioning",
        pool_ready_at: null,
      }),
    ]);
    repo.reserveStalePoolEntryForRollout.mockResolvedValue(undefined);
    const { creator, destroy } = fakeCreator();
    const manager = new WarmPoolManager(creator);

    const result = await manager.rollout("ghcr.io/elizaos/eliza:stable", TARGET_DIGEST);

    expect(result.reserved).toEqual([]);
    expect(result.deferred[0]?.reason).toContain("claimed");
    expect(destroy).not.toHaveBeenCalled();
  });

  test("partial teardown failure stays fenced and succeeds on the next bounded sweep", async () => {
    const { WarmPoolManager } = await load();
    const target = rolloutRow("target", TARGET_DIGEST);
    const stale = rolloutRow("stale", STALE_DIGEST);
    repo.listPoolEntriesForRollout.mockResolvedValue([target, stale]);
    repo.reserveStalePoolEntryForRollout.mockImplementation(async (row) => row);
    let attempts = 0;
    const destroy = mock(async () => {
      attempts++;
      if (attempts === 1) throw new Error("ssh timeout");
    });
    const { creator } = fakeCreator({ destroyPoolContainer: destroy });
    const manager = new WarmPoolManager(creator);

    const first = await manager.rollout("ghcr.io/elizaos/eliza:stable", TARGET_DIGEST);
    const second = await manager.rollout("ghcr.io/elizaos/eliza:stable", TARGET_DIGEST);

    expect(first.failed[0]?.error).toContain("ssh timeout");
    expect(first.replaced).toEqual([]);
    expect(second.replaced).toEqual(["stale"]);
    expect(destroy).toHaveBeenCalledTimes(2);
  });

  test("a retained cleanup tombstone is failed, never reported as replaced", async () => {
    const { WarmPoolManager } = await load();
    const target = rolloutRow("target", TARGET_DIGEST);
    const stale = rolloutRow("stale-retained", STALE_DIGEST);
    repo.listPoolEntriesForRollout.mockResolvedValue([target, stale]);
    repo.reserveStalePoolEntryForRollout.mockImplementation(async (row) => row);
    repo.findById.mockResolvedValue(stale);
    const { creator, destroy } = fakeCreator();
    const manager = new WarmPoolManager(creator);

    const result = await manager.rollout("ghcr.io/elizaos/eliza:stable", TARGET_DIGEST);

    expect(destroy).toHaveBeenCalledWith("stale-retained");
    expect(result.replaced).toEqual([]);
    expect(result.failed).toEqual([
      {
        id: "stale-retained",
        error: "remote teardown did not remove the fenced pool generation",
      },
    ]);
  });
});
