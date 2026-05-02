/**
 * POST /api/v1/advertising/campaigns/[id]/pause — pause a campaign.
 */

import { Hono } from "hono";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import { advertisingService } from "@/lib/services/advertising";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

const app = new Hono<AppEnv>();

app.post("/", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);
    const id = c.req.param("id")!;

    const campaign = await advertisingService.pauseCampaign(id, user.organization_id);

    logger.info("[Advertising API] Campaign paused", { campaignId: id });

    return c.json({
      id: campaign.id,
      name: campaign.name,
      status: campaign.status,
      updatedAt: campaign.updated_at.toISOString(),
    });
  } catch (error) {
    return failureResponse(c, error);
  }
});

export default app;
