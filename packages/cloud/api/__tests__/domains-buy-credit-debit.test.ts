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
const checkAvailability = mock();
const registerDomain = mock();
const getRegisteredDomain = mock();
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
    registerDomain,
    getRegisteredDomain,
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

type DomainBuyResponseBody = {
  success?: unknown;
  code?: unknown;
  domain?: unknown;
};

function buy(domain = "example.com", appId = "app-1") {
  return app.request(`/api/v1/apps/${appId}/domains/buy`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ domain }),
  });
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
      priceUsdCents: 1000,
      renewalUsdCents: 1000,
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
      transaction: { id: "txn-1" },
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
    expect(registerDomain).toHaveBeenCalledWith("example.com");
    // A successful purchase is not refunded.
    expect(refundCredits).not.toHaveBeenCalled();
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
      priceUsdCents: 1000,
      renewalUsdCents: 1000,
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
    deductCredits.mockReset();
    deductCredits.mockResolvedValue({
      success: true,
      newBalance: 5,
      transaction: { id: "txn-1" },
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

  test("registrar throws after debit → refunds EXACTLY once, assigns no domain, returns 502", async () => {
    registerDomain.mockRejectedValue(new Error("cf registrar 500"));

    const res = await buy();
    const body = (await res.json()) as DomainBuyResponseBody;

    expect(res.status).toBe(502);
    expect(body.success).toBe(false);
    expect(deductCredits).toHaveBeenCalledTimes(1);
    // Exactly-once refund, reconciling the original debit as a refund.
    expect(refundCredits).toHaveBeenCalledTimes(1);
    const refundArg = refundCredits.mock.calls[0]?.[0] as {
      organizationId: string;
      metadata: { type: string; domain: string };
    };
    expect(refundArg.organizationId).toBe("org-1");
    expect(refundArg.metadata.type).toBe("domain_purchase_refund");
    expect(refundArg.metadata.domain).toBe("example.com");
    // No domain row written / assigned on a failed registration.
    expect(upsertCloudflareRegisteredDomain).not.toHaveBeenCalled();
    expect(assignToResource).not.toHaveBeenCalled();
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
      priceUsdCents: 1000,
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
      transaction: { id: "txn-1" },
    });
    registerDomain.mockReset();
    registerDomain.mockResolvedValue({ registrationId: "reg-1" });
    refundCredits.mockReset();
    getRegisteredDomain.mockReset();
    getRegisteredDomain.mockResolvedValue(null);
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
    dbWriteTerminal.mockClear();
    dbReadLimit.mockReset();
  });

  test("concurrent duplicate (claim lost the race, prior still processing) → 409, never charges/registers twice", async () => {
    // This caller lost the unique-insert race: onConflictDoNothing returns no row.
    idempotencyReturning.mockResolvedValue([]);
    // The winning claim is still in flight.
    dbReadLimit.mockResolvedValue([
      { status: "processing", expires_at: new Date(Date.now() + 3_600_000) },
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
});
