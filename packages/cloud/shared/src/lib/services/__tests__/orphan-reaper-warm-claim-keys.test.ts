/**
 * Exercises warm-claim and cleanup-fence name resolution against an in-process
 * PGlite schema so physical container ownership cannot be mistaken for absence.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";

const AMBIENT_DATABASE_URL = process.env.DATABASE_URL ?? "";
process.env.DATABASE_URL ||= "pglite://memory";
process.env.NODE_ENV ||= "test";
process.env.MOCK_REDIS = "1";

import { pushSchema } from "drizzle-kit/api";
import { agentSandboxes } from "../../../db/schemas/agent-sandboxes";
import { organizations } from "../../../db/schemas/organizations";
import { userCharacters } from "../../../db/schemas/user-characters";
import { users } from "../../../db/schemas/users";

const PGLITE_TIMEOUT = 60_000;

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
  if (AMBIENT_DATABASE_URL !== "" && !AMBIENT_DATABASE_URL.startsWith("pglite")) {
    throw new Error("This suite requires an isolated PGlite DATABASE_URL");
  }
  ({ closeDatabaseConnectionsForTests: closeDb, dbWrite } = await import("../../../db/client"));
  ({ loadSandboxStatusesByIds } = await import("../docker-node-workloads"));
  const schema = { organizations, users, userCharacters, agentSandboxes };
  const { apply } = await pushSchema(schema as never, dbWrite as never);
  await apply();
  // This focused suite does not load the full restore schema. Keep the exact
  // columns read by docker-node-workloads so the physical-name ownership query
  // is still exercised through a real PostgreSQL-compatible engine.
  await dbWrite.execute(sql`
    CREATE TABLE agent_sandbox_replacement_attempts (
      id uuid PRIMARY KEY,
      agent_id uuid NOT NULL,
      restore_attempt_id uuid,
      state text NOT NULL,
      locator_container_name text,
      locator_node_id text
    )
  `);
}, PGLITE_TIMEOUT);

afterAll(async () => {
  if (closeDb) await closeDb();
});

describe("orphan reaper key resolution for warm-claimed containers", () => {
  test(
    "a pool key resolves to the live claimed row, on the row's node",
    async () => {
      const { orgId, userId } = await seedOwner();
      const poolId = crypto.randomUUID();
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
          container_name: `agent-${poolId}`,
        })
        .returning();

      const placements = await loadSandboxStatusesByIds([poolId]);

      const forPoolKey = placements.filter((p) => p.key === poolId);
      expect(forPoolKey.length).toBeGreaterThanOrEqual(1);
      expect(forPoolKey[0]?.status).toBe("running");
      expect(forPoolKey[0]?.nodeId).toBe("node-7");
      expect(placements.some((p) => p.key === row.id)).toBe(true);
    },
    PGLITE_TIMEOUT,
  );

  test(
    "the finalized steady state resolves by physical name after the source id is cleared",
    async () => {
      const { orgId, userId } = await seedOwner();
      const poolId = crypto.randomUUID();
      const [row] = await dbWrite
        .insert(agentSandboxes)
        .values({
          organization_id: orgId,
          user_id: userId,
          agent_name: uniq("finalized"),
          status: "running",
          execution_tier: "dedicated-always",
          node_id: "node-7",
          warm_claim_source_pool_id: null,
          container_name: `agent-${poolId}`,
        })
        .returning();

      const placements = await loadSandboxStatusesByIds([poolId]);

      const forPoolKey = placements.filter((p) => p.key === poolId);
      expect(forPoolKey.length).toBeGreaterThanOrEqual(1);
      expect(forPoolKey[0]?.status).toBe("running");
      expect(forPoolKey[0]?.nodeId).toBe("node-7");
      expect(placements.some((p) => p.key === row.id)).toBe(true);
    },
    PGLITE_TIMEOUT,
  );

  test(
    "an unclaimed pool id yields no placement",
    async () => {
      const placements = await loadSandboxStatusesByIds([crypto.randomUUID()]);
      expect(placements).toEqual([]);
    },
    PGLITE_TIMEOUT,
  );

  test(
    "a cleanup-fenced physical name protects only its own placement",
    async () => {
      const { orgId, userId } = await seedOwner();
      const rowId = crypto.randomUUID();
      const cleanupNameId = crypto.randomUUID();
      await dbWrite
        .insert(agentSandboxes)
        .values({
          id: rowId,
          organization_id: orgId,
          user_id: userId,
          agent_name: uniq("claimed"),
          status: "running",
          execution_tier: "dedicated-always",
          node_id: "node-7",
          container_name: `agent-${rowId}`,
          replacement_cleanup_sandbox_id: crypto.randomUUID(),
          replacement_cleanup_node_id: "node-8",
          replacement_cleanup_container_name: `agent-${cleanupNameId}`,
          replacement_cleanup_attempt_id: crypto.randomUUID(),
          replacement_cleanup_allocation_counted: true,
          replacement_cleanup_created_at: new Date(),
        })
        .returning();

      const placements = await loadSandboxStatusesByIds([cleanupNameId]);
      const forCleanupName = placements.filter((placement) => placement.key === cleanupNameId);
      expect(forCleanupName).toEqual([
        {
          key: cleanupNameId,
          status: "replacement_cleanup_owned",
          nodeId: "node-8",
        },
      ]);
    },
    PGLITE_TIMEOUT,
  );

  test(
    "an active exact restore attempt protects its physical name past the rowless grace",
    async () => {
      const agentId = crypto.randomUUID();
      const restoreAttemptId = crypto.randomUUID();
      const replacementAttemptId = crypto.randomUUID();
      const exactKey = `restore-${agentId}-${restoreAttemptId}`;
      const containerName = `agent-${exactKey}`;

      await dbWrite.execute(sql`
        INSERT INTO agent_sandbox_replacement_attempts (
          id,
          agent_id,
          restore_attempt_id,
          state,
          locator_container_name,
          locator_node_id
        ) VALUES (
          ${replacementAttemptId}::uuid,
          ${agentId}::uuid,
          ${restoreAttemptId}::uuid,
          'in_flight_unresolved',
          ${containerName},
          'node-exact'
        )
      `);

      expect(await loadSandboxStatusesByIds([exactKey])).toEqual([
        {
          key: exactKey,
          status: "replacement_attempt_owned",
          nodeId: "node-exact",
        },
      ]);

      await dbWrite.execute(sql`
        UPDATE agent_sandbox_replacement_attempts
        SET state = 'cleanup_proven'
        WHERE id = ${replacementAttemptId}::uuid
      `);
      expect(await loadSandboxStatusesByIds([exactKey])).toEqual([]);
    },
    PGLITE_TIMEOUT,
  );
});
