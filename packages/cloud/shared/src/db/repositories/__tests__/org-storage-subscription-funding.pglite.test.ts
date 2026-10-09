/**
 * Proves native storage PUTs and paid reads fund allowance-first for paid
 * subscribers, refund to their exact sources, and leave the purchased-credit
 * lane of non-subscribers unchanged, against real PGlite migrations.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import type {
  RuntimeR2Bucket,
  RuntimeR2ObjectMetadata,
} from "../../../lib/storage/r2-runtime-binding";
import { createBillingSnapshotFixture } from "../account-billing-snapshot-test-fixture";

process.env.DATABASE_URL = "pglite://memory";
process.env.TEST_DATABASE_URL = "pglite://memory";
process.env.ENVIRONMENT = "local";

const SUBSCRIBER = "61000000-0000-4000-8000-000000000001";
const SUBSCRIPTION = "62000000-0000-4000-8000-000000000001";
const CASH_ORG = "61000000-0000-4000-8000-000000000002";
const SUBSCRIBER_USER = "64000000-0000-4000-8000-000000000001";
const CASH_USER = "64000000-0000-4000-8000-000000000002";
const TIMEOUT = 120_000;

let client: typeof import("../../client");
let mutations: typeof import("../org-storage-mutations");
let reads: typeof import("../org-storage-reads");
let putService: typeof import("../../../lib/services/storage/native-storage-put");
let exec: (query: string) => Promise<void>;
let query: <T extends Record<string, unknown>>(
  text: string,
  parameters?: unknown[],
) => Promise<T[]>;

async function applyMigration(name: string, skip: (statement: string) => boolean = () => false) {
  const source = await readFile(new URL(`../../migrations/${name}`, import.meta.url), "utf8");
  for (const statement of source.split("--> statement-breakpoint")) {
    if (statement.trim() && !skip(statement)) await exec(statement);
  }
}

beforeAll(async () => {
  client = await import("../../client");
  const pglite = client.getPgliteClientForTests();
  exec = async (text) => {
    await pglite.exec(text);
  };
  query = async (text, parameters) => (await pglite.query(text, parameters)).rows as never;
  await createBillingSnapshotFixture(exec, "");
  await exec(`
    ALTER TABLE credit_transactions ALTER COLUMN id SET DEFAULT gen_random_uuid();
    ALTER TABLE credit_transactions ADD COLUMN user_id uuid;
    ALTER TABLE credit_transactions ADD COLUMN description text;
    ALTER TABLE credit_transactions ADD COLUMN created_at timestamp DEFAULT now();
    ALTER TABLE credit_transactions ADD COLUMN settled_at timestamp;
    ALTER TABLE users ADD COLUMN organization_id uuid REFERENCES organizations(id);
    ALTER TABLE org_storage_quota ADD PRIMARY KEY (organization_id);
    CREATE TABLE service_pricing (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      service_id text NOT NULL, method text NOT NULL, cost numeric(12,6) NOT NULL,
      updated_at timestamp DEFAULT now() NOT NULL);
    CREATE TABLE service_pricing_audit (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      service_pricing_id uuid, service_id text NOT NULL, method text NOT NULL,
      old_cost numeric(12,6), new_cost numeric(12,6) NOT NULL, change_type text NOT NULL,
      changed_by text NOT NULL, reason text, created_at timestamp DEFAULT now() NOT NULL);
    INSERT INTO organizations(id, credit_balance, balance_revision, balance_decrease_revision,
      settings, is_active, auto_top_up_enabled, account_lifecycle_state)
    VALUES ('${CASH_ORG}', '10.000001', 1, 0, '{}', true, false, 'active');
    INSERT INTO users(id, organization_id) VALUES
      ('${SUBSCRIBER_USER}', '${SUBSCRIBER}'), ('${CASH_USER}', '${CASH_ORG}');
  `);
  // The fixture already carries today's org_storage_quota columns.
  await applyMigration("0256_org_storage_native_objects.sql", (statement) =>
    statement.includes("native_catalog_reconciled_at"),
  );
  for (const name of [
    "0257_org_storage_native_put_operations.sql",
    "0258_org_storage_generation_gc_outbox.sql",
    "0266_org_storage_read_operations.sql",
    "0482_org_storage_subscription_funding.sql",
  ]) {
    await applyMigration(name);
  }

  // Move the paid subscription and its allowance period around the real clock.
  const { subscriptionAuthorityRepository: authority } = await import("../subscription-authority");
  const { subscriptionEntitlementsRepository: entitlements } = await import(
    "../subscription-entitlements"
  );
  const current = await authority.findById(SUBSCRIBER, SUBSCRIPTION);
  if (!current) throw new Error("Missing paid subscription fixture");
  const { id, organization_id, lifecycle_revision, created_at, updated_at, ...values } = current;
  const periodStart = new Date(Date.now() - 86_400_000);
  const periodEnd = new Date(Date.now() + 86_400_000);
  const advanced = await authority.advance({
    organizationId: SUBSCRIBER,
    subscriptionId: SUBSCRIPTION,
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
    organizationId: SUBSCRIBER,
    sourceSubscriptionId: SUBSCRIPTION,
    sourceSubscriptionRevision: advanced.subscription.lifecycle_revision,
    expectedProjectionRevision: 1,
  });
  await query(
    `UPDATE subscription_allowance_periods SET subscription_revision=$1,
      period_start=$2, period_end=$3, expires_at=$3 WHERE organization_id=$4`,
    [advanced.subscription.lifecycle_revision, periodStart, periodEnd, SUBSCRIBER],
  );

  mutations = await import("../org-storage-mutations");
  reads = await import("../org-storage-reads");
  putService = await import("../../../lib/services/storage/native-storage-put");
}, TIMEOUT);

afterAll(async () => {
  await client?.closeDatabaseConnectionsForTests();
});

interface Money {
  balance: string;
  available: string;
  reserved: string;
  settled: string;
}

async function money(organizationId: string): Promise<Money> {
  const [row] = await query<{
    balance: string;
    available: string | null;
    reserved: string | null;
    settled: string | null;
  }>(
    `SELECT o.credit_balance::text AS balance, p.available_amount::text AS available,
      p.reserved_amount::text AS reserved, p.settled_amount::text AS settled
     FROM organizations o
     LEFT JOIN subscription_allowance_periods p ON p.organization_id = o.id
     WHERE o.id = $1`,
    [organizationId],
  );
  if (!row) throw new Error("organization missing");
  return {
    balance: row.balance,
    available: row.available ?? "none",
    reserved: row.reserved ?? "none",
    settled: row.settled ?? "none",
  };
}

async function reservation(logicalOperationId: string) {
  const [row] = await query<{ id: string; status: string; requested_amount: string }>(
    `SELECT id, status, requested_amount::text FROM billing_funding_reservations
     WHERE logical_operation_id = $1`,
    [logicalOperationId],
  );
  return row;
}

async function allocations(reservationId: string) {
  return await query<{ source: string; reserved_amount: string }>(
    `SELECT source, reserved_amount::text FROM billing_funding_allocations
     WHERE reservation_id = $1 ORDER BY source`,
    [reservationId],
  );
}

async function storageCreditRows(organizationId: string) {
  return await query<{ amount: string; type: string }>(
    `SELECT amount::text, type FROM credit_transactions
     WHERE organization_id = $1 AND metadata ? 'storage_operation_id'`,
    [organizationId],
  );
}

let keySequence = 0;
function nextHex(): string {
  keySequence += 1;
  return keySequence.toString(16).padStart(64, "0");
}

async function preparePut(organizationId: string, priceUsd: string) {
  const logicalKey = `funded/${nextHex()}`;
  const prepared = await mutations.orgStorageMutationsRepository.preparePut({
    organizationId,
    logicalKey,
    idempotencyKeyHash: nextHex(),
    requestDigest: nextHex(),
    sizeBytes: 3n,
    contentType: "application/octet-stream",
    contentSha256: "d".repeat(64),
    priceUsd,
  });
  return prepared.operation;
}

async function reserveAndLease(organizationId: string, priceUsd: string) {
  const operation = await preparePut(organizationId, priceUsd);
  const reserved = await mutations.orgStorageMutationsRepository.reservePutCredits({
    operationId: operation.id,
    organizationId,
  });
  expect(reserved.insufficient).toBe(false);
  const leased = await mutations.orgStorageMutationsRepository.claimProviderLease({
    operationId: operation.id,
    organizationId,
    leaseToken: crypto.randomUUID(),
    leaseExpiresAt: new Date(Date.now() + 60_000),
    now: new Date(),
  });
  return { reserved, leased };
}

function commit(operation: { id: string; organization_id: string; lease_token: string | null }) {
  return mutations.orgStorageMutationsRepository.commitObservedPut({
    operationId: operation.id,
    organizationId: operation.organization_id,
    leaseToken: operation.lease_token!,
    etag: "etag-funded",
    uploadedAt: new Date("2026-09-01T00:00:00Z"),
    responseJson: JSON.stringify({ key: "funded" }),
  });
}

function refund(operation: { id: string; organization_id: string; lease_token: string | null }) {
  return mutations.orgStorageMutationsRepository.finalizeRefund({
    operationId: operation.id,
    organizationId: operation.organization_id,
    leaseToken: operation.lease_token!,
    responseJson: JSON.stringify({ error: "Storage PUT did not reach R2" }),
  });
}

function micros(value: string): bigint {
  const negative = value.startsWith("-");
  const [whole = "0", fraction = ""] = (negative ? value.slice(1) : value).split(".");
  const magnitude = BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, "0").slice(0, 6));
  return negative ? -magnitude : magnitude;
}

function plus(value: string, delta: string): string {
  const total = micros(value) + micros(delta);
  const sign = total < 0n ? "-" : "";
  const absolute = total < 0n ? -total : total;
  return `${sign}${absolute / 1_000_000n}.${(absolute % 1_000_000n).toString().padStart(6, "0")}`;
}

describe("native storage read subscription funding", () => {
  async function succeededRead(organizationId: string, userId: string, priceUsd: string) {
    const prepared = await reads.orgStorageReadsRepository.prepare({
      organizationId,
      userId,
      idempotencyKeyHash: nextHex(),
      requestDigest: nextHex(),
      method: "list",
      priceUsd,
    });
    await reads.orgStorageReadsRepository.recordProviderSuccess({
      operationId: prepared.operation.id,
      organizationId,
      responseStatus: 200,
      responseJson: "{}",
      providerSucceededAt: new Date(),
    });
    return prepared.operation;
  }

  test(
    "a subscriber read is charged to allowance and bound to a finalized reservation",
    async () => {
      const before = await money(SUBSCRIBER);
      const operation = await succeededRead(SUBSCRIBER, SUBSCRIBER_USER, "0.000001");
      const committed = await reads.orgStorageReadsRepository.commitProviderSuccess({
        operationId: operation.id,
        organizationId: SUBSCRIBER,
        now: new Date(),
      });
      expect(committed.insufficient).toBe(false);
      expect(committed.operation.state).toBe("committed");
      expect(committed.operation.credit_transaction_id).toBeNull();
      const funding = await reservation(`storage.read:${operation.id}`);
      expect(funding).toMatchObject({ status: "finalized", requested_amount: "0.000001" });
      expect(committed.operation.funding_reservation_id).toBe(funding!.id);
      expect((await money(SUBSCRIBER)).balance).toBe(before.balance);
      expect(
        await query(
          "SELECT id FROM credit_transactions WHERE metadata->>'storage_read_operation_id' = $1",
          [operation.id],
        ),
      ).toEqual([]);
      const settled = await money(SUBSCRIBER);
      expect(settled).toEqual({
        balance: before.balance,
        available: plus(before.available, "-0.000001"),
        reserved: before.reserved,
        settled: plus(before.settled, "0.000001"),
      });

      // Replay returns the committed receipt without another charge.
      const replay = await reads.orgStorageReadsRepository.commitProviderSuccess({
        operationId: operation.id,
        organizationId: SUBSCRIBER,
        now: new Date(),
      });
      expect(replay.operation.funding_reservation_id).toBe(funding!.id);
      expect(await money(SUBSCRIBER)).toEqual(settled);

      // The receipt's funding authority is terminal.
      await expect(
        query(
          "UPDATE org_storage_read_operations SET funding_reservation_id = NULL WHERE id = $1",
          [operation.id],
        ),
      ).rejects.toThrow();
    },
    TIMEOUT,
  );

  test(
    "a subscriber read beyond allowance and credits fails with the insufficient receipt",
    async () => {
      const before = await money(SUBSCRIBER);
      const operation = await succeededRead(SUBSCRIBER, SUBSCRIBER_USER, "500.000000");
      const failed = await reads.orgStorageReadsRepository.commitProviderSuccess({
        operationId: operation.id,
        organizationId: SUBSCRIBER,
        now: new Date(),
      });
      expect(failed.insufficient).toBe(true);
      expect(failed.operation).toMatchObject({ state: "failed", response_status: 402 });
      expect(failed.availableUsd).toBe(before.balance);
      expect(await reservation(`storage.read:${operation.id}`)).toBeUndefined();
      expect(await money(SUBSCRIBER)).toEqual(before);
    },
    TIMEOUT,
  );

  test(
    "a non-subscriber read keeps the settled purchased-credit receipt",
    async () => {
      const before = await money(CASH_ORG);
      const operation = await succeededRead(CASH_ORG, CASH_USER, "0.300000");
      const committed = await reads.orgStorageReadsRepository.commitProviderSuccess({
        operationId: operation.id,
        organizationId: CASH_ORG,
        now: new Date(),
      });
      expect(committed.operation.funding_reservation_id).toBeNull();
      expect(committed.operation.credit_transaction_id).not.toBeNull();
      expect(await reservation(`storage.read:${operation.id}`)).toBeUndefined();
      expect((await money(CASH_ORG)).balance).toBe(plus(before.balance, "-0.300000"));
    },
    TIMEOUT,
  );
});

describe("native storage PUT subscription funding", () => {
  test(
    "a subscriber PUT is paid from allowance with no purchased-credit movement",
    async () => {
      const before = await money(SUBSCRIBER);
      const { reserved, leased } = await reserveAndLease(SUBSCRIBER, "1.250000");
      expect(reserved.purchasedCreditMoved).toBe(false);
      expect(reserved.operation.credit_transaction_id).toBeNull();
      const funding = await reservation(`storage.put:${leased.id}`);
      expect(funding).toMatchObject({ status: "reserved", requested_amount: "1.250000" });
      expect(reserved.operation.funding_reservation_id).toBe(funding!.id);
      expect(await allocations(funding!.id)).toEqual([
        { source: "allowance", reserved_amount: "1.250000" },
      ]);
      expect(await money(SUBSCRIBER)).toEqual({
        balance: before.balance,
        available: plus(before.available, "-1.250000"),
        reserved: plus(before.reserved, "1.250000"),
        settled: before.settled,
      });

      const committed = await commit(leased);
      expect(committed.state).toBe("committed");
      expect((await reservation(`storage.put:${leased.id}`))?.status).toBe("finalized");
      const after = {
        balance: before.balance,
        available: plus(before.available, "-1.250000"),
        reserved: before.reserved,
        settled: plus(before.settled, "1.250000"),
      };
      expect(await money(SUBSCRIBER)).toEqual(after);
      expect(await storageCreditRows(SUBSCRIBER)).toEqual([]);

      // Commit replay is idempotent and never settles twice.
      expect((await commit(leased)).state).toBe("committed");
      expect(await money(SUBSCRIBER)).toEqual(after);
    },
    TIMEOUT,
  );

  test(
    "a refunded subscriber PUT returns its allowance, and refund replay is idempotent",
    async () => {
      const before = await money(SUBSCRIBER);
      const { leased } = await reserveAndLease(SUBSCRIBER, "2.000000");
      expect((await money(SUBSCRIBER)).available).toBe(plus(before.available, "-2.000000"));
      const refunded = await refund(leased);
      expect(refunded.state).toBe("refunded");
      expect((await reservation(`storage.put:${leased.id}`))?.status).toBe("canceled");
      expect(await money(SUBSCRIBER)).toEqual(before);
      expect((await refund(leased)).state).toBe("refunded");
      expect(await money(SUBSCRIBER)).toEqual(before);
    },
    TIMEOUT,
  );

  test(
    "a funding shortfall takes the insufficient-credit receipt and releases quota",
    async () => {
      const before = await money(SUBSCRIBER);
      const quotaBytes = async () =>
        (
          await query<{ bytes_used: string }>(
            "SELECT bytes_used::text FROM org_storage_quota WHERE organization_id = $1",
            [SUBSCRIBER],
          )
        )[0]?.bytes_used;
      const quotaBefore = await quotaBytes();
      const operation = await preparePut(SUBSCRIBER, "500.000000");
      expect(await quotaBytes()).not.toBe(quotaBefore);
      const result = await mutations.orgStorageMutationsRepository.reservePutCredits({
        operationId: operation.id,
        organizationId: SUBSCRIBER,
      });
      expect(result.insufficient).toBe(true);
      expect(result.operation.state).toBe("refunded");
      expect(result.operation.response_json).toBe(
        JSON.stringify({ error: "Insufficient credits" }),
      );
      expect(result.operation.funding_reservation_id).toBeNull();
      expect(await reservation(`storage.put:${operation.id}`)).toBeUndefined();
      expect(await money(SUBSCRIBER)).toEqual(before);
      expect(await quotaBytes()).toBe(quotaBefore);
    },
    TIMEOUT,
  );

  test(
    "a non-subscriber PUT keeps the unchanged purchased-credit hold lane",
    async () => {
      const before = await money(CASH_ORG);
      const { reserved, leased } = await reserveAndLease(CASH_ORG, "1.000000");
      expect(reserved.operation.funding_reservation_id).toBeNull();
      expect(reserved.operation.credit_transaction_id).not.toBeNull();
      expect(await reservation(`storage.put:${leased.id}`)).toBeUndefined();
      expect((await money(CASH_ORG)).balance).toBe(plus(before.balance, "-1.000000"));
      await commit(leased);
      const holds = await query<{ settled: boolean; kind: string }>(
        `SELECT settled_at IS NOT NULL AS settled, metadata->>'type' AS kind
         FROM credit_transactions WHERE id = $1`,
        [reserved.operation.credit_transaction_id],
      );
      expect(holds).toEqual([{ settled: true, kind: "reservation" }]);
      expect((await money(CASH_ORG)).balance).toBe(plus(before.balance, "-1.000000"));

      // One charge carrier only: a cash-held PUT cannot also claim a funding reservation.
      const [anyReservation] = await query<{ id: string }>(
        "SELECT id FROM billing_funding_reservations LIMIT 1",
      );
      await expect(
        query("UPDATE org_storage_put_operations SET funding_reservation_id = $2 WHERE id = $1", [
          leased.id,
          anyReservation!.id,
        ]),
      ).rejects.toThrow();
    },
    TIMEOUT,
  );

  test(
    "the native reconciler settles funded PUTs on provider evidence and cancels on absence",
    async () => {
      const before = await money(SUBSCRIBER);
      const present = await reserveAndLease(SUBSCRIBER, "0.500000");
      const absent = await reserveAndLease(SUBSCRIBER, "0.250000");
      await query(
        `UPDATE org_storage_put_operations SET lease_expires_at = now() - interval '1 minute'
         WHERE id = ANY($1::uuid[])`,
        [[present.leased.id, absent.leased.id]],
      );
      const objects = new Map<string, RuntimeR2ObjectMetadata>([
        [
          present.leased.target_provider_key,
          {
            key: present.leased.target_provider_key,
            size: 3,
            etag: "etag-present",
            uploaded: new Date("2026-09-01T00:00:00Z"),
            customMetadata: {
              requestDigest: present.leased.request_digest,
              contentSha256: present.leased.target_content_sha256,
            },
          } as RuntimeR2ObjectMetadata,
        ],
      ]);
      const bucket: RuntimeR2Bucket = {
        head: async (key) => objects.get(key) ?? null,
        get: async () => null,
        put: async () => null,
        delete: async (key) => objects.delete(key),
      };
      // First pass commits the present generation and quarantines the absence.
      await putService.reconcileNativeStoragePuts(bucket);
      expect((await reservation(`storage.put:${present.leased.id}`))?.status).toBe("finalized");
      expect((await reservation(`storage.put:${absent.leased.id}`))?.status).toBe("reserved");
      await query(
        `UPDATE org_storage_put_operations SET lease_expires_at = now() - interval '1 minute'
         WHERE id = $1`,
        [absent.leased.id],
      );
      // A second strong absence refunds the quarantined PUT to its allowance.
      await putService.reconcileNativeStoragePuts(bucket);
      expect((await reservation(`storage.put:${absent.leased.id}`))?.status).toBe("canceled");
      expect(await money(SUBSCRIBER)).toEqual({
        balance: before.balance,
        available: plus(before.available, "-0.500000"),
        reserved: before.reserved,
        settled: plus(before.settled, "0.500000"),
      });
    },
    TIMEOUT,
  );
  test(
    "a PUT larger than the allowance splits exactly into allowance and purchased credit",
    async () => {
      const before = await money(SUBSCRIBER);
      const price = plus(before.available, "0.000003");
      const { reserved, leased } = await reserveAndLease(SUBSCRIBER, price);
      expect(reserved.purchasedCreditMoved).toBe(true);
      const funding = await reservation(`storage.put:${leased.id}`);
      expect(await allocations(funding!.id)).toEqual([
        { source: "allowance", reserved_amount: before.available },
        { source: "purchased_credit", reserved_amount: "0.000003" },
      ]);
      expect(await money(SUBSCRIBER)).toMatchObject({
        balance: plus(before.balance, "-0.000003"),
        available: "0.000000",
      });

      // Provider absence cancels both sources back to where they came from.
      await refund(leased);
      expect(await money(SUBSCRIBER)).toEqual(before);

      // A committed split keeps both the allowance and the purchased share.
      const second = await reserveAndLease(SUBSCRIBER, price);
      await commit(second.leased);
      expect(await money(SUBSCRIBER)).toEqual({
        balance: plus(before.balance, "-0.000003"),
        available: "0.000000",
        reserved: before.reserved,
        settled: plus(before.settled, before.available),
      });
    },
    TIMEOUT,
  );
});
