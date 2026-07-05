/**
 * Stripe integration for payment processing.
 *
 * Uses lazy initialization to allow the app to build without
 * STRIPE_SECRET_KEY set. The error is thrown only when Stripe
 * methods are actually invoked at runtime.
 *
 * @example
 * // RECOMMENDED: Use requireStripe() for type-safe access
 * import { requireStripe } from "./stripe";
 *
 * const stripe = requireStripe(); // throws if not configured
 * const customer = await stripe.customers.create({ email });
 *
 * @example
 * // For graceful degradation, check first
 * import { isStripeConfigured, requireStripe } from "./stripe";
 *
 * if (!isStripeConfigured()) {
 *   return { error: "Payment processing is not configured" };
 * }
 * const stripe = requireStripe();
 * const customer = await stripe.customers.create({ email });
 */

import Stripe from "stripe";
import {
  shouldBlockLiveStripeKeyOutsideProduction,
  shouldWarnTestStripeKeyInProduction,
} from "./config/deployment-environment";
import { getCloudAwareEnv } from "./runtime/cloud-bindings";
import { logger } from "./utils/logger";

type PinnedStripeApiVersion = Stripe.WebhookEndpointCreateParams.ApiVersion;
type StripeConstructorConfig = NonNullable<ConstructorParameters<typeof Stripe>[1]>;

const STRIPE_API_VERSION: PinnedStripeApiVersion = "2024-11-20.acacia";

let stripeInstance: Stripe | null = null;
let stripeInitError: Error | null = null;

/**
 * Get the Stripe client instance (lazy initialization).
 * Returns null if STRIPE_SECRET_KEY is not configured.
 */
function initStripe(): Stripe | null {
  if (stripeInstance) return stripeInstance;
  if (stripeInitError) return null;

  const env = getCloudAwareEnv();
  const secretKey = env.STRIPE_SECRET_KEY?.trim();

  if (!secretKey) {
    stripeInitError = new Error("STRIPE_SECRET_KEY is not set in environment variables");
    return null;
  }

  if (!secretKey.startsWith("sk_")) {
    stripeInitError = new Error(
      `STRIPE_SECRET_KEY appears invalid (should start with 'sk_', got '${secretKey.substring(0, 3)}...'). Please verify your Stripe configuration.`,
    );
    return null;
  }

  // Fail closed on live keys outside production (#13752). Staging bound to
  // prod's sk_live_ key produced cs_live checkout sessions, letting QA pay
  // real money into the staging database. Never initialize a live-mode
  // client unless this deployment is production.
  if (shouldBlockLiveStripeKeyOutsideProduction(env)) {
    stripeInitError = new Error(
      "SECURITY: STRIPE_SECRET_KEY is a LIVE-mode key (sk_live_/rk_live_) but this deployment is not production (ENVIRONMENT/NODE_ENV). Refusing to initialize Stripe: live keys outside prod let checkouts charge real money into a non-prod database (#13752). Bind a test-mode key (sk_test_) to this environment.",
    );
    logger.error(`[Stripe] ${stripeInitError.message}`);
    return null;
  }

  // Reverse misconfiguration: production on a TEST key silently "collects"
  // fake money. Loud warning, not fatal, so a prod deploy is not bricked.
  if (shouldWarnTestStripeKeyInProduction(env)) {
    logger.warn(
      "[Stripe] STRIPE_SECRET_KEY is a TEST-mode key (sk_test_) in a production deployment. Checkouts will not move real money. Verify the environment's Stripe secrets (#13752).",
    );
  }

  stripeInstance = new Stripe(secretKey, {
    typescript: true,
    apiVersion: STRIPE_API_VERSION as StripeConstructorConfig["apiVersion"],
  });
  return stripeInstance;
}

/**
 * Get the Stripe client instance.
 * Throws an error if STRIPE_SECRET_KEY is not configured.
 *
 * @throws {Error} If STRIPE_SECRET_KEY is not configured
 * @returns {Stripe} The initialized Stripe client
 */
export function getStripe(): Stripe {
  const instance = initStripe();
  if (!instance) {
    throw stripeInitError || new Error("STRIPE_SECRET_KEY is not set in environment variables");
  }
  return instance;
}

/**
 * Get a type-safe Stripe client instance.
 * This is the RECOMMENDED way to access Stripe - it throws early if not configured.
 *
 * @throws {Error} If STRIPE_SECRET_KEY is not configured
 * @returns {Stripe} The initialized Stripe client
 *
 * @example
 * const stripe = requireStripe();
 * await stripe.customers.create({ email: "test@example.com" });
 */
export function requireStripe(): Stripe {
  return getStripe();
}

/**
 * Check if Stripe is configured (has valid secret key).
 * Use this before calling `requireStripe()` to avoid runtime errors.
 */
export function isStripeConfigured(): boolean {
  const env = getCloudAwareEnv();
  const key = env.STRIPE_SECRET_KEY?.trim();
  if (!key || !key.startsWith("sk_")) {
    return false;
  }
  // A live key outside production is treated as NOT configured (#13752):
  // callers that gate on this helper degrade gracefully instead of creating
  // real-money checkout sessions against a non-prod database.
  return !shouldBlockLiveStripeKeyOutsideProduction(env);
}

/**
 * Assert that Stripe is configured, throwing an error if not.
 * Use this at the start of functions that require Stripe to be available.
 *
 * @throws {Error} If STRIPE_SECRET_KEY is not configured
 *
 * @example
 * export async function createCustomer(email: string) {
 *   assertStripeConfigured();
 *   // Safe to use stripe after this point
 *   return stripe.customers.create({ email });
 * }
 */
export function assertStripeConfigured(): void {
  if (!isStripeConfigured()) {
    throw new Error("STRIPE_SECRET_KEY is not set in environment variables");
  }
}

/**
 * Reset the cached Stripe client/init error. Test-only: lets unit tests
 * exercise initStripe() under different STRIPE_SECRET_KEY / environment
 * combinations (the module otherwise caches the first outcome).
 */
export function __resetStripeForTests(): void {
  stripeInstance = null;
  stripeInitError = null;
}

/**
 * Default currency for Stripe transactions.
 */
export const STRIPE_CURRENCY = "usd";
