/**
 * GET /api/v1/billing/active
 * Lists every currently billable resource for the authenticated organization.
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

const app = new Hono<AppEnv>();

app.use("*", rateLimit(RateLimitPresets.STANDARD));

app.get("/", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);
    const resources = await activeBillingService.listActiveResources(
      user.organization_id,
    );

    return c.json({
      success: true,
      resources,
      totalActive: resources.length,
      estimatedDailyCost: resources.reduce((sum, resource) => {
        const daily =
          resource.billingInterval === "hour"
            ? resource.unitPrice * 24
            : resource.unitPrice;
        return sum + daily;
      }, 0),
    });
  } catch (error) {
    logger.error("[Billing Active API] Error listing active billables", error);
    return failureResponse(c, error);
  }
});

export default app;
