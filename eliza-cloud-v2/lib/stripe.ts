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

let stripeInstance: Stripe | null = null;
let stripeInitError: Error | null = null;

/**
 * Get the Stripe client instance (lazy initialization).
 * Returns null if STRIPE_SECRET_KEY is not configured.
 */
function initStripe(): Stripe | null {
  if (stripeInstance) return stripeInstance;
  if (stripeInitError) return null;

  const secretKey = process.env.STRIPE_SECRET_KEY?.trim();

  if (!secretKey) {
    stripeInitError = new Error(
      "STRIPE_SECRET_KEY is not set in environment variables",
    );
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
    throw (
      stripeInitError ||
      new Error("STRIPE_SECRET_KEY is not set in environment variables")
    );
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

function createDeferredErrorProxy(): unknown {
  return new Proxy(() => {}, {
    get() {
      return createDeferredErrorProxy();
    },
    apply() {
      throw (
        stripeInitError ||
        new Error("STRIPE_SECRET_KEY is not set in environment variables")
      );
    },
  });
}

/**
 * Lazy-initialized Stripe client proxy.
 *
 * @deprecated Use `requireStripe()` instead for type-safe access.
 * This proxy allows builds to succeed without STRIPE_SECRET_KEY but provides
 * no TypeScript safety - calls will throw at runtime if not configured.
 *
 * @warning This is a Proxy object, NOT a real Stripe instance at build time.
 * TypeScript shows this as `Stripe`, but methods will throw at runtime if
 * STRIPE_SECRET_KEY is not configured.
 *
 * @throws {Error} When any method is invoked without STRIPE_SECRET_KEY configured
 */
export const stripe: Stripe = new Proxy({} as Stripe, {
  get(target, prop, receiver) {
    if (typeof prop === "symbol") {
      return undefined;
    }
    const instance = initStripe();
    if (!instance) {
      return createDeferredErrorProxy();
    }
    const value = Reflect.get(instance, prop, receiver);
    if (typeof value === "function") {
      return value.bind(instance);
    }
    return value;
  },
});

/**
 * Check if Stripe is configured (has valid secret key).
 * Use this before accessing the `stripe` proxy to avoid runtime errors.
 */
export function isStripeConfigured(): boolean {
  const key = process.env.STRIPE_SECRET_KEY?.trim();
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
export function assertStripeConfigured(): asserts stripe is Stripe {
  if (!isStripeConfigured()) {
    throw new Error("STRIPE_SECRET_KEY is not set in environment variables");
  }
}

/**
 * Default currency for Stripe transactions.
 */
export const STRIPE_CURRENCY = "usd";
