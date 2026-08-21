/**
 * Domain-purchase rate-limit wiring through the real Hono middleware and route.
 * The harness replaces Redis and purchase collaborators with deterministic
 * in-process seams so limiter failures can prove that no money or external
 * registration side effect begins before the canonical 503 response.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";

type RedisMode = "healthy" | "missing" | "throwing";

let redisMode: RedisMode = "healthy";

interface TestRedisPipeline {
  incr(key: string): TestRedisPipeline;
  pttl(key: string): TestRedisPipeline;
  exec(): Promise<unknown[]>;
}

const redisPipelineExec = mock(async (): Promise<unknown[]> => {
  if (redisMode === "throwing") {
    throw new Error("ECONNREFUSED: hermetic Redis outage");
  }
  return [1, 300_000];
});

const redisPipeline: TestRedisPipeline = {
  incr: mock((_key: string) => redisPipeline),
  pttl: mock((_key: string) => redisPipeline),
  exec: redisPipelineExec,
};

const redisPexpire = mock(async () => 1);
const redisClient = {
  pipeline: mock(() => redisPipeline),
  pexpire: redisPexpire,
};
const buildRedisClient = mock(() =>
  redisMode === "missing" ? null : redisClient,
);

mock.module("@/lib/cache/redis-factory", () => ({
  buildRedisClient,
  hasRedisConfig: () => redisMode !== "missing",
  isCloudflareWorkerRuntime: () => false,
}));

const requireUserOrApiKeyWithOrg = mock(async () => ({
  id: "user-1",
  organization_id: "org-1",
}));
const isAppKeyOutOfScope = mock(async () => false);
const getById = mock(async () => ({
  organization_id: "org-1",
  app_url: "https://app-1.apps.elizacloud.ai",
}));

mock.module("@/lib/auth/workers-hono-auth", () => ({
  requireUserOrApiKeyWithOrg,
}));
mock.module("@/lib/auth/app-key-scope", () => ({ isAppKeyOutOfScope }));
mock.module("@/lib/services/apps", () => ({
  appsService: { getById },
}));

let dbWrite: Record<string, unknown>;
const dbWriteInsert = mock<() => Record<string, unknown>>(() => dbWrite);
const dbWriteValues = mock<() => Record<string, unknown>>(() => dbWrite);
const dbWriteOnConflictDoNothing = mock<() => Record<string, unknown>>(
  () => dbWrite,
);
const dbWriteReturning = mock(async () => [{ id: "claim-1" }]);
const dbWriteUpdate = mock<() => Record<string, unknown>>(() => dbWrite);
const dbWriteSet = mock<() => Record<string, unknown>>(() => dbWrite);
const dbWriteDelete = mock<() => Record<string, unknown>>(() => dbWrite);
const dbWriteWhere = mock(async () => undefined);

dbWrite = {
  insert: dbWriteInsert,
  values: dbWriteValues,
  onConflictDoNothing: dbWriteOnConflictDoNothing,
  returning: dbWriteReturning,
  update: dbWriteUpdate,
  set: dbWriteSet,
  delete: dbWriteDelete,
  where: dbWriteWhere,
};

let dbRead: Record<string, unknown>;
const dbReadSelect = mock<() => Record<string, unknown>>(() => dbRead);
const dbReadFrom = mock<() => Record<string, unknown>>(() => dbRead);
const dbReadWhere = mock<() => Record<string, unknown>>(() => dbRead);
const dbReadLimit = mock(async () => []);

dbRead = {
  select: dbReadSelect,
  from: dbReadFrom,
  where: dbReadWhere,
  limit: dbReadLimit,
};

mock.module("@/db/client", () => ({ dbRead, dbWrite }));

let durableAttempt: Record<string, unknown> | null = null;
const domainPurchaseAttemptsRepository = {
  createOrRead: mock(
    async (input: { requestDigest: string; registrationYears: number }) => {
      dbWriteInsert();
      dbWriteValues();
      dbWriteOnConflictDoNothing();
      await dbWriteReturning();
      durableAttempt = {
        id: "claim-1",
        key: "domain-buy:org-1:example.com",
        organization_id: "org-1",
        app_id: "app-1",
        domain: "example.com",
        status: "processing",
        request_digest: input.requestDigest,
        registration_years: input.registrationYears,
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
      return { attempt: durableAttempt, created: true };
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
  claimRegistrarStart: mock(async (input: { leaseToken: string }) => {
    durableAttempt = {
      ...durableAttempt,
      status: "provider_started",
      lease_token: input.leaseToken,
      attempt_count: 1,
    };
    return durableAttempt;
  }),
  markRegistered: mock(async (input: { registrationId: string }) => {
    durableAttempt = {
      ...durableAttempt,
      status: "registered",
      cloudflare_registration_id: input.registrationId,
    };
    return durableAttempt;
  }),
  complete: mock(async () => durableAttempt),
  markTerminalFailure: mock(async () => durableAttempt),
  read: mock(async () => durableAttempt),
};
mock.module("@/db/repositories/domain-purchase-attempts", () => ({
  domainPurchaseAttemptsRepository,
}));

const getDomainByName = mock(async () => null);
const upsertCloudflareRegisteredDomain = mock(async () => ({
  id: "managed-domain-1",
  status: "active" as const,
  verified: true,
}));
const assignToResource = mock(async () => ({ id: "app-domain-1" }));
const hasUnrefundedDomainPurchase = mock(async () => false);

mock.module("@/lib/services/managed-domains", () => ({
  managedDomainsService: {
    getDomainByName,
    upsertCloudflareRegisteredDomain,
    assignToResource,
  },
}));
mock.module("@/db/repositories/credit-transactions", () => ({
  creditTransactionsRepository: { hasUnrefundedDomainPurchase },
}));

const checkAvailability = mock(async () => ({
  available: true,
  priceUsdCents: 1_000,
  renewalUsdCents: 1_000,
  currency: "USD",
}));
const getMinimumRegistrationYears = mock(async () => 1);
const registerDomain = mock(async () => ({ registrationId: "registration-1" }));
const getRegisteredDomain = mock(async () => ({
  domain: "example.com",
  zoneId: "zone-1",
  expiresAt: "2027-01-01T00:00:00.000Z",
  autoRenew: true,
}));

mock.module("@/lib/services/cloudflare-registrar", () => ({
  cloudflareRegistrarService: {
    checkAvailability,
    getMinimumRegistrationYears,
    registerDomain,
    getRegisteredDomain,
  },
}));

const deductCredits = mock(async () => ({
  success: true as const,
  newBalance: 85,
  transaction: {
    id: "transaction-1",
    organization_id: "org-1",
    type: "debit",
    amount: "-14.950000",
    metadata: {
      type: "domain_purchase",
      domain: "example.com",
      domainPurchaseKey: "domain-buy:org-1:example.com",
      totalUsdCents: 1495,
    },
  },
}));
const refundCredits = mock(async () => ({ success: true }));

mock.module("@/lib/services/credits", () => ({
  creditsService: { deductCredits, refundCredits },
}));
mock.module("@/lib/services/domain-pricing", () => ({
  computeDomainPrice: () => ({
    totalUsdCents: 1_495,
    wholesaleUsdCents: 1_000,
    marginUsdCents: 495,
  }),
}));

const setCustomDomain = mock(async () => undefined);
mock.module("@/lib/services/app-domains-compat", () => ({
  appDomainsCompat: { setCustomDomain },
}));

const listRecords = mock(async () => []);
const createRecord = mock(async () => ({ id: "dns-record-1" }));
const updateRecord = mock(async () => ({ id: "dns-record-1" }));

mock.module("@/lib/services/cloudflare-dns", () => ({
  cloudflareDnsService: { listRecords, createRecord, updateRecord },
}));

const failureResponse = mock(
  (c: { json: (body: unknown, status: 500) => Response }) =>
    c.json({ success: false, error: "unhandled" }, 500),
);
mock.module("@/lib/api/cloud-worker-errors", () => ({ failureResponse }));

const logger = {
  info: mock(() => undefined),
  warn: mock(() => undefined),
  error: mock(() => undefined),
  debug: mock(() => undefined),
};
mock.module("@/lib/utils/logger", () => ({ logger }));
mock.module("@/lib/utils/error-handling", () => ({
  extractErrorMessage: (error: unknown) =>
    error instanceof Error ? error.message : String(error),
}));

const { _resetHonoRateLimitLeases, _resetRedisUnavailableFallbackBuckets } =
  await import("@/lib/middleware/rate-limit-hono-cloudflare");
const { default: buyRoute } = await import("../v1/apps/[id]/domains/buy/route");

const api = new Hono();
api.route("/api/v1/apps/:id/domains/buy", buyRoute);

const ENV = {
  NODE_ENV: "production",
  REDIS_RATE_LIMITING: "true",
  REDIS_URL: "redis://hermetic.invalid:6379",
  INFERENCE_HOT_PATH_CACHES: "true",
};

async function buy(): Promise<Response> {
  return await api.request(
    "/api/v1/apps/app-1/domains/buy",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": "eliza_domain_buy_test_key",
      },
      body: JSON.stringify({ domain: "example.com" }),
    },
    ENV,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readJsonObject(
  response: Response,
): Promise<Record<string, unknown>> {
  const body: unknown = await response.json();
  if (!isRecord(body)) throw new Error("Expected a JSON object response");
  return body;
}

function purchaseSideEffectReceipt(): Record<string, number> {
  return {
    authentication: requireUserOrApiKeyWithOrg.mock.calls.length,
    apiKeyScopeCheck: isAppKeyOutOfScope.mock.calls.length,
    appLookup: getById.mock.calls.length,
    idempotencyInsert: dbWriteInsert.mock.calls.length,
    idempotencyUpdate: dbWriteUpdate.mock.calls.length,
    idempotencyDelete: dbWriteDelete.mock.calls.length,
    idempotencyRead: dbReadSelect.mock.calls.length,
    domainLookup: getDomainByName.mock.calls.length,
    availabilityCheck: checkAvailability.mock.calls.length,
    creditDebit: deductCredits.mock.calls.length,
    creditRefund: refundCredits.mock.calls.length,
    registrarRegistration: registerDomain.mock.calls.length,
    registrarLookup: getRegisteredDomain.mock.calls.length,
    unrefundedPurchaseLookup: hasUnrefundedDomainPurchase.mock.calls.length,
    domainPersistence: upsertCloudflareRegisteredDomain.mock.calls.length,
    domainAssignment: assignToResource.mock.calls.length,
    appDomainPersistence: setCustomDomain.mock.calls.length,
    dnsList: listRecords.mock.calls.length,
    dnsCreate: createRecord.mock.calls.length,
    dnsUpdate: updateRecord.mock.calls.length,
  };
}

const ZERO_SIDE_EFFECT_RECEIPT = {
  authentication: 0,
  apiKeyScopeCheck: 0,
  appLookup: 0,
  idempotencyInsert: 0,
  idempotencyUpdate: 0,
  idempotencyDelete: 0,
  idempotencyRead: 0,
  domainLookup: 0,
  availabilityCheck: 0,
  creditDebit: 0,
  creditRefund: 0,
  registrarRegistration: 0,
  registrarLookup: 0,
  unrefundedPurchaseLookup: 0,
  domainPersistence: 0,
  domainAssignment: 0,
  appDomainPersistence: 0,
  dnsList: 0,
  dnsCreate: 0,
  dnsUpdate: 0,
} as const;

const resetMocks = [
  buildRedisClient,
  redisClient.pipeline,
  redisPipelineExec,
  redisPexpire,
  requireUserOrApiKeyWithOrg,
  isAppKeyOutOfScope,
  getById,
  dbWriteInsert,
  dbWriteValues,
  dbWriteOnConflictDoNothing,
  dbWriteReturning,
  dbWriteUpdate,
  dbWriteSet,
  dbWriteDelete,
  dbWriteWhere,
  dbReadSelect,
  dbReadFrom,
  dbReadWhere,
  dbReadLimit,
  getDomainByName,
  upsertCloudflareRegisteredDomain,
  assignToResource,
  hasUnrefundedDomainPurchase,
  checkAvailability,
  registerDomain,
  getRegisteredDomain,
  deductCredits,
  refundCredits,
  setCustomDomain,
  listRecords,
  createRecord,
  updateRecord,
  failureResponse,
  logger.info,
  logger.warn,
  logger.error,
  logger.debug,
] as const;

beforeEach(() => {
  redisMode = "healthy";
  durableAttempt = null;
  _resetHonoRateLimitLeases();
  _resetRedisUnavailableFallbackBuckets();
  for (const testMock of resetMocks) testMock.mockClear();
});

describe("POST /apps/:id/domains/buy — fail-closed rate limit", () => {
  test("GET stays 404 instead of entering the POST-only limiter", async () => {
    redisMode = "missing";

    const response = await api.request(
      "/api/v1/apps/app-1/domains/buy",
      { method: "GET" },
      ENV,
    );

    expect(response.status).toBe(404);
    expect(buildRedisClient).not.toHaveBeenCalled();
    expect(purchaseSideEffectReceipt()).toEqual(ZERO_SIDE_EFFECT_RECEIPT);
  });

  for (const mode of ["missing", "throwing"] as const) {
    test(`${mode} Redis returns 503 before every purchase side effect`, async () => {
      redisMode = mode;

      const response = await buy();

      expect(response.status).toBe(503);
      expect(response.headers.get("Retry-After")).toBe("30");
      expect(await readJsonObject(response)).toEqual({
        success: false,
        error: "Service temporarily unavailable",
        code: "rate_limit_unavailable",
        message: "Rate limiter backing store is unavailable; request rejected.",
      });
      expect(purchaseSideEffectReceipt()).toEqual(ZERO_SIDE_EFFECT_RECEIPT);
      expect(failureResponse).not.toHaveBeenCalled();
    });
  }

  test("healthy Redis reaches the unchanged successful purchase handler", async () => {
    const response = await buy();
    const body = await readJsonObject(response);

    expect(response.status).toBe(200);
    expect(body).toMatchObject({ success: true, domain: "example.com" });
    expect(redisPipelineExec).toHaveBeenCalledTimes(1);
    expect(requireUserOrApiKeyWithOrg).toHaveBeenCalledTimes(1);
    expect(dbWriteInsert).toHaveBeenCalledTimes(1);
    expect(deductCredits).toHaveBeenCalledTimes(1);
    expect(registerDomain).toHaveBeenCalledTimes(1);
    expect(upsertCloudflareRegisteredDomain).toHaveBeenCalledTimes(1);
    expect(assignToResource).toHaveBeenCalledTimes(1);
    expect(createRecord).toHaveBeenCalledTimes(1);
    expect(refundCredits).not.toHaveBeenCalled();
    expect(failureResponse).not.toHaveBeenCalled();
  });

  test("a warm healthy check cannot lease a purchase through a later Redis outage", async () => {
    const healthyResponse = await buy();
    expect(healthyResponse.status).toBe(200);
    const receiptAfterHealthyPurchase = purchaseSideEffectReceipt();

    redisMode = "throwing";
    const outageResponse = await buy();

    expect(outageResponse.status).toBe(503);
    expect(outageResponse.headers.get("Retry-After")).toBe("30");
    expect(redisPipelineExec).toHaveBeenCalledTimes(2);
    expect(purchaseSideEffectReceipt()).toEqual(receiptAfterHealthyPurchase);
  });
});
