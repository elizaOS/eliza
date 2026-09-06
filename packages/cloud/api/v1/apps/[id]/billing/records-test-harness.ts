/** Starts isolated PostgreSQL and signed-session records routes with real billing repositories and controlled Stripe HTTP. */

import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { CloudApiClient } from "@elizaos/cloud-sdk";
import { AppBillingClient } from "@elizaos/cloud-sdk/app-billing";
import { generateDrizzleJson, generateMigration } from "drizzle-kit/api";
import type { Hono } from "hono";
import { Client } from "pg";
import Stripe from "stripe";
import type {
  BuyerBillingIdentity,
  GenericBillingRuntime,
} from "@/lib/services/generic-billing-runtime";
import { createRuntimeStripeFixture } from "@/lib/services/generic-billing-runtime.stripe-fixture";
import type { AppEnv } from "@/types/cloud-worker-env";

export const postgresUrl = process.env.APP_BILLING_TEST_POSTGRES_URL;
const schema = `app_records_${randomUUID().replaceAll("-", "_")}`;
if (postgresUrl) {
  const repositoryUrl = new URL(postgresUrl);
  repositoryUrl.searchParams.set("options", `-c search_path=${schema},public`);
  process.env.DATABASE_URL = repositoryUrl.toString();
  process.env.TEST_DATABASE_URL = repositoryUrl.toString();
}
process.env.LOCAL_PG_POOL_MAX = "4";
process.env.NODE_ENV ||= "test";
process.env.APP_BILLING_UI_ORIGIN = "https://cloud.example.test";
process.env.CACHE_BACKEND = "memory";
export let db: Client;
let close: typeof import("@/db/client").closeDatabaseConnectionsForTests;
let authority: typeof import("@/db/repositories/app-subscription-authority").appSubscriptionAuthorityRepository;
let runtime: GenericBillingRuntime;
const fixture = createRuntimeStripeFixture();
export const org = randomUUID();
export const merchant = randomUUID();

export async function buyer(): Promise<{
  identity: BuyerBillingIdentity;
  scopeId: string;
  planId: string;
}> {
  const appId = randomUUID();
  const actorUserId = randomUUID();
  const planId = randomUUID();
  await db.query(
    "INSERT INTO users(id,organization_id,email_verified,steward_user_id) VALUES($1::uuid,$2,true,$1::uuid::text)",
    [actorUserId, org],
  );
  await db.query("INSERT INTO apps(id,organization_id) VALUES($1,$2)", [
    appId,
    org,
  ]);
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
  const scope = await authority.resolveScope({
    ...identity,
    merchantId: merchant,
  });
  return { identity, scopeId: scope.scopeId, planId };
}

export async function setupRecordsTest() {
  db = new Client({ connectionString: postgresUrl });
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
  await db.query(`CREATE TABLE webhook_events(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),event_id text NOT NULL UNIQUE,provider text NOT NULL,event_type text,payload_hash text NOT NULL,source_ip text,processed_at timestamp NOT NULL DEFAULT now(),event_timestamp timestamp);
      CREATE TABLE apps(id uuid PRIMARY KEY,name text NOT NULL DEFAULT 'Independent app',organization_id uuid NOT NULL REFERENCES organizations(id),is_active boolean NOT NULL DEFAULT true,is_approved boolean NOT NULL DEFAULT true,review_status text NOT NULL DEFAULT 'approved');
      CREATE TABLE credit_transactions(id uuid PRIMARY KEY,organization_id uuid NOT NULL REFERENCES organizations(id),CONSTRAINT credit_transactions_id_org_idx UNIQUE(id,organization_id));`);
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
    "0396_app_billing_notification_endpoints",
    "0397_app_subscription_outbox_delivery",
    "0398_app_billing_webhook_recovery",
    "0399_app_billing_checkout_expiry",
    "0400_app_billing_membership_authority",
    "0401_app_billing_seat_mutations",
    "0402_app_billing_application_slots",
    "0414_app_billing_administrators",
    "0418_billing_identity_anchors",
    "0419_billing_identity_backfill",
    "0420_billing_identity_references",
  ]) {
    const migration = await readFile(
      new URL(
        `../../db/migrations/${tag}.sql`,
        import.meta.resolve("@/lib/services/generic-billing-runtime"),
      ),
      "utf8",
    );
    for (const statement of migration.split("--> statement-breakpoint"))
      if (statement.trim())
        await db.query(statement.replaceAll('"public".', ""));
  }
  await db.query(
    "INSERT INTO organizations(id,name,slug,stripe_customer_id) VALUES($1,'Developer','records-developer','cus_infrastructure')",
    [org],
  );
  await db.query(
    "INSERT INTO billing_merchants(id,organization_id,provider_account_key,stripe_account_id,livemode,enabled) VALUES($1,$2,'acct_runtime','acct_runtime',false,true)",
    [merchant, org],
  );
  close = (await import("@/db/client")).closeDatabaseConnectionsForTests;
  authority = (await import("@/db/repositories/app-subscription-authority"))
    .appSubscriptionAuthorityRepository;
  const { appBillingProviderBindings } = await import(
    "@/db/repositories/app-billing-provider-bindings"
  );
  const { createGenericBillingProvider } = await import(
    "@/lib/services/generic-billing-provider"
  );
  const { GenericBillingRuntime } = await import(
    "@/lib/services/generic-billing-runtime"
  );
  runtime = new GenericBillingRuntime(async (merchantId, livemode) => {
    if (merchantId !== merchant || livemode)
      throw new Error("Unexpected runtime merchant");
    return createGenericBillingProvider(
      fixture.stripe,
      {
        merchantId,
        kind: "connected",
        stripeAccountId: "acct_runtime",
        livemode,
      },
      appBillingProviderBindings,
    );
  });
  await setupRoutes();
}
export async function closeRecordsTest() {
  if (close) await close();
  if (db) {
    await db.query(`DROP SCHEMA ${schema} CASCADE`);
    await db.end();
  }
}

export const env = {
  NODE_ENV: "test",
  ENVIRONMENT: "local",
  PLAYWRIGHT_TEST_AUTH: "true",
  PLAYWRIGHT_TEST_AUTH_SECRET: "local-records-test-auth-secret",
  APP_BILLING_ENVIRONMENT: "test",
};
export let routes: Hono<AppEnv>;
export const invoiceFixture = {
  wrongCustomer: false,
  repeatCursor: false,
  fail: false,
  beforeResponse: null as (() => Promise<void>) | null,
  requests: [] as {
    customer: string | null;
    subscription: string | null;
    merchant: string | null;
  }[],
};

function invoice(id: string, customer: string, subscription: string) {
  return {
    id,
    object: "invoice",
    livemode: false,
    customer,
    subscription,
    hosted_invoice_url: `https://invoice.stripe.com/i/${id}`,
    charge: null,
    payment_intent: null,
    status: "paid",
    paid: true,
    paid_out_of_band: false,
    amount_paid: 3000,
    amount_due: 0,
    billing_reason: "subscription_cycle",
    subtotal: 3000,
    subtotal_excluding_tax: 3000,
    total: 3000,
    tax: 0,
    total_discount_amounts: [],
    currency: "usd",
    period_start: 1700000000,
    period_end: 1702592000,
  };
}

async function setupRoutes() {
  const { createGenericBillingProvider } = await import(
    "@/lib/services/generic-billing-provider"
  );
  const { appBillingProviderBindings } = await import(
    "@/db/repositories/app-billing-provider-bindings"
  );
  const { GenericBillingRecordsService } = await import(
    "@/lib/services/generic-billing-records"
  );
  const stripe = new Stripe("sk_test_controlled_records", {
    maxNetworkRetries: 0,
    httpClient: Stripe.createFetchHttpClient(
      Object.assign(
        async (
          input: Parameters<typeof fetch>[0],
          init?: Parameters<typeof fetch>[1],
        ) => {
          const url = new URL(String(input));
          if (url.pathname === "/v1/balance")
            return Response.json({ livemode: false });
          if (url.pathname.startsWith("/v1/customers/"))
            return Response.json({
              id: url.pathname.split("/")[3],
              object: "customer",
              livemode: false,
              metadata: {},
            });
          if (url.pathname === "/v1/invoices") {
            const customer = url.searchParams.get("customer");
            const subscription = url.searchParams.get("subscription");
            invoiceFixture.requests.push({
              customer,
              subscription,
              merchant: new Headers(init?.headers).get("Stripe-Account"),
            });
            if (!customer || !subscription)
              throw new Error("Invoice query omitted persisted scope");
            if (invoiceFixture.beforeResponse)
              await invoiceFixture.beforeResponse();
            if (invoiceFixture.fail)
              return Response.json(
                {
                  error: { type: "api_error", message: "Invoices unavailable" },
                },
                { status: 503 },
              );
            const start =
              url.searchParams.get("starting_after") &&
              !invoiceFixture.repeatCursor
                ? 2
                : 1;
            return Response.json({
              object: "list",
              has_more: start === 1,
              data: [
                invoice(
                  `in_${subscription.replace("sub_", "")}${start}`,
                  invoiceFixture.wrongCustomer ? "cus_foreign" : customer,
                  subscription,
                ),
              ],
            });
          }
          if (url.pathname.startsWith("/v1/invoices/")) {
            const id = url.pathname.split("/")[3]!;
            const subscription = `sub_${id.replace(/^in_/u, "").replace(/[12]$/u, "")}`;
            const row = await db.query(
              "SELECT stripe_customer_id FROM billing_subscriptions WHERE stripe_subscription_id=$1",
              [subscription],
            );
            return Response.json(
              invoice(
                id,
                row.rows[0]?.stripe_customer_id ?? "cus_foreign",
                subscription,
              ),
            );
          }
          throw new Error(
            `Unexpected records provider request ${url.pathname}`,
          );
        },
        { preconnect: fetch.preconnect },
      ),
    ),
  });
  const service = new GenericBillingRecordsService(
    undefined,
    async (merchantId, livemode) => {
      if (merchantId !== merchant || livemode)
        throw new Error("Records selected a different merchant or environment");
      return createGenericBillingProvider(
        stripe,
        {
          merchantId,
          kind: "connected",
          stripeAccountId: "acct_runtime",
          livemode,
        },
        appBillingProviderBindings,
      );
    },
  );
  const { createAppBillingRecordsHandlers } = await import(
    "./_records-handlers"
  );
  const { billingRoute, getBillingCatalog, getBillingSnapshot } = await import(
    "./_handlers"
  );
  const { runWithCloudBindingsAsync } = await import(
    "@/lib/runtime/cloud-bindings"
  );
  const { default: administrators } = await import(
    "./accounts/[accountId]/administrators/route"
  );
  const { default: applicationProduct } = await import(
    "../../../billing/application-slots/[slotKey]/route"
  );
  const handlers = createAppBillingRecordsHandlers(service);
  routes = billingRoute();
  routes.use("*", (c, next) => runWithCloudBindingsAsync(c.env, next));
  const path =
    "/api/v1/apps/:id/billing/accounts/:accountId/subscriptions/:family";
  routes.route(
    "/api/v1/apps/:id/billing/accounts/:accountId/administrators",
    administrators,
  );
  routes.route(
    "/api/v1/billing/application-slots/:slotKey",
    applicationProduct,
  );
  routes.get("/api/v1/apps/:id/billing/catalog", getBillingCatalog);
  routes.get(path, getBillingSnapshot);
  routes.get(`${path}/seats`, handlers.listBillingSeats);
  routes.post(`${path}/seats`, handlers.assignBillingSeat);
  routes.post(`${path}/seats/:seatId/revoke`, handlers.revokeBillingSeat);
  routes.get(`${path}/invoices`, handlers.listBillingInvoices);
  routes.get(`${path}/usage`, handlers.listBillingUsage);
}

export async function sdk(
  identity: BuyerBillingIdentity,
  live = false,
  options: { clientId?: string; omitCsrfMarker?: boolean } = {},
) {
  const session = await import("@/lib/auth/playwright-test-session");
  const token = session.createPlaywrightTestSessionToken(
    identity.actorUserId,
    org,
    env,
  );
  const fetchImpl = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      if (options.omitCsrfMarker) {
        headers.delete("X-Eliza-Request");
        headers.set("Content-Type", "text/plain");
      }
      return routes.request(
        input,
        { ...init, headers },
        {
          ...env,
          APP_BILLING_ENVIRONMENT: live ? "live" : "test",
        },
      );
    },
    { preconnect: fetch.preconnect },
  );
  return new AppBillingClient(
    new CloudApiClient("https://cloud.eliza.app/api/v1", undefined, {
      fetchImpl,
      defaultHeaders: {
        cookie: `eliza-test-session=${token}`,
        origin: "https://cloud.eliza.app",
        ...(!options.omitCsrfMarker ? { "X-Eliza-Request": "1" } : {}),
      },
    }),
    identity.appId,
    { clientId: options.clientId },
  );
}

export async function trial(quantity = 1) {
  const item = await buyer();
  const result = await runtime.prepare(item.identity, {
    idempotencyKey: randomUUID(),
    expectedSubscriptionRevision: null,
    payload: {
      version: 1,
      domain: "buyer",
      action: "trial",
      planRevisionId: item.planId,
      quantity,
    },
  });
  if (result.status !== "succeeded")
    throw new Error(`Trial fixture did not finalize: ${result.status}`);
  return { ...item, client: await sdk(item.identity) };
}

export async function member(
  identity: BuyerBillingIdentity,
  environment: "all" | "test" | "live" = "test",
  role: "member" | "administrator" = "member",
) {
  const userId = randomUUID();
  await db.query(
    "INSERT INTO users(id,organization_id,email_verified,steward_user_id) VALUES($1::uuid,$2,true,$1::uuid::text)",
    [userId, org],
  );
  await db.query(
    "INSERT INTO app_billing_members(app_id,billing_account_id,user_id,role,livemode) VALUES($1,$2,$3,$4,$5)",
    [
      identity.appId,
      identity.billingAccountId,
      userId,
      role,
      environment === "all" ? null : environment === "live",
    ],
  );
  return userId;
}
