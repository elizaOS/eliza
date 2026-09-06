/**
 * Exercises signed webhook HTTP intake, actual Stripe SDK observations, PostgreSQL leases/finalization and signed app callback HTTP.
 * Set APP_DELIVERY_TEST_POSTGRES_URL to run the same contract in an isolated PostgreSQL schema.
 */
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Client } from "pg";

const postgresUrl = process.env.APP_DELIVERY_TEST_POSTGRES_URL;
const schema = `app_delivery_${randomUUID().replaceAll("-", "_")}`;
let postgres: Client | null = null;
const repositoryUrl = postgresUrl ? new URL(postgresUrl) : null;
if (repositoryUrl) repositoryUrl.searchParams.set("options", `-c search_path=${schema},public`);
process.env.DATABASE_URL = repositoryUrl?.toString() ?? "pglite://memory";
process.env.TEST_DATABASE_URL = process.env.DATABASE_URL;
process.env.LOCAL_PG_POOL_MAX = "4";
process.env.NODE_ENV ||= "test";
process.env.SECRETS_MASTER_KEY = randomBytes(32).toString("hex");
process.env.STRIPE_SECRET_KEY = "sk_test_delivery_fixture";
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
    CREATE TABLE organizations(id uuid PRIMARY KEY,is_active boolean NOT NULL DEFAULT true,account_lifecycle_state text NOT NULL DEFAULT 'active',paid_work_fenced_at timestamptz,stripe_customer_id text,credit_balance numeric(16,6) NOT NULL DEFAULT 42,balance_revision bigint NOT NULL DEFAULT 0,settings jsonb NOT NULL DEFAULT '{}',updated_at timestamp NOT NULL DEFAULT now());
    CREATE TABLE users(id uuid PRIMARY KEY,is_active boolean NOT NULL DEFAULT true,deleted_at timestamptz,email_verified boolean NOT NULL DEFAULT true,organization_id uuid REFERENCES organizations(id),email text,name text,is_anonymous boolean NOT NULL DEFAULT false,expires_at timestamptz,account_lifecycle_state text NOT NULL DEFAULT 'active',auth_fenced_at timestamptz);
    CREATE TABLE apps(id uuid PRIMARY KEY,organization_id uuid NOT NULL REFERENCES organizations(id),is_active boolean NOT NULL DEFAULT true,is_approved boolean NOT NULL DEFAULT true,review_status text NOT NULL DEFAULT 'approved',name text NOT NULL DEFAULT 'Delivery test app',allowed_origins text[] NOT NULL DEFAULT ARRAY['https://app.example'],app_url text NOT NULL DEFAULT 'https://app.example');
    CREATE TABLE credit_transactions(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),organization_id uuid NOT NULL REFERENCES organizations(id),user_id uuid REFERENCES users(id),amount numeric(16,6) NOT NULL,type text NOT NULL,description text,metadata jsonb NOT NULL DEFAULT '{}',stripe_payment_intent_id text UNIQUE,created_at timestamp NOT NULL DEFAULT now(),settled_at timestamp,CONSTRAINT credit_transactions_id_org_idx UNIQUE(id,organization_id));
    CREATE TABLE app_users(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),app_id uuid REFERENCES apps(id),user_id uuid REFERENCES users(id));
    CREATE TABLE provider_admissions(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),organization_id uuid NOT NULL REFERENCES organizations(id),operation_kind text NOT NULL,operation_id uuid NOT NULL,admitted_at timestamptz NOT NULL,released_at timestamptz,UNIQUE(operation_kind,operation_id));
    CREATE TABLE webhook_events(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),event_id text NOT NULL UNIQUE,provider text NOT NULL,event_type text,payload_hash text NOT NULL,source_ip text,processed_at timestamp NOT NULL DEFAULT now(),event_timestamp timestamp);
    CREATE TABLE auth_events(event_id uuid PRIMARY KEY,ts timestamptz NOT NULL DEFAULT now(),actor_type text NOT NULL,actor_id text NOT NULL,action text NOT NULL,result text NOT NULL,resource_type text,resource_id text,ip text,ua text,request_id text,org_id text,metadata jsonb,expires_at timestamptz NOT NULL DEFAULT now()+interval '7 years');
    CREATE TABLE organization_encryption_keys(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),organization_id uuid NOT NULL UNIQUE REFERENCES organizations(id),encrypted_dek text NOT NULL,key_version integer NOT NULL DEFAULT 1,algorithm text NOT NULL DEFAULT 'aes-256-gcm',created_at timestamp NOT NULL DEFAULT now(),rotated_at timestamp);
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
    targetPlanRevisionId: planRevisionId,
    quantity: 1,
    idempotencyKey: `checkout:${key}`,
    requestDigest: digest,
    expectedSubscriptionRevision: null,
    payload: { version: 1, domain: "buyer", action: "trial", planRevisionId, quantity: 1 },
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
  return {
    input,
    observation,
    app,
    plan,
    principal,
    merchantId,
    providerAccountId,
    trial,
    projection,
    buyerOrg,
    developer,
    accountId: prepared.account.id,
    scopeId: prepared.scope.scopeId,
  };
}

async function providerFixture(f: Awaited<ReturnType<typeof fixture>>) {
  const Stripe = (await import("stripe")).default;
  const { createGenericBillingProvider } = await import("./generic-billing-provider");
  const { appBillingProviderBindings } = await import(
    "../../db/repositories/app-billing-provider-bindings"
  );
  const state = {
    value: { ...f.observation.value },
    fail: false,
    beforeReply: null as null | (() => Promise<void>),
  };
  const requests: string[] = [];
  const stripe = new Stripe("sk_test_controlled_delivery", {
    maxNetworkRetries: 0,
    httpClient: Stripe.createFetchHttpClient(async (input, init) => {
      const path = new URL(String(input)).pathname,
        headers = new Headers(init?.headers);
      expect(headers.get("stripe-account")).toBe(f.providerAccountId);
      expect(headers.get("stripe-version")).toBe("2024-11-20.acacia");
      requests.push(path);
      if (state.fail) throw new Error("Controlled provider transport unavailable");
      let result: unknown;
      if (path === "/v1/balance") result = { object: "balance", livemode: false };
      else if (path === `/v1/customers/${f.observation.value.customerId}`)
        result = {
          id: f.observation.value.customerId,
          object: "customer",
          livemode: false,
          metadata: {},
        };
      else if (path === `/v1/subscriptions/${state.value.subscriptionId}`) {
        const v = { ...state.value };
        if (state.beforeReply) {
          const callback = state.beforeReply;
          state.beforeReply = null;
          await callback();
        }
        result = {
          id: v.subscriptionId,
          object: "subscription",
          customer: v.customerId,
          livemode: false,
          metadata: {},
          status: v.status,
          current_period_start: v.currentPeriodStart,
          current_period_end: v.currentPeriodEnd,
          trial_start: v.trialStart,
          trial_end: v.trialEnd,
          cancel_at_period_end: v.cancelAtPeriodEnd,
          canceled_at: v.canceledAt,
          ended_at: v.endedAt,
          latest_invoice: v.latestInvoiceId,
          pending_update: v.pendingUpdate ? { expires_at: v.currentPeriodEnd } : null,
          items: {
            has_more: false,
            data: [
              {
                id: v.itemId,
                quantity: v.quantity,
                price: {
                  id: v.priceId,
                  object: "price",
                  active: true,
                  livemode: false,
                  product: v.productId,
                  currency: "usd",
                  unit_amount: 3000,
                  type: "recurring",
                  billing_scheme: "per_unit",
                  transform_quantity: null,
                  recurring: {
                    interval: "month",
                    interval_count: 1,
                    usage_type: "licensed",
                    trial_period_days: null,
                  },
                },
              },
            ],
          },
        };
      } else throw new Error(`Unexpected controlled Stripe endpoint: ${path}`);
      return new Response(JSON.stringify(result), {
        headers: { "content-type": "application/json" },
      });
    }),
  });
  const provider = createGenericBillingProvider(
    stripe,
    {
      merchantId: f.merchantId,
      kind: "connected",
      stripeAccountId: f.providerAccountId,
      livemode: false,
    },
    appBillingProviderBindings,
  );
  const { AppBillingReconciliation } = await import("./app-billing-reconciliation");
  const recovered: Array<{ scopeId: string; commandId: string }> = [];
  const worker = new AppBillingReconciliation({
    provider: async () => provider,
    reconcileCommand: async (input) => {
      recovered.push(input);
    },
  });
  return { state, requests, provider, worker, recovered };
}
async function triggerFor(
  f: Awaited<ReturnType<typeof fixture>>,
  created = Math.floor(Date.now() / 1000),
) {
  const { appBillingTriggerFromVerifiedEvent } = await import("./app-billing-webhook-intake");
  const event = {
    id: `evt_${randomUUID().replaceAll("-", "")}`,
    type: "customer.subscription.updated",
    created,
    api_version: "2024-11-20.acacia",
    livemode: false,
    account: f.providerAccountId,
    data: {
      object: {
        id: f.observation.value.subscriptionId,
        object: "subscription",
        customer: f.observation.value.customerId,
        metadata: {},
      },
    },
  };
  const body = JSON.stringify(event),
    result = await appBillingTriggerFromVerifiedEvent(event, body);
  if (!result) throw new Error("Fixture event was not recognized");
  return { ...result, event, body };
}
async function current(scopeId: string) {
  return (
    await client.query(
      "SELECT s.status,s.lifecycle_revision::int revision,e.entitlement_effective effective,e.access access FROM billing_subscriptions s JOIN organization_entitlements e ON e.source_subscription_id=s.id WHERE s.billing_scope_id=$1",
      [scopeId],
    )
  ).rows[0];
}

describe("generic subscription webhook and delivery", () => {
  test("signed HTTP intake survives failed queue handoff and duplicate delivery, with cancellation winning stale event timestamps", async () => {
    const f = await fixture(),
      wire = await providerFixture(f),
      t = await triggerFor(f);
    const { Hono } = await import("hono");
    const { handleStripeWebhook } = await import("../../../../api/stripe/webhook/route");
    const Stripe = (await import("stripe")).default;
    const signing = new Stripe("sk_test_signature_fixture"),
      secret = "whsec_delivery_test";
    let enqueues = 0;
    const app = new Hono<import("../../types/cloud-worker-env").AppEnv>();
    app.post("/", (c) =>
      handleStripeWebhook(c, async () => {
        enqueues++;
        throw new Error("Controlled Redis outage");
      }),
    );
    app.onError((_error, c) => c.json({ error: "Unavailable" }, 503));
    const server = Bun.serve({
      port: 0,
      fetch: (request) =>
        app.fetch(request, {
          STRIPE_WEBHOOK_SECRET: secret,
          STRIPE_TEST_WEBHOOK_SECRET: "whsec_secondary_test",
        }),
    });
    try {
      const headers = {
        "stripe-signature": await signing.webhooks.generateTestHeaderStringAsync({
          payload: t.body,
          secret,
        }),
      };
      const first = await fetch(server.url, { method: "POST", body: t.body, headers });
      expect(first.status).toBe(503);
      const duplicate = await fetch(server.url, { method: "POST", body: t.body, headers });
      expect(duplicate.status).toBe(200);
      expect(enqueues).toBe(1);
      const changedBody = JSON.stringify({ ...t.event, created: t.event.created - 1 });
      const changed = await fetch(server.url, {
        method: "POST",
        body: changedBody,
        headers: {
          "stripe-signature": await signing.webhooks.generateTestHeaderStringAsync({
            payload: changedBody,
            secret,
          }),
        },
      });
      expect(changed.status).toBe(409);
      const invalid = await fetch(server.url, {
        method: "POST",
        body: t.body,
        headers: { "stripe-signature": "t=0,v1=invalid" },
      });
      expect(invalid.status).toBe(400);
      const liveBody = JSON.stringify({ ...t.event, livemode: true });
      const testSignedLive = await fetch(server.url, {
        method: "POST",
        body: liveBody,
        headers: {
          "stripe-signature": await signing.webhooks.generateTestHeaderStringAsync({
            payload: liveBody,
            secret: "whsec_secondary_test",
          }),
        },
      });
      expect(testSignedLive.status).toBe(400);
      await expect(
        client.query(
          'UPDATE webhook_events SET app_billing_trigger=app_billing_trigger || \'{"merchantKey":"platform"}\'::jsonb WHERE event_id=$1',
          [t.receiptKey],
        ),
      ).rejects.toThrow("immutable");
      await expect(
        client.query("DELETE FROM webhook_events WHERE event_id=$1", [t.receiptKey]),
      ).rejects.toThrow("durable recovery");
      wire.state.value.status = "canceled";
      wire.state.value.canceledAt = Math.floor(Date.now() / 1000);
      wire.state.value.endedAt = wire.state.value.canceledAt;
      await wire.worker.processPersisted(t.receiptKey, t.trigger);
      expect(await current(f.scopeId)).toMatchObject({
        status: "canceled",
        effective: false,
        revision: 2,
      });
      const old = await triggerFor(f, t.event.created - 100);
      await wire.worker.processTrigger(old.trigger);
      expect(await current(f.scopeId)).toMatchObject({
        status: "canceled",
        effective: false,
        revision: 3,
      });
      await wire.worker.processTrigger(t.trigger);
      expect(await current(f.scopeId)).toMatchObject({
        status: "canceled",
        effective: false,
        revision: 3,
      });
      expect(
        (
          await client.query(
            "SELECT count(*)::int count FROM subscription_allowance_transactions WHERE billing_scope_id=$1 AND kind='grant'",
            [f.scopeId],
          )
        ).rows,
      ).toEqual([{ count: 1 }]);
    } finally {
      server.stop(true);
    }
  });
  test("a losing event worker cannot apply an old observation after another worker advances the scope", async () => {
    const f = await fixture(),
      wire = await providerFixture(f),
      t = await triggerFor(f);
    const { appSubscriptionFinalizer } = await import(
      "../../db/repositories/app-subscription-finalizer"
    );
    wire.state.beforeReply = async () => {
      await appSubscriptionFinalizer.applyObservation({
        ...f.input,
        command: null,
        expectedSubscriptionRevision: 1,
        subscription: {
          ...f.observation,
          digest: "b".repeat(64),
          value: {
            ...f.observation.value,
            status: "canceled",
            canceledAt: Math.floor(Date.now() / 1000),
            endedAt: Math.floor(Date.now() / 1000),
          },
        },
      });
    };
    await expect(wire.worker.processTrigger(t.trigger)).rejects.toThrow("stale");
    expect(await current(f.scopeId)).toMatchObject({
      status: "canceled",
      effective: false,
      revision: 2,
    });
    expect(
      (
        await client.query(
          "SELECT status,error_code FROM billing_subscription_event_receipts WHERE provider_event_id=$1",
          [t.event.id],
        )
      ).rows,
    ).toMatchObject([{ status: "failed" }]);
    wire.state.value.status = "canceled";
    wire.state.value.canceledAt = Math.floor(Date.now() / 1000);
    wire.state.value.endedAt = wire.state.value.canceledAt;
    await wire.worker.processTrigger(t.trigger);
    expect(await current(f.scopeId)).toMatchObject({ status: "canceled", effective: false });
  });
  test("periodic lease expiry and provider failure retain denial and recoverable scope state", async () => {
    const f = await fixture(),
      wire = await providerFixture(f);
    await client.query(
      "UPDATE app_billing_scopes SET reconcile_after=now()+interval '1 hour' WHERE id<>$1",
      [f.scopeId],
    );
    const claim = await wire.worker.claimPeriodic();
    if (!claim) throw new Error("No scope claim");
    await client.query(
      "UPDATE app_billing_scopes SET reconcile_lease_expires_at=now()-interval '1 second' WHERE id=$1",
      [f.scopeId],
    );
    await expect(wire.worker.reconcilePeriodic(claim)).rejects.toThrow("lease");
    expect(await current(f.scopeId)).toMatchObject({ revision: 1 });
    await client.query(
      "UPDATE app_billing_scopes SET fenced_at=now(),reconcile_after=now() WHERE id=$1",
      [f.scopeId],
    );
    const next = await wire.worker.claimPeriodic();
    if (!next) throw new Error("No scope retry");
    wire.state.fail = true;
    await expect(wire.worker.reconcilePeriodic(next)).rejects.toThrow();
    wire.state.fail = false;
    await client.query("UPDATE app_billing_scopes SET reconcile_after=now() WHERE id=$1", [
      f.scopeId,
    ]);
    const final = await wire.worker.claimPeriodic();
    if (!final) throw new Error("No final scope retry");
    await wire.worker.reconcilePeriodic(final);
    expect(await current(f.scopeId)).toMatchObject({ effective: false, access: "denied" });
  });
  test("unknown first provider objects only select an exact original command and never invent a binding", async () => {
    const f = await fixture(),
      wire = await providerFixture(f),
      t = await triggerFor(f);
    const unknown = {
      ...t.trigger,
      event: { ...t.trigger.event, objectId: "sub_unknown" },
      subscriptionIdHint: "sub_unknown",
    };
    await expect(wire.worker.processTrigger(unknown)).rejects.toThrow("original durable");
    expect(wire.recovered).toHaveLength(0);
    expect(
      (
        await client.query(
          "SELECT count(*)::int count FROM billing_subscriptions WHERE billing_scope_id=$1",
          [f.scopeId],
        )
      ).rows,
    ).toEqual([{ count: 1 }]);
    await expect(
      wire.worker.processTrigger({
        ...unknown,
        event: { ...unknown.event, merchantId: randomUUID() },
      }),
    ).rejects.toThrow();
    expect(wire.requests).toHaveLength(0);
  });
  test("notification config, encrypted staged key rotation and HTTP retries preserve tenant mode and delivery identity", async () => {
    const f = await fixture();
    const registration = randomUUID();
    await client.query(
      "INSERT INTO app_client_registrations(id,app_id,owner_organization_id,billing_environment,secret_hashes,redirect_uris,allowed_scopes) VALUES($1,$2,$3,'test','[]','[]','[]')",
      [registration, f.app, f.developer],
    );
    const { AppBillingNotifications } = await import("./app-billing-notifications");
    const { verifyAppBillingNotification } = await import("@elizaos/cloud-sdk/app-notifications");
    const received: Array<{ body: string; headers: Headers }> = [];
    let responseCode = 503;
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        received.push({ body: await request.text(), headers: request.headers });
        return new Response(null, { status: responseCode });
      },
    });
    // Controlled local receiver substitutes network egress only; signing, encryption, leases and durable rows remain real.
    const notifications = new AppBillingNotifications(async (_url, init) =>
      fetch(server.url, init),
    );
    const owner = { appId: f.app, organizationId: f.developer, clientRegistrationId: registration };
    try {
      let config = await notifications.configure({
        ...owner,
        endpointUrl: "https://app.example/hooks/billing",
        enabled: false,
        expectedRevision: null,
      });
      await expect(
        notifications.configure({
          ...owner,
          endpointUrl: "https://other.example/hook",
          enabled: false,
          expectedRevision: config.revision,
        }),
      ).rejects.toThrow("registered application origin");
      await expect(notifications.read({ ...owner, organizationId: f.buyerOrg })).rejects.toThrow(
        "app owner",
      );
      const prepared = await notifications.prepareKey({
        ...owner,
        expectedRevision: config.revision,
      });
      config = await notifications.activateKey({
        ...owner,
        expectedRevision: prepared.config.revision,
        pendingKeyId: prepared.config.pendingKeyId!,
      });
      config = await notifications.configure({
        ...owner,
        endpointUrl: config.endpointUrl!,
        enabled: true,
        expectedRevision: config.revision,
      });
      const [claimA, claimB] = await Promise.all([notifications.claim(), notifications.claim()]);
      const claim = claimA ?? claimB;
      if (!claim) throw new Error("No delivery claim");
      expect(Number(Boolean(claimA)) + Number(Boolean(claimB))).toBe(1);
      expect(await notifications.deliver(claim)).toBe("retried");
      expect(received).toHaveLength(1);
      await client.query("UPDATE app_subscription_outbox SET next_attempt_at=now() WHERE id=$1", [
        claim.row.id,
      ]);
      const retry = await notifications.claim();
      if (!retry) throw new Error("No retry");
      responseCode = 204;
      expect(await notifications.deliver(retry)).toBe("delivered");
      expect(received[0].body).toBe(received[1].body);
      const verified = await verifyAppBillingNotification({
        secret: prepared.signingSecret,
        expectedAppId: f.app,
        expectedEnvironment: "test",
        body: received[1].body,
        timestamp: received[1].headers.get("X-Eliza-Timestamp")!,
        signature: received[1].headers.get("X-Eliza-Signature")!,
      });
      expect(verified.billingAccountId).toBe(f.accountId);
      expect(JSON.parse(received[1].body)).not.toHaveProperty("entitlement");
      await expect(
        verifyAppBillingNotification({
          secret: prepared.signingSecret,
          expectedAppId: f.app,
          expectedEnvironment: "live",
          body: received[1].body,
          timestamp: received[1].headers.get("X-Eliza-Timestamp")!,
          signature: received[1].headers.get("X-Eliza-Signature")!,
        }),
      ).rejects.toThrow("environment");
      const stored = JSON.stringify(
        (
          await client.query(
            "SELECT active_secret,pending_secret FROM app_billing_notification_endpoints WHERE app_id=$1",
            [f.app],
          )
        ).rows,
      );
      expect(stored).not.toContain(prepared.signingSecret);
      expect(stored).toContain("enc:v1:");
      const next = await notifications.prepareKey({ ...owner, expectedRevision: config.revision });
      await expect(
        notifications.activateKey({
          ...owner,
          expectedRevision: config.revision,
          pendingKeyId: next.config.pendingKeyId!,
        }),
      ).rejects.toThrow("changed");
      await notifications.activateKey({
        ...owner,
        expectedRevision: next.config.revision,
        pendingKeyId: next.config.pendingKeyId!,
      });
      expect((await notifications.read(owner)).lastDeliveredAt).not.toBeNull();
      expect(await notifications.deliver(retry)).toBe("stale");
      expect(received).toHaveLength(2);
    } finally {
      server.stop(true);
    }
  });
});

function paidInvoice(
  f: Awaited<ReturnType<typeof fixture>>,
  invoiceId: string,
): import("./generic-billing-provider-types").BillingProviderInvoice {
  const v = f.observation.value;
  return {
    hostedInvoiceUrl: null,
    invoiceId,
    subscriptionId: v.subscriptionId,
    customerId: v.customerId,
    chargeId: "ch_paid",
    paymentIntentId: "pi_paid",
    paidOutOfBand: false,
    payment: {
      paymentIntentId: "pi_paid",
      status: "succeeded",
      amountReceivedCents: 3000,
      customerId: v.customerId,
      currency: "usd",
      invoiceId,
    },
    status: "paid",
    paid: true,
    amountPaidCents: 3000,
    amountDueCents: 3000,
    billingReason: "subscription_cycle",
    subtotalCents: 3000,
    subtotalExcludingTaxCents: 3000,
    totalCents: 3000,
    taxCents: 0,
    discountCents: 0,
    currency: "usd",
    periodStart: v.currentPeriodStart,
    periodEnd: v.currentPeriodEnd,
    lines: [
      {
        lineId: "il_paid",
        lineType: "subscription",
        subscriptionId: v.subscriptionId,
        subscriptionItemId: v.itemId,
        priceId: v.priceId,
        quantity: 1,
        discountAmountsCents: [],
        taxAmountsCents: [],
        amountCents: 3000,
        periodStart: v.currentPeriodStart,
        periodEnd: v.currentPeriodEnd,
        proration: false,
      },
    ],
  };
}

test("a historical invoice trigger validates its association while only current paid invoice evidence funds access", async () => {
  const f = await fixture({ expiresSoon: true }),
    t = await triggerFor(f);
  await Bun.sleep(3000);
  f.observation.value.currentPeriodStart = f.trial.ends_at.getTime() / 1000;
  f.observation.value.currentPeriodEnd = f.observation.value.currentPeriodStart + 2_592_000;
  const { appSubscriptionFinalizer } = await import(
    "../../db/repositories/app-subscription-finalizer"
  );
  const latest = paidInvoice(f, "in_current"),
    old = {
      ...paidInvoice(f, "in_historical"),
      status: "open" as const,
      paid: false,
      payment: null,
      amountPaidCents: 0,
    };
  const input = {
    ...f.input,
    command: null,
    expectedSubscriptionRevision: 1,
    subscription: {
      ...f.observation,
      digest: "c".repeat(64),
      value: {
        ...f.observation.value,
        status: "active" as const,
        latestInvoiceId: latest.invoiceId,
      },
    },
    invoice: { ...f.observation, value: latest },
    eventInvoice: { ...f.observation, value: old },
    event: { ...t.trigger.event, objectType: "invoice", objectId: old.invoiceId },
  };
  await expect(
    appSubscriptionFinalizer.applyObservation({
      ...input,
      eventInvoice: { ...input.eventInvoice, value: { ...old, subscriptionId: "sub_foreign" } },
    }),
  ).rejects.toThrow("another subscription scope");
  const applied = await appSubscriptionFinalizer.applyObservation(input);
  expect(applied.entitlement.entitlement_effective).toBe(true);
  expect(
    (
      await client.query(
        "SELECT stripe_invoice_id FROM app_subscription_paid_periods WHERE billing_scope_id=$1",
        [f.scopeId],
      )
    ).rows,
  ).toEqual([{ stripe_invoice_id: "in_current" }]);
});

test("an authorized cancellation completes after a webhook revision only with current CAS, lease and original timing", async () => {
  const f = await fixture();
  const command = await repository.prepareCommand({
    scopeId: f.scopeId,
    actorUserId: f.principal,
    kind: "cancel",
    targetPlanRevisionId: null,
    quantity: 1,
    idempotencyKey: `cancel:${randomUUID()}`,
    requestDigest: digest,
    expectedSubscriptionRevision: 1,
    payload: { version: 1, domain: "buyer", action: "cancel", timing: "period_end" },
  });
  const { appBillingCommandRuntimeRepository } = await import(
    "../../db/repositories/app-billing-command-runtime"
  );
  const claim = await appBillingCommandRuntimeRepository.claim({
    scopeId: f.scopeId,
    commandId: command.id,
    actorUserId: f.principal,
  });
  if (!claim) throw new Error("No command lease");
  const { appSubscriptionFinalizer } = await import(
    "../../db/repositories/app-subscription-finalizer"
  );
  const observed = {
    ...f.observation,
    digest: "d".repeat(64),
    value: { ...f.observation.value, cancelAtPeriodEnd: true },
  };
  await appSubscriptionFinalizer.applyObservation({
    ...f.input,
    command: null,
    expectedSubscriptionRevision: 1,
    subscription: observed,
  });
  const input = {
    ...f.input,
    subscription: observed,
    expectedSubscriptionRevision: 2,
    command: {
      id: command.id,
      stateRevision: claim.lease.stateRevision,
      executionGeneration: claim.lease.executionGeneration,
      leaseToken: claim.lease.token,
    },
  };
  await expect(appSubscriptionFinalizer.applyObservation(input)).rejects.toThrow("execution fence");
  await expect(
    appSubscriptionFinalizer.applyObservation({
      ...input,
      commandReconciliation: true,
      expectedSubscriptionRevision: 1,
    }),
  ).rejects.toThrow("stale");
  await expect(
    appSubscriptionFinalizer.applyObservation({
      ...input,
      commandReconciliation: true,
      command: { ...input.command, leaseToken: randomUUID() },
    }),
  ).rejects.toThrow("execution fence");
  const result = await appSubscriptionFinalizer.applyObservation({
    ...input,
    commandReconciliation: true,
  });
  expect(result.subscription.cancel_at_period_end).toBe(true);
  expect(
    (
      await client.query("SELECT status FROM billing_subscription_commands WHERE id=$1", [
        command.id,
      ])
    ).rows,
  ).toEqual([{ status: "APPLIED" }]);
  const immediate = await fixture();
  const second = await repository.prepareCommand({
    scopeId: immediate.scopeId,
    actorUserId: immediate.principal,
    kind: "cancel",
    targetPlanRevisionId: null,
    quantity: 1,
    idempotencyKey: `cancel:${randomUUID()}`,
    requestDigest: digest,
    expectedSubscriptionRevision: 1,
    payload: { version: 1, domain: "buyer", action: "cancel", timing: "immediate" },
  });
  const secondClaim = await appBillingCommandRuntimeRepository.claim({
    scopeId: immediate.scopeId,
    commandId: second.id,
    actorUserId: immediate.principal,
  });
  if (!secondClaim) throw new Error("No immediate command lease");
  await expect(
    appSubscriptionFinalizer.applyObservation({
      ...immediate.input,
      expectedSubscriptionRevision: 1,
      subscription: {
        ...immediate.observation,
        value: { ...immediate.observation.value, cancelAtPeriodEnd: true },
      },
      command: {
        id: second.id,
        stateRevision: secondClaim.lease.stateRevision,
        executionGeneration: secondClaim.lease.executionGeneration,
        leaseToken: secondClaim.lease.token,
      },
      commandReconciliation: true,
    }),
  ).rejects.toThrow("original authorized command");
});

test("reconciliation cannot complete an unpaid or pending plan target after another worker changed the revision", async () => {
  const f = await fixture();
  const { dbWrite } = await import("../../db/helpers"),
    { billingSubscriptionCommands } = await import(
      "../../db/schemas/subscription-billing-operations"
    );
  const id = randomUUID(),
    key = `update:${id}`;
  await dbWrite.insert(billingSubscriptionCommands).values({
    id,
    app_id: f.app,
    livemode: false,
    merchant_id: f.merchantId,
    billing_scope_id: f.scopeId,
    merchant_key: f.providerAccountId,
    organization_id: f.developer,
    subscription_id: f.projection.subscription.id,
    requested_by_user_id: f.principal,
    kind: "upgrade",
    target_quantity: 2,
    target_plan_revision_id: f.plan,
    target_plan_key: "basic",
    expected_subscription_revision: 1,
    idempotency_key: key,
    provider_idempotency_key: key,
    request_digest: digest,
    request_payload: {
      version: 1,
      domain: "buyer",
      action: "update",
      planRevisionId: f.plan,
      quantity: 2,
      quoteId: randomUUID(),
      billingConsent: "accepted",
    },
  });
  const { appBillingCommandRuntimeRepository } = await import(
      "../../db/repositories/app-billing-command-runtime"
    ),
    { appSubscriptionFinalizer } = await import("../../db/repositories/app-subscription-finalizer");
  const claim = await appBillingCommandRuntimeRepository.claim({
    scopeId: f.scopeId,
    commandId: id,
    actorUserId: f.principal,
  });
  if (!claim) throw new Error("No update lease");
  await appSubscriptionFinalizer.applyObservation({
    ...f.input,
    command: null,
    expectedSubscriptionRevision: 1,
    subscription: { ...f.observation, digest: "e".repeat(64) },
  });
  const input = {
    ...f.input,
    expectedSubscriptionRevision: 2,
    command: {
      id,
      stateRevision: claim.lease.stateRevision,
      executionGeneration: claim.lease.executionGeneration,
      leaseToken: claim.lease.token,
    },
    commandReconciliation: true as const,
    subscription: {
      ...f.observation,
      digest: "f".repeat(64),
      value: { ...f.observation.value, status: "active" as const, quantity: 2 },
    },
  };
  await expect(appSubscriptionFinalizer.applyObservation(input)).rejects.toThrow(
    "original authorized command",
  );
  await expect(
    appSubscriptionFinalizer.applyObservation({
      ...input,
      subscription: {
        ...input.subscription,
        value: { ...input.subscription.value, pendingUpdate: true },
      },
    }),
  ).rejects.toThrow("Pending provider updates");
  expect(
    (await client.query("SELECT status FROM billing_subscription_commands WHERE id=$1", [id])).rows,
  ).toEqual([{ status: "OUTCOME_UNKNOWN" }]);
  expect(
    (
      await client.query(
        "SELECT count(*)::int count FROM app_subscription_paid_periods WHERE billing_scope_id=$1",
        [f.scopeId],
      )
    ).rows,
  ).toEqual([{ count: 0 }]);
});

test("command recovery schedules revoked actors fairly without changing their provider outcome", async () => {
  const first = await fixture(),
    second = await fixture();
  const commands = [];
  for (const f of [first, second])
    commands.push(
      await repository.prepareCommand({
        scopeId: f.scopeId,
        actorUserId: f.principal,
        kind: "cancel",
        targetPlanRevisionId: null,
        quantity: 1,
        idempotencyKey: `cancel:${randomUUID()}`,
        requestDigest: digest,
        expectedSubscriptionRevision: 1,
        payload: { version: 1, domain: "buyer", action: "cancel", timing: "period_end" },
      }),
    );
  await client.query(
    "UPDATE app_billing_scopes SET command_reconcile_after=now()+interval '1 hour' WHERE id NOT IN ($1,$2)",
    [first.scopeId, second.scopeId],
  );
  await client.query(
    "UPDATE app_billing_scopes SET command_reconcile_after=now()-interval '1 minute' WHERE id=$1",
    [first.scopeId],
  );
  await client.query("UPDATE users SET is_active=false WHERE id=$1", [first.principal]);
  const { appBillingCommandRuntimeRepository } = await import(
    "../../db/repositories/app-billing-command-runtime"
  );
  const { AppBillingReconciliation } = await import("./app-billing-reconciliation");
  const attempted: string[] = [];
  const worker = new AppBillingReconciliation({
    provider: async () => {
      throw new Error("No provider call is authorized");
    },
    reconcileCommand: async (input) => {
      attempted.push(input.commandId);
      const f = input.scopeId === first.scopeId ? first : second;
      await appBillingCommandRuntimeRepository.claim({ ...input, actorUserId: f.principal });
    },
  });
  expect(await worker.recoverCommands(1)).toEqual({ processed: 0, failed: 1 });
  expect(await worker.recoverCommands(1)).toEqual({ processed: 1, failed: 0 });
  expect(attempted).toEqual(commands.map((c) => c.id));
  expect(
    (
      await client.query("SELECT status FROM billing_subscription_commands WHERE id=$1", [
        commands[0]!.id,
      ])
    ).rows,
  ).toEqual([{ status: "PREPARED" }]);
  const t = await triggerFor(second),
    wire = await providerFixture(second);
  await wire.worker.processTrigger({
    ...t.trigger,
    event: { ...t.trigger.event, objectId: "sub_unknown_recovery" },
    subscriptionIdHint: "sub_unknown_recovery",
    commandIdHint: commands[1]!.id,
    requestDigestHint: digest,
  });
  expect(wire.recovered).toEqual([{ scopeId: second.scopeId, commandId: commands[1]!.id }]);
  expect(wire.requests).toHaveLength(0);
});

test("late Checkout delivery for an applied command is acknowledged without repeating the purchase", async () => {
  const f = await fixture(),
    wire = await providerFixture(f),
    t = await triggerFor(f);
  const hint = {
    ...t.trigger,
    event: { ...t.trigger.event, objectType: "checkout.session", objectId: "cs_late" },
    subscriptionIdHint: f.observation.value.subscriptionId,
    commandIdHint: f.input.command!.id,
    requestDigestHint: digest,
  };
  expect(await wire.worker.processTrigger(hint)).toBe("command_reconciled");
  expect(wire.recovered).toHaveLength(0);
  expect(wire.requests).toHaveLength(0);
  expect(await current(f.scopeId)).toMatchObject({ revision: 1, effective: true });
});

test("delivery migration backfills existing acknowledgements under the prior immutable-source guard", async () => {
  const f = await fixture();
  await client.exec(
    "DROP TRIGGER app_subscription_outbox_delivery_authority ON app_subscription_outbox; ALTER TABLE app_subscription_outbox DROP CONSTRAINT app_subscription_outbox_delivery_check; CREATE TRIGGER app_subscription_outbox_app_source BEFORE INSERT OR UPDATE ON app_subscription_outbox FOR EACH ROW EXECUTE FUNCTION validate_subscription_app_source();",
  );
  await client.query(
    "UPDATE app_subscription_outbox SET delivered_at=now() WHERE billing_scope_id=$1",
    [f.scopeId],
  );
  const migration = await readFile(
    new URL("../../db/migrations/0397_app_subscription_outbox_delivery.sql", import.meta.url),
    "utf8",
  );
  for (const statement of migration.split("--> statement-breakpoint"))
    if (statement.trim()) await client.exec(statement);
  expect(
    (
      await client.query("SELECT state FROM app_subscription_outbox WHERE billing_scope_id=$1", [
        f.scopeId,
      ])
    ).rows,
  ).toEqual([{ state: "delivered" }]);
  await expect(
    client.query(
      "UPDATE app_subscription_outbox SET state='pending',delivered_at=null WHERE billing_scope_id=$1",
      [f.scopeId],
    ),
  ).rejects.toThrow("terminal");
});

test("an exact historical subscription event is ignored after its scope obtains a paid replacement", async () => {
  const f = await fixture({ expiresSoon: true }),
    wire = await providerFixture(f),
    t = await triggerFor(f);
  const { appSubscriptionFinalizer } = await import(
    "../../db/repositories/app-subscription-finalizer"
  );
  await appSubscriptionFinalizer.applyObservation({
    ...f.input,
    command: null,
    expectedSubscriptionRevision: 1,
    subscription: {
      ...f.observation,
      digest: "7".repeat(64),
      value: {
        ...f.observation.value,
        status: "canceled",
        canceledAt: Math.floor(Date.now() / 1000),
        endedAt: Math.floor(Date.now() / 1000),
      },
    },
  });
  await Bun.sleep(3000);
  const command = await repository.prepareCommand({
    scopeId: f.scopeId,
    actorUserId: f.principal,
    kind: "checkout",
    targetPlanRevisionId: f.plan,
    quantity: 1,
    idempotencyKey: `checkout:${randomUUID()}`,
    requestDigest: digest,
    expectedSubscriptionRevision: null,
    payload: {
      version: 1,
      domain: "buyer",
      action: "checkout",
      planRevisionId: f.plan,
      quantity: 1,
      billingConsent: "accepted",
      successUrl: "https://app.example/success",
      cancelUrl: "https://app.example/cancel",
    },
  });
  const { appBillingCommandRuntimeRepository } = await import(
    "../../db/repositories/app-billing-command-runtime"
  );
  const claim = await appBillingCommandRuntimeRepository.claim({
    scopeId: f.scopeId,
    commandId: command.id,
    actorUserId: f.principal,
  });
  if (!claim) throw new Error("No replacement command lease");
  const subscription = {
    ...f.observation,
    digest: "8".repeat(64),
    value: {
      ...f.observation.value,
      subscriptionId: `sub_replacement${randomUUID().replaceAll("-", "")}`,
      itemId: `si_replacement${randomUUID().replaceAll("-", "")}`,
      status: "active" as const,
      trialStart: null,
      trialEnd: null,
      currentPeriodStart: f.trial.ends_at.getTime() / 1000,
      currentPeriodEnd: f.trial.ends_at.getTime() / 1000 + 2_592_000,
      latestInvoiceId: "in_replacement",
    },
  };
  const invoice = paidInvoice({ ...f, observation: subscription }, "in_replacement");
  await appSubscriptionFinalizer.applyObservation({
    ...f.input,
    expectedSubscriptionRevision: null,
    subscription,
    invoice: { ...subscription, value: invoice },
    command: {
      id: command.id,
      stateRevision: claim.lease.stateRevision,
      executionGeneration: claim.lease.executionGeneration,
      leaseToken: claim.lease.token,
    },
  });
  expect(await wire.worker.processTrigger(t.trigger)).toBe("ignored");
  expect(await wire.worker.processTrigger(t.trigger)).toBe("replayed");
  expect(wire.requests).toHaveLength(0);
  expect(await current(f.scopeId)).toMatchObject({
    status: "active",
    revision: 1,
    effective: true,
  });
  expect(
    (
      await client.query(
        "SELECT status,disposition FROM billing_subscription_event_receipts WHERE provider_event_id=$1",
        [t.event.id],
      )
    ).rows,
  ).toEqual([{ status: "ignored", disposition: "superseded_scope_subscription" }]);
});
