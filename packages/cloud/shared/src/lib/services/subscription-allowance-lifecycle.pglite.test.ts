/**
 * Proves allowance lifecycle behavior against real subscription migrations on
 * PGlite: caller deadlines persist apart from period expiry, stranded holds are
 * released to their exact sources, ended and terminal periods are retired, a
 * resubscription can be granted over a canceled bucket, windows that straddle a
 * period end fund the remainder from credits, and ex-subscribers stay on cash.
 * Policy caches are exercised on the explicit in-memory test cache backend.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";

process.env.DATABASE_URL = "pglite://memory";
process.env.TEST_DATABASE_URL = process.env.DATABASE_URL;
process.env.ENVIRONMENT = "local";
// CI runs cloud unit tests with CACHE_ENABLED=false; MOCK_REDIS only takes
// effect on an enabled cache, so opt this suite in explicitly.
process.env.CACHE_ENABLED = "true";
process.env.MOCK_REDIS = "1";

let client: typeof import("../../db/client");
let helpers: typeof import("../../db/helpers");
let funding: typeof import("./subscription-funding");
let allowance: typeof import("../../db/repositories/subscription-allowance");
let fixture: {
  exec(query: string): Promise<unknown>;
  query<T extends Record<string, unknown> = Record<string, unknown>>(
    query: string,
    parameters?: unknown[],
  ): Promise<{ rows: T[] }>;
};

const HOUR = 60 * 60 * 1000;

beforeAll(async () => {
  client = await import("../../db/client");
  helpers = await import("../../db/helpers");
  funding = await import("./subscription-funding");
  allowance = await import("../../db/repositories/subscription-allowance");
  const pglite = client.getPgliteClientForTests();
  fixture = {
    exec: (query) => pglite.exec(query),
    query: <T extends Record<string, unknown>>(query: string, parameters?: unknown[]) =>
      pglite.query<T>(query, parameters),
  };
  const { createBillingSnapshotFixture } = await import(
    "../../db/repositories/account-billing-snapshot-test-fixture"
  );
  await createBillingSnapshotFixture((query) => fixture.exec(query), "");
  await fixture.exec(`
    ALTER TABLE credit_transactions ALTER COLUMN id SET DEFAULT gen_random_uuid();
    ALTER TABLE credit_transactions ADD COLUMN user_id uuid;
    ALTER TABLE credit_transactions ADD COLUMN description text;
    ALTER TABLE credit_transactions ADD COLUMN created_at timestamp DEFAULT now();
    ALTER TABLE credit_transactions ADD COLUMN settled_at timestamp;
    CREATE TABLE generations(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid, status text, metadata jsonb);
  `);
  // The shared fixture's historical period has already ended; retire it so
  // each test observes only the periods it seeds.
  await allowance.subscriptionAllowanceRepository.expireEndedPeriods();
}, 120_000);

afterAll(async () => {
  await client.closeDatabaseConnectionsForTests();
});

async function databaseNow(): Promise<Date> {
  const { rows } = await fixture.query<{ now: Date }>("SELECT now() AS now");
  return new Date(rows[0]!.now);
}

let seeded = 0;

/** Seeds one active Plus subscriber whose entitlement matches its derivation exactly. */
async function seedSubscriber(options: {
  periodStart: Date;
  periodEnd: Date;
  allowance: string;
  credits: string;
}) {
  seeded += 1;
  const suffix = seeded.toString(16).padStart(12, "0");
  const org = `71000000-0000-4000-8000-${suffix}`;
  const sub = `72000000-0000-4000-8000-${suffix}`;
  const digest = "c".repeat(64);
  await fixture.query(
    `INSERT INTO organizations(id, credit_balance, balance_revision, balance_decrease_revision,
       settings, is_active, auto_top_up_enabled, account_lifecycle_state)
     VALUES ($1, $2, 1, 0, '{}', true, false, 'active')`,
    [org, options.credits],
  );
  await fixture.query(
    `INSERT INTO billing_subscriptions(id, organization_id, provider_environment, stripe_customer_id,
       stripe_subscription_id, stripe_subscription_item_id, plan_key, catalog_version, status,
       current_period_start, current_period_end, lifecycle_revision, provider_object_digest)
     VALUES ($1, $2, 'test', $3, $4, $5, 'plus_monthly', 'v1', 'active', $6, $7, 1, $8)`,
    [
      sub,
      org,
      `cus_${suffix}`,
      `sub_${suffix}`,
      `si_${suffix}`,
      options.periodStart,
      options.periodEnd,
      digest,
    ],
  );
  await fixture.query(
    `INSERT INTO billing_subscription_revisions(organization_id, subscription_id, revision, source,
       provider_environment, stripe_customer_id, stripe_subscription_id, stripe_subscription_item_id,
       plan_key, catalog_version, status, current_period_start, current_period_end,
       cancel_at_period_end, provider_object_digest)
     VALUES ($1, $2, 1, 'webhook', 'test', $3, $4, $5, 'plus_monthly', 'v1', 'active', $6, $7, false, $8)`,
    [
      org,
      sub,
      `cus_${suffix}`,
      `sub_${suffix}`,
      `si_${suffix}`,
      options.periodStart,
      options.periodEnd,
      digest,
    ],
  );
  await fixture.query(
    `UPDATE organization_subscription_authorities SET subscription_id = $2, state = 'current'
     WHERE organization_id = $1`,
    [org, sub],
  );
  await fixture.query(
    `UPDATE organization_entitlements SET plan_key = 'plus_monthly', state = 'active',
       entitlement_effective = true, effective_from = $3, effective_until = $4,
       completions_rpm = 120, embeddings_rpm = 200, standard_rpm = 60, strict_rpm = 10,
       cloud_characters_ceiling = 5, agent_sandboxes_ceiling = 5, containers_ceiling = 1,
       storage_gib_ceiling = 5, apps_ceiling = 25, catalog_version = 'v1',
       source_digest = $5, source_subscription_id = $2, source_subscription_revision = 1,
       projection_revision = 1
     WHERE organization_id = $1`,
    [org, sub, options.periodStart, options.periodEnd, digest],
  );
  const { rows } = await fixture.query<{ id: string }>(
    `INSERT INTO subscription_allowance_periods(organization_id, subscription_id, subscription_revision,
       provider_environment, stripe_invoice_id, plan_key, catalog_version, period_start, period_end,
       expires_at, granted_amount, available_amount)
     VALUES ($1, $2, 1, 'test', $3, 'plus_monthly', 'v1', $4, $5, $5, $6, $6) RETURNING id`,
    [org, sub, `in_${suffix}`, options.periodStart, options.periodEnd, options.allowance],
  );
  return { org, sub, periodId: rows[0]!.id };
}

async function readState(org: string) {
  const [balance, periods, reservations, allocations, ledger] = await Promise.all([
    fixture.query<{ credit_balance: string }>(
      "SELECT credit_balance::text FROM organizations WHERE id = $1",
      [org],
    ),
    fixture.query<Record<string, string>>(
      `SELECT id, state, available_amount::text, reserved_amount::text, settled_amount::text,
         expired_amount::text FROM subscription_allowance_periods WHERE organization_id = $1
       ORDER BY period_start`,
      [org],
    ),
    fixture.query<Record<string, unknown>>(
      `SELECT logical_operation_id, status, expires_at, created_at FROM billing_funding_reservations
       WHERE organization_id = $1 ORDER BY created_at, id`,
      [org],
    ),
    fixture.query<Record<string, string>>(
      `SELECT source, reserved_amount::text, finalized_amount::text, released_amount::text,
         expired_refund_amount::text FROM billing_funding_allocations
       WHERE organization_id = $1 ORDER BY reservation_id, sequence`,
      [org],
    ),
    fixture.query<Record<string, string>>(
      `SELECT kind, amount::text FROM subscription_allowance_transactions
       WHERE organization_id = $1 ORDER BY allowance_period_id, sequence`,
      [org],
    ),
  ]);
  return {
    balance: balance.rows[0]!.credit_balance,
    periods: periods.rows,
    reservations: reservations.rows,
    allocations: allocations.rows,
    ledger: ledger.rows,
  };
}

describe("subscription allowance lifecycle", () => {
  test("a TTL reservation persists its own deadline and a stranded hold returns to its exact sources", async () => {
    const now = await databaseNow();
    const { org } = await seedSubscriber({
      periodStart: new Date(now.getTime() - 24 * HOUR),
      periodEnd: new Date(now.getTime() + 24 * HOUR),
      allowance: "1.000000",
      credits: "5.000000",
    });
    const reserved = await funding.subscriptionFundingService.reserve({
      organizationId: org,
      logicalOperationId: "inference-gate:stranded-request-0001",
      operation: "ai_inference",
      amount: "2.500000",
      description: "stranded inference",
      reservationTtlMs: 60_000,
    });
    const deadline =
      reserved.reservation.expires_at.getTime() - reserved.reservation.created_at.getTime();
    // The caller's TTL, not the period expiry a day away.
    expect(deadline).toBeGreaterThanOrEqual(59_000);
    expect(deadline).toBeLessThan(5 * 60_000);
    // A Dedicated window owns its own reconciliation and is never swept.
    await funding.subscriptionFundingService.reserve({
      organizationId: org,
      logicalOperationId: "compute.agent-owned-window-0001",
      operation: "managed_agent_compute",
      amount: "0.100000",
      description: "owned window",
      reservationTtlMs: 60_000,
    });
    const held = await readState(org);
    expect(held.balance).toBe("3.400000");
    expect(held.periods[0]).toMatchObject({
      available_amount: "0.000000",
      reserved_amount: "1.000000",
    });

    // Nothing is swept before its persisted deadline plus the margin.
    expect(await funding.subscriptionFundingService.sweepStaleReservations()).toMatchObject({
      canceled: 0,
    });
    await fixture.query(
      `UPDATE billing_funding_reservations SET created_at = now() - interval '3 hours',
         expires_at = now() - interval '2 hours' WHERE organization_id = $1`,
      [org],
    );
    const swept = await funding.subscriptionFundingService.sweepStaleReservations();
    expect(swept.canceled).toBe(1);
    const released = await readState(org);
    expect(released.balance).toBe("4.900000");
    expect(released.periods[0]).toMatchObject({
      available_amount: "1.000000",
      reserved_amount: "0.000000",
    });
    expect(
      released.reservations
        .map((row) => [row.logical_operation_id, row.status])
        .sort((left, right) => String(left[0]).localeCompare(String(right[0]))),
    ).toEqual([
      ["compute.agent-owned-window-0001", "reserved"],
      ["inference-gate:stranded-request-0001", "canceled"],
    ]);
    // Replaying the sweep neither refunds twice nor touches the owned window.
    expect(await funding.subscriptionFundingService.sweepStaleReservations()).toMatchObject({
      canceled: 0,
    });
    expect((await readState(org)).balance).toBe("4.900000");
    // The stranded owner can no longer settle a released hold.
    await expect(
      funding.subscriptionFundingService.settle({
        organizationId: org,
        logicalOperationId: "inference-gate:stranded-request-0001",
        operation: "ai_inference",
        actualAmount: "1.000000",
        occurredAt: reserved.reservation.created_at,
      }),
    ).rejects.toMatchObject({ code: "SUBSCRIPTION_ALLOWANCE_CONFLICT" });
  }, 60_000);

  test("an explicit cancellation is idempotent and releases allowance and cash once", async () => {
    const now = await databaseNow();
    const { org } = await seedSubscriber({
      periodStart: new Date(now.getTime() - HOUR),
      periodEnd: new Date(now.getTime() + 24 * HOUR),
      allowance: "0.250000",
      credits: "1.000000",
    });
    await funding.subscriptionFundingService.reserve({
      organizationId: org,
      logicalOperationId: "search:cancel-me-00000001",
      operation: "search",
      amount: "0.750000",
      description: "search hold",
      reservationTtlMs: 60_000,
    });
    const first = await funding.subscriptionFundingService.cancel({
      organizationId: org,
      logicalOperationId: "search:cancel-me-00000001",
      operation: "search",
      reason: "provider_failed",
    });
    const replay = await funding.subscriptionFundingService.cancel({
      organizationId: org,
      logicalOperationId: "search:cancel-me-00000001",
      operation: "search",
      reason: "provider_failed",
    });
    expect([first.replayed, replay.replayed]).toEqual([false, true]);
    expect([first.purchasedCreditRefunded, replay.purchasedCreditRefunded]).toEqual([true, false]);
    const state = await readState(org);
    expect(state.balance).toBe("1.000000");
    expect(state.periods[0]).toMatchObject({
      available_amount: "0.250000",
      reserved_amount: "0.000000",
    });
    await expect(
      funding.subscriptionFundingService.cancel({
        organizationId: org,
        logicalOperationId: "search:cancel-me-00000001",
        operation: "search",
        reason: "different_reason",
      }),
    ).rejects.toMatchObject({ code: funding.SUBSCRIPTION_FUNDING_REPLAY_CONFLICT });
  }, 60_000);

  test("a time-metered window straddling the period end funds the remainder from credits", async () => {
    const now = await databaseNow();
    const { org } = await seedSubscriber({
      periodStart: new Date(now.getTime() - 24 * HOUR),
      periodEnd: new Date(now.getTime() + HOUR / 2),
      allowance: "25.000000",
      credits: "5.000000",
    });
    const reserved = await helpers.writeTransaction((tx) =>
      funding.subscriptionFundingService.reserveInTransaction(tx, {
        organizationId: org,
        logicalOperationId: "compute.straddle-window-0001",
        operation: "managed_agent_compute",
        amount: "2.000000",
        description: "window straddling renewal",
        expiresAt: new Date(now.getTime() + 2 * HOUR),
        timeMeteredFrom: now,
      }),
    );
    // Only a quarter of the two-hour window lies inside the allowance period.
    expect(reserved.reservation.expires_at.getTime()).toBe(now.getTime() + 2 * HOUR);
    const state = await readState(org);
    expect(state.allocations).toEqual([
      expect.objectContaining({ source: "allowance", reserved_amount: "0.500000" }),
      expect.objectContaining({ source: "purchased_credit", reserved_amount: "1.500000" }),
    ]);
    expect(state.balance).toBe("3.500000");
    expect(
      funding.timeMeteredAllowanceCap({
        requestedAmount: "1.000000" as never,
        windowStart: new Date(0),
        windowEnd: new Date(3),
        allowanceExpiresAt: new Date(1),
      }),
    ).toBe("0.333333");
  }, 60_000);

  test("the expire job retires ended periods once and later settlements forfeit their remainder", async () => {
    const now = await databaseNow();
    const { org, periodId } = await seedSubscriber({
      periodStart: new Date(now.getTime() - 24 * HOUR),
      periodEnd: new Date(now.getTime() + 24 * HOUR),
      allowance: "4.000000",
      credits: "0.000000",
    });
    const reserved = await funding.subscriptionFundingService.reserve({
      organizationId: org,
      logicalOperationId: "inference-gate:settles-after-expiry-01",
      operation: "ai_inference",
      amount: "1.000000",
      description: "in flight at period end",
      reservationTtlMs: 60_000,
    });
    // The billing period ends while that request is still in flight.
    const ended = new Date(now.getTime() - 1_000);
    await fixture.query(
      `UPDATE subscription_allowance_periods SET period_end = $2, expires_at = $2 WHERE id = $1`,
      [periodId, ended],
    );
    const first = await allowance.subscriptionAllowanceRepository.expireEndedPeriods();
    expect(first).toMatchObject({ expired: 1, failed: 0, forfeitedAmount: "3.000000" });
    const second = await allowance.subscriptionAllowanceRepository.expireEndedPeriods();
    expect(second).toMatchObject({ scanned: 0, expired: 0 });
    await funding.subscriptionFundingService.settle({
      organizationId: org,
      logicalOperationId: "inference-gate:settles-after-expiry-01",
      operation: "ai_inference",
      actualAmount: "0.400000",
      occurredAt: reserved.reservation.created_at,
    });
    const state = await readState(org);
    expect(state.periods[0]).toMatchObject({
      state: "expired",
      available_amount: "0.000000",
      reserved_amount: "0.000000",
      settled_amount: "0.400000",
      expired_amount: "3.600000",
    });
    expect(state.ledger.map((row) => row.kind)).toEqual([
      "reserve",
      "expire",
      "finalize",
      "expired_refund",
    ]);
  }, 60_000);

  test("ex-subscribers fund allowance-eligible work from cash and can resubscribe mid-period", async () => {
    const now = await databaseNow();
    const periodStart = new Date(now.getTime() - 24 * HOUR);
    const periodEnd = new Date(now.getTime() + 24 * HOUR);
    const { org, sub, periodId } = await seedSubscriber({
      periodStart,
      periodEnd,
      allowance: "25.000000",
      credits: "3.000000",
    });
    const { subscriptionAuthorityRepository: authority } = await import(
      "../../db/repositories/subscription-authority"
    );
    const { subscriptionEntitlementsRepository: entitlements } = await import(
      "../../db/repositories/subscription-entitlements"
    );
    const current = await authority.findById(org, sub);
    if (!current) throw new Error("Missing seeded subscription");
    const { id, organization_id, lifecycle_revision, created_at, updated_at, ...values } = current;
    // A provider-side cancellation lands mid-period; the bucket is left open.
    const canceled = await authority.advance({
      organizationId: org,
      subscriptionId: sub,
      expectedRevision: lifecycle_revision,
      source: "webhook",
      observation: "authoritative_provider_retrieval",
      values: {
        ...values,
        status: "canceled",
        canceled_at: now,
        ended_at: now,
        provider_object_digest: "d".repeat(64),
      },
    });
    await entitlements.rebuild({
      organizationId: org,
      sourceSubscriptionId: sub,
      sourceSubscriptionRevision: canceled.subscription.lifecycle_revision,
      expectedProjectionRevision: 1,
    });

    // Cash-only, not a denial: Dedicated compute is admitted from credits.
    const cash = await helpers.writeTransaction((tx) =>
      funding.subscriptionFundingService.reserveInTransaction(tx, {
        organizationId: org,
        logicalOperationId: "compute.ex-subscriber-window-01",
        operation: "managed_agent_compute",
        amount: "1.000000",
        description: "ex-subscriber Dedicated window",
        reservationTtlMs: HOUR,
      }),
    );
    expect(cash.purchasedCreditDebited).toBe(true);
    let state = await readState(org);
    expect(state.balance).toBe("2.000000");
    expect(state.allocations).toEqual([
      expect.objectContaining({ source: "purchased_credit", reserved_amount: "1.000000" }),
    ]);
    expect(state.periods[0]).toMatchObject({ state: "open", available_amount: "25.000000" });

    // Resubscribing in the same period retires the terminal bucket and grants anew.
    const resub = "73000000-0000-4000-8000-000000000001";
    await fixture.query(
      `INSERT INTO billing_subscriptions(id, organization_id, provider_environment, stripe_customer_id,
         stripe_subscription_id, stripe_subscription_item_id, plan_key, catalog_version, status,
         current_period_start, current_period_end, lifecycle_revision, provider_object_digest)
       SELECT $1, organization_id, provider_environment, stripe_customer_id, 'sub_resubscribed',
         'si_resubscribed', 'plus_monthly', 'v1', 'active', $2, $3, 1, $4
       FROM billing_subscriptions WHERE id = $5`,
      [resub, now, new Date(now.getTime() + 30 * 24 * HOUR), "e".repeat(64), sub],
    );
    await fixture.query(
      `INSERT INTO billing_subscription_revisions(organization_id, subscription_id, revision, source,
         provider_environment, stripe_customer_id, stripe_subscription_id, stripe_subscription_item_id,
         plan_key, catalog_version, status, current_period_start, current_period_end,
         cancel_at_period_end, provider_object_digest)
       SELECT organization_id, id, 1, 'webhook', provider_environment, stripe_customer_id,
         stripe_subscription_id, stripe_subscription_item_id, plan_key, catalog_version, status,
         current_period_start, current_period_end, false, provider_object_digest
       FROM billing_subscriptions WHERE id = $1`,
      [resub],
    );
    const { billingSubscriptions } = await import("../../db/schemas/billing-subscriptions");
    const { eq } = await import("drizzle-orm");
    const { readPostLockDatabaseNow } = await import(
      "../../db/repositories/primary-database-clock"
    );
    const granted = await helpers.writeTransaction(async (tx) => {
      const [source] = await tx
        .select()
        .from(billingSubscriptions)
        .where(eq(billingSubscriptions.id, resub));
      return allowance.subscriptionAllowanceRepository.grantRenewalInTransaction(tx, {
        source: source!,
        invoiceId: "in_resubscribed",
        requestDigest: "f".repeat(64),
        databaseNow: await readPostLockDatabaseNow(tx),
      });
    });
    expect(granted.replayed).toBe(false);
    state = await readState(org);
    expect(state.periods).toEqual([
      expect.objectContaining({ id: periodId, state: "expired", available_amount: "0.000000" }),
      expect.objectContaining({
        id: granted.period.id,
        state: "open",
        available_amount: "25.000000",
      }),
    ]);
  }, 60_000);

  test("funding keys keep valid request ids and hash unsafe ones; inexact cash amounts are rejected", async () => {
    const { subscriptionFundingOperationKey } = await import("./allowance-first-credits");
    expect(await subscriptionFundingOperationKey("inference-gate:", "req_12345678")).toBe(
      "inference-gate:req_12345678",
    );
    const hashed = await subscriptionFundingOperationKey("inference-gate:", `${"x".repeat(200)} /`);
    expect(hashed).toMatch(/^inference-gate:sha256\.[0-9a-f]{64}$/);
    expect(await subscriptionFundingOperationKey("inference-gate:", `${"x".repeat(200)} /`)).toBe(
      hashed,
    );
    const now = await databaseNow();
    const { org } = await seedSubscriber({
      periodStart: new Date(now.getTime() - HOUR),
      periodEnd: new Date(now.getTime() + HOUR),
      allowance: "1.000000",
      credits: "0.000000",
    });
    await expect(
      funding.subscriptionFundingService.reserve({
        organizationId: org,
        logicalOperationId: "inference-gate:inexact-amount-0001",
        operation: "unclassified",
        amount: "9999999999.999999",
        description: "inexact",
        reservationTtlMs: 60_000,
      }),
    ).rejects.toMatchObject({ code: funding.SUBSCRIPTION_FUNDING_INVALID_AMOUNT });
  }, 60_000);

  test("request-scoped allowance-eligible spend is funded allowance-first for subscribers", async () => {
    const now = await databaseNow();
    const { org } = await seedSubscriber({
      periodStart: new Date(now.getTime() - HOUR),
      periodEnd: new Date(now.getTime() + 24 * HOUR),
      allowance: "0.300000",
      credits: "1.000000",
    });
    const {
      deductAllowanceEligibleCredits,
      isSubscriptionFundedReservation,
      reserveAllowanceEligibleCredits,
      settleSubscriptionFundedReservation,
    } = await import("./allowance-first-credits");
    const { InsufficientCreditsError } = await import("./credits");
    const { parseVideoPendingSettlement } = await import("./video-generation-reconcile");

    // A search hold draws allowance first and settles the actual cost.
    const search = await reserveAllowanceEligibleCredits("search", {
      organizationId: org,
      amount: 0.2,
      description: "search proxy",
      operationKey: { prefix: "search:", identity: "request-search-000001" },
    });
    expect(isSubscriptionFundedReservation(search)).toBe(true);
    expect(await search.reconcile(0.15)).toMatchObject({
      collectedAmount: 0.15,
      adjustmentType: "refund",
    });
    // An immediate charge spends the remaining allowance, then cash.
    const deducted = await deductAllowanceEligibleCredits("search", {
      organizationId: org,
      amount: 0.25,
      description: "dexscreener request",
      operationKey: { prefix: "search:", identity: "request-dex-0000001" },
    });
    expect(deducted).toMatchObject({ success: true, newBalance: 0.9 });
    let state = await readState(org);
    expect(state.periods[0]).toMatchObject({
      available_amount: "0.000000",
      settled_amount: "0.300000",
    });
    expect(state.balance).toBe("0.900000");

    // A shortfall keeps the credit lane's typed contract, reporting both sources.
    await expect(
      reserveAllowanceEligibleCredits("voice", {
        organizationId: org,
        amount: 5,
        description: "meeting window",
        operationKey: { prefix: "voice:", identity: "meeting-window-00001" },
      }),
    ).rejects.toBeInstanceOf(InsufficientCreditsError);

    // A pending video hold carries its funding identity to the reconcile sweep.
    const video = await reserveAllowanceEligibleCredits("media_generation", {
      organizationId: org,
      amount: 0.5,
      description: "pending video",
      operationKey: { prefix: "video:", identity: "upstream-job-000001" },
    });
    if (!isSubscriptionFundedReservation(video)) throw new Error("Expected a funded hold");
    const pending = parseVideoPendingSettlement({
      settlement_marker: "video_pending_settlement_v1",
      reservation_transaction_id: video.reservationTransactionId,
      reserved_amount: video.reservedAmount,
      billed_cost: 0.5,
      billing_source: "fal",
      funding: {
        logical_operation_id: video.funding.logicalOperationId,
        operation: video.funding.operation,
        occurred_at: video.funding.occurredAt.toISOString(),
      },
    });
    expect(pending?.funding?.logical_operation_id).toBe("video:upstream-job-000001");
    // A verified upstream failure releases the whole hold to purchased credit.
    await settleSubscriptionFundedReservation({
      organizationId: org,
      logicalOperationId: pending!.funding!.logical_operation_id,
      operation: pending!.funding!.operation,
      actualCost: 0,
      occurredAt: new Date(pending!.funding!.occurred_at),
    });
    state = await readState(org);
    expect(state.balance).toBe("0.900000");
  }, 60_000);

  test("a policy-generation bump repairs the admission snapshot and the tier cache", async () => {
    const now = await databaseNow();
    const { org } = await seedSubscriber({
      periodStart: new Date(now.getTime() - HOUR),
      periodEnd: new Date(now.getTime() + 24 * HOUR),
      allowance: "1.000000",
      credits: "1.000000",
    });
    const { cache } = await import("../cache/client");
    const { CacheKeys } = await import("../cache/keys");
    const snapshots = await import("./inference-admission-snapshot");
    const { admitOrganizationInference, InferenceAdmissionUnavailableError } = await import(
      "./organization-inference-admission"
    );
    const { getOrgTier } = await import("./org-rate-limits");
    const { advanceOrganizationPolicyGeneration } = await import(
      "../../db/repositories/organization-policy-generation"
    );
    const stale = await snapshots.warmInferenceAdmissionSnapshot(org);
    const staleTier = await getOrgTier(org);
    expect(staleTier.authority.generation).toBe(stale.authority.generation);

    // Renewal, cancellation and overrides all advance the policy generation.
    await helpers.writeTransaction((tx) =>
      advanceOrganizationPolicyGeneration(tx, {
        organizationId: org,
        reason: "entitlement",
        actor: "system:test",
        change: { projectionRevision: 2 },
      }),
    );
    const next = (BigInt(stale.authority.generation) + 1n).toString();

    // The stale snapshot still fails its request closed, but the shared
    // projection is republished at once instead of waiting out its TTL.
    await expect(
      admitOrganizationInference({
        context: {
          organizationId: org,
          userId: "74000000-0000-4000-8000-000000000001",
          model: "gpt-4o-mini",
          provider: "openai",
          billingSource: "gateway",
          requestId: "req_stale_snapshot_0001",
        },
        estimatedInputTokens: 1,
        estimatedOutputTokens: 1,
        admissionSnapshot: stale,
      }),
    ).rejects.toBeInstanceOf(InferenceAdmissionUnavailableError);
    const republished = await cache.get<{ authority: { generation: string } }>(
      CacheKeys.inference.orgAdmission(org),
    );
    expect(republished?.authority.generation).toBe(next);

    // The display tier cache is rebuilt once its stamp is older than the generation.
    expect((await getOrgTier(org)).authority.generation).toBe(next);
  }, 60_000);
});
