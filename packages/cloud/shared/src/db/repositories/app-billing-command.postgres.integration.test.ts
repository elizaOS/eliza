/** Proves command migration, immutable intent, and financial/quote races with independent PostgreSQL sessions. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Client } from "pg";

const databaseUrl = process.env.APP_BILLING_TEST_POSTGRES_URL;
const schema = `app_commands_${randomUUID().replaceAll("-", "_")}`;
const ids = {
  org: randomUUID(),
  user: randomUUID(),
  app: randomUUID(),
  merchant: randomUUID(),
  registration: randomUUID(),
  account: randomUUID(),
  scope: randomUUID(),
  plan: randomUUID(),
  subscription: randomUUID(),
  priorCommand: randomUUID(),
};
const digest = "a".repeat(64);
let db: Client;
async function connect() {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  await client.query(`SET search_path TO ${schema},public`);
  return client;
}
async function migrate(tags: string[]) {
  for (const tag of tags) {
    const contents = await readFile(new URL(`../migrations/${tag}.sql`, import.meta.url), "utf8");
    for (const statement of contents.split("--> statement-breakpoint"))
      if (statement.trim()) await db.query(statement.replaceAll('"public".', ""));
  }
}
async function insertAdmin(
  client: Client,
  key: string,
  overrides: { mode?: boolean; registrationId?: string } = {},
) {
  return client.query(
    `INSERT INTO billing_subscription_commands(app_id,livemode,client_registration_id,organization_id,requested_by_user_id,kind,idempotency_key,provider_idempotency_key,request_digest,request_payload) VALUES ($1,$2,$3,$4,$5,'merchant_create',$6,$7,$8,$9) RETURNING id`,
    [
      ids.app,
      overrides.mode ?? false,
      overrides.registrationId ?? ids.registration,
      ids.org,
      ids.user,
      key,
      `provider:${key}`,
      digest,
      {
        version: 1,
        domain: "admin",
        clientRegistrationId: overrides.registrationId ?? ids.registration,
        action: "merchant_create",
        country: "US",
      },
    ],
  );
}
async function insertUpdate(client: Client, quoteId: string, key: string) {
  return client.query(
    `INSERT INTO billing_subscription_commands(app_id,livemode,merchant_id,billing_scope_id,organization_id,requested_by_user_id,subscription_id,expected_subscription_revision,kind,target_plan_key,target_plan_revision_id,target_quantity,idempotency_key,provider_idempotency_key,request_digest,request_payload) VALUES ($1,false,$2,$3,$4,$5,$6,1,'upgrade','basic',$7,2,$8,$9,$10,$11) RETURNING id`,
    [
      ids.app,
      ids.merchant,
      ids.scope,
      ids.org,
      ids.user,
      ids.subscription,
      ids.plan,
      key,
      `provider:${key}`,
      digest,
      {
        version: 1,
        domain: "buyer",
        action: "update",
        planRevisionId: ids.plan,
        quantity: 2,
        quoteId,
        billingConsent: "accepted",
      },
    ],
  );
}
async function quote(expires = "clock_timestamp() + interval '10 minutes'") {
  const result = await db.query(
    `INSERT INTO app_billing_quotes(app_id,billing_scope_id,actor_user_id,subscription_id,subscription_revision,plan_revision_id,quantity,merchant_id,livemode,provider_preview,digest,expires_at) VALUES($1,$2,$3,$4,1,$5,2,$6,false,$7,$8,${expires}) RETURNING id`,
    [
      ids.app,
      ids.scope,
      ids.user,
      ids.subscription,
      ids.plan,
      ids.merchant,
      {
        requestDigest: digest,
        subscriptionDigest: digest,
        prorationDate: 1,
        trialEnd: null,
        dueNowCents: 1000,
        nextInvoice: {
          currency: "usd",
          amountDueCents: 1000,
          subtotalCents: 1000,
          totalCents: 1000,
          taxCents: 0,
          discountCents: 0,
          prorationCents: 1000,
          lines: [],
        },
        recurringInvoice: null,
        recurringBasis: "long_term",
      },
      digest,
    ],
  );
  return String(result.rows[0].id);
}

describe.skipIf(!databaseUrl)("app billing command authority PostgreSQL", () => {
  beforeAll(async () => {
    db = new Client({ connectionString: databaseUrl });
    await db.connect();
    await db.query("CREATE EXTENSION IF NOT EXISTS btree_gist WITH SCHEMA public");
    await db.query(`CREATE SCHEMA ${schema}`);
    await db.query(`SET search_path TO ${schema},public`);
    await db.query(
      `CREATE TABLE organizations(id uuid PRIMARY KEY,is_active boolean NOT NULL DEFAULT true,account_lifecycle_state text NOT NULL DEFAULT 'active',paid_work_fenced_at timestamptz,credit_balance numeric NOT NULL DEFAULT 42); CREATE TABLE users(id uuid PRIMARY KEY); CREATE TABLE apps(id uuid PRIMARY KEY,organization_id uuid NOT NULL REFERENCES organizations(id),is_active boolean NOT NULL DEFAULT true,is_approved boolean NOT NULL DEFAULT true,review_status text NOT NULL DEFAULT 'approved'); CREATE TABLE credit_transactions(id uuid PRIMARY KEY,organization_id uuid NOT NULL REFERENCES organizations(id),CONSTRAINT credit_transactions_id_org_idx UNIQUE(id,organization_id));`,
    );
    await migrate([
      "0373_subscription_authority",
      "0374_subscription_funding_transaction_uniqueness",
      "0379_subscription_account_authority",
      "0380_app_billing_catalog",
      "0381_app_billing_scope_records",
      "0382_app_billing_registration_constraints",
      "0383_subscription_app_scope_columns",
      "0384_subscription_app_scope_constraints",
      "0385_subscription_app_scope_guards",
      "0386_subscription_app_source_guards",
      "0387_app_delegations",
      "0417_app_billing_return_destination",
    ]);
    await db.query("INSERT INTO organizations(id) VALUES($1)", [ids.org]);
    await db.query("INSERT INTO users(id) VALUES($1)", [ids.user]);
    await db.query("INSERT INTO apps(id,organization_id) VALUES($1,$2)", [ids.app, ids.org]);
    await db.query(
      "INSERT INTO billing_merchants(id,organization_id,provider_account_key,livemode,enabled) VALUES($1,$2,'platform',false,true)",
      [ids.merchant, ids.org],
    );
    await db.query(
      "INSERT INTO app_client_registrations(id,app_id,owner_organization_id,billing_environment,secret_hashes,redirect_uris,allowed_scopes) VALUES($1,$2,$3,'test','[]','[]','[]')",
      [ids.registration, ids.app, ids.org],
    );
    await db.query(
      "INSERT INTO app_billing_accounts(id,app_id,display_name,external_account_key,eligibility_principal_id) VALUES($1,$2,'Buyer','buyer-account',$3)",
      [ids.account, ids.app, ids.user],
    );
    await db.query(
      "INSERT INTO app_billing_plan_revisions(id,app_id,merchant_id,product_family_key,plan_key,revision,name,amount_cents,currency,interval,maximum_quantity,expired_access,entitlements,stripe_price_id,stripe_product_id,published_at) VALUES($1,$2,$3,'main','basic',1,'Basic',3000,'usd','month',10,'read_only','{}','price_basic','prod_basic',now())",
      [ids.plan, ids.app, ids.merchant],
    );
    await db.query(
      "INSERT INTO app_billing_scopes(id,app_id,organization_id,billing_account_id,merchant_id,livemode,product_family_key) VALUES($1,$2,$3,$4,$5,false,'main')",
      [ids.scope, ids.app, ids.org, ids.account, ids.merchant],
    );
    await db.query(
      "INSERT INTO billing_subscription_commands(id,billing_scope_id,organization_id,requested_by_user_id,kind,target_plan_key,target_plan_revision_id,idempotency_key,provider_idempotency_key,request_digest,status,execution_generation,provider_started_at) VALUES($1,$2,$3,$4,'checkout','basic',$5,'prior-command','provider-prior-command',$6,'OUTCOME_UNKNOWN',1,now())",
      [ids.priorCommand, ids.scope, ids.org, ids.user, ids.plan, digest],
    );
    await db.query(
      "INSERT INTO app_billing_customers(billing_account_id,merchant_id,stripe_customer_id,command_id) VALUES($1,$2,'cus_buyer',$3)",
      [ids.account, ids.merchant, ids.priorCommand],
    );
    await db.query(
      "INSERT INTO billing_subscriptions(id,billing_scope_id,organization_id,provider_environment,stripe_customer_id,stripe_subscription_id,stripe_subscription_item_id,plan_key,plan_revision_id,catalog_version,status,current_period_start,current_period_end,lifecycle_revision,provider_object_digest) VALUES($1,$2,$3,'test','cus_buyer','sub_buyer','si_buyer','basic',$4,'app-v1','active',now(),now()+interval '1 month',1,$5)",
      [ids.subscription, ids.scope, ids.org, ids.plan, digest],
    );
    await db.query(
      "UPDATE billing_subscription_commands SET status='FAILED',error_code='controlled-test-abandonment',completed_at=now() WHERE id=$1",
      [ids.priorCommand],
    );
    await migrate([
      "0390_app_billing_command_intents",
      "0391_app_billing_command_guards",
      "0392_app_billing_update_quotes",
      "0394_app_billing_merchant_identity",
      "0400_app_billing_membership_authority",
      "0414_app_billing_administrators",
      "0418_billing_identity_anchors",
      "0419_billing_identity_backfill",
      "0420_billing_identity_references",
    ]);
  });
  afterAll(async () => {
    if (db) {
      await db.query(`DROP SCHEMA ${schema} CASCADE`);
      await db.end();
    }
  });
  test("backfills only scoped commands and preserves infrastructure balance", async () => {
    expect(
      (
        await db.query(
          "SELECT app_id,merchant_id,livemode,request_payload FROM billing_subscription_commands WHERE id=$1",
          [ids.priorCommand],
        )
      ).rows,
    ).toEqual([
      { app_id: ids.app, merchant_id: ids.merchant, livemode: false, request_payload: null },
    ]);
    expect(
      (await db.query("SELECT credit_balance::text FROM organizations WHERE id=$1", [ids.org]))
        .rows,
    ).toEqual([{ credit_balance: "42" }]);
  });
  test("binds the platform account once and increments connection revision without changing provider identity", async () => {
    await db.query("UPDATE billing_merchants SET stripe_account_id='acct_platform' WHERE id=$1", [
      ids.merchant,
    ]);
    expect(
      (
        await db.query(
          "SELECT connection_revision::text,stripe_account_id,provider_account_key FROM billing_merchants WHERE id=$1",
          [ids.merchant],
        )
      ).rows,
    ).toEqual([
      {
        connection_revision: "2",
        stripe_account_id: "acct_platform",
        provider_account_key: "platform",
      },
    ]);
    await expect(
      db.query("UPDATE billing_merchants SET stripe_account_id='acct_other' WHERE id=$1", [
        ids.merchant,
      ]),
    ).rejects.toThrow("identity is immutable");
    await db.query(
      "UPDATE billing_merchants SET enabled=false,disconnected_at=clock_timestamp() WHERE id=$1",
      [ids.merchant],
    );
    expect(
      (
        await db.query("SELECT connection_revision::text FROM billing_merchants WHERE id=$1", [
          ids.merchant,
        ])
      ).rows,
    ).toEqual([{ connection_revision: "3" }]);
    await expect(
      db.query("UPDATE billing_merchants SET enabled=true WHERE id=$1", [ids.merchant]),
    ).rejects.toThrow();
    await db.query("UPDATE billing_merchants SET enabled=true,disconnected_at=NULL WHERE id=$1", [
      ids.merchant,
    ]);
  });
  test("admin and legacy checkout idempotency cannot alias", async () => {
    const key = randomUUID();
    await insertAdmin(db, key);
    await db.query(
      "INSERT INTO billing_subscription_commands(organization_id,requested_by_user_id,kind,target_plan_key,idempotency_key,provider_idempotency_key,request_digest) VALUES($1,$2,'checkout','plus_monthly',$3,$4,$5)",
      [ids.org, ids.user, key, `legacy:${key}`, digest],
    );
    const result = await db.query(
      "SELECT count(*)::int AS count FROM billing_subscription_commands WHERE idempotency_key=$1",
      [key],
    );
    expect(result.rows).toEqual([{ count: 2 }]);
    expect(
      (
        await db.query(
          "SELECT count(*)::int AS count FROM billing_subscription_commands WHERE billing_scope_id IS NULL AND app_id IS NULL AND idempotency_key=$1",
          [key],
        )
      ).rows,
    ).toEqual([{ count: 1 }]);
  });
  test("rejects another environment registration and missing or changed intent", async () => {
    await expect(insertAdmin(db, randomUUID(), { mode: true })).rejects.toThrow(
      "registration mismatch",
    );
    const result = await insertAdmin(db, randomUUID());
    const id = result.rows[0].id;
    await expect(
      db.query(
        "UPDATE billing_subscription_commands SET request_payload=jsonb_set(request_payload,'{country}','\"CA\"') WHERE id=$1",
        [id],
      ),
    ).rejects.toThrow("immutable");
    await expect(
      db.query(
        "INSERT INTO billing_subscription_commands(app_id,livemode,client_registration_id,organization_id,requested_by_user_id,kind,idempotency_key,provider_idempotency_key,request_digest) VALUES($1,false,$2,$3,$4,'merchant_create',$5,$6,$7)",
        [ids.app, ids.registration, ids.org, ids.user, randomUUID(), randomUUID(), digest],
      ),
    ).rejects.toThrow("complete durable intent");
  });
  test("allows recoverable provider action only after success and then refuses overwrite", async () => {
    const result = await insertAdmin(db, randomUUID());
    const id = result.rows[0].id;
    await expect(
      db.query("UPDATE billing_subscription_commands SET provider_result=$2 WHERE id=$1", [
        id,
        { kind: "merchant", merchantId: ids.merchant },
      ]),
    ).rejects.toThrow();
    await db.query(
      "UPDATE billing_subscription_commands SET status='OUTCOME_UNKNOWN',execution_generation=1,provider_started_at=now() WHERE id=$1",
      [id],
    );
    await db.query(
      "UPDATE billing_subscription_commands SET status='SUCCEEDED',completed_at=now(),provider_response_digest=$2,provider_result=$3 WHERE id=$1",
      [id, digest, { kind: "merchant", merchantId: ids.merchant }],
    );
    await expect(
      db.query("UPDATE billing_subscription_commands SET provider_result=$2 WHERE id=$1", [
        id,
        { kind: "merchant", merchantId: randomUUID() },
      ]),
    ).rejects.toThrow("immutable");
  });
  test("records ambiguous progress and learns completion without changing provider handles", async () => {
    const id = randomUUID();
    await db.query(
      "INSERT INTO billing_subscription_commands(id,app_id,livemode,merchant_id,billing_scope_id,organization_id,requested_by_user_id,kind,idempotency_key,provider_idempotency_key,request_digest,request_payload) VALUES($1,$2,false,$3,$4,$5,$6,'portal',$7,$8,$9,$10)",
      [
        id,
        ids.app,
        ids.merchant,
        ids.scope,
        ids.org,
        ids.user,
        randomUUID(),
        randomUUID(),
        digest,
        { version: 1, domain: "buyer", action: "portal", returnUrl: "https://app.example/billing" },
      ],
    );
    await db.query(
      "UPDATE billing_subscription_commands SET status='OUTCOME_UNKNOWN',execution_generation=1,provider_started_at=now(),provider_result=$2 WHERE id=$1",
      [id, { kind: "completed", subscriptionId: null, subscriptionRevision: null }],
    );
    await db.query(
      "UPDATE billing_subscription_commands SET status='SUCCEEDED',completed_at=now(),provider_response_digest=$2,provider_result=$3 WHERE id=$1",
      [id, digest, { kind: "completed", subscriptionId: "sub_buyer", subscriptionRevision: 1 }],
    );
    await expect(
      db.query("UPDATE billing_subscription_commands SET provider_result=$2 WHERE id=$1", [
        id,
        { kind: "completed", subscriptionId: "sub_other", subscriptionRevision: 1 },
      ]),
    ).rejects.toThrow("handles are immutable");
    await expect(
      db.query("UPDATE billing_subscription_commands SET provider_result=$2 WHERE id=$1", [
        id,
        { kind: "completed", subscriptionId: "sub_buyer", subscriptionRevision: null },
      ]),
    ).rejects.toThrow("handles are immutable");
  });
  test("admits one active paid update across independent sessions and consumes its exact quote once", async () => {
    const q = await quote();
    const first = await connect();
    const second = await connect();
    try {
      const results = await Promise.allSettled([
        insertUpdate(first, q, randomUUID()),
        insertUpdate(second, q, randomUUID()),
      ]);
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
      const winner = results.find((r) => r.status === "fulfilled");
      if (!winner || winner.status !== "fulfilled") throw new Error("Missing admitted command");
      const command = winner.value.rows[0].id;
      await db.query(
        "UPDATE app_billing_quotes SET consumed_by_command_id=$2,consumed_at=clock_timestamp() WHERE id=$1",
        [q, command],
      );
      await expect(
        db.query(
          "UPDATE app_billing_quotes SET consumed_by_command_id=NULL,consumed_at=NULL WHERE id=$1",
          [q],
        ),
      ).rejects.toThrow("already consumed");
      await expect(
        db.query("UPDATE app_billing_quotes SET quantity=3 WHERE id=$1", [q]),
      ).rejects.toThrow("immutable");
      await db.query(
        "UPDATE billing_subscription_commands SET status='SUPERSEDED',error_code='test-finished',completed_at=now() WHERE id=$1",
        [command],
      );
    } finally {
      await first.end();
      await second.end();
    }
  });
  test("expired quotes cannot be consumed even when a matching command exists", async () => {
    const q = await quote("clock_timestamp() + interval '80 milliseconds'");
    const result = await insertUpdate(db, q, randomUUID());
    await db.query("SELECT pg_sleep(0.1)");
    await expect(
      db.query(
        "UPDATE app_billing_quotes SET consumed_by_command_id=$2,consumed_at=clock_timestamp() WHERE id=$1",
        [q, result.rows[0].id],
      ),
    ).rejects.toThrow("exact unexpired command");
  });
});
