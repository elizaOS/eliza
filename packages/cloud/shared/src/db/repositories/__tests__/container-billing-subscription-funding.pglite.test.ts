/**
 * Proves container compute and deployment charges fund Plus/Pro subscribers
 * allowance-first (after pay-as-you-go earnings) against the real container
 * billing writer, funding service, and subscription migrations on PGlite,
 * while organizations without a subscription keep the purchased-credit lane.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { pushSchema } from "drizzle-kit/api";
import { eq, sql } from "drizzle-orm";
import { pgTable, primaryKey, uuid } from "drizzle-orm/pg-core";

process.env.DATABASE_URL = "pglite://memory";
process.env.TEST_DATABASE_URL = "pglite://memory";
process.env.NODE_ENV ||= "test";

import { closeDatabaseConnectionsForTests, dbWrite, getPgliteClientForTests } from "../../client";
import { agentSandboxes } from "../../schemas/agent-sandboxes";
import { apiKeys } from "../../schemas/api-keys";
import { computeBillingRateSegments } from "../../schemas/compute-billing-rate-segments";
import { containerBillingRecords, containers } from "../../schemas/containers";
import { creditTransactions } from "../../schemas/credit-transactions";
import { organizationPaymentReversalHolds } from "../../schemas/organization-payment-reversal-holds";
import { organizations } from "../../schemas/organizations";
import {
  earningsSourceEnum,
  ledgerEntryTypeEnum,
  redeemableEarnings,
  redeemableEarningsLedger,
} from "../../schemas/redeemable-earnings";
import { userCharacters } from "../../schemas/user-characters";
import { users } from "../../schemas/users";
import { containerBillingRepository } from "../container-billing";
import { containersRepository } from "../containers";
import { installOrganizationPolicyTestSchema } from "../organization-policy-test-fixture";
import { subscriptionEntitlementsRepository } from "../subscription-entitlements";

const PGLITE_TIMEOUT = 60_000;
const HOUR_MS = 60 * 60 * 1000;
const DIGEST = "d".repeat(64);

/** Lets the Drizzle push resolve the receipt FK; the real table replaces it below. */
const fundingReservationReceiptTarget = pgTable(
  "billing_funding_reservations",
  { id: uuid("id").notNull(), organization_id: uuid("organization_id").notNull() },
  (table) => ({ pk: primaryKey({ columns: [table.id, table.organization_id] }) }),
);

const exec = (query: string) => getPgliteClientForTests().exec(query);
async function rows<T>(query: string, parameters: unknown[] = []): Promise<T[]> {
  return (await getPgliteClientForTests().query<T>(query, parameters)).rows;
}

beforeAll(async () => {
  const { apply } = await pushSchema(
    {
      organizations,
      users,
      userCharacters,
      agentSandboxes,
      apiKeys,
      creditTransactions,
      organizationPaymentReversalHolds,
      computeBillingRateSegments,
      containers,
      containerBillingRecords,
      fundingReservationReceiptTarget,
      earningsSourceEnum,
      ledgerEntryTypeEnum,
      redeemableEarnings,
      redeemableEarningsLedger,
    } as never,
    dbWrite as never,
  );
  await apply();
  await exec("DROP TABLE billing_funding_reservations CASCADE");
  await installOrganizationPolicyTestSchema(exec);
  await exec(
    await readFile(
      new URL("../../migrations/0483_container_billing_funding_reservations.sql", import.meta.url),
      "utf8",
    ),
  );
  // Replaying the migration must be a no-op.
  await exec(
    await readFile(
      new URL("../../migrations/0483_container_billing_funding_reservations.sql", import.meta.url),
      "utf8",
    ),
  );
  await exec(`CREATE TABLE jobs (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      type text NOT NULL,
      organization_id uuid NOT NULL,
      data jsonb NOT NULL,
      data_storage text NOT NULL DEFAULT 'inline',
      data_key text
    );
    CREATE TABLE container_compute_stop_intents (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      organization_id uuid NOT NULL,
      container_id uuid NOT NULL,
      lifecycle_revision bigint NOT NULL,
      "authorization" text NOT NULL DEFAULT 'billing_request',
      status text NOT NULL DEFAULT 'pending',
      job_id uuid REFERENCES jobs(id) ON DELETE SET NULL,
      provider_confirmed_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );`);
}, PGLITE_TIMEOUT);

afterAll(async () => {
  await closeDatabaseConnectionsForTests();
});

async function seedOrganization(params: {
  creditBalance: string;
  allowance?: string;
  payAsYouGoFromEarnings?: boolean;
  earnings?: string;
}) {
  const [org] = await dbWrite
    .insert(organizations)
    .values({
      name: "Container Subscriber",
      slug: `container-sub-${crypto.randomUUID()}`,
      credit_balance: params.creditBalance,
      pay_as_you_go_from_earnings: params.payAsYouGoFromEarnings ?? false,
    })
    .returning();
  const [user] = await dbWrite
    .insert(users)
    .values({ steward_user_id: `steward-${crypto.randomUUID()}`, organization_id: org.id })
    .returning();
  if (params.earnings) {
    await dbWrite.insert(redeemableEarnings).values({
      user_id: user.id,
      total_earned: params.earnings,
      available_balance: params.earnings,
    });
  }
  if (params.allowance !== undefined) {
    const subscriptionId = crypto.randomUUID();
    const tag = subscriptionId.slice(0, 8);
    const periodStart = new Date(Date.now() - 24 * HOUR_MS).toISOString();
    const periodEnd = new Date(Date.now() + 29 * 24 * HOUR_MS).toISOString();
    await exec(`
      INSERT INTO billing_subscriptions(id, organization_id, provider_environment, stripe_customer_id, stripe_subscription_id, stripe_subscription_item_id, plan_key, catalog_version, status, current_period_start, current_period_end, lifecycle_revision, provider_object_digest)
      VALUES('${subscriptionId}', '${org.id}', 'test', 'cus_${tag}', 'sub_${tag}', 'si_${tag}', 'plus_monthly', 'v1', 'active', '${periodStart}', '${periodEnd}', 1, '${DIGEST}');
      INSERT INTO billing_subscription_revisions(organization_id, subscription_id, revision, source, provider_environment, stripe_customer_id, stripe_subscription_id, stripe_subscription_item_id, plan_key, catalog_version, status, current_period_start, current_period_end, cancel_at_period_end, provider_object_digest)
      VALUES('${org.id}', '${subscriptionId}', 1, 'webhook', 'test', 'cus_${tag}', 'sub_${tag}', 'si_${tag}', 'plus_monthly', 'v1', 'active', '${periodStart}', '${periodEnd}', false, '${DIGEST}');
      UPDATE organization_subscription_authorities SET subscription_id = '${subscriptionId}', state = 'current' WHERE organization_id = '${org.id}';`);
    await subscriptionEntitlementsRepository.rebuild({
      organizationId: org.id,
      sourceSubscriptionId: subscriptionId,
      sourceSubscriptionRevision: 1,
      expectedProjectionRevision: 0,
    });
    await exec(`
      INSERT INTO subscription_allowance_periods(organization_id, subscription_id, subscription_revision, provider_environment, stripe_invoice_id, plan_key, catalog_version, period_start, period_end, expires_at, granted_amount, available_amount)
      VALUES('${org.id}', '${subscriptionId}', 1, 'test', 'in_${tag}', 'plus_monthly', 'v1', '${periodStart}', '${periodEnd}', '${periodEnd}', '${params.allowance}', '${params.allowance}');`);
  }
  return { org, user };
}

/** A running container whose elapsed period costs exactly `hours * 0.100000`. */
async function seedRunningContainer(organizationId: string, userId: string, hours: number) {
  const containerId = crypto.randomUUID();
  const periodStart = new Date(Date.now() - 48 * HOUR_MS);
  await dbWrite.insert(containers).values({
    id: containerId,
    organization_id: organizationId,
    user_id: userId,
    name: `container-${containerId.slice(0, 8)}`,
    project_name: `container-${containerId.slice(0, 8)}`,
    status: "running",
    billing_status: "active",
    last_billed_at: periodStart,
    next_billing_at: new Date(0),
    created_at: periodStart,
    updated_at: periodStart,
  });
  await dbWrite.insert(computeBillingRateSegments).values({
    organization_id: organizationId,
    workload_kind: "container",
    workload_id: containerId,
    lifecycle_revision: 0,
    billing_state: "running",
    rate_per_hour: "0.100000",
    effective_at: periodStart,
  });
  return { containerId, periodStart, now: new Date(periodStart.getTime() + hours * HOUR_MS) };
}

function billingInput(
  seeded: { org: { id: string }; user: { id: string } },
  container: { containerId: string; now: Date },
  earningsSourceUserId: string | null = null,
) {
  return {
    containerId: container.containerId,
    organizationId: seeded.org.id,
    userId: seeded.user.id,
    containerName: "funded-container",
    dailyRate: 2.4,
    earningsSourceUserId,
    payAsYouGoFromEarnings: earningsSourceUserId !== null,
    newBalance: 0,
    now: container.now,
  };
}

async function fundingState(organizationId: string) {
  const [state] = await rows<{
    credit_balance: string;
    allowance_available: string | null;
    allowance_settled: string | null;
    reservations: number;
    debits: number;
  }>(
    `SELECT o.credit_balance::text AS credit_balance,
      (SELECT available_amount::text FROM subscription_allowance_periods WHERE organization_id=o.id) AS allowance_available,
      (SELECT settled_amount::text FROM subscription_allowance_periods WHERE organization_id=o.id) AS allowance_settled,
      (SELECT count(*)::integer FROM billing_funding_reservations WHERE organization_id=o.id) AS reservations,
      (SELECT count(*)::integer FROM credit_transactions WHERE organization_id=o.id AND type='debit') AS debits
    FROM organizations o WHERE o.id=$1`,
    [organizationId],
  );
  return state;
}

async function receipts(containerId: string) {
  return await dbWrite
    .select()
    .from(containerBillingRecords)
    .where(eq(containerBillingRecords.container_id, containerId));
}

describe("container compute allowance-first funding", () => {
  test("a subscriber's charge is funded from the allowance without a purchased debit", async () => {
    const seeded = await seedOrganization({ creditBalance: "5.000000", allowance: "10.000000" });
    const container = await seedRunningContainer(seeded.org.id, seeded.user.id, 10);

    const result = await containerBillingRepository.recordSuccessfulDailyBilling(
      billingInput(seeded, container),
    );

    expect(result).toMatchObject({
      alreadyBilled: false,
      insufficient: false,
      amount: 1,
      fromEarnings: 0,
      fromAllowance: 1,
      allowanceRemaining: 9,
      newBalance: 5,
      transactionId: null,
      creditCachesStale: false,
    });
    expect(await fundingState(seeded.org.id)).toEqual({
      credit_balance: "5.000000",
      allowance_available: "9.000000",
      allowance_settled: "1.000000",
      reservations: 1,
      debits: 0,
    });
    const [receipt] = await receipts(container.containerId);
    expect(receipt).toMatchObject({
      status: "success",
      amount: "1.000000",
      credit_transaction_id: null,
      funding_reservation_id: result.fundingReservationId,
    });
    const [reservation] = await rows<{ status: string; logical_operation_id: string }>(
      "SELECT status, logical_operation_id FROM billing_funding_reservations WHERE id=$1",
      [result.fundingReservationId],
    );
    expect(reservation).toEqual({
      status: "finalized",
      logical_operation_id: `container.${container.containerId}.${container.periodStart.getTime()}`,
    });

    const replay = await containerBillingRepository.recordSuccessfulDailyBilling(
      billingInput(seeded, container),
    );
    expect(replay).toMatchObject({ alreadyBilled: true, amount: 0 });
    expect((await fundingState(seeded.org.id)).reservations).toBe(1);
  });

  test("allowance and purchased credits split one charge when neither covers it alone", async () => {
    const seeded = await seedOrganization({ creditBalance: "0.700000", allowance: "0.400000" });
    const container = await seedRunningContainer(seeded.org.id, seeded.user.id, 10);

    const result = await containerBillingRepository.recordSuccessfulDailyBilling(
      billingInput(seeded, container),
    );

    expect(result).toMatchObject({
      insufficient: false,
      amount: 1,
      fromAllowance: 0.4,
      allowanceRemaining: 0,
      newBalance: 0.1,
      creditCachesStale: true,
    });
    expect(await fundingState(seeded.org.id)).toEqual({
      credit_balance: "0.100000",
      allowance_available: "0.000000",
      allowance_settled: "0.400000",
      reservations: 1,
      debits: 1,
    });
    const [allocations] = await rows<{ allowance: string; purchased: string }>(
      `SELECT
        (SELECT finalized_amount::text FROM billing_funding_allocations WHERE reservation_id=$1 AND source='allowance') AS allowance,
        (SELECT finalized_amount::text FROM billing_funding_allocations WHERE reservation_id=$1 AND source='purchased_credit') AS purchased`,
      [result.fundingReservationId],
    );
    expect(allocations).toEqual({ allowance: "0.400000", purchased: "0.600000" });
    const [receipt] = await receipts(container.containerId);
    expect(receipt).toMatchObject({
      status: "success",
      credit_transaction_id: null,
      funding_reservation_id: result.fundingReservationId,
    });
  });

  test("a subscriber is insufficient only when allowance, credits, and earnings together fall short", async () => {
    const seeded = await seedOrganization({
      creditBalance: "0.300000",
      allowance: "0.300000",
      payAsYouGoFromEarnings: true,
      earnings: "0.3000",
    });
    const container = await seedRunningContainer(seeded.org.id, seeded.user.id, 10);
    const before = await fundingState(seeded.org.id);

    const result = await containerBillingRepository.recordSuccessfulDailyBilling(
      billingInput(seeded, container, seeded.user.id),
    );

    expect(result).toMatchObject({ insufficient: true, amount: 1, transactionId: null });
    expect(await fundingState(seeded.org.id)).toEqual(before);
    expect(await receipts(container.containerId)).toHaveLength(0);
    const [earnings] = await dbWrite
      .select({ available_balance: redeemableEarnings.available_balance })
      .from(redeemableEarnings)
      .where(eq(redeemableEarnings.user_id, seeded.user.id));
    expect(earnings?.available_balance).toBe("0.3000");
  });

  test("pay-as-you-go earnings fund first, then the allowance, then purchased credits", async () => {
    const seeded = await seedOrganization({
      creditBalance: "0.300000",
      allowance: "0.400000",
      payAsYouGoFromEarnings: true,
      earnings: "0.3000",
    });
    const container = await seedRunningContainer(seeded.org.id, seeded.user.id, 10);

    const result = await containerBillingRepository.recordSuccessfulDailyBilling(
      billingInput(seeded, container, seeded.user.id),
    );

    expect(result).toMatchObject({
      insufficient: false,
      amount: 1,
      fromEarnings: 0.3,
      fromAllowance: 0.4,
      allowanceRemaining: 0,
      newBalance: 0,
      creditCachesStale: true,
    });
    // Earnings convert 0.3 into credits and debit it back; the funded 0.7
    // remainder takes 0.4 allowance and 0.3 purchased credit.
    expect(await fundingState(seeded.org.id)).toEqual({
      credit_balance: "0.000000",
      allowance_available: "0.000000",
      allowance_settled: "0.400000",
      reservations: 1,
      debits: 2,
    });
    const [receipt] = await receipts(container.containerId);
    expect(receipt?.status).toBe("success");
    expect(receipt?.credit_transaction_id).toBe(result.transactionId);
    expect(receipt?.funding_reservation_id).toBe(result.fundingReservationId ?? null);
    const [earningsDebit] = await dbWrite
      .select({ amount: creditTransactions.amount, metadata: creditTransactions.metadata })
      .from(creditTransactions)
      .where(eq(creditTransactions.id, result.transactionId ?? ""));
    expect(earningsDebit?.amount).toBe("-0.300000");
    expect(earningsDebit?.metadata).toMatchObject({
      paid_from_earnings: "0.300000",
      subscription_funded: true,
    });
  });

  test("terminal settlement still records an uncollected receipt when every source is short", async () => {
    const seeded = await seedOrganization({ creditBalance: "0.200000", allowance: "0.300000" });
    const container = await seedRunningContainer(seeded.org.id, seeded.user.id, 10);
    const before = await fundingState(seeded.org.id);

    const result = await dbWrite.transaction((tx) =>
      containerBillingRepository.recordSuccessfulDailyBillingInTransaction(
        tx,
        billingInput(seeded, container),
        { forceLifecycleSettlement: true, terminalInsufficientDisposition: "uncollected" },
      ),
    );

    expect(result).toMatchObject({ insufficient: true, uncollected: true, amount: 1 });
    expect(await fundingState(seeded.org.id)).toEqual(before);
    const [receipt] = await receipts(container.containerId);
    expect(receipt).toMatchObject({
      status: "uncollected",
      credit_transaction_id: null,
      funding_reservation_id: null,
    });
  });

  test("organizations without a subscription keep the purchased-credit debit lane", async () => {
    const seeded = await seedOrganization({ creditBalance: "5.000000" });
    const container = await seedRunningContainer(seeded.org.id, seeded.user.id, 10);

    const result = await containerBillingRepository.recordSuccessfulDailyBilling(
      billingInput(seeded, container),
    );

    expect(result).toEqual({
      newBalance: 4,
      transactionId: expect.any(String),
      alreadyBilled: false,
      insufficient: false,
      amount: 1,
      fromEarnings: 0,
    });
    expect(await fundingState(seeded.org.id)).toEqual({
      credit_balance: "4.000000",
      allowance_available: null,
      allowance_settled: null,
      reservations: 0,
      debits: 1,
    });
    const [receipt] = await receipts(container.containerId);
    expect(receipt).toMatchObject({
      status: "success",
      credit_transaction_id: result.transactionId,
      funding_reservation_id: null,
    });
  });

  test("a funded receipt must cover its finalized reservation", async () => {
    const seeded = await seedOrganization({ creditBalance: "5.000000", allowance: "10.000000" });
    const container = await seedRunningContainer(seeded.org.id, seeded.user.id, 10);
    const result = await containerBillingRepository.recordSuccessfulDailyBilling(
      billingInput(seeded, container),
    );
    const [original] = await receipts(container.containerId);
    await dbWrite
      .delete(containerBillingRecords)
      .where(eq(containerBillingRecords.id, original?.id ?? ""));
    const insertReceipt = async (amount: string) =>
      await dbWrite.execute(sql`INSERT INTO container_billing_records(container_id, organization_id,
        amount, billing_period_start, billing_period_end, status, funding_reservation_id)
        VALUES (${container.containerId}, ${seeded.org.id}, ${amount}, now(), now(), 'success',
          ${result.fundingReservationId})`);
    await expect(insertReceipt("0.500000")).rejects.toThrow();
    await insertReceipt("1.000000");
    expect(await receipts(container.containerId)).toHaveLength(1);
  });
});

describe("container deployment allowance-first funding", () => {
  test("a subscriber's deployment is funded from the allowance", async () => {
    const seeded = await seedOrganization({ creditBalance: "1.000000", allowance: "2.000000" });

    const deployed = await containersRepository.createContainerWithCreditDeduction(
      {
        organization_id: seeded.org.id,
        user_id: seeded.user.id,
        name: "funded-deploy",
        project_name: "funded-deploy",
      },
      seeded.user.id,
      1.5,
    );

    expect(deployed.newBalance).toBe(1);
    expect(deployed.fundingReservationId).toEqual(expect.any(String));
    expect(await fundingState(seeded.org.id)).toEqual({
      credit_balance: "1.000000",
      allowance_available: "0.500000",
      allowance_settled: "1.500000",
      reservations: 1,
      debits: 0,
    });
    const [reservation] = await rows<{ logical_operation_id: string; status: string }>(
      "SELECT logical_operation_id, status FROM billing_funding_reservations WHERE id=$1",
      [deployed.fundingReservationId],
    );
    expect(reservation).toEqual({
      logical_operation_id: `container-deploy.${deployed.container.id}`,
      status: "finalized",
    });
  });

  test("a subscriber's deployment is refused only when allowance plus credits fall short", async () => {
    const seeded = await seedOrganization({ creditBalance: "0.500000", allowance: "0.500000" });
    const before = await fundingState(seeded.org.id);

    await expect(
      containersRepository.createContainerWithCreditDeduction(
        {
          organization_id: seeded.org.id,
          user_id: seeded.user.id,
          name: "short-deploy",
          project_name: "short-deploy",
        },
        seeded.user.id,
        1.5,
      ),
    ).rejects.toThrow("Insufficient balance");
    expect(await fundingState(seeded.org.id)).toEqual(before);
    expect(
      await dbWrite.select().from(containers).where(eq(containers.organization_id, seeded.org.id)),
    ).toHaveLength(0);
  });

  test("a non-subscriber deployment keeps the purchased-credit debit", async () => {
    const seeded = await seedOrganization({ creditBalance: "2.000000" });

    const deployed = await containersRepository.createContainerWithCreditDeduction(
      {
        organization_id: seeded.org.id,
        user_id: seeded.user.id,
        name: "cash-deploy",
        project_name: "cash-deploy",
      },
      seeded.user.id,
      1.5,
    );

    expect(deployed).toEqual({ container: deployed.container, newBalance: 0.5 });
    expect(await fundingState(seeded.org.id)).toMatchObject({
      credit_balance: "0.500000",
      reservations: 0,
      debits: 1,
    });
  });
});
