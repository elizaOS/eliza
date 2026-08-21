/**
 * Exercises the operator preflight with deterministic provider objects so a
 * duplicate or unavailable Price cannot masquerade as real drift evidence.
 */

import { beforeEach, describe, expect, test } from "bun:test";
import {
  __resetSubscriptionCatalogCacheForTests,
  type SubscriptionCatalogProvider,
} from "@elizaos/cloud-shared/lib/services/subscription-catalog";
import { runSubscriptionCatalogPreflight } from "./preflight-subscription-catalog";

const ENV = {
  ENVIRONMENT: "staging",
  NODE_ENV: "test",
  STRIPE_SECRET_KEY: "sk_test_preflight123",
  STRIPE_PLUS_MONTHLY_PRICE_ID: "price_plus123",
  STRIPE_PLUS_PRODUCT_ID: "prod_plus123",
  STRIPE_PRO_MONTHLY_PRICE_ID: "price_pro123",
  STRIPE_PRO_PRODUCT_ID: "prod_pro123",
  STRIPE_SUBSCRIPTION_PREFLIGHT_WRONG_PRICE_ID: "price_wrong123",
} satisfies NodeJS.ProcessEnv;

function provider(
  options: { unknownWrong?: boolean } = {},
): SubscriptionCatalogProvider {
  return {
    async retrievePrice(priceId) {
      if (priceId === "price_wrong123") {
        if (options.unknownWrong) throw new Error("No such price");
        return {
          active: true,
          currency: "usd",
          unitAmount: 2_999,
          type: "recurring",
          billingScheme: "per_unit",
          recurring: {
            interval: "month",
            intervalCount: 1,
            usageType: "licensed",
          },
          productId: "prod_plus123",
          livemode: false,
        };
      }
      const plus = priceId === "price_plus123";
      return {
        active: true,
        currency: "usd",
        unitAmount: plus ? 3_000 : 10_000,
        type: "recurring",
        billingScheme: "per_unit",
        recurring: {
          interval: "month",
          intervalCount: 1,
          usageType: "licensed",
        },
        productId: plus ? "prod_plus123" : "prod_pro123",
        livemode: false,
      };
    },
    async retrieveProduct() {
      return { active: true, deleted: false, livemode: false };
    },
  };
}

beforeEach(() => {
  __resetSubscriptionCatalogCacheForTests();
});

describe("subscription catalog operator preflight", () => {
  test("proves approved objects and exact wrong-Price drift", async () => {
    await expect(
      runSubscriptionCatalogPreflight({ env: ENV, provider: provider() }),
    ).resolves.toEqual({
      catalogVersion: "v1",
      approvedPlanKeys: ["plus_monthly", "pro_monthly"],
      approvedProviderObjects: 4,
      wrongFixtureRejected: true,
      mode: "test",
    });
  });

  test("does not count provider unavailability as wrong-Price drift proof", async () => {
    await expect(
      runSubscriptionCatalogPreflight({
        env: ENV,
        provider: provider({ unknownWrong: true }),
      }),
    ).rejects.toMatchObject({
      code: "SUBSCRIPTION_CATALOG_PROVIDER_UNAVAILABLE",
    });
  });

  test("requires the wrong fixture to differ from both approved Prices", async () => {
    await expect(
      runSubscriptionCatalogPreflight({
        env: {
          ...ENV,
          STRIPE_SUBSCRIPTION_PREFLIGHT_WRONG_PRICE_ID:
            ENV.STRIPE_PRO_MONTHLY_PRICE_ID,
        },
        provider: provider(),
      }),
    ).rejects.toThrow("must differ from both approved Prices");
  });
});
