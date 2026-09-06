/**
 * Exercises resume payment through real PostgreSQL, runtime and Stripe SDK with controlled HTTP.
 * A schema-local database clock seeds an elapsed trial, then restores wall time before checkout;
 * this deterministic integration harness does not represent live Stripe or real seven-day elapsed time.
 */
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Client } from "pg";
import type { BuyerBillingIdentity, GenericBillingRuntime } from "./generic-billing-runtime";
import { createRuntimeStripeFixture } from "./generic-billing-runtime.stripe-fixture";

const postgresUrl = process.env.APP_BILLING_TEST_POSTGRES_URL;
const schema = `app_resume_${randomUUID().replaceAll("-", "_")}`;
if (postgresUrl) {
  const repositoryUrl = new URL(postgresUrl);
  repositoryUrl.searchParams.set(
    "options",
    `-c search_path=${schema},pg_catalog,public -c timezone=America/New_York`,
  );
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
let commands: typeof import("../../db/repositories/app-billing-command-runtime").appBillingCommandRuntimeRepository;
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

describe.skipIf(!postgresUrl)("setup Checkout resume with PostgreSQL and Stripe HTTP", () => {
  beforeAll(async () => {
    db = new Client({ connectionString: postgresUrl });
    await db.connect();
    await db.query("CREATE EXTENSION IF NOT EXISTS btree_gist WITH SCHEMA public");
    await db.query(`CREATE SCHEMA ${schema}`);
    await db.query(`SET search_path TO ${schema},pg_catalog,public`);
    await db.query(`
      CREATE TABLE fixture_clock(offset_seconds integer NOT NULL);
      INSERT INTO fixture_clock VALUES(0);
      CREATE FUNCTION clock_timestamp() RETURNS timestamptz LANGUAGE sql VOLATILE AS 'SELECT pg_catalog.clock_timestamp() + make_interval(secs => offset_seconds) FROM fixture_clock';
      CREATE FUNCTION now() RETURNS timestamptz LANGUAGE sql STABLE AS 'SELECT pg_catalog.now() + make_interval(secs => offset_seconds) FROM fixture_clock';
    `);
    await db.query(`
      CREATE TABLE IF NOT EXISTS webhook_events(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),event_id text NOT NULL UNIQUE,provider text NOT NULL,event_type text,payload_hash text NOT NULL,source_ip text,processed_at timestamp NOT NULL DEFAULT now(),event_timestamp timestamp);
    CREATE TABLE organizations(id uuid PRIMARY KEY,account_deletion_request_id uuid,account_lifecycle_revision bigint NOT NULL DEFAULT 0,is_active boolean NOT NULL DEFAULT true,account_lifecycle_state text NOT NULL DEFAULT 'active',paid_work_fenced_at timestamptz,stripe_customer_id text,credit_balance numeric NOT NULL DEFAULT 0);
      CREATE TABLE users(id uuid PRIMARY KEY,account_deletion_request_id uuid,account_lifecycle_revision bigint NOT NULL DEFAULT 0,is_active boolean NOT NULL DEFAULT true,deleted_at timestamptz,email_verified boolean NOT NULL DEFAULT true,is_anonymous boolean NOT NULL DEFAULT false,organization_id uuid,role text NOT NULL DEFAULT 'member',expires_at timestamp,account_lifecycle_state text NOT NULL DEFAULT 'active',auth_fenced_at timestamptz);
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
      "0426_app_billing_resume_payment_progress",
      "0427_app_billing_paid_resume_progress",
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
    commands = (await import("../../db/repositories/app-billing-command-runtime"))
      .appBillingCommandRuntimeRepository;
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

  async function pausedCheckout(projectPaused = false, elapsedTrial = true) {
    fixture.setResumePaymentOutcome("paid");
    await db.query("UPDATE fixture_clock SET offset_seconds=$1", [elapsedTrial ? -691200 : 0]);
    const offset = await db.query(
      "SELECT round(extract(epoch FROM clock_timestamp()-pg_catalog.clock_timestamp()))::integer AS seconds",
    );
    expect(offset.rows[0].seconds).toBe(elapsedTrial ? -691200 : 0);
    const { identity, scopeId, planId } = await buyer();
    const trial = await runtime.prepare(identity, {
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
    await db.query("UPDATE fixture_clock SET offset_seconds=0");
    expect(
      (
        await db.query(
          "SELECT abs(extract(epoch FROM clock_timestamp()-pg_catalog.clock_timestamp()))<1 AS restored",
        )
      ).rows[0].restored,
    ).toBe(true);
    expect(trial.status).toBe("succeeded");
    let original = await queries.snapshot(identity);
    if (original.kind !== "subscription" || !original.subscription.stripe_subscription_id)
      throw new Error("Expected original provider trial");
    const subscriptionId = original.subscription.stripe_subscription_id;
    fixture.pauseSubscription(subscriptionId);
    if (projectPaused) {
      await projectProviderSubscription(identity, scopeId, planId, subscriptionId);
      original = await queries.snapshot(identity);
      if (original.kind !== "subscription") throw new Error("Expected paused projection");
      expect(original.subscription.status).toBe("paused");
    }
    const input = {
      idempotencyKey: randomUUID(),
      expectedSubscriptionRevision: original.mutationRevision,
      planRevisionId: planId,
      quantity: 1,
      billingConsent: "accepted" as const,
    };
    const checkout = await runtime.checkout(identity, input);
    expect(checkout.status).toBe("requires_action");
    const stored = await commands.read({
      scopeId,
      commandId: checkout.id,
      actorUserId: identity.actorUserId,
    });
    if (stored.command.provider_result?.kind !== "checkout")
      throw new Error("Expected setup Checkout");
    const sessionId = stored.command.provider_result.checkoutSessionId;
    const setup = fixture.completeSetupCheckout(sessionId);
    return {
      identity,
      scopeId,
      planId,
      original,
      subscriptionId,
      input,
      checkout,
      sessionId,
      setup,
    };
  }

  const posts = () => fixture.requests.filter((request) => request.method === "POST");
  const paymentPosts = () =>
    posts().filter((request) => /\/invoices\/[^/]+\/pay$/.test(request.path));

  test("setup completion pays the exact resume invoice once and preserves the original subscription and trial", async () => {
    const state = await pausedCheckout();
    const beforePayments = paymentPosts().length;
    const completed = await runtime.reconcileCommand({
      scopeId: state.scopeId,
      commandId: state.checkout.id,
    });
    expect(completed.status).toBe("succeeded");
    const current = await queries.snapshot(state.identity);
    if (current.kind !== "subscription") throw new Error("Expected paid subscription");
    expect(current.subscription.id).toBe(state.original.subscription.id);
    expect(current.subscription.stripe_subscription_id).toBe(state.subscriptionId);
    expect(current.subscription.status).toBe("active");
    expect(current.trial?.id).toBe(state.original.trial?.id);
    expect(paymentPosts()).toHaveLength(beforePayments + 1);
    const payment = paymentPosts().at(-1)!;
    expect(payment.body.get("payment_method")).toBe(state.setup.paymentMethodId);
    expect(payment.body.get("off_session")).toBe("true");
    const invoiceId = fixture.subscriptions.get(state.subscriptionId)!.invoiceId;
    expect(payment.path).toBe(`/v1/invoices/${invoiceId}/pay`);
    const command = await commands.read({
      scopeId: state.scopeId,
      commandId: state.checkout.id,
      actorUserId: state.identity.actorUserId,
    });
    expect(command.command.requested_by_user_id).toBe(state.identity.actorUserId);
    expect(command.command.provider_result).toMatchObject({
      kind: "checkout",
      resume: { invoiceId, invoicePaid: true },
    });
    const writes = posts().length;
    expect((await runtime.checkout(state.identity, state.input)).id).toBe(state.checkout.id);
    expect(
      (await runtime.reconcileCommand({ scopeId: state.scopeId, commandId: state.checkout.id }))
        .status,
    ).toBe("succeeded");
    expect(posts()).toHaveLength(writes);
    expect(
      (
        await db.query(
          "SELECT granted_amount FROM subscription_allowance_periods WHERE subscription_id=$1 AND grant_source='paid_invoice'",
          [current.subscription.id],
        )
      ).rows,
    ).toEqual([{ granted_amount: "25.000000" }]);
  });

  test("a paid invoice for a future service period grants no current allowance", async () => {
    const state = await pausedCheckout(false, false);
    expect(
      (await runtime.reconcileCommand({ scopeId: state.scopeId, commandId: state.checkout.id }))
        .status,
    ).toBe("succeeded");
    const { GenericBillingReadService } = await import("./generic-billing-read");
    expect(
      (await new GenericBillingReadService().snapshot(state.identity)).entitlement?.access,
    ).toBe("read_only");
    expect(
      (
        await db.query(
          "SELECT entitlement_effective FROM organization_entitlements WHERE billing_scope_id=$1",
          [state.scopeId],
        )
      ).rows,
    ).toEqual([{ entitlement_effective: false }]);
    expect(
      (
        await db.query(
          "SELECT id FROM subscription_allowance_periods WHERE subscription_id=$1 AND grant_source='paid_invoice'",
          [state.original.subscription.id],
        )
      ).rows,
    ).toEqual([]);
  });

  test("verified paid future invoice hides its historical CTA until access becomes effective", async () => {
    const state = await pausedCheckout(false, false);
    fixture.setResumePaymentOutcome("requires_action");
    expect(
      (await runtime.reconcileCommand({ scopeId: state.scopeId, commandId: state.checkout.id }))
        .status,
    ).toBe("requires_action");
    const read = () =>
      commands.read({
        scopeId: state.scopeId,
        commandId: state.checkout.id,
        actorUserId: state.identity.actorUserId,
      });
    const initial = (await read()).command.provider_result;
    if (initial?.kind !== "checkout" || !initial.resume?.action)
      throw new Error("Expected retained payment action");
    fixture.settleResumePayment(state.subscriptionId);
    await projectProviderSubscription(
      state.identity,
      state.scopeId,
      state.planId,
      state.subscriptionId,
    );
    const writes = posts().length;
    const pending = await runtime.reconcileCommand({
      scopeId: state.scopeId,
      commandId: state.checkout.id,
    });
    expect(pending).toMatchObject({ status: "pending", retryAfterSeconds: 3 });
    expect(pending).not.toHaveProperty("action");
    const stored = (await read()).command;
    expect(stored.status).toBe("SUCCEEDED");
    expect(stored.provider_result).toMatchObject({
      kind: "checkout",
      resume: {
        invoiceId: initial.resume.invoiceId,
        invoicePaid: true,
        action: initial.resume.action,
      },
    });
    const { GenericBillingReadService } = await import("./generic-billing-read");
    const snapshot = await new GenericBillingReadService().snapshot(state.identity);
    expect(snapshot.entitlement?.access).toBe("read_only");
    expect(snapshot.pendingOperation).toMatchObject({ status: "pending", retryAfterSeconds: 3 });
    expect(snapshot.pendingOperation).not.toHaveProperty("action");
    expect(
      (
        await db.query(
          "SELECT id FROM subscription_allowance_periods WHERE subscription_id=$1 AND grant_source='paid_invoice'",
          [state.original.subscription.id],
        )
      ).rows,
    ).toEqual([]);
    expect(
      (await runtime.reconcileCommand({ scopeId: state.scopeId, commandId: state.checkout.id }))
        .status,
    ).toBe("pending");
    expect(posts()).toHaveLength(writes);
    await db.query("UPDATE fixture_clock SET offset_seconds=604801");
    try {
      expect(
        (await runtime.reconcileCommand({ scopeId: state.scopeId, commandId: state.checkout.id }))
          .status,
      ).toBe("succeeded");
      expect(
        (await new GenericBillingReadService().snapshot(state.identity)).entitlement?.access,
      ).toBe("granted");
      expect(posts()).toHaveLength(writes);
    } finally {
      await db.query("UPDATE fixture_clock SET offset_seconds=0");
    }
    const paid = (await read()).command.provider_result;
    if (paid?.kind !== "checkout" || !paid.resume)
      throw new Error("Missing settled invoice history");
    const { invoicePaid: marker, ...withoutMarker } = paid.resume;
    expect(marker).toBe(true);
    for (const resume of [
      { ...paid.resume, invoicePaid: false },
      { ...paid.resume, invoicePaid: null },
      withoutMarker,
      { ...paid.resume, invoiceId: null },
    ]) {
      await expect(
        db.query("UPDATE billing_subscription_commands SET provider_result=$2 WHERE id=$1", [
          state.checkout.id,
          { ...paid, resume },
        ]),
      ).rejects.toThrow();
    }
    expect((await read()).command.provider_result).toEqual(paid);
  });

  test("authentication required exposes the hosted invoice and later reconciles the same payment without paying again", async () => {
    const state = await pausedCheckout();
    fixture.setResumePaymentOutcome("requires_action");
    const pending = await runtime.reconcileCommand({
      scopeId: state.scopeId,
      commandId: state.checkout.id,
    });
    expect(pending.status).toBe("requires_action");
    const invoiceId = fixture.subscriptions.get(state.subscriptionId)!.invoiceId;
    const stored = await commands.read({
      scopeId: state.scopeId,
      commandId: state.checkout.id,
      actorUserId: state.identity.actorUserId,
    });
    expect(stored.command.provider_result).toMatchObject({
      kind: "checkout",
      resume: { invoiceId, action: { kind: "payment", invoiceId } },
    });
    expect(JSON.stringify(pending)).toContain(`https://invoice.stripe.com/i/${invoiceId}`);
    expect(JSON.stringify(pending)).not.toContain(
      `https://checkout.stripe.com/c/pay/${state.sessionId}`,
    );
    const writes = posts().length;
    expect(
      (await runtime.reconcileCommand({ scopeId: state.scopeId, commandId: state.checkout.id }))
        .status,
    ).toBe("requires_action");
    expect(posts()).toHaveLength(writes);
    fixture.settleResumePayment(state.subscriptionId);
    expect(
      (await runtime.reconcileCommand({ scopeId: state.scopeId, commandId: state.checkout.id }))
        .status,
    ).toBe("succeeded");
    expect(posts()).toHaveLength(writes);
    expect(fixture.subscriptions.get(state.subscriptionId)!.invoiceId).toBe(invoiceId);
  });

  test("a lost accepted payment response recovers from the recorded invoice without a second pay", async () => {
    const state = await pausedCheckout();
    const payments = paymentPosts().length;
    fixture.loseResumePaymentResponse();
    const first = await runtime.reconcileCommand({
      scopeId: state.scopeId,
      commandId: state.checkout.id,
    });
    expect(first.status).toBe("requires_action");
    const invoiceId = fixture.subscriptions.get(state.subscriptionId)!.invoiceId;
    const stored = await commands.read({
      scopeId: state.scopeId,
      commandId: state.checkout.id,
      actorUserId: state.identity.actorUserId,
    });
    expect(stored.command.status).toBe("SUCCEEDED");
    expect(stored.command.provider_result).toMatchObject({
      kind: "checkout",
      resume: { invoiceId, action: { kind: "payment", invoiceId } },
    });
    if (stored.command.provider_result?.kind !== "checkout")
      throw new Error("Missing resume result");
    expect(stored.command.provider_result.resume).not.toHaveProperty("invoicePaid");
    expect(paymentPosts()).toHaveLength(payments + 1);
    const writes = posts().length;
    expect(
      (await runtime.reconcileCommand({ scopeId: state.scopeId, commandId: state.checkout.id }))
        .status,
    ).toBe("succeeded");
    expect(posts()).toHaveLength(writes);
    expect(
      (
        await commands.read({
          scopeId: state.scopeId,
          commandId: state.checkout.id,
          actorUserId: state.identity.actorUserId,
        })
      ).command.provider_result,
    ).toMatchObject({ kind: "checkout", resume: { invoiceId, invoicePaid: true } });
  });

  test("deletion recovery observes an unpaid resume and never initiates payment", async () => {
    const state = await pausedCheckout();
    fixture.setResumePaymentOutcome("requires_action");
    expect(
      (await runtime.reconcileCommand({ scopeId: state.scopeId, commandId: state.checkout.id }))
        .status,
    ).toBe("requires_action");
    const deletionAuthority = {
      kind: "account_deletion" as const,
      requestId: randomUUID(),
      requestDigest: "c".repeat(64),
      lifecycleRevision: 2,
      phaseReceiptId: randomUUID(),
      phaseGeneration: 1,
    };
    await db.query(
      "UPDATE users SET is_active=false,auth_fenced_at=now(),account_lifecycle_state='deletion_irreversible' WHERE id=$1",
      [state.identity.actorUserId],
    );
    await db.query(
      "INSERT INTO account_deletion_requests VALUES($1,$2,$3,$4,2,now(),'processing')",
      [
        deletionAuthority.requestId,
        state.identity.actorUserId,
        randomUUID(),
        deletionAuthority.requestDigest,
      ],
    );
    await db.query(
      "INSERT INTO account_deletion_phase_receipts VALUES($1,$2,'stripe',1,(now()+interval '5 minutes') AT TIME ZONE 'UTC','calling')",
      [deletionAuthority.phaseReceiptId, deletionAuthority.requestId],
    );
    const writes = posts().length;
    fixture.setResumePaymentOutcome("paid");
    expect(
      (
        await runtime.run({
          scopeId: state.scopeId,
          commandId: state.checkout.id,
          deletionAuthority,
        })
      ).status,
    ).toBe("requires_action");
    expect(posts()).toHaveLength(writes);
    fixture.settleResumePayment(state.subscriptionId);
    expect(
      (
        await runtime.run({
          scopeId: state.scopeId,
          commandId: state.checkout.id,
          deletionAuthority,
        })
      ).status,
    ).toBe("succeeded");
    expect(posts()).toHaveLength(writes);
    expect(
      (
        await db.query(
          "SELECT stripe_subscription_id,status FROM billing_subscriptions WHERE billing_scope_id=$1",
          [state.scopeId],
        )
      ).rows,
    ).toEqual([{ stripe_subscription_id: state.subscriptionId, status: "active" }]);
  });

  async function projectProviderSubscription(
    identity: BuyerBillingIdentity,
    scopeId: string,
    planId: string,
    subscriptionId: string,
  ) {
    const { appBillingProviderBindings } = await import(
      "../../db/repositories/app-billing-provider-bindings"
    );
    const { createGenericBillingProvider } = await import("./generic-billing-provider");
    const { appBillingProviderPlan } = await import("./generic-billing-provider-runtime");
    const { appSubscriptionFinalizer } = await import(
      "../../db/repositories/app-subscription-finalizer"
    );
    const provider = createGenericBillingProvider(
      fixture.stripe,
      { merchantId: merchant, kind: "connected", stripeAccountId: "acct_runtime", livemode: false },
      appBillingProviderBindings,
    );
    const scope = await authority.getScope(identity);
    const plan = appBillingProviderPlan(
      await authority.getHistoricalPlan({ appId: identity.appId, planRevisionId: planId }),
    );
    const snapshot = await queries.snapshot(identity);
    if (snapshot.kind !== "subscription" || !scope.stripeCustomerId)
      throw new Error("Missing subscription binding");
    const subscription = await provider.retrieveSubscription(scope, {
      subscriptionId,
      customerId: scope.stripeCustomerId,
      plan,
    });
    const invoice = subscription.value.latestInvoiceId
      ? await provider.retrieveInvoice(scope, {
          invoiceId: subscription.value.latestInvoiceId,
          subscriptionId,
          customerId: scope.stripeCustomerId,
          plan,
        })
      : null;
    await appSubscriptionFinalizer.applyObservation({
      scopeId,
      planRevisionId: planId,
      expectedSubscriptionRevision: snapshot.subscription.lifecycle_revision,
      subscription,
      invoice,
      command: null,
      event: null,
    });
  }

  test("legacy resume recovers its original invoice after a webhook already projected active", async () => {
    const state = await pausedCheckout(true);
    const stored = await commands.read({
      scopeId: state.scopeId,
      commandId: state.checkout.id,
      actorUserId: state.identity.actorUserId,
    });
    const key = `${stored.command.provider_idempotency_key}:resume`;
    await fixture.stripe.subscriptions.update(
      state.subscriptionId,
      { default_payment_method: state.setup.paymentMethodId },
      { stripeAccount: "acct_runtime" },
    );
    await fixture.stripe.subscriptions.resume(
      state.subscriptionId,
      { billing_cycle_anchor: "now" },
      { stripeAccount: "acct_runtime", idempotencyKey: key },
    );
    const invoiceId = fixture.subscriptions.get(state.subscriptionId)!.invoiceId;
    fixture.settleResumePayment(state.subscriptionId);
    await projectProviderSubscription(
      state.identity,
      state.scopeId,
      state.planId,
      state.subscriptionId,
    );
    const active = await queries.snapshot(state.identity);
    if (active.kind !== "subscription") throw new Error("Expected active projection");
    expect(active.subscription.status).toBe("active");
    expect(active.subscription.lifecycle_revision).toBeGreaterThan(
      state.original.subscription.lifecycle_revision,
    );
    const writes = posts().length;
    expect(
      (await runtime.reconcileCommand({ scopeId: state.scopeId, commandId: state.checkout.id }))
        .status,
    ).toBe("succeeded");
    expect(
      posts()
        .slice(writes)
        .map((request) => ({ path: request.path, key: request.key })),
    ).toEqual([{ path: `/v1/subscriptions/${state.subscriptionId}/resume`, key }]);
    expect(
      (
        await db.query("SELECT provider_result FROM billing_subscription_commands WHERE id=$1", [
          state.checkout.id,
        ])
      ).rows[0].provider_result,
    ).toMatchObject({ kind: "checkout", resume: { invoiceId } });
    expect(fixture.subscriptions.get(state.subscriptionId)!.invoiceId).toBe(invoiceId);
  });

  test("deletion leaves a legacy setup without a recorded invoice unresolved and performs no provider writes", async () => {
    const state = await pausedCheckout();
    const stored = await commands.read({
      scopeId: state.scopeId,
      commandId: state.checkout.id,
      actorUserId: state.identity.actorUserId,
    });
    await fixture.stripe.subscriptions.update(
      state.subscriptionId,
      { default_payment_method: state.setup.paymentMethodId },
      { stripeAccount: "acct_runtime" },
    );
    await fixture.stripe.subscriptions.resume(
      state.subscriptionId,
      { billing_cycle_anchor: "now" },
      {
        stripeAccount: "acct_runtime",
        idempotencyKey: `${stored.command.provider_idempotency_key}:resume`,
      },
    );
    const deletionAuthority = {
      kind: "account_deletion" as const,
      requestId: randomUUID(),
      requestDigest: "e".repeat(64),
      lifecycleRevision: 2,
      phaseReceiptId: randomUUID(),
      phaseGeneration: 1,
    };
    await db.query(
      "UPDATE users SET is_active=false,auth_fenced_at=now(),account_lifecycle_state='deletion_irreversible' WHERE id=$1",
      [state.identity.actorUserId],
    );
    await db.query(
      "INSERT INTO account_deletion_requests VALUES($1,$2,$3,$4,2,now(),'processing')",
      [
        deletionAuthority.requestId,
        state.identity.actorUserId,
        randomUUID(),
        deletionAuthority.requestDigest,
      ],
    );
    await db.query(
      "INSERT INTO account_deletion_phase_receipts VALUES($1,$2,'stripe',1,(now()+interval '5 minutes') AT TIME ZONE 'UTC','calling')",
      [deletionAuthority.phaseReceiptId, deletionAuthority.requestId],
    );
    const writes = posts().length;
    expect(
      (
        await runtime.run({
          scopeId: state.scopeId,
          commandId: state.checkout.id,
          deletionAuthority,
        })
      ).status,
    ).not.toBe("succeeded");
    expect(posts()).toHaveLength(writes);
    const command = (
      await db.query(
        "SELECT status,provider_result FROM billing_subscription_commands WHERE id=$1",
        [state.checkout.id],
      )
    ).rows[0];
    expect(command.status).not.toBe("APPLIED");
    expect(command.provider_result).not.toHaveProperty("resume");
    expect(fixture.subscriptions.get(state.subscriptionId)!.paused).toBe(true);
  });

  test("PostgreSQL rejects rewritten resume authority and nonfinite payment deadlines", async () => {
    const state = await pausedCheckout();
    fixture.setResumePaymentOutcome("requires_action");
    await runtime.reconcileCommand({ scopeId: state.scopeId, commandId: state.checkout.id });
    const {
      rows: [{ provider_result: original }],
    } = await db.query("SELECT provider_result FROM billing_subscription_commands WHERE id=$1", [
      state.checkout.id,
    ]);
    const invalid = [
      { ...original, resume: { ...original.resume, notBefore: "infinity" } },
      {
        ...original,
        resume: {
          ...original.resume,
          notBefore: new Date(Date.parse(original.resume.notBefore) + 1000).toISOString(),
        },
      },
      { ...original, resume: { ...original.resume, invoiceId: "in_replacement" } },
      {
        ...original,
        resume: {
          ...original.resume,
          action: { ...original.resume.action, url: "https://invoice.stripe.com/i/replacement" },
        },
      },
      {
        ...original,
        resume: {
          ...original.resume,
          action: { ...original.resume.action, expiresAt: "infinity" },
        },
      },
      { ...original, resume: { ...original.resume, invoiceId: null, action: null } },
    ];
    for (const result of invalid)
      await expect(
        db.query("UPDATE billing_subscription_commands SET provider_result=$2 WHERE id=$1", [
          state.checkout.id,
          result,
        ]),
      ).rejects.toThrow();
    expect(
      (
        await db.query("SELECT provider_result FROM billing_subscription_commands WHERE id=$1", [
          state.checkout.id,
        ])
      ).rows[0].provider_result,
    ).toEqual(original);
    const other = await buyer();
    const checkout = await runtime.checkout(other.identity, {
      idempotencyKey: randomUUID(),
      expectedSubscriptionRevision: null,
      planRevisionId: other.planId,
      quantity: 1,
      billingConsent: "accepted",
    });
    await expect(
      db.query(
        "UPDATE billing_subscription_commands SET provider_result=provider_result || $2::jsonb WHERE id=$1",
        [checkout.id, { resume: original.resume }],
      ),
    ).rejects.toThrow("Invalid setup resume payment progress");
  });
});
