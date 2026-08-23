/**
 * GET /api/v1/billing/payment-states
 * Server-authoritative purchase payment states (receipts, refund/dispute
 * reversals) for the authenticated organization's billing history surface.
 */

import { Hono } from "hono";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import {
  RateLimitPresets,
  rateLimit,
} from "@/lib/middleware/rate-limit-hono-cloudflare";
import { paymentHistoryService } from "@/lib/services/payment-history";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";
import { parsePaginationParam } from "../../pagination";

const app = new Hono<AppEnv>();

app.use("*", rateLimit(RateLimitPresets.STANDARD));

app.get("/", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);
    const limitResult = parsePaginationParam(c.req.query("limit"), "limit", 50);
    if (!limitResult.ok) {
      return c.json({ success: false, error: limitResult.error }, 400);
    }
    const states = await paymentHistoryService.listPaymentStates(
      user.organization_id,
      limitResult.value,
    );

    return c.json({
      success: true,
      states,
      total: states.length,
    });
  } catch (error) {
    // error-policy:J1 boundary translation: the transport boundary returns a
    // structured failure instead of leaking the raw service error.
    logger.error(
      "[Billing Payment States API] Error listing payment states",
      error,
    );
    return failureResponse(c, error);
  }
});

export default app;
