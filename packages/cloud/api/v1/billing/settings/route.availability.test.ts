/** Exercises unavailable billing settings through the real service and HTTP route with deterministic storage. */
import { expect, mock, test } from "bun:test";
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
  async (): Promise<Organization | undefined> => undefined,
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
