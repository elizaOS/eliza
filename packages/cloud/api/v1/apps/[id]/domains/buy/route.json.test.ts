/**
 * Exercises the domain-buy JSON decoding boundary with deterministic mocks.
 * Malformed JSON is a client error while internal decoder failures stay server errors.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";

mock.module("@elizaos/plugin-todos/edge", () => ({
  convergeTodoScopesInTransaction: async () => undefined,
}));

const getById = mock(async () => null);
const failureResponse = mock(
  (c: { json: (body: unknown, status: 500) => Response }, _error: unknown) =>
    c.json({ success: false, error: "unhandled" }, 500),
);

mock.module("@/lib/api/cloud-worker-errors", () => ({ failureResponse }));

mock.module("@/db/client", () => ({
  dbRead: {},
  dbWrite: {
    insert: () => ({
      values: async () => {
        throw new Error("dbWrite.insert must not run on malformed JSON");
      },
    }),
  },
}));

mock.module("@/db/repositories/credit-transactions", () => ({
  creditTransactionsRepository: {},
}));

mock.module("@/db/schemas/domain-purchase-idempotency", () => ({
  domainPurchaseIdempotency: {},
}));

mock.module("@/lib/auth/workers-hono-auth", () => ({
  requireUserOrApiKeyWithOrg: async () => ({
    id: "user-1",
    organization_id: "org-1",
  }),
  readSessionCredential: () => undefined,
}));

mock.module("@/lib/middleware/rate-limit-hono-cloudflare", () => ({
  RateLimitPresets: {
    STANDARD: {},
    CRITICAL: {},
  },
  rateLimit: () => async (_c: unknown, next: () => Promise<void>) => next(),
}));

mock.module("@/lib/auth/app-key-scope", () => ({
  isAppKeyOutOfScope: async () => false,
}));

mock.module("drizzle-orm", () => ({
  eq: () => undefined,
}));

mock.module("@/lib/services/apps", () => ({
  appsService: { getById },
}));

mock.module("@/lib/services/app-domains-compat", () => ({
  appDomainsCompat: {},
}));

mock.module("@/lib/services/cloudflare-dns", () => ({
  cloudflareDnsService: {},
}));

mock.module("@/lib/services/cloudflare-registrar", () => ({
  cloudflareRegistrarService: {},
}));

mock.module("@/lib/services/credits", () => ({
  creditsService: {},
}));

mock.module("@/lib/services/domain-pricing", () => ({
  computeDomainPrice: () => ({ totalUsdCents: 0 }),
}));

mock.module("@/lib/services/managed-domains", () => ({
  managedDomainsService: {},
}));

mock.module("@/lib/runtime/cloud-bindings", () => ({
  getCloudAwareEnv: () => ({}),
}));

mock.module("@/lib/utils/error-handling", () => ({
  extractErrorMessage: (error: unknown) => String(error),
}));

mock.module("@/lib/utils/logger", () => ({
  logger: {
    debug: () => undefined,
    error: () => undefined,
    info: () => undefined,
    warn: () => undefined,
  },
}));

const { default: buy } = await import("./route");
const app = new Hono();
app.route("/:id", buy);

describe("POST /api/v1/apps/:id/domains/buy malformed JSON", () => {
  beforeEach(() => {
    getById.mockClear();
    failureResponse.mockClear();
  });

  test("returns 400 instead of 500 and never looks up the app", async () => {
    const response = await app.request("/app-1", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{",
    });
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: "Invalid JSON body",
    });
    expect(getById).not.toHaveBeenCalled();
  });

  test("canonical JSON still looks up the app", async () => {
    const response = await app.request("/app-1", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ domain: "example.com" }),
    });
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({
      error: "App not found",
    });
    expect(getById).toHaveBeenCalled();
  });

  test("does not misclassify an internal request decoding failure as malformed JSON", async () => {
    const internalError = new TypeError("request stream unavailable");
    const request = new Request("http://localhost/app-1", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ domain: "example.com" }),
    });
    request.text = async () => {
      throw internalError;
    };

    const response = await app.fetch(request);

    expect(response.status).toBe(500);
    expect(failureResponse).toHaveBeenCalledTimes(1);
    expect(failureResponse.mock.calls[0]?.[1]).toBe(internalError);
    expect(getById).not.toHaveBeenCalled();
  });
});
