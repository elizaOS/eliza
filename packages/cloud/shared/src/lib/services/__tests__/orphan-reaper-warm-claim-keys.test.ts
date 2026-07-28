/**
 * Real-DB proof that the orphan reaper's key resolution protects warm-claimed
 * containers (#17253 §1).
 *
 * A container claimed from the warm pool keeps the name it was born with —
 * `agent-<pool id>` — while the pool row it points at is deleted at claim time.
 * The claimed USER row records the provenance in `warm_claim_source_pool_id`.
 * Resolving node-side keys against `id` alone maps every claimed customer
 * container to a deleted row, and the sweep reaps it as `no_db_row` while the
 * customer is talking to it. The loader must therefore surface a placement for
 * the POOL key whenever a row claims it as its source.
 *
 * Drives the REAL loadSandboxStatusesByIds against in-process PGlite (real
 * Drizzle schema via pushSchema) with NOTHING mocked. Fails LOUDLY if
 * PGlite/pushSchema is unavailable (never silently passes).
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";

const AMBIENT_DATABASE_URL = process.env.DATABASE_URL ?? "";
const CAN_USE_ISOLATED_PGLITE =
  AMBIENT_DATABASE_URL === "" || AMBIENT_DATABASE_URL.startsWith("pglite");
process.env.DATABASE_URL ||= "pglite://memory";
process.env.NODE_ENV ||= "test";
process.env.MOCK_REDIS = "1";

import { pushSchema } from "drizzle-kit/api";
import { agentSandboxes } from "../../../db/schemas/agent-sandboxes";
import { organizations } from "../../../db/schemas/organizations";
import { userCharacters } from "../../../db/schemas/user-characters";
import { users } from "../../../db/schemas/users";

const PGLITE_TIMEOUT = 60_000;

let pgliteReady = true;
let dbWrite: typeof import("../../../db/client").dbWrite;
let closeDb: typeof import("../../../db/client").closeDatabaseConnectionsForTests | undefined;
let loadSandboxStatusesByIds: typeof import("../docker-node-workloads").loadSandboxStatusesByIds;

let seq = 0;
function uniq(p: string): string {
  seq += 1;
  return `${p}-${seq}-${Math.random().toString(36).slice(2, 8)}`;
}

async function seedOwner(): Promise<{ orgId: string; userId: string }> {
  const [org] = await dbWrite
    .insert(organizations)
    .values({ name: "Org", slug: uniq("org"), credit_balance: "1.000000" })
    .returning();
  const [user] = await dbWrite
    .insert(users)
    .values({ steward_user_id: uniq("steward"), organization_id: org.id })
    .returning();
  return { orgId: org.id, userId: user.id };
}

beforeAll(async () => {
  if (!CAN_USE_ISOLATED_PGLITE) {
    pgliteReady = false;
    console.warn("[orphan-reaper-warm-claim-keys.test] non-PGlite DATABASE_URL; failing.");
    return;
  }
  try {
    ({ closeDatabaseConnectionsForTests: closeDb, dbWrite } = await import("../../../db/client"));
    ({ loadSandboxStatusesByIds } = await import("../docker-node-workloads"));
    const schema = { organizations, users, userCharacters, agentSandboxes };
    const { apply } = await pushSchema(schema as never, dbWrite as never);
    await apply();
  } catch (error) {
    pgliteReady = false;
    console.error(
      "[orphan-reaper-warm-claim-keys.test] PGlite/pushSchema unavailable — failing.",
      error,
    );
  }
}, PGLITE_TIMEOUT);

afterAll(async () => {
  if (closeDb) await closeDb();
});

describe("orphan reaper key resolution for warm-claimed containers", () => {
  test(
    "a pool key resolves to the live claimed row, on the row's node",
    async () => {
      expect(pgliteReady).toBe(true);
      const { orgId, userId } = await seedOwner();
      const poolId = crypto.randomUUID();
      // The claimed USER row: its own id differs from the pool id its
      // container is named after; the pool row itself no longer exists.
      const [row] = await dbWrite
        .insert(agentSandboxes)
        .values({
          organization_id: orgId,
          user_id: userId,
          agent_name: uniq("claimed"),
          status: "running",
          execution_tier: "dedicated-always",
          node_id: "node-7",
          warm_claim_source_pool_id: poolId,
        })
        .returning();

      // The reaper resolves the key it parsed from `agent-<pool id>`.
      const placements = await loadSandboxStatusesByIds([poolId]);

      const forPoolKey = placements.filter((p) => p.key === poolId);
      expect(forPoolKey.length).toBeGreaterThanOrEqual(1);
      expect(forPoolKey[0]?.status).toBe("running");
      expect(forPoolKey[0]?.nodeId).toBe("node-7");
      // The row's own key is still protected too.
      expect(placements.some((p) => p.key === row.id)).toBe(true);
    },
    PGLITE_TIMEOUT,
  );

  test(
    "a pool id claimed by NO row yields no placement (a true orphan still reaps)",
    async () => {
      expect(pgliteReady).toBe(true);
      const placements = await loadSandboxStatusesByIds([crypto.randomUUID()]);
      expect(placements).toEqual([]);
    },
    PGLITE_TIMEOUT,
  );

  test(
    "a replacement placement is mirrored onto the pool key as well",
    async () => {
      expect(pgliteReady).toBe(true);
      const { orgId, userId } = await seedOwner();
      const poolId = crypto.randomUUID();
      await dbWrite
        .insert(agentSandboxes)
        .values({
          organization_id: orgId,
          user_id: userId,
          agent_name: uniq("claimed"),
          status: "running",
          execution_tier: "dedicated-always",
          node_id: "node-7",
          warm_claim_source_pool_id: poolId,
          // Full locator: the pair CHECK requires the whole tuple or none.
          replacement_cleanup_sandbox_id: crypto.randomUUID(),
          replacement_cleanup_node_id: "node-8",
          replacement_cleanup_container_name: "agent-old-twin",
          replacement_cleanup_attempt_id: crypto.randomUUID(),
          replacement_cleanup_allocation_counted: true,
          replacement_cleanup_created_at: new Date(),
        })
        .returning();

      const placements = await loadSandboxStatusesByIds([poolId]);
      const replacementForPool = placements.filter(
        (p) => p.key === poolId && p.status === "replacement_cleanup_owned",
      );
      expect(replacementForPool).toHaveLength(1);
      expect(replacementForPool[0]?.nodeId).toBe("node-8");
    },
    PGLITE_TIMEOUT,
  );
});
