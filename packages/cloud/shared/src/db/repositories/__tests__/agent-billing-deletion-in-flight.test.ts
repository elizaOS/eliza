/**
 * `listBillableSandboxes` was the only predicate in `agent-billing.ts` without a
 * `deletion_attempt_id IS NULL` guard; its six siblings all carry one (#22508).
 *
 * The charge path was never at risk: `recordHourlyBillingWithOptions` claims the
 * row with the same guard on its `SELECT ... FOR UPDATE`, so a deleting sandbox
 * is never debited, and everything gated on that claim (shutdown-warning mail,
 * the `credits.low` webhook) is equally unreachable. The exposure is the cron's
 * `shutdown_pending` branch, which reads the selected row directly and fires
 * the `credits.depleted` webhook plus `enqueueAgentSuspendOnce` without
 * consulting the deletion state.
 *
 * The window is narrow: both writers that set `deletion_attempt_id` set
 * `status='deletion_pending'` in the same UPDATE, and that status is already
 * excluded here. It opens when something writes `running` back over a row whose
 * deletion attempt is still set, a shape `agent_sandboxes_deletion_intent_pair_check`
 * permits. These tests pin the guard rather than that race.
 *
 * Harness mirrors `agent-billing-reactivation.test.ts`: drizzle-kit `pushSchema`
 * generates the EXACT DDL from the real schema objects and applies it to the same
 * in-process PGlite the repository queries through. Fails LOUDLY when a shared
 * non-PGlite Postgres is the ambient DATABASE_URL.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";

const AMBIENT_DATABASE_URL = process.env.DATABASE_URL ?? "";
const CAN_USE_ISOLATED_PGLITE =
  AMBIENT_DATABASE_URL === "" || AMBIENT_DATABASE_URL.startsWith("pglite");
process.env.DATABASE_URL ||= "pglite://memory";
process.env.NODE_ENV ||= "test";
process.env.MOCK_REDIS = "1";

import { pushSchema } from "drizzle-kit/api";
import { closeDatabaseConnectionsForTests, dbWrite } from "../../client";
import { agentSandboxes } from "../../schemas/agent-sandboxes";
import { organizations } from "../../schemas/organizations";
import { userCharacters } from "../../schemas/user-characters";
import { users } from "../../schemas/users";
import { agentBillingRepository } from "../agent-billing";

const PGLITE_TIMEOUT = 60_000;
let pgliteReady = true;

let seq = 0;
function uniq(prefix: string): string {
  seq += 1;
  return `${prefix}-${seq}-${Math.random().toString(36).slice(2, 8)}`;
}

async function seedOrgAndUser(): Promise<{
  organizationId: string;
  userId: string;
}> {
  const [org] = await dbWrite
    .insert(organizations)
    .values({ name: "Billing Org", slug: uniq("org") })
    .returning();
  const [user] = await dbWrite
    .insert(users)
    .values({ steward_user_id: uniq("steward"), organization_id: org.id })
    .returning();
  return { organizationId: org.id, userId: user.id };
}

/**
 * A dedicated sandbox that is due for billing. `last_billed_at` stays NULL so it
 * satisfies `billingDueCondition` — the state a real row is in when a deletion
 * attempt starts between two billing cycles.
 */
async function seedDueSandbox(
  organizationId: string,
  userId: string,
  overrides: {
    status: "running" | "stopped";
    deletionAttemptId: string | null;
  },
): Promise<string> {
  const [row] = await dbWrite
    .insert(agentSandboxes)
    .values({
      organization_id: organizationId,
      user_id: userId,
      agent_name: uniq("agent"),
      status: overrides.status,
      execution_tier: "dedicated-always",
      billing_status: "active",
      // The column defaults to now(), which would make the row not yet due.
      // A row that has never been billed is the state a fresh cycle sees.
      last_billed_at: null,
      deletion_attempt_id: overrides.deletionAttemptId,
      // `agent_sandboxes_deletion_intent_pair_check` requires deletion_attempt_id
      // and deletion_started_at to be set or cleared together, so an in-flight
      // deletion always carries both. Seeding only the id is rejected by the DB.
      deletion_started_at: overrides.deletionAttemptId
        ? new Date("2026-06-01T00:00:00.000Z")
        : null,
      // The stopped arm additionally requires a backup to be billable.
      last_backup_at: overrides.status === "stopped" ? new Date("2026-06-01T00:00:00.000Z") : null,
    })
    .returning();
  return row.id;
}

async function billable(): Promise<{ running: string[]; stopped: string[] }> {
  const now = new Date();
  const rebillCutoff = new Date(now.getTime() - 60 * 60 * 1000);
  const { runningSandboxes, stoppedWithBackups } =
    await agentBillingRepository.listBillableSandboxes(now, rebillCutoff);
  return {
    running: runningSandboxes.map((s) => s.id),
    stopped: stoppedWithBackups.map((s) => s.id),
  };
}

beforeAll(async () => {
  if (!CAN_USE_ISOLATED_PGLITE) {
    pgliteReady = false;
    console.warn(
      "[agent-billing-deletion-in-flight.test] DATABASE_URL is a non-PGlite Postgres (shared CI DB); this in-process-PGlite isolation suite fails — drizzle-kit pushSchema against a shared connection crashes the bun runner and would mutate the shared schema.",
    );
    return;
  }
  try {
    const schema = { organizations, users, userCharacters, agentSandboxes };
    const { apply } = await pushSchema(schema as never, dbWrite as never);
    await apply();
  } catch (error) {
    pgliteReady = false;
    console.error(
      "[agent-billing-deletion-in-flight.test] PGlite/pushSchema unavailable — cannot drive AgentBillingRepository against a real DB. Failing all cases.",
      error,
    );
  }
}, PGLITE_TIMEOUT);

beforeEach(async () => {
  expect(pgliteReady).toBe(true);
  await dbWrite.delete(agentSandboxes);
  await dbWrite.delete(userCharacters);
  await dbWrite.delete(users);
  await dbWrite.delete(organizations);
});

afterAll(async () => {
  await closeDatabaseConnectionsForTests();
});

describe("AgentBillingRepository.listBillableSandboxes deletion guard", () => {
  test("a running sandbox with a deletion attempt in flight is NOT billable", async () => {
    const { organizationId, userId } = await seedOrgAndUser();

    const deleting = await seedDueSandbox(organizationId, userId, {
      status: "running",
      deletionAttemptId: crypto.randomUUID(),
    });
    const live = await seedDueSandbox(organizationId, userId, {
      status: "running",
      deletionAttemptId: null,
    });

    const { running } = await billable();

    // Identical rows apart from the in-flight deletion. Without the guard both
    // are returned, and the cron's shutdown_pending branch then webhooks and
    // enqueues a suspend for a sandbox that is already being torn down.
    expect(running).toContain(live);
    expect(running).not.toContain(deleting);
  });

  test("a stopped-with-backup sandbox with a deletion attempt in flight is NOT billable", async () => {
    const { organizationId, userId } = await seedOrgAndUser();

    const deleting = await seedDueSandbox(organizationId, userId, {
      status: "stopped",
      deletionAttemptId: crypto.randomUUID(),
    });
    const live = await seedDueSandbox(organizationId, userId, {
      status: "stopped",
      deletionAttemptId: null,
    });

    const { stopped } = await billable();

    // The stopped arm bills for retained backups and has the same exposure.
    expect(stopped).toContain(live);
    expect(stopped).not.toContain(deleting);
  });
});
