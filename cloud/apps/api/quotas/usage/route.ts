/**
 * GET /api/quotas/usage
 * Gets current quota usage statistics for the organization.
 */

import { Hono } from "hono";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import { RateLimitPresets, rateLimit } from "@/lib/middleware/rate-limit-hono-cloudflare";
import { usageQuotasService } from "@/lib/services/usage-quotas";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

const app = new Hono<AppEnv>();

app.use("*", rateLimit(RateLimitPresets.STANDARD));

app.get("/", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);
    const usage = await usageQuotasService.getCurrentUsage(user.organization_id);
    return c.json({ success: true, data: usage });
  } catch (error) {
    logger.error("Error fetching quota usage:", error);
    return failureResponse(c, error);
  }
});

export default app;
