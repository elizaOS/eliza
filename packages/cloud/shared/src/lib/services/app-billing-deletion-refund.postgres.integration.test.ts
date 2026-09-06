/** Exercises purchaser recovery through the real command journal, PostgreSQL finalizer and Stripe SDK with controlled HTTP. */
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Client } from "pg";
import type { BuyerBillingIdentity, GenericBillingRuntime } from "./generic-billing-runtime";
import { createRuntimeStripeFixture } from "./generic-billing-runtime.stripe-fixture";

const postgresUrl = process.env.APP_BILLING_TEST_POSTGRES_URL;
const schema = `app_refund_recovery_${randomUUID().replaceAll("-", "_")}`;
if (postgresUrl) {
  const repositoryUrl = new URL(postgresUrl);
  repositoryUrl.searchParams.set(
    "options",
    `-c search_path=${schema},public -c timezone=America/New_York`,
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

describe.skipIf(!postgresUrl)("generic purchaser runtime with PostgreSQL and Stripe HTTP", () => {
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
      "0402_app_billing_application_slots",
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
      "0432_billing_owner_subjects",
      "0433_billing_owner_subject_guards",
      "0434_billing_owner_subject_creation",
      "0435_billing_owner_source_anchors",
      "0436_billing_owner_subject_backfill",
      "0445_app_billing_refund_observations",
      "0446_app_billing_refund_recovery_authority",
      "0447_app_billing_refund_observation_guards",
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

  test("deletion reconciles refund receipts without issuing another refund", async () => {
    const { identity, planId, scopeId } = await buyer();
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
    expect(trial.status).toBe("succeeded");
    const active = await queries.snapshot(identity);
    if (active.kind !== "subscription") throw new Error("Expected original trial subscription");
    const canceled = await runtime.prepare(identity, {
      idempotencyKey: randomUUID(),
      expectedSubscriptionRevision: active.subscription.lifecycle_revision,
      payload: { version: 1, domain: "buyer", action: "cancel", timing: "immediate" },
    });
    expect(canceled.status).toBe("succeeded");
    const inactive = await queries.snapshot(identity);
    expect(inactive.mutationRevision).toBeNull();
    const checkout = await runtime.checkout(identity, {
      idempotencyKey: randomUUID(),
      expectedSubscriptionRevision: null,
      planRevisionId: planId,
      quantity: 3,
      billingConsent: "accepted",
    });
    expect(checkout.status).toBe("requires_action");
    const command = await commands.read({
      scopeId,
      commandId: checkout.id,
      actorUserId: identity.actorUserId,
    });
    const result = command.command.provider_result;
    if (result?.kind !== "checkout") throw new Error("Expected scoped checkout result");
    const providerId = fixture.completeCheckout(result.checkoutSessionId);
    expect((await runtime.reconcileCommand({ scopeId, commandId: checkout.id })).status).toBe(
      "succeeded",
    );
    const renewed = await queries.snapshot(identity);
    if (renewed.kind !== "subscription") throw new Error("Expected paid subscription");
    expect(renewed.subscription.stripe_subscription_id).toBe(providerId);
    expect(renewed.subscription.stripe_customer_id).toBe(active.subscription.stripe_customer_id);
    expect(renewed.subscription.status).toBe("active");
    expect(renewed.trial?.id).toBe(active.trial?.id);
    const paid = await db.query(
      "SELECT granted_amount FROM subscription_allowance_periods WHERE subscription_id=$1 AND grant_source='paid_invoice'",
      [renewed.subscription.id],
    );
    expect(paid.rows).toEqual([{ granted_amount: "25.000000" }]);
    const administratorId = randomUUID();
    const registrationId = randomUUID();
    await db.query("INSERT INTO users(id,organization_id,role) VALUES($1,$2,'owner')", [
      administratorId,
      org,
    ]);
    await db.query(
      "INSERT INTO app_client_registrations(id,app_id,owner_organization_id,billing_environment,secret_hashes,redirect_uris,allowed_scopes) VALUES($1,$2,$3,'test','[]','[]','[]')",
      [registrationId, identity.appId, org],
    );
    const receipt = await db.query(
      "SELECT id,stripe_invoice_id FROM app_subscription_paid_periods WHERE subscription_id=$1",
      [renewed.subscription.id],
    );
    expect(receipt.rows).toHaveLength(1);
    const { lockAppBillingRefundSource } = await import(
      "../../db/repositories/app-billing-refund-source"
    );
    const { writeTransaction } = await import("../../db/helpers");
    const owner = { appId: identity.appId, organizationId: org, userId: administratorId };
    const selection = { clientRegistrationId: registrationId, paidPeriodId: receipt.rows[0].id };
    const resolveRefund = () =>
      writeTransaction((tx) => lockAppBillingRefundSource(tx, owner, selection));
    const source = await resolveRefund();
    const { GenericBillingAdminService } = await import("./generic-billing-admin");
    const { appBillingAdminRepository } = await import("../../db/repositories/app-billing-admin");
    const { recoverAppBillingRefundForDeletion: recover } = await import(
      "./app-billing-deletion-refund"
    );
    const { appBillingDeletionRefundRepository: repository } = await import(
      "../../db/repositories/app-billing-deletion-refund"
    );
    const { decideAppBillingDeletionScope } = await import(
      "../../db/repositories/app-billing-deletion-dispositions"
    );
    const admin = new GenericBillingAdminService(async () => fixture.stripe);
    const prepare = () =>
      appBillingAdminRepository.prepare(owner, {
        clientRegistrationId: registrationId,
        idempotencyKey: randomUUID(),
        merchantId: merchant,
        requestDigest: "d".repeat(64),
        payload: () => ({
          version: 1,
          domain: "admin",
          action: "refund",
          clientRegistrationId: registrationId,
          source,
          amountCents: 300,
          accessPolicy: "preserve",
        }),
      });
    const prepared = await prepare();
    const absent = await prepare();
    await appBillingAdminRepository.claim(owner, absent.id);
    const refundKey = randomUUID();
    fixture.loseRefundResponse();
    await expect(
      admin.refund(owner, {
        ...selection,
        idempotencyKey: refundKey,
        amountCents: 500,
        accessPolicy: "preserve",
        confirmation: "refund_original_payment_preserve_access",
      }),
    ).rejects.toThrow("Refund response lost");
    const original = (
      await db.query("SELECT * FROM billing_subscription_commands WHERE idempotency_key=$1", [
        refundKey,
      ])
    ).rows[0];
    const requestId = randomUUID(),
      phaseId = randomUUID();
    await db.query(
      "INSERT INTO account_deletion_requests(id,user_id,organization_id,request_digest,lifecycle_revision,irreversible_at,status) VALUES($1,$2,$3,$4,1,now(),'processing')",
      [requestId, administratorId, org, "f".repeat(64)],
    );
    await db.query(
      "INSERT INTO account_deletion_phase_receipts(id,request_id,phase,lease_generation,lease_expires_at,status) VALUES($1,$2,'stripe',1,(clock_timestamp() AT TIME ZONE 'UTC')+interval '1 hour','calling')",
      [phaseId, requestId],
    );
    await db.query(
      "UPDATE organizations SET account_lifecycle_state='deletion_irreversible',account_deletion_request_id=$1,account_lifecycle_revision=1,paid_work_fenced_at=now() WHERE id=$2",
      [requestId, org],
    );
    await db.query(
      "UPDATE users SET account_lifecycle_state='deletion_irreversible',account_deletion_request_id=$1,account_lifecycle_revision=1,auth_fenced_at=now() WHERE id=$2",
      [requestId, administratorId],
    );
    const deletion = {
      kind: "account_deletion" as const,
      requestId,
      requestDigest: "f".repeat(64),
      lifecycleRevision: 1,
      phaseReceiptId: phaseId,
      phaseGeneration: 1,
    };
    const stripe = async () => fixture.stripe;
    await expect(recover(original.id, deletion, stripe)).rejects.toMatchObject({
      cause: { message: "Refund recovery requires the exact canonical closed payment scope" },
    });
    await decideAppBillingDeletionScope({ scopeId, authority: deletion });
    await db.query("UPDATE app_client_registrations SET is_active=false WHERE id=$1", [
      registrationId,
    ]);
    await expect(resolveRefund()).rejects.toThrow();
    const boundary = fixture.requests.length;
    expect(await recover(prepared.id, deletion, stripe)).toEqual({ status: "superseded" });
    expect(await recover(original.id, deletion, stripe)).toMatchObject({
      status: "unresolved",
      reason: "execution_leased",
    });
    await db.query(
      "UPDATE billing_subscription_commands SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=ANY($1::uuid[])",
      [[original.id, absent.id]],
    );
    expect(await recover(absent.id, deletion, stripe)).toMatchObject({
      status: "unresolved",
      reason: "provider_absent",
    });
    expect(await recover(original.id, deletion, stripe)).toMatchObject({
      status: "unresolved",
      reason: "provider_pending",
      providerStatus: "pending",
    });
    const recovered = (
      await db.query("SELECT * FROM billing_subscription_commands WHERE id=$1", [original.id])
    ).rows[0];
    expect(recovered.status).toBe("SUCCEEDED");
    expect(recovered.request_payload).toEqual(original.request_payload);
    expect(recovered.requested_by_user_id).toBe(original.requested_by_user_id);
    expect(recovered.provider_started_at).toEqual(original.provider_started_at);
    const refundId = recovered.provider_result.refundId;
    for (const status of ["succeeded", "failed", "canceled"] as const) {
      fixture.setRefundStatus(refundId, status);
      expect(await recover(original.id, deletion, stripe)).toMatchObject({
        status: "terminal",
        providerStatus: status,
      });
    }
    expect(
      (
        await db.query("SELECT provider_result FROM billing_subscription_commands WHERE id=$1", [
          original.id,
        ])
      ).rows[0].provider_result,
    ).toEqual(recovered.provider_result);
    const observations = (
      await db.query(
        "SELECT * FROM app_billing_refund_observations WHERE command_id=$1 ORDER BY observation_sequence",
        [original.id],
      )
    ).rows;
    expect(observations.map((r) => r.observation.value.status)).toEqual([
      "pending",
      "succeeded",
      "failed",
      "canceled",
    ]);
    await expect(
      db.query("UPDATE app_billing_refund_observations SET observation='{}' WHERE id=$1", [
        observations[0].id,
      ]),
    ).rejects.toThrow("immutable");
    await expect(
      db.query("DELETE FROM app_billing_refund_observations WHERE id=$1", [observations[0].id]),
    ).rejects.toThrow("immutable");
    const snapshot = await repository.inspect(original.id, deletion);
    if (snapshot.kind !== "read") throw new Error("Expected refund read snapshot");
    await expect(
      repository.record(
        snapshot,
        deletion,
        { ...observations.at(-1).observation, digest: "0".repeat(64) },
        null,
      ),
    ).rejects.toMatchObject({
      cause: {
        message: "Refund observation does not match original command and provider evidence",
      },
    });
    await expect(
      repository.record(
        snapshot,
        deletion,
        { ...observations.at(-1).observation, inputDigest: "0".repeat(64) },
        null,
      ),
    ).rejects.toMatchObject({
      cause: {
        message: "Refund observation does not match original command and provider evidence",
      },
    });
    const validObservation = observations.at(-1).observation;
    for (const invalid of [
      { ...validObservation, providerAccountId: "acct_foreign" },
      { ...validObservation, livemode: true },
      { ...validObservation, apiVersion: "2020-01-01" },
      { ...validObservation, observedAt: "2099-01-01T00:00:00.000Z" },
    ])
      await expect(repository.record(snapshot, deletion, invalid, null)).rejects.toMatchObject({
        cause: {
          message: "Refund observation does not match original command and provider evidence",
        },
      });
    expect(
      observations.every(
        (row, index) =>
          index === 0 ||
          BigInt(row.observation_sequence) > BigInt(observations[index - 1].observation_sequence),
      ),
    ).toBe(true);
    await expect(
      recover(original.id, { ...deletion, phaseGeneration: 2 }, stripe),
    ).rejects.toMatchObject({
      cause: { message: "Refund recovery requires current canonical irreversible authority" },
    });
    await db.query(
      "UPDATE account_deletion_phase_receipts SET lease_expires_at=(clock_timestamp() AT TIME ZONE 'UTC')-interval '1 second' WHERE id=$1",
      [phaseId],
    );
    await expect(recover(original.id, deletion, stripe)).rejects.toMatchObject({
      cause: { message: "Refund recovery requires current canonical irreversible authority" },
    });
    expect(fixture.requests.slice(boundary).filter((r) => r.method !== "GET")).toEqual([]);
    expect(
      (
        await db.query("SELECT status FROM billing_subscriptions WHERE id=$1", [
          renewed.subscription.id,
        ])
      ).rows[0].status,
    ).toBe("active");
    expect(
      (await db.query("SELECT credit_balance FROM organizations WHERE id=$1", [org])).rows[0]
        .credit_balance,
    ).toBe("0");
  });
});
