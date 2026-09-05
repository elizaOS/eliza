/**
 * Deletion intent is not provider absence. These real-PGlite cases prove an
 * owned workload remains due through deletion_pending/deletion_failed and only
 * leaves billing when the provider-confirmed delete removes its row.
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
import { eq } from "drizzle-orm";
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
    status: "running" | "stopped" | "deletion_pending" | "deletion_failed";
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
  test("deletion-pending and deletion-failed provider workloads remain billable", async () => {
    const { organizationId, userId } = await seedOrgAndUser();

    const deleting = await seedDueSandbox(organizationId, userId, {
      status: "deletion_pending",
      deletionAttemptId: crypto.randomUUID(),
    });
    const failed = await seedDueSandbox(organizationId, userId, {
      status: "deletion_failed",
      deletionAttemptId: crypto.randomUUID(),
    });
    const live = await seedDueSandbox(organizationId, userId, {
      status: "running",
      deletionAttemptId: null,
    });

    const { running } = await billable();

    // Provider-backed delete attempts still accrue compute until absence is
    // confirmed; a user-owned live row remains the control case.
    expect(running).toContain(live);
    expect(running).toContain(deleting);
    expect(running).toContain(failed);
  });

  test("provider-confirmed row removal is the billing terminal condition", async () => {
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

    // Retained provider/storage state remains billable until terminal removal.
    expect(stopped).toContain(live);
    expect(stopped).toContain(deleting);
    await dbWrite.delete(agentSandboxes).where(eq(agentSandboxes.id, deleting));
    expect((await billable()).stopped).not.toContain(deleting);
  });
});
