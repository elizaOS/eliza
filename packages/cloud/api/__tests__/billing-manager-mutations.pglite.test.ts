/** Real route/session authority and primary PGlite membership; financial adapters only record local effects. */
import { afterAll, beforeAll, beforeEach, expect, mock, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { generateDrizzleJson, generateMigration } from "drizzle-kit/api";
import { relations } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { Hono } from "hono";
import { organizations } from "@/db/schemas/organizations";
import { userIdentities } from "@/db/schemas/user-identities";
import { users } from "@/db/schemas/users";
import { createPlaywrightTestSessionToken } from "@/lib/auth/playwright-test-session";
import type { AppEnv, AuthedUser } from "@/types/cloud-worker-env";

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
mock.module("@/db/helpers", () => ({
  db: database,
  dbRead: database,
  dbWrite: database,
  writeTransaction: database.transaction.bind(database),
  getDbConnectionInfo: () => ({}),
}));
const effects: string[] = [];
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
mock.module("@/lib/middleware/rate-limit-hono-cloudflare", () => ({
  moneyRateLimit: () => async (_c: unknown, next: () => Promise<void>) =>
    next(),
  RateLimitPresets: { STRICT: {} },
}));
mock.module("@/lib/services/auto-top-up", () => ({
  autoTopUpService: {
    executeAutoTopUpForOrganization: async () => {
      effects.push("topup");
      return { success: true, amount: 5 };
    },
  },
}));
mock.module("@/lib/services/credits", () => ({
  creditsService: {
    getCreditPackById: async () => ({
      is_active: true,
      stripe_price_id: "price_test",
      price_cents: 500,
      credits: 5,
    }),
  },
}));
mock.module("@/lib/services/stripe-customer-authority", () => ({
  stripeCustomerAuthorityService: {
    ensure: async () => {
      effects.push("customer");
      return "cus_test";
    },
  },
}));
mock.module("@/lib/services/stripe-checkout-orders", () => ({
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
}));
mock.module("@/lib/stripe", () => ({
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
        create: async () => {
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
}, 30_000);
beforeEach(async () => {
  effects.length = 0;
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
  body: Record<string, unknown> = { amount: 5 },
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
      body: JSON.stringify(body),
    },
    env,
  );
}
for (const path of ["checkout", "topup"]) {
  for (const role of ["owner", "admin"])
    test(`${path}: current ${role} reaches its payment adapter`, async () => {
      cached.role = role;
      await pg.query("UPDATE users SET role=$1 WHERE id=$2", [role, userId]);
      expect((await request(path)).status).toBe(200);
      expect(effects).toContain(path === "checkout" ? "stripe" : "topup");
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

test("checkout: primary downgrade during price lookup prevents durable payment effects", async () => {
  afterPriceRead = async () => {
    await pg.query("UPDATE users SET role='member' WHERE id=$1", [userId]);
  };
  expect(
    (await request("checkout", {}, org, { creditPackId: randomUUID() })).status,
  ).toBe(403);
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
