/** Exercises prepared-command deletion through real PostgreSQL journal guards and canonical recovery. Controlled Stripe HTTP records prove that supersession never dispatches provider work. */
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Client } from "pg";
import type { BuyerBillingIdentity, GenericBillingRuntime } from "./generic-billing-runtime";
import { createRuntimeStripeFixture } from "./generic-billing-runtime.stripe-fixture";

const postgresUrl = process.env.APP_BILLING_TEST_POSTGRES_URL;
const schema = `app_prepared_deletion_${randomUUID().replaceAll("-", "_")}`;
if (postgresUrl) {
  const repositoryUrl = new URL(postgresUrl);
  repositoryUrl.searchParams.set("application_name", schema);
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

describe.skipIf(!postgresUrl)("prepared purchaser deletion with PostgreSQL and Stripe HTTP", () => {
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
    const authority = {
      kind: "account_deletion" as const,
      requestId,
      requestDigest: "a".repeat(64),
      lifecycleRevision: 1,
      phaseReceiptId,
      phaseGeneration: 1,
    };
    const context = {
      ...authority,
      userId,
      organizationId,
      stewardUserId: "controlled-subject",
      blob: {} as import("../storage/r2-runtime-binding").RuntimeR2Bucket,
    };
    return { authority, context };
  }
  async function administrator(identity: BuyerBillingIdentity) {
    const id = randomUUID();
    await db.query("INSERT INTO users(id) VALUES($1)", [id]);
    await db.query(
      "INSERT INTO app_billing_members(app_id,billing_account_id,user_id,role,livemode) VALUES($1,$2,$3,'administrator',false)",
      [identity.appId, identity.billingAccountId, id],
    );
    return id;
  }
  async function preparedTrial(scopeId: string, userId: string, planId: string) {
    return authority.prepareCommand({
      scopeId,
      actorUserId: userId,
      kind: "checkout",
      targetPlanRevisionId: planId,
      quantity: 1,
      idempotencyKey: randomUUID(),
      expectedSubscriptionRevision: null,
      requestDigest: "b".repeat(64),
      payload: {
        version: 1,
        domain: "buyer",
        action: "trial",
        planRevisionId: planId,
        quantity: 1,
      },
    });
  }
  async function recover(context: Awaited<ReturnType<typeof deletion>>["context"]) {
    return (await import("./app-billing-deletion-recovery")).recoverAppBillingForAccountDeletion(
      context,
      runtime,
    );
  }
  async function snapshot(commandId: string) {
    return (await db.query("SELECT * FROM billing_subscription_commands WHERE id=$1", [commandId]))
      .rows[0];
  }
  test("canonical recovery supersedes only departing intent and preserves shared subscription, other purchaser intent and provider history", async () => {
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
    const survivingUser = await administrator(identity);
    const existing = await queries.snapshot(identity);
    if (existing.kind !== "subscription") throw new Error("Expected real trial subscription");
    const cancel = await authority.prepareCommand({
      scopeId,
      actorUserId: identity.actorUserId,
      kind: "cancel",
      targetPlanRevisionId: null,
      quantity: 1,
      idempotencyKey: randomUUID(),
      expectedSubscriptionRevision: existing.mutationRevision,
      requestDigest: "c".repeat(64),
      payload: { version: 1, domain: "buyer", action: "cancel", atPeriodEnd: true },
    });
    const portal = await authority.prepareCommand({
      scopeId,
      actorUserId: survivingUser,
      kind: "portal",
      targetPlanRevisionId: null,
      quantity: 1,
      idempotencyKey: randomUUID(),
      expectedSubscriptionRevision: existing.mutationRevision,
      requestDigest: "d".repeat(64),
      payload: { version: 1, domain: "buyer", action: "portal", returnUrl: "https://app.example" },
    });
    const before = await snapshot(cancel.id),
      otherBefore = await snapshot(portal.id),
      providerCount = fixture.requests.length;
    const { context } = await deletion(identity.actorUserId);
    expect(await recover(context)).toBe("complete");
    expect(await recover(context)).toBe("complete");
    const after = await snapshot(cancel.id);
    expect(after).toEqual({
      ...before,
      status: "SUPERSEDED",
      state_revision: String(Number(before.state_revision) + 1),
      error_code: "APP_BILLING_PURCHASER_DELETED",
      completed_at: expect.any(Date),
      updated_at: expect.any(Date),
    });
    expect(await snapshot(portal.id)).toEqual(otherBefore);
    expect(
      await commands.claim({ scopeId, commandId: cancel.id, actorUserId: survivingUser }),
    ).toBeNull();
    const shared = await queries.snapshot({ ...identity, actorUserId: survivingUser });
    if (shared.kind !== "subscription") throw new Error("Shared subscription was lost");
    expect(shared.subscription).toEqual(existing.subscription);
    expect(shared.trial).toEqual(existing.trial);
    expect(fixture.requests.length).toBe(providerCount);
  });
  test("stale phase, wrong purchaser and changed command lease or revision cannot retire intent", async () => {
    const { identity, scopeId, planId } = await buyer();
    const command = await preparedTrial(scopeId, identity.actorUserId, planId);
    const { authority: deletionAuthority } = await deletion(identity.actorUserId);
    const input = {
      scopeId,
      commandId: command.id,
      expectedStateRevision: command.state_revision,
      authority: deletionAuthority,
    };
    const before = await snapshot(command.id),
      providerCount = fixture.requests.length;
    await db.query("UPDATE account_deletion_phase_receipts SET lease_generation=2 WHERE id=$1", [
      deletionAuthority.phaseReceiptId,
    ]);
    await expect(commands.supersedePreparedForDeletion(input)).rejects.toThrow(
      "current irreversible",
    );
    expect(await snapshot(command.id)).toEqual(before);
    await db.query(
      "UPDATE account_deletion_phase_receipts SET lease_expires_at=(now() AT TIME ZONE 'UTC')-interval '1 minute' WHERE id=$1",
      [deletionAuthority.phaseReceiptId],
    );
    await expect(
      commands.supersedePreparedForDeletion({
        ...input,
        authority: { ...deletionAuthority, phaseGeneration: 2 },
      }),
    ).rejects.toThrow("current irreversible");
    expect(await snapshot(command.id)).toEqual(before);
    await db.query(
      "UPDATE account_deletion_phase_receipts SET lease_expires_at=(now() AT TIME ZONE 'UTC')+interval '5 minutes' WHERE id=$1",
      [deletionAuthority.phaseReceiptId],
    );
    const other = await buyer();
    const foreign = await deletion(other.identity.actorUserId);
    await expect(
      commands.supersedePreparedForDeletion({ ...input, authority: foreign.authority }),
    ).rejects.toThrow("original unstarted purchaser");
    const current = { ...input, authority: { ...deletionAuthority, phaseGeneration: 2 } };
    await db.query(
      "UPDATE billing_subscription_commands SET lease_token=$2,lease_expires_at=(now() AT TIME ZONE 'UTC')+interval '5 minutes' WHERE id=$1",
      [command.id, randomUUID()],
    );
    const leased = await snapshot(command.id);
    await expect(commands.supersedePreparedForDeletion(current)).rejects.toThrow(
      "execution lease changed",
    );
    expect(await snapshot(command.id)).toEqual(leased);
    await db.query(
      "UPDATE billing_subscription_commands SET lease_token=NULL,lease_expires_at=NULL,state_revision=state_revision+1 WHERE id=$1",
      [command.id],
    );
    await expect(commands.supersedePreparedForDeletion(current)).rejects.toThrow("revision");
    expect(
      (
        await commands.supersedePreparedForDeletion({
          ...current,
          expectedStateRevision: command.state_revision + 1,
        })
      ).status,
    ).toBe("SUPERSEDED");
    expect(fixture.requests.length).toBe(providerCount);
  });
  test("a concurrent execution claim wins before supersession without losing ambiguous provider intent", async () => {
    const { identity, scopeId, planId } = await buyer();
    const other = await administrator(identity);
    const command = await preparedTrial(scopeId, identity.actorUserId, planId);
    const { authority: deletionAuthority } = await deletion(identity.actorUserId);
    const blocker = new Client({ connectionString: postgresUrl });
    await blocker.connect();
    await blocker.query(`SET search_path TO ${schema},public`);
    await blocker.query("BEGIN");
    await blocker.query("SELECT id FROM organizations WHERE id=$1 FOR UPDATE", [org]);
    const providerCount = fixture.requests.length;
    try {
      const claiming = commands.claim({ scopeId, commandId: command.id, actorUserId: other });
      for (let attempt = 0; ; attempt++) {
        const waiting = await db.query(
          "SELECT count(*)::int AS count FROM pg_stat_activity WHERE application_name=$1 AND wait_event_type='Lock'",
          [schema],
        );
        if (waiting.rows[0].count > 0) break;
        if (attempt === 100) throw new Error("Execution claim did not reach owner lock");
        await Bun.sleep(10);
      }
      const superseding = commands.supersedePreparedForDeletion({
        scopeId,
        commandId: command.id,
        expectedStateRevision: command.state_revision,
        authority: deletionAuthority,
      });
      const observed = Promise.allSettled([claiming, superseding]);
      await blocker.query("COMMIT");
      const results = await observed;
      expect(results[0].status).toBe("fulfilled");
      expect(results[1].status).toBe("rejected");
      const after = await snapshot(command.id);
      expect(after.status).toBe("OUTCOME_UNKNOWN");
      expect(after.provider_started_at).toBeInstanceOf(Date);
      expect(Number(after.execution_generation)).toBe(1);
      expect(after.request_digest).toBe(command.request_digest);
      expect(after.requested_by_user_id).toBe(identity.actorUserId);
      const calls = fixture.requests.length;
      await expect(
        commands.supersedePreparedForDeletion({
          scopeId,
          commandId: command.id,
          expectedStateRevision: Number(after.state_revision),
          authority: deletionAuthority,
        }),
      ).rejects.toThrow("unstarted");
      expect(await snapshot(command.id)).toEqual(after);
      expect(fixture.requests.length).toBe(calls);
      expect(fixture.requests.length).toBe(providerCount);
    } finally {
      await blocker.end();
    }
  });
  test("developer deletion authority cannot supersede a different purchaser command", async () => {
    const { identity, scopeId, planId } = await buyer();
    const command = await preparedTrial(scopeId, identity.actorUserId, planId);
    const developer = randomUUID();
    await db.query("INSERT INTO users(id) VALUES($1)", [developer]);
    const { authority: deletionAuthority } = await deletion(developer);
    await db.query("UPDATE account_deletion_requests SET organization_id=$1 WHERE id=$2", [
      org,
      deletionAuthority.requestId,
    ]);
    await db.query("UPDATE users SET organization_id=$1 WHERE id=$2", [org, developer]);
    await db.query(
      "UPDATE organizations SET account_lifecycle_state='deletion_irreversible',account_deletion_request_id=$1,account_lifecycle_revision=1 WHERE id=$2",
      [deletionAuthority.requestId, org],
    );
    const before = await snapshot(command.id),
      providerCount = fixture.requests.length;
    await expect(
      commands.supersedePreparedForDeletion({
        scopeId,
        commandId: command.id,
        expectedStateRevision: command.state_revision,
        authority: deletionAuthority,
      }),
    ).rejects.toThrow("original unstarted purchaser");
    expect(await snapshot(command.id)).toEqual(before);
    expect(fixture.requests.length).toBe(providerCount);
  });
});
