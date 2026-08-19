// Exercises cloud API tests domains buy credit debit.test behavior with deterministic Worker route fixtures.
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";

/**
 * Regression test for the money-integrity bug in
 * `v1/apps/[id]/domains/buy/route.ts`.
 *
 * `creditsService.deductCredits()` RETURNS `{ success, reason, ... }` on a
 * declined debit — it never throws `InsufficientCreditsError` (only
 * `creditsService.reserve()` does). The route previously discarded that return
 * value inside a try/catch that only caught the (never-thrown) error, so an
 * out-of-credit org was NOT charged yet the flow proceeded to
 * `cloudflareRegistrarService.registerDomain(domain)` — registering a real
 * domain on Eliza's own Cloudflare account for free.
 *
 * The fix binds the debit result and returns 402 BEFORE `registerDomain`. These
 * tests drive the real route control flow (only its collaborators are mocked)
 * and assert that a declined debit never reaches the registrar and never issues
 * a refund, while a successful debit does register exactly once.
 */

// --- collaborator mocks --------------------------------------------------

const requireUserOrApiKeyWithOrg =
  mock<() => Promise<{ organization_id: string }>>();

const getById = mock();
const getDomainByName = mock();
const getMinimumRegistrationYears = mock();
const checkAvailability = mock();
const registerDomain = mock();
const getRegisteredDomain = mock();
const getRegistrationStatus = mock();
const deductCredits = mock();
const refundCredits = mock();
const computeDomainPrice = mock();
const upsertCloudflareRegisteredDomain = mock();
const assignToResource = mock();
const setCustomDomain = mock();
const hasUnrefundedDomainPurchase = mock<() => Promise<boolean>>();

// Chainable Drizzle write builder. The route uses:
//   insert().values().onConflictDoNothing().returning()   -> [claim]
//   update().set().where().catch()                         -> Promise
//   delete().where().catch()                               -> Promise (releaseClaim)
const idempotencyReturning = mock<() => Promise<Array<{ id: string }>>>(
  async () => [{ id: "claim-1" }],
);
const dbWriteTerminal = mock<() => Promise<void>>(async () => undefined);

function makeDbWrite() {
  const chain: Record<string, unknown> = {};
  chain.insert = () => chain;
  chain.values = () => chain;
  chain.onConflictDoNothing = () => chain;
  chain.returning = idempotencyReturning;
  chain.update = () => chain;
  chain.set = () => chain;
  chain.delete = () => chain;
  chain.where = dbWriteTerminal;
  return chain;
}
const dbWrite = makeDbWrite();

// Read builder is only exercised on the idempotency-conflict branch (claim
// truthy here, so it stays unused), but the module must import cleanly.
const dbReadLimit = mock<() => Promise<unknown[]>>(async () => []);
function makeDbRead() {
  const chain: Record<string, unknown> = {};
  chain.select = () => chain;
  chain.from = () => chain;
  chain.where = () => chain;
  chain.limit = dbReadLimit;
  return chain;
}
const dbRead = makeDbRead();

mock.module("@/db/client", () => ({ dbWrite, dbRead }));

let durableAttempt: Record<string, unknown> | null = null;
function baseAttempt() {
  return {
    id: "claim-1",
    key: "domain-buy:org-1:example.com",
    organization_id: "org-1",
    app_id: "app-1",
    domain: "example.com",
    status: "processing",
    request_digest: null,
    registration_years: null,
    charge_id: null,
    refund_id: null,
    charge: null,
    cloudflare_registration_id: null,
    managed_domain_id: null,
    response_body: null,
    response_status: null,
    error_code: null,
    lease_token: null,
    provider_started_at: null,
    next_reconcile_at: null,
    attempt_count: 0,
    expires_at: new Date(Date.now() + 60_000),
    created_at: new Date(),
    updated_at: new Date(),
  };
}
const domainPurchaseAttemptsRepository = {
  createOrRead: mock(
    async (input: { requestDigest: string; registrationYears: number }) => {
      const inserted = await idempotencyReturning();
      if (inserted.length > 0) {
        durableAttempt = {
          ...baseAttempt(),
          request_digest: input.requestDigest,
          registration_years: input.registrationYears,
        };
        return { attempt: durableAttempt, created: true };
      }
      const existing = (await dbReadLimit())[0] as
        | Record<string, unknown>
        | undefined;
      durableAttempt = existing
        ? {
            ...baseAttempt(),
            ...existing,
            request_digest: Object.hasOwn(existing, "request_digest")
              ? existing.request_digest
              : input.requestDigest,
            response_status:
              existing.response_status ??
              (existing.status === "completed" ? 200 : null),
          }
        : (durableAttempt ?? {
            ...baseAttempt(),
            request_digest: input.requestDigest,
          });
      return { attempt: durableAttempt, created: false };
    },
  ),
  storeQuote: mock(async (input: { quote: Record<string, unknown> }) => {
    durableAttempt = {
      ...durableAttempt,
      status: "quoted",
      charge: input.quote,
    };
    return durableAttempt;
  }),
  attachCharge: mock(async (input: { chargeId: string }) => {
    durableAttempt = {
      ...durableAttempt,
      status: "charged",
      charge_id: input.chargeId,
    };
    return durableAttempt;
  }),
  claimRegistrarStart: mock(
    async (input: { leaseToken: string; claimedUntil: Date }) => {
      durableAttempt = {
        ...durableAttempt,
        status: "provider_started",
        lease_token: input.leaseToken,
        expires_at: input.claimedUntil,
        attempt_count: 1,
      };
      return durableAttempt;
    },
  ),
  markRegistered: mock(async (input: { registrationId: string }) => {
    durableAttempt = {
      ...durableAttempt,
      status: "registered",
      cloudflare_registration_id: input.registrationId,
      lease_token: null,
    };
    return durableAttempt;
  }),
  markProviderAmbiguous: mock(async (input: { errorCode: string }) => {
    durableAttempt = {
      ...durableAttempt,
      status: "provider_ambiguous",
      error_code: input.errorCode,
      lease_token: null,
    };
    return durableAttempt;
  }),
  markRefundPending: mock(async () => {
    durableAttempt = { ...durableAttempt, status: "refund_pending" };
    return durableAttempt;
  }),
  markChargedRefundPending: mock(async () => {
    durableAttempt = { ...durableAttempt, status: "refund_pending" };
    return durableAttempt;
  }),
  markRefunded: mock(
    async (input: { responseBody: Record<string, unknown> }) => {
      durableAttempt = {
        ...durableAttempt,
        status: "refunded",
        response_body: input.responseBody,
      };
      return durableAttempt;
    },
  ),
  markTerminalFailure: mock(
    async (input: {
      responseBody: Record<string, unknown>;
      responseStatus: number;
    }) => {
      durableAttempt = {
        ...durableAttempt,
        status: "failed",
        response_body: input.responseBody,
        response_status: input.responseStatus,
      };
      return durableAttempt;
    },
  ),
  complete: mock(async (input: { responseBody: Record<string, unknown> }) => {
    durableAttempt = {
      ...durableAttempt,
      status: "completed",
      response_body: input.responseBody,
    };
    return durableAttempt;
  }),
  read: mock(async () => {
    if (durableAttempt) return durableAttempt;
    const existing = (await dbReadLimit())[0] as
      | Record<string, unknown>
      | undefined;
    return existing ? { ...baseAttempt(), ...existing } : null;
  }),
  deleteExpiredLegacyUncharged: mock(async () => false),
  claimReconciliation: mock(
    async (input: { leaseToken: string; claimedUntil: Date }) => {
      if (
        !durableAttempt ||
        !(durableAttempt.expires_at instanceof Date) ||
        durableAttempt.expires_at > new Date()
      )
        return null;
      durableAttempt = {
        ...durableAttempt,
        status: "provider_ambiguous",
        lease_token: input.leaseToken,
        expires_at: input.claimedUntil,
        attempt_count: Number(durableAttempt.attempt_count) + 1,
      };
      return durableAttempt;
    },
  ),
};
mock.module("@/db/repositories/domain-purchase-attempts", () => ({
  domainPurchaseAttemptsRepository,
}));

mock.module("@/db/schemas/domain-purchase-idempotency", () => ({
  domainPurchaseIdempotency: { key: "key", id: "id" },
}));

mock.module("@/lib/auth/workers-hono-auth", () => ({
  requireUserOrApiKeyWithOrg,
}));

mock.module("@/lib/services/apps", () => ({
  appsService: { getById },
}));

mock.module("@/lib/services/managed-domains", () => ({
  managedDomainsService: {
    getDomainByName,
    upsertCloudflareRegisteredDomain,
    assignToResource,
  },
}));

mock.module("@/lib/services/cloudflare-registrar", () => ({
  cloudflareRegistrarService: {
    checkAvailability,
    getMinimumRegistrationYears,
    registerDomain,
    getRegisteredDomain,
    getRegistrationStatus,
  },
}));

// The route no longer imports `InsufficientCreditsError`, but the real module
// exports it — keep exporting a class so any other importer still resolves.
class InsufficientCreditsError extends Error {}
mock.module("@/lib/services/credits", () => ({
  creditsService: { deductCredits, refundCredits },
  InsufficientCreditsError,
}));

mock.module("@/lib/services/domain-pricing", () => ({
  computeDomainPrice,
}));

mock.module("@/db/repositories/credit-transactions", () => ({
  creditTransactionsRepository: { hasUnrefundedDomainPurchase },
}));

mock.module("@/lib/services/app-domains-compat", () => ({
  appDomainsCompat: { setCustomDomain },
}));

mock.module("@/lib/services/cloudflare-dns", () => ({
  cloudflareDnsService: {
    listRecords: mock(async () => []),
    createRecord: mock(async () => ({})),
    updateRecord: mock(async () => ({})),
  },
}));

mock.module("@/lib/runtime/cloud-bindings", () => ({
  getCloudAwareEnv: () => ({}),
  getCloudBinding: () => undefined,
}));

mock.module("@/lib/utils/error-handling", () => ({
  extractErrorMessage: (e: unknown) =>
    e instanceof Error ? e.message : String(e),
}));

mock.module("@/lib/api/cloud-worker-errors", () => ({
  failureResponse: (c: { json: (b: unknown, s: number) => unknown }) =>
    c.json({ success: false, error: "unhandled" }, 500),
}));

mock.module("@/lib/utils/logger", () => ({
  logger: {
    info: mock(),
    warn: mock(),
    error: mock(),
    debug: mock(),
  },
}));

const { default: buyRoute } = await import("../v1/apps/[id]/domains/buy/route");

const app = new Hono();
app.route("/api/v1/apps/:id/domains/buy", buyRoute);

const ENV = { NODE_ENV: "test", RATE_LIMIT_DISABLED: "true" };

type DomainBuyResponseBody = {
  success?: unknown;
  code?: unknown;
  domain?: unknown;
};

function buy(domain = "example.com", appId = "app-1") {
  return app.request(
    `/api/v1/apps/${appId}/domains/buy`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ domain }),
    },
    ENV,
  );
}

async function domainPurchaseDigest(years: number): Promise<string> {
  const bytes = new TextEncoder().encode(
    JSON.stringify({ organizationId: "org-1", domain: "example.com", years }),
  );
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function successfulDebitTransaction(id = "txn-1") {
  return {
    id,
    organization_id: "org-1",
    type: "debit",
    amount: "-14.950000",
    metadata: {
      type: "domain_purchase",
      domain: "example.com",
      domainPurchaseKey: "domain-buy:org-1:example.com",
      totalUsdCents: 1495,
    },
  };
}

async function readDomainBuyResponseBody(
  res: Response,
): Promise<DomainBuyResponseBody> {
  const body = await res.json();
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new Error("Expected domain buy response body to be an object");
  }

  const success = Object.getOwnPropertyDescriptor(body, "success")?.value;
  const code = Object.getOwnPropertyDescriptor(body, "code")?.value;
  const domain = Object.getOwnPropertyDescriptor(body, "domain")?.value;

  return {
    success: typeof success === "boolean" ? success : undefined,
    code: typeof code === "string" ? code : undefined,
    domain: typeof domain === "string" ? domain : undefined,
  };
}

beforeEach(() => {
  durableAttempt = null;
  getMinimumRegistrationYears.mockReset();
  getMinimumRegistrationYears.mockResolvedValue(1);
});

describe("POST /apps/:id/domains/buy — credit debit gates registration", () => {
  beforeEach(() => {
    requireUserOrApiKeyWithOrg.mockReset();
    requireUserOrApiKeyWithOrg.mockResolvedValue({ organization_id: "org-1" });

    getById.mockReset();
    getById.mockResolvedValue({
      organization_id: "org-1",
      app_url: "https://x.apps.elizacloud.ai",
    });

    getDomainByName.mockReset();
    getDomainByName.mockResolvedValue(null);

    checkAvailability.mockReset();
    checkAvailability.mockResolvedValue({
      available: true,
      priceUsdCents: 1100,
      renewalUsdCents: 1100,
      currency: "USD",
    });

    computeDomainPrice.mockReset();
    computeDomainPrice.mockReturnValue({
      totalUsdCents: 1495,
      wholesaleUsdCents: 1100,
      marginUsdCents: 395,
    });

    registerDomain.mockReset();
    getRegisteredDomain.mockReset();
    getRegisteredDomain.mockResolvedValue(null);
    getRegistrationStatus.mockReset();
    getRegistrationStatus.mockResolvedValue({ status: "pending" });

    deductCredits.mockReset();
    refundCredits.mockReset();
    refundCredits.mockResolvedValue({ success: true });

    upsertCloudflareRegisteredDomain.mockReset();
    upsertCloudflareRegisteredDomain.mockResolvedValue({
      id: "md-1",
      status: "pending",
      verified: false,
    });
    assignToResource.mockReset();
    assignToResource.mockResolvedValue({ id: "app-domain-1" });
    setCustomDomain.mockReset();
    setCustomDomain.mockResolvedValue(undefined);

    idempotencyReturning.mockClear();
    idempotencyReturning.mockResolvedValue([{ id: "claim-1" }]);
    dbWriteTerminal.mockClear();
    dbReadLimit.mockClear();

    hasUnrefundedDomainPurchase.mockReset();
    hasUnrefundedDomainPurchase.mockResolvedValue(false);
  });

  test("insufficient balance → 402, no registration, no refund", async () => {
    deductCredits.mockResolvedValue({
      success: false,
      reason: "insufficient_balance",
      newBalance: 0,
      transaction: null,
    });

    const res = await buy();
    const body = await readDomainBuyResponseBody(res);

    expect(res.status).toBe(402);
    expect(body).toMatchObject({
      success: false,
      code: "insufficient_balance",
    });
    // The bug: a declined debit must NOT register a domain on Eliza's account.
    expect(registerDomain).not.toHaveBeenCalled();
    expect(refundCredits).not.toHaveBeenCalled();
    expect(deductCredits).toHaveBeenCalledTimes(1);
  });

  test("below_minimum → 402, no registration, no refund", async () => {
    deductCredits.mockResolvedValue({
      success: false,
      reason: "below_minimum",
      newBalance: 0,
      transaction: null,
    });

    const res = await buy();
    const body = await readDomainBuyResponseBody(res);

    expect(res.status).toBe(402);
    expect(body).toMatchObject({
      success: false,
      code: "below_minimum",
    });
    expect(registerDomain).not.toHaveBeenCalled();
    expect(refundCredits).not.toHaveBeenCalled();
  });

  test("org_not_found → 402, no registration, no refund", async () => {
    deductCredits.mockResolvedValue({
      success: false,
      reason: "org_not_found",
      newBalance: 0,
      transaction: null,
    });

    const res = await buy();
    const body = await readDomainBuyResponseBody(res);

    expect(res.status).toBe(402);
    expect(body).toMatchObject({ code: "org_not_found" });
    expect(registerDomain).not.toHaveBeenCalled();
    expect(refundCredits).not.toHaveBeenCalled();
  });

  test("successful debit → registers exactly once and returns 200", async () => {
    deductCredits.mockResolvedValue({
      success: true,
      newBalance: 5,
      transaction: successfulDebitTransaction(),
    });
    registerDomain.mockResolvedValue({ registrationId: "reg-1" });

    const res = await buy();
    const body = await readDomainBuyResponseBody(res);

    expect(res.status).toBe(200);
    expect(body).toMatchObject({
      success: true,
      domain: "example.com",
    });
    expect(deductCredits).toHaveBeenCalledTimes(1);
    expect(registerDomain).toHaveBeenCalledTimes(1);
    expect(registerDomain).toHaveBeenCalledWith("example.com", 1);
    // A successful purchase is not refunded.
    expect(refundCredits).not.toHaveBeenCalled();
  });

  test("two-year registry minimum is pinned, fully priced, debited, and POSTed exactly", async () => {
    getMinimumRegistrationYears.mockResolvedValue(2);
    checkAvailability.mockResolvedValue({
      available: true,
      priceUsdCents: 1000,
      renewalUsdCents: 2000,
      currency: "USD",
    });
    computeDomainPrice.mockImplementation((wholesaleUsdCents: number) =>
      wholesaleUsdCents === 3000
        ? {
            totalUsdCents: 4000,
            wholesaleUsdCents: 3000,
            marginUsdCents: 1000,
          }
        : {
            totalUsdCents: 2500,
            wholesaleUsdCents: 2000,
            marginUsdCents: 500,
          },
    );
    deductCredits.mockResolvedValue({
      success: true,
      newBalance: 60,
      transaction: {
        ...successfulDebitTransaction("txn-2y"),
        amount: "-40.000000",
        metadata: {
          ...successfulDebitTransaction().metadata,
          totalUsdCents: 4000,
        },
      },
    });
    registerDomain.mockResolvedValue({
      registrationId: "reg-2y",
      status: "active",
    });

    const res = await buy();
    expect(res.status).toBe(200);
    expect(deductCredits).toHaveBeenCalledWith(
      expect.objectContaining({ amount: 40 }),
    );
    expect(domainPurchaseAttemptsRepository.storeQuote).toHaveBeenCalledWith(
      expect.objectContaining({
        quote: expect.objectContaining({
          years: 2,
          registrationWholesaleUsdCents: 1000,
          renewalWholesaleUsdCents: 2000,
          wholesaleUsdCents: 3000,
          totalUsdCents: 4000,
        }),
      }),
    );
    expect(registerDomain).toHaveBeenCalledWith("example.com", 2);
  });
});

describe("POST /apps/:id/domains/buy — refund-on-failure + recoverable orphan (#10247, #10253)", () => {
  beforeEach(() => {
    requireUserOrApiKeyWithOrg.mockReset();
    requireUserOrApiKeyWithOrg.mockResolvedValue({ organization_id: "org-1" });
    getById.mockReset();
    getById.mockResolvedValue({
      organization_id: "org-1",
      app_url: "https://x.apps.elizacloud.ai",
    });
    getDomainByName.mockReset();
    getDomainByName.mockResolvedValue(null);
    checkAvailability.mockReset();
    checkAvailability.mockResolvedValue({
      available: true,
      priceUsdCents: 1100,
      renewalUsdCents: 1100,
      currency: "USD",
    });
    computeDomainPrice.mockReset();
    computeDomainPrice.mockReturnValue({
      totalUsdCents: 1495,
      wholesaleUsdCents: 1100,
      marginUsdCents: 395,
    });
    registerDomain.mockReset();
    getRegisteredDomain.mockReset();
    getRegisteredDomain.mockResolvedValue(null);
    getRegistrationStatus.mockReset();
    getRegistrationStatus.mockResolvedValue({ status: "pending" });
    deductCredits.mockReset();
    deductCredits.mockResolvedValue({
      success: true,
      newBalance: 5,
      transaction: successfulDebitTransaction(),
    });
    refundCredits.mockReset();
    refundCredits.mockResolvedValue({
      transaction: { id: "refund-1" },
      newBalance: 6,
    });
    upsertCloudflareRegisteredDomain.mockReset();
    upsertCloudflareRegisteredDomain.mockResolvedValue({
      id: "md-1",
      status: "pending",
      verified: false,
    });
    assignToResource.mockReset();
    assignToResource.mockResolvedValue({ id: "app-domain-1" });
    setCustomDomain.mockReset();
    setCustomDomain.mockResolvedValue(undefined);
    idempotencyReturning.mockClear();
    idempotencyReturning.mockResolvedValue([{ id: "claim-1" }]);
    dbWriteTerminal.mockClear();
    dbReadLimit.mockClear();
    hasUnrefundedDomainPurchase.mockReset();
    hasUnrefundedDomainPurchase.mockResolvedValue(false);
  });

  test("registrar throws after debit → reconciles without guessing or refunding", async () => {
    registerDomain.mockRejectedValue(new Error("cf registrar 500"));

    const res = await buy();
    const body = (await res.json()) as DomainBuyResponseBody;

    expect(res.status).toBe(409);
    expect(body.success).toBe(false);
    expect(deductCredits).toHaveBeenCalledTimes(1);
    // A transport failure after POST may be an acknowledgement loss. Refunding
    // immediately would let a registered domain escape payment; the durable
    // attempt is reconciled first and only a provider-confirmed failure refunds.
    expect(refundCredits).not.toHaveBeenCalled();
    expect(upsertCloudflareRegisteredDomain).not.toHaveBeenCalled();
    expect(assignToResource).not.toHaveBeenCalled();
  });

  test("two-year ACK loss retries from the pinned term without a second debit or POST", async () => {
    getMinimumRegistrationYears.mockResolvedValue(2);
    checkAvailability.mockResolvedValue({
      available: true,
      priceUsdCents: 1000,
      renewalUsdCents: 2000,
      currency: "USD",
    });
    computeDomainPrice.mockImplementation((wholesaleUsdCents: number) =>
      wholesaleUsdCents === 3000
        ? {
            totalUsdCents: 4000,
            wholesaleUsdCents: 3000,
            marginUsdCents: 1000,
          }
        : {
            totalUsdCents: 2500,
            wholesaleUsdCents: 2000,
            marginUsdCents: 500,
          },
    );
    deductCredits.mockResolvedValue({
      success: true,
      newBalance: 60,
      transaction: {
        ...successfulDebitTransaction("txn-ack-2y"),
        amount: "-40.000000",
        metadata: {
          ...successfulDebitTransaction().metadata,
          totalUsdCents: 4000,
        },
      },
    });
    registerDomain.mockRejectedValue(new Error("acknowledgement lost"));

    expect((await buy()).status).toBe(409);
    if (!durableAttempt) throw new Error("Expected durable two-year attempt");
    durableAttempt.expires_at = new Date(Date.now() - 1);
    idempotencyReturning.mockResolvedValue([]);
    getMinimumRegistrationYears.mockResolvedValue(1);
    getRegistrationStatus.mockResolvedValue({ status: "active" });

    expect((await buy()).status).toBe(200);
    expect(getMinimumRegistrationYears).toHaveBeenCalledTimes(1);
    expect(deductCredits).toHaveBeenCalledTimes(1);
    expect(registerDomain).toHaveBeenCalledTimes(1);
    expect(registerDomain).toHaveBeenCalledWith("example.com", 2);
    expect(refundCredits).not.toHaveBeenCalled();
  });

  test("ambiguous registration refunds only after authoritative failure and replays terminally", async () => {
    registerDomain.mockRejectedValue(
      new Error("registrar acknowledgement lost"),
    );

    const ambiguous = await buy();
    expect(ambiguous.status).toBe(409);
    expect(deductCredits).toHaveBeenCalledTimes(1);
    expect(registerDomain).toHaveBeenCalledTimes(1);
    expect(refundCredits).not.toHaveBeenCalled();

    if (!durableAttempt) throw new Error("Expected a durable purchase attempt");
    durableAttempt.expires_at = new Date(Date.now() - 1);
    idempotencyReturning.mockResolvedValue([]);
    getRegistrationStatus.mockResolvedValue({ status: "failed" });
    refundCredits.mockResolvedValue({
      transaction: {
        id: "refund-1",
        organization_id: "org-1",
        type: "refund",
        amount: "14.950000",
        metadata: {
          type: "domain_purchase_refund",
          domain: "example.com",
          domainPurchaseKey: "domain-buy:org-1:example.com",
        },
      },
      newBalance: 19.95,
    });

    const failed = await buy();
    expect(failed.status).toBe(502);
    expect(refundCredits).toHaveBeenCalledTimes(1);
    expect(registerDomain).toHaveBeenCalledTimes(1);

    const replay = await buy();
    expect(replay.status).toBe(502);
    expect(refundCredits).toHaveBeenCalledTimes(1);
    expect(registerDomain).toHaveBeenCalledTimes(1);
  });

  test("a charged pre-provider retry that loses the domain race refunds without registering", async () => {
    idempotencyReturning.mockResolvedValue([]);
    dbReadLimit.mockResolvedValue([
      {
        status: "charged",
        organization_id: "org-1",
        app_id: "app-1",
        domain: "example.com",
        charge_id: "txn-1",
        charge: {
          totalUsdCents: 1495,
          wholesaleUsdCents: 1100,
          marginUsdCents: 395,
          registrationWholesaleUsdCents: 1100,
          renewalWholesaleUsdCents: 1100,
          renewalUsdCents: 1495,
          years: 1,
          currency: "USD",
        },
        expires_at: new Date(Date.now() - 1),
      },
    ]);
    getDomainByName.mockResolvedValue({
      organizationId: "org-2",
      registrar: "cloudflare",
    });
    refundCredits.mockResolvedValue({
      transaction: {
        id: "refund-race",
        organization_id: "org-1",
        type: "refund",
        amount: "14.950000",
        metadata: {
          type: "domain_purchase_refund",
          domain: "example.com",
          domainPurchaseKey: "domain-buy:org-1:example.com",
        },
      },
      newBalance: 19.95,
    });

    const res = await buy();
    expect(res.status).toBe(502);
    expect(refundCredits).toHaveBeenCalledTimes(1);
    expect(registerDomain).not.toHaveBeenCalled();
  });

  test("post-register persist failure → 502 persist_failed_recoverable, NOT refunded (domain kept)", async () => {
    registerDomain.mockResolvedValue({ registrationId: "reg-1" });
    upsertCloudflareRegisteredDomain.mockRejectedValue(
      new Error("db write failed"),
    );

    const res = await buy();
    const body = (await res.json()) as DomainBuyResponseBody & {
      code?: string;
    };

    expect(res.status).toBe(502);
    expect(body.code).toBe("persist_failed_recoverable");
    expect(registerDomain).toHaveBeenCalledTimes(1);
    // The domain was registered + charged; it is genuinely the org's, so it is
    // NOT refunded — it is recoverable via the unrefunded-debit ownership proof.
    expect(refundCredits).not.toHaveBeenCalled();
  });

  test("recover an orphaned (registered, no row) domain WITHOUT a prior purchase → 409, no assign, no debit", async () => {
    // Domain has no managed_domains row and is unavailable (already registered
    // on our CF account) — the orphan shape. The caller never paid for it.
    getDomainByName.mockResolvedValue(null);
    checkAvailability.mockResolvedValue({ available: false });
    getRegisteredDomain.mockResolvedValue({
      domain: "example.com",
      zoneId: "zone-1",
      expiresAt: "2027-01-01T00:00:00Z",
      autoRenew: true,
    });
    hasUnrefundedDomainPurchase.mockResolvedValue(false);

    const res = await buy();
    const body = (await res.json()) as DomainBuyResponseBody;

    expect(res.status).toBe(409);
    expect(body.success).toBe(false);
    // Cross-tenant takeover blocked: no assignment, and never a free debit-less grab.
    expect(upsertCloudflareRegisteredDomain).not.toHaveBeenCalled();
    expect(assignToResource).not.toHaveBeenCalled();
    expect(deductCredits).not.toHaveBeenCalled();
    expect(hasUnrefundedDomainPurchase).toHaveBeenCalledWith(
      "org-1",
      "example.com",
    );
  });

  test("recover OWN orphan (unrefunded prior purchase) → 200, assigns for free (no new debit)", async () => {
    getDomainByName.mockResolvedValue(null);
    checkAvailability.mockResolvedValue({ available: false });
    getRegisteredDomain.mockResolvedValue({
      domain: "example.com",
      zoneId: "zone-1",
      expiresAt: "2027-01-01T00:00:00Z",
      autoRenew: true,
    });
    hasUnrefundedDomainPurchase.mockResolvedValue(true);

    const res = await buy();
    const body = (await res.json()) as DomainBuyResponseBody & {
      recoveredFromRegistrar?: boolean;
    };

    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.recoveredFromRegistrar).toBe(true);
    expect(upsertCloudflareRegisteredDomain).toHaveBeenCalledTimes(1);
    expect(assignToResource).toHaveBeenCalledTimes(1);
    // Self-recovery does NOT re-charge.
    expect(deductCredits).not.toHaveBeenCalled();
  });
});

describe("POST /apps/:id/domains/buy — idempotency single-flights the purchase (#10247)", () => {
  beforeEach(() => {
    requireUserOrApiKeyWithOrg.mockReset();
    requireUserOrApiKeyWithOrg.mockResolvedValue({ organization_id: "org-1" });
    getById.mockReset();
    getById.mockResolvedValue({
      organization_id: "org-1",
      app_url: "https://x.apps.elizacloud.ai",
    });
    getDomainByName.mockReset();
    getDomainByName.mockResolvedValue(null);
    checkAvailability.mockReset();
    checkAvailability.mockResolvedValue({
      available: true,
      priceUsdCents: 1100,
      currency: "USD",
    });
    computeDomainPrice.mockReset();
    computeDomainPrice.mockReturnValue({
      totalUsdCents: 1495,
      wholesaleUsdCents: 1100,
      marginUsdCents: 395,
    });
    deductCredits.mockReset();
    deductCredits.mockResolvedValue({
      success: true,
      newBalance: 5,
      transaction: successfulDebitTransaction(),
    });
    registerDomain.mockReset();
    registerDomain.mockResolvedValue({ registrationId: "reg-1" });
    refundCredits.mockReset();
    getRegisteredDomain.mockReset();
    getRegisteredDomain.mockResolvedValue(null);
    getRegistrationStatus.mockReset();
    getRegistrationStatus.mockResolvedValue({ status: "pending" });
    upsertCloudflareRegisteredDomain.mockReset();
    upsertCloudflareRegisteredDomain.mockResolvedValue({
      id: "md-1",
      status: "pending",
      verified: false,
    });
    assignToResource.mockReset();
    assignToResource.mockResolvedValue({ id: "app-domain-1" });
    setCustomDomain.mockReset();
    setCustomDomain.mockResolvedValue(undefined);
    hasUnrefundedDomainPurchase.mockReset();
    hasUnrefundedDomainPurchase.mockResolvedValue(false);
    domainPurchaseAttemptsRepository.deleteExpiredLegacyUncharged.mockReset();
    domainPurchaseAttemptsRepository.deleteExpiredLegacyUncharged.mockResolvedValue(
      false,
    );
    dbWriteTerminal.mockClear();
    dbReadLimit.mockReset();
  });

  test("expired legacy claim with a possible debit fails closed for reconciliation", async () => {
    idempotencyReturning.mockResolvedValue([]);
    dbReadLimit.mockResolvedValue([
      {
        status: "processing",
        request_digest: null,
        expires_at: new Date(Date.now() - 1),
      },
    ]);
    domainPurchaseAttemptsRepository.deleteExpiredLegacyUncharged.mockResolvedValue(
      false,
    );

    const res = await buy();
    const body = await readDomainBuyResponseBody(res);

    expect(res.status).toBe(409);
    expect(body.code).toBe("legacy_purchase_reconciliation_required");
    expect(deductCredits).not.toHaveBeenCalled();
    expect(registerDomain).not.toHaveBeenCalled();
  });

  test("expired legacy claim with no debit is released for an explicit retry", async () => {
    idempotencyReturning.mockResolvedValue([]);
    dbReadLimit.mockResolvedValue([
      {
        status: "processing",
        request_digest: null,
        expires_at: new Date(Date.now() - 1),
      },
    ]);
    domainPurchaseAttemptsRepository.deleteExpiredLegacyUncharged.mockResolvedValue(
      true,
    );

    const res = await buy();
    const body = await readDomainBuyResponseBody(res);

    expect(res.status).toBe(409);
    expect(body.code).toBe("idempotency_retry");
    expect(deductCredits).not.toHaveBeenCalled();
    expect(registerDomain).not.toHaveBeenCalled();
  });

  test("concurrent duplicate (claim lost the race, prior still processing) → 409, never charges/registers twice", async () => {
    const requestDigest = await domainPurchaseDigest(1);
    // This caller lost the unique-insert race: onConflictDoNothing returns no row.
    idempotencyReturning.mockResolvedValue([]);
    // The winning claim is still in flight.
    dbReadLimit.mockResolvedValue([
      {
        status: "processing",
        request_digest: requestDigest,
        registration_years: 1,
        expires_at: new Date(Date.now() + 3_600_000),
      },
    ]);

    const res = await buy();
    const body = (await res.json()) as DomainBuyResponseBody & {
      code?: string;
    };

    expect(res.status).toBe(409);
    expect(body.code).toBe("idempotency_in_progress");
    // The losing caller must NOT charge or register — the winner owns the purchase.
    expect(deductCredits).not.toHaveBeenCalled();
    expect(registerDomain).not.toHaveBeenCalled();
  });

  test("unquoted processing attempt with a future lease returns in-progress without side effects", async () => {
    const requestDigest = await domainPurchaseDigest(2);
    idempotencyReturning.mockResolvedValue([]);
    dbReadLimit.mockResolvedValue([
      {
        status: "processing",
        request_digest: requestDigest,
        registration_years: 2,
        charge: null,
        expires_at: new Date(Date.now() + 3_600_000),
      },
    ]);

    const res = await buy();
    const body = await readDomainBuyResponseBody(res);

    expect(res.status).toBe(409);
    expect(body.code).toBe("idempotency_in_progress");
    expect(getMinimumRegistrationYears).not.toHaveBeenCalled();
    expect(checkAvailability).not.toHaveBeenCalled();
    expect(deductCredits).not.toHaveBeenCalled();
    expect(registerDomain).not.toHaveBeenCalled();
  });

  test("expired unquoted processing attempt resumes from its durable term without a second attempt", async () => {
    const requestDigest = await domainPurchaseDigest(2);
    const winner = {
      status: "processing",
      request_digest: requestDigest,
      registration_years: 2,
      charge: null,
      expires_at: new Date(Date.now() - 1),
    };
    idempotencyReturning.mockResolvedValue([]);
    dbReadLimit.mockResolvedValue([winner]);
    checkAvailability.mockResolvedValue({
      available: true,
      priceUsdCents: 1000,
      renewalUsdCents: 1000,
      currency: "USD",
    });
    computeDomainPrice.mockImplementation((wholesaleUsdCents: number) =>
      wholesaleUsdCents === 2000
        ? {
            totalUsdCents: 2800,
            wholesaleUsdCents: 2000,
            marginUsdCents: 800,
          }
        : {
            totalUsdCents: 1400,
            wholesaleUsdCents: 1000,
            marginUsdCents: 400,
          },
    );
    deductCredits.mockResolvedValue({
      success: true,
      newBalance: 72,
      transaction: {
        ...successfulDebitTransaction("txn-resume-2y"),
        amount: "-28.000000",
        metadata: {
          ...successfulDebitTransaction().metadata,
          totalUsdCents: 2800,
        },
      },
    });
    registerDomain.mockResolvedValue({ registrationId: "reg-resume-2y" });
    const insertionCallsBefore = idempotencyReturning.mock.calls.length;

    const res = await buy();

    expect(res.status).toBe(200);
    expect(getMinimumRegistrationYears).not.toHaveBeenCalled();
    expect(idempotencyReturning.mock.calls.length - insertionCallsBefore).toBe(
      1,
    );
    expect(domainPurchaseAttemptsRepository.storeQuote).toHaveBeenCalledWith(
      expect.objectContaining({ quote: expect.objectContaining({ years: 2 }) }),
    );
    expect(deductCredits).toHaveBeenCalledTimes(1);
    expect(registerDomain).toHaveBeenCalledWith("example.com", 2);
  });

  test("concurrent loser that reads the winner before quote returns 409 without buying", async () => {
    const requestDigest = await domainPurchaseDigest(1);
    idempotencyReturning.mockResolvedValue([]);
    dbReadLimit.mockResolvedValueOnce([]).mockResolvedValueOnce([
      {
        status: "processing",
        request_digest: requestDigest,
        registration_years: 1,
        charge: null,
        expires_at: new Date(Date.now() + 3_600_000),
      },
    ]);
    const res = await buy();

    expect(res.status).toBe(409);
    expect(getMinimumRegistrationYears).toHaveBeenCalledTimes(1);
    expect(checkAvailability).not.toHaveBeenCalled();
    expect(deductCredits).not.toHaveBeenCalled();
    expect(registerDomain).not.toHaveBeenCalled();
  });

  test("concurrent provider-minimum drift fails closed against the winner's durable term", async () => {
    const winnerDigest = await domainPurchaseDigest(1);
    idempotencyReturning.mockResolvedValue([]);
    getMinimumRegistrationYears.mockResolvedValue(2);
    dbReadLimit.mockResolvedValueOnce([]).mockResolvedValueOnce([
      {
        status: "processing",
        request_digest: winnerDigest,
        registration_years: 1,
        charge: null,
        expires_at: new Date(Date.now() + 3_600_000),
      },
    ]);
    const quoteCallsBefore =
      domainPurchaseAttemptsRepository.storeQuote.mock.calls.length;

    const res = await buy();

    expect(res.status).toBe(409);
    expect(getMinimumRegistrationYears).toHaveBeenCalledTimes(1);
    expect(checkAvailability).not.toHaveBeenCalled();
    expect(
      domainPurchaseAttemptsRepository.storeQuote.mock.calls.length -
        quoteCallsBefore,
    ).toBe(0);
    expect(deductCredits).not.toHaveBeenCalled();
    expect(registerDomain).not.toHaveBeenCalled();
  });

  test("retried duplicate of a completed purchase → replays the cached 200 without re-charging", async () => {
    idempotencyReturning.mockResolvedValue([]);
    // app_id is NOT NULL on the real claim row; the cached replay is app-scoped,
    // so the fixture must carry the SAME app the retry posts to ("app-1").
    dbReadLimit.mockResolvedValue([
      {
        status: "completed",
        app_id: "app-1",
        expires_at: new Date(Date.now() + 3_600_000),
        response_body: { success: true, domain: "example.com", replayed: true },
      },
    ]);

    const res = await buy();
    const body = (await res.json()) as DomainBuyResponseBody & {
      replayed?: boolean;
    };

    expect(res.status).toBe(200);
    expect(body).toMatchObject({
      success: true,
      domain: "example.com",
      replayed: true,
    });
    // A replay never re-charges or re-registers.
    expect(deductCredits).not.toHaveBeenCalled();
    expect(registerDomain).not.toHaveBeenCalled();
  });

  test("legacy completed purchase reassigns to a second same-org app without any financial or registrar call", async () => {
    idempotencyReturning.mockResolvedValue([]);
    dbReadLimit.mockResolvedValue([
      {
        status: "completed",
        app_id: "app-1",
        request_digest: null,
        managed_domain_id: "md-legacy",
        response_status: 200,
        response_body: { success: true, domain: "example.com" },
        expires_at: new Date(Date.now() - 1),
      },
    ]);
    getById.mockResolvedValue({
      organization_id: "org-1",
      app_url: "https://app-2.apps.elizacloud.ai",
    });
    getDomainByName.mockResolvedValue({
      id: "md-legacy",
      organizationId: "org-1",
      registrar: "cloudflare",
      cloudflareRegistrationId: "example.com",
      cloudflareZoneId: null,
      status: "pending",
      verified: false,
    });

    const res = await buy("example.com", "app-2");
    expect(res.status).toBe(200);
    expect(assignToResource).toHaveBeenCalledTimes(1);
    expect(deductCredits).not.toHaveBeenCalled();
    expect(refundCredits).not.toHaveBeenCalled();
    expect(checkAvailability).not.toHaveBeenCalled();
    expect(registerDomain).not.toHaveBeenCalled();
    expect(getMinimumRegistrationYears).not.toHaveBeenCalled();
  });

  test("legacy completed purchase cannot reassign a managed domain owned by another org", async () => {
    idempotencyReturning.mockResolvedValue([]);
    dbReadLimit.mockResolvedValue([
      {
        status: "completed",
        app_id: "app-1",
        request_digest: null,
        managed_domain_id: "md-legacy",
        response_status: 200,
        response_body: { success: true, domain: "example.com" },
        expires_at: new Date(Date.now() - 1),
      },
    ]);
    getDomainByName.mockResolvedValue({
      id: "md-legacy",
      organizationId: "org-2",
      registrar: "cloudflare",
    });

    const res = await buy("example.com", "app-2");
    expect(res.status).toBe(409);
    expect(assignToResource).not.toHaveBeenCalled();
    expect(deductCredits).not.toHaveBeenCalled();
    expect(refundCredits).not.toHaveBeenCalled();
    expect(checkAvailability).not.toHaveBeenCalled();
    expect(registerDomain).not.toHaveBeenCalled();
  });
});
