/** Exercises unavailable billing settings through the real service and HTTP route with deterministic storage. */
import { beforeEach, expect, mock, test } from "bun:test";
import type { Organization } from "@/db/repositories";

const NOW = new Date("2026-08-17T00:00:00.000Z");

interface BillingAttributionFixture {
  userId: string | null;
  affiliateCode: {
    id: string;
    user_id: string;
    markup_percent: string;
  } | null;
}

const findOrganizationById = mock(
  async (): Promise<
    | Pick<
        Organization,
        | "id"
        | "auto_top_up_enabled"
        | "auto_top_up_amount"
        | "auto_top_up_threshold"
        | "stripe_default_payment_method"
        | "pay_as_you_go_from_earnings"
      >
    | undefined
  > => undefined,
);
const updateOrganization = mock(
  async (): Promise<Organization | undefined> => undefined,
);
const getControl = mock(async () => ({
  mode: "durable" as const,
  pausedAt: NOW,
  legacyReconciledThrough: NOW,
}));
const findBlockingByOrganization = mock(async () => null);
const findBlockingLegacyPaymentByOrganization = mock(async () => null);
const listUsersByOrganization = mock(async () => []);
const getBillingAttributionForOrganization = mock(
  async (): Promise<BillingAttributionFixture> => ({
    userId: null,
    affiliateCode: null,
  }),
);

mock.module("@/db/repositories", () => ({
  affiliatesRepository: {
    getBillingAttributionForOrganization,
  },
  autoTopUpAttemptsRepository: {
    getControl,
    findBlockingByOrganization,
    findBlockingLegacyPaymentByOrganization,
  },
  organizationsRepository: {
    findById: findOrganizationById,
    update: updateOrganization,
  },
  usersRepository: {
    listByOrganization: listUsersByOrganization,
  },
}));

const onCreditMutation = mock(async () => undefined);
const onOrganizationUpdated = mock(async () => undefined);
mock.module("@/lib/cache/invalidation", () => ({
  CacheInvalidation: {
    onCreditMutation,
    onOrganizationUpdated,
  },
}));

const invalidateOrganizationCache = mock(async () => undefined);
mock.module("@/lib/cache/organizations-cache", () => ({
  invalidateOrganizationCache,
}));

const invalidateOrgTierCache = mock(async () => undefined);
mock.module("@/lib/services/org-rate-limits", () => ({
  invalidateOrgTierCache,
}));

const sendAutoTopUpSuccessEmail = mock(async () => true);
const sendAutoTopUpDisabledEmail = mock(async () => true);
mock.module("@/lib/services/email", () => ({
  emailService: {
    sendAutoTopUpSuccessEmail,
    sendAutoTopUpDisabledEmail,
  },
}));

mock.module("@/lib/utils/logger", () => ({
  logger: {
    debug: mock(),
    error: mock(),
    info: mock(),
    warn: mock(),
  },
}));

const ensureStripeCustomer = mock(async () => "cus_123");
mock.module("@/lib/services/stripe-customer-authority", () => ({
  stripeCustomerAuthorityService: { ensure: ensureStripeCustomer },
}));

mock.module("@/lib/auth/workers-hono-auth", () => ({
  requireUserOrApiKeyWithOrg: async () => ({
    id: "user-1",
    organization_id: "org-1",
  }),
  requireCurrentBillingManagerSession: async () => ({
    id: "user-1",
    organization_id: "org-1",
  }),
}));
mock.module("@/lib/middleware/rate-limit-hono-cloudflare", () => ({
  RateLimitPresets: { STANDARD: {} },
  rateLimit: () => async (_c: unknown, next: () => Promise<void>) => next(),
  moneyRateLimit: () => async (_c: unknown, next: () => Promise<void>) =>
    next(),
}));
const { default: route } = await import("./route");
test("real getSettings missing organization uses advertised unavailable response", async () => {
  findOrganizationById.mockResolvedValue(undefined);
  const response = await route.request("http://internal/");
  expect(await response.json()).toEqual(
    expect.objectContaining({
      success: false,
      code: "service_unavailable",
      error: "Billing settings are unavailable",
    }),
  );
  expect(updateOrganization).not.toHaveBeenCalled();
  expect(response.status).toBe(503);
});

beforeEach(() => {
  findOrganizationById.mockResolvedValue(undefined);
  updateOrganization.mockClear();
  invalidateOrganizationCache.mockClear();
  onOrganizationUpdated.mockClear();
});

test("real updateSettings missing organization returns PUT unavailable without mutations", async () => {
  const response = await route.request("http://internal/", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ autoTopUp: { enabled: false } }),
  });
  expect(response.status).toBe(503);
  expect(await response.json()).toMatchObject({
    success: false,
    code: "service_unavailable",
    error: "Billing settings are unavailable",
  });
  expect(updateOrganization).not.toHaveBeenCalled();
  expect(invalidateOrganizationCache).not.toHaveBeenCalled();
  expect(onOrganizationUpdated).not.toHaveBeenCalled();
});

test.each([{}, { autoTopUp: {} }, { ignored: true }])(
  "PUT with no recognized changes preserves storage and caches: %p",
  async (body) => {
    findOrganizationById.mockResolvedValue({
      id: "org-1",
      auto_top_up_enabled: false,
      auto_top_up_amount: "10.00",
      auto_top_up_threshold: "5.00",
      stripe_default_payment_method: null,
      pay_as_you_go_from_earnings: false,
    });
    const response = await route.request("http://internal/", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      success: true,
      settings: {
        autoTopUp: {
          enabled: false,
          amount: 10,
          threshold: 5,
          hasPaymentMethod: false,
        },
        payAsYouGoFromEarnings: false,
      },
    });
    expect(updateOrganization).not.toHaveBeenCalled();
    expect(invalidateOrganizationCache).not.toHaveBeenCalled();
    expect(onOrganizationUpdated).not.toHaveBeenCalled();
  },
);
