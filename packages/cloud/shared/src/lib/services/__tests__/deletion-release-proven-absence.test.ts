/**
 * A deletion generation releases its node slot only on PROVEN absence (#17185).
 *
 * The exactly-once CAS is covered elsewhere; what these pin is the policy that
 * decides whether the CAS is reached at all. Two paths must NOT release: a
 * reachable stop failure (the container is still there and the teardown will be
 * retried) and a bounded-timeout or unreachable-node abandon (the container may
 * still be running).
 * Releasing on either hands a live container's slot back to the scheduler, which
 * then packs a new container onto a node still running the old one — a worse
 * failure than the double-free this feature closes, because it is invisible
 * until the node is oversubscribed.
 *
 * Drives the real `ElizaSandboxService.deleteAgent` against in-process PGlite
 * with the real repositories and a scripted `SandboxProvider` injected at the
 * `_provider` seam.
 *
 * The abandon case overrides `runBoundedSandboxStop` rather than stalling a real
 * stop past `SANDBOX_DELETE_STOP_TIMEOUT_MS` (120s, not env-tunable): that would
 * make the suite two minutes slower and timing-dependent for no added coverage.
 * The timer itself is exercised by the provider suites; what is under test here
 * is what `deleteAgent` does with a tagged timeout, which is exactly the
 * branch a future refactor could silently drop.
 *
 * Every delete passes `authorization: "user_request"`: the seeded agent is a
 * running dedicated workload, and the live-agent deletion guard (#18573)
 * refuses unauthorized deletes before the slot-release policy under test here
 * is ever reached.
 */

import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";

const AMBIENT_DATABASE_URL = process.env.DATABASE_URL ?? "";
const CAN_USE_ISOLATED_PGLITE =
  AMBIENT_DATABASE_URL === "" || AMBIENT_DATABASE_URL.startsWith("pglite");
process.env.DATABASE_URL ||= "pglite://memory";
process.env.NODE_ENV ||= "test";
process.env.MOCK_REDIS = "1";

import { eq } from "drizzle-orm";
import { agentSandboxes } from "../../../db/schemas/agent-sandboxes";
import { dockerNodes } from "../../../db/schemas/docker-nodes";
import { organizations } from "../../../db/schemas/organizations";
import { users } from "../../../db/schemas/users";
import { apiKeysService } from "../api-keys";
import { AGENT_ORPHAN_RECONCILER_CONFIG } from "../docker-node-workloads";
import {
  type OrphanReconcilerNode,
  reconcileOrphanContainers,
} from "../orphan-container-reconciler";
import type { SandboxDeletionStopOutcome } from "../sandbox-provider-types";
import { PROVISIONING_JOB_TEST_TABLES } from "./tier-upgrade-pglite-schema";

const PGLITE_TIMEOUT = 60_000;

let pgliteReady = true;
let dbWrite: typeof import("../../../db/client").dbWrite;
let closeDb: typeof import("../../../db/client").closeDatabaseConnectionsForTests | undefined;
let ElizaSandboxService: typeof import("../eliza-sandbox").ElizaSandboxService;
let snapshotEndpointUnsupported: string;

let seq = 0;
function uniq(p: string): string {
  seq += 1;
  return `${p}-${seq}-${Math.random().toString(36).slice(2, 8)}`;
}

beforeAll(async () => {
  if (!CAN_USE_ISOLATED_PGLITE) {
    pgliteReady = false;
    console.error("[deletion-release-proven-absence] non-PGlite DATABASE_URL; failing.");
    return;
  }
  try {
    ({ closeDatabaseConnectionsForTests: closeDb, dbWrite } = await import("../../../db/client"));
    ({ ElizaSandboxService, SNAPSHOT_ENDPOINT_UNSUPPORTED: snapshotEndpointUnsupported } =
      await import("../eliza-sandbox"));
    // Plain DDL rather than drizzle-kit pushSchema: the generated path spends
    // minutes on "Pulling schema from database" here and blows the hook budget.
    // This is the same helper the other provisioning-job PGlite suites use.
    for (const ddl of PROVISIONING_JOB_TEST_TABLES) {
      await dbWrite.execute(ddl);
    }
    await dbWrite.execute(`CREATE TABLE IF NOT EXISTS "docker_nodes" (
      "id" uuid NOT NULL DEFAULT gen_random_uuid(),
      "node_id" text NOT NULL,
      "hostname" text NOT NULL,
      "ssh_port" integer NOT NULL DEFAULT 22,
      "capacity" integer NOT NULL DEFAULT 8,
      "enabled" boolean NOT NULL DEFAULT true,
      "status" text NOT NULL DEFAULT 'unknown'::text,
      "allocated_count" integer NOT NULL DEFAULT 0,
      "placement_state" text NOT NULL DEFAULT 'open',
      "last_health_check" timestamptz,
      "ssh_user" text NOT NULL DEFAULT 'root'::text,
      "host_key_fingerprint" text,
      "fleet_kind" text,
      "infrastructure_provider" text,
      "provider_server_id" text,
      "node_incarnation" uuid,
      "current_node_history_id" uuid,
      "metadata" jsonb NOT NULL DEFAULT '{}'::jsonb,
      "created_at" timestamptz NOT NULL DEFAULT now(),
      "updated_at" timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY ("id"),
      UNIQUE ("node_id")
    )`);
    await dbWrite.execute(`CREATE TABLE IF NOT EXISTS "shared_runtime_history" (
      "agent_id" text NOT NULL,
      "channel_id" text NOT NULL,
      "messages" jsonb NOT NULL,
      "updated_at" timestamp NOT NULL DEFAULT now(),
      PRIMARY KEY ("agent_id", "channel_id")
    )`);
  } catch (error) {
    pgliteReady = false;
    console.error("[deletion-release-proven-absence] PGlite/pushSchema unavailable.", error);
  }
}, PGLITE_TIMEOUT);

afterAll(async () => {
  if (closeDb) await closeDb();
});

/** A placed, running agent owning one of its node's two slots (the other is a live sibling). */
async function seedPlacedAgent(): Promise<{
  service: InstanceType<typeof ElizaSandboxService>;
  agentId: string;
  orgId: string;
  nodeId: string;
}> {
  const service = new ElizaSandboxService();
  const [org] = await dbWrite
    .insert(organizations)
    .values({ name: "Org", slug: uniq("org"), credit_balance: "5.000000" })
    .returning();
  const [user] = await dbWrite
    .insert(users)
    .values({ steward_user_id: uniq("steward"), organization_id: org.id })
    .returning();
  const created = await service.createAgent({
    organizationId: org.id,
    userId: user.id,
    agentName: uniq("agent"),
    executionTier: "dedicated-always",
    maxNonTerminalAgents: 10,
  });
  const nodeId = uniq("node");
  await dbWrite
    .insert(dockerNodes)
    .values({ node_id: nodeId, hostname: `${nodeId}.test.invalid`, allocated_count: 2 });
  await dbWrite
    .update(agentSandboxes)
    .set({
      status: "running",
      node_id: nodeId,
      container_name: uniq("container"),
      sandbox_id: uniq("sandbox"),
      bridge_url: "http://100.64.0.10:3000",
      headscale_ip: "100.64.0.10",
    })
    .where(eq(agentSandboxes.id, created.agent.id));
  return { service, agentId: created.agent.id, orgId: org.id, nodeId };
}

/** Injects a provider whose stop behaves as scripted; everything else is real. */
function scriptProvider(
  service: InstanceType<typeof ElizaSandboxService>,
  stop: () => Promise<void>,
  outcome: SandboxDeletionStopOutcome = { kind: "not-running-proven" },
): void {
  const seams = service as unknown as {
    _provider: unknown;
    fetchSnapshotState: () => Promise<never>;
  };
  // This suite owns allocation-release behavior, not snapshot transport. Model
  // an older image's supported no-snapshot response so the real delete path
  // persists its generation-scoped waiver before exercising teardown.
  seams.fetchSnapshotState = async () => {
    throw new Error(snapshotEndpointUnsupported);
  };
  seams._provider = {
    stopForDeletion: async () => {
      await stop();
      return outcome;
    },
    stopForReplacement: stop,
  };
}

async function nodeCount(nodeId: string): Promise<number> {
  const [row] = await dbWrite
    .select({ n: dockerNodes.allocated_count })
    .from(dockerNodes)
    .where(eq(dockerNodes.node_id, nodeId));
  return Number(row.n);
}

async function ownership(agentId: string): Promise<boolean | null> {
  const [row] = await dbWrite
    .select({ owned: agentSandboxes.deletion_allocation_counted })
    .from(agentSandboxes)
    .where(eq(agentSandboxes.id, agentId));
  return row?.owned ?? null;
}

describe("deleteAgent releases the node slot only when the workload is proven not running", () => {
  test(
    "a clean teardown releases exactly one slot",
    async () => {
      if (!pgliteReady) return;
      const { service, agentId, orgId, nodeId } = await seedPlacedAgent();
      scriptProvider(service, async () => {});

      await service.deleteAgent(agentId, orgId, { authorization: "user_request" });

      expect(await nodeCount(nodeId)).toBe(1);
    },
    PGLITE_TIMEOUT,
  );

  test(
    "a reachable stop failure keeps ownership and the slot",
    async () => {
      if (!pgliteReady) return;
      const { service, agentId, orgId, nodeId } = await seedPlacedAgent();
      // A reachable node that refuses: the container is still running, so the
      // teardown must be retried and the slot must stay counted until it works.
      scriptProvider(service, async () => {
        throw new Error("Cannot connect to the Docker daemon");
      });

      const result = await service.deleteAgent(agentId, orgId, { authorization: "user_request" });

      expect(result.success).toBe(false);
      expect(await nodeCount(nodeId)).toBe(2);
      expect(await ownership(agentId)).toBe(true);
    },
    PGLITE_TIMEOUT,
  );

  test(
    "a bounded-timeout abandon keeps ownership and the slot",
    async () => {
      if (!pgliteReady) return;
      const { service, agentId, orgId, nodeId } = await seedPlacedAgent();
      scriptProvider(service, async () => {});
      // The verdict `runBoundedSandboxStop` produces when the teardown blows its
      // hard cap: the delete completes but the container is ABANDONED and may
      // still be running, so its slot is not ours to hand back.
      (
        service as unknown as { runBoundedSandboxStop: () => Promise<unknown> }
      ).runBoundedSandboxStop = async () => ({
        kind: "stop-timed-out" as const,
        error: new Error("agent-delete stop timed out"),
      });

      const result = await service.deleteAgent(agentId, orgId, { authorization: "user_request" });

      expect(result).toMatchObject({ success: true, rowDeleted: false });
      expect(await nodeCount(nodeId)).toBe(2);
      expect(await ownership(agentId)).toBe(true);
    },
    PGLITE_TIMEOUT,
  );

  test(
    "an unreachable-node abandon completes deletion without releasing its slot",
    async () => {
      if (!pgliteReady) return;
      const { service, agentId, orgId, nodeId } = await seedPlacedAgent();
      scriptProvider(service, async () => {}, {
        kind: "not-running-unresolved",
        reason: "node-unreachable",
      });

      const result = await service.deleteAgent(agentId, orgId, { authorization: "user_request" });

      expect(result).toMatchObject({ success: true, rowDeleted: false });
      expect(await nodeCount(nodeId)).toBe(2);
      expect(await ownership(agentId)).toBe(true);
      const retained = await dbWrite.query.agentSandboxes.findFirst({
        where: eq(agentSandboxes.id, agentId),
      });
      expect(retained?.status).toBe("deletion_failed");
    },
    PGLITE_TIMEOUT,
  );

  test(
    "an unresolved tombstone survives until the real orphan reaper releases and retry finalizes it",
    async () => {
      if (!pgliteReady) return;
      const { service, agentId, orgId, nodeId } = await seedPlacedAgent();
      scriptProvider(service, async () => {}, {
        kind: "not-running-unresolved",
        reason: "node-unreachable",
      });
      const pending = await service.deleteAgent(agentId, orgId, { authorization: "user_request" });
      expect(pending).toMatchObject({ success: true, rowDeleted: false });

      const removed: string[] = [];
      const node: OrphanReconcilerNode = {
        node_id: nodeId,
        hostname: "reaper.test.invalid",
        status: "healthy",
        listContainers: async () => [
          { id: "immutable-container-id", name: `agent-${agentId}`, createdAtMs: 1 },
        ],
        removeContainer: async (containerId) => {
          removed.push(containerId);
        },
      };
      const reaped = await reconcileOrphanContainers([node], {
        ...AGENT_ORPHAN_RECONCILER_CONFIG,
        rowlessGraceMs: 0,
      });

      expect(reaped.reaped).toBe(1);
      expect(removed).toEqual(["immutable-container-id"]);
      expect(await nodeCount(nodeId)).toBe(1);
      expect(await ownership(agentId)).toBe(false);

      scriptProvider(service, async () => {});
      const finalized = await service.deleteAgent(agentId, orgId, {
        authorization: "user_request",
      });
      expect(finalized).toMatchObject({ success: true, rowDeleted: true });
      const row = await dbWrite.query.agentSandboxes.findFirst({
        where: eq(agentSandboxes.id, agentId),
      });
      expect(row).toBeUndefined();
      expect(await nodeCount(nodeId)).toBe(1);
    },
    PGLITE_TIMEOUT,
  );

  test(
    "a failure after the release, then a full-path retry, still decrements once",
    async () => {
      if (!pgliteReady) return;
      // The issue's headline scenario, driven end to end rather than by calling
      // the CAS twice by hand: the teardown succeeds and the slot is released,
      // then a downstream step fails, so the whole delete re-runs. The retry
      // must find ownership already spent and leave the live sibling's slot
      // alone. Credential revocation is the first thing after the release that
      // can fail, so it is the honest place to inject it.
      const { service, agentId, orgId, nodeId } = await seedPlacedAgent();
      scriptProvider(service, async () => {});

      const revoke = spyOn(apiKeysService, "revokeForAgent").mockRejectedValueOnce(
        new Error("credential revocation failed"),
      );
      try {
        await expect(
          service.deleteAgent(agentId, orgId, { authorization: "user_request" }),
        ).rejects.toThrow(/credential revocation failed/);
        // The release already committed before the failure — that is the design.
        expect(await nodeCount(nodeId)).toBe(1);
        expect(await ownership(agentId)).toBe(false);

        // Retry the whole path. Revocation now succeeds, the delete completes,
        // and the release CAS is a no-op because ownership is spent.
        await service.deleteAgent(agentId, orgId, { authorization: "user_request" });
        expect(await nodeCount(nodeId)).toBe(1);
      } finally {
        revoke.mockRestore();
      }
    },
    PGLITE_TIMEOUT,
  );
});

// Loud guard: PGlite is in-process, so this must be true or every case above
// early-returns and a safety proof becomes a vacuous green.
test("pglite schema applied — never a silent skip", () => {
  expect(pgliteReady).toBe(true);
});
