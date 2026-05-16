/**
 * POST /api/stripe/create-checkout-session
 *
 * Creates a Stripe Checkout session for a credit pack or custom-amount top-up.
 * Lazily creates a Stripe customer for the org if one doesn't exist.
 */

import { Hono } from "hono";
import type Stripe from "stripe";
import { z } from "zod";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireUserWithOrg } from "@/lib/auth/workers-hono-auth";
import {
  RateLimitPresets,
  rateLimit,
} from "@/lib/middleware/rate-limit-hono-cloudflare";
import { creditsService } from "@/lib/services/credits";
import { organizationsService } from "@/lib/services/organizations";
import { isStripeConfigured, requireStripe } from "@/lib/stripe";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

const CUSTOM_AMOUNT_LIMITS = { MIN_AMOUNT: 1, MAX_AMOUNT: 1000 } as const;
const HARDWARE_PRODUCTS = {
  "elizaos-phone": {
    amount: 499,
    name: "ElizaOS Phone preorder deposit",
    description: "Reserve first-party ElizaOS phone hardware.",
  },
  "elizaos-box": {
    amount: 299,
    name: "ElizaOS Box preorder deposit",
    description: "Reserve the ElizaOS home/runtime box.",
  },
  "elizaos-usb-chibi": {
    amount: 49,
    name: "Chibi USB key preorder",
    description: "Character ElizaOS USB installer key. Ships October 2026.",
  },
  "elizaos-usb": {
    amount: 49,
    name: "ElizaOS USB key preorder",
    description: "First-party ElizaOS USB installer key. Ships October 2026.",
  },
  "elizaos-usb-plastic": {
    amount: 49,
    name: "Branded USB key preorder",
    description:
      "Simple plastic ElizaOS USB installer key. Ships October 2026.",
  },
  "elizaos-raspberry-pi-case": {
    amount: 49,
    name: "ElizaOS Raspberry Pi case preorder",
    description: "Reserve the ElizaOS Raspberry Pi case.",
  },
  "elizaos-custom-raspberry-pi-case": {
    amount: 149,
    name: "ElizaOS Raspberry Pi + case preorder",
    description: "Reserve the custom Raspberry Pi and ElizaOS case kit.",
  },
  "elizaos-mini-pc": {
    amount: 1999,
    name: "ElizaOS mini PC preorder",
    description: "Reserve the first-party ElizaOS mini PC.",
  },
} as const;

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
    hardwareSku: z
      .enum([
        "elizaos-phone",
        "elizaos-box",
        "elizaos-usb-chibi",
        "elizaos-usb",
        "elizaos-usb-plastic",
        "elizaos-raspberry-pi-case",
        "elizaos-custom-raspberry-pi-case",
        "elizaos-mini-pc",
      ])
      .optional(),
    hardwareColor: z.string().min(1).max(32).optional(),
    returnUrl: z.enum(["settings", "billing"]).optional().default("settings"),
  })
  .refine((data) => data.creditPackId || data.amount || data.hardwareSku, {
    message: "Either creditPackId, amount, or hardwareSku must be provided",
  });

const app = new Hono<AppEnv>();

app.post("/", rateLimit(RateLimitPresets.STRICT), async (c) => {
  try {
    const user = await requireUserWithOrg(c);

    const stripeCurrency = c.env.STRIPE_CURRENCY || "usd";
    const allowedOrigins = [
      c.env.NEXT_PUBLIC_APP_URL,
      "http://localhost:3000",
      "http://localhost:3001",
      "http://localhost:4455",
      "https://elizaos.ai",
      "https://www.elizaos.ai",
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

    const organizationId = user.organization_id;

    if (hardwareSku) {
      const hardware = HARDWARE_PRODUCTS[hardwareSku];
      lineItems = [
        {
          price_data: {
            currency: stripeCurrency,
            product_data: {
              name: hardware.name,
              description: hardware.description,
            },
            unit_amount: Math.round(hardware.amount * 100),
          },
          quantity: 1,
        },
      ];
      sessionMetadata = {
        organization_id: organizationId,
        user_id: user.id,
        hardware_sku: hardwareSku,
        hardware_color: hardwareColor ?? "unspecified",
        preorder_amount: hardware.amount.toFixed(2),
        type: "hardware_preorder",
      };
    } else if (creditPackId) {
      const creditPack = await creditsService.getCreditPackById(creditPackId);
      if (!creditPack?.is_active) {
        return c.json({ error: "Invalid or inactive credit pack" }, 404);
      }

      lineItems = [{ price: creditPack.stripe_price_id, quantity: 1 }];
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
            currency: stripeCurrency,
            product_data: {
              name: "Account Balance Top-up",
              description: `Add $${amount.toFixed(2)} to your account balance`,
            },
            unit_amount: Math.round(amount * 100),
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

    if (!customerId) {
      const customerData: Stripe.CustomerCreateParams = {
        name: orgFull.name,
        metadata: { organization_id: organizationId },
      };
      const email = orgFull.billing_email || user.email;
      if (email) customerData.email = email;
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
      : `${baseUrl}/dashboard/billing/success?session_id={CHECKOUT_SESSION_ID}&from=${returnUrl}`;
    const cancelUrl = hardwareSku
      ? `${baseUrl}/checkout/cancel?sku=${hardwareSku}`
      : returnUrl === "settings"
        ? `${baseUrl}/dashboard/settings?tab=billing`
        : `${baseUrl}/dashboard/billing?canceled=true`;

    const session = await requireStripe().checkout.sessions.create({
      customer: customerId,
      payment_method_types: ["card"],
      line_items: lineItems,
      mode: "payment",
      success_url: successUrl,
      cancel_url: cancelUrl,
      metadata: sessionMetadata,
      payment_intent_data: { metadata: sessionMetadata },
    });

    return c.json({ sessionId: session.id, url: session.url });
  } catch (error) {
    logger.error("[Stripe Checkout] Error creating checkout session:", error);
    return failureResponse(c, error);
  }
});

export default app;
