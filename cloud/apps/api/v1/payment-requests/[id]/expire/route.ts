/**
 * Unified payment requests — expire (authed creator).
 *
 * POST /api/v1/payment-requests/:id/expire
 *
 * Forces the request into `expired` status if it has passed its expiry. The
 * underlying service decides whether the row is actually past expiry; the
 * route only authorizes the call.
 */

import { Hono } from "hono";
import { ApiError, failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import { RateLimitPresets, rateLimit } from "@/lib/middleware/rate-limit-hono-cloudflare";
import { getPaymentRequestsService } from "@/lib/services/payment-requests-default";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

const app = new Hono<AppEnv>();

app.use("*", rateLimit(RateLimitPresets.STANDARD));

app.post("/", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);
    const id = c.req.param("id");
    if (!id) {
      return c.json({ success: false, error: "Missing payment request id" }, 400);
    }

    const service = getPaymentRequestsService(c.env);
    const existing = await service.get(id, user.organization_id);
    if (!existing) {
      return c.json({ success: false, error: "Payment request not found" }, 404);
    }

    const expiredIds = await service.expirePast(new Date());
    const wasExpired = expiredIds.includes(id);

    const after = await service.get(id, user.organization_id);
    if (!after) {
      throw new ApiError(500, "internal_error", "Payment request vanished after expire");
    }

    return c.json({
      success: true,
      paymentRequest: after,
      expired: wasExpired,
    });
  } catch (error) {
    logger.error("[PaymentRequests API] Failed to expire payment request", { error });
    return failureResponse(c, error);
  }
});

export default app;
