/** Proves registration/consent serialization and deletion fences using independent PostgreSQL sessions; requires the hosted subscription PostgreSQL DSN. */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Client } from "pg";
import { installOrganizationPolicyTestSchema } from "./organization-policy-test-fixture";

const databaseUrl = process.env.SUBSCRIPTION_AUTHORITY_POSTGRES_URL;
const schemaName = `app_billing_${randomUUID().replaceAll("-", "")}`;
let setup: Client;
let accounts: import("./app-billing-accounts").AppBillingAccountsRepository;
let appsRepo: typeof import("./apps").appsRepository;
let close: typeof import("../client").closeDatabaseConnectionsForTests;
async function connection() {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  await client.query(`SET search_path TO ${schemaName}, public`);
  return client;
}
async function waiters(count: number) {
  for (let attempt = 0; attempt < 500; attempt++) {
    const result = await setup.query<{ pid: number }>(
      "SELECT pid FROM pg_stat_activity WHERE application_name=$1 AND wait_event_type='Lock' AND query ILIKE '%apps%for update%'",
      [schemaName],
    );
    if (result.rows.length >= count) return result.rows.map((row) => row.pid);
    await Bun.sleep(20);
  }
  throw new Error(`Expected ${count} independent app-row waiters`);
}
async function fixture() {
  const org = randomUUID(),
    buyerOrg = randomUUID(),
    owner = randomUUID(),
    buyer = randomUUID(),
    appId = randomUUID();
  await setup.query("INSERT INTO organizations(id) VALUES ($1),($2)", [org, buyerOrg]);
  await setup.query("INSERT INTO users(id,organization_id) VALUES ($1,$2),($3,$4)", [
    owner,
    org,
    buyer,
    buyerOrg,
  ]);
  await setup.query("INSERT INTO apps(id,organization_id,created_by_user_id) VALUES ($1,$2,$3)", [
    appId,
    org,
    owner,
  ]);
  return { org, buyerOrg, owner, buyer, appId };
}
function observe<T>(pending: Promise<T>) {
  return pending.then(
    (result) => ({ result }),
    (error: unknown) => ({ error }),
  );
}
describe.skipIf(!databaseUrl)("app billing PostgreSQL concurrency", () => {
  beforeAll(async () => {
    setup = new Client({ connectionString: databaseUrl });
    await setup.connect();
    await setup.query(`CREATE SCHEMA ${schemaName}`);
    await setup.query(`SET search_path TO ${schemaName}, public`);
    await setup.query(`CREATE TABLE organizations(id uuid PRIMARY KEY,is_active boolean NOT NULL DEFAULT true,account_lifecycle_state text DEFAULT 'active',paid_work_fenced_at timestamptz,account_deletion_request_id uuid);
      CREATE TABLE users(id uuid PRIMARY KEY,organization_id uuid NOT NULL REFERENCES organizations(id),is_active boolean DEFAULT true);
      CREATE TABLE apps(id uuid PRIMARY KEY,organization_id uuid NOT NULL REFERENCES organizations(id),created_by_user_id uuid NOT NULL REFERENCES users(id),is_active boolean DEFAULT true,is_approved boolean DEFAULT true,total_users integer DEFAULT 0);
      CREATE TABLE app_users(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),app_id uuid NOT NULL REFERENCES apps(id) ON DELETE CASCADE,user_id uuid NOT NULL REFERENCES users(id),signup_source text,referral_code_used text,ip_address text,user_agent text,total_requests integer DEFAULT 0,total_credits_used numeric DEFAULT 0,metadata jsonb DEFAULT '{}',first_seen_at timestamp DEFAULT now(),last_seen_at timestamp DEFAULT now(),UNIQUE(app_id,user_id));`);
    await installOrganizationPolicyTestSchema((query) => setup.query(query));
    const migration = await readFile(
      new URL("../migrations/0381_app_billing_registration.sql", import.meta.url),
      "utf8",
    );
    for (const statement of migration.split("--> statement-breakpoint"))
      if (statement.trim()) await setup.query(statement);
    const url = new URL(databaseUrl!);
    url.searchParams.set("options", `-c search_path=${schemaName},public`);
    url.searchParams.set("application_name", schemaName);
    process.env.DATABASE_URL = url.toString();
    process.env.TEST_DATABASE_URL = url.toString();
    process.env.LOCAL_PG_POOL_MAX = "4";
    ({ appBillingAccountsRepository: accounts } = await import("./app-billing-accounts"));
    ({ appsRepository: appsRepo } = await import("./apps"));
    ({ closeDatabaseConnectionsForTests: close } = await import("../client"));
  });
  afterAll(async () => {
    if (!setup) return;
    await close?.();
    await setup.query(`DROP SCHEMA ${schemaName} CASCADE`);
    await setup.end();
  });
  test("both registration/consent completion orders materialize exactly one buyer account", async () => {
    for (const order of ["registration", "consent"]) {
      const f = await fixture(),
        locker = await connection();
      const pending: Promise<unknown>[] = [];
      const registration = () =>
        observe(accounts.register(f.appId, "test", { userId: f.owner, credentialId: null }));
      const consent = () =>
        observe(appsRepo.connectUser({ appId: f.appId, userId: f.buyer, signupSource: "oauth" }));
      try {
        await locker.query("BEGIN");
        await locker.query("SELECT id FROM apps WHERE id=$1 FOR UPDATE", [f.appId]);
        const first = order === "registration" ? registration() : consent();
        pending.push(first);
        await waiters(1);
        const second = order === "registration" ? consent() : registration();
        pending.push(second);
        expect(new Set(await waiters(2)).size).toBe(2);
        await locker.query("COMMIT");
        expect(await first).toHaveProperty("result");
        expect(await second).toHaveProperty("result");
        expect(
          await accounts.read(f.appId, "test", { userId: f.buyer, credentialId: null }),
        ).toMatchObject({ state: "unconfigured", account: { kind: "individual" } });
        expect(
          (await setup.query("SELECT total_users FROM apps WHERE id=$1", [f.appId])).rows,
        ).toEqual([{ total_users: 1 }]);
        expect(
          (await setup.query("SELECT id FROM app_subscriber_accounts WHERE app_id=$1", [f.appId]))
            .rows,
        ).toHaveLength(1);
      } finally {
        await locker.query("ROLLBACK");
        await Promise.all(pending);
        await locker.end();
      }
    }
  }, 30_000);
  test("a registration waiting behind committed app deletion cannot resurrect billing identity", async () => {
    const f = await fixture(),
      locker = await connection();
    let pending: ReturnType<typeof observe> | undefined;
    try {
      await locker.query("BEGIN");
      await locker.query("SELECT id FROM apps WHERE id=$1 FOR UPDATE", [f.appId]);
      pending = observe(
        accounts.register(f.appId, "test", { userId: f.owner, credentialId: null }),
      );
      await waiters(1);
      await locker.query("DELETE FROM apps WHERE id=$1", [f.appId]);
      await locker.query("COMMIT");
      expect(await pending).toMatchObject({ error: { code: "APP_BILLING_ACCESS_DENIED" } });
      expect(
        (await setup.query("SELECT id FROM app_billing_registrations WHERE app_id=$1", [f.appId]))
          .rows,
      ).toEqual([]);
    } finally {
      await locker.query("ROLLBACK");
      if (pending) await pending;
      await locker.end();
    }
  }, 30_000);
});
