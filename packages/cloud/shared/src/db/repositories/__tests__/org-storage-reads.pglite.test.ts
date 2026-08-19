/**
 * Exercises durable storage-read repository settlement against real PGlite,
 * including concurrent idempotency, exact-once debit, ACK-loss replay, and
 * zero-cost terminal receipts.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { sql } from "drizzle-orm";

process.env.DATABASE_URL = "pglite://memory";
process.env.TEST_DATABASE_URL = "pglite://memory";
process.env.NODE_ENV ||= "test";

const ORG = "00000000-0000-4000-8000-000000021045";
const USER = "00000000-0000-4000-8000-000000021047";
const OBJECT = "00000000-0000-4000-8000-000000021048";
const TIMEOUT = 60_000;

let dbWrite: typeof import("../../client").dbWrite;
let closeDatabaseConnectionsForTests:
  | typeof import("../../client").closeDatabaseConnectionsForTests
  | null = null;
let repository: typeof import("../org-storage-reads").orgStorageReadsRepository;

beforeAll(async () => {
  ({ closeDatabaseConnectionsForTests, dbWrite } = await import("../../client"));
  for (const statement of [
    `CREATE TABLE organizations (
      id uuid PRIMARY KEY,
      name text NOT NULL,
      slug text NOT NULL UNIQUE,
      credit_balance numeric(12,6) DEFAULT 10 NOT NULL,
      updated_at timestamp with time zone DEFAULT now() NOT NULL
    )`,
    `CREATE TABLE users (
      id uuid PRIMARY KEY,
      organization_id uuid NOT NULL REFERENCES organizations(id)
    )`,
    `CREATE TABLE credit_transactions (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      organization_id uuid NOT NULL REFERENCES organizations(id),
      user_id uuid NOT NULL REFERENCES users(id),
      amount numeric(12,6) NOT NULL,
      type text NOT NULL,
      description text,
      metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
      settled_at timestamp with time zone,
      created_at timestamp with time zone DEFAULT now() NOT NULL
    )`,
    `CREATE TABLE org_storage_objects (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      organization_id uuid NOT NULL REFERENCES organizations(id),
      generation bigint DEFAULT 1 NOT NULL,
      provider_key text,
      size_bytes bigint DEFAULT 0 NOT NULL,
      etag text,
      deleted_at timestamp with time zone,
      UNIQUE (id, organization_id)
    )`,
    `CREATE TABLE org_storage_delete_operations (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      organization_id uuid NOT NULL REFERENCES organizations(id),
      object_id uuid NOT NULL REFERENCES org_storage_objects(id),
      state text NOT NULL DEFAULT 'prepared'
    )`,
  ]) {
    await dbWrite.execute(sql.raw(statement));
  }
  const source = readFileSync(
    join(import.meta.dir, "../../migrations/0266_org_storage_read_operations.sql"),
    "utf8",
  );
  for (const statement of source.split("--> statement-breakpoint")) {
    if (statement.trim()) await dbWrite.execute(sql.raw(statement));
  }
  ({ orgStorageReadsRepository: repository } = await import("../org-storage-reads"));
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
      sql.raw(
        "TRUNCATE org_storage_read_operations, org_storage_delete_operations, credit_transactions, org_storage_objects, users, organizations CASCADE",
      ),
    );
  } finally {
    await dbWrite.execute(
      sql.raw(
        "ALTER TABLE org_storage_read_operations ENABLE TRIGGER org_storage_read_truncate_guard_trigger",
      ),
    );
  }
  await dbWrite.execute(
    sql`INSERT INTO organizations (id, name, slug, credit_balance)
      VALUES (${ORG}, 'Storage Test', 'storage-test', 1.000000)`,
  );
  await dbWrite.execute(sql`INSERT INTO users (id, organization_id) VALUES (${USER}, ${ORG})`);
  await dbWrite.execute(sql`INSERT INTO org_storage_objects (
      id, organization_id, generation, provider_key, size_bytes, etag
    ) VALUES (${OBJECT}, ${ORG}, 1, 'opaque-provider-generation', 5, 'etag-1')`);
});

afterAll(async () => {
  if (closeDatabaseConnectionsForTests) await closeDatabaseConnectionsForTests();
});

function prepare(priceUsd: string, key = "a".repeat(64)) {
  return repository.prepare({
    organizationId: ORG,
    userId: USER,
    idempotencyKeyHash: key,
    requestDigest: "b".repeat(64),
    method: "list",
    priceUsd,
  });
}

async function providerSucceeded(id: string) {
  return await repository.recordProviderSuccess({
    operationId: id,
    organizationId: ORG,
    responseStatus: 200,
    responseJson: JSON.stringify({ items: [], truncated: false }),
    providerSucceededAt: new Date(),
  });
}

async function committedExpiredPresign() {
  const issuedAt = new Date();
  const expiresAt = new Date(issuedAt.getTime() + 60_000);
  const prepared = await repository.prepare({
    organizationId: ORG,
    userId: USER,
    objectId: OBJECT,
    idempotencyKeyHash: "9".repeat(64),
    requestDigest: "8".repeat(64),
    method: "presign",
    priceUsd: "0.000000",
    capabilityId: crypto.randomUUID(),
    capabilityHost: "blob.example.test",
    capabilityIssuedAt: issuedAt,
    capabilityExpiresAt: expiresAt,
    retainUntil: expiresAt,
  });
  const succeeded = await repository.recordProviderSuccess({
    operationId: prepared.operation.id,
    organizationId: ORG,
    objectId: OBJECT,
    objectGeneration: 1n,
    providerKey: "opaque-provider-generation",
    resultSizeBytes: 5n,
    resultContentType: "audio/ogg",
    resultEtag: "etag-1",
    responseStatus: 200,
    responseJson: JSON.stringify({ expiresAt: expiresAt.toISOString() }),
    providerSucceededAt: issuedAt,
  });
  return (
    await repository.commitProviderSuccess({
      operationId: succeeded.id,
      organizationId: ORG,
      now: issuedAt,
    })
  ).operation;
}

describe("OrgStorageReadsRepository", () => {
  test("serializes a tenant idempotency race into one request authority", async () => {
    const attempts = await Promise.all([prepare("0.100000"), prepare("0.100000")]);
    expect(new Set(attempts.map((value) => value.operation.id)).size).toBe(1);
    expect(attempts.filter((value) => value.replay)).toHaveLength(1);
  });

  test("settles one exact debit and replays provider success after ACK loss", async () => {
    const prepared = await prepare("0.250000");
    const succeeded = await providerSucceeded(prepared.operation.id);
    await expect(
      repository.recordProviderSuccess({
        operationId: succeeded.id,
        organizationId: ORG,
        responseStatus: 200,
        responseJson: JSON.stringify({ items: [], truncated: false }),
        providerSucceededAt: new Date(Date.now() + 1_000),
      }),
    ).resolves.toMatchObject({ id: succeeded.id, state: "provider_succeeded" });

    const settlements = await Promise.all([
      repository.commitProviderSuccess({
        operationId: succeeded.id,
        organizationId: ORG,
        now: new Date(),
      }),
      repository.commitProviderSuccess({
        operationId: succeeded.id,
        organizationId: ORG,
        now: new Date(),
      }),
    ]);
    expect(settlements.every((value) => value.operation.state === "committed")).toBe(true);
    const balance = await dbWrite.execute(
      sql`SELECT credit_balance FROM organizations WHERE id = ${ORG}`,
    );
    expect(balance.rows).toEqual([{ credit_balance: "0.750000" }]);
    const ledger = await dbWrite.execute(sql`SELECT amount FROM credit_transactions`);
    expect(ledger.rows).toEqual([{ amount: "-0.250000" }]);
  });

  test("commits a durable zero-cost receipt without a ledger row", async () => {
    const prepared = await prepare("0.000000", "c".repeat(64));
    const succeeded = await providerSucceeded(prepared.operation.id);
    const committed = await repository.commitProviderSuccess({
      operationId: succeeded.id,
      organizationId: ORG,
      now: new Date(),
    });
    expect(committed.operation).toMatchObject({
      state: "committed",
      credit_transaction_id: null,
    });
    const ledger = await dbWrite.execute(
      sql`SELECT count(*)::int AS count FROM credit_transactions`,
    );
    expect(ledger.rows).toEqual([{ count: 0 }]);
  });

  test("terminalizes provider success as insufficient without any debit", async () => {
    const prepared = await prepare("2.000000", "d".repeat(64));
    const succeeded = await providerSucceeded(prepared.operation.id);
    const failed = await repository.commitProviderSuccess({
      operationId: succeeded.id,
      organizationId: ORG,
      now: new Date(),
    });
    expect(failed).toMatchObject({ insufficient: true, operation: { state: "failed" } });
    const balance = await dbWrite.execute(
      sql`SELECT credit_balance FROM organizations WHERE id = ${ORG}`,
    );
    expect(balance.rows).toEqual([{ credit_balance: "1.000000" }]);
  });

  test("rejects settlement authority after a serialized DELETE starts", async () => {
    const prepared = await repository.prepare({
      organizationId: ORG,
      userId: USER,
      objectId: OBJECT,
      idempotencyKeyHash: "e".repeat(64),
      requestDigest: "f".repeat(64),
      method: "get",
      priceUsd: "0.000000",
      retainUntil: new Date(Date.now() + 60_000),
    });
    await dbWrite.execute(sql`INSERT INTO org_storage_delete_operations
      (organization_id, object_id) VALUES (${ORG}, ${OBJECT})`);
    await expect(
      repository.recordProviderSuccess({
        operationId: prepared.operation.id,
        organizationId: ORG,
        objectId: OBJECT,
        objectGeneration: 1n,
        providerKey: "opaque-provider-generation",
        resultSizeBytes: 5n,
        resultContentType: "audio/ogg",
        resultEtag: "etag-1",
        responseStatus: 200,
        responseJson: JSON.stringify({ size: 5 }),
        providerSucceededAt: new Date(),
      }),
    ).rejects.toMatchObject({ reason: "provider_result_mismatch" });
  });

  test("serializes unbounded capability renewal generations and ACK-loss replay", async () => {
    const root = await committedExpiredPresign();
    const lineageNow = new Date(Date.now() + 120_000);
    let latest = root;
    for (let generation = 1; generation <= 4; generation++) {
      const issuedAt = new Date(lineageNow.getTime() + (generation - 1) * 120_000);
      const expiresAt = new Date(issuedAt.getTime() + 60_000);
      const input = {
        organizationId: ORG,
        userId: USER,
        rootOperationId: root.id,
        expectedGeneration: generation,
        idempotencyKeyHash: generation.toString(16).repeat(64),
        requestDigest: (generation + 4).toString(16).repeat(64),
        priceUsd: "0.000000",
        capabilityId: crypto.randomUUID(),
        capabilityHost: "blob.example.test",
        capabilityIssuedAt: issuedAt,
        capabilityExpiresAt: expiresAt,
        now: issuedAt,
      };
      const raced = await Promise.all([
        repository.preparePresignRenewal(input),
        repository.preparePresignRenewal({ ...input, capabilityId: crypto.randomUUID() }),
      ]);
      expect(new Set(raced.map((value) => value.operation.id)).size).toBe(1);
      latest = raced[0]!.operation;
      expect(latest.renewal_generation).toBe(generation);
      const succeeded = await repository.recordProviderSuccess({
        operationId: latest.id,
        organizationId: ORG,
        objectId: OBJECT,
        objectGeneration: 1n,
        providerKey: "opaque-provider-generation",
        resultSizeBytes: 5n,
        resultContentType: "audio/ogg",
        resultEtag: "etag-1",
        responseStatus: 200,
        responseJson: JSON.stringify({ expiresAt: expiresAt.toISOString() }),
        providerSucceededAt: issuedAt,
      });
      const ackLossReplay = await repository.preparePresignRenewal(input);
      expect(ackLossReplay).toMatchObject({
        created: false,
        operation: { id: succeeded.id, state: "provider_succeeded" },
      });
      latest = (
        await repository.commitProviderSuccess({
          operationId: succeeded.id,
          organizationId: ORG,
          now: issuedAt,
        })
      ).operation;
    }
    const rows = await dbWrite.execute(sql`SELECT renewal_generation
      FROM org_storage_read_operations WHERE id = ${root.id} OR renewal_root_id = ${root.id}
      ORDER BY renewal_generation`);
    expect(rows.rows).toEqual([
      { renewal_generation: 0 },
      { renewal_generation: 1 },
      { renewal_generation: 2 },
      { renewal_generation: 3 },
      { renewal_generation: 4 },
    ]);

    await repository.revokeCapabilitiesForObject({
      organizationId: ORG,
      objectId: OBJECT,
      now: new Date(lineageNow.getTime() + 4 * 120_000),
    });
    await expect(
      repository.preparePresignRenewal({
        organizationId: ORG,
        userId: USER,
        rootOperationId: root.id,
        expectedGeneration: 5,
        idempotencyKeyHash: "e".repeat(64),
        requestDigest: "f".repeat(64),
        priceUsd: "0.000000",
        capabilityId: crypto.randomUUID(),
        capabilityHost: "blob.example.test",
        capabilityIssuedAt: lineageNow,
        capabilityExpiresAt: new Date(lineageNow.getTime() + 60_000),
        now: lineageNow,
      }),
    ).rejects.toMatchObject({ reason: "state_conflict" });
  });

  test("tombstones an expired provider success without debit before renewing", async () => {
    const issuedAt = new Date("2026-08-19T10:00:00.000Z");
    const expiresAt = new Date("2026-08-19T10:01:00.000Z");
    const prepared = await repository.prepare({
      organizationId: ORG,
      userId: USER,
      objectId: OBJECT,
      idempotencyKeyHash: "1".repeat(64),
      requestDigest: "2".repeat(64),
      method: "presign",
      priceUsd: "0.250000",
      capabilityId: crypto.randomUUID(),
      capabilityHost: "blob.example.test",
      capabilityIssuedAt: issuedAt,
      capabilityExpiresAt: expiresAt,
      retainUntil: expiresAt,
    });
    await repository.recordProviderSuccess({
      operationId: prepared.operation.id,
      organizationId: ORG,
      objectId: OBJECT,
      objectGeneration: 1n,
      providerKey: "opaque-provider-generation",
      resultSizeBytes: 5n,
      resultContentType: "audio/ogg",
      resultEtag: "etag-1",
      responseStatus: 200,
      responseJson: JSON.stringify({ expiresAt: expiresAt.toISOString() }),
      providerSucceededAt: issuedAt,
    });
    const expired = await repository.expirePresignProviderSuccess({
      operationId: prepared.operation.id,
      organizationId: ORG,
      now: new Date("2026-08-19T10:02:00.000Z"),
    });
    expect(expired).toMatchObject({ state: "failed", response_status: 409 });
    const ledger = await dbWrite.execute(
      sql`SELECT count(*)::int AS count FROM credit_transactions`,
    );
    expect(ledger.rows).toEqual([{ count: 0 }]);
    await expect(
      repository.preparePresignRenewal({
        organizationId: ORG,
        userId: USER,
        rootOperationId: prepared.operation.id,
        expectedGeneration: 1,
        idempotencyKeyHash: "3".repeat(64),
        requestDigest: "4".repeat(64),
        priceUsd: "0.250000",
        capabilityId: crypto.randomUUID(),
        capabilityHost: "blob.example.test",
        capabilityIssuedAt: new Date("2026-08-19T10:02:00.000Z"),
        capabilityExpiresAt: new Date("2026-08-19T10:03:00.000Z"),
        now: new Date("2026-08-19T10:02:00.000Z"),
      }),
    ).resolves.toMatchObject({ created: true, operation: { renewal_generation: 1 } });
  });

  test("denies renewal after the catalog object is deleted", async () => {
    const root = await committedExpiredPresign();
    await dbWrite.execute(
      sql`UPDATE org_storage_objects SET deleted_at = NOW() WHERE id = ${OBJECT}`,
    );
    await expect(
      repository.preparePresignRenewal({
        organizationId: ORG,
        userId: USER,
        rootOperationId: root.id,
        expectedGeneration: 1,
        idempotencyKeyHash: "5".repeat(64),
        requestDigest: "6".repeat(64),
        priceUsd: "0.000000",
        capabilityId: crypto.randomUUID(),
        capabilityHost: "blob.example.test",
        capabilityIssuedAt: new Date("2030-01-01T00:00:00.000Z"),
        capabilityExpiresAt: new Date("2030-01-01T00:01:00.000Z"),
        now: new Date("2030-01-01T00:00:00.000Z"),
      }),
    ).rejects.toMatchObject({ reason: "provider_result_mismatch" });
  });

  test("does not debit when revocation wins the provider-to-settlement race", async () => {
    const issuedAt = new Date("2026-08-19T10:00:00.000Z");
    const expiresAt = new Date("2030-08-19T10:00:00.000Z");
    const prepared = await repository.prepare({
      organizationId: ORG,
      userId: USER,
      objectId: OBJECT,
      idempotencyKeyHash: "7".repeat(64),
      requestDigest: "8".repeat(64),
      method: "presign",
      priceUsd: "0.250000",
      capabilityId: crypto.randomUUID(),
      capabilityHost: "blob.example.test",
      capabilityIssuedAt: issuedAt,
      capabilityExpiresAt: expiresAt,
      retainUntil: expiresAt,
    });
    await repository.recordProviderSuccess({
      operationId: prepared.operation.id,
      organizationId: ORG,
      objectId: OBJECT,
      objectGeneration: 1n,
      providerKey: "opaque-provider-generation",
      resultSizeBytes: 5n,
      resultContentType: "audio/ogg",
      resultEtag: "etag-1",
      responseStatus: 200,
      responseJson: JSON.stringify({ expiresAt: expiresAt.toISOString() }),
      providerSucceededAt: issuedAt,
    });
    await repository.revokeCapabilitiesForObject({
      organizationId: ORG,
      objectId: OBJECT,
      now: new Date("2026-08-19T10:01:00.000Z"),
    });
    const settled = await repository.commitProviderSuccess({
      operationId: prepared.operation.id,
      organizationId: ORG,
      now: new Date("2026-08-19T10:01:00.000Z"),
    });
    expect(settled.operation).toMatchObject({ state: "failed", response_status: 409 });
    const balance = await dbWrite.execute(
      sql`SELECT credit_balance FROM organizations WHERE id = ${ORG}`,
    );
    expect(balance.rows).toEqual([{ credit_balance: "1.000000" }]);
    const ledger = await dbWrite.execute(
      sql`SELECT count(*)::int AS count FROM credit_transactions`,
    );
    expect(ledger.rows).toEqual([{ count: 0 }]);
  });

  test("samples expiry after a settlement lock wait and renews from one no-debit tombstone", async () => {
    const issuedAt = new Date();
    const expiresAt = new Date(issuedAt.getTime() + 1_000);
    const prepared = await repository.prepare({
      organizationId: ORG,
      userId: USER,
      objectId: OBJECT,
      idempotencyKeyHash: "a".repeat(64),
      requestDigest: "c".repeat(64),
      method: "presign",
      priceUsd: "0.250000",
      capabilityId: crypto.randomUUID(),
      capabilityHost: "blob.example.test",
      capabilityIssuedAt: issuedAt,
      capabilityExpiresAt: expiresAt,
      retainUntil: expiresAt,
    });
    await repository.recordProviderSuccess({
      operationId: prepared.operation.id,
      organizationId: ORG,
      objectId: OBJECT,
      objectGeneration: 1n,
      providerKey: "opaque-provider-generation",
      resultSizeBytes: 5n,
      resultContentType: "audio/ogg",
      resultEtag: "etag-1",
      responseStatus: 200,
      responseJson: JSON.stringify({ expiresAt: expiresAt.toISOString() }),
      providerSucceededAt: issuedAt,
    });

    let releaseLock!: () => void;
    let reportLocked!: () => void;
    const locked = new Promise<void>((resolve) => {
      reportLocked = resolve;
    });
    const release = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });
    const blocker = dbWrite.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT id FROM org_storage_read_operations
          WHERE id = ${prepared.operation.id} FOR UPDATE`,
      );
      reportLocked();
      await release;
    });
    await locked;
    const stalePreExpiryTime = new Date();
    const settlements = Promise.all([
      repository.commitProviderSuccess({
        operationId: prepared.operation.id,
        organizationId: ORG,
        now: stalePreExpiryTime,
      }),
      repository.commitProviderSuccess({
        operationId: prepared.operation.id,
        organizationId: ORG,
        now: stalePreExpiryTime,
      }),
    ]);
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    releaseLock();
    await blocker;

    const expired = await settlements;
    expect(stalePreExpiryTime.getTime()).toBeLessThan(expiresAt.getTime());
    expect(expired).toHaveLength(2);
    expect(
      expired.every(
        (result) => result.operation.state === "failed" && result.operation.response_status === 409,
      ),
    ).toBe(true);
    const afterExpiry = await dbWrite.execute(sql`SELECT credit_balance FROM organizations
      WHERE id = ${ORG}`);
    expect(afterExpiry.rows).toEqual([{ credit_balance: "1.000000" }]);
    expect(
      (await dbWrite.execute(sql`SELECT count(*)::int AS count FROM credit_transactions`)).rows,
    ).toEqual([{ count: 0 }]);

    const renewalIssuedAt = new Date();
    const renewalExpiresAt = new Date(renewalIssuedAt.getTime() + 60_000);
    const renewal = await repository.preparePresignRenewal({
      organizationId: ORG,
      userId: USER,
      rootOperationId: prepared.operation.id,
      expectedGeneration: 1,
      idempotencyKeyHash: "d".repeat(64),
      requestDigest: "e".repeat(64),
      priceUsd: "0.250000",
      capabilityId: crypto.randomUUID(),
      capabilityHost: "blob.example.test",
      capabilityIssuedAt: renewalIssuedAt,
      capabilityExpiresAt: renewalExpiresAt,
      now: renewalIssuedAt,
    });
    const renewalSucceeded = await repository.recordProviderSuccess({
      operationId: renewal.operation.id,
      organizationId: ORG,
      objectId: OBJECT,
      objectGeneration: 1n,
      providerKey: "opaque-provider-generation",
      resultSizeBytes: 5n,
      resultContentType: "audio/ogg",
      resultEtag: "etag-1",
      responseStatus: 200,
      responseJson: JSON.stringify({ expiresAt: renewalExpiresAt.toISOString() }),
      providerSucceededAt: renewalIssuedAt,
    });
    await expect(
      repository.commitProviderSuccess({
        operationId: renewalSucceeded.id,
        organizationId: ORG,
        now: renewalIssuedAt,
      }),
    ).resolves.toMatchObject({ operation: { state: "committed" } });
    expect(
      (await dbWrite.execute(sql`SELECT amount FROM credit_transactions ORDER BY created_at`)).rows,
    ).toEqual([{ amount: "-0.250000" }]);
  });
});
