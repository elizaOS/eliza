/**
 * Proves deferred subscriber inference funding against real subscription
 * migrations on PGlite: funding capacity is purchased credit plus spendable
 * allowance at the organization balance revision, allowance-only spend advances
 * that revision (migration 0491), settlement funds allowance first then
 * purchased credit and never overdraws, the post-accounting capacity comes from
 * the funding transaction itself, and alarm recovery replays live settlement.
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
    ALTER TABLE credit_transactions ADD COLUMN stripe_payment_intent_id text UNIQUE;
    ALTER TABLE credit_transactions ADD COLUMN created_at timestamp DEFAULT now();
    ALTER TABLE credit_transactions ADD COLUMN settled_at timestamp;
    CREATE TABLE generations(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid, status text, metadata jsonb);
  `);
  // Production revision authority: purchased-credit changes (0177) and
  // platform allowance changes (0491) advance the organization revision.
  for (const name of [
    "0177_organization_balance_revision.sql",
    "0491_allowance_advances_balance_revision.sql",
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
