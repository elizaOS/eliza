/**
 * Stripe Server-Side Configuration
 *
 * Server-side Stripe SDK instance for API routes.
 * Uses the secret key for server-to-server communication.
 */

import Stripe from "stripe";

/**
 * Lazily initialized Stripe instance
 * This allows helper functions to be imported without requiring STRIPE_SECRET_KEY
 * (useful for testing pure functions like calculatePointsFromUSD)
 */
let _stripe: Stripe | null = null;

/**
 * Server-side Stripe instance
 *
 * Used in API routes for:
 * - Creating Checkout Sessions
 * - Verifying webhook signatures
 * - Retrieving payment information
 *
 * @throws Error if STRIPE_SECRET_KEY is not set
 */
export function getStripeInstance(): Stripe {
  if (!_stripe) {
    if (!process.env.STRIPE_SECRET_KEY) {
      throw new Error("STRIPE_SECRET_KEY environment variable is required");
    }
    _stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
      apiVersion: "2026-02-25.clover",
      typescript: true,
    });
  }
  return _stripe;
}

/**
 * Convenience export for direct access (throws if STRIPE_SECRET_KEY not set)
 */
export const stripe = {
  get checkout() {
    return getStripeInstance().checkout;
  },
  get webhooks() {
    return getStripeInstance().webhooks;
  },
  get charges() {
    return getStripeInstance().charges;
  },
};

/**
 * Points pricing configuration
 *
 * 100 points = $1 USD
 * Minimum: $1 (100 points)
 * Maximum: $1000 (100,000 points)
 */
export const POINTS_CONFIG = {
  POINTS_PER_DOLLAR: 100,
  MIN_AMOUNT_USD: 1,
  MAX_AMOUNT_USD: 1000,
  CURRENCY: "usd",
} as const;

/**
 * Calculate points from USD amount
 */
export function calculatePointsFromUSD(amountUSD: number): number {
  return Math.floor(amountUSD * POINTS_CONFIG.POINTS_PER_DOLLAR);
}

/**
 * Validate purchase amount is within allowed range
 */
export function validatePurchaseAmount(amountUSD: number): {
  valid: boolean;
  error?: string;
} {
  if (!Number.isFinite(amountUSD) || amountUSD < POINTS_CONFIG.MIN_AMOUNT_USD) {
    return {
      valid: false,
      error: `Minimum purchase amount is $${POINTS_CONFIG.MIN_AMOUNT_USD}`,
    };
  }

  if (amountUSD > POINTS_CONFIG.MAX_AMOUNT_USD) {
    return {
      valid: false,
      error: `Maximum purchase amount is $${POINTS_CONFIG.MAX_AMOUNT_USD}`,
    };
  }

  return { valid: true };
}

/**
 * Allowed origins for Stripe redirect URLs
 *
 * Only these origins are trusted for post-checkout redirects.
 * This prevents attackers from spoofing the Origin header to redirect
 * users to malicious sites after checkout.
 */
const ALLOWED_REDIRECT_ORIGINS = [
  "https://feed.market",
  "https://www.feed.market",
  "https://staging.feed.market",
  "http://localhost:3000",
  "http://localhost:3001",
];

/**
 * Get the base URL for redirects based on environment
 *
 * SECURITY: Origin header is validated against an allowlist to prevent
 * open redirect attacks where a malicious Origin could redirect users
 * to phishing sites after checkout.
 *
 * Priority:
 * 1. Explicit override via STRIPE_REDIRECT_BASE_URL (for local dev/staging)
 * 2. Request origin (if in allowlist)
 * 3. NEXT_PUBLIC_APP_URL
 * 4. VERCEL_URL
 * 5. Fallback to localhost
 */
export function getBaseUrl(requestOrigin?: string): string {
  // Allow explicit override for local development or specific environments
  if (process.env.STRIPE_REDIRECT_BASE_URL) {
    return process.env.STRIPE_REDIRECT_BASE_URL;
  }

  // Validate origin against allowlist before trusting it
  if (requestOrigin && ALLOWED_REDIRECT_ORIGINS.includes(requestOrigin)) {
    return requestOrigin;
  }

  // Also allow Vercel preview URLs if they match the origin
  if (requestOrigin && process.env.VERCEL_URL) {
    const vercelUrl = `https://${process.env.VERCEL_URL}`;
    if (requestOrigin === vercelUrl) {
      return requestOrigin;
    }
  }

  // Fall back to configured app URL
  if (process.env.NEXT_PUBLIC_APP_URL) {
    return process.env.NEXT_PUBLIC_APP_URL;
  }

  if (process.env.VERCEL_URL) {
    return `https://${process.env.VERCEL_URL}`;
  }

  return "http://localhost:3000";
}

/**
 * Verify Stripe webhook signature
 *
 * @throws Error if signature is invalid
 */
export function constructWebhookEvent(
  payload: string,
  signature: string,
): Stripe.Event {
  if (!process.env.STRIPE_WEBHOOK_SECRET) {
    throw new Error("STRIPE_WEBHOOK_SECRET environment variable is required");
  }

  return stripe.webhooks.constructEvent(
    payload,
    signature,
    process.env.STRIPE_WEBHOOK_SECRET,
  );
}
