/** Verifies offline-owner invitations through the real SDK, HTTP authentication, PostgreSQL membership and seat transaction. */
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { CloudApiClient } from "@elizaos/cloud-sdk";
import { AppBillingClient } from "@elizaos/cloud-sdk/app-billing";
import { Hono } from "hono";
import { Client } from "pg";
import type { AppEnv } from "../../types/cloud-worker-env";
import type { GenericBillingRuntime } from "./generic-billing-runtime";
import { createRuntimeStripeFixture } from "./generic-billing-runtime.stripe-fixture";

const postgresUrl = process.env.APP_BILLING_TEST_POSTGRES_URL;
const schema = `app_members_${randomUUID().replaceAll("-", "_")}`;
if (postgresUrl) {
  const repositoryUrl = new URL(postgresUrl);
  repositoryUrl.searchParams.set("options", `-c search_path=${schema},public`);
  process.env.DATABASE_URL = repositoryUrl.toString();
  process.env.TEST_DATABASE_URL = repositoryUrl.toString();
}
process.env.LOCAL_PG_POOL_MAX = "4";
process.env.NODE_ENV ||= "test";
process.env.APP_BILLING_ENVIRONMENT = "test";
setDefaultTimeout(120_000);
let db: Client;
let close: typeof import("../../db/client").closeDatabaseConnectionsForTests;
let authority: typeof import("../../db/repositories/app-subscription-authority").appSubscriptionAuthorityRepository;
let runtime: GenericBillingRuntime;
let server: ReturnType<typeof Bun.serve>;
const org = randomUUID();
const merchant = randomUUID();
const fixture = createRuntimeStripeFixture();
const secret = "controlled-app-member-backend-secret";

async function workspace() {
  const owner = randomUUID();
  const appId = randomUUID();
  const planId = randomUUID();
  const clientId = randomUUID();
  await db.query("INSERT INTO users(id) VALUES($1)", [owner]);
  await db.query("INSERT INTO apps(id,organization_id) VALUES($1,$2)", [appId, org]);
  await db.query(
    `INSERT INTO app_client_registrations(id,app_id,owner_organization_id,billing_environment,secret_hashes,redirect_uris,allowed_scopes) VALUES($1,$2,$3,'test',$4,'["https://app.example.test/callback"]','["identity","billing:write"]')`,
    [clientId, appId, org, JSON.stringify([createHash("sha256").update(secret).digest("hex")])],
  );
  await db.query(
    `INSERT INTO app_billing_plan_revisions(id,app_id,merchant_id,product_family_key,plan_key,revision,name,amount_cents,currency,interval,maximum_quantity,trial_allowance_usd,paid_allowance_usd,expired_access,entitlements,stripe_price_id,stripe_product_id,published_at) VALUES($1,$2,$3,'main','basic',1,'Basic',3000,'usd','month',10,'5.000000','25.000000','read_only','{"features":["inference"],"completionsRpm":60,"embeddingsRpm":60,"standardRpm":60,"strictRpm":10}','price_basic','prod_basic',now())`,
    [planId, appId, merchant],
  );
  const account = await authority.createAccount({
    appId,
    externalAccountKey: randomUUID(),
    displayName: "Independent workspace",
    principalUserId: owner,
  });
  const identity = {
    appId,
    actorUserId: owner,
    billingAccountId: account.id,
    productFamilyKey: "main",
    livemode: false,
    clientRegistrationId: null,
  };
  const trial = await runtime.prepare(identity, {
    idempotencyKey: randomUUID(),
    expectedSubscriptionRevision: null,
    payload: { version: 1, domain: "buyer", action: "trial", planRevisionId: planId, quantity: 1 },
  });
  expect(trial.status).toBe("succeeded");
  const scope = await authority.getScope(identity);
  const basic = `Basic ${Buffer.from(`${clientId}:${secret}`).toString("base64")}`;
  const sdk = new AppBillingClient(
    new CloudApiClient(`${server.url.origin}/api/v1`, undefined, {
      defaultHeaders: { Authorization: basic },
    }),
    appId,
  );
  return { owner, appId, accountId: account.id, clientId, basic, sdk, scopeId: scope.scopeId };
}
async function principal() {
  const id = randomUUID();
  await db.query("INSERT INTO users(id) VALUES($1)", [id]);
  return id;
}
const change = (userId: string, expectedRevision = "0", assigned = true) => ({
  userId,
  active: true,
  expectedRevision,
  idempotencyKey: randomUUID(),
  seats: [{ productFamilyKey: "main", assigned }],
});

describe.skipIf(!postgresUrl)("registered backend team membership", () => {
  beforeAll(async () => {
    db = new Client({ connectionString: postgresUrl });
    await db.connect();
    await db.query("CREATE EXTENSION IF NOT EXISTS btree_gist WITH SCHEMA public");
    await db.query(`CREATE SCHEMA ${schema}`);
    await db.query(`SET search_path TO ${schema},public`);
    await db.query(
      `CREATE TABLE organizations(id uuid PRIMARY KEY,is_active boolean NOT NULL DEFAULT true,account_lifecycle_state text NOT NULL DEFAULT 'active',paid_work_fenced_at timestamptz,stripe_customer_id text,credit_balance numeric NOT NULL DEFAULT 0); CREATE TABLE users(id uuid PRIMARY KEY,is_active boolean NOT NULL DEFAULT true,deleted_at timestamptz,email_verified boolean NOT NULL DEFAULT true,is_anonymous boolean NOT NULL DEFAULT false,account_lifecycle_state text NOT NULL DEFAULT 'active',auth_fenced_at timestamptz,expires_at timestamptz); CREATE TABLE apps(id uuid PRIMARY KEY,name text NOT NULL DEFAULT 'Independent app',organization_id uuid NOT NULL REFERENCES organizations(id),is_active boolean NOT NULL DEFAULT true,is_approved boolean NOT NULL DEFAULT true,review_status text NOT NULL DEFAULT 'approved'); CREATE TABLE credit_transactions(id uuid PRIMARY KEY,organization_id uuid NOT NULL REFERENCES organizations(id),CONSTRAINT credit_transactions_id_org_idx UNIQUE(id,organization_id));`,
    );
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
        if (statement.trim()) await db.query(statement.replaceAll('"public".', ""));
    }
    const { applyAppBillingTestMigrations } = await import(
      "../../db/repositories/app-billing-test-migrations"
    );
    await applyAppBillingTestMigrations((statement) => db.query(statement));
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
    const { createGenericBillingProvider } = await import("./generic-billing-provider");
    const { appBillingProviderBindings } = await import(
      "../../db/repositories/app-billing-provider-bindings"
    );
    const { GenericBillingRuntime } = await import("./generic-billing-runtime");
    runtime = new GenericBillingRuntime(async (merchantId, livemode) =>
      createGenericBillingProvider(
        fixture.stripe,
        { merchantId, kind: "connected", stripeAccountId: "acct_runtime", livemode },
        appBillingProviderBindings,
      ),
    );
    const { default: members } = await import(
      "../../../../api/v1/apps/[id]/billing/accounts/[accountId]/members/route"
    );
    const { default: sync } = await import(
      "../../../../api/v1/apps/[id]/billing/accounts/[accountId]/members/sync/route"
    );
    const { default: administrators } = await import(
      "../../../../api/v1/apps/[id]/billing/accounts/[accountId]/administrators/route"
    );
    const app = new Hono<AppEnv>();
    app.route("/api/v1/apps/:id/billing/accounts/:accountId/administrators", administrators);
    app.route("/api/v1/apps/:id/billing/accounts/:accountId/members", members);
    app.route("/api/v1/apps/:id/billing/accounts/:accountId/members/sync", sync);
    server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (request) => app.fetch(request) });
  });
  afterAll(async () => {
    if (server) await server.stop(true);
    if (close) await close();
    if (db) {
      await db.query(`DROP SCHEMA ${schema} CASCADE`);
      await db.end();
    }
  });

  test("accepted invitation works without owner delegation and one retry retains the same seat", async () => {
    const w = await workspace();
    const userId = await principal();
    const before = await w.sdk.listMembers(w.accountId);
    expect(before.data.revision).toBe("0");
    const input = change(userId);
    const result = await w.sdk.synchronizeMember(w.accountId, input);
    expect(result.data.member).toEqual({ userId, role: "member", active: true });
    expect(result.data.seats).toHaveLength(1);
    expect((await w.sdk.synchronizeMember(w.accountId, input)).data).toEqual(result.data);
    const counts = await db.query(
      "SELECT count(*)::int AS count FROM app_billing_seats WHERE billing_scope_id=$1 AND revoked_at IS NULL",
      [w.scopeId],
    );
    expect(counts.rows[0].count).toBe(1);
    const { appBillingQueries } = await import("../../db/repositories/app-billing-queries");
    expect(
      (
        await appBillingQueries.snapshot({
          appId: w.appId,
          billingAccountId: w.accountId,
          productFamilyKey: "main",
          actorUserId: userId,
          livemode: false,
        })
      ).kind,
    ).toBe("subscription");
    await expect(
      appBillingQueries.snapshot({
        appId: w.appId,
        billingAccountId: w.accountId,
        productFamilyKey: "main",
        actorUserId: userId,
        livemode: true,
      }),
    ).rejects.toThrow("membership");
  });

  test("only a definitely unexecuted stale revision permits membership intent replacement", async () => {
    const w = await workspace();
    const firstUser = await principal();
    const secondUser = await principal();
    const original = change(firstUser);
    const applied = await w.sdk.synchronizeMember(w.accountId, original);
    const stale = { ...change(secondUser), seats: [] };
    await expect(w.sdk.synchronizeMember(w.accountId, stale)).rejects.toMatchObject({
      statusCode: 409,
      errorBody: { code: "APP_BILLING_MEMBERSHIP_REVISION_CONFLICT" },
    });
    expect(
      (
        await db.query(
          "SELECT count(*)::int AS total FROM app_billing_membership_operations WHERE billing_account_id=$1 AND idempotency_key=$2",
          [w.accountId, stale.idempotencyKey],
        )
      ).rows[0].total,
    ).toBe(0);
    expect(
      (await w.sdk.listMembers(w.accountId)).data.members.some(
        (member) => member.userId === secondUser,
      ),
    ).toBe(false);
    expect((await w.sdk.synchronizeMember(w.accountId, original)).data).toEqual(applied.data);
    await expect(
      w.sdk.synchronizeMember(w.accountId, { ...original, userId: secondUser }),
    ).rejects.toMatchObject({
      statusCode: 409,
      errorBody: { code: "APP_BILLING_AUTHORITY_CONFLICT" },
    });
    const refreshed = await w.sdk.listMembers(w.accountId);
    const recovered = await w.sdk.synchronizeMember(w.accountId, {
      ...stale,
      expectedRevision: refreshed.data.revision,
    });
    expect(recovered.data.member).toEqual({ userId: secondUser, role: "member", active: true });
    expect(recovered.data.revision).toBe("2");
  });

  test("wallet principals can receive seats while anonymous identities cannot become members", async () => {
    const w = await workspace();
    const walletUser = await principal();
    await db.query("UPDATE users SET email_verified=false WHERE id=$1", [walletUser]);
    const result = await w.sdk.synchronizeMember(w.accountId, change(walletUser));
    expect(result.data.member.active).toBe(true);
    expect(result.data.seats).toHaveLength(1);
    const anonymousUser = await principal();
    await db.query("UPDATE users SET is_anonymous=true WHERE id=$1", [anonymousUser]);
    await expect(
      w.sdk.synchronizeMember(w.accountId, {
        ...change(anonymousUser, "1", false),
        seats: [],
      }),
    ).rejects.toMatchObject({ statusCode: 409 });
    expect((await w.sdk.listMembers(w.accountId)).data.revision).toBe("1");
  });

  test("seat exhaustion rolls back membership and concurrent revisions cannot overbook", async () => {
    const w = await workspace();
    const users = await Promise.all([principal(), principal()]);
    const outcomes = await Promise.allSettled(
      users.map((userId) => w.sdk.synchronizeMember(w.accountId, change(userId))),
    );
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    const remaining = outcomes[0]!.status === "fulfilled" ? users[1]! : users[0]!;
    await expect(
      w.sdk.synchronizeMember(w.accountId, change(remaining, "1")),
    ).rejects.toMatchObject({ statusCode: 409 });
    const current = await w.sdk.listMembers(w.accountId);
    expect(current.data.revision).toBe("1");
    expect(
      current.data.members.some((member) => member.userId === remaining && member.active),
    ).toBe(false);
  });

  test("removal revokes seats atomically while the original administrator remains protected", async () => {
    const w = await workspace();
    const userId = await principal();
    await w.sdk.synchronizeMember(w.accountId, change(userId));
    const remove = { ...change(userId, "1", false), active: false };
    const result = await w.sdk.synchronizeMember(w.accountId, remove);
    expect(result.data.member.active).toBe(false);
    expect(result.data.seats).toEqual([]);
    await expect(
      w.sdk.synchronizeMember(w.accountId, { ...change(w.owner, "2", false), active: false }),
    ).rejects.toMatchObject({ statusCode: 409 });
    const current = await w.sdk.listMembers(w.accountId);
    expect(current.data.members.find((member) => member.userId === w.owner)).toEqual({
      userId: w.owner,
      role: "administrator",
      active: true,
    });
    expect((await w.sdk.synchronizeMember(w.accountId, remove)).data).toEqual(result.data);
  });

  test("purchaser transfer releases the former administrator to backend membership without granting backend purchase authority", async () => {
    const w = await workspace();
    const userId = await principal();
    await w.sdk.synchronizeMember(w.accountId, { ...change(userId), seats: [] });
    const input = {
      userId,
      action: "transfer" as const,
      expectedRevision: "1",
      idempotencyKey: randomUUID(),
    };
    await expect(w.sdk.changeAdministrator(w.accountId, input)).rejects.toMatchObject({
      statusCode: 401,
    });
    const { genericBillingAdministratorsService } = await import(
      "./generic-billing-administrators"
    );
    await genericBillingAdministratorsService.change(
      {
        appId: w.appId,
        billingAccountId: w.accountId,
        userId: w.owner,
        clientId: null,
        environment: "test",
      },
      input,
    );
    const members = (await w.sdk.listMembers(w.accountId)).data;
    expect(members.revision).toBe("2");
    expect(members.members.find((row) => row.userId === w.owner)).toEqual({
      userId: w.owner,
      active: true,
      role: "member",
    });
    expect(members.members.find((row) => row.userId === userId)).toEqual({
      userId,
      active: true,
      role: "administrator",
    });
    const removed = await w.sdk.synchronizeMember(w.accountId, {
      ...change(w.owner, "2", false),
      active: false,
      seats: [],
    });
    expect(removed.data.member.active).toBe(false);
    await expect(
      w.sdk.synchronizeMember(w.accountId, {
        ...change(userId, "3", false),
        active: false,
        seats: [],
      }),
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  test("real Basic authentication and route validation reject foreign or broadened authority", async () => {
    const w = await workspace();
    const other = await workspace();
    await expect(w.sdk.listMembers(other.accountId)).rejects.toMatchObject({ statusCode: 409 });
    const wrong = new AppBillingClient(
      new CloudApiClient(`${server.url.origin}/api/v1`, undefined, {
        defaultHeaders: {
          Authorization: `Basic ${Buffer.from(`${w.clientId}:incorrect`).toString("base64")}`,
        },
      }),
      w.appId,
    );
    await expect(wrong.listMembers(w.accountId)).rejects.toMatchObject({ statusCode: 401 });
    const response = await fetch(
      `${server.url.origin}/api/v1/apps/${w.appId}/billing/accounts/${w.accountId}/members/sync`,
      {
        method: "POST",
        headers: { Authorization: w.basic, "Content-Type": "application/json" },
        body: JSON.stringify({ ...change(await principal()), role: "administrator" }),
      },
    );
    expect(response.status).toBe(400);
    await db.query(
      "UPDATE app_client_registrations SET is_active=false,revision=revision+1 WHERE id=$1",
      [w.clientId],
    );
    await expect(w.sdk.listMembers(w.accountId)).rejects.toMatchObject({ statusCode: 401 });
  });
});
