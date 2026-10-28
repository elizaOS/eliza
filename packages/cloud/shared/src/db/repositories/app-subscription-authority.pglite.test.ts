/**
 * Exercises app billing migrations and finalization against PGlite or independent PostgreSQL sessions.
 * Set APP_BILLING_TEST_POSTGRES_URL to run the same contract in an isolated PostgreSQL schema.
 */
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Client } from "pg";
import { loadCanonicalMigrations } from "../../../../scripts/admin/canonical-migration-ledger";
import {
  installBillingCommandEvidenceTestColumns,
  installSubscriptionGrantTestSchema,
} from "../../testing";

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
const promotionalOrg = randomUUID();
const promotionalPeriod = randomUUID();
const user = randomUUID();
const merchant = randomUUID();
const appA = randomUUID();
const appB = randomUUID();
const planA = randomUUID();
const planB = randomUUID();
const digest = "a".repeat(64);
let invoiceAuthorityMigration: string[];

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
    "0397_subscription_checkout_contract",
    "0383_subscription_cancellation_result",
    "0384_subscription_cancellation_undo",
    "0438_app_billing_applied_revision",
    "0374_subscription_funding_transaction_uniqueness",
    "0379_subscription_account_authority",
    "0400_app_billing_catalog",
    "0401_app_billing_scope_records",
    "0402_app_billing_registration_constraints",
    "0403_subscription_app_scope_columns",
    "0404_subscription_app_scope_constraints",
    "0405_subscription_app_scope_guards",
    "0406_subscription_app_source_guards",
    "0407_app_delegations",
    "0427_app_billing_return_destination",
    "0408_app_billing_command_intents",
    "0409_app_billing_command_guards",
    "0410_app_billing_update_quotes",
    "0411_app_billing_merchant_identity",
    "0413_app_billing_notification_endpoints",
    "0508_app_notification_secret_envelope_v2",
    "0414_app_subscription_outbox_delivery",
    "0415_app_billing_webhook_recovery",
    "0416_app_billing_checkout_expiry",
    "0417_app_billing_membership_authority",
    "0424_app_billing_administrators",
    "0428_billing_identity_anchors",
    "0429_billing_identity_backfill",
    "0430_billing_identity_references",
    "0511_organization_plan_change_quotes",
    "0512_organization_upgrade_dispatch",
  ]) {
    const migration = await readFile(new URL(`../migrations/${tag}.sql`, import.meta.url), "utf8");
    for (const statement of migration.split("--> statement-breakpoint"))
      if (statement.trim()) await client.exec(statement.replaceAll('"public".', ""));
  }
  const canonical = await loadCanonicalMigrations();
  const authority = canonical.find(
    (migration) => migration.entry.tag === "0534_subscription_allowance_invoice_authority",
  );
  if (!authority)
    throw new Error("Invoice authority migration is absent from the canonical ledger");
  invoiceAuthorityMigration = authority.statements;
  for (const statement of invoiceAuthorityMigration) await client.exec(statement);
  const pilotMigration = canonical.find(
    (migration) => migration.entry.tag === "0541_app_pilot_redemptions",
  );
  if (!pilotMigration) throw new Error("Pilot migration is absent from the canonical ledger");
  for (const statement of pilotMigration.statements) await client.exec(statement);
  await installSubscriptionGrantTestSchema((statement) => client.exec(statement));
  // Keep a real existing promotional bucket across the pilot migration.
  await client.query("INSERT INTO organizations(id) VALUES($1)", [promotionalOrg]);
  await client.query(
    `WITH code AS (
      INSERT INTO subscription_grant_codes(code_hash,max_redemptions) VALUES($1,1) RETURNING id
    ), grant_row AS (
      INSERT INTO subscription_grants(organization_id,code_id,family,plan_key,catalog_version,idempotency_key,starts_at,ends_at)
      SELECT $2,id,'alpha_phone','plus_monthly','v1','pilot-migration-coexistence',now(),now()+interval '1 month' FROM code RETURNING id
    )
    INSERT INTO subscription_allowance_periods(id,organization_id,provider,provider_environment,grant_source,promo_grant_id,plan_key,catalog_version,period_start,period_end,expires_at,granted_amount,available_amount)
    SELECT $3,$2,'eliza','test','promo_grant',id,'plus_monthly','v1',now(),now()+interval '1 month',now()+interval '1 month',25,25 FROM grant_row`,
    ["b".repeat(64), promotionalOrg, promotionalPeriod],
  );
  const pilotAllowance = canonical.find(
    (migration) => migration.entry.tag === "0543_app_pilot_allowance",
  );
  if (!pilotAllowance) throw new Error("Pilot allowance migration is missing");
  for (const statement of pilotAllowance.statements) await client.exec(statement);
  await installBillingCommandEvidenceTestColumns((statement) => client.exec(statement));

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

test("pilot migration preserves an existing promotional allowance and rejects mixed source authority", async () => {
  const result = await client.query(
    "UPDATE subscription_allowance_periods SET available_amount=24,settled_amount=1 WHERE id=$1 RETURNING grant_source,pilot_redemption_id",
    [promotionalPeriod],
  );
  expect(result.rows).toEqual([{ grant_source: "promo_grant", pilot_redemption_id: null }]);
  await expect(
    client.query(
      "UPDATE subscription_allowance_periods SET provider='pilot',grant_source='pilot' WHERE id=$1",
      [promotionalPeriod],
    ),
  ).rejects.toThrow();
});

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
  test("paid allowance cannot use a null invoice as a substitute for financial authority", async () => {
    const { appSubscriptionFinalizer } = await import("./app-subscription-finalizer");
    const { input } = await providerTrialFixture();
    const result = await appSubscriptionFinalizer.applyObservation(input);
    expect(result.allowance?.grant_source).toBe("trial_claim");
    expect(result.allowance?.stripe_invoice_id).toBeNull();
    const insertPaid = (invoice: string | null) =>
      client.query(
        `INSERT INTO subscription_allowance_periods
        (billing_scope_id, merchant_key, organization_id, subscription_id, subscription_revision,
         provider, provider_environment, stripe_invoice_id, grant_source, trial_claim_id,
         plan_key, catalog_version, period_start, period_end, expires_at,
         granted_amount, available_amount)
       SELECT billing_scope_id, merchant_key, organization_id, subscription_id, subscription_revision,
         provider, provider_environment, $2, 'paid_invoice', NULL,
         plan_key, catalog_version, period_start + interval '2 months',
         period_end + interval '2 months', expires_at + interval '2 months',
         granted_amount, granted_amount
       FROM subscription_allowance_periods WHERE id=$1 RETURNING id, stripe_invoice_id`,
        [result.allowance!.id, invoice],
      );
    await expect(insertPaid(null)).rejects.toMatchObject({
      code: "23514",
      constraint: "subscription_allowance_periods_invoice_id_check",
    });
    await expect(insertPaid("")).rejects.toMatchObject({
      code: "23514",
      constraint: "subscription_allowance_periods_invoice_id_check",
    });
    await expect(insertPaid("pi_notAnInvoice")).rejects.toMatchObject({
      code: "23514",
      constraint: "subscription_allowance_periods_invoice_id_check",
    });
    const invoice = `in_${randomUUID().replaceAll("-", "")}`;
    const paid = (await insertPaid(invoice)).rows as { id: string; stripe_invoice_id: string }[];
    expect(paid).toHaveLength(1);
    expect(paid[0]!.stripe_invoice_id).toBe(invoice);
    await expect(
      client.query("UPDATE subscription_allowance_periods SET stripe_invoice_id=NULL WHERE id=$1", [
        paid[0]!.id,
      ]),
    ).rejects.toMatchObject({
      code: "23514",
      constraint: "subscription_allowance_periods_invoice_id_check",
    });
    expect(
      (
        await client.query(
          "SELECT stripe_invoice_id FROM subscription_allowance_periods WHERE id=$1",
          [paid[0]!.id],
        )
      ).rows,
    ).toEqual([{ stripe_invoice_id: invoice }]);
    // Validate existing data during rollout; never fabricate invoice provenance to
    // get a dirty historical database through the new migration.
    const predecessor = (
      await readFile(
        new URL("../migrations/0405_subscription_app_scope_guards.sql", import.meta.url),
        "utf8",
      )
    )
      .split("--> statement-breakpoint")
      .find((statement) =>
        statement.includes('ADD CONSTRAINT "subscription_allowance_periods_invoice_id_check"'),
      );
    if (!predecessor) throw new Error("Historical invoice constraint is missing");
    await client.exec("BEGIN");
    try {
      // This historical migration predates promotional grants. Isolate its fixture rows.
      await client.query("DELETE FROM subscription_allowance_periods WHERE id=$1", [
        promotionalPeriod,
      ]);
      await client.exec(
        "ALTER TABLE subscription_allowance_periods DROP CONSTRAINT subscription_allowance_periods_invoice_id_check",
      );
      await client.exec(predecessor);
      await client.query(
        "UPDATE subscription_allowance_periods SET stripe_invoice_id=NULL WHERE id=$1",
        [paid[0]!.id],
      );
      await expect(client.exec(invoiceAuthorityMigration.join("\n"))).rejects.toMatchObject({
        code: "23514",
        constraint: "subscription_allowance_periods_invoice_id_check",
      });
    } finally {
      await client.exec("ROLLBACK");
    }
    const rows = () =>
      client.query("SELECT * FROM subscription_allowance_periods WHERE id IN ($1,$2) ORDER BY id", [
        paid[0]!.id,
        result.allowance!.id,
      ]);
    const before = await rows();
    await client.exec("BEGIN");
    try {
      await client.query("DELETE FROM subscription_allowance_periods WHERE id=$1", [
        promotionalPeriod,
      ]);
      for (const statement of invoiceAuthorityMigration) await client.exec(statement);
      expect(await rows()).toEqual(before);
    } finally {
      // Restore the current constraint and promotional fixture after testing historical DDL.
      await client.exec("ROLLBACK");
    }
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

test("seller tenant predicates preserve cross-organization buyers and reject foreign accounts", async () => {
  const { appBillingQueries } = await import("./app-billing-queries");
  const { appBillingRecordsRepository } = await import("./app-billing-records");
  const { lockAppBillingOwner } = await import("./app-billing-admin");
  const { writeTransaction } = await import("../helpers");
  const seller = randomUUID();
  const buyerOrg = randomUUID();
  const buyer = randomUUID();
  const sellerUser = randomUUID();
  const outsider = randomUUID();
  const secondApp = randomUUID();
  const secondMerchant = randomUUID();
  await client.exec(
    "ALTER TABLE users ADD COLUMN organization_id uuid, ADD COLUMN role text NOT NULL DEFAULT 'member'",
  );
  await client.query("INSERT INTO organizations(id) VALUES($1),($2)", [seller, buyerOrg]);
  await client.query(
    "INSERT INTO users(id,organization_id,role) VALUES($1,$2,'owner'),($3,$4,'member'),($5,$4,'member')",
    [sellerUser, seller, buyer, buyerOrg, outsider],
  );
  await client.query("INSERT INTO apps(id,organization_id) VALUES($1,$2)", [secondApp, seller]);
  await client.query(
    "INSERT INTO billing_merchants(id,organization_id,provider_account_key,livemode,enabled) VALUES($1,$2,$3,false,true)",
    [secondMerchant, seller, `acct_${randomUUID().replaceAll("-", "")}`],
  );
  const catalog = await appBillingQueries.catalog(appA, false);
  expect(catalog.plans.length).toBeGreaterThan(0);
  const key = randomUUID();
  const account = await repository.createAccount({
    appId: appA,
    externalAccountKey: key,
    displayName: "Cross-org buyer",
    principalUserId: buyer,
  });
  const secondAccount = await repository.createAccount({
    appId: secondApp,
    externalAccountKey: randomUUID(),
    displayName: "Second seller",
    principalUserId: buyer,
  });
  const identity = {
    appId: appA,
    billingAccountId: account.id,
    actorUserId: buyer,
    productFamilyKey: "main",
    livemode: false,
  };
  const scope = await repository.resolveScope({ ...identity, merchantId: merchant });
  expect(scope.organizationId).toBe(org);
  expect(scope.organizationId).not.toBe(buyerOrg);
  expect((await appBillingQueries.snapshot(identity)).account.id).toBe(account.id);
  expect(await appBillingRecordsRepository.seats(identity, null, 10)).toEqual([]);
  await expect(
    repository.createAccount({
      appId: appA,
      externalAccountKey: key,
      displayName: "Collision",
      principalUserId: outsider,
    }),
  ).rejects.toThrow("ownership");
  for (const invalid of [
    { ...identity, billingAccountId: secondAccount.id },
    { ...identity, actorUserId: outsider },
  ]) {
    await expect(appBillingQueries.snapshot(invalid)).rejects.toThrow("membership");
    await expect(appBillingRecordsRepository.seats(invalid, null, 10)).rejects.toThrow(
      "membership",
    );
  }
  await expect(
    writeTransaction((tx) =>
      lockAppBillingOwner(tx, { appId: appA, organizationId: seller, userId: sellerUser }),
    ),
  ).rejects.toThrow("administration");
  expect(
    (
      await writeTransaction((tx) =>
        lockAppBillingOwner(tx, { appId: secondApp, organizationId: seller, userId: sellerUser }),
      )
    ).app.id,
  ).toBe(secondApp);
  await expect(
    repository.resolveScope({
      ...identity,
      billingAccountId: secondAccount.id,
      merchantId: secondMerchant,
    }),
  ).rejects.toThrow();
  expect(
    (
      await client.query("SELECT id FROM app_billing_scopes WHERE billing_account_id=$1", [
        secondAccount.id,
      ])
    ).rows,
  ).toHaveLength(0);
  const command = await repository.prepareCommand({
    scopeId: scope.scopeId,
    actorUserId: buyer,
    kind: "checkout",
    payload: { version: 1, domain: "buyer", action: "trial", planRevisionId: planA, quantity: 1 },
    targetPlanRevisionId: planA,
    quantity: 1,
    idempotencyKey: randomUUID(),
    requestDigest: digest,
    expectedSubscriptionRevision: null,
  });
  expect(
    (
      await repository.claimTrial({
        scopeId: scope.scopeId,
        commandId: command.id,
        planRevisionId: planA,
      })
    ).id,
  ).toBeDefined();
  await client.query(
    "UPDATE app_billing_members SET revoked_at=now() WHERE billing_account_id=$1",
    [account.id],
  );
  await expect(appBillingQueries.snapshot(identity)).rejects.toThrow("membership");
});

describe("sponsored pilot admission ledger", () => {
  async function pilotAccount() {
    const actor = randomUUID();
    await client.query("INSERT INTO users(id) VALUES ($1)", [actor]);
    const account = await repository.createAccount({
      appId: appA,
      externalAccountKey: randomUUID(),
      displayName: "Pilot",
      principalUserId: actor,
    });
    const scope = await repository.resolveScope({
      appId: appA,
      billingAccountId: account.id,
      productFamilyKey: "main",
      merchantId: merchant,
      actorUserId: actor,
    });
    return { actor, account, scope };
  }
  async function campaign(
    maximum = 2,
    opens = "now() - interval '1 day'",
    closes = "now() + interval '1 day'",
    appId: string = appA,
    planId: string = planA,
  ) {
    const { appPilotCodeDigest } = await import("./app-pilot-redemptions");
    const code = randomUUID().replaceAll("-", "");
    const id = randomUUID();
    await client.query(
      `INSERT INTO app_pilot_campaigns(id, app_id, plan_revision_id, livemode, code_digest, maximum_redemptions, opens_at, closes_at) VALUES ($1,$2,$3,false,$4,$5,${opens},${closes})`,
      [id, appId, planId, appPilotCodeDigest(code), maximum],
    );
    return { id, code };
  }
  async function invite(campaignId: string, principal: string) {
    await client.query(
      "INSERT INTO app_pilot_invitations(campaign_id,eligibility_principal_id) VALUES ($1,$2)",
      [campaignId, principal],
    );
  }
  async function redeem(account: Awaited<ReturnType<typeof pilotAccount>>, code: string) {
    return (await import("./app-pilot-redemptions")).appPilotRedemptionsRepository.redeem({
      appId: appA,
      livemode: false,
      scopeId: account.scope.scopeId,
      actorUserId: account.actor,
      code,
    });
  }
  test("real database redemption survives lost-response retry, campaign revocation and immutable-history checks", async () => {
    const account = await pilotAccount();
    const offer = await campaign(1);
    await invite(offer.id, account.scope.eligibilityPrincipalId);
    const first = await redeem(account, offer.code);
    expect(first.replayed).toBe(false);
    const retry = await redeem(account, offer.code);
    expect(retry).toEqual({ redemption: first.redemption, replayed: true });
    await client.query("UPDATE app_pilot_campaigns SET revoked_at=clock_timestamp() WHERE id=$1", [
      offer.id,
    ]);
    expect((await redeem(account, offer.code)).redemption).toEqual(first.redemption);
    await expect(
      client.query(
        "UPDATE app_pilot_redemptions SET ends_at=ends_at + interval '1 month' WHERE id=$1",
        [first.redemption.id],
      ),
    ).rejects.toThrow();
    await expect(
      client.query("DELETE FROM app_pilot_redemptions WHERE id=$1", [first.redemption.id]),
    ).rejects.toThrow();
    await expect(
      client.query("UPDATE app_pilot_campaigns SET revoked_at=NULL WHERE id=$1", [offer.id]),
    ).rejects.toThrow();
    const otherOffer = await campaign();
    await invite(otherOffer.id, account.scope.eligibilityPrincipalId);
    await expect(redeem(account, otherOffer.code)).rejects.toThrow("already been used");
    const second = await pilotAccount();
    await invite(offer.id, second.scope.eligibilityPrincipalId);
    await expect(redeem(second, offer.code)).rejects.toThrow("expired, revoked or full");
    expect(
      (
        await client.query(
          "SELECT count(*)::integer AS n FROM billing_subscriptions WHERE billing_scope_id=$1",
          [account.scope.scopeId],
        )
      ).rows,
    ).toEqual([{ n: 0 }]);
    expect(
      (
        await client.query(
          "SELECT count(*)::integer AS n FROM subscription_allowance_periods WHERE billing_scope_id=$1",
          [account.scope.scopeId],
        )
      ).rows,
    ).toEqual([{ n: 6 }]);
  });
  test("publication failure rolls back redemption, allowance and campaign capacity together", async () => {
    const account = await pilotAccount();
    const offer = await campaign(1);
    await invite(offer.id, account.scope.eligibilityPrincipalId);
    await client.exec(
      "CREATE FUNCTION reject_pilot_activation_test() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'controlled activation failure'; END $$; CREATE TRIGGER reject_pilot_activation_test BEFORE INSERT ON app_pilot_activations FOR EACH ROW EXECUTE FUNCTION reject_pilot_activation_test()",
    );
    try {
      await expect(redeem(account, offer.code)).rejects.toThrow();
      expect(
        (
          await client.query(
            "SELECT count(*)::integer n FROM app_pilot_redemptions WHERE campaign_id=$1",
            [offer.id],
          )
        ).rows,
      ).toEqual([{ n: 0 }]);
      expect(
        (
          await client.query(
            "SELECT count(*)::integer n FROM subscription_allowance_periods WHERE billing_scope_id=$1",
            [account.scope.scopeId],
          )
        ).rows,
      ).toEqual([{ n: 0 }]);
    } finally {
      await client.exec(
        "DROP TRIGGER reject_pilot_activation_test ON app_pilot_activations; DROP FUNCTION reject_pilot_activation_test()",
      );
    }
    expect((await redeem(account, offer.code)).replayed).toBe(false);
  });
  test("another billing account for the same principal cannot restart the pilot", async () => {
    const first = await pilotAccount();
    const offer = await campaign();
    await invite(offer.id, first.scope.eligibilityPrincipalId);
    await redeem(first, offer.code);
    const account = await repository.createAccount({
      appId: appA,
      externalAccountKey: randomUUID(),
      displayName: "Second account",
      principalUserId: first.actor,
    });
    const scope = await repository.resolveScope({
      appId: appA,
      billingAccountId: account.id,
      productFamilyKey: "main",
      merchantId: merchant,
      actorUserId: first.actor,
    });
    await expect(redeem({ actor: first.actor, account, scope }, offer.code)).rejects.toThrow(
      "already been used",
    );
  });
  test("existing provider subscription is retained and cannot receive a second pilot obligation", async () => {
    const fixture = await providerTrialFixture();
    await (await import("./app-subscription-finalizer")).appSubscriptionFinalizer.applyObservation(
      fixture.input,
    );
    const [scope] = (
      await client.query(
        "SELECT s.app_id, a.eligibility_principal_id FROM app_billing_scopes s JOIN app_billing_accounts a ON a.id=s.billing_account_id WHERE s.id=$1",
        [fixture.input.scopeId],
      )
    ).rows as { app_id: string; eligibility_principal_id: string }[];
    const offer = await campaign(
      2,
      undefined,
      undefined,
      scope!.app_id,
      fixture.input.planRevisionId,
    );
    await invite(offer.id, scope!.eligibility_principal_id);
    await expect(
      (await import("./app-pilot-redemptions")).appPilotRedemptionsRepository.redeem({
        appId: scope!.app_id,
        livemode: false,
        scopeId: fixture.input.scopeId,
        actorUserId: user,
        code: offer.code,
      }),
    ).rejects.toThrow("Existing billing");
  });
  test("invitation, environment, account membership and campaign time are required", async () => {
    const account = await pilotAccount();
    const offer = await campaign();
    await expect(redeem(account, offer.code)).rejects.toThrow("invitation");
    await invite(offer.id, account.scope.eligibilityPrincipalId);
    const repo = (await import("./app-pilot-redemptions")).appPilotRedemptionsRepository;
    const input = {
      appId: appA,
      livemode: false,
      scopeId: account.scope.scopeId,
      actorUserId: account.actor,
      code: offer.code,
    };
    await expect(repo.redeem({ ...input, livemode: true })).rejects.toThrow("environment");
    await expect(repo.redeem({ ...input, appId: appB })).rejects.toThrow("environment");
    await expect(repo.redeem({ ...input, actorUserId: user })).rejects.toThrow("administrator");
    await expect(redeem(account, "not-a-code")).rejects.toThrow("code");
    await expect(redeem(account, randomUUID().replaceAll("-", ""))).rejects.toThrow("code");
    await client.query(
      "UPDATE app_pilot_invitations SET revoked_at=clock_timestamp() WHERE campaign_id=$1",
      [offer.id],
    );
    await expect(redeem(account, offer.code)).rejects.toThrow("invitation");
    for (const dates of [
      ["now() - interval '2 days'", "now() - interval '1 day'"],
      ["now() + interval '1 day'", "now() + interval '2 days'"],
    ]) {
      const timed = await campaign(1, dates[0], dates[1]);
      await invite(timed.id, account.scope.eligibilityPrincipalId);
      await expect(redeem(account, timed.code)).rejects.toThrow("expired, revoked or full");
    }
  });
  test("parallel accounts cannot exceed the cap and retries do not consume another place", async () => {
    const a = await pilotAccount();
    const b = await pilotAccount();
    const offer = await campaign(1);
    await invite(offer.id, a.scope.eligibilityPrincipalId);
    await invite(offer.id, b.scope.eligibilityPrincipalId);
    const attempts = await Promise.allSettled([redeem(a, offer.code), redeem(b, offer.code)]);
    expect(attempts.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(attempts.filter((result) => result.status === "rejected")).toHaveLength(1);
    const winner = attempts[0]?.status === "fulfilled" ? a : b;
    const retries = await Promise.all([redeem(winner, offer.code), redeem(winner, offer.code)]);
    expect(retries.every((result) => result.replayed)).toBe(true);
    expect(retries[0]?.redemption.id).toBe(retries[1]?.redemption.id);
  });
  test("unresolved checkout prevents pilot admission without changing the checkout", async () => {
    const account = await pilotAccount();
    const offer = await campaign();
    await invite(offer.id, account.scope.eligibilityPrincipalId);
    const command = await repository.prepareCommand({
      scopeId: account.scope.scopeId,
      actorUserId: account.actor,
      kind: "checkout",
      payload: { version: 1, domain: "buyer", action: "trial", planRevisionId: planA, quantity: 1 },
      targetPlanRevisionId: planA,
      quantity: 1,
      idempotencyKey: randomUUID(),
      requestDigest: digest,
      expectedSubscriptionRevision: null,
    });
    await expect(redeem(account, offer.code)).rejects.toThrow("Existing billing");
    expect(
      (
        await client.query("SELECT status FROM billing_subscription_commands WHERE id=$1", [
          command.id,
        ])
      ).rows,
    ).toEqual([{ status: "PREPARED" }]);
  });
  test.skipIf(!postgresUrl)(
    "pilot campaign expiry uses the clock after a blocking campaign lock",
    async () => {
      const account = await pilotAccount();
      const offer = await campaign(1, "now() - interval '1 day'", "now() + interval '1 second'");
      await invite(offer.id, account.scope.eligibilityPrincipalId);
      const blocker = new Client({ connectionString: postgresUrl });
      await blocker.connect();
      await blocker.query(`SET search_path TO ${schema},public`);
      await blocker.query("BEGIN");
      await blocker.query("SELECT id FROM app_pilot_campaigns WHERE id=$1 FOR UPDATE", [offer.id]);
      const pending = redeem(account, offer.code).then(
        () => null,
        (error) => error,
      );
      try {
        await new Promise((resolve) => setTimeout(resolve, 1500));
        await blocker.query("COMMIT");
        expect((await pending)?.message).toContain("expired, revoked or full");
        expect(
          (
            await client.query(
              "SELECT count(*)::integer AS n FROM app_pilot_redemptions WHERE campaign_id=$1",
              [offer.id],
            )
          ).rows,
        ).toEqual([{ n: 0 }]);
      } finally {
        await blocker.query("ROLLBACK");
        await blocker.end();
      }
    },
  );
  test("UTC six calendar months clamps leap and non-leap month ends independently of session timezone", async () => {
    await client.exec("SET TIME ZONE 'America/Los_Angeles'");
    try {
      for (const [start, end] of [
        ["2023-08-31T23:59:59.123Z", "2024-02-29T23:59:59.123Z"],
        ["2024-08-31T05:00:00.000Z", "2025-02-28T05:00:00.000Z"],
        ["2024-02-29T12:00:00.000Z", "2024-08-29T12:00:00.000Z"],
      ]) {
        const rows = (
          await client.query(
            "SELECT (($1::timestamptz AT TIME ZONE 'UTC') + interval '6 months') AT TIME ZONE 'UTC' AS ends_at",
            [start],
          )
        ).rows as { ends_at: Date | string }[];
        expect(new Date(rows[0]!.ends_at).toISOString()).toBe(end);
      }
    } finally {
      await client.exec("SET TIME ZONE 'UTC'");
    }
  });
});
