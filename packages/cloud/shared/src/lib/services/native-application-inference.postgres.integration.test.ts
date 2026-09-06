/**
 * Exercises native HTTP credentials, encrypted developer keys and paired ledgers with real PostgreSQL; provider acceptance is controlled.
 * Set APP_FUNDING_TEST_POSTGRES_URL to run the same contract in an isolated PostgreSQL schema.
 */
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import { Hono } from "hono";
import { Client } from "pg";
import type { AppEnv } from "../../types/cloud-worker-env";

const postgresUrl = process.env.APP_FUNDING_TEST_POSTGRES_URL;
const schema = `native_funding_${randomUUID().replaceAll("-", "_")}`;
let postgres: Client | null = null;
const repositoryUrl = postgresUrl ? new URL(postgresUrl) : null;
if (repositoryUrl) repositoryUrl.searchParams.set("options", `-c search_path=${schema},public`);
process.env.DATABASE_URL = repositoryUrl?.toString() ?? "pglite://memory";
process.env.TEST_DATABASE_URL = process.env.DATABASE_URL;
process.env.LOCAL_PG_POOL_MAX = "4";
process.env.NODE_ENV = "test";
process.env.CACHE_BACKEND = "memory";
process.env.ELIZA_KMS_BACKEND = "memory";
process.env.INFERENCE_AUTH_CACHE_ENABLED = "false";
setDefaultTimeout(120_000);
let client: {
  exec(statement: string): Promise<unknown>;
  query(statement: string, params?: unknown[]): Promise<{ rows: unknown[] }>;
};
let close: typeof import("../../db/client").closeDatabaseConnectionsForTests;
let repository: import("../../db/repositories/app-subscription-authority").AppSubscriptionAuthorityRepository;
const org = randomUUID();
const user = randomUUID();
const merchant = randomUUID();
const appA = randomUUID();
const appB = randomUUID();
const planA = randomUUID();
const planB = randomUUID();
const digest = "a".repeat(64);

beforeAll(async () => {
  const module = await import("../../db/client");
  if (postgresUrl) {
    const connection = new Client({ connectionString: postgresUrl });
    await connection.connect();
    await connection.query(`CREATE SCHEMA ${schema}`);
    await connection.query(`SET search_path TO ${schema},public`);
    postgres = connection;
    client = {
      exec: (statement) => connection.query(statement),
      query: (statement, params) => connection.query(statement, params),
    };
  } else client = module.getPgliteClientForTests();
  close = module.closeDatabaseConnectionsForTests;
  repository = (await import("../../db/repositories/app-subscription-authority"))
    .appSubscriptionAuthorityRepository;
  await client.exec(`
    CREATE TABLE webhook_events(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),event_id text NOT NULL UNIQUE,provider text NOT NULL,event_type text,payload_hash text NOT NULL,source_ip text,processed_at timestamp NOT NULL DEFAULT now(),event_timestamp timestamp);
    CREATE TABLE organizations(id uuid PRIMARY KEY,is_active boolean NOT NULL DEFAULT true,account_lifecycle_state text NOT NULL DEFAULT 'active',paid_work_fenced_at timestamptz,stripe_customer_id text,credit_balance numeric(16,6) NOT NULL DEFAULT 42,balance_revision bigint NOT NULL DEFAULT 0,settings jsonb NOT NULL DEFAULT '{}',updated_at timestamp NOT NULL DEFAULT now());
    CREATE TABLE users(id uuid PRIMARY KEY,is_active boolean NOT NULL DEFAULT true,deleted_at timestamptz,email_verified boolean NOT NULL DEFAULT true,organization_id uuid REFERENCES organizations(id),email text,name text,is_anonymous boolean NOT NULL DEFAULT false,expires_at timestamptz,account_lifecycle_state text NOT NULL DEFAULT 'active',auth_fenced_at timestamptz);
    CREATE TABLE apps(id uuid PRIMARY KEY,organization_id uuid NOT NULL REFERENCES organizations(id),is_active boolean NOT NULL DEFAULT true,is_approved boolean NOT NULL DEFAULT true,review_status text NOT NULL DEFAULT 'approved',name text NOT NULL DEFAULT 'Funding test app');
    CREATE TABLE credit_transactions(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),organization_id uuid NOT NULL REFERENCES organizations(id),user_id uuid REFERENCES users(id),amount numeric(16,6) NOT NULL,type text NOT NULL,description text,metadata jsonb NOT NULL DEFAULT '{}',stripe_payment_intent_id text UNIQUE,created_at timestamp NOT NULL DEFAULT now(),settled_at timestamp,CONSTRAINT credit_transactions_id_org_idx UNIQUE(id,organization_id));
    CREATE TABLE app_users(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),app_id uuid REFERENCES apps(id),user_id uuid REFERENCES users(id));
    CREATE TABLE provider_admissions(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),organization_id uuid NOT NULL REFERENCES organizations(id),operation_kind text NOT NULL,operation_id uuid NOT NULL,admitted_at timestamptz NOT NULL,released_at timestamptz,UNIQUE(operation_kind,operation_id));
    INSERT INTO organizations(id,stripe_customer_id) VALUES ('${org}','cus_infrastructure');
    INSERT INTO users(id) VALUES ('${user}');
    INSERT INTO apps(id,organization_id) VALUES ('${appA}','${org}'),('${appB}','${org}');
  `);
  // Hydration uses the real ORM projections; add their non-billing columns to this isolated authority fixture.
  const tables = await import("../../db/schemas");
  for (const table of [tables.users, tables.organizations, tables.apiKeys] as PgTable[]) {
    const config = getTableConfig(table);
    await client.exec(`CREATE TABLE IF NOT EXISTS "${config.name}" (id uuid PRIMARY KEY)`);
    for (const column of config.columns)
      await client.exec(
        `ALTER TABLE "${config.name}" ADD COLUMN IF NOT EXISTS "${column.name}" ${column.getSQLType()}`,
      );
  }
  await client.exec(`ALTER TABLE apps ADD COLUMN api_key_id uuid;
    ALTER TABLE users ALTER COLUMN account_lifecycle_state SET DEFAULT 'active';
    ALTER TABLE users ALTER COLUMN email_verified SET DEFAULT true;
    ALTER TABLE users ALTER COLUMN created_at SET DEFAULT now();
    ALTER TABLE users ALTER COLUMN role SET DEFAULT 'member';
    UPDATE users SET account_lifecycle_state='active',created_at=now(),role='member';`);
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
    "0417_app_billing_return_destination",
    "0390_app_billing_command_intents",
    "0391_app_billing_command_guards",
    "0392_app_billing_update_quotes",
    "0394_app_billing_merchant_identity",
    "0396_app_billing_notification_endpoints",
    "0397_app_subscription_outbox_delivery",
    "0398_app_billing_webhook_recovery",
    "0399_app_billing_checkout_expiry",
    "0400_app_billing_membership_authority",
    "0402_app_billing_application_slots",
    "0415_app_billing_sales_fence",
    "0414_app_billing_administrators",
    "0418_billing_identity_anchors",
    "0419_billing_identity_backfill",
    "0420_billing_identity_references",
  ]) {
    const migration = await readFile(
      new URL(`../../db/migrations/${tag}.sql`, import.meta.url),
      "utf8",
    );
    for (const statement of migration.split("--> statement-breakpoint"))
      if (statement.trim()) await client.exec(statement.replaceAll('"public".', ""));
  }
  await client.query(
    `INSERT INTO billing_merchants(id,organization_id,provider_account_key,livemode,enabled) VALUES ($1,$2,'platform',false,true)`,
    [merchant, org],
  );
  for (const [app, plan] of [
    [appA, planA],
    [appB, planB],
  ])
    await client.query(
      `INSERT INTO app_billing_plan_revisions(id,app_id,merchant_id,product_family_key,plan_key,revision,name,amount_cents,currency,interval,maximum_quantity,trial_allowance_usd,paid_allowance_usd,expired_access,entitlements,stripe_price_id,stripe_product_id,published_at) VALUES ($1,$2,$3,'main','basic',1,'Basic',3000,'usd','month',10,'5.000000','25.000000','read_only','{"features":["inference"],"completionsRpm":60,"embeddingsRpm":60,"standardRpm":60,"strictRpm":10}','price_basic','prod_basic',now())`,
      [plan, app, merchant],
    );
});
afterAll(async () => {
  await Promise.all(background);
  await close();
  if (postgres) {
    await postgres.query(`DROP SCHEMA ${schema} CASCADE`);
    await postgres.end();
  }
});

async function prepare(
  appId: string,
  planRevisionId: string,
  merchantId: string,
  principal: string,
  key = randomUUID(),
) {
  const account = await repository.createAccount({
    appId,
    externalAccountKey: key,
    displayName: "Test workspace",
    principalUserId: principal,
  });
  const scope = await repository.resolveScope({
    appId,
    billingAccountId: account.id,
    productFamilyKey: "main",
    merchantId,
    actorUserId: principal,
  });
  const command = await repository.prepareCommand({
    scopeId: scope.scopeId,
    actorUserId: principal,
    kind: "checkout",
    payload: {
      version: 1,
      domain: "buyer",
      action: "trial",
      planRevisionId: planRevisionId,
      quantity: 1,
    },
    targetPlanRevisionId: planRevisionId,
    quantity: 1,
    idempotencyKey: `checkout:${key}`,
    requestDigest: digest,
    expectedSubscriptionRevision: null,
  });
  return { account, scope, command };
}

async function fixture(options: { creditBalance?: string; expiresSoon?: boolean } = {}) {
  const developer = randomUUID();
  const principal = randomUUID();
  const buyerOrg = randomUUID();
  const merchantId = randomUUID();
  const providerAccountId = `acct_${randomUUID().replaceAll("-", "")}`;
  await client.query("INSERT INTO organizations(id,credit_balance) VALUES ($1,$2),($3,0)", [
    developer,
    options.creditBalance ?? "42.000000",
    buyerOrg,
  ]);
  await client.query("INSERT INTO users(id,organization_id) VALUES ($1,$2)", [principal, buyerOrg]);
  await client.query(
    "INSERT INTO billing_merchants(id,organization_id,provider_account_key,livemode,enabled) VALUES ($1,$2,$3,false,true)",
    [merchantId, developer, providerAccountId],
  );
  const app = randomUUID();
  const plan = randomUUID();
  await client.query("INSERT INTO apps(id,organization_id) VALUES ($1,$2)", [app, developer]);
  const { dbWrite } = await import("../../db/helpers");
  const { appBillingPlanRevisions, appSubscriptionTrials } = await import(
    "../../db/schemas/app-billing"
  );
  const original = await repository.getPlan({ appId: appA, planRevisionId: planA });
  await dbWrite
    .insert(appBillingPlanRevisions)
    .values({ ...original, id: plan, app_id: app, merchant_id: merchantId });
  const prepared = await prepare(app, plan, merchantId, principal, `user:${principal}`);
  const trialEnd = new Date(Math.floor((Date.now() + 2500) / 1000) * 1000);
  const trial = options.expiresSoon
    ? (
        await dbWrite
          .insert(appSubscriptionTrials)
          .values({
            app_id: app,
            eligibility_principal_id: principal,
            billing_scope_id: prepared.scope.scopeId,
            livemode: false,
            command_id: prepared.command.id,
            plan_revision_id: plan,
            starts_at: new Date(trialEnd.getTime() - 604800000),
            ends_at: trialEnd,
          })
          .returning()
      )[0]
    : await repository.claimTrial({
        scopeId: prepared.scope.scopeId,
        commandId: prepared.command.id,
        planRevisionId: plan,
      });
  if (!trial) throw new Error("Trial fixture insertion returned no row");
  const command = await repository.beginCommand({
    scopeId: prepared.scope.scopeId,
    commandId: prepared.command.id,
    actorUserId: principal,
    expectedStateRevision: prepared.command.state_revision,
    expectedExecutionGeneration: prepared.command.execution_generation,
  });
  const suffix = randomUUID().replaceAll("-", "");
  const customerId = `cus_${suffix}`;
  await repository.bindCustomer({
    scopeId: prepared.scope.scopeId,
    commandId: command.id,
    customerId,
  });
  const observation: import("./generic-billing-provider-types").BillingProviderObservation<
    import("./generic-billing-provider-types").BillingProviderSubscription
  > = {
    value: {
      subscriptionId: `sub_${suffix}`,
      customerId,
      itemId: `si_${suffix}`,
      status: "trialing",
      quantity: 1,
      priceId: "price_basic",
      productId: "prod_basic",
      currentPeriodStart: trial.starts_at.getTime() / 1000,
      currentPeriodEnd: trial.ends_at.getTime() / 1000,
      trialStart: trial.starts_at.getTime() / 1000,
      trialEnd: trial.ends_at.getTime() / 1000,
      cancelAtPeriodEnd: false,
      canceledAt: null,
      endedAt: null,
      latestInvoiceId: null,
      pendingUpdate: false,
    },
    digest,
    inputDigest: digest,
    apiVersion: "2024-11-20.acacia",
    merchantId,
    providerAccountId,
    livemode: false,
    observedAt: new Date().toISOString(),
  };
  const input: import("../../db/repositories/app-subscription-finalizer").ApplyAppSubscriptionObservation =
    {
      scopeId: prepared.scope.scopeId,
      planRevisionId: plan,
      expectedSubscriptionRevision: null,
      subscription: observation,
      invoice: null,
      command: {
        id: command.id,
        stateRevision: command.state_revision,
        executionGeneration: command.execution_generation,
        leaseToken: command.lease_token,
      },
      event: null,
    };
  const { appSubscriptionFinalizer } = await import(
    "../../db/repositories/app-subscription-finalizer"
  );
  const projection = await appSubscriptionFinalizer.applyObservation(input);
  const actor: import("./app-inference-funding").AppInferenceFundingActor = {
    appId: app,
    billingAccountId: prepared.account.id,
    productFamilyKey: "main",
    environment: "test",
    developerOrganizationId: developer,
    actorUserId: principal,
  };
  const request: import("./app-inference-funding").AppInferenceFundingRequest = {
    actor,
    logicalOperationId: `inference:${randomUUID()}`,
    requestDigest: digest,
    estimatedAmountUsd: "2.000000",
  };
  return {
    request,
    trial,
    projection,
    buyerOrg,
    developer,
    scopeId: prepared.scope.scopeId,
    merchantId,
    app,
    principal,
  };
}

async function balances(developer: string, scopeId: string) {
  const { rows } = await client.query(
    `SELECT o.credit_balance::text cash,p.available_amount::text available,p.reserved_amount::text reserved,p.settled_amount::text settled,p.expired_amount::text expired FROM organizations o JOIN subscription_allowance_periods p ON p.organization_id=o.id WHERE o.id=$1 AND p.billing_scope_id=$2`,
    [developer, scopeId],
  );
  return rows[0];
}

async function credential(organizationId: string, userId: string) {
  const id = randomUUID();
  const secret = `eliza_${randomBytes(24).toString("hex")}`;
  const { encryptApiKey } = await import("../../db/crypto/api-keys");
  const encrypted = await encryptApiKey(organizationId, id, secret);
  await client.query(
    `INSERT INTO api_keys(id,name,key_hash,key_prefix,organization_id,user_id,is_active,rate_limit,usage_count,created_at,updated_at,key_ciphertext,key_nonce,key_auth_tag,key_kms_key_id,key_kms_key_version) VALUES($1,'Native fixture',$2,'eliza_fixture',$3,$4,true,1000,0,now(),now(),$5,$6,$7,$8,$9)`,
    [
      id,
      createHash("sha256").update(secret).digest("hex"),
      organizationId,
      userId,
      encrypted.ciphertext,
      encrypted.nonce,
      encrypted.auth_tag,
      encrypted.kms_key_id,
      encrypted.kms_key_version,
    ],
  );
  return { id, secret };
}
async function nativeFixture() {
  const f = await fixture();
  await client.query("UPDATE users SET email_verified=false WHERE id=$1", [f.principal]);
  const developerUser = randomUUID();
  await client.query("INSERT INTO users(id,organization_id) VALUES($1,$2)", [
    developerUser,
    f.developer,
  ]);
  const developerKey = await credential(f.developer, developerUser);
  const purchaserKey = await credential(f.buyerOrg, f.principal);
  await client.query("UPDATE apps SET api_key_id=$1 WHERE id=$2", [developerKey.id, f.app]);
  const slotKey = `native_${randomBytes(8).toString("hex")}`;
  await client.query(
    "INSERT INTO app_billing_application_slots(slot_key,app_id,organization_id,merchant_id,livemode,product_family_key,manifest_digest) VALUES($1,$2,$3,$4,false,'main',$5)",
    [slotKey, f.app, f.developer, f.merchantId, createHash("sha256").update(slotKey).digest("hex")],
  );
  return { ...f, developerKey, purchaserKey, slotKey };
}
const background: Promise<unknown>[] = [];
let providerCalls = 0;
let beforeDispatch: (() => Promise<void>) | null = null;
let rejectProvider = false;
let observedDeveloperCredential: string | null = null;
async function routes() {
  const { prepareNativeApplicationInference, nativeApplicationInferenceErrorResponse } =
    await import("./native-application-inference");
  const { nativeApplicationSelectionSurfaceError } = await import(
    "../http/native-application-selection"
  );
  const { admitAppSubscriptionInference, appInferenceDeveloperScope } = await import(
    "./app-subscription-inference-admission"
  );
  const { requireInferenceApiKeyWithOrg } = await import("./inference-api-key-auth");
  const { settlementDigest } = await import("./settlement-digest");
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => nativeApplicationSelectionSurfaceError(c.req.raw) ?? next());
  app.onError((error) => {
    process.stderr.write(`${error.name}: ${error.message}\n`);
    return (
      nativeApplicationInferenceErrorResponse(error) ??
      Response.json({ error: { code: "unavailable" } }, { status: 503 })
    );
  });
  app.post("/api/v1/chat/completions", async (c) => {
    const native = await prepareNativeApplicationInference(c);
    if (!native.actor) return c.json({ funding: "prepaid" });
    observedDeveloperCredential = native.request.headers.get("Authorization");
    const developer = await requireInferenceApiKeyWithOrg(
      observedDeveloperCredential!.substring(7),
    );
    const request = await native.request.json();
    const admission = await admitAppSubscriptionInference({
      actor: native.actor,
      developerOrganizationId: developer.user.organization_id,
      developerAppScopeId: await appInferenceDeveloperScope(developer.apiKey.id),
      logicalOperationId: native.request.headers.get("Idempotency-Key")!,
      requestDigest: settlementDigest(request),
      estimatedCostUsd: 2,
      revalidateDeveloperCredential: async () => {
        const current = await requireInferenceApiKeyWithOrg(
          observedDeveloperCredential!.substring(7),
        );
        if (current.apiKey.id !== developer.apiKey.id) throw new Error("Developer changed");
      },
    });
    try {
      await beforeDispatch?.();
      await admission.markProviderDispatched();
      providerCalls++;
      if (rejectProvider) {
        await admission.settle(0);
        return c.json({ error: { code: "provider_rejected" } }, 503);
      }
      await admission.settle(0.75);
      await admission.settle(0.75);
      return c.json({ choices: [{ message: { content: "Controlled provider response" } }] });
    } catch (error) {
      // error-policy:J2 Release only the pre-dispatch failure exercised here and preserve its typed authority denial.
      await admission.settle(0);
      throw error;
    }
  });
  return app;
}
function send(
  app: Hono<AppEnv>,
  f: Awaited<ReturnType<typeof nativeFixture>>,
  operationId = `native:${randomUUID()}`,
  environment: "test" | "live" = "test",
  path = "/api/v1/chat/completions",
) {
  return app.request(
    `http://localhost${path}`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${f.purchaserKey.secret}`,
        "X-API-Key": f.purchaserKey.secret,
        "X-Eliza-Application-Slot": f.slotKey,
        "Idempotency-Key": operationId,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "fixture",
        messages: [{ role: "user", content: "Complete native request" }],
      }),
    },
    { APP_INFERENCE_EXECUTION_ENVIRONMENT: environment, NODE_ENV: "test" },
    {
      waitUntil: (promise: Promise<unknown>) => {
        background.push(promise);
      },
      passThroughOnException() {},
      props: {},
    },
  );
}
describe("native application product funding HTTP authority", () => {
  test("merchant sales disable retains purchased native usage while app suspension still blocks dispatch", async () => {
    const f = await nativeFixture();
    const app = await routes();
    providerCalls = 0;
    rejectProvider = false;
    beforeDispatch = null;
    await client.query(
      "UPDATE billing_merchants SET enabled=false,disconnected_at=now() WHERE id=$1",
      [f.merchantId],
    );
    const { readAppBillingApplicationProduct } = await import(
      "../../db/repositories/app-billing-application-slots"
    );
    const product = await readAppBillingApplicationProduct({ slotKey: f.slotKey, livemode: false });
    expect(product.appId).toBe(f.app);
    expect((await send(app, f)).status).toBe(200);
    expect(providerCalls).toBe(1);
    const settled = await balances(f.developer, f.scopeId);
    expect(settled).toMatchObject({
      cash: "41.250000",
      available: "4.250000",
      reserved: "0.000000",
      settled: "0.750000",
    });
    await client.query("UPDATE apps SET is_active=false WHERE id=$1", [f.app]);
    expect((await send(app, f)).status).toBe(403);
    expect(providerCalls).toBe(1);
    expect(await balances(f.developer, f.scopeId)).toEqual(settled);
  });

  test("a free wallet buyer pays from app allowance and server-owned developer funding, with exact replay denial", async () => {
    const f = await nativeFixture();
    const app = await routes();
    providerCalls = 0;
    rejectProvider = false;
    beforeDispatch = null;
    const operation = `native:${randomUUID()}`;
    const responses = await Promise.all([send(app, f, operation), send(app, f, operation)]);
    expect(responses.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(providerCalls).toBe(1);
    expect(observedDeveloperCredential).toBe(`Bearer ${f.developerKey.secret}`);
    expect(await balances(f.developer, f.scopeId)).toMatchObject({
      cash: "41.250000",
      available: "4.250000",
      reserved: "0.000000",
      settled: "0.750000",
    });
    expect(
      (
        await client.query(
          "SELECT credit_balance::text AS balance FROM organizations WHERE id=$1",
          [f.buyerOrg],
        )
      ).rows[0],
    ).toEqual({ balance: "0.000000" });
    expect(
      (
        await client.query(
          "SELECT count(*)::int AS count FROM billing_subscriptions WHERE organization_id=$1",
          [f.buyerOrg],
        )
      ).rows[0],
    ).toEqual({ count: 0 });
    const reply = await send(app, f, operation);
    expect(reply.status).toBe(409);
    expect(providerCalls).toBe(1);
  });
  test("known provider rejection releases both holds once; replay never dispatches again", async () => {
    const f = await nativeFixture();
    const app = await routes();
    providerCalls = 0;
    rejectProvider = true;
    beforeDispatch = null;
    const operation = `native:${randomUUID()}`;
    expect((await send(app, f, operation)).status).toBe(503);
    expect((await send(app, f, operation)).status).toBe(409);
    expect(providerCalls).toBe(1);
    expect(await balances(f.developer, f.scopeId)).toMatchObject({
      cash: "42.000000",
      available: "5.000000",
      reserved: "0.000000",
      settled: "0.000000",
    });
    rejectProvider = false;
  });
  test("revocation after reserve denies dispatch and releases both holds", async () => {
    const f = await nativeFixture();
    const app = await routes();
    providerCalls = 0;
    beforeDispatch = async () => {
      await client.query("UPDATE api_keys SET is_active=false WHERE id=$1", [f.purchaserKey.id]);
    };
    expect((await send(app, f)).status).toBe(403);
    expect(providerCalls).toBe(0);
    expect(await balances(f.developer, f.scopeId)).toMatchObject({
      cash: "42.000000",
      available: "5.000000",
      reserved: "0.000000",
    });
    beforeDispatch = null;
  });
  test("current developer rotation and disabled slots cannot use prior funding authority", async () => {
    const f = await nativeFixture();
    const app = await routes();
    providerCalls = 0;
    beforeDispatch = async () => {
      await client.query("UPDATE apps SET api_key_id=null WHERE id=$1", [f.app]);
    };
    expect((await send(app, f)).status).toBe(403);
    expect(providerCalls).toBe(0);
    beforeDispatch = null;
    await client.query(
      "UPDATE app_billing_application_slots SET disabled_at=now() WHERE slot_key=$1",
      [f.slotKey],
    );
    expect((await send(app, f)).status).toBe(403);
    expect(providerCalls).toBe(0);
  });
  test("two apps and merchants isolate native account, operation and execution environment", async () => {
    const a = await nativeFixture();
    const b = await nativeFixture();
    const app = await routes();
    providerCalls = 0;
    beforeDispatch = null;
    rejectProvider = false;
    expect((await send(app, { ...a, slotKey: b.slotKey })).status).toBe(403);
    expect((await send(app, a, `native:${randomUUID()}`, "live")).status).toBe(403);
    expect(
      (await send(app, a, `native:${randomUUID()}`, "test", "/api/v1/images/generations")).status,
    ).toBe(400);
    const operation = `native:${randomUUID()}`;
    expect((await send(app, a, operation)).status).toBe(200);
    expect((await send(app, b, operation)).status).toBe(200);
    expect(providerCalls).toBe(2);
    expect(await balances(a.developer, a.scopeId)).toMatchObject({ cash: "41.250000" });
    expect(await balances(b.developer, b.scopeId)).toMatchObject({ cash: "41.250000" });
  });
});
