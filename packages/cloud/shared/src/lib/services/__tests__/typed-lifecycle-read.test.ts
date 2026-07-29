/**
 * Regression proof for the typed lifecycle read (#17249 root-fix class).
 *
 * `getAgentForLifecycleMutation` was a raw `SELECT * FOR UPDATE`: raw drizzle
 * rows carry timestamptz as STRINGS despite the `AgentSandbox` type. Beyond
 * the delete crash (#17260), the consumer audit proved three more live
 * defects, of which the loudest: `agent_sleep` crashed on EVERY attempt at the
 * commit CAS (`current.updated_at?.getTime()` on a string). PGlite's raw rows
 * are strings exactly like production's, so this harness reproduces those
 * incidents faithfully.
 *
 * The typed read maps to real `Date`s — truncated to MILLISECONDS, which is
 * why the sleep/managed-launch SQL fences compare through
 * `date_trunc('milliseconds', column)`: stored values written by raw
 * `updated_at = NOW()` carry microseconds. The µs test below seeds via an
 * explicit SQL literal — PGlite's own NOW() is ms-only, so a NOW()-seeded row
 * could not reproduce the mismatch.
 *
 * Drives the REAL ElizaSandboxService.executeSleep against in-process PGlite
 * (real Drizzle schema via pushSchema), NOTHING mocked — the seeded rows carry
 * no container locators, so no provider call is ever reached. Fails LOUDLY if
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
import { sql } from "drizzle-orm";
import { agentSandboxBackups, agentSandboxes } from "../../../db/schemas/agent-sandboxes";
import { apiKeys } from "../../../db/schemas/api-keys";
import { generations } from "../../../db/schemas/generations";
import { jobs } from "../../../db/schemas/jobs";
import { organizations } from "../../../db/schemas/organizations";
import { usageRecords } from "../../../db/schemas/usage-records";
import { userCharacters } from "../../../db/schemas/user-characters";
import { users } from "../../../db/schemas/users";
import { hasReadyWarmClaimCredential } from "../warm-claim-key-push";

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

async function seedOwner(): Promise<{ orgId: string; userId: string }> {
  const [org] = await dbWrite
    .insert(organizations)
    .values({ name: "Org", slug: uniq("org"), credit_balance: "5.000000" })
    .returning();
  const [user] = await dbWrite
    .insert(users)
    .values({ steward_user_id: uniq("steward"), organization_id: org.id })
    .returning();
  return { orgId: org.id, userId: user.id };
}

/**
 * A running agent with no live container (locators NULL, no bridge): sleep
 * skips the live capture, goes through the backup gate, then the locked CAS —
 * the crash site under the raw read.
 */
async function seedRunningAgent(orgId: string, userId: string): Promise<string> {
  const [rec] = await dbWrite
    .insert(agentSandboxes)
    .values({
      organization_id: orgId,
      user_id: userId,
      agent_name: uniq("sleeper"),
      status: "running",
      execution_tier: "dedicated-always",
    })
    .returning();
  return rec.id;
}

/** A durable backup the wake-restore gate accepts without a live decrypt. */
async function seedFreshVerifiedBackup(sandboxRecordId: string): Promise<void> {
  await dbWrite.insert(agentSandboxBackups).values({
    sandbox_record_id: sandboxRecordId,
    snapshot_type: "pre-shutdown",
    state_data: { memories: [], config: {}, workspaceFiles: {} },
    size_bytes: 2,
    verification_status: "verified",
    verified_at: new Date(),
  });
}

beforeAll(async () => {
  if (!CAN_USE_ISOLATED_PGLITE) {
    pgliteReady = false;
    console.warn("[typed-lifecycle-read.test] non-PGlite DATABASE_URL; failing.");
    return;
  }
  try {
    ({ closeDatabaseConnectionsForTests: closeDb, dbWrite } = await import("../../../db/client"));
    ({ ElizaSandboxService } = await import("../eliza-sandbox"));
    const schema = {
      organizations,
      users,
      userCharacters,
      agentSandboxes,
      agentSandboxBackups,
      apiKeys,
      generations,
      usageRecords,
      jobs,
    };
    const { apply } = await pushSchema(schema as never, dbWrite as never);
    await apply();
  } catch (error) {
    pgliteReady = false;
    console.error("[typed-lifecycle-read.test] PGlite/pushSchema unavailable — failing.", error);
  }
}, PGLITE_TIMEOUT);

afterAll(async () => {
  if (closeDb) await closeDb();
});

describe("typed lifecycle read (#17249 root-fix class)", () => {
  test(
    "agent_sleep completes instead of crashing at the generation CAS",
    async () => {
      expect(pgliteReady).toBe(true);
      const { orgId, userId } = await seedOwner();
      const agentId = await seedRunningAgent(orgId, userId);
      await seedFreshVerifiedBackup(agentId);

      const result = await new ElizaSandboxService().executeSleep(agentId, orgId);

      // Pre-fix this threw `current.updated_at?.getTime is not a function`
      // at the commit CAS — agent_sleep was 100% broken in production.
      expect(result.success).toBe(true);
      const row = await dbWrite.query.agentSandboxes.findFirst({
        where: sql`${agentSandboxes.id} = ${agentId}`,
      });
      expect(row?.status).toBe("sleeping");
    },
    PGLITE_TIMEOUT,
  );

  test(
    "the sleep CAS survives a MICROSECOND-precision updated_at",
    async () => {
      expect(pgliteReady).toBe(true);
      const { orgId, userId } = await seedOwner();
      const agentId = await seedRunningAgent(orgId, userId);
      await seedFreshVerifiedBackup(agentId);
      // Explicit µs literal: PGlite's NOW() is ms-only, so only a literal can
      // reproduce what prod's raw `updated_at = NOW()` writers store. A typed
      // read truncates this to .123 — without date_trunc on the column the
      // CAS would miss and sleep would fail with a lost-generation error.
      await dbWrite.execute(
        sql`UPDATE ${agentSandboxes}
            SET updated_at = '2026-01-01 00:00:00.123456+00'::timestamptz
            WHERE id = ${agentId}`,
      );

      const result = await new ElizaSandboxService().executeSleep(agentId, orgId);

      expect(result.success).toBe(true);
      const row = await dbWrite.query.agentSandboxes.findFirst({
        where: sql`${agentSandboxes.id} = ${agentId}`,
      });
      expect(row?.status).toBe("sleeping");
    },
    PGLITE_TIMEOUT,
  );

  test(
    "the lifecycle read returns real Dates, so the warm-claim credential gate can answer",
    async () => {
      expect(pgliteReady).toBe(true);
      const { orgId, userId } = await seedOwner();
      const [rec] = await dbWrite
        .insert(agentSandboxes)
        .values({
          organization_id: orgId,
          user_id: userId,
          agent_name: uniq("claimed"),
          status: "running",
          execution_tier: "dedicated-always",
          claimed_at: new Date(),
          warm_claim_credential_state: "ready",
          warm_claim_key_fingerprint: "fp",
          warm_claim_attested_at: new Date(),
          warm_claim_attested_environment_revision: 0,
        })
        .returning();

      const svc = new ElizaSandboxService() as unknown as {
        getAgentForLifecycleMutation: (
          tx: unknown,
          agentId: string,
          orgId: string,
        ) => Promise<Record<string, unknown> | undefined>;
      };
      const row = await dbWrite.transaction(async (tx) =>
        svc.getAgentForLifecycleMutation(tx, rec.id, orgId),
      );

      expect(row?.updated_at).toBeInstanceOf(Date);
      expect(row?.claimed_at).toBeInstanceOf(Date);
      expect(row?.warm_claim_attested_at).toBeInstanceOf(Date);
      // The consequence that matters: the in-transaction upgrade/downgrade CAS
      // consults this gate, whose contract requires a REAL Date. On the raw
      // read it returned false for every warm-claimed agent, so their
      // upgrades could never commit.
      expect(
        hasReadyWarmClaimCredential(row as Parameters<typeof hasReadyWarmClaimCredential>[0]),
      ).toBe(true);
    },
    PGLITE_TIMEOUT,
  );
});
