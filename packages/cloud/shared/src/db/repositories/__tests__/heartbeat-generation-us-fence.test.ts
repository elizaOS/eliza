/**
 * Regression proof for the observed-running-generation CAS (#17249 fence
 * class): `agentSandboxesRepository.update(..., expectedRunningGeneration)`
 * fenced `updated_at` with a plain eq() — but the stored value may carry
 * MICROSECONDS (raw `updated_at = NOW()` writers) while the expected value
 * came through a typed read, which truncates to milliseconds. The fence
 * silently missed for every µs-stored row, so the heartbeat's observed
 * generation was never persisted after such a write. Same remedy as the
 * sleep and managed-launch CASes: date_trunc('milliseconds', column).
 *
 * The µs row is seeded via an explicit SQL literal — PGlite's own NOW() is
 * ms-only, so a NOW()-seeded row cannot reproduce the mismatch and the
 * fail-on-base property would be false.
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

  test(
    "the fence matches a row whose updated_at carries MICROSECONDS",
    async () => {
      expect(pgliteReady).toBe(true);
      const { id, orgId } = await seedRunningAgent();
      // What prod's ~20 raw `updated_at = NOW()` writers store.
      await dbWrite.execute(
        sql`UPDATE ${agentSandboxes}
            SET updated_at = '2026-01-01 00:00:00.123456+00'::timestamptz
            WHERE id = ${id}`,
      );
      // What the service observed through its typed read: ms-truncated.
      const observed = new Date("2026-01-01T00:00:00.123Z");

      const updated = await repo.update(
        id,
        { last_heartbeat_at: new Date() },
        {
          organizationId: orgId,
          environmentRevision: 3,
          sandboxId: "agent-hb",
          nodeId: "node-1",
          containerName: "agent-hb",
          updatedAt: observed,
        },
      );

      // Pre-fix the eq() fence missed and the CAS write was a silent no-op.
      expect(updated).toBeDefined();
      expect(updated?.last_heartbeat_at).toBeInstanceOf(Date);
    },
    PGLITE_TIMEOUT,
  );

  test(
    "a genuinely moved generation still loses the fence",
    async () => {
      expect(pgliteReady).toBe(true);
      const { id, orgId } = await seedRunningAgent();
      await dbWrite.execute(
        sql`UPDATE ${agentSandboxes}
            SET updated_at = '2026-01-01 00:00:00.123456+00'::timestamptz
            WHERE id = ${id}`,
      );
      // Observed a DIFFERENT millisecond: the row moved since the read.
      const staleObserved = new Date("2026-01-01T00:00:00.122Z");

      const updated = await repo.update(
        id,
        { last_heartbeat_at: new Date() },
        {
          organizationId: orgId,
          environmentRevision: 3,
          sandboxId: "agent-hb",
          nodeId: "node-1",
          containerName: "agent-hb",
          updatedAt: staleObserved,
        },
      );

      expect(updated).toBeUndefined();
    },
    PGLITE_TIMEOUT,
  );
});
