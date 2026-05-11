/**
 * Unified payment requests — single resource.
 *
 * GET   /api/v1/payment-requests/:id            Authed creator view (full row).
 * GET   /api/v1/payment-requests/:id?public=1   Redacted public view (no auth required):
 *                                               strips callbackSecret, settlementProof, and
 *                                               payerIdentityId for any_payer requests.
 */

import { Hono } from "hono";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import { RateLimitPresets, rateLimit } from "@/lib/middleware/rate-limit-hono-cloudflare";
import {
  getPaymentRequestsService,
  redactPaymentRequestForPublic,
} from "@/lib/services/payment-requests";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

const app = new Hono<AppEnv>();

app.use("*", rateLimit(RateLimitPresets.STANDARD));

app.get("/", async (c) => {
  try {
    const id = c.req.param("id");
    if (!id) {
      return c.json({ success: false, error: "Missing payment request id" }, 400);
    }

    const isPublic = c.req.query("public") === "1";
    const service = getPaymentRequestsService(c.env);

    if (isPublic) {
      // Public path: lookup by id alone, redact, return.
      const row = await service.get(id, "");
      if (!row) {
        return c.json({ success: false, error: "Payment request not found" }, 404);
      }
      return c.json({ success: true, paymentRequest: redactPaymentRequestForPublic(row) });
    }

    const user = await requireUserOrApiKeyWithOrg(c);
    const row = await service.get(id, user.organization_id);
    if (!row) {
      return c.json({ success: false, error: "Payment request not found" }, 404);
    }

    return c.json({ success: true, paymentRequest: row });
  } catch (error) {
    logger.error("[PaymentRequests API] Failed to get payment request", { error });
    return failureResponse(c, error);
  }
});

export default app;
