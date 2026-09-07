/** Exercises real registration, consent, primary credential fences and HTTP/SDK readback on PGlite; the HTTP harness supplies a previously authenticated session, not a live Steward login. */

import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Hono } from "hono";
import type { AppEnv } from "../../types/cloud-worker-env";
import { installOrganizationPolicyTestSchema } from "./organization-policy-test-fixture";

process.env.DATABASE_URL = "pglite://memory";
process.env.TEST_DATABASE_URL = "pglite://memory";
process.env.NODE_ENV = "test";
process.env.MOCK_REDIS = "1";
setDefaultTimeout(120_000);
let client: typeof import("../client");
let accounts: import("./app-billing-accounts").AppBillingAccountsRepository;
let appsRepo: typeof import("./apps").appsRepository;
let registrationRoute: Hono<AppEnv>;
let accountRoute: Hono<AppEnv>;
let sdk: typeof import("../../../../sdk/src/client");
let oldRows: Awaited<ReturnType<typeof historicalRows>>;
const historicalOrg = randomUUID();
const historicalUser = randomUUID();
const historicalSub = randomUUID();
const pg = () => client.getPgliteClientForTests();
async function migrate(name: string) {
  const source = await readFile(new URL(`../migrations/${name}`, import.meta.url), "utf8");
  for (const statement of source.split("--> statement-breakpoint"))
    if (statement.trim()) await pg().exec(statement);
}
async function historicalRows() {
  const records: Record<string, unknown> = {};
  for (const table of [
    "billing_subscriptions",
    "billing_subscription_revisions",
    "billing_subscription_commands",
    "subscription_allowance_periods",
    "credit_transactions",
  ]) {
    records[table] = (
      await pg().query(`SELECT row_to_json(t) AS value FROM ${table} t ORDER BY id`)
    ).rows;
  }
  records.cash = (
    await pg().query("SELECT credit_balance::text FROM organizations WHERE id=$1", [historicalOrg])
  ).rows;
  return records;
}
beforeAll(async () => {
  client = await import("../client");
  ({ appBillingAccountsRepository: accounts } = await import("./app-billing-accounts"));
  ({ appsRepository: appsRepo } = await import("./apps"));
  ({ default: registrationRoute } = await import(
    "../../../../api/v1/apps/[id]/billing/registration/route"
  ));
  ({ default: accountRoute } = await import("../../../../api/v1/apps/[id]/billing/account/route"));
  sdk = await import("../../../../sdk/src/client");
  await pg().exec(`
    CREATE TABLE organizations(id uuid PRIMARY KEY, is_active boolean NOT NULL DEFAULT true, account_lifecycle_state text NOT NULL DEFAULT 'active', account_lifecycle_revision bigint DEFAULT 1, account_deletion_request_id uuid, paid_work_fenced_at timestamptz, credit_balance numeric NOT NULL DEFAULT 0);
    CREATE TABLE users(id uuid PRIMARY KEY, organization_id uuid NOT NULL REFERENCES organizations(id), is_active boolean NOT NULL DEFAULT true);
    CREATE TABLE apps(id uuid PRIMARY KEY, organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE, created_by_user_id uuid NOT NULL REFERENCES users(id), is_active boolean NOT NULL DEFAULT true, is_approved boolean NOT NULL DEFAULT true, total_users integer NOT NULL DEFAULT 0, updated_at timestamp DEFAULT now());
    CREATE TABLE app_users(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), app_id uuid NOT NULL REFERENCES apps(id) ON DELETE CASCADE, user_id uuid NOT NULL REFERENCES users(id), signup_source text, referral_code_used text, total_requests integer DEFAULT 0, total_credits_used numeric DEFAULT 0, metadata jsonb DEFAULT '{}', ip_address text, user_agent text, first_seen_at timestamp DEFAULT now(), last_seen_at timestamp DEFAULT now(), UNIQUE(app_id,user_id));
    CREATE TABLE api_keys(id uuid PRIMARY KEY, name text NOT NULL DEFAULT 'test', description text, key_hash text NOT NULL UNIQUE, key_prefix text NOT NULL DEFAULT 'eliza_mobile_', key_ciphertext text, key_nonce text, key_auth_tag text, key_kms_key_id text, key_kms_key_version integer, organization_id uuid NOT NULL, user_id uuid NOT NULL, source_app_id uuid, rate_limit integer DEFAULT 1000, is_active boolean NOT NULL DEFAULT true, usage_count integer DEFAULT 0, expires_at timestamp, last_used_at timestamp, created_at timestamp DEFAULT now(), updated_at timestamp DEFAULT now(), deleted_at timestamp);
    CREATE TABLE credit_transactions(id uuid PRIMARY KEY, organization_id uuid NOT NULL REFERENCES organizations(id), amount numeric, CONSTRAINT credit_transactions_id_org_idx UNIQUE(id,organization_id));
  `);
  await installOrganizationPolicyTestSchema((query) => pg().exec(query));
  await pg().query("INSERT INTO organizations(id,credit_balance) VALUES ($1,37.5)", [
    historicalOrg,
  ]);
  await pg().query("INSERT INTO users(id,organization_id) VALUES ($1,$2)", [
    historicalUser,
    historicalOrg,
  ]);
  await pg().query(
    `INSERT INTO billing_subscriptions(id,organization_id,provider_environment,stripe_customer_id,stripe_subscription_id,stripe_subscription_item_id,plan_key,catalog_version,status,current_period_start,current_period_end,lifecycle_revision,provider_object_digest)
    VALUES ($1,$2,'test','cus_old','sub_old','si_old','plus_monthly','v1','active','2026-08-01Z','2026-09-01Z',1,$3)`,
    [historicalSub, historicalOrg, "a".repeat(64)],
  );
  await pg().query(
    `INSERT INTO billing_subscription_revisions(organization_id,subscription_id,revision,source,provider_environment,stripe_customer_id,stripe_subscription_id,stripe_subscription_item_id,plan_key,catalog_version,status,current_period_start,current_period_end,cancel_at_period_end,provider_object_digest)
    SELECT organization_id,id,1,'webhook',provider_environment,stripe_customer_id,stripe_subscription_id,stripe_subscription_item_id,plan_key,catalog_version,status,current_period_start,current_period_end,false,provider_object_digest FROM billing_subscriptions WHERE id=$1`,
    [historicalSub],
  );
  // Seed the historical command shape directly: this migration-preservation test
  // intentionally precedes later command-result columns and current writers.
  await pg().query(
    `INSERT INTO billing_subscription_commands(organization_id,subscription_id,requested_by_user_id,kind,expected_subscription_revision,idempotency_key,provider_idempotency_key,request_digest)
    VALUES($1,$2,$3,'cancel',1,'old.command.cancel','old.provider.cancel',$4)`,
    [historicalOrg, historicalSub, historicalUser, "b".repeat(64)],
  );
  await pg().query(
    `INSERT INTO subscription_allowance_periods(organization_id,subscription_id,subscription_revision,provider_environment,stripe_invoice_id,plan_key,catalog_version,period_start,period_end,expires_at,granted_amount,available_amount)
    VALUES ($1,$2,1,'test','in_old','plus_monthly','v1','2026-08-01Z','2026-09-01Z','2026-09-01Z',10,10)`,
    [historicalOrg, historicalSub],
  );
  await pg().query(
    "INSERT INTO credit_transactions(id,organization_id,amount) VALUES ($1,$2,37.5)",
    [randomUUID(), historicalOrg],
  );
  oldRows = await historicalRows();
  await migrate("0381_app_billing_registration.sql");
});
afterAll(async () => {
  await client.closeDatabaseConnectionsForTests();
});
async function fixture() {
  const ownerOrg = randomUUID(),
    buyerOrg = randomUUID(),
    owner = randomUUID(),
    buyer = randomUUID(),
    appId = randomUUID();
  await pg().query("INSERT INTO organizations(id) VALUES ($1),($2)", [ownerOrg, buyerOrg]);
  await pg().query("INSERT INTO users(id,organization_id) VALUES ($1,$2),($3,$4)", [
    owner,
    ownerOrg,
    buyer,
    buyerOrg,
  ]);
  await pg().query("INSERT INTO apps(id,organization_id,created_by_user_id) VALUES ($1,$2,$3)", [
    appId,
    ownerOrg,
    owner,
  ]);
  return { ownerOrg, buyerOrg, owner, buyer, appId };
}
const principal = (userId: string) => ({ userId, credentialId: null });
async function consent(f: Awaited<ReturnType<typeof fixture>>) {
  return appsRepo.connectUser({ appId: f.appId, userId: f.buyer, signupSource: "oauth" });
}
function http(f: Awaited<ReturnType<typeof fixture>>, userId: string) {
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("user", {
      id: userId,
      organization_id: userId === f.owner ? f.ownerOrg : f.buyerOrg,
      organization: { id: userId === f.owner ? f.ownerOrg : f.buyerOrg, is_active: true },
      is_active: true,
    });
    c.set("authMethod", "session");
    await next();
  });
  app.route("/api/v1/apps/:id/billing/registration", registrationRoute);
  app.route("/api/v1/apps/:id/billing/account", accountRoute);
  return app;
}
function transportFor(app: Hono<AppEnv>): typeof fetch {
  return Object.assign(
    async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) =>
      app.request(new Request(input, init), {}, { NODE_ENV: "test" }),
    { preconnect: fetch.preconnect },
  );
}
describe("unconfigured app billing authority", () => {
  test("migration preserves populated infrastructure subscription, command, invoice allowance and cash records", async () => {
    expect(await historicalRows()).toEqual(oldRows);
    expect((await pg().query("SELECT * FROM app_billing_registrations")).rows).toEqual([]);
    expect((await pg().query("SELECT * FROM app_subscriber_accounts")).rows).toEqual([]);
  });
  test("real owner HTTP/SDK registration, consent and buyer read do not require personal credit", async () => {
    const f = await fixture();
    const ownerHttp = http(f, f.owner);
    const buyerHttp = http(f, f.buyer);
    const ownerClient = new sdk.ElizaCloudClient({
      baseUrl: "https://test.invalid",
      bearerToken: "session.fixture",
      fetchImpl: transportFor(ownerHttp),
    });
    const result = await ownerClient.registerAppBilling(f.appId, "test");
    expect(result.data.merchant).toEqual({ state: "unconfigured" });
    expect(await consent(f)).toBe("created");
    const buyerClient = new sdk.ElizaCloudClient({
      baseUrl: "https://test.invalid",
      bearerToken: "session.fixture",
      fetchImpl: transportFor(buyerHttp),
    });
    const account = await buyerClient.getAppBillingAccount(f.appId, "test");
    expect(account.data).toMatchObject({
      state: "unconfigured",
      account: { kind: "individual" },
      subscription: { state: "unavailable" },
    });
    expect(
      (
        await pg().query(
          "SELECT owner_organization_id,infrastructure_payer_organization_id FROM app_billing_registrations WHERE app_id=$1",
          [f.appId],
        )
      ).rows,
    ).toEqual([
      { owner_organization_id: f.ownerOrg, infrastructure_payer_organization_id: f.ownerOrg },
    ]);
    expect(
      (await pg().query("SELECT credit_balance::text FROM organizations WHERE id=$1", [f.buyerOrg]))
        .rows,
    ).toEqual([{ credit_balance: "0" }]);
    expect(await historicalRows()).toEqual(oldRows);
  });
  test("analytics membership is denied until explicit connect upgrades consent", async () => {
    for (const registrationFirst of [true, false]) {
      const f = await fixture();
      if (registrationFirst) await accounts.register(f.appId, "test", principal(f.owner));
      await appsRepo.createAppUser({ app_id: f.appId, user_id: f.buyer });
      if (!registrationFirst) await accounts.register(f.appId, "test", principal(f.owner));
      const path = `https://test.invalid/api/v1/apps/${f.appId}/billing/account?environment=test`;
      expect((await http(f, f.buyer).request(path)).status).toBe(403);
      expect(
        (await pg().query("SELECT id FROM app_subscriber_accounts WHERE app_id=$1", [f.appId]))
          .rows,
      ).toHaveLength(0);
      await consent(f);
      expect((await http(f, f.buyer).request(path)).status).toBe(200);
      expect(
        (await pg().query("SELECT id FROM app_subscriber_accounts WHERE app_id=$1", [f.appId]))
          .rows,
      ).toHaveLength(1);
      expect(
        (await pg().query("SELECT total_users FROM apps WHERE id=$1", [f.appId])).rows,
      ).toEqual([{ total_users: 1 }]);
    }
  });
  test("either registration/consent order and concurrent duplicate approvals converge on one account and counter", async () => {
    for (const order of ["consent-first", "registration-first"]) {
      const f = await fixture();
      if (order === "consent-first") await consent(f);
      else await accounts.register(f.appId, "test", principal(f.owner));
      await Promise.all([
        accounts.register(f.appId, "test", principal(f.owner)),
        consent(f),
        consent(f),
      ]);
      const first = await accounts.read(f.appId, "test", principal(f.buyer));
      await consent(f);
      expect(await accounts.read(f.appId, "test", principal(f.buyer))).toEqual(first);
      expect(
        (await pg().query("SELECT total_users FROM apps WHERE id=$1", [f.appId])).rows,
      ).toEqual([{ total_users: 1 }]);
      expect(
        (await pg().query("SELECT id FROM app_subscriber_accounts WHERE app_id=$1", [f.appId]))
          .rows,
      ).toHaveLength(1);
    }
  });
  test("three apps, two environments and two buyers never share account identity", async () => {
    const ids = new Set<string>();
    for (let i = 0; i < 3; i++) {
      const f = await fixture();
      await consent(f);
      for (const env of ["test", "live"] as const) {
        await accounts.register(f.appId, env, principal(f.owner));
        const result = await accounts.read(f.appId, env, principal(f.buyer));
        if (result.state !== "unconfigured") throw new Error("Missing account");
        ids.add(result.account.id);
      }
      const another = await fixture();
      await appsRepo.connectUser({ appId: f.appId, userId: another.buyer, signupSource: "oauth" });
      const otherAccount = await accounts.read(f.appId, "test", principal(another.buyer));
      if (otherAccount.state !== "unconfigured") throw new Error("Missing second buyer account");
      expect(ids.has(otherAccount.account.id)).toBe(false);
      await expect(accounts.read(f.appId, "test", principal(f.owner))).rejects.toMatchObject({
        code: "APP_BILLING_ACCESS_DENIED",
      });
    }
    expect(ids.size).toBe(6);
  });
  test("unregistered, missing consent, suspended app and fenced buyer are distinct", async () => {
    const f = await fixture();
    await expect(accounts.read(f.appId, "test", principal(f.buyer))).rejects.toMatchObject({
      code: "APP_BILLING_ACCESS_DENIED",
    });
    await consent(f);
    expect(await accounts.read(f.appId, "test", principal(f.buyer))).toMatchObject({
      state: "unregistered",
    });
    await accounts.register(f.appId, "test", principal(f.owner));
    await pg().query("UPDATE organizations SET paid_work_fenced_at=now() WHERE id=$1", [
      f.buyerOrg,
    ]);
    await expect(accounts.read(f.appId, "test", principal(f.buyer))).rejects.toMatchObject({
      code: "APP_BILLING_ACCESS_DENIED",
    });
    await pg().query("UPDATE organizations SET paid_work_fenced_at=NULL WHERE id=$1", [f.buyerOrg]);
    await pg().query("UPDATE apps SET is_approved=false WHERE id=$1", [f.appId]);
    await expect(accounts.read(f.appId, "test", principal(f.buyer))).rejects.toMatchObject({
      code: "APP_BILLING_ACCESS_DENIED",
    });
  });
  test("owner HTTP boundary rejects another tenant, provider IDs, malformed JSON and ordinary API keys", async () => {
    const f = await fixture();
    const path = `https://test.invalid/api/v1/apps/${f.appId}/billing/registration`;
    const foreign = await http(f, f.buyer).request(
      path,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ environment: "test" }),
      },
      { NODE_ENV: "test" },
    );
    expect(foreign.status).toBe(403);
    for (const body of [
      JSON.stringify({ environment: "test", customerId: "cus_untrusted" }),
      "{",
    ]) {
      const response = await http(f, f.owner).request(
        path,
        { method: "POST", headers: { "Content-Type": "application/json" }, body },
        { NODE_ENV: "test" },
      );
      expect(response.status).toBe(400);
    }
    const keyResponse = await http(f, f.owner).request(
      path,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-API-Key": "eliza_general" },
        body: JSON.stringify({ environment: "test" }),
      },
      { NODE_ENV: "test" },
    );
    expect(keyResponse.status).toBe(401);
    expect(
      (await pg().query("SELECT id FROM app_billing_registrations WHERE app_id=$1", [f.appId]))
        .rows,
    ).toEqual([]);
  });
  test("source-app credential read validates current primary key and revocation", async () => {
    const f = await fixture();
    await accounts.register(f.appId, "test", principal(f.owner));
    await consent(f);
    const keyId = randomUUID(),
      secret = `eliza_mobile_${"d".repeat(64)}`;
    await pg().query(
      "INSERT INTO api_keys(id,key_hash,organization_id,user_id,source_app_id,expires_at) VALUES ($1,$2,$3,$4,$5,now()+interval '1 day')",
      [keyId, createHash("sha256").update(secret).digest("hex"), f.buyerOrg, f.buyer, f.appId],
    );
    const path = `https://test.invalid/api/v1/apps/${f.appId}/billing/account?environment=test`;
    const response = await http(f, f.buyer).request(
      path,
      { headers: { Authorization: `Bearer ${secret}` } },
      { NODE_ENV: "test" },
    );
    expect(response.status).toBe(200);
    for (const scheme of ["bearer", "bEaReR\t", "Bearer  "]) {
      const normalized = await http(f, f.buyer).request(
        path,
        { headers: { Authorization: `${scheme} ${secret}` } },
        { NODE_ENV: "test" },
      );
      expect(normalized.status).toBe(200);
    }
    await pg().query("UPDATE api_keys SET is_active=false,deleted_at=now() WHERE id=$1", [keyId]);
    const denied = await http(f, f.buyer).request(
      path,
      { headers: { Authorization: `Bearer ${secret}` } },
      { NODE_ENV: "test" },
    );
    expect(denied.status).toBe(401);
    await expect(
      accounts.read(f.appId, "test", { userId: f.buyer, credentialId: keyId }),
    ).rejects.toMatchObject({ code: "APP_BILLING_ACCESS_DENIED" });
  });
  test("HTTP read rejects expired, moved and cross-app credentials, revoked consent, and deleted apps", async () => {
    const f = await fixture();
    await accounts.register(f.appId, "test", principal(f.owner));
    await consent(f);
    const keyId = randomUUID(),
      secret = `eliza_mobile_${"e".repeat(64)}`;
    await pg().query(
      "INSERT INTO api_keys(id,key_hash,organization_id,user_id,source_app_id,expires_at) VALUES ($1,$2,$3,$4,$5,now()+interval '1 day')",
      [keyId, createHash("sha256").update(secret).digest("hex"), f.buyerOrg, f.buyer, f.appId],
    );
    const path = `https://test.invalid/api/v1/apps/${f.appId}/billing/account?environment=test`;
    const read = () =>
      http(f, f.buyer).request(
        path,
        { headers: { Authorization: `Bearer ${secret}` } },
        { NODE_ENV: "test" },
      );
    expect((await read()).status).toBe(200);
    const other = await fixture();
    const cross = await http(f, f.buyer).request(
      `https://test.invalid/api/v1/apps/${other.appId}/billing/account?environment=test`,
      { headers: { Authorization: `Bearer ${secret}` } },
      { NODE_ENV: "test" },
    );
    expect(cross.status).toBe(403);
    await pg().query("UPDATE users SET organization_id=$1 WHERE id=$2", [other.buyerOrg, f.buyer]);
    expect((await read()).status).toBe(403);
    await pg().query("UPDATE users SET organization_id=$1 WHERE id=$2", [f.buyerOrg, f.buyer]);
    await pg().query("UPDATE apps SET is_active=false WHERE id=$1", [f.appId]);
    expect((await read()).status).toBe(403);
    await pg().query("UPDATE apps SET is_active=true WHERE id=$1", [f.appId]);
    await pg().query("DELETE FROM app_users WHERE app_id=$1 AND user_id=$2", [f.appId, f.buyer]);
    expect((await read()).status).toBe(403);
    await consent(f);
    expect((await read()).status).toBe(200);
    await pg().query("DELETE FROM apps WHERE id=$1", [f.appId]);
    expect((await read()).status).toBe(403);
    expect(
      (await pg().query("SELECT id FROM app_billing_registrations WHERE app_id=$1", [f.appId]))
        .rows,
    ).toEqual([]);
    expect(
      (await pg().query("SELECT id FROM app_subscriber_accounts WHERE app_id=$1", [f.appId])).rows,
    ).toEqual([]);
    await pg().query("UPDATE api_keys SET expires_at=now()-interval '1 minute' WHERE id=$1", [
      keyId,
    ]);
    expect((await read()).status).toBe(401);
  });

  test("materialization failure rolls back registration and separately rolls back consent and its counter", async () => {
    const f = await fixture();
    await consent(f);
    await pg().exec(`CREATE FUNCTION reject_test_billing_account() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected account insert failure'; END $$;
      CREATE TRIGGER reject_test_billing_account BEFORE INSERT ON app_subscriber_accounts FOR EACH ROW EXECUTE FUNCTION reject_test_billing_account();`);
    try {
      await expect(accounts.register(f.appId, "test", principal(f.owner))).rejects.toThrow();
      expect(
        (await pg().query("SELECT id FROM app_billing_registrations WHERE app_id=$1", [f.appId]))
          .rows,
      ).toEqual([]);
      const next = await fixture();
      await accounts.register(next.appId, "test", principal(next.owner));
      await expect(consent(next)).rejects.toThrow();
      expect(
        (await pg().query("SELECT id FROM app_users WHERE app_id=$1", [next.appId])).rows,
      ).toEqual([]);
      expect(
        (await pg().query("SELECT total_users FROM apps WHERE id=$1", [next.appId])).rows,
      ).toEqual([{ total_users: 0 }]);
    } finally {
      await pg().exec(
        "DROP TRIGGER reject_test_billing_account ON app_subscriber_accounts; DROP FUNCTION reject_test_billing_account()",
      );
    }
  });

  test("database rejects forged payer, cross-app consent and identity rewrites", async () => {
    const f = await fixture(),
      other = await fixture();
    await accounts.register(f.appId, "test", principal(f.owner));
    await consent(f);
    await expect(
      pg().query(
        "UPDATE app_billing_registrations SET infrastructure_payer_organization_id=$1 WHERE app_id=$2",
        [f.buyerOrg, f.appId],
      ),
    ).rejects.toThrow();
    await expect(
      pg().query(
        "INSERT INTO app_billing_registrations(app_id,owner_organization_id,infrastructure_payer_organization_id,registered_by_user_id,provider_environment) VALUES ($1,$2,$2,$3,'test')",
        [other.appId, f.ownerOrg, f.owner],
      ),
    ).rejects.toThrow();
    await expect(
      pg().query("UPDATE app_subscriber_accounts SET subscriber_user_id=$1 WHERE app_id=$2", [
        other.buyer,
        f.appId,
      ]),
    ).rejects.toThrow();
    await pg().query("DELETE FROM app_users WHERE app_id=$1 AND user_id=$2", [f.appId, f.buyer]);
    await expect(accounts.read(f.appId, "test", principal(f.buyer))).rejects.toMatchObject({
      code: "APP_BILLING_ACCESS_DENIED",
    });
    expect(
      (await pg().query("SELECT id FROM app_subscriber_accounts WHERE app_id=$1", [f.appId])).rows,
    ).toEqual([]);
  });
});
