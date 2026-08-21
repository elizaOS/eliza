/**
 * Performs the operator-run, read-only Stripe test-mode certification for the
 * recurring subscription catalog, including a known-wrong fixture rejection.
 */

import { getCloudAwareEnv } from "@elizaos/cloud-shared/lib/runtime/cloud-bindings";
import {
  adaptStripeSubscriptionCatalogProvider,
  getVerifiedSubscriptionPlans,
  SubscriptionCatalogError,
  type SubscriptionCatalogProvider,
} from "@elizaos/cloud-shared/lib/services/subscription-catalog";
import { requireStripe } from "@elizaos/cloud-shared/lib/stripe";

export interface SubscriptionCatalogPreflightResult {
  catalogVersion: "v1";
  approvedPlanKeys: string[];
  approvedProviderObjects: 5;
  portalConfigurationVerified: true;
  wrongFixtureRejected: true;
  mode: "test";
}

/** Runs the read-only test-mode proof and returns its secret-free receipt. */
export async function runSubscriptionCatalogPreflight(
  options: {
    env?: NodeJS.ProcessEnv;
    provider?: SubscriptionCatalogProvider;
  } = {},
): Promise<SubscriptionCatalogPreflightResult> {
  const env = options.env ?? getCloudAwareEnv();
  const secret = env.STRIPE_SECRET_KEY?.trim() ?? "";
  if (!secret.startsWith("sk_test_") && !secret.startsWith("rk_test_")) {
    throw new Error(
      "Subscription catalog preflight requires a Stripe test-mode key",
    );
  }
  if (env.ENVIRONMENT === "production" || env.NODE_ENV === "production") {
    throw new Error("Subscription catalog preflight cannot run in production");
  }

  const wrongPriceId = env.STRIPE_SUBSCRIPTION_PREFLIGHT_WRONG_PRICE_ID?.trim();
  if (!wrongPriceId || !/^price_[A-Za-z0-9]+$/.test(wrongPriceId)) {
    throw new Error(
      "STRIPE_SUBSCRIPTION_PREFLIGHT_WRONG_PRICE_ID must name a deliberately wrong test Price",
    );
  }
  if (
    wrongPriceId === env.STRIPE_PLUS_MONTHLY_PRICE_ID?.trim() ||
    wrongPriceId === env.STRIPE_PRO_MONTHLY_PRICE_ID?.trim()
  ) {
    throw new Error(
      "STRIPE_SUBSCRIPTION_PREFLIGHT_WRONG_PRICE_ID must differ from both approved Prices",
    );
  }

  const provider =
    options.provider ?? adaptStripeSubscriptionCatalogProvider(requireStripe());
  const approved = await getVerifiedSubscriptionPlans({ env, provider });

  const wrongFixtureEnv = {
    ...env,
    STRIPE_PLUS_MONTHLY_PRICE_ID: wrongPriceId,
  };
  let wrongFixtureRejected = false;
  try {
    await getVerifiedSubscriptionPlans({ env: wrongFixtureEnv, provider });
  } catch (error) {
    if (
      error instanceof SubscriptionCatalogError &&
      error.code === "SUBSCRIPTION_CATALOG_PROVIDER_DRIFT"
    ) {
      wrongFixtureRejected = true;
    } else {
      throw error;
    }
  }
  if (!wrongFixtureRejected) {
    throw new Error(
      "Deliberately wrong Stripe fixture Price was unexpectedly accepted",
    );
  }

  return {
    catalogVersion: approved.catalogVersion,
    approvedPlanKeys: approved.plans.map((plan) => plan.key),
    approvedProviderObjects: 5,
    portalConfigurationVerified: true,
    wrongFixtureRejected: true,
    mode: "test",
  };
}

if (import.meta.main) {
  try {
    process.stdout.write(
      `${JSON.stringify(await runSubscriptionCatalogPreflight())}\n`,
    );
  } catch (error) {
    // error-policy:J1 The operator CLI reports only a safe summary and never
    // prints provider identifiers, secret keys, or raw Stripe response objects.
    process.stderr.write(
      `${error instanceof Error ? error.message : "Subscription catalog preflight failed"}\n`,
    );
    process.exitCode = 1;
  }
}
