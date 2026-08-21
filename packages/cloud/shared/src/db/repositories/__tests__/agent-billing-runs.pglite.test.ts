/**
 * Drives AgentBillingRunRepository against the real Drizzle schema on one
 * isolated PGlite database, including concurrent identity claims and immutable
 * first-terminal completion.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";

const AMBIENT_DATABASE_URL = process.env.DATABASE_URL ?? "";
const CAN_USE_ISOLATED_PGLITE =
  AMBIENT_DATABASE_URL === "" || AMBIENT_DATABASE_URL.startsWith("pglite");
process.env.DATABASE_URL ||= "pglite://memory";
process.env.NODE_ENV ||= "test";
process.env.MOCK_REDIS = "1";

import { pushSchema } from "drizzle-kit/api";
import { closeDatabaseConnectionsForTests, dbWrite } from "../../client";
import { agentBillingRunItems, agentBillingRuns } from "../../schemas/compute-billing";
import { agentBillingRunRepository } from "../agent-billing-runs";

const PGLITE_TIMEOUT = 60_000;
let pgliteReady = true;

async function waitForDatabaseLeaseExpiry(runId: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const [clock] = await dbWrite
      .select({
        expired: sql<boolean>`${agentBillingRuns.lease_expires_at} <= clock_timestamp()`,
      })
      .from(agentBillingRuns)
      .where(eq(agentBillingRuns.id, runId));
    if (clock?.expired) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for the database lease clock");
}

beforeAll(async () => {
  if (!CAN_USE_ISOLATED_PGLITE) {
    pgliteReady = false;
    console.warn(
      "[agent-billing-runs.pglite.test] DATABASE_URL is not isolated PGlite; refusing to mutate it.",
    );
    return;
  }
  try {
    const { apply } = await pushSchema(
      { agentBillingRuns, agentBillingRunItems } as never,
      dbWrite as never,
    );
    await apply();
  } catch (error) {
    // error-policy:J1 isolated test-harness setup boundary; dependent tests
    // fail through the explicit readiness assertion with this diagnostic.
    pgliteReady = false;
    console.error("[agent-billing-runs.pglite.test] PGlite schema setup failed", error);
  }
}, PGLITE_TIMEOUT);

beforeEach(async () => {
  expect(pgliteReady).toBe(true);
  await dbWrite.delete(agentBillingRunItems);
  await dbWrite.delete(agentBillingRuns);
});

afterAll(async () => {
  await closeDatabaseConnectionsForTests();
});

describe("AgentBillingRunRepository", () => {
  test("one concurrent scheduled identity claim wins and the loser reconstructs it", async () => {
    const input = {
      invocationKey:
        "cloudflare-cron:1787245200000:0%20*%20*%20*%20*:%2Fapi%2Fcron%2Fagent-billing",
      triggerKind: "scheduled" as const,
      schedule: "0 * * * *",
      scheduledAt: new Date("2026-08-20T17:00:00.000Z"),
      leaseDurationMs: 5 * 60_000,
    };

    const [first, second] = await Promise.all([
      agentBillingRunRepository.startOrLoad(input),
      agentBillingRunRepository.startOrLoad(input),
    ]);

    expect([first.claimed, second.claimed].sort()).toEqual([false, true]);
    expect([first.leaseToken === null, second.leaseToken === null].sort()).toEqual([false, true]);
    expect(first.run.id).toBe(second.run.id);
    expect(first.run.status).toBe("started");
    expect(await agentBillingRunRepository.findByInvocationKey(input.invocationKey)).toMatchObject({
      id: first.run.id,
      status: "started",
    });
  });

  test("persists one bounded exact terminal result and never overwrites it", async () => {
    const { run, leaseToken } = await agentBillingRunRepository.startOrLoad({
      invocationKey: "manual:agent-billing:terminal",
      triggerKind: "manual",
      schedule: null,
      scheduledAt: null,
      leaseDurationMs: 5 * 60_000,
    });
    expect(leaseToken).not.toBeNull();
    const samples = Array.from({ length: 25 }, (_, index) => ({
      code: `sandbox_failure_${index}`,
      message: "Sandbox billing processing failed",
      sandboxId: `sandbox-${index}`,
    }));

    const completedResult = await agentBillingRunRepository.complete(run.id, leaseToken!, {
      status: "partial_failure",
      sandboxesProcessed: 2,
      sandboxesBilled: 1,
      warningsSent: 0,
      sandboxesShutdown: 0,
      errors: 1,
      totalRevenue: "0.3",
      errorSamples: samples,
    });
    const completed = completedResult.run;

    expect(completedResult).toMatchObject({
      completedByCaller: true,
      terminalReplay: false,
    });

    expect(completed).toMatchObject({
      status: "partial_failure",
      total_revenue: "0.300000",
      sandboxes_processed: 2,
      sandboxes_billed: 1,
      errors: 1,
    });
    expect(completed.error_samples).toHaveLength(20);
    expect(completed.duration_ms).toBe(
      completed.completed_at!.getTime() - completed.started_at.getTime(),
    );

    const replayedCompletion = await agentBillingRunRepository.complete(run.id, leaseToken!, {
      status: "succeeded",
      sandboxesProcessed: 1,
      sandboxesBilled: 1,
      warningsSent: 0,
      sandboxesShutdown: 0,
      errors: 0,
      totalRevenue: "99.000000",
      errorSamples: [],
    });
    expect(replayedCompletion).toEqual({
      run: completed,
      completedByCaller: false,
      terminalReplay: true,
    });
  });

  test("rejects reused identity with conflicting scheduled metadata", async () => {
    const invocationKey =
      "cloudflare-cron:1787245200000:0%20*%20*%20*%20*:%2Fapi%2Fcron%2Fagent-billing";
    await agentBillingRunRepository.startOrLoad({
      invocationKey,
      triggerKind: "scheduled",
      schedule: "0 * * * *",
      scheduledAt: new Date("2026-08-20T17:00:00.000Z"),
      leaseDurationMs: 5 * 60_000,
    });

    await expect(
      agentBillingRunRepository.startOrLoad({
        invocationKey,
        triggerKind: "scheduled",
        schedule: "0 * * * *",
        scheduledAt: new Date("2026-08-20T18:00:00.000Z"),
        leaseDurationMs: 5 * 60_000,
      }),
    ).rejects.toMatchObject({ code: "AGENT_BILLING_RUN_IDENTITY_CONFLICT" });
  });

  test("rejects status/counter combinations that would fabricate healthy evidence", async () => {
    const { run, leaseToken } = await agentBillingRunRepository.startOrLoad({
      invocationKey: "manual:agent-billing:invalid",
      triggerKind: "manual",
      schedule: null,
      scheduledAt: null,
      leaseDurationMs: 5 * 60_000,
    });
    expect(leaseToken).not.toBeNull();

    await expect(
      agentBillingRunRepository.complete(run.id, leaseToken!, {
        status: "succeeded",
        sandboxesProcessed: 1,
        sandboxesBilled: 0,
        warningsSent: 0,
        sandboxesShutdown: 0,
        errors: 1,
        totalRevenue: "0",
        errorSamples: [],
      }),
    ).rejects.toMatchObject({ code: "INVALID_AGENT_BILLING_RUN_INPUT" });

    const impossibleCompletions = [
      {
        status: "succeeded" as const,
        sandboxesProcessed: 0,
        sandboxesBilled: 0,
        warningsSent: 0,
        sandboxesShutdown: 0,
        errors: 0,
      },
      {
        status: "succeeded" as const,
        sandboxesProcessed: 1,
        sandboxesBilled: 1,
        warningsSent: 1,
        sandboxesShutdown: 0,
        errors: 0,
      },
      {
        status: "partial_failure" as const,
        sandboxesProcessed: 1,
        sandboxesBilled: 1,
        warningsSent: 0,
        sandboxesShutdown: 0,
        errors: 0,
      },
      {
        status: "partial_failure" as const,
        sandboxesProcessed: 2,
        sandboxesBilled: 1,
        warningsSent: 1,
        sandboxesShutdown: 0,
        errors: 1,
      },
    ];
    for (const impossible of impossibleCompletions) {
      await expect(
        agentBillingRunRepository.complete(run.id, leaseToken!, {
          ...impossible,
          totalRevenue: "0",
          errorSamples: [],
        }),
      ).rejects.toMatchObject({ code: "INVALID_AGENT_BILLING_RUN_INPUT" });
    }
  });

  test("persists one immutable sandbox outcome under the active lease", async () => {
    const claim = await agentBillingRunRepository.startOrLoad({
      invocationKey: `manual:agent-billing:item:${crypto.randomUUID()}`,
      triggerKind: "manual",
      schedule: null,
      scheduledAt: null,
      leaseDurationMs: 5 * 60_000,
    });
    if (!claim.leaseToken) throw new Error("Expected run lease");
    const authority = {
      runId: claim.run.id,
      leaseToken: claim.leaseToken,
    };
    const first = await agentBillingRunRepository.recordItem(authority, {
      sandboxId: "123e4567-e89b-42d3-a456-426614174000",
      organizationId: "123e4567-e89b-42d3-a456-426614174010",
      agentName: "Durable Agent",
      action: "billed",
      amountDecimal: "0.123456",
      newBalanceDecimal: "9.876544",
      transactionId: "transaction-authority-1",
      completedAt: new Date(),
    });
    const conflictingReplay = await agentBillingRunRepository.recordItem(authority, {
      sandboxId: "123e4567-e89b-42d3-a456-426614174000",
      organizationId: "123e4567-e89b-42d3-a456-426614174010",
      agentName: "Durable Agent",
      action: "error",
      detailCode: "late_local_error",
      detailMessage: "Late local result must not replace the debit",
      completedAt: new Date(),
    });

    expect(first.created).toBe(true);
    expect(conflictingReplay).toEqual({ item: first.item, created: false });
    expect(await agentBillingRunRepository.listItems(claim.run.id)).toEqual([first.item]);
  });

  test("fences renew and completion when a barrier crosses the database lease expiry", async () => {
    const claim = await agentBillingRunRepository.startOrLoad({
      invocationKey: `manual:agent-billing:db-clock:${crypto.randomUUID()}`,
      triggerKind: "manual",
      schedule: null,
      scheduledAt: null,
      leaseDurationMs: 100,
    });
    if (!claim.leaseToken) throw new Error("Expected run lease");

    let releaseBarrier: () => void = () => {
      throw new Error("Expiry barrier was not initialized");
    };
    const expiryBarrier = new Promise<void>((resolve) => {
      releaseBarrier = resolve;
    });
    const staleRenew = (async () => {
      await expiryBarrier;
      return agentBillingRunRepository.renewLease(claim.run.id, claim.leaseToken!, 5 * 60_000);
    })();
    const staleComplete = (async () => {
      await expiryBarrier;
      return agentBillingRunRepository.complete(claim.run.id, claim.leaseToken!, {
        status: "succeeded",
        sandboxesProcessed: 1,
        sandboxesBilled: 1,
        warningsSent: 0,
        sandboxesShutdown: 0,
        errors: 0,
        totalRevenue: "0.100000",
        errorSamples: [],
      });
    })();
    const renewOutcome = staleRenew.then(
      () => null,
      (error: unknown) => error,
    );
    const completeOutcome = staleComplete.then(
      () => null,
      (error: unknown) => error,
    );

    await waitForDatabaseLeaseExpiry(claim.run.id);
    releaseBarrier();
    await expect(renewOutcome).resolves.toMatchObject({
      code: "AGENT_BILLING_RUN_LEASE_LOST",
    });
    await expect(completeOutcome).resolves.toMatchObject({
      code: "AGENT_BILLING_RUN_LEASE_LOST",
    });
    expect(
      await agentBillingRunRepository.findByInvocationKey(claim.run.invocation_key),
    ).toMatchObject({ status: "started", lease_token: claim.leaseToken });
  });

  test("recovers a stale started receipt and fences the crashed owner", async () => {
    const first = await agentBillingRunRepository.startOrLoad({
      invocationKey: "manual:agent-billing:stale-recovery",
      triggerKind: "manual",
      schedule: null,
      scheduledAt: null,
      leaseDurationMs: 5 * 60_000,
    });
    await dbWrite
      .update(agentBillingRuns)
      .set({
        started_at: sql`date_trunc('milliseconds', clock_timestamp() - INTERVAL '2 minutes')`,
        billing_cutoff_at: sql`date_trunc('milliseconds', clock_timestamp() - INTERVAL '2 minutes')`,
        lease_expires_at: sql`clock_timestamp() - INTERVAL '1 second'`,
        updated_at: sql`clock_timestamp() - INTERVAL '2 seconds'`,
      })
      .where(eq(agentBillingRuns.id, first.run.id));
    const [staleRun] = await dbWrite
      .select()
      .from(agentBillingRuns)
      .where(eq(agentBillingRuns.id, first.run.id));
    const recovered = await agentBillingRunRepository.startOrLoad({
      invocationKey: "manual:agent-billing:stale-recovery",
      triggerKind: "manual",
      schedule: null,
      scheduledAt: null,
      leaseDurationMs: 5 * 60_000,
    });

    expect(recovered).toMatchObject({
      claimed: true,
      recovered: true,
      run: {
        id: first.run.id,
        attempt_count: 2,
        status: "started",
        billing_cutoff_at: staleRun!.billing_cutoff_at,
      },
    });
    expect(recovered.leaseToken).not.toBe(first.leaseToken);
    await expect(
      agentBillingRunRepository.renewLease(first.run.id, first.leaseToken!, 5 * 60_000),
    ).rejects.toMatchObject({ code: "AGENT_BILLING_RUN_LEASE_LOST" });
    await expect(
      agentBillingRunRepository.complete(first.run.id, first.leaseToken!, {
        status: "succeeded",
        sandboxesProcessed: 1,
        sandboxesBilled: 1,
        warningsSent: 0,
        sandboxesShutdown: 0,
        errors: 0,
        totalRevenue: "0.100000",
        errorSamples: [],
      }),
    ).rejects.toMatchObject({ code: "AGENT_BILLING_RUN_LEASE_LOST" });

    const completed = await agentBillingRunRepository.complete(
      recovered.run.id,
      recovered.leaseToken!,
      {
        status: "succeeded",
        sandboxesProcessed: 1,
        sandboxesBilled: 1,
        warningsSent: 0,
        sandboxesShutdown: 0,
        errors: 0,
        totalRevenue: "0.100000",
        errorSamples: [],
      },
    );
    expect(completed).toMatchObject({
      completedByCaller: true,
      terminalReplay: false,
      run: {
        id: first.run.id,
        attempt_count: 2,
        status: "succeeded",
        lease_expires_at: null,
      },
    });
    expect(completed.run.duration_ms).toBe(
      completed.run.completed_at!.getTime() - completed.run.started_at.getTime(),
    );
    expect(completed.run.duration_ms).toBeGreaterThanOrEqual(120_000);

    const staleOwnerAfterWinner = await agentBillingRunRepository.complete(
      first.run.id,
      first.leaseToken!,
      {
        status: "failed",
        sandboxesProcessed: 0,
        sandboxesBilled: 0,
        warningsSent: 0,
        sandboxesShutdown: 0,
        errors: 1,
        totalRevenue: "0.000000",
        errorSamples: [{ code: "stale_owner", message: "Stale owner local failure" }],
      },
    );
    expect(staleOwnerAfterWinner).toEqual({
      run: completed.run,
      completedByCaller: false,
      terminalReplay: true,
    });
  });
});
