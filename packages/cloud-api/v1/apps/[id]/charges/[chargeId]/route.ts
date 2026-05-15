/**
 * Public app charge request details.
 */

import { Hono } from "hono";
import { appsRepository } from "@/db/repositories/apps";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { RateLimitPresets, rateLimit } from "@/lib/middleware/rate-limit-hono-cloudflare";
import { appChargeRequestsService } from "@/lib/services/app-charge-requests";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

const app = new Hono<AppEnv>();

app.use("*", rateLimit(RateLimitPresets.STANDARD));

app.get("/", async (c) => {
  try {
    const appId = c.req.param("id");
    const chargeId = c.req.param("chargeId");
    if (!appId || !chargeId) {
      return c.json({ success: false, error: "Missing route parameters" }, 400);
    }

    const [targetApp, charge] = await Promise.all([
      appsRepository.findPublicInfoById(appId),
      appChargeRequestsService.getForApp(appId, chargeId),
    ]);

    if (!targetApp || !charge) {
      return c.json({ success: false, error: "Charge request not found" }, 404);
    }

    return c.json({
      success: true,
      charge,
      app: {
        id: targetApp.id,
        name: targetApp.name,
        description: targetApp.description,
        logo_url: targetApp.logo_url,
        website_url: targetApp.website_url,
      },
    });
  } catch (error) {
    logger.error("[AppCharges API] Failed to get charge request", { error });
    return failureResponse(c, error);
  }
});

export default app;
