/** Verifies sandbox migration setup and real runtime finalization against disposable PostgreSQL with controlled Stripe HTTP. */
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { createRuntimeStripeFixture } from "../src/lib/services/generic-billing-runtime.stripe-fixture";
import { hasCompletedSandboxEvent } from "./billing-sandbox-completion";
import { initializeBillingSandboxDatabase } from "./billing-sandbox-database";

const connection = process.env.APP_BILLING_TEST_POSTGRES_URL;
const schema = `sandbox_fixture_${randomUUID().replaceAll("-", "_")}`;
if (connection) {
  const url = new URL(connection);
  if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
    throw new Error("Local PostgreSQL required");
  url.searchParams.set("options", `-c search_path=${schema},public`);
  process.env.DATABASE_URL = url.toString();
  process.env.TEST_DATABASE_URL = url.toString();
}
setDefaultTimeout(120_000);
let db: Client;
describe.skipIf(!connection)("sandbox runtime database harness", () => {
  beforeAll(async () => {
    db = new Client({ connectionString: connection });
    await db.connect();
    await db.query("CREATE EXTENSION IF NOT EXISTS btree_gist WITH SCHEMA public");
    await db.query(`CREATE SCHEMA ${schema}`);
    await db.query(`SET search_path TO ${schema},public`);
    await initializeBillingSandboxDatabase(db);
  });
  afterAll(async () => {
    await (await import("../src/db/client")).closeDatabaseConnectionsForTests();
    if (db) {
      await db.query(`DROP SCHEMA ${schema} CASCADE`);
      await db.end();
    }
  });
  test("commits a seven-day, three-seat trial and durable source through the real runtime", async () => {
    const { appSubscriptionAuthorityRepository: authority } = await import(
      "../src/db/repositories/app-subscription-authority"
    );
    const { appBillingProviderBindings } = await import(
      "../src/db/repositories/app-billing-provider-bindings"
    );
    const { appBillingQueries } = await import("../src/db/repositories/app-billing-queries");
    const { GenericBillingRuntime } = await import("../src/lib/services/generic-billing-runtime");
    const { createGenericBillingProvider } = await import(
      "../src/lib/services/generic-billing-provider"
    );
    const fixture = createRuntimeStripeFixture();
    const org = randomUUID(),
      merchant = randomUUID(),
      appId = randomUUID(),
      actorUserId = randomUUID(),
      planId = randomUUID();
    await db.query("INSERT INTO organizations(id) VALUES($1)", [org]);
    await db.query("INSERT INTO users(id) VALUES($1)", [actorUserId]);
    await db.query("INSERT INTO apps(id,organization_id) VALUES($1,$2)", [appId, org]);
    await db.query(
      "INSERT INTO billing_merchants(id,organization_id,provider_account_key,stripe_account_id,livemode,enabled) VALUES($1,$2,'acct_runtime','acct_runtime',false,true)",
      [merchant, org],
    );
    await db.query(
      `INSERT INTO app_billing_plan_revisions(id,app_id,merchant_id,product_family_key,plan_key,revision,name,amount_cents,currency,interval,maximum_quantity,trial_allowance_usd,paid_allowance_usd,expired_access,entitlements,stripe_price_id,stripe_product_id,published_at) VALUES($1,$2,$3,'main','basic',1,'Basic',3000,'usd','month',10,'5.000000','25.000000','read_only','{"features":["inference"],"completionsRpm":60,"embeddingsRpm":60,"standardRpm":60,"strictRpm":10}','price_basic','prod_basic',now())`,
      [planId, appId, merchant],
    );
    const account = await authority.createAccount({
      appId,
      externalAccountKey: randomUUID(),
      displayName: "Sandbox",
      principalUserId: actorUserId,
    });
    const identity = {
      appId,
      actorUserId,
      billingAccountId: account.id,
      productFamilyKey: "main",
      livemode: false,
      clientRegistrationId: null,
    };
    const runtime = new GenericBillingRuntime(async () =>
      createGenericBillingProvider(
        fixture.stripe,
        {
          merchantId: merchant,
          kind: "connected",
          stripeAccountId: "acct_runtime",
          livemode: false,
        },
        appBillingProviderBindings,
      ),
    );
    const command = {
      idempotencyKey: randomUUID(),
      expectedSubscriptionRevision: null,
      payload: {
        version: 1 as const,
        domain: "buyer" as const,
        action: "trial" as const,
        planRevisionId: planId,
        quantity: 3,
      },
    };
    expect((await runtime.prepare(identity, command)).status).toBe("succeeded");
    expect((await runtime.prepare(identity, command)).status).toBe("succeeded");
    const snapshot = await appBillingQueries.snapshot(identity);
    expect(snapshot.kind).toBe("subscription");
    if (snapshot.kind !== "subscription") throw new Error("Missing trial");
    expect(snapshot.subscription.status).toBe("trialing");
    expect(snapshot.subscription.quantity).toBe(3);
    const claims = await db.query(
      "SELECT extract(epoch FROM ends_at-starts_at)::int AS seconds FROM app_subscription_trials",
    );
    expect(claims.rows).toEqual([{ seconds: 604800 }]);
    const persisted = await db.query("SELECT status FROM billing_subscription_commands");
    expect(persisted.rows).toEqual([{ status: "APPLIED" }]);
    const providerRecord = fixture.subscriptions.get(snapshot.subscription.stripe_subscription_id);
    if (!providerRecord) throw new Error("Missing provider subscription");
    providerRecord.canceled = true;
    const object = await fixture.stripe.subscriptions.retrieve(
      snapshot.subscription.stripe_subscription_id,
      {},
      { stripeAccount: "acct_runtime", apiVersion: "2024-11-20.acacia" },
    );
    const body = JSON.stringify({
      id: "evt_sandboxCanceled",
      object: "event",
      type: "customer.subscription.deleted",
      created: Math.floor(Date.now() / 1000),
      livemode: false,
      account: "acct_runtime",
      api_version: "2024-11-20.acacia",
      data: { object: { ...object, object: "subscription" } },
    });
    const { AppBillingReconciliation } = await import(
      "../src/lib/services/app-billing-reconciliation"
    );
    const reconciler = new AppBillingReconciliation({
      provider: async () =>
        createGenericBillingProvider(
          fixture.stripe,
          {
            merchantId: merchant,
            kind: "connected",
            stripeAccountId: "acct_runtime",
            livemode: false,
          },
          appBillingProviderBindings,
        ),
      reconcileCommand: (input) => runtime.reconcileCommand(input),
    });
    const { createRuntimeSandboxIngress } = await import("./billing-sandbox-ingress");
    const processed: string[] = [];
    const ingress = createRuntimeSandboxIngress({
      stripe: fixture.stripe,
      account: "acct_runtime",
      webhookSecret: "whsec_controlled",
      reconciler,
      onProcessed: async (id) => {
        processed.push(id);
      },
    });
    const signedRequest = async (payload: string) =>
      new Request("http://127.0.0.1/stripe/webhook", {
        method: "POST",
        body: payload,
        headers: {
          "stripe-signature": await fixture.stripe.webhooks.generateTestHeaderStringAsync({
            payload,
            secret: "whsec_controlled",
          }),
        },
      });
    expect(
      (await ingress(new Request("http://127.0.0.1/stripe/webhook", { method: "POST", body })))
        .status,
    ).toBe(400);
    expect(
      (await db.query("SELECT count(*)::int AS count FROM webhook_events")).rows[0].count,
    ).toBe(0);
    const subscriptionId = snapshot.subscription.stripe_subscription_id;
    const completed = () =>
      hasCompletedSandboxEvent(db, subscriptionId, "customer.subscription.deleted");
    expect(await completed()).toBe(false);
    // A provider outage leaves signed intake durable and prevents acceptance until canonical retry.
    fixture.subscriptions.delete(subscriptionId);
    expect((await ingress(await signedRequest(body))).status).toBe(503);
    expect(await completed()).toBe(false);
    fixture.subscriptions.set(subscriptionId, providerRecord);
    const retryDeadline = Date.now() + 90_000;
    while (!(await completed()) && Date.now() < retryDeadline) {
      await reconciler.recoverIntake();
      if (!(await completed())) await Bun.sleep(1000);
    }
    expect(await completed()).toBe(true);
    expect(await hasCompletedSandboxEvent(db, subscriptionId, "customer.subscription.paused")).toBe(
      false,
    );
    expect((await ingress(await signedRequest(body))).status).toBe(204);
    expect((await ingress(await signedRequest(body))).status).toBe(204);
    expect((await ingress(await signedRequest(`${body} `))).status).toBe(409);
    expect(
      (await db.query("SELECT count(*)::int AS count FROM webhook_events")).rows[0].count,
    ).toBe(1);
    expect(
      (
        await db.query(
          "SELECT count(*)::int AS count FROM billing_subscription_event_receipts WHERE status='applied'",
        )
      ).rows[0].count,
    ).toBe(1);
    expect(processed).toEqual(["evt_sandboxCanceled", "evt_sandboxCanceled"]);
    const canceled = await appBillingQueries.snapshot(identity);
    if (canceled.kind !== "subscription") throw new Error("Missing canceled subscription");
    expect(canceled.subscription.status).toBe("canceled");
  });
});
