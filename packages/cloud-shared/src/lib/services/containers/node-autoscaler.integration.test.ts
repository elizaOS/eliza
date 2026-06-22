/**
 * Local autoscale-loop integration test (#8920).
 *
 * Drives the FULL scale-up → healthy → scale-down cycle of `NodeAutoscaler`
 * against two real collaborators and NO real credentials:
 *
 *  1. The stateful Hetzner HTTP mock (`@elizaos/cloud-test-mocks`) — a real
 *     fetch server whose `/servers` create/delete actions progress through a
 *     `running → success` lifecycle, mutating `server.status` to `running` once
 *     the action clock ticks. We point a real `HetznerCloudClient` at it via the
 *     #8919 ComputeProvider seam (`HCLOUD_API_BASE_URL` + an injected client),
 *     so NO HCLOUD_TOKEN and NO network to Hetzner.
 *
 *  2. A real PGlite-backed `docker_nodes` table (plus the `containers` /
 *     `agent_sandboxes` tables the workload counters read), using the same
 *     in-process PGlite harness the other cloud-shared DB tests use
 *     (`DATABASE_URL=pglite://memory`, real SQL via `dbWrite.execute`). The
 *     autoscaler's `dockerNodesRepository` writes/reads go through real Drizzle
 *     against real SQL.
 *
 * The test ticks across multiple cycles:
 *   - evaluateCapacity() on an empty pool → shouldScaleUp
 *   - provisionNode() → assert a docker_nodes row appears (status `unknown`)
 *   - flip it to `healthy` (the production health check's job) → assert
 *     evaluateCapacity() now sees healthy capacity and stops scaling up
 *   - add a SECOND healthy node + age both past the idle threshold + drive
 *     utilization down (zero workloads) → evaluateCapacity() flags a drain
 *     candidate → drainNode(deprovision) deletes the Hetzner server AND the row.
 *
 * Self-skips if PGlite is unavailable in this environment.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import {
  type RunningHetznerMock,
  startHetznerMock,
  // Relative import: `@elizaos/cloud-test-mocks` is a private workspace package
  // not symlinked into this package's node_modules in every environment, so we
  // resolve the source directly. cloud-shared's tsconfig excludes *.test.ts from
  // typecheck, and bun resolves the path natively at test time.
} from "../../../../../test/cloud-mocks/src/hetzner/index.ts";

// Env MUST be set before importing any module that reads it at load time:
//  - DATABASE_URL: PGlite in-memory (db/client reads it lazily, but pin early).
//  - HCLOUD_API_BASE_URL: hetzner-cloud-api reads this into a module const at
//    import, so it must be set BEFORE the dynamic import below — we therefore
//    start the mock and set this inside beforeAll, then import the client.
//  - MOCK_HETZNER_LATENCY=0: the mock injects 70-220ms artificial latency per
//    route by default; disable it so the loop runs fast.
process.env.DATABASE_URL ||= "pglite://memory";
process.env.NODE_ENV ||= "test";
process.env.MOCK_HETZNER_LATENCY = "0";
process.env.ENVIRONMENT ||= "local";
process.env.ELIZA_AGENT_IMAGE = "ghcr.io/elizaos/eliza:latest";
// arm64 so the autoscaler's architecture-compatibility filter treats a cax21
// (arm) node as compatible capacity.
process.env.ELIZA_AGENT_IMAGE_PLATFORM = "linux/arm64";

const PGLITE_TIMEOUT = 60_000;
const ACTION_MS = 5; // mock action lifecycle: provision/delete settle almost instantly

const policy = {
  minFreeSlotsBuffer: 4,
  minHotAvailableSlots: 1,
  maxNodes: 4,
  scaleUpCooldownMs: 5 * 60 * 1000,
  idleNodeMinAgeMs: 30 * 60 * 1000,
  defaultServerType: "cax21",
  defaultLocation: "fsn1",
  defaultImage: "ubuntu-24.04",
  defaultCapacity: 8,
};

const bootstrap = {
  controlPlanePublicKey: "ssh-ed25519 AAAAcontrol",
  registrationUrl: "https://cloud.example.test/register",
  registrationSecret: "secret",
};

let mock: RunningHetznerMock;
let dbWrite: typeof import("../../../db/client").dbWrite;
let HetznerCloudClient: typeof import("./hetzner-cloud-api").HetznerCloudClient;
let NodeAutoscaler: typeof import("./node-autoscaler").NodeAutoscaler;
let pgliteReady = true;
/** Restored in afterAll so sibling tests in the same process see the real endpoint. */
let originalApiBaseUrl: string | undefined;

/** Wall clock the autoscaler reads; advanced by the test to age nodes. */
let clockMs = Date.parse("2026-05-15T12:00:00Z");
const nowFn = () => clockMs;

beforeAll(async () => {
  // 1) Boot the mock and pin its URL into the env BEFORE importing the client.
  //    hetzner-cloud-api reads HCLOUD_API_BASE_URL per request, so setting it
  //    here (even after the module is loaded by a sibling test) takes effect.
  originalApiBaseUrl = process.env.HCLOUD_API_BASE_URL;
  mock = await startHetznerMock({ actionMs: ACTION_MS });
  process.env.HCLOUD_API_BASE_URL = mock.url;

  try {
    ({ dbWrite } = await import("../../../db/client"));
    ({ HetznerCloudClient } = await import("./hetzner-cloud-api"));
    ({ NodeAutoscaler } = await import("./node-autoscaler"));

    // Full docker_nodes table (the repository inserts via Drizzle over the whole
    // schema). containers + agent_sandboxes carry only the columns the workload
    // counters read.
    const ddl = [
      `CREATE TABLE IF NOT EXISTS docker_nodes (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        node_id text UNIQUE NOT NULL,
        hostname text NOT NULL,
        ssh_port integer NOT NULL DEFAULT 22,
        capacity integer NOT NULL DEFAULT 8,
        enabled boolean NOT NULL DEFAULT true,
        status text NOT NULL DEFAULT 'unknown',
        allocated_count integer NOT NULL DEFAULT 0,
        last_health_check timestamptz,
        ssh_user text NOT NULL DEFAULT 'root',
        host_key_fingerprint text,
        metadata jsonb NOT NULL DEFAULT '{}',
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      )`,
      `CREATE TABLE IF NOT EXISTS containers (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        organization_id uuid,
        node_id text,
        status text NOT NULL DEFAULT 'pending',
        updated_at timestamptz NOT NULL DEFAULT now()
      )`,
      `CREATE TABLE IF NOT EXISTS agent_sandboxes (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        organization_id uuid,
        node_id text,
        status text NOT NULL DEFAULT 'pending',
        pool_status text,
        updated_at timestamptz NOT NULL DEFAULT now()
      )`,
    ];
    for (const stmt of ddl) {
      await dbWrite.execute(stmt);
    }
  } catch (error) {
    pgliteReady = false;
    console.warn("[node-autoscaler.integration] PGlite unavailable, skipping:", error);
  }
}, PGLITE_TIMEOUT);

afterAll(async () => {
  await mock?.stop();
  if (originalApiBaseUrl === undefined) {
    delete process.env.HCLOUD_API_BASE_URL;
  } else {
    process.env.HCLOUD_API_BASE_URL = originalApiBaseUrl;
  }
});

beforeEach(async () => {
  if (!pgliteReady) return;
  clockMs = Date.parse("2026-05-15T12:00:00Z");
  await dbWrite.execute("DELETE FROM docker_nodes;");
  await dbWrite.execute("DELETE FROM containers;");
  await dbWrite.execute("DELETE FROM agent_sandboxes;");
});

/** A real Hetzner client wired to the mock — the production code path, no creds. */
function makeAutoscaler() {
  const provider = HetznerCloudClient.withToken("integration-test-token");
  return new NodeAutoscaler(policy, nowFn, {
    provider,
    isConfigured: () => true,
  });
}

async function nodeRows(): Promise<
  Array<{ node_id: string; status: string; enabled: boolean; hostname: string }>
> {
  const res = await dbWrite.execute(
    "SELECT node_id, status, enabled, hostname FROM docker_nodes ORDER BY node_id;",
  );
  return res.rows as Array<{
    node_id: string;
    status: string;
    enabled: boolean;
    hostname: string;
  }>;
}

/**
 * ISO timestamp `ms` before the autoscaler's injected clock. Used to backdate a
 * node's `created_at` so it ages relative to `nowFn()` (the autoscaler reads the
 * injected clock, but PGlite stamps `created_at = now()` at the real wall clock,
 * which would otherwise sit in the future relative to `clockMs`).
 */
function isoBefore(ms: number): string {
  return new Date(clockMs - ms).toISOString();
}

/** Wait until the mock has flipped a created server to `running`. */
async function waitForServerRunning(serverId: number): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (mock.store.servers.get(serverId)?.status === "running") return;
    await new Promise((resolve) => setTimeout(resolve, ACTION_MS));
  }
  throw new Error(`mock server ${serverId} never reached running`);
}

describe("NodeAutoscaler local autoscale loop (Hetzner mock + PGlite)", () => {
  test(
    "drives the full provision → healthy → drain cycle",
    async () => {
      if (!pgliteReady) return;
      const autoscaler = makeAutoscaler();

      // ── Cycle 1: empty pool → must scale up ─────────────────────────────
      const empty = await autoscaler.evaluateCapacity();
      expect(empty.enabledNodeCount).toBe(0);
      expect(empty.totalAvailable).toBe(0);
      expect(empty.shouldScaleUp).toBe(true);

      // ── Provision a node through the seam (real client → mock) ───────────
      const provisioned = await autoscaler.provisionNode({ nodeId: "node-a" }, bootstrap);
      expect(provisioned.nodeId).toBe("node-a");
      // The mock minted a real numeric server id and a public IPv4 the
      // autoscaler persisted as the hostname.
      expect(provisioned.hcloudServerId).toBeGreaterThan(0);
      expect(provisioned.hostname).toMatch(/^\d+\.\d+\.\d+\.\d+$/);

      // A docker_nodes row appears in `unknown` status (bootstrap in flight).
      let rows = await nodeRows();
      expect(rows).toHaveLength(1);
      expect(rows[0]?.node_id).toBe("node-a");
      expect(rows[0]?.status).toBe("unknown");
      expect(rows[0]?.hostname).toBe(provisioned.hostname);

      // The mock server actually exists and progresses to `running`.
      expect(mock.store.servers.has(provisioned.hcloudServerId)).toBe(true);
      await waitForServerRunning(provisioned.hcloudServerId);
      expect(mock.store.servers.get(provisioned.hcloudServerId)?.status).toBe("running");

      // An `unknown` node contributes NO capacity yet → still wants to scale up.
      const stillCold = await autoscaler.evaluateCapacity();
      expect(stillCold.healthyNodeCount).toBe(0);
      expect(stillCold.shouldScaleUp).toBe(true);

      // ── Tick the action clock to healthy (the health-check's job) ────────
      await dbWrite.execute(
        "UPDATE docker_nodes SET status = 'healthy', last_health_check = now() WHERE node_id = 'node-a';",
      );

      const healthy = await autoscaler.evaluateCapacity();
      expect(healthy.healthyNodeCount).toBe(1);
      expect(healthy.totalCapacity).toBe(policy.defaultCapacity);
      expect(healthy.totalAvailable).toBe(policy.defaultCapacity);
      // Available (8) >= buffer (4) → no further scale-up.
      expect(healthy.shouldScaleUp).toBe(false);

      // ── Add a SECOND healthy node so a drain is even allowed (the loop
      //    never drains the last healthy node) and so the pool is over-provisioned.
      const second = await autoscaler.provisionNode({ nodeId: "node-b" }, bootstrap);
      await dbWrite.execute(
        "UPDATE docker_nodes SET status = 'healthy', last_health_check = now() WHERE node_id = 'node-b';",
      );
      await waitForServerRunning(second.hcloudServerId);

      // Two healthy nodes, zero workloads → 16 free slots, way over buffer.
      // Both rows were just inserted, so relative to the autoscaler clock they
      // are brand-new (younger than idleNodeMinAgeMs) and NOT yet drainable.
      const recentCreated = isoBefore(0);
      await dbWrite.execute(
        `UPDATE docker_nodes SET created_at = '${recentCreated}' WHERE node_id IN ('node-a','node-b');`,
      );
      const overProvisioned = await autoscaler.evaluateCapacity();
      expect(overProvisioned.healthyNodeCount).toBe(2);
      expect(overProvisioned.shouldScaleUp).toBe(false);
      expect(overProvisioned.shouldScaleDownNodeIds).toHaveLength(0);

      // ── Drive utilization down: age both nodes past the idle threshold (and
      //    past the scale-up cooldown) so an idle, zero-workload node becomes
      //    drainable. Utilization is already zero — no containers/sandboxes. ──
      const agedCreated = isoBefore(policy.idleNodeMinAgeMs + 60_000);
      await dbWrite.execute(
        `UPDATE docker_nodes SET created_at = '${agedCreated}' WHERE node_id IN ('node-a','node-b');`,
      );

      const drainable = await autoscaler.evaluateCapacity();
      expect(drainable.shouldScaleUp).toBe(false);
      // At least one idle, aged node is now eligible for drain.
      expect(drainable.shouldScaleDownNodeIds.length).toBeGreaterThan(0);
      const drainTarget = drainable.shouldScaleDownNodeIds[0];
      if (drainTarget === undefined) throw new Error("expected a drain candidate");

      const targetRow = (await nodeRows()).find((r) => r.node_id === drainTarget);
      const targetServerId =
        drainTarget === "node-a" ? provisioned.hcloudServerId : second.hcloudServerId;
      expect(targetRow).toBeDefined();

      // ── drainNode(deprovision) → row deleted AND mock server deletion driven.
      await autoscaler.drainNode(drainTarget, { deprovision: true });

      const afterDrain = await nodeRows();
      expect(afterDrain.map((r) => r.node_id)).not.toContain(drainTarget);
      expect(afterDrain).toHaveLength(1);

      // The Hetzner mock processed the delete action; the server is gone (or
      // mid-deletion) — assert it is no longer a live `running` server.
      const deletedDeadline = Date.now() + 5_000;
      while (Date.now() < deletedDeadline) {
        const s = mock.store.servers.get(targetServerId);
        if (!s || s.status === "deleting") break;
        await new Promise((resolve) => setTimeout(resolve, ACTION_MS));
      }
      const finalServer = mock.store.servers.get(targetServerId);
      expect(finalServer === undefined || finalServer.status !== "running").toBe(true);

      // The surviving node still serves capacity — the pool drained safely.
      const settled = await autoscaler.evaluateCapacity();
      expect(settled.healthyNodeCount).toBe(1);
      expect(settled.shouldScaleUp).toBe(false);
    },
    PGLITE_TIMEOUT,
  );

  test(
    "never drains the last healthy node even when idle and aged",
    async () => {
      if (!pgliteReady) return;
      const autoscaler = makeAutoscaler();

      const only = await autoscaler.provisionNode({ nodeId: "solo" }, bootstrap);
      // Healthy + aged well past the idle threshold; utilization is zero.
      const agedCreated = isoBefore(policy.idleNodeMinAgeMs + 60_000);
      await dbWrite.execute(
        `UPDATE docker_nodes SET status = 'healthy', last_health_check = now(), created_at = '${agedCreated}' WHERE node_id = 'solo';`,
      );
      await waitForServerRunning(only.hcloudServerId);

      const decision = await autoscaler.evaluateCapacity();
      // Single healthy node is the floor: it must never be drained.
      expect(decision.healthyNodeCount).toBe(1);
      expect(decision.shouldScaleDownNodeIds).toHaveLength(0);
    },
    PGLITE_TIMEOUT,
  );
});
