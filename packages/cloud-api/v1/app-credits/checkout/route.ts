/**
 * POST /api/v1/app-credits/checkout — create a Stripe checkout session for
 * purchasing app credits.
 *
 * CORS is handled globally (wildcard origin, no credentials).
 */

import { Hono } from "hono";
import { z } from "zod";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import {
  assertAllowedAbsoluteRedirectUrl,
  getDefaultPlatformRedirectOrigins,
} from "@/lib/security/redirect-validation";
import { appsService } from "@/lib/services/apps";
import { requireStripe } from "@/lib/stripe";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

const CheckoutSchema = z.object({
  app_id: z.string().uuid(),
  amount: z.number().min(1).max(10000),
  success_url: z.string().url(),
  cancel_url: z.string().url(),
});

const app = new Hono<AppEnv>();

app.post("/", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);

    const body = await c.req.json();
    const validation = CheckoutSchema.safeParse(body);
    if (!validation.success) {
      return c.json(
        { success: false, error: "Invalid request", details: validation.error.format() },
        400,
      );
    }

    const { app_id, amount, success_url, cancel_url } = validation.data;

    const targetApp = await appsService.getById(app_id);
    if (!targetApp) {
      return c.json({ success: false, error: "App not found" }, 404);
    }

    const allowedRedirectOrigins = [
      ...getDefaultPlatformRedirectOrigins(),
      targetApp.app_url,
      ...(targetApp.allowed_origins ?? []),
    ].filter((value): value is string => !!value);

    let successUrl: URL;
    let cancelUrl: URL;
    try {
      successUrl = assertAllowedAbsoluteRedirectUrl(
        success_url,
        allowedRedirectOrigins,
        "success_url",
      );
      cancelUrl = assertAllowedAbsoluteRedirectUrl(
        cancel_url,
        allowedRedirectOrigins,
        "cancel_url",
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : "Invalid redirect URL";
      return c.json({ success: false, error: message }, 400);
    }

    successUrl.searchParams.set("session_id", "{CHECKOUT_SESSION_ID}");

    const session = await requireStripe().checkout.sessions.create({
      payment_method_types: ["card"],
      line_items: [
        {
          price_data: {
            currency: "usd",
            product_data: {
              name: `${targetApp.name} Credits`,
              description: `$${amount} credits for ${targetApp.name}`,
            },
            unit_amount: amount * 100,
          },
          quantity: 1,
        },
      ],
      mode: "payment",
      success_url: successUrl.toString(),
      cancel_url: cancelUrl.toString(),
      customer_email: user.email || undefined,
      metadata: {
        type: "app_credit_purchase",
        source: "miniapp_app",
        app_id,
        user_id: user.id,
        organization_id: user.organization_id || "",
        credits: amount.toString(),
        amount: amount.toString(),
      },
    });

    logger.info("[App Credits API] Created app credit checkout session", {
      sessionId: session.id,
      appId: app_id,
      userId: user.id,
      amount,
    });

    return c.json({ success: true, url: session.url, sessionId: session.id });
  } catch (error) {
    logger.error("[App Credits API] Failed to create checkout session:", error);
    return failureResponse(c, error);
  }
});

export default app;
