/**
 * Stripe Checkout Session API
 *
 * @route POST /api/stripe/checkout/session - Create Stripe Checkout Session
 * @access Authenticated
 *
 * @description
 * Creates a Stripe Checkout Session for funding trading balance with a credit card.
 * Returns the session URL for redirecting the user to Stripe's hosted checkout.
 *
 * Trading balance is funded via webhook after successful payment, not in this endpoint.
 *
 * @openapi
 * /api/stripe/checkout/session:
 *   post:
 *     tags:
 *       - Stripe
 *       - Points
 *     summary: Create Stripe Checkout Session for trading balance funding
 *     description: Creates a Stripe Checkout Session and returns the URL for redirect
 *     security:
 *       - BearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - amountUSD
 *             properties:
 *               amountUSD:
 *                 type: number
 *                 minimum: 1
 *                 maximum: 1000
 *                 description: Amount in USD (1-1000)
 *     responses:
 *       200:
 *         description: Checkout session created successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 sessionId:
 *                   type: string
 *                   description: Stripe Checkout Session ID
 *                 url:
 *                   type: string
 *                   description: URL to redirect user to Stripe Checkout
 *       400:
 *         description: Invalid input (amount out of range)
 *       401:
 *         description: Unauthorized
 *       503:
 *         description: Card payments are temporarily unavailable
 *
 * @example
 * ```typescript
 * const response = await fetch('/api/stripe/checkout/session', {
 *   method: 'POST',
 *   headers: {
 *     'Content-Type': 'application/json',
 *     'Authorization': `Bearer ${token}`
 *   },
 *   body: JSON.stringify({ amountUSD: 50 })
 * });
 *
 * const { url } = await response.json();
 * window.location.href = url; // Redirect to Stripe Checkout
 * ```
 */

import {
  authenticate,
  ServiceUnavailableError,
  withErrorHandling,
} from '@feed/api';
import { logger } from '@feed/shared';
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { trackServerEvent } from '@/lib/posthog/server';
import {
  calculatePointsFromUSD,
  getBaseUrl,
  POINTS_CONFIG,
  stripe,
  validatePurchaseAmount,
} from '@/lib/stripe/server';

interface CreateCheckoutSessionBody {
  amountUSD: number;
}

const STRIPE_CHECKOUT_UNAVAILABLE_MESSAGE =
  'Card payments are temporarily unavailable. Please try again later.';

export const POST = withErrorHandling(async function POST(req: NextRequest) {
  const authUser = await authenticate(req);

  // Ensure user has a database record
  if (!authUser.dbUserId) {
    return NextResponse.json(
      {
        success: false,
        error:
          'User account not fully set up. Please complete your profile first.',
      },
      { status: 401 }
    );
  }

  const userId = authUser.dbUserId;
  const userEmail = authUser.email;

  // Parse request body with error handling for malformed JSON
  let body: CreateCheckoutSessionBody;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { success: false, error: 'Invalid JSON body' },
      { status: 400 }
    );
  }
  const { amountUSD } = body;

  // Validate amount
  const validation = validatePurchaseAmount(amountUSD);
  if (!validation.valid) {
    return NextResponse.json(
      { success: false, error: validation.error },
      { status: 400 }
    );
  }

  const balanceUnits = calculatePointsFromUSD(amountUSD);

  // Get the origin from the request for accurate redirect URLs
  const requestOrigin =
    req.headers.get('origin') ||
    req.headers.get('referer')?.replace(/\/[^/]*$/, '');
  const baseUrl = getBaseUrl(requestOrigin || undefined);

  // Create Stripe Checkout Session
  // Use Math.round to avoid floating-point errors (e.g., 1.1 * 100 = 110.00000000000001)
  const amountCents = Math.round(amountUSD * 100);

  let session;
  try {
    session = await stripe.checkout.sessions.create({
      mode: 'payment',
      payment_method_types: ['card'],
      line_items: [
        {
          price_data: {
            currency: POINTS_CONFIG.CURRENCY,
            unit_amount: amountCents, // Stripe uses cents
            product_data: {
              name: `${balanceUnits.toLocaleString()} Feed Trading Balance`,
              description: `Fund ${balanceUnits.toLocaleString()} balance units for $${amountUSD}`,
            },
          },
          quantity: 1,
        },
      ],
      // Store purchase details in metadata for webhook processing
      metadata: {
        app: 'feed',
        userId,
        balanceUnits: balanceUnits.toString(),
        amountUSD: amountUSD.toString(),
        purchaseType: 'trading_balance',
      },
      // Pre-fill customer email if available
      customer_email: userEmail || undefined,
      // Success redirect includes session ID for confirmation display
      success_url: `${baseUrl}/markets?stripe_success=true&session_id={CHECKOUT_SESSION_ID}`,
      // Cancel redirect for user who abandons checkout
      cancel_url: `${baseUrl}/markets?stripe_cancelled=true`,
      // Session expires after 30 minutes
      expires_at: Math.floor(Date.now() / 1000) + 30 * 60,
    });
  } catch (error) {
    throw new ServiceUnavailableError(
      STRIPE_CHECKOUT_UNAVAILABLE_MESSAGE,
      'STRIPE_CHECKOUT_UNAVAILABLE',
      {
        provider: 'stripe',
        operation: 'checkout.sessions.create',
        reason: error instanceof Error ? error.message : String(error),
      }
    );
  }

  logger.info(
    `Created Stripe checkout session for ${balanceUnits} balance units ($${amountUSD})`,
    {
      userId,
      sessionId: session.id,
      amountUSD,
      balanceUnits,
    },
    'StripeCheckout'
  );

  void trackServerEvent(userId, 'stripe_checkout_initiated', {
    amountUSD,
    balanceUnits,
    sessionId: session.id,
  }).catch((err) => {
    logger.warn(
      'Failed to track stripe_checkout_initiated',
      { error: err },
      'StripeCheckout'
    );
  });

  return NextResponse.json({
    success: true,
    sessionId: session.id,
    url: session.url,
  });
});
