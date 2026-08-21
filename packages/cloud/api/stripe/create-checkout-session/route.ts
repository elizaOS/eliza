/**
 * POST /api/stripe/create-checkout-session
 *
 * Creates a Stripe Checkout session for a credit pack or custom-amount top-up.
 * Lazily creates a Stripe customer for the org if one doesn't exist.
 */

import { findBySku, HARDWARE_SKUS } from "@elizaos/shared/hardware-catalog";
import { Hono } from "hono";
import type Stripe from "stripe";
import { z } from "zod";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireUserWithOrg } from "@/lib/auth/workers-hono-auth";
import {
  moneyRateLimit,
  RateLimitPresets,
} from "@/lib/middleware/rate-limit-hono-cloudflare";
import { creditsService } from "@/lib/services/credits";
import { stripeCheckoutOrdersService } from "@/lib/services/stripe-checkout-orders";
import { stripeCustomerAuthorityService } from "@/lib/services/stripe-customer-authority";
import { isStripeConfigured, requireStripe } from "@/lib/stripe";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

const CUSTOM_AMOUNT_LIMITS = { MIN_AMOUNT: 1, MAX_AMOUNT: 1000 } as const;

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
    hardwareSku: z.enum(HARDWARE_SKUS).optional(),
    hardwareColor: z.string().min(1).max(32).optional(),
    returnUrl: z.enum(["settings", "billing"]).optional().default("settings"),
  })
  .refine((data) => data.creditPackId || data.amount || data.hardwareSku, {
    message: "Either creditPackId, amount, or hardwareSku must be provided",
  });

const app = new Hono<AppEnv>();

app.post("/", moneyRateLimit(RateLimitPresets.STRICT), async (c) => {
  try {
    const user = await requireUserWithOrg(c);

    const stripeCurrency = (c.env.STRIPE_CURRENCY || "usd")
      .trim()
      .toLowerCase();
    if (!/^[a-z]{3}$/.test(stripeCurrency)) {
      return c.json({ error: "Payment currency is misconfigured" }, 503);
    }
    const allowedOrigins = [
      c.env.NEXT_PUBLIC_APP_URL,
      "http://localhost:3000",
      "http://localhost:3001",
      "http://localhost:4455",
      "https://elizaos.ai",
      "https://www.elizaos.ai",
      "https://os.eliza.app",
      // Transitional legacy storefront origin.
      "https://os.elizacloud.ai",
      "https://eliza.ai",
      "https://www.eliza.ai",
    ].filter(Boolean) as string[];

    const body = await c.req.json();
    const validationResult = checkoutRequestSchema.safeParse(body);
    if (!validationResult.success) {
      const flatErrors = validationResult.error.flatten();
      const fieldErrors = Object.values(flatErrors.fieldErrors).flat();
      const formErrors = flatErrors.formErrors;
      const firstError = fieldErrors[0] || formErrors[0] || "Invalid request";
      return c.json({ error: firstError }, 400);
    }

    const { creditPackId, amount, hardwareColor, hardwareSku, returnUrl } =
      validationResult.data;
    const clientRequestKey = c.req.header("idempotency-key")?.trim();
    if (!hardwareSku && !clientRequestKey) {
      return c.json(
        { error: "Idempotency-Key header is required for credit purchases" },
        400,
      );
    }
    if (
      clientRequestKey &&
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(clientRequestKey)
    ) {
      return c.json({ error: "Idempotency-Key header is invalid" }, 400);
    }
    if (!isStripeConfigured()) {
      return c.json({ error: "Payment processing is not configured" }, 503);
    }

    // stripe v22 re-exports `SessionCreateParams` as a type alias from the
    // Checkout barrel, which strips the nested `LineItem` namespace. Derive
    // the line-item type from the params shape directly.
    type LineItem = NonNullable<
      Stripe.Checkout.SessionCreateParams["line_items"]
    >[number];
    let lineItems: LineItem[];
    let sessionMetadata: Record<string, string>;
    let creditQuote: {
      purchaseType: "credit_pack" | "custom_amount";
      creditPackId: string | null;
      creditsToGrant: string;
      chargeAmountCents: number;
    } | null = null;

    const organizationId = user.organization_id;

    if (hardwareSku) {
      const hardware = findBySku(hardwareSku);
      if (!hardware) {
        return c.json({ error: "Unknown hardware SKU" }, 400);
      }
      lineItems = [
        {
          price_data: {
            currency: stripeCurrency,
            product_data: {
              name: hardware.stripeName,
              description: hardware.stripeDescription,
            },
            unit_amount: Math.round(hardware.priceUsd * 100),
          },
          quantity: 1,
        },
      ];
      sessionMetadata = {
        organization_id: organizationId,
        user_id: user.id,
        hardware_sku: hardwareSku,
        hardware_color: hardwareColor ?? "unspecified",
        preorder_amount: hardware.priceUsd.toFixed(2),
        type: "hardware_preorder",
      };
    } else if (creditPackId) {
      if (stripeCurrency !== "usd") {
        return c.json({ error: "Credit purchases require USD billing" }, 503);
      }
      const creditPack = await creditsService.getCreditPackById(creditPackId);
      if (!creditPack?.is_active) {
        return c.json({ error: "Invalid or inactive credit pack" }, 404);
      }

      const stripePrice = await requireStripe().prices.retrieve(
        creditPack.stripe_price_id,
      );
      if (
        !stripePrice.active ||
        stripePrice.currency.toLowerCase() !== "usd" ||
        stripePrice.unit_amount !== creditPack.price_cents ||
        stripePrice.recurring
      ) {
        return c.json(
          { error: "Credit pack price is unavailable or out of sync" },
          503,
        );
      }
      lineItems = [{ price: stripePrice.id, quantity: 1 }];
      sessionMetadata = {
        organization_id: organizationId,
        user_id: user.id,
        credit_pack_id: creditPackId,
        credits: creditPack.credits.toString(),
        type: "credit_pack",
      };
      creditQuote = {
        purchaseType: "credit_pack",
        creditPackId,
        creditsToGrant: canonicalCredits(creditPack.credits),
        chargeAmountCents: creditPack.price_cents,
      };
    } else if (amount) {
      if (stripeCurrency !== "usd") {
        return c.json({ error: "Credit purchases require USD billing" }, 503);
      }
      const amountCents = amount * 100;
      if (!Number.isSafeInteger(amountCents)) {
        return c.json({ error: "Amount must use exact whole cents" }, 400);
      }
      lineItems = [
        {
          price_data: {
            currency: stripeCurrency,
            product_data: {
              name: "Account Balance Top-up",
              description: `Add $${amount.toFixed(2)} to your account balance`,
            },
            unit_amount: amountCents,
          },
          quantity: 1,
        },
      ];
      sessionMetadata = {
        organization_id: organizationId,
        user_id: user.id,
        credits: amount.toFixed(2),
        type: "custom_amount",
      };
      creditQuote = {
        purchaseType: "custom_amount",
        creditPackId: null,
        creditsToGrant: amount.toFixed(6),
        chargeAmountCents: amountCents,
      };
    } else {
      return c.json(
        {
          error: "Either creditPackId, amount, or hardwareSku must be provided",
        },
        400,
      );
    }

    const orgFull = (user.organization ?? {}) as {
      stripe_customer_id?: string | null;
      name?: string;
      billing_email?: string | null;
    };
    let customerId = orgFull.stripe_customer_id ?? null;

    const envAppUrl = c.env.NEXT_PUBLIC_APP_URL;
    const requestOrigin =
      c.req.header("origin") ||
      c.req.header("referer")?.split("/").slice(0, 3).join("/");

    const hardwareOrigin =
      hardwareSku && requestOrigin && allowedOrigins.includes(requestOrigin)
        ? requestOrigin
        : null;

    let baseUrl: string;
    if (hardwareOrigin) {
      baseUrl = hardwareOrigin;
    } else if (envAppUrl?.trim()) {
      baseUrl = envAppUrl.trim();
    } else if (requestOrigin && allowedOrigins.includes(requestOrigin)) {
      baseUrl = requestOrigin;
    } else {
      if (requestOrigin) {
        logger.warn(
          `[Stripe Checkout] Untrusted origin rejected: ${requestOrigin}`,
        );
      }
      baseUrl = "http://localhost:3000";
    }
    if (!baseUrl.startsWith("http")) baseUrl = "http://localhost:3000";

    const successUrl = hardwareSku
      ? `${baseUrl}/checkout/success?session_id={CHECKOUT_SESSION_ID}&sku=${hardwareSku}`
      : `${baseUrl}/cloud/billing/success?session_id={CHECKOUT_SESSION_ID}&from=${returnUrl}`;
    const cancelUrl = hardwareSku
      ? `${baseUrl}/checkout/cancel?sku=${hardwareSku}`
      : returnUrl === "settings"
        ? `${baseUrl}/cloud/settings?tab=billing`
        : `${baseUrl}/cloud/billing?canceled=true`;

    const requestDigest = creditQuote
      ? await sha256Hex(
          JSON.stringify({
            purchaseType: creditQuote.purchaseType,
            creditPackId: creditQuote.creditPackId,
            creditsToGrant: creditQuote.creditsToGrant,
            chargeAmountCents: creditQuote.chargeAmountCents,
            currency: "usd",
            successUrl,
            cancelUrl,
            returnUrl,
          }),
        )
      : null;
    let checkoutOrder = creditQuote
      ? await stripeCheckoutOrdersService.create({
          organizationId,
          initiatedByUserId: user.id,
          clientRequestKey: clientRequestKey!,
          requestDigest: requestDigest!,
          purchaseType: creditQuote.purchaseType,
          creditPackId: creditQuote.creditPackId,
          creditsToGrant: creditQuote.creditsToGrant,
          chargeAmountCents: creditQuote.chargeAmountCents,
          currency: stripeCurrency.toLowerCase(),
          stripeCustomerId: null,
          metadata: { return_url: returnUrl },
        })
      : null;
    const authoritativeCustomerId = await stripeCustomerAuthorityService.ensure(
      {
        organizationId,
        callerIntent: "interactive_checkout",
      },
    );
    if (checkoutOrder) {
      if (!checkoutOrder.stripe_customer_id) {
        checkoutOrder = await stripeCheckoutOrdersService.bindCustomer(
          checkoutOrder.id,
          authoritativeCustomerId,
        );
      } else if (checkoutOrder.stripe_customer_id !== authoritativeCustomerId) {
        throw new Error(
          "Checkout order customer conflicts with Stripe customer authority",
        );
      }
      customerId = checkoutOrder.stripe_customer_id;
    } else {
      customerId = authoritativeCustomerId;
    }
    if (!customerId) {
      throw new Error("Stripe customer authority was not established");
    }
    if (
      checkoutOrder?.stripe_checkout_session_id &&
      (checkoutOrder.status === "delivered" ||
        checkoutOrder.status === "settled")
    ) {
      const replaySession = await requireStripe().checkout.sessions.retrieve(
        checkoutOrder.stripe_checkout_session_id,
      );
      return c.json({ sessionId: replaySession.id, url: replaySession.url });
    }
    if (checkoutOrder) {
      if (
        checkoutOrder.status === "provider_started" ||
        checkoutOrder.status === "provider_ambiguous"
      ) {
        const recovered = await findCheckoutSessionForOrder(
          requireStripe(),
          checkoutOrder,
        );
        if (recovered) {
          await stripeCheckoutOrdersService.bindSession(
            checkoutOrder.id,
            recovered.id,
          );
          return c.json({ sessionId: recovered.id, url: recovered.url });
        }
        if (
          Date.now() - checkoutOrder.updated_at.getTime() >=
          23 * 60 * 60 * 1000
        ) {
          throw new Error(
            "Stripe Checkout creation is ambiguous and requires reconciliation",
          );
        }
      }
      sessionMetadata = {
        checkout_order_id: checkoutOrder.id,
        type: checkoutOrder.purchase_type,
      };
      await stripeCheckoutOrdersService.markProviderStarted(checkoutOrder.id);
    }

    let session: Stripe.Checkout.Session;
    try {
      session = await requireStripe().checkout.sessions.create(
        {
          customer: customerId,
          ...(checkoutOrder ? { client_reference_id: checkoutOrder.id } : {}),
          payment_method_types: ["card"],
          line_items: lineItems,
          mode: "payment",
          success_url: successUrl,
          cancel_url: cancelUrl,
          metadata: sessionMetadata,
          payment_intent_data: { metadata: sessionMetadata },
        },
        checkoutOrder
          ? { idempotencyKey: `checkout-order:${checkoutOrder.id}` }
          : undefined,
      );
    } catch (cause) {
      // error-policy:J1 Route boundary durably records an ambiguous provider outcome before translating it.
      if (checkoutOrder) {
        await stripeCheckoutOrdersService.markProviderAmbiguous(
          checkoutOrder.id,
          cause instanceof Error ? cause.name : "unknown_provider_error",
        );
      }
      throw cause;
    }
    if (checkoutOrder) {
      await stripeCheckoutOrdersService.bindSession(
        checkoutOrder.id,
        session.id,
      );
    }

    return c.json({ sessionId: session.id, url: session.url });
  } catch (error) {
    // error-policy:J1 HTTP boundary translates checkout failures into the shared structured response.
    logger.error("[Stripe Checkout] Error creating checkout session:", error);
    return failureResponse(c, error);
  }
});

export default app;

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

function canonicalCredits(value: string | number): string {
  const match = /^(\d+)(?:\.(\d{1,6}))?$/.exec(String(value));
  if (!match?.[1]) throw new Error("Credit pack grant is invalid");
  return `${match[1]}.${(match[2] ?? "").padEnd(6, "0")}`;
}

async function findCheckoutSessionForOrder(
  stripe: Stripe,
  order: {
    id: string;
    stripe_customer_id: string | null;
    updated_at: Date;
  },
): Promise<Stripe.Checkout.Session | null> {
  if (!order.stripe_customer_id) {
    throw new Error("Checkout order has no pinned Stripe customer");
  }
  const providerAttemptSeconds = Math.floor(order.updated_at.getTime() / 1000);
  let startingAfter: string | undefined;
  for (let page = 0; page < 10; page += 1) {
    const sessions = await stripe.checkout.sessions.list({
      customer: order.stripe_customer_id,
      created: {
        gte: Math.max(0, providerAttemptSeconds - 3600),
        lte: providerAttemptSeconds + 3600,
      },
      limit: 100,
      ...(startingAfter ? { starting_after: startingAfter } : {}),
    });
    const match = sessions.data.find(
      (session) =>
        session.client_reference_id === order.id &&
        session.metadata?.checkout_order_id === order.id,
    );
    if (match) return match;
    if (!sessions.has_more || sessions.data.length === 0) return null;
    startingAfter = sessions.data.at(-1)?.id;
  }
  throw new Error(
    "Stripe Checkout reconciliation exceeded its safe search bound",
  );
}
