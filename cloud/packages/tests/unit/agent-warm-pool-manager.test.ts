import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { AgentSandbox } from "@/db/schemas/agent-sandboxes";
import type { PoolContainerCreator } from "@/lib/services/containers/agent-warm-pool";
import { DEFAULT_WARM_POOL_POLICY } from "@/lib/services/containers/agent-warm-pool-forecast";

const NOW = Date.parse("2026-05-06T12:00:00.000Z");
const IMAGE = "ghcr.io/elizaos/eliza:latest";

type RepoMock = {
  countAllPoolEntries: ReturnType<typeof mock>;
  countUnclaimedPool: ReturnType<typeof mock>;
  countUserProvisionsByHour: ReturnType<typeof mock>;
  listUnclaimedPool: ReturnType<typeof mock>;
  findStuckPoolProvisioning: ReturnType<typeof mock>;
};

type CreatorMock = PoolContainerCreator & {
  createCalls: number;
  destroyCalls: string[];
  probeReturns: Map<string, boolean>;
};

function makeRow(overrides: Partial<AgentSandbox> = {}): AgentSandbox {
  return {
    id: overrides.id ?? "pool-1",
    organization_id: "00000000-0000-4000-8000-000000077001",
    user_id: "00000000-0000-4000-8000-000000077002",
    character_id: null,
    sandbox_id: null,
    status: overrides.status ?? "running",
    bridge_url: "http://node-1.test:31337",
    health_url: "http://node-1.test:31337/health",
    agent_name: overrides.agent_name ?? "pool-abc",
    agent_config: null,
    neon_project_id: null,
    neon_branch_id: null,
    database_uri: null,
    database_status: "ready",
    database_error: null,
    snapshot_id: null,
    last_backup_at: null,
    last_heartbeat_at: null,
    error_message: null,
    error_count: 0,
    environment_vars: {},
    node_id: overrides.node_id ?? "node-1",
    container_name: "container-pool-1",
    bridge_port: 31337,
    web_ui_port: 2138,
    headscale_ip: "10.0.0.1",
    docker_image: overrides.docker_image ?? IMAGE,
    billing_status: "active",
    last_billed_at: null,
    hourly_rate: "0.0100",
    total_billed: "0.00",
    shutdown_warning_sent_at: null,
    scheduled_shutdown_at: null,
    pool_status: "unclaimed",
    pool_ready_at: overrides.pool_ready_at ?? new Date(NOW - 60_000),
    claimed_at: null,
    created_at: new Date(NOW - 5 * 60_000),
    updated_at: new Date(NOW - 60_000),
    ...overrides,
  } as AgentSandbox;
}

function installRepoMocks(repo: RepoMock): void {
  mock.module("@/db/repositories/agent-sandboxes", () => ({
    agentSandboxesRepository: repo,
  }));
}

/**
 * Toggle warm-pool via real env vars (avoids mock.module on containers-env,
 * which leaks across test files in Bun).
 */
function setEnv(enabled: boolean): void {
  if (enabled) process.env.WARM_POOL_ENABLED = "true";
  else delete process.env.WARM_POOL_ENABLED;
}

function installLoggerMock(): void {
  mock.module("@/lib/utils/logger", () => ({
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
  }));
}

function makeCreator(): CreatorMock {
  let counter = 0;
  const probeReturns = new Map<string, boolean>();
  return {
    createCalls: 0,
    destroyCalls: [],
    probeReturns,
    async createPoolContainer() {
      counter++;
      this.createCalls++;
      return { id: `created-${counter}`, nodeId: "node-1" };
    },
    async destroyPoolContainer(id: string) {
      this.destroyCalls.push(id);
    },
    async healthProbe(id: string) {
      return probeReturns.get(id) ?? true;
    },
  } as CreatorMock;
}

async function importManager() {
  const url = new URL(
    `../../lib/services/containers/agent-warm-pool.ts?test=${Date.now()}-${Math.random()}`,
    import.meta.url,
  );
  return import(url.href) as Promise<typeof import("@/lib/services/containers/agent-warm-pool")>;
}

const ENV_KEYS_TO_SCRUB = [
  "WARM_POOL_ENABLED",
  "WARM_POOL_MIN_SIZE",
  "WARM_POOL_MAX_SIZE",
] as const;
let envSnapshot: Record<string, string | undefined> = {};

// Note: do NOT call mock.restore() here. Bun's mock.restore() wipes module
// mocks installed at file scope by other test files, so calling it leaks
// failures into adjacent suites (e.g. provisioning-jobs-heartbeat). Each
// `mock.module(path, factory)` call overrides the previous one for that
// path, so re-installing per-test is sufficient.
beforeEach(() => {
  installLoggerMock();
  envSnapshot = {};
  for (const k of ENV_KEYS_TO_SCRUB) {
    envSnapshot[k] = process.env[k];
    delete process.env[k];
  }
});
afterEach(() => {
  for (const k of ENV_KEYS_TO_SCRUB) {
    const v = envSnapshot[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe("WarmPoolManager", () => {
  test("disabled pool no-ops on every operation", async () => {
    setEnv(false);
    installRepoMocks({
      countAllPoolEntries: mock(async () => ({ ready: 0, provisioning: 0 })),
      countUnclaimedPool: mock(async () => 0),
      countUserProvisionsByHour: mock(async () => [0, 0, 0]),
      listUnclaimedPool: mock(async () => []),
      findStuckPoolProvisioning: mock(async () => []),
    });
    const { WarmPoolManager } = await importManager();
    const creator = makeCreator();
    const mgr = new WarmPoolManager(creator, DEFAULT_WARM_POOL_POLICY, () => NOW);

    const r1 = await mgr.replenish(IMAGE);
    expect(r1.created).toEqual([]);
    expect(r1.decision.reason).toContain("WARM_POOL_ENABLED=false");
    expect(creator.createCalls).toBe(0);

    const r2 = await mgr.drainIdle(IMAGE);
    expect(r2.drained).toEqual([]);
    expect(creator.destroyCalls).toEqual([]);

    const r3 = await mgr.healthCheck();
    expect(r3.probed).toBe(0);

    const r4 = await mgr.rollout(IMAGE);
    expect(r4.replaced).toEqual([]);
  });

  test("replenish creates pool entries up to forecast target", async () => {
    setEnv(true);
    installRepoMocks({
      countAllPoolEntries: mock(async () => ({ ready: 0, provisioning: 0 })),
      countUnclaimedPool: mock(async () => 0),
      // 10 provisions/hr × 1 lead-time bucket → ~10 demand → +1 floor → clamped to maxPool=10
      countUserProvisionsByHour: mock(async () => [10, 10, 10, 10, 10, 10]),
      listUnclaimedPool: mock(async () => []),
      findStuckPoolProvisioning: mock(async () => []),
    });
    const { WarmPoolManager } = await importManager();
    const creator = makeCreator();
    const mgr = new WarmPoolManager(creator, DEFAULT_WARM_POOL_POLICY, () => NOW);

    const result = await mgr.replenish(IMAGE);
    expect(result.state.targetPoolSize).toBe(10);
    expect(result.decision.toCreate).toBe(DEFAULT_WARM_POOL_POLICY.replenishBurstLimit);
    expect(creator.createCalls).toBe(DEFAULT_WARM_POOL_POLICY.replenishBurstLimit);
    expect(result.created.length).toBe(DEFAULT_WARM_POOL_POLICY.replenishBurstLimit);
  });

  test("replenish stops on first failure", async () => {
    setEnv(true);
    installRepoMocks({
      countAllPoolEntries: mock(async () => ({ ready: 0, provisioning: 0 })),
      countUnclaimedPool: mock(async () => 0),
      countUserProvisionsByHour: mock(async () => [10, 10, 10, 10, 10, 10]),
      listUnclaimedPool: mock(async () => []),
      findStuckPoolProvisioning: mock(async () => []),
    });
    const { WarmPoolManager } = await importManager();
    const creator: CreatorMock = {
      createCalls: 0,
      destroyCalls: [],
      probeReturns: new Map(),
      async createPoolContainer() {
        this.createCalls++;
        if (this.createCalls === 2) throw new Error("hcloud quota exceeded");
        return { id: `c-${this.createCalls}`, nodeId: "node-1" };
      },
      async destroyPoolContainer(id: string) {
        this.destroyCalls.push(id);
      },
      async healthProbe() {
        return true;
      },
    } as CreatorMock;
    const mgr = new WarmPoolManager(creator, DEFAULT_WARM_POOL_POLICY, () => NOW);

    const result = await mgr.replenish(IMAGE);
    expect(result.created.length).toBe(1);
    expect(result.failed.length).toBe(1);
    expect(result.failed[0]?.error).toContain("hcloud quota");
  });

  test("drainIdle removes only past-idle-window entries when target == floor", async () => {
    setEnv(true);
    const old = new Date(NOW - 90 * 60 * 1000);
    const recent = new Date(NOW - 60_000);
    installRepoMocks({
      countAllPoolEntries: mock(async () => ({ ready: 3, provisioning: 0 })),
      countUnclaimedPool: mock(async () => 3),
      countUserProvisionsByHour: mock(async () => [0, 0, 0, 0, 0, 0]),
      listUnclaimedPool: mock(async () => [
        makeRow({ id: "old-a", pool_ready_at: old }),
        makeRow({ id: "old-b", pool_ready_at: old }),
        makeRow({ id: "fresh", pool_ready_at: recent }),
      ]),
      findStuckPoolProvisioning: mock(async () => []),
    });
    const { WarmPoolManager } = await importManager();
    const creator = makeCreator();
    const mgr = new WarmPoolManager(creator, DEFAULT_WARM_POOL_POLICY, () => NOW);

    const result = await mgr.drainIdle(IMAGE);
    expect(result.drained).toContain("old-a");
    expect(result.drained).toContain("old-b");
    expect(result.drained).not.toContain("fresh");
    // Floor is 1; pool had 3 ready + 0 demand → drain 2.
    expect(result.drained.length).toBe(2);
  });

  test("healthCheck removes failing pool entries and reaps stuck ones", async () => {
    setEnv(true);
    installRepoMocks({
      countAllPoolEntries: mock(async () => ({ ready: 2, provisioning: 0 })),
      countUnclaimedPool: mock(async () => 2),
      countUserProvisionsByHour: mock(async () => [0, 0, 0]),
      listUnclaimedPool: mock(async () => [makeRow({ id: "alive" }), makeRow({ id: "dead" })]),
      findStuckPoolProvisioning: mock(async () => [
        makeRow({ id: "stuck", status: "provisioning", pool_ready_at: null }),
      ]),
    });
    const { WarmPoolManager } = await importManager();
    const creator = makeCreator();
    creator.probeReturns.set("alive", true);
    creator.probeReturns.set("dead", false);
    const mgr = new WarmPoolManager(creator, DEFAULT_WARM_POOL_POLICY, () => NOW);

    const result = await mgr.healthCheck();
    expect(result.probed).toBe(2);
    expect(result.alive).toBe(1);
    expect(creator.destroyCalls).toEqual(expect.arrayContaining(["dead", "stuck"]));
    expect(result.removed.length).toBe(2);
  });

  test("rollout drains rows whose docker_image differs from current", async () => {
    setEnv(true);
    installRepoMocks({
      countAllPoolEntries: mock(async () => ({ ready: 2, provisioning: 0 })),
      countUnclaimedPool: mock(async () => 2),
      countUserProvisionsByHour: mock(async () => [0, 0, 0]),
      listUnclaimedPool: mock(async () => [
        makeRow({ id: "stale", docker_image: "ghcr.io/elizaos/eliza:v1" }),
        makeRow({ id: "fresh", docker_image: IMAGE }),
      ]),
      findStuckPoolProvisioning: mock(async () => []),
    });
    const { WarmPoolManager } = await importManager();
    const creator = makeCreator();
    const mgr = new WarmPoolManager(creator, DEFAULT_WARM_POOL_POLICY, () => NOW);

    const result = await mgr.rollout(IMAGE);
    expect(result.replaced).toEqual(["stale"]);
    expect(creator.destroyCalls).toEqual(["stale"]);
  });
});
