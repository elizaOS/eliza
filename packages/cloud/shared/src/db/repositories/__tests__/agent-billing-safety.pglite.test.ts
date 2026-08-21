/**
 * Exercises failed/deleted agent billing exclusion and the final debit claim against real PGlite.
 *
 * The repository is the billing authority: replica/list results may become stale before settlement,
 * so both discovery and the row lock must reject workloads that no longer accrue charges.
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
import { type AgentBillingStatus, agentSandboxes } from "../../schemas/agent-sandboxes";
import { agentBillingRunItems, agentBillingRuns } from "../../schemas/compute-billing";
import { organizations } from "../../schemas/organizations";
import { userCharacters } from "../../schemas/user-characters";
import { users } from "../../schemas/users";
import { agentBillingRepository } from "../agent-billing";
import { agentBillingRunRepository } from "../agent-billing-runs";

const PGLITE_TIMEOUT = 60_000;
const BILLING_NOW = new Date("2026-08-20T12:00:00.000Z");
let pgliteReady = true;
let sequence = 0;

function unique(prefix: string): string {
  sequence += 1;
  return `${prefix}-${sequence}-${Math.random().toString(36).slice(2, 8)}`;
}

async function seedOrganizationAndUser(): Promise<{
  organizationId: string;
  userId: string;
}> {
  const [organization] = await dbWrite
    .insert(organizations)
    .values({ name: "Billing Safety Org", slug: unique("org"), credit_balance: "10" })
    .returning();
  const [user] = await dbWrite
    .insert(users)
    .values({ steward_user_id: unique("steward"), organization_id: organization.id })
    .returning();
  return { organizationId: organization.id, userId: user.id };
}

async function seedSandbox(
  organizationId: string,
  userId: string,
  values: {
    status?: "running" | "stopped" | "error";
    billingStatus?: AgentBillingStatus;
    deletedAt?: Date | null;
    lastBackupAt?: Date | null;
  } = {},
): Promise<string> {
  const [sandbox] = await dbWrite
    .insert(agentSandboxes)
    .values({
      organization_id: organizationId,
      user_id: userId,
      agent_name: unique("agent"),
      status: values.status ?? "running",
      execution_tier: "dedicated-always",
      billing_status: values.billingStatus ?? "active",
      deleted_at: values.deletedAt ?? null,
      last_backup_at: values.lastBackupAt ?? null,
      created_at: new Date("2026-08-20T10:00:00.000Z"),
      last_billed_at: new Date("2026-08-20T10:00:00.000Z"),
      shutdown_warning_sent_at: new Date("2026-08-20T10:30:00.000Z"),
      scheduled_shutdown_at: new Date("2026-08-20T11:30:00.000Z"),
    })
    .returning();
  return sandbox.id;
}

async function claimBillingRun(): Promise<{ runId: string; leaseToken: string }> {
  const claim = await agentBillingRunRepository.startOrLoad({
    invocationKey: `manual:billing-safety:${crypto.randomUUID()}`,
    triggerKind: "manual",
    schedule: null,
    scheduledAt: null,
    leaseDurationMs: 5 * 60_000,
  });
  if (!claim.leaseToken) throw new Error("Expected billing run lease");
  return { runId: claim.run.id, leaseToken: claim.leaseToken };
}

async function row(id: string) {
  const [sandbox] = await dbWrite.select().from(agentSandboxes).where(eq(agentSandboxes.id, id));
  return sandbox;
}

beforeAll(async () => {
  if (!CAN_USE_ISOLATED_PGLITE) {
    pgliteReady = false;
    return;
  }
  try {
    const schema = {
      organizations,
      users,
      userCharacters,
      agentSandboxes,
      agentBillingRuns,
      agentBillingRunItems,
    };
    const { apply } = await pushSchema(schema as never, dbWrite as never);
    await apply();
  } catch (error) {
    pgliteReady = false;
    console.error("[agent-billing-safety] real PGlite schema setup failed", error);
  }
}, PGLITE_TIMEOUT);

beforeEach(async () => {
  expect(pgliteReady).toBe(true);
  await dbWrite.delete(agentBillingRunItems);
  await dbWrite.delete(agentBillingRuns);
  await dbWrite.delete(agentSandboxes);
  await dbWrite.delete(userCharacters);
  await dbWrite.delete(users);
  await dbWrite.delete(organizations);
});

afterAll(async () => {
  await closeDatabaseConnectionsForTests();
});

describe("AgentBillingRepository billable-state authority", () => {
  test("the due-set excludes a soft-deleted running sandbox", async () => {
    const { organizationId, userId } = await seedOrganizationAndUser();
    const activeId = await seedSandbox(organizationId, userId);
    const deletedId = await seedSandbox(organizationId, userId, {
      deletedAt: new Date("2026-08-20T11:00:00.000Z"),
    });

    const due = await agentBillingRepository.listBillableSandboxes(
      BILLING_NOW,
      new Date("2026-08-20T11:00:00.000Z"),
    );

    expect(due.runningSandboxes.map((sandbox) => sandbox.id)).toEqual([activeId]);
    expect(due.runningSandboxes.map((sandbox) => sandbox.id)).not.toContain(deletedId);
  });

  test("hourly maintenance suspends every failed active clock but preserves exempt", async () => {
    const { organizationId, userId } = await seedOrganizationAndUser();
    const activeId = await seedSandbox(organizationId, userId, { status: "error" });
    const warningId = await seedSandbox(organizationId, userId, {
      status: "error",
      billingStatus: "warning",
    });
    const pendingId = await seedSandbox(organizationId, userId, {
      status: "error",
      billingStatus: "shutdown_pending",
    });
    const exemptId = await seedSandbox(organizationId, userId, {
      status: "error",
      billingStatus: "exempt",
    });
    const runningId = await seedSandbox(organizationId, userId);

    expect(await agentBillingRepository.suspendFailedSandboxBilling(BILLING_NOW)).toBe(3);

    for (const id of [activeId, warningId, pendingId]) {
      expect(await row(id)).toMatchObject({
        billing_status: "suspended",
        shutdown_warning_sent_at: null,
        scheduled_shutdown_at: null,
      });
    }
    expect((await row(exemptId)).billing_status).toBe("exempt");
    expect((await row(runningId)).billing_status).toBe("active");
  });

  test("a soft delete after discovery loses the final debit claim", async () => {
    const { organizationId, userId } = await seedOrganizationAndUser();
    const sandboxId = await seedSandbox(organizationId, userId);
    const discovered = await agentBillingRepository.listBillableSandboxes(
      BILLING_NOW,
      new Date("2026-08-20T11:00:00.000Z"),
    );
    expect(discovered.runningSandboxes.map((sandbox) => sandbox.id)).toContain(sandboxId);

    await dbWrite
      .update(agentSandboxes)
      .set({ deleted_at: new Date("2026-08-20T11:59:00.000Z") })
      .where(eq(agentSandboxes.id, sandboxId));

    const outcome = await agentBillingRepository.recordHourlyBilling({
      ...(await claimBillingRun()),
      sandboxId,
      organizationId,
      userId,
      agentName: "deleted-race",
      hourlyRate: 0.01,
      billingDescription: "must not debit",
      lowCreditWarningAmount: 1,
      now: BILLING_NOW,
    });

    expect(outcome).toEqual({ status: "already_billed_recently" });
    expect((await row(sandboxId)).last_billed_at).toEqual(new Date("2026-08-20T10:00:00.000Z"));
  });

  test("a stopped sandbox without a backup loses the final debit claim", async () => {
    const { organizationId, userId } = await seedOrganizationAndUser();
    const sandboxId = await seedSandbox(organizationId, userId, {
      status: "stopped",
      lastBackupAt: null,
    });

    const outcome = await agentBillingRepository.recordHourlyBilling({
      ...(await claimBillingRun()),
      sandboxId,
      organizationId,
      userId,
      agentName: "no-backup",
      hourlyRate: 0.01,
      billingDescription: "must not debit",
      lowCreditWarningAmount: 1,
      now: BILLING_NOW,
    });

    expect(outcome).toEqual({ status: "already_billed_recently" });
    expect((await row(sandboxId)).last_billed_at).toEqual(new Date("2026-08-20T10:00:00.000Z"));
  });
});
