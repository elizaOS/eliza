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
  "0266_org_storage_read_operations.sql",
];
const TIMEOUT = 60_000;

let dbWrite: typeof import("../../client").dbWrite;
let closeDatabaseConnectionsForTests:
  | typeof import("../../client").closeDatabaseConnectionsForTests
  | null = null;
let repository: typeof import("../org-storage-mutations").orgStorageMutationsRepository;

async function executeSqlFile(name: string): Promise<void> {
  const source = readFileSync(join(import.meta.dir, "../../migrations", name), "utf8");
  for (const statement of source.split("--> statement-breakpoint")) {
    if (statement.trim()) await dbWrite.execute(sql.raw(statement));
  }
}

beforeAll(async () => {
  ({ closeDatabaseConnectionsForTests, dbWrite } = await import("../../client"));
  for (const statement of [
    `CREATE TABLE organizations (
      id uuid PRIMARY KEY,
      credit_balance numeric(12,6) DEFAULT 10 NOT NULL,
      updated_at timestamp DEFAULT now() NOT NULL
    )`,
    `CREATE TABLE credit_transactions (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      organization_id uuid NOT NULL REFERENCES organizations(id),
      user_id uuid,
      amount numeric(12,6) NOT NULL,
      type text NOT NULL,
      description text,
      metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
      settled_at timestamp with time zone,
      created_at timestamp DEFAULT now() NOT NULL
    )`,
    `CREATE TABLE users (
      id uuid PRIMARY KEY,
      organization_id uuid NOT NULL REFERENCES organizations(id)
    )`,
    `CREATE TABLE service_pricing (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      service_id text NOT NULL,
      method text NOT NULL,
      cost numeric(12,6) NOT NULL,
      updated_at timestamp DEFAULT now() NOT NULL
    )`,
    `CREATE TABLE service_pricing_audit (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      service_pricing_id uuid,
      service_id text NOT NULL,
      method text NOT NULL,
      old_cost numeric(12,6),
      new_cost numeric(12,6) NOT NULL,
      change_type text NOT NULL,
      changed_by text NOT NULL,
      reason text,
      created_at timestamp DEFAULT now() NOT NULL
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
  await dbWrite.execute(sql`INSERT INTO service_pricing (service_id, method, cost)
    VALUES ('storage', 'put_per_byte', 0)`);
  for (const migration of MIGRATIONS) await executeSqlFile(migration);
  ({ orgStorageMutationsRepository: repository } = await import("../org-storage-mutations"));
}, TIMEOUT);

beforeEach(async () => {
  // The production receipt table rejects DELETE/TRUNCATE. This database-owner-only
  // fixture reset bypasses just its statement guard; migration tests exercise the guard itself.
  await dbWrite.execute(
    sql.raw(
      "ALTER TABLE org_storage_read_operations DISABLE TRIGGER org_storage_read_truncate_guard_trigger",
    ),
  );
  try {
    await dbWrite.execute(
      sql.raw(`TRUNCATE org_storage_read_operations, org_storage_gc_outbox,
        org_storage_delete_operations, org_storage_put_operations, org_storage_objects,
        org_storage_quota, credit_transactions, users, organizations CASCADE`),
    );
  } finally {
    await dbWrite.execute(
      sql.raw(
        "ALTER TABLE org_storage_read_operations ENABLE TRIGGER org_storage_read_truncate_guard_trigger",
      ),
    );
  }
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
  const reservation = await repository.reservePutCredits({
    operationId: prepared.operation.id,
    organizationId: ORG,
  });
  const reserved = reservation.operation;
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
  test("reseeds and audits a put_per_byte price rounded to zero by the old schema", async () => {
    const pricing = await dbWrite.execute(sql`SELECT cost FROM service_pricing
      WHERE service_id = 'storage' AND method = 'put_per_byte'`);
    expect(String((pricing.rows[0] as { cost: string } | undefined)?.cost)).toBe("0.000000001000");
    const audit = await dbWrite.execute(sql`SELECT old_cost, new_cost, changed_by
      FROM service_pricing_audit WHERE service_id = 'storage' AND method = 'put_per_byte'`);
    expect(audit.rows[0]).toMatchObject({
      old_cost: "0.000000000000",
      new_cost: "0.000000001000",
      changed_by: "migration:0256",
    });
  });

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
    const reservation = await repository.reservePutCredits({
      operationId: prepared.operation.id,
      organizationId: ORG,
    });
    const reserved = reservation.operation;
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

  test("fences a stale reconciler against a concurrent live provider claim", async () => {
    const prepared = await prepare("recovery-race", "a", 4n);
    const reservation = await repository.reservePutCredits({
      operationId: prepared.operation.id,
      organizationId: ORG,
    });
    const reserved = reservation.operation;
    const now = new Date();
    await dbWrite.execute(sql`UPDATE org_storage_put_operations
      SET updated_at = ${new Date(now.getTime() - 11 * 60 * 1000)}
      WHERE id = ${reserved.id}`);
    const claims = await Promise.allSettled([
      repository.claimReconciliationLease({
        operationId: reserved.id,
        organizationId: ORG,
        leaseToken: crypto.randomUUID(),
        leaseExpiresAt: new Date(now.getTime() + 60_000),
        staleBefore: new Date(now.getTime() - 10 * 60_000),
        now,
      }),
      repository.claimProviderLease({
        operationId: reserved.id,
        organizationId: ORG,
        leaseToken: crypto.randomUUID(),
        leaseExpiresAt: new Date(now.getTime() + 60_000),
        now,
      }),
    ]);
    expect(claims.filter((claim) => claim.status === "fulfilled")).toHaveLength(1);
    expect(claims.filter((claim) => claim.status === "rejected")).toHaveLength(1);
  });

  test("requires an expired provider-absence quarantine before one reconciler can recheck", async () => {
    const prepared = await prepare("quarantine", "e", 4n);
    await repository.reservePutCredits({
      operationId: prepared.operation.id,
      organizationId: ORG,
    });
    const provider = await repository.claimProviderLease({
      operationId: prepared.operation.id,
      organizationId: ORG,
      leaseToken: crypto.randomUUID(),
      leaseExpiresAt: new Date(Date.now() - 1),
      now: new Date(Date.now() - 2),
    });
    const firstToken = crypto.randomUUID();
    const firstClaim = await repository.claimReconciliationLease({
      operationId: provider.id,
      organizationId: ORG,
      leaseToken: firstToken,
      leaseExpiresAt: new Date(Date.now() + 60_000),
      staleBefore: new Date(),
      now: new Date(),
    });
    const recheckAt = new Date(Date.now() + 10 * 60_000);
    const quarantined = await repository.deferProviderAbsence({
      operationId: firstClaim.id,
      organizationId: ORG,
      leaseToken: firstToken,
      observedAt: new Date(),
      recheckAt,
    });
    expect(quarantined.state).toBe("reconciling");
    expect(quarantined.provider_absence_observed_at).toBeInstanceOf(Date);
    await expect(
      repository.claimReconciliationLease({
        operationId: quarantined.id,
        organizationId: ORG,
        leaseToken: crypto.randomUUID(),
        leaseExpiresAt: new Date(Date.now() + 60_000),
        staleBefore: new Date(),
        now: new Date(),
      }),
    ).rejects.toMatchObject({ reason: "stale_lease" });

    await dbWrite.execute(sql`UPDATE org_storage_put_operations
      SET lease_expires_at = ${new Date(Date.now() - 1)}
      WHERE id = ${quarantined.id}`);
    const attempts = await Promise.allSettled(
      [crypto.randomUUID(), crypto.randomUUID()].map((leaseToken) =>
        repository.claimReconciliationLease({
          operationId: quarantined.id,
          organizationId: ORG,
          leaseToken,
          leaseExpiresAt: new Date(Date.now() + 60_000),
          staleBefore: new Date(),
          now: new Date(),
        }),
      ),
    );
    expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1);
  });

  test("atomically fences credit reservation against prepared-operation recovery", async () => {
    const prepared = await repository.preparePut({
      organizationId: ORG,
      logicalKey: "credit-attach-race",
      idempotencyKeyHash: "7".repeat(64),
      requestDigest: "8".repeat(64),
      sizeBytes: 4n,
      contentType: "text/plain",
      contentSha256: "9".repeat(64),
      priceUsd: "1.000000",
    });
    const now = new Date();
    await dbWrite.execute(sql`UPDATE org_storage_put_operations
      SET created_at = ${new Date(now.getTime() - 11 * 60 * 1000)}
      WHERE id = ${prepared.operation.id}`);
    const outcomes = await Promise.allSettled([
      repository.reservePutCredits({
        operationId: prepared.operation.id,
        organizationId: ORG,
      }),
      repository.claimReconciliationLease({
        operationId: prepared.operation.id,
        organizationId: ORG,
        leaseToken: crypto.randomUUID(),
        leaseExpiresAt: new Date(now.getTime() + 60_000),
        staleBefore: new Date(now.getTime() - 10 * 60_000),
        now,
      }),
    ]);
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === "rejected")).toHaveLength(1);
    const result = await dbWrite.execute(sql`SELECT operation.state,
        organization.credit_balance, count(hold.id) AS hold_count
      FROM org_storage_put_operations operation
      JOIN organizations organization ON organization.id = operation.organization_id
      LEFT JOIN credit_transactions hold
        ON hold.metadata->>'storage_operation_id' = operation.id::text
      WHERE operation.id = ${prepared.operation.id}
      GROUP BY operation.state, organization.credit_balance`);
    const row = result.rows[0] as Record<string, unknown>;
    if (row.state === "reserved") {
      expect(row).toMatchObject({ credit_balance: "9.000000", hold_count: 1 });
    } else {
      expect(row).toMatchObject({
        state: "reconciling",
        credit_balance: "10.000000",
        hold_count: 0,
      });
    }
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

  test("adopts already-counted legacy bytes and transfers overwrite authority to GC", async () => {
    await dbWrite.execute(
      sql`UPDATE org_storage_quota SET bytes_used = 10 WHERE organization_id = ${ORG}`,
    );
    const legacyKey = `org/${ORG}/legacy/voice.ogg`;
    const adopted = await repository.adoptLegacyObject({
      organizationId: ORG,
      logicalKey: "legacy/voice.ogg",
      providerKey: legacyKey,
      sizeBytes: 8n,
      contentType: "audio/ogg",
      etag: "legacy-etag",
      uploadedAt: new Date("2026-08-18T00:00:00.000Z"),
    });
    expect(adopted.generation).toBe(0n);
    expect(adopted.provider_key).toBe(legacyKey);
    await repository.adoptLegacyObjects([
      {
        organizationId: ORG,
        logicalKey: "legacy/second.ogg",
        providerKey: `org/${ORG}/legacy/second.ogg`,
        sizeBytes: 2n,
        contentType: "audio/ogg",
        etag: "legacy-second-etag",
        uploadedAt: new Date("2026-08-18T00:00:00.000Z"),
      },
    ]);
    const prepared = await prepare("legacy/voice.ogg", "e", 3n);
    expect(prepared.operation.source_size_bytes).toBe(8n);
    expect(prepared.operation.quota_reserved_bytes).toBe(0n);
    await commitZeroCost("legacy/voice.ogg", "e", 3n);

    const quota = await dbWrite.execute(
      sql`SELECT bytes_used FROM org_storage_quota WHERE organization_id = ${ORG}`,
    );
    expect(String((quota.rows[0] as { bytes_used: string } | undefined)?.bytes_used)).toBe("5");
    const gc = await dbWrite.execute(
      sql`SELECT provider_key FROM org_storage_gc_outbox WHERE organization_id = ${ORG}`,
    );
    expect(gc.rows[0]).toMatchObject({ provider_key: legacyKey });
    const listed = await repository.listObjects(ORG, "legacy/");
    expect(listed.map((object) => object.logical_key)).toEqual([
      "legacy/second.ogg",
      "legacy/voice.ogg",
    ]);
    expect(listed[1]?.generation).toBe(1n);
  });

  test("does not collect an overwritten generation while a durable read retains it", async () => {
    await commitZeroCost("retained-generation", "a", 6n);
    const object = await repository.findObject(ORG, "retained-generation");
    if (!object?.provider_key || !object.content_type || !object.etag || !object.uploaded_at) {
      throw new Error("committed storage fixture is incomplete");
    }
    const now = new Date();
    const userId = crypto.randomUUID();
    await dbWrite.execute(sql`INSERT INTO users (id, organization_id) VALUES (${userId}, ${ORG})`);
    const receipt = await dbWrite.execute(sql`INSERT INTO org_storage_read_operations (
        organization_id, user_id, object_id, idempotency_key_hash, request_digest,
        method, price_usd, retain_until
      ) VALUES (
        ${ORG}, ${userId}, ${object.id}, ${"5".repeat(64)}, ${"6".repeat(64)},
        'get', 0, ${new Date(now.getTime() + 60_000)}
      ) RETURNING id`);
    const receiptId = (receipt.rows[0] as { id: string }).id;
    await dbWrite.execute(sql`UPDATE org_storage_read_operations SET
        state = 'provider_succeeded', object_generation = ${object.generation},
        provider_key = ${object.provider_key}, result_size_bytes = ${object.size_bytes},
        result_content_type = ${object.content_type}, result_etag = ${object.etag},
        response_status = 200, response_json = ${JSON.stringify({ size: 6 })},
        provider_succeeded_at = ${now}
      WHERE id = ${receiptId}`);
    await dbWrite.execute(sql`UPDATE org_storage_read_operations
      SET state = 'committed', completed_at = ${now} WHERE id = ${receiptId}`);

    await commitZeroCost("retained-generation", "e", 3n);
    await dbWrite.execute(sql`UPDATE org_storage_gc_outbox
      SET not_before = ${new Date(now.getTime() - 1_000)}
      WHERE provider_key = ${object.provider_key}`);

    expect(await repository.listDueGc(now)).toEqual([]);
    expect(
      (await repository.listDueGc(new Date(now.getTime() + 61_000))).map(
        (item) => item.provider_key,
      ),
    ).toEqual([object.provider_key]);
  });

  test("repairs historical quota drift from the adopted catalog plus active reservations", async () => {
    await repository.adoptLegacyObjects([
      {
        organizationId: ORG,
        logicalKey: "legacy/one.bin",
        providerKey: `org/${ORG}/legacy/one.bin`,
        sizeBytes: 3n,
        contentType: "application/octet-stream",
        etag: "one-etag",
        uploadedAt: new Date("2026-08-18T00:00:00.000Z"),
      },
      {
        organizationId: ORG,
        logicalKey: "legacy/two.bin",
        providerKey: `org/${ORG}/legacy/two.bin`,
        sizeBytes: 4n,
        contentType: "application/octet-stream",
        etag: "two-etag",
        uploadedAt: new Date("2026-08-18T00:01:00.000Z"),
      },
    ]);
    await dbWrite.execute(sql`UPDATE org_storage_quota
      SET bytes_used = 99, bytes_limit = 1000
      WHERE organization_id = ${ORG}`);
    await Promise.all([
      repository.reconcileNativeQuotaFromCatalog(ORG),
      prepare("new.bin", "f", 5n),
    ]);

    const quota = await dbWrite.execute(sql`SELECT bytes_used FROM org_storage_quota
      WHERE organization_id = ${ORG}`);
    expect(BigInt(String(quota.rows[0]?.bytes_used))).toBe(12n);
    expect(await repository.quotaNeedsNativeCatalogReconciliation(ORG)).toBe(false);
  });

  test("filters non-recursive catalog depth before applying the result limit", async () => {
    await dbWrite.execute(sql`INSERT INTO org_storage_objects (
        organization_id, logical_key, provider_key, size_bytes,
        content_type, etag, uploaded_at
      )
      SELECT ${ORG}, 'folder/' || lpad(value::text, 4, '0') || '/item.bin',
        ${`org/${ORG}/folder/`} || lpad(value::text, 4, '0') || '/item.bin',
        1, 'application/octet-stream', 'etag-' || value, NOW()
      FROM generate_series(0, 1000) AS value`);
    await dbWrite.execute(sql`INSERT INTO org_storage_objects (
        organization_id, logical_key, provider_key, size_bytes,
        content_type, etag, uploaded_at
      ) VALUES (
        ${ORG}, 'folder/zzzz.bin', ${`org/${ORG}/folder/zzzz.bin`},
        1, 'application/octet-stream', 'direct-etag', NOW()
      )`);

    const listed = await repository.listObjects(ORG, "folder", 1001, false);
    expect(listed.map((object) => object.logical_key)).toEqual(["folder/zzzz.bin"]);
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
    const reservation = await repository.reservePutCredits({
      operationId: prepared.operation.id,
      organizationId: ORG,
    });
    expect(reservation.insufficient).toBe(false);
    const reserved = reservation.operation;
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

  test("atomically releases quota and writes a terminal receipt on insufficient credit", async () => {
    await dbWrite.execute(sql`UPDATE organizations SET credit_balance = 0.5 WHERE id = ${ORG}`);
    const prepared = await repository.preparePut({
      organizationId: ORG,
      logicalKey: "insufficient",
      idempotencyKeyHash: "0".repeat(64),
      requestDigest: "1".repeat(64),
      sizeBytes: 4n,
      contentType: "text/plain",
      contentSha256: "2".repeat(64),
      priceUsd: "1.000000",
    });
    const reservation = await repository.reservePutCredits({
      operationId: prepared.operation.id,
      organizationId: ORG,
    });
    expect(reservation.insufficient).toBe(true);
    expect(reservation.available).toBe(0.5);
    expect(reservation.operation.state).toBe("refunded");
    const result = await dbWrite.execute(sql`SELECT quota.bytes_used,
        organization.credit_balance, count(hold.id) AS hold_count
      FROM org_storage_quota quota
      JOIN organizations organization ON organization.id = quota.organization_id
      LEFT JOIN credit_transactions hold ON hold.organization_id = organization.id
      WHERE quota.organization_id = ${ORG}
      GROUP BY quota.bytes_used, organization.credit_balance`);
    expect(result.rows[0]).toMatchObject({
      bytes_used: 0,
      credit_balance: "0.500000",
      hold_count: 0,
    });
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
      Promise.resolve(
        dbWrite.execute(sql`UPDATE credit_transactions
          SET organization_id = ${ORG}
          WHERE id = ${transactionId}`),
      ),
    ).rejects.toThrow();
    await expect(
      Promise.resolve(
        dbWrite.execute(sql`UPDATE org_storage_put_operations
          SET state = 'reserved', credit_transaction_id = ${transactionId}
          WHERE id = ${prepared.operation.id}`),
      ),
    ).rejects.toThrow();
    expect((await repository.findOperation(ORG, prepared.operation.id))?.state).toBe("prepared");
  });

  test("rejects a held amount that does not match the pinned price before provider dispatch", async () => {
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
    await dbWrite.execute(sql`UPDATE org_storage_put_operations
      SET state = 'reserved', credit_transaction_id = ${transactionId}
      WHERE id = ${prepared.operation.id}`);
    const leased = await repository.claimProviderLease({
      operationId: prepared.operation.id,
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
      JOIN credit_transactions c ON c.id = ${transactionId}
      WHERE o.id = ${prepared.operation.id}`);
    const row = (result as { rows: Array<Record<string, unknown>> }).rows[0];
    expect(row).toMatchObject({ state: "provider_started", provider_key: null, settled_at: null });
  });

  test("atomically refunds an orphan hold with quota and terminal replay", async () => {
    const prepared = await repository.preparePut({
      organizationId: ORG,
      logicalKey: "orphan-refund",
      idempotencyKeyHash: "f".repeat(64),
      requestDigest: "e".repeat(64),
      sizeBytes: 4n,
      contentType: "text/plain",
      contentSha256: "d".repeat(64),
      priceUsd: "1.000000",
    });
    const holdId = crypto.randomUUID();
    await dbWrite.execute(sql`UPDATE organizations SET credit_balance = 9 WHERE id = ${ORG}`);
    await dbWrite.execute(sql`INSERT INTO credit_transactions
      (id, organization_id, amount, type, metadata)
      VALUES (
        ${holdId}, ${ORG}, -1.000000, 'debit',
        ${JSON.stringify({
          type: "reservation",
          settlement_marker: "credit_reservation_v1",
          storage_operation_id: prepared.operation.id,
        })}::jsonb
      )`);
    const now = new Date();
    await dbWrite.execute(sql`UPDATE org_storage_put_operations
      SET created_at = ${new Date(now.getTime() - 11 * 60 * 1000)}
      WHERE id = ${prepared.operation.id}`);
    const leaseToken = crypto.randomUUID();
    const claimed = await repository.claimReconciliationLease({
      operationId: prepared.operation.id,
      organizationId: ORG,
      leaseToken,
      leaseExpiresAt: new Date(now.getTime() + 60_000),
      staleBefore: new Date(now.getTime() - 10 * 60_000),
      now,
    });
    expect(claimed.state).toBe("reconciling");
    const responseJson = JSON.stringify({ error: "Storage PUT did not reach R2" });
    await repository.finalizeRefund({
      operationId: claimed.id,
      organizationId: ORG,
      leaseToken,
      responseJson,
    });
    await repository.finalizeRefund({
      operationId: claimed.id,
      organizationId: ORG,
      leaseToken,
      responseJson,
    });
    const result = await dbWrite.execute(sql`SELECT
        operation.state, operation.credit_transaction_id, hold.settled_at,
        quota.bytes_used, organization.credit_balance,
        count(refund.id) AS refund_count
      FROM org_storage_put_operations operation
      JOIN credit_transactions hold ON hold.id = ${holdId}
      JOIN org_storage_quota quota ON quota.organization_id = operation.organization_id
      JOIN organizations organization ON organization.id = operation.organization_id
      LEFT JOIN credit_transactions refund
        ON refund.metadata->>'storage_operation_id' = operation.id::text
       AND refund.metadata->>'type' = 'storage_put_refund'
      WHERE operation.id = ${claimed.id}
      GROUP BY operation.state, operation.credit_transaction_id, hold.settled_at,
        quota.bytes_used, organization.credit_balance`);
    expect(result.rows[0]).toMatchObject({
      state: "refunded",
      credit_transaction_id: null,
      bytes_used: 0,
      credit_balance: "10.000000",
      refund_count: 1,
    });
    expect((result.rows[0] as { settled_at?: unknown } | undefined)?.settled_at).not.toBeNull();
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

  test("holds DELETE while an exact GET receipt remains recoverable", async () => {
    await commitZeroCost("retained", "f", 6n);
    const object = await repository.findObject(ORG, "retained");
    if (!object?.provider_key || !object.content_type || !object.etag || !object.uploaded_at) {
      throw new Error("committed storage fixture is incomplete");
    }
    const userId = crypto.randomUUID();
    await dbWrite.execute(sql`INSERT INTO users (id, organization_id) VALUES (${userId}, ${ORG})`);
    const receipt = await dbWrite.execute(sql`INSERT INTO org_storage_read_operations (
        organization_id, user_id, object_id, idempotency_key_hash, request_digest,
        method, price_usd, retain_until
      ) VALUES (
        ${ORG}, ${userId}, ${object.id}, ${"1".repeat(64)}, ${"2".repeat(64)},
        'get', 0, ${new Date(Date.now() + 60_000)}
      ) RETURNING id`);
    const receiptId = (receipt.rows[0] as { id: string }).id;
    await dbWrite.execute(sql`UPDATE org_storage_read_operations SET
        state = 'provider_succeeded', object_generation = ${object.generation},
        provider_key = ${object.provider_key}, result_size_bytes = ${object.size_bytes},
        result_content_type = ${object.content_type}, result_etag = ${object.etag},
        response_status = 200, response_json = ${JSON.stringify({
          contentType: object.content_type,
          size: Number(object.size_bytes),
          etag: object.etag,
          lastModified: object.uploaded_at.toUTCString(),
        })}, provider_succeeded_at = NOW()
      WHERE id = ${receiptId}`);
    await dbWrite.execute(sql`UPDATE org_storage_read_operations
      SET state = 'committed', completed_at = NOW() WHERE id = ${receiptId}`);

    await expect(
      repository.prepareDelete({
        organizationId: ORG,
        logicalKey: "retained",
        idempotencyKeyHash: "3".repeat(64),
        requestDigest: "4".repeat(64),
      }),
    ).rejects.toMatchObject({ reason: "object_busy" });
  });
});
