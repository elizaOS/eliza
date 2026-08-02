/**
 * A deletion generation releases its node slot only on PROVEN absence (#17185).
 *
 * The exactly-once CAS is covered elsewhere; what these pin is the policy that
 * decides whether the CAS is reached at all. Two paths must NOT release: a
 * reachable stop failure (the container is still there and the teardown will be
 * retried) and a bounded-timeout abandon (the container may still be running).
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
 * is what `deleteAgent` DOES with a `timedOut` verdict, which is exactly the
 * branch a future refactor could silently drop.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";

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
import { PROVISIONING_JOB_TEST_TABLES } from "./tier-upgrade-pglite-schema";

const PGLITE_TIMEOUT = 60_000;

let pgliteReady = true;
let dbWrite: typeof import("../../../db/client").dbWrite;
let closeDb: typeof import("../../../db/client").closeDatabaseConnectionsForTests | undefined;
let ElizaSandboxService: typeof import("../eliza-sandbox").ElizaSandboxService;

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
    ({ ElizaSandboxService } = await import("../eliza-sandbox"));
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
      "last_health_check" timestamptz,
      "ssh_user" text NOT NULL DEFAULT 'root'::text,
      "host_key_fingerprint" text,
      "metadata" jsonb NOT NULL DEFAULT '{}'::jsonb,
      "created_at" timestamptz NOT NULL DEFAULT now(),
      "updated_at" timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY ("id"),
      UNIQUE ("node_id")
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
    })
    .where(eq(agentSandboxes.id, created.agent.id));
  return { service, agentId: created.agent.id, orgId: org.id, nodeId };
}

/** Injects a provider whose stop behaves as scripted; everything else is real. */
function scriptProvider(
  service: InstanceType<typeof ElizaSandboxService>,
  stop: () => Promise<void>,
): void {
  (service as unknown as { _provider: unknown })._provider = {
    stop,
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

describe("deleteAgent releases the node slot only on proven absence", () => {
  test(
    "a clean teardown releases exactly one slot",
    async () => {
      if (!pgliteReady) return;
      const { service, agentId, orgId, nodeId } = await seedPlacedAgent();
      scriptProvider(service, async () => {});

      await service.deleteAgent(agentId, orgId);

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

      const result = await service.deleteAgent(agentId, orgId);

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
        error: new Error("agent-delete stop timed out"),
        timedOut: true as const,
      });

      await service.deleteAgent(agentId, orgId);

      expect(await nodeCount(nodeId)).toBe(2);
    },
    PGLITE_TIMEOUT,
  );
});

// Loud guard: PGlite is in-process, so this must be true or every case above
// early-returns and a safety proof becomes a vacuous green.
test("pglite schema applied — never a silent skip", () => {
  expect(pgliteReady).toBe(true);
});
