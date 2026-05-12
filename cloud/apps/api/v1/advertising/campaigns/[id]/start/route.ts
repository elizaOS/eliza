/**
 * POST /api/v1/advertising/campaigns/[id]/start — activate a campaign.
 */

import { Hono } from "hono";
import { failureResponse, NotFoundError } from "@/lib/api/cloud-worker-errors";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import { advertisingService } from "@/lib/services/advertising";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

const app = new Hono<AppEnv>();

app.post("/", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);
    const id = c.req.param("id")!;

    const campaign = await advertisingService.startCampaign(id, user.organization_id);

    logger.info("[Advertising API] Campaign started", { campaignId: id });

    return c.json({
      id: campaign.id,
      name: campaign.name,
      status: campaign.status,
      updatedAt: campaign.updated_at.toISOString(),
    });
  } catch (error) {
    if (error instanceof Error && error.message === "Campaign not found") {
      return failureResponse(c, NotFoundError("Campaign not found"));
    }
    return failureResponse(c, error);
  }
});

export default app;
