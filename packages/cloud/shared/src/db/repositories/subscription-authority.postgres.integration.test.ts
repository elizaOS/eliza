/**
 * Proves subscription authority constraints with independent real-PostgreSQL sessions.
 * The suite creates and drops an isolated schema and never runs against PGlite.
 * Start one locally with `docker run --rm --detach --name eliza-subscription-postgres -e
 * POSTGRES_HOST_AUTH_METHOD=trust -p 55432:5432 postgres:16-alpine`, then run:
 * `SUBSCRIPTION_AUTHORITY_POSTGRES_URL=postgresql://postgres@127.0.0.1:55432/postgres bun test --config=/dev/null --isolate packages/cloud/shared/src/db/repositories/subscription-authority.postgres.integration.test.ts`.
 */
import { afterAll, beforeAll, describe, expect, setSystemTime, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Client } from "pg";

const databaseUrl = process.env.SUBSCRIPTION_AUTHORITY_POSTGRES_URL;
const schemaName = `subscription_authority_${randomUUID().replaceAll("-", "_")}`;
const DIGEST = "a".repeat(64);
const ORG = "10000000-0000-4000-8000-000000000091";
const USER = "11000000-0000-4000-8000-000000000091";
const SUBSCRIPTION = "12000000-0000-4000-8000-000000000091";
const EXPIRY_ORG = "10000000-0000-4000-8000-000000000092";
const EXPIRY_SUBSCRIPTION = "12000000-0000-4000-8000-000000000092";
const LIVE_ORG = "10000000-0000-4000-8000-000000000093";
const LIVE_SUBSCRIPTION_ONE = "12000000-0000-4000-8000-000000000093";
const LIVE_SUBSCRIPTION_TWO = "12000000-0000-4000-8000-000000000094";
const CLOCK_ORG = "10000000-0000-4000-8000-000000000095";
const CLOCK_SUBSCRIPTION = "12000000-0000-4000-8000-000000000095";
const PURCHASED_ORG = "10000000-0000-4000-8000-000000000096";
const PURCHASED_TRANSACTION = "13000000-0000-4000-8000-000000000096";

let setupClient: Client | undefined;
let allowanceRepository: import("./subscription-allowance").SubscriptionAllowanceRepository;
let writeTransaction: typeof import("../helpers").writeTransaction;
let microsToMoney: typeof import("./subscription-funding-reservations").microsToMoney;
let subscriptionFundingService: import("../../lib/services/subscription-funding").SubscriptionFundingService;
let closeDatabaseConnectionsForTests:
  | typeof import("../client").closeDatabaseConnectionsForTests
  | undefined;

async function connect(): Promise<Client> {
  if (!databaseUrl) throw new Error("SUBSCRIPTION_AUTHORITY_POSTGRES_URL is required");
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  await client.query(`SET search_path TO ${schemaName}, public`);
  return client;
}

describe.skipIf(!databaseUrl)("subscription authority PostgreSQL constraints", () => {
  beforeAll(async () => {
    setupClient = new Client({ connectionString: databaseUrl });
    await setupClient.connect();
    await setupClient.query(`CREATE SCHEMA ${schemaName}`);
    await setupClient.query(`SET search_path TO ${schemaName}, public`);
    await setupClient.query(`
      CREATE TABLE organizations (id uuid PRIMARY KEY);
      CREATE TABLE users (id uuid PRIMARY KEY);
      CREATE TABLE credit_transactions (
        id uuid PRIMARY KEY,
        organization_id uuid NOT NULL REFERENCES organizations(id),
        CONSTRAINT credit_transactions_id_org_idx UNIQUE (id, organization_id)
      );
    `);
    const migrations = await Promise.all(
      [
        "../migrations/0373_subscription_authority.sql",
        "../migrations/0374_subscription_funding_transaction_uniqueness.sql",
      ].map((path) => readFile(new URL(path, import.meta.url), "utf8")),
    );
    for (const migration of migrations) {
      for (const statement of migration.split("--> statement-breakpoint")) {
        if (statement.trim()) await setupClient.query(statement);
      }
    }
    await setupClient.query(`INSERT INTO organizations(id) VALUES ($1)`, [ORG]);
    await setupClient.query(`INSERT INTO organizations(id) VALUES ($1)`, [EXPIRY_ORG]);
    await setupClient.query(`INSERT INTO organizations(id) VALUES ($1)`, [LIVE_ORG]);
    await setupClient.query(`INSERT INTO organizations(id) VALUES ($1)`, [CLOCK_ORG]);
    await setupClient.query(`INSERT INTO organizations(id) VALUES ($1)`, [PURCHASED_ORG]);
    await setupClient.query(`INSERT INTO users(id) VALUES ($1)`, [USER]);
    const repositoryUrl = new URL(databaseUrl!);
    repositoryUrl.searchParams.set("options", `-c search_path=${schemaName},public`);
    repositoryUrl.searchParams.set("application_name", schemaName);
    process.env.DATABASE_URL = repositoryUrl.toString();
    process.env.TEST_DATABASE_URL = repositoryUrl.toString();
    process.env.LOCAL_PG_POOL_MAX = "4";
    ({ subscriptionAllowanceRepository: allowanceRepository } = await import(
      "./subscription-allowance"
    ));
    ({ writeTransaction } = await import("../helpers"));
    ({ microsToMoney } = await import("./subscription-funding-reservations"));
    ({ subscriptionFundingService } = await import("../../lib/services/subscription-funding"));
    ({ closeDatabaseConnectionsForTests } = await import("../client"));
  });

  afterAll(async () => {
    if (!setupClient) return;
    await closeDatabaseConnectionsForTests?.();
    await setupClient.query(`DROP SCHEMA ${schemaName} CASCADE`);
    await setupClient.end();
  });

  test("admits one live checkout and one overlapping allowance period under races", async () => {
    const first = await connect();
    const second = await connect();
    try {
      const checkoutSql = `INSERT INTO billing_subscription_commands (
        organization_id, requested_by_user_id, kind, target_plan_key,
        idempotency_key, provider_idempotency_key, request_digest
      ) VALUES ($1,$2,'checkout',$3,$4,$5,$6)`;
      const checkoutResults = await Promise.allSettled([
        first.query(checkoutSql, [
          ORG,
          USER,
          "plus_monthly",
          "checkout.race.one",
          "provider.checkout.race.one",
          DIGEST,
        ]),
        second.query(checkoutSql, [
          ORG,
          USER,
          "pro_monthly",
          "checkout.race.two",
          "provider.checkout.race.two",
          DIGEST,
        ]),
      ]);
      expect(checkoutResults.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
      expect(checkoutResults.filter(({ status }) => status === "rejected")).toHaveLength(1);

      const liveSubscriptionSql = `INSERT INTO billing_subscriptions (
        id, organization_id, provider_environment, stripe_customer_id,
        stripe_subscription_id, stripe_subscription_item_id, plan_key,
        catalog_version, status, current_period_start, current_period_end,
        lifecycle_revision, provider_object_digest
      ) VALUES ($1,$2,'test',$3,$4,$5,'plus_monthly','v1','active',
        '2026-08-01Z','2026-09-01Z',1,$6)`;
      const liveSubscriptionResults = await Promise.allSettled([
        first.query(liveSubscriptionSql, [
          LIVE_SUBSCRIPTION_ONE,
          LIVE_ORG,
          "cus_liveone",
          "sub_liveone",
          "si_liveone",
          DIGEST,
        ]),
        second.query(liveSubscriptionSql, [
          LIVE_SUBSCRIPTION_TWO,
          LIVE_ORG,
          "cus_livetwo",
          "sub_livetwo",
          "si_livetwo",
          DIGEST,
        ]),
      ]);
      expect(liveSubscriptionResults.filter(({ status }) => status === "fulfilled")).toHaveLength(
        1,
      );
      expect(liveSubscriptionResults.filter(({ status }) => status === "rejected")).toHaveLength(1);
      const persistedLiveSubscriptions = await setupClient!.query(
        `SELECT count(*)::int AS live_subscriptions
         FROM billing_subscriptions
         WHERE organization_id=$1
           AND status IN ('pending','incomplete','active','grace','past_due','unpaid')`,
        [LIVE_ORG],
      );
      expect(persistedLiveSubscriptions.rows).toEqual([{ live_subscriptions: 1 }]);

      await setupClient?.query(
        `INSERT INTO billing_subscriptions (
          id, organization_id, provider_environment, stripe_customer_id,
          stripe_subscription_id, stripe_subscription_item_id, plan_key,
          catalog_version, status, current_period_start, current_period_end,
          lifecycle_revision, provider_object_digest
        ) VALUES ($1,$2,'test','cus_realrace','sub_realrace','si_realrace',
          'plus_monthly','v1','active','2026-08-01Z','2026-09-01Z',1,$3)`,
        [SUBSCRIPTION, ORG, DIGEST],
      );
      await setupClient?.query(
        `INSERT INTO billing_subscription_revisions (
          organization_id, subscription_id, revision, source, provider_environment,
          stripe_customer_id, stripe_subscription_id, stripe_subscription_item_id,
          plan_key, catalog_version, status, current_period_start, current_period_end,
          cancel_at_period_end, provider_object_digest
        ) VALUES ($2,$1,1,'webhook','test','cus_realrace','sub_realrace','si_realrace',
          'plus_monthly','v1','active','2026-08-01Z','2026-09-01Z',false,$3)`,
        [SUBSCRIPTION, ORG, DIGEST],
      );
      const periodSql = `INSERT INTO subscription_allowance_periods (
        id, organization_id, subscription_id, subscription_revision,
        provider_environment, stripe_invoice_id, plan_key, catalog_version,
        period_start, period_end, expires_at, granted_amount, available_amount
      ) VALUES ($1,$2,$3,1,'test',$4,'plus_monthly','v1',$5,$6,$6,5,5)`;
      const periodResults = await Promise.allSettled([
        first.query(periodSql, [
          randomUUID(),
          ORG,
          SUBSCRIPTION,
          "in_realrace1",
          "2026-08-01Z",
          "2026-09-01Z",
        ]),
        second.query(periodSql, [
          randomUUID(),
          ORG,
          SUBSCRIPTION,
          "in_realrace2",
          "2026-08-15Z",
          "2026-09-15Z",
        ]),
      ]);
      expect(periodResults.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
      expect(periodResults.filter(({ status }) => status === "rejected")).toHaveLength(1);

      await setupClient?.query(`DELETE FROM subscription_allowance_periods`);
      const spendPeriodId = randomUUID();
      await setupClient?.query(periodSql, [
        spendPeriodId,
        ORG,
        SUBSCRIPTION,
        "in_realspend1",
        "2026-09-01Z",
        "2099-10-01Z",
      ]);
      const reserveResults = await Promise.allSettled([
        writeTransaction((tx) =>
          allowanceRepository.reserve(tx, {
            organizationId: ORG,
            periodId: spendPeriodId,
            logicalOperationId: "operation.real.reserve.one",
            requestDigest: DIGEST,
            requestedAmount: microsToMoney(5_000_000n),
            allowanceAmount: microsToMoney(5_000_000n),
            purchasedCreditAmount: microsToMoney(0n),
            purchasedCreditReservationTransactionId: null,
          }),
        ),
        writeTransaction((tx) =>
          allowanceRepository.reserve(tx, {
            organizationId: ORG,
            periodId: spendPeriodId,
            logicalOperationId: "operation.real.reserve.two",
            requestDigest: "b".repeat(64),
            requestedAmount: microsToMoney(5_000_000n),
            allowanceAmount: microsToMoney(5_000_000n),
            purchasedCreditAmount: microsToMoney(0n),
            purchasedCreditReservationTransactionId: null,
          }),
        ),
      ]);
      expect(reserveResults.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
      expect(reserveResults.filter(({ status }) => status === "rejected")).toHaveLength(1);
      const persistedReserve = await setupClient!.query(
        `SELECT
          (SELECT count(*)::int FROM billing_funding_reservations WHERE organization_id=$1) AS reservations,
          (SELECT count(*)::int FROM billing_funding_allocations WHERE organization_id=$1) AS allocations,
          (SELECT count(*)::int FROM subscription_allowance_transactions WHERE organization_id=$1 AND kind='reserve') AS reserve_entries`,
        [ORG],
      );
      expect(persistedReserve.rows).toEqual([
        { reservations: 1, allocations: 1, reserve_entries: 1 },
      ]);
      await expect(
        writeTransaction((tx) =>
          allowanceRepository.reserve(tx, {
            organizationId: ORG,
            periodId: spendPeriodId,
            logicalOperationId: "operation.real.reserve.insufficient",
            requestDigest: "c".repeat(64),
            requestedAmount: microsToMoney(1_000_000n),
            allowanceAmount: microsToMoney(1_000_000n),
            purchasedCreditAmount: microsToMoney(0n),
            purchasedCreditReservationTransactionId: null,
          }),
        ),
      ).rejects.toMatchObject({
        code: "SUBSCRIPTION_ALLOWANCE_CONFLICT",
      });

      await setupClient?.query(
        `INSERT INTO billing_subscriptions (
          id, organization_id, provider_environment, stripe_customer_id,
          stripe_subscription_id, stripe_subscription_item_id, plan_key,
          catalog_version, status, current_period_start, current_period_end,
          lifecycle_revision, provider_object_digest
        ) VALUES ($1,$2,'test','cus_realexpiry','sub_realexpiry','si_realexpiry',
          'plus_monthly','v1','canceled','2026-08-01Z','2026-09-01Z',1,$3)`,
        [EXPIRY_SUBSCRIPTION, EXPIRY_ORG, DIGEST],
      );
      await setupClient?.query(
        `INSERT INTO billing_subscription_revisions (
          organization_id, subscription_id, revision, source, provider_environment,
          stripe_customer_id, stripe_subscription_id, stripe_subscription_item_id,
          plan_key, catalog_version, status, current_period_start, current_period_end,
          cancel_at_period_end, provider_object_digest
        ) VALUES ($2,$1,1,'webhook','test','cus_realexpiry','sub_realexpiry','si_realexpiry',
          'plus_monthly','v1','canceled','2026-08-01Z','2026-09-01Z',false,$3)`,
        [EXPIRY_SUBSCRIPTION, EXPIRY_ORG, DIGEST],
      );
      const expiringPeriodId = randomUUID();
      await setupClient?.query(
        `INSERT INTO subscription_allowance_periods (
          id, organization_id, subscription_id, subscription_revision,
          provider_environment, stripe_invoice_id, plan_key, catalog_version,
          period_start, period_end, expires_at, granted_amount, available_amount
        ) SELECT $1,$2,$3,1,'test','in_realexpiry1','plus_monthly','v1',
          database_now - interval '1 day', database_now + interval '2 seconds',
          database_now + interval '2 seconds',5,5
        FROM (SELECT clock_timestamp() AS database_now) AS clock`,
        [expiringPeriodId, EXPIRY_ORG, EXPIRY_SUBSCRIPTION],
      );
      await first.query("BEGIN");
      await first.query("SELECT id FROM organizations WHERE id=$1 FOR UPDATE", [EXPIRY_ORG]);
      const blockedReserve = writeTransaction((tx) =>
        allowanceRepository.reserve(tx, {
          organizationId: EXPIRY_ORG,
          periodId: expiringPeriodId,
          logicalOperationId: "operation.real.expired",
          requestDigest: DIGEST,
          requestedAmount: microsToMoney(5_000_000n),
          allowanceAmount: microsToMoney(5_000_000n),
          purchasedCreditAmount: microsToMoney(0n),
          purchasedCreditReservationTransactionId: null,
        }),
      );
      let reachedOrganizationLock = false;
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const lockWait = await setupClient!.query<{ blocked: boolean }>(
          `SELECT EXISTS (
             SELECT 1 FROM pg_stat_activity
             WHERE datname = current_database() AND wait_event_type = 'Lock'
               AND application_name = $1 AND query ILIKE '%organizations%FOR UPDATE%'
           ) AS blocked`,
          [schemaName],
        );
        reachedOrganizationLock = lockWait.rows[0]?.blocked === true;
        if (reachedOrganizationLock) break;
        await Bun.sleep(10);
      }
      expect(reachedOrganizationLock).toBe(true);
      const liveBeforeRelease = await setupClient!.query<{ live: boolean }>(
        `SELECT expires_at > clock_timestamp() AS live
         FROM subscription_allowance_periods WHERE id=$1`,
        [expiringPeriodId],
      );
      expect(liveBeforeRelease.rows).toEqual([{ live: true }]);
      await setupClient!.query(
        `SELECT pg_sleep(
           GREATEST(0, EXTRACT(EPOCH FROM expires_at - clock_timestamp())) + 0.05
         ) FROM subscription_allowance_periods WHERE id=$1`,
        [expiringPeriodId],
      );
      await first.query("COMMIT");
      await expect(blockedReserve).rejects.toMatchObject({
        code: "SUBSCRIPTION_ALLOWANCE_CONFLICT",
      });
      const postLockExpiry = await setupClient!.query(
        `SELECT available_amount::text, reserved_amount::text,
          (SELECT count(*)::int FROM billing_funding_reservations WHERE organization_id=$2) AS reservations
         FROM subscription_allowance_periods WHERE id=$1`,
        [expiringPeriodId, EXPIRY_ORG],
      );
      expect(postLockExpiry.rows).toEqual([
        { available_amount: "5.000000", reserved_amount: "0.000000", reservations: 0 },
      ]);
    } finally {
      await Promise.all([first.end(), second.end()]);
    }
  });

  test("serializes and caps allowance settlement under process clock skew", async () => {
    await setupClient!.query(
      `INSERT INTO billing_subscriptions (
        id, organization_id, provider_environment, stripe_customer_id,
        stripe_subscription_id, stripe_subscription_item_id, plan_key,
        catalog_version, status, current_period_start, current_period_end,
        lifecycle_revision, provider_object_digest
      ) VALUES ($1,$2,'test','cus_clock','sub_clock','si_clock',
        'plus_monthly','v1','active',clock_timestamp() - interval '1 day',
        clock_timestamp() + interval '1 day',1,$3)`,
      [CLOCK_SUBSCRIPTION, CLOCK_ORG, DIGEST],
    );
    await setupClient!.query(
      `INSERT INTO billing_subscription_revisions (
        organization_id, subscription_id, revision, source, provider_environment,
        stripe_customer_id, stripe_subscription_id, stripe_subscription_item_id,
        plan_key, catalog_version, status, current_period_start, current_period_end,
        cancel_at_period_end, provider_object_digest
      ) VALUES ($2,$1,1,'webhook','test','cus_clock','sub_clock','si_clock',
        'plus_monthly','v1','active',clock_timestamp() - interval '1 day',
        clock_timestamp() + interval '1 day',false,$3)`,
      [CLOCK_SUBSCRIPTION, CLOCK_ORG, DIGEST],
    );
    await setupClient!.query(
      `INSERT INTO subscription_allowance_periods (
        id, organization_id, subscription_id, subscription_revision,
        provider_environment, stripe_invoice_id, plan_key, catalog_version,
        period_start, period_end, expires_at, granted_amount, available_amount
      ) SELECT $1,$2,$3,1,'test','in_clock','plus_monthly','v1',
        database_now - interval '1 day', database_now + interval '1 day',
        database_now + interval '1 day',5,5
      FROM (SELECT clock_timestamp() AS database_now) AS clock`,
      [randomUUID(), CLOCK_ORG, CLOCK_SUBSCRIPTION],
    );

    setSystemTime(new Date("2040-01-01T00:00:00.000Z"));
    try {
      const result = await subscriptionFundingService.reserve({
        organizationId: CLOCK_ORG,
        logicalOperationId: "operation.database.clock",
        operation: "ai_inference",
        amount: microsToMoney(1_000_000n),
        description: "Database clock regression",
        reservationTtlMs: 60_000,
      });
      const allocations = await setupClient!.query(
        `SELECT source, reserved_amount::text
         FROM billing_funding_allocations
         WHERE reservation_id=$1
         ORDER BY source`,
        [result.reservation.id],
      );
      expect(allocations.rows).toEqual([{ source: "allowance", reserved_amount: "1.000000" }]);

      const locker = await connect();
      try {
        await locker.query("BEGIN");
        await locker.query("SELECT id FROM organizations WHERE id=$1 FOR UPDATE", [CLOCK_ORG]);
        let settlementCompleted = false;
        const settlementPromise = subscriptionFundingService
          .settle({
            organizationId: CLOCK_ORG,
            logicalOperationId: "operation.database.clock",
            operation: "ai_inference",
            actualAmount: microsToMoney(2_000_000n),
            occurredAt: new Date("2026-08-31T00:00:00.000Z"),
          })
          .then((settlement) => {
            settlementCompleted = true;
            return settlement;
          });
        await Bun.sleep(300);
        expect(settlementCompleted).toBe(false);
        await locker.query("COMMIT");
        await expect(settlementPromise).resolves.toMatchObject({
          replayed: false,
          collectedAmount: "1.000000",
          uncollectedOverageAmount: "1.000000",
          reservation: { status: "finalized" },
        });
      } finally {
        await locker.query("ROLLBACK");
        await locker.end();
      }
      const finalizedAllocations = await setupClient!.query(
        `SELECT source, reserved_amount::text, finalized_amount::text, released_amount::text
         FROM billing_funding_allocations
         WHERE reservation_id=$1
         ORDER BY source`,
        [result.reservation.id],
      );
      expect(finalizedAllocations.rows).toEqual([
        {
          source: "allowance",
          reserved_amount: "1.000000",
          finalized_amount: "1.000000",
          released_amount: "0.000000",
        },
      ]);
      const persistedSettlement = await setupClient!.query(
        `SELECT uncollected_overage_amount::text
         FROM billing_funding_reservations
         WHERE id=$1`,
        [result.reservation.id],
      );
      expect(persistedSettlement.rows).toEqual([{ uncollected_overage_amount: "1.000000" }]);
    } finally {
      setSystemTime();
    }
  });

  test("serializes purchased-credit-only settlement behind the organization lock", async () => {
    await setupClient!.query(
      `INSERT INTO credit_transactions (id, organization_id) VALUES ($1,$2)`,
      [PURCHASED_TRANSACTION, PURCHASED_ORG],
    );
    const reservationId = randomUUID();
    await setupClient!.query(
      `INSERT INTO billing_funding_reservations (
         id, organization_id, logical_operation_id, request_digest, funding_class,
         requested_amount, reserved_amount, expires_at
       ) VALUES ($1,$2,'operation.purchased.lock',$3,'cash_only',1,1,
         clock_timestamp() + interval '1 day')`,
      [reservationId, PURCHASED_ORG, DIGEST],
    );
    await setupClient!.query(
      `INSERT INTO billing_funding_allocations (
         organization_id, reservation_id, sequence, source,
         purchased_credit_reservation_transaction_id, reserved_amount
       ) VALUES ($1,$2,1,'purchased_credit',$3,1)`,
      [PURCHASED_ORG, reservationId, PURCHASED_TRANSACTION],
    );

    const locker = await connect();
    setSystemTime(new Date("2040-01-01T00:00:00.000Z"));
    try {
      await locker.query("BEGIN");
      await locker.query("SELECT id FROM organizations WHERE id=$1 FOR UPDATE", [PURCHASED_ORG]);
      const settlementPromise = subscriptionFundingService.settle({
        organizationId: PURCHASED_ORG,
        logicalOperationId: "operation.purchased.lock",
        operation: "unclassified",
        actualAmount: microsToMoney(1_000_000n),
        occurredAt: new Date("2026-08-31T00:00:00.000Z"),
      });
      let reachedOrganizationLock = false;
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const lockWait = await setupClient!.query<{ blocked: boolean }>(
          `SELECT EXISTS (
             SELECT 1 FROM pg_stat_activity
             WHERE datname = current_database() AND wait_event_type = 'Lock'
               AND application_name = $1 AND query ILIKE '%organizations%FOR UPDATE%'
           ) AS blocked`,
          [schemaName],
        );
        reachedOrganizationLock = lockWait.rows[0]?.blocked === true;
        if (reachedOrganizationLock) break;
        await Bun.sleep(10);
      }
      expect(reachedOrganizationLock).toBe(true);
      await locker.query("COMMIT");
      await expect(settlementPromise).resolves.toMatchObject({
        replayed: false,
        reservation: { status: "finalized" },
      });
      const allocation = await setupClient!.query(
        `SELECT finalized_amount::text, released_amount::text
         FROM billing_funding_allocations WHERE reservation_id=$1`,
        [reservationId],
      );
      expect(allocation.rows).toEqual([
        { finalized_amount: "1.000000", released_amount: "0.000000" },
      ]);
      const stamp = await setupClient!.query<{ skewed: boolean }>(
        `SELECT finalized_at > clock_timestamp() + interval '1 year' AS skewed
         FROM billing_funding_reservations WHERE id=$1`,
        [reservationId],
      );
      expect(stamp.rows).toEqual([{ skewed: false }]);
    } finally {
      setSystemTime();
      await locker.query("ROLLBACK");
      await locker.end();
    }
  });
});
