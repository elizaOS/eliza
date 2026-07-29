/**
 * Regression proof for #17253 §5: a crash between `provision()` committing
 * `running` and `markPoolEntryReady` strands a warm-pool row at
 * `unclaimed / running / pool_ready_at NULL` — refused by claimWarmContainer,
 * skipped by drain, invisible to the stuck-finder, yet COUNTED as ready
 * capacity, permanently suppressing one slot of replenishment while the
 * container bills forever.
 *
 * Two fixes pinned here: the ready count requires the readiness stamp, and
 * findStuckPoolProvisioning now matches the stranded shape so the reap path
 * can reclaim it once wired.
 *
 * Drives the REAL repository against in-process PGlite (real Drizzle schema
 * via pushSchema), NOTHING mocked. Fails LOUDLY if PGlite/pushSchema is
 * unavailable (never silently passes).
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";

const AMBIENT_DATABASE_URL = process.env.DATABASE_URL ?? "";
const CAN_USE_ISOLATED_PGLITE =
  AMBIENT_DATABASE_URL === "" || AMBIENT_DATABASE_URL.startsWith("pglite");
process.env.DATABASE_URL ||= "pglite://memory";
process.env.NODE_ENV ||= "test";
process.env.MOCK_REDIS = "1";

import { pushSchema } from "drizzle-kit/api";
import { sql } from "drizzle-orm";
import { agentSandboxes } from "../../schemas/agent-sandboxes";
import { organizations } from "../../schemas/organizations";
import { userCharacters } from "../../schemas/user-characters";
import { users } from "../../schemas/users";

const PGLITE_TIMEOUT = 60_000;

let pgliteReady = true;
let dbWrite: typeof import("../../client").dbWrite;
let closeDb: typeof import("../../client").closeDatabaseConnectionsForTests | undefined;
let repo: typeof import("../agent-sandboxes").agentSandboxesRepository;
let poolOrgId: string;
let poolUserId: string;

beforeAll(async () => {
  if (!CAN_USE_ISOLATED_PGLITE) {
    pgliteReady = false;
    console.warn("[warm-pool-stranded-readiness.test] non-PGlite DATABASE_URL; failing.");
    return;
  }
  try {
    ({ closeDatabaseConnectionsForTests: closeDb, dbWrite } = await import("../../client"));
    ({ agentSandboxesRepository: repo } = await import("../agent-sandboxes"));
    const schema = { organizations, users, userCharacters, agentSandboxes };
    const { apply } = await pushSchema(schema as never, dbWrite as never);
    await apply();
    const [org] = await dbWrite
      .insert(organizations)
      .values({
        name: "Pool",
        slug: "warm-pool-stranded",
        credit_balance: "0.000000",
      })
      .returning();
    poolOrgId = org.id;
    const [user] = await dbWrite
      .insert(users)
      .values({ steward_user_id: "steward-warm-pool-stranded", organization_id: org.id })
      .returning();
    poolUserId = user.id;
  } catch (error) {
    pgliteReady = false;
    console.error(
      "[warm-pool-stranded-readiness.test] PGlite/pushSchema unavailable — failing.",
      error,
    );
  }
}, PGLITE_TIMEOUT);

afterAll(async () => {
  if (closeDb) await closeDb();
});

async function seedPoolRow(params: {
  status: "running" | "provisioning";
  poolReadyAt: Date | null;
  updatedAt: string;
}): Promise<string> {
  const [rec] = await dbWrite
    .insert(agentSandboxes)
    .values({
      organization_id: poolOrgId,
      user_id: poolUserId,
      agent_name: `pool-${Math.random().toString(36).slice(2, 10)}`,
      status: params.status,
      execution_tier: "dedicated-always",
      pool_status: "unclaimed",
      pool_ready_at: params.poolReadyAt,
      node_id: "node-1",
    })
    .returning();
  await dbWrite.execute(
    sql`UPDATE ${agentSandboxes}
        SET updated_at = ${params.updatedAt}::timestamptz
        WHERE id = ${rec.id}`,
  );
  return rec.id;
}

describe("warm-pool stranded readiness (#17253 §5)", () => {
  test(
    "a running row WITHOUT the readiness stamp does not count as ready capacity",
    async () => {
      expect(pgliteReady).toBe(true);
      await dbWrite.execute(sql`DELETE FROM ${agentSandboxes}`);
      // The crash-window shape: provision committed running, readiness never
      // stamped.
      await seedPoolRow({
        status: "running",
        poolReadyAt: null,
        updatedAt: "2026-07-01 00:00:00+00",
      });
      // A genuinely ready sibling.
      await seedPoolRow({
        status: "running",
        poolReadyAt: new Date(),
        updatedAt: "2026-07-01 00:00:00+00",
      });

      const counts = await repo.countAllPoolEntries();

      // Pre-fix: ready === 2 and the replenisher believed the pool was full.
      expect(counts.ready).toBe(1);
    },
    PGLITE_TIMEOUT,
  );

  test(
    "the stuck-finder now surfaces the stranded running+NULL shape",
    async () => {
      expect(pgliteReady).toBe(true);
      await dbWrite.execute(sql`DELETE FROM ${agentSandboxes}`);
      const strandedId = await seedPoolRow({
        status: "running",
        poolReadyAt: null,
        updatedAt: "2026-07-01 00:00:00+00",
      });
      // A healthy ready row and a FRESH stranded row must both stay out.
      await seedPoolRow({
        status: "running",
        poolReadyAt: new Date(),
        updatedAt: "2026-07-01 00:00:00+00",
      });
      const freshId = await seedPoolRow({
        status: "running",
        poolReadyAt: null,
        updatedAt: new Date().toISOString(),
      });

      const stuck = await repo.findStuckPoolProvisioning(60 * 60 * 1000);
      const ids = stuck.map((r) => r.id);

      // Pre-fix: the stranded shape matched NOTHING — invisible to the sweep.
      expect(ids).toContain(strandedId);
      expect(ids).not.toContain(freshId);
      expect(ids).toHaveLength(1);
    },
    PGLITE_TIMEOUT,
  );
});
