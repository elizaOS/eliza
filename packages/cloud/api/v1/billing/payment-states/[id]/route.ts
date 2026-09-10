/**
 * GET /api/v1/billing/payment-states/:id
 * Server-authoritative single payment state (receipt, refund/dispute
 * reversals) for the authenticated organization (#22966 linked-detail
 * surface). The id is the row's stable `{surface}:{authorityId}` identity;
 * the lookup resolves the owning authority row directly, org-scoped — a
 * persisted purchase stays reachable from its stable detail URL no matter
 * how many newer purchases exist, and never a cross-tenant probe.
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

const app = new Hono<AppEnv>();

app.use("*", rateLimit(RateLimitPresets.STANDARD));

app.get("/", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);
    const id = c.req.param("id");
    if (
      typeof id !== "string" ||
      id.length === 0 ||
      id.length > 200 ||
      !/^[a-z_]+:[0-9a-zA-Z._:-]+$/.test(id)
    ) {
      return c.json(
        {
          success: false,
          error: "INVALID_PAYMENT_STATE_ID",
        },
        400,
      );
    }
    // Direct tenant-scoped resolution by the stable id: the projection is
    // derived from persisted authority rows, so any well-formed id that
    // belongs to the org resolves regardless of list-window position. An id
    // the org does not own (or that no longer projects) is a real 404.
    const state = await paymentHistoryService.findPaymentStateById(
      user.organization_id,
      id,
    );
    if (!state) {
      return c.json({ success: false, error: "PAYMENT_STATE_NOT_FOUND" }, 404);
    }

    return c.json({
      success: true,
      state,
    });
  } catch (error) {
    // error-policy:J1 boundary translation: the transport boundary returns a
    // structured failure instead of leaking the raw service error.
    logger.error(
      "[Billing Payment States API] Error loading payment state",
      error,
    );
    return failureResponse(c, error);
  }
});

export default app;
