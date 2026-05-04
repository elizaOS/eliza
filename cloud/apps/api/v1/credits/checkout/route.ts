/**
 * POST /api/v1/credits/checkout
 * Create a Stripe checkout session for purchasing organization credits.
 */

import { Hono } from "hono";
import type Stripe from "stripe";
import { z } from "zod";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import { RateLimitPresets, rateLimit } from "@/lib/middleware/rate-limit-hono-cloudflare";
import {
  assertAllowedAbsoluteRedirectUrl,
  getDefaultPlatformRedirectOrigins,
} from "@/lib/security/redirect-validation";
import { organizationsService } from "@/lib/services/organizations";
import { requireStripe } from "@/lib/stripe";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

const CheckoutSchema = z.object({
  credits: z.number().min(1).max(1000),
  success_url: z.string().url(),
  cancel_url: z.string().url(),
});

const app = new Hono<AppEnv>();

app.use("*", rateLimit(RateLimitPresets.STANDARD));

app.post("/", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);
    const stripeCurrency = (c.env.STRIPE_CURRENCY as string | undefined) || "usd";

    const body = await c.req.json();
    const validation = CheckoutSchema.safeParse(body);
    if (!validation.success) {
      return c.json({ error: "Invalid request", details: validation.error.format() }, 400);
    }

    const { credits: amount, success_url, cancel_url } = validation.data;
    const allowedRedirectOrigins = getDefaultPlatformRedirectOrigins();
    const successUrl = assertAllowedAbsoluteRedirectUrl(
      success_url,
      allowedRedirectOrigins,
      "success_url",
    );
    const cancelUrl = assertAllowedAbsoluteRedirectUrl(
      cancel_url,
      allowedRedirectOrigins,
      "cancel_url",
    );

    const organizationId = user.organization_id;

    // stripe v22 re-exports `SessionCreateParams` as a type alias from the
    // Checkout barrel, which strips the nested `LineItem` namespace. Derive
    // the line-item type from the params shape directly.
    type LineItem = NonNullable<Stripe.Checkout.SessionCreateParams["line_items"]>[number];
    const lineItems: LineItem[] = [
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

    successUrl.searchParams.set("session_id", "{CHECKOUT_SESSION_ID}");

    const session = await requireStripe().checkout.sessions.create({
      customer: customerId,
      payment_method_types: ["card"],
      line_items: lineItems,
      mode: "payment",
      success_url: successUrl.toString(),
      cancel_url: cancelUrl.toString(),
      metadata: {
        organization_id: organizationId,
        user_id: user.id,
        credits: amount.toFixed(2),
        type: "custom_amount",
      },
    });

    logger.info("Created credits checkout session", {
      sessionId: session.id,
      organizationId,
      userId: user.id,
      amount,
    });

    return c.json({ url: session.url, sessionId: session.id });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "";
    if (
      errorMessage.includes("Invalid success_url") ||
      errorMessage.includes("Invalid cancel_url")
    ) {
      return c.json({ error: errorMessage }, 400);
    }
    logger.error("[Credits Checkout API v1] Error:", error);
    return failureResponse(c, error);
  }
});

export default app;
