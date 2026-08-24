/**
 * GET /api/v1/billing/payment-states/:id
 * Server-authoritative single payment state (receipt, refund/dispute
 * reversals) for the authenticated organization (#22966 linked-detail
 * surface). Rows are served from the same paymentHistoryService projection
 * the list endpoint uses; the id is the row's stable
 * `{surface}:{authorityId}` identity, so this is a scoped lookup over the
 * org's own recent history — never a cross-tenant probe.
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

/**
 * Detail lookups scan the org's full bounded history window, matching the
 * `limit` maximum the pagination helper documents for this route family
 * (1–500, see ../../pagination.ts). Any change to that cap must move with
 * this constant so a linked row is reachable for the whole listable window.
 */
const DETAIL_WINDOW_LIMIT = 500;

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
    // The detail surface reads the org's full recent history — the same
    // bounded window the list view exposes — and selects the requested row.
    // A row that no longer projects (older than the window) is a real 404:
    // the projection is derived, not persisted, so "exists in the window"
    // is the honest authority for a linked detail view.
    const states = await paymentHistoryService.listPaymentStates(
      user.organization_id,
      DETAIL_WINDOW_LIMIT,
    );
    const row = states.find((candidate) => candidate.id === id);
    if (!row) {
      return c.json({ success: false, error: "PAYMENT_STATE_NOT_FOUND" }, 404);
    }

    return c.json({
      success: true,
      state: row,
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
