/**
 * Exercises paired app allowance and developer cash funding with real repositories and PostgreSQL sessions.
 * Set APP_FUNDING_TEST_POSTGRES_URL to run the same contract in an isolated PostgreSQL schema.
 */
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Client } from "pg";

const postgresUrl = process.env.APP_FUNDING_TEST_POSTGRES_URL;
const schema = `app_funding_${randomUUID().replaceAll("-", "_")}`;
let postgres: Client | null = null;
const repositoryUrl = postgresUrl ? new URL(postgresUrl) : null;
if (repositoryUrl) repositoryUrl.searchParams.set("options", `-c search_path=${schema},public`);
process.env.DATABASE_URL = repositoryUrl?.toString() ?? "pglite://memory";
process.env.TEST_DATABASE_URL = process.env.DATABASE_URL;
process.env.LOCAL_PG_POOL_MAX = "4";
process.env.NODE_ENV ||= "test";
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
    CREATE TABLE IF NOT EXISTS webhook_events(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),event_id text NOT NULL UNIQUE,provider text NOT NULL,event_type text,payload_hash text NOT NULL,source_ip text,processed_at timestamp NOT NULL DEFAULT now(),event_timestamp timestamp);
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
    "0399_app_billing_checkout_expiry",
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
    `INSERT INTO billing_merchants(id,organization_id,provider_account_key,stripe_account_id,livemode,enabled) VALUES ($1,$2,'platform','acct_platform',false,true)`,
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
    "INSERT INTO billing_merchants(id,organization_id,provider_account_key,stripe_account_id,livemode,enabled) VALUES ($1,$2,$3,$3,false,true)",
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
  const prepared = await prepare(app, plan, merchantId, principal);
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
  return { request, trial, projection, buyerOrg, developer, scopeId: prepared.scope.scopeId };
}

async function balances(developer: string, scopeId: string) {
  const { rows } = await client.query(
    `SELECT o.credit_balance::text cash,p.available_amount::text available,p.reserved_amount::text reserved,p.settled_amount::text settled,p.expired_amount::text expired FROM organizations o JOIN subscription_allowance_periods p ON p.organization_id=o.id WHERE o.id=$1 AND p.billing_scope_id=$2`,
    [developer, scopeId],
  );
  return rows[0];
}
async function service() {
  return (await import("./app-inference-funding")).appInferenceFundingService;
}

describe("paired app inference funding", () => {
  test("free buyer consumes app allowance while developer pays actual infrastructure exactly once", async () => {
    const f = await fixture();
    const funding = await service();
    const reservations = await Promise.all([
      funding.reserve(f.request),
      funding.reserve(f.request),
    ]);
    expect(reservations.filter((r) => r.dispatchGranted)).toHaveLength(1);
    expect(reservations[0]?.allowanceReservationId).toBe(reservations[1]?.allowanceReservationId);
    await funding.assertDispatchCurrent(f.request);
    expect(await balances(f.developer, f.scopeId)).toMatchObject({
      cash: "40.000000",
      available: "3.000000",
      reserved: "2.000000",
    });
    const result = await funding.settle({ ...f.request, actualAmountUsd: "1.250000" });
    expect(result).toMatchObject({
      status: "finalized",
      replayed: false,
      collectedAmountUsd: "1.250000",
    });
    expect(await funding.settle({ ...f.request, actualAmountUsd: "1.250000" })).toMatchObject({
      replayed: true,
    });
    expect(await balances(f.developer, f.scopeId)).toMatchObject({
      cash: "40.750000",
      available: "3.750000",
      reserved: "0.000000",
      settled: "1.250000",
    });
    expect(
      (
        await client.query("SELECT credit_balance::text FROM organizations WHERE id=$1", [
          f.buyerOrg,
        ])
      ).rows,
    ).toEqual([{ credit_balance: "0.000000" }]);
    expect(
      (
        await client.query("SELECT id FROM billing_subscriptions WHERE organization_id=$1", [
          f.buyerOrg,
        ])
      ).rows,
    ).toEqual([]);
    expect(
      (
        await client.query("SELECT id FROM credit_transactions WHERE organization_id=$1", [
          f.buyerOrg,
        ])
      ).rows,
    ).toEqual([]);
    expect(
      (
        await client.query(
          "SELECT type,count(*)::int n FROM credit_transactions WHERE organization_id=$1 GROUP BY type ORDER BY type",
          [f.developer],
        )
      ).rows,
    ).toEqual([
      { type: "debit", n: 1 },
      { type: "refund", n: 1 },
    ]);
    await expect(funding.release(f.request)).rejects.toMatchObject({
      code: "APP_INFERENCE_REPLAY_CONFLICT",
    });
    await expect(funding.assertDispatchCurrent(f.request)).rejects.toMatchObject({
      code: "APP_INFERENCE_DISPATCH_EXPIRED",
    });
  });
  test("known provider failure releases both balances once and never grants a retry dispatch", async () => {
    const f = await fixture();
    const funding = await service();
    await funding.reserve(f.request);
    const outcomes = await Promise.all([funding.release(f.request), funding.release(f.request)]);
    expect(outcomes.filter((r) => !r.replayed)).toHaveLength(1);
    expect(await balances(f.developer, f.scopeId)).toMatchObject({
      cash: "42.000000",
      available: "5.000000",
      reserved: "0.000000",
      settled: "0.000000",
    });
    expect(await funding.reserve(f.request)).toMatchObject({
      status: "canceled",
      dispatchGranted: false,
    });
    expect(
      (
        await client.query(
          "SELECT id FROM provider_admissions WHERE organization_id=$1 AND released_at IS NULL",
          [f.developer],
        )
      ).rows,
    ).toEqual([]);
  });
  test("insufficient buyer allowance cannot fall back to developer money; insufficient infrastructure rolls everything back", async () => {
    const a = await fixture();
    const funding = await service();
    await expect(
      funding.reserve({ ...a.request, estimatedAmountUsd: "6.000000" }),
    ).rejects.toMatchObject({ code: "APP_INFERENCE_ALLOWANCE_INSUFFICIENT" });
    expect(await balances(a.developer, a.scopeId)).toMatchObject({
      cash: "42.000000",
      available: "5.000000",
      reserved: "0.000000",
    });
    const b = await fixture({ creditBalance: "1.000000" });
    await expect(funding.reserve(b.request)).rejects.toMatchObject({
      code: "APP_INFERENCE_INFRASTRUCTURE_INSUFFICIENT",
    });
    expect(await balances(b.developer, b.scopeId)).toMatchObject({
      cash: "1.000000",
      available: "5.000000",
      reserved: "0.000000",
    });
    expect(
      (
        await client.query("SELECT id FROM billing_funding_reservations WHERE organization_id=$1", [
          b.developer,
        ])
      ).rows,
    ).toEqual([]);
  });
  test("database failure after the debit atomically rolls back both ledgers and permits one safe new attempt", async () => {
    const f = await fixture();
    const funding = await service();
    await client.exec(
      `CREATE FUNCTION reject_app_admission() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.organization_id='${f.developer}'::uuid THEN RAISE EXCEPTION 'injected admission failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER reject_app_admission BEFORE INSERT ON provider_admissions FOR EACH ROW EXECUTE FUNCTION reject_app_admission();`,
    );
    try {
      await expect(funding.reserve(f.request)).rejects.toThrow();
    } finally {
      await client.exec(
        "DROP TRIGGER reject_app_admission ON provider_admissions; DROP FUNCTION reject_app_admission()",
      );
    }
    expect(await balances(f.developer, f.scopeId)).toMatchObject({
      cash: "42.000000",
      available: "5.000000",
      reserved: "0.000000",
    });
    expect(
      (
        await client.query("SELECT id FROM credit_transactions WHERE organization_id=$1", [
          f.developer,
        ])
      ).rows,
    ).toEqual([]);
    expect(await funding.reserve(f.request)).toMatchObject({ dispatchGranted: true });
    await funding.release(f.request);
  });
  test("two merchants and apps with the same operation key remain isolated and test entitlement cannot authorize live use", async () => {
    const a = await fixture();
    const b = await fixture();
    const funding = await service();
    const second = { ...b.request, logicalOperationId: a.request.logicalOperationId };
    await Promise.all([funding.reserve(a.request), funding.reserve(second)]);
    await funding.settle({ ...a.request, actualAmountUsd: "1.000000" });
    expect(await balances(b.developer, b.scopeId)).toMatchObject({
      cash: "40.000000",
      available: "3.000000",
      reserved: "2.000000",
      settled: "0.000000",
    });
    await expect(
      funding.reserve({ ...a.request, actor: { ...a.request.actor, environment: "live" } }),
    ).rejects.toMatchObject({ code: "APP_INFERENCE_SCOPE" });
    await expect(
      funding.reserve({
        ...b.request,
        actor: { ...b.request.actor, developerOrganizationId: a.developer },
      }),
    ).rejects.toMatchObject({ code: "APP_INFERENCE_SCOPE" });
    await expect(
      funding.reserve({
        ...a.request,
        actor: { ...a.request.actor, billingAccountId: b.request.actor.billingAccountId },
      }),
    ).rejects.toMatchObject({ code: "APP_INFERENCE_SCOPE" });
    await funding.release(second);
  });
  test("changed payload replay and revoked membership cannot reuse a pending operation", async () => {
    const f = await fixture();
    const funding = await service();
    await funding.reserve(f.request);
    await expect(
      funding.reserve({ ...f.request, requestDigest: "b".repeat(64) }),
    ).rejects.toMatchObject({ code: "APP_INFERENCE_REPLAY_CONFLICT" });
    await client.query(
      "UPDATE app_billing_members SET revoked_at=now() WHERE billing_account_id=$1",
      [f.request.actor.billingAccountId],
    );
    await expect(funding.assertDispatchCurrent(f.request)).rejects.toMatchObject({
      code: "APP_INFERENCE_MEMBERSHIP",
    });
    await expect(funding.reserve(f.request)).rejects.toMatchObject({
      code: "APP_INFERENCE_MEMBERSHIP",
    });
    await funding.release(f.request);
    expect(await balances(f.developer, f.scopeId)).toMatchObject({
      cash: "42.000000",
      reserved: "0.000000",
    });
  });
  test("trial expiry bounds dispatch and late release cannot revive expired allowance", async () => {
    const f = await fixture({ expiresSoon: true });
    const funding = await service();
    const reserved = await funding.reserve(f.request);
    expect(reserved.validUntil.getTime()).toBe(f.trial.ends_at.getTime());
    await new Promise((resolve) =>
      setTimeout(resolve, Math.max(0, f.trial.ends_at.getTime() - Date.now() + 50)),
    );
    await expect(funding.assertDispatchCurrent(f.request)).rejects.toMatchObject({
      code: "APP_INFERENCE_DISPATCH_EXPIRED",
    });
    await funding.release(f.request);
    expect(await balances(f.developer, f.scopeId)).toMatchObject({
      cash: "42.000000",
      reserved: "0.000000",
      expired: "2.000000",
    });
    await expect(
      funding.reserve({ ...f.request, logicalOperationId: `new:${randomUUID()}` }),
    ).rejects.toMatchObject({ code: "APP_INFERENCE_ENTITLEMENT" });
  });
  test("measured overage stays explicit in both durable funding records", async () => {
    const f = await fixture();
    const funding = await service();
    await funding.reserve(f.request);
    expect(await funding.settle({ ...f.request, actualAmountUsd: "2.250000" })).toMatchObject({
      collectedAmountUsd: "2.000000",
      uncollectedOverageUsd: "0.250000",
    });
    expect(
      (
        await client.query(
          "SELECT uncollected_overage_amount::text FROM billing_funding_reservations WHERE organization_id=$1",
          [f.developer],
        )
      ).rows,
    ).toEqual([
      { uncollected_overage_amount: "0.250000" },
      { uncollected_overage_amount: "0.250000" },
    ]);
  });
});

test("one callback owns dispatch while an unknown provider result retains both original reservations", async () => {
  const f = await fixture();
  const { admitAppSubscriptionInference } = await import("./app-subscription-inference-admission");
  const callbacks = await admitAppSubscriptionInference({
    actor: { ...f.request.actor, revalidate: async () => {} },
    developerOrganizationId: f.developer,
    developerAppScopeId: f.request.actor.appId,
    logicalOperationId: f.request.logicalOperationId,
    requestDigest: f.request.requestDigest,
    estimatedCostUsd: 2,
    revalidateDeveloperCredential: async () => {},
  });
  const attempts = await Promise.allSettled([
    callbacks.markProviderDispatched(),
    callbacks.markProviderDispatched(),
  ]);
  expect(attempts.filter((result) => result.status === "fulfilled")).toHaveLength(1);
  expect(attempts.filter((result) => result.status === "rejected")).toHaveLength(1);
  expect(await callbacks.settleUnknown()).toBeNull();
  expect(await balances(f.developer, f.scopeId)).toMatchObject({
    cash: "40.000000",
    available: "3.000000",
    reserved: "2.000000",
  });
  await callbacks.settle(1.25);
  await callbacks.settle(1.25);
  expect(await balances(f.developer, f.scopeId)).toMatchObject({
    cash: "40.750000",
    available: "3.750000",
    reserved: "0.000000",
  });
});

test("registered delegation HTTP boundary and real DB admission preserve payer isolation across known failure, retry and mode denial", async () => {
  const f = await fixture();
  const clientId = randomUUID(),
    consentId = randomUUID();
  const secret = randomBytes(32).toString("base64url"),
    token = `ead_${randomBytes(32).toString("base64url")}`;
  const hash = (value: string) => createHash("sha256").update(value).digest("hex");
  await client.query("INSERT INTO app_users(id,app_id,user_id) VALUES ($1,$2,$3)", [
    consentId,
    f.request.actor.appId,
    f.request.actor.actorUserId,
  ]);
  await client.query(
    `INSERT INTO app_client_registrations(id,app_id,owner_organization_id,billing_environment,secret_hashes,redirect_uris,allowed_scopes) VALUES ($1,$2,$3,'test',$4::jsonb,'["https://example.test/callback"]','["identity","inference"]')`,
    [clientId, f.request.actor.appId, f.developer, JSON.stringify([hash(secret)])],
  );
  await client.query(
    `INSERT INTO app_delegations(token_hash,authorization_code_hash,client_id,app_id,user_id,consent_id,organization_id,registration_revision,scopes,expires_at) VALUES ($1,$2,$3,$4,$5,$6,$7,1,'["identity","inference"]',now()+interval '1 day')`,
    [
      hash(token),
      hash(randomUUID()),
      clientId,
      f.request.actor.appId,
      f.request.actor.actorUserId,
      consentId,
      f.buyerOrg,
    ],
  );
  const { Hono } = await import("hono");
  const { createAppInferenceRoute } = await import(
    "../../../../api/v1/apps/[id]/inference/chat/completions/route"
  );
  const { admitAppSubscriptionInference, appInferenceErrorResponse } = await import(
    "./app-subscription-inference-admission"
  );
  const { settlementDigest } = await import("./settlement-digest");
  const { ElizaCloudClient } = await import("../../../../sdk/src/client");
  let providerCalls = 0;
  // The external provider and infrastructure credential are controlled fixtures; delegation and money repositories are real.
  const router = new Hono<import("../../types/cloud-worker-env").AppEnv>();
  router.route(
    "/api/v1/apps/:id/inference/chat/completions",
    createAppInferenceRoute(async (request, options) => {
      if (
        request.headers.get("Authorization") !== "Bearer eliza_controlled_developer" ||
        request.headers.has("X-App-Delegation") ||
        request.headers.has("Cookie")
      )
        return new Response("Credential transport failed", { status: 401 });
      if (!options?.appFundingActor) throw new Error("Missing delegated actor");
      const body = await request.json();
      try {
        const admission = await admitAppSubscriptionInference({
          actor: options.appFundingActor,
          developerOrganizationId: f.developer,
          developerAppScopeId: f.request.actor.appId,
          logicalOperationId: request.headers.get("Idempotency-Key") ?? "",
          requestDigest: settlementDigest(body),
          estimatedCostUsd: 2,
          revalidateDeveloperCredential: async () => {},
        });
        await admission.markProviderDispatched();
        providerCalls++;
        if (request.headers.get("Idempotency-Key") === "operation:known-failure") {
          await admission.settle(0);
          return Response.json(
            { error: { message: "Controlled provider rejected request" } },
            { status: 422 },
          );
        }
        await admission.settle(1.25);
        return Response.json({
          choices: [{ message: { role: "assistant", content: "controlled model receipt" } }],
        });
      } catch (error) {
        // error-policy:J1 This harness translates the same typed money failures as the production gateway.
        const response = appInferenceErrorResponse(error);
        if (response) return response;
        throw error;
      }
    }),
  );
  const executionContext = {
    waitUntil: (_promise: Promise<unknown>) => {},
    passThroughOnException: () => {},
  };
  let mode: "test" | "live" = "test";
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (request) =>
      router.fetch(
        request,
        {
          DATABASE_URL: process.env.DATABASE_URL,
          APP_INFERENCE_EXECUTION_ENVIRONMENT: mode,
        } as import("../../types/cloud-worker-env").Bindings,
        executionContext,
      ),
  });
  try {
    const sdk = new ElizaCloudClient({ apiBaseUrl: server.url.href }).appInference(
      f.request.actor.appId,
      { clientId, clientSecret: secret, developerApiKey: "eliza_controlled_developer" },
    );
    const operation = {
      billingAccountId: f.request.actor.billingAccountId,
      productFamilyKey: "main",
      delegationToken: token,
      operationId: "operation:known-failure",
    };
    const body = {
      model: "controlled-model",
      messages: [{ role: "user" as const, content: "Preserved customer request" }],
    };
    await expect(sdk.createChatCompletion(operation, body)).rejects.toMatchObject({
      statusCode: 422,
    });
    expect(providerCalls).toBe(1);
    expect(await balances(f.developer, f.scopeId)).toMatchObject({
      cash: "42.000000",
      available: "5.000000",
      reserved: "0.000000",
    });
    await expect(sdk.createChatCompletion(operation, body)).rejects.toMatchObject({
      statusCode: 409,
      errorBody: { code: "APP_INFERENCE_OPERATION_COMPLETE" },
    });
    expect(providerCalls).toBe(1);
    mode = "live";
    await expect(
      sdk.createChatCompletion({ ...operation, operationId: "operation:mode-denied" }, body),
    ).rejects.toMatchObject({ statusCode: 403, errorBody: { code: "APP_INFERENCE_ENVIRONMENT" } });
    expect(providerCalls).toBe(1);
    mode = "test";
    const successful = { ...operation, operationId: "operation:succeeded" };
    expect((await sdk.createChatCompletion(successful, body)).choices?.[0]?.message?.content).toBe(
      "controlled model receipt",
    );
    expect(providerCalls).toBe(2);
    expect(await balances(f.developer, f.scopeId)).toMatchObject({
      cash: "40.750000",
      available: "3.750000",
      reserved: "0.000000",
    });
    await client.query("UPDATE app_delegations SET revoked_at=now() WHERE token_hash=$1", [
      hash(token),
    ]);
    await expect(
      sdk.createChatCompletion({ ...operation, operationId: "operation:revoked" }, body),
    ).rejects.toMatchObject({ statusCode: 401, errorBody: { code: "APP_GRANT_REVOKED" } });
    expect(providerCalls).toBe(2);
  } finally {
    server.stop(true);
  }
});
