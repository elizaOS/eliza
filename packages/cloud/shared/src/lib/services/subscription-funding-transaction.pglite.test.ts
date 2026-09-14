/** Verifies funding admission, renewal and stop refunds on PGlite or empty loopback PostgreSQL. An explicit SSH fixture adds real Docker rollback/retry proof on a host without an existing compute guard. */

import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { sql } from "drizzle-orm";
import { getTableConfig } from "drizzle-orm/pg-core";
import { z } from "zod";
import { createBillingSnapshotFixture } from "../../db/repositories/account-billing-snapshot-test-fixture";

const postgresTestUrl = process.env.COMPUTE_FUNDING_POSTGRES_TEST_URL;
const sshFixturePath = process.env.COMPUTE_FUNDING_SSH_FIXTURE;
if (sshFixturePath && !postgresTestUrl) {
  throw new Error("The real SSH suspend test requires isolated PostgreSQL");
}

if (postgresTestUrl) {
  const target = new URL(postgresTestUrl);
  if (
    !["127.0.0.1", "localhost", "[::1]"].includes(target.hostname) ||
    !/^\/dedicated_compute_test_[a-z0-9]+$/.test(target.pathname)
  ) {
    throw new Error("Funding tests require an isolated loopback dedicated_compute_test_ database");
  }
}
process.env.DATABASE_URL = postgresTestUrl ?? "pglite://memory";
process.env.TEST_DATABASE_URL = process.env.DATABASE_URL;
process.env.ENVIRONMENT = "local";

const organizationId = "61000000-0000-4000-8000-000000000002";
const allowanceOrganizationId = "61000000-0000-4000-8000-000000000001";
const subscriptionId = "62000000-0000-4000-8000-000000000001";
let client: typeof import("../../db/client");
let helpers: typeof import("../../db/helpers");
let funding: typeof import("./subscription-funding");
let postgresPool: import("pg").Pool | undefined;
let fixture: {
  exec(query: string): Promise<void>;
  query<T extends Record<string, unknown> = Record<string, unknown>>(
    query: string,
    parameters?: unknown[],
  ): Promise<{ rows: T[] }>;
};

beforeAll(async () => {
  client = await import("../../db/client");
  helpers = await import("../../db/helpers");
  funding = await import("./subscription-funding");
  if (postgresTestUrl) {
    const { Pool } = await import("pg");
    const pool = new Pool({ connectionString: postgresTestUrl, max: 4 });
    postgresPool = pool;
    fixture = {
      async exec(query) {
        await pool.query(query);
      },
      async query<T extends Record<string, unknown>>(query: string, parameters?: unknown[]) {
        return pool.query<T>(query, parameters);
      },
    };
    const tables = await fixture.query(
      "SELECT count(*)::integer AS count FROM information_schema.tables WHERE table_schema='public'",
    );
    if (tables.rows[0]?.count !== 0)
      throw new Error("PostgreSQL funding test database must be empty");
  } else {
    const pglite = client.getPgliteClientForTests();
    fixture = {
      async exec(query) {
        await pglite.exec(query);
      },
      async query<T extends Record<string, unknown>>(query: string, parameters?: unknown[]) {
        return pglite.query<T>(query, parameters);
      },
    };
  }
  await createBillingSnapshotFixture((query) => fixture.exec(query), "");
  await fixture.exec(`
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
  await fixture.exec(`
    ALTER TABLE agent_sandboxes ADD CONSTRAINT agent_sandboxes_id_organization_unique UNIQUE(id, organization_id);
    ALTER TABLE agent_sandboxes ADD COLUMN IF NOT EXISTS node_id text;
    INSERT INTO agent_sandboxes(id,organization_id,status,execution_tier,lifecycle_revision)
    VALUES ('63000000-0000-4000-8000-000000000001','${organizationId}','provisioning','dedicated-always',1);
  `);
  const computeMigration = await readFile(
    new URL("../../db/migrations/0387_agent_compute_funding.sql", import.meta.url),
    "utf8",
  );
  await fixture.exec(computeMigration);
  // The generated migration must also be safe when recovery repeats it.
  await fixture.exec(computeMigration);
  const stopMigration = await readFile(
    new URL("../../db/migrations/0389_agent_compute_stop_receipts.sql", import.meta.url),
    "utf8",
  );
  await fixture.exec(stopMigration);
  await fixture.exec(stopMigration);
  const legacyBillingMigration = await readFile(
    new URL("../../db/migrations/0265_compute_billing_recovery.sql", import.meta.url),
    "utf8",
  );
  const legacyReceiptTable = legacyBillingMigration.match(
    /CREATE TABLE agent_billing_records \([\s\S]*?\n\);/,
  );
  if (!legacyReceiptTable) throw new Error("Missing canonical legacy billing receipt DDL");
  await fixture.exec(legacyReceiptTable[0]);
  const receiptMigration = await readFile(
    new URL("../../db/migrations/0388_agent_compute_funded_receipts.sql", import.meta.url),
    "utf8",
  );
  await fixture.exec(receiptMigration);
  await fixture.exec(receiptMigration);
  await fixture.exec(
    await readFile(
      new URL("../../db/migrations/0274_agent_billing_run_receipts.sql", import.meta.url),
      "utf8",
    ),
  );
  const baseline = await readFile(
    new URL("../../db/migrations/0000_last_reavers.sql", import.meta.url),
    "utf8",
  );
  const jobsDDL = baseline.match(/CREATE TABLE "jobs" \([\s\S]*?\n\);/);
  if (!jobsDDL) throw new Error("Missing canonical jobs DDL");
  await fixture.exec(jobsDDL[0]);
  const { jobs } = await import("../../db/schemas/jobs");
  for (const column of getTableConfig(jobs).columns) {
    await fixture.exec(
      `ALTER TABLE jobs ADD COLUMN IF NOT EXISTS "${column.name}" ${column.getSQLType()}`,
    );
  }
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
  await fixture.query(
    `UPDATE subscription_allowance_periods SET subscription_revision=$1,
      period_start=$2,period_end=$3,expires_at=$3 WHERE organization_id=$4`,
    [advanced.subscription.lifecycle_revision, periodStart, periodEnd, allowanceOrganizationId],
  );
}, 120000);

afterAll(async () => {
  await client.closeDatabaseConnectionsForTests();
  await postgresPool?.end();
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
    await fixture.query<{
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
      await fixture.query(
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
  expect((await fixture.query("SELECT * FROM agent_compute_funding")).rows).toHaveLength(0);
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
  expect(fundedState).toEqual({ balance: "3.230001", reservations: 3, debits: 4 });
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
    fixture.query("UPDATE agent_compute_funding SET settled_at=now() WHERE id=$1", [bound.id]),
  ).rejects.toThrow("agent_compute_funding_settlement_check");
  await fixture.query("UPDATE organizations SET paid_work_fenced_at=now() WHERE id=$1", [
    organizationId,
  ]);
  await expect(
    helpers.writeTransaction((tx) => compute.reserveInTransaction(tx, identity)),
  ).rejects.toMatchObject({ code: AGENT_COMPUTE_FUNDING_AUTHORITY_CHANGED });
  expect(await state()).toEqual(fundedState);
  await fixture.query("UPDATE organizations SET paid_work_fenced_at=NULL WHERE id=$1", [
    organizationId,
  ]);
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
  await fixture.query(
    `INSERT INTO organizations(id,credit_balance,balance_revision,balance_decrease_revision,settings,is_active,auto_top_up_enabled,account_lifecycle_state)
    VALUES ($1,'0.000000',1,0,'{}',true,false,'active')`,
    [unfundedOrg],
  );
  await fixture.query(
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
  await fixture.query("UPDATE agent_sandboxes SET execution_tier='shared' WHERE id=$1", [
    identity.agentId,
  ]);
  await expect(
    helpers.writeTransaction((tx) => compute.reserveInTransaction(tx, identity)),
  ).rejects.toMatchObject({ code: AGENT_COMPUTE_FUNDING_AUTHORITY_CHANGED });
  await fixture.query("UPDATE agent_sandboxes SET execution_tier='dedicated-always' WHERE id=$1", [
    identity.agentId,
  ]);
  await expect(
    fixture.query("UPDATE agent_compute_funding SET hourly_rate='NaN' WHERE agent_id=$1", [
      identity.agentId,
    ]),
  ).rejects.toThrow("agent_compute_funding_period_check");
  await fixture.query(
    "UPDATE agent_compute_funding SET period_start=now()-interval '2 hours',period_end=now()-interval '1 hour' WHERE agent_id=$1",
    [identity.agentId],
  );
  await expect(
    helpers.writeTransaction((tx) => compute.reserveInTransaction(tx, identity)),
  ).rejects.toMatchObject({ code: AGENT_COMPUTE_FUNDING_EXPIRED });
  expect(await state()).toEqual(before);
});

async function runningFundedAgent(
  org: string,
  agentId: string,
  providerTarget?: { nodeId: string; containerId: string },
) {
  const { agentComputeFundingService: compute } = await import("./agent-compute-funding");
  await fixture.query(
    `INSERT INTO agent_sandboxes(id,organization_id,status,execution_tier,lifecycle_revision)
      VALUES ($1,$2,'provisioning','dedicated-always',1)`,
    [agentId, org],
  );
  const identity = { agentId, organizationId: org, lifecycleRevision: 1 };
  const reserved = await helpers.writeTransaction((tx) =>
    compute.reserveInTransaction(tx, identity),
  );
  const provider = {
    ...identity,
    fundingId: reserved.window.id,
    nodeId: providerTarget?.nodeId ?? "renewal-test-node",
    containerId: providerTarget?.containerId ?? "c".repeat(64),
  };
  await helpers.writeTransaction((tx) => compute.bindProviderInTransaction(tx, provider));
  const authorization = await helpers.writeTransaction((tx) =>
    compute.authorizeHostInTransaction(tx, provider),
  );
  expect(authorization.previousFundingId).toBeNull();
  expect(authorization.containerId).toBe(provider.containerId);
  expect(authorization.paidUntilMs - authorization.paidFromMs).toBe(2 * 60 * 60_000);
  await helpers.writeTransaction((tx) => compute.confirmHostLeaseInTransaction(tx, provider));
  await fixture.query("UPDATE agent_sandboxes SET status='running',node_id=$2 WHERE id=$1", [
    agentId,
    provider.nodeId,
  ]);
  // Advance this fixture's paid interval while retaining a full two-hour hold.
  // The meter supplies one hour of actual usage; no fake provider or credit service is substituted.
  await fixture.query(
    "UPDATE agent_compute_funding SET period_start=clock_timestamp()-interval '1 hour',period_end=clock_timestamp()+interval '1 hour' WHERE id=$1",
    [reserved.window.id],
  );
  return { compute, identity, provider, reserved };
}

async function renewalState(org: string) {
  const [balance, windows, reservations, allocations, ledger] = await Promise.all([
    fixture.query("SELECT credit_balance::text FROM organizations WHERE id=$1", [org]),
    fixture.query("SELECT * FROM agent_compute_funding WHERE organization_id=$1 ORDER BY id", [
      org,
    ]),
    fixture.query(
      "SELECT * FROM billing_funding_reservations WHERE organization_id=$1 ORDER BY id",
      [org],
    ),
    fixture.query(
      "SELECT * FROM billing_funding_allocations WHERE organization_id=$1 ORDER BY id",
      [org],
    ),
    fixture.query("SELECT * FROM credit_transactions WHERE organization_id=$1 ORDER BY id", [org]),
  ]);
  return {
    balance: balance.rows,
    windows: windows.rows,
    reservations: reservations.rows,
    allocations: allocations.rows,
    ledger: ledger.rows,
  };
}

test("concurrent renewals exchange one hold, preserve source accounting, and require a host acknowledgement", async () => {
  const org = "61000000-0000-4000-8000-000000000004";
  await fixture.query(
    `INSERT INTO organizations(id,credit_balance,balance_revision,balance_decrease_revision,settings,is_active,auto_top_up_enabled,account_lifecycle_state)
      VALUES ($1,'1.000000',1,0,'{}',true,false,'active')`,
    [org],
  );
  const { compute, identity, provider, reserved } = await runningFundedAgent(
    org,
    "63000000-0000-4000-8000-000000000004",
  );
  const request = {
    ...identity,
    fundingId: reserved.window.id,
    settledThrough: new Date(),
    actualAmount: "0.010000",
  };
  const [first, replay] = await Promise.all([
    helpers.writeTransaction((tx) => compute.renewInTransaction(tx, request)),
    helpers.writeTransaction((tx) => compute.renewInTransaction(tx, request)),
  ]);
  expect(first.window.id).toBe(replay.window.id);
  expect([first.replayed, replay.replayed].sort()).toEqual([false, true]);
  expect(first.window.previous_funding_id).toBe(reserved.window.id);
  expect(first.window.provider_container_id).toBe(provider.containerId);
  expect(first.window.host_lease_confirmed_at).toBeNull();
  const after = await renewalState(org);
  expect(after.balance).toEqual([{ credit_balance: "0.970000" }]);
  expect(after.windows).toHaveLength(2);
  expect(after.reservations).toHaveLength(2);
  expect(after.ledger).toHaveLength(3);
  expect(
    after.allocations
      .map((row) => ({
        reserved: row.reserved_amount,
        finalized: row.finalized_amount,
        released: row.released_amount,
      }))
      .sort((a, b) => String(a.finalized).localeCompare(String(b.finalized))),
  ).toEqual([
    { reserved: "0.020000", finalized: "0.000000", released: "0.000000" },
    { reserved: "0.020000", finalized: "0.010000", released: "0.010000" },
  ]);
  await helpers.writeTransaction(async (tx) => {
    await expect(
      compute.renewInTransaction(tx, { ...request, actualAmount: "0.009000" }),
    ).rejects.toMatchObject({ code: "SUBSCRIPTION_FUNDING_CONFLICT" });
  });
  expect(await renewalState(org)).toEqual(after);
  await expect(
    helpers.writeTransaction((tx) =>
      compute.renewInTransaction(tx, {
        ...request,
        fundingId: first.window.id,
        settledThrough: new Date(),
      }),
    ),
  ).rejects.toMatchObject({ code: "AGENT_COMPUTE_FUNDING_UNCONFIRMED" });
  const newProvider = { ...provider, fundingId: first.window.id };
  const authorization = await helpers.writeTransaction((tx) =>
    compute.authorizeHostInTransaction(tx, newProvider),
  );
  expect(authorization.previousFundingId).toBe(reserved.window.id);
  expect(authorization.paidFromMs).toBe(request.settledThrough.getTime());
  await helpers.writeTransaction((tx) => compute.confirmHostLeaseInTransaction(tx, newProvider));
  await expect(
    helpers.writeTransaction((tx) => compute.authorizeHostInTransaction(tx, provider)),
  ).rejects.toMatchObject({ code: "AGENT_COMPUTE_FUNDING_AUTHORITY_CHANGED" });
});

test("a caught failed renewal rolls back its allowance settlement, cash refund, and successor before the outer transaction commits", async () => {
  // Leave exactly half a cent of paid allowance and 1.5 cents of cash for this agent.
  await helpers.writeTransaction(async (tx) => {
    await funding.subscriptionFundingService.reserveInTransaction(tx, {
      ...input("compute:renewal-allowance-buffer", "24.995001"),
      organizationId: allowanceOrganizationId,
    });
    await funding.subscriptionFundingService.reserveInTransaction(tx, {
      ...input("compute:renewal-cash-buffer", "9.985001"),
      organizationId: allowanceOrganizationId,
      operation: "unclassified",
    });
  });
  const { compute, identity, reserved } = await runningFundedAgent(
    allowanceOrganizationId,
    "63000000-0000-4000-8000-000000000005",
  );
  const before = await renewalState(allowanceOrganizationId);
  const allowanceBefore = (
    await fixture.query("SELECT * FROM subscription_allowance_periods WHERE organization_id=$1", [
      allowanceOrganizationId,
    ])
  ).rows;
  expect(before.balance).toEqual([{ credit_balance: "0.000000" }]);
  await helpers.writeTransaction(async (tx) => {
    await expect(
      compute.renewInTransaction(tx, {
        ...identity,
        fundingId: reserved.window.id,
        settledThrough: new Date(),
        actualAmount: "0.010000",
      }),
    ).rejects.toMatchObject({ code: funding.SUBSCRIPTION_FUNDING_INSUFFICIENT });
    // Prove the outer transaction remains usable after the rejected exchange.
    await tx.execute(
      sql`UPDATE organizations SET settings='{"renewal_stop_needed":true}'::jsonb WHERE id=${allowanceOrganizationId}`,
    );
  });
  expect(await renewalState(allowanceOrganizationId)).toEqual(before);
  expect(
    (
      await fixture.query("SELECT * FROM subscription_allowance_periods WHERE organization_id=$1", [
        allowanceOrganizationId,
      ])
    ).rows,
  ).toEqual(allowanceBefore);
  expect(
    (
      await fixture.query("SELECT settings FROM organizations WHERE id=$1", [
        allowanceOrganizationId,
      ])
    ).rows,
  ).toEqual([{ settings: { renewal_stop_needed: true } }]);
});

test("a usage receipt must match one finalized funding source, its exact amount, tenant and metered period", async () => {
  const org = "61000000-0000-4000-8000-000000000004";
  const agentId = "63000000-0000-4000-8000-000000000004";
  const windows = (
    await fixture.query<{ id: string; settled_at: Date | null }>(
      "SELECT id,settled_at FROM agent_compute_funding WHERE organization_id=$1",
      [org],
    )
  ).rows;
  const settled = windows.find((window) => window.settled_at !== null);
  const open = windows.find((window) => window.settled_at === null);
  if (!settled || !open) throw new Error("Missing real completed renewal fixture");
  const insert = (fundingId: string, amount: string, receiptOrg = org) =>
    fixture.query(
      `INSERT INTO agent_billing_records(organization_id,sandbox_id,sandbox_status,billing_period_start,billing_period_end,hourly_rate,amount,compute_funding_id)
      SELECT $1,$2,'running',date_trunc('milliseconds',period_start),COALESCE(settled_through,period_end),hourly_rate,$3,id
      FROM agent_compute_funding WHERE id=$4`,
      [receiptOrg, agentId, amount, fundingId],
    );
  const before = await renewalState(org);
  await expect(insert(open.id, "0.010000")).rejects.toThrow("agent billing receipt must match");
  await expect(insert(settled.id, "0.009000")).rejects.toThrow("agent billing receipt must match");
  await expect(insert(settled.id, "0.010000", organizationId)).rejects.toThrow(
    "agent billing receipt must match",
  );
  await expect(
    fixture.query(
      `INSERT INTO agent_billing_records(organization_id,sandbox_id,sandbox_status,billing_period_start,billing_period_end,hourly_rate,amount,compute_funding_id)
      SELECT organization_id,agent_id,'running',date_trunc('milliseconds',period_start),settled_through+interval '1 second',hourly_rate,'0.010000',id
      FROM agent_compute_funding WHERE id=$1`,
      [settled.id],
    ),
  ).rejects.toThrow("agent billing receipt must match");
  await expect(
    fixture.query(
      `INSERT INTO agent_billing_records(organization_id,sandbox_id,sandbox_status,billing_period_start,billing_period_end,hourly_rate,amount,compute_funding_id,credit_transaction_id)
      SELECT organization_id,agent_id,'running',date_trunc('milliseconds',period_start),settled_through,hourly_rate,'0.010000',id,
        (SELECT id FROM credit_transactions WHERE organization_id=$2 LIMIT 1)
      FROM agent_compute_funding WHERE id=$1`,
      [settled.id, org],
    ),
  ).rejects.toThrow("agent_billing_records_funding_source_check");
  await insert(settled.id, "0.010000");
  await expect(insert(settled.id, "0.010000")).rejects.toThrow(
    "agent_billing_records_compute_funding_idx",
  );
  expect(
    (
      await fixture.query(
        "SELECT amount::text,credit_transaction_id,compute_funding_id FROM agent_billing_records WHERE organization_id=$1",
        [org],
      )
    ).rows,
  ).toEqual([{ amount: "0.010000", credit_transaction_id: null, compute_funding_id: settled.id }]);
  expect(await renewalState(org)).toEqual(before);
});

async function billableFundedAgent(
  suffix: string,
  balance: string,
  providerTarget?: { nodeId: string; containerId: string },
) {
  const org = `61000000-0000-4000-8000-${suffix}`;
  const agentId = `63000000-0000-4000-8000-${suffix}`;
  const userId = `64000000-0000-4000-8000-${suffix}`;
  await fixture.query("INSERT INTO users(id) VALUES($1)", [userId]);
  await fixture.query(
    `INSERT INTO organizations(id,credit_balance,balance_revision,balance_decrease_revision,settings,is_active,auto_top_up_enabled,account_lifecycle_state)
    VALUES ($1,$2,1,0,'{}',true,false,'active')`,
    [org, balance],
  );
  const funded = await runningFundedAgent(org, agentId, providerTarget);
  await fixture.query(
    `UPDATE agent_compute_funding SET period_start=date_trunc('milliseconds',period_start) WHERE id=$1`,
    [funded.provider.fundingId],
  );
  await fixture.query(
    `UPDATE agent_sandboxes SET user_id=$2,agent_name='Funded test',billing_status='active',total_billed=0,
    last_billed_at=(SELECT period_start FROM agent_compute_funding WHERE id=$3),created_at=now()-interval '2 hours' WHERE id=$1`,
    [agentId, userId, funded.provider.fundingId],
  );
  await fixture.query(
    `INSERT INTO compute_billing_rate_segments(id,organization_id,workload_kind,workload_id,lifecycle_revision,billing_state,rate_per_hour,effective_at)
    SELECT gen_random_uuid(),$1,'agent',$2,1,'running','0.01',period_start FROM agent_compute_funding WHERE id=$3`,
    [org, agentId, funded.provider.fundingId],
  );
  const { agentBillingRunRepository } = await import("../../db/repositories/agent-billing-runs");
  const run = await agentBillingRunRepository.startOrLoad({
    invocationKey: `manual:prepaid:${suffix}`,
    triggerKind: "manual",
    schedule: null,
    scheduledAt: null,
    leaseDurationMs: 300_000,
  });
  if (!run.leaseToken) throw new Error("Billing test did not claim its run");
  const { agentBillingRepository } = await import("../../db/repositories/agent-billing");
  const cutoff = await fixture.query<{ cutoff: Date }>(
    "SELECT period_start+interval '1 hour' AS cutoff FROM agent_compute_funding WHERE id=$1",
    [funded.provider.fundingId],
  );
  return {
    ...funded,
    org,
    agentId,
    agentBillingRepository,
    input: {
      runId: run.run.id,
      leaseToken: run.leaseToken,
      sandboxId: agentId,
      organizationId: org,
      userId,
      agentName: "Funded test",
      hourlyRate: 99,
      billingDescription: "Must use the canonical meter",
      lowCreditWarningAmount: 0.1,
      now: cutoff.rows[0]!.cutoff,
    },
  };
}

test("the real hourly biller settles a funded hour once and commits its receipt with one renewal job", async () => {
  const { org, agentId, provider, input, agentBillingRepository } = await billableFundedAgent(
    "000000000010",
    "1.000000",
  );
  const outcomes = await Promise.all([
    agentBillingRepository.recordHourlyBilling(input),
    agentBillingRepository.recordHourlyBilling(input),
  ]);
  expect(outcomes.map((value) => value.status).sort()).toEqual([
    "already_billed_recently",
    "billed",
  ]);
  const billed = outcomes.find((value) => value.status === "billed");
  expect(billed).toMatchObject({
    amountDecimal: "0.010000",
    newBalance: 0.97,
    transactionId: `compute-funding:${provider.fundingId}`,
  });
  const after = await renewalState(org);
  expect(after.ledger).toHaveLength(3); // initial hold, unused remainder refund, replacement hold; no usage cash debit.
  expect(after.windows).toHaveLength(2);
  const receipts = await fixture.query(
    "SELECT compute_funding_id,credit_transaction_id,amount::text FROM agent_billing_records WHERE sandbox_id=$1",
    [agentId],
  );
  expect(receipts.rows).toEqual([
    { compute_funding_id: provider.fundingId, credit_transaction_id: null, amount: "0.010000" },
  ]);
  const jobs = await fixture.query("SELECT * FROM jobs WHERE agent_id=$1", [agentId]);
  expect(jobs.rows).toHaveLength(1);
  const { readAgentComputeLeaseJobData } = await import("./agent-compute-lease-jobs");
  const job = jobs.rows[0] as unknown as import("../../db/schemas/jobs").Job;
  expect(readAgentComputeLeaseJobData(job)).toEqual({
    agentId,
    organizationId: org,
    fundingId: job.id,
    lifecycleRevision: 1,
  });
  expect(job.type).toBe("agent_compute_lease");
  expect(job.status).toBe("pending");
  expect(() => readAgentComputeLeaseJobData({ ...job, organization_id: organizationId })).toThrow(
    "identity changed",
  );
  const runItems = await fixture.query(
    "SELECT action,amount::text,new_balance::text,transaction_id FROM agent_billing_run_items WHERE run_id=$1",
    [input.runId],
  );
  expect(runItems.rows).toEqual([
    {
      action: "billed",
      amount: "0.010000",
      new_balance: "0.970000",
      transaction_id: `compute-funding:${provider.fundingId}`,
    },
  ]);
});

test("failed durable job delivery rolls back the hourly funding exchange, receipt and billing cursor", async () => {
  const { org, agentId, input, agentBillingRepository } = await billableFundedAgent(
    "000000000011",
    "1.000000",
  );
  const before = await renewalState(org);
  const cursor = await fixture.query(
    "SELECT last_billed_at,total_billed::text FROM agent_sandboxes WHERE id=$1",
    [agentId],
  );
  // Real database failure after settlement: no service is mocked and the outer transaction must undo every financial write.
  await fixture.exec(`CREATE FUNCTION reject_test_renewal_job() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF NEW.agent_id='${agentId}' THEN RAISE EXCEPTION 'test renewal job unavailable'; END IF; RETURN NEW; END $$;
    CREATE TRIGGER reject_test_renewal_job BEFORE INSERT ON jobs FOR EACH ROW EXECUTE FUNCTION reject_test_renewal_job();`);
  try {
    await expect(agentBillingRepository.recordHourlyBilling(input)).rejects.toThrow();
    expect(await renewalState(org)).toEqual(before);
    expect(
      (
        await fixture.query(
          "SELECT last_billed_at,total_billed::text FROM agent_sandboxes WHERE id=$1",
          [agentId],
        )
      ).rows,
    ).toEqual(cursor.rows);
    expect(
      (await fixture.query("SELECT id FROM agent_billing_records WHERE sandbox_id=$1", [agentId]))
        .rows,
    ).toHaveLength(0);
    expect(
      (await fixture.query("SELECT id FROM agent_billing_run_items WHERE run_id=$1", [input.runId]))
        .rows,
    ).toHaveLength(0);
  } finally {
    await fixture.exec(
      "DROP TRIGGER reject_test_renewal_job ON jobs; DROP FUNCTION reject_test_renewal_job();",
    );
  }
  expect(await agentBillingRepository.recordHourlyBilling(input)).toMatchObject({
    status: "billed",
    amountDecimal: "0.010000",
  });
});

test("an unfundable hourly renewal keeps its existing hold and returns the canonical shutdown outcome", async () => {
  const { org, agentId, input, agentBillingRepository } = await billableFundedAgent(
    "000000000012",
    "0.020000",
  );
  const before = await renewalState(org);
  expect(await agentBillingRepository.recordHourlyBilling(input)).toEqual({
    status: "insufficient_credits",
  });
  expect(await renewalState(org)).toEqual(before);
  expect(
    (await fixture.query("SELECT id FROM jobs WHERE agent_id=$1", [agentId])).rows,
  ).toHaveLength(0);
  expect(
    (await fixture.query("SELECT id FROM agent_billing_records WHERE sandbox_id=$1", [agentId]))
      .rows,
  ).toHaveLength(0);
});

async function stopReceiptFor(fundingId: string, stoppedAt: Date) {
  const { rows } = await fixture.query<{
    id: string;
    agent_id: string;
    organization_id: string;
    provider_container_id: string;
    previous_funding_id: string | null;
    period_start: Date;
    period_end: Date;
  }>("SELECT * FROM agent_compute_funding WHERE id=$1", [fundingId]);
  const window = rows[0]!;
  return {
    authorization: {
      agentId: window.agent_id,
      organizationId: window.organization_id,
      containerId: window.provider_container_id,
      fundingId: window.id,
      previousFundingId: window.previous_funding_id,
      issuedAtMs: Date.now(),
      paidFromMs: window.period_start.getTime(),
      paidUntilMs: window.period_end.getTime(),
    },
    bootId: crypto.randomUUID(),
    expired: true,
    stoppedAtMs: stoppedAt.getTime(),
  };
}

test("stopped runtime refunds its unused hold atomically, including for an inactive account, without replaying the refund", async () => {
  const { org, agentId, identity, provider, input } = await billableFundedAgent(
    "000000000020",
    "1.000000",
  );
  const { settleStoppedAgentComputeInTransaction: settle } = await import("./agent-compute-stop");
  const receipt = await stopReceiptFor(provider.fundingId, input.now);
  const request = { ...identity, fundingId: provider.fundingId };
  const before = await renewalState(org);
  await expect(
    helpers.writeTransaction((tx) => settle(tx, request, { ...receipt, expired: false })),
  ).rejects.toThrow();
  await expect(
    helpers.writeTransaction((tx) =>
      settle(tx, request, {
        ...receipt,
        authorization: { ...receipt.authorization, containerId: "e".repeat(64) },
      }),
    ),
  ).rejects.toThrow();
  expect(await renewalState(org)).toEqual(before);
  await expect(
    helpers.writeTransaction(async (tx) => {
      await settle(tx, request, receipt);
      throw new Error("stop writeback failed");
    }),
  ).rejects.toThrow("stop writeback failed");
  expect(await renewalState(org)).toEqual(before);
  expect(
    (await fixture.query("SELECT id FROM agent_billing_records WHERE sandbox_id=$1", [agentId]))
      .rows,
  ).toHaveLength(0);
  await fixture.query(
    "UPDATE organizations SET is_active=false,paid_work_fenced_at=now() WHERE id=$1",
    [org],
  );
  expect(await helpers.writeTransaction((tx) => settle(tx, request, receipt))).toMatchObject({
    replayed: false,
    purchasedCreditRefunded: true,
  });
  const after = await renewalState(org);
  expect(after.balance).toEqual([{ credit_balance: "0.990000" }]);
  expect(after.ledger).toHaveLength(2);
  expect(
    (
      await fixture.query(
        "SELECT amount::text,compute_funding_id,credit_transaction_id FROM agent_billing_records WHERE sandbox_id=$1",
        [agentId],
      )
    ).rows,
  ).toEqual([
    { amount: "0.010000", compute_funding_id: provider.fundingId, credit_transaction_id: null },
  ]);
  expect(await helpers.writeTransaction((tx) => settle(tx, request, receipt))).toMatchObject({
    replayed: true,
    purchasedCreditRefunded: false,
  });
  expect(await renewalState(org)).toEqual(after);
  await expect(
    helpers.writeTransaction((tx) =>
      settle(tx, request, { ...receipt, stoppedAtMs: receipt.stoppedAtMs + 1 }),
    ),
  ).rejects.toThrow();
  expect(await renewalState(org)).toEqual(after);
});

test("a delayed expiry reconciliation bills only through the durable host stop time", async () => {
  const { org, agentId, identity, provider } = await billableFundedAgent(
    "000000000021",
    "1.000000",
  );
  await fixture.query(
    `UPDATE agent_compute_funding SET period_end=period_start+interval '30 minutes',
    provider_bound_at=period_start,host_lease_confirmed_at=period_start WHERE id=$1`,
    [provider.fundingId],
  );
  const { rows } = await fixture.query<{ stopped_at: Date }>(
    "SELECT period_end-interval '1 minute' AS stopped_at FROM agent_compute_funding WHERE id=$1",
    [provider.fundingId],
  );
  const receipt = await stopReceiptFor(provider.fundingId, rows[0]!.stopped_at);
  const { settleStoppedAgentComputeInTransaction: settle } = await import("./agent-compute-stop");
  await helpers.writeTransaction((tx) =>
    settle(tx, { ...identity, fundingId: provider.fundingId }, receipt),
  );
  expect((await renewalState(org)).balance).toEqual([{ credit_balance: "0.995167" }]);
  expect(
    (
      await fixture.query(
        "SELECT amount::text,billing_period_end FROM agent_billing_records WHERE sandbox_id=$1",
        [agentId],
      )
    ).rows,
  ).toEqual([{ amount: "0.004833", billing_period_end: rows[0]!.stopped_at }]);
});

test("revoking an undelivered successor after its predecessor stopped releases the whole unused window", async () => {
  const { org, agentId, identity, input, agentBillingRepository } = await billableFundedAgent(
    "000000000022",
    "1.000000",
  );
  await agentBillingRepository.recordHourlyBilling(input);
  const { rows } = await fixture.query<{ id: string; period_start: Date }>(
    "SELECT id,period_start FROM agent_compute_funding WHERE agent_id=$1 AND settled_at IS NULL",
    [agentId],
  );
  const current = rows[0]!;
  const receipt = await stopReceiptFor(current.id, new Date(current.period_start.getTime() - 1));
  const { settleStoppedAgentComputeInTransaction: settle } = await import("./agent-compute-stop");
  await helpers.writeTransaction((tx) =>
    settle(tx, { ...identity, fundingId: current.id }, receipt),
  );
  expect((await renewalState(org)).balance).toEqual([{ credit_balance: "0.990000" }]);
  expect(
    (
      await fixture.query("SELECT id FROM agent_billing_records WHERE compute_funding_id=$1", [
        current.id,
      ])
    ).rows,
  ).toHaveLength(0);
  const stopped = await fixture.query(
    "SELECT provider_stop_receipt,settled_at IS NOT NULL AS settled FROM agent_compute_funding WHERE id=$1",
    [current.id],
  );
  expect(stopped.rows[0]).toMatchObject({
    settled: true,
    provider_stop_receipt: { fundingId: current.id, stoppedAtMs: receipt.stoppedAtMs },
  });
});

test("paid lease recovery cannot authorize an unreconciled legacy lifecycle transition", async () => {
  const { org, agentId, input, agentBillingRepository } = await billableFundedAgent(
    "000000000031",
    "1.000000",
  );
  const before = await renewalState(org);
  await expect(
    helpers.writeTransaction((tx) =>
      agentBillingRepository.settleAccruedBillingBeforeLifecycleInTransaction(
        tx,
        agentId,
        org,
        input.now,
      ),
    ),
  ).rejects.toMatchObject({ code: "AGENT_COMPUTE_BILLING_RECONCILIATION_REQUIRED" });
  expect(await renewalState(org)).toEqual(before);
  expect(
    await helpers.writeTransaction((tx) =>
      agentBillingRepository.settleAccruedBillingBeforeLifecycleInTransaction(
        tx,
        agentId,
        org,
        input.now,
        "billing_recovery",
      ),
    ),
  ).toMatchObject({ status: "billed" });
  const after = await renewalState(org);
  expect(after.balance).toEqual([{ credit_balance: "0.970000" }]);
  expect(after.windows).toHaveLength(2);
  expect(after.reservations).toHaveLength(2);
});

if (sshFixturePath) {
  test("real Docker stop survives a PostgreSQL rollback and app suspension refunds once", async () => {
    const target = z
      .object({
        hostname: z.ipv4(),
        port: z.number().int().min(1).max(65535),
        username: z.string().regex(/^[a-z_][a-z0-9_-]*$/),
        hostKeyFingerprint: z.string().regex(/^SHA256:[A-Za-z0-9+/]+$/),
        image: z.string().regex(/^sha256:[a-f0-9]{64}$/),
      })
      .strict()
      .parse(JSON.parse(await readFile(sshFixturePath, "utf8")));
    const { DockerSSHClient } = await import("./docker-ssh");
    const { shellQuote } = await import("./docker-sandbox-utils");
    const guard = await import("./docker-compute-lease");
    const { stopFundedAgentInTransaction, settleStoppedAgentComputeInTransaction } = await import(
      "./agent-compute-stop"
    );
    const ssh = new DockerSSHClient(target);
    const rootSSH = guard.dockerComputeRootSSH(ssh, target.username);
    const name = `eliza-compute-stop-integration-${crypto.randomUUID()}`;
    const nodeId = `stop-test-${crypto.randomUUID()}`;
    const org = "61000000-0000-4000-8000-000000000030";
    const agentId = "63000000-0000-4000-8000-000000000030";
    const marker = crypto.randomUUID();
    let containerId: string | undefined;
    let ownsGuard = false;
    let originalRunning: string[] = [];
    const docker = target.username === "root" ? "docker" : "sudo --non-interactive docker";
    await ssh.connect();
    try {
      originalRunning = (await ssh.exec(`${docker} ps -q --no-trunc`))
        .trim()
        .split("\n")
        .filter(Boolean)
        .sort();
      await rootSSH.execStdin(
        "python3 -",
        `from pathlib import Path\nassert not Path('/var/lib/eliza/compute-leases').exists()\nassert not Path('/etc/systemd/system/eliza-compute-guard.service').exists()\n`,
      );
      containerId = (
        await ssh.exec(
          [
            `${docker} create --pull=never --network=none --memory=64m --cpus=0.2 --pids-limit=32`,
            "--cap-drop=ALL --security-opt=no-new-privileges --user=65534:65534 --restart=no",
            `--name ${shellQuote(name)} --label ai.elizaos.managed-by=eliza-cloud --label ai.elizaos.container-class=test`,
            `--label ai.elizaos.agent-id=${agentId} --label ai.elizaos.org-id=${org}`,
            `--entrypoint /bin/sh ${shellQuote(target.image)} -c 'exec sleep 600'`,
          ].join(" "),
        )
      ).trim();
      expect(containerId).toMatch(/^[a-f0-9]{64}$/);
      const { dockerNodes } = await import("../../db/schemas/docker-nodes");
      const columns = getTableConfig(dockerNodes).columns.map(
        (column) => `"${column.name}" ${column.getSQLType()}`,
      );
      await fixture.exec(`CREATE TABLE docker_nodes (${columns.join(", ")})`);
      await fixture.query(
        "INSERT INTO docker_nodes(id,node_id,hostname,ssh_port,ssh_user,host_key_fingerprint) VALUES(gen_random_uuid(),$1,$2,$3,$4,$5)",
        [nodeId, target.hostname, target.port, target.username, target.hostKeyFingerprint],
      );
      const { compute, identity, provider } = await billableFundedAgent(
        "000000000030",
        "1.000000",
        { nodeId, containerId },
      );
      await fixture.query("UPDATE agent_sandboxes SET sandbox_id=$2 WHERE id=$1", [
        agentId,
        `docker://${nodeId}/${name}`,
      ]);
      const authorization = await helpers.writeTransaction((tx) =>
        compute.authorizeHostInTransaction(tx, provider),
      );
      ownsGuard = true;
      await guard.installDockerComputeGuard(rootSSH);
      await guard.grantDockerComputeLease(rootSSH, authorization);
      await guard.startDockerComputeLease(rootSSH, authorization);
      await ssh.exec(
        `${docker} exec ${containerId} /bin/sh -c ${shellQuote(`printf '%s' '${marker}' > /tmp/stop-marker`)}`,
      );
      const before = await renewalState(org);
      await expect(
        helpers.writeTransaction(async (tx) => {
          await stopFundedAgentInTransaction(tx, identity);
          throw new Error("Forced outer PostgreSQL rollback after real Docker stop");
        }),
      ).rejects.toThrow("Forced outer PostgreSQL rollback");
      expect(await renewalState(org)).toEqual(before);
      expect(
        (await ssh.exec(`${docker} inspect --format '{{.State.Running}}' ${containerId}`)).trim(),
      ).toBe("false");
      const { elizaSandboxService } = await import("./eliza-sandbox");
      expect(
        await elizaSandboxService.executeSuspend(agentId, org, crypto.randomUUID(), "user_request"),
      ).toMatchObject({ success: true, containerStopped: true });
      const settled = await fixture.query<{
        provider_stop_receipt: { bootId: string; stoppedAtMs: number };
        settled: boolean;
      }>(
        "SELECT provider_stop_receipt,settled_at IS NOT NULL AS settled FROM agent_compute_funding WHERE id=$1",
        [provider.fundingId],
      );
      expect(settled.rows[0]?.settled).toBe(true);
      const totals = await fixture.query(
        `SELECT a.status,a.sandbox_id,a.billing_status,
        (SELECT count(*)::int FROM credit_transactions WHERE organization_id=$2) AS ledger_count,
        (SELECT count(*)::int FROM agent_billing_records WHERE sandbox_id=$1) AS receipt_count,
        (o.credit_balance+a.total_billed)=1.000000 AS reconciled
        FROM agent_sandboxes a JOIN organizations o ON o.id=a.organization_id WHERE a.id=$1`,
        [agentId, org],
      );
      expect(totals.rows[0]).toMatchObject({
        status: "stopped",
        sandbox_id: `docker://${nodeId}/${name}`,
        ledger_count: 2,
        receipt_count: 1,
        reconciled: true,
      });
      const after = await renewalState(org);
      const receipt = {
        authorization,
        expired: true as const,
        ...settled.rows[0]!.provider_stop_receipt,
      };
      expect(
        await helpers.writeTransaction((tx) =>
          settleStoppedAgentComputeInTransaction(
            tx,
            { ...identity, fundingId: provider.fundingId },
            receipt,
          ),
        ),
      ).toMatchObject({ replayed: true, purchasedCreditRefunded: false });
      expect(await renewalState(org)).toEqual(after);
      expect(
        (await ssh.exec(`${docker} cp ${containerId}:/tmp/stop-marker - | tar -xO`)).trim(),
      ).toBe(marker);
      await expect(
        guard.grantDockerComputeLease(rootSSH, { ...authorization, issuedAtMs: Date.now() }),
      ).rejects.toThrow("funding_revoked");
      expect(
        (await ssh.exec(`${docker} inspect --format '{{.State.Running}}' ${containerId}`)).trim(),
      ).toBe("false");
    } finally {
      try {
        if (containerId) await ssh.exec(`${docker} rm -f ${shellQuote(containerId)}`);
        if (ownsGuard) {
          const digest = createHash("sha256")
            .update(guard.DOCKER_COMPUTE_GUARD_PROGRAM)
            .digest("hex");
          await rootSSH.execStdin(
            "python3 -",
            `import json, pathlib, shutil, subprocess\nroot=pathlib.Path('/var/lib/eliza/compute-leases')\nunit=pathlib.Path('/etc/systemd/system/eliza-compute-guard.service')\nif unit.exists():\n assert 'guard-${digest}.py' in unit.read_text(), 'foreign_guard_preserved'\nif root.exists():\n for p in root.glob('*.json'):\n  assert json.loads(p.read_text())['authorization']['containerId']==${JSON.stringify(containerId)}, 'foreign_lease_preserved'\nif unit.exists():\n subprocess.run(['systemctl','disable','--now',unit.name],check=True,capture_output=True)\n unit.unlink()\n subprocess.run(['systemctl','daemon-reload'],check=True,capture_output=True)\nif root.exists(): shutil.rmtree(root)\nassert not root.exists() and not unit.exists()\n`,
          );
        }
        expect(
          (
            await ssh.exec(`${docker} ps -a --filter name=${shellQuote(name)} --format '{{.ID}}'`)
          ).trim(),
        ).toBe("");
        expect(
          (await ssh.exec(`${docker} ps -q --no-trunc`)).trim().split("\n").filter(Boolean).sort(),
        ).toEqual(originalRunning);
      } finally {
        await ssh.disconnect();
      }
    }
  }, 180_000);
}
