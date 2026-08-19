/**
 * Exercises native storage PUT authority and quota serialization against real
 * in-process PGlite, including concurrent admission and overwrite deltas.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { sql } from "drizzle-orm";

process.env.DATABASE_URL = "pglite://memory";
process.env.TEST_DATABASE_URL = "pglite://memory";
process.env.NODE_ENV ||= "test";

const ORG = "00000000-0000-4000-8000-000000021045";
const OTHER_ORG = "00000000-0000-4000-8000-000000021049";
const MIGRATIONS = [
  "0256_org_storage_native_objects.sql",
  "0257_org_storage_native_put_operations.sql",
  "0258_org_storage_generation_gc_outbox.sql",
];
const TIMEOUT = 60_000;

let dbWrite: typeof import("../../client").dbWrite;
let closeDatabaseConnectionsForTests:
  | typeof import("../../client").closeDatabaseConnectionsForTests
  | null = null;
let repository: typeof import("../org-storage-mutations").orgStorageMutationsRepository;

async function executeSqlFile(name: string): Promise<void> {
  const source = readFileSync(join(import.meta.dir, "../../migrations", name), "utf8");
  for (const statement of source.split(";")) {
    if (statement.trim()) await dbWrite.execute(sql.raw(statement));
  }
}

beforeAll(async () => {
  ({ closeDatabaseConnectionsForTests, dbWrite } = await import("../../client"));
  for (const statement of [
    `CREATE TABLE organizations (id uuid PRIMARY KEY)`,
    `CREATE TABLE credit_transactions (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      organization_id uuid NOT NULL REFERENCES organizations(id),
      amount numeric(12,6) NOT NULL,
      type text NOT NULL,
      metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
      settled_at timestamp with time zone,
      created_at timestamp DEFAULT now() NOT NULL
    )`,
    `CREATE TABLE service_pricing (cost numeric(12,6) NOT NULL)`,
    `CREATE TABLE service_pricing_audit (
      old_cost numeric(12,6),
      new_cost numeric(12,6) NOT NULL
    )`,
    `CREATE TABLE org_storage_quota (
      organization_id uuid PRIMARY KEY REFERENCES organizations(id),
      bytes_used bigint DEFAULT 0 NOT NULL,
      bytes_limit bigint DEFAULT 5368709120 NOT NULL,
      created_at timestamp DEFAULT now() NOT NULL,
      updated_at timestamp DEFAULT now() NOT NULL
    )`,
  ]) {
    await dbWrite.execute(sql.raw(statement));
  }
  for (const migration of MIGRATIONS) await executeSqlFile(migration);
  ({ orgStorageMutationsRepository: repository } = await import("../org-storage-mutations"));
}, TIMEOUT);

beforeEach(async () => {
  await dbWrite.execute(
    sql.raw(`TRUNCATE org_storage_gc_outbox, org_storage_delete_operations, org_storage_put_operations,
      org_storage_objects, org_storage_quota, credit_transactions, organizations CASCADE`),
  );
  await dbWrite.execute(sql`INSERT INTO organizations (id) VALUES (${ORG})`);
  await dbWrite.execute(sql`INSERT INTO organizations (id) VALUES (${OTHER_ORG})`);
  await dbWrite.execute(
    sql`INSERT INTO org_storage_quota (organization_id, bytes_limit) VALUES (${ORG}, 10)`,
  );
});

afterAll(async () => {
  if (closeDatabaseConnectionsForTests) await closeDatabaseConnectionsForTests();
});

function prepare(logicalKey: string, id: string, bytes: bigint) {
  return repository.preparePut({
    organizationId: ORG,
    logicalKey,
    idempotencyKeyHash: id.repeat(64),
    requestDigest: (id === "a" ? "b" : "c").repeat(64),
    sizeBytes: bytes,
    contentType: "application/octet-stream",
    contentSha256: "d".repeat(64),
    priceUsd: "0.000000",
  });
}

async function commitZeroCost(logicalKey: string, id: string, bytes: bigint) {
  const prepared = await prepare(logicalKey, id, bytes);
  const reserved = await repository.attachCreditReservation({
    operationId: prepared.operation.id,
    organizationId: ORG,
    creditTransactionId: null,
  });
  const leased = await repository.claimProviderLease({
    operationId: reserved.id,
    organizationId: ORG,
    leaseToken: crypto.randomUUID(),
    leaseExpiresAt: new Date(Date.now() + 60_000),
    now: new Date(),
  });
  return await repository.commitObservedPut({
    operationId: leased.id,
    organizationId: ORG,
    leaseToken: leased.lease_token!,
    etag: `etag-${id}`,
    uploadedAt: new Date(),
    responseJson: JSON.stringify({ key: logicalKey }),
  });
}

describe("OrgStorageMutationsRepository", () => {
  test("serializes concurrent quota admission across different object keys", async () => {
    const outcomes = await Promise.allSettled([prepare("one", "a", 7n), prepare("two", "e", 7n)]);
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === "rejected")).toHaveLength(1);
    const quota = await dbWrite.execute(
      sql`SELECT bytes_used FROM org_storage_quota WHERE organization_id = ${ORG}`,
    );
    expect(String((quota.rows[0] as { bytes_used: string } | undefined)?.bytes_used)).toBe("7");
  });

  test("does not reconcile a fresh reserved operation while its request is active", async () => {
    const prepared = await prepare("active-request", "a", 4n);
    const reserved = await repository.attachCreditReservation({
      operationId: prepared.operation.id,
      organizationId: ORG,
      creditTransactionId: null,
    });
    const now = new Date();
    expect(
      (await repository.listDueOperations(now)).map((operation) => operation.id),
    ).not.toContain(reserved.id);

    await dbWrite.execute(sql`UPDATE org_storage_put_operations
      SET updated_at = ${new Date(now.getTime() - 11 * 60 * 1000)}
      WHERE id = ${reserved.id}`);
    expect((await repository.listDueOperations(now)).map((operation) => operation.id)).toContain(
      reserved.id,
    );
  });

  test("reserves max(new-old, 0) and releases shrink delta only at commit", async () => {
    await commitZeroCost("same", "a", 8n);
    const shrink = await prepare("same", "e", 3n);
    expect(shrink.operation.source_size_bytes).toBe(8n);
    expect(shrink.operation.quota_reserved_bytes).toBe(0n);
    await commitZeroCost("same", "e", 3n);
    const quota = await dbWrite.execute(
      sql`SELECT bytes_used FROM org_storage_quota WHERE organization_id = ${ORG}`,
    );
    expect(String((quota.rows[0] as { bytes_used: string } | undefined)?.bytes_used)).toBe("3");
  });

  test("rejects an idempotency replay whose durable digest includes a changed price", async () => {
    await prepare("same", "a", 2n);
    await expect(
      repository.preparePut({
        organizationId: ORG,
        logicalKey: "same",
        idempotencyKeyHash: "a".repeat(64),
        requestDigest: "f".repeat(64),
        sizeBytes: 2n,
        contentType: "application/octet-stream",
        contentSha256: "d".repeat(64),
        priceUsd: "1.000000",
      }),
    ).rejects.toMatchObject({ reason: "idempotency_mismatch" });
  });

  test("atomically settles the exact tenant hold before publishing the object", async () => {
    const prepared = await repository.preparePut({
      organizationId: ORG,
      logicalKey: "paid",
      idempotencyKeyHash: "1".repeat(64),
      requestDigest: "2".repeat(64),
      sizeBytes: 4n,
      contentType: "text/plain",
      contentSha256: "3".repeat(64),
      priceUsd: "1.250000",
    });
    const transactionId = crypto.randomUUID();
    await dbWrite.execute(sql`INSERT INTO credit_transactions
      (id, organization_id, amount, type, metadata)
      VALUES (
        ${transactionId}, ${ORG}, -1.250000, 'debit',
        ${JSON.stringify({
          type: "reservation",
          settlement_marker: "credit_reservation_v1",
          storage_operation_id: prepared.operation.id,
        })}::jsonb
      )`);
    const reserved = await repository.attachCreditReservation({
      operationId: prepared.operation.id,
      organizationId: ORG,
      creditTransactionId: transactionId,
    });
    const leased = await repository.claimProviderLease({
      operationId: reserved.id,
      organizationId: ORG,
      leaseToken: crypto.randomUUID(),
      leaseExpiresAt: new Date(Date.now() + 60_000),
      now: new Date(),
    });
    await repository.commitObservedPut({
      operationId: leased.id,
      organizationId: ORG,
      leaseToken: leased.lease_token!,
      etag: "paid-etag",
      uploadedAt: new Date(),
      responseJson: JSON.stringify({ key: "paid" }),
    });
    const result = await dbWrite.execute(sql`SELECT o.state, h.provider_key, c.settled_at
      FROM org_storage_put_operations o
      JOIN org_storage_objects h ON h.id = o.object_id
      JOIN credit_transactions c ON c.id = o.credit_transaction_id
      WHERE o.id = ${leased.id}`);
    const row = (result as { rows: Array<Record<string, unknown>> }).rows[0];
    expect(row?.state).toBe("committed");
    expect(row?.provider_key).toBe(leased.target_provider_key);
    expect(row?.settled_at).not.toBeNull();
  });

  test("rejects a cross-tenant credit transaction at the database boundary", async () => {
    const prepared = await repository.preparePut({
      organizationId: ORG,
      logicalKey: "tenant-fence",
      idempotencyKeyHash: "9".repeat(64),
      requestDigest: "a".repeat(64),
      sizeBytes: 1n,
      contentType: "text/plain",
      contentSha256: "b".repeat(64),
      priceUsd: "0.500000",
    });
    const transactionId = crypto.randomUUID();
    await dbWrite.execute(sql`INSERT INTO credit_transactions
      (id, organization_id, amount, type, metadata)
      VALUES (
        ${transactionId}, ${OTHER_ORG}, -0.500000, 'debit',
        ${JSON.stringify({
          type: "reservation",
          settlement_marker: "credit_reservation_v1",
          storage_operation_id: prepared.operation.id,
        })}::jsonb
      )`);
    await expect(
      repository.attachCreditReservation({
        operationId: prepared.operation.id,
        organizationId: ORG,
        creditTransactionId: transactionId,
      }),
    ).rejects.toThrow();
    expect((await repository.findOperation(ORG, prepared.operation.id))?.state).toBe("prepared");
  });

  test("rolls back publication when the held amount does not match the pinned price", async () => {
    const prepared = await repository.preparePut({
      organizationId: ORG,
      logicalKey: "bad-hold",
      idempotencyKeyHash: "4".repeat(64),
      requestDigest: "5".repeat(64),
      sizeBytes: 2n,
      contentType: "text/plain",
      contentSha256: "6".repeat(64),
      priceUsd: "1.000000",
    });
    const transactionId = crypto.randomUUID();
    await dbWrite.execute(sql`INSERT INTO credit_transactions
      (id, organization_id, amount, type, metadata)
      VALUES (
        ${transactionId}, ${ORG}, -0.500000, 'debit',
        ${JSON.stringify({
          type: "reservation",
          settlement_marker: "credit_reservation_v1",
          storage_operation_id: prepared.operation.id,
        })}::jsonb
      )`);
    const reserved = await repository.attachCreditReservation({
      operationId: prepared.operation.id,
      organizationId: ORG,
      creditTransactionId: transactionId,
    });
    const leased = await repository.claimProviderLease({
      operationId: reserved.id,
      organizationId: ORG,
      leaseToken: crypto.randomUUID(),
      leaseExpiresAt: new Date(Date.now() + 60_000),
      now: new Date(),
    });
    await expect(
      repository.commitObservedPut({
        operationId: leased.id,
        organizationId: ORG,
        leaseToken: leased.lease_token!,
        etag: "must-not-publish",
        uploadedAt: new Date(),
        responseJson: JSON.stringify({ key: "bad-hold" }),
      }),
    ).rejects.toThrow("credit settlement returned no row");
    const result = await dbWrite.execute(sql`SELECT o.state, h.provider_key, c.settled_at
      FROM org_storage_put_operations o
      JOIN org_storage_objects h ON h.id = o.object_id
      JOIN credit_transactions c ON c.id = o.credit_transaction_id
      WHERE o.id = ${leased.id}`);
    const row = (result as { rows: Array<Record<string, unknown>> }).rows[0];
    expect(row).toMatchObject({ state: "provider_started", provider_key: null, settled_at: null });
  });

  test("releases quota and tombstones the catalog only after observed delete", async () => {
    await commitZeroCost("remove", "a", 6n);
    const prepared = await repository.prepareDelete({
      organizationId: ORG,
      logicalKey: "remove",
      idempotencyKeyHash: "7".repeat(64),
      requestDigest: "8".repeat(64),
    });
    const leased = await repository.claimDeleteLease({
      operationId: prepared.operation.id,
      organizationId: ORG,
      leaseToken: crypto.randomUUID(),
      leaseExpiresAt: new Date(Date.now() + 60_000),
      now: new Date(),
    });
    const before = await repository.findObject(ORG, "remove");
    expect(before?.provider_key).toBe(leased.source_provider_key);
    await repository.commitObservedDelete({
      operationId: leased.id,
      organizationId: ORG,
      leaseToken: leased.lease_token!,
      responseJson: JSON.stringify({ deleted: true }),
    });
    const after = await repository.findObject(ORG, "remove");
    expect(after).toMatchObject({ provider_key: null, size_bytes: 0n });
    expect(after?.deleted_at).toBeInstanceOf(Date);
    const quota = await dbWrite.execute(
      sql`SELECT bytes_used FROM org_storage_quota WHERE organization_id = ${ORG}`,
    );
    expect(String((quota.rows[0] as { bytes_used: string } | undefined)?.bytes_used)).toBe("0");
  });
});
