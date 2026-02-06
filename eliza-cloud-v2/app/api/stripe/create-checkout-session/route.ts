import { type NextRequest, NextResponse } from "next/server";
import { requireAuthWithOrg } from "@/lib/auth";
import { requireStripe } from "@/lib/stripe";
import { creditsService } from "@/lib/services/credits";
import { organizationsService } from "@/lib/services/organizations";
import { withRateLimit, RateLimitPresets } from "@/lib/middleware/rate-limit";
import { z } from "zod";
import type Stripe from "stripe";
import { logger } from "@/lib/utils/logger";
import { trackServerEvent } from "@/lib/analytics/posthog-server";

const CUSTOM_AMOUNT_LIMITS = {
  MIN_AMOUNT: 1,
  MAX_AMOUNT: 1000,
} as const;

// Allowed origins for redirect URLs - prevents open redirect vulnerabilities
const ALLOWED_ORIGINS = [
  process.env.NEXT_PUBLIC_APP_URL,
  "http://localhost:3000",
  "http://localhost:3001",
].filter(Boolean) as string[];

// Configurable currency
const STRIPE_CURRENCY = process.env.STRIPE_CURRENCY || "usd";

const checkoutRequestSchema = z
  .object({
    creditPackId: z.string().uuid().optional(),
    amount: z
      .number()
      .min(
        CUSTOM_AMOUNT_LIMITS.MIN_AMOUNT,
        `Amount must be at least $${CUSTOM_AMOUNT_LIMITS.MIN_AMOUNT}`,
      )
      .max(
        CUSTOM_AMOUNT_LIMITS.MAX_AMOUNT,
        `Amount cannot exceed $${CUSTOM_AMOUNT_LIMITS.MAX_AMOUNT}`,
      )
      .finite("Amount must be a valid number")
      .optional(),
    returnUrl: z.enum(["settings", "billing"]).optional().default("settings"),
  })
  .refine((data) => data.creditPackId || data.amount, {
    message: "Either creditPackId or amount must be provided",
  });

type CheckoutRequest = z.infer<typeof checkoutRequestSchema>;

/**
 * POST /api/stripe/create-checkout-session
 * Creates a Stripe Checkout session for credit pack purchase or custom amount top-up.
 * Creates Stripe customer if one doesn't exist for the organization.
 *
 * @param req - Request body with creditPackId or amount, and optional returnUrl.
 * @returns Checkout session ID and URL.
 */
async function handleCheckoutSession(req: NextRequest) {
  logger.debug("[Stripe Checkout] Route handler called");

  try {
    logger.debug("[Stripe Checkout] Authenticating user...");
    const user = await requireAuthWithOrg();
    logger.debug("[Stripe Checkout] User authenticated");

    const body = await req.json();
    // Only log non-sensitive request metadata
    logger.debug("[Stripe Checkout] Request validated", {
      hasAmount: !!body.amount,
      hasCreditPackId: !!body.creditPackId,
    });

    const validationResult = checkoutRequestSchema.safeParse(body);

    if (!validationResult.success) {
      // Extract the first user-friendly error message
      const flatErrors = validationResult.error.flatten();
      const fieldErrors = Object.values(flatErrors.fieldErrors).flat();
      const formErrors = flatErrors.formErrors;
      const firstError = fieldErrors[0] || formErrors[0] || "Invalid request";

      return NextResponse.json({ error: firstError }, { status: 400 });
    }

    const { creditPackId, amount, returnUrl } = validationResult.data;

    let lineItems: Stripe.Checkout.SessionCreateParams.LineItem[];
    let creditsAmount: number;
    let sessionMetadata: Record<string, string>;

    // Validate organization_id is present (guaranteed by requireAuthWithOrg)
    const organizationId = user.organization_id;
    if (!organizationId) {
      return NextResponse.json(
        { error: "Organization not found" },
        { status: 400 },
      );
    }

    if (creditPackId) {
      const creditPack = await creditsService.getCreditPackById(creditPackId);
      if (!creditPack || !creditPack.is_active) {
        return NextResponse.json(
          { error: "Invalid or inactive credit pack" },
          { status: 404 },
        );
      }

      lineItems = [
        {
          price: creditPack.stripe_price_id,
          quantity: 1,
        },
      ];
      creditsAmount = Number(creditPack.credits);
      sessionMetadata = {
        organization_id: organizationId,
        user_id: user.id,
        credit_pack_id: creditPackId,
        credits: creditPack.credits.toString(),
        type: "credit_pack",
      };
    } else if (amount) {
      lineItems = [
        {
          price_data: {
            currency: STRIPE_CURRENCY,
            product_data: {
              name: "Account Balance Top-up",
              description: `Add $${amount.toFixed(2)} to your account balance`,
            },
            unit_amount: Math.round(amount * 100),
          },
          quantity: 1,
        },
      ];
      creditsAmount = amount;
      sessionMetadata = {
        organization_id: organizationId,
        user_id: user.id,
        credits: amount.toFixed(2),
        type: "custom_amount",
      };
    } else {
      return NextResponse.json(
        { error: "Either creditPackId or amount must be provided" },
        { status: 400 },
      );
    }

    let customerId = user.organization.stripe_customer_id;

    if (!customerId) {
      const customerData: Stripe.CustomerCreateParams = {
        name: user.organization.name,
        metadata: {
          organization_id: organizationId,
        },
      };

      const email = user.organization.billing_email || user.email;
      if (email) {
        customerData.email = email;
      }

      if (user.wallet_address) {
        customerData.metadata = {
          ...customerData.metadata,
          wallet_address: user.wallet_address,
        };
      }

      const customer = await requireStripe().customers.create(customerData);
      customerId = customer.id;

      await organizationsService.update(organizationId, {
        stripe_customer_id: customerId,
        updated_at: new Date(),
      });
    }

    // Secure URL construction - validate origin to prevent open redirect vulnerabilities
    const envAppUrl = process.env.NEXT_PUBLIC_APP_URL;
    const requestOrigin =
      req.headers.get("origin") ||
      req.headers.get("referer")?.split("/").slice(0, 3).join("/");

    // Only use request origin if it's in the allowed list
    let baseUrl: string;
    if (envAppUrl?.trim()) {
      baseUrl = envAppUrl.trim();
    } else if (requestOrigin && ALLOWED_ORIGINS.includes(requestOrigin)) {
      baseUrl = requestOrigin;
    } else {
      if (requestOrigin) {
        logger.warn(
          `[Stripe Checkout] Untrusted origin rejected: ${requestOrigin}`,
        );
      }
      baseUrl = "http://localhost:3000";
    }

    // Ensure baseUrl starts with http
    if (!baseUrl.startsWith("http")) {
      baseUrl = "http://localhost:3000";
    }

    const successUrl = `${baseUrl}/dashboard/billing/success?session_id={CHECKOUT_SESSION_ID}&from=${returnUrl}`;
    const cancelUrl =
      returnUrl === "settings"
        ? `${baseUrl}/dashboard/settings?tab=billing`
        : `${baseUrl}/dashboard/billing?canceled=true`;

    logger.debug("[Stripe Checkout] Session URLs configured", {
      baseUrl,
      returnUrl,
    });

    const session = await requireStripe().checkout.sessions.create({
      customer: customerId,
      payment_method_types: ["card"],
      line_items: lineItems,
      mode: "payment",
      success_url: successUrl,
      cancel_url: cancelUrl,
      metadata: sessionMetadata,
      // Copy metadata to PaymentIntent so checkout_failed webhook can track failures
      // Stripe doesn't automatically copy session metadata to the PaymentIntent
      payment_intent_data: {
        metadata: sessionMetadata,
      },
    });

    logger.debug("[Stripe Checkout] Session created", {
      sessionId: session.id,
      credits: creditsAmount,
    });

    // Track checkout initiated in PostHog
    const purchaseType = creditPackId ? "credit_pack" : "custom_amount";
    const sourcePage = returnUrl === "settings" ? "settings" : "billing";

    trackServerEvent(user.id, "checkout_initiated", {
      payment_method: "stripe",
      amount: creditsAmount,
      currency: STRIPE_CURRENCY,
      organization_id: organizationId,
      source_page: sourcePage,
      purchase_type: purchaseType,
      credit_pack_id: creditPackId,
    });

    return NextResponse.json({ sessionId: session.id, url: session.url });
  } catch (error) {
    logger.error("[Stripe Checkout] Error creating checkout session:", error);

    // Don't expose internal details - log them but return generic message
    return NextResponse.json(
      { error: "Failed to create checkout session" },
      { status: 500 },
    );
  }
}

// Export rate-limited handler with standard preset
export const POST = withRateLimit(
  handleCheckoutSession,
  RateLimitPresets.STRICT,
);
