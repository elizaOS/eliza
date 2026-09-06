/** Exercises closed-scope cancellation with real PostgreSQL and Stripe SDK over controlled HTTP, including authority races and ambiguous responses. */
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Client } from "pg";
import type { BuyerBillingIdentity, GenericBillingRuntime } from "./generic-billing-runtime";
import { createRuntimeStripeFixture } from "./generic-billing-runtime.stripe-fixture";
import { settlementDigest } from "./settlement-digest";

const postgresUrl = process.env.APP_BILLING_TEST_POSTGRES_URL;
const schema = `app_delete_cancel_${randomUUID().replaceAll("-", "_")}`;
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

describe.skipIf(!postgresUrl)("server-selected closed-scope cancellation", () => {
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
      "0429_app_billing_applied_revision",
      "0430_app_billing_completed_checkout",
      "0431_app_billing_deletion_cancellation",
      "0445_app_billing_refund_observations",
      "0461_app_billing_cancellation_evidence",
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

  async function start(retain = false, withPortal = false) {
    const b = await buyer();
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
    if (before.kind !== "subscription") throw new Error("Trial was not applied");
    if (withPortal) {
      const portal = await runtime.portal(b.identity, {
        idempotencyKey: randomUUID(),
        expectedSubscriptionRevision: before.subscription.lifecycle_revision,
      });
      expect(portal.status).toBe("requires_action");
    }
    if (retain) {
      const survivor = randomUUID();
      await db.query("INSERT INTO users(id) VALUES($1)", [survivor]);
      await db.query(
        "INSERT INTO app_billing_members(app_id,billing_account_id,user_id,role,livemode) VALUES($1,$2,$3,'administrator',false)",
        [b.identity.appId, b.identity.billingAccountId, survivor],
      );
    }
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
    const auth = {
      kind: "account_deletion_subscription_cancellation" as const,
      requestId,
      requestDigest: "a".repeat(64),
      lifecycleRevision: 1,
      phaseReceiptId,
      phaseGeneration: 1,
    };
    await (
      await import("../../db/repositories/app-billing-deletion-dispositions")
    ).decideAppBillingDeletionScope({
      scopeId: b.scopeId,
      authority: { ...auth, kind: "account_deletion" },
    });
    return { ...b, auth, before };
  }
  async function cancel(state: Awaited<ReturnType<typeof start>>, auth = state.auth) {
    return (
      await import("./app-billing-deletion-cancellation")
    ).cancelClosedScopeSubscriptionForDeletion(state.scopeId, auth, resolveProvider);
  }
  async function repository() {
    return (await import("../../db/repositories/app-billing-deletion-cancellation"))
      .appBillingDeletionCancellationRepository;
  }
  test("immediate cancellation projects denied access atomically and replays without provider writes", async () => {
    const state = await start(),
      at = fixture.requests.length;
    expect(await cancel(state)).toBe("pending");
    const rows = (
      await db.query(
        "SELECT c.status,c.result_subscription_revision,s.status AS subscription_status,e.access,e.entitlement_effective FROM billing_subscription_commands c JOIN billing_subscriptions s ON s.id=c.result_subscription_id JOIN organization_entitlements e ON e.billing_scope_id=c.billing_scope_id WHERE c.billing_scope_id=$1 AND c.request_payload->>'domain'='account_deletion'",
        [state.scopeId],
      )
    ).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("APPLIED");
    expect(rows[0].subscription_status).toBe("canceled");
    expect(rows[0].access).toBe("denied");
    expect(rows[0].entitlement_effective).toBe(false);
    expect(Number(rows[0].result_subscription_revision)).toBeGreaterThan(1);
    const writes = fixture.requests.slice(at).filter((r) => r.method !== "GET");
    expect(writes).toHaveLength(1);
    expect(writes[0]!.method).toBe("DELETE");
    expect(writes[0]!.query.get("invoice_now")).toBe("false");
    expect(writes[0]!.query.get("prorate")).toBe("false");
    const after = fixture.requests.length;
    expect(await cancel(state)).toBe("complete");
    expect(fixture.requests.length).toBe(after);
  });
  test("retains the exact SDK observation and rejects changed provenance or pending updates", async () => {
    const state = await start(),
      repo = await repository();
    const selected = await repo.claim(state.scopeId, state.auth);
    if (selected.kind !== "claimed") throw new Error("missing cancellation claim");
    const scope = await repo.validateDispatch(selected.claim);
    const provider = await resolveProvider(merchant, false);
    const { appBillingProviderPlan } = await import("./generic-billing-provider-runtime");
    const plan = await authority.getHistoricalPlan({
      appId: scope.appId,
      planRevisionId: state.planId,
    });
    const observed = await provider.cancelSubscription(
      scope,
      {
        subscriptionId: selected.claim.payload.subscriptionId,
        customerId: selected.claim.payload.customerId,
        plan: appBillingProviderPlan(plan),
        atPeriodEnd: false,
      },
      {
        commandId: selected.claim.lease.commandId,
        idempotencyKey: randomUUID(),
        requestDigest: settlementDigest(selected.claim.payload),
      },
    );
    const pending = { ...observed.value, pendingUpdate: true };
    for (const invalid of [
      { ...observed, value: pending, digest: settlementDigest(pending) },
      { ...observed, digest: "0".repeat(64) },
      { ...observed, inputDigest: "0".repeat(64) },
      { ...observed, providerAccountId: "acct_other" },
      { ...observed, observedAt: "2999-01-01T00:00:00.000Z" },
    ])
      await expect(repo.complete(selected.claim, invalid)).rejects.toThrow();
    await repo.complete(selected.claim, observed);
    const {
      rows: [retained],
    } = await db.query(
      "SELECT provider_result,provider_response_digest,result_subscription_id,result_subscription_revision,request_payload FROM billing_subscription_commands WHERE id=$1",
      [selected.claim.lease.commandId],
    );
    expect(retained.provider_result.cancellationEvidence).toEqual({
      commandId: selected.claim.lease.commandId,
      commandRevision: selected.claim.lease.stateRevision,
      executionGeneration: selected.claim.lease.executionGeneration,
      leaseToken: selected.claim.lease.token,
      phaseGeneration: state.auth.phaseGeneration,
      observation: observed,
    });
    expect(retained.provider_result.subscriptionId).toBe(retained.result_subscription_id);
    expect(retained.provider_result.subscriptionRevision).toBe(
      Number(retained.result_subscription_revision),
    );
    expect(retained.provider_response_digest).toBe(observed.digest);
    expect(retained.request_payload).toEqual(selected.claim.payload);
    await expect(
      db.query(
        "UPDATE billing_subscription_commands SET provider_result=jsonb_set(provider_result,'{cancellationEvidence,observation,value,pendingUpdate}','true') WHERE id=$1",
        [selected.claim.lease.commandId],
      ),
    ).rejects.toThrow();
  });
  test("database rejects substituted cancellation execution evidence and rolls back projection", async () => {
    const state = await start();
    // A database-side adversarial writer changes a validated application's write before the real guard sees it.
    await db.query(`CREATE FUNCTION substitute_cancellation_evidence() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.status='APPLIED' AND NEW.request_payload->>'domain'='account_deletion' THEN
        NEW.provider_result=jsonb_set(NEW.provider_result,'{cancellationEvidence,commandId}',to_jsonb('00000000-0000-0000-0000-000000000000'::text));
      END IF; RETURN NEW; END $$;
      CREATE TRIGGER aaa_substitute_cancellation_evidence BEFORE UPDATE ON billing_subscription_commands FOR EACH ROW EXECUTE FUNCTION substitute_cancellation_evidence();`);
    try {
      expect(await cancel(state)).toBe("pending");
      const {
        rows: [row],
      } = await db.query(
        "SELECT c.status,c.provider_result,s.status AS subscription_status FROM billing_subscription_commands c JOIN billing_subscriptions s ON s.id=c.subscription_id WHERE c.billing_scope_id=$1 AND c.request_payload->>'domain'='account_deletion'",
        [state.scopeId],
      );
      expect(row.status).toBe("OUTCOME_UNKNOWN");
      expect(row.provider_result).toBeNull();
      expect(row.subscription_status).toBe("trialing");
    } finally {
      await db.query(
        "DROP TRIGGER aaa_substitute_cancellation_evidence ON billing_subscription_commands; DROP FUNCTION substitute_cancellation_evidence()",
      );
    }
    expect(await cancel(state)).toBe("pending");
    expect(await cancel(state)).toBe("complete");
  });
  test("a completed billing portal does not prevent subscription cancellation", async () => {
    const state = await start(false, true);
    const at = fixture.requests.length;
    expect(await cancel(state)).toBe("pending");
    expect(await cancel(state)).toBe("complete");
    const row = (
      await db.query("SELECT status FROM billing_subscriptions WHERE billing_scope_id=$1", [
        state.scopeId,
      ])
    ).rows[0];
    expect(row.status).toBe("canceled");
    expect(
      fixture.requests.slice(at).filter((request) => request.method === "DELETE"),
    ).toHaveLength(1);
  });
  test("retained shared scope performs zero provider requests", async () => {
    const state = await start(true),
      at = fixture.requests.length;
    expect(await cancel(state)).toBe("retained");
    expect(fixture.requests.length).toBe(at);
    expect(
      (
        await db.query("SELECT status FROM billing_subscriptions WHERE billing_scope_id=$1", [
          state.scopeId,
        ])
      ).rows[0].status,
    ).toBe("trialing");
  });
  test("another purchaser's unresolved command blocks all cancellation", async () => {
    const state = await start(),
      actor = randomUUID();
    await db.query("INSERT INTO users(id) VALUES($1)", [actor]);
    // A retained command from another purchaser must block cleanup regardless of the deleting user.
    await db.query(
      "INSERT INTO billing_identity_subjects(id,live_user_id,eligibility_principal_id) SELECT $1,$1,eligibility_principal_id FROM app_billing_accounts WHERE id=$2 ON CONFLICT DO NOTHING",
      [actor, state.identity.billingAccountId],
    );
    await db.query(
      "INSERT INTO billing_subscription_commands(app_id,livemode,merchant_id,organization_id,billing_scope_id,merchant_key,requested_by_user_id,kind,idempotency_key,provider_idempotency_key,request_digest,request_payload) VALUES($1,false,$2,$3,$4,'acct_runtime',$5,'portal',$6,$6,$7,$8)",
      [
        state.identity.appId,
        merchant,
        org,
        state.scopeId,
        actor,
        randomUUID(),
        "b".repeat(64),
        JSON.stringify({
          version: 1,
          domain: "buyer",
          action: "portal",
          returnUrl: "https://app.example",
        }),
      ],
    );
    const at = fixture.requests.length;
    expect(await cancel(state)).toBe("pending");
    expect(fixture.requests.length).toBe(at);
  });
  test("execution contention and phase takeover reject stale dispatch", async () => {
    const state = await start(),
      repo = await repository();
    const first = await repo.claim(state.scopeId, state.auth);
    expect(first.kind).toBe("claimed");
    if (first.kind !== "claimed") throw new Error("missing claim");
    expect((await repo.claim(state.scopeId, state.auth)).kind).toBe("pending");
    await db.query("UPDATE account_deletion_phase_receipts SET lease_generation=2 WHERE id=$1", [
      state.auth.phaseReceiptId,
    ]);
    await expect(repo.validateDispatch(first.claim)).rejects.toThrow();
    await repo.release(first.claim);
  });
  test("period-end state and foreign exact handles cannot become terminal cancellation", async () => {
    const state = await start(),
      repo = await repository(),
      claimed = await repo.claim(state.scopeId, state.auth);
    if (claimed.kind !== "claimed") throw new Error("missing claim");
    const scope = await repo.validateDispatch(claimed.claim),
      provider = await resolveProvider(merchant, false);
    const { appBillingProviderPlan } = await import("./generic-billing-provider-runtime");
    const plan = await authority.getHistoricalPlan({
      appId: scope.appId,
      planRevisionId: state.planId,
    });
    const observed = await provider.cancelSubscription(
      scope,
      {
        subscriptionId: claimed.claim.payload.subscriptionId,
        customerId: claimed.claim.payload.customerId,
        plan: appBillingProviderPlan(plan),
        atPeriodEnd: true,
      },
      {
        commandId: claimed.claim.lease.commandId,
        idempotencyKey: randomUUID(),
        requestDigest: settlementDigest(claimed.claim.payload),
      },
    );
    await expect(repo.complete(claimed.claim, observed)).rejects.toThrow();
    await expect(
      repo.complete(claimed.claim, {
        ...observed,
        value: { ...observed.value, status: "canceled", customerId: "cus_foreign" },
      }),
    ).rejects.toThrow();
    expect(
      (
        await db.query("SELECT status FROM billing_subscription_commands WHERE id=$1", [
          claimed.claim.lease.commandId,
        ])
      ).rows[0].status,
    ).toBe("OUTCOME_UNKNOWN");
    await repo.release(claimed.claim);
  });
  test("phase takeover during provider read prevents DELETE at dispatch boundary", async () => {
    const state = await start(),
      at = fixture.requests.length;
    fixture.beforeSubscriptionRead(async () => {
      await db.query("UPDATE account_deletion_phase_receipts SET lease_generation=2 WHERE id=$1", [
        state.auth.phaseReceiptId,
      ]);
    });
    try {
      expect(await cancel(state)).toBe("pending");
    } finally {
      fixture.beforeSubscriptionRead(null);
    }
    expect(fixture.requests.slice(at).filter((r) => r.method !== "GET")).toHaveLength(0);
  });
  test("lost cancellation response is recovered by exact read without a second DELETE", async () => {
    const state = await start(),
      at = fixture.requests.length;
    fixture.loseCancellationResponse();
    expect(await cancel(state)).toBe("pending");
    expect(await cancel(state)).toBe("pending");
    expect(await cancel(state)).toBe("complete");
    expect(fixture.requests.slice(at).filter((r) => r.method === "DELETE")).toHaveLength(1);
  });
  test("phase takeover after provider cancellation fences terminal commit until a fresh lease", async () => {
    const state = await start(),
      at = fixture.requests.length;
    fixture.beforeCancellation(async () => {
      await db.query("UPDATE account_deletion_phase_receipts SET lease_generation=2 WHERE id=$1", [
        state.auth.phaseReceiptId,
      ]);
    });
    try {
      expect(await cancel(state)).toBe("pending");
    } finally {
      fixture.beforeCancellation(null);
    }
    expect(
      (
        await db.query("SELECT status FROM billing_subscriptions WHERE billing_scope_id=$1", [
          state.scopeId,
        ])
      ).rows[0].status,
    ).toBe("trialing");
    const auth = { ...state.auth, phaseGeneration: 2 };
    await (
      await import("../../db/repositories/app-billing-deletion-dispositions")
    ).decideAppBillingDeletionScope({
      scopeId: state.scopeId,
      authority: { ...auth, kind: "account_deletion" },
    });
    expect(await cancel(state, auth)).toBe("pending");
    expect(await cancel(state, auth)).toBe("complete");
    expect(fixture.requests.slice(at).filter((r) => r.method === "DELETE")).toHaveLength(1);
  });
  test("execution lease takeover rejects an old canceled result and commits it only under the new generation", async () => {
    const state = await start(),
      repo = await repository(),
      first = await repo.claim(state.scopeId, state.auth);
    if (first.kind !== "claimed") throw new Error("missing first claim");
    const scope = await repo.validateDispatch(first.claim),
      provider = await resolveProvider(merchant, false);
    const { appBillingProviderPlan } = await import("./generic-billing-provider-runtime");
    const plan = await authority.getHistoricalPlan({
      appId: scope.appId,
      planRevisionId: state.planId,
    });
    const observation = await provider.cancelSubscription(
      scope,
      {
        subscriptionId: first.claim.payload.subscriptionId,
        customerId: first.claim.payload.customerId,
        plan: appBillingProviderPlan(plan),
        atPeriodEnd: false,
      },
      {
        commandId: first.claim.lease.commandId,
        idempotencyKey: randomUUID(),
        requestDigest: settlementDigest(first.claim.payload),
      },
    );
    await db.query(
      "UPDATE billing_subscription_commands SET lease_expires_at=now()-interval '1 second' WHERE id=$1",
      [first.claim.lease.commandId],
    );
    const second = await repo.claim(state.scopeId, state.auth);
    if (second.kind !== "claimed") throw new Error("missing takeover claim");
    expect(second.claim.lease.commandId).toBe(first.claim.lease.commandId);
    expect(second.claim.lease.executionGeneration).toBeGreaterThan(
      first.claim.lease.executionGeneration,
    );
    await expect(repo.complete(first.claim, observation)).rejects.toThrow();
    await repo.complete(second.claim, observation);
    expect(await cancel(state)).toBe("complete");
  });
});
