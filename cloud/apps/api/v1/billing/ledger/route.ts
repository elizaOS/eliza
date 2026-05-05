/**
 * GET /api/v1/billing/ledger
 * Recent billing and credit ledger entries for the authenticated organization.
 */

import { Hono } from "hono";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import { RateLimitPresets, rateLimit } from "@/lib/middleware/rate-limit-hono-cloudflare";
import { activeBillingService } from "@/lib/services/active-billing";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

const app = new Hono<AppEnv>();

app.use("*", rateLimit(RateLimitPresets.STANDARD));

app.get("/", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);
    const rawLimit = Number(c.req.query("limit") ?? 50);
    const ledger = await activeBillingService.listLedger(
      user.organization_id,
      Number.isFinite(rawLimit) ? rawLimit : 50,
    );

    return c.json({
      success: true,
      ledger,
      total: ledger.length,
    });
  } catch (error) {
    logger.error("[Billing Ledger API] Error listing ledger", error);
    return failureResponse(c, error);
  }
});

export default app;
