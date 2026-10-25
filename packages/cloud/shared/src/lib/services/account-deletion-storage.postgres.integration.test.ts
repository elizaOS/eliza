/** Exercises storage cleanup against real PostgreSQL and the production 0266 immutable-read migration over minimal surrounding table fixtures, with controlled provider absence observations. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Client } from "pg";

const url = process.env.APP_BILLING_TEST_POSTGRES_URL;
const schema = `storage_delete_${randomUUID().replaceAll("-", "_")}`;
if (url) {
  const scoped = new URL(url);
  scoped.searchParams.set(
    "options",
    `-c search_path=${schema},pg_catalog,public -c timezone=America/New_York`,
  );
  process.env.DATABASE_URL = scoped.toString();
  process.env.TEST_DATABASE_URL = scoped.toString();
}
let db: Client;
let reconcile: typeof import("./account-deletion-storage").reconcileAccountDeletionStorage;
let close: typeof import("../../db/client").closeDatabaseConnectionsForTests;

async function subject(withRead = false, withObject = true) {
  const organizationId = randomUUID(),
    userId = randomUUID(),
    requestId = randomUUID(),
    phaseReceiptId = randomUUID();
  const context = {
    organizationId,
    userId,
    requestId,
    phaseReceiptId,
    requestDigest: "a".repeat(64),
    lifecycleRevision: 1,
    phaseGeneration: 1,
  };
  await db.query("INSERT INTO organizations VALUES($1,'deletion_irreversible',$2,1)", [
    organizationId,
    requestId,
  ]);
  await db.query("INSERT INTO users VALUES($1,$2,'deletion_irreversible',$3,1)", [
    userId,
    organizationId,
    requestId,
  ]);
  await db.query("INSERT INTO account_deletion_requests VALUES($1,$2,$3,$4,1,'processing',now())", [
    requestId,
    organizationId,
    userId,
    context.requestDigest,
  ]);
  await db.query(
    "INSERT INTO account_deletion_phase_receipts VALUES($1,$2,'primary_object_storage',1,'leased',(now()+interval '5 minutes') AT TIME ZONE 'UTC')",
    [phaseReceiptId, requestId],
  );
  if (withObject)
    await db.query("INSERT INTO org_storage_objects VALUES($1,$2)", [randomUUID(), organizationId]);
  if (withRead)
    await db.query(
      "INSERT INTO org_storage_read_operations(organization_id,user_id,idempotency_key_hash,request_digest,method,price_usd) VALUES($1,$2,$3,$3,'list',0)",
      [organizationId, userId, "b".repeat(64)],
    );
  return context;
}
async function count(table: string, org: string) {
  return (await db.query(`SELECT count(*)::int AS n FROM ${table} WHERE organization_id=$1`, [org]))
    .rows[0].n;
}

describe.skipIf(!url)("canonical storage deletion", () => {
  beforeAll(async () => {
    db = new Client({ connectionString: url });
    await db.connect();
    await db.query(`CREATE SCHEMA ${schema}; SET search_path TO ${schema},pg_catalog,public`);
    await db.query(`CREATE TABLE organizations(id uuid PRIMARY KEY,account_lifecycle_state text,account_deletion_request_id uuid,account_lifecycle_revision bigint);
      CREATE TABLE users(id uuid PRIMARY KEY,organization_id uuid REFERENCES organizations(id),account_lifecycle_state text,account_deletion_request_id uuid,account_lifecycle_revision bigint);
      CREATE TABLE account_deletion_requests(id uuid PRIMARY KEY,organization_id uuid,user_id uuid,request_digest text,lifecycle_revision bigint,status text,irreversible_at timestamptz);
      CREATE TABLE account_deletion_phase_receipts(id uuid PRIMARY KEY,request_id uuid,phase text,lease_generation bigint,status text,lease_expires_at timestamp);
      CREATE TABLE org_storage_objects(id uuid PRIMARY KEY,organization_id uuid REFERENCES organizations(id),UNIQUE(id,organization_id));
      CREATE TABLE credit_transactions(id uuid PRIMARY KEY,organization_id uuid,user_id uuid,type text,amount numeric,settled_at timestamptz,metadata jsonb);
      CREATE TABLE org_storage_delete_operations(id uuid PRIMARY KEY,organization_id uuid);
      CREATE TABLE org_storage_gc_outbox(id uuid PRIMARY KEY,organization_id uuid);
      CREATE TABLE org_storage_put_operations(id uuid PRIMARY KEY,organization_id uuid);`);
    const migration = await readFile(
      new URL("../../db/migrations/0266_org_storage_read_operations.sql", import.meta.url),
      "utf8",
    );
    for (const statement of migration.split("--> statement-breakpoint"))
      if (statement.trim()) await db.query(statement);
    ({ reconcileAccountDeletionStorage: reconcile } = await import("./account-deletion-storage"));
    ({ closeDatabaseConnectionsForTests: close } = await import("../../db/client"));
  }, 120000);
  afterAll(async () => {
    await close?.();
    if (db) {
      await db.query(`DROP SCHEMA ${schema} CASCADE`);
      await db.end();
    }
  });
  test("orphan immutable reads require retention; arbitrary deletion stays forbidden", async () => {
    const c = await subject(true, false);
    expect(await reconcile(c, async () => true)).toBe("retained_reads");
    expect(await count("org_storage_read_operations", c.organizationId)).toBe(1);
    await expect(
      db.query("DELETE FROM org_storage_read_operations WHERE organization_id=$1", [
        c.organizationId,
      ]),
    ).rejects.toThrow("immutable audit history");
    await expect(db.query("TRUNCATE org_storage_read_operations")).rejects.toThrow(
      "immutable audit history",
    );
  });
  test("retained reads prevent object metadata cleanup too", async () => {
    const c = await subject(true);
    expect(await reconcile(c, async () => true)).toBe("retained_reads");
    expect(await count("org_storage_objects", c.organizationId)).toBe(1);
  });
  test("fresh provider absence removes only the authorized tenant's metadata", async () => {
    const c = await subject(),
      other = await subject(true);
    expect(await reconcile(c, async () => false)).toBe("provider_present");
    expect(await count("org_storage_objects", c.organizationId)).toBe(1);
    expect(await reconcile(c, async () => true)).toBe("absent");
    expect(await count("org_storage_objects", c.organizationId)).toBe(0);
    expect(await count("org_storage_objects", other.organizationId)).toBe(1);
    expect(await count("org_storage_read_operations", other.organizationId)).toBe(1);
    expect(await reconcile(c, async () => true)).toBe("absent");
  });
  test("stale generation, foreign phase, and expired lease cannot inspect or delete", async () => {
    const c = await subject(),
      other = await subject();
    let observed = 0;
    const absent = async () => {
      observed++;
      return true;
    };
    await expect(reconcile({ ...c, phaseGeneration: 0 }, absent)).rejects.toThrow(
      "current irreversible",
    );
    await expect(reconcile({ ...c, phaseReceiptId: other.phaseReceiptId }, absent)).rejects.toThrow(
      "current irreversible",
    );
    await db.query(
      "UPDATE account_deletion_phase_receipts SET lease_expires_at=(now()-interval '1 second') AT TIME ZONE 'UTC' WHERE id=$1",
      [c.phaseReceiptId],
    );
    await expect(reconcile(c, absent)).rejects.toThrow("current irreversible");
    expect(observed).toBe(0);
    expect(await count("org_storage_objects", c.organizationId)).toBe(1);
  });
  test("orphan mutation metadata is cleaned without an object row", async () => {
    const c = await subject(false, false),
      other = await subject(false, false);
    for (const table of [
      "org_storage_delete_operations",
      "org_storage_gc_outbox",
      "org_storage_put_operations",
    ]) {
      await db.query(`INSERT INTO ${table} VALUES($1,$2),($3,$4)`, [
        randomUUID(),
        c.organizationId,
        randomUUID(),
        other.organizationId,
      ]);
    }
    expect(await reconcile(c, async () => true)).toBe("absent");
    for (const table of [
      "org_storage_delete_operations",
      "org_storage_gc_outbox",
      "org_storage_put_operations",
    ]) {
      expect(await count(table, c.organizationId)).toBe(0);
      expect(await count(table, other.organizationId)).toBe(1);
    }
  });
  test("foreign request identity and reassigned personal membership cannot authorize cleanup", async () => {
    const c = await subject(),
      other = await subject();
    let observed = 0;
    const absent = async () => {
      observed++;
      return true;
    };
    for (const override of [
      { requestDigest: "c".repeat(64) },
      { userId: other.userId },
      { organizationId: other.organizationId },
      { requestId: other.requestId },
    ]) {
      await expect(reconcile({ ...c, ...override }, absent)).rejects.toThrow(
        "current irreversible",
      );
    }
    await db.query("UPDATE users SET organization_id=$1 WHERE id=$2", [
      other.organizationId,
      c.userId,
    ]);
    await expect(reconcile(c, absent)).rejects.toThrow("current irreversible");
    expect(observed).toBe(0);
    expect(await count("org_storage_objects", c.organizationId)).toBe(1);
  });
  test("lease expiring during provider observation cannot commit local cleanup", async () => {
    const c = await subject();
    await db.query(
      "UPDATE account_deletion_phase_receipts SET lease_expires_at=(clock_timestamp()+interval '1 second') AT TIME ZONE 'UTC' WHERE id=$1",
      [c.phaseReceiptId],
    );
    await expect(
      reconcile(c, async () => {
        await db.query("SELECT pg_sleep(1.1)");
        return true;
      }),
    ).rejects.toThrow("current irreversible");
    expect(await count("org_storage_objects", c.organizationId)).toBe(1);
  });
  test("provider errors preserve metadata and do not fabricate absence", async () => {
    const c = await subject();
    await expect(
      reconcile(c, async () => {
        throw new Error("provider unavailable");
      }),
    ).rejects.toThrow("provider unavailable");
    expect(await count("org_storage_objects", c.organizationId)).toBe(1);
  });
});
