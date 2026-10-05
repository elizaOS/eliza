/**
 * Proves deferred subscriber inference funding against real subscription
 * migrations on PGlite: funding capacity is purchased credit plus spendable
 * allowance at the organization balance revision, allowance-only spend advances
 * that revision (migration 0491), settlement funds allowance first then
 * purchased credit and never overdraws, the post-accounting capacity comes from
 * the funding transaction itself, alarm recovery replays live settlement, and a
 * pinned affiliate payout commits in the same transaction as the funded debit.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

process.env.DATABASE_URL = "pglite://memory";
process.env.TEST_DATABASE_URL = process.env.DATABASE_URL;
process.env.ENVIRONMENT = "local";
process.env.MOCK_REDIS = "1";

let client: typeof import("../../db/client");
let helpers: typeof import("../../db/helpers");
let allowance: typeof import("../../db/repositories/subscription-allowance");
let subscriber: typeof import("./subscriber-inference-funding");
let allowanceFirst: typeof import("./allowance-first-credits");
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
  allowance = await import("../../db/repositories/subscription-allowance");
  subscriber = await import("./subscriber-inference-funding");
  allowanceFirst = await import("./allowance-first-credits");
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
  // Production revision authority: purchased-credit changes (0177) and
  // platform allowance changes (0491) advance the organization revision.
  for (const name of [
    "0177_organization_balance_revision.sql",
    "0491_allowance_advances_balance_revision.sql",
    "0493_zero_collected_inference_receipts.sql",
    "0179_affiliate_payout_outbox.sql",
  ]) {
    const migration = await readFile(
      new URL(`../../db/migrations/${name}`, import.meta.url),
      "utf8",
    );
    for (const statement of migration.split("--> statement-breakpoint")) {
      if (statement.trim()) await fixture.exec(statement);
    }
  }
  // The shared fixture's historical period has already ended; retire it so
  // each test observes only the periods it seeds.
  await allowance.subscriptionAllowanceRepository.expireEndedPeriods();
  await fixture.query("INSERT INTO users(id) VALUES ($1) ON CONFLICT DO NOTHING", [
    AFFILIATE.affiliateUserId,
  ]);
}, 120_000);

const AFFILIATE = {
  affiliateCodeId: "73000000-0000-4000-8000-000000000001",
  affiliateUserId: "74000000-0000-4000-8000-000000000001",
  affiliateCode: "PARTNER",
  markupPercent: 0.2,
};

async function payoutsFor(sourceId: string) {
  const { rows } = await fixture.query<{ amount: string; metadata: Record<string, unknown> }>(
    "SELECT amount::text, metadata FROM affiliate_payout_outbox WHERE source_id = $1",
    [sourceId],
  );
  return rows;
}

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

async function revisionOf(org: string): Promise<bigint> {
  const { rows } = await fixture.query<{ revision: string }>(
    "SELECT balance_revision::text AS revision FROM organizations WHERE id = $1",
    [org],
  );
  return BigInt(rows[0]!.revision);
}

async function readCapacity(org: string) {
  return await helpers.writeTransaction((tx) =>
    subscriber.readSubscriberFundingCapacityInTransaction(tx, org),
  );
}

function charge(org: string, requestId: string, amountUsd: number) {
  return {
    organizationId: org,
    requestId,
    userId: "00000000-0000-4000-8000-000000000009",
    model: "gpt-oss-120b",
    provider: "cerebras",
    billingSource: "cerebras",
    description: "Deferred subscriber inference",
    amountUsd,
  };
}

describe("deferred subscriber inference funding", () => {
  test("capacity is purchased credit plus spendable allowance at the balance revision", async () => {
    const now = await databaseNow();
    const { org } = await seedSubscriber({
      periodStart: new Date(now.getTime() - 24 * HOUR),
      periodEnd: new Date(now.getTime() + 24 * HOUR),
      allowance: "2.000000",
      credits: "3.000000",
    });
    const capacity = await readCapacity(org);
    expect(capacity.balanceUsd).toBeCloseTo(5, 6);
    expect(BigInt(capacity.balanceRevision)).toBe(await revisionOf(org));
  });

  test("an allowance-only charge advances the revision and reports post-accounting capacity without a readback", async () => {
    const now = await databaseNow();
    const { org } = await seedSubscriber({
      periodStart: new Date(now.getTime() - 24 * HOUR),
      periodEnd: new Date(now.getTime() + 24 * HOUR),
      allowance: "2.000000",
      credits: "3.000000",
    });
    const before = await revisionOf(org);
    const funded = await subscriber.fundSubscriberInferenceCharge(
      charge(org, "subscriber-allowance-0001", 0.5),
    );
    expect(funded.reconciliation).toMatchObject({
      actualCost: 0.5,
      collectedAmount: 0.5,
      adjustmentType: "none",
    });
    // Purchased credit is untouched, yet the capacity revision moved: the
    // gate must observe allowance spend as a newer balance.
    const state = await readState(org);
    expect(state.balance).toBe("3.000000");
    expect(state.periods[0]).toMatchObject({
      available_amount: "1.500000",
      settled_amount: "0.500000",
    });
    const after = await revisionOf(org);
    expect(after > before).toBe(true);
    expect(funded.capacity).toEqual({ balanceUsd: 4.5, balanceRevision: after.toString() });
  });

  test("allowance is spent first, purchased credit funds the remainder, and a shortfall is uncollected", async () => {
    const now = await databaseNow();
    const { org } = await seedSubscriber({
      periodStart: new Date(now.getTime() - 24 * HOUR),
      periodEnd: new Date(now.getTime() + 24 * HOUR),
      allowance: "1.000000",
      credits: "1.000000",
    });
    const split = await subscriber.fundSubscriberInferenceCharge(
      charge(org, "subscriber-split-0001", 1.25),
    );
    expect(split.reconciliation).toMatchObject({ collectedAmount: 1.25, adjustmentType: "none" });
    const afterSplit = await readState(org);
    expect(afterSplit.balance).toBe("0.750000");
    expect(afterSplit.periods[0]).toMatchObject({ available_amount: "0.000000" });
    expect(split.capacity.balanceUsd).toBeCloseTo(0.75, 6);

    // Concurrent non-inference spend can exhaust capacity after admission;
    // settlement collects what exists and never overdraws.
    const short = await subscriber.fundSubscriberInferenceCharge(
      charge(org, "subscriber-short-0001", 2),
    );
    expect(short.reconciliation).toMatchObject({
      actualCost: 2,
      collectedAmount: 0.75,
      adjustmentType: "uncollected_overage",
    });
    expect((await readState(org)).balance).toBe("0.000000");
    expect(short.capacity.balanceUsd).toBe(0);
  });

  test("alarm recovery replays the live settlement instead of funding the estimate again", async () => {
    const now = await databaseNow();
    const { org } = await seedSubscriber({
      periodStart: new Date(now.getTime() - 24 * HOUR),
      periodEnd: new Date(now.getTime() + 24 * HOUR),
      allowance: "0.200000",
      credits: "5.000000",
    });
    const live = await subscriber.fundSubscriberInferenceCharge(
      charge(org, "subscriber-replay-0001", 0.4),
    );
    expect(live.reconciliation.collectedAmount).toBe(0.4);
    const settled = await readState(org);
    // The recovery lane charges the larger lease estimate under the same key.
    const replay = await subscriber.fundSubscriberInferenceCharge(
      charge(org, "subscriber-replay-0001", 1.5),
    );
    expect(replay.reconciliation).toMatchObject({
      collectedAmount: 0.4,
      adjustmentType: "uncollected_overage",
    });
    const replayed = await readState(org);
    expect(replayed.balance).toBe(settled.balance);
    expect(replayed.periods).toEqual(settled.periods);
    expect(replayed.reservations).toEqual(settled.reservations);
    expect(replay.capacity).toEqual(live.capacity);
  });

  test("a zero-collected live settlement cannot debit a larger recovery estimate after top-up", async () => {
    const now = await databaseNow();
    const { org } = await seedSubscriber({
      periodStart: new Date(now.getTime() - 24 * HOUR),
      periodEnd: new Date(now.getTime() + 24 * HOUR),
      allowance: "0.200000",
      credits: "0.300000",
    });
    await subscriber.fundSubscriberInferenceCharge(charge(org, "subscriber-drain-zero-0001", 0.5));
    const [live, concurrent] = await Promise.all([
      subscriber.fundSubscriberInferenceCharge(charge(org, "subscriber-zero-replay-0001", 0.4)),
      subscriber.fundSubscriberInferenceCharge(charge(org, "subscriber-zero-replay-0001", 0.4)),
    ]);
    expect(concurrent.reconciliation).toEqual(live.reconciliation);
    expect(live.reconciliation).toMatchObject({
      actualCost: 0.4,
      collectedAmount: 0,
      adjustmentType: "uncollected_overage",
    });
    const { rows: receipts } = await fixture.query<{
      status: string;
      requested: string;
      reserved: string;
      uncollected: string;
    }>(
      "SELECT status, requested_amount::text AS requested, reserved_amount::text AS reserved, uncollected_overage_amount::text AS uncollected FROM billing_funding_reservations WHERE organization_id = $1 AND logical_operation_id = $2",
      [org, "inference-gate:subscriber-zero-replay-0001"],
    );
    expect(receipts).toEqual([
      { status: "finalized", requested: "0.000000", reserved: "0.000000", uncollected: "0.400000" },
    ]);
    await expect(
      fixture.query(
        "UPDATE billing_funding_reservations SET status = 'reserved', finalized_at = NULL, settlement_key = NULL, settlement_digest = NULL, uncollected_overage_amount = 0 WHERE organization_id = $1 AND logical_operation_id = $2",
        [org, "inference-gate:subscriber-zero-replay-0001"],
      ),
    ).rejects.toThrow("billing_funding_reservations_amount_check");
    await expect(
      fixture.query(
        "UPDATE billing_funding_reservations SET status = 'canceled', finalized_at = NULL, settlement_key = NULL, settlement_digest = NULL, cancellation_key = 'zero-cancel-test', cancellation_digest = repeat('a', 64), canceled_at = now(), uncollected_overage_amount = 0 WHERE organization_id = $1 AND logical_operation_id = $2",
        [org, "inference-gate:subscriber-zero-replay-0001"],
      ),
    ).rejects.toThrow("billing_funding_reservations_amount_check");
    // A lost gate-settlement response leaves the original $1.50 lease for alarm
    // recovery. The later top-up must not turn the completed $0.40 operation
    // into a new debit at that larger estimate.
    await fixture.query(
      "UPDATE organizations SET credit_balance = credit_balance + 2 WHERE id = $1",
      [org],
    );
    const beforeReplay = await readState(org);
    const replay = await subscriber.fundSubscriberInferenceCharge(
      charge(org, "subscriber-zero-replay-0001", 1.5),
    );
    expect(replay.reconciliation).toEqual(live.reconciliation);
    expect(await readState(org)).toEqual(beforeReplay);
  });

  test("an affiliate payout commits with the funded debit and pays only collected markup", async () => {
    const now = await databaseNow();
    const { org } = await seedSubscriber({
      periodStart: new Date(now.getTime() - 24 * HOUR),
      periodEnd: new Date(now.getTime() + 24 * HOUR),
      allowance: "0.500000",
      credits: "1.000000",
    });
    const fullSource = "ai_billing:affiliate:subscriber-affiliate-0001";
    // $1.00 pre-affiliate cost at a 20% markup is a $1.20 charge.
    const full = await subscriber.fundSubscriberInferenceCharge({
      ...charge(org, "subscriber-affiliate-0001", 1.2),
      affiliatePayout: { attribution: AFFILIATE, sourceId: fullSource },
    });
    expect(full.reconciliation).toMatchObject({ collectedAmount: 1.2, adjustmentType: "none" });
    const [payout] = await payoutsFor(fullSource);
    expect(payout?.amount).toBe("0.2000");
    expect(payout?.metadata).toMatchObject({
      affiliateCodeId: AFFILIATE.affiliateCodeId,
      actualTotalCost: "1.200000",
      collectedTotalCost: "1.200000",
    });

    // Alarm recovery replays under the same key with a larger estimate: the
    // debit and the payout both stay exactly as the live settlement wrote them.
    const replay = await subscriber.fundSubscriberInferenceCharge({
      ...charge(org, "subscriber-affiliate-0001", 3),
      affiliatePayout: { attribution: AFFILIATE, sourceId: fullSource },
    });
    expect(replay.capacity).toEqual(full.capacity);
    expect(await payoutsFor(fullSource)).toEqual([payout!]);

    // Only $0.30 of capacity remains; the $1.20 charge collects $0.30, which
    // does not cover the $1.00 pre-affiliate cost, so no markup was collected.
    const shortSource = "ai_billing:affiliate:subscriber-affiliate-0002";
    const short = await subscriber.fundSubscriberInferenceCharge({
      ...charge(org, "subscriber-affiliate-0002", 1.2),
      affiliatePayout: { attribution: AFFILIATE, sourceId: shortSource },
    });
    expect(short.reconciliation).toMatchObject({
      collectedAmount: 0.3,
      adjustmentType: "uncollected_overage",
    });
    expect(await payoutsFor(shortSource)).toEqual([]);
  });

  test("the synchronous subscriber reservation enqueues its pinned affiliate payout on settlement", async () => {
    const now = await databaseNow();
    const { org } = await seedSubscriber({
      periodStart: new Date(now.getTime() - 24 * HOUR),
      periodEnd: new Date(now.getTime() + 24 * HOUR),
      allowance: "1.000000",
      credits: "1.000000",
    });
    const sourceId = "ai_billing:affiliate:subscriber-affiliate-sync-0001";
    const reservation = await allowanceFirst.reserveSubscriptionFundedCredits({
      organizationId: org,
      operation: "ai_inference",
      logicalOperationId: "inference-gate:subscriber-affiliate-sync-0001",
      amount: "1.800000",
      description: "Synchronous subscriber inference",
      metadata: {
        affiliatePayout: { version: 1, sourceId, attribution: AFFILIATE, model: "gpt-oss-120b" },
      },
    });
    await reservation.reconcile(1.2);
    await reservation.reconcile(1.2);
    const payouts = await payoutsFor(sourceId);
    expect(payouts.map((row) => row.amount)).toEqual(["0.2000"]);
  });

  test("a published admission snapshot carries subscriber capacity and hold state at one revision", async () => {
    const now = await databaseNow();
    const { org } = await seedSubscriber({
      periodStart: new Date(now.getTime() - 24 * HOUR),
      periodEnd: new Date(now.getTime() + 24 * HOUR),
      allowance: "2.000000",
      credits: "3.000000",
    });
    const { withOrganizationPolicyAdmission } = await import("./organization-policy-admission");
    const { inferenceAdmissionSnapshotInTransaction } = await import(
      "./inference-admission-snapshot"
    );
    const publish = () =>
      withOrganizationPolicyAdmission(org, undefined, (policy, tx) =>
        inferenceAdmissionSnapshotInTransaction(tx, org, policy),
      );
    const snapshot = await publish();
    const revision = (await revisionOf(org)).toString();
    expect(snapshot).toMatchObject({
      subscriptionFunded: true,
      billingHold: false,
      balance: { balanceUsd: 3, balanceRevision: revision },
      funding: { balanceUsd: 5, balanceRevision: revision },
    });

    // A payment-reversal hold is published so snapshot admission cannot
    // bypass the primary's hold check.
    await fixture.query(
      `INSERT INTO organization_payment_reversal_holds(organization_id, reason, stripe_dispute_id,
         stripe_charge_id, amount_cents)
       VALUES ($1, 'chargeback_lost', 'dp_snapshot_hold', 'ch_snapshot_hold', 100)`,
      [org],
    );
    expect(await publish()).toMatchObject({ billingHold: true });
  });

  test("an ex-subscriber's lapsed allowance is not counted as capacity", async () => {
    const now = await databaseNow();
    const { org, sub } = await seedSubscriber({
      periodStart: new Date(now.getTime() - 24 * HOUR),
      periodEnd: new Date(now.getTime() + 24 * HOUR),
      allowance: "4.000000",
      credits: "1.000000",
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
    const capacity = await readCapacity(org);
    expect(capacity.balanceUsd).toBeCloseTo(1, 6);
    const funded = await subscriber.fundSubscriberInferenceCharge(
      charge(org, "subscriber-lapsed-0001", 0.25),
    );
    expect(funded.reconciliation.collectedAmount).toBe(0.25);
    const state = await readState(org);
    expect(state.balance).toBe("0.750000");
    expect(state.periods[0]).toMatchObject({ available_amount: "4.000000" });
  });
});
