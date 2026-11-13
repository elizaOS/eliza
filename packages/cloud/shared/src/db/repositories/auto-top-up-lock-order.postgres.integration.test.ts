/** Exercises real lock contention; PGlite cannot represent independent row-lock owners. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { acquireEphemeralPostgres } from "../../lib/services/tenant-db/__tests__/ephemeral-postgres";
import { installAutoTopUpTestSchema } from "./test-support/auto-top-up-test-schema";

const postgres = await acquireEphemeralPostgres();
const originalEnv = {
  DATABASE_URL: process.env.DATABASE_URL,
  TEST_DATABASE_URL: process.env.TEST_DATABASE_URL,
};
const databaseName = `auto_top_up_locks_${randomUUID().replaceAll("-", "")}`;
let admin: Client;
let observer: Client;
let holder: Client;
let repository: typeof import("./auto-top-up-attempts").autoTopUpAttemptsRepository;
let close: typeof import("../client").closeDatabaseConnectionsForTests;

if (!postgres)
  console.warn(
    "[auto-top-up lock order] SKIPPED: real PostgreSQL unavailable; set APPS_TENANT_DB_TEST_DSN or APPS_TENANT_DB_EPHEMERAL=1.",
  );

async function waitForBlocked(count: number): Promise<void> {
  const until = Date.now() + 5_000;
  while (Date.now() < until) {
    const result = await observer.query<{ count: number }>(`
      SELECT count(*)::int AS count FROM pg_stat_activity
      WHERE datname=current_database()
        AND cardinality(pg_blocking_pids(pid)) > 0
    `);
    if ((result.rows[0]?.count ?? 0) >= count) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Expected ${count} concurrent blocked repository transactions`);
}

async function seed(succeeded: boolean) {
  const organizationId = randomUUID();
  const authorityId = randomUUID();
  const customerId = `cus_${organizationId.replaceAll("-", "")}`;
  await observer.query(
    `INSERT INTO organizations(id,name,slug,credit_balance,
    auto_top_up_enabled,auto_top_up_threshold,auto_top_up_amount,stripe_default_payment_method)
    VALUES($1::uuid,'test',$1::text,1,true,5,10,'pm_test')`,
    [organizationId],
  );
  await observer.query(
    `INSERT INTO stripe_customer_attempts(id,organization_id,generation,
    request_digest,caller_intent,idempotency_key) VALUES($1,$2,1,$3,'auto_top_up',$4)`,
    [authorityId, organizationId, "a".repeat(64), `eliza-customer-attempt:${authorityId}`],
  );
  await observer.query(
    "UPDATE stripe_customer_attempts SET status='provider_started',provider_started_at=now() WHERE id=$1",
    [authorityId],
  );
  const receipt = {
    binding_kind: "attempt_created",
    created: 1_700_000_000,
    customer_id: customerId,
    livemode: false,
    metadata: {
      organization_id: organizationId,
      eliza_organization_id: organizationId,
      eliza_customer_attempt_id: authorityId,
      eliza_customer_generation: "1",
      eliza_customer_request_digest: "a".repeat(64),
      eliza_customer_provider: "stripe",
    },
  };
  await observer.query(
    `UPDATE stripe_customer_attempts SET status='bound',provider_customer_id=$2,
    provider_receipt=$3,provider_livemode=false,bound_at=now() WHERE id=$1`,
    [authorityId, customerId, receipt],
  );
  await observer.query("UPDATE organizations SET stripe_customer_id=$2 WHERE id=$1", [
    organizationId,
    customerId,
  ]);
  const now = new Date();
  const claim = await repository.claimEligibleAttempt({
    organizationId,
    triggerSource: "cron",
    attemptId: randomUUID(),
    idempotencyKey: `auto_top_up:${randomUUID()}`,
    now,
  });
  if (claim.outcome !== "created") throw new Error("Expected an eligible new attempt");
  const attemptId = claim.attempt.id;
  const leaseToken = randomUUID();
  await repository.claimDueLease({
    attemptId,
    leaseToken,
    now,
    leaseExpiresAt: new Date(now.getTime() + 60_000),
  });
  if (succeeded) {
    await repository.finalizeRequest({
      attemptId,
      leaseToken,
      chargeAmountCents: 1200,
      requestMetadata: { organization_id: organizationId },
      now,
    });
    await repository.markProviderRequestStarted({
      attemptId,
      leaseToken,
      now,
      recoveryDeadlineAt: new Date(now.getTime() + 23 * 3_600_000),
    });
    await repository.recordPaymentIntent({
      attemptId,
      leaseToken,
      now,
      paymentIntentId: `pi_${attemptId}`,
      providerStatus: "succeeded",
      result: { id: `pi_${attemptId}`, status: "succeeded" },
    });
  }
  return { organizationId, attemptId, leaseToken, now };
}

(postgres ? describe : describe.skip)("auto-top-up organization-first locking", () => {
  beforeAll(async () => {
    if (!postgres) return;
    admin = new Client({ connectionString: postgres.dsn });
    await admin.connect();
    await admin.query(`CREATE DATABASE "${databaseName}"`);
    await admin.query(`ALTER DATABASE "${databaseName}" SET deadlock_timeout='100ms'`);
    const url = new URL(postgres.dsn);
    url.pathname = `/${databaseName}`;
    observer = new Client({ connectionString: url.toString() });
    holder = new Client({ connectionString: url.toString() });
    await observer.connect();
    await holder.connect();
    await installAutoTopUpTestSchema((query) => observer.query(query));
    await observer.query(
      "UPDATE auto_top_up_control SET mode='durable',legacy_reconciled_through=paused_at WHERE singleton=true",
    );
    process.env.DATABASE_URL = process.env.TEST_DATABASE_URL = url.toString();
    ({ autoTopUpAttemptsRepository: repository } = await import("./auto-top-up-attempts"));
    ({ closeDatabaseConnectionsForTests: close } = await import("../client"));
  }, 60_000);

  afterAll(async () => {
    if (!postgres) return;
    await holder?.query("ROLLBACK");
    await close?.();
    await holder?.end();
    await observer?.end();
    if (admin) {
      await admin.query(`DROP DATABASE IF EXISTS "${databaseName}"`);
      await admin.end();
    }
    for (const name of ["DATABASE_URL", "TEST_DATABASE_URL"] as const) {
      if (originalEnv[name] === undefined) delete process.env[name];
      else process.env[name] = originalEnv[name];
    }
    await postgres.stop();
  }, 60_000);

  for (const operation of ["settle", "cancel", "review"] as const) {
    test(`${operation} cannot deadlock with stale provider authorization`, async () => {
      const input = await seed(operation === "settle");
      await holder.query("BEGIN");
      await holder.query("SELECT id FROM organizations WHERE id=$1 FOR UPDATE", [
        input.organizationId,
      ]);
      let authorization: ReturnType<typeof repository.authorizeProviderRequest> | undefined;
      let mutation: Promise<unknown> | undefined;
      try {
        // Queue authorization first. It must receive the organization lock
        // before the mutation when the external holder releases it.
        authorization = repository.authorizeProviderRequest({
          ...input,
          leaseToken: randomUUID(),
          recoveryDeadlineAt: new Date(input.now.getTime() + 23 * 3_600_000),
        });
        await waitForBlocked(1);
        mutation =
          operation === "settle"
            ? repository.settleSucceededAttempt(input)
            : operation === "cancel"
              ? repository.markCanceled({ ...input, error: "test cancellation" })
              : repository.markManualReview({ ...input, error: "test manual review" });
        await waitForBlocked(2);
        await holder.query("COMMIT");
        const [authorizationResult, mutationResult] = await Promise.all([authorization, mutation]);
        expect(authorizationResult.outcome).toBe("fence_lost");
        expect(mutationResult).toMatchObject(
          operation === "settle"
            ? { outcome: "applied" }
            : { status: operation === "cancel" ? "canceled" : "manual_review" },
        );
        if (operation === "settle") {
          const balance = await observer.query<{ credit_balance: string }>(
            "SELECT credit_balance FROM organizations WHERE id=$1",
            [input.organizationId],
          );
          expect(balance.rows[0]?.credit_balance).toBe("11.000000");
        }
      } finally {
        await holder.query("ROLLBACK");
        await Promise.allSettled([authorization, mutation]);
      }
    }, 20_000);
  }
});
