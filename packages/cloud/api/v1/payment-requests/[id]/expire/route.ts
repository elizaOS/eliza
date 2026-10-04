/**
 * Payment requests — expire (authed creator).
 *
 * POST /api/v1/payment-requests/:id/expire
 *
 * Expires a past-due request only when no provider intent was delivered. A
 * provider-backed request remains settlement-eligible until reconciliation
 * owns its terminal state. The service decides whether the row is actually
 * past expiry; the route only authorizes the call.
 */

import { requireUserOrApiKeyWithOrg } from "@elizaos/cloud-shared/auth";
import { failureResponse } from "@elizaos/cloud-shared/lib/api/cloud-worker-errors";
import {
  moneyRateLimit,
  RateLimitPresets,
} from "@elizaos/cloud-shared/lib/middleware/rate-limit-hono-cloudflare";
import { toPaymentRequestDto } from "@elizaos/cloud-shared/lib/services/payment-requests";
import { getPaymentRequestsService } from "@elizaos/cloud-shared/lib/services/payment-requests-default";
import { logger } from "@elizaos/cloud-shared/lib/utils/logger";
import type { AppEnv } from "@elizaos/cloud-shared/types/cloud-worker-env";
import { Hono } from "hono";

const app = new Hono<AppEnv>();

app.use("*", moneyRateLimit(RateLimitPresets.STANDARD));

app.post("/", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);
    const id = c.req.param("id");
    if (!id) {
      return c.json(
        { success: false, error: "Missing payment request id" },
        400,
      );
    }

    const service = getPaymentRequestsService(c.env);
    const existing = await service.get(id, user.organization_id);
    if (!existing) {
      return c.json(
        { success: false, error: "Payment request not found" },
        404,
      );
    }

    // Scoped to THIS request id + the caller's org — not the global sweep.
    const { paymentRequest: after, expired: wasExpired } = await service.expire(
      id,
      user.organization_id,
    );

    return c.json({
      success: true,
      paymentRequest: toPaymentRequestDto(after),
      expired: wasExpired,
    });
  } catch (error) {
    logger.error("[PaymentRequests API] Failed to expire payment request", {
      error,
    });
    return failureResponse(c, error);
  }
});

export default app;
