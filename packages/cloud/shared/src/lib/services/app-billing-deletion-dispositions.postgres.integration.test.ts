/** Exercises canonical deletion decisions, scope fences and concurrent administrator authority against real PostgreSQL migrations. Subscription preservation uses the real billing runtime and Stripe SDK with controlled HTTP. */
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Client } from "pg";
import type { BuyerBillingIdentity, GenericBillingRuntime } from "./generic-billing-runtime";
import { createRuntimeStripeFixture } from "./generic-billing-runtime.stripe-fixture";

const postgresUrl = process.env.APP_BILLING_TEST_POSTGRES_URL;
const schema = `app_deletion_disposition_${randomUUID().replaceAll("-", "_")}`;
if (postgresUrl) {
  const repositoryUrl = new URL(postgresUrl);
  repositoryUrl.searchParams.set("options", `-c search_path=${schema},public`);
  process.env.DATABASE_URL = repositoryUrl.toString();
  process.env.TEST_DATABASE_URL = repositoryUrl.toString();
}
process.env.LOCAL_PG_POOL_MAX = "4";
process.env.NODE_ENV ||= "test";
process.env.APP_BILLING_UI_ORIGIN = "https://cloud.example.test";
setDefaultTimeout(120_000);
let db: Client;
let close: typeof import("../../db/client").closeDatabaseConnectionsForTests;
let authority: typeof import("../../db/repositories/app-subscription-authority").appSubscriptionAuthorityRepository;
let queries: typeof import("../../db/repositories/app-billing-queries").appBillingQueries;
let runtime: GenericBillingRuntime;
const fixture = createRuntimeStripeFixture();
const org = randomUUID();
const merchant = randomUUID();

async function buyer(eligibilityPrincipalId?: string): Promise<{
  identity: BuyerBillingIdentity;
  scopeId: string;
  planId: string;
}> {
  const appId = randomUUID();
  const actorUserId = randomUUID();
  const planId = randomUUID();
  await db.query("INSERT INTO users(id) VALUES($1)", [actorUserId]);
  if (eligibilityPrincipalId) {
    await db.query("INSERT INTO billing_eligibility_principals(id) VALUES($1)", [
      eligibilityPrincipalId,
    ]);
    await db.query(
      "INSERT INTO billing_identity_subjects(id,live_user_id,eligibility_principal_id) VALUES($1,$1,$2)",
      [actorUserId, eligibilityPrincipalId],
    );
  }
  await db.query("INSERT INTO apps(id,organization_id) VALUES($1,$2)", [appId, org]);
  await db.query(
    `INSERT INTO app_billing_plan_revisions(id,app_id,merchant_id,product_family_key,plan_key,revision,name,amount_cents,currency,interval,maximum_quantity,trial_allowance_usd,paid_allowance_usd,expired_access,entitlements,stripe_price_id,stripe_product_id,published_at) VALUES ($1,$2,$3,'main','basic',1,'Basic',3000,'usd','month',10,'5.000000','25.000000','read_only','{"features":["inference"],"completionsRpm":60,"embeddingsRpm":60,"standardRpm":60,"strictRpm":10}','price_basic','prod_basic',now())`,
    [planId, appId, merchant],
  );
  const account = await authority.createAccount({
    appId,
    externalAccountKey: randomUUID(),
    displayName: "Independent workspace",
    principalUserId: actorUserId,
  });
  const identity: BuyerBillingIdentity = {
    appId,
    actorUserId,
    billingAccountId: account.id,
    productFamilyKey: "main",
    livemode: false,
    clientRegistrationId: null,
  };
  const scope = await authority.resolveScope({ ...identity, merchantId: merchant });
  return { identity, scopeId: scope.scopeId, planId };
}

describe.skipIf(!postgresUrl)("canonical billing deletion decisions with PostgreSQL", () => {
  beforeAll(async () => {
    db = new Client({ connectionString: postgresUrl });
    await db.connect();
    await db.query("CREATE EXTENSION IF NOT EXISTS btree_gist WITH SCHEMA public");
    await db.query(`CREATE SCHEMA ${schema}`);
    await db.query(`SET search_path TO ${schema},public`);
    await db.query(`
      CREATE TABLE IF NOT EXISTS webhook_events(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),event_id text NOT NULL UNIQUE,provider text NOT NULL,event_type text,payload_hash text NOT NULL,source_ip text,processed_at timestamp NOT NULL DEFAULT now(),event_timestamp timestamp);
    CREATE TABLE organizations(id uuid PRIMARY KEY,account_deletion_request_id uuid,account_lifecycle_revision bigint NOT NULL DEFAULT 0,is_active boolean NOT NULL DEFAULT true,account_lifecycle_state text NOT NULL DEFAULT 'active',paid_work_fenced_at timestamptz,stripe_customer_id text,credit_balance numeric NOT NULL DEFAULT 0);
      CREATE TABLE users(id uuid PRIMARY KEY,account_deletion_request_id uuid,account_lifecycle_revision bigint NOT NULL DEFAULT 0,is_active boolean NOT NULL DEFAULT true,deleted_at timestamptz,email_verified boolean NOT NULL DEFAULT true,is_anonymous boolean NOT NULL DEFAULT false,organization_id uuid,role text NOT NULL DEFAULT 'member',expires_at timestamptz,account_lifecycle_state text NOT NULL DEFAULT 'active',auth_fenced_at timestamptz);
      CREATE TABLE account_deletion_requests(id uuid PRIMARY KEY,user_id uuid,organization_id uuid,request_digest text,lifecycle_revision bigint,irreversible_at timestamp,status text);
      CREATE TABLE account_deletion_phase_receipts(id uuid PRIMARY KEY,request_id uuid REFERENCES account_deletion_requests(id),phase text,lease_generation bigint,lease_expires_at timestamp,status text);
      CREATE TABLE apps(id uuid PRIMARY KEY,name text NOT NULL DEFAULT 'Independent app',app_url text NOT NULL DEFAULT 'https://app.example',allowed_origins jsonb NOT NULL DEFAULT '["https://app.example"]',organization_id uuid NOT NULL REFERENCES organizations(id),is_active boolean NOT NULL DEFAULT true,is_approved boolean NOT NULL DEFAULT true,review_status text NOT NULL DEFAULT 'approved');
      CREATE TABLE credit_transactions(id uuid PRIMARY KEY,organization_id uuid NOT NULL REFERENCES organizations(id),CONSTRAINT credit_transactions_id_org_idx UNIQUE(id,organization_id));
    `);
    for (const tag of [
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
      "0390_app_billing_command_intents",
      "0391_app_billing_command_guards",
      "0392_app_billing_update_quotes",
      "0394_app_billing_merchant_identity",
      "0396_app_billing_notification_endpoints",
      "0397_app_subscription_outbox_delivery",
      "0398_app_billing_webhook_recovery",
      "0399_app_billing_checkout_expiry",
      "0400_app_billing_membership_authority",
      "0403_app_billing_import_commands",
      "0404_app_billing_import_guards",
      "0405_app_billing_import_allowance",
      "0413_app_billing_payment_expiry",
      "0415_app_billing_sales_fence",
      "0416_app_billing_refund_commands",
      "0417_app_billing_return_destination",
      "0414_app_billing_administrators",
      "0418_billing_identity_anchors",
      "0419_billing_identity_backfill",
      "0420_billing_identity_references",
      "0421_app_billing_deletion_dispositions",
      "0422_app_billing_deletion_disposition_guards",
    ]) {
      const migration = await readFile(
        new URL(`../../db/migrations/${tag}.sql`, import.meta.url),
        "utf8",
      );
      for (const statement of migration.split("--> statement-breakpoint"))
        if (statement.trim()) await db.query(statement.replaceAll('"public".', ""));
    }
    await db.query(
      "INSERT INTO organizations(id,stripe_customer_id) VALUES($1,'cus_infrastructure')",
      [org],
    );
    await db.query(
      "INSERT INTO billing_merchants(id,organization_id,provider_account_key,stripe_account_id,livemode,enabled) VALUES($1,$2,'acct_runtime','acct_runtime',false,true)",
      [merchant, org],
    );
    close = (await import("../../db/client")).closeDatabaseConnectionsForTests;
    authority = (await import("../../db/repositories/app-subscription-authority"))
      .appSubscriptionAuthorityRepository;

    queries = (await import("../../db/repositories/app-billing-queries")).appBillingQueries;
    const { appBillingProviderBindings } = await import(
      "../../db/repositories/app-billing-provider-bindings"
    );
    const { createGenericBillingProvider } = await import("./generic-billing-provider");
    const { GenericBillingRuntime } = await import("./generic-billing-runtime");
    runtime = new GenericBillingRuntime(async (merchantId, livemode) => {
      if (merchantId !== merchant || livemode) throw new Error("Unexpected runtime merchant");
      return createGenericBillingProvider(
        fixture.stripe,
        { merchantId, kind: "connected", stripeAccountId: "acct_runtime", livemode },
        appBillingProviderBindings,
      );
    });
  });
  afterAll(async () => {
    if (close) await close();
    if (db) {
      await db.query(`DROP SCHEMA ${schema} CASCADE`);
      await db.end();
    }
  });

  async function deletion(userId: string) {
    const organizationId = randomUUID(),
      requestId = randomUUID(),
      phaseReceiptId = randomUUID();
    await db.query(
      "INSERT INTO organizations(id,account_lifecycle_state,account_lifecycle_revision,account_deletion_request_id) VALUES($1,'deletion_irreversible',1,$2)",
      [organizationId, requestId],
    );
    await db.query(
      "UPDATE users SET organization_id=$2,is_active=false,account_lifecycle_state='deletion_irreversible',account_lifecycle_revision=1,account_deletion_request_id=$3 WHERE id=$1",
      [userId, organizationId, requestId],
    );
    await db.query(
      "INSERT INTO account_deletion_requests VALUES($1,$2,$3,$4,1,(now() AT TIME ZONE 'UTC'),'processing')",
      [requestId, userId, organizationId, "a".repeat(64)],
    );
    await db.query(
      "INSERT INTO account_deletion_phase_receipts VALUES($1,$2,'stripe',1,(now() AT TIME ZONE 'UTC')+interval '5 minutes','calling')",
      [phaseReceiptId, requestId],
    );
    return {
      kind: "account_deletion" as const,
      requestId,
      requestDigest: "a".repeat(64),
      lifecycleRevision: 1,
      phaseReceiptId,
      phaseGeneration: 1,
    };
  }
  async function administrator(appId: string, accountId: string) {
    const id = randomUUID();
    await db.query("INSERT INTO users(id) VALUES($1)", [id]);
    await db.query(
      "INSERT INTO app_billing_members(app_id,billing_account_id,user_id,role,livemode) VALUES($1,$2,$3,'administrator',false)",
      [appId, accountId, id],
    );
    return id;
  }
  async function decide(scopeId: string, authority: Awaited<ReturnType<typeof deletion>>) {
    return (
      await import("../../db/repositories/app-billing-deletion-dispositions")
    ).decideAppBillingDeletionScope({ scopeId, authority });
  }
  test("shared retention preserves a live subscription, rejects phase takeover, then closes irreversibly", async () => {
    const { identity, scopeId, planId } = await buyer();
    await runtime.prepare(identity, {
      idempotencyKey: randomUUID(),
      expectedSubscriptionRevision: null,
      payload: {
        version: 1,
        domain: "buyer",
        action: "trial",
        planRevisionId: planId,
        quantity: 1,
      },
    });
    const other = await administrator(identity.appId, identity.billingAccountId);
    const auth = await deletion(identity.actorUserId);
    expect((await decide(scopeId, auth)).disposition).toBe("retain_shared");
    expect((await queries.snapshot({ ...identity, actorUserId: other })).kind).toBe("subscription");
    expect(
      (await db.query("SELECT fenced_at FROM app_billing_scopes WHERE id=$1", [scopeId])).rows[0]
        .fenced_at,
    ).toBeNull();
    await db.query("UPDATE account_deletion_phase_receipts SET lease_generation=2 WHERE id=$1", [
      auth.phaseReceiptId,
    ]);
    await expect(decide(scopeId, auth)).rejects.toThrow("current irreversible");
    await db.query("UPDATE users SET auth_fenced_at=now() WHERE id=$1", [other]);
    const current = { ...auth, phaseGeneration: 2 };
    expect((await decide(scopeId, current)).disposition).toBe("close");
    await db.query("UPDATE users SET auth_fenced_at=NULL WHERE id=$1", [other]);
    expect((await decide(scopeId, current)).disposition).toBe("close");
    await expect(
      db.query("UPDATE app_billing_scopes SET fenced_at=NULL WHERE id=$1", [scopeId]),
    ).rejects.toThrow("cannot reopen");
    await expect(
      db.query(
        "UPDATE app_billing_deletion_dispositions SET disposition='retain_shared' WHERE scope_id=$1",
        [scopeId],
      ),
    ).rejects.toThrow("cannot reopen");
    await db.query("UPDATE account_deletion_requests SET lifecycle_revision=2 WHERE id=$1", [
      auth.requestId,
    ]);
    await expect(decide(scopeId, current)).rejects.toThrow("current irreversible");
  });
  test("database guard rejects close with a survivor and rejects expired or infinite phase evidence in a non-UTC session", async () => {
    const { identity, scopeId } = await buyer();
    await administrator(identity.appId, identity.billingAccountId);
    const auth = await deletion(identity.actorUserId);
    await db.query("SET TIME ZONE 'America/New_York'");
    const insert = () =>
      db.query(
        `INSERT INTO app_billing_deletion_dispositions(request_id,scope_id,request_digest,lifecycle_revision,phase_receipt_id,phase_generation,merchant_id,provider_account_key,livemode,disposition) SELECT $1,s.id,$2,1,$3,1,s.merchant_id,m.provider_account_key,s.livemode,'close' FROM app_billing_scopes s JOIN billing_merchants m ON m.id=s.merchant_id WHERE s.id=$4`,
        [auth.requestId, auth.requestDigest, auth.phaseReceiptId, scopeId],
      );
    await db.query("UPDATE app_billing_scopes SET fenced_at=now() WHERE id=$1", [scopeId]);
    await expect(insert()).rejects.toThrow("Surviving administrator");
    await db.query(
      "UPDATE account_deletion_phase_receipts SET lease_expires_at=(now() AT TIME ZONE 'UTC')-interval '1 minute' WHERE id=$1",
      [auth.phaseReceiptId],
    );
    await expect(insert()).rejects.toThrow("current canonical");
    await expect(decide(scopeId, auth)).rejects.toThrow("current irreversible");
    await db.query(
      "UPDATE account_deletion_phase_receipts SET lease_expires_at='infinity' WHERE id=$1",
      [auth.phaseReceiptId],
    );
    await expect(insert()).rejects.toThrow("current canonical");
    await expect(decide(scopeId, auth)).rejects.toThrow("current irreversible");
    expect(
      (
        await db.query("SELECT * FROM app_billing_deletion_dispositions WHERE scope_id=$1", [
          scopeId,
        ])
      ).rowCount,
    ).toBe(0);
  });
  test("simultaneously deleting administrators cannot count each other as survivors", async () => {
    const { identity, scopeId } = await buyer();
    const other = await administrator(identity.appId, identity.billingAccountId);
    const first = await deletion(identity.actorUserId),
      second = await deletion(other);
    const results = await Promise.all([decide(scopeId, first), decide(scopeId, second)]);
    expect(results.map((row) => row.disposition)).toEqual(["close", "close"]);
    expect(
      (await db.query("SELECT fenced_at FROM app_billing_scopes WHERE id=$1", [scopeId])).rows[0]
        .fenced_at,
    ).not.toBeNull();
  });
  test("foreign subjects and ordinary members cannot close a scope or write disposition evidence", async () => {
    const { identity, scopeId } = await buyer();
    const other = await buyer();
    const foreign = await deletion(other.identity.actorUserId);
    await expect(decide(scopeId, foreign)).rejects.toThrow("does not administer");
    const own = await deletion(identity.actorUserId);
    await db.query("UPDATE app_billing_members SET role='member' WHERE user_id=$1", [
      identity.actorUserId,
    ]);
    await expect(decide(scopeId, own)).rejects.toThrow("does not administer");
    expect(
      (
        await db.query("SELECT * FROM app_billing_deletion_dispositions WHERE scope_id=$1", [
          scopeId,
        ])
      ).rows,
    ).toEqual([]);
    expect(
      (await db.query("SELECT fenced_at FROM app_billing_scopes WHERE id=$1", [scopeId])).rows[0]
        .fenced_at,
    ).toBeNull();
  });
  test("developer deletion closes owned scopes despite surviving purchaser administrators", async () => {
    const { identity, scopeId } = await buyer();
    const developerUser = randomUUID();
    await db.query("INSERT INTO users(id) VALUES($1)", [developerUser]);
    const auth = await deletion(developerUser);
    await db.query("UPDATE account_deletion_requests SET organization_id=$2 WHERE id=$1", [
      auth.requestId,
      org,
    ]);
    await db.query(
      "UPDATE organizations SET account_lifecycle_state='deletion_irreversible',account_lifecycle_revision=1,account_deletion_request_id=$2 WHERE id=$1",
      [org, auth.requestId],
    );
    await db.query("UPDATE users SET organization_id=$2 WHERE id=$1", [developerUser, org]);
    expect((await decide(scopeId, auth)).disposition).toBe("close");
    await expect(
      runtime.prepare(identity, {
        idempotencyKey: randomUUID(),
        expectedSubscriptionRevision: null,
        payload: {
          version: 1,
          domain: "buyer",
          action: "trial",
          planRevisionId: (
            await db.query("SELECT id FROM app_billing_plan_revisions WHERE app_id=$1", [
              identity.appId,
            ])
          ).rows[0].id,
          quantity: 1,
        },
      }),
    ).rejects.toThrow("fenced");
  });
});
