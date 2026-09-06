/** Exercises purchaser recovery through the real command journal, PostgreSQL finalizer and Stripe SDK with controlled HTTP. */
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Client } from "pg";
import type { AccountDeletionProviderContext } from "./account-deletion-saga";
import type { BuyerBillingIdentity, GenericBillingRuntime } from "./generic-billing-runtime";
import { createRuntimeStripeFixture } from "./generic-billing-runtime.stripe-fixture";

const postgresUrl = process.env.APP_BILLING_TEST_POSTGRES_URL;
const schema = `app_runtime_${randomUUID().replaceAll("-", "_")}`;
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

  test("deletion inventory preserves other administrators and separates developer obligations", async () => {
    const { identity, scopeId } = await buyer();
    const { readAppBillingDeletionObligations: inventory } = await import(
      "../../db/repositories/app-billing-deletion-inventory"
    );
    const personalOrg = randomUUID();
    await db.query("INSERT INTO organizations(id) VALUES($1)", [personalOrg]);
    const input = { userId: identity.actorUserId, organizationId: personalOrg };
    expect(await inventory(input)).toMatchObject([
      {
        scopeId,
        customerId: null,
        departingAdministrator: true,
        disposition: "purchaser_without_successor",
      },
    ]);
    const successor = randomUUID();
    await db.query("INSERT INTO users(id) VALUES($1)", [successor]);
    await db.query(
      "INSERT INTO app_billing_members(app_id,billing_account_id,user_id,role,livemode) VALUES($1,$2,$3,'administrator',true)",
      [identity.appId, identity.billingAccountId, successor],
    );
    expect((await inventory(input))[0].disposition).toBe("purchaser_without_successor");
    await db.query("UPDATE app_billing_members SET livemode=false WHERE user_id=$1", [successor]);
    expect((await inventory(input))[0].disposition).toBe("shared_purchaser");
    await db.query("UPDATE users SET auth_fenced_at=now() WHERE id=$1", [successor]);
    expect((await inventory(input))[0].disposition).toBe("purchaser_without_successor");
    await db.query(
      "UPDATE users SET auth_fenced_at=NULL,expires_at=(now() AT TIME ZONE 'UTC')-interval '1 second' WHERE id=$1",
      [successor],
    );
    expect((await inventory(input))[0].disposition).toBe("purchaser_without_successor");
    await db.query(
      "UPDATE users SET expires_at=(now() AT TIME ZONE 'UTC')+interval '1 hour' WHERE id=$1",
      [successor],
    );
    expect((await inventory(input))[0].disposition).toBe("shared_purchaser");
    await db.query("UPDATE users SET account_lifecycle_state='deleting' WHERE id=$1", [successor]);
    expect((await inventory(input))[0].disposition).toBe("purchaser_without_successor");
    await db.query("UPDATE users SET account_lifecycle_state='active' WHERE id=$1", [successor]);
    await db.query("UPDATE app_billing_members SET revoked_at=now() WHERE user_id=$1", [successor]);
    expect((await inventory(input))[0].disposition).toBe("purchaser_without_successor");
    await db.query("UPDATE app_billing_members SET role='member' WHERE user_id=$1", [
      identity.actorUserId,
    ]);
    expect((await inventory(input))[0]).toMatchObject({
      departingAdministrator: false,
      disposition: "purchaser_without_successor",
    });
    await db.query(
      "UPDATE app_billing_members SET role='administrator',livemode=true WHERE user_id=$1",
      [identity.actorUserId],
    );
    expect((await inventory(input))[0].departingAdministrator).toBe(false);
    await db.query("UPDATE app_billing_members SET livemode=false WHERE user_id=$1", [
      identity.actorUserId,
    ]);
    expect((await inventory(input))[0].departingAdministrator).toBe(true);
    const developerRows = await inventory({ ...input, organizationId: org });
    expect(developerRows.find((row) => row.scopeId === scopeId)?.disposition).toBe(
      "developer_owned",
    );
    const unrelated = await inventory({ userId: randomUUID(), organizationId: personalOrg });
    expect(unrelated).toEqual([]);
    expect(
      (
        await db.query("SELECT revoked_at FROM app_billing_members WHERE user_id=$1", [
          identity.actorUserId,
        ])
      ).rows[0].revoked_at,
    ).toBeNull();
  });

  test("trial eligibility is independent of its original command actor across recreated workspaces", async () => {
    const principal = randomUUID();
    const { identity, scopeId, planId } = await buyer(principal);
    const input = {
      idempotencyKey: randomUUID(),
      expectedSubscriptionRevision: null,
      payload: {
        version: 1 as const,
        domain: "buyer" as const,
        action: "trial" as const,
        planRevisionId: planId,
        quantity: 1,
      },
    };
    await runtime.prepare(identity, input);
    expect(
      (
        await db.query(
          "SELECT t.eligibility_principal_id,c.requested_by_user_id FROM app_subscription_trials t JOIN billing_subscription_commands c ON c.id=t.command_id WHERE t.billing_scope_id=$1",
          [scopeId],
        )
      ).rows,
    ).toEqual([
      { eligibility_principal_id: principal, requested_by_user_id: identity.actorUserId },
    ]);
    const account = await authority.createAccount({
      appId: identity.appId,
      externalAccountKey: randomUUID(),
      displayName: "Recreated workspace",
      principalUserId: identity.actorUserId,
    });
    await authority.resolveScope({
      ...identity,
      billingAccountId: account.id,
      merchantId: merchant,
    });
    await expect(
      runtime.prepare(
        { ...identity, billingAccountId: account.id },
        { ...input, idempotencyKey: randomUUID() },
      ),
    ).rejects.toThrow("trial");
    expect(
      (await db.query("SELECT id FROM app_subscription_trials WHERE app_id=$1", [identity.appId]))
        .rows,
    ).toHaveLength(1);
  });

  test("Stripe deletion preserves shared purchaser billing and refuses unclosed last-administrator obligations", async () => {
    const { identity, scopeId, planId } = await buyer();
    const trial = {
      idempotencyKey: randomUUID(),
      expectedSubscriptionRevision: null,
      payload: {
        version: 1 as const,
        domain: "buyer" as const,
        action: "trial" as const,
        planRevisionId: planId,
        quantity: 1,
      },
    };
    expect((await runtime.prepare(identity, trial)).status).toBe("succeeded");
    const personalOrganization = randomUUID();
    await db.query("INSERT INTO organizations(id) VALUES($1)", [personalOrganization]);
    const { createAccountDeletionProviderAdapters } = await import(
      "./account-deletion-provider-adapters"
    );
    const context = {
      requestId: randomUUID(),
      requestDigest: "d".repeat(64),
      userId: identity.actorUserId,
      organizationId: personalOrganization,
      stewardUserId: "controlled-deletion-subject",
      lifecycleRevision: 2,
      phaseReceiptId: randomUUID(),
      phaseGeneration: 1,
      blob: {} as import("../storage/r2-runtime-binding").RuntimeR2Bucket,
    };
    await db.query(
      "INSERT INTO account_deletion_requests VALUES($1,$2,$3,$4,2,(now() AT TIME ZONE 'UTC'),'processing')",
      [context.requestId, context.userId, context.organizationId, context.requestDigest],
    );
    await db.query(
      "INSERT INTO account_deletion_phase_receipts VALUES($1,$2,'stripe',1,(now() AT TIME ZONE 'UTC')+interval '5 minutes','calling')",
      [context.phaseReceiptId, context.requestId],
    );
    await db.query(
      "UPDATE organizations SET account_lifecycle_state='deletion_irreversible',account_deletion_request_id=$1,account_lifecycle_revision=2 WHERE id=$2",
      [context.requestId, context.organizationId],
    );
    await db.query(
      "UPDATE users SET account_lifecycle_state='deletion_irreversible',account_deletion_request_id=$1,account_lifecycle_revision=2 WHERE id=$2",
      [context.requestId, context.userId],
    );
    const adapter = createAccountDeletionProviderAdapters().stripe;
    const survivor = randomUUID();
    await db.query("INSERT INTO users(id) VALUES($1)", [survivor]);
    await db.query(
      "INSERT INTO app_billing_members(app_id,billing_account_id,user_id,role,livemode) VALUES($1,$2,$3,'administrator',false)",
      [identity.appId, identity.billingAccountId, survivor],
    );
    await expect(adapter.inspect(context)).resolves.toMatchObject({ state: "complete" });
    expect((await queries.snapshot({ ...identity, actorUserId: survivor })).kind).toBe(
      "subscription",
    );
    await db.query("UPDATE account_deletion_phase_receipts SET lease_generation=2 WHERE id=$1", [
      context.phaseReceiptId,
    ]);
    await expect(adapter.inspect(context)).rejects.toThrow("current irreversible");
    expect(
      (
        await db.query(
          "SELECT disposition,phase_generation FROM app_billing_deletion_dispositions WHERE scope_id=$1",
          [scopeId],
        )
      ).rows,
    ).toEqual([{ disposition: "retain_shared", phase_generation: "1" }]);
    context.phaseGeneration = 2;
    await db.query("UPDATE users SET is_active=false WHERE id=$1", [survivor]);
    await expect(adapter.inspect(context)).resolves.toEqual({
      state: "action_required",
      errorCode: "APP_BILLING_PROVIDER_CLEANUP_REQUIRED",
    });
    await db.query("UPDATE users SET is_active=true WHERE id=$1", [survivor]);
    await expect(
      runtime.prepare(
        { ...identity, actorUserId: survivor },
        { ...trial, idempotencyKey: randomUUID() },
      ),
    ).rejects.toThrow("fenced");
    await expect(adapter.inspect(context)).resolves.toEqual({
      state: "action_required",
      errorCode: "APP_BILLING_PROVIDER_CLEANUP_REQUIRED",
    });
    await db.query("UPDATE app_billing_members SET role='member' WHERE user_id=$1", [
      identity.actorUserId,
    ]);
    await expect(adapter.inspect(context)).resolves.toEqual({
      state: "action_required",
      errorCode: "APP_BILLING_PROVIDER_CLEANUP_REQUIRED",
    });
  });

  test("erasing a purchaser identity preserves shared trial and command provenance without granting access", async () => {
    const { identity, scopeId, planId } = await buyer();
    await runtime.prepare(identity, {
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
    const survivor = randomUUID();
    await db.query("INSERT INTO users(id) VALUES($1)", [survivor]);
    await db.query(
      "INSERT INTO app_billing_members(app_id,billing_account_id,user_id,role,livemode) VALUES($1,$2,$3,'administrator',false)",
      [identity.appId, identity.billingAccountId, survivor],
    );
    const commandBefore = (
      await db.query("SELECT * FROM billing_subscription_commands WHERE billing_scope_id=$1", [
        scopeId,
      ])
    ).rows;
    const trialBefore = (
      await db.query("SELECT * FROM app_subscription_trials WHERE billing_scope_id=$1", [scopeId])
    ).rows;
    const snapshotBefore = await queries.snapshot({ ...identity, actorUserId: survivor });
    expect(snapshotBefore.kind).toBe("subscription");
    await db.query("DELETE FROM app_billing_members WHERE user_id=$1", [identity.actorUserId]);
    await db.query("DELETE FROM users WHERE id=$1", [identity.actorUserId]);
    expect(
      (
        await db.query("SELECT * FROM billing_subscription_commands WHERE billing_scope_id=$1", [
          scopeId,
        ])
      ).rows,
    ).toEqual(commandBefore);
    expect(
      (await db.query("SELECT * FROM app_subscription_trials WHERE billing_scope_id=$1", [scopeId]))
        .rows,
    ).toEqual(trialBefore);
    const { now: beforeReadAt, ...beforeState } = snapshotBefore;
    const { now: afterReadAt, ...afterState } = await queries.snapshot({
      ...identity,
      actorUserId: survivor,
    });
    expect(afterReadAt.getTime()).toBeGreaterThanOrEqual(beforeReadAt.getTime());
    expect(afterState).toEqual(beforeState);
    expect(
      (
        await db.query("SELECT live_user_id FROM billing_identity_subjects WHERE id=$1", [
          identity.actorUserId,
        ])
      ).rows,
    ).toEqual([{ live_user_id: null }]);
    await expect(queries.snapshot(identity)).rejects.toThrow("membership");
    await expect(
      authority.createAccount({
        appId: identity.appId,
        externalAccountKey: randomUUID(),
        displayName: "Erased purchaser",
        principalUserId: identity.actorUserId,
      }),
    ).rejects.toThrow("active app and verified principal");
    await expect(
      db.query("UPDATE billing_identity_subjects SET live_user_id=$2 WHERE id=$1", [
        identity.actorUserId,
        survivor,
      ]),
    ).rejects.toThrow("immutable");
    await expect(
      db.query("DELETE FROM billing_eligibility_principals WHERE id=$1", [identity.actorUserId]),
    ).rejects.toThrow("immutable");
  });

  test("portal destination is app and environment scoped and preserved on recovery", async () => {
    const { identity, scopeId, planId } = await buyer();
    await runtime.prepare(identity, {
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
    const read = await queries.snapshot(identity);
    if (read.kind !== "subscription") throw new Error("Expected trial subscription");
    const registrationId = randomUUID();
    const destination = "https://app.example/#/settings";
    await db.query(
      "INSERT INTO app_client_registrations(id,app_id,owner_organization_id,billing_environment,secret_hashes,redirect_uris,allowed_scopes,billing_return_url) VALUES($1,$2,$3,'live','[]','[]','[]',$4)",
      [registrationId, identity.appId, org, destination],
    );
    identity.clientRegistrationId = registrationId;
    const input = {
      idempotencyKey: randomUUID(),
      expectedSubscriptionRevision: read.subscription.lifecycle_revision,
    };
    await expect(runtime.portal(identity, input)).rejects.toThrow("registration is unavailable");
    await db.query("UPDATE app_client_registrations SET billing_environment='test' WHERE id=$1", [
      registrationId,
    ]);
    const other = await buyer();
    await expect(
      runtime.portal(
        { ...other.identity, clientRegistrationId: registrationId },
        { idempotencyKey: randomUUID(), expectedSubscriptionRevision: null },
      ),
    ).rejects.toThrow("registration is unavailable");
    const first = await runtime.portal(identity, input);
    expect(first.status).toBe("requires_action");
    const stored = await commands.read({
      scopeId,
      commandId: first.id,
      actorUserId: identity.actorUserId,
    });
    expect(stored.command.request_payload).toMatchObject({ returnUrl: destination });
    const dispatched = fixture.requests.filter(
      (row) =>
        row.method === "POST" &&
        row.path === "/v1/billing_portal/sessions" &&
        row.body.get("return_url") === destination,
    );
    expect(dispatched).toHaveLength(1);
    await db.query(
      "UPDATE app_client_registrations SET billing_return_url='https://app.example/changed' WHERE id=$1",
      [registrationId],
    );
    expect((await runtime.portal(identity, input)).id).toBe(first.id);
    expect(
      (await commands.read({ scopeId, commandId: first.id, actorUserId: identity.actorUserId }))
        .command.request_payload,
    ).toEqual(stored.command.request_payload);
  });

  test("registered billing return fragments are frozen across exact retries", async () => {
    const { identity, scopeId, planId } = await buyer();
    const destination = "https://app.example/?view=billing#/settings";
    const { appDelegationsRepository: registrations } = await import(
      "../../db/repositories/app-delegations"
    );
    const registrationInput = {
      billingEnvironment: "test" as const,
      redirectUris: ["https://app.example/callback"],
      allowedScopes: ["identity" as const],
      billingReturnUrl: destination,
    };
    for (const invalid of [
      "http://app.example/settings",
      "https://app.example.attacker.test/settings",
      "https://user:password@app.example/settings",
      "javascript:alert(1)",
    ]) {
      await expect(
        registrations.register(identity.appId, org, {
          ...registrationInput,
          billingReturnUrl: invalid,
        }),
      ).rejects.toThrow();
    }
    const registration = await registrations.register(identity.appId, org, registrationInput);
    const registrationId = registration.clientId;
    expect((await registrations.list(identity.appId, org))[0].billingReturnUrl).toBe(destination);
    identity.clientRegistrationId = registrationId;
    const input = {
      idempotencyKey: randomUUID(),
      expectedSubscriptionRevision: null,
      planRevisionId: planId,
      quantity: 1,
      billingConsent: "accepted" as const,
    };
    fixture.loseCheckoutResponse();
    const first = await runtime.checkout(identity, input);
    expect(first.status).toBe("outcome_unknown");
    const stored = await commands.read({
      scopeId,
      commandId: first.id,
      actorUserId: identity.actorUserId,
    });
    expect(stored.command.request_payload).toMatchObject({
      successUrl: destination,
      cancelUrl: destination,
    });
    const dispatched = fixture.requests.filter(
      (row) =>
        row.method === "POST" &&
        row.path === "/v1/checkout/sessions" &&
        row.body.get("metadata[eliza_app_id]") === identity.appId,
    );
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0].body.get("success_url")).toBe(destination);
    expect(dispatched[0].body.get("cancel_url")).toBe(destination);
    await db.query(
      "UPDATE app_client_registrations SET billing_return_url='https://app.example/changed#/billing' WHERE id=$1",
      [registrationId],
    );
    expect((await runtime.checkout(identity, input)).id).toBe(first.id);
    const recovered = await commands.read({
      scopeId,
      commandId: first.id,
      actorUserId: identity.actorUserId,
    });
    expect(recovered.command.request_payload).toEqual(stored.command.request_payload);
    expect(
      fixture.requests.filter(
        (row) =>
          row.method === "POST" &&
          row.path === "/v1/checkout/sessions" &&
          row.body.get("metadata[eliza_app_id]") === identity.appId,
      ),
    ).toHaveLength(1);
    await expect(runtime.checkout(identity, { ...input, quantity: 2 })).rejects.toThrow(
      "immutable intent",
    );
  });

  test("free identity and zero Cloud balance get one total trial grant, including after a lost response", async () => {
    const { identity, planId, scopeId } = await buyer();
    fixture.loseSubscriptionResponse();
    const intent = {
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
    const first = await runtime.prepare(identity, intent);
    expect(first.status).toBe("outcome_unknown");
    await db.query(
      "UPDATE billing_subscription_commands SET provider_started_at=clock_timestamp()-interval '25 hours' WHERE id=$1",
      [first.id],
    );
    const prepared = await commands.read({
      scopeId,
      commandId: first.id,
      actorUserId: identity.actorUserId,
    });
    const originalStartedAt = prepared.command.provider_started_at;
    const recovered = await runtime.reconcileCommand({ scopeId, commandId: first.id });
    expect(recovered.status).toBe("succeeded");
    const read = await queries.snapshot(identity);
    expect(read.kind).toBe("subscription");
    if (read.kind !== "subscription") throw new Error("Recovered trial has no subscription");
    expect(read.subscription.status).toBe("trialing");
    expect(read.subscription.quantity).toBe(3);
    const grant = await db.query(
      "SELECT granted_amount,trial_claim_id FROM subscription_allowance_periods WHERE billing_scope_id=$1",
      [scopeId],
    );
    expect(grant.rows).toHaveLength(1);
    expect(grant.rows[0].granted_amount).toBe("5.000000");
    expect(grant.rows[0].trial_claim_id).toBe(read.trial?.id);
    expect(read.trial!.ends_at.getTime() - read.trial!.starts_at.getTime()).toBe(604800000);
    const finished = await commands.read({
      scopeId,
      commandId: first.id,
      actorUserId: identity.actorUserId,
    });
    expect(finished.command.provider_started_at).toEqual(originalStartedAt);
    const dispatched = fixture.requests.filter(
      (row) =>
        row.method === "POST" &&
        row.path === "/v1/subscriptions" &&
        row.body.get("metadata[eliza_app_id]") === identity.appId,
    );
    expect(dispatched).toHaveLength(1);
    await db.query("UPDATE app_billing_plan_revisions SET retired_at=now() WHERE id=$1", [planId]);
    expect((await runtime.prepare(identity, intent)).status).toBe("succeeded");
    const { genericBillingReadService } = await import("./generic-billing-read");
    expect((await genericBillingReadService.catalog(identity.appId, false)).plans).toHaveLength(0);
    const historical = await genericBillingReadService.snapshot(identity);
    expect(historical.subscription?.planKey).toBe("basic");
    expect(historical.subscription?.planRevisionId).toBe(planId);
    expect(historical.entitlement.access).toBe("granted");
    const unchanged = await db.query("SELECT credit_balance FROM organizations WHERE id=$1", [org]);
    expect(Number(unchanged.rows[0].credit_balance)).toBe(0);
  });

  test("expired original checkout releases the pending purchase without renewing its trial", async () => {
    const { identity, planId, scopeId } = await buyer();
    const purchase = () =>
      runtime.checkout(identity, {
        idempotencyKey: randomUUID(),
        expectedSubscriptionRevision: null,
        planRevisionId: planId,
        quantity: 2,
        billingConsent: "accepted",
      });
    const first = await purchase();
    expect(first.status).toBe("requires_action");
    const initial = await queries.snapshot(identity);
    expect(initial.trial).not.toBeNull();
    const original = await commands.read({
      scopeId,
      commandId: first.id,
      actorUserId: identity.actorUserId,
    });
    const session = original.command.provider_result;
    if (session?.kind !== "checkout") throw new Error("Checkout handle was not persisted");
    const expired = await runtime.prepare(identity, {
      idempotencyKey: randomUUID(),
      expectedSubscriptionRevision: null,
      payload: {
        version: 1,
        domain: "buyer",
        action: "expire_checkout",
        checkoutCommandId: first.id,
      },
    });
    expect(expired.status).toBe("succeeded");
    expect(
      (await commands.read({ scopeId, commandId: first.id, actorUserId: identity.actorUserId }))
        .command.status,
    ).toBe("FAILED");
    const second = await purchase();
    expect(second.status).toBe("requires_action");
    const repeated = await queries.snapshot(identity);
    expect(repeated.trial?.id).toBe(initial.trial?.id);
    expect(repeated.trial?.ends_at).toEqual(initial.trial?.ends_at);
    const dispatches = fixture.requests.filter(
      (row) =>
        row.method === "POST" &&
        row.path === "/v1/checkout/sessions" &&
        row.body.get("metadata[eliza_app_id]") === identity.appId,
    );
    expect(dispatches).toHaveLength(2);
    expect(dispatches[0]!.body.has("subscription_data[trial_end]")).toBe(true);
    expect(dispatches[1]!.body.has("subscription_data[trial_end]")).toBe(false);
    expect(fixture.checkouts.get(session.checkoutSessionId)?.expired).toBe(true);
  });

  test("concurrent command leases exclude duplicate dispatch and fence stale progress", async () => {
    const { identity, planId, scopeId } = await buyer();
    const command = await authority.prepareCommand({
      scopeId,
      actorUserId: identity.actorUserId,
      kind: "checkout",
      targetPlanRevisionId: planId,
      quantity: 1,
      idempotencyKey: randomUUID(),
      expectedSubscriptionRevision: null,
      requestDigest: "a".repeat(64),
      payload: {
        version: 1,
        domain: "buyer",
        action: "trial",
        planRevisionId: planId,
        quantity: 1,
      },
    });
    const input = { scopeId, commandId: command.id, actorUserId: identity.actorUserId };
    const claims = await Promise.all([commands.claim(input), commands.claim(input)]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    const first = claims.find((claim) => claim !== null)!;
    await db.query(
      "UPDATE billing_subscription_commands SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",
      [command.id],
    );
    const next = await commands.claim(input);
    expect(next).not.toBeNull();
    expect(next!.firstDispatch).toBe(false);
    expect(next!.command.provider_started_at).toEqual(first.command.provider_started_at);
    await expect(
      commands.recordProgress(first.lease, {
        kind: "completed",
        subscriptionId: "sub_stale",
        subscriptionRevision: null,
      }),
    ).rejects.toThrow("current execution lease");
    await commands.releaseLease(next!.lease);
  });

  test("unknown provider creation outside retention never creates a replacement subscription", async () => {
    const { identity, planId, scopeId } = await buyer();
    fixture.loseSubscriptionResponse();
    const first = await runtime.prepare(identity, {
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
    expect(first.status).toBe("outcome_unknown");
    for (const [id, row] of fixture.subscriptions)
      if (row.metadata.eliza_app_id === identity.appId) fixture.subscriptions.delete(id);
    await db.query(
      "UPDATE billing_subscription_commands SET provider_started_at=clock_timestamp()-interval '25 hours' WHERE id=$1",
      [first.id],
    );
    expect((await runtime.reconcileCommand({ scopeId, commandId: first.id })).status).toBe(
      "outcome_unknown",
    );
    const dispatches = fixture.requests.filter(
      (row) =>
        row.method === "POST" &&
        row.path === "/v1/subscriptions" &&
        row.body.get("metadata[eliza_app_id]") === identity.appId,
    );
    expect(dispatches).toHaveLength(1);
    expect((await queries.snapshot(identity)).kind).toBe("empty");
  });

  test("backend membership in test mode grants neither live access nor purchaser authority", async () => {
    const { identity, planId } = await buyer();
    const memberId = randomUUID();
    await db.query("INSERT INTO users(id) VALUES($1)", [memberId]);
    await db.query(
      "INSERT INTO app_billing_members(app_id,billing_account_id,user_id,role,livemode) VALUES($1,$2,$3,'member',false)",
      [identity.appId, identity.billingAccountId, memberId],
    );
    const member = { ...identity, actorUserId: memberId };
    expect((await queries.snapshot(member)).kind).toBe("empty");
    await expect(queries.snapshot({ ...member, livemode: true })).rejects.toThrow(
      "Current app billing account membership",
    );
    await expect(
      runtime.prepare(member, {
        idempotencyKey: randomUUID(),
        expectedSubscriptionRevision: null,
        payload: {
          version: 1,
          domain: "buyer",
          action: "trial",
          planRevisionId: planId,
          quantity: 1,
        },
      }),
    ).rejects.toThrow("administrator authority");
    await db.query(
      "UPDATE app_billing_members SET revoked_at=now() WHERE billing_account_id=$1 AND user_id=$2",
      [identity.billingAccountId, memberId],
    );
    await expect(queries.snapshot(member)).rejects.toThrow(
      "Current app billing account membership",
    );
  });

  test("a canceled subscriber can buy again and only its app merchant can resolve the paid refund source", async () => {
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
    expect(source.invoice.invoiceId).toBe(receipt.rows[0].stripe_invoice_id);
    expect(source.invoice.customerId).toBe(renewed.subscription.stripe_customer_id);
    expect(source.invoice.subscriptionId).toBe(providerId);
    expect(source.invoice.plan.planRevisionId).toBe(planId);
    expect(source.scope.scopeId).toBe(scopeId);
    expect(source.merchant.stripeAccountId).toBe("acct_runtime");
    await db.query("UPDATE app_billing_plan_revisions SET retired_at=now() WHERE id=$1", [planId]);
    await db.query("UPDATE billing_merchants SET enabled=false,disconnected_at=now() WHERE id=$1", [
      merchant,
    ]);
    expect((await resolveRefund()).invoice).toEqual(source.invoice);
    await expect(
      writeTransaction((tx) =>
        lockAppBillingRefundSource(tx, { ...owner, userId: identity.actorUserId }, selection),
      ),
    ).rejects.toMatchObject({ code: "APP_BILLING_ADMIN_FORBIDDEN" });
    await expect(
      writeTransaction((tx) =>
        lockAppBillingRefundSource(tx, owner, { ...selection, paidPeriodId: randomUUID() }),
      ),
    ).rejects.toMatchObject({ code: "APP_BILLING_ADMIN_FORBIDDEN" });
    const otherApplicationId = randomUUID();
    await db.query("INSERT INTO apps(id,organization_id) VALUES($1,$2)", [otherApplicationId, org]);
    const otherRegistrationId = randomUUID();
    const liveRegistrationId = randomUUID();
    await db.query(
      "INSERT INTO app_client_registrations(id,app_id,owner_organization_id,billing_environment,secret_hashes,redirect_uris,allowed_scopes) VALUES($1,$2,$3,'test','[]','[]','[]'),($4,$5,$3,'live','[]','[]','[]')",
      [otherRegistrationId, otherApplicationId, org, liveRegistrationId, identity.appId],
    );
    await expect(
      writeTransaction((tx) =>
        lockAppBillingRefundSource(
          tx,
          { ...owner, appId: otherApplicationId },
          { ...selection, clientRegistrationId: otherRegistrationId },
        ),
      ),
    ).rejects.toMatchObject({ code: "APP_BILLING_ADMIN_FORBIDDEN" });
    await expect(
      writeTransaction((tx) =>
        lockAppBillingRefundSource(tx, owner, {
          ...selection,
          clientRegistrationId: liveRegistrationId,
        }),
      ),
    ).rejects.toMatchObject({ code: "APP_BILLING_ADMIN_FORBIDDEN" });
    const { GenericBillingAdminService } = await import("./generic-billing-admin");
    const admin = new GenericBillingAdminService(async (mode) => {
      if (mode) throw new Error("Unexpected live mode");
      return fixture.stripe;
    });
    const listed = await admin.paidPeriods(owner, { clientRegistrationId: registrationId });
    expect(listed.items.map((item) => item.id)).toEqual([selection.paidPeriodId]);
    expect(listed.items[0].accountName).toBe("Independent workspace");
    expect(
      (
        await admin.paidPeriods(owner, {
          clientRegistrationId: registrationId,
          cursor: selection.paidPeriodId,
        })
      ).items,
    ).toEqual([]);
    await expect(
      admin.paidPeriods(
        { ...owner, appId: otherApplicationId },
        { clientRegistrationId: otherRegistrationId, cursor: selection.paidPeriodId },
      ),
    ).rejects.toMatchObject({ code: "APP_BILLING_ADMIN_FORBIDDEN" });
    const preview = await admin.previewRefund(owner, selection);
    expect(preview.amountPaidCents).toBe(9000);
    expect(preview.amountAvailableCents).toBe(9000);
    const revokedPreview = new GenericBillingAdminService(async () => {
      await db.query("UPDATE users SET role='member' WHERE id=$1", [administratorId]);
      return fixture.stripe;
    });
    await expect(revokedPreview.previewRefund(owner, selection)).rejects.toMatchObject({
      code: "APP_BILLING_ADMIN_FORBIDDEN",
    });
    await db.query("UPDATE users SET role='owner' WHERE id=$1", [administratorId]);
    expect(
      fixture.requests.some((row) => row.method === "POST" && row.path === "/v1/refunds"),
    ).toBe(false);
    const refundInput = {
      ...selection,
      idempotencyKey: randomUUID(),
      amountCents: 500,
      accessPolicy: "preserve" as const,
      confirmation: "refund_original_payment_preserve_access" as const,
    };
    const beforeRefund = await queries.snapshot(identity);
    if (beforeRefund.kind !== "subscription")
      throw new Error("Expected paid subscription before refund");
    fixture.loseRefundResponse();
    await expect(admin.refund(owner, refundInput)).rejects.toThrow("Refund response lost");
    expect((await admin.refund(owner, refundInput)).status).toBe("outcome_unknown");
    await expect(admin.refund(owner, { ...refundInput, amountCents: 600 })).rejects.toMatchObject({
      code: "APP_BILLING_ADMIN_CONFLICT",
    });
    const durable = await db.query(
      "SELECT id,status,request_payload FROM billing_subscription_commands WHERE app_id=$1 AND idempotency_key=$2",
      [owner.appId, refundInput.idempotencyKey],
    );
    expect(durable.rows[0].status).toBe("OUTCOME_UNKNOWN");
    expect(durable.rows[0].request_payload.source.invoice.invoiceId).toBe(source.invoice.invoiceId);
    await db.query(
      "UPDATE billing_subscription_commands SET lease_expires_at=clock_timestamp()-interval '1 second',provider_started_at=clock_timestamp()-interval '25 hours' WHERE id=$1",
      [durable.rows[0].id],
    );
    const successorId = randomUUID();
    await db.query("INSERT INTO users(id,organization_id,role) VALUES($1,$2,'admin')", [
      successorId,
      org,
    ]);
    const recoveredRefund = await admin.recoverOperation(
      { ...owner, userId: successorId },
      durable.rows[0].id,
    );
    expect(
      (
        await db.query(
          "SELECT requested_by_user_id FROM billing_subscription_commands WHERE id=$1",
          [durable.rows[0].id],
        )
      ).rows[0].requested_by_user_id,
    ).toBe(administratorId);
    expect(recoveredRefund.status).toBe("refund");
    if (recoveredRefund.status !== "refund") throw new Error("Expected recovered refund receipt");
    expect(recoveredRefund.receipt.providerStatus).toBe("pending");
    expect(recoveredRefund.receipt.accessPolicy).toBe("preserve");
    expect((await admin.previewRefund(owner, selection)).amountAvailableCents).toBe(8500);
    fixture.setRefundStatus(recoveredRefund.receipt.refundId, "failed");
    const failedRefund = await admin.recoverOperation(owner, durable.rows[0].id);
    expect(failedRefund.status === "refund" && failedRefund.receipt.providerStatus).toBe("failed");
    expect(
      fixture.requests.filter((row) => row.method === "POST" && row.path === "/v1/refunds"),
    ).toHaveLength(1);
    const historyPage = await admin.paidPeriods(
      { ...owner, userId: successorId },
      { clientRegistrationId: registrationId },
    );
    expect(
      historyPage.items.find((item) => item.id === selection.paidPeriodId)?.refundOperations,
    ).toEqual([
      {
        id: durable.rows[0].id,
        amountCents: 500,
        state: "receipt_available",
        createdAt: expect.any(String),
      },
    ]);
    await db.query("UPDATE users SET role='member' WHERE id=$1", [successorId]);
    await expect(
      admin.recoverOperation({ ...owner, userId: successorId }, durable.rows[0].id),
    ).rejects.toMatchObject({ code: "APP_BILLING_ADMIN_FORBIDDEN" });
    const afterRefund = await queries.snapshot(identity);
    if (afterRefund.kind !== "subscription")
      throw new Error("Expected paid subscription after refund");
    expect(afterRefund.projection).toEqual(beforeRefund.projection);
    expect(afterRefund.allowances).toEqual(beforeRefund.allowances);
    expect(afterRefund.subscription).toEqual(beforeRefund.subscription);
    expect(afterRefund.trial).toEqual(beforeRefund.trial);
    expect(
      (await db.query("SELECT credit_balance FROM organizations WHERE id=$1", [org])).rows[0]
        .credit_balance,
    ).toBe("0");
    const { appBillingAdminRepository } = await import("../../db/repositories/app-billing-admin");
    const missing = await appBillingAdminRepository.prepare(owner, {
      clientRegistrationId: registrationId,
      idempotencyKey: randomUUID(),
      merchantId: merchant,
      requestDigest: "d".repeat(64),
      payload: () => ({
        version: 1,
        domain: "admin",
        clientRegistrationId: registrationId,
        action: "refund",
        source,
        amountCents: 300,
        accessPolicy: "preserve",
      }),
    });
    await appBillingAdminRepository.claim(owner, missing.id);
    await db.query(
      "UPDATE billing_subscription_commands SET lease_expires_at=clock_timestamp()-interval '1 second',provider_started_at=clock_timestamp()-interval '25 hours' WHERE id=$1",
      [missing.id],
    );
    expect((await admin.recoverOperation(owner, missing.id)).status).toBe("outcome_unknown");
    expect(
      fixture.requests.filter((row) => row.method === "POST" && row.path === "/v1/refunds"),
    ).toHaveLength(1);
    const history = await db.query(
      "INSERT INTO app_subscription_paid_periods(billing_scope_id,subscription_id,plan_revision_id,merchant_key,livemode,stripe_invoice_id,stripe_price_id,quantity,period_start,period_end,provider_digest,created_at) SELECT billing_scope_id,subscription_id,plan_revision_id,merchant_key,livemode,'in_history'||g::text,stripe_price_id,quantity,period_start,period_end,provider_digest,created_at FROM app_subscription_paid_periods CROSS JOIN generate_series(1,50) g WHERE id=$1 RETURNING id",
      [selection.paidPeriodId],
    );
    const firstPage = await admin.paidPeriods(owner, { clientRegistrationId: registrationId });
    expect(firstPage.nextCursor).not.toBeNull();
    const secondPage = await admin.paidPeriods(owner, {
      clientRegistrationId: registrationId,
      cursor: firstPage.nextCursor,
    });
    expect(secondPage.nextCursor).toBeNull();
    expect([...firstPage.items, ...secondPage.items].map((item) => item.id).sort()).toEqual(
      [selection.paidPeriodId, ...history.rows.map((row) => row.id)].sort(),
    );
    await db.query("UPDATE app_client_registrations SET is_active=false WHERE id=$1", [
      registrationId,
    ]);
    await expect(resolveRefund()).rejects.toMatchObject({ code: "APP_BILLING_ADMIN_FORBIDDEN" });
    await db.query("UPDATE billing_merchants SET enabled=true,disconnected_at=NULL WHERE id=$1", [
      merchant,
    ]);
  });

  test("a cancellation command recovers after a webhook commits the provider change first", async () => {
    const { identity, planId, scopeId } = await buyer();
    await runtime.prepare(identity, {
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
    const initial = await queries.snapshot(identity);
    if (initial.kind !== "subscription") throw new Error("Expected original subscription");
    const command = await authority.prepareCommand({
      scopeId,
      actorUserId: identity.actorUserId,
      kind: "cancel",
      targetPlanRevisionId: null,
      quantity: 1,
      idempotencyKey: randomUUID(),
      requestDigest: "c".repeat(64),
      expectedSubscriptionRevision: initial.subscription.lifecycle_revision,
      payload: { version: 1, domain: "buyer", action: "cancel", timing: "period_end" },
    });
    const claimed = await commands.claim({
      scopeId,
      commandId: command.id,
      actorUserId: identity.actorUserId,
    });
    if (!claimed || !claimed.plan) throw new Error("Expected original command lease and plan");
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
      {
        merchantId: merchant,
        kind: "connected",
        stripeAccountId: "acct_runtime",
        livemode: false,
      },
      appBillingProviderBindings,
    );
    const observation = await provider.cancelSubscription(
      claimed.scope,
      {
        subscriptionId: initial.subscription.stripe_subscription_id,
        customerId: initial.subscription.stripe_customer_id,
        plan: appBillingProviderPlan(claimed.plan),
        atPeriodEnd: true,
      },
      {
        commandId: command.id,
        idempotencyKey: `${command.provider_idempotency_key}:cancel`,
        requestDigest: command.request_digest,
      },
    );
    await appSubscriptionFinalizer.applyObservation({
      scopeId,
      planRevisionId: planId,
      expectedSubscriptionRevision: initial.subscription.lifecycle_revision,
      subscription: observation,
      invoice: null,
      command: null,
      event: null,
    });
    await commands.releaseLease(claimed.lease);
    expect((await runtime.reconcileCommand({ scopeId, commandId: command.id })).status).toBe(
      "succeeded",
    );
    const current = await queries.snapshot(identity);
    if (current.kind !== "subscription") throw new Error("Expected retained subscription");
    expect(current.subscription.id).toBe(initial.subscription.id);
    expect(current.subscription.cancel_at_period_end).toBe(true);
    expect(
      (
        await db.query(
          "SELECT count(*)::int AS count FROM subscription_allowance_periods WHERE subscription_id=$1",
          [current.subscription.id],
        )
      ).rows,
    ).toEqual([{ count: 1 }]);
  });
  for (const purchaserState of ["active", "deleting"] as const) {
    for (const outcome of ["paid", "void"] as const) {
      test(`${purchaserState} purchaser pending update ${outcome} recovers the original payment without repeating a purchase`, async () => {
        const { identity, planId, scopeId } = await buyer();
        await runtime.prepare(identity, {
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
        const trial = await queries.snapshot(identity);
        if (trial.kind !== "subscription") throw new Error("Missing trial");
        await runtime.prepare(identity, {
          idempotencyKey: randomUUID(),
          expectedSubscriptionRevision: trial.mutationRevision,
          payload: { version: 1, domain: "buyer", action: "cancel", timing: "immediate" },
        });
        const checkout = await runtime.checkout(identity, {
          idempotencyKey: randomUUID(),
          expectedSubscriptionRevision: null,
          planRevisionId: planId,
          quantity: 1,
          billingConsent: "accepted",
        });
        const purchase = await commands.read({
          scopeId,
          commandId: checkout.id,
          actorUserId: identity.actorUserId,
        });
        if (purchase.command.provider_result?.kind !== "checkout")
          throw new Error("Missing checkout");
        const subscriptionId = fixture.completeCheckout(
          purchase.command.provider_result.checkoutSessionId,
        );
        expect((await runtime.reconcileCommand({ scopeId, commandId: checkout.id })).status).toBe(
          "succeeded",
        );
        const paid = await queries.snapshot(identity);
        if (paid.kind !== "subscription") throw new Error("Missing paid subscription");
        const quote = await runtime.quote(identity, {
          planRevisionId: planId,
          quantity: 2,
          expectedSubscriptionRevision: paid.mutationRevision,
        });
        const request = {
          idempotencyKey: randomUUID(),
          expectedSubscriptionRevision: paid.mutationRevision,
          payload: {
            version: 1 as const,
            domain: "buyer" as const,
            action: "update" as const,
            planRevisionId: planId,
            quantity: 2,
            quoteId: quote.id,
            billingConsent: "accepted" as const,
          },
        };
        for (const rejected of [
          { ...request, idempotencyKey: randomUUID(), expectedSubscriptionRevision: 0 },
          {
            ...request,
            idempotencyKey: randomUUID(),
            payload: { ...request.payload, quantity: 3 },
          },
        ]) {
          await expect(runtime.prepare(identity, rejected)).rejects.toMatchObject({
            code: "APP_BILLING_COMMAND_NOT_APPLIED",
          });
          expect(
            (
              await db.query(
                "SELECT count(*)::int AS total FROM billing_subscription_commands WHERE billing_scope_id=$1 AND idempotency_key=$2",
                [scopeId, rejected.idempotencyKey],
              )
            ).rows[0].total,
          ).toBe(0);
        }
        if (outcome === "paid") fixture.loseUpdateResponse();
        const first = await runtime.prepare(identity, request);
        if (outcome === "paid") expect(first.status).toBe("outcome_unknown");
        else expect(first.status).toBe("requires_action");
        const pending = await runtime.reconcileCommand({ scopeId, commandId: first.id });
        expect(pending.status).toBe("requires_action");
        if (pending.status !== "requires_action") throw new Error("Missing payment action");
        expect(pending.action.kind).toBe("payment");
        await expect(
          runtime.prepare(identity, { ...request, payload: { ...request.payload, quantity: 3 } }),
        ).rejects.toMatchObject({ code: "APP_BILLING_AUTHORITY_CONFLICT" });
        expect(await runtime.prepare(identity, request)).toEqual(pending);
        const before = await queries.snapshot(identity);
        if (before.kind !== "subscription") throw new Error("Lost original subscription");
        expect(before.subscription.quantity).toBe(1);
        expect(before.pendingCommand?.id).toBe(first.id);
        const deletionAuthority = {
          kind: "account_deletion" as const,
          requestId: randomUUID(),
          requestDigest: "e".repeat(64),
          lifecycleRevision: 2,
          phaseReceiptId: randomUUID(),
          phaseGeneration: 1,
        };
        const deletionOrganizationId = randomUUID();
        const deletionContext = {
          ...deletionAuthority,
          userId: identity.actorUserId,
          organizationId: deletionOrganizationId,
          stewardUserId: "steward-shared-purchaser",
          blob: {},
        } as AccountDeletionProviderContext;
        const { createAccountDeletionProviderAdapters } = await import(
          "./account-deletion-provider-adapters"
        );
        const deletionAdapter = createAccountDeletionProviderAdapters({
          appBillingRuntime: runtime,
        }).stripe;
        const originalHistory = (
          await db.query(
            "SELECT requested_by_user_id,request_payload,request_digest,provider_idempotency_key FROM billing_subscription_commands WHERE id=$1",
            [first.id],
          )
        ).rows;
        const originalTrial = (
          await db.query("SELECT * FROM app_subscription_trials WHERE billing_scope_id=$1", [
            scopeId,
          ])
        ).rows;
        if (purchaserState === "deleting") {
          const successor = randomUUID();
          await db.query("INSERT INTO users(id) VALUES($1)", [successor]);
          await db.query(
            "INSERT INTO app_billing_members(billing_account_id,app_id,user_id,role,livemode) VALUES($1,$2,$3,'administrator',false)",
            [identity.billingAccountId, identity.appId, successor],
          );
          await db.query("INSERT INTO organizations(id) VALUES($1)", [deletionOrganizationId]);
          await db.query(
            "UPDATE users SET is_active=false,auth_fenced_at=now(),account_lifecycle_state='deletion_irreversible' WHERE id=$1",
            [identity.actorUserId],
          );
          await db.query(
            "INSERT INTO account_deletion_requests VALUES($1,$2,$3,$4,2,now(),'processing')",
            [
              deletionAuthority.requestId,
              identity.actorUserId,
              deletionOrganizationId,
              deletionAuthority.requestDigest,
            ],
          );
          await db.query(
            "UPDATE organizations SET account_lifecycle_state='deletion_irreversible',account_deletion_request_id=$1,account_lifecycle_revision=2 WHERE id=$2",
            [deletionAuthority.requestId, deletionOrganizationId],
          );
          await db.query(
            "UPDATE users SET account_deletion_request_id=$1,account_lifecycle_revision=2 WHERE id=$2",
            [deletionAuthority.requestId, identity.actorUserId],
          );
          await db.query(
            "INSERT INTO account_deletion_phase_receipts VALUES($1,$2,'stripe',1,(now()+interval '5 minutes') AT TIME ZONE 'UTC','calling')",
            [deletionAuthority.phaseReceiptId, deletionAuthority.requestId],
          );
          await expect(runtime.reconcileCommand({ scopeId, commandId: first.id })).rejects.toThrow(
            "administrator authority",
          );
          const leaseClaim = await commands.claim({
            scopeId,
            commandId: first.id,
            deletionAuthority,
          });
          if (!leaseClaim) throw new Error("Expected deletion update lease");
          const { appBillingUpdateQuotesRepository } = await import(
            "../../db/repositories/app-billing-update-quotes"
          );
          const recoveryLease = { ...leaseClaim.lease, deletionAuthority };
          const recoveredQuote =
            await appBillingUpdateQuotesRepository.getForCommand(recoveryLease);
          expect(recoveredQuote.actor_user_id).toBe(identity.actorUserId);
          expect(recoveredQuote.consumed_by_command_id).toBe(first.id);
          await db.query(
            "UPDATE account_deletion_phase_receipts SET lease_generation=2 WHERE id=$1",
            [deletionAuthority.phaseReceiptId],
          );
          await expect(
            appBillingUpdateQuotesRepository.getForCommand(recoveryLease),
          ).rejects.toThrow("current irreversible deletion phase");
          deletionAuthority.phaseGeneration = 2;
          await commands.releaseLease(leaseClaim.lease);
          deletionContext.phaseGeneration = deletionAuthority.phaseGeneration;
          const writesBeforeInspection = fixture.requests.filter(
            (row) => row.method === "POST",
          ).length;
          await expect(deletionAdapter.inspect(deletionContext)).resolves.toEqual({
            state: "action_required",
            errorCode: "APP_BILLING_COMMAND_RECOVERY_REQUIRED",
          });
          expect(fixture.requests.filter((row) => row.method === "POST")).toHaveLength(
            writesBeforeInspection,
          );
        }
        fixture.settleUpdate(subscriptionId, outcome);
        if (purchaserState === "deleting") {
          const { GenericBillingRuntime } = await import("./generic-billing-runtime");
          const { createGenericBillingProvider } = await import("./generic-billing-provider");
          const { appBillingProviderBindings } = await import(
            "../../db/repositories/app-billing-provider-bindings"
          );
          let inspections = 0;
          const staleRuntime = new GenericBillingRuntime(async (merchantId, livemode) => {
            const provider = createGenericBillingProvider(
              fixture.stripe,
              { merchantId, kind: "connected", stripeAccountId: "acct_runtime", livemode },
              appBillingProviderBindings,
            );
            return {
              ...provider,
              async inspectUpdatePayment(scope, input) {
                const observation = await provider.inspectUpdatePayment(scope, input);
                inspections++;
                if (inspections === (outcome === "void" ? 2 : 1))
                  await db.query(
                    "UPDATE account_deletion_phase_receipts SET lease_generation=3 WHERE id=$1",
                    [deletionAuthority.phaseReceiptId],
                  );
                return observation;
              },
            };
          });
          await expect(
            staleRuntime.run({ scopeId, commandId: first.id, deletionAuthority }),
          ).rejects.toThrow("current irreversible deletion phase");
          expect(
            (
              await db.query("SELECT status FROM billing_subscription_commands WHERE id=$1", [
                first.id,
              ])
            ).rows[0].status,
          ).toBe("SUCCEEDED");
          expect(
            (
              await db.query("SELECT quantity FROM billing_subscriptions WHERE id=$1", [
                paid.subscription.id,
              ])
            ).rows[0].quantity,
          ).toBe(1);
          deletionAuthority.phaseGeneration = 3;
          deletionContext.phaseGeneration = 3;
          const writesBeforeRecovery = fixture.requests.filter(
            (row) => row.method === "POST",
          ).length;
          await expect(deletionAdapter.inspect(deletionContext)).resolves.toMatchObject({
            state: "complete",
          });
          expect(
            (
              await db.query("SELECT status FROM billing_subscription_commands WHERE id=$1", [
                first.id,
              ])
            ).rows[0].status,
          ).toBe(outcome === "paid" ? "APPLIED" : "FAILED");
          expect(fixture.requests.filter((row) => row.method === "POST")).toHaveLength(
            writesBeforeRecovery,
          );
          await expect(deletionAdapter.inspect(deletionContext)).resolves.toMatchObject({
            state: "complete",
          });
        }
        const settled =
          purchaserState === "deleting"
            ? await runtime.run({ scopeId, commandId: first.id, deletionAuthority })
            : await runtime.reconcileCommand({ scopeId, commandId: first.id });
        expect(settled.status).toBe(outcome === "paid" ? "succeeded" : "failed");
        if (outcome === "void" && settled.status === "failed")
          expect(settled.error.code).toBe("APP_BILLING_PAYMENT_EXPIRED");
        if (purchaserState === "deleting") {
          expect(
            (
              await db.query(
                "SELECT requested_by_user_id,request_payload,request_digest,provider_idempotency_key FROM billing_subscription_commands WHERE id=$1",
                [first.id],
              )
            ).rows,
          ).toEqual(originalHistory);
          expect(
            (
              await db.query("SELECT * FROM app_subscription_trials WHERE billing_scope_id=$1", [
                scopeId,
              ])
            ).rows,
          ).toEqual(originalTrial);
          await db.query(
            "UPDATE users SET is_active=true,auth_fenced_at=NULL,account_lifecycle_state='active' WHERE id=$1",
            [identity.actorUserId],
          );
        }
        expect(await runtime.prepare(identity, request)).toEqual(settled);
        const current = await queries.snapshot(identity);
        if (current.kind !== "subscription") throw new Error("Lost paid subscription");
        expect(current.subscription.quantity).toBe(outcome === "paid" ? 2 : 1);
        expect(current.pendingCommand).toBeNull();
        expect(
          fixture.requests.filter(
            (row) => row.method === "POST" && row.path === `/v1/subscriptions/${subscriptionId}`,
          ),
        ).toHaveLength(1);
        const grants = await db.query(
          "SELECT granted_amount FROM subscription_allowance_periods WHERE subscription_id=$1 AND grant_source='paid_invoice'",
          [current.subscription.id],
        );
        expect(grants.rows).toEqual([{ granted_amount: "25.000000" }]);
      });
    }
  }

  for (const state of ["prepared", "open_checkout"] as const) {
    test(`shared purchaser deletion handles ${state} intent without dispatching new work`, async () => {
      const { identity, scopeId, planId } = await buyer();
      const command =
        state === "prepared"
          ? await authority.prepareCommand({
              scopeId,
              actorUserId: identity.actorUserId,
              kind: "checkout",
              targetPlanRevisionId: planId,
              quantity: 1,
              idempotencyKey: randomUUID(),
              requestDigest: "f".repeat(64),
              expectedSubscriptionRevision: null,
              payload: {
                version: 1,
                domain: "buyer",
                action: "trial",
                planRevisionId: planId,
                quantity: 1,
              },
            })
          : await runtime.checkout(identity, {
              idempotencyKey: randomUUID(),
              expectedSubscriptionRevision: null,
              planRevisionId: planId,
              quantity: 1,
              billingConsent: "accepted",
            });
      const successor = randomUUID();
      const organizationId = randomUUID();
      await db.query("INSERT INTO users(id) VALUES($1)", [successor]);
      await db.query(
        "INSERT INTO app_billing_members(billing_account_id,app_id,user_id,role,livemode) VALUES($1,$2,$3,'administrator',false)",
        [identity.billingAccountId, identity.appId, successor],
      );
      await db.query("INSERT INTO organizations(id) VALUES($1)", [organizationId]);
      const context = {
        requestId: randomUUID(),
        requestDigest: "a".repeat(64),
        lifecycleRevision: 2,
        phaseReceiptId: randomUUID(),
        phaseGeneration: 1,
        userId: identity.actorUserId,
        organizationId,
        stewardUserId: "steward-shared-purchaser",
        blob: {},
      } as AccountDeletionProviderContext;
      await db.query(
        "UPDATE users SET is_active=false,auth_fenced_at=now(),account_lifecycle_state='deletion_irreversible',account_deletion_request_id=$2,account_lifecycle_revision=2 WHERE id=$1",
        [identity.actorUserId, context.requestId],
      );
      await db.query(
        "UPDATE organizations SET account_lifecycle_state='deletion_irreversible',account_deletion_request_id=$2,account_lifecycle_revision=2 WHERE id=$1",
        [organizationId, context.requestId],
      );
      await db.query(
        "INSERT INTO account_deletion_requests VALUES($1,$2,$3,$4,2,(now() AT TIME ZONE 'UTC'),'processing')",
        [context.requestId, context.userId, organizationId, context.requestDigest],
      );
      await db.query(
        "INSERT INTO account_deletion_phase_receipts VALUES($1,$2,'stripe',1,(now()+interval '5 minutes') AT TIME ZONE 'UTC','calling')",
        [context.phaseReceiptId, context.requestId],
      );
      const { createAccountDeletionProviderAdapters } = await import(
        "./account-deletion-provider-adapters"
      );
      const adapter = createAccountDeletionProviderAdapters({ appBillingRuntime: runtime }).stripe;
      const writes = fixture.requests.filter((row) => row.method === "POST").length;
      const expected =
        state === "prepared"
          ? { state: "complete" }
          : { state: "action_required", errorCode: "APP_BILLING_COMMAND_RECOVERY_REQUIRED" };
      await expect(adapter.inspect(context)).resolves.toMatchObject(expected);
      await expect(adapter.inspect(context)).resolves.toMatchObject(expected);
      expect(fixture.requests.filter((row) => row.method === "POST")).toHaveLength(writes);
      expect(
        (
          await db.query(
            "SELECT status,provider_started_at FROM billing_subscription_commands WHERE id=$1",
            [command.id],
          )
        ).rows[0],
      ).toMatchObject({
        status: state === "prepared" ? "SUPERSEDED" : "SUCCEEDED",
        ...(state === "prepared" ? { provider_started_at: null } : {}),
      });
      expect(
        (
          await db.query("SELECT user_id FROM app_billing_members WHERE billing_account_id=$1", [
            identity.billingAccountId,
          ])
        ).rows,
      ).toHaveLength(2);
    });
  }

  test("disabling merchant sales preserves existing access and cancellation without admitting a new trial", async () => {
    const existing = await buyer();
    const newcomer = await buyer();
    const intent = {
      idempotencyKey: randomUUID(),
      expectedSubscriptionRevision: null,
      payload: {
        version: 1 as const,
        domain: "buyer" as const,
        action: "trial" as const,
        planRevisionId: existing.planId,
        quantity: 1,
      },
    };
    const trial = await runtime.prepare(existing.identity, intent);
    expect(trial.status).toBe("succeeded");
    const { GenericBillingReadService } = await import("./generic-billing-read");
    const reads = new GenericBillingReadService();
    const before = await reads.snapshot(existing.identity);
    expect(before.entitlement?.access).toBe("granted");
    await db.query(
      "UPDATE billing_merchants SET enabled=false,disconnected_at=clock_timestamp() WHERE id=$1",
      [merchant],
    );
    try {
      expect((await reads.snapshot(existing.identity)).entitlement).toEqual(before.entitlement);
      expect(
        (await runtime.reconcileCommand({ scopeId: existing.scopeId, commandId: trial.id })).status,
      ).toBe("succeeded");
      expect((await reads.snapshot(existing.identity)).trialEligibility).toEqual(
        before.trialEligibility,
      );
      await expect(
        runtime.prepare(newcomer.identity, {
          ...intent,
          idempotencyKey: randomUUID(),
          payload: { ...intent.payload, planRevisionId: newcomer.planId },
        }),
      ).rejects.toThrow();
      const current = await queries.snapshot(existing.identity);
      if (current.kind !== "subscription")
        throw new Error("Existing merchant subscription disappeared");
      const portal = await runtime.portal(existing.identity, {
        idempotencyKey: randomUUID(),
        expectedSubscriptionRevision: current.subscription.lifecycle_revision,
      });
      expect(portal.status).toBe("requires_action");
      expect(portal.action?.kind).toBe("portal");
      const canceled = await runtime.prepare(existing.identity, {
        idempotencyKey: randomUUID(),
        expectedSubscriptionRevision: current.subscription.lifecycle_revision,
        payload: { version: 1, domain: "buyer", action: "cancel", timing: "immediate" },
      });
      expect(canceled.status).toBe("succeeded");
      expect((await reads.snapshot(existing.identity)).entitlement?.access).not.toBe("granted");
      expect(
        fixture.requests.filter(
          (row) =>
            row.method === "POST" &&
            row.path === "/v1/subscriptions" &&
            row.body.get("metadata[eliza_app_id]") === newcomer.identity.appId,
        ),
      ).toHaveLength(0);
    } finally {
      await db.query("UPDATE billing_merchants SET enabled=true,disconnected_at=NULL WHERE id=$1", [
        merchant,
      ]);
    }
  });

  test("customer discovery commits only under the current deletion phase without recreating the customer", async () => {
    const { GenericBillingRuntime } = await import("./generic-billing-runtime");
    const { createGenericBillingProvider } = await import("./generic-billing-provider");
    const { appBillingProviderBindings } = await import(
      "../../db/repositories/app-billing-provider-bindings"
    );
    const { identity, planId, scopeId } = await buyer();
    const provider = createGenericBillingProvider(
      fixture.stripe,
      { merchantId: merchant, kind: "connected", stripeAccountId: "acct_runtime", livemode: false },
      appBillingProviderBindings,
    );
    const lostRuntime = new GenericBillingRuntime(async () => ({
      ...provider,
      async createCustomer(scope, intent) {
        await provider.createCustomer(scope, intent);
        throw new Error("Customer response lost after provider acceptance");
      },
    }));
    const operation = await lostRuntime.checkout(identity, {
      idempotencyKey: randomUUID(),
      expectedSubscriptionRevision: null,
      planRevisionId: planId,
      quantity: 1,
      billingConsent: "accepted",
    });
    const writes = fixture.requests.filter((row) => row.method === "POST").length;
    const deletionAuthority = {
      kind: "account_deletion" as const,
      requestId: randomUUID(),
      requestDigest: "c".repeat(64),
      lifecycleRevision: 2,
      phaseReceiptId: randomUUID(),
      phaseGeneration: 1,
    };
    await db.query("UPDATE users SET is_active=false WHERE id=$1", [identity.actorUserId]);
    await db.query("UPDATE app_billing_scopes SET fenced_at=now() WHERE id=$1", [scopeId]);
    await db.query(
      "INSERT INTO account_deletion_requests VALUES($1,$2,$3,$4,2,now(),'processing')",
      [
        deletionAuthority.requestId,
        identity.actorUserId,
        randomUUID(),
        deletionAuthority.requestDigest,
      ],
    );
    await db.query(
      "INSERT INTO account_deletion_phase_receipts VALUES($1,$2,'stripe',1,(now()+interval '5 minutes') AT TIME ZONE 'UTC','calling')",
      [deletionAuthority.phaseReceiptId, deletionAuthority.requestId],
    );
    const staleRuntime = new GenericBillingRuntime(async () => ({
      ...provider,
      async discoverCreatedCustomer(scope, intent) {
        const observed = await provider.discoverCreatedCustomer(scope, intent);
        await db.query(
          "UPDATE account_deletion_phase_receipts SET lease_generation=2 WHERE id=$1",
          [deletionAuthority.phaseReceiptId],
        );
        return observed;
      },
    }));
    await expect(
      staleRuntime.run({ scopeId, commandId: operation.id, deletionAuthority }),
    ).rejects.toThrow("current irreversible deletion phase");
    expect(
      (
        await db.query("SELECT * FROM app_billing_customers WHERE billing_account_id=$1", [
          identity.billingAccountId,
        ])
      ).rows,
    ).toHaveLength(0);
    await runtime.run({
      scopeId,
      commandId: operation.id,
      deletionAuthority: { ...deletionAuthority, phaseGeneration: 2 },
    });
    const binding = (
      await db.query(
        "SELECT stripe_customer_id,command_id FROM app_billing_customers WHERE billing_account_id=$1",
        [identity.billingAccountId],
      )
    ).rows;
    expect(binding).toHaveLength(1);
    expect(binding[0].command_id).toBe(operation.id);
    expect(fixture.customers.has(binding[0].stripe_customer_id)).toBe(true);
    expect(fixture.requests.filter((row) => row.method === "POST")).toHaveLength(writes);
    expect(
      (
        await db.query("SELECT status FROM billing_subscription_commands WHERE id=$1", [
          operation.id,
        ])
      ).rows[0].status,
    ).toBe("OUTCOME_UNKNOWN");
  });

  test("deletion phase takeover cannot commit checkout discovery or expiry results", async () => {
    const { GenericBillingRuntime } = await import("./generic-billing-runtime");
    const { createGenericBillingProvider } = await import("./generic-billing-provider");
    const { appBillingProviderBindings } = await import(
      "../../db/repositories/app-billing-provider-bindings"
    );
    for (const mode of ["discover", "expire"] as const) {
      const { identity, planId, scopeId } = await buyer();
      if (mode === "discover") fixture.loseCheckoutResponse();
      const operation = await runtime.checkout(identity, {
        idempotencyKey: randomUUID(),
        expectedSubscriptionRevision: null,
        planRevisionId: planId,
        quantity: 1,
        billingConsent: "accepted",
      });
      const session = [...fixture.checkouts.values()].find(
        (row) => row.metadata.eliza_app_id === identity.appId,
      );
      if (!session) throw new Error("Expected original provider checkout");
      if (mode === "expire") session.expired = true;
      const before = (
        await db.query(
          "SELECT status,provider_result FROM billing_subscription_commands WHERE id=$1",
          [operation.id],
        )
      ).rows[0];
      const writes = fixture.requests.filter((row) => row.method === "POST").length;
      await db.query("UPDATE users SET is_active=false WHERE id=$1", [identity.actorUserId]);
      const authority = {
        kind: "account_deletion" as const,
        requestId: randomUUID(),
        requestDigest: "c".repeat(64),
        lifecycleRevision: 2,
        phaseReceiptId: randomUUID(),
        phaseGeneration: 1,
      };
      await db.query(
        "INSERT INTO account_deletion_requests VALUES($1,$2,$3,$4,2,now(),'processing')",
        [authority.requestId, identity.actorUserId, randomUUID(), authority.requestDigest],
      );
      await db.query(
        "INSERT INTO account_deletion_phase_receipts VALUES($1,$2,'stripe',1,(now()+interval '5 minutes') AT TIME ZONE 'UTC','calling')",
        [authority.phaseReceiptId, authority.requestId],
      );
      const takeover = () =>
        db.query("UPDATE account_deletion_phase_receipts SET lease_generation=2 WHERE id=$1", [
          authority.phaseReceiptId,
        ]);
      const staleRuntime = new GenericBillingRuntime(async (merchantId, livemode) => {
        const provider = createGenericBillingProvider(
          fixture.stripe,
          { merchantId, kind: "connected", stripeAccountId: "acct_runtime", livemode },
          appBillingProviderBindings,
        );
        return {
          ...provider,
          async discoverCreatedCheckout(scope, input, intent) {
            const observed = await provider.discoverCreatedCheckout(scope, input, intent);
            if (mode === "discover") await takeover();
            return observed;
          },
          async readCheckout(scope, input) {
            const observed = await provider.readCheckout(scope, input);
            if (mode === "expire") await takeover();
            return observed;
          },
        };
      });
      await expect(
        staleRuntime.run({ scopeId, commandId: operation.id, deletionAuthority: authority }),
      ).rejects.toThrow("current irreversible deletion phase");
      expect(
        (
          await db.query(
            "SELECT status,provider_result FROM billing_subscription_commands WHERE id=$1",
            [operation.id],
          )
        ).rows[0],
      ).toEqual(before);
      const recovered = await runtime.run({
        scopeId,
        commandId: operation.id,
        deletionAuthority: { ...authority, phaseGeneration: 2 },
      });
      expect(recovered.status).toBe(mode === "discover" ? "requires_action" : "failed");
      expect(fixture.requests.filter((row) => row.method === "POST")).toHaveLength(writes);
    }
  });

  test("the current deletion lease recovers an inactive actor's original purchase without provider writes", async () => {
    const { identity, planId, scopeId } = await buyer();
    fixture.loseSubscriptionResponse();
    const pending = await runtime.prepare(identity, {
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
    expect(pending.status).toBe("outcome_unknown");
    const writes = fixture.requests.filter((row) => row.method === "POST").length;
    await db.query(
      "UPDATE users SET is_active=false,auth_fenced_at=now(),account_lifecycle_state='deletion_irreversible' WHERE id=$1",
      [identity.actorUserId],
    );
    await expect(runtime.reconcileCommand({ scopeId, commandId: pending.id })).rejects.toThrow(
      "administrator authority",
    );
    const authority = {
      kind: "account_deletion" as const,
      requestId: randomUUID(),
      requestDigest: "b".repeat(64),
      lifecycleRevision: 2,
      phaseReceiptId: randomUUID(),
      phaseGeneration: 3,
    };
    await db.query(
      "INSERT INTO account_deletion_requests VALUES($1,$2,$3,$4,2,now(),'processing')",
      [authority.requestId, identity.actorUserId, randomUUID(), authority.requestDigest],
    );
    await db.query(
      "INSERT INTO account_deletion_phase_receipts VALUES($1,$2,'stripe',3,(now()+interval '5 minutes') AT TIME ZONE 'UTC','calling')",
      [authority.phaseReceiptId, authority.requestId],
    );
    const recover = (deletionAuthority = authority) =>
      runtime.run({ scopeId, commandId: pending.id, deletionAuthority });
    await expect(recover({ ...authority, phaseGeneration: 2 })).rejects.toThrow(
      "current irreversible deletion phase",
    );
    await db.query(
      "UPDATE account_deletion_phase_receipts SET lease_expires_at=(now()-interval '1 second') AT TIME ZONE 'UTC' WHERE id=$1",
      [authority.phaseReceiptId],
    );
    await expect(recover()).rejects.toThrow("current irreversible deletion phase");
    await db.query(
      "UPDATE account_deletion_phase_receipts SET lease_expires_at=(now()+interval '5 minutes') AT TIME ZONE 'UTC' WHERE id=$1",
      [authority.phaseReceiptId],
    );
    await db.query("UPDATE account_deletion_requests SET user_id=$2 WHERE id=$1", [
      authority.requestId,
      randomUUID(),
    ]);
    await expect(recover()).rejects.toThrow("current irreversible deletion phase");
    await db.query("UPDATE account_deletion_requests SET user_id=$2 WHERE id=$1", [
      authority.requestId,
      identity.actorUserId,
    ]);
    const { GenericBillingRuntime } = await import("./generic-billing-runtime");
    const { createGenericBillingProvider } = await import("./generic-billing-provider");
    const { appBillingProviderBindings } = await import(
      "../../db/repositories/app-billing-provider-bindings"
    );
    let advanced = false;
    const staleRuntime = new GenericBillingRuntime(async (merchantId, livemode) => {
      const provider = createGenericBillingProvider(
        fixture.stripe,
        { merchantId, kind: "connected", stripeAccountId: "acct_runtime", livemode },
        appBillingProviderBindings,
      );
      return {
        ...provider,
        async retrieveSubscription(scope, input) {
          const observed = await provider.retrieveSubscription(scope, input);
          if (!advanced) {
            advanced = true;
            await db.query(
              "UPDATE account_deletion_phase_receipts SET lease_generation=4 WHERE id=$1",
              [authority.phaseReceiptId],
            );
          }
          return observed;
        },
      };
    });
    await expect(
      staleRuntime.run({ scopeId, commandId: pending.id, deletionAuthority: authority }),
    ).rejects.toThrow("current irreversible deletion phase");
    expect(
      (await db.query("SELECT id FROM billing_subscriptions WHERE billing_scope_id=$1", [scopeId]))
        .rows,
    ).toEqual([]);
    expect((await recover({ ...authority, phaseGeneration: 4 })).status).toBe("succeeded");
    expect(fixture.requests.filter((row) => row.method === "POST")).toHaveLength(writes);
    const history = await db.query(
      "SELECT requested_by_user_id,status FROM billing_subscription_commands WHERE id=$1",
      [pending.id],
    );
    expect(history.rows[0]).toEqual({
      requested_by_user_id: identity.actorUserId,
      status: "APPLIED",
    });
    expect(
      (
        await db.query("SELECT status FROM billing_subscriptions WHERE billing_scope_id=$1", [
          scopeId,
        ])
      ).rows[0].status,
    ).toBe("trialing");
  });

  test("purchaser fencing between preparation and dispatch leaves the command unapplied", async () => {
    const { identity, planId, scopeId } = await buyer();
    const command = await authority.prepareCommand({
      scopeId,
      actorUserId: identity.actorUserId,
      kind: "checkout",
      targetPlanRevisionId: planId,
      quantity: 1,
      idempotencyKey: randomUUID(),
      requestDigest: "a".repeat(64),
      expectedSubscriptionRevision: null,
      payload: {
        version: 1,
        domain: "buyer",
        action: "trial",
        planRevisionId: planId,
        quantity: 1,
      },
    });
    await db.query("UPDATE users SET auth_fenced_at=now() WHERE id=$1", [identity.actorUserId]);
    await expect(
      commands.claim({ scopeId, commandId: command.id, actorUserId: identity.actorUserId }),
    ).rejects.toThrow("fenced before provider dispatch");
    await expect(
      authority.beginCommand({
        scopeId,
        commandId: command.id,
        actorUserId: identity.actorUserId,
        expectedStateRevision: command.state_revision,
        expectedExecutionGeneration: command.execution_generation,
      }),
    ).rejects.toThrow("fenced before provider dispatch");
    const stored = await db.query(
      "SELECT status,attempt_count,provider_started_at FROM billing_subscription_commands WHERE id=$1",
      [command.id],
    );
    expect(stored.rows[0]).toEqual({
      status: "PREPARED",
      attempt_count: 0,
      provider_started_at: null,
    });
    expect(
      fixture.requests.filter(
        (row) => row.method === "POST" && row.body.get("metadata[eliza_app_id]") === identity.appId,
      ),
    ).toEqual([]);
  });

  test("purchaser lifecycle fences reject new work while recovering an existing provider result", async () => {
    const { identity, planId, scopeId } = await buyer();
    const input = {
      idempotencyKey: randomUUID(),
      expectedSubscriptionRevision: null,
      payload: {
        version: 1 as const,
        domain: "buyer" as const,
        action: "trial" as const,
        planRevisionId: planId,
        quantity: 1,
      },
    };
    for (const mutation of [
      "auth_fenced_at=now()",
      "auth_fenced_at=NULL,expires_at=now()-interval '1 second'",
      "expires_at=NULL,account_lifecycle_state='deletion_recovery'",
    ]) {
      await db.query(`UPDATE users SET ${mutation} WHERE id=$1`, [identity.actorUserId]);
      await expect(runtime.prepare(identity, input)).rejects.toThrow(
        "cannot start new billing work",
      );
      expect(
        (
          await db.query("SELECT id FROM billing_subscription_commands WHERE billing_scope_id=$1", [
            scopeId,
          ])
        ).rows,
      ).toEqual([]);
    }
    await db.query("UPDATE users SET account_lifecycle_state='active' WHERE id=$1", [
      identity.actorUserId,
    ]);
    fixture.loseSubscriptionResponse();
    const pending = await runtime.prepare(identity, input);
    expect(pending.status).toBe("outcome_unknown");
    const observed = [...fixture.subscriptions].filter(
      ([, row]) => row.metadata.eliza_app_id === identity.appId,
    );
    expect(observed).toHaveLength(1);
    for (const [id] of observed) fixture.subscriptions.delete(id);
    await db.query("UPDATE users SET auth_fenced_at=now() WHERE id=$1", [identity.actorUserId]);
    expect((await runtime.reconcileCommand({ scopeId, commandId: pending.id })).status).toBe(
      "outcome_unknown",
    );
    expect(
      fixture.requests.filter(
        (row) =>
          row.method === "POST" &&
          row.path === "/v1/subscriptions" &&
          row.body.get("metadata[eliza_app_id]") === identity.appId,
      ),
    ).toHaveLength(1);
    for (const [id, row] of observed) fixture.subscriptions.set(id, row);
    expect((await runtime.reconcileCommand({ scopeId, commandId: pending.id })).status).toBe(
      "succeeded",
    );
    expect((await queries.snapshot(identity)).subscription?.status).toBe("trialing");
  });

  test("a fenced pending purchase may reconcile but cannot create another provider object", async () => {
    const { identity, planId, scopeId } = await buyer();
    fixture.loseSubscriptionResponse();
    const first = await runtime.prepare(identity, {
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
    expect(first.status).toBe("outcome_unknown");
    for (const [id, row] of fixture.subscriptions)
      if (row.metadata.eliza_app_id === identity.appId) fixture.subscriptions.delete(id);
    await db.query("UPDATE app_billing_scopes SET fenced_at=now() WHERE id=$1", [scopeId]);
    expect((await runtime.reconcileCommand({ scopeId, commandId: first.id })).status).toBe(
      "outcome_unknown",
    );
    expect(
      fixture.requests.filter(
        (row) =>
          row.method === "POST" &&
          row.path === "/v1/subscriptions" &&
          row.body.get("metadata[eliza_app_id]") === identity.appId,
      ),
    ).toHaveLength(1);
  });
});
