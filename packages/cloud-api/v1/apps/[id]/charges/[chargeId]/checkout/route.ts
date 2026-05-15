/**
 * Create a payer checkout session for an app charge request.
 */

import { Hono } from "hono";
import { z } from "zod";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import { SUPPORTED_PAY_CURRENCIES } from "@/lib/config/crypto";
import { RateLimitPresets, rateLimit } from "@/lib/middleware/rate-limit-hono-cloudflare";
import { appChargeRequestsService } from "@/lib/services/app-charge-requests";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

const CheckoutSchema = z.object({
  provider: z.enum(["stripe", "oxapay"]),
  success_url: z.string().url().optional(),
  cancel_url: z.string().url().optional(),
  return_url: z.string().url().optional(),
  payCurrency: z.enum(SUPPORTED_PAY_CURRENCIES).optional(),
  network: z.enum(["ERC20", "TRC20", "BEP20", "POLYGON", "SOL", "BASE", "ARB", "OP"]).optional(),
});

const app = new Hono<AppEnv>();

app.use("*", rateLimit(RateLimitPresets.STRICT));

app.post("/", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);
    const appId = c.req.param("id");
    const chargeId = c.req.param("chargeId");
    if (!appId || !chargeId) {
      return c.json({ success: false, error: "Missing route parameters" }, 400);
    }

    const body = await c.req.json().catch(() => null);
    const parsed = CheckoutSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        { success: false, error: "Invalid request", details: parsed.error.issues },
        400,
      );
    }

    if (parsed.data.provider === "stripe") {
      const checkout = await appChargeRequestsService.createStripeCheckout({
        appId,
        chargeRequestId: chargeId,
        payerUserId: user.id,
        payerOrganizationId: user.organization_id,
        payerEmail: user.email,
        successUrl: parsed.data.success_url,
        cancelUrl: parsed.data.cancel_url,
      });

      return c.json({ success: true, checkout });
    }

    const checkout = await appChargeRequestsService.createOxaPayCheckout({
      appId,
      chargeRequestId: chargeId,
      payerUserId: user.id,
      payerOrganizationId: user.organization_id,
      payCurrency: parsed.data.payCurrency,
      network: parsed.data.network,
      returnUrl: parsed.data.return_url ?? parsed.data.success_url,
    });

    return c.json({
      success: true,
      checkout: {
        ...checkout,
        expiresAt: checkout.expiresAt.toISOString(),
      },
    });
  } catch (error) {
    logger.error("[AppCharges API] Failed to create checkout", { error });
    return failureResponse(c, error);
  }
});

export default app;
