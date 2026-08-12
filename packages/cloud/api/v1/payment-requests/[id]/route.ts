/**
 * Payment requests — single resource.
 *
 * GET   /api/v1/payment-requests/:id            Authed creator view (full row).
 * GET   /api/v1/payment-requests/:id?public=1   Allowlisted checkout view (no auth required).
 */

import { Hono } from "hono";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import {
  RateLimitPresets,
  rateLimit,
} from "@/lib/middleware/rate-limit-hono-cloudflare";
import type { PaymentRequestRow } from "@/lib/services/payment-requests";
import { getPaymentRequestsService } from "@/lib/services/payment-requests-default";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

const app = new Hono<AppEnv>();

type PublicPaymentRequest = Pick<
  PaymentRequestRow,
  "id" | "provider" | "amountCents" | "currency" | "reason" | "status" | "hostedUrl" | "expiresAt"
>;

function toPublicPaymentRequest(row: PaymentRequestRow): PublicPaymentRequest {
  return {
    id: row.id,
    provider: row.provider,
    amountCents: row.amountCents,
    currency: row.currency,
    reason: row.reason,
    status: row.status,
    hostedUrl: row.hostedUrl,
    expiresAt: row.expiresAt,
  };
}

app.use("*", rateLimit(RateLimitPresets.STANDARD));

app.get("/", async (c) => {
  try {
    const id = c.req.param("id");
    if (!id) {
      return c.json(
        { success: false, error: "Missing payment request id" },
        400,
      );
    }

    const isPublic = c.req.query("public") === "1";
    const service = getPaymentRequestsService(c.env);

    if (isPublic) {
      // Public path: lookup by id alone, then construct an explicit DTO.
      const row = await service.getPublic(id);
      if (!row) {
        return c.json(
          { success: false, error: "Payment request not found" },
          404,
        );
      }
      return c.json({
        success: true,
        paymentRequest: toPublicPaymentRequest(row),
      });
    }

    const user = await requireUserOrApiKeyWithOrg(c);
    const row = await service.get(id, user.organization_id);
    if (!row) {
      return c.json(
        { success: false, error: "Payment request not found" },
        404,
      );
    }

    return c.json({ success: true, paymentRequest: row });
  } catch (error) {
    // error-policy:J1 route boundary - translate failures into a structured HTTP response.
    logger.error("[PaymentRequests API] Failed to get payment request", {
      error,
    });
    return failureResponse(c, error);
  }
});

export default app;
