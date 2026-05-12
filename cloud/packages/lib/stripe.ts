/**
 * Stripe integration for payment processing.
 *
 * Uses lazy initialization to allow the app to build without
 * STRIPE_SECRET_KEY set. The error is thrown only when Stripe
 * methods are actually invoked at runtime.
 *
 * @example
 * // RECOMMENDED: Use requireStripe() for type-safe access
 * import { requireStripe } from "@/lib/stripe";
 *
 * const stripe = requireStripe(); // throws if not configured
 * const customer = await stripe.customers.create({ email });
 *
 * @example
 * // For graceful degradation, check first
 * import { isStripeConfigured, requireStripe } from "@/lib/stripe";
 *
 * if (!isStripeConfigured()) {
 *   return { error: "Payment processing is not configured" };
 * }
 * const stripe = requireStripe();
 * const customer = await stripe.customers.create({ email });
 */

import Stripe from "stripe";
import { getCloudAwareEnv } from "@/lib/runtime/cloud-bindings";

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

  const secretKey = getCloudAwareEnv().STRIPE_SECRET_KEY?.trim();

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
  const key = getCloudAwareEnv().STRIPE_SECRET_KEY?.trim();
  return !!key && key.startsWith("sk_");
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
 * Default currency for Stripe transactions.
 */
export const STRIPE_CURRENCY = "usd";
