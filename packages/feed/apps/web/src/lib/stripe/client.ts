/**
 * Stripe Client-Side Configuration
 *
 * Client-side Stripe SDK instance for browser usage.
 * Uses the publishable key for client-to-Stripe communication.
 */

import { logger } from "@feed/shared";
import { loadStripe, type Stripe } from "@stripe/stripe-js";

let stripePromise: Promise<Stripe | null> | null = null;
let stripeDisabledLogged = false;

/**
 * Get or create a Stripe client instance
 *
 * Uses lazy loading to avoid importing Stripe.js until needed.
 * Caches the instance for reuse across the application.
 * Also caches the disabled state to avoid logging on every call.
 */
export function getStripe(): Promise<Stripe | null> {
  if (!stripePromise) {
    const publishableKey = process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY;

    if (!publishableKey) {
      // Only log once to avoid console spam
      if (!stripeDisabledLogged) {
        logger.error(
          "NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY is not configured",
          undefined,
          "Stripe",
        );
        stripeDisabledLogged = true;
      }
      // Cache the null promise so we don't re-check on every call
      stripePromise = Promise.resolve(null);
      return stripePromise;
    }

    stripePromise = loadStripe(publishableKey);
  }

  return stripePromise;
}

/**
 * Check if Stripe is enabled
 *
 * Stripe is enabled when the publishable key is configured.
 * This can be used to conditionally show the Stripe payment option.
 */
export function isStripeEnabled(): boolean {
  return Boolean(process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY);
}
