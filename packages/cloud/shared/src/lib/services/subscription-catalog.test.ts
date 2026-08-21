/**
 * Exercises the recurring catalog authority with deterministic provider
 * objects, including configuration, drift, cache, and disclosure boundaries.
 */

import { beforeEach, describe, expect, test } from "bun:test";
import type { SubscriptionPlanDto } from "../types/cloud-api";
import {
  __buildSubscriptionCatalogForTests,
  __publicSubscriptionPlansForTests,
  __resetSubscriptionCatalogCacheForTests,
  getVerifiedSubscriptionPlans,
  SubscriptionCatalogError,
  type SubscriptionCatalogProvider,
  type SubscriptionCatalogProviderPrice,
  type SubscriptionCatalogProviderProduct,
  validateSubscriptionCatalogConfiguration,
} from "./subscription-catalog";

const TEST_ENV = {
  ENVIRONMENT: "staging",
  NODE_ENV: "test",
  STRIPE_SECRET_KEY: "sk_test_catalog123",
  STRIPE_PLUS_MONTHLY_PRICE_ID: "price_plus123",
  STRIPE_PLUS_PRODUCT_ID: "prod_plus123",
  STRIPE_PRO_MONTHLY_PRICE_ID: "price_pro123",
  STRIPE_PRO_PRODUCT_ID: "prod_pro123",
} satisfies NodeJS.ProcessEnv;

interface ProviderOverrides {
  prices?: Partial<Record<string, Partial<SubscriptionCatalogProviderPrice>>>;
  products?: Partial<Record<string, Partial<SubscriptionCatalogProviderProduct>>>;
  failPrice?: boolean;
}

function createProvider(overrides: ProviderOverrides = {}): {
  provider: SubscriptionCatalogProvider;
  priceCalls: string[];
  productCalls: string[];
} {
  const publicPlans = __publicSubscriptionPlansForTests();
  const planByPrice = new Map([
    [TEST_ENV.STRIPE_PLUS_MONTHLY_PRICE_ID, publicPlans.plans[0]],
    [TEST_ENV.STRIPE_PRO_MONTHLY_PRICE_ID, publicPlans.plans[1]],
  ]);
  const productByPrice = new Map([
    [TEST_ENV.STRIPE_PLUS_MONTHLY_PRICE_ID, TEST_ENV.STRIPE_PLUS_PRODUCT_ID],
    [TEST_ENV.STRIPE_PRO_MONTHLY_PRICE_ID, TEST_ENV.STRIPE_PRO_PRODUCT_ID],
  ]);
  const priceCalls: string[] = [];
  const productCalls: string[] = [];
  return {
    priceCalls,
    productCalls,
    provider: {
      async retrievePrice(priceId) {
        priceCalls.push(priceId);
        if (overrides.failPrice) throw new Error("provider transport unavailable");
        const plan = planByPrice.get(priceId);
        if (!plan) throw new Error("unknown fixture price");
        return {
          active: true,
          currency: plan.currency,
          unitAmount: plan.amountCents,
          type: "recurring",
          billingScheme: "per_unit",
          transformQuantity: null,
          recurring: {
            interval: plan.interval,
            intervalCount: plan.intervalCount,
            trialPeriodDays: null,
            usageType: "licensed",
          },
          productId: productByPrice.get(priceId) ?? null,
          livemode: false,
          ...overrides.prices?.[priceId],
        };
      },
      async retrieveProduct(productId) {
        productCalls.push(productId);
        return {
          active: true,
          deleted: false,
          livemode: false,
          ...overrides.products?.[productId],
        };
      },
    },
  };
}

beforeEach(() => {
  __resetSubscriptionCatalogCacheForTests();
});

describe("subscription catalog contract", () => {
  test("contains exactly the immutable ratified v1 plans", () => {
    const catalog = __publicSubscriptionPlansForTests();
    expect(catalog).toEqual({
      catalogVersion: "v1",
      plans: [
        {
          key: "plus_monthly",
          name: "Plus",
          catalogVersion: "v1",
          active: true,
          interval: "month",
          intervalCount: 1,
          currency: "usd",
          amountCents: 3_000,
          allowance: {
            amountUsd: "25.000000",
            fundingClass: "allowance_eligible",
            rollover: false,
            expiresAt: "billing_period_end",
          },
          fundingClasses: ["allowance_eligible", "cash_only"],
          rateLimits: {
            completionsRpm: 120,
            embeddingsRpm: 200,
            standardRpm: 60,
            strictRpm: 10,
          },
          resourceCeilings: null,
        },
        {
          key: "pro_monthly",
          name: "Pro",
          catalogVersion: "v1",
          active: true,
          interval: "month",
          intervalCount: 1,
          currency: "usd",
          amountCents: 10_000,
          allowance: {
            amountUsd: "90.000000",
            fundingClass: "allowance_eligible",
            rollover: false,
            expiresAt: "billing_period_end",
          },
          fundingClasses: ["allowance_eligible", "cash_only"],
          rateLimits: {
            completionsRpm: 300,
            embeddingsRpm: 600,
            standardRpm: 120,
            strictRpm: 30,
          },
          resourceCeilings: null,
        },
      ],
    });
    expect(Object.isFrozen(catalog)).toBe(true);
    expect(Object.isFrozen(catalog.plans)).toBe(true);
    expect(Object.isFrozen(catalog.plans[0]?.rateLimits)).toBe(true);
  });

  test("rejects duplicate keys instead of silently replacing a plan", () => {
    const plus = __publicSubscriptionPlansForTests().plans[0] as SubscriptionPlanDto;
    expect(() => __buildSubscriptionCatalogForTests([plus, { ...plus }])).toThrow(
      "duplicate plan key",
    );
  });

  test("rejects non-canonical six-decimal allowance money", () => {
    const [plus, pro] = __publicSubscriptionPlansForTests().plans;
    expect(() =>
      __buildSubscriptionCatalogForTests([
        { ...plus, allowance: { ...plus?.allowance, amountUsd: "025.000000" } },
        pro,
      ]),
    ).toThrow();
  });

  test("public DTO serialization contains no Stripe or provider identifiers", () => {
    const serialized = JSON.stringify(__publicSubscriptionPlansForTests());
    expect(serialized.toLowerCase()).not.toContain("stripe");
    expect(serialized).not.toMatch(/(?:price|prod)_[A-Za-z0-9]+/);
    expect(serialized).not.toContain("secret");
  });
});

describe("subscription catalog configuration", () => {
  test("accepts only complete, deployment-matched server bindings", () => {
    expect(() => validateSubscriptionCatalogConfiguration(TEST_ENV)).not.toThrow();
    expect(() =>
      validateSubscriptionCatalogConfiguration({
        ...TEST_ENV,
        ENVIRONMENT: "production",
        STRIPE_SECRET_KEY: "sk_live_catalog123",
      }),
    ).not.toThrow();
  });

  test.each([
    ["missing price", { STRIPE_PLUS_MONTHLY_PRICE_ID: undefined }],
    ["blank product", { STRIPE_PRO_PRODUCT_ID: " " }],
    ["malformed id", { STRIPE_PLUS_PRODUCT_ID: "acct_wrong" }],
    ["price in product binding", { STRIPE_PLUS_PRODUCT_ID: "price_wrong123" }],
    ["product in price binding", { STRIPE_PLUS_MONTHLY_PRICE_ID: "prod_wrong123" }],
    ["duplicate price", { STRIPE_PRO_MONTHLY_PRICE_ID: "price_plus123" }],
    ["duplicate product", { STRIPE_PRO_PRODUCT_ID: "prod_plus123" }],
    ["live key in staging", { STRIPE_SECRET_KEY: "sk_live_catalog123" }],
    [
      "test key in production",
      { ENVIRONMENT: "production", STRIPE_SECRET_KEY: "sk_test_catalog123" },
    ],
  ])("rejects %s", (_name, changes) => {
    expect(() => validateSubscriptionCatalogConfiguration({ ...TEST_ENV, ...changes })).toThrow(
      SubscriptionCatalogError,
    );
  });
});

describe("Stripe provider authority", () => {
  test("publishes only after both Price and Product objects match", async () => {
    const fixture = createProvider();
    await expect(
      getVerifiedSubscriptionPlans({ env: TEST_ENV, provider: fixture.provider }),
    ).resolves.toEqual(__publicSubscriptionPlansForTests());
    expect(fixture.priceCalls).toHaveLength(2);
    expect(fixture.productCalls).toHaveLength(2);
  });

  test.each([
    ["price activity", { active: false }],
    ["currency", { currency: "eur" }],
    ["non-canonical currency case", { currency: "USD" }],
    ["amount", { unitAmount: 2_999 }],
    ["price kind", { type: "one_time" }],
    ["billing scheme", { billingScheme: "tiered" }],
    ["quantity transform", { transformQuantity: { divideBy: 10, round: "up" } }],
    ["recurrence", { recurring: null }],
    [
      "interval",
      {
        recurring: {
          interval: "year",
          intervalCount: 1,
          trialPeriodDays: null,
          usageType: "licensed",
        },
      },
    ],
    [
      "interval count",
      {
        recurring: {
          interval: "month",
          intervalCount: 2,
          trialPeriodDays: null,
          usageType: "licensed",
        },
      },
    ],
    [
      "default trial",
      {
        recurring: {
          interval: "month",
          intervalCount: 1,
          trialPeriodDays: 7,
          usageType: "licensed",
        },
      },
    ],
    [
      "usage type",
      {
        recurring: {
          interval: "month",
          intervalCount: 1,
          trialPeriodDays: null,
          usageType: "metered",
        },
      },
    ],
    ["approved product", { productId: "prod_unapproved" }],
    ["price livemode", { livemode: true }],
  ] satisfies Array<[string, Partial<SubscriptionCatalogProviderPrice>]>)(
    "rejects %s drift",
    async (_name, changes) => {
      const fixture = createProvider({
        prices: { [TEST_ENV.STRIPE_PLUS_MONTHLY_PRICE_ID]: changes },
      });
      await expect(
        getVerifiedSubscriptionPlans({ env: TEST_ENV, provider: fixture.provider }),
      ).rejects.toMatchObject({ code: "SUBSCRIPTION_CATALOG_PROVIDER_DRIFT" });
    },
  );

  test.each([
    ["inactive product", { active: false }],
    ["deleted product", { deleted: true }],
    ["product livemode", { livemode: true }],
  ] satisfies Array<[string, Partial<SubscriptionCatalogProviderProduct>]>)(
    "rejects %s drift",
    async (_name, changes) => {
      const fixture = createProvider({
        products: { [TEST_ENV.STRIPE_PLUS_PRODUCT_ID]: changes },
      });
      await expect(
        getVerifiedSubscriptionPlans({ env: TEST_ENV, provider: fixture.provider }),
      ).rejects.toMatchObject({ code: "SUBSCRIPTION_CATALOG_PROVIDER_DRIFT" });
    },
  );

  test("coalesces successful lookups briefly and revalidates after expiry", async () => {
    const fixture = createProvider();
    let now = 1_000;
    await Promise.all([
      getVerifiedSubscriptionPlans({ env: TEST_ENV, provider: fixture.provider, now: () => now }),
      getVerifiedSubscriptionPlans({ env: TEST_ENV, provider: fixture.provider, now: () => now }),
    ]);
    expect(fixture.priceCalls).toHaveLength(2);
    now += 5 * 60 * 1_000 + 1;
    await getVerifiedSubscriptionPlans({
      env: TEST_ENV,
      provider: fixture.provider,
      now: () => now,
    });
    expect(fixture.priceCalls).toHaveLength(4);
  });

  test("does not reuse provider verification after a Stripe credential rotation", async () => {
    const fixture = createProvider();
    await getVerifiedSubscriptionPlans({ env: TEST_ENV, provider: fixture.provider });
    await getVerifiedSubscriptionPlans({
      env: { ...TEST_ENV, STRIPE_SECRET_KEY: "sk_test_rotatedCatalog456" },
      provider: fixture.provider,
    });
    expect(fixture.priceCalls).toHaveLength(4);
    expect(fixture.productCalls).toHaveLength(4);
  });

  test("never caches a provider failure", async () => {
    const fixture = createProvider({ failPrice: true });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await expect(
        getVerifiedSubscriptionPlans({ env: TEST_ENV, provider: fixture.provider }),
      ).rejects.toMatchObject({ code: "SUBSCRIPTION_CATALOG_PROVIDER_UNAVAILABLE" });
    }
    expect(fixture.priceCalls).toHaveLength(4);
  });

  test("rejects malformed provider response shapes before field access", async () => {
    const fixture = createProvider();
    fixture.provider.retrievePrice = async () =>
      ({ active: true, currency: 7 }) as unknown as SubscriptionCatalogProviderPrice;
    await expect(
      getVerifiedSubscriptionPlans({ env: TEST_ENV, provider: fixture.provider }),
    ).rejects.toMatchObject({
      code: "SUBSCRIPTION_CATALOG_PROVIDER_DRIFT",
      context: { field: "price.shape" },
    });
  });
});
