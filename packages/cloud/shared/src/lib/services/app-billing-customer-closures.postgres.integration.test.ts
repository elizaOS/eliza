/** Exercises customer-wide closure identity and admission fences against real PostgreSQL migrations. Subscription preservation uses the real billing runtime and Stripe SDK with controlled HTTP. */
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Client } from "pg";
import type { BuyerBillingIdentity, GenericBillingRuntime } from "./generic-billing-runtime";
import { createRuntimeStripeFixture } from "./generic-billing-runtime.stripe-fixture";

const postgresUrl = process.env.APP_BILLING_TEST_POSTGRES_URL;
const schema = `app_customer_closure_${randomUUID().replaceAll("-", "_")}`;
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

describe.skipIf(!postgresUrl)("canonical customer closure with PostgreSQL", () => {
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
      "0424_app_billing_customer_closures",
      "0425_app_billing_customer_closure_guards",
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
  async function fixtureCustomer() {
    const source = await buyer();
    await runtime.prepare(source.identity, {
      idempotencyKey: randomUUID(),
      expectedSubscriptionRevision: null,
      payload: {
        version: 1,
        domain: "buyer",
        action: "trial",
        planRevisionId: source.planId,
        quantity: 1,
      },
    });
    const sibling = await authority.resolveScope({
      ...source.identity,
      productFamilyKey: "second",
      merchantId: merchant,
    });
    const binding = (
      await db.query(
        "SELECT * FROM app_billing_customers WHERE billing_account_id=$1 AND merchant_id=$2",
        [source.identity.billingAccountId, merchant],
      )
    ).rows[0];
    if (!binding) throw new Error("Runtime did not bind its customer");
    return { ...source, siblingId: sibling.scopeId, binding };
  }
  async function freeze(
    customerBindingId: string,
    authority: Awaited<ReturnType<typeof deletion>>,
  ) {
    return (
      await import("../../db/repositories/app-billing-customer-closures")
    ).closeAppBillingCustomer({ customerBindingId, authority });
  }
  test("a retained sibling blocks customer closure until it receives a canonical close decision", async () => {
    const source = await fixtureCustomer();
    const survivor = await administrator(source.identity.appId, source.identity.billingAccountId);
    const auth = await deletion(source.identity.actorUserId);
    expect((await decide(source.siblingId, auth)).disposition).toBe("retain_shared");
    await db.query("UPDATE users SET auth_fenced_at=now() WHERE id=$1", [survivor]);
    expect((await decide(source.scopeId, auth)).disposition).toBe("close");
    await expect(freeze(source.binding.id, auth)).rejects.toMatchObject({
      cause: { cause: { message: expect.stringContaining("Every sharing scope") } },
    });
    expect(
      (
        await db.query(
          "SELECT count(*)::int AS count FROM app_billing_customer_closures WHERE customer_binding_id=$1",
          [source.binding.id],
        )
      ).rows[0].count,
    ).toBe(0);
    await decide(source.siblingId, auth);
    const closure = await freeze(source.binding.id, auth);
    expect(closure.stripe_customer_id).toBe(source.binding.stripe_customer_id);
    expect(closure.merchant_id).toBe(merchant);
    expect(closure.livemode).toBe(false);
    expect(closure.stripe_account_id).toBe("acct_runtime");
    await expect(
      db.query(
        `INSERT INTO app_billing_customer_closures(customer_binding_id,billing_account_id,app_id,merchant_id,provider_account_key,stripe_account_id,livemode,stripe_customer_id,initiating_request_id,request_digest,lifecycle_revision,phase_receipt_id,phase_generation)
      SELECT customer_binding_id,billing_account_id,app_id,merchant_id,provider_account_key,stripe_account_id,NOT livemode,stripe_customer_id,initiating_request_id,request_digest,lifecycle_revision,phase_receipt_id,phase_generation FROM app_billing_customer_closures WHERE customer_binding_id=$1 ON CONFLICT DO NOTHING`,
        [source.binding.id],
      ),
    ).rejects.toThrow("provider identity mismatch");
    const after = await db.query(
      "SELECT status FROM billing_subscriptions WHERE billing_scope_id=$1",
      [source.scopeId],
    );
    expect(after.rows[0].status).toBe("trialing");
  });
  test("concurrent deletion requests converge on one immutable closure and stale replays still fail", async () => {
    const source = await fixtureCustomer();
    const other = await administrator(source.identity.appId, source.identity.billingAccountId);
    const first = await deletion(source.identity.actorUserId),
      second = await deletion(other);
    for (const auth of [first, second])
      for (const scope of [source.scopeId, source.siblingId]) await decide(scope, auth);
    const [a, b] = await Promise.all([
      freeze(source.binding.id, first),
      freeze(source.binding.id, second),
    ]);
    expect(a).toEqual(b);
    expect(
      (
        await db.query(
          "SELECT count(*)::int AS count FROM app_billing_customer_closures WHERE customer_binding_id=$1",
          [source.binding.id],
        )
      ).rows[0].count,
    ).toBe(1);
    await db.query("UPDATE account_deletion_phase_receipts SET lease_generation=2 WHERE id=$1", [
      first.phaseReceiptId,
    ]);
    await expect(freeze(source.binding.id, first)).rejects.toMatchObject({
      cause: { cause: { message: expect.stringContaining("current canonical deletion phase") } },
    });
    expect(await freeze(source.binding.id, { ...first, phaseGeneration: 2 })).toEqual(a);
    await expect(
      db.query(
        "UPDATE app_billing_customer_closures SET stripe_customer_id='cus_wrong' WHERE customer_binding_id=$1",
        [source.binding.id],
      ),
    ).rejects.toThrow("identity is immutable");
  });
  test("owner locking serializes sibling admission in both closure orders", async () => {
    const writer = new Client({ connectionString: process.env.DATABASE_URL });
    await writer.connect();
    async function waitForBlockedBy(pid: number) {
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        const blocked = await db.query(
          "SELECT 1 FROM pg_stat_activity WHERE $1::int=ANY(pg_blocking_pids(pid))",
          [pid],
        );
        if (blocked.rowCount) return;
        await Bun.sleep(10);
      }
      throw new Error("Expected competing billing operation to wait for owner lock");
    }
    const insertScope = (client: Client, source: Awaited<ReturnType<typeof fixtureCustomer>>) =>
      client.query(
        "INSERT INTO app_billing_scopes(app_id,organization_id,billing_account_id,merchant_id,livemode,product_family_key) VALUES($1,$2,$3,$4,false,'racing-family')",
        [source.identity.appId, org, source.identity.billingAccountId, merchant],
      );
    try {
      const first = await fixtureCustomer();
      const auth = await deletion(first.identity.actorUserId);
      await decide(first.scopeId, auth);
      await decide(first.siblingId, auth);
      await writer.query("BEGIN");
      const pid = (await writer.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
      await writer.query(
        `INSERT INTO app_billing_customer_closures(customer_binding_id,billing_account_id,app_id,merchant_id,provider_account_key,stripe_account_id,livemode,stripe_customer_id,initiating_request_id,request_digest,lifecycle_revision,phase_receipt_id,phase_generation)
         SELECT c.id,c.billing_account_id,a.app_id,c.merchant_id,m.provider_account_key,m.stripe_account_id,m.livemode,c.stripe_customer_id,$2,$3,$4,$5,$6 FROM app_billing_customers c JOIN app_billing_accounts a ON a.id=c.billing_account_id JOIN billing_merchants m ON m.id=c.merchant_id WHERE c.id=$1`,
        [
          first.binding.id,
          auth.requestId,
          auth.requestDigest,
          auth.lifecycleRevision,
          auth.phaseReceiptId,
          auth.phaseGeneration,
        ],
      );
      // Use a separate observer because this client is waiting inside the admission trigger.
      const admission = new Client({ connectionString: process.env.DATABASE_URL });
      await admission.connect();
      try {
        const rejected = insertScope(admission, first).then(
          () => null,
          (error: Error) => error,
        );
        await waitForBlockedBy(pid);
        await writer.query("COMMIT");
        expect(await rejected).toMatchObject({
          message: expect.stringContaining("cannot admit a scope or reuse"),
        });
      } finally {
        await writer.query("ROLLBACK");
        await admission.end();
      }
      const second = await fixtureCustomer();
      const next = await deletion(second.identity.actorUserId);
      await decide(second.scopeId, next);
      await decide(second.siblingId, next);
      await writer.query("BEGIN");
      await insertScope(writer, second);
      const rejected = freeze(second.binding.id, next).then(
        () => null,
        (error: Error) => error,
      );
      await waitForBlockedBy(pid);
      await writer.query("COMMIT");
      expect(await rejected).toMatchObject({
        cause: { cause: { message: expect.stringContaining("Every sharing scope requires") } },
      });
      expect(
        (
          await db.query(
            "SELECT count(*)::int AS count FROM app_billing_customer_closures WHERE customer_binding_id=$1",
            [second.binding.id],
          )
        ).rows[0].count,
      ).toBe(0);
    } finally {
      await writer.query("ROLLBACK");
      await writer.end();
    }
  });
  test("stale phase cannot create closure and closing rejects new scopes and binding replays", async () => {
    const source = await fixtureCustomer();
    const auth = await deletion(source.identity.actorUserId);
    await decide(source.scopeId, auth);
    await decide(source.siblingId, auth);
    await expect(freeze(source.binding.id, { ...auth, phaseGeneration: 2 })).rejects.toMatchObject({
      cause: { cause: { message: expect.stringContaining("current canonical deletion phase") } },
    });
    expect(
      (
        await db.query(
          "SELECT count(*)::int AS count FROM app_billing_customer_closures WHERE customer_binding_id=$1",
          [source.binding.id],
        )
      ).rows[0].count,
    ).toBe(0);
    await db.query(
      "UPDATE account_deletion_phase_receipts SET lease_expires_at=(now() AT TIME ZONE 'UTC')-interval '1 second' WHERE id=$1",
      [auth.phaseReceiptId],
    );
    await expect(freeze(source.binding.id, auth)).rejects.toMatchObject({
      cause: { cause: { message: expect.stringContaining("current canonical deletion phase") } },
    });
    await db.query(
      "UPDATE account_deletion_phase_receipts SET lease_expires_at=(now() AT TIME ZONE 'UTC')+interval '5 minutes' WHERE id=$1",
      [auth.phaseReceiptId],
    );
    const closure = await freeze(source.binding.id, auth);
    await expect(db.query("TRUNCATE app_billing_customer_closures")).rejects.toThrow(
      "identity is immutable",
    );
    expect(await freeze(source.binding.id, auth)).toEqual(closure);
    await expect(
      db.query(
        "INSERT INTO app_billing_scopes(app_id,organization_id,billing_account_id,merchant_id,livemode,product_family_key) VALUES($1,$2,$3,$4,false,'new-family')",
        [source.identity.appId, org, source.identity.billingAccountId, merchant],
      ),
    ).rejects.toThrow("cannot admit a scope or reuse");
    await expect(
      db.query(
        "INSERT INTO app_billing_customers(id,billing_account_id,merchant_id,stripe_customer_id,command_id) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING",
        [
          source.binding.id,
          source.binding.billing_account_id,
          source.binding.merchant_id,
          source.binding.stripe_customer_id,
          source.binding.command_id,
        ],
      ),
    ).rejects.toThrow("cannot admit a scope or reuse");
    expect(
      (
        await db.query(
          "SELECT count(*)::int AS count FROM app_billing_scopes WHERE billing_account_id=$1 AND merchant_id=$2",
          [source.identity.billingAccountId, merchant],
        )
      ).rows[0].count,
    ).toBe(2);
  });
});
