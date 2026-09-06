/** Exercises canonical Checkout cleanup with real PostgreSQL and Stripe SDK over controlled HTTP, including authority races and ambiguous responses. */
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Client } from "pg";
import type { BuyerBillingIdentity, GenericBillingRuntime } from "./generic-billing-runtime";
import { createRuntimeStripeFixture } from "./generic-billing-runtime.stripe-fixture";
import { settlementDigest } from "./settlement-digest";

const postgresUrl = process.env.APP_BILLING_TEST_POSTGRES_URL;
const schema = `app_delete_checkout_${randomUUID().replaceAll("-", "_")}`;
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
let queries: typeof import("../../db/repositories/app-billing-queries").appBillingQueries;
let runtime: GenericBillingRuntime;
let resolveProvider: typeof import("./generic-billing-provider-runtime").getAppBillingProvider;
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

describe.skipIf(!postgresUrl)("departing purchaser Checkout cleanup", () => {
  beforeAll(async () => {
    db = new Client({ connectionString: postgresUrl });
    await db.connect();
    await db.query("CREATE EXTENSION IF NOT EXISTS btree_gist WITH SCHEMA public");
    await db.query(`CREATE SCHEMA ${schema}`);
    await db.query(`SET search_path TO ${schema},pg_catalog,public`);
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
      "0429_app_billing_applied_revision",
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
      "0428_app_billing_deletion_checkout",
      "0430_app_billing_completed_checkout",
      "0445_app_billing_refund_observations",
      "0462_app_billing_checkout_cleanup_receipts",
      "0463_app_billing_checkout_cleanup_evidence",
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
    queries = (await import("../../db/repositories/app-billing-queries")).appBillingQueries;
    const { appBillingProviderBindings } = await import(
      "../../db/repositories/app-billing-provider-bindings"
    );
    const { createGenericBillingProvider } = await import("./generic-billing-provider");
    const { GenericBillingRuntime } = await import("./generic-billing-runtime");
    resolveProvider = async (merchantId, livemode) => {
      if (merchantId !== merchant || livemode) throw new Error("Unexpected runtime merchant");
      return createGenericBillingProvider(
        fixture.stripe,
        { merchantId, kind: "connected", stripeAccountId: "acct_runtime", livemode },
        appBillingProviderBindings,
      );
    };
    runtime = new GenericBillingRuntime(resolveProvider);
  });
  afterAll(async () => {
    if (close) await close();
    if (db) {
      await db.query(`DROP SCHEMA ${schema} CASCADE`);
      await db.end();
    }
  });

  async function start(setup: boolean) {
    const b = await buyer();
    if (setup)
      await runtime.prepare(b.identity, {
        idempotencyKey: randomUUID(),
        expectedSubscriptionRevision: null,
        payload: {
          version: 1,
          domain: "buyer",
          action: "trial",
          planRevisionId: b.planId,
          quantity: 1,
        },
      });
    const before = await queries.snapshot(b.identity);
    const operation = await runtime.checkout(b.identity, {
      idempotencyKey: randomUUID(),
      expectedSubscriptionRevision: before.kind === "subscription" ? before.mutationRevision : null,
      planRevisionId: b.planId,
      quantity: 1,
      billingConsent: "accepted",
    });
    if (operation.status !== "requires_action") throw new Error("Expected real open Checkout");
    const source = (
      await db.query("SELECT * FROM billing_subscription_commands WHERE id=$1", [operation.id])
    ).rows[0];
    const survivor = randomUUID();
    await db.query("INSERT INTO users(id) VALUES($1)", [survivor]);
    await db.query(
      "INSERT INTO app_billing_members(app_id,billing_account_id,user_id,role,livemode) VALUES($1,$2,$3,'administrator',false)",
      [b.identity.appId, b.identity.billingAccountId, survivor],
    );
    const organizationId = randomUUID(),
      requestId = randomUUID(),
      phaseReceiptId = randomUUID();
    await db.query(
      "INSERT INTO organizations(id,account_lifecycle_state,account_deletion_request_id,account_lifecycle_revision) VALUES($1,'deletion_irreversible',$2,1)",
      [organizationId, requestId],
    );
    await db.query(
      "UPDATE users SET organization_id=$2,is_active=false,account_lifecycle_state='deletion_irreversible',account_deletion_request_id=$3,account_lifecycle_revision=1 WHERE id=$1",
      [b.identity.actorUserId, organizationId, requestId],
    );
    await db.query(
      "INSERT INTO account_deletion_requests VALUES($1,$2,$3,$4,1,(now() AT TIME ZONE 'UTC'),'processing')",
      [requestId, b.identity.actorUserId, organizationId, "a".repeat(64)],
    );
    await db.query(
      "INSERT INTO account_deletion_phase_receipts VALUES($1,$2,'stripe',1,(now() AT TIME ZONE 'UTC')+interval '5 minutes','calling')",
      [phaseReceiptId, requestId],
    );
    return {
      ...b,
      source,
      survivor,
      before,
      organizationId,
      auth: {
        kind: "account_deletion_checkout_expiry" as const,
        requestId,
        requestDigest: "a".repeat(64),
        lifecycleRevision: 1,
        phaseReceiptId,
        phaseGeneration: 1,
      },
    };
  }
  async function expire(state: Awaited<ReturnType<typeof start>>, authority = state.auth) {
    return (await import("./app-billing-deletion-checkout")).expirePurchaserCheckoutForDeletion(
      state.source.id,
      authority,
      resolveProvider,
    );
  }
  async function rows(sourceId: string) {
    return (
      await db.query(
        "SELECT * FROM billing_subscription_commands WHERE id=$1::uuid OR request_payload->>'sourceCommandId'=$1::text ORDER BY kind",
        [sourceId],
      )
    ).rows;
  }
  function writesSince(index: number) {
    return fixture.requests.slice(index).filter((r) => r.method !== "GET");
  }

  test("open setup expires atomically while surviving purchaser subscription and trial remain intact", async () => {
    const state = await start(true),
      count = fixture.requests.length;
    expect(await expire(state)).toBe("complete");
    const [source, cleanup] = (await rows(state.source.id)).sort((a, b) =>
      a.kind.localeCompare(b.kind),
    );
    const original = source.id === state.source.id ? source : cleanup,
      receipt = source.id === state.source.id ? cleanup : source;
    expect(original.status).toBe("FAILED");
    expect(original.error_code).toBe("APP_BILLING_CHECKOUT_EXPIRED");
    expect(original.provider_result).toEqual(state.source.provider_result);
    expect(original.request_digest).toBe(state.source.request_digest);
    expect(receipt.status).toBe("SUCCEEDED");
    const remaining = await queries.snapshot({ ...state.identity, actorUserId: state.survivor });
    if (remaining.kind !== "subscription" || state.before.kind !== "subscription")
      throw new Error("Shared subscription disappeared");
    expect(remaining.subscription).toEqual(state.before.subscription);
    expect(remaining.trial).toEqual(state.before.trial);
    expect(writesSince(count).map((r) => r.path)).toEqual([
      `/v1/checkout/sessions/${state.source.provider_result.checkoutSessionId}/expire`,
    ]);
    const after = fixture.requests.length;
    expect(await expire(state)).toBe("complete");
    expect(fixture.requests.length).toBe(after);
  });
  test("subscription Checkout expiry recovers a lost response without another provider write", async () => {
    const state = await start(false),
      count = fixture.requests.length;
    fixture.loseExpiryResponse();
    expect(await expire(state)).toBe("pending");
    expect((await rows(state.source.id)).find((r) => r.id === state.source.id).status).toBe(
      "SUCCEEDED",
    );
    expect(await expire(state)).toBe("complete");
    expect(writesSince(count)).toHaveLength(1);
    expect(writesSince(count)[0]?.key).toBe(`app-deletion-expire:${state.source.id}:expire`);
  });
  test("phase takeover rejects stale completion and recovers identical provider expiration", async () => {
    const state = await start(true),
      count = fixture.requests.length;
    fixture.beforeExpiry(async () => {
      await db.query("UPDATE account_deletion_phase_receipts SET lease_generation=2 WHERE id=$1", [
        state.auth.phaseReceiptId,
      ]);
    });
    expect(await expire(state)).toBe("pending");
    fixture.beforeExpiry(null);
    expect((await rows(state.source.id)).find((r) => r.id === state.source.id).status).toBe(
      "SUCCEEDED",
    );
    await expect(expire(state)).rejects.toThrow("current irreversible");
    expect(await expire(state, { ...state.auth, phaseGeneration: 2 })).toBe("complete");
    expect(writesSince(count)).toHaveLength(1);
  });
  test("completed, missing and unavailable sessions remain pending and never cancel shared billing", async () => {
    for (const status of [404, 503] as const) {
      const state = await start(true),
        count = fixture.requests.length;
      fixture.failCheckoutRead(state.source.provider_result.checkoutSessionId, status);
      expect(await expire(state)).toBe("pending");
      expect(writesSince(count)).toHaveLength(0);
      expect((await rows(state.source.id)).find((r) => r.id === state.source.id).status).toBe(
        "SUCCEEDED",
      );
      fixture.failCheckoutRead(state.source.provider_result.checkoutSessionId, null);
    }
    const state = await start(true),
      count = fixture.requests.length;
    fixture.completeSetupCheckout(state.source.provider_result.checkoutSessionId);
    expect(await expire(state)).toBe("pending");
    expect(writesSince(count)).toHaveLength(0);
  });
  test("concurrent cleanup workers share one lease and expired authority cannot dispatch", async () => {
    const state = await start(true),
      count = fixture.requests.length;
    let signal!: () => void, release!: () => void;
    const reached = new Promise<void>((r) => (signal = r)),
      gate = new Promise<void>((r) => (release = r));
    fixture.beforeExpiry(async () => {
      signal();
      await gate;
    });
    const first = expire(state);
    await reached;
    expect(await expire(state)).toBe("pending");
    release();
    expect(await first).toBe("complete");
    fixture.beforeExpiry(null);
    expect(writesSince(count)).toHaveLength(1);
    await db.query(
      "UPDATE account_deletion_phase_receipts SET lease_expires_at=(now() AT TIME ZONE 'UTC')-interval '1 second' WHERE id=$1",
      [state.auth.phaseReceiptId],
    );
    await expect(expire(state)).rejects.toThrow("current irreversible");
    expect(writesSince(count)).toHaveLength(1);
  });
  test("foreign purchaser authority and changed retained session identity are rejected", async () => {
    const state = await start(true),
      other = await start(true),
      count = fixture.requests.length;
    await expect(expire(state, other.auth)).rejects.toThrow("original purchaser");
    expect(writesSince(count)).toHaveLength(0);
    expect(await expire(state)).toBe("complete");
    await expect(
      db.query(
        "UPDATE billing_subscription_commands SET request_payload=jsonb_set(request_payload,'{customerId}','\"cus_wrong\"') WHERE request_payload->>'sourceCommandId'=$1",
        [state.source.id],
      ),
    ).rejects.toThrow("immutable");
  });
  test("deletion recovery drives expiry and retains completed Checkout as unresolved", async () => {
    const recovery = (await import("./app-billing-deletion-recovery"))
      .recoverAppBillingForAccountDeletion;
    const state = await start(true);
    const context = { ...state.auth, userId: state.identity.actorUserId };
    expect(
      await recovery(context, runtime, (id, auth) =>
        import("./app-billing-deletion-checkout").then(
          ({ expirePurchaserCheckoutForDeletion: expire }) => expire(id, auth, resolveProvider),
        ),
      ),
    ).toBe("complete");
    const completed = await start(true);
    fixture.completeSetupCheckout(completed.source.provider_result.checkoutSessionId);
    const count = fixture.requests.length;
    expect(
      await recovery(
        { ...completed.auth, userId: completed.identity.actorUserId },
        runtime,
        (id, auth) =>
          import("./app-billing-deletion-checkout").then(
            ({ expirePurchaserCheckoutForDeletion: expire }) => expire(id, auth, resolveProvider),
          ),
      ),
    ).toBe("pending");
    expect(writesSince(count)).toHaveLength(0);
  });
  test("Checkout completion racing expiration never produces expired success", async () => {
    const state = await start(true);
    fixture.beforeExpiry(async () => {
      fixture.completeSetupCheckout(state.source.provider_result.checkoutSessionId);
    });
    expect(await expire(state)).toBe("pending");
    fixture.beforeExpiry(null);
    const journal = await rows(state.source.id);
    expect(journal.find((row) => row.id === state.source.id).status).toBe("SUCCEEDED");
    expect(journal.find((row) => row.id !== state.source.id).status).toBe("OUTCOME_UNKNOWN");
  });
  test("pending cleanup is revisited after completed subscription purchase is applied", async () => {
    const state = await start(false);
    fixture.completeCheckout(state.source.provider_result.checkoutSessionId);
    const recovery = (await import("./app-billing-deletion-recovery"))
      .recoverAppBillingForAccountDeletion;
    const service = (await import("./app-billing-deletion-checkout"))
      .expirePurchaserCheckoutForDeletion;
    const context = { ...state.auth, userId: state.identity.actorUserId };
    expect(await recovery(context, runtime, (id, auth) => service(id, auth, resolveProvider))).toBe(
      "pending",
    );
    expect((await rows(state.source.id)).find((row) => row.id === state.source.id).status).toBe(
      "APPLIED",
    );
    const count = fixture.requests.length;
    expect(await recovery(context, runtime, (id, auth) => service(id, auth, resolveProvider))).toBe(
      "pending",
    );
    expect(
      fixture.requests
        .slice(count)
        .some(
          (request) =>
            request.path ===
            `/v1/checkout/sessions/${state.source.provider_result.checkoutSessionId}`,
        ),
    ).toBe(true);
    expect(writesSince(count)).toHaveLength(0);
  });
  async function appliedWithDecision() {
    const state = await start(false);
    fixture.completeCheckout(state.source.provider_result.checkoutSessionId);
    const recovery = (await import("./app-billing-deletion-recovery"))
      .recoverAppBillingForAccountDeletion;
    expect(
      await recovery({ ...state.auth, userId: state.identity.actorUserId }, runtime, (id, auth) =>
        import("./app-billing-deletion-checkout").then(({ expirePurchaserCheckoutForDeletion }) =>
          expirePurchaserCheckoutForDeletion(id, auth, resolveProvider),
        ),
      ),
    ).toBe("pending");
    const decide = (await import("../../db/repositories/app-billing-deletion-dispositions"))
      .decideAppBillingDeletionScope;
    await decide({
      scopeId: state.scopeId,
      authority: { ...state.auth, kind: "account_deletion" },
    });
    return state;
  }
  test("applied completed Checkout clears cleanup without rewriting purchase or provider", async () => {
    const state = await appliedWithDecision();
    const before = (await rows(state.source.id)).find((row) => row.id === state.source.id);
    expect(before.result_subscription_revision).not.toBeNull();
    const count = fixture.requests.length;
    expect(await expire(state)).toBe("complete");
    expect(await expire(state)).toBe("complete");
    const after = await rows(state.source.id);
    expect(after.find((row) => row.id === state.source.id)).toEqual(before);
    expect(after.find((row) => row.id !== state.source.id).provider_result).toMatchObject({
      kind: "completed_checkout",
      subscriptionId: before.result_subscription_id,
      subscriptionRevision: Number(before.result_subscription_revision),
    });
    expect(writesSince(count)).toHaveLength(0);
    await expect(
      db.query(
        "UPDATE billing_subscription_commands SET result_subscription_revision=NULL WHERE id=$1",
        [state.source.id],
      ),
    ).rejects.toThrow("immutable");
  });
  test("completed cleanup rechecks survivor eligibility after a retained decision", async () => {
    const state = await appliedWithDecision();
    await db.query("UPDATE users SET auth_fenced_at=now() WHERE id=$1", [state.survivor]);
    const count = fixture.requests.length;
    expect(await expire(state)).toBe("pending");
    expect((await rows(state.source.id)).find((row) => row.id === state.source.id).status).toBe(
      "APPLIED",
    );
    expect(writesSince(count)).toHaveLength(0);
  });
  test("historical purchaser may retain for an eligible survivor but cannot initiate closure", async () => {
    const state = await appliedWithDecision();
    await db.query(
      "UPDATE app_billing_members SET revoked_at=now() WHERE billing_account_id=$1 AND user_id=$2",
      [state.identity.billingAccountId, state.identity.actorUserId],
    );
    const decide = (await import("../../db/repositories/app-billing-deletion-dispositions"))
      .decideAppBillingDeletionScope;
    expect(
      (
        await decide({
          scopeId: state.scopeId,
          authority: { ...state.auth, kind: "account_deletion" },
        })
      ).disposition,
    ).toBe("retain_shared");
    await db.query("UPDATE users SET auth_fenced_at=now() WHERE id=$1", [state.survivor]);
    await expect(
      decide({ scopeId: state.scopeId, authority: { ...state.auth, kind: "account_deletion" } }),
    ).rejects.toThrow("cannot authorize scope closure");
  });
  test("closing scope blocks completion of canonical Stripe phase", async () => {
    const state = await appliedWithDecision();
    await db.query("UPDATE users SET auth_fenced_at=now() WHERE id=$1", [state.survivor]);
    const decide = (await import("../../db/repositories/app-billing-deletion-dispositions"))
      .decideAppBillingDeletionScope;
    expect(
      (
        await decide({
          scopeId: state.scopeId,
          authority: { ...state.auth, kind: "account_deletion" },
        })
      ).disposition,
    ).toBe("close");
    expect(await expire(state)).toBe("complete");
    await expect(
      db.query("UPDATE account_deletion_phase_receipts SET status='completed' WHERE id=$1", [
        state.auth.phaseReceiptId,
      ]),
    ).rejects.toThrow("requires provider cleanup");
  });

  test("phase completion and a closing decision serialize in both transaction orders", async () => {
    const contender = new Client({ connectionString: postgresUrl });
    await contender.connect();
    await contender.query(`SET search_path TO ${schema},pg_catalog,public`);
    try {
      for (const closeFirst of [true, false]) {
        const state = await appliedWithDecision();
        await db.query("UPDATE users SET auth_fenced_at=now() WHERE id=$1", [state.survivor]);
        await db.query("UPDATE app_billing_scopes SET fenced_at=now() WHERE id=$1", [
          state.scopeId,
        ]);
        const closeSql =
          "UPDATE app_billing_deletion_dispositions SET disposition='close' WHERE request_id=$1";
        const phaseSql =
          "UPDATE account_deletion_phase_receipts SET status='completed' WHERE request_id=$1";
        await db.query("BEGIN");
        await db.query(closeFirst ? closeSql : phaseSql, [state.auth.requestId]);
        // Start the actual PostgreSQL query before releasing the conflicting phase lock.
        const pending = contender.query(closeFirst ? phaseSql : closeSql, [state.auth.requestId]);
        const outcome = pending.then(
          () => ({ error: null }),
          (error: Error) => ({ error }),
        );
        await db.query("COMMIT");
        const result = await outcome;
        expect(result.error?.message).toContain(
          closeFirst ? "requires provider cleanup" : "current canonical deletion phase",
        );
      }
    } finally {
      await contender.end();
    }
  });
  test("legacy applied purchases resolve only a unique matching immutable revision", async () => {
    for (const ambiguous of [false, true]) {
      const state = await appliedWithDecision();
      // Model a pre-0426 applied row; production recovery never disables this guard.
      await db.query(
        "ALTER TABLE billing_subscription_commands DISABLE TRIGGER app_billing_applied_revision_guard",
      );
      await db.query(
        "UPDATE billing_subscription_commands SET result_subscription_revision=NULL WHERE id=$1",
        [state.source.id],
      );
      await db.query(
        "ALTER TABLE billing_subscription_commands ENABLE TRIGGER app_billing_applied_revision_guard",
      );
      if (ambiguous)
        await db.query(
          `INSERT INTO billing_subscription_revisions SELECT (jsonb_populate_record(NULL::billing_subscription_revisions,to_jsonb(r)||jsonb_build_object('id',gen_random_uuid(),'revision',r.revision+100))).* FROM billing_subscription_revisions r JOIN billing_subscription_commands c ON c.result_subscription_id=r.subscription_id AND c.provider_response_digest=r.provider_object_digest WHERE c.id=$1`,
          [state.source.id],
        );
      expect(await expire(state)).toBe(ambiguous ? "pending" : "complete");
      const source = (await rows(state.source.id)).find((row) => row.id === state.source.id);
      expect(source.status).toBe("APPLIED");
      expect(source.result_subscription_revision === null).toBe(ambiguous);
    }
  });
  test("survivor fencing commits before blocked cleanup can write terminal evidence", async () => {
    const state = await appliedWithDecision();
    const repository = (await import("../../db/repositories/app-billing-deletion-checkout"))
      .appBillingDeletionCheckoutRepository;
    const claimed = await repository.claim(state.source.id, state.auth);
    if (claimed.kind !== "claimed") throw new Error("Expected cleanup claim");
    const scope = await repository.validateDispatch(claimed.claim);
    const provider = await resolveProvider(scope.merchantId, scope.livemode);
    const readInput = {
      sessionId: claimed.claim.payload.checkoutSessionId,
      customerId: claimed.claim.payload.customerId,
      mode: "subscription" as const,
    };
    const observed = await provider.readCheckout(
      { scopeId: scope.scopeId, appId: scope.appId, billingAccountId: scope.billingAccountId },
      readInput,
    );
    await db.query("BEGIN");
    await db.query("UPDATE users SET auth_fenced_at=now() WHERE id=$1", [state.survivor]);
    const pending = repository.completeApplied(claimed.claim, observed);
    const outcome = pending.then(
      () => ({ error: null }),
      (error: Error) => ({ error }),
    );
    await db.query("COMMIT");
    expect((await outcome).error?.message).toContain("eligible survivor");
    await repository.release(claimed.claim);
    expect((await rows(state.source.id)).find((row) => row.id !== state.source.id).status).toBe(
      "OUTCOME_UNKNOWN",
    );
  });
  test("retains exact subscription and setup Checkout observations with their cleanup execution", async () => {
    for (const setup of [false, true]) {
      const state = await start(setup);
      const repository = (await import("../../db/repositories/app-billing-deletion-checkout"))
        .appBillingDeletionCheckoutRepository;
      let selected = await repository.claim(state.source.id, state.auth);
      if (selected.kind !== "claimed") throw new Error("Missing cleanup claim");
      const scope = await repository.validateDispatch(selected.claim);
      const provider = await resolveProvider(scope.merchantId, scope.livemode);
      const providerScope = {
        scopeId: scope.scopeId,
        appId: scope.appId,
        billingAccountId: scope.billingAccountId,
      };
      const plan = await authority.getHistoricalPlan({
        appId: scope.appId,
        planRevisionId: state.planId,
      });
      const { appBillingProviderPlan } = await import("./generic-billing-provider-runtime");
      const base = {
        sessionId: selected.claim.payload.checkoutSessionId,
        customerId: selected.claim.payload.customerId,
      };
      const input = setup
        ? {
            ...base,
            mode: "setup" as const,
            subscriptionId: selected.claim.payload.subscriptionId!,
            plan: appBillingProviderPlan(plan),
          }
        : { ...base, mode: "subscription" as const };
      const observed = await provider.expireCheckout(providerScope, input, {
        commandId: selected.claim.lease.commandId,
        idempotencyKey: randomUUID(),
        requestDigest: settlementDigest(selected.claim.payload),
      });
      for (const invalid of [
        { ...observed, digest: "0".repeat(64) },
        { ...observed, inputDigest: "0".repeat(64) },
        { ...observed, value: { ...observed.value, sessionId: "cs_foreign" } },
        { ...observed, value: { ...observed.value, status: "open" as const } },
      ])
        await expect(repository.complete(selected.claim, invalid)).rejects.toThrow();
      const firstClaim = selected.claim;
      await db.query(
        "UPDATE billing_subscription_commands SET lease_expires_at=now()-interval '1 second' WHERE id=$1",
        [firstClaim.lease.commandId],
      );
      selected = await repository.claim(state.source.id, state.auth);
      if (selected.kind !== "claimed") throw new Error("Missing takeover claim");
      expect(selected.claim.lease.commandId).toBe(firstClaim.lease.commandId);
      expect(selected.claim.lease.executionGeneration).toBe(
        firstClaim.lease.executionGeneration + 1,
      );
      const beforeRecovery = fixture.requests.length;
      await expect(repository.complete(firstClaim, observed)).rejects.toThrow("execution lease");
      await repository.complete(selected.claim, observed);
      expect(fixture.requests.length).toBe(beforeRecovery);
      const records = await rows(state.source.id);
      const cleanup = records.find((row) => row.id !== state.source.id);
      expect(cleanup.provider_result.checkoutEvidence).toEqual({
        commandId: selected.claim.lease.commandId,
        commandRevision: selected.claim.lease.stateRevision,
        executionGeneration: selected.claim.lease.executionGeneration,
        leaseToken: selected.claim.lease.token,
        phaseGeneration: state.auth.phaseGeneration,
        sourceCommandId: state.source.id,
        sourceRevision: Number(records.find((row) => row.id === state.source.id).state_revision),
        observation: observed,
      });
      const beforeReplay = fixture.requests.length;
      expect(await expire(state)).toBe("complete");
      expect(fixture.requests.length).toBe(beforeReplay);
      await expect(
        db.query(
          "UPDATE billing_subscription_commands SET provider_result=jsonb_set(provider_result,'{checkoutEvidence,observation,digest}',to_jsonb(repeat('0',64))) WHERE id=$1",
          [cleanup.id],
        ),
      ).rejects.toThrow();
    }
  });
  test("completed Checkout retains the actual read and rejects a substituted source in SQL", async () => {
    const state = await appliedWithDecision();
    const repository = (await import("../../db/repositories/app-billing-deletion-checkout"))
      .appBillingDeletionCheckoutRepository;
    const selected = await repository.claim(state.source.id, state.auth);
    if (selected.kind !== "claimed") throw new Error("Missing cleanup claim");
    const scope = await repository.validateDispatch(selected.claim);
    const provider = await resolveProvider(scope.merchantId, scope.livemode);
    const readInput = {
      sessionId: selected.claim.payload.checkoutSessionId,
      customerId: selected.claim.payload.customerId,
      mode: "subscription" as const,
    };
    const observed = await provider.readCheckout(
      { scopeId: scope.scopeId, appId: scope.appId, billingAccountId: scope.billingAccountId },
      readInput,
    );
    await db.query(`CREATE FUNCTION substitute_checkout_source() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.request_payload->>'domain'='account_deletion' AND NEW.status='SUCCEEDED' THEN NEW.provider_result=jsonb_set(NEW.provider_result,'{checkoutEvidence,sourceCommandId}',to_jsonb('00000000-0000-0000-0000-000000000000'::text)); END IF; RETURN NEW; END $$;
      CREATE TRIGGER aaa_substitute_checkout_source BEFORE UPDATE ON billing_subscription_commands FOR EACH ROW EXECUTE FUNCTION substitute_checkout_source();`);
    try {
      await expect(repository.completeApplied(selected.claim, observed)).rejects.toMatchObject({
        cause: {
          message:
            "Checkout cleanup requires retained observation and current source execution authority",
        },
      });
    } finally {
      await db.query(
        "DROP TRIGGER aaa_substitute_checkout_source ON billing_subscription_commands; DROP FUNCTION substitute_checkout_source()",
      );
    }
    expect((await rows(state.source.id)).find((row) => row.id !== state.source.id).status).toBe(
      "OUTCOME_UNKNOWN",
    );
    await repository.completeApplied(selected.claim, observed);
    const result = (await rows(state.source.id)).find(
      (row) => row.id !== state.source.id,
    ).provider_result;
    expect(result.checkoutEvidence.observation).toEqual(observed);
    expect(result.checkoutEvidence.sourceCommandId).toBe(state.source.id);
    const beforeReplay = fixture.requests.length;
    expect(await expire(state)).toBe("complete");
    expect(fixture.requests.length).toBe(beforeReplay);
  });
  test("completed cleanup rejects a provider subscription outside its applied revision", async () => {
    const state = await appliedWithDecision();
    const repository = (await import("../../db/repositories/app-billing-deletion-checkout"))
      .appBillingDeletionCheckoutRepository;
    const claimed = await repository.claim(state.source.id, state.auth);
    if (claimed.kind !== "claimed") throw new Error("Expected cleanup claim");
    const scope = await repository.validateDispatch(claimed.claim);
    const provider = await resolveProvider(scope.merchantId, scope.livemode);
    const readInput = {
      sessionId: claimed.claim.payload.checkoutSessionId,
      customerId: claimed.claim.payload.customerId,
      mode: "subscription" as const,
    };
    const observed = await provider.readCheckout(
      { scopeId: scope.scopeId, appId: scope.appId, billingAccountId: scope.billingAccountId },
      readInput,
    );
    await expect(
      repository.completeApplied(claimed.claim, {
        ...observed,
        value: { ...observed.value, subscriptionId: "sub_foreign" },
      }),
    ).rejects.toThrow("differs from its applied subscription revision");
    expect((await rows(state.source.id)).find((row) => row.id !== state.source.id).status).toBe(
      "OUTCOME_UNKNOWN",
    );
    await repository.release(claimed.claim);
  });
});
