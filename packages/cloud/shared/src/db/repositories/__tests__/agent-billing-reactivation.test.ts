/**
 * Free-compute leak regression at the data layer (#10554, finding 2).
 *
 * When a credit-suspended agent is topped up and resumed, `provision()` calls
 * `agentBillingRepository.reactivateSandboxBillingAfterFunding`. If that did not
 * flip `billing_status` back to a billable value, the agent would run
 * (status='running') permanently EXCLUDED from `listBillableSandboxes` — free
 * dedicated compute forever. This suite proves the writer actually re-enters the
 * billable set, against the REAL Drizzle schema on an in-process PGlite.
 *
 * Harness mirrors `repositories/__tests__/apps.test.ts`: drizzle-kit `pushSchema`
 * generates the EXACT DDL from the real schema objects and applies it to the same
 * PGlite connection the repository queries through. Fails LOUDLY (never
 * silently passes) when a shared non-PGlite Postgres is the ambient DATABASE_URL.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";

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

async function seedOrgAndUser(): Promise<{ organizationId: string; userId: string }> {
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

/** Insert a dedicated, running sandbox and return its id. */
async function seedSandbox(
  organizationId: string,
  userId: string,
  billingStatus: "suspended" | "exempt" | "active",
): Promise<string> {
  const [row] = await dbWrite
    .insert(agentSandboxes)
    .values({
      organization_id: organizationId,
      user_id: userId,
      agent_name: uniq("agent"),
      status: "running",
      execution_tier: "dedicated-always",
      billing_status: billingStatus,
      // A suspended/shutdown row may carry a pending-shutdown schedule; reactivate
      // must clear it on the way back to billable.
      shutdown_warning_sent_at: new Date("2026-06-01T00:00:00.000Z"),
      scheduled_shutdown_at: new Date("2026-06-02T00:00:00.000Z"),
    })
    .returning();
  return row.id;
}

async function billingStatusOf(id: string): Promise<string> {
  const [row] = await dbWrite
    .select({ billing_status: agentSandboxes.billing_status })
    .from(agentSandboxes)
    .where(eq(agentSandboxes.id, id));
  return row.billing_status;
}

async function billableIds(): Promise<string[]> {
  const now = new Date();
  const rebillCutoff = new Date(now.getTime() - 60 * 60 * 1000);
  const { runningSandboxes } = await agentBillingRepository.listBillableSandboxes(
    now,
    rebillCutoff,
  );
  return runningSandboxes.map((s) => s.id);
}

beforeAll(async () => {
  if (!CAN_USE_ISOLATED_PGLITE) {
    pgliteReady = false;
    console.warn(
      "[agent-billing-reactivation.test] DATABASE_URL is a non-PGlite Postgres (shared CI DB); this in-process-PGlite isolation suite fails — drizzle-kit pushSchema against a shared connection crashes the bun runner and would mutate the shared schema.",
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
      "[agent-billing-reactivation.test] PGlite/pushSchema unavailable — cannot drive AgentBillingRepository against a real DB. Failing all cases.",
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

describe("AgentBillingRepository.reactivateSandboxBillingAfterFunding", () => {
  test("credit suspension commits only against the exact stopped lifecycle", async () => {
    expect(pgliteReady).toBe(true);
    const { organizationId, userId } = await seedOrgAndUser();
    const sandboxId = await seedSandbox(organizationId, userId, "active");
    const scheduledShutdownAt = new Date("2026-07-23T15:00:00.000Z");
    await dbWrite
      .update(agentSandboxes)
      .set({
        status: "stopped",
        billing_status: "shutdown_pending",
        scheduled_shutdown_at: scheduledShutdownAt,
      })
      .where(eq(agentSandboxes.id, sandboxId));
    const [stopped] = await dbWrite
      .select({ lifecycle_revision: agentSandboxes.lifecycle_revision })
      .from(agentSandboxes)
      .where(eq(agentSandboxes.id, sandboxId));

    expect(
      await agentBillingRepository.suspendSandboxForInsufficientCredits({
        sandboxId,
        expectedLifecycleRevision: stopped.lifecycle_revision,
        expectedScheduledShutdownAt: scheduledShutdownAt,
        now: new Date("2026-07-23T15:01:00.000Z"),
      }),
    ).toBe(true);

    const [row] = await dbWrite
      .select({
        status: agentSandboxes.status,
        billing_status: agentSandboxes.billing_status,
        shutdown_warning_sent_at: agentSandboxes.shutdown_warning_sent_at,
        scheduled_shutdown_at: agentSandboxes.scheduled_shutdown_at,
      })
      .from(agentSandboxes)
      .where(eq(agentSandboxes.id, sandboxId));
    expect(row).toEqual({
      status: "stopped",
      billing_status: "suspended",
      shutdown_warning_sent_at: null,
      scheduled_shutdown_at: null,
    });
  });

  test("credit suspension preserves a placement published after shutdown", async () => {
    expect(pgliteReady).toBe(true);
    const { organizationId, userId } = await seedOrgAndUser();
    const sandboxId = await seedSandbox(organizationId, userId, "active");
    const scheduledShutdownAt = new Date("2026-07-23T15:00:00.000Z");
    await dbWrite
      .update(agentSandboxes)
      .set({
        status: "stopped",
        billing_status: "shutdown_pending",
        scheduled_shutdown_at: scheduledShutdownAt,
      })
      .where(eq(agentSandboxes.id, sandboxId));
    const [stopped] = await dbWrite
      .select({ lifecycle_revision: agentSandboxes.lifecycle_revision })
      .from(agentSandboxes)
      .where(eq(agentSandboxes.id, sandboxId));

    await dbWrite
      .update(agentSandboxes)
      .set({
        status: "running",
        sandbox_id: "concurrent-resume",
        bridge_url: "https://concurrent-resume.example",
        health_url: "https://concurrent-resume.example/health",
        node_id: "node-concurrent-resume",
        container_name: "concurrent-resume",
        headscale_ip: "100.64.0.3",
        bridge_port: 2138,
        web_ui_port: 31337,
      })
      .where(eq(agentSandboxes.id, sandboxId));

    expect(
      await agentBillingRepository.suspendSandboxForInsufficientCredits({
        sandboxId,
        expectedLifecycleRevision: stopped.lifecycle_revision,
        expectedScheduledShutdownAt: scheduledShutdownAt,
        now: new Date("2026-07-23T15:01:00.000Z"),
      }),
    ).toBe(false);

    const [row] = await dbWrite
      .select({
        status: agentSandboxes.status,
        billing_status: agentSandboxes.billing_status,
        sandbox_id: agentSandboxes.sandbox_id,
        node_id: agentSandboxes.node_id,
        container_name: agentSandboxes.container_name,
      })
      .from(agentSandboxes)
      .where(eq(agentSandboxes.id, sandboxId));
    expect(row).toEqual({
      status: "running",
      billing_status: "shutdown_pending",
      sandbox_id: "concurrent-resume",
      node_id: "node-concurrent-resume",
      container_name: "concurrent-resume",
    });
  });

  test("a suspended running agent is EXCLUDED from the billable set until reactivated", async () => {
    expect(pgliteReady).toBe(true);
    const { organizationId, userId } = await seedOrgAndUser();
    const sandboxId = await seedSandbox(organizationId, userId, "suspended");

    // Free-compute leak: suspended → not billed.
    expect(await billingStatusOf(sandboxId)).toBe("suspended");
    expect(await billableIds()).not.toContain(sandboxId);

    await agentBillingRepository.reactivateSandboxBillingAfterFunding(sandboxId, new Date());

    // Leak closed: active + back in the billable set, with the pending shutdown cleared.
    expect(await billingStatusOf(sandboxId)).toBe("active");
    expect(await billableIds()).toContain(sandboxId);

    const [row] = await dbWrite
      .select({
        shutdown_warning_sent_at: agentSandboxes.shutdown_warning_sent_at,
        scheduled_shutdown_at: agentSandboxes.scheduled_shutdown_at,
      })
      .from(agentSandboxes)
      .where(eq(agentSandboxes.id, sandboxId));
    expect(row.shutdown_warning_sent_at).toBeNull();
    expect(row.scheduled_shutdown_at).toBeNull();
  });

  test("an EXEMPT agent is never forced into billing by reactivation", async () => {
    expect(pgliteReady).toBe(true);
    const { organizationId, userId } = await seedOrgAndUser();
    const sandboxId = await seedSandbox(organizationId, userId, "exempt");

    await agentBillingRepository.reactivateSandboxBillingAfterFunding(sandboxId, new Date());

    // The `ne(billing_status, 'exempt')` guard means the row is untouched, and
    // exempt is not a billable status, so it stays out of the billable set.
    expect(await billingStatusOf(sandboxId)).toBe("exempt");
    expect(await billableIds()).not.toContain(sandboxId);
  });

  test("billing maintenance cannot rewrite status or locators after deletion owns the row", async () => {
    expect(pgliteReady).toBe(true);
    const { organizationId, userId } = await seedOrgAndUser();
    const sandboxId = await seedSandbox(organizationId, userId, "suspended");
    const deletionStartedAt = new Date("2026-07-23T14:00:00.000Z");
    await dbWrite
      .update(agentSandboxes)
      .set({
        status: "deletion_pending",
        deletion_attempt_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        deletion_started_at: deletionStartedAt,
        sandbox_id: "sandbox-owned-by-delete",
        bridge_url: "https://delete-owned.example",
        health_url: "https://delete-owned.example/health",
      })
      .where(eq(agentSandboxes.id, sandboxId));

    await agentBillingRepository.scheduleShutdownWarning(
      sandboxId,
      new Date("2026-07-23T14:01:00.000Z"),
      new Date("2026-07-23T15:00:00.000Z"),
    );
    await agentBillingRepository.reactivateSandboxBillingAfterFunding(
      sandboxId,
      new Date("2026-07-23T14:02:00.000Z"),
    );
    const [deletionOwned] = await dbWrite
      .select({ lifecycle_revision: agentSandboxes.lifecycle_revision })
      .from(agentSandboxes)
      .where(eq(agentSandboxes.id, sandboxId));
    expect(
      await agentBillingRepository.suspendSandboxForInsufficientCredits({
        sandboxId,
        expectedLifecycleRevision: deletionOwned.lifecycle_revision,
        expectedScheduledShutdownAt: new Date("2026-06-02T00:00:00.000Z"),
        now: new Date("2026-07-23T14:03:00.000Z"),
      }),
    ).toBe(false);

    const [row] = await dbWrite
      .select()
      .from(agentSandboxes)
      .where(eq(agentSandboxes.id, sandboxId));
    expect(row).toMatchObject({
      status: "deletion_pending",
      deletion_attempt_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      deletion_started_at: deletionStartedAt,
      sandbox_id: "sandbox-owned-by-delete",
      bridge_url: "https://delete-owned.example",
      health_url: "https://delete-owned.example/health",
      billing_status: "suspended",
    });
    expect(row.shutdown_warning_sent_at).toEqual(new Date("2026-06-01T00:00:00.000Z"));
    expect(row.scheduled_shutdown_at).toEqual(new Date("2026-06-02T00:00:00.000Z"));
  });
});
