/** Exercises real PostgreSQL upgrades, operator manifests and native slot isolation with the real Stripe SDK on controlled HTTP. */
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "pg";
import type { AppBillingSlotManifest } from "./generic-billing-import-manifest";
import { createRuntimeStripeFixture } from "./generic-billing-runtime.stripe-fixture";

const databaseUrl = process.env.APP_BILLING_TEST_POSTGRES_URL;
const schema = `app_slots_${randomUUID().replaceAll("-", "_")}`;
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
let install: typeof import("./generic-billing-application-slot").installAppBillingApplicationSlot;
let resolve: typeof import("../../db/repositories/app-billing-application-slots").resolveAppBillingApplicationSlot;
let authority: typeof import("../../db/repositories/app-subscription-authority").appSubscriptionAuthorityRepository;
const fixture = createRuntimeStripeFixture();
const ids = {
  org: randomUUID(),
  buyerOrg: randomUUID(),
  app: randomUUID(),
  merchant: randomUUID(),
  user: randomUUID(),
  otherUser: randomUUID(),
  plan: randomUUID(),
};
let scopeId: string;
let accountId: string;
let manifest: AppBillingSlotManifest;
let reviewedDigest: string;
let directory: string;
describe.skipIf(!databaseUrl)("trusted application billing slots", () => {
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
    for (const statement of (
      await readFile(
        new URL("../../db/migrations/0402_app_billing_application_slots.sql", import.meta.url),
        "utf8",
      )
    ).split("--> statement-breakpoint"))
      if (statement.trim()) await db.query(statement);
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
    install = (await import("./generic-billing-application-slot")).installAppBillingApplicationSlot;
    resolve = (await import("../../db/repositories/app-billing-application-slots"))
      .resolveAppBillingApplicationSlot;
    close = (await import("../../db/client")).closeDatabaseConnectionsForTests;
    const account = await authority.createAccount({
      appId: ids.app,
      externalAccountKey: `user:${ids.user}`,
      displayName: "Native purchaser",
      principalUserId: ids.user,
    });
    accountId = account.id;
    const scope = await authority.resolveScope({
      actorUserId: ids.user,
      appId: ids.app,
      billingAccountId: account.id,
      productFamilyKey: "main",
      merchantId: ids.merchant,
    });
    scopeId = scope.scopeId;
    manifest = {
      version: 1,
      kind: "application_slot",
      sourceSystem: "operator-registry",
      sourceRecordId: "native-main",
      sourceDigest: "a".repeat(64),
      slotKey: "native_main",
      appId: ids.app,
      developerOrganizationId: ids.org,
      merchantId: ids.merchant,
      livemode: false,
      productFamilyKey: "main",
    };
    directory = await mkdtemp(join(tmpdir(), "billing-slot-manifest-"));
    const bytes = JSON.stringify(manifest);
    reviewedDigest = createHash("sha256").update(bytes).digest("hex");
    await writeFile(join(directory, "manifest.json"), bytes, { mode: 0o600 });
  });
  afterAll(async () => {
    if (close) await close();
    if (db) {
      await db.query(`DROP SCHEMA ${schema} CASCADE`);
      await db.end();
    }
    if (directory) await rm(directory, { recursive: true });
  });
  test("requires an exact operator-owned manifest and rejects modified or linked input", async () => {
    const { readAppBillingOperatorManifest } = await import("./generic-billing-operator-manifest");
    const path = join(directory, "manifest.json");
    const reviewed = await readAppBillingOperatorManifest(path, reviewedDigest);
    expect(reviewed.manifest).toEqual(manifest);
    await expect(readAppBillingOperatorManifest(path, "b".repeat(64))).rejects.toThrow("differs");
    await chmod(path, 0o666);
    await expect(readAppBillingOperatorManifest(path, reviewedDigest)).rejects.toThrow(
      "operator-owned",
    );
    await chmod(path, 0o600);
    const linked = join(directory, "linked.json");
    await symlink(path, linked);
    await expect(readAppBillingOperatorManifest(linked, reviewedDigest)).rejects.toThrow();
  });
  test("verifies current merchant and prices without writes, then selects only the native purchaser app account", async () => {
    const row = await install({ manifest, digest: reviewedDigest }, async () => fixture.stripe);
    const replay = await install({ manifest, digest: reviewedDigest }, async () => fixture.stripe);
    expect(replay.id).toBe(row.id);
    const selected = await resolve({
      slotKey: "native_main",
      livemode: false,
      verifiedUserId: ids.user,
    });
    expect(selected).toEqual({
      slotId: row.id,
      appId: ids.app,
      billingAccountId: accountId,
      scopeId,
      productFamilyKey: "main",
      environment: "test",
      developerOrganizationId: ids.org,
      actorUserId: ids.user,
    });
    expect(fixture.requests.every((request) => request.method === "GET")).toBe(true);
    expect(
      (
        await db.query(
          "SELECT stripe_customer_id,stripe_subscription_id,stripe_subscription_item_id,billing_scope_id FROM billing_subscriptions WHERE organization_id=$1",
          [ids.buyerOrg],
        )
      ).rows,
    ).toEqual([
      {
        stripe_customer_id: "cus_legacy",
        stripe_subscription_id: "sub_legacy",
        stripe_subscription_item_id: "si_legacy",
        billing_scope_id: null,
      },
    ]);
    expect(
      (await db.query("SELECT credit_balance FROM organizations WHERE id=$1", [ids.buyerOrg]))
        .rows[0].credit_balance,
    ).toBe("42");
  });
  test("supports authenticated wallet identities and rejects another user, wrong mode, revoked identity and withdrawn approval", async () => {
    await expect(
      resolve({ slotKey: "native_main", livemode: false, verifiedUserId: ids.otherUser }),
    ).rejects.toThrow("current purchaser identity");
    await db.query("SELECT ensure_billing_identity_subject($1)", [ids.otherUser]);
    await expect(
      resolve({ slotKey: "native_main", livemode: false, verifiedUserId: ids.otherUser }),
    ).rejects.toThrow("purchaser account");
    await expect(
      resolve({ slotKey: "native_main", livemode: true, verifiedUserId: ids.user }),
    ).rejects.toThrow("environment");
    await db.query("UPDATE users SET email_verified=false WHERE id=$1", [ids.user]);
    expect(
      (await resolve({ slotKey: "native_main", livemode: false, verifiedUserId: ids.user }))
        .billingAccountId,
    ).toBe(accountId);
    await db.query("UPDATE users SET auth_fenced_at=clock_timestamp() WHERE id=$1", [ids.user]);
    await expect(
      resolve({ slotKey: "native_main", livemode: false, verifiedUserId: ids.user }),
    ).rejects.toThrow("verified");
    await db.query("UPDATE users SET auth_fenced_at=NULL WHERE id=$1", [ids.user]);
    await db.query("UPDATE apps SET review_status='draft' WHERE id=$1", [ids.app]);
    await expect(
      resolve({ slotKey: "native_main", livemode: false, verifiedUserId: ids.user }),
    ).rejects.toMatchObject({ code: "APP_BILLING_APPLICATION_SLOT_UNAVAILABLE" });
    await db.query("UPDATE apps SET review_status='approved' WHERE id=$1", [ids.app]);
  });
  test("refuses mismatched provider terms and makes disabling irreversible for that slot identity", async () => {
    await db.query(
      "INSERT INTO app_billing_plan_revisions SELECT gen_random_uuid(),app_id,merchant_id,'wrong','wrong',1,'Wrong',4000,currency,interval,interval_count,minimum_quantity,maximum_quantity,trial_days,trial_allowance_usd,paid_allowance_usd,expired_access,entitlements,stripe_price_id,stripe_product_id,published_at,retired_at,created_at FROM app_billing_plan_revisions WHERE id=$1",
      [ids.plan],
    );
    await expect(
      install(
        {
          manifest: { ...manifest, slotKey: "wrong", productFamilyKey: "wrong" },
          digest: "c".repeat(64),
        },
        async () => fixture.stripe,
      ),
    ).rejects.toThrow();
    await db.query(
      "UPDATE app_billing_plan_revisions SET retired_at=clock_timestamp() WHERE id=$1",
      [ids.plan],
    );
    const before = await resolve({
      slotKey: "native_main",
      livemode: false,
      verifiedUserId: ids.user,
    });
    await db.query(
      "UPDATE app_billing_application_slots SET disabled_at=clock_timestamp() WHERE id=$1",
      [before.slotId],
    );
    await expect(
      resolve({ slotKey: "native_main", livemode: false, verifiedUserId: ids.user }),
    ).rejects.toThrow("not configured");
    await expect(
      db.query("UPDATE app_billing_application_slots SET disabled_at=NULL WHERE id=$1", [
        before.slotId,
      ]),
    ).rejects.toThrow("disabled once");
  });
});
