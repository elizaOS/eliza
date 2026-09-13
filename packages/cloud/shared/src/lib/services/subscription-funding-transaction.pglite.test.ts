/** Verifies that real funding reservations commit or roll back with work admission, and concurrent reservations cannot overspend an organization. */

import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { sql } from "drizzle-orm";
import { createBillingSnapshotFixture } from "../../db/repositories/account-billing-snapshot-test-fixture";

process.env.DATABASE_URL = "pglite://memory";
process.env.TEST_DATABASE_URL = "pglite://memory";
process.env.ENVIRONMENT = "local";

const organizationId = "61000000-0000-4000-8000-000000000002";
const allowanceOrganizationId = "61000000-0000-4000-8000-000000000001";
const subscriptionId = "62000000-0000-4000-8000-000000000001";
let client: typeof import("../../db/client");
let helpers: typeof import("../../db/helpers");
let funding: typeof import("./subscription-funding");

beforeAll(async () => {
  client = await import("../../db/client");
  helpers = await import("../../db/helpers");
  funding = await import("./subscription-funding");
  await createBillingSnapshotFixture((query) => client.getPgliteClientForTests().exec(query), "");
  await client.getPgliteClientForTests().exec(`
    ALTER TABLE credit_transactions ALTER COLUMN id SET DEFAULT gen_random_uuid();
    ALTER TABLE credit_transactions ADD COLUMN user_id uuid;
    ALTER TABLE credit_transactions ADD COLUMN description text;
    ALTER TABLE credit_transactions ADD COLUMN stripe_payment_intent_id text UNIQUE;
    ALTER TABLE credit_transactions ADD COLUMN created_at timestamp DEFAULT now();
    ALTER TABLE credit_transactions ADD COLUMN settled_at timestamp;
    INSERT INTO organizations(id, credit_balance, balance_revision, balance_decrease_revision,
      settings, is_active, auto_top_up_enabled, account_lifecycle_state)
    VALUES ('${organizationId}', '10.000001', 1, 0, '{}', true, false, 'active');
  `);
  await client.getPgliteClientForTests().exec(`
    ALTER TABLE agent_sandboxes ADD CONSTRAINT agent_sandboxes_id_organization_unique UNIQUE(id, organization_id);
    INSERT INTO agent_sandboxes(id,organization_id,status,execution_tier,lifecycle_revision)
    VALUES ('63000000-0000-4000-8000-000000000001','${organizationId}','provisioning','dedicated-always',1);
  `);
  const computeMigration = await readFile(
    new URL("../../db/migrations/0387_agent_compute_funding.sql", import.meta.url),
    "utf8",
  );
  await client.getPgliteClientForTests().exec(computeMigration);
  // The generated migration must also be safe when recovery repeats it.
  await client.getPgliteClientForTests().exec(computeMigration);
  const { subscriptionAuthorityRepository: authority } = await import(
    "../../db/repositories/subscription-authority"
  );
  const { subscriptionEntitlementsRepository: entitlements } = await import(
    "../../db/repositories/subscription-entitlements"
  );
  const current = await authority.findById(allowanceOrganizationId, subscriptionId);
  if (!current) throw new Error("Missing paid subscription fixture");
  const { id, organization_id, lifecycle_revision, created_at, updated_at, ...values } = current;
  const periodStart = new Date(Date.now() - 86400000);
  const periodEnd = new Date(Date.now() + 86400000);
  const advanced = await authority.advance({
    organizationId: allowanceOrganizationId,
    subscriptionId,
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
    organizationId: allowanceOrganizationId,
    sourceSubscriptionId: subscriptionId,
    sourceSubscriptionRevision: advanced.subscription.lifecycle_revision,
    expectedProjectionRevision: 1,
  });
  await client.getPgliteClientForTests().query(
    `UPDATE subscription_allowance_periods SET subscription_revision=$1,
      period_start=$2,period_end=$3,expires_at=$3 WHERE organization_id=$4`,
    [advanced.subscription.lifecycle_revision, periodStart, periodEnd, allowanceOrganizationId],
  );
}, 120000);

afterAll(async () => {
  await client.closeDatabaseConnectionsForTests();
});

function input(logicalOperationId: string, amount: string) {
  return {
    organizationId,
    logicalOperationId,
    operation: "managed_agent_compute" as const,
    amount,
    description: "Dedicated admission transaction test",
    reservationTtlMs: 3600000,
  };
}

async function state() {
  return (
    await client.getPgliteClientForTests().query<{
      balance: string;
      reservations: number;
      debits: number;
    }>(`SELECT credit_balance::text AS balance,
      (SELECT count(*)::integer FROM billing_funding_reservations) AS reservations,
      (SELECT count(*)::integer FROM credit_transactions) AS debits
      FROM organizations WHERE id='${organizationId}'`)
  ).rows[0];
}

test("a rejected admission rolls back its real credit debit and funding reservation", async () => {
  const before = await state();
  await expect(
    helpers.writeTransaction(async (tx) => {
      const result = await funding.subscriptionFundingService.reserveInTransaction(
        tx,
        input("compute:rejected-admission", "1.000000"),
      );
      expect(result.purchasedCreditDebited).toBe(true);
      const rows = await tx.execute(
        sql`SELECT count(*)::integer AS count FROM billing_funding_reservations`,
      );
      expect(rows.rows[0]?.count).toBe(1);
      throw new Error("Work admission rejected");
    }),
  ).rejects.toThrow("Work admission rejected");
  expect(await state()).toEqual(before);
});

test("concurrent compute admissions reserve once, reject overspending, and replay without another debit", async () => {
  const requests = [
    input("compute:concurrent-first", "6.000000"),
    input("compute:concurrent-second", "6.000000"),
  ];
  const attempts = await Promise.allSettled(
    requests.map((request) =>
      helpers.writeTransaction((tx) =>
        funding.subscriptionFundingService.reserveInTransaction(tx, request),
      ),
    ),
  );
  const winnerIndex = attempts.findIndex((attempt) => attempt.status === "fulfilled");
  expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1);
  const rejected = attempts.find((attempt) => attempt.status === "rejected");
  expect(rejected?.status === "rejected" && rejected.reason).toMatchObject({
    code: funding.SUBSCRIPTION_FUNDING_INSUFFICIENT,
  });
  expect(await state()).toEqual({ balance: "4.000001", reservations: 1, debits: 1 });
  const replay = await helpers.writeTransaction((tx) =>
    funding.subscriptionFundingService.reserveInTransaction(tx, requests[winnerIndex]!),
  );
  expect(replay.replayed).toBe(true);
  expect(replay.purchasedCreditDebited).toBe(false);
  expect(await state()).toEqual({ balance: "4.000001", reservations: 1, debits: 1 });
  await expect(
    helpers.writeTransaction((tx) =>
      funding.subscriptionFundingService.reserveInTransaction(tx, {
        ...requests[winnerIndex]!,
        amount: "2.000000",
      }),
    ),
  ).rejects.toMatchObject({ code: funding.SUBSCRIPTION_FUNDING_REPLAY_CONFLICT });
  expect(await state()).toEqual({ balance: "4.000001", reservations: 1, debits: 1 });
});

test("a rejected mixed-source admission returns both paid allowance and purchased credit atomically", async () => {
  const readPaidState = async () =>
    (
      await client.getPgliteClientForTests().query(
        `SELECT o.credit_balance::text, p.available_amount::text, p.reserved_amount::text,
          (SELECT count(*)::integer FROM billing_funding_reservations WHERE organization_id=$1) AS reservations,
          (SELECT count(*)::integer FROM credit_transactions WHERE organization_id=$1) AS debits
          FROM organizations o JOIN subscription_allowance_periods p ON p.organization_id=o.id
          WHERE o.id=$1`,
        [allowanceOrganizationId],
      )
    ).rows;
  const before = await readPaidState();
  await expect(
    helpers.writeTransaction(async (tx) => {
      const result = await funding.subscriptionFundingService.reserveInTransaction(tx, {
        ...input("compute:mixed-rejected", "30.000000"),
        organizationId: allowanceOrganizationId,
      });
      expect(result.reservation.reserved_amount).toBe("30.000000");
      expect(result.purchasedCreditDebited).toBe(true);
      const allocated = await tx.execute(sql`
        SELECT source, reserved_amount::text FROM billing_funding_allocations
        WHERE reservation_id=${result.reservation.id} ORDER BY source`);
      expect(allocated.rows).toEqual([
        { source: "allowance", reserved_amount: "25.000001" },
        { source: "purchased_credit", reserved_amount: "4.999999" },
      ]);
      throw new Error("Paid work admission rejected");
    }),
  ).rejects.toThrow("Paid work admission rejected");
  expect(await readPaidState()).toEqual(before);
});

test("work-completion failure rolls back the settlement and refund; exact replay never credits twice", async () => {
  const { SUBSCRIPTION_FUNDING_CONFLICT } = await import(
    "../../db/repositories/subscription-funding-reservations"
  );
  const request = input("compute:completion-atomicity", "2.000000");
  await helpers.writeTransaction((tx) =>
    funding.subscriptionFundingService.reserveInTransaction(tx, request),
  );
  const before = await state();
  const settlement = {
    organizationId,
    logicalOperationId: request.logicalOperationId,
    operation: request.operation,
    actualAmount: "0.750000",
    occurredAt: new Date(),
  };
  await expect(
    helpers.writeTransaction(async (tx) => {
      const result = await funding.subscriptionFundingService.settleInTransaction(tx, settlement);
      expect(result.collectedAmount).toBe("0.750000");
      expect(result.purchasedCreditRefunded).toBe(true);
      throw new Error("Compute receipt rejected");
    }),
  ).rejects.toThrow("Compute receipt rejected");
  expect(await state()).toEqual(before);
  const result = await helpers.writeTransaction((tx) =>
    funding.subscriptionFundingService.settleInTransaction(tx, settlement),
  );
  expect(result.reservation.status).toBe("finalized");
  expect(result.purchasedCreditRefunded).toBe(true);
  expect(await state()).toEqual({ balance: "3.250001", reservations: 2, debits: 3 });
  const replay = await helpers.writeTransaction((tx) =>
    funding.subscriptionFundingService.settleInTransaction(tx, settlement),
  );
  expect(replay.replayed).toBe(true);
  expect(replay.purchasedCreditRefunded).toBe(false);
  expect(await state()).toEqual({ balance: "3.250001", reservations: 2, debits: 3 });
  await expect(
    helpers.writeTransaction((tx) =>
      funding.subscriptionFundingService.settleInTransaction(tx, {
        ...settlement,
        actualAmount: "0.250000",
      }),
    ),
  ).rejects.toMatchObject({ code: SUBSCRIPTION_FUNDING_CONFLICT });
  expect(await state()).toEqual({ balance: "3.250001", reservations: 2, debits: 3 });
});

test("Dedicated funding rolls back with rejected lifecycle admission and binds retries to one container", async () => {
  const { agentComputeFundingService: compute, AGENT_COMPUTE_FUNDING_AUTHORITY_CHANGED } =
    await import("./agent-compute-funding");
  const identity = {
    agentId: "63000000-0000-4000-8000-000000000001",
    organizationId,
    lifecycleRevision: 1,
  };
  const before = await state();
  await expect(
    helpers.writeTransaction(async (tx) => {
      await compute.reserveInTransaction(tx, identity);
      throw new Error("Lifecycle admission rejected");
    }),
  ).rejects.toThrow("Lifecycle admission rejected");
  expect(await state()).toEqual(before);
  expect(
    (await client.getPgliteClientForTests().query("SELECT * FROM agent_compute_funding")).rows,
  ).toHaveLength(0);
  await expect(
    helpers.writeTransaction((tx) =>
      compute.reserveInTransaction(tx, { ...identity, lifecycleRevision: 2 }),
    ),
  ).rejects.toMatchObject({ code: AGENT_COMPUTE_FUNDING_AUTHORITY_CHANGED });
  await expect(
    helpers.writeTransaction((tx) =>
      compute.reserveInTransaction(tx, { ...identity, organizationId: allowanceOrganizationId }),
    ),
  ).rejects.toMatchObject({ code: AGENT_COMPUTE_FUNDING_AUTHORITY_CHANGED });
  expect(await state()).toEqual(before);
  const [first, retry] = await Promise.all([
    helpers.writeTransaction((tx) => compute.reserveInTransaction(tx, identity)),
    helpers.writeTransaction((tx) => compute.reserveInTransaction(tx, identity)),
  ]);
  expect(first.window.id).toBe(retry.window.id);
  expect([first.replayed, retry.replayed].sort()).toEqual([false, true]);
  const fundedState = await state();
  expect(fundedState).toEqual({ balance: "3.240001", reservations: 3, debits: 4 });
  const provider = {
    ...identity,
    fundingId: first.window.id,
    nodeId: "dedicated-test-node",
    containerId: "a".repeat(64),
  };
  const bound = await helpers.writeTransaction((tx) =>
    compute.bindProviderInTransaction(tx, provider),
  );
  expect(bound.provider_container_id).toBe(provider.containerId);
  expect(
    await helpers.writeTransaction((tx) => compute.bindProviderInTransaction(tx, provider)),
  ).toEqual(bound);
  await expect(
    helpers.writeTransaction((tx) =>
      compute.bindProviderInTransaction(tx, { ...provider, containerId: "b".repeat(64) }),
    ),
  ).rejects.toMatchObject({ code: AGENT_COMPUTE_FUNDING_AUTHORITY_CHANGED });
  expect(await state()).toEqual(fundedState);
  await expect(
    client
      .getPgliteClientForTests()
      .query("UPDATE agent_compute_funding SET settled_at=now() WHERE id=$1", [bound.id]),
  ).rejects.toThrow("agent_compute_funding_settlement_check");
  await client
    .getPgliteClientForTests()
    .query("UPDATE organizations SET paid_work_fenced_at=now() WHERE id=$1", [organizationId]);
  await expect(
    helpers.writeTransaction((tx) => compute.reserveInTransaction(tx, identity)),
  ).rejects.toMatchObject({ code: AGENT_COMPUTE_FUNDING_AUTHORITY_CHANGED });
  expect(await state()).toEqual(fundedState);
  await client
    .getPgliteClientForTests()
    .query("UPDATE organizations SET paid_work_fenced_at=NULL WHERE id=$1", [organizationId]);
});

test("unfunded, Shared and expired Dedicated admissions cannot create another debit", async () => {
  const {
    agentComputeFundingService: compute,
    AGENT_COMPUTE_FUNDING_AUTHORITY_CHANGED,
    AGENT_COMPUTE_FUNDING_EXPIRED,
  } = await import("./agent-compute-funding");
  const identity = {
    agentId: "63000000-0000-4000-8000-000000000001",
    organizationId,
    lifecycleRevision: 1,
  };
  const unfundedOrg = "61000000-0000-4000-8000-000000000003";
  const unfundedAgent = "63000000-0000-4000-8000-000000000002";
  await client.getPgliteClientForTests().query(
    `INSERT INTO organizations(id,credit_balance,balance_revision,balance_decrease_revision,settings,is_active,auto_top_up_enabled,account_lifecycle_state)
    VALUES ($1,'0.000000',1,0,'{}',true,false,'active')`,
    [unfundedOrg],
  );
  await client.getPgliteClientForTests().query(
    `INSERT INTO agent_sandboxes(id,organization_id,status,execution_tier,lifecycle_revision)
    VALUES ($1,$2,'provisioning','dedicated-always',1)`,
    [unfundedAgent, unfundedOrg],
  );
  const before = await state();
  await expect(
    helpers.writeTransaction((tx) =>
      compute.reserveInTransaction(tx, {
        agentId: unfundedAgent,
        organizationId: unfundedOrg,
        lifecycleRevision: 1,
      }),
    ),
  ).rejects.toMatchObject({ code: funding.SUBSCRIPTION_FUNDING_INSUFFICIENT });
  expect(await state()).toEqual(before);
  await client
    .getPgliteClientForTests()
    .query("UPDATE agent_sandboxes SET execution_tier='shared' WHERE id=$1", [identity.agentId]);
  await expect(
    helpers.writeTransaction((tx) => compute.reserveInTransaction(tx, identity)),
  ).rejects.toMatchObject({ code: AGENT_COMPUTE_FUNDING_AUTHORITY_CHANGED });
  await client
    .getPgliteClientForTests()
    .query("UPDATE agent_sandboxes SET execution_tier='dedicated-always' WHERE id=$1", [
      identity.agentId,
    ]);
  await expect(
    client
      .getPgliteClientForTests()
      .query("UPDATE agent_compute_funding SET hourly_rate='NaN' WHERE agent_id=$1", [
        identity.agentId,
      ]),
  ).rejects.toThrow("agent_compute_funding_period_check");
  await client
    .getPgliteClientForTests()
    .query(
      "UPDATE agent_compute_funding SET period_start=now()-interval '2 hours',period_end=now()-interval '1 hour' WHERE agent_id=$1",
      [identity.agentId],
    );
  await expect(
    helpers.writeTransaction((tx) => compute.reserveInTransaction(tx, identity)),
  ).rejects.toMatchObject({ code: AGENT_COMPUTE_FUNDING_EXPIRED });
  expect(await state()).toEqual(before);
});
