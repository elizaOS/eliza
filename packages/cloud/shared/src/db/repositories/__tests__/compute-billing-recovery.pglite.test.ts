/**
 * Exercises elapsed compute charging, tenant identity, and retry atomicity
 * against the real Drizzle statements on an isolated PGlite database.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { pushSchema } from "drizzle-kit/api";
import { eq, sql } from "drizzle-orm";

process.env.DATABASE_URL = "pglite://memory";
process.env.TEST_DATABASE_URL = "pglite://memory";
process.env.NODE_ENV ||= "test";

import {
  dispatchContainerStopJob,
  enqueueContainerStopOnce,
  listRecoverableContainerStopIntents,
} from "../../../lib/services/container-stop-job-service";
import { getHetznerContainersClient } from "../../../lib/services/containers/hetzner-client/client";
import { closeDatabaseConnectionsForTests, dbWrite } from "../../client";
import { agentSandboxes } from "../../schemas/agent-sandboxes";
import { apiKeys } from "../../schemas/api-keys";
import {
  agentBillingRecords,
  agentBillingRunItems,
  agentBillingRuns,
} from "../../schemas/compute-billing";
import { computeBillingRateSegments } from "../../schemas/compute-billing-rate-segments";
import { containerComputeStopIntents } from "../../schemas/compute-stop-intents";
import { containerBillingRecords, containers } from "../../schemas/containers";
import { creditTransactions } from "../../schemas/credit-transactions";
import { jobs } from "../../schemas/jobs";
import { organizations } from "../../schemas/organizations";
import {
  earningsSourceEnum,
  ledgerEntryTypeEnum,
  redeemableEarnings,
  redeemableEarningsLedger,
} from "../../schemas/redeemable-earnings";
import { userCharacters } from "../../schemas/user-characters";
import { users } from "../../schemas/users";
import { agentBillingRepository } from "../agent-billing";
import { agentBillingRunRepository } from "../agent-billing-runs";
import { containersRepository } from "../containers";

const PGLITE_TIMEOUT = 60_000;
let ready = true;

beforeAll(async () => {
  try {
    const schema = {
      organizations,
      users,
      userCharacters,
      agentSandboxes,
      apiKeys,
      creditTransactions,
      agentBillingRecords,
      agentBillingRuns,
      agentBillingRunItems,
      computeBillingRateSegments,
      containers,
      containerBillingRecords,
      earningsSourceEnum,
      ledgerEntryTypeEnum,
      redeemableEarnings,
      redeemableEarningsLedger,
    };
    const { apply } = await pushSchema(schema as never, dbWrite as never);
    await apply();
    await dbWrite.execute(
      sql.raw(`CREATE TABLE jobs (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      type text NOT NULL,
      status text NOT NULL DEFAULT 'pending',
      data jsonb NOT NULL,
      data_storage text NOT NULL DEFAULT 'inline',
      data_key text,
      agent_id text,
      character_id text,
      result jsonb,
      result_storage text NOT NULL DEFAULT 'inline',
      result_key text,
      error text,
      error_storage text NOT NULL DEFAULT 'inline',
      error_key text,
      attempts integer NOT NULL DEFAULT 0,
      max_attempts integer NOT NULL DEFAULT 3,
      execution_interruptions integer NOT NULL DEFAULT 0,
      retryable_requeues integer NOT NULL DEFAULT 0,
      organization_id uuid NOT NULL,
      user_id uuid,
      api_key_id uuid,
      generation_id uuid,
      webhook_url text,
      webhook_status text,
      estimated_completion_at timestamp,
      scheduled_for timestamp NOT NULL DEFAULT now(),
      started_at timestamp,
      execution_generation uuid,
      execution_quiesced_at timestamp,
      completed_at timestamp,
      created_at timestamp NOT NULL DEFAULT now(),
      updated_at timestamp NOT NULL DEFAULT now()
    )`),
    );
    await dbWrite.execute(
      sql.raw(`CREATE TABLE container_compute_stop_intents (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      organization_id uuid NOT NULL,
      container_id uuid NOT NULL,
      lifecycle_revision bigint NOT NULL,
      status text NOT NULL DEFAULT 'pending',
      job_id uuid REFERENCES jobs(id) ON DELETE SET NULL,
      attempts integer NOT NULL DEFAULT 0,
      last_error text,
      next_attempt_at timestamptz NOT NULL DEFAULT now(),
      provider_started_at timestamptz,
      provider_confirmed_at timestamptz,
      provider_node_id text,
      slot_released_at timestamptz,
      superseded_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )`),
    );
    await dbWrite.execute(
      sql.raw(`CREATE UNIQUE INDEX container_compute_stop_intents_active_unique
      ON container_compute_stop_intents (organization_id, container_id)
      WHERE status IN ('pending', 'dispatching', 'retry', 'terminal_attention')`),
    );
  } catch (error) {
    ready = false;
    console.error("[compute-billing-recovery] PGlite schema setup failed", error);
  }
}, PGLITE_TIMEOUT);

beforeEach(async () => {
  expect(ready).toBe(true);
  await dbWrite.execute(sql.raw(`DELETE FROM jobs`));
  await dbWrite.execute(sql.raw(`DELETE FROM container_compute_stop_intents`));
  await dbWrite.delete(containerBillingRecords);
  await dbWrite.execute(sql.raw(`DELETE FROM containers`));
  await dbWrite.delete(computeBillingRateSegments);
  await dbWrite.delete(redeemableEarningsLedger);
  await dbWrite.delete(redeemableEarnings);
  await dbWrite.delete(agentBillingRunItems);
  await dbWrite.delete(agentBillingRuns);
  await dbWrite.delete(agentBillingRecords);
  await dbWrite.delete(creditTransactions);
  await dbWrite.delete(agentSandboxes);
  await dbWrite.delete(userCharacters);
  await dbWrite.delete(users);
  await dbWrite.delete(organizations);
});

afterAll(async () => {
  await closeDatabaseConnectionsForTests();
});

async function seed(balance = "10.000000") {
  const [org] = await dbWrite
    .insert(organizations)
    .values({
      name: "Compute Billing",
      slug: `compute-${crypto.randomUUID()}`,
      credit_balance: balance,
      pay_as_you_go_from_earnings: false,
    })
    .returning();
  const [user] = await dbWrite
    .insert(users)
    .values({ steward_user_id: `steward-${crypto.randomUUID()}`, organization_id: org.id })
    .returning();
  const lastBilledAt = new Date("2026-08-19T01:00:00.000Z");
  const [sandbox] = await dbWrite
    .insert(agentSandboxes)
    .values({
      organization_id: org.id,
      user_id: user.id,
      agent_name: "elapsed-agent",
      status: "running",
      execution_tier: "dedicated-always",
      billing_status: "active",
      last_billed_at: lastBilledAt,
    })
    .returning();
  await dbWrite.insert(computeBillingRateSegments).values({
    organization_id: org.id,
    workload_kind: "agent",
    workload_id: sandbox.id,
    lifecycle_revision: sandbox.lifecycle_revision,
    billing_state: "running",
    rate_per_hour: "0.010000",
    effective_at: lastBilledAt,
  });
  return { org, user, sandbox, lastBilledAt };
}

async function claimBillingRun(_billingCutoffAt: Date) {
  const claim = await agentBillingRunRepository.startOrLoad({
    invocationKey: `manual:compute-recovery:${crypto.randomUUID()}`,
    triggerKind: "manual",
    schedule: null,
    scheduledAt: null,
    leaseDurationMs: 5 * 60_000,
  });
  if (!claim.leaseToken) throw new Error("Expected billing run lease");
  return { runId: claim.run.id, leaseToken: claim.leaseToken };
}

describe("compute billing recovery", () => {
  test("commits the sandbox stamp and warning_sent item atomically after delivery", async () => {
    const { org, sandbox } = await seed("0.000000");
    const now = new Date("2026-08-19T04:30:00.000Z");
    const authority = await claimBillingRun(now);
    const input = {
      ...authority,
      sandboxId: sandbox.id,
      organizationId: org.id,
      agentName: sandbox.agent_name ?? sandbox.id,
      now,
      shutdownTime: new Date("2026-08-21T04:30:00.000Z"),
    };

    await expect(agentBillingRepository.scheduleShutdownWarningForRun(input)).resolves.toBe(
      "claimed",
    );
    expect(await dbWrite.select().from(agentBillingRunItems)).toMatchObject([
      { action: "warning_pending" },
    ]);
    await expect(
      agentBillingRepository.completeShutdownWarningForRun({ ...input, outcome: "sent" }),
    ).resolves.toBe("sent");
    const items = await dbWrite.select().from(agentBillingRunItems);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      run_id: authority.runId,
      sandbox_id: sandbox.id,
      action: "warning_sent",
    });
    const [updated] = await dbWrite
      .select({
        billingStatus: agentSandboxes.billing_status,
        warningSentAt: agentSandboxes.shutdown_warning_sent_at,
      })
      .from(agentSandboxes)
      .where(eq(agentSandboxes.id, sandbox.id));
    expect(updated).toEqual({
      billingStatus: "shutdown_pending",
      warningSentAt: now,
    });
  });

  test("a crash after the warning claim leaves a durable retryable intent", async () => {
    const { org, sandbox } = await seed("0.000000");
    const now = new Date("2026-08-19T04:30:00.000Z");
    const invocationKey = `manual:compute-recovery:${crypto.randomUUID()}`;
    const crashed = await agentBillingRunRepository.startOrLoad({
      invocationKey,
      triggerKind: "manual",
      schedule: null,
      scheduledAt: null,
      leaseDurationMs: 5 * 60_000,
    });
    if (!crashed.leaseToken) throw new Error("Expected billing run lease");
    const warningInput = {
      runId: crashed.run.id,
      leaseToken: crashed.leaseToken,
      sandboxId: sandbox.id,
      organizationId: org.id,
      agentName: sandbox.agent_name ?? sandbox.id,
      now,
      shutdownTime: new Date("2026-08-21T04:30:00.000Z"),
    };
    await expect(agentBillingRepository.scheduleShutdownWarningForRun(warningInput)).resolves.toBe(
      "claimed",
    );
    // Simulated worker death before provider delivery: the durable intent is
    // visible, but neither the sent timestamp nor shutdown is armed.
    expect(await dbWrite.select().from(agentBillingRunItems)).toMatchObject([
      { action: "warning_pending" },
    ]);
    const [beforeRetry] = await dbWrite
      .select({
        billingStatus: agentSandboxes.billing_status,
        warningSentAt: agentSandboxes.shutdown_warning_sent_at,
        scheduledShutdownAt: agentSandboxes.scheduled_shutdown_at,
      })
      .from(agentSandboxes)
      .where(eq(agentSandboxes.id, sandbox.id));
    expect(beforeRetry).toEqual({
      billingStatus: "active",
      warningSentAt: null,
      scheduledShutdownAt: null,
    });

    await dbWrite
      .update(agentBillingRuns)
      .set({
        lease_expires_at: sql`clock_timestamp() - INTERVAL '1 second'`,
        updated_at: sql`clock_timestamp() - INTERVAL '2 seconds'`,
      })
      .where(eq(agentBillingRuns.id, crashed.run.id));
    const retry = await agentBillingRunRepository.startOrLoad({
      invocationKey,
      triggerKind: "manual",
      schedule: null,
      scheduledAt: null,
      leaseDurationMs: 5 * 60_000,
    });
    if (!retry.leaseToken) throw new Error("Expected recovered run lease");
    expect(retry).toMatchObject({
      claimed: true,
      recovered: true,
      run: { id: crashed.run.id, attempt_count: 2 },
    });

    const recoveredInput = {
      ...warningInput,
      runId: retry.run.id,
      leaseToken: retry.leaseToken,
    };
    await expect(
      agentBillingRepository.scheduleShutdownWarningForRun(recoveredInput),
    ).resolves.toBe("pending");
    await expect(
      agentBillingRepository.completeShutdownWarningForRun({
        ...recoveredInput,
        outcome: "sent",
      }),
    ).resolves.toBe("sent");
    const items = await dbWrite.select().from(agentBillingRunItems);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      run_id: crashed.run.id,
      sandbox_id: sandbox.id,
      action: "warning_sent",
    });
    const [afterRetry] = await dbWrite
      .select({
        billingStatus: agentSandboxes.billing_status,
        warningSentAt: agentSandboxes.shutdown_warning_sent_at,
      })
      .from(agentSandboxes)
      .where(eq(agentSandboxes.id, sandbox.id));
    expect(afterRetry).toEqual({
      billingStatus: "shutdown_pending",
      warningSentAt: now,
    });
  });

  test("a recovered balance terminally cancels a pending warning intent", async () => {
    const { org, sandbox } = await seed("0.000000");
    const now = new Date("2026-08-19T04:30:00.000Z");
    const authority = await claimBillingRun(now);
    const input = {
      ...authority,
      sandboxId: sandbox.id,
      organizationId: org.id,
      agentName: sandbox.agent_name ?? sandbox.id,
      now,
      shutdownTime: new Date("2026-08-21T04:30:00.000Z"),
    };

    await expect(agentBillingRepository.scheduleShutdownWarningForRun(input)).resolves.toBe(
      "claimed",
    );
    await expect(
      agentBillingRepository.completeShutdownWarningForRun({
        ...input,
        outcome: "skipped",
      }),
    ).resolves.toBe("skipped");

    expect(await dbWrite.select().from(agentBillingRunItems)).toMatchObject([
      {
        action: "skipped",
        detail_code: "balance_recovered",
        detail_message: "Balance recovered before warning could be sent",
      },
    ]);
    const [unchanged] = await dbWrite
      .select({
        billingStatus: agentSandboxes.billing_status,
        warningSentAt: agentSandboxes.shutdown_warning_sent_at,
        scheduledShutdownAt: agentSandboxes.scheduled_shutdown_at,
      })
      .from(agentSandboxes)
      .where(eq(agentSandboxes.id, sandbox.id));
    expect(unchanged).toEqual({
      billingStatus: "active",
      warningSentAt: null,
      scheduledShutdownAt: null,
    });
  });

  test("Dedicated warm-pool capacity is outside every billing lifecycle path", async () => {
    const { org, user, sandbox, lastBilledAt } = await seed();
    await dbWrite
      .update(agentSandboxes)
      .set({ pool_status: "unclaimed" })
      .where(eq(agentSandboxes.id, sandbox.id));
    const now = new Date("2026-08-19T04:30:00.000Z");

    const billableWhileRunning = await agentBillingRepository.listBillableSandboxes(
      now,
      new Date("2026-08-19T03:30:00.000Z"),
    );
    expect(billableWhileRunning.runningSandboxes.map((row) => row.id)).not.toContain(sandbox.id);

    const input = {
      ...(await claimBillingRun(now)),
      sandboxId: sandbox.id,
      organizationId: org.id,
      userId: user.id,
      agentName: "pool-capacity",
      hourlyRate: 0.01,
      billingDescription: "must remain exempt",
      lowCreditWarningAmount: 1,
      now,
    };
    await expect(agentBillingRepository.recordHourlyBilling(input)).resolves.toEqual({
      status: "already_billed_recently",
    });
    await expect(
      agentBillingRepository.settleAccruedBillingBeforeLifecycle(sandbox.id, org.id, now),
    ).resolves.toEqual({ status: "already_billed_recently" });

    await agentBillingRepository.scheduleShutdownWarning(
      sandbox.id,
      org.id,
      now,
      new Date("2026-08-19T05:30:00.000Z"),
    );
    await agentBillingRepository.suspendSandboxForInsufficientCredits(sandbox.id, org.id, now);

    const [afterRejectedTransitions] = await dbWrite
      .select({
        billing_status: agentSandboxes.billing_status,
        shutdown_warning_sent_at: agentSandboxes.shutdown_warning_sent_at,
        scheduled_shutdown_at: agentSandboxes.scheduled_shutdown_at,
      })
      .from(agentSandboxes)
      .where(eq(agentSandboxes.id, sandbox.id));
    expect(afterRejectedTransitions).toEqual({
      billing_status: "active",
      shutdown_warning_sent_at: null,
      scheduled_shutdown_at: null,
    });

    await dbWrite
      .update(agentSandboxes)
      .set({ status: "stopped", last_backup_at: now })
      .where(eq(agentSandboxes.id, sandbox.id));
    const billableWhileStopped = await agentBillingRepository.listBillableSandboxes(
      now,
      new Date("2026-08-19T03:30:00.000Z"),
    );
    expect(billableWhileStopped.stoppedWithBackups.map((row) => row.id)).not.toContain(sandbox.id);

    await dbWrite
      .update(agentSandboxes)
      .set({ billing_status: "suspended" })
      .where(eq(agentSandboxes.id, sandbox.id));
    await agentBillingRepository.reactivateSandboxBillingAfterFunding(
      sandbox.id,
      new Date("2026-08-19T04:31:00.000Z"),
      org.id,
    );

    const [stored] = await dbWrite
      .select({
        billing_status: agentSandboxes.billing_status,
        last_billed_at: agentSandboxes.last_billed_at,
        shutdown_warning_sent_at: agentSandboxes.shutdown_warning_sent_at,
        scheduled_shutdown_at: agentSandboxes.scheduled_shutdown_at,
      })
      .from(agentSandboxes)
      .where(eq(agentSandboxes.id, sandbox.id));
    expect(stored).toEqual({
      billing_status: "suspended",
      last_billed_at: lastBilledAt,
      shutdown_warning_sent_at: null,
      scheduled_shutdown_at: null,
    });
    const [balance] = await dbWrite
      .select({ credit_balance: organizations.credit_balance })
      .from(organizations)
      .where(eq(organizations.id, org.id));
    expect(balance.credit_balance).toBe("10.000000");
    expect(await dbWrite.select().from(agentBillingRecords)).toHaveLength(0);
    expect(await dbWrite.select().from(creditTransactions)).toHaveLength(0);
  });

  test("a delayed run charges the full elapsed interval and a concurrent replay is a no-op", async () => {
    const { org, user, sandbox } = await seed();
    const now = new Date("2026-08-19T04:30:00.000Z");
    const input = {
      ...(await claimBillingRun(now)),
      sandboxId: sandbox.id,
      organizationId: org.id,
      userId: user.id,
      agentName: "elapsed-agent",
      hourlyRate: 0.01,
      billingDescription: "elapsed compute",
      lowCreditWarningAmount: 1,
      now,
    };

    const [first, replay] = await Promise.all([
      agentBillingRepository.recordHourlyBilling(input),
      agentBillingRepository.recordHourlyBilling(input),
    ]);
    const billed = [first, replay].filter((result) => result.status === "billed");
    expect(billed).toHaveLength(1);
    expect(billed[0]).toMatchObject({ amount: 0.035 });

    const [balance] = await dbWrite
      .select({ credit_balance: organizations.credit_balance })
      .from(organizations)
      .where(eq(organizations.id, org.id));
    expect(Number(balance.credit_balance)).toBeCloseTo(9.965, 6);

    const [counts] = await dbWrite
      .select({ receipts: sql<number>`count(*)::int` })
      .from(agentBillingRecords)
      .where(eq(agentBillingRecords.organization_id, org.id));
    expect(counts.receipts).toBe(1);
    const [runItem] = await dbWrite.select().from(agentBillingRunItems);
    expect(runItem).toMatchObject({
      run_id: input.runId,
      sandbox_id: sandbox.id,
      action: "billed",
      amount: "0.035000",
    });
    expect(runItem?.transaction_id).toBeTruthy();
  });

  test("insufficient credit rolls back the claim and creates no ledger or receipt", async () => {
    const { org, user, sandbox, lastBilledAt } = await seed("0.001000");
    const now = new Date("2026-08-19T04:30:00.000Z");
    const result = await agentBillingRepository.recordHourlyBilling({
      ...(await claimBillingRun(now)),
      sandboxId: sandbox.id,
      organizationId: org.id,
      userId: user.id,
      agentName: "elapsed-agent",
      hourlyRate: 0.01,
      billingDescription: "elapsed compute",
      lowCreditWarningAmount: 1,
      now,
    });
    expect(result.status).toBe("insufficient_credits");

    const [row] = await dbWrite
      .select({ last_billed_at: agentSandboxes.last_billed_at })
      .from(agentSandboxes)
      .where(eq(agentSandboxes.id, sandbox.id));
    expect(row.last_billed_at).toEqual(lastBilledAt);
    expect(await dbWrite.select().from(agentBillingRecords)).toHaveLength(0);
    expect(await dbWrite.select().from(creditTransactions)).toHaveLength(0);
  });

  test("an expired run lease is fenced inside the debit transaction before mutation", async () => {
    const { org, user, sandbox, lastBilledAt } = await seed();
    const now = new Date("2026-08-19T04:30:00.000Z");
    const authority = await claimBillingRun(now);
    await dbWrite
      .update(agentBillingRuns)
      .set({
        lease_expires_at: sql`clock_timestamp() - INTERVAL '1 second'`,
        updated_at: sql`clock_timestamp() - INTERVAL '2 seconds'`,
      })
      .where(eq(agentBillingRuns.id, authority.runId));

    await expect(
      agentBillingRepository.recordHourlyBilling({
        ...authority,
        sandboxId: sandbox.id,
        organizationId: org.id,
        userId: user.id,
        agentName: "elapsed-agent",
        hourlyRate: 0.01,
        billingDescription: "expired lease must not debit",
        lowCreditWarningAmount: 1,
        now,
      }),
    ).rejects.toMatchObject({ code: "AGENT_BILLING_RUN_LEASE_LOST" });

    const [sandboxAfter] = await dbWrite
      .select({ last_billed_at: agentSandboxes.last_billed_at })
      .from(agentSandboxes)
      .where(eq(agentSandboxes.id, sandbox.id));
    expect(sandboxAfter.last_billed_at).toEqual(lastBilledAt);
    expect(await dbWrite.select().from(agentBillingRecords)).toHaveLength(0);
    expect(await dbWrite.select().from(agentBillingRunItems)).toHaveLength(0);
    expect(await dbWrite.select().from(creditTransactions)).toHaveLength(0);
  });

  test("funded agent lifecycle settles sub-hour debt before reactivation without forgiveness", async () => {
    const { org, sandbox } = await seed("1.000000");
    await dbWrite
      .update(agentSandboxes)
      .set({ billing_status: "suspended", status: "stopped" })
      .where(eq(agentSandboxes.id, sandbox.id));
    const resumedAt = new Date("2026-08-19T01:30:00.000Z");
    const result = await agentBillingRepository.settleAccruedBillingBeforeLifecycle(
      sandbox.id,
      org.id,
      resumedAt,
    );
    expect(result).toMatchObject({ status: "billed", amount: 0.005 });
    await agentBillingRepository.reactivateSandboxBillingAfterFunding(
      sandbox.id,
      new Date("2026-08-19T01:31:00.000Z"),
      org.id,
    );
    const [row] = await dbWrite
      .select({
        last_billed_at: agentSandboxes.last_billed_at,
        billing_status: agentSandboxes.billing_status,
      })
      .from(agentSandboxes)
      .where(eq(agentSandboxes.id, sandbox.id));
    expect(row).toMatchObject({ last_billed_at: resumedAt, billing_status: "active" });
    expect(await dbWrite.select().from(agentBillingRecords)).toHaveLength(1);
    expect(await dbWrite.select().from(creditTransactions)).toHaveLength(1);
  });

  test("insufficient agent lifecycle funding preserves debt cursor and emits no receipt", async () => {
    const { org, sandbox, lastBilledAt } = await seed("0.001000");
    await dbWrite
      .update(agentSandboxes)
      .set({ billing_status: "suspended", status: "stopped" })
      .where(eq(agentSandboxes.id, sandbox.id));
    const result = await agentBillingRepository.settleAccruedBillingBeforeLifecycle(
      sandbox.id,
      org.id,
      new Date("2026-08-19T01:30:00.000Z"),
    );
    expect(result.status).toBe("insufficient_credits");
    const [row] = await dbWrite
      .select({ last_billed_at: agentSandboxes.last_billed_at })
      .from(agentSandboxes)
      .where(eq(agentSandboxes.id, sandbox.id));
    expect(row.last_billed_at).toEqual(lastBilledAt);
    expect(await dbWrite.select().from(agentBillingRecords)).toHaveLength(0);
    expect(await dbWrite.select().from(creditTransactions)).toHaveLength(0);
  });

  test("a delayed run settles running, backup, and stopped segments at their exact rates", async () => {
    const { org, user, sandbox } = await seed();
    await dbWrite.insert(computeBillingRateSegments).values([
      {
        organization_id: org.id,
        workload_kind: "agent",
        workload_id: sandbox.id,
        lifecycle_revision: sandbox.lifecycle_revision + 1,
        billing_state: "backup",
        rate_per_hour: "0.002500",
        effective_at: new Date("2026-08-19T02:00:00.000Z"),
      },
      {
        organization_id: org.id,
        workload_kind: "agent",
        workload_id: sandbox.id,
        lifecycle_revision: sandbox.lifecycle_revision + 2,
        billing_state: "not_billable",
        rate_per_hour: "0.000000",
        effective_at: new Date("2026-08-19T03:00:00.000Z"),
      },
    ]);
    const result = await agentBillingRepository.recordHourlyBilling({
      ...(await claimBillingRun(new Date("2026-08-19T04:00:00.000Z"))),
      sandboxId: sandbox.id,
      organizationId: org.id,
      userId: user.id,
      agentName: "elapsed-agent",
      hourlyRate: 999,
      billingDescription: "segmented compute",
      lowCreditWarningAmount: 1,
      now: new Date("2026-08-19T04:00:00.000Z"),
    });
    expect(result).toMatchObject({ status: "billed", amount: 0.0125 });
    const [receipt] = await dbWrite.select().from(agentBillingRecords);
    expect(receipt?.rate_segments).toHaveLength(3);
    expect(receipt?.sandbox_status).toBe("mixed");
    expect(receipt?.hourly_rate).toBe("0.004167");
  });

  test("a mismatched tenant cannot charge another tenant's workload", async () => {
    const { user, sandbox } = await seed();
    const [other] = await dbWrite
      .insert(organizations)
      .values({ name: "Other", slug: `other-${crypto.randomUUID()}`, credit_balance: "10" })
      .returning();
    const result = await agentBillingRepository.recordHourlyBilling({
      ...(await claimBillingRun(new Date("2026-08-19T04:30:00.000Z"))),
      sandboxId: sandbox.id,
      organizationId: other.id,
      userId: user.id,
      agentName: "elapsed-agent",
      hourlyRate: 0.01,
      billingDescription: "cross tenant",
      lowCreditWarningAmount: 1,
      now: new Date("2026-08-19T04:30:00.000Z"),
    });
    expect(result.status).toBe("already_billed_recently");
    expect(await dbWrite.select().from(agentBillingRecords)).toHaveLength(0);
  });

  test("container stop intent is single-flight for one funded tenant envelope", async () => {
    const { org, user } = await seed("0.000000");
    const containerId = "00000000-0000-4000-8000-000000000001";
    const periodStart = new Date("2026-08-19T01:00:00.000Z");
    await dbWrite.execute(sql`INSERT INTO containers
      (id, name, project_name, organization_id, user_id, status, billing_status, scheduled_shutdown_at,
       last_billed_at, lifecycle_revision, created_at, updated_at)
      VALUES (${containerId}, 'stop-fixture', 'stop-fixture', ${org.id}, ${user.id}, 'running', 'shutdown_pending',
        ${new Date(Date.now() - 60_000)}, ${periodStart}, 4, ${periodStart}, ${periodStart})`);
    await dbWrite.insert(computeBillingRateSegments).values({
      organization_id: org.id,
      workload_kind: "container",
      workload_id: containerId,
      lifecycle_revision: 4,
      billing_state: "running",
      rate_per_hour: "0.027917",
      effective_at: periodStart,
    });
    const first = await enqueueContainerStopOnce({
      containerId,
      organizationId: org.id,
    });
    const replay = await enqueueContainerStopOnce({
      containerId,
      organizationId: org.id,
    });
    expect(first.requested).toBe(true);
    if (!first.requested) throw new Error("Expected durable stop request");
    expect(first.created).toBe(true);
    expect(replay).toEqual({ requested: true, id: first.id, created: false });
    const rows = await dbWrite.execute(
      sql.raw(`SELECT organization_id FROM jobs ORDER BY organization_id`),
    );
    expect(rows.rows).toHaveLength(1);
  });

  test("funding restored under the stop-decision locks reactivates without a provider job", async () => {
    const { org, user } = await seed("10.000000");
    const containerId = "00000000-0000-4000-8000-000000000002";
    const periodStart = new Date("2026-08-19T01:00:00.000Z");
    await dbWrite.execute(sql`INSERT INTO containers
      (id, name, project_name, organization_id, user_id, status, billing_status, scheduled_shutdown_at,
       last_billed_at, lifecycle_revision, created_at, updated_at)
      VALUES (${containerId}, 'funding-fixture', 'funding-fixture', ${org.id}, ${user.id}, 'running', 'shutdown_pending',
        ${new Date(Date.now() - 60_000)}, ${periodStart}, 2, ${periodStart}, ${periodStart})`);
    await dbWrite.insert(computeBillingRateSegments).values({
      organization_id: org.id,
      workload_kind: "container",
      workload_id: containerId,
      lifecycle_revision: 2,
      billing_state: "running",
      rate_per_hour: "0.027917",
      effective_at: periodStart,
    });
    const outcome = await enqueueContainerStopOnce({ containerId, organizationId: org.id });
    expect(outcome).toMatchObject({ requested: false, reason: "funding_restored" });
    expect(await dbWrite.select().from(jobs)).toHaveLength(0);
    const row = await dbWrite.execute(
      sql`SELECT billing_status, scheduled_shutdown_at, last_billed_at
          FROM containers WHERE id = ${containerId}`,
    );
    expect(row.rows[0]).toMatchObject({
      billing_status: "active",
      scheduled_shutdown_at: null,
      last_billed_at: "2026-08-19 01:00:00",
    });
  });

  test("policy-permitted earnings fund stop revalidation without forgiving elapsed debt", async () => {
    const { org, user } = await seed("0.000000");
    await dbWrite
      .update(organizations)
      .set({ pay_as_you_go_from_earnings: true })
      .where(eq(organizations.id, org.id));
    await dbWrite.insert(redeemableEarnings).values({
      user_id: user.id,
      total_earned: "10.0000",
      available_balance: "10.0000",
    });
    const containerId = "00000000-0000-4000-8000-000000000006";
    const periodStart = new Date("2026-08-19T01:00:00.000Z");
    await dbWrite.execute(sql`INSERT INTO containers
      (id, name, project_name, organization_id, user_id, status, billing_status, scheduled_shutdown_at,
       last_billed_at, lifecycle_revision, created_at, updated_at)
      VALUES (${containerId}, 'earnings-fixture', 'earnings-fixture', ${org.id}, ${user.id}, 'running', 'shutdown_pending',
        ${new Date(Date.now() - 60_000)}, ${periodStart}, 12, ${periodStart}, ${periodStart})`);
    await dbWrite.insert(computeBillingRateSegments).values({
      organization_id: org.id,
      workload_kind: "container",
      workload_id: containerId,
      lifecycle_revision: 12,
      billing_state: "running",
      rate_per_hour: "0.027917",
      effective_at: periodStart,
    });

    await expect(
      enqueueContainerStopOnce({ containerId, organizationId: org.id }),
    ).resolves.toMatchObject({ requested: false, reason: "funding_restored" });
    expect(await dbWrite.select().from(jobs)).toHaveLength(0);
    const row = await dbWrite.execute(
      sql`SELECT billing_status, last_billed_at FROM containers WHERE id = ${containerId}`,
    );
    expect(row.rows[0]).toMatchObject({
      billing_status: "active",
      last_billed_at: "2026-08-19 01:00:00",
    });
  });

  test("funded restart atomically settles exact debt through earnings and canonical credits", async () => {
    const { org, user } = await seed("0.000000");
    await dbWrite
      .update(organizations)
      .set({ pay_as_you_go_from_earnings: true })
      .where(eq(organizations.id, org.id));
    await dbWrite.insert(redeemableEarnings).values({
      user_id: user.id,
      total_earned: "10.0000",
      available_balance: "10.0000",
    });
    const containerId = "00000000-0000-4000-8000-000000000007";
    const periodStart = new Date("2026-08-19T01:00:00.000Z");
    const restartAt = new Date("2026-08-19T03:00:00.000Z");
    await dbWrite.insert(containers).values({
      id: containerId,
      organization_id: org.id,
      user_id: user.id,
      name: "atomic-restart",
      project_name: "atomic-restart",
      status: "stopped",
      billing_status: "suspended",
      desired_count: 1,
      cpu: 1024,
      memory: 2048,
      last_billed_at: periodStart,
      created_at: periodStart,
      updated_at: periodStart,
    });
    await dbWrite.insert(computeBillingRateSegments).values({
      organization_id: org.id,
      workload_kind: "container",
      workload_id: containerId,
      lifecycle_revision: 1,
      billing_state: "running",
      rate_per_hour: "0.027917",
      effective_at: periodStart,
    });
    await dbWrite.insert(containerComputeStopIntents).values({
      organization_id: org.id,
      container_id: containerId,
      lifecycle_revision: 1,
    });

    const prepared = await containersRepository.prepareFundedRestart(
      containerId,
      org.id,
      restartAt,
    );
    expect(prepared).toMatchObject({
      status: "deploying",
      billing_status: "active",
      last_billed_at: restartAt,
    });
    const [balance] = await dbWrite
      .select({ credit: organizations.credit_balance })
      .from(organizations)
      .where(eq(organizations.id, org.id));
    expect(balance.credit).toBe("0.000066");
    const [earnings] = await dbWrite
      .select({ available: redeemableEarnings.available_balance })
      .from(redeemableEarnings)
      .where(eq(redeemableEarnings.user_id, user.id));
    expect(earnings.available).toBe("9.9441");
    const ledger = await dbWrite
      .select({ amount: creditTransactions.amount })
      .from(creditTransactions)
      .where(eq(creditTransactions.organization_id, org.id));
    expect(ledger.map((entry) => entry.amount).sort()).toEqual(["-0.055834", "0.055900"]);
    const [receipt] = await dbWrite.select().from(containerBillingRecords);
    expect(receipt).toMatchObject({ amount: "0.055834", status: "success" });
    const [intent] = await dbWrite.select().from(containerComputeStopIntents);
    expect(intent.status).toBe("superseded");
  });

  test("restart debt settlement rolls back every transition when funding is insufficient", async () => {
    const { org, user } = await seed("0.001000");
    const containerId = "00000000-0000-4000-8000-000000000008";
    const periodStart = new Date("2026-08-19T01:00:00.000Z");
    await dbWrite.insert(containers).values({
      id: containerId,
      organization_id: org.id,
      user_id: user.id,
      name: "blocked-restart",
      project_name: "blocked-restart",
      status: "stopped",
      billing_status: "suspended",
      desired_count: 1,
      cpu: 1024,
      memory: 2048,
      last_billed_at: periodStart,
      created_at: periodStart,
      updated_at: periodStart,
    });
    await dbWrite.insert(computeBillingRateSegments).values({
      organization_id: org.id,
      workload_kind: "container",
      workload_id: containerId,
      lifecycle_revision: 2,
      billing_state: "running",
      rate_per_hour: "0.027917",
      effective_at: periodStart,
    });

    await expect(
      containersRepository.prepareFundedRestart(
        containerId,
        org.id,
        new Date("2026-08-19T03:00:00.000Z"),
      ),
    ).rejects.toThrow("funding beyond its unsettled compute debt");
    const [row] = await dbWrite.select().from(containers).where(eq(containers.id, containerId));
    expect(row).toMatchObject({
      status: "stopped",
      billing_status: "suspended",
      last_billed_at: periodStart,
    });
    expect(await dbWrite.select().from(containerBillingRecords)).toHaveLength(0);
    expect(await dbWrite.select().from(creditTransactions)).toHaveLength(0);
  });

  test("daemon rejects tenant envelopes and supersedes a stale lifecycle generation before provider I/O", async () => {
    const { org, user } = await seed("0.000000");
    const containerId = "00000000-0000-4000-8000-000000000003";
    const periodStart = new Date("2026-08-19T01:00:00.000Z");
    await dbWrite.execute(sql`INSERT INTO containers
      (id, name, project_name, organization_id, user_id, status, billing_status, scheduled_shutdown_at,
       last_billed_at, lifecycle_revision, created_at, updated_at)
      VALUES (${containerId}, 'stale-fixture', 'stale-fixture', ${org.id}, ${user.id}, 'running', 'shutdown_pending',
        ${new Date(Date.now() - 60_000)}, ${periodStart}, 7, ${periodStart}, ${periodStart})`);
    await dbWrite.insert(computeBillingRateSegments).values({
      organization_id: org.id,
      workload_kind: "container",
      workload_id: containerId,
      lifecycle_revision: 7,
      billing_state: "running",
      rate_per_hour: "0.027917",
      effective_at: periodStart,
    });
    const requested = await enqueueContainerStopOnce({ containerId, organizationId: org.id });
    if (!requested.requested) throw new Error("Expected stop request");
    const [job] = await dbWrite.select().from(jobs).where(eq(jobs.id, requested.id));
    const providerStop = spyOn(
      getHetznerContainersClient(),
      "stopContainerRuntimeForBilling",
    ).mockResolvedValue({ nodeId: null });
    await expect(
      dispatchContainerStopJob({ ...job, organization_id: crypto.randomUUID() }),
    ).rejects.toThrow("tenant envelope mismatch");
    await dbWrite.execute(
      sql`UPDATE containers SET lifecycle_revision = 8, status = 'deploying' WHERE id = ${containerId}`,
    );
    const stale = await dispatchContainerStopJob(job);
    expect(stale.reason).toBe("stale-lifecycle-generation");
    expect(providerStop).not.toHaveBeenCalled();
    const [intent] = await dbWrite.select().from(containerComputeStopIntents);
    expect(intent?.status).toBe("superseded");
    providerStop.mockRestore();
  });

  test("provider failures persist terminal attention and remain independently recoverable", async () => {
    const { org, user } = await seed("0.000000");
    const containerId = "00000000-0000-4000-8000-000000000004";
    const periodStart = new Date("2026-08-19T01:00:00.000Z");
    await dbWrite.execute(sql`INSERT INTO containers
      (id, name, project_name, organization_id, user_id, status, billing_status, scheduled_shutdown_at,
       last_billed_at, lifecycle_revision, created_at, updated_at)
      VALUES (${containerId}, 'terminal-fixture', 'terminal-fixture', ${org.id}, ${user.id}, 'running', 'shutdown_pending',
        ${new Date(Date.now() - 60_000)}, ${periodStart}, 9, ${periodStart}, ${periodStart})`);
    await dbWrite.insert(computeBillingRateSegments).values({
      organization_id: org.id,
      workload_kind: "container",
      workload_id: containerId,
      lifecycle_revision: 9,
      billing_state: "running",
      rate_per_hour: "0.027917",
      effective_at: periodStart,
    });
    const requested = await enqueueContainerStopOnce({ containerId, organizationId: org.id });
    if (!requested.requested) throw new Error("Expected stop request");
    const [job] = await dbWrite.select().from(jobs).where(eq(jobs.id, requested.id));
    const providerStop = spyOn(
      getHetznerContainersClient(),
      "stopContainerRuntimeForBilling",
    ).mockRejectedValue(new Error("provider unavailable"));
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await expect(dispatchContainerStopJob(job)).rejects.toThrow("provider unavailable");
    }
    await dbWrite
      .update(containerComputeStopIntents)
      .set({ next_attempt_at: new Date(0) })
      .where(eq(containerComputeStopIntents.container_id, containerId));
    const [terminal] = await dbWrite
      .select()
      .from(containerComputeStopIntents)
      .where(eq(containerComputeStopIntents.container_id, containerId));
    expect(terminal).toMatchObject({ status: "terminal_attention", attempts: 3 });
    const recovery = await listRecoverableContainerStopIntents(new Date());
    expect(recovery.map((intent) => intent.id)).toContain(terminal?.id);
    const row = await dbWrite.execute(
      sql`SELECT status, billing_status FROM containers WHERE id = ${containerId}`,
    );
    expect(row.rows[0]).toMatchObject({ status: "running", billing_status: "shutdown_pending" });
    providerStop.mockRestore();
  });

  test("provider success followed by control-plane rollback replays absence proof idempotently", async () => {
    const { org, user } = await seed("0.000000");
    const containerId = "00000000-0000-4000-8000-000000000006";
    const periodStart = new Date("2026-08-19T01:00:00.000Z");
    await dbWrite.execute(sql`INSERT INTO containers
      (id, name, project_name, organization_id, user_id, status, billing_status,
       scheduled_shutdown_at, last_billed_at, lifecycle_revision, created_at, updated_at)
      VALUES (${containerId}, 'crash-replay', 'crash-replay', ${org.id}, ${user.id},
        'running', 'shutdown_pending', ${new Date(Date.now() - 60_000)}, ${periodStart},
        10, ${periodStart}, ${periodStart})`);
    await dbWrite.insert(computeBillingRateSegments).values({
      organization_id: org.id,
      workload_kind: "container",
      workload_id: containerId,
      lifecycle_revision: 10,
      billing_state: "running",
      rate_per_hour: "0.027917",
      effective_at: periodStart,
    });
    const requested = await enqueueContainerStopOnce({ containerId, organizationId: org.id });
    if (!requested.requested) throw new Error("Expected stop request");
    const [job] = await dbWrite.select().from(jobs).where(eq(jobs.id, requested.id));
    const providerStop = spyOn(
      getHetznerContainersClient(),
      "stopContainerRuntimeForBilling",
    ).mockResolvedValue({ nodeId: null });
    await dbWrite.execute(
      sql.raw(`
      CREATE FUNCTION fail_compute_stop_confirmation() RETURNS trigger AS $$
      BEGIN
        IF NEW.status = 'stopped' THEN
          RAISE EXCEPTION 'simulated crash after provider success';
        END IF;
        RETURN NEW;
      END $$ LANGUAGE plpgsql
    `),
    );
    await dbWrite.execute(
      sql.raw(`
      CREATE TRIGGER fail_compute_stop_confirmation
        BEFORE UPDATE ON containers FOR EACH ROW
        EXECUTE FUNCTION fail_compute_stop_confirmation()
    `),
    );
    try {
      await expect(dispatchContainerStopJob(job)).rejects.toThrow();
      const [recoverable] = await dbWrite
        .select()
        .from(containerComputeStopIntents)
        .where(eq(containerComputeStopIntents.container_id, containerId));
      expect(recoverable).toMatchObject({ status: "pending", attempts: 0 });
      await dbWrite.execute(sql.raw(`DROP TRIGGER fail_compute_stop_confirmation ON containers`));

      await expect(dispatchContainerStopJob(job)).resolves.toEqual({ stopped: true });
      expect(providerStop).toHaveBeenCalledTimes(2);
      const [confirmed] = await dbWrite
        .select()
        .from(containerComputeStopIntents)
        .where(eq(containerComputeStopIntents.container_id, containerId));
      expect(confirmed).toMatchObject({ status: "provider_confirmed", attempts: 1 });
    } finally {
      providerStop.mockRestore();
      await dbWrite.execute(
        sql.raw(`DROP TRIGGER IF EXISTS fail_compute_stop_confirmation ON containers`),
      );
      await dbWrite.execute(sql.raw(`DROP FUNCTION IF EXISTS fail_compute_stop_confirmation()`));
    }
  });

  test("provider confirmation is the only transition to stopped and suspended", async () => {
    const { org, user } = await seed("0.000000");
    const containerId = "00000000-0000-4000-8000-000000000005";
    const periodStart = new Date("2026-08-19T01:00:00.000Z");
    await dbWrite.execute(sql`INSERT INTO containers
      (id, name, project_name, organization_id, user_id, status, billing_status, scheduled_shutdown_at,
       last_billed_at, lifecycle_revision, created_at, updated_at)
      VALUES (${containerId}, 'confirmed-fixture', 'confirmed-fixture', ${org.id}, ${user.id}, 'running', 'shutdown_pending',
        ${new Date(Date.now() - 60_000)}, ${periodStart}, 11, ${periodStart}, ${periodStart})`);
    await dbWrite.insert(computeBillingRateSegments).values({
      organization_id: org.id,
      workload_kind: "container",
      workload_id: containerId,
      lifecycle_revision: 11,
      billing_state: "running",
      rate_per_hour: "0.027917",
      effective_at: periodStart,
    });
    const requested = await enqueueContainerStopOnce({ containerId, organizationId: org.id });
    if (!requested.requested) throw new Error("Expected stop request");
    const [job] = await dbWrite.select().from(jobs).where(eq(jobs.id, requested.id));
    const providerStop = spyOn(
      getHetznerContainersClient(),
      "stopContainerRuntimeForBilling",
    ).mockResolvedValue({ nodeId: null });

    await expect(dispatchContainerStopJob(job)).resolves.toEqual({ stopped: true });
    expect(providerStop).toHaveBeenCalledWith(containerId, org.id, 11);
    const row = await dbWrite.execute(
      sql`SELECT status, billing_status FROM containers WHERE id = ${containerId}`,
    );
    expect(row.rows[0]).toMatchObject({ status: "stopped", billing_status: "suspended" });
    const [intent] = await dbWrite.select().from(containerComputeStopIntents);
    expect(intent).toMatchObject({ status: "provider_confirmed", attempts: 1 });
    expect(intent?.provider_confirmed_at).toBeInstanceOf(Date);
    providerStop.mockRestore();
  });
});

test("PGlite setup is mandatory", () => expect(ready).toBe(true));
