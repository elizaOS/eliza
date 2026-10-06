/**
 * POST /api/v1/advertising/campaigns/[id]/start — activate a campaign.
 */

import { requireUserOrApiKeyWithOrg } from "@elizaos/cloud-shared/auth";
import {
  failureResponse,
  NotFoundError,
} from "@elizaos/cloud-shared/lib/api/cloud-worker-errors";
import { advertisingService } from "@elizaos/cloud-shared/lib/services/advertising";
import { logger } from "@elizaos/cloud-shared/lib/utils/logger";
import type { AppEnv } from "@elizaos/cloud-shared/types/cloud-worker-env";
import { Hono } from "hono";

const app = new Hono<AppEnv>();

app.post("/", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);
    const id = c.req.param("id")!;

    const campaign = await advertisingService.startCampaign(
      id,
      user.organization_id,
    );

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
