/** Real route/session authority and primary PGlite membership; financial adapters only record local effects. */
import { afterAll, beforeAll, beforeEach, expect, mock, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { organizations } from "@elizaos/cloud-shared/db/schemas/organizations";
import { userIdentities } from "@elizaos/cloud-shared/db/schemas/user-identities";
import { users } from "@elizaos/cloud-shared/db/schemas/users";
import { createPlaywrightTestSessionToken } from "@elizaos/cloud-shared/lib/auth/playwright-test-session";
import type {
  AppEnv,
  AuthedUser,
} from "@elizaos/cloud-shared/types/cloud-worker-env";
import { generateDrizzleJson, generateMigration } from "drizzle-kit/api";
import { relations } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { Hono } from "hono";
import type Stripe from "stripe";

const pg = new PGlite();
const usersRelations = relations(users, ({ one }) => ({
  organization: one(organizations, {
    fields: [users.organization_id],
    references: [organizations.id],
  }),
}));
const database = drizzle(pg, {
  schema: { organizations, users, userIdentities, usersRelations },
});
mock.module("@elizaos/cloud-shared/db/helpers", () => ({
  db: database,
  dbRead: database,
  dbWrite: database,
  writeTransaction: database.transaction.bind(database),
  getDbConnectionInfo: () => ({}),
}));
const effects: string[] = [];
let checkoutParameters: Stripe.Checkout.SessionCreateParams | undefined;
const org = randomUUID(),
  otherOrg = randomUUID(),
  userId = randomUUID();
let afterPriceRead: (() => Promise<void>) | undefined;
let cached: AuthedUser;
let route: Hono<AppEnv>;
const env = {
  NODE_ENV: "test",
  ENVIRONMENT: "local",
  PLAYWRIGHT_TEST_AUTH: "true",
  PLAYWRIGHT_TEST_AUTH_SECRET: "billing-route-matrix-local-secret",
  NEXT_PUBLIC_APP_URL: "https://cloud.eliza.app",
  STRIPE_CURRENCY: "usd",
};
mock.module(
  "@elizaos/cloud-shared/lib/middleware/rate-limit-hono-cloudflare",
  () => ({
    rateLimit: () => async (_c: unknown, next: () => Promise<void>) => next(),
    moneyRateLimit: () => async (_c: unknown, next: () => Promise<void>) =>
      next(),
    RateLimitPresets: { STRICT: {}, STANDARD: {} },
  }),
);
mock.module("@elizaos/cloud-shared/lib/services/auto-top-up", () => ({
  autoTopUpService: {
    executeAutoTopUpForOrganization: async () => {
      effects.push("topup");
      return { success: true, amount: 5 };
    },
  },
}));
mock.module(
  "@elizaos/cloud-shared/lib/services/stripe-customer-authority",
  () => ({
    stripeCustomerAuthorityService: {
      ensure: async () => {
        effects.push("customer");
        return "cus_test";
      },
    },
  }),
);
mock.module(
  "@elizaos/cloud-shared/lib/services/stripe-checkout-orders",
  () => ({
    stripeCheckoutOrdersService: {
      create: async () => {
        effects.push("order");
        return {
          id: "order_test",
          status: "created",
          stripe_customer_id: "cus_test",
        };
      },
      markProviderStarted: async () => {
        effects.push("provider-started");
      },
      bindSession: async () => {
        effects.push("bind-session");
      },
    },
  }),
);
mock.module(
  "@elizaos/cloud-shared/lib/services/subscription-customer-portal",
  () => ({
    // The portal adapter re-runs the route's billing-manager revalidation before its provider effect.
    createSubscriptionPortalSession: async (
      input: { organizationId: string },
      reauthorize: () => Promise<void>,
    ) => {
      await reauthorize();
      effects.push(`portal:${input.organizationId}`);
      return { url: "https://billing.stripe.com/p/session/test" };
    },
  }),
);
mock.module(
  "@elizaos/cloud-shared/lib/services/subscription-command-status",
  () => ({
    listPendingOrganizationPlanChangeCommands: async () => {
      await afterPriceRead?.();
      return {
        observedAt: new Date().toISOString(),
        items: [],
        nextCursor: null,
      };
    },
  }),
);
mock.module(
  "@elizaos/cloud-shared/lib/services/organization-downgrade-command",
  () => ({
    confirmOrganizationSubscriptionDowngrade: async (
      input: { organizationId: string; actorId: string },
      reauthorize: () => Promise<void>,
    ) => {
      await afterPriceRead?.();
      await reauthorize();
      effects.push(`downgrade:${input.organizationId}:${input.actorId}`);
      return { commandId: "original", status: "OUTCOME_UNKNOWN" };
    },
  }),
);
mock.module("@elizaos/cloud-shared/lib/stripe", () => ({
  isStripeConfigured: () => true,
  requireStripe: () => ({
    prices: {
      retrieve: async () => {
        await afterPriceRead?.();
        return {
          id: "price_test",
          active: true,
          currency: "usd",
          unit_amount: 500,
        };
      },
    },
    checkout: {
      sessions: {
        create: async (parameters: Stripe.Checkout.SessionCreateParams) => {
          checkoutParameters = parameters;
          effects.push("stripe");
          return { id: "cs_test", url: "https://checkout.stripe.test/local" };
        },
      },
    },
  }),
}));
beforeAll(async () => {
  const empty = generateDrizzleJson({});
  for (const statement of await generateMigration(
    empty,
    generateDrizzleJson({ organizations, users, userIdentities }, empty.id),
  ))
    await pg.exec(statement.replaceAll('"public".', ""));
  await pg.query(
    "INSERT INTO organizations(id,name,slug) VALUES ($1,'Local','local'),($2,'Other','other')",
    [org, otherOrg],
  );
  await pg.query(
    "INSERT INTO users(id,organization_id,steward_user_id,role) VALUES ($1,$2,'subject_test','owner')",
    [userId, org],
  );
  route = new Hono<AppEnv>();
  // Hydrated middleware context is deliberately stale in negative cases. The
  // real guard must verify the signed cookie and re-read primary membership.
  route.use("*", async (c, next) => {
    c.set("user", cached);
    c.set("authMethod", "session");
    await next();
  });
  route.route(
    "/checkout",
    (await import("../stripe/create-checkout-session/route")).default,
  );
  route.route("/topup", (await import("../auto-top-up/trigger/route")).default);
  route.route(
    "/plan-commands",
    (await import("../v1/subscriptions/plan-change/commands/route")).default,
  );
  route.route(
    "/downgrade",
    (await import("../v1/subscriptions/downgrade/confirm/route")).default,
  );
  route.route(
    "/portal",
    (await import("../v1/subscriptions/portal/route")).default,
  );
}, 30_000);
beforeEach(async () => {
  effects.length = 0;
  checkoutParameters = undefined;
  afterPriceRead = undefined;
  await pg.query(
    "UPDATE users SET role='owner',organization_id=$1,is_active=true WHERE id=$2",
    [org, userId],
  );
  cached = {
    id: userId,
    created_at: new Date(),
    email: null,
    email_verified: true,
    organization_id: org,
    organization: { id: org, name: "Local", is_active: true },
    role: "owner",
    steward_id: "subject_test",
    is_active: true,
    is_anonymous: false,
    wallet_address: null,
  };
});
afterAll(async () => {
  await pg.close();
});
function request(
  path: string,
  headers: Record<string, string> = {},
  tokenOrg = org,
  body?: Record<string, unknown>,
) {
  const token = createPlaywrightTestSessionToken(userId, tokenOrg, env);
  return route.request(
    `https://cloud.eliza.app/${path}`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: `eliza-test-session=${token}`,
        "idempotency-key": randomUUID(),
        ...headers,
      },
      body: JSON.stringify(
        body ??
          (path === "downgrade"
            ? { quoteId: randomUUID(), idempotencyKey: randomUUID() }
            : { amount: 5 }),
      ),
    },
    env,
  );
}
for (const path of ["checkout", "topup", "portal", "downgrade"]) {
  for (const role of ["owner", "admin"])
    test(`${path}: current ${role} reaches its payment adapter`, async () => {
      cached.role = role;
      await pg.query("UPDATE users SET role=$1 WHERE id=$2", [role, userId]);
      expect((await request(path)).status).toBe(200);
      expect(effects).toContain(
        path === "checkout"
          ? "stripe"
          : path === "portal"
            ? `portal:${org}`
            : path === "downgrade"
              ? `downgrade:${org}:${userId}`
              : "topup",
      );
    });
  for (const role of ["member", "guest"])
    test(`${path}: ${role} has no financial effects`, async () => {
      cached.role = role;
      await pg.query("UPDATE users SET role=$1 WHERE id=$2", [role, userId]);
      expect((await request(path)).status).toBe(403);
      expect(effects).toEqual([]);
    });
  test(`${path}: stale owner cannot survive primary downgrade`, async () => {
    await pg.query("UPDATE users SET role='member' WHERE id=$1", [userId]);
    expect((await request(path)).status).toBe(403);
    expect(effects).toEqual([]);
  });
  test(`${path}: primary tenant transfer cannot charge old tenant`, async () => {
    await pg.query("UPDATE users SET organization_id=$1 WHERE id=$2", [
      otherOrg,
      userId,
    ]);
    expect((await request(path)).status).toBe(403);
    expect(effects).toEqual([]);
  });
  test(`${path}: wrong-tenant signed cookie has no financial effects`, async () => {
    expect((await request(path, {}, otherOrg)).status).toBe(401);
    expect(effects).toEqual([]);
  });
  for (const header of [
    { authorization: "Bearer eliza_general_key" },
    { "x-api-key": "eliza_general_key" },
  ] as Record<string, string>[])
    test(`${path}: explicit API key cannot borrow owner session`, async () => {
      expect((await request(path, header)).status).toBe(401);
      expect(effects).toEqual([]);
    });
}

test("checkout: a retired credit pack id is rejected before payment effects (#22963)", async () => {
  const response = await request("checkout", {}, org, {
    creditPackId: randomUUID(),
  });
  expect(response.status).toBe(400);
  expect(((await response.json()) as { error?: string }).error).toMatch(
    /Credit packs are retired/,
  );
  expect(effects).toEqual([]);
});
test("checkout: hardware checkout retains existing member authority", async () => {
  cached.role = "member";
  await pg.query("UPDATE users SET role='member' WHERE id=$1", [userId]);
  expect(
    (await request("checkout", {}, org, { hardwareSku: "elizaos-usb" })).status,
  ).toBe(200);
  expect(effects).toContain("stripe");
});

for (const [amount, cents] of [
  [5, 500],
  [5.15, 515],
  [19.99, 1999],
  [1000, 100000],
]) {
  test(`checkout accepts exact decimal cents for ${amount}`, async () => {
    const response = await request("checkout", {}, org, { amount });
    expect(response.status).toBe(200);
    expect(checkoutParameters?.line_items?.[0]?.price_data?.unit_amount).toBe(
      cents,
    );
  });
}
for (const amount of [1, 4.99, 1000.01, 5.001, 5.150000000000001]) {
  test(`checkout rejects ${amount} before payment effects`, async () => {
    const response = await request("checkout", {}, org, { amount });
    expect(response.status).toBe(400);
    expect(effects).toEqual([]);
  });
}

test("downgrade: manager loss during confirmation is re-read from primary before an effect", async () => {
  afterPriceRead = async () => {
    await pg.query("UPDATE users SET role='member' WHERE id=$1", [userId]);
  };
  const response = await request("downgrade");
  expect(response.status).toBe(403);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(effects).toEqual([]);
});

function planRequest(headers: Record<string, string> = {}, tokenOrg = org) {
  const token = createPlaywrightTestSessionToken(userId, tokenOrg, env);
  return route.request(
    "https://cloud.eliza.app/plan-commands?limit=5",
    { headers: { cookie: `eliza-test-session=${token}`, ...headers } },
    env,
  );
}
for (const role of ["owner", "admin", "member", "guest"])
  test(`plan discovery: primary ${role} authorization`, async () => {
    cached.role = role;
    await pg.query("UPDATE users SET role=$1 WHERE id=$2", [role, userId]);
    const response = await planRequest();
    expect(response.status).toBe(
      role === "owner" || role === "admin" ? 200 : 403,
    );
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(effects).toEqual([]);
  });
test("plan discovery: primary role loss after reading discards the result", async () => {
  afterPriceRead = async () => {
    await pg.query("UPDATE users SET role='member' WHERE id=$1", [userId]);
  };
  expect((await planRequest()).status).toBe(403);
  expect(effects).toEqual([]);
});
test("plan discovery: stale owner and tenant transfer cannot borrow the cached identity", async () => {
  await pg.query("UPDATE users SET role='member' WHERE id=$1", [userId]);
  expect((await planRequest()).status).toBe(403);
  await pg.query(
    "UPDATE users SET role='owner',organization_id=$1 WHERE id=$2",
    [otherOrg, userId],
  );
  expect((await planRequest()).status).toBe(403);
});
test("plan discovery: wrong-tenant cookie and explicit API keys cannot borrow a session", async () => {
  expect((await planRequest({}, otherOrg)).status).toBe(401);
  for (const header of [
    { authorization: "Bearer eliza_general_key" },
    { "x-api-key": "eliza_general_key" },
  ] as Record<string, string>[])
    expect((await planRequest(header)).status).toBe(401);
  expect(effects).toEqual([]);
});
