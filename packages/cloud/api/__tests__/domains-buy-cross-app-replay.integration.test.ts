/**
 * Cross-app replay of a completed domain-buy claim (F4) — REAL route handler +
 * REAL idempotency/credits/managed-domains services + PGlite.
 *
 * The idempotency claim key is org+domain (intentionally NOT app-scoped, so the
 * org can never be double-charged for one domain). The bug: the completed-claim
 * replay branch returned the cached `response_body` without comparing the
 * requested app to `claim.app_id` — so within the 24h TTL, org buys `d.com` for
 * app A, then buys `d.com` for app B, and B's caller got A's cached success
 * while B was never assigned the domain.
 *
 * This suite drives the real route against PGlite (real claim rows, real credit
 * ledger, real managed_domains reassignment). Only the external seams are
 * stubbed: auth, the Cloudflare registrar/DNS HTTP clients, and — mirroring
 * `credits-deduct-guard.test.ts` — the fire-and-forget post-debit notifications
 * (email/auto-top-up/waifu), which are not the code under test.
 *
 * Self-skips LOUDLY if PGlite/pushSchema is unavailable.
 */

import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";

const AMBIENT_DATABASE_URL = process.env.DATABASE_URL ?? "";
const CAN_USE_ISOLATED_PGLITE =
  AMBIENT_DATABASE_URL === "" || AMBIENT_DATABASE_URL.startsWith("pglite");
process.env.DATABASE_URL ||= "pglite://memory";
process.env.NODE_ENV ||= "test";
process.env.MOCK_REDIS = "1";

import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { closeDatabaseConnectionsForTests, dbRead, dbWrite } from "@/db/client";
// Via cloud-shared so `drizzle-kit` (its devDependency) resolves at runtime.
import { pushSchema } from "@/db/push-schema-for-tests";
import { apiKeys } from "@/db/schemas/api-keys";
import { appDomains } from "@/db/schemas/app-domains";
import {
  appDeploymentStatusEnum,
  appReviewStatusEnum,
  apps,
  userDatabaseStatusEnum,
} from "@/db/schemas/apps";
import { containers } from "@/db/schemas/containers";
import { creditTransactions } from "@/db/schemas/credit-transactions";
import { domainPurchaseIdempotency } from "@/db/schemas/domain-purchase-idempotency";
import {
  domainModerationStatusEnum,
  domainNameserverModeEnum,
  domainRegistrarEnum,
  domainResourceTypeEnum,
  domainStatusEnum,
  managedDomains,
} from "@/db/schemas/managed-domains";
import { organizations } from "@/db/schemas/organizations";
import { userCharacters } from "@/db/schemas/user-characters";
import {
  mcpPricingTypeEnum,
  mcpStatusEnum,
  userMcps,
} from "@/db/schemas/user-mcps";
import { users } from "@/db/schemas/users";
import * as realAuth from "@/lib/auth/workers-hono-auth";
import * as realAutoTopUp from "@/lib/services/auto-top-up";
import * as realDns from "@/lib/services/cloudflare-dns";
import * as realRegistrar from "@/lib/services/cloudflare-registrar";
import { computeDomainPrice } from "@/lib/services/domain-pricing";
import * as realEmail from "@/lib/services/email";
import * as realWaifu from "@/lib/services/waifu-webhook";
import type { AppEnv } from "@/types/cloud-worker-env";

const ENV = {
  NODE_ENV: "test",
  MOCK_REDIS: "1",
} as unknown as AppEnv["Bindings"];

const PGLITE_TIMEOUT = 180_000;
let pgliteReady = true;

const DOMAIN = "cross-app-replay-f4.com";
const WHOLESALE_USD_CENTS = 1000;
const SEED_BALANCE = 100;

// ---- external seams (auth + Cloudflare HTTP clients) ----------------------

let authOrgId = "";
let authUserId = "";
const requireUserOrApiKeyWithOrg = mock(async () => ({
  id: authUserId,
  email: "buyer@example.com",
  organization_id: authOrgId,
  organization: { id: authOrgId, name: "Buyer Org", is_active: true },
  is_active: true,
  role: "user",
  steward_id: null,
  wallet_address: null,
  is_anonymous: false,
}));

const checkAvailability = mock(async () => ({
  available: true,
  priceUsdCents: WHOLESALE_USD_CENTS,
  renewalUsdCents: WHOLESALE_USD_CENTS,
  currency: "USD",
}));
const registerDomain = mock(async () => ({ registrationId: "reg-1" }));
const getRegisteredDomain = mock(async () => ({
  domain: DOMAIN,
  zoneId: "zone-1",
  expiresAt: "2027-01-01T00:00:00Z",
  autoRenew: true,
}));

mock.module("@/lib/auth/workers-hono-auth", () => ({
  ...realAuth,
  requireUserOrApiKeyWithOrg,
}));
mock.module("@/lib/services/cloudflare-registrar", () => ({
  ...realRegistrar,
  cloudflareRegistrarService: {
    checkAvailability,
    registerDomain,
    getRegisteredDomain,
  },
}));
mock.module("@/lib/services/cloudflare-dns", () => ({
  ...realDns,
  cloudflareDnsService: {
    listRecords: mock(async () => []),
    createRecord: mock(async () => ({})),
    updateRecord: mock(async () => ({})),
  },
}));

// Fire-and-forget post-debit notifications (NOT the code under test) — same
// stubs as credits-deduct-guard.test.ts so the suite stays deterministic and
// offline. The debit/refund SQL itself runs entirely real against PGlite.
mock.module("@/lib/services/email", () => ({
  emailService: { sendLowCreditsEmail: mock(async () => false) },
}));
mock.module("@/lib/services/waifu-webhook", () => ({
  resolveWaifuWebhookTarget: mock(() => null),
  classifyCreditBalance: mock(() => null),
  emitWaifuCreditWebhook: mock(async () => undefined),
}));
mock.module("@/lib/services/auto-top-up", () => ({
  autoTopUpService: { executeAutoTopUp: mock(async () => undefined) },
}));

// Import the route AFTER the seam mocks (it binds them at module-eval time).
const { default: buyRoute } = await import("../v1/apps/[id]/domains/buy/route");

const api = new Hono<AppEnv>();
api.route("/api/v1/apps/:id/domains/buy", buyRoute);

afterAll(async () => {
  // Restore ALL mocked modules — bun's mock.module is process-global, so a
  // leaked seam mock corrupts sibling suites in a combined run.
  mock.module("@/lib/auth/workers-hono-auth", () => realAuth);
  mock.module("@/lib/services/cloudflare-registrar", () => realRegistrar);
  mock.module("@/lib/services/cloudflare-dns", () => realDns);
  mock.module("@/lib/services/email", () => realEmail);
  mock.module("@/lib/services/waifu-webhook", () => realWaifu);
  mock.module("@/lib/services/auto-top-up", () => realAutoTopUp);
  await closeDatabaseConnectionsForTests();
});

// ---- world -----------------------------------------------------------------

let orgId = "";
let appAId = "";
let appBId = "";

async function seedWorld() {
  const [org] = await dbWrite
    .insert(organizations)
    .values({
      name: "Buyer Org",
      slug: `buyer-${Math.random().toString(36).slice(2, 8)}`,
      credit_balance: String(SEED_BALANCE),
    })
    .returning();
  const [user] = await dbWrite
    .insert(users)
    .values({ steward_user_id: `buyer-u-${org.id}`, organization_id: org.id })
    .returning();
  const [appA] = await dbWrite
    .insert(apps)
    .values({
      name: "App A",
      slug: `app-a-${org.id.slice(0, 8)}`,
      organization_id: org.id,
      created_by_user_id: user.id,
      app_url: "https://a.apps.elizacloud.ai",
    })
    .returning();
  const [appB] = await dbWrite
    .insert(apps)
    .values({
      name: "App B",
      slug: `app-b-${org.id.slice(0, 8)}`,
      organization_id: org.id,
      created_by_user_id: user.id,
      app_url: "https://b.apps.elizacloud.ai",
    })
    .returning();
  orgId = org.id;
  authOrgId = org.id;
  authUserId = user.id;
  appAId = appA.id;
  appBId = appB.id;
}

async function buy(appId: string): Promise<Response> {
  return api.request(
    `/api/v1/apps/${appId}/domains/buy`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ domain: DOMAIN }),
    },
    ENV,
  );
}

async function domainRow() {
  const row = await dbRead.query.managedDomains.findFirst({
    where: eq(managedDomains.domain, DOMAIN),
  });
  if (!row) throw new Error(`managed_domains row missing for ${DOMAIN}`);
  return row;
}

async function domainPurchaseDebits() {
  const rows = await dbRead
    .select()
    .from(creditTransactions)
    .where(eq(creditTransactions.organization_id, orgId));
  return rows.filter(
    (r) =>
      (r.metadata as { type?: string; domain?: string }).type ===
        "domain_purchase" &&
      (r.metadata as { domain?: string }).domain === DOMAIN,
  );
}

async function orgBalance(): Promise<number> {
  const [org] = await dbRead
    .select()
    .from(organizations)
    .where(eq(organizations.id, orgId));
  return Number(org.credit_balance);
}

async function claimRow() {
  const [row] = await dbRead
    .select()
    .from(domainPurchaseIdempotency)
    .where(eq(domainPurchaseIdempotency.domain, DOMAIN));
  if (!row) throw new Error(`idempotency claim missing for ${DOMAIN}`);
  return row;
}

beforeAll(async () => {
  if (!CAN_USE_ISOLATED_PGLITE) {
    pgliteReady = false;
    return;
  }
  try {
    const schema = {
      organizations,
      users,
      apiKeys,
      apps,
      appDeploymentStatusEnum,
      appReviewStatusEnum,
      userDatabaseStatusEnum,
      creditTransactions,
      userCharacters,
      containers,
      userMcps,
      mcpPricingTypeEnum,
      mcpStatusEnum,
      managedDomains,
      domainRegistrarEnum,
      domainNameserverModeEnum,
      domainResourceTypeEnum,
      domainModerationStatusEnum,
      domainStatusEnum,
      appDomains,
      domainPurchaseIdempotency,
    };
    const { apply } = await pushSchema(schema as never, dbWrite as never);
    await apply();
    await seedWorld();
  } catch (error) {
    pgliteReady = false;
    console.error(
      "[domains-buy-cross-app-replay.test] PGlite/pushSchema unavailable — skipping.",
      error,
    );
  }
}, PGLITE_TIMEOUT);

// The three steps below are ONE sequential scenario (buy for A → buy for B →
// retry for A) sharing the seeded world and buy-1's cached claim on purpose:
// the bug only exists against a live completed claim within its TTL.

const totalUsdCents = computeDomainPrice(WHOLESALE_USD_CENTS).totalUsdCents;
let buy1Body: Record<string, unknown> = {};

describe("POST /apps/:id/domains/buy — completed-claim replay is app-scoped (F4)", () => {
  test("pglite applied (loud)", () => {
    expect(pgliteReady).toBe(true);
  });

  test("step 1: org buys the domain for app A → charged once, assigned to A, claim cached", async () => {
    if (!pgliteReady) return;

    const res = await buy(appAId);
    buy1Body = (await res.json()) as Record<string, unknown>;

    expect(res.status).toBe(200);
    expect(buy1Body.success).toBe(true);
    expect(buy1Body.domain).toBe(DOMAIN);
    expect(registerDomain).toHaveBeenCalledTimes(1);

    const domain = await domainRow();
    expect(domain.appId).toBe(appAId);
    expect(domain.organizationId).toBe(orgId);
    expect(domain.registrar).toBe("cloudflare");

    // Exactly one real debit on the ledger, and the balance moved by it.
    const debits = await domainPurchaseDebits();
    expect(debits).toHaveLength(1);
    expect(Number(debits[0].amount)).toBeCloseTo(-totalUsdCents / 100, 6);
    expect(await orgBalance()).toBeCloseTo(
      SEED_BALANCE - totalUsdCents / 100,
      6,
    );

    const claim = await claimRow();
    expect(claim.status).toBe("completed");
    expect(claim.app_id).toBe(appAId);
    expect(claim.response_body).toEqual(buy1Body);
  });

  test("step 2 (regression): same org buys the SAME domain for app B within the claim TTL → reassigned to B, NOT a replay of A's success, no second charge", async () => {
    if (!pgliteReady) return;

    const res = await buy(appBId);
    const body = (await res.json()) as Record<string, unknown>;

    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
    // The owned-domain reassign outcome, not app A's cached fresh-purchase body.
    expect(body.alreadyRegistered).toBe(true);
    expect(body).not.toEqual(buy1Body);

    // THE bug: pre-fix this stayed appAId (app B saw success but was never
    // assigned the domain).
    const domain = await domainRow();
    expect(domain.appId).toBe(appBId);
    expect(domain.organizationId).toBe(orgId);

    // The org+domain charge guard held: still exactly one debit, no re-register.
    expect(await domainPurchaseDebits()).toHaveLength(1);
    expect(await orgBalance()).toBeCloseTo(
      SEED_BALANCE - totalUsdCents / 100,
      6,
    );
    expect(registerDomain).toHaveBeenCalledTimes(1);

    // The claim row is untouched by the mismatch path (its replay stays scoped
    // to app A).
    const claim = await claimRow();
    expect(claim.status).toBe("completed");
    expect(claim.app_id).toBe(appAId);
    expect(claim.response_body).toEqual(buy1Body);
  });

  test("step 3 (control): re-buy for app A again → still the idempotent replay, no new action", async () => {
    if (!pgliteReady) return;

    const res = await buy(appAId);
    const body = (await res.json()) as Record<string, unknown>;

    expect(res.status).toBe(200);
    // Verbatim replay of the cached completion.
    expect(body).toEqual(buy1Body);

    // No new money movement, no re-register, no reassignment.
    expect(await domainPurchaseDebits()).toHaveLength(1);
    expect(await orgBalance()).toBeCloseTo(
      SEED_BALANCE - totalUsdCents / 100,
      6,
    );
    expect(registerDomain).toHaveBeenCalledTimes(1);
    expect((await domainRow()).appId).toBe(appBId);
  });
});
