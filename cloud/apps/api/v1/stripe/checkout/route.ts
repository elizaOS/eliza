/**
 * POST /api/v1/stripe/checkout
 *
 * Authed direct Stripe Checkout creation against the unified
 * payment_requests table. Looks up the request, verifies it's
 * pending and provider=stripe, then dispatches to the
 * Stripe payment adapter.
 *
 * The legacy app-charge checkout flow at
 * `/api/v1/apps/[id]/charges/[chargeId]/checkout` is unchanged.
 */

import { Hono } from "hono";
import { z } from "zod";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import { RateLimitPresets, rateLimit } from "@/lib/middleware/rate-limit-hono-cloudflare";
import { stripePaymentAdapter } from "@/lib/services/payment-adapters/stripe";
import {
  paymentRequestsService,
  type PaymentRequestRow,
} from "@/lib/services/payment-requests";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

const CheckoutSchema = z.object({
  paymentRequestId: z.string().min(1),
  successUrl: z.string().url(),
  cancelUrl: z.string().url(),
});

const app = new Hono<AppEnv>();

app.use("*", rateLimit(RateLimitPresets.STRICT));

app.post("/", async (c) => {
  try {
    await requireUserOrApiKeyWithOrg(c);

    const body = await c.req.json().catch(() => null);
    const parsed = CheckoutSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        { success: false, error: "Invalid request", details: parsed.error.issues },
        400,
      );
    }

    const request = await paymentRequestsService.get(parsed.data.paymentRequestId);
    if (!request) {
      return c.json({ success: false, error: "Payment request not found" }, 404);
    }
    if (request.provider !== "stripe") {
      return c.json(
        { success: false, error: `Payment request provider is ${request.provider}, not stripe` },
        400,
      );
    }
    if (request.status !== "pending") {
      return c.json(
        { success: false, error: `Payment request already ${request.status}` },
        409,
      );
    }

    const requestForAdapter: PaymentRequestRow = {
      ...request,
      successUrl: parsed.data.successUrl,
      cancelUrl: parsed.data.cancelUrl,
    };

    const result = await stripePaymentAdapter.createIntent({ request: requestForAdapter });
    await paymentRequestsService.markInitialized(request.id, result.providerIntent);

    return c.json({ success: true, hostedUrl: result.hostedUrl ?? null });
  } catch (error) {
    logger.error("[StripeCheckout API] Failed to create checkout", { error });
    return failureResponse(c, error);
  }
});

export default app;
