/**
 * GET /api/v1/billing/ledger
 * Recent billing and credit ledger entries for the authenticated organization.
 */

import { requireUserOrApiKeyWithOrg } from "@elizaos/cloud-shared/auth";
import { failureResponse } from "@elizaos/cloud-shared/lib/api/cloud-worker-errors";
import {
  RateLimitPresets,
  rateLimit,
} from "@elizaos/cloud-shared/lib/middleware/rate-limit-hono-cloudflare";
import { activeBillingService } from "@elizaos/cloud-shared/lib/services/active-billing";
import { logger } from "@elizaos/cloud-shared/lib/utils/logger";
import type { AppEnv } from "@elizaos/cloud-shared/types/cloud-worker-env";
import { Hono } from "hono";
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
    const ledger = await activeBillingService.listLedger(
      user.organization_id,
      limitResult.value,
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
