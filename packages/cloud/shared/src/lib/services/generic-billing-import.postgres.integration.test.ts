/** Exercises real PostgreSQL history imports and canonical lifecycle finalization through controlled, read-only Stripe HTTP. */
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Client } from "pg";
import { createImportStripeFixture } from "./generic-billing-import.stripe-fixture";
import type { AppBillingImportManifest } from "./generic-billing-import-manifest";
import { settlementDigest } from "./settlement-digest";

const databaseUrl = process.env.APP_BILLING_TEST_POSTGRES_URL;
const schema = `app_import_${randomUUID().replaceAll("-", "_")}`;
if (databaseUrl) {
  const url = new URL(databaseUrl);
  url.searchParams.set("options", `-c search_path=${schema},public`);
  process.env.DATABASE_URL = url.toString();
  process.env.TEST_DATABASE_URL = url.toString();
}
process.env.NODE_ENV = "test";
process.env.LOCAL_PG_POOL_MAX = "4";
setDefaultTimeout(120000);
let db: Client;
let close: typeof import("../../db/client").closeDatabaseConnectionsForTests;
let authority: typeof import("../../db/repositories/app-subscription-authority").appSubscriptionAuthorityRepository;
let runImport: typeof import("./generic-billing-import").importAppBillingHistory;
const fixture = createImportStripeFixture();
const ids = {
  org: randomUUID(),
  buyerOrg: randomUUID(),
  app: randomUUID(),
  merchant: randomUUID(),
  user: randomUUID(),
  otherUser: randomUUID(),
  plan: randomUUID(),
};
let sequence = 0;
async function purchaser(merchantId = ids.merchant) {
  const user = randomUUID();
  await db.query("INSERT INTO users(id,email_verified) VALUES($1,true)", [user]);
  const account = await authority.createAccount({
    appId: ids.app,
    externalAccountKey: `user:${user}`,
    displayName: "Imported purchaser",
    principalUserId: user,
  });
  await db.query("UPDATE users SET email_verified=false WHERE id=$1", [user]);
  const scope = await authority.resolveScope({
    actorUserId: user,
    appId: ids.app,
    billingAccountId: account.id,
    productFamilyKey: "main",
    merchantId,
  });
  return { user, account, scope };
}
async function source(
  kind: "local" | "trial" | "paid",
  merchantId = ids.merchant,
  planId = ids.plan,
) {
  const buyer = await purchaser(merchantId),
    n = ++sequence,
    now = Math.floor(Date.now() / 1000),
    starts = now - 3600,
    ends = starts + 604800;
  const manifest: AppBillingImportManifest = {
    version: 1,
    kind: "subscription_import",
    sourceSystem: "historical-product",
    sourceRecordId: `source-${n}`,
    sourceDigest: "a".repeat(64),
    scopeId: buyer.scope.scopeId,
    planRevisionId: planId,
    principalUserId: buyer.user,
    quantity: 1,
    trial:
      kind === "paid"
        ? null
        : {
            planRevisionId: planId,
            startsAt: new Date(starts * 1000).toISOString(),
            endsAt: new Date(ends * 1000).toISOString(),
          },
    provider:
      kind === "local"
        ? null
        : {
            customerId: `cus_import${n}`,
            subscriptionId: `sub_import${n}`,
            invoiceId: kind === "paid" ? `in_import${n}` : null,
          },
    allowance:
      kind === "local" ? null : { availableUsd: kind === "paid" ? "17.000000" : "2.000000" },
  };
  if (manifest.provider)
    fixture.subscriptions.set(manifest.provider.subscriptionId, {
      id: manifest.provider.subscriptionId,
      customerId: manifest.provider.customerId,
      quantity: 1,
      status: kind === "paid" ? "active" : "trialing",
      periodStart: starts,
      periodEnd: kind === "paid" ? starts + 2592000 : ends,
      trialStart: kind === "paid" ? null : starts,
      trialEnd: kind === "paid" ? null : ends,
      invoiceId: manifest.provider.invoiceId,
    });
  return { buyer, manifest, digest: settlementDigest(manifest) };
}
describe.skipIf(!databaseUrl)("trusted external billing imports", () => {
  beforeAll(async () => {
    db = new Client({ connectionString: databaseUrl });
    await db.connect();
    await db.query("CREATE EXTENSION IF NOT EXISTS btree_gist WITH SCHEMA public");
    await db.query(`CREATE SCHEMA ${schema}`);
    await db.query(`SET search_path TO ${schema},public`);
    await db.query(`CREATE TABLE organizations(id uuid PRIMARY KEY,is_active boolean NOT NULL DEFAULT true,account_lifecycle_state text NOT NULL DEFAULT 'active',paid_work_fenced_at timestamptz,stripe_customer_id text,credit_balance numeric NOT NULL DEFAULT 0);
      CREATE TABLE users(id uuid PRIMARY KEY,is_active boolean NOT NULL DEFAULT true,deleted_at timestamptz,email_verified boolean NOT NULL DEFAULT true,is_anonymous boolean NOT NULL DEFAULT false,account_lifecycle_state text NOT NULL DEFAULT 'active',auth_fenced_at timestamptz,expires_at timestamptz);
      CREATE TABLE credit_transactions(id uuid PRIMARY KEY,organization_id uuid NOT NULL REFERENCES organizations(id),CONSTRAINT credit_transactions_id_org_idx UNIQUE(id,organization_id));`);
    for (const tag of [
      "0373_subscription_authority",
      "0374_subscription_funding_transaction_uniqueness",
      "0379_subscription_account_authority",
    ]) {
      const migration = await readFile(
        new URL(`../../db/migrations/${tag}.sql`, import.meta.url),
        "utf8",
      );
      for (const statement of migration.split("--> statement-breakpoint"))
        if (statement.trim()) await db.query(statement);
    }
    await db.query("INSERT INTO organizations(id,credit_balance) VALUES($1,100),($2,42)", [
      ids.org,
      ids.buyerOrg,
    ]);
    await db.query(
      "INSERT INTO billing_subscriptions(organization_id,provider_environment,stripe_customer_id,stripe_subscription_id,stripe_subscription_item_id,plan_key,catalog_version,status,current_period_start,current_period_end,lifecycle_revision,provider_object_digest) VALUES($1,'test','cus_legacy','sub_legacy','si_legacy','plus_monthly','legacy-v1','active',now(),now()+interval '30 days',1,$2)",
      [ids.buyerOrg, "e".repeat(64)],
    );
    const { applyAppBillingTestMigrations } = await import(
      "../../db/repositories/app-billing-test-migrations"
    );
    await applyAppBillingTestMigrations(async (statement) => {
      await db.query(statement);
    });
    for (const tag of [
      "0402_app_billing_application_slots",
      "0403_app_billing_import_commands",
      "0404_app_billing_import_guards",
      "0405_app_billing_import_allowance",
      "0413_app_billing_payment_expiry",
    ]) {
      for (const statement of (
        await readFile(new URL(`../../db/migrations/${tag}.sql`, import.meta.url), "utf8")
      ).split("--> statement-breakpoint"))
        if (statement.trim()) await db.query(statement);
    }
    await db.query("INSERT INTO users(id) VALUES($1),($2)", [ids.user, ids.otherUser]);
    await db.query("INSERT INTO apps(id,organization_id) VALUES($1,$2)", [ids.app, ids.org]);
    await db.query(
      "INSERT INTO billing_merchants(id,organization_id,provider_account_key,stripe_account_id,livemode,enabled) VALUES($1,$2,'acct_runtime','acct_runtime',false,true)",
      [ids.merchant, ids.org],
    );
    await db.query(
      `INSERT INTO app_billing_plan_revisions(id,app_id,merchant_id,product_family_key,plan_key,revision,name,amount_cents,currency,interval,maximum_quantity,trial_allowance_usd,paid_allowance_usd,expired_access,entitlements,stripe_price_id,stripe_product_id,published_at) VALUES($1,$2,$3,'main','basic',1,'Basic',3000,'usd','month',10,'5.000000','25.000000','read_only','{"features":["inference"],"completionsRpm":60,"embeddingsRpm":60,"standardRpm":60,"strictRpm":10}','price_basic','prod_basic',now())`,
      [ids.plan, ids.app, ids.merchant],
    );
    authority = (await import("../../db/repositories/app-subscription-authority"))
      .appSubscriptionAuthorityRepository;
    runImport = (await import("./generic-billing-import")).importAppBillingHistory;
    close = (await import("../../db/client")).closeDatabaseConnectionsForTests;
  });
  afterAll(async () => {
    if (close) await close();
    if (db) {
      await db.query(`DROP SCHEMA ${schema} CASCADE`);
      await db.end();
    }
  });
  test("consumes exact local trial history once without fabricating a subscription or allowance", async () => {
    const input = await source("local");
    const results = await Promise.all([
      runImport(input, async () => fixture.stripe),
      runImport(input, async () => fixture.stripe),
    ]);
    expect(results.some((r) => r.status === "applied")).toBe(true);
    const replay = await runImport(input, async () => fixture.stripe);
    expect(replay.status).toBe("applied");
    const trial = (
      await db.query(
        "SELECT starts_at,ends_at FROM app_subscription_trials WHERE billing_scope_id=$1",
        [input.manifest.scopeId],
      )
    ).rows[0];
    expect(trial.starts_at.toISOString()).toBe(input.manifest.trial!.startsAt);
    expect(trial.ends_at.toISOString()).toBe(input.manifest.trial!.endsAt);
    expect(
      (
        await db.query("SELECT count(*) FROM billing_subscriptions WHERE billing_scope_id=$1", [
          input.manifest.scopeId,
        ])
      ).rows[0].count,
    ).toBe("0");
    const changed = {
      ...input.manifest,
      trial: {
        planRevisionId: ids.plan,
        startsAt: new Date(Date.parse(input.manifest.trial!.startsAt) + 1000).toISOString(),
        endsAt: new Date(Date.parse(input.manifest.trial!.endsAt) + 1000).toISOString(),
      },
    };
    await expect(
      runImport(
        { manifest: changed, digest: settlementDigest(changed) },
        async () => fixture.stripe,
      ),
    ).rejects.toThrow();
    const nextCommand = await authority.prepareCommand({
      scopeId: input.manifest.scopeId,
      actorUserId: input.buyer.user,
      kind: "checkout",
      targetPlanRevisionId: ids.plan,
      quantity: 1,
      idempotencyKey: "new-trial-rejected",
      requestDigest: "e".repeat(64),
      expectedSubscriptionRevision: null,
      payload: {
        version: 1,
        domain: "buyer",
        action: "trial",
        planRevisionId: ids.plan,
        quantity: 1,
      },
    });
    await expect(
      authority.claimTrial({
        scopeId: input.manifest.scopeId,
        commandId: nextCommand.id,
        planRevisionId: ids.plan,
      }),
    ).rejects.toThrow();
  });
  test("retains original provider trial and consumed allowance through reconciliation and import replay", async () => {
    const input = await source("trial");
    const imported = await runImport(input, async () => fixture.stripe);
    expect(imported.status).toBe("applied");
    const row = (
      await db.query("SELECT * FROM billing_subscriptions WHERE billing_scope_id=$1", [
        input.manifest.scopeId,
      ])
    ).rows[0];
    expect([
      row.stripe_customer_id,
      row.stripe_subscription_id,
      row.stripe_subscription_item_id,
      row.lifecycle_revision,
    ]).toEqual([
      input.manifest.provider!.customerId,
      input.manifest.provider!.subscriptionId,
      `si_${input.manifest.provider!.subscriptionId.replace("sub_", "")}`,
      "1",
    ]);
    expect(row.trial_start.toISOString()).toBe(input.manifest.trial!.startsAt);
    expect(
      (
        await db.query(
          "SELECT available_amount,settled_amount FROM subscription_allowance_periods WHERE billing_scope_id=$1",
          [input.manifest.scopeId],
        )
      ).rows,
    ).toEqual([{ available_amount: "2.000000", settled_amount: "3.000000" }]);
    const original = fixture.subscriptions.get(input.manifest.provider!.subscriptionId)!;
    original.status = "canceled";
    const { verifyAppBillingImportProvider } = await import("./generic-billing-import-provider");
    const observed = await verifyAppBillingImportProvider({
      stripe: fixture.stripe,
      merchant: {
        merchantId: ids.merchant,
        kind: "connected",
        stripeAccountId: "acct_runtime",
        livemode: false,
      },
      scope: input.buyer.scope,
      plan: {
        planRevisionId: ids.plan,
        priceId: "price_basic",
        productId: "prod_basic",
        amountCents: 3000,
        currency: "usd",
        interval: "month",
        intervalCount: 1,
        minimumQuantity: 1,
        maximumQuantity: 10,
        trialDays: 7,
      },
      manifest: input.manifest,
    });
    const { appSubscriptionFinalizer } = await import(
      "../../db/repositories/app-subscription-finalizer"
    );
    await appSubscriptionFinalizer.applyObservation({
      scopeId: input.manifest.scopeId,
      planRevisionId: ids.plan,
      expectedSubscriptionRevision: 1,
      subscription: observed.subscription!,
      invoice: null,
      command: null,
      event: null,
    });
    await runImport(input, async () => fixture.stripe);
    expect(
      (
        await db.query("SELECT status,lifecycle_revision FROM billing_subscriptions WHERE id=$1", [
          row.id,
        ])
      ).rows,
    ).toEqual([{ status: "canceled", lifecycle_revision: "2" }]);
    expect(
      (
        await db.query(
          "SELECT available_amount FROM subscription_allowance_periods WHERE billing_scope_id=$1",
          [input.manifest.scopeId],
        )
      ).rows[0].available_amount,
    ).toBe("2.000000");
  });
  test("preserves paid invoice identity, payment proof and remaining noncash balance without touching cash", async () => {
    const input = await source("paid");
    await runImport(input, async () => fixture.stripe);
    expect(
      (
        await db.query(
          "SELECT stripe_invoice_id FROM app_subscription_paid_periods WHERE billing_scope_id=$1",
          [input.manifest.scopeId],
        )
      ).rows[0].stripe_invoice_id,
    ).toBe(input.manifest.provider!.invoiceId);
    expect(
      (
        await db.query(
          "SELECT available_amount,settled_amount FROM subscription_allowance_periods WHERE billing_scope_id=$1",
          [input.manifest.scopeId],
        )
      ).rows,
    ).toEqual([{ available_amount: "17.000000", settled_amount: "8.000000" }]);
    expect(
      (
        await db.query(
          "SELECT entitlement_effective FROM organization_entitlements WHERE billing_scope_id=$1",
          [input.manifest.scopeId],
        )
      ).rows[0].entitlement_effective,
    ).toBe(true);
    expect(
      (await db.query("SELECT credit_balance FROM organizations WHERE id=$1", [ids.buyerOrg]))
        .rows[0].credit_balance,
    ).toBe("42");
    expect(
      fixture.requests.every((r) => r.method === "GET" && r.version === "2024-11-20.acacia"),
    ).toBe(true);
  });
  test("rolls back all adoption records when remaining allowance exceeds the verified grant", async () => {
    const input = await source("trial");
    input.manifest.allowance = { availableUsd: "6.000000" };
    input.digest = settlementDigest(input.manifest);
    await expect(runImport(input, async () => fixture.stripe)).rejects.toThrow("remaining balance");
    const rows = (
      await db.query(
        "SELECT (SELECT count(*) FROM billing_subscriptions WHERE billing_scope_id=$1) subscriptions,(SELECT count(*) FROM app_subscription_trials WHERE billing_scope_id=$1) trials,(SELECT count(*) FROM app_billing_customers WHERE billing_account_id=$2) customers,(SELECT count(*) FROM app_subscription_outbox WHERE billing_scope_id=$1) outbox",
        [input.manifest.scopeId, input.buyer.account.id],
      )
    ).rows[0];
    expect(rows).toEqual({ subscriptions: "0", trials: "0", customers: "0", outbox: "0" });
  });
  test("rejects wrong provider mode and shared historical customer invoices before adoption", async () => {
    const input = await source("paid");
    fixture.setWrongMode(true);
    await expect(runImport(input, async () => fixture.stripe)).rejects.toThrow();
    fixture.setWrongMode(false);
    fixture.setExtraInvoiceCustomer(input.manifest.provider!.customerId);
    await expect(runImport(input, async () => fixture.stripe)).rejects.toThrow(
      "unrelated invoices",
    );
    fixture.setExtraInvoiceCustomer(null);
    expect(
      (
        await db.query("SELECT count(*) FROM app_billing_customers WHERE billing_account_id=$1", [
          input.buyer.account.id,
        ])
      ).rows[0].count,
    ).toBe("0");
  });
  test("rejects a subscription canceled while its payment evidence is being read", async () => {
    const input = await source("paid");
    const original = fixture.subscriptions.get(input.manifest.provider!.subscriptionId)!;
    fixture.beforeRead(async () => {
      if (fixture.requests.at(-1)?.path === `/v1/invoices/${original.invoiceId}`) {
        original.status = "canceled";
        fixture.beforeRead(null);
      }
    });
    try {
      await expect(runImport(input, async () => fixture.stripe)).rejects.toThrow(
        "changed while verifying",
      );
    } finally {
      fixture.beforeRead(null);
    }
    expect(
      (
        await db.query("SELECT count(*) FROM billing_subscriptions WHERE billing_scope_id=$1", [
          input.manifest.scopeId,
        ])
      ).rows[0].count,
    ).toBe("0");
    expect(
      (
        await db.query(
          "SELECT count(*) FROM subscription_allowance_periods WHERE billing_scope_id=$1",
          [input.manifest.scopeId],
        )
      ).rows[0].count,
    ).toBe("0");
  });
  test("refuses stale leases and leaves canonical history and cash unchanged", async () => {
    const input = await source("trial");
    fixture.beforeRead(async () => {
      fixture.beforeRead(null);
      await db.query(
        "UPDATE billing_subscription_commands SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE billing_scope_id=$1",
        [input.manifest.scopeId],
      );
    });
    await expect(runImport(input, async () => fixture.stripe)).rejects.toThrow("execution lease");
    expect(
      (
        await db.query("SELECT count(*) FROM billing_subscriptions WHERE billing_scope_id=$1", [
          input.manifest.scopeId,
        ])
      ).rows[0].count,
    ).toBe("0");
    const platformMerchant = randomUUID();
    const platformPlan = randomUUID();
    await db.query(
      "INSERT INTO billing_merchants(id,organization_id,provider_account_key,stripe_account_id,livemode,enabled) VALUES($1,$2,'platform','acct_platform',false,true)",
      [platformMerchant, ids.org],
    );
    await db.query(
      `INSERT INTO app_billing_plan_revisions(id,app_id,merchant_id,product_family_key,plan_key,revision,name,amount_cents,currency,interval,maximum_quantity,trial_allowance_usd,paid_allowance_usd,expired_access,entitlements,stripe_price_id,stripe_product_id,published_at)
       SELECT $1,app_id,$2,product_family_key,'platform-basic',revision,name,amount_cents,currency,interval,maximum_quantity,trial_allowance_usd,paid_allowance_usd,expired_access,entitlements,stripe_price_id,stripe_product_id,published_at FROM app_billing_plan_revisions WHERE id=$3`,
      [platformPlan, platformMerchant, ids.plan],
    );
    const platformSource = await source("trial", platformMerchant, platformPlan);
    const legacy = {
      ...platformSource.manifest,
      provider: { customerId: "cus_legacy", subscriptionId: "sub_legacy", invoiceId: null },
      sourceRecordId: "legacy-source",
    };
    await expect(
      runImport({ manifest: legacy, digest: settlementDigest(legacy) }, async () => fixture.stripe),
    ).rejects.toThrow("Historical organization");
    expect(
      (
        await db.query(
          "SELECT organization_id,billing_scope_id,stripe_customer_id FROM billing_subscriptions WHERE stripe_subscription_id='sub_legacy'",
        )
      ).rows,
    ).toEqual([
      { organization_id: ids.buyerOrg, billing_scope_id: null, stripe_customer_id: "cus_legacy" },
    ]);
  });
});
