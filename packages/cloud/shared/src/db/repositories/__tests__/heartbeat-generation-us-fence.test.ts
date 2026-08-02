/**
 * Regression proof for the observed-running-generation CAS (#17249 fence
 * class): `agentSandboxesRepository.update(..., expectedRunningGeneration)`
 * once fenced `updated_at` — first with a plain eq() that silently missed for
 * µs-stored rows, then with a date_trunc('milliseconds') window (#17284) that
 * still admitted same-millisecond ABA writers. The fence is now the
 * database-owned `lifecycle_revision`, advanced by a BEFORE UPDATE trigger on
 * every write including raw `updated_at = NOW()` writers, so timestamp
 * precision no longer participates in ownership at all.
 *
 * The µs row is still seeded via an explicit SQL literal — PGlite's own NOW()
 * is ms-only — to prove the exact row shape that defeated the eq() fence now
 * passes the revision CAS, and that a genuinely moved generation still loses.
 *
 * Drives the REAL repository against in-process PGlite (real Drizzle schema
 * via pushSchema; the revision trigger comes from ensureAgentSandboxSchema),
 * NOTHING mocked. Fails LOUDLY if PGlite/pushSchema is unavailable (never
 * silently passes).
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

let seq = 0;
function uniq(p: string): string {
  seq += 1;
  return `${p}-${seq}-${Math.random().toString(36).slice(2, 8)}`;
}

beforeAll(async () => {
  if (!CAN_USE_ISOLATED_PGLITE) {
    pgliteReady = false;
    console.warn("[heartbeat-generation-us-fence.test] non-PGlite DATABASE_URL; failing.");
    return;
  }
  try {
    ({ closeDatabaseConnectionsForTests: closeDb, dbWrite } = await import("../../client"));
    ({ agentSandboxesRepository: repo } = await import("../agent-sandboxes"));
    const schema = { organizations, users, userCharacters, agentSandboxes };
    const { apply } = await pushSchema(schema as never, dbWrite as never);
    await apply();
    // Install the lifecycle_revision trigger BEFORE any raw writer runs —
    // pushSchema only creates columns, and the revision fence is meaningless
    // unless raw `updated_at = NOW()` writers advance the generation too.
    const { ensureAgentSandboxSchema } = await import("../../ensure-agent-sandbox-schema");
    await ensureAgentSandboxSchema();
  } catch (error) {
    pgliteReady = false;
    console.error(
      "[heartbeat-generation-us-fence.test] PGlite/pushSchema unavailable — failing.",
      error,
    );
  }
}, PGLITE_TIMEOUT);

afterAll(async () => {
  if (closeDb) await closeDb();
});

describe("observed-running-generation CAS vs microsecond timestamps", () => {
  async function seedRunningAgent(): Promise<{
    id: string;
    orgId: string;
  }> {
    const [org] = await dbWrite
      .insert(organizations)
      .values({ name: "Org", slug: uniq("org"), credit_balance: "1.000000" })
      .returning();
    const [user] = await dbWrite
      .insert(users)
      .values({ steward_user_id: uniq("steward"), organization_id: org.id })
      .returning();
    const [rec] = await dbWrite
      .insert(agentSandboxes)
      .values({
        organization_id: org.id,
        user_id: user.id,
        agent_name: uniq("hb"),
        status: "running",
        execution_tier: "dedicated-always",
        environment_revision: 3,
        sandbox_id: "agent-hb",
        node_id: "node-1",
        container_name: "agent-hb",
      })
      .returning();
    return { id: rec.id, orgId: org.id };
  }

  async function readLifecycleRevision(id: string): Promise<number> {
    const [row] = await dbWrite
      .select({ lifecycle_revision: agentSandboxes.lifecycle_revision })
      .from(agentSandboxes)
      .where(sql`${agentSandboxes.id} = ${id}`)
      .limit(1);
    if (!row) throw new Error("seeded agent row disappeared");
    return row.lifecycle_revision;
  }

  test(
    "the fence matches a µs-stored row when the observed revision is current",
    async () => {
      expect(pgliteReady).toBe(true);
      const { id, orgId } = await seedRunningAgent();
      // What prod's ~20 raw `updated_at = NOW()` writers store. The trigger
      // advances lifecycle_revision on this raw write too.
      await dbWrite.execute(
        sql`UPDATE ${agentSandboxes}
            SET updated_at = '2026-01-01 00:00:00.123456+00'::timestamptz
            WHERE id = ${id}`,
      );
      const observedRevision = await readLifecycleRevision(id);
      // The raw write must have advanced the generation past the insert value.
      expect(observedRevision).toBeGreaterThan(0);

      const updated = await repo.update(
        id,
        { last_heartbeat_at: new Date() },
        {
          organizationId: orgId,
          environmentRevision: 3,
          sandboxId: "agent-hb",
          nodeId: "node-1",
          containerName: "agent-hb",
          lifecycleRevision: observedRevision,
        },
      );

      // Pre-fix the eq(updated_at) fence missed on µs rows and the CAS write
      // was a silent no-op; the revision fence is precision-independent.
      expect(updated).toBeDefined();
      expect(updated?.last_heartbeat_at).toBeInstanceOf(Date);
      // The CAS write itself advanced the generation again.
      expect(updated?.lifecycle_revision).toBe(observedRevision + 1);
    },
    PGLITE_TIMEOUT,
  );

  test(
    "a genuinely moved generation still loses the fence",
    async () => {
      expect(pgliteReady).toBe(true);
      const { id, orgId } = await seedRunningAgent();
      const observedRevision = await readLifecycleRevision(id);
      // Another writer intervenes after the read: the trigger advances the
      // generation, so the earlier observed revision is now stale.
      await dbWrite.execute(
        sql`UPDATE ${agentSandboxes}
            SET updated_at = '2026-01-01 00:00:00.123456+00'::timestamptz
            WHERE id = ${id}`,
      );

      const updated = await repo.update(
        id,
        { last_heartbeat_at: new Date() },
        {
          organizationId: orgId,
          environmentRevision: 3,
          sandboxId: "agent-hb",
          nodeId: "node-1",
          containerName: "agent-hb",
          lifecycleRevision: observedRevision,
        },
      );

      expect(updated).toBeUndefined();
    },
    PGLITE_TIMEOUT,
  );
});
