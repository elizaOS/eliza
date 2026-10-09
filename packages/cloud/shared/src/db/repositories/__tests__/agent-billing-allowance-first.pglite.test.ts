/**
 * Proves the legacy hourly agent biller funds Cloud subscribers allowance-first
 * (then purchased credit) against real PGlite migrations, while every other
 * organization keeps its unchanged purchased-credit debit lane.
 */

import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { createBillingSnapshotFixture } from "../account-billing-snapshot-test-fixture";

process.env.DATABASE_URL = "pglite://memory";
process.env.TEST_DATABASE_URL = process.env.DATABASE_URL;
process.env.ENVIRONMENT = "local";

const PGLITE_TIMEOUT = 120_000;
const SUBSCRIBER_ORG = "61000000-0000-4000-8000-000000000001";
const CASH_ORG = "61000000-0000-4000-8000-000000000002";
const SUBSCRIPTION_ID = "62000000-0000-4000-8000-000000000001";
const USER_ID = "64000000-0000-4000-8000-000000000001";

let client: typeof import("../../client");
let repository: typeof import("../agent-billing").agentBillingRepository;
let runs: typeof import("../agent-billing-runs").agentBillingRunRepository;
let fixture: {
  exec(query: string): Promise<void>;
  query<T extends Record<string, unknown> = Record<string, unknown>>(
    query: string,
    parameters?: unknown[],
  ): Promise<{ rows: T[] }>;
};
let agentSequence = 0;

const migration = (name: string) =>
  readFile(new URL(`../../migrations/${name}`, import.meta.url), "utf8");

beforeAll(async () => {
  client = await import("../../client");
  const pglite = client.getPgliteClientForTests();
  fixture = {
    async exec(query) {
      await pglite.exec(query);
    },
    async query<T extends Record<string, unknown>>(query: string, parameters?: unknown[]) {
      return pglite.query<T>(query, parameters);
    },
  };
  await createBillingSnapshotFixture((query) => fixture.exec(query), "");
  await fixture.exec(`
    ALTER TABLE credit_transactions ALTER COLUMN id SET DEFAULT gen_random_uuid();
    ALTER TABLE credit_transactions ADD COLUMN user_id uuid;
    ALTER TABLE credit_transactions ADD COLUMN description text;
    ALTER TABLE credit_transactions ADD COLUMN created_at timestamp DEFAULT now();
    ALTER TABLE credit_transactions ADD COLUMN settled_at timestamp;
    INSERT INTO users(id) VALUES ('${USER_ID}');
    INSERT INTO organizations(id, credit_balance, balance_revision, balance_decrease_revision,
      settings, is_active, auto_top_up_enabled, account_lifecycle_state)
    VALUES ('${CASH_ORG}', '10.000000', 1, 0, '{}', true, false, 'active');
    ALTER TABLE agent_sandboxes ADD CONSTRAINT agent_sandboxes_id_organization_unique UNIQUE(id, organization_id);
  `);
  for (const name of [
    "0387_agent_compute_funding.sql",
    "0389_agent_compute_stop_receipts.sql",
    "0390_agent_compute_runtime_readiness.sql",
    "0391_agent_compute_subjects.sql",
    "0392_agent_compute_retirement_backup.sql",
    "0393_agent_compute_activation_minimum.sql",
  ]) {
    await fixture.exec(await migration(name));
  }
  const legacyReceiptTable = (await migration("0265_compute_billing_recovery.sql")).match(
    /CREATE TABLE agent_billing_records \([\s\S]*?\n\);/,
  );
  if (!legacyReceiptTable) throw new Error("Missing canonical legacy billing receipt DDL");
  await fixture.exec(legacyReceiptTable[0]);
  for (const name of [
    "0388_agent_compute_funded_receipts.sql",
    "0394_agent_billing_activation_minimum.sql",
    "0484_agent_billing_funding_reservations.sql",
    // Recovery may replay the receipt migrations; the funding source check must survive.
    "0388_agent_compute_funded_receipts.sql",
    "0484_agent_billing_funding_reservations.sql",
    "0274_agent_billing_run_receipts.sql",
  ]) {
    await fixture.exec(await migration(name));
  }

  // Move the seeded paid subscription and its allowance period around now.
  const { subscriptionAuthorityRepository: authority } = await import("../subscription-authority");
  const { subscriptionEntitlementsRepository: entitlements } = await import(
    "../subscription-entitlements"
  );
  const current = await authority.findById(SUBSCRIBER_ORG, SUBSCRIPTION_ID);
  if (!current) throw new Error("Missing paid subscription fixture");
  const { id, organization_id, lifecycle_revision, created_at, updated_at, ...values } = current;
  const periodStart = new Date(Date.now() - 86_400_000);
  const periodEnd = new Date(Date.now() + 86_400_000);
  const advanced = await authority.advance({
    organizationId: SUBSCRIBER_ORG,
    subscriptionId: SUBSCRIPTION_ID,
    expectedRevision: lifecycle_revision,
    source: "webhook",
    observation: "authoritative_provider_retrieval",
    values: {
      ...values,
      current_period_start: periodStart,
      current_period_end: periodEnd,
      provider_object_digest: "c".repeat(64),
    },
  });
  await entitlements.rebuild({
    organizationId: SUBSCRIBER_ORG,
    sourceSubscriptionId: SUBSCRIPTION_ID,
    sourceSubscriptionRevision: advanced.subscription.lifecycle_revision,
    expectedProjectionRevision: 1,
  });
  await fixture.query(
    `UPDATE subscription_allowance_periods SET subscription_revision=$1,
      period_start=$2,period_end=$3,expires_at=$3 WHERE organization_id=$4`,
    [advanced.subscription.lifecycle_revision, periodStart, periodEnd, SUBSCRIBER_ORG],
  );

  repository = (await import("../agent-billing")).agentBillingRepository;
  runs = (await import("../agent-billing-runs")).agentBillingRunRepository;
}, PGLITE_TIMEOUT);

afterAll(async () => {
  await client.closeDatabaseConnectionsForTests();
});

/** Sets exact purchased credit and spendable allowance, keeping the period's amount identity. */
async function setFunds(organizationId: string, credit: string, allowance?: string) {
  await fixture.query("UPDATE organizations SET credit_balance=$2 WHERE id=$1", [
    organizationId,
    credit,
  ]);
  if (allowance === undefined) return;
  await fixture.query(
    `UPDATE subscription_allowance_periods SET available_amount=$2::numeric,
      expired_amount=granted_amount+adjustment_amount-reserved_amount-settled_amount-clawed_back_amount-$2::numeric
      WHERE organization_id=$1`,
    [organizationId, allowance],
  );
}

/** A billable legacy (unfunded-window) agent with one exact metered hour at `ratePerHour`. */
async function billableHour(organizationId: string, ratePerHour: string) {
  agentSequence += 1;
  const agentId = `63000000-0000-4000-8000-${String(agentSequence).padStart(12, "0")}`;
  const now = new Date(Math.floor(Date.now() / 1000) * 1000);
  const periodStart = new Date(now.getTime() - 3_600_000);
  await fixture.query(
    `INSERT INTO agent_sandboxes(id,organization_id,user_id,agent_name,status,execution_tier,
      billing_status,lifecycle_revision,total_billed,last_billed_at,created_at)
    VALUES ($1,$2,$3,'Legacy agent','running','dedicated-always','active',1,0,$4,$4)`,
    [agentId, organizationId, USER_ID, periodStart],
  );
  await fixture.query(
    `INSERT INTO compute_billing_rate_segments(id,organization_id,workload_kind,workload_id,
      lifecycle_revision,billing_state,rate_per_hour,effective_at)
    VALUES (gen_random_uuid(),$1,'agent',$2,1,'running',$3,$4)`,
    [organizationId, agentId, ratePerHour, periodStart],
  );
  const run = await runs.startOrLoad({
    invocationKey: `manual:allowance-first:${agentId}`,
    triggerKind: "manual",
    schedule: null,
    scheduledAt: null,
    leaseDurationMs: 300_000,
  });
  if (!run.leaseToken) throw new Error("Billing test did not claim its run");
  return {
    agentId,
    periodStart,
    input: {
      runId: run.run.id,
      leaseToken: run.leaseToken,
      sandboxId: agentId,
      organizationId,
      userId: USER_ID,
      agentName: "Legacy agent",
      hourlyRate: 99,
      billingDescription: "Legacy hourly agent compute",
      lowCreditWarningAmount: 1,
      now,
    },
  };
}

async function funds(organizationId: string) {
  const [balance, allowance, ledger, reservations] = await Promise.all([
    fixture.query<{ credit_balance: string }>(
      "SELECT credit_balance::text FROM organizations WHERE id=$1",
      [organizationId],
    ),
    fixture.query<{ available_amount: string; settled_amount: string }>(
      "SELECT available_amount::text,settled_amount::text FROM subscription_allowance_periods WHERE organization_id=$1",
      [organizationId],
    ),
    fixture.query<{ amount: string; type: string }>(
      "SELECT amount::text,type FROM credit_transactions WHERE organization_id=$1 ORDER BY created_at,id",
      [organizationId],
    ),
    fixture.query("SELECT id,status FROM billing_funding_reservations WHERE organization_id=$1", [
      organizationId,
    ]),
  ]);
  return {
    credit: balance.rows[0]?.credit_balance,
    allowance: allowance.rows[0]?.available_amount,
    allowanceSettled: allowance.rows[0]?.settled_amount,
    ledger: ledger.rows,
    reservations: reservations.rows,
  };
}

async function sandboxState(agentId: string) {
  const [sandbox] = (
    await fixture.query<{
      billing_status: string;
      total_billed: string;
      last_billed_at: Date;
    }>("SELECT billing_status,total_billed::text,last_billed_at FROM agent_sandboxes WHERE id=$1", [
      agentId,
    ])
  ).rows;
  const receipts = await fixture.query<{
    amount: string;
    credit_transaction_id: string | null;
    compute_funding_id: string | null;
    funding_reservation_id: string | null;
  }>(
    "SELECT amount::text,credit_transaction_id,compute_funding_id,funding_reservation_id FROM agent_billing_records WHERE sandbox_id=$1",
    [agentId],
  );
  return { sandbox, receipts: receipts.rows };
}

async function allocations(reservationId: string) {
  return (
    await fixture.query<{ source: string; finalized_amount: string }>(
      "SELECT source,finalized_amount::text FROM billing_funding_allocations WHERE reservation_id=$1 ORDER BY sequence",
      [reservationId],
    )
  ).rows;
}

test("a subscriber's legacy hourly charge is funded from allowance without debiting purchased credit", async () => {
  await setFunds(SUBSCRIBER_ORG, "1.000000", "25.000000");
  const before = await funds(SUBSCRIBER_ORG);
  const { agentId, periodStart, input } = await billableHour(SUBSCRIBER_ORG, "2.000000");

  const outcomes = await Promise.all([
    repository.recordHourlyBilling(input),
    repository.recordHourlyBilling(input),
  ]);
  expect(outcomes.map((outcome) => outcome.status).sort()).toEqual([
    "already_billed_recently",
    "billed",
  ]);
  const billed = outcomes.find((outcome) => outcome.status === "billed");
  if (billed?.status !== "billed") throw new Error("Expected one billed outcome");
  expect(billed).toMatchObject({ amountDecimal: "2.000000", newBalance: 1 });

  const after = await funds(SUBSCRIBER_ORG);
  expect(after.credit).toBe("1.000000");
  expect(after.allowance).toBe("23.000000");
  expect(after.ledger).toEqual(before.ledger);
  const reservation = await fixture.query<{ id: string; logical_operation_id: string }>(
    "SELECT id,logical_operation_id FROM billing_funding_reservations WHERE organization_id=$1 AND logical_operation_id=$2",
    [SUBSCRIBER_ORG, `agent-bill.${agentId}.${periodStart.getTime()}`],
  );
  const reservationId = reservation.rows[0]?.id;
  if (!reservationId) throw new Error("Missing retry-stable funding reservation");
  expect(billed.transactionId).toBe(`funding-reservation:${reservationId}`);
  expect(await allocations(reservationId)).toEqual([
    { source: "allowance", finalized_amount: "2.000000" },
  ]);

  const state = await sandboxState(agentId);
  expect(state.sandbox).toMatchObject({ billing_status: "active", total_billed: "2.000000" });
  expect(state.sandbox?.last_billed_at.getTime()).toBe(input.now.getTime());
  expect(state.receipts).toEqual([
    {
      amount: "2.000000",
      credit_transaction_id: null,
      compute_funding_id: null,
      funding_reservation_id: reservationId,
    },
  ]);
  expect(
    (
      await fixture.query(
        "SELECT action,amount::text,new_balance::text,transaction_id FROM agent_billing_run_items WHERE run_id=$1",
        [input.runId],
      )
    ).rows,
  ).toEqual([
    {
      action: "billed",
      amount: "2.000000",
      new_balance: "1.000000",
      transaction_id: `funding-reservation:${reservationId}`,
    },
  ]);
});

test("a subscriber's charge spends remaining allowance first, then purchased credit, and warns on combined funds", async () => {
  await setFunds(SUBSCRIBER_ORG, "1.500000", "0.500000");
  const { agentId, input } = await billableHour(SUBSCRIBER_ORG, "1.250000");

  const outcome = await repository.recordHourlyBilling(input);
  expect(outcome).toMatchObject({ status: "billed", amountDecimal: "1.250000", newBalance: 0.75 });

  const after = await funds(SUBSCRIBER_ORG);
  expect(after.credit).toBe("0.750000");
  expect(after.allowance).toBe("0.000000");
  if (outcome.status !== "billed") throw new Error("Expected billed outcome");
  const reservationId = outcome.transactionId.replace("funding-reservation:", "");
  expect(await allocations(reservationId)).toEqual([
    { source: "allowance", finalized_amount: "0.500000" },
    { source: "purchased_credit", finalized_amount: "0.750000" },
  ]);
  // 0.75 purchased credit + 0 allowance is below the 1.00 warning threshold.
  const state = await sandboxState(agentId);
  expect(state.sandbox).toMatchObject({ billing_status: "warning", total_billed: "1.250000" });
  expect(state.receipts).toEqual([
    {
      amount: "1.250000",
      credit_transaction_id: null,
      compute_funding_id: null,
      funding_reservation_id: reservationId,
    },
  ]);
});

test("remaining allowance keeps a subscriber with little purchased credit out of the low-funds warning", async () => {
  await setFunds(SUBSCRIBER_ORG, "0.000000", "5.000000");
  const { agentId, input } = await billableHour(SUBSCRIBER_ORG, "1.000000");

  expect(await repository.recordHourlyBilling(input)).toMatchObject({
    status: "billed",
    amountDecimal: "1.000000",
    newBalance: 0,
  });
  expect(await funds(SUBSCRIBER_ORG)).toMatchObject({ credit: "0.000000", allowance: "4.000000" });
  expect((await sandboxState(agentId)).sandbox).toMatchObject({ billing_status: "active" });
});

test("a subscriber short on allowance plus purchased credit gets insufficient_credits with nothing debited", async () => {
  await setFunds(SUBSCRIBER_ORG, "1.000000", "0.500000");
  const { agentId, input } = await billableHour(SUBSCRIBER_ORG, "2.000000");
  const before = await funds(SUBSCRIBER_ORG);
  const sandboxBefore = await sandboxState(agentId);

  expect(await repository.recordHourlyBilling(input)).toEqual({
    status: "insufficient_credits",
  });

  expect(await funds(SUBSCRIBER_ORG)).toEqual(before);
  expect(await sandboxState(agentId)).toEqual(sandboxBefore);
  expect(sandboxBefore.receipts).toEqual([]);
  expect(
    (await fixture.query("SELECT id FROM agent_billing_run_items WHERE run_id=$1", [input.runId]))
      .rows,
  ).toEqual([]);
});

test("a non-subscriber keeps the purchased-credit debit lane unchanged", async () => {
  await setFunds(CASH_ORG, "10.000000");
  const { agentId, input } = await billableHour(CASH_ORG, "2.000000");

  const outcome = await repository.recordHourlyBilling(input);
  expect(outcome).toMatchObject({ status: "billed", amountDecimal: "2.000000", newBalance: 8 });

  const after = await funds(CASH_ORG);
  expect(after.credit).toBe("8.000000");
  expect(after.reservations).toEqual([]);
  expect(after.ledger).toEqual([{ amount: "-2.000000", type: "debit" }]);
  const state = await sandboxState(agentId);
  if (outcome.status !== "billed") throw new Error("Expected billed outcome");
  expect(state.receipts).toEqual([
    {
      amount: "2.000000",
      credit_transaction_id: outcome.transactionId,
      compute_funding_id: null,
      funding_reservation_id: null,
    },
  ]);
});

test("a funding-reservation receipt must match its finalized reservation amount and tenant", async () => {
  const [reservation] = (
    await fixture.query<{ id: string; amount: string }>(
      `SELECT r.id,r.requested_amount::text AS amount FROM billing_funding_reservations r
      JOIN agent_billing_records b ON b.funding_reservation_id=r.id
      WHERE r.organization_id=$1 LIMIT 1`,
      [SUBSCRIBER_ORG],
    )
  ).rows;
  const [subscriberCredit] = (
    await fixture.query<{ id: string }>(
      "SELECT id FROM credit_transactions WHERE organization_id=$1 LIMIT 1",
      [SUBSCRIBER_ORG],
    )
  ).rows;
  if (!reservation || !subscriberCredit) throw new Error("Missing finalized funding fixtures");
  const insert = (organizationId: string, amount: string, creditTransactionId: string | null) =>
    fixture.query(
      `INSERT INTO agent_billing_records(organization_id,sandbox_id,sandbox_status,billing_period_start,
        billing_period_end,hourly_rate,amount,funding_reservation_id,credit_transaction_id)
      VALUES ($1,gen_random_uuid(),'running',now()-interval '1 hour',now(),$2,$2,$3,$4)`,
      [organizationId, amount, reservation.id, creditTransactionId],
    );
  await expect(insert(SUBSCRIBER_ORG, "9.000000", null)).rejects.toThrow(
    "must match its finalized funding reservation",
  );
  await expect(insert(CASH_ORG, reservation.amount, null)).rejects.toThrow(
    "must match its finalized funding reservation",
  );
  await expect(insert(SUBSCRIBER_ORG, reservation.amount, subscriberCredit.id)).rejects.toThrow(
    "agent_billing_records_funding_source_check",
  );
  await expect(insert(SUBSCRIBER_ORG, reservation.amount, null)).rejects.toThrow(
    "agent_billing_records_funding_reservation_idx",
  );
});
