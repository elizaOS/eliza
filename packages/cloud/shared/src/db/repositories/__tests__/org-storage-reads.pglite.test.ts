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
    join(import.meta.dir, "../../migrations/0264_org_storage_read_operations.sql"),
    "utf8",
  );
  for (const statement of source.split("--> statement-breakpoint")) {
    if (statement.trim()) await dbWrite.execute(sql.raw(statement));
  }
  ({ orgStorageReadsRepository: repository } = await import("../org-storage-reads"));
}, TIMEOUT);

beforeEach(async () => {
  await dbWrite.execute(
    sql.raw(
      "TRUNCATE org_storage_read_operations, org_storage_delete_operations, credit_transactions, org_storage_objects, users, organizations CASCADE",
    ),
  );
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
});
