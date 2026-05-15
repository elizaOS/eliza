/**
 * GET /api/v1/billing/active
 * Lists every currently billable resource for the authenticated organization.
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
    const resources = await activeBillingService.listActiveResources(user.organization_id);

    return c.json({
      success: true,
      resources,
      totalActive: resources.length,
      estimatedDailyCost: resources.reduce((sum, resource) => {
        const daily =
          resource.billingInterval === "hour" ? resource.unitPrice * 24 : resource.unitPrice;
        return sum + daily;
      }, 0),
    });
  } catch (error) {
    logger.error("[Billing Active API] Error listing active billables", error);
    return failureResponse(c, error);
  }
});

export default app;
