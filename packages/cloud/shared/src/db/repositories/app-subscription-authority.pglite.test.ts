/**
 * Exercises app billing migrations and finalization against PGlite or independent PostgreSQL sessions.
 * Set APP_BILLING_TEST_POSTGRES_URL to run the same contract in an isolated PostgreSQL schema.
 */
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Client } from "pg";

const postgresUrl = process.env.APP_BILLING_TEST_POSTGRES_URL;
const schema = `app_billing_${randomUUID().replaceAll("-", "_")}`;
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
let close: typeof import("../client").closeDatabaseConnectionsForTests;
let repository: import("./app-subscription-authority").AppSubscriptionAuthorityRepository;
const org = randomUUID();
const user = randomUUID();
const merchant = randomUUID();
const appA = randomUUID();
const appB = randomUUID();
const planA = randomUUID();
const planB = randomUUID();
const digest = "a".repeat(64);

beforeAll(async () => {
  const module = await import("../client");
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
  repository = (await import("./app-subscription-authority")).appSubscriptionAuthorityRepository;
  await client.exec(`
    CREATE TABLE IF NOT EXISTS webhook_events(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),event_id text NOT NULL UNIQUE,provider text NOT NULL,event_type text,payload_hash text NOT NULL,source_ip text,processed_at timestamp NOT NULL DEFAULT now(),event_timestamp timestamp);
    CREATE TABLE organizations(id uuid PRIMARY KEY,is_active boolean NOT NULL DEFAULT true,account_lifecycle_state text NOT NULL DEFAULT 'active',paid_work_fenced_at timestamptz,stripe_customer_id text,credit_balance numeric NOT NULL DEFAULT 42);
    CREATE TABLE users(id uuid PRIMARY KEY,is_active boolean NOT NULL DEFAULT true,deleted_at timestamptz,email_verified boolean NOT NULL DEFAULT true,is_anonymous boolean NOT NULL DEFAULT false,account_lifecycle_state text NOT NULL DEFAULT 'active',auth_fenced_at timestamptz,expires_at timestamptz);
    CREATE TABLE apps(id uuid PRIMARY KEY,name text NOT NULL DEFAULT 'Independent app',organization_id uuid NOT NULL REFERENCES organizations(id),is_active boolean NOT NULL DEFAULT true,is_approved boolean NOT NULL DEFAULT true,review_status text NOT NULL DEFAULT 'approved');
    CREATE TABLE credit_transactions(id uuid PRIMARY KEY,organization_id uuid NOT NULL REFERENCES organizations(id),CONSTRAINT credit_transactions_id_org_idx UNIQUE(id,organization_id));
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
    "0414_app_billing_administrators",
    "0418_billing_identity_anchors",
    "0419_billing_identity_backfill",
    "0420_billing_identity_references",
  ]) {
    const migration = await readFile(new URL(`../migrations/${tag}.sql`, import.meta.url), "utf8");
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
  await close();
  if (postgres) {
    await postgres.query(`DROP SCHEMA ${schema} CASCADE`);
    await postgres.end();
  }
});

async function prepare(appId: string, planRevisionId: string, key = randomUUID()) {
  const account = await repository.createAccount({
    appId,
    externalAccountKey: key,
    displayName: "Test workspace",
    principalUserId: user,
  });
  const scope = await repository.resolveScope({
    appId,
    billingAccountId: account.id,
    productFamilyKey: "main",
    merchantId: merchant,
    actorUserId: user,
  });
  const command = await repository.prepareCommand({
    scopeId: scope.scopeId,
    actorUserId: user,
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

describe("generic app subscription authority", () => {
  test("migration preserves infrastructure money and customer ownership", async () => {
    expect(
      (
        await client.query(
          "SELECT credit_balance::text,stripe_customer_id FROM organizations WHERE id=$1",
          [org],
        )
      ).rows,
    ).toEqual([{ credit_balance: "42", stripe_customer_id: "cus_infrastructure" }]);
    expect((await client.query("SELECT * FROM app_billing_accounts")).rows).toHaveLength(0);
  });
  test("wallet principals may own accounts while anonymous identities cannot acquire billing authority", async () => {
    const walletUser = randomUUID();
    const anonymousUser = randomUUID();
    await client.query(
      "INSERT INTO users(id,email_verified,is_anonymous) VALUES($1,false,false),($2,false,true)",
      [walletUser, anonymousUser],
    );
    const account = await repository.createAccount({
      appId: appA,
      externalAccountKey: randomUUID(),
      displayName: "Wallet account",
      principalUserId: walletUser,
    });
    const scope = await repository.resolveScope({
      appId: appA,
      billingAccountId: account.id,
      productFamilyKey: "main",
      merchantId: merchant,
      actorUserId: walletUser,
    });
    expect(scope.billingAccountId).toBe(account.id);
    await expect(
      repository.createAccount({
        appId: appA,
        externalAccountKey: randomUUID(),
        displayName: "Anonymous account",
        principalUserId: anonymousUser,
      }),
    ).rejects.toThrow("verified principal");
  });

  test("one verified principal can claim independent seven-day trials in different apps, never again through a new workspace", async () => {
    const a = await prepare(appA, planA);
    const b = await prepare(appB, planB);
    const [trialA, trialB] = await Promise.all([
      repository.claimTrial({
        scopeId: a.scope.scopeId,
        commandId: a.command.id,
        planRevisionId: planA,
      }),
      repository.claimTrial({
        scopeId: b.scope.scopeId,
        commandId: b.command.id,
        planRevisionId: planB,
      }),
    ]);
    expect(trialA.ends_at.getTime() - trialA.starts_at.getTime()).toBe(604800000);
    expect(trialB.ends_at.getTime() - trialB.starts_at.getTime()).toBe(604800000);
    expect(
      (
        await repository.claimTrial({
          scopeId: a.scope.scopeId,
          commandId: a.command.id,
          planRevisionId: planA,
        })
      ).id,
    ).toBe(trialA.id);
    const second = await prepare(appA, planA);
    await expect(
      repository.claimTrial({
        scopeId: second.scope.scopeId,
        commandId: second.command.id,
        planRevisionId: planA,
      }),
    ).rejects.toMatchObject({ code: "APP_BILLING_AUTHORITY_CONFLICT" });
    await expect(
      client.query(
        "UPDATE app_subscription_trials SET ends_at=ends_at+interval '1 day' WHERE id=$1",
        [trialA.id],
      ),
    ).rejects.toThrow();
  });
  test("command execution generation allows exactly one concurrent provider dispatch and customer bindings cannot move", async () => {
    const { scope, command } = await prepare(appA, planA);
    const start = {
      scopeId: scope.scopeId,
      commandId: command.id,
      actorUserId: user,
      expectedStateRevision: command.state_revision,
      expectedExecutionGeneration: command.execution_generation,
    };
    const attempts = await Promise.allSettled([
      repository.beginCommand(start),
      repository.beginCommand(start),
    ]);
    expect(attempts.filter((value) => value.status === "fulfilled")).toHaveLength(1);
    expect(attempts.filter((value) => value.status === "rejected")).toHaveLength(1);
    await repository.bindCustomer({
      scopeId: scope.scopeId,
      commandId: command.id,
      customerId: "cus_appcustomer",
    });
    await expect(
      repository.bindCustomer({
        scopeId: scope.scopeId,
        commandId: command.id,
        customerId: "cus_different",
      }),
    ).rejects.toThrow();
    await expect(
      client.query(
        "UPDATE app_billing_customers SET stripe_customer_id='cus_changed' WHERE billing_account_id=$1",
        [scope.billingAccountId],
      ),
    ).rejects.toThrow();
    expect(
      (await client.query("SELECT stripe_customer_id FROM organizations WHERE id=$1", [org])).rows,
    ).toEqual([{ stripe_customer_id: "cus_infrastructure" }]);
  });
  test("cross-app plans and revoked administrator authority fail before provider execution", async () => {
    const { scope, command } = await prepare(appA, planA);
    await expect(
      repository.prepareCommand({
        scopeId: scope.scopeId,
        actorUserId: user,
        kind: "checkout",
        payload: {
          version: 1,
          domain: "buyer",
          action: "trial",
          planRevisionId: planB,
          quantity: 1,
        },
        targetPlanRevisionId: planB,
        quantity: 1,
        idempotencyKey: `checkout:${randomUUID()}`,
        requestDigest: digest,
        expectedSubscriptionRevision: null,
      }),
    ).rejects.toThrow();
    await client.query(
      "UPDATE app_billing_members SET revoked_at=now() WHERE billing_account_id=$1",
      [scope.billingAccountId],
    );
    await expect(
      repository.beginCommand({
        scopeId: scope.scopeId,
        commandId: command.id,
        actorUserId: user,
        expectedStateRevision: command.state_revision,
        expectedExecutionGeneration: command.execution_generation,
      }),
    ).rejects.toThrow();
    expect(
      (
        await client.query("SELECT status FROM billing_subscription_commands WHERE id=$1", [
          command.id,
        ])
      ).rows,
    ).toEqual([{ status: "PREPARED" }]);
  });
  test("review approval is checked again at dispatch and historical scopes remain readable while fenced", async () => {
    const { scope, command } = await prepare(appB, planB);
    await client.query("UPDATE apps SET review_status='pending' WHERE id=$1", [appB]);
    expect(
      (
        await repository.getScope({
          appId: appB,
          billingAccountId: scope.billingAccountId,
          productFamilyKey: "main",
          livemode: false,
        })
      ).fenced,
    ).toBe(true);
    await expect(
      repository.beginCommand({
        scopeId: scope.scopeId,
        commandId: command.id,
        actorUserId: user,
        expectedStateRevision: command.state_revision,
        expectedExecutionGeneration: command.execution_generation,
      }),
    ).rejects.toThrow();
    await client.query("UPDATE apps SET review_status='approved' WHERE id=$1", [appB]);
  });
  test("sandbox trial eligibility and billing scope cannot consume or masquerade as live mode", async () => {
    const { account, scope: sandbox } = await prepare(appA, planA);
    const liveMerchant = randomUUID();
    const livePlan = randomUUID();
    await client.query(
      "INSERT INTO billing_merchants(id,organization_id,provider_account_key,livemode,enabled) VALUES ($1,$2,'platform',true,true)",
      [liveMerchant, org],
    );
    const { dbWrite } = await import("../helpers");
    const { appBillingPlanRevisions } = await import("../schemas/app-billing");
    const original = await repository.getPlan({ appId: appA, planRevisionId: planA });
    await dbWrite
      .insert(appBillingPlanRevisions)
      .values({ ...original, id: livePlan, merchant_id: liveMerchant, revision: 2 });
    const scope = await repository.resolveScope({
      appId: appA,
      billingAccountId: account.id,
      productFamilyKey: "main",
      merchantId: liveMerchant,
      actorUserId: user,
    });
    expect(scope.scopeId).not.toBe(sandbox.scopeId);
    expect(scope.livemode).toBe(true);
    const command = await repository.prepareCommand({
      scopeId: scope.scopeId,
      actorUserId: user,
      kind: "checkout",
      payload: {
        version: 1,
        domain: "buyer",
        action: "trial",
        planRevisionId: livePlan,
        quantity: 1,
      },
      targetPlanRevisionId: livePlan,
      quantity: 1,
      idempotencyKey: `live:${randomUUID()}`,
      requestDigest: digest,
      expectedSubscriptionRevision: null,
    });
    const trial = await repository.claimTrial({
      scopeId: scope.scopeId,
      commandId: command.id,
      planRevisionId: livePlan,
    });
    expect(trial.livemode).toBe(true);
    await expect(
      client.query("UPDATE app_billing_scopes SET livemode=false WHERE id=$1", [scope.scopeId]),
    ).rejects.toThrow();
    await expect(
      client.query(
        "INSERT INTO app_billing_scopes(app_id,organization_id,billing_account_id,merchant_id,product_family_key,livemode) VALUES ($1,$2,$3,$4,'other',false)",
        [appA, org, account.id, liveMerchant],
      ),
    ).rejects.toThrow();
  });
  test("published plan identity and prices are immutable and trial policy cannot exceed seven days", async () => {
    await expect(
      client.query("UPDATE app_billing_plan_revisions SET amount_cents=1 WHERE id=$1", [planA]),
    ).rejects.toThrow();
    await expect(
      client.query("UPDATE app_billing_plan_revisions SET trial_days=8 WHERE id=$1", [planB]),
    ).rejects.toThrow();
  });
});

async function providerTrialFixture(paidAllowanceUsd = "25.000000", expiresSoon = false) {
  const app = randomUUID();
  const plan = randomUUID();
  await client.query("INSERT INTO apps(id,organization_id) VALUES ($1,$2)", [app, org]);
  const { dbWrite } = await import("../helpers");
  const { appBillingPlanRevisions, appSubscriptionTrials } = await import("../schemas/app-billing");
  const original = await repository.getPlan({ appId: appA, planRevisionId: planA });
  await dbWrite
    .insert(appBillingPlanRevisions)
    .values({ ...original, id: plan, app_id: app, paid_allowance_usd: paidAllowanceUsd });
  const prepared = await prepare(app, plan);
  const trialEnd = new Date(Math.floor((Date.now() + 1000) / 1000) * 1000);
  const trial = expiresSoon
    ? (
        await dbWrite
          .insert(appSubscriptionTrials)
          .values({
            app_id: app,
            eligibility_principal_id: user,
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
    actorUserId: user,
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
  const observation: import("../../lib/services/generic-billing-provider-types").BillingProviderObservation<
    import("../../lib/services/generic-billing-provider-types").BillingProviderSubscription
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
    merchantId: merchant,
    providerAccountId: "acct_platform",
    livemode: false,
    observedAt: new Date().toISOString(),
  };
  const input: import("./app-subscription-finalizer").ApplyAppSubscriptionObservation = {
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
  return { input, trial, command };
}

describe("atomic app subscription finalization", () => {
  test("trial observation produces one journal revision, typed noncash grant, projection and outbox while rejecting stale replay", async () => {
    const { appSubscriptionFinalizer } = await import("./app-subscription-finalizer");
    const { input, trial, command } = await providerTrialFixture();
    const result = await appSubscriptionFinalizer.applyObservation(input);
    expect(result.entitlement.access).toBe("granted");
    expect(result.allowance).toMatchObject({
      grant_source: "trial_claim",
      trial_claim_id: trial.id,
      stripe_invoice_id: null,
      granted_amount: "5.000000",
    });
    expect(result.subscription.lifecycle_revision).toBe(1);
    const accountIdentity = () =>
      client.query(
        "SELECT subscription_id,state FROM organization_subscription_authorities WHERE organization_id=$1",
        [org],
      );
    expect((await accountIdentity()).rows).toEqual([{ subscription_id: null, state: "none" }]);
    await expect(
      client.query(
        "UPDATE organization_subscription_authorities SET subscription_id=$1,state='current' WHERE organization_id=$2",
        [result.subscription.id, org],
      ),
    ).rejects.toThrow("Subscription child source scope mismatch");
    expect((await accountIdentity()).rows).toEqual([{ subscription_id: null, state: "none" }]);

    expect(
      (
        await client.query("SELECT status FROM billing_subscription_commands WHERE id=$1", [
          command.id,
        ])
      ).rows,
    ).toEqual([{ status: "APPLIED" }]);
    await expect(appSubscriptionFinalizer.applyObservation(input)).rejects.toMatchObject({
      code: "APP_BILLING_AUTHORITY_CONFLICT",
    });
    expect(
      (
        await client.query(
          "SELECT count(*)::int AS count FROM app_subscription_outbox WHERE billing_scope_id=$1",
          [input.scopeId],
        )
      ).rows,
    ).toEqual([{ count: 1 }]);
    expect(
      (
        await client.query(
          "SELECT count(*)::int AS count FROM subscription_allowance_transactions WHERE billing_scope_id=$1",
          [input.scopeId],
        )
      ).rows,
    ).toEqual([{ count: 1 }]);
    expect(
      (
        await client.query(
          "SELECT credit_balance::text,stripe_customer_id FROM organizations WHERE id=$1",
          [org],
        )
      ).rows,
    ).toEqual([{ credit_balance: "42", stripe_customer_id: "cus_infrastructure" }]);
  });
  test("late outbox failure rolls back subscription, grant, projection and command result together", async () => {
    const { appSubscriptionFinalizer } = await import("./app-subscription-finalizer");
    const { input, command } = await providerTrialFixture();
    await client.exec(
      `CREATE FUNCTION fail_app_outbox_test() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'outbox unavailable'; END $$; CREATE TRIGGER fail_app_outbox_test BEFORE INSERT ON app_subscription_outbox FOR EACH ROW EXECUTE FUNCTION fail_app_outbox_test();`,
    );
    try {
      await expect(appSubscriptionFinalizer.applyObservation(input)).rejects.toThrow();
      for (const table of [
        "billing_subscriptions",
        "organization_entitlements",
        "subscription_allowance_periods",
        "subscription_allowance_transactions",
        "app_subscription_outbox",
      ])
        expect(
          (
            await client.query(
              `SELECT count(*)::int AS count FROM ${table} WHERE billing_scope_id=$1`,
              [input.scopeId],
            )
          ).rows,
        ).toEqual([{ count: 0 }]);
      expect(
        (
          await client.query("SELECT status FROM billing_subscription_commands WHERE id=$1", [
            command.id,
          ])
        ).rows,
      ).toEqual([{ status: "OUTCOME_UNKNOWN" }]);
    } finally {
      await client.exec(
        "DROP TRIGGER fail_app_outbox_test ON app_subscription_outbox; DROP FUNCTION fail_app_outbox_test();",
      );
    }
    expect(
      (await appSubscriptionFinalizer.applyObservation(input)).subscription.lifecycle_revision,
    ).toBe(1);
  });
  test.skipIf(!postgresUrl)(
    "trial expiry is re-evaluated after waiting on another PostgreSQL session's owner lock",
    async () => {
      const { appSubscriptionFinalizer } = await import("./app-subscription-finalizer");
      const { input, trial } = await providerTrialFixture("25.000000", true);
      const blocker = new Client({ connectionString: postgresUrl });
      await blocker.connect();
      await blocker.query(`SET search_path TO ${schema},public`);
      await blocker.query("BEGIN");
      await blocker.query("SELECT id FROM organizations WHERE id=$1 FOR UPDATE", [org]);
      const pending = appSubscriptionFinalizer.applyObservation(input);
      try {
        await new Promise((resolve) => setTimeout(resolve, 1500));
        await blocker.query("COMMIT");
        const result = await pending;
        expect(result.databaseNow.getTime()).toBeGreaterThanOrEqual(trial.ends_at.getTime());
        expect(result.entitlement.entitlement_effective).toBe(false);
        expect(result.allowance).toBeNull();
      } finally {
        await blocker.query("ROLLBACK");
        await blocker.end();
      }
    },
  );
  test("a paid zero-allowance plan retains paid access proof independently of money grants", async () => {
    const { appSubscriptionFinalizer } = await import("./app-subscription-finalizer");
    const { input } = await providerTrialFixture("0.000000");
    const observed = {
      ...input.subscription.value,
      status: "active" as const,
      trialStart: null,
      trialEnd: null,
      latestInvoiceId: "in_zeroplan",
    };
    const invoice: import("../../lib/services/generic-billing-provider-types").BillingProviderInvoice =
      {
        hostedInvoiceUrl: null,
        invoiceId: "in_zeroplan",
        subscriptionId: observed.subscriptionId,
        customerId: observed.customerId,
        chargeId: "ch_paid",
        paymentIntentId: "pi_paid",
        paidOutOfBand: false,
        payment: {
          paymentIntentId: "pi_paid",
          status: "succeeded",
          amountReceivedCents: 3000,
          customerId: observed.customerId,
          currency: "usd",
          invoiceId: "in_zeroplan",
        },
        status: "paid",
        paid: true,
        amountPaidCents: 3000,
        amountDueCents: 3000,
        billingReason: "subscription_create",
        subtotalCents: 3000,
        subtotalExcludingTaxCents: 3000,
        totalCents: 3000,
        taxCents: 0,
        discountCents: 0,
        currency: "usd",
        periodStart: observed.currentPeriodStart,
        periodEnd: observed.currentPeriodEnd,
        lines: [
          {
            lineId: "il_paid",
            lineType: "subscription",
            subscriptionId: observed.subscriptionId,
            subscriptionItemId: observed.itemId,
            priceId: observed.priceId,
            quantity: 1,
            discountAmountsCents: [],
            taxAmountsCents: [],
            amountCents: 3000,
            periodStart: observed.currentPeriodStart,
            periodEnd: observed.currentPeriodEnd,
            proration: false,
          },
        ],
      };
    const first = await appSubscriptionFinalizer.applyObservation({
      ...input,
      subscription: { ...input.subscription, value: observed },
      invoice: { ...input.subscription, value: invoice },
    });
    expect(first.entitlement.access).toBe("granted");
    expect(first.allowance).toBeNull();
    const second = await appSubscriptionFinalizer.applyObservation({
      ...input,
      command: null,
      expectedSubscriptionRevision: 1,
      subscription: { ...input.subscription, value: observed },
    });
    expect(second.entitlement.access).toBe("granted");
    expect(second.allowance).toBeNull();
    expect(
      (
        await client.query(
          "SELECT count(*)::int AS count FROM app_subscription_paid_periods WHERE billing_scope_id=$1",
          [input.scopeId],
        )
      ).rows,
    ).toEqual([{ count: 1 }]);
  });
  test("leased provider events apply once and an old applied event replay cannot overwrite cancellation", async () => {
    const { appSubscriptionFinalizer } = await import("./app-subscription-finalizer");
    const { input } = await providerTrialFixture();
    const first = await appSubscriptionFinalizer.applyObservation(input);
    const receiptId = randomUUID();
    const leaseToken = randomUUID();
    const event: import("../../lib/services/generic-billing-provider-types").BillingProviderEvent =
      {
        eventId: `evt_${randomUUID().replaceAll("-", "")}`,
        eventType: "customer.subscription.updated",
        createdAt: Math.floor(Date.now() / 1000),
        apiVersion: "2024-11-20.acacia",
        merchantId: merchant,
        providerAccountId: "acct_platform",
        livemode: false,
        objectId: input.subscription.value.subscriptionId,
        objectType: "subscription",
        payloadDigest: digest,
      };
    await client.query(
      "INSERT INTO billing_subscription_event_receipts(id,billing_scope_id,organization_id,subscription_id,provider_event_id,event_type,provider_object_type,provider_object_id,livemode,event_created_at,payload_digest,status,lease_token,lease_expires_at) VALUES ($1,$2,$3,$4,$5,$6,'subscription',$7,false,$8,$9,'processing',$10,now()+interval '1 minute')",
      [
        receiptId,
        input.scopeId,
        org,
        first.subscription.id,
        event.eventId,
        event.eventType,
        event.objectId,
        new Date(event.createdAt * 1000),
        digest,
        leaseToken,
      ],
    );
    const eventInput = {
      ...input,
      command: null,
      expectedSubscriptionRevision: 1,
      event,
      eventReceipt: { id: receiptId, leaseToken },
    };
    await expect(
      appSubscriptionFinalizer.applyObservation({
        ...eventInput,
        eventReceipt: { id: receiptId, leaseToken: randomUUID() },
      }),
    ).rejects.toThrow();
    const applied = await appSubscriptionFinalizer.applyObservation(eventInput);
    expect(applied.subscription.lifecycle_revision).toBe(2);
    await appSubscriptionFinalizer.applyObservation({
      ...input,
      command: null,
      expectedSubscriptionRevision: 2,
      subscription: {
        ...input.subscription,
        digest: "c".repeat(64),
        value: {
          ...input.subscription.value,
          status: "canceled",
          canceledAt: Math.floor(Date.now() / 1000),
          endedAt: Math.floor(Date.now() / 1000),
        },
      },
    });
    const replay = await appSubscriptionFinalizer.applyObservation(eventInput);
    expect(replay.replayed).toBe(true);
    expect(replay.subscription.status).toBe("canceled");
    expect(replay.entitlement.entitlement_effective).toBe(false);
    expect(replay.subscription.lifecycle_revision).toBe(3);
    expect(
      (
        await client.query(
          "SELECT count(*)::int AS count FROM app_subscription_outbox WHERE billing_scope_id=$1",
          [input.scopeId],
        )
      ).rows,
    ).toEqual([{ count: 3 }]);
  });
  test("unpaid active observation revokes access without paid grant, and stale entitlement revision cannot resurrect trial access", async () => {
    const { appSubscriptionFinalizer } = await import("./app-subscription-finalizer");
    const { input } = await providerTrialFixture();
    const first = await appSubscriptionFinalizer.applyObservation(input);
    const result = await appSubscriptionFinalizer.applyObservation({
      ...input,
      expectedSubscriptionRevision: 1,
      command: null,
      subscription: {
        ...input.subscription,
        digest: "b".repeat(64),
        value: { ...input.subscription.value, status: "active", trialStart: null, trialEnd: null },
      },
    });
    expect(result.entitlement.access).toBe("read_only");
    expect(result.allowance).toBeNull();
    await expect(
      client.query(
        "UPDATE organization_entitlements SET source_subscription_revision=1,entitlement_effective=true,access='granted' WHERE billing_scope_id=$1",
        [input.scopeId],
      ),
    ).rejects.toThrow();
    expect(
      (
        await client.query(
          "SELECT count(*)::int AS count FROM app_subscription_paid_periods WHERE billing_scope_id=$1",
          [input.scopeId],
        )
      ).rows,
    ).toEqual([{ count: 0 }]);
    expect(first.subscription.id).toBe(result.subscription.id);
  });
});

describe("buyer snapshot authority", () => {
  test("a buyer sees only their app allowance and a revoked member cannot read it", async () => {
    const { input } = await providerTrialFixture();
    const { appSubscriptionFinalizer } = await import("./app-subscription-finalizer");
    const { genericBillingReadService } = await import("../../lib/services/generic-billing-read");
    const result = await appSubscriptionFinalizer.applyObservation(input);
    const { appBillingScopes } = await import("../schemas/app-billing");
    const { dbWrite } = await import("../helpers");
    const { eq } = await import("drizzle-orm");
    const [scope] = await dbWrite
      .select()
      .from(appBillingScopes)
      .where(eq(appBillingScopes.id, input.scopeId));
    if (!scope) throw new Error("Missing scope fixture");
    const identity = {
      appId: scope.app_id,
      billingAccountId: scope.billing_account_id,
      productFamilyKey: "main",
      actorUserId: user,
      livemode: false,
    };
    const snapshot = await genericBillingReadService.snapshot(identity);
    expect(snapshot.mutationRevision).toBe(String(result.subscription.lifecycle_revision));
    expect(snapshot.entitlement?.access).toBe("granted");
    expect(snapshot.allowances.map((row) => row.remainingUsd)).toEqual(["5.000000"]);
    expect(JSON.stringify(snapshot)).not.toContain("cus_infrastructure");
    await expect(
      genericBillingReadService.snapshot({ ...identity, appId: appB }),
    ).rejects.toThrow();
    await expect(
      genericBillingReadService.snapshot({ ...identity, livemode: true }),
    ).rejects.toThrow();
    await client.query(
      "UPDATE app_billing_members SET revoked_at=now() WHERE billing_account_id=$1",
      [scope.billing_account_id],
    );
    await expect(genericBillingReadService.snapshot(identity)).rejects.toThrow("membership");
  });

  test("missing projection is unavailable rather than an empty subscription", async () => {
    const { input } = await providerTrialFixture();
    const { appSubscriptionFinalizer } = await import("./app-subscription-finalizer");
    const { genericBillingReadService } = await import("../../lib/services/generic-billing-read");
    await appSubscriptionFinalizer.applyObservation(input);
    const { appBillingScopes } = await import("../schemas/app-billing");
    const { dbWrite } = await import("../helpers");
    const { eq } = await import("drizzle-orm");
    const [scope] = await dbWrite
      .select()
      .from(appBillingScopes)
      .where(eq(appBillingScopes.id, input.scopeId));
    if (!scope) throw new Error("Missing scope fixture");
    await client.query("DELETE FROM organization_entitlements WHERE billing_scope_id=$1", [
      scope.id,
    ]);
    await expect(
      genericBillingReadService.snapshot({
        appId: scope.app_id,
        billingAccountId: scope.billing_account_id,
        productFamilyKey: "main",
        actorUserId: user,
        livemode: false,
      }),
    ).rejects.toThrow("projection");
  });

  test("an expired trial snapshot denies access without waiting for another webhook", async () => {
    const { input, trial } = await providerTrialFixture("25.000000", true);
    const { appSubscriptionFinalizer } = await import("./app-subscription-finalizer");
    const { genericBillingReadService } = await import("../../lib/services/generic-billing-read");
    await appSubscriptionFinalizer.applyObservation(input);
    const { appBillingScopes } = await import("../schemas/app-billing");
    const { dbWrite } = await import("../helpers");
    const { eq } = await import("drizzle-orm");
    const [scope] = await dbWrite
      .select()
      .from(appBillingScopes)
      .where(eq(appBillingScopes.id, input.scopeId));
    if (!scope) throw new Error("Missing scope fixture");
    await Bun.sleep(Math.max(1, trial.ends_at.getTime() - Date.now() + 50));
    const snapshot = await genericBillingReadService.snapshot({
      appId: scope.app_id,
      billingAccountId: scope.billing_account_id,
      productFamilyKey: "main",
      actorUserId: user,
      livemode: false,
    });
    expect(snapshot.entitlement?.access).toBe("read_only");
    expect(snapshot.entitlement?.featureKeys).toEqual([]);
    expect(snapshot.allowances.every((row) => row.remainingUsd === "0.000000")).toBe(true);
    expect(snapshot.trialEligibility.status).toBe("claimed");
  });
});
