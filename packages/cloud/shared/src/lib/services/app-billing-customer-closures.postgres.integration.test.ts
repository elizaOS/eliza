/** Exercises customer-wide closure identity and admission fences against real PostgreSQL migrations. Subscription preservation uses the real billing runtime and Stripe SDK with controlled HTTP. */
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Client } from "pg";
import type { BuyerBillingIdentity, GenericBillingRuntime } from "./generic-billing-runtime";
import { createRuntimeStripeFixture } from "./generic-billing-runtime.stripe-fixture";
import { settlementDigest } from "./settlement-digest";

const postgresUrl = process.env.APP_BILLING_TEST_POSTGRES_URL;
const schema = `app_customer_closure_${randomUUID().replaceAll("-", "_")}`;
if (postgresUrl) {
  const repositoryUrl = new URL(postgresUrl);
  repositoryUrl.searchParams.set("options", `-c search_path=${schema},public`);
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

describe.skipIf(!postgresUrl)("canonical customer closure with PostgreSQL", () => {
  beforeAll(async () => {
    db = new Client({ connectionString: postgresUrl });
    await db.connect();
    await db.query("CREATE EXTENSION IF NOT EXISTS btree_gist WITH SCHEMA public");
    await db.query(`CREATE SCHEMA ${schema}`);
    await db.query(`SET search_path TO ${schema},public`);
    await db.query(`
      CREATE TABLE IF NOT EXISTS webhook_events(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),event_id text NOT NULL UNIQUE,provider text NOT NULL,event_type text,payload_hash text NOT NULL,source_ip text,processed_at timestamp NOT NULL DEFAULT now(),event_timestamp timestamp);
    CREATE TABLE organizations(id uuid PRIMARY KEY,account_deletion_request_id uuid,account_lifecycle_revision bigint NOT NULL DEFAULT 0,is_active boolean NOT NULL DEFAULT true,account_lifecycle_state text NOT NULL DEFAULT 'active',paid_work_fenced_at timestamptz,stripe_customer_id text,credit_balance numeric NOT NULL DEFAULT 0);
      CREATE TABLE users(id uuid PRIMARY KEY,account_deletion_request_id uuid,account_lifecycle_revision bigint NOT NULL DEFAULT 0,is_active boolean NOT NULL DEFAULT true,deleted_at timestamptz,email_verified boolean NOT NULL DEFAULT true,is_anonymous boolean NOT NULL DEFAULT false,organization_id uuid,role text NOT NULL DEFAULT 'member',expires_at timestamp,account_lifecycle_state text NOT NULL DEFAULT 'active',auth_fenced_at timestamptz);
      CREATE TABLE account_deletion_requests(id uuid PRIMARY KEY,user_id uuid,organization_id uuid,request_digest text,lifecycle_revision bigint,irreversible_at timestamp,status text);
      CREATE TABLE account_deletion_phase_receipts(id uuid PRIMARY KEY,request_id uuid REFERENCES account_deletion_requests(id),phase text,lease_generation bigint,lease_expires_at timestamp,status text,lease_owner_digest text,provider_receipt_digest text,provider_acknowledged_at timestamp,reconciled_at timestamp,completed_at timestamp,retry_class text,next_attempt_at timestamp,last_error_code text,updated_at timestamp);
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
      "0424_app_billing_customer_closures",
      "0425_app_billing_customer_closure_guards",
      "0430_app_billing_completed_checkout",
      "0438_app_billing_customer_terminal_obligations",
      "0439_app_billing_customer_command_shape",
      "0440_app_billing_terminal_buyer_commands",
      "0441_app_billing_customer_command_identity",
      "0442_app_billing_customer_execution_lease",
      "0443_app_billing_customer_completion_guard",
      "0444_app_billing_customer_command_guard",
      "0445_app_billing_refund_observations",
      "0446_app_billing_refund_recovery_authority",
      "0447_app_billing_refund_observation_guards",
      "0448_app_billing_customer_retention",
      "0449_app_billing_refund_actor_recovery",
      "0450_app_billing_observed_customer_retention",
      "0451_app_billing_refund_phase_obligations",
      "0452_app_billing_completion_owner_locks",
      "0453_app_billing_completion_scope_decisions",
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

  async function deletion(userId: string) {
    const organizationId = randomUUID(),
      requestId = randomUUID(),
      phaseReceiptId = randomUUID();
    await db.query(
      "INSERT INTO organizations(id,account_lifecycle_state,account_lifecycle_revision,account_deletion_request_id) VALUES($1,'deletion_irreversible',1,$2)",
      [organizationId, requestId],
    );
    await db.query(
      "UPDATE users SET organization_id=$2,is_active=false,account_lifecycle_state='deletion_irreversible',account_lifecycle_revision=1,account_deletion_request_id=$3 WHERE id=$1",
      [userId, organizationId, requestId],
    );
    await db.query(
      "INSERT INTO account_deletion_requests VALUES($1,$2,$3,$4,1,(now() AT TIME ZONE 'UTC'),'processing')",
      [requestId, userId, organizationId, "a".repeat(64)],
    );
    await db.query(
      "INSERT INTO account_deletion_phase_receipts VALUES($1,$2,'stripe',1,(now() AT TIME ZONE 'UTC')+interval '5 minutes','calling')",
      [phaseReceiptId, requestId],
    );
    return {
      kind: "account_deletion" as const,
      requestId,
      requestDigest: "a".repeat(64),
      lifecycleRevision: 1,
      phaseReceiptId,
      phaseGeneration: 1,
    };
  }
  async function administrator(appId: string, accountId: string) {
    const id = randomUUID();
    await db.query("INSERT INTO users(id) VALUES($1)", [id]);
    await db.query(
      "INSERT INTO app_billing_members(app_id,billing_account_id,user_id,role,livemode) VALUES($1,$2,$3,'administrator',false)",
      [appId, accountId, id],
    );
    return id;
  }
  async function decide(scopeId: string, authority: Awaited<ReturnType<typeof deletion>>) {
    return (
      await import("../../db/repositories/app-billing-deletion-dispositions")
    ).decideAppBillingDeletionScope({ scopeId, authority });
  }
  async function fixtureCustomer() {
    const source = await buyer();
    await runtime.prepare(source.identity, {
      idempotencyKey: randomUUID(),
      expectedSubscriptionRevision: null,
      payload: {
        version: 1,
        domain: "buyer",
        action: "trial",
        planRevisionId: source.planId,
        quantity: 1,
      },
    });
    const sibling = await authority.resolveScope({
      ...source.identity,
      productFamilyKey: "second",
      merchantId: merchant,
    });
    const binding = (
      await db.query(
        "SELECT * FROM app_billing_customers WHERE billing_account_id=$1 AND merchant_id=$2",
        [source.identity.billingAccountId, merchant],
      )
    ).rows[0];
    if (!binding) throw new Error("Runtime did not bind its customer");
    return { ...source, siblingId: sibling.scopeId, binding };
  }
  async function freeze(
    customerBindingId: string,
    authority: Awaited<ReturnType<typeof deletion>>,
  ) {
    return (
      await import("../../db/repositories/app-billing-customer-closures")
    ).closeAppBillingCustomer({ customerBindingId, authority });
  }
  async function settledCustomer() {
    const source = await buyer();
    const checkout = await runtime.checkout(source.identity, {
      idempotencyKey: randomUUID(),
      expectedSubscriptionRevision: null,
      planRevisionId: source.planId,
      quantity: 1,
      billingConsent: "accepted",
    });
    expect(checkout.status).toBe("requires_action");
    const expired = await runtime.prepare(source.identity, {
      idempotencyKey: randomUUID(),
      expectedSubscriptionRevision: null,
      payload: {
        version: 1,
        domain: "buyer",
        action: "expire_checkout",
        checkoutCommandId: checkout.id,
      },
    });
    expect(expired.status).toBe("succeeded");
    const binding = (
      await db.query(
        "SELECT id FROM app_billing_customers WHERE billing_account_id=$1 AND merchant_id=$2",
        [source.identity.billingAccountId, merchant],
      )
    ).rows[0];
    if (!binding) throw new Error("Checkout did not retain its customer binding");
    const auth = await deletion(source.identity.actorUserId);
    await decide(source.scopeId, auth);
    await freeze(binding.id, auth);
    return { source, checkout, expired, binding, auth };
  }
  test("settled buyer checkout expiration permits closure but unsettled usage still blocks it", async () => {
    const { source, checkout, expired, binding, auth } = await settledCustomer();
    const preflight = () =>
      db.query("SELECT require_app_billing_customer_terminal_obligations($1,$2,$3,$4,$5,$6)", [
        binding.id,
        auth.requestId,
        auth.requestDigest,
        auth.lifecycleRevision,
        auth.phaseReceiptId,
        auth.phaseGeneration,
      ]);
    await preflight();
    const reservationId = randomUUID();
    await db.query(
      "INSERT INTO billing_funding_reservations(id,organization_id,billing_scope_id,merchant_key,logical_operation_id,request_digest,funding_class,requested_amount,reserved_amount,expires_at) VALUES($1,$2,$3,'acct_runtime',$4,$5,'allowance_eligible',1,1,now()+interval '1 hour')",
      [reservationId, org, source.scopeId, randomUUID(), "b".repeat(64)],
    );
    await expect(preflight()).rejects.toThrow("unsettled usage reservations");
    await db.query(
      "UPDATE billing_funding_reservations SET status='canceled',canceled_at=now(),cancellation_key=$2,cancellation_digest=$3 WHERE id=$1",
      [reservationId, randomUUID(), "c".repeat(64)],
    );
    await preflight();
    const history = (
      await db.query(
        "SELECT status,provider_result FROM billing_subscription_commands WHERE id=ANY($1::uuid[]) ORDER BY id",
        [[checkout.id, expired.id]],
      )
    ).rows;
    expect(
      history.some((row) => row.status === "FAILED" && row.provider_result.kind === "checkout"),
    ).toBe(true);
    expect(
      history.some(
        (row) => row.status === "SUCCEEDED" && row.provider_result.kind === "expired_checkout",
      ),
    ).toBe(true);
  });
  test("only the exact leased deletion command may exclude itself from terminal obligations", async () => {
    const { source, binding, auth } = await settledCustomer();
    const closure = (
      await db.query("SELECT * FROM app_billing_customer_closures WHERE customer_binding_id=$1", [
        binding.id,
      ])
    ).rows[0];
    const payload = {
      version: 1,
      domain: "account_deletion",
      action: "delete_customer",
      customerBindingId: binding.id,
      requestId: auth.requestId,
      requestDigest: auth.requestDigest,
      lifecycleRevision: auth.lifecycleRevision,
      phaseReceiptId: auth.phaseReceiptId,
      initiatingPhaseGeneration: auth.phaseGeneration,
      closureRequestId: closure.initiating_request_id,
      closureRequestDigest: closure.request_digest,
      billingAccountId: source.identity.billingAccountId,
      customerId: closure.stripe_customer_id,
      providerAccountId: closure.stripe_account_id,
    };
    const commandId = randomUUID();
    const insert = (intent: typeof payload) =>
      db.query(
        "INSERT INTO billing_subscription_commands(id,app_id,livemode,merchant_id,organization_id,billing_scope_id,merchant_key,requested_by_user_id,kind,idempotency_key,provider_idempotency_key,request_digest,request_payload) VALUES($1,$2,false,$3,$4,$5,'acct_runtime',$6,'delete_customer',$7,$8,$9,$10)",
        [
          commandId,
          source.identity.appId,
          merchant,
          org,
          source.scopeId,
          source.identity.actorUserId,
          `deletion-customer:${binding.id}`,
          `app-deletion-customer:${binding.id}`,
          settlementDigest(intent),
          JSON.stringify(intent),
        ],
      );
    await expect(insert({ ...payload, customerId: "cus_foreign" })).rejects.toThrow(
      "immutable original closure intent",
    );
    await insert(payload);
    const args = [
      binding.id,
      auth.requestId,
      auth.requestDigest,
      auth.lifecycleRevision,
      auth.phaseReceiptId,
      auth.phaseGeneration,
    ];
    const preflight = (id: string, token: string, generation = 1, revision = 2) =>
      db.query(
        "SELECT require_app_billing_customer_terminal_obligations($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",
        [...args, id, token, generation, revision],
      );
    const token = randomUUID();
    await expect(preflight(commandId, token)).rejects.toThrow("exact current execution lease");
    await db.query(
      "UPDATE billing_subscription_commands SET status='OUTCOME_UNKNOWN',execution_generation=1,state_revision=2,provider_started_at=now(),lease_token=$2,lease_expires_at=now()+interval '1 minute' WHERE id=$1",
      [commandId, token],
    );
    await expect(
      db.query("SELECT require_app_billing_customer_terminal_obligations($1,$2,$3,$4,$5,$6)", args),
    ).rejects.toThrow("unresolved provider commands");
    await expect(preflight(commandId, randomUUID())).rejects.toThrow(
      "exact current execution lease",
    );
    await expect(preflight(commandId, token, 2)).rejects.toThrow("exact current execution lease");
    await expect(preflight(commandId, token, 1, 3)).rejects.toThrow(
      "exact current execution lease",
    );
    await preflight(commandId, token);
    const value = { customerId: payload.customerId, status: "deleted" as const };
    const receipt = {
      kind: "deleted_customer",
      customerBindingId: binding.id,
      observation: {
        value,
        digest: settlementDigest(value),
        inputDigest: "d".repeat(64),
        apiVersion: "2024-11-20.acacia",
        merchantId: merchant,
        providerAccountId: payload.providerAccountId,
        livemode: false,
        observedAt: new Date().toISOString(),
      },
      completionAuthority: {
        requestId: auth.requestId,
        requestDigest: auth.requestDigest,
        lifecycleRevision: auth.lifecycleRevision,
        phaseReceiptId: auth.phaseReceiptId,
        phaseGeneration: auth.phaseGeneration,
      },
    };
    // Submit deterministic receipt proposals through the real migration guard; provider observation is tested separately.
    const complete = (result: typeof receipt) =>
      db.query(
        "UPDATE billing_subscription_commands SET status='SUCCEEDED',provider_result=$2,provider_response_digest=$3,completed_at=now(),state_revision=3,lease_token=NULL,lease_expires_at=NULL WHERE id=$1",
        [commandId, JSON.stringify(result), receipt.observation.digest],
      );
    await expect(
      complete({
        ...receipt,
        observation: { ...receipt.observation, value: { ...value, customerId: "cus_foreign" } },
      }),
    ).rejects.toThrow("exact retained tombstone evidence");
    await db.query("UPDATE account_deletion_phase_receipts SET lease_generation=2 WHERE id=$1", [
      auth.phaseReceiptId,
    ]);
    await expect(preflight(commandId, token)).rejects.toThrow("current canonical deletion phase");
    await expect(complete(receipt)).rejects.toThrow("current canonical deletion phase");
    const accepted = {
      ...receipt,
      completionAuthority: { ...receipt.completionAuthority, phaseGeneration: 2 },
    };
    await complete(accepted);
    await db.query("SELECT require_app_billing_customer_terminal_obligations($1,$2,$3,$4,$5,$6)", [
      ...args.slice(0, 5),
      2,
    ]);
    expect(
      (
        await db.query("SELECT provider_result FROM billing_subscription_commands WHERE id=$1", [
          commandId,
        ])
      ).rows[0].provider_result,
    ).toEqual(accepted);
    await expect(
      db.query("UPDATE billing_subscription_commands SET completed_at=now() WHERE id=$1", [
        commandId,
      ]),
    ).rejects.toThrow("completion is immutable");
    expect(
      (
        await db.query("SELECT request_payload FROM billing_subscription_commands WHERE id=$1", [
          commandId,
        ])
      ).rows[0].request_payload,
    ).toEqual(payload);
  });
  async function deleteCustomer(
    state: Awaited<ReturnType<typeof settledCustomer>>,
    phaseGeneration = state.auth.phaseGeneration,
  ) {
    return (await import("./app-billing-deletion-customer")).deleteClosedAppBillingCustomer(
      state.binding.id,
      { ...state.auth, phaseGeneration },
      resolveProvider,
    );
  }
  test("customer deletion retains the real provider tombstone and replays without provider requests", async () => {
    const state = await settledCustomer();
    const at = fixture.requests.length;
    expect(await deleteCustomer(state)).toBe("complete");
    const rows = (
      await db.query(
        "SELECT status,provider_result,result_subscription_id FROM billing_subscription_commands WHERE request_payload->>'customerBindingId'=$1",
        [state.binding.id],
      )
    ).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("SUCCEEDED");
    expect(rows[0].provider_result.observation.value.status).toBe("deleted");
    expect(rows[0].result_subscription_id).toBeNull();
    expect(
      fixture.requests.slice(at).filter((request) => request.method === "DELETE"),
    ).toHaveLength(1);
    const after = fixture.requests.length;
    expect(await deleteCustomer(state)).toBe("complete");
    expect(fixture.requests.length).toBe(after);
  });
  test("lost customer DELETE response recovers by reading the tombstone without a second DELETE", async () => {
    const state = await settledCustomer();
    const at = fixture.requests.length;
    fixture.loseCustomerDeleteResponse();
    expect(await deleteCustomer(state)).toBe("pending");
    expect(await deleteCustomer(state)).toBe("complete");
    expect(
      fixture.requests.slice(at).filter((request) => request.method === "DELETE"),
    ).toHaveLength(1);
  });
  test("phase takeover during customer read prevents DELETE until fresh canonical authority", async () => {
    const state = await settledCustomer();
    const at = fixture.requests.length;
    fixture.beforeCustomerRead(async () => {
      await db.query("UPDATE account_deletion_phase_receipts SET lease_generation=2 WHERE id=$1", [
        state.auth.phaseReceiptId,
      ]);
    });
    try {
      expect(await deleteCustomer(state)).toBe("pending");
    } finally {
      fixture.beforeCustomerRead(null);
    }
    expect(
      fixture.requests.slice(at).filter((request) => request.method === "DELETE"),
    ).toHaveLength(0);
    expect(await deleteCustomer(state, 2)).toBe("complete");
  });
  test("phase takeover after customer deletion rejects the stale receipt and permits read-only recovery", async () => {
    const state = await settledCustomer();
    const at = fixture.requests.length;
    fixture.beforeCustomerDelete(async () => {
      await db.query("UPDATE account_deletion_phase_receipts SET lease_generation=2 WHERE id=$1", [
        state.auth.phaseReceiptId,
      ]);
    });
    try {
      expect(await deleteCustomer(state)).toBe("pending");
    } finally {
      fixture.beforeCustomerDelete(null);
    }
    expect(await deleteCustomer(state, 2)).toBe("complete");
    expect(
      fixture.requests.slice(at).filter((request) => request.method === "DELETE"),
    ).toHaveLength(1);
  });
  test("concurrent customer claims preserve one journal command and reject a stale execution token", async () => {
    const state = await settledCustomer();
    const repo = (await import("../../db/repositories/app-billing-deletion-customer"))
      .appBillingDeletionCustomerRepository;
    const claims = await Promise.all([
      repo.claim(state.binding.id, state.auth),
      repo.claim(state.binding.id, state.auth),
    ]);
    const owned = claims.find((claim) => claim.kind === "claimed");
    if (!owned || owned.kind !== "claimed")
      throw new Error("Expected one current customer deletion lease");
    expect(claims.filter((claim) => claim.kind === "pending")).toHaveLength(1);
    await repo.release(owned.claim);
    const next = await repo.claim(state.binding.id, state.auth);
    if (next.kind !== "claimed") throw new Error("Expected a replacement execution lease");
    await expect(repo.validateDispatch(owned.claim)).rejects.toThrow();
    await repo.release(next.claim);
    expect(await deleteCustomer(state)).toBe("complete");
    expect(
      (
        await db.query(
          "SELECT count(*)::int AS count FROM billing_subscription_commands WHERE request_payload->>'customerBindingId'=$1",
          [state.binding.id],
        )
      ).rows[0].count,
    ).toBe(1);
  });
  test("closed provider cleanup cancels the real trial before deleting its customer and leaves infrastructure untouched", async () => {
    const source = await fixtureCustomer();
    const auth = await deletion(source.identity.actorUserId);
    await decide(source.scopeId, auth);
    await decide(source.siblingId, auth);
    const { reconcileClosedAppBillingProviders } = await import(
      "./app-billing-deletion-provider-cleanup"
    );
    const at = fixture.requests.length;
    expect(await reconcileClosedAppBillingProviders(auth, resolveProvider)).toBe("pending");
    expect(
      fixture.requests
        .slice(at)
        .some(
          (request) => request.method === "DELETE" && request.path.startsWith("/v1/customers/"),
        ),
    ).toBe(false);
    fixture.loseCustomerDeleteResponse();
    expect(await reconcileClosedAppBillingProviders(auth, resolveProvider)).toBe("pending");
    expect(await reconcileClosedAppBillingProviders(auth, resolveProvider)).toBe("complete");
    const writes = fixture.requests.slice(at).filter((request) => request.method === "DELETE");
    expect(writes).toHaveLength(2);
    expect(writes[0]?.path.startsWith("/v1/subscriptions/")).toBe(true);
    expect(writes[1]?.path).toBe(`/v1/customers/${source.binding.stripe_customer_id}`);
    expect(
      (
        await db.query("SELECT status FROM billing_subscriptions WHERE billing_scope_id=$1", [
          source.scopeId,
        ])
      ).rows[0].status,
    ).toBe("canceled");
    expect(
      (await db.query("SELECT stripe_customer_id FROM organizations WHERE id=$1", [org])).rows[0]
        .stripe_customer_id,
    ).toBe("cus_infrastructure");
    const after = fixture.requests.length;
    expect(await reconcileClosedAppBillingProviders(auth, resolveProvider)).toBe("complete");
    expect(fixture.requests.length).toBe(after);
  });
  test.each(["current_administrator", "historical_purchaser"])(
    "mixed scope cleanup preserves the surviving family's trial and shared customer (%s)",
    async (mode) => {
      const source = await fixtureCustomer();
      const siblingPlanId = randomUUID();
      await db.query(
        `INSERT INTO app_billing_plan_revisions(id,app_id,merchant_id,product_family_key,plan_key,revision,name,amount_cents,currency,interval,maximum_quantity,trial_allowance_usd,paid_allowance_usd,expired_access,entitlements,stripe_price_id,stripe_product_id,published_at)
       SELECT $1,app_id,merchant_id,'second',plan_key,revision,name,amount_cents,currency,interval,maximum_quantity,trial_allowance_usd,paid_allowance_usd,expired_access,entitlements,stripe_price_id,stripe_product_id,published_at FROM app_billing_plan_revisions WHERE id=$2`,
        [siblingPlanId, source.planId],
      );
      const checkout = await runtime.checkout(
        { ...source.identity, productFamilyKey: "second" },
        {
          idempotencyKey: randomUUID(),
          expectedSubscriptionRevision: null,
          planRevisionId: siblingPlanId,
          quantity: 1,
          billingConsent: "accepted",
        },
      );
      expect(checkout.status).toBe("requires_action");
      const { appBillingCommandRuntimeRepository } = await import(
        "../../db/repositories/app-billing-command-runtime"
      );
      const command = await appBillingCommandRuntimeRepository.read({
        scopeId: source.siblingId,
        commandId: checkout.id,
        actorUserId: source.identity.actorUserId,
      });
      const result = command.command.provider_result;
      if (result?.kind !== "checkout") throw new Error("Expected sibling checkout result");
      const siblingProviderId = fixture.completeCheckout(result.checkoutSessionId);
      expect(
        (await runtime.reconcileCommand({ scopeId: source.siblingId, commandId: checkout.id }))
          .status,
      ).toBe("succeeded");
      const siblingBefore = (
        await db.query(
          "SELECT status,stripe_customer_id FROM billing_subscriptions WHERE billing_scope_id=$1",
          [source.siblingId],
        )
      ).rows[0];
      expect(siblingBefore).toEqual({
        status: "active",
        stripe_customer_id: source.binding.stripe_customer_id,
      });
      const observedSibling = await authority.resolveScope({
        ...source.identity,
        productFamilyKey: "unrelated",
        merchantId: merchant,
      });
      const auth = await deletion(source.identity.actorUserId);
      expect((await decide(source.siblingId, auth)).disposition).toBe("close");
      const survivor = await administrator(source.identity.appId, source.identity.billingAccountId);
      if (mode === "historical_purchaser") {
        await db.query(
          "UPDATE app_billing_members SET revoked_at=now() WHERE billing_account_id=$1 AND user_id=$2",
          [source.identity.billingAccountId, source.identity.actorUserId],
        );
        await expect(decide(observedSibling.scopeId, auth)).rejects.toThrow();
      }
      expect((await decide(source.scopeId, auth)).disposition).toBe("retain_shared");
      const { reconcileClosedAppBillingProviders } = await import(
        "./app-billing-deletion-provider-cleanup"
      );
      const before = (
        await db.query(
          "SELECT status,lifecycle_revision,stripe_customer_id FROM billing_subscriptions WHERE billing_scope_id=$1",
          [source.scopeId],
        )
      ).rows;
      const at = fixture.requests.length;
      expect(await reconcileClosedAppBillingProviders(auth, resolveProvider)).toBe("pending");
      expect(
        (
          await db.query("SELECT status FROM billing_subscriptions WHERE billing_scope_id=$1", [
            source.siblingId,
          ])
        ).rows[0].status,
      ).toBe("canceled");
      if (mode === "current_administrator") {
        expect(await reconcileClosedAppBillingProviders(auth, resolveProvider)).toBe("pending");
        expect((await decide(observedSibling.scopeId, auth)).disposition).toBe("retain_shared");
      }
      expect(await reconcileClosedAppBillingProviders(auth, resolveProvider)).toBe("complete");
      expect(
        (
          await db.query(
            "SELECT status,lifecycle_revision,stripe_customer_id FROM billing_subscriptions WHERE billing_scope_id=$1",
            [source.scopeId],
          )
        ).rows,
      ).toEqual(before);
      expect(before[0].status).toBe("trialing");
      expect(fixture.deletedCustomers.has(source.binding.stripe_customer_id)).toBe(false);
      expect(
        fixture.requests
          .slice(at)
          .filter((request) => request.method === "DELETE")
          .map((request) => request.path),
      ).toEqual([`/v1/subscriptions/${siblingProviderId}`]);
      await db.query("UPDATE users SET auth_fenced_at=now() WHERE id=$1", [survivor]);
      expect(await reconcileClosedAppBillingProviders(auth, resolveProvider)).toBe("pending");
      expect(
        fixture.requests
          .slice(at)
          .filter((request) => request.method === "DELETE")
          .map((request) => request.path),
      ).toEqual([`/v1/subscriptions/${siblingProviderId}`]);
    },
  );
  test("closure intent cannot authorize customer deletion while a trial still runs", async () => {
    const source = await fixtureCustomer();
    const auth = await deletion(source.identity.actorUserId);
    await decide(source.scopeId, auth);
    await decide(source.siblingId, auth);
    await freeze(source.binding.id, auth);
    const before = (
      await db.query("SELECT * FROM billing_subscriptions WHERE billing_scope_id=$1", [
        source.scopeId,
      ])
    ).rows;
    await expect(
      db.query("SELECT require_app_billing_customer_terminal_obligations($1,$2,$3,$4,$5,$6)", [
        source.binding.id,
        auth.requestId,
        auth.requestDigest,
        auth.lifecycleRevision,
        auth.phaseReceiptId,
        auth.phaseGeneration,
      ]),
    ).rejects.toThrow("unresolved subscription obligations");
    expect(
      (
        await db.query("SELECT * FROM billing_subscriptions WHERE billing_scope_id=$1", [
          source.scopeId,
        ])
      ).rows,
    ).toEqual(before);
    await expect(
      db.query("SELECT require_app_billing_customer_terminal_obligations($1,$2,$3,$4,$5,$6)", [
        source.binding.id,
        auth.requestId,
        auth.requestDigest,
        auth.lifecycleRevision,
        auth.phaseReceiptId,
        auth.phaseGeneration + 1,
      ]),
    ).rejects.toThrow("current canonical deletion phase");
  });
  test("a retained sibling blocks customer closure until it receives a canonical close decision", async () => {
    const source = await fixtureCustomer();
    const survivor = await administrator(source.identity.appId, source.identity.billingAccountId);
    const auth = await deletion(source.identity.actorUserId);
    expect((await decide(source.siblingId, auth)).disposition).toBe("retain_shared");
    await db.query("UPDATE users SET auth_fenced_at=now() WHERE id=$1", [survivor]);
    expect((await decide(source.scopeId, auth)).disposition).toBe("close");
    await expect(freeze(source.binding.id, auth)).rejects.toMatchObject({
      cause: { cause: { message: expect.stringContaining("Every sharing scope") } },
    });
    expect(
      (
        await db.query(
          "SELECT count(*)::int AS count FROM app_billing_customer_closures WHERE customer_binding_id=$1",
          [source.binding.id],
        )
      ).rows[0].count,
    ).toBe(0);
    await decide(source.siblingId, auth);
    const closure = await freeze(source.binding.id, auth);
    expect(closure.stripe_customer_id).toBe(source.binding.stripe_customer_id);
    expect(closure.merchant_id).toBe(merchant);
    expect(closure.livemode).toBe(false);
    expect(closure.stripe_account_id).toBe("acct_runtime");
    await expect(
      db.query(
        `INSERT INTO app_billing_customer_closures(customer_binding_id,billing_account_id,app_id,merchant_id,provider_account_key,stripe_account_id,livemode,stripe_customer_id,initiating_request_id,request_digest,lifecycle_revision,phase_receipt_id,phase_generation)
      SELECT customer_binding_id,billing_account_id,app_id,merchant_id,provider_account_key,stripe_account_id,NOT livemode,stripe_customer_id,initiating_request_id,request_digest,lifecycle_revision,phase_receipt_id,phase_generation FROM app_billing_customer_closures WHERE customer_binding_id=$1 ON CONFLICT DO NOTHING`,
        [source.binding.id],
      ),
    ).rejects.toThrow("provider identity mismatch");
    const after = await db.query(
      "SELECT status FROM billing_subscriptions WHERE billing_scope_id=$1",
      [source.scopeId],
    );
    expect(after.rows[0].status).toBe("trialing");
  });
  test("concurrent deletion requests converge on one immutable closure and stale replays still fail", async () => {
    const source = await fixtureCustomer();
    const other = await administrator(source.identity.appId, source.identity.billingAccountId);
    const first = await deletion(source.identity.actorUserId),
      second = await deletion(other);
    for (const auth of [first, second])
      for (const scope of [source.scopeId, source.siblingId]) await decide(scope, auth);
    const [a, b] = await Promise.all([
      freeze(source.binding.id, first),
      freeze(source.binding.id, second),
    ]);
    expect(a).toEqual(b);
    expect(
      (
        await db.query(
          "SELECT count(*)::int AS count FROM app_billing_customer_closures WHERE customer_binding_id=$1",
          [source.binding.id],
        )
      ).rows[0].count,
    ).toBe(1);
    await db.query("UPDATE account_deletion_phase_receipts SET lease_generation=2 WHERE id=$1", [
      first.phaseReceiptId,
    ]);
    await expect(freeze(source.binding.id, first)).rejects.toMatchObject({
      cause: { cause: { message: expect.stringContaining("current canonical deletion phase") } },
    });
    expect(await freeze(source.binding.id, { ...first, phaseGeneration: 2 })).toEqual(a);
    await expect(
      db.query(
        "UPDATE app_billing_customer_closures SET stripe_customer_id='cus_wrong' WHERE customer_binding_id=$1",
        [source.binding.id],
      ),
    ).rejects.toThrow("identity is immutable");
  });
  test("owner locking serializes sibling admission in both closure orders", async () => {
    const writer = new Client({ connectionString: process.env.DATABASE_URL });
    await writer.connect();
    async function waitForBlockedBy(pid: number) {
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        const blocked = await db.query(
          "SELECT 1 FROM pg_stat_activity WHERE $1::int=ANY(pg_blocking_pids(pid))",
          [pid],
        );
        if (blocked.rowCount) return;
        await Bun.sleep(10);
      }
      throw new Error("Expected competing billing operation to wait for owner lock");
    }
    const insertScope = (client: Client, source: Awaited<ReturnType<typeof fixtureCustomer>>) =>
      client.query(
        "INSERT INTO app_billing_scopes(app_id,organization_id,billing_account_id,merchant_id,livemode,product_family_key) VALUES($1,$2,$3,$4,false,'racing-family')",
        [source.identity.appId, org, source.identity.billingAccountId, merchant],
      );
    try {
      const first = await fixtureCustomer();
      const auth = await deletion(first.identity.actorUserId);
      await decide(first.scopeId, auth);
      await decide(first.siblingId, auth);
      await writer.query("BEGIN");
      const pid = (await writer.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
      await writer.query(
        `INSERT INTO app_billing_customer_closures(customer_binding_id,billing_account_id,app_id,merchant_id,provider_account_key,stripe_account_id,livemode,stripe_customer_id,initiating_request_id,request_digest,lifecycle_revision,phase_receipt_id,phase_generation)
         SELECT c.id,c.billing_account_id,a.app_id,c.merchant_id,m.provider_account_key,m.stripe_account_id,m.livemode,c.stripe_customer_id,$2,$3,$4,$5,$6 FROM app_billing_customers c JOIN app_billing_accounts a ON a.id=c.billing_account_id JOIN billing_merchants m ON m.id=c.merchant_id WHERE c.id=$1`,
        [
          first.binding.id,
          auth.requestId,
          auth.requestDigest,
          auth.lifecycleRevision,
          auth.phaseReceiptId,
          auth.phaseGeneration,
        ],
      );
      // Use a separate observer because this client is waiting inside the admission trigger.
      const admission = new Client({ connectionString: process.env.DATABASE_URL });
      await admission.connect();
      try {
        const rejected = insertScope(admission, first).then(
          () => null,
          (error: Error) => error,
        );
        await waitForBlockedBy(pid);
        await writer.query("COMMIT");
        expect(await rejected).toMatchObject({
          message: expect.stringContaining("cannot admit a scope or reuse"),
        });
      } finally {
        await writer.query("ROLLBACK");
        await admission.end();
      }
      const second = await fixtureCustomer();
      const next = await deletion(second.identity.actorUserId);
      await decide(second.scopeId, next);
      await decide(second.siblingId, next);
      await writer.query("BEGIN");
      await insertScope(writer, second);
      const rejected = freeze(second.binding.id, next).then(
        () => null,
        (error: Error) => error,
      );
      await waitForBlockedBy(pid);
      await writer.query("COMMIT");
      expect(await rejected).toMatchObject({
        cause: { cause: { message: expect.stringContaining("Every sharing scope requires") } },
      });
      expect(
        (
          await db.query(
            "SELECT count(*)::int AS count FROM app_billing_customer_closures WHERE customer_binding_id=$1",
            [second.binding.id],
          )
        ).rows[0].count,
      ).toBe(0);
    } finally {
      await writer.query("ROLLBACK");
      await writer.end();
    }
  });
  test("stale phase cannot create closure and closing rejects new scopes and binding replays", async () => {
    const source = await fixtureCustomer();
    const auth = await deletion(source.identity.actorUserId);
    await decide(source.scopeId, auth);
    await decide(source.siblingId, auth);
    await expect(freeze(source.binding.id, { ...auth, phaseGeneration: 2 })).rejects.toMatchObject({
      cause: { cause: { message: expect.stringContaining("current canonical deletion phase") } },
    });
    expect(
      (
        await db.query(
          "SELECT count(*)::int AS count FROM app_billing_customer_closures WHERE customer_binding_id=$1",
          [source.binding.id],
        )
      ).rows[0].count,
    ).toBe(0);
    await db.query(
      "UPDATE account_deletion_phase_receipts SET lease_expires_at=(now() AT TIME ZONE 'UTC')-interval '1 second' WHERE id=$1",
      [auth.phaseReceiptId],
    );
    await expect(freeze(source.binding.id, auth)).rejects.toMatchObject({
      cause: { cause: { message: expect.stringContaining("current canonical deletion phase") } },
    });
    await db.query(
      "UPDATE account_deletion_phase_receipts SET lease_expires_at=(now() AT TIME ZONE 'UTC')+interval '5 minutes' WHERE id=$1",
      [auth.phaseReceiptId],
    );
    const closure = await freeze(source.binding.id, auth);
    await expect(db.query("TRUNCATE app_billing_customer_closures")).rejects.toThrow(
      "identity is immutable",
    );
    expect(await freeze(source.binding.id, auth)).toEqual(closure);
    await expect(
      db.query(
        "INSERT INTO app_billing_scopes(app_id,organization_id,billing_account_id,merchant_id,livemode,product_family_key) VALUES($1,$2,$3,$4,false,'new-family')",
        [source.identity.appId, org, source.identity.billingAccountId, merchant],
      ),
    ).rejects.toThrow("cannot admit a scope or reuse");
    await expect(
      db.query(
        "INSERT INTO app_billing_customers(id,billing_account_id,merchant_id,stripe_customer_id,command_id) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING",
        [
          source.binding.id,
          source.binding.billing_account_id,
          source.binding.merchant_id,
          source.binding.stripe_customer_id,
          source.binding.command_id,
        ],
      ),
    ).rejects.toThrow("cannot admit a scope or reuse");
    expect(
      (
        await db.query(
          "SELECT count(*)::int AS count FROM app_billing_scopes WHERE billing_account_id=$1 AND merchant_id=$2",
          [source.identity.billingAccountId, merchant],
        )
      ).rows[0].count,
    ).toBe(2);
  });
  test("Stripe completion waits for the app owner before taking the phase lock", async () => {
    const source = await buyer();
    const auth = await deletion(source.identity.actorUserId);
    const { accountDeletionRequestsRepository } = await import(
      "../../db/repositories/account-deletion-requests"
    );
    const holder = new Client({ connectionString: postgresUrl });
    await holder.connect();
    await holder.query(`SET search_path TO ${schema},public`);
    await holder.query("BEGIN");
    let holding = true;
    try {
      await holder.query("SELECT id FROM organizations WHERE id=$1 FOR UPDATE", [org]);
      const pid = (await holder.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
      let settled = false;
      // error-policy:J1 Observe repository failure while the competing transaction must release its owner lock.
      const completion = accountDeletionRequestsRepository
        .completeProviderPhase({
          requestId: auth.requestId,
          phaseReceiptId: auth.phaseReceiptId,
          generation: auth.phaseGeneration,
          providerReceiptDigest: "b".repeat(64),
          now: new Date("2000-01-01T00:00:00Z"),
        })
        .then(
          (value) => {
            settled = true;
            return { value };
          },
          (error) => {
            settled = true;
            return { error };
          },
        );
      let blocked = false;
      try {
        const deadline = Date.now() + 60000;
        while (!settled && Date.now() < deadline) {
          if (
            (
              await db.query(
                "SELECT pid FROM pg_stat_activity WHERE $1::int=ANY(pg_blocking_pids(pid))",
                [pid],
              )
            ).rowCount
          ) {
            blocked = true;
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        if (blocked)
          await holder.query(
            "UPDATE account_deletion_phase_receipts SET lease_expires_at=(clock_timestamp() AT TIME ZONE 'UTC')-interval '1 second' WHERE id=$1",
            [auth.phaseReceiptId],
          );
      } finally {
        await holder.query("COMMIT");
        holding = false;
      }
      const result = await completion;
      if ("error" in result) throw result.error;
      expect(blocked).toBe(true);
      expect(result.value).toBe(false);
      expect(
        (
          await db.query(
            "SELECT status,provider_receipt_digest FROM account_deletion_phase_receipts WHERE id=$1",
            [auth.phaseReceiptId],
          )
        ).rows[0],
      ).toEqual({ status: "calling", provider_receipt_digest: null });
    } finally {
      if (holding) await holder.query("ROLLBACK");
      await holder.end();
    }
  });
  test("Stripe completion with no app obligations preserves current phase authority", async () => {
    const userId = randomUUID();
    await db.query("INSERT INTO users(id) VALUES($1)", [userId]);
    const auth = await deletion(userId);
    const { accountDeletionRequestsRepository } = await import(
      "../../db/repositories/account-deletion-requests"
    );
    const input = {
      requestId: auth.requestId,
      phaseReceiptId: auth.phaseReceiptId,
      generation: auth.phaseGeneration,
      providerReceiptDigest: "c".repeat(64),
      now: new Date("2000-01-01T00:00:00Z"),
    };
    expect(
      await accountDeletionRequestsRepository.completeProviderPhase({
        ...input,
        generation: auth.phaseGeneration + 1,
      }),
    ).toBe(false);
    expect(await accountDeletionRequestsRepository.completeProviderPhase(input)).toBe(true);
    expect(await accountDeletionRequestsRepository.completeProviderPhase(input)).toBe(false);
    expect(
      (
        await db.query(
          "SELECT status,provider_receipt_digest FROM account_deletion_phase_receipts WHERE id=$1",
          [auth.phaseReceiptId],
        )
      ).rows[0],
    ).toEqual({ status: "completed", provider_receipt_digest: input.providerReceiptDigest });
  });
  test("Stripe completion rejects omitted decisions and an expired retained administrator", async () => {
    const source = await buyer();
    const survivor = await administrator(source.identity.appId, source.identity.billingAccountId);
    const auth = await deletion(source.identity.actorUserId);
    const complete = () =>
      db.query("UPDATE account_deletion_phase_receipts SET status='completed' WHERE id=$1", [
        auth.phaseReceiptId,
      ]);
    await expect(complete()).rejects.toThrow("canonical scope decision");
    expect((await decide(source.scopeId, auth)).disposition).toBe("retain_shared");
    await db.query(
      "UPDATE users SET expires_at=(clock_timestamp() AT TIME ZONE 'UTC')-interval '1 second' WHERE id=$1",
      [survivor],
    );
    await expect(complete()).rejects.toThrow("eligible surviving administrator");
    expect(
      (
        await db.query("SELECT status FROM account_deletion_phase_receipts WHERE id=$1", [
          auth.phaseReceiptId,
        ])
      ).rows[0].status,
    ).toBe("calling");
    await db.query("UPDATE users SET expires_at=NULL WHERE id=$1", [survivor]);
    await complete();
    expect(
      (
        await db.query("SELECT status FROM account_deletion_phase_receipts WHERE id=$1", [
          auth.phaseReceiptId,
        ])
      ).rows[0].status,
    ).toBe("completed");
  });
  test("ordinary member departure does not acquire scope decision authority", async () => {
    const source = await buyer();
    await administrator(source.identity.appId, source.identity.billingAccountId);
    await db.query(
      "UPDATE app_billing_members SET role='member' WHERE user_id=$1 AND billing_account_id=$2",
      [source.identity.actorUserId, source.identity.billingAccountId],
    );
    const auth = await deletion(source.identity.actorUserId);
    await expect(decide(source.scopeId, auth)).rejects.toThrow("no billing scope authority");
    const { accountDeletionRequestsRepository } = await import(
      "../../db/repositories/account-deletion-requests"
    );
    expect(
      await accountDeletionRequestsRepository.completeProviderPhase({
        requestId: auth.requestId,
        phaseReceiptId: auth.phaseReceiptId,
        generation: auth.phaseGeneration,
        providerReceiptDigest: "d".repeat(64),
        now: new Date(),
      }),
    ).toBe(true);
    expect(
      (await db.query("SELECT fenced_at FROM app_billing_scopes WHERE id=$1", [source.scopeId]))
        .rows[0].fenced_at,
    ).toBeNull();
  });
});
