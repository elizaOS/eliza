/** Starts isolated PostgreSQL and signed-session HTTP fixtures while keeping billing repositories and Stripe SDK real. */
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { generateDrizzleJson, generateMigration } from "drizzle-kit/api";
import { Hono } from "hono";
import { Client } from "pg";
import type { AppContext, AppEnv } from "@/types/cloud-worker-env";
import { createAdminTestProvider } from "./admin-test-provider";
export const databaseUrl = process.env.APP_BILLING_TEST_POSTGRES_URL;
const schema = `app_admin_${randomUUID().replaceAll("-", "_")}`;
const connectionUrl = databaseUrl ? new URL(databaseUrl) : null;
if (connectionUrl)
  connectionUrl.searchParams.set("options", `-c search_path=${schema},public`);
process.env.DATABASE_URL = connectionUrl?.toString() ?? "postgresql://unused";
process.env.TEST_DATABASE_URL = process.env.DATABASE_URL;
process.env.NODE_ENV = "test";
process.env.CACHE_BACKEND = "memory";
process.env.LOCAL_PG_POOL_MAX = "4";
export const ids = {
  org: randomUUID(),
  user: randomUUID(),
  app: randomUUID(),
  registration: randomUUID(),
  otherOrg: randomUUID(),
  otherUser: randomUUID(),
};
export const env = {
  NODE_ENV: "test",
  ENVIRONMENT: "local",
  PLAYWRIGHT_TEST_AUTH: "true",
  PLAYWRIGHT_TEST_AUTH_SECRET: "local-admin-test-auth-secret",
  APP_BILLING_UI_ORIGIN: "https://cloud.eliza.app",
  STRIPE_PLATFORM_BILLING_ORGANIZATION_ID: ids.org,
};
export let db: Client;
let close: () => Promise<void>;
export let token: string;
export let otherToken: string;
export let routes: Hono<AppEnv>;
export const provider = createAdminTestProvider();
export async function request<T>(
  suffix: string,
  input?: object,
  actorToken = token,
) {
  const response = await routes.request(
    `https://cloud.eliza.app/apps/${ids.app}${suffix}`,
    {
      method: input ? "POST" : "GET",
      headers: {
        cookie: `eliza-test-session=${actorToken}`,
        "content-type": "application/json",
        origin: "https://cloud.eliza.app",
        "X-Eliza-Request": "1",
      },
      ...(input ? { body: JSON.stringify(input) } : {}),
    },
    env,
  );
  return {
    response,
    body: (await response.json()) as {
      success: boolean;
      data: T;
      error?: string;
      code?: string;
    },
  };
}
async function migrate(tag: string) {
  const source = await readFile(
    new URL(
      `../../db/migrations/${tag}.sql`,
      import.meta.resolve("@/lib/services/generic-billing-admin"),
    ),
    "utf8",
  );
  for (const statement of source.split("--> statement-breakpoint"))
    if (statement.trim()) await db.query(statement.replaceAll('"public".', ""));
}

export async function setupAdminTest() {
  db = new Client({ connectionString: databaseUrl });
  await db.connect();
  await db.query(
    "CREATE EXTENSION IF NOT EXISTS btree_gist WITH SCHEMA public",
  );
  await db.query(`CREATE SCHEMA ${schema}`);
  await db.query(`SET search_path TO ${schema},public`);
  const { organizations } = await import("@/db/schemas/organizations");
  const { users } = await import("@/db/schemas/users");
  const empty = generateDrizzleJson({});
  const target = generateDrizzleJson({ organizations, users }, empty.id);
  for (const statement of await generateMigration(empty, target))
    await db.query(statement.replaceAll('"public".', ""));
  await db.query(
    "CREATE TABLE apps(id uuid PRIMARY KEY,organization_id uuid NOT NULL REFERENCES organizations(id),name text NOT NULL,is_active boolean NOT NULL DEFAULT true,is_approved boolean NOT NULL DEFAULT true,review_status text NOT NULL DEFAULT 'approved'); CREATE TABLE credit_transactions(id uuid PRIMARY KEY,organization_id uuid NOT NULL REFERENCES organizations(id),CONSTRAINT credit_transactions_id_org_idx UNIQUE(id,organization_id)); CREATE TABLE stripe_connect_accounts(id uuid PRIMARY KEY,user_id uuid NOT NULL REFERENCES users(id),stripe_connect_account_id text NOT NULL);",
  );
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
    "0417_app_billing_return_destination",
    "0390_app_billing_command_intents",
    "0391_app_billing_command_guards",
    "0392_app_billing_update_quotes",
    "0394_app_billing_merchant_identity",
    "0395_app_billing_provider_verifications",
    "0400_app_billing_membership_authority",
    "0414_app_billing_administrators",
    "0416_app_billing_refund_commands",
    "0418_billing_identity_anchors",
    "0419_billing_identity_backfill",
    "0420_billing_identity_references",
  ])
    await migrate(tag);
  await db.query(
    "INSERT INTO organizations(id,name,slug,credit_balance) VALUES($1,'Developer','developer',42),($2,'Other','other',0)",
    [ids.org, ids.otherOrg],
  );
  await db.query(
    "INSERT INTO users(id,organization_id,role,steward_user_id,is_active) VALUES($1,$2,'owner','admin-fixture',true),($3,$4,'owner','other-fixture',true)",
    [ids.user, ids.org, ids.otherUser, ids.otherOrg],
  );
  await db.query(
    "INSERT INTO apps(id,organization_id,name) VALUES($1,$2,'App')",
    [ids.app, ids.org],
  );
  await db.query(
    "INSERT INTO app_client_registrations(id,app_id,owner_organization_id,billing_environment,secret_hashes,redirect_uris,allowed_scopes) VALUES($1,$2,$3,'test','[]','[]','[]')",
    [ids.registration, ids.app, ids.org],
  );
  const session = await import("@/lib/auth/playwright-test-session");
  token = session.createPlaywrightTestSessionToken(ids.user, ids.org, env);
  otherToken = session.createPlaywrightTestSessionToken(
    ids.otherUser,
    ids.otherOrg,
    env,
  );
  const { GenericBillingAdminService } = await import(
    "@/lib/services/generic-billing-admin"
  );
  const { createAppBillingAdminHandlers, appBillingAdministrationBoundary } =
    await import("./_handlers");
  const { runWithCloudBindingsAsync } = await import(
    "@/lib/runtime/cloud-bindings"
  );
  const handlers = createAppBillingAdminHandlers(
    new GenericBillingAdminService(async (mode) => {
      if (mode) throw new Error("Live mode forbidden in test");
      return provider.stripe;
    }),
  );
  routes = new Hono<AppEnv>();
  routes.use("*", (c, next) => runWithCloudBindingsAsync(c.env, next));
  appBillingAdministrationBoundary(routes);
  routes.get("/apps/:id", handlers.overview);
  routes.get("/apps/:id/billing/admin", handlers.overview);
  routes.get("/apps/:id/billing/admin/paid-periods", handlers.paidPeriods);
  routes.get("/apps/:id/paid-periods", handlers.paidPeriods);
  for (const [suffix, handler] of [
    ["/merchants", handlers.registerMerchant],
    ["/merchants/onboarding", handlers.onboardMerchant],
    ["/merchants/refresh", handlers.refreshMerchant],
    ["/merchants/disconnect", handlers.disconnectMerchant],
    ["/plans", handlers.createPlan],
    ["/refunds", handlers.refund],
    ["/refunds/preview", handlers.previewRefund],
    ["/plans/adopt", handlers.adoptPlan],
    ["/plans/verify", handlers.verifyPlan],
    ["/plans/publish", handlers.publishPlan],
    ["/plans/retire", handlers.retirePlan],
    ["/operations/:commandId/recover", handlers.recoverOperation],
  ] as const) {
    const routeHandler: (context: AppContext) => Promise<Response> = handler;
    routes.post(`/apps/:id${suffix}`, routeHandler);
    routes.post(`/apps/:id/billing/admin${suffix}`, routeHandler);
  }
  close = (await import("@/db/client")).closeDatabaseConnectionsForTests;
}
export async function closeAdminTest() {
  if (close) await close();
  if (db) {
    await db.query(`DROP SCHEMA ${schema} CASCADE`);
    await db.end();
  }
}
