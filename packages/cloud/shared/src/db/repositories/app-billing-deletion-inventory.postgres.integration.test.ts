/** Exercises the production deletion inventory query against real PostgreSQL with deterministic owner, command and deletion-history fixtures. Discovery does not confer mutation authority. */
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { Client } from "pg";

setDefaultTimeout(120_000);
const postgresUrl = process.env.APP_BILLING_TEST_POSTGRES_URL;
const schema = `deletion_inventory_${randomUUID().replaceAll("-", "_")}`;
if (postgresUrl) {
  const url = new URL(postgresUrl);
  url.searchParams.set("options", `-c search_path=${schema},pg_catalog,public`);
  process.env.DATABASE_URL = url.toString();
  process.env.TEST_DATABASE_URL = url.toString();
}
let db: Client;
let inventory: typeof import("./app-billing-deletion-inventory").readAppBillingDeletionObligations;
let close: typeof import("../client").closeDatabaseConnectionsForTests;

async function fixture() {
  const owner = randomUUID(),
    userId = randomUUID(),
    organizationId = randomUUID(),
    app = randomUUID(),
    account = randomUUID(),
    merchant = randomUUID(),
    scope = randomUUID(),
    requestId = randomUUID();
  await db.query("INSERT INTO users VALUES($1,true,NULL,'active',NULL,NULL)", [userId]);
  await db.query("INSERT INTO app_billing_accounts VALUES($1,$2,$3)", [account, app, randomUUID()]);
  await db.query("INSERT INTO billing_merchants VALUES($1,$2,'acct_fixture',false)", [
    merchant,
    owner,
  ]);
  await db.query("INSERT INTO app_billing_scopes VALUES($1,$2,$3,$4,$5,false)", [
    scope,
    app,
    account,
    owner,
    merchant,
  ]);
  await db.query("INSERT INTO app_billing_members VALUES($1,$2,$3,'administrator',false,now())", [
    account,
    app,
    userId,
  ]);
  await db.query("INSERT INTO account_deletion_requests VALUES($1,$2,$3,'processing',now(),$4,1)", [
    requestId,
    userId,
    organizationId,
    "a".repeat(64),
  ]);
  return { owner, userId, organizationId, app, account, merchant, scope, requestId };
}
async function command(
  f: Awaited<ReturnType<typeof fixture>>,
  payload: Record<string, unknown>,
  actor = f.userId,
) {
  await db.query("INSERT INTO billing_subscription_commands VALUES($1,$2,$3,$4,false,$5,$6)", [
    f.scope,
    f.app,
    f.owner,
    f.merchant,
    actor,
    JSON.stringify(payload),
  ]);
}
describe.skipIf(!postgresUrl)("historical app billing deletion inventory", () => {
  beforeAll(async () => {
    db = new Client({ connectionString: postgresUrl });
    await db.connect();
    await db.query(`CREATE SCHEMA ${schema}`);
    await db.query(`SET search_path TO ${schema},pg_catalog,public`);
    // Same external owner shapes used by the billing PostgreSQL fixtures; only query-relevant columns are needed here.
    await db.query(`
      CREATE TABLE users(id uuid PRIMARY KEY,is_active boolean,deleted_at timestamptz,account_lifecycle_state text,auth_fenced_at timestamptz,expires_at timestamp);
      CREATE TABLE app_billing_accounts(id uuid PRIMARY KEY,app_id uuid,eligibility_principal_id uuid);
      CREATE TABLE app_billing_scopes(id uuid PRIMARY KEY,app_id uuid,billing_account_id uuid,organization_id uuid,merchant_id uuid,livemode boolean);
      CREATE TABLE billing_merchants(id uuid PRIMARY KEY,organization_id uuid,provider_account_key text,livemode boolean);
      CREATE TABLE app_billing_customers(billing_account_id uuid,merchant_id uuid,stripe_customer_id text);
      CREATE TABLE app_billing_members(billing_account_id uuid,app_id uuid,user_id uuid,role text,livemode boolean,revoked_at timestamptz);
      CREATE TABLE billing_identity_subjects(live_user_id uuid,eligibility_principal_id uuid);
      CREATE TABLE billing_subscription_commands(billing_scope_id uuid,app_id uuid,organization_id uuid,merchant_id uuid,livemode boolean,requested_by_user_id uuid,request_payload jsonb);
      CREATE TABLE account_deletion_requests(id uuid,user_id uuid,organization_id uuid,status text,irreversible_at timestamptz,request_digest text,lifecycle_revision bigint);
      CREATE TABLE app_billing_deletion_dispositions(request_id uuid,scope_id uuid,request_digest text,lifecycle_revision bigint,merchant_id uuid,livemode boolean);
    `);
    inventory = (await import("./app-billing-deletion-inventory"))
      .readAppBillingDeletionObligations;
    close = (await import("../client")).closeDatabaseConnectionsForTests;
  });
  afterAll(async () => {
    if (close) await close();
    if (db) {
      await db.query(`DROP SCHEMA ${schema} CASCADE`);
      await db.end();
    }
  });
  test("original purchaser commands recover scopes after membership revocation without becoming developer-owned", async () => {
    const f = await fixture();
    expect(await inventory(f)).toEqual([]);
    await command(f, { domain: "buyer", action: "checkout" });
    expect(await inventory(f)).toMatchObject([
      {
        scopeId: f.scope,
        departingAdministrator: false,
        disposition: "purchaser_without_successor",
      },
    ]);
    expect(await inventory({ ...f, userId: randomUUID() })).toEqual([]);
    expect(await inventory({ ...f, organizationId: f.owner })).toMatchObject([
      { scopeId: f.scope, disposition: "developer_owned" },
    ]);
    const survivor = randomUUID();
    await db.query("INSERT INTO users VALUES($1,true,NULL,'active',NULL,NULL)", [survivor]);
    await db.query("INSERT INTO app_billing_members VALUES($1,$2,$3,'administrator',false,NULL)", [
      f.account,
      f.app,
      survivor,
    ]);
    expect(await inventory(f)).toMatchObject([
      { scopeId: f.scope, departingAdministrator: false, disposition: "shared_purchaser" },
    ]);
  });
  test("canonical request dispositions recover otherwise undiscoverable scopes and reject another subject or request", async () => {
    const f = await fixture();
    await db.query("INSERT INTO app_billing_deletion_dispositions VALUES($1,$2,$3,1,$4,false)", [
      f.requestId,
      f.scope,
      "a".repeat(64),
      f.merchant,
    ]);
    expect(await inventory({ userId: f.userId, organizationId: f.organizationId })).toEqual([]);
    expect(await inventory(f)).toMatchObject([
      { scopeId: f.scope, disposition: "purchaser_without_successor" },
    ]);
    expect(await inventory({ ...f, requestId: randomUUID() })).toEqual([]);
    expect(await inventory({ ...f, userId: randomUUID() })).toEqual([]);
    expect(await inventory({ ...f, organizationId: randomUUID() })).toEqual([]);
    await db.query("UPDATE account_deletion_requests SET lifecycle_revision=2 WHERE id=$1", [
      f.requestId,
    ]);
    expect(await inventory(f)).toEqual([]);
  });
  test("cleanup journal discovery requires the exact canonical request and remains purchaser-scoped", async () => {
    const f = await fixture();
    await command(f, {
      domain: "account_deletion",
      action: "cancel",
      requestId: f.requestId,
      requestDigest: "a".repeat(64),
      lifecycleRevision: 1,
    });
    expect(await inventory({ userId: f.userId, organizationId: f.organizationId })).toEqual([]);
    expect(await inventory(f)).toMatchObject([
      { scopeId: f.scope, disposition: "purchaser_without_successor" },
    ]);
    expect(await inventory({ ...f, requestId: randomUUID() })).toEqual([]);
    expect(await inventory({ ...f, userId: randomUUID() })).toEqual([]);
    await db.query("UPDATE account_deletion_requests SET status='completed' WHERE id=$1", [
      f.requestId,
    ]);
    expect(await inventory(f)).toEqual([]);
  });
});
